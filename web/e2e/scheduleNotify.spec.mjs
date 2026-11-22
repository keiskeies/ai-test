// 1E T9：`scheduleNotify.spec.mjs` = 一期 DoD 的 DoD 证据（蓝图 §13:1600 后两拍
// 「混合场景执行→报告落库→定时触发→通知真实送达」+ §T9 补记的「导入腿」，
// 计划 2026-11-16-1e §T9 原文）。三条 test，各证一条腿：
//
// ① 导入腿（§1.5 判据第 1 条的自动化代理）：真端点 api-import-preview/commit 导入
//    petstore 5 条 → 把导入出来的「列出宠物」改指本机靶场 → 建用例挂进混合场景
//    （api_case+sleep+if，形状同 mixedScene）→ 执行 → 报告中心出现。
//    **如实口径**：判据原文是「新人 30 分钟走通 建项目→导入 20 接口→建混合场景→执行→看报告」，
//    「30 分钟走通」本质是人工验收口径，任何自动化都只是代理——本条是**端点面代理**
//    （preview/commit 就是向导点的同两个端点），向导 UI 面在 importWizard.spec.mjs；
//    金线（test_golden_1c.py / mixedScene.spec）都不含导入腿，这条补上后判据第 1 条
//    才第一次有 e2e 代理证据。业主手动 30 分钟走查仍是交付步骤，不许把本条当它已闭合。
//
// ② 混合场景执行→报告落库（DoD 前段，worker 腿）：计划点名的四类节点一景跑通——
//    API(http_direct→靶场) + 等待(sleep) + UI(ui_case，真 Chromium 打本机靶场，
//    reports.spec T19 靶页形状；断言步故意不过=如实橙 fail，不是红 error) +
//    adb(adb_case，假设备真跑、真落截图制品)。
//    执行入口为什么不是 POST /scenarios/{id}/run：8321 是 TP_EXEC_MODE=inline 且默认
//    不带假 adb（playwright.config.ts 的 webServer env 只在显式注入时转接 TP_ADB_PATH），
//    inline 的 adb 步必 error（mixedScene ① 钉死的形状），四类节点全跑通在那条腿上
//    证不出来。本条用 orchestration.enqueue 的子进程（verify_worker.py 的同款 enqueue
//    形状，TP_EXEC_MODE=celery：探 broker → 落 queued run → send_task scenario.run 投
//    tp.e2e）建 trigger=manual 的 run，由本规格 worker（带 TP_ADB_PATH/FAKE_ADB_STATE）
//    真执行；8321 全程只读库出报告，不是这轮执行者。
//    adb 设备行 DB 直插（insertAdbDevice）：POST /adb-devices 必先真 adb connect 成功才
//    入库（adb_test/device_services.py adb_device_create→_connect_verify「先 connect
//    验证再入库」），假 adb 住在 worker 进程里，8321 注册不了它——「数据直插、执行归真」
//    与 helpers.insertRunDirect 同约定；worker 没起来/没假设备时 adb 步照样如实红，
//    绿的只有真跑过的。
//    fail_fast=false 且 uin 排在 adb 前：uin 恒挂，fail_fast=true 会把 adb 落成 skip，
//    通过率就成 2/3=66.7% 的假数——四类节点必须都真上场。通过率同一把尺（stats 是顶层
//    节点数：runner.run_graph 的 total=len(top)，子步骤走步骤表另账；pass/(total−skip)
//    与 notify/template.pass_rate、report_services._pass_rate 同尺）：api/nap/adb 过、
//    uin 如实挂 = 3/4 = 75.0%——② 报告环 data-percent=75 与 ③ Markdown 的「通过率：
//    75.0%」是同一个数在两处对账，两头都不是手写的。
//    manual run 零通知副作用：终态钩子只认 trigger=schedule（notify/hooks.py
//    on_run_finalized 开头即 return），② 不挂渠道也不会有任何发送——这是核过的不是假设。
//    ② 经 chain 把场景（连同 UI/ADB 用例与设备行）接力给 ③——DoD 后段必须挂真混合场景。
//
// ③ 定时触发→通知真实送达（DoD 后段，celery 腿）。逐拍标清自动化边界（哪拍证了、哪拍要人）：
//    [自动化] 建渠道(假接收端)/定时任务(`* * * * *`+挂渠道) 走真 UI —— 定时任务页归本规格
//             （notifyChannel.spec 头注），含 next-5 预览 5 个时刻。
//    [人工替代] **cron 到点那一拍**：e2e 的 8321 是 `uvicorn app.server:app` + TP_EXEC_MODE=inline，
//             进程里没有 beat（DbScheduler 只在 `celery -A app.beat beat` 独立进程里跑，见 beat.py）。
//             服务面没有「手动触发一次」端点（schedule/service.py 的 @service 只有 CRUD+next_5），
//             不许伪造触发，所以本规格调 **fire_task 本体**（worker 的 schedule.fire 任务体、
//             真实触发入口：建 trigger=schedule 的 run + 投 broker + entry=schedule 审计 + last_run
//             回执全在里面）替代 beat 的分钟 tick——被人工替代的只有「到点」，不是触发逻辑。
//             beat 真到点属业主手动步骤：`celery -A app.beat beat -l info`（带 e2e 那套 TP_* 环境），
//             `* * * * *` 任务每分钟真触发一次；后端 test_schedule_beat.py/test_schedule_1e.py
//             证的是调度器读表与到点投递。**本 e2e 证明的是「trigger=定时 的 run 一路到
//             报告+通知+审计」**。**规格绝不自起 beat**：testpilot_e2e 是追加式共享库，
//             beat 起来会把历轮遗留的 enabled 行全触发一遍，污染所有人的数字。
//    [自动化] fire 投出的 scenario.run 由**规格自起的真 worker 子进程**（celery --pool=solo，
//             队列 tp.e2e，形状同 backend/scripts/verify_worker.py 的 worker 子进程）消费执行——
//             8321 webServer 没有 worker，没有消费者 run 永远 queued，这一段不算伪造而是补上
//             真实执行环境；R118 隔离：e2e 各规格的执行走 inline 不经 broker，只有本规格的
//             投递（② 的 enqueue 与 ③ 的 fire_task）往 tp.e2e 投任务。**worker 带 TP_ADB_PATH/FAKE_ADB_STATE 假 adb 环境**
//             （mixedScene ② 全绿通路的同一对生成物，执行在本机 worker 进程，8321 不需要）：
//             adb 步真跑假设备、真落截图制品；未命中分支照旧不落行。UI 步断言如实 fail。
//             worker 只在用例存续期存在、afterAll 必杀（Windows taskkill /T 杀进程树）。
//    [自动化] run 终态(failed) → core.run_finalized → notify.hooks（8321/worker 同一份装配）真发
//             Markdown 到规格内 node:http 假接收端（含场景名 + 定时任务名 + 通过率 75.0% +
//             触发方式=定时 + 失败原因），渠道 last_send ✓ 落库（通知送达 ≠ 执行通过，两账分立）、
//             任务 last_run.run_final.notified=true；报告中心 trigger=定时 着色、
//             审计页 入口=定时 有 schedule_task.run 行。
//    通过率口径（Σpass/Σ(total−skip)，template.pass_rate / test_schedule_notify_hook 同尺）：
//    四步 api/nap/adb 过、uin 如实挂 = 3/4 = 75.0%（通知模板渲染的正是这份失败现场）。
//
// 追加式库纪律：具名记录从下拉里选一律先键入名字再 pickOption（antd 虚拟列表视口外不在 DOM）；
// 平台级唯一资源（通知渠道名）用时间戳 tag 命名，避免跨轮 409。
//
// 如实口径：playwright 实测通过——本规格改写后连跑两轮均 3 passed（第二轮 36.9s、
// 第三轮 35.8s：① 1.7s / ② 14.3s / ③ 15.9s，追加式库第二轮全绿）。首轮曾 300s 挂在
// ③ 的报告中心筛选上（场景名含「定时」二字 + antd 双浮层退场竞态），修复即下面 ③
// 里的精确 label + pickOption 口径。
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";
import { E2E_DB_URL, E2E_REDIS_URL } from "./dbEnv.mjs";

const APP = "http://127.0.0.1:5173";
const TARGET = "http://127.0.0.1:9999";
const HERE = import.meta.dirname;
const BACKEND_DIR = path.resolve(HERE, "..", "..", "backend");
const PY = process.env.TP_PYTHON
  ?? path.join(BACKEND_DIR, ".venv", "Scripts", "python.exe");
// 与 playwright.config.ts 的 webServer 完全同一套 env：8321 用这套 key 加密渠道 config，
// worker/fire 子进程必须以同一 TP_SECRET_KEY 解密（Fernet 由 secret_key 派生），差一位就 ✗。
const E2E_ENV = {
  ...process.env,
  TP_ENV: "e2e",
  TP_DB_URL: E2E_DB_URL,
  TP_REDIS_URL: E2E_REDIS_URL,
  TP_SECRET_KEY: "e2e-secret-key-0123456789abcdef0123456789",
  TP_BOOTSTRAP_ACCOUNT: "admin",
  TP_BOOTSTRAP_PASSWORD: "E2e@Pass123",
  TP_MODEL_SEED_BASE_URL: "fake://basic_two_tools",
  TP_MODEL_SEED_NAME: "fake-basic",
};
const FIX = path.resolve(BACKEND_DIR, "tests", "fixtures", "import");
const PETSTORE = readFileSync(path.join(FIX, "petstore_openapi3.json"), "utf8");

const uniq = (tag) => "1E定时" + tag + "-" + Date.now().toString(36);

// ── 本机假 webhook 接收端：spec 文件内 node:http 临时端口（不改共享 webServer）──
let receiver = null;
const received = []; // { body: 解析后的 JSON, at }
test.beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { received.push({ body: JSON.parse(raw), at: Date.now() }); }
      catch { received.push({ body: raw, at: Date.now() }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}'); // <400 → 发送器如实判 ✓（senders._send_http 的口径）
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
});
test.afterAll(async () => {
  if (receiver) await new Promise((resolve) => receiver.close(resolve));
});
function receiverUrl() {
  return "http://127.0.0.1:" + receiver.address().port + "/hook";
}

/** 规格自起的真 worker 子进程（② 的 manual run 与 ③ 的 schedule run 共用这一台；
 *  afterAll 必杀）。见文件头 ②③ 说明：假 adb 生成物在这里挂进 worker 子进程自己的
 *  env——执行住在本规格拥有的 worker 里，8321 共享 webServer 不需要（也不该）带
 *  TP_ADB_PATH。幂等：② 起过之后 ③ 再调不双起（双起会让 workerProc 句柄覆盖，
 *  afterAll 只能杀一台，另一台变孤儿霸着 tp.e2e 队列）。 */
let workerProc = null;
let workerLog = "";
/** 生成/复用假 adb 装配（mixedScene.spec FakeAdb 同款：cwd=backend，manager 相对路径）。 */
function fakeAdb() {
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, os.getcwd())  # cwd 必须是 backend：manager 内 fake_adb.py 按相对路径生成 wrapper
from scripts.fake_device import FakeDeviceManager
mgr = FakeDeviceManager().with_device(serial="127.0.0.1:5555")
print(json.dumps({"executable": mgr.adb(), "state": str(mgr.state_path)}))
`], { cwd: BACKEND_DIR, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
function startWorker() {
  if (workerProc && workerProc.exitCode === null) return; // 幂等：② 起过的台 ③ 接着用
  const fake = fakeAdb();
  workerProc = spawn(PY, ["-m", "celery", "-A", "app.worker:celery_app", "worker",
    "--pool=solo", "-l", "info", "--without-gossip", "--without-mingle", "--without-heartbeat"],
  { cwd: BACKEND_DIR,
    env: { ...E2E_ENV, TP_ADB_PATH: fake.executable, FAKE_ADB_STATE: fake.state } });
  workerProc.stdout.on("data", (c) => { workerLog += c; });
  workerProc.stderr.on("data", (c) => { workerLog += c; });
}
test.afterAll(() => {
  // Windows 下 node 的 SIGTERM 对 celery 子进程树无效——taskkill /T 连子孙一起杀
  if (workerProc && workerProc.exitCode === null) {
    try { execFileSync("taskkill", ["/PID", String(workerProc.pid), "/T", "/F"]); } catch { /* 已退 */ }
  }
  workerProc = null;
});

/** ②→③ 的接力（workers=1、文件内顺序执行）：③ 的定时 run 必须挂在 ② 的真混合场景上。 */
let chain = null; // { token, projectId, sceneName, scenarioId, tag }

/** 必败 UI 步（reports.spec T19 同款夹具形状）：#login-tip 常驻，断不可能文案 = fail 不是 error。 */
const UI_FAIL_STEPS = [
  { id: "u1", type: "open", input: TARGET + "/ui/login" },
  { id: "u2", type: "input", inline_locator: { type: "css", value: "#account" }, input: "demo" },
  { id: "u3", type: "assert_text", inline_locator: { type: "css", value: "#login-tip" },
    input: "不可能出现的断言文案XYZ" },
];

/** adb 设备行 DB 直插（palette.spec 直插 / helpers.insertRunDirect 同约定）：
 *  POST /adb-devices 必须真 adb connect 得通才入库（device_services「先 connect 验证再入库」），
 *  8321 没挂假 adb，这条 UI/API 路在 e2e 里根本走不通——行是数据，执行才是真相，
 *  且执行发生在本规格 worker 的假 adb 里真跑（worker 起不来/没假设备时 adb 步照样如实红）。 */
function insertAdbDevice(projectId, serial, name) {
  const spec = JSON.stringify({ projectId, serial, name, db: E2E_ENV.TP_DB_URL });
  const out = execFileSync(PY, ["-c", INSERT_ADB_DEVICE_PY, spec],
    { cwd: BACKEND_DIR, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const INSERT_ADB_DEVICE_PY = `
import json, sys, uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
import pymysql
spec = json.loads(sys.argv[1])
u = urlsplit(spec["db"])
now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
dev_id = str(uuid.uuid4())
conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                       password=u.password, database=u.path.lstrip("/"), autocommit=True)
with conn.cursor() as cur:
    cur.execute(
        "INSERT INTO adb_device (id, project_id, name, serial, connect_type, wifi_addr,"
        " enabled, owner_id, project_public, status, updated_by, created_at, updated_at)"
        " VALUES (%s,%s,%s,%s,'wifi',NULL,1,NULL,1,'normal',NULL,%s,%s)",
        (dev_id, spec["projectId"], spec["name"], spec["serial"], now, now))
conn.close()
print(json.dumps({"id": dev_id}))
`;

/** ② 的执行入口：子进程跑 orchestration.enqueue（形状同 verify_worker.py 的投递段：
 *  独立 NullPool session，只投递不执行）。TP_EXEC_MODE=celery 是这里的执行裁定——
 *  enqueue 会先探 broker 再落 queued run 行，然后 send_task scenario.run 投 tp.e2e
 *  （config.task_queue 由 TP_ENV=e2e 推导），由本规格 worker 领走真执行。
 *  不改共享 8321 的执行模式（e2e 全局裁定仍是 inline，playwright.config.ts 头注），
 *  只有这条 run 走 broker——R118 隔离不破：别的规格照常 inline，谁也不会领到这条。
 *  actor 是触发人快照（enqueue 的口径：谁触发以谁的身份跑）；perms 给 {"*"} 只因为
 *  token 就是系统管理员 admin（seedProject），引擎侧 ensure_project_access 仍现查。 */
function enqueueManualRun(actor, projectId, scenarioId, subjectName) {
  const spec = JSON.stringify({ projectId, scenarioId, subjectName, actor });
  const out = execFileSync(PY, ["-c", ENQUEUE_RUN_PY, spec], {
    cwd: BACKEND_DIR, encoding: "utf8",
    env: { ...E2E_ENV, TP_EXEC_MODE: "celery" },
  });
  return JSON.parse(out.trim().split("\n").pop());
}
const ENQUEUE_RUN_PY = `
import asyncio, json, sys
sys.path.insert(0, ".")
from app.main import create_app  # worker._boot 同款装配（enqueue 内部不 import 引擎，无需额外步骤）
create_app()
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.modules.scenario.orchestration import enqueue

spec = json.loads(sys.argv[1])

async def _go():
    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        maker = async_sessionmaker(bind=eng, expire_on_commit=False, class_=AsyncSession)
        async with maker() as db:
            rec = await enqueue(db, project_id=spec["projectId"],
                                subject_id=spec["scenarioId"],
                                subject_name=spec["subjectName"], trigger="manual",
                                created_by=spec["actor"]["user_id"], actor=spec["actor"])
            return rec.id
    finally:
        await eng.dispose()

print(json.dumps({"run_id": asyncio.run(_go())}))
`;

/** 真端点导入 petstore（与向导同两个端点：preview → commit），返回 commit 回执。 */
async function importPetstore(token, projectId) {
  const pv = await asUser(token, "post", "api-import-preview", {
    data: { project_id: projectId, source: "openapi3", text: PETSTORE } });
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  expect(pv.body.new_count).toBe(5);
  const cm = await asUser(token, "post", "api-import-commit", {
    data: { project_id: projectId, items: pv.body.items.map((it) => ({
      name: it.name, method: it.method, path: it.path, request: it.request, strategy: "overwrite",
    })) } });
  expect(cm.status, JSON.stringify(cm.body)).toBe(200);
  expect(cm.body.created).toBe(5);
  return cm.body;
}

/** 等 run 落终态并返回报告体（mixedScene 同款轮询）。 */
async function waitTerminal(token, projectId, runId, timeout = 150_000) {
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout, intervals: [1000] }).toMatch(/passed|failed|error|cancelled/);
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  return rep.body;
}

// ═════ ① 导入腿：导入 5 接口 → 用导入的接口建混合场景 → 执行 → 报告出现 ═════
test("① 导入腿代理证据：petstore 5 接口入库 → 「列出宠物」改指靶场建用例 → api_case+sleep+if 场景执行 passed → 报告中心出现", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Date.now().toString(36);
  const { token, projectId } = await seedProject(page, "1e-dod导入腿");
  await importPetstore(token, projectId);

  // 库侧事实：5 条逐字对上限定的名字（UI 绿了不算，库里得真有条目）
  const defs = await asUser(token, "get", "api-definitions",
    { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items.map((d) => d.name).sort())
    .toEqual(["上传宠物照片（体引用外部文档）", "删除宠物", "列出宠物", "创建宠物", "查询宠物"].sort());

  // 把「列出宠物」的请求体改指本机靶场（导入样本的 url 指向 petstore.example.com，
  // 不可达；改指 :9999 才能真执行——这是「用导入出来的接口建场景」的接法，不改样本文件）
  const pet = defs.body.items.find((d) => d.name === "列出宠物");
  const patchDef = await asUser(token, "patch", "api-definitions/" + pet.id, { data: {
    project_id: projectId, definition_id: pet.id, version: pet.version,
    request: { method: "GET", url: TARGET + "/healthz" } } });
  expect(patchDef.status, JSON.stringify(patchDef.body)).toBe(200);

  // 挂在导入接口下建用例（断言 200）→ 混合场景 api_case+sleep+if → 执行
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: pet.id, name: "导入腿用例-" + tag,
    assertions: [{ type: "status_code", expected: 200 }] } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "导入腿混合场景-" + tag, priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "api", kind: "api_case", name: "导入的接口步", ref: c.body.id },
      { key: "nap", kind: "sleep", name: "等待步", config: { ms: 50 } },
      { key: "gate", kind: "if", name: "判断步", config: { branches: [
        { cond: "ctx.vars['never_set'] == '1'", children: [
          { key: "gate.dead", kind: "sleep", name: "不该走到的分支", config: { ms: 10 } }] },
        { cond: "else", children: [
          { key: "gate.live", kind: "sleep", name: "兜底分支", config: { ms: 10 } }] } ] } },
    ] },
    variables: {}, fail_fast: true, project_public: true } });
  expect(sc.status, JSON.stringify(sc.body)).toBe(201);
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const body = await waitTerminal(token, projectId, run.body.run_id);
  expect(body.status).toBe("passed");
  expect(body.stats).toMatchObject({ total: 3, pass: 3 });

  // 报告中心出现这条（判据第 1 条的最后一拍：看报告）
  await page.goto(APP + "/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  const row = page.getByTestId("reports-row").filter({ hasText: "导入腿混合场景-" + tag });
  await expect(row).toHaveCount(1);
  await expect(row.first()).toHaveAttribute("data-trigger", "manual");
  await expect(row.first().getByTestId("report-trigger")).toContainText("手动");
  await expect(row.first().getByTestId("report-pass-rate")).toHaveAttribute("data-percent", "100");
});

// ═════ ② 混合场景执行→报告落库（DoD 前段，worker 腿）═════
test("② 混合场景执行→报告：子进程 enqueue(manual) → 规格 worker 真执行 api/nap/uin/adb 四步（UI 真开靶页如实挂、adb 真跑假设备）→ 报告中心出现（75.0% 同一把尺）", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = Date.now().toString(36);
  const seeded = await seedProject(page, "1e-dod混合");
  const { token, projectId } = seeded;
  const sceneName = "定时DoD混合场景-" + tag;

  // UI 用例：真 Chromium 打本机靶场，断言步必不可能 → uin 步如实 fail（reports.spec T19 同形状）
  const uc = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name: "DoD混合UI用例-" + tag, priority: "P2", steps: UI_FAIL_STEPS } });
  expect(uc.status, JSON.stringify(uc.body)).toBe(201);

  // ADB 用例（mixedScene seedAdbCase 同款三连）+ 设备行 DB 直插（理由见 insertAdbDevice 头注）
  const serial = "127.0.0.1:5555";
  const ac = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name: "DoD混合ADB用例-" + tag, priority: "P2",
    steps: [
      { id: "a1", type: "connect", config: { addr: serial } },
      { id: "a2", type: "assert_text", config: { text: "登录", timeout_ms: 2000 } },
      { id: "a3", type: "screenshot" },
    ] } });
  expect(ac.status, JSON.stringify(ac.body)).toBe(201);
  insertAdbDevice(projectId, serial, "DoD假机-" + tag);

  // fail_fast=false：四类节点每次都真上场——uin 恒挂，fail_fast=true 会把 adb 落成 skip，
  // 通过率就成 2/3=66.7% 的假数（这正是「同一把尺」要防的手写数）。
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: sceneName, priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "api", kind: "http_direct", name: "接口步：健康检查",
        config: { method: "GET", url: TARGET + "/healthz",
          assertions: [{ type: "status_code", expected: 200 }] } },
      { key: "nap", kind: "sleep", name: "等待步", config: { ms: 50 } },
      { key: "uin", kind: "ui_case", name: "UI 步：靶场登录页断言", ref: uc.body.id },
      { key: "adb", kind: "adb_case", name: "设备步：假机三连", ref: ac.body.id,
        config: { device_policy: "specified", device_serial: serial } },
    ] },
    variables: {}, fail_fast: false, project_public: true } });
  expect(sc.status, JSON.stringify(sc.body)).toBe(201);

  // 执行环境先就位（8321 webServer 无 worker；见文件头 ② 说明），再真投递。
  // worker 带假 adb（TP_ADB_PATH/FAKE_ADB_STATE）：adb 步在 worker 进程真跑假设备，
  // 执行链（含 playwright 起真浏览器跑 uin）全部发生在本规格拥有的进程里。
  startWorker();
  const me = await asUser(token, "get", "auth/me");
  expect(me.status).toBe(200); // token 就是 seedProject 登录的系统管理员，actor 如实快照
  const fired = enqueueManualRun(
    { user_id: me.body.id, user_name: me.body.name, is_system_admin: true,
      perms: ["*"], entry: "http" },
    projectId, sc.body.id, sceneName);
  const runId = fired.run_id;

  // worker 领取执行到终态；执行环境恒有假 adb ⇒ 形状是死的，不是「两种通道都钉」的骑墙：
  // api/nap/adb 过、uin 如实挂 → failed，通过率 3/(4−0)=75.0%（runner 的 total=顶层节点数，
  // template.pass_rate 同尺）。这条的 75.0% 与 ③ Markdown 的 75.0% 是同一个数两处对账。
  let body;
  try {
    // 240s：worker 冷启动（celery boot + create_app 装配）+ 真 UI 步 + 假 adb 三连的叠加上限
    body = await waitTerminal(token, projectId, runId, 240_000);
  } catch {
    throw new Error("run 未落终态（多半是 worker 没起来）；worker 日志尾部：\n"
      + workerLog.slice(-2000));
  }
  expect(body.status).toBe("failed");
  expect(body.trigger).toBe("manual");
  expect(body.stats).toMatchObject({ total: 4, pass: 3, fail: 1, error: 0, skip: 0 });
  expect(body.pass_rate).toBeCloseTo(0.75, 6);

  // 执行确实发生在带假 adb 的 worker 里（8321 默认通道只能给 error）：
  // adb 步 pass、点名设备与模式、screenshot 真落制品（bytes>0，报告页右栏按 ref 可取）
  const adbStep = await asUser(token, "get", "reports/" + runId + "/steps",
    { params: { project_id: projectId, run_id: runId, step_key: "adb", row_no: 0 } });
  expect(adbStep.status).toBe(200);
  expect(adbStep.body.status).toBe("pass");
  expect(adbStep.body.detail.device).toBe(serial);
  expect(["u2", "dump"]).toContain(adbStep.body.detail.mode); // dump 降级是 CI 预期形状（mixedScene ② 同尺）
  const adbShots = (adbStep.body.detail.artifacts ?? []).filter((a) => a.kind === "SCREENSHOT");
  expect(adbShots.length).toBeGreaterThanOrEqual(1);
  expect(adbShots[0].bytes).toBeGreaterThan(0);

  // uin 步如实挂：断言不成立 = fail（橙）而不是 error（红）——真开了靶页、读了 #login-tip、
  // 文案对不上才算 fail；「元素找不到」是另一种红，这里必须区分开。
  const uiStep = await asUser(token, "get", "reports/" + runId + "/steps",
    { params: { project_id: projectId, run_id: runId, step_key: "uin", row_no: 0 } });
  expect(uiStep.body.status).toBe("fail");

  // manual run 零通知（核过不是假设）：② 全程没建渠道/任务，钩子对 trigger≠schedule
  // 直接 return（notify/hooks.py on_run_finalized）——假接收端此刻必须一封都没收到。
  expect(received.length).toBe(0);

  // 报告落库 + UI：详情页四主体按结果分色；uin=橙（判定不成立）而不是红（真开了靶页读了 #login-tip）
  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-step-row")).toHaveCount(4);
  for (const k of ["api", "nap"]) {
    await expect(page.locator("[data-testid='report-step-row'][data-key='" + k + "']"))
      .toHaveAttribute("data-status", "pass");
  }
  await expect(page.locator("[data-testid='report-step-row'][data-key='uin']"))
    .toHaveAttribute("data-status", "fail");
  await expect(page.locator("[data-testid='report-step-row'][data-key='adb']"))
    .toHaveAttribute("data-status", "pass");
  // UI 制品按画布步骤 key 归位（场景内形状，T19④）：真解码内联
  await page.locator("[data-testid='report-step-row'][data-key='uin']").click();
  const shot = page.getByTestId("report-step-detail").getByTestId("report-artifact-img").first();
  await expect(shot).toBeVisible({ timeout: 20_000 });
  expect(await shot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  // 报告中心列表出现这条（「报告落库」的用户可见面）+ 通过率环 75：
  // 与库里 pass_rate、③ Markdown 的「通过率：75.0%」同尺同数——环是渲染出来的不是手写的。
  // 追加式库：历轮同名场景行也在列表里，按本轮专属 sceneName 筛出恰好 1 行才是硬事实。
  await page.goto(APP + "/#/reports");
  const row = page.getByTestId("reports-row").filter({ hasText: sceneName });
  await expect(row).toHaveCount(1);
  await expect(row.first()).toHaveAttribute("data-trigger", "manual");
  await expect(row.first().getByTestId("report-pass-rate")).toHaveAttribute("data-percent", "75");

  // 接力给 ③：定时 run 必须挂在同一支混合场景上（DoD 后段不许换成简化场景假证）
  chain = { ...seeded, sceneName, scenarioId: sc.body.id, tag };
});

// ═════ ③ 定时→通知腿：`* * * * *` 任务 + 假接收端 → 触发 → worker 执行 ② 的场景 → 通知 → 报告/审计 ═════
test("③ 定时→通知：UI 建 `* * * * *` 任务挂假接收端渠道 → 真触发建 schedule run → 真 worker 执行混合场景 → 接收端收到含场景名与通过率的 Markdown → 报告「定时」着色 + 审计「入口=定时」有行", async ({ page }) => {
  test.setTimeout(300_000);
  if (!chain) throw new Error("② 没把混合场景接力给 ③（② 失败或文件内顺序被改）——③ 拒绝换简化场景假证 DoD");
  const { token, projectId, project, sceneName } = chain;
  const chanName = uniq("接收端");
  const taskName = uniq("每分钟回归");
  // ③ 全程用 ② 的项目身份（渠道/任务/报告/审计都归那个项目）
  await page.addInitScript(([t, pj]) => {
    localStorage.setItem("tp_token", t);
    localStorage.setItem("tp_project", JSON.stringify(pj));
  }, [token, project]);

  // 渠道走 UI 建（假接收端 = 本 spec 内 node:http 临时端口）
  await page.goto(APP + "/#/notify/channels");
  await expect(page.getByTestId("page-notify-channels")).toBeVisible();
  await page.getByTestId("notify-channel-create").click();
  await page.getByTestId("notify-field-name").fill(chanName);
  await page.getByTestId("notify-field-url").fill(receiverUrl());
  await page.getByTestId("notify-channel-save").click();
  await expect(page.getByRole("row").filter({ hasText: chanName })).toBeVisible();
  const chanList = await asUser(token, "get", "notify-channels", { params: { size: 200 } });
  const chanRow = chanList.body.items.find((r) => r.name === chanName);
  expect(chanRow, "渠道没落后端库").toBeTruthy();

  // 定时任务走 schedules 页 UI 建（notifyChannel.spec 头注：定时任务页归本规格）
  await page.goto(APP + "/#/schedules");
  await expect(page.getByTestId("page-schedules")).toBeVisible();
  await page.getByTestId("schedule-create").click();
  await page.getByTestId("schedule-field-name").fill(taskName);
  // 追加式库：具名记录必先键入名字过滤再点（antd 虚拟列表视口外不在 DOM）
  await page.getByTestId("schedule-field-subject_id").click();
  await page.keyboard.type(sceneName);
  await pickOption(page, sceneName);
  // D76 之后 cron 有三种输入外壳，`schedule-field-cron` 只在「自定义 cron」态存在：
  // 新建默认落「每天」，直接 fill 会撞到一个压根不在 DOM 的控件。先切态再填，
  // 顺带把「切到自定义 → raw 槽逐字可填」这条 D76 口径钉在真实浏览器里。
  await page.getByTestId("schedule-plan-mode").getByText("自定义 cron", { exact: true }).click();
  await expect(page.getByTestId("schedule-plan-derived")).toHaveText("将写入：（未填 cron）");
  await page.getByTestId("schedule-field-cron").fill("* * * * *");
  await expect(page.getByTestId("schedule-plan-derived")).toHaveText("将写入：* * * * *");
  await page.getByTestId("schedule-preview-btn").click();
  // next-5 预览：5 个未来时刻（草稿 cron 未保存也能算，§11.4.17）
  await expect(page.getByTestId("schedule-preview-time")).toHaveCount(5);
  await page.getByTestId("schedule-field-channels").click();
  await page.keyboard.type(chanName);
  await pickOption(page, chanName);
  await page.getByTestId("schedule-save").click();
  const taskTableRow = page.getByRole("row").filter({ hasText: taskName });
  await expect(taskTableRow).toBeVisible();
  await expect(taskTableRow).toContainText("* * * * *");

  const tasks = await asUser(token, "get", "schedule-tasks", { params: { project_id: projectId, size: 100 } });
  const task = tasks.body.items.find((t) => t.name === taskName);
  expect(task, "定时任务没落后端库").toBeTruthy();
  expect(task.cron).toBe("* * * * *");
  expect(task.notify_channel_ids).toEqual([chanRow.id]);

  // 真 worker 子进程补上执行环境（8321 webServer 无 worker；见文件头 [自动化] 说明）
  startWorker();

  // [人工替代] cron 到点那拍：e2e 的 8321 进程里没有 beat，规格不许伪造——直接调
  // worker 任务体同款 fire_task 本体（真实触发入口，除「等分钟」外全真：建 schedule run
  // + send_task scenario.run 投 tp.e2e + entry=schedule 审计 + last_run 回执）。
  const FIRE_PY = `
import asyncio, json, sys
sys.path.insert(0, ".")
from app.main import create_app  # worker._boot 同款：REGISTRY/audit writer 装配齐才落得到审计
create_app()
from app.modules.schedule.service import fire_task
print(json.dumps(asyncio.run(fire_task(sys.argv[1]))))
`;
  const firedOut = execFileSync(PY, ["-c", FIRE_PY, task.id],
    { cwd: BACKEND_DIR, env: E2E_ENV, encoding: "utf8" });
  const fired = JSON.parse(firedOut.trim().split("\n").pop());
  expect(fired.ok, "fire_task 回执非 ok: " + JSON.stringify(fired)).toBeTruthy();
  const runId = fired.run_id;

  // 真 worker 领走 tp.e2e 的 scenario.run 执行到终态（inline 的 8321 不参与这轮执行）。
  // worker 环境归本规格（带假 adb，见 startWorker）：adb 步真跑假设备 → pass；
  // UI 步照旧如实 fail → run=failed、通过率 3/4=75.0%（通知模板渲染失败现场，两账分立）。
  let body;
  try {
    // 240s：worker 冷启动（celery boot + create_app 装配）+ 真 UI 步一轮是叠加上限
    body = await waitTerminal(token, projectId, runId, 240_000);
  } catch {
    throw new Error("run 未落终态（多半是 worker 没起来）；worker 日志尾部：\n"
      + workerLog.slice(-2000));
  }
  expect(body.status).toBe("failed");
  expect(body.trigger).toBe("schedule"); // 报告中心「触发=定时」的库侧事实
  expect(body.stats).toMatchObject({ total: 4, pass: 3, fail: 1, error: 0, skip: 0 });

  // 执行确实发生在带假 adb 的 worker 里：adb 步 pass 且点名设备（8321 默认通道只能给 error）
  const adbStep = await asUser(token, "get", "reports/" + runId + "/steps",
    { params: { project_id: projectId, run_id: runId, step_key: "adb", row_no: 0 } });
  expect(adbStep.status).toBe(200);
  expect(adbStep.body.status).toBe("pass");
  expect(adbStep.body.detail.device).toBe("127.0.0.1:5555");

  // 假接收端真收到 Markdown：主题行 + 场景名 + 定时任务名 + 通过率（Σpass/Σ(total−skip)=75.0%）
  // + 触发方式 + 失败原因（template.render 的失败分支，模板字段逐字对齐）。
  // 恰 1 条：ephemeral 端口只挂在本次运行的这个渠道上，fire 一次 = 一封（告警阈值 3 不触发）。
  await expect.poll(async () => received.length, { timeout: 30_000 }).toBe(1);
  const text = received[0].body.text;
  expect(text).toContain("TestPilot 执行结果摘要");
  expect(text).toContain(sceneName);
  expect(text).toContain("- 通过率：75.0%");
  expect(text).toContain("- 触发方式：定时");
  expect(text).toContain("- 结果：未通过");
  expect(text).toContain("- 失败原因：");
  expect(text).toContain(taskName); // 定时任务名也在摘要里（hooks 注入 task_name）

  // 落账两侧：渠道 last_send ✓（D28：送达回执，与 run 成败无关）+ 任务回执合并；
  // run failed → consecutive_failures=1（钩子唯一写入方的口径，发没发都不碰它）
  const chanAfter = await asUser(token, "get", "notify-channels/" + chanRow.id);
  expect(chanAfter.body.last_send.ok, JSON.stringify(chanAfter.body.last_send)).toBe(true);
  const taskAfter = await asUser(token, "get", "schedule-tasks/" + task.id,
    { params: { project_id: projectId } });
  expect(taskAfter.body.last_run.run_id).toBe(runId);
  expect(taskAfter.body.last_run.run_final.notified).toBe(true);
  expect(taskAfter.body.last_run.run_final.ok).toBe(false);
  expect(taskAfter.body.last_run.run_final.channels[0].ok).toBe(true);
  expect(taskAfter.body.consecutive_failures).toBe(1);

  // UI：报告中心 trigger=定时 着色。追加式库里历轮遗留的 schedule run 也在 7 天窗口内，
  // 所以先按 ② 的新场景筛（subject_id 是本轮专属 id）再叠 trigger=定时 → 恰好 1 行才是硬事实。
  // 两个连环坑（首轮实测 300s 挂在第二跳上）：① 场景名本身含「定时」二字，筛选项的
  // 「定时」必须精确匹配 label，否则会把场景项当触发项点掉；② 连开两个 antd 下拉时前一个
  // 还在退场动画（不带 hidden 类），裸 .first() 会点到退场浮层里的场景项等到超时——
  // 所以场景选完先 Escape 关掉浮层，触发选择走 pickOption（.last() = 最新打开的浮层）。
  await page.goto(APP + "/#/reports");
  await page.getByTestId("reports-filter-scene").click();
  await page.keyboard.type(sceneName);
  await pickOption(page, sceneName);
  await page.keyboard.press("Escape");
  await page.getByTestId("reports-filter-trigger").click();
  const triggerOption = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last()
    .locator(".ant-select-item-option").filter({ hasText: /(^|\s)定时$/ }).first();
  await expect(triggerOption).toBeVisible();
  await triggerOption.click();
  const srow = page.getByTestId("reports-row");
  await expect(srow).toHaveCount(1, { timeout: 10_000 });
  await expect(srow.first()).toHaveAttribute("data-trigger", "schedule");
  await expect(srow.first().getByTestId("report-trigger")).toContainText("定时");
  await expect(srow.first()).toContainText(sceneName);
  // 通过率环 75（同一条 run 的列表侧读面，与 Markdown 的 75.0% 同一把尺两处对账）
  await expect(srow.first().getByTestId("report-pass-rate")).toHaveAttribute("data-percent", "75");

  // UI：审计页「入口=定时」有 schedule_task.run 行（R144：机器触发 entry=schedule、user NULL）
  await page.goto(APP + "/#/settings");
  await page.locator(".ant-tabs-tab").filter({ hasText: "审计日志" }).click();
  await expect(page.getByTestId("tab-audit")).toBeVisible();
  await page.getByTestId("audit-filter-action").fill("schedule_task.run");
  await page.getByTestId("audit-filter-action").press("Enter");
  const arow = page.getByTestId("audit-row").filter({ hasText: "schedule_task.run" });
  await expect(arow.first()).toBeVisible({ timeout: 15_000 });
  await expect(arow.first().getByTestId("audit-entry").first()).toHaveText("定时");
  await page.getByTestId("audit-filter-entry").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "定时" }).first().click();
  await expect(arow.first()).toBeVisible({ timeout: 15_000 }); // 入口筛「定时」后该行仍在

  // 自删现场（渠道被任务引用会 409，先删任务再删渠道）
  expect((await asUser(token, "post", "schedule-tasks/" + task.id + "/delete",
    { data: { project_id: projectId, task_id: task.id } })).ok).toBeTruthy();
  expect((await asUser(token, "post", "notify-channels/" + chanRow.id + "/delete",
    { data: { channel_id: chanRow.id } })).ok).toBeTruthy();
});
