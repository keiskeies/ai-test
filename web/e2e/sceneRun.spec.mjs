// SSE 实时进度（T21，§12.2 run 通道）：执行含 /slow 的场景 → 画布节点呼吸（running 态可观察）
// → 终态着色与 run_end.stats 一致；断线重连不重不漏（Review Focus 3 前端半边）；
// 取消 → 终态 cancelled。断线用 fetch 包装 abort 真断当前流（openStream 自动带
// Last-Event-ID 重连），事件行的 data-seq 让「重复/缺口」变成可数的 DOM 事实。
import { expect, test } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";

const TARGET = "http://127.0.0.1:9999";

async function seedScenario(token, projectId, name, nodes, extra = {}) {
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name, priority: "P2",
    step_graph: { version: 1, nodes: JSON.parse(JSON.stringify(nodes)) },
    variables: {}, fail_fast: true, project_public: true, ...extra,
  } });
  expect(sc.status).toBe(201);
  return sc.body.id;
}

/** 事件行去重/连续性检查：data-seq 必须恰好 1..N（重连重放不重复、不断档）。 */
async function eventSeqs(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-testid='debug-event-line']")]
    .map((el) => Number(el.getAttribute("data-seq"))));
}

test("执行实时进度：running 呼吸可观察 → 终态着色与 run_end.stats 一致（pass/fail/skip 三色齐）", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t21live");
  const key = "t21-" + Date.now().toString(36); // flaky 按 key 计数：每次跑用唯一 key
  const scenarioId = await seedScenario(token, projectId, "呼吸高亮", [
    { key: "s1", kind: "http_direct", name: "慢步骤",
      config: { method: "GET", url: TARGET + "/slow?ms=3000" } },
    { key: "s2", kind: "http_direct", name: "必败步骤",
      config: { method: "GET", url: TARGET + "/flaky?key=" + key + "&fail_first=1",
        assertions: [{ type: "status_code", expected: 200 }] } },
    { key: "s3", kind: "sleep", name: "不会被跑到", config: { ms: 200 } },
  ]);

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  // 执行按钮已解禁（T21）：跑库里已保存的场景，trigger=manual
  await expect(page.getByTestId("scene-run")).toBeEnabled();
  await page.getByTestId("scene-run").click();
  await expect(page.getByTestId("debug-drawer")).toBeVisible();

  // 至少观察到 1 个 running 节点（/slow 的 3 秒窗口；画布节点带 data-run-status）
  await expect(page.locator("[data-testid='scene-node-s1'][data-run-status='running']"))
    .toBeVisible({ timeout: 10_000 });

  // 终态徽标 + stats（总3/过1/败1/跳1，fail_fast 后 s3 skip）
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "failed",
    { timeout: 30_000 });
  const stats = await page.getByTestId("debug-stats").getAttribute("data-stats");
  expect(JSON.parse(stats)).toMatchObject({ total: 3, pass: 1, fail: 1, skip: 1 });

  // 画布终态着色与 stats 一致：DOM 里 1 绿 1 红 1 灰
  const colored = await page.evaluate(() => {
    const c = {};
    for (const el of document.querySelectorAll("[data-testid^='scene-node-']")) {
      const s = el.getAttribute("data-run-status") || "none";
      c[s] = (c[s] || 0) + 1;
    }
    return c;
  });
  expect(colored).toMatchObject({ pass: 1, fail: 1, skip: 1 });

  // 「查看报告」入口带 run_id（报告详情页 T22 落地；数据此刻已在 /reports 里）
  const href = await page.getByTestId("debug-report-link").getAttribute("href");
  expect(href).toMatch(/^#\/reports\/[0-9a-f-]{36}$/);

  // 终态后流已停：抽屉徽标不再变化（run_end 停流）
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "failed");
});

test("断线重连：跑中 abort 当前 SSE → Last-Event-ID 续传 → 事件行不重不漏且终态完整", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t21resume");
  const scenarioId = await seedScenario(token, projectId, "断线续传", [
    { key: "slow", kind: "http_direct", name: "六秒慢步",
      config: { method: "GET", url: TARGET + "/slow?ms=6000" } },
    { key: "tail", kind: "http_direct", name: "收尾",
      config: { method: "GET", url: TARGET + "/healthz" } },
  ]);

  // fetch 包装：run SSE 请求走可被测试 abort 的 controller（真断流，不是模拟状态位）
  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.__tpSseCtl = null;
    window.__dropSse = () => window.__tpSseCtl && window.__tpSseCtl.abort && window.__tpSseCtl.abort();
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/events/run/")) {
        const ctrl = new AbortController();
        window.__tpSseCtl = ctrl;
        return orig(input, { ...(init || {}), signal: ctrl.signal });
      }
      return orig(input, init);
    };
  });

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await page.getByTestId("scene-run").click();
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "running",
    { timeout: 15_000 });

  // 慢步 running 时把流掐掉；openStream 1.5s 后带 Last-Event-ID 重连
  await expect(page.locator("[data-testid='scene-node-slow'][data-run-status='running']"))
    .toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => window.__dropSse());

  // 重连后照常走到终态：6 秒慢步 + 收尾 → passed
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "passed",
    { timeout: 40_000 });

  // 事件行恰好 1..N：断线不重放旧事件（重放差集 + seq 去重），也不吞中间步
  const seqs = await eventSeqs(page);
  expect(seqs.length).toBeGreaterThanOrEqual(5); // running×2 + pass×2 + run_end（+ 可能直播重叠帧被去重）
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  // 终态树完整：两个步骤行都在
  await expect(page.getByTestId("debug-step-row")).toHaveCount(2);
});

test("取消执行：running 中的 sleep 30s 在 500ms 切片边界被取消 → 终态 cancelled", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t21cancel");
  const scenarioId = await seedScenario(token, projectId, "取消长等待", [
    { key: "nap", kind: "sleep", name: "长睡", config: { ms: 30000 } },
  ]);

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await page.getByTestId("scene-run").click();
  await expect(page.locator("[data-testid='scene-node-nap'][data-run-status='running']"))
    .toBeVisible({ timeout: 15_000 });

  await page.getByTestId("scene-cancel-run").click();
  // 按钮进入「取消中…」态（旗已置、等步骤边界生效），随后终态 cancelled
  await expect(page.getByTestId("scene-cancel-run")).toContainText("取消中");
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "cancelled",
    { timeout: 15_000 });
  // 取消的 run 不再是「永远呼吸」的死节点：nap 行转 cancelled
  await expect(page.locator("[data-testid='scene-node-nap'][data-run-status='cancelled']"))
    .toBeVisible({ timeout: 10_000 });

  // 已终态再取消 → 后端 409 already_finished（诚实报错，不当成功 no-op）
  const runId = (await page.getByTestId("debug-report-link").getAttribute("href"))
    .split("/").pop();
  const again = await asUser(token, "post", "runs/" + runId + "/cancel",
    { data: { project_id: projectId } });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("already_finished");
});
