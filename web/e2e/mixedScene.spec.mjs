// 1D T10：混合场景 DoD 的 e2e 证据（计划 T10「API 步骤 + sleep + if + adb_case 一景跑通
// → 报告页三主体着色/截图内联」，即蓝图 §13:1597「1D 末达成混合场景端到端 DoD」那条）。
//
// ✅ 本文件**跑过**（T11 门禁轮）：不带变量 = CI 形状 79 passed / 2 skipped（本文件 ① 绿、②③ skip
// 并说明原因）；带 TP_ADB_PATH/FAKE_ADB_STATE = 81 passed / 0 skipped（三条全绿，②③ 吃到假设备）。
//
// 假 adb 的接法（与前两份 adb 规格的边界差别在这里）：adbDevice.spec 头注说「webServer 进程
// 环境没有 TP_ADB_PATH/FAKE_ADB_STATE」——本规格不改共享 webServer，改用两条确定性通路：
//   A. 默认形状（机器上没显式配 TP_ADB_PATH、PATH/SDK 也查不到 adb 时，CI 即此形状）：
//      所有 adb 子进程 = 「没找到 adb 可执行」（adb_path.ADB_INSTALL_HINT，adb_executable 响亮）。
//      于是「UI 添加设备必 422 回显」「adb 步骤必 error 且报错原文是安装指引」都是**确定性**的，
//      不猜机器（adbDevice.spec ③ 的同款「两种终态谁先到算谁」留给真装了 adb 的本机）。
//   B. opt-in 全绿通路：起 e2e 后端前显式 TP_ADB_PATH=<fake-adb 生成物> +
//      FAKE_ADB_STATE=<同目录 state.json>（本文件 export FakeAdb 就是生成这对路径的工具，
//      cwd 必须是 backend——manager 里的 fake_adb.py 是相对路径）。这条通路吃满 DoD：
//      真 POST /adb-devices 建建设备（fake 对 connect 回 "connected to"）、执行体真打 fake、
//      dump-mode 降级如实可见（CI 没装 atx，adb_u2.connect_session 必回 None）、截图内联真解码。
//      未设 TP_ADB_PATH 时本用例如实 skip 并说明原因（不装绿，纪律 1）。
//
// 为什么场景执行走 API（asUser POST run）而不是点「执行」按钮：sceneRun.spec 钉的就是按钮+SSE
// 那半边，本文件钉的是「混合图 → 库 → 报告页」这半边；数据事实走 API 是既有分工。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import path from "node:path";
import { asUser, seedProject } from "./helpers.mjs";

const APP = "http://127.0.0.1:5173";
const TARGET = "http://127.0.0.1:9999";
const PY = process.env.TP_PYTHON
  ?? path.resolve(import.meta.dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
const BACKEND_DIR = path.resolve(import.meta.dirname, "..", "..", "backend");

/**
 * 生成/复用假 adb 装配（FakeDeviceManager 的 CLI 等价，不动共享 webServer）：
 * 打印 {executable, state}，state 文件预置一台 online 设备（fake_adb 的 with_device 形状）。
 */
export function FakeAdb() {
  const out = execFileSync(PY, ["-c", `
import json, os, sys
sys.path.insert(0, os.getcwd())  # cwd 必须是 backend：manager 内 fake_adb.py 按相对路径生成 wrapper
from scripts.fake_device import FakeDeviceManager
mgr = FakeDeviceManager().with_device(serial="127.0.0.1:5555")
print(json.dumps({"executable": mgr.adb(), "state": str(mgr.state_path)}))
`], { cwd: BACKEND_DIR, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

/** 当前后端进程能不能真跑 adb：只有「显式注入了 TP_ADB_PATH 且文件存在」才算确定能跑。
 *  没注入时 PATH/SDK 会不会撞上一台真 adb 不可知（CI 里必无），因此按「不可知 = 默认形状」处理。 */
function backendHasAdb() {
  const p = process.env.TP_ADB_PATH;
  return Boolean(p && existsSync(path.resolve(BACKEND_DIR, p)));
}

/** 每用例专属场景：api(http_direct) + sleep + if + adb_case，serial 掺 tag 防跨用例串扰。 */
async function seedMixed(token, projectId, tag, adbCaseId, extra = {}) {
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "混合场景DoD-" + tag, priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "api", kind: "http_direct", name: "接口步：健康检查",
        config: { method: "GET", url: TARGET + "/healthz",
          assertions: [{ type: "status_code", expected: 200 }] } },
      { key: "nap", kind: "sleep", name: "等待步", config: { ms: 100 } },
      { key: "gate", kind: "if", name: "判断步", config: { branches: [
        { cond: "ctx.vars['never_set'] == '1'", children: [
          { key: "gate.dead", kind: "sleep", name: "不该走到的分支", config: { ms: 10 } }] },
        { cond: "else", children: [
          { key: "gate.live", kind: "sleep", name: "兜底分支", config: { ms: 10 } }] } ] } },
      { key: "adb", kind: "adb_case", name: "设备步：假机三连", ref: adbCaseId,
        config: { device_policy: "specified", device_serial: "127.0.0.1:" + tag, ...extra } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status, JSON.stringify(sc.body)).toBe(201);
  return sc.body.id;
}

/** 建 ADB 用例：connect + assert_text（fake 默认树含「登录」）+ screenshot（制品源）。 */
async function seedAdbCase(token, projectId, name, addr, extra = {}) {
  const c = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name, priority: "P2",
    steps: [
      { id: "a1", type: "connect", config: { addr } },
      { id: "a2", type: "assert_text", config: { text: "登录", timeout_ms: 2000 } },
      { id: "a3", type: "screenshot" },
    ], ...extra,
  } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body.id;
}

async function waitTerminal(token, projectId, runId, timeout = 150_000) {
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout, intervals: [1000] }).toMatch(/passed|failed|error|cancelled/);
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  return rep.body;
}

// ══════════ ① 默认形状（CI 即此形状，零 adb 依赖）：混合一景跑通，缺设备如实红 ══════════
// 图的形状就是 DoD 的形状：api 步 + sleep + if（命中分支真跑、未命中分支不出行）+ adb_case。
// adb 挂「默认设备未登记」这条与 adb 二进制无关的确定性路（debug_services._resolve_parts
// 原文「不在本项目可用设备里」）——api/sleep/if 三步照常绿，adb 步 error 且**点名原因**，
// run 终态 error；页面不许演出一张不存在的截图（纪律 1：没跑成设备就是没制品）。
test("① 混合一景（api+sleep+if+adb_case）：无设备可跑时 api/sleep/if 照常绿、adb 步点名报错、零假制品", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = Date.now().toString(36);
  const { token, projectId } = await seedProject(page, "t10-mixed-nodev");
  const caseId = await seedAdbCase(token, projectId, "混合用ADB用例-" + tag, "127.0.0.1:5555",
    { default_device: "127.0.0.1:" + tag }); // 未登记的 serial：存期不校验（§4.5），跑期必须点名
  const scenarioId = await seedMixed(token, projectId, tag, caseId,
    { device_policy: undefined, device_serial: undefined });

  const run = await asUser(token, "post", "scenarios/" + scenarioId + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const body = await waitTerminal(token, projectId, run.body.run_id);
  const runId = run.body.run_id;

  // 库侧事实：终态 error（adb 步的 error 参与判定），顶层四步 3 过 1 错
  expect(body.status).toBe("error");
  expect(body.subject_type).toBe("scenario");
  expect(body.stats.total).toBe(4);
  expect(body.stats.pass).toBe(3);
  expect(body.stats.error).toBe(1);

  // adb 步明细点名到 serial 与原因（不是含糊的「执行失败」）；且没有制品摘要——没连设备就没图
  const adbStep = await asUser(token, "get", "reports/" + runId + "/steps",
    { params: { project_id: projectId, run_id: runId, step_key: "adb", row_no: 0 } });
  expect(adbStep.status).toBe(200);
  expect(adbStep.body.status).toBe("error");
  expect(JSON.stringify(adbStep.body.detail)).toContain("没有设备可跑");
  expect(JSON.stringify(adbStep.body.detail)).toContain("127.0.0.1:" + tag);
  expect(body.artifacts).toEqual([]);

  // UI：报告中心能按「场景」筛出这条 → 详情页四节点分色 3 绿 1 红
  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-subject-type")).toHaveText("场景");
  await expect(page.getByTestId("report-step-row").filter({ hasText: "健康检查" })).toBeVisible();
  // 命中分支的孩子真落库（gate.live 挂在 gate 下）；未命中分支不落行——树里没走过的那条不存在
  await expect(page.getByTestId("report-step-row")).toHaveCount(5);
  await expect(page.locator("[data-testid='report-step-row'][data-key='api']"))
    .toHaveAttribute("data-status", "pass");
  await expect(page.locator("[data-testid='report-step-row'][data-key='nap']"))
    .toHaveAttribute("data-status", "pass");
  await expect(page.locator("[data-testid='report-step-row'][data-key='gate']"))
    .toHaveAttribute("data-status", "pass");
  await expect(page.locator("[data-testid='report-step-row'][data-key='gate.live']"))
    .toHaveAttribute("data-status", "pass");
  await expect(page.locator("[data-testid='report-step-row'][data-key='gate.dead']")).toHaveCount(0);
  await expect(page.locator("[data-testid='report-step-row'][data-key='adb']"))
    .toHaveAttribute("data-status", "error");
  // 只读画布同一支笔：三个绿一个红（api/sleep/if/adb 四主体着色，红的是没设备不是断言失败）
  await expect(page.getByTestId("scene-node-api")).toHaveAttribute("data-run-status", "pass");
  await expect(page.getByTestId("scene-node-nap")).toHaveAttribute("data-run-status", "pass");
  await expect(page.getByTestId("scene-node-gate")).toHaveAttribute("data-run-status", "pass");
  await expect(page.getByTestId("scene-node-adb")).toHaveAttribute("data-run-status", "error");
  // 没跑成设备就是没截图：页面不许摆出一张装绿的图
  await expect(page.getByTestId("report-artifact-img")).toHaveCount(0);
});

// ══════════ ② opt-in 全绿通路：混合一景真跑到假设备（DoD 的正向半边） ══════════
// 前置：起 e2e 前注入 TP_ADB_PATH/FAKE_ADB_STATE（生成法见文件头与 README-1d-demo）。
// 真 POST /adb-devices（fake 的 connect 应「connected to」）→ 场景执行 → 报告页四步全绿、
// adb 步明细带真 device + mode（CI 没 atx 会话 ⇒ dump 降级，这是预期形状不是失败）。
// 如实记录一处现状边界（报告里有 file:line）：adb 子 run 的制品落在子 run 名下，
// 场景报告的 run_artifact 里没有它 → 场景报告页右栏此刻渲染不出这张内联截图；
// 截图内联的 UI 证据走 ③（独立 ADB 运行报告 + 调试面板，两处都是同一份字节）。
test("② 混合一景真跑（假设备）：api/sleep/if/adb 全绿 + adb 明细点名设备与模式", async ({ page }) => {
  test.skip(!backendHasAdb(),
    "未注入 TP_ADB_PATH：全绿通路要求后端进程挂假 adb（见 README-1d-demo §门禁不依赖 emulator 一节）");
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const serial = "127.0.0.1:5555";
  const { token, projectId } = await seedProject(page, "t10-mixed-fake");

  // 设备走真端点（fake adb 对 connect 回 connected）——不直插设备行，建连验证链路也要吃到
  const dev = await asUser(token, "post", "adb-devices", { data: {
    project_id: projectId, name: "假机-" + tag, serial, connect_type: "wifi" } });
  expect(dev.status, "设备入库失败——八成是 8321 被没带假 adb 环境的进程占了："
    + JSON.stringify(dev.body)).toBe(201);

  const caseId = await seedAdbCase(token, projectId, "混合真跑ADB用例-" + tag, serial);
  const scenarioId = await seedMixed(token, projectId, tag, caseId,
    { device_policy: "any_idle", device_serial: undefined });
  const run = await asUser(token, "post", "scenarios/" + scenarioId + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const runId = run.body.run_id;
  const body = await waitTerminal(token, projectId, runId);

  expect(body.status).toBe("passed");
  expect(body.stats).toMatchObject({ total: 4, pass: 4, fail: 0, error: 0 });

  // adb 步明细（API 侧数据事实）：跑在哪台 + 什么模式 + 断言行 + 制品摘要都在
  const adbStep = await asUser(token, "get", "reports/" + runId + "/steps",
    { params: { project_id: projectId, run_id: runId, step_key: "adb", row_no: 0 } });
  expect(adbStep.status).toBe(200);
  expect(adbStep.body.kind).toBe("adb_case");
  const d = adbStep.body.detail ?? {};
  expect(d.device).toBe(serial);
  // dump 降级在 CI 是预期形状（没 atx 会话）；mode 缺失=没连上，那是红不是绿路径
  expect(["u2", "dump"]).toContain(d.mode);
  const shots = (d.artifacts ?? []).filter((a) => a.kind === "SCREENSHOT");
  expect(shots.length).toBeGreaterThanOrEqual(1);
  expect(String(shots[0].ref)).toMatch(/\.png$/);
  expect(JSON.stringify(d.assertions ?? [])).toContain("assert_text");

  // 现状边界如实记录：场景 run 自己的 run_artifact 不含 adb 子 run 的截图
  //（h_adb_case 不走 StepOutcome.artifacts 通道，handlers.py:561-563 原话）——
  // 这不是「截图丢了」（字节在子 run 名下、上查 detail.artifacts.ref 可取），
  // 但场景报告页右栏不渲染子 run 的图（见 README-1d-demo 已知限制）。
  const sceneShots = (body.artifacts ?? []).filter((a) => a.kind === "SCREENSHOT");
  expect(sceneShots).toEqual([]);

  // UI：报告页四个顶层主体按结果着色（全绿），命中分支的孩子在树里、未命中的不在
  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-subject-type")).toHaveText("场景");
  await expect(page.getByTestId("report-step-row")).toHaveCount(5);
  for (const k of ["api", "nap", "gate", "adb", "gate.live"]) {
    await expect(page.locator("[data-testid='report-step-row'][data-key='" + k + "']"))
      .toHaveAttribute("data-status", "pass");
  }
  await expect(page.getByTestId("scene-node-adb")).toHaveAttribute("data-run-status", "pass");
  // 点 adb 汇总节点 → 右栏出 DebugPanel 的断言卡（期望「登录」= fake 默认控件树里的真文本）。
  // D154 前 adb 与 ui_case 不同流：adb 汇总掉进通用断言表 report-assert-row；修完与 UI 同形，
  // 断言行改由断言卡 assertion-card 承载（形状变化即本修的目标，见报告详情右栏分流）。
  await page.locator("[data-testid='report-step-row'][data-key='adb']").click();
  const panel = page.getByTestId("report-step-detail");
  await expect(panel.getByTestId("assertion-card").first()).toContainText("assert_text");
  await expect(panel.getByTestId("assertion-card").first()).toContainText("登录");
});

// ══════════ ③ opt-in 全绿通路：截图内联的两处真 UI（独立 ADB 运行报告 + 调试面板） ══════════
// DoD 的「截图内联」在场景报告页今天渲染不出来（见 ② 里如实钉下的边界：字节在子 run 名下）。
// 这条把内联证据钉在**真的有 run_artifact 的两页**上：独立 adb_case 运行的报告（trigger=manual、
// 「ADB 用例」类型标、case+命令行、a3 截图 naturalWidth>0——真 PNG 解码，不是 src 拼错也绿）
// 与用例详情页的调试面板（dump 降级徽标当场可见 + 同案截图 + 设备名）。
test("③ 独立 ADB 运行：报告页「ADB 用例」着色 + 截图真解码内联；调试面板 dump 徽标可见", async ({ page }) => {
  test.skip(!backendHasAdb(),
    "未注入 TP_ADB_PATH：全绿通路要求后端进程挂假 adb（见 README-1d-demo）");
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const serial = "127.0.0.1:5555";
  const { token, projectId } = await seedProject(page, "t10-adb-green");
  const dev = await asUser(token, "post", "adb-devices", { data: {
    project_id: projectId, name: "假机R-" + tag, serial, connect_type: "wifi" } });
  expect(dev.status).toBe(201);
  const caseId = await seedAdbCase(token, projectId, "内联截图用例-" + tag, serial,
    { default_device: serial });

  // 设备卡片墙的三态带在假 adb 下真绿（建连首帧 online ⇒ 空闲；run 锁释放后仍空闲）
  await page.goto(APP + "/#/adb/devices");
  await expect(page.getByTestId("adb-device-card-" + dev.body.id)
    .getByTestId("adb-device-state")).toHaveText("空闲");

  const run = await asUser(token, "post", "adb-cases/" + caseId + "/run",
    { data: { project_id: projectId, case_id: caseId } });
  expect(run.status).toBe(200);
  const runId = run.body.run_id;
  const body = await waitTerminal(token, projectId, runId);
  expect(body.status).toBe("passed");
  expect(body.subject_type).toBe("adb_case");
  expect(body.trigger).toBe("manual");

  // 报告中心按对象类型筛得出（R112 词表的 ADB 半边）
  await page.goto(APP + "/#/reports");
  await page.getByTestId("reports-filter-subject-type").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "ADB 用例" }).first().click();
  await expect(page.getByTestId("reports-row")).toHaveCount(1, { timeout: 10_000 });

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-subject-type")).toHaveText("ADB 用例");
  await expect(page.getByTestId("report-overview-status")).toContainText("通过");
  // R102 形状：case 汇总 + 3 条命令行
  await expect(page.getByTestId("report-step-row")).toHaveCount(4);
  await expect(page.locator("[data-testid='report-step-row'][data-key='case']"))
    .toHaveAttribute("data-status", "pass");
  // 命令行自己的截图按步骤 id（a3）归位：真解码（naturalWidth>0），不是碎图标装绿
  await page.locator("[data-testid='report-step-row'][data-key='a3']").click();
  const shot = page.getByTestId("report-step-detail").getByTestId("report-artifact-img").first();
  await expect(shot).toBeVisible({ timeout: 20_000 });
  expect(await shot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  // 断言行（a2 的 assert_text）也在树里可选、右栏出判定表
  await page.locator("[data-testid='report-step-row'][data-key='a2']").click();
  await expect(page.getByTestId("report-assert-row").first()).toContainText("登录");

  // 调试面板（trigger=debug，UI 通路）：dump 降级徽标 + 设备名 + 同案截图内联
  await page.goto(APP + "/#/adb/cases/" + caseId);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();
  await page.getByTestId("adb-case-debug").click();
  const dbg = page.getByTestId("adb-debug-panel");
  await expect(dbg).toBeVisible();
  await expect(page.getByTestId("adb-debug-badge")).toHaveAttribute("data-status", "passed",
    { timeout: 60_000 });
  // mode 徽标必须当场说话（T6 交接：降级不可见=纪律 1 违例）；CI 假 adb 无 atx ⇒ dump
  await expect(page.getByTestId("adb-debug-mode")).toHaveText(/dump 轮询|控件树会话/);
  await expect(page.getByTestId("adb-debug-device")).toContainText(serial);
  // a3 的截图是**两张**（不是重复写盘）：a3 自己那条 screenshot 命令 + 执行核给整案
  // 末尾补的「整案终态截图」（adb_core.py:679，绿红都留一张现场）——两者都落在末步 id 上。
  // 所以这里精确钉 2 张 + 两个理由都在，而不是 .first() 摸过去：将来谁把终态图改了
  // step_id 或悄悄去重，这条会红。
  const dshots = page.getByTestId("adb-debug-shot-a3");
  await expect(dshots).toHaveCount(2, { timeout: 20_000 });
  for (const el of await dshots.all()) {
    expect(await el.evaluate((n) => n.naturalWidth)).toBeGreaterThan(0);
  }
  const dbgPanelText = await page.getByTestId("adb-debug-panel").innerText();
  expect(dbgPanelText).toContain("screenshot 命令");
  expect(dbgPanelText).toContain("整案终态截图");
  // D17：全程无「预计」类估算字样
  await expect(page.locator("body")).not.toContainText("预计");
});

