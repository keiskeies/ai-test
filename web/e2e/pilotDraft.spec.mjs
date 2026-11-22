// D84「预填不偷发」的浏览器层收口：两个入口（报告详情 / ADB 设备卡片墙）点「让 Pilot …」
// 之后真实发生的事，vitest 结构上给不出来，这里逐个补真 e2e——
//   ① 真路由跳转 + 预填不偷发：点发送端钮 → 落在 /#/bench，草稿整段坐在 bench-input 里
//      （发送端拼好的 state 真的穿过 createHashRouter 送到了接收端，不是两个 jsdom 各自演
//      一遍）。「没发出去」钉三样：草稿原封不动在输入框里（真发会被 send() 清空，
//      bench.tsx:128）、一张 event-card 都没有、页面零写请求零开流——出货口径里预填后
//      发送钮是开着的（bench.tsx:230，单测 bench.test.tsx:477 钉死），禁用态不是证据。
//      只断「输入框有字」的测试在一个会自动发送的构建上照样绿；上面三条不会。
//   ② 注入一次性：落地后整页 reload 不再倒回同一段草稿（接收端 seed 后的 replace 清
//      state，bench.tsx:65），改一笔再 reload 也不复活。
//   ③ 「运行级报错」行（reportDetail askPilot 里 report.error 的分支）：真实 error 运行
//      （端口没人听）把落库的 run_record.error 逐字带上稿——单测用假报告钉形状，这里钉真
//      数据；顺带对照「运行状态：请求失败」（STATUSES.error），并钉死 fail 与 error 的口径
//      差：断言失败步的 detail 里 error 键整个缺席 → 它的「报错」整行省略（宁缺不编，
//      reportDetail.tsx:391-392 注释的分支），error 步才带报错行。
//   ④ ADB 侧：卡片读数（含 Redis 真种的占用锁）逐字进草稿 + 同样吃一次一次性注入；
//      回收站视图没有这个出口（与「测试连接/重连」同进退，adbDevices.tsx:457-474 的
//      inRecycled 分支里根本不渲染这两个钮）。
// 每条断言的期望字符串都逐字抄自 web/src 现网渲染（断言上方一行注释给 file:line），不发明文案。
// 数据从真实执行来：报告侧用 reports.spec.mjs 的 /flaky?key=<唯一>&fail_first=1 必败配方
// （key 每次运行唯一：计数器全局-per-key，reports.spec 第一轮已消耗掉固定 key 的 500）；
// 设备侧沿用 adbDevice.spec.mjs 的 DB+Redis 直种（零 adb 依赖，占用读数是真的 /occupation
// 响应，不是 mock 的响应体）。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";
import { E2E_DB_URL, E2E_REDIS_URL } from "./dbEnv.mjs";

const APP = "http://127.0.0.1:5173";
const TARGET = "http://127.0.0.1:9999";
const PY = process.env.TP_PYTHON
  ?? path.resolve(import.meta.dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
const DB = E2E_DB_URL;
const REDIS = E2E_REDIS_URL;

const tag = () => Date.now().toString(36);

/** 每次运行唯一的端口：20000-60000 里随机，避开靶场/后端/常见 dev 端口。 */
const closedPort = () => 20000 + Math.floor(Math.random() * 40000);

/**
 * 造一条必然 error 的步：GET 一个端口上没人听的请求 → 执行核按「请求根本没跑成」判
 * error（handlers.py _send → StepOutcome("error", "请求失败：" + str(result.error))，
 * handlers.py:234）→ run 级 error，rec.error = 该步消息（runner.py:528 failed/error 都写）。
 * 选 127.0.0.1 的随机高位端口：connect 立即 ECONNREFUSED，既确定又不依赖外网/DNS。
 */
const deadUrl = () => "http://127.0.0.1:" + closedPort() + "/dead";

/** 建场景 → POST /run（inline 档）→ 轮询到终态，返回 runId。 */
async function runToTerminal(token, projectId, scenario, want) {
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, priority: "P2", variables: {}, fail_fast: true,
    project_public: true, ...scenario } });
  expect(sc.status).toBe(201);
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 45_000, intervals: [1000] }).toMatch(want);
  return runId;
}

/** 落地 /#/bench：未武装时输入框不存在（bench.tsx:198 的 armed 门），点「开始新会话」才可见。 */
async function armBench(page) {
  await expect(page.getByTestId("bench")).toBeVisible();
  // bench.tsx:291 未武装空态原话——输入区此刻根本不在 DOM 里
  await expect(page.getByText("选择项目并点「开始新会话」")).toBeVisible();
  await page.getByTestId("bench-start").click(); // bench.tsx:194-195
  await expect(page.getByTestId("bench-input")).toBeVisible();
}

test("① 报告详情点「让 Pilot 总结失败原因」：真跳到 /#/bench，真实败因草稿整段落进输入框，一个字节都没发出去", async ({ page }) => {
  test.setTimeout(180_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d84预填报告");
  const key = "d84-" + t; // /flaky 计数器全局-per-key：每次跑唯一（reports.spec.mjs:13 同款）
  const sceneName = "预填验证场景-" + t;
  const runId = await runToTerminal(token, projectId, {
    name: sceneName,
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "http_direct", name: "必败步骤",
        config: { method: "GET", url: TARGET + "/flaky?key=" + key + "&fail_first=1",
          assertions: [{ type: "status_code", expected: 200 }] } },
      { key: "s2", kind: "sleep", name: "不会被跑到", config: { ms: 100 } },
    ] },
  }, /failed/);

  // 库里两条事实：①失败步的 detail 里没有 error 键（断言失败不是请求失败；线上形状是
  // 键整个缺席，前端 typeof e === "string" 对 null/缺席同一处理，这里按线上形状断）——
  // 草稿「报错」行的省略分支（reportDetail.tsx:397）踩的是真数据，不是桩；
  // ②failed 轮 runner 也写 rec.error = 首个坏步的结论（runner.py:528），
  // 所以「运行级报错」行在 failed 轮就在，③ 的 error 轮是它另一份真值而非它的存在前提。
  const detail = await asUser(token, "get", "reports/" + runId + "/steps?project_id=" + projectId
    + "&step_key=s1&row_no=0");
  expect(detail.status).toBe(200);
  expect(detail.body.detail.error ?? null).toBeNull();
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.status).toBe(200);
  const runError = rep.body.error;
  expect(runError).toContain("条断言未通过"); // 执行核 _describe_assertions 的结论消息上稿

  const writes = [];
  const streams = [];
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() !== "GET" && u.includes("/api/v1/")) writes.push(r.method() + " " + u);
    if (u.includes("/api/v1/events/agent/")) streams.push(u);
  });

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  const btn = page.getByTestId("report-ask-pilot");
  await expect(btn).toHaveText("让 Pilot 总结失败原因"); // reportDetail.tsx:468-470
  await btn.click();

  // 真路由跳转：不是 jsdom 里 spy 到的 nav 调用，是浏览器真的换了页
  await expect(page).toHaveURL(/#\/bench$/);
  // 落地瞬间（还没人点过「开始新会话」）：状态还是初值——自动发的构建这里已是「运行中」
  await expect(page.getByTestId("bench-status")).toHaveText("未开始"); // bench.tsx:36 初值
  await armBench(page);

  const input = page.getByTestId("bench-input");
  const draft = await input.inputValue();
  // 逐字（报告 ID 每跑不同，故逐行断骨架 + 动态值拼进模板）
  expect(draft.split("\n")[0]).toBe("请帮我总结这份运行报告的失败原因。"); // reportDetail.tsx:400
  expect(draft).toContain("报告对象：" + sceneName + "（场景）"); // :403 + runVocab.ts:86 scenario
  expect(draft).toContain("报告 ID：" + runId); // :404
  expect(draft).toContain("运行状态：断言失败"); // :404 + runVocab.ts:56 failed（STATUSES）
  expect(draft).toContain("失败步骤（共 1 个）："); // :411（bad.length === shown.length 分支）
  expect(draft).toContain("1. 必败步骤 · http_direct · 断言失败"); // :416-418 + runVocab.ts:69 fail
  // failed 轮 runner 同样写 rec.error = 首个坏步的结论消息（runner.py:528）→ :406 分支在真数据上就在
  expect(draft).toContain("运行级报错：" + runError); // :406 逐字（未超 PILOT_TEXT_CLIP=500，clip 原样返回）
  // s1 的 detail 里没有 error 键 → 它名下不许有「报错」行：宁缺不编（:419 的 errs[i] 假值分支）
  const stepTail = draft.slice(draft.indexOf("1. 必败步骤"));
  expect(stepTail).not.toContain("报错");

  // 预填不偷发（功能的全部意义）。出货口径注意：草稿有字 → 发送钮是**开着**的
  // （bench.tsx:230 disabled={!draft.trim() || running}；单测 bench.test.tsx:477 也钉死
  // 预填后 disabled===false——草稿是真草稿，人随时可按）。所以「没发出去」的证据不是
  // 钮的禁用态，而是三样一起：① 草稿原封不动还坐在输入框里（真发出去 send() 会清空它，
  // bench.tsx:128）；② event-card 零张（USER 卡 = 发过，bench.tsx:209）；③ 请求层零写
  // 零开流。自动发送的构建三条全炸。
  await expect(page.getByTestId("bench-send")).toBeEnabled(); // 钮开着 ≠ 发过：见上
  await expect(input).toHaveValue(draft); // 草稿没被 send() 清走
  await expect(page.getByTestId("event-card")).toHaveCount(0); // bench.tsx:209 事件卡一张都不许有（USER 卡=发过）
  // 网络层同样干净：零写请求（sessions/messages 都在 writes 里会现形）、零 SSE 开流
  expect(writes).toEqual([]);
  expect(streams).toEqual([]);
  // 没点过「开始新会话」之前的空态也验不到 armed 之外：armed 后按钮变「重新开始」（bench.tsx:195）
  await expect(page.getByTestId("bench-start")).toHaveText("重新开始");
});

test("② 注入是一次性的：落地后整页 reload 不再倒回同一段草稿；编辑一笔再 reload 旧草稿也不复活", async ({ page }) => {
  test.setTimeout(180_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d84一次性");
  const key = "d841shot-" + t;
  const runId = await runToTerminal(token, projectId, {
    name: "一次性注入场景-" + t,
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "http_direct", name: "必败步骤",
        config: { method: "GET", url: TARGET + "/flaky?key=" + key + "&fail_first=1",
          assertions: [{ type: "status_code", expected: 200 }] } },
    ] },
  }, /failed/);

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await page.getByTestId("report-ask-pilot").click();
  await expect(page).toHaveURL(/#\/bench$/);
  await armBench(page);
  const input = page.getByTestId("bench-input");
  const seeded = await input.inputValue();
  expect(seeded).toContain("请帮我总结这份运行报告的失败原因。"); // reportDetail.tsx:400
  expect(seeded).toContain("报告 ID：" + runId); // :404

  // 整页 reload：data router 的 history.state 已被接收端 replace 清掉
  // （bench.tsx:65 nav(..., {replace:true, state:null})）→ 同一条草稿不许倒第二遍
  await page.reload();
  await armBench(page);
  await expect(page.getByTestId("bench-input")).toHaveValue("");
  await expect(page.getByTestId("bench-send")).toBeDisabled(); // bench.tsx:230 !draft.trim()

  // 人已动过笔 → reload：旧草稿不复活；同时这测试顺带钉「reload 不覆盖人写的字」？
  // 不——reload 本来就丢未提交输入，那是浏览器的行为不是本功能的账。这里只钉注入侧：
  // 编辑后 reload 输入框为空（seed 没有复活，人的草稿浏览器本来也不持久——不假装它能）。
  await input.fill("人自己改的一句-" + t);
  await page.reload();
  await armBench(page);
  const after = await page.getByTestId("bench-input").inputValue();
  expect(after).not.toContain("请帮我总结这份运行报告的失败原因。"); // 不复活
  expect(after).not.toContain("报告 ID：" + runId);
  expect(after).toBe("");
});

test("③ 运行级报错的草稿：真实 error 运行（端口没人听）把 run_record.error 逐字带进「运行级报错」行；断言失败步不带「报错」行", async ({ page }) => {
  test.setTimeout(180_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d84运行级报错");
  const sceneName = "运行级报错场景-" + t;
  const runId = await runToTerminal(token, projectId, {
    name: sceneName,
    // fail_fast=false：e1 报错后 s1 仍要跑到（草稿要同时吃到 error 步与 fail 步两种形状；
    // 默认 true 时 e1 一红 s1 就变 skip，「共 2 个」与两步行都不成立）
    fail_fast: false,
    step_graph: { version: 1, nodes: [
      { key: "e1", kind: "http_direct", name: "打不开的步骤", config: { method: "GET", url: deadUrl() } },
      { key: "s1", kind: "http_direct", name: "必败步骤",
        config: { method: "GET", url: TARGET + "/flaky?key=d84err-" + t + "&fail_first=1",
          assertions: [{ type: "status_code", expected: 200 }] } },
    ] },
  }, /error/);

  // 库里事实：run.error = 首个坏步 e1 的结论消息（runner.py:528 error 轮写 rec.error =
  // bad.message[:300]；e1 消息 = handlers.py:234「请求失败：」+ core 的异常名+原因）。
  // error 步的 detail.error 是 core.py:85 的裸异常串（type(e)+原因，不带「请求失败：」前缀），
  // 草稿「报错」行拼的是这份真值而非推测。
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.status).toBe(200);
  expect(rep.body.status).toBe("error");
  const runError = rep.body.error;
  expect(runError).toContain("请求失败："); // handlers.py:234 步骤消息前缀 → run.error 同源
  const e1 = await asUser(token, "get", "reports/" + runId + "/steps?project_id=" + projectId
    + "&step_key=e1&row_no=0");
  expect(e1.status).toBe(200);
  expect(typeof e1.body.detail.error).toBe("string"); // core.py:85：error 步 detail.error 有真值
  expect(e1.body.detail.error.length).toBeGreaterThan(0);
  const s1 = await asUser(token, "get", "reports/" + runId + "/steps?project_id=" + projectId
    + "&step_key=s1&row_no=0");
  expect(s1.status).toBe(200);
  expect(s1.body.detail.error ?? null).toBeNull(); // 断言失败步：线上形状是 error 键缺席 → 报错行省略

  const writes = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/v1/")) writes.push(r.method() + " " + r.url());
  });

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-overview-status")).toHaveText("请求失败"); // :459 + runVocab.ts:57 error
  await page.getByTestId("report-ask-pilot").click();
  await expect(page).toHaveURL(/#\/bench$/);
  await armBench(page);

  const draft = await page.getByTestId("bench-input").inputValue();
  expect(draft).toContain("运行状态：请求失败"); // reportDetail.tsx:404 + runVocab.ts:57
  expect(draft).toContain("运行级报错：" + runError); // :406 —— 库里 run.error 逐字上稿
  expect(draft).toContain("失败步骤（共 2 个）："); // :411 两步都败（e1 error + s1 fail）
  expect(draft).toContain("1. 打不开的步骤 · http_direct · 请求失败"); // :416-418 + runVocab.ts:71
  expect(draft).toContain("   报错：" + e1.body.detail.error); // :419 缩进三格
  expect(draft).toContain("2. 必败步骤 · http_direct · 断言失败"); // :416-418 + runVocab.ts:69
  // fail 与 error 的口径差：s1 的报错行不许出现（error 键缺席的步整行省略）
  const tail = draft.slice(draft.indexOf("2. 必败步骤"));
  expect(tail).not.toContain("报错");

  // 这条测的虽是草稿内容，「不偷发」的最低账照付（钮开着是出货口径，见 ① 的注释）：
  // 草稿还在、零事件卡、零写请求
  await expect(page.getByTestId("bench-send")).toBeEnabled();
  await expect(page.getByTestId("bench-input")).toHaveValue(draft); // 发过会被清空（bench.tsx:128）
  await expect(page.getByTestId("event-card")).toHaveCount(0);
  expect(writes).toEqual([]);
});

// ── ADB 设备卡片墙侧 ─────────────────────────────────────────────────────────
// 设备直插 DB + 占用锁真种 Redis（adbDevice.spec.mjs 的既有配方：tp.adb.dev.{serial} =
// adb_bus 前缀 "tp." + adb_lock.lock_key(serial)，读路径 occupied(serial) 读的就是这两个键）：
// 草稿里的「占用/排队/心跳」是被测端点 /occupation 的真响应 + 真心跳帧，不是 mock 响应体。

function seedDevice(projectId, d) {
  const spec = JSON.stringify({ db: DB, redis: REDIS, project_id: projectId, device: d });
  const out = execFileSync(PY, ["-c", SEED_DEVICE_PY, spec], {
    cwd: path.resolve(import.meta.dirname, "..", "..", "backend"), encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

function cleanDeviceLocks(serials) {
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

const SEED_DEVICE_PY = `
import json, sys, uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
import pymysql
import redis

spec = json.loads(sys.argv[1])
u = urlsplit(spec["db"])
ru = urlsplit(spec["redis"])
# db 号在 URL path 里（/6）：漏了它锁就种在 0 号库，后端永远读不到（adbDevice.spec 同款坑）
r = redis.Redis(host=ru.hostname, port=ru.port or 6379,
                password=ru.password or None, db=int((ru.path or "/0").lstrip("/") or 0),
                decode_responses=True)
conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                       password=u.password, database=u.path.lstrip("/"), autocommit=True)
now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
d = spec["device"]
did = str(uuid.uuid4())
frame = {"model": "Pixel 6", "os": "13", "online": True, "battery_level": 86,
         "last_check_at": datetime.now(timezone.utc).isoformat()}
with conn.cursor() as cur:
    cur.execute(
        "INSERT INTO adb_device (id, project_id, name, serial, connect_type, wifi_addr,"
        " enabled, last_state, owner_id, project_public, status, created_at, updated_at)"
        " VALUES (%s,%s,%s,%s,'wifi',%s,1,%s,NULL,1,'normal',%s,%s)",
        (did, spec["project_id"], d["name"], d["serial"], d["serial"].rsplit(":", 1)[0],
         json.dumps(frame, ensure_ascii=False), now, now))
# 真种设备锁（持有者 token + 1 人排队），与 adbDevice.spec 的 occupied 卡同形状
r.set("tp.adb.dev." + d["serial"], "run:e2e-d84:1:host:4242", ex=300)
r.rpush("tp.adb.dev.q." + d["serial"], "run:e2e-d84-q:1:h:1")
r.expire("tp.adb.dev.q." + d["serial"], 300)
conn.close()
print(json.dumps({"id": did}))
`;

test("④ ADB 设备卡点「让 Pilot 排查」：卡片读数（含真种的占用锁）逐字进草稿并真跳到 /#/bench，零写请求；回收站视图没有这个出口", async ({ page }) => {
  test.setTimeout(180_000);
  const t = tag();
  // 设备直插走 SQL/Redis（seedDevice），这一侧不碰 API 写面，token 用不上就不解构
  const { projectId, project } = await seedProject(page, "d84预填设备");
  const dev = {
    // 两次随机八位组：serial 若跨运行撞库（历史行不删），直插会吃唯一约束
    name: "排查机-" + t,
    serial: "10.84." + Math.floor(Math.random() * 200) + "." + (1 + Math.floor(Math.random() * 250)) + ":5555",
  };
  const { id: deviceId } = seedDevice(projectId, dev);
  try {
    const writes = [];
    const streams = [];
    page.on("request", (r) => {
      const u = r.url();
      if (r.method() !== "GET" && u.includes("/api/v1/")) writes.push(r.method() + " " + u);
      if (u.includes("/api/v1/events/agent/")) streams.push(u);
    });

    await page.goto(APP + "/#/adb/devices");
    await expect(page.getByTestId("page-adb-devices")).toBeVisible();
    const card = page.getByTestId("adb-device-card-" + deviceId);
    await expect(card).toBeVisible();
    // 占用读数到位（卡片状态徽标是 /occupation 的下游：卡变「占用」= occ[deviceId] 已就位，
    // askPilot 那一刻 pilotDraftFor 拿到的就是带真值的 occ，不会踩「读数缺失」分支）
    await expect(card.getByTestId("adb-device-state")).toHaveText("占用"); // adbDevices.tsx:44 CARD_LABEL
    const ask = card.getByTestId("adb-device-ask-pilot");
    await expect(ask).toHaveText("让 Pilot 排查"); // adbDevices.tsx:474
    await ask.click();

    await expect(page).toHaveURL(/#\/bench$/);
    // 落地瞬间（没人点过「开始新会话」）：状态还是初值；自动发的构建这里已是「运行中」
    await expect(page.getByTestId("bench-status")).toHaveText("未开始"); // bench.tsx:36 初值
    await armBench(page);
    const draft = await page.getByTestId("bench-input").inputValue();
    // 逐字对表 pilotDraftFor（adbDevices.tsx:113-133），值从卡片/库上真读数拼出
    expect(draft.split("\n")[0])
      .toBe("请帮我排查这台 ADB 设备（以下均为设备卡片墙当前读数，非推测）："); // :114
    expect(draft).toContain("- 设备：" + dev.name); // :115
    expect(draft).toContain("- 序列号：" + dev.serial); // :116
    expect(draft).toContain("- 项目：" + project.name); // :118（seedProject 建的项目）
    expect(draft).toContain("- 卡片状态：占用"); // :119 CARD_LABEL.occupied
    expect(draft).toContain("- 电量：电 86%"); // :122 + batteryBadge(:67) 帧里 86
    expect(draft).toContain("- 占用：被 run:e2e-d84:1:host:4242 持有"); // :128，token 是本测试种进 Redis 的
    expect(draft).toContain("- 排队：1 人"); // :129 queued=1（种了一个排队 token）
    expect(draft).toContain("- 心跳：最后心跳 刚刚"); // :133 agoLabel(<60s)（:90）
    expect(draft).not.toContain("占用读数缺失"); // :126 —— occ 在场就不许说缺失

    // 预填不偷发（口径同 ①：钮开着 = 草稿活着可发，没发过的证据是草稿原位未动 +
    // 零事件卡 + 网络层零写零开流）
    await expect(page.getByTestId("bench-send")).toBeEnabled(); // bench.tsx:230 草稿有字钮就开
    await expect(page.getByTestId("bench-input")).toHaveValue(draft); // 发过会被清空（bench.tsx:128）
    await expect(page.getByTestId("event-card")).toHaveCount(0); // bench.tsx:209
    // 「未开始」已在上 arm 前钉过；start() 把状态置「空闲」（bench.tsx:100）——
    // 偷发的构建这里要么「运行中」要么出 USER 卡，两头都过不去
    await expect(page.getByTestId("bench-status")).toHaveText("空闲"); // bench.tsx:100
    expect(writes).toEqual([]);
    expect(streams).toEqual([]);

    // 一次性注入（接收端与发送端无关，ADB 入口也要吃到 replace 清 state）
    await page.reload();
    await armBench(page);
    await expect(page.getByTestId("bench-input")).toHaveValue("");

    // 回收站视图没有这个出口（adbDevices.tsx:457 inRecycled 分支只渲染 恢复/彻底删除）：
    // 回收 → 进回收站视图 → 出口不存在 → 恢复回正常视图 → 出口回来。
    // D167 新闸先钉住：这台设备占着执行锁（本测试开头真种的），删除必被 409 拦——
    // 「被占用删不掉」与「清锁后能回收」两个形状共用同一把锁，先钉拦、再钉放。
    await page.goBack(); // 回设备页（SPA 内导航，零写请求不破）
    await expect(page.getByTestId("page-adb-devices")).toBeVisible();
    await page.getByTestId("adb-device-card-" + deviceId)
      .getByTestId("adb-device-delete").click(); // adbDevices.tsx:488
    const confirm = page.locator(".ant-modal-confirm").last();
    await expect(confirm).toContainText("放入回收站？"); // adbDevices.tsx:358 标题句式
    await confirm.getByRole("button", { name: "放入回收站" }).click(); // :361 okText
    await expect(page.locator(".ant-message")).toContainText("设备正被执行锁占用"); // D167 原话
    await expect(page.getByTestId("adb-device-card-" + deviceId)).toBeVisible(); // 拦下了，行还在
    cleanDeviceLocks([dev.serial]); // 自清这把锁，继续钉正常回收路（finally 再清一次无害）
    await page.getByTestId("adb-device-card-" + deviceId)
      .getByTestId("adb-device-delete").click();
    const confirm2 = page.locator(".ant-modal-confirm").last();
    await confirm2.getByRole("button", { name: "放入回收站" }).click();
    await expect(page.getByTestId("adb-device-card-" + deviceId)).toHaveCount(0);
    await page.getByTestId("adb-device-recycled").click(); // adbDevices.tsx:507
    const ghost = page.getByTestId("adb-device-card-" + deviceId);
    await expect(ghost).toBeVisible();
    await expect(ghost.getByTestId("adb-device-ask-pilot")).toHaveCount(0); // 回收站没有出口
    await expect(ghost.getByTestId("adb-device-test")).toHaveCount(0); // 与「测试连接」同进退
    await ghost.getByTestId("adb-device-restore").click(); // 恢复，收尾不留垃圾
    await expect(page.locator(".ant-message")).toContainText("已恢复"); // adbDevices.tsx:366
  } finally {
    cleanDeviceLocks([dev.serial]); // 锁键自清（TTL 300s 是兜底不是理由）
  }
});
