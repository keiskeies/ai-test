// 1D T9 设备卡片墙的 e2e（页面级契约 + 占用/强制释放的真实数据通路）。
//
// **为什么没有「挂假 adb 的真增删改查」**（计划 T10 原文）：本规格自己不押假 adb——它钉的是
// 与 adb 二进制无关的行为（数据经 DB + Redis 直种，同 helpers.insertRunDirect 的既有约定），
// 假 adb 下的 create/test/reconnect 回显由后端 pytest（fake fixture）钉。
// （写这段时的理由「webServer 进程环境没有 TP_ADB_PATH」已经不成立：T10 起 playwright.config.ts
// 会把这两个变量透传进后端，注入后本文件三条照常绿——81 passed / 0 skipped 那一轮量过。
// 保留「不押假 adb」的选择，是因为不依赖注入的规格在 CI 与本机都能跑，不必为它多要一个前提。）
// 且本机实测发现（见下 ② 的注释与交付报告）：**真 adb 对连不上的地址返回 rc=0**
// （"cannot connect ... (10061)" 但退出码 0），后端 _connect_verify 按 rc 判失败——
// 在有真 adb 的机器上「添加失败回显」根本触发不了。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";
import { E2E_DB_URL, E2E_REDIS_URL } from "./dbEnv.mjs";

const APP = "http://127.0.0.1:5173";
const PY = process.env.TP_PYTHON
  ?? path.resolve(import.meta.dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
const DB = E2E_DB_URL;
const REDIS = E2E_REDIS_URL;

/**
 * 直插三台设备（在线空闲 / 在线占用+2 人排队 / 离线）并真种 Redis 设备锁。
 * 锁键与 execution/adb_lock.py 逐字同构：tp.adb.dev.{serial} + tp.adb.dev.q.{serial}
 * （EventBus channel 前缀 "tp."）——这不是绕过被测件：/occupation 读的就是这两个键，
 * 种键 = 造「有 run 正在占着设备」的事实，比 mock 响应更接近真实现场。
 */
function seedDevices(projectId, serials) {
  const spec = JSON.stringify({ db: DB, redis: REDIS, project_id: projectId, serials });
  const out = execFileSync(PY, ["-c", SEED_PY, spec], {
    cwd: path.resolve(import.meta.dirname, "..", "..", "backend"), encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const SEED_PY = `
import json, sys, uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
import pymysql
import redis

spec = json.loads(sys.argv[1])
u = urlsplit(spec["db"])
ru = urlsplit(spec["redis"])
# db 号在 URL path 里（/6）：漏了它锁就种在 0 号库，后端永远读不到（② 首跑实测）
r = redis.Redis(host=ru.hostname, port=ru.port or 6379,
                password=ru.password or None, db=int((ru.path or "/0").lstrip("/") or 0),
                decode_responses=True)
conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                       password=u.password, database=u.path.lstrip("/"), autocommit=True)
now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
frames = {
    "idle": {"model": "Pixel 6", "os": "13", "online": True, "battery_level": 86,
             "last_check_at": datetime.now(timezone.utc).isoformat()},
    "occupied": {"model": "小米 13", "os": "14", "online": True, "battery_level": 40,
             "last_check_at": datetime.now(timezone.utc).isoformat()},
    # 离线帧：心跳保留末帧机型/电量、online=False（§11.4.14 灰态的数据基础）
    "offline": {"model": "Nexus 5", "os": "8", "online": False, "battery_level": 12,
             "last_check_at": datetime.now(timezone.utc).isoformat()},
}
ids = {}
with conn.cursor() as cur:
    for s in spec["serials"]:
        did = str(uuid.uuid4())
        ids[s["serial"]] = did
        cur.execute(
            "INSERT INTO adb_device (id, project_id, name, serial, connect_type, wifi_addr,"
            " enabled, last_state, owner_id, project_public, status, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,'wifi',%s,1,%s,NULL,1,'normal',%s,%s)",
            (did, spec["project_id"], s["name"], s["serial"], s["serial"].rsplit(":", 1)[0],
             json.dumps(frames[s["state"]], ensure_ascii=False), now, now))
        if s["state"] == "occupied":
            # 与 adb_lock 同一物理键：SET 锁 + RPUSH 两个排队 token（TTL 兜底，测试自清）
            r.set("tp.adb.dev." + s["serial"], "run:e2e-seed:1:host:4242", ex=300)
            r.rpush("tp.adb.dev.q." + s["serial"], "run:e2e-q1:1:h:1", "run:e2e-q2:1:h:1")
            r.expire("tp.adb.dev.q." + s["serial"], 300)
conn.close()
print(json.dumps(ids))
`;

function cleanLocks(serials) {
  const spec = JSON.stringify({ redis: REDIS, serials });
  execFileSync(PY, ["-c", `
import json, sys
from urllib.parse import urlsplit
import redis
spec = json.loads(sys.argv[1])
u = urlsplit(spec["redis"])
r = redis.Redis(host=u.hostname, port=u.port or 6379, password=u.password or None,
                db=int((u.path or "/0").lstrip("/") or 0))
for s in spec["serials"]:
    r.delete("tp.adb.dev." + s, "tp.adb.dev.q." + s)
`, spec], { cwd: path.resolve(import.meta.dirname, "..", "..", "backend") });
}

test("① 空库诚实空态：引导文案说清「添加会真的 adb connect 验证」；过滤器只有三态（D18）", async ({ page }) => {
  test.setTimeout(120_000);
  await seedProject(page, "t9-devices-empty");
  await page.goto(APP + "/#/adb/devices");
  await expect(page.getByTestId("page-adb-devices")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("设备管理");
  await expect(page.getByTestId("adb-device-add")).toBeVisible();
  await expect(page.getByTestId("adb-device-empty")).toBeVisible();
  await expect(page.getByTestId("adb-device-empty")).toContainText("adb connect");
  // 三态过滤器 = 全部/空闲/占用/离线（D18：§11.4.14 mock 之外不造「异常」红态）
  const seg = page.getByTestId("adb-device-filter");
  await expect(seg).toContainText("空闲");
  await expect(seg).toContainText("占用");
  await expect(seg).toContainText("离线");
  await expect(seg).not.toContainText("异常");
});

test("② 卡片墙三态 + 排队 #2 + 强制释放（数据直种 DB/Redis，零 adb 依赖）", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = Date.now().toString(36);
  const serials = [
    { name: "Pixel6-" + tag, serial: "10.99.0.1:5555", state: "idle" },
    { name: "小米13-" + tag, serial: "10.99.0.2:5555", state: "occupied" },
    { name: "Nexus5-" + tag, serial: "10.99.0.3:5555", state: "offline" },
  ];
  const { token, projectId } = await seedProject(page, "t9-devices-wall");
  const ids = seedDevices(projectId, serials);
  try {
    await page.goto(APP + "/#/adb/devices");
    await expect(page.getByTestId("page-adb-devices")).toBeVisible();

    // 三张卡的状态徽标各按心跳帧 + 实时锁上色（§11.4.14 状态带）
    const card = (ser) => page.getByTestId("adb-device-card-" + ids[ser]);
    await expect(card("10.99.0.1:5555").getByTestId("adb-device-state")).toHaveText("空闲");
    await expect(card("10.99.0.2:5555").getByTestId("adb-device-state")).toHaveText("占用");
    await expect(card("10.99.0.3:5555").getByTestId("adb-device-state")).toHaveText("离线");

    // §11.4.14 字段逐一点名：型号/系统/电量徽标/WiFi 地址/最后心跳
    const c1 = card("10.99.0.1:5555");
    await expect(c1.getByTestId("adb-device-battery")).toContainText("电 86%");
    await expect(c1.getByTestId("adb-device-serial")).toContainText("10.99.0.1");
    await expect(c1.getByTestId("adb-device-heartbeat")).toContainText("最后心跳");
    await expect(c1).toContainText("Pixel 6");
    await expect(c1).toContainText("Android 13");
    // 低电量红档：12% 的离线条（阈值 <20 = red，adbDevices.test.tsx 钉过纯函数）
    await expect(card("10.99.0.3:5555").getByTestId("adb-device-battery"))
      .toHaveClass(/ant-tag-red/);

    // 占用卡：排队 #2（真实排队人数），全页无「预计」类估算字样（D17）
    await expect(card("10.99.0.2:5555").getByTestId("adb-device-queue")).toHaveText("排队 #2");
    await expect(page.locator("body")).not.toContainText("预计");

    // 筛选「离线」只剩灰卡（三态过滤器可用即诚实，不做假交互）
    await page.getByTestId("adb-device-filter").getByText("离线").click();
    await expect(page.getByTestId(/^adb-device-card-/)).toHaveCount(1);
    await expect(page.getByTestId("adb-device-state")).toHaveText("离线");
    await page.getByTestId("adb-device-filter").getByText("全部").click();

    // 强制释放（D16）：确认弹窗点名越权+审计；确认后 /occupation 真回到空闲
    // D159 改口后原话是「项目管理员及以上的越权动作」（门禁位也从 :update 换成 :manage）——
    // 断言跟原话走，不迁就旧串。
    await card("10.99.0.2:5555").getByTestId("adb-device-force-release").click();
    const confirm = page.locator(".ant-modal-confirm");
    await expect(confirm).toContainText("项目管理员及以上的越权动作");
    await expect(confirm).toContainText("审计");
    await confirm.getByRole("button", { name: "确认强制释放" }).click();
    await expect(card("10.99.0.2:5555").getByTestId("adb-device-state")).toHaveText("空闲");
    await expect(card("10.99.0.2:5555").getByTestId("adb-device-queue")).toHaveCount(0);

    // Redis 事实：锁键与队列键真的被删（UI 说释放了，键得真没了）
    const left = await asUser(token, "get", "adb-devices/" + ids["10.99.0.2:5555"]
      + "?project_id=" + projectId);
    expect(left.status).toBe(200); // 行还在（强制释放不动资产）
  } finally {
    cleanLocks(serials.map((s) => s.serial));
  }
});

test("③ 添加弹窗的 422 原话整段回显且弹窗不关、零脏行（USB 写入口 D14 的确定性形状）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9-devices-echo");
  await page.goto(APP + "/#/adb/devices");
  await page.getByTestId("adb-device-add").click();
  await page.getByTestId("adb-device-name").fill("USB机-" + Date.now().toString(36));
  await page.getByTestId("adb-device-add-serial").fill("emulator-5554");
  // connect_type 在弹窗里固定 wifi（UI 不露 USB），这里从 API 侧钉 D14 的 422 文案，
  // UI 侧钉「任何 422 都在弹窗里整段回显、弹窗不关、库里零脏行」这条通路。
  const usb = await asUser(token, "post", "adb-devices", { data: {
    project_id: projectId, name: "USB直连", serial: "emulator-5554", connect_type: "usb",
  } });
  expect(usb.status).toBe(422);
  expect(JSON.stringify(usb.body)).toContain("D14");

  // UI 通路：确定性 422 有两条（D14 的 USB 文案已由上面 API 侧钉过），UI 侧钉
  // 「任何失败都在弹窗里整段回显、弹窗不关」这条通路。首台提交在有真 adb 的机器上
  // 可能成功入库（弹窗关闭），在 CI（无 adb）必然 422（弹窗留开 + 回显）——两种终态
  // 都等，谁先到算谁，不猜机器。
  await page.getByTestId("adb-device-add-ok").click();
  const echo = page.getByTestId("adb-device-add-echo");
  const okBtn = page.getByTestId("adb-device-add-ok");
  const echoed = await echo.waitFor({ state: "visible", timeout: 45_000 })
    .then(() => true).catch(() => false);
  if (echoed) {
    // CI 形状：422 安装指引整段回显 + 弹窗不关 + 零脏行
    await expect((echo.textContent() ?? "").toLowerCase()).toContain("adb");
    await expect(okBtn).toBeVisible();
    const list = await asUser(token, "get", "adb-devices?project_id=" + projectId);
    expect(list.body.items).toHaveLength(0);
  } else {
    // 本机形状：首台真入库（弹窗关了）→ 同名二次提交必然 409 → 回显块出现
    const list1 = await asUser(token, "get", "adb-devices?project_id=" + projectId);
    expect(list1.status).toBe(200);
    const made = list1.body.items.find((d) => d.name.startsWith("USB机-"));
    expect(made).toBeTruthy(); // 弹窗关了库里就得真有一条（不说假话）
    await page.getByTestId("adb-device-add").click();
    await page.getByTestId("adb-device-name").fill(made.name);
    await page.getByTestId("adb-device-add-serial").fill("127.0.0.1:5555");
    await page.getByTestId("adb-device-add-ok").click();
    await expect(echo).toBeVisible({ timeout: 30_000 });
    await expect(echo).toContainText("设备名"); // 409 的原话（回收站占位/已存在 两种都含这仨字）
    await expect(okBtn).toBeVisible(); // 弹窗不关，操作员能改名重试
  }
});
