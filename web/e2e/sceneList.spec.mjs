// 场景列表模式 + 场景级面板 + 调试抽屉（T20，§11.4.10/§11.5.6/§11.7.3）。
// 列表模式与画布同一 graph 同一时刻（同一 zustand store），本文件反复两模式互切来钉这件事；
// 调试抽屉跑的是**未保存草稿**（scenario_debug），终态徽标来自轮询 run 的报告面。
// SSE 实时呼吸/取消/正式执行归 T21——本文件不依赖它们。
import { expect, test } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";

/** 三个顶层步骤（其中一个容器带 1 个子步骤）：http_direct 打靶场 healthz，调试能真跑绿。 */
const NODES3 = [
  { key: "a", kind: "http_direct", name: "健康检查",
    config: { method: "GET", url: "http://127.0.0.1:9999/healthz" } },
  { key: "g", kind: "group", name: "包装", children: [
    { key: "g.1", kind: "sleep", name: "等100", config: { ms: 100 } },
  ] },
  { key: "z", kind: "sleep", name: "等200", config: { ms: 200 } },
];

async function seedScenario(token, projectId, name) {
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name, priority: "P2",
    step_graph: { version: 1, nodes: JSON.parse(JSON.stringify(NODES3)) },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  return sc.body.id;
}

/** HTML5 拖拽（同 sceneCanvas.spec 的取证：dragTo 不带 DataTransfer，落点逻辑全靠载荷）。 */
async function html5Drag(page, source, target) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await source.dispatchEvent("dragend", { dataTransfer: dt });
}

const rowAt = (page, i) => page.getByTestId("scene-list-row").nth(i);

test("列表模式与画布同源：数量/序号/嵌套一致 → 拖拽换序 → 剪贴板 → 搜索定位 → 切回画布一致", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t20list");
  const scenarioId = await seedScenario(token, projectId, "双模式同源");
  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await expect(page.getByTestId("scene-node-a")).toBeVisible();

  // 切列表：4 行（a / g / g.1 / z），序号 1、2、2.1、3
  await page.getByTestId("scene-mode-list").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(4);
  await expect(rowAt(page, 0)).toContainText("健康检查");
  await expect(rowAt(page, 0)).toContainText("1");
  await expect(rowAt(page, 1)).toContainText("2");
  await expect(rowAt(page, 2)).toContainText("2.1");
  await expect(rowAt(page, 3)).toContainText("3");
  // 摘要：sleep 行带毫秒，容器行带子步数
  await expect(rowAt(page, 2)).toContainText("100ms");
  await expect(rowAt(page, 3)).toContainText("200ms");
  await expect(rowAt(page, 1)).toContainText("1 子步");

  // 折叠容器：只剩 3 行
  await page.getByTestId("list-collapse-g").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(3);
  await page.getByTestId("list-collapse-g").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(4);

  // 拖拽换序：把 z 拖到 a 上（非容器 = 插到其后）→ a, z, g, g.1
  await html5Drag(page, rowAt(page, 3), rowAt(page, 0));
  await expect(rowAt(page, 0)).toContainText("健康检查");
  await expect(rowAt(page, 1)).toContainText("等200");
  await expect(rowAt(page, 1)).toContainText("2");

  // 启用勾选：取消 g.1 的勾选 = disable=true（与画布右键「禁用」同一字段）
  await page.getByTestId("list-enable-g.1").uncheck();
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 剪贴板：复制「健康检查」→ 粘贴(1) → 5 行且新 key（不复用 a，dup_key 是要防的）
  await rowAt(page, 0).getByTestId("list-menu").click();
  await page.getByTestId("list-copy").click();
  await expect(page.getByTestId("list-paste")).toContainText("粘贴(1)");
  await page.getByTestId("list-paste").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(5);
  const pasted = rowAt(page, 4);
  await expect(pasted).toContainText("健康检查");
  // 再粘贴一次（剪贴板可复用）：第二份也不能撞第一份的 key——「每次粘贴都重新分配」
  // 这条 guard 只有双粘贴才观测得到（单粘贴时变异掉 guard 也照样绿，实测踩过）。
  await page.getByTestId("list-paste").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(6);
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='scene-list-row']")]
      .map((r) => r.getAttribute("data-key")));
  expect(new Set(keys).size).toBe(6); // 两份粘贴体都必须换新 key

  // 搜索定位：搜「等」→ 只剩含「等」的行（等100/等200），点结果选中该步骤（右面板跟上）
  await page.getByTestId("list-search").fill("等");
  const hits = page.getByTestId("scene-list-row");
  await expect(hits).toHaveCount(2);
  await hits.first().click();
  // 选中态落在行上（node key 在 data-key），右面板切到步骤表单（kind 徽标 = 等待）
  const selected = page.locator("[data-testid='scene-list-row'][data-selected='true']");
  await expect(selected).toHaveCount(1);
  await expect(selected).toContainText("等");
  await expect(page.getByTestId("scene-props")).toBeVisible();
  await expect(page.getByTestId("prop-kind")).toHaveText("等待");
  await page.getByTestId("list-search").fill("");

  // 切回画布：同一 graph（5 节点 + 粘贴体带 1 节点 → 顶层可见 4 个 + g.1 子节点）
  await page.getByTestId("scene-mode-canvas").click();
  await expect(page.getByTestId("scene-node-a")).toBeVisible();
  await expect(page.getByTestId("scene-node-g")).toBeVisible();
  await expect(page.getByTestId("scene-node-g.1")).toBeVisible();
  const canvasKeys = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='scene-node-']")]
      .map((r) => r.getAttribute("data-testid")));
  expect(canvasKeys.length).toBe(6);
  expect(new Set(canvasKeys).size).toBe(6);
  // 换序 & disable 已进同一 store：保存后服务端结构一致
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  const top = saved.body.step_graph.nodes.map((n) => n.key);
  expect(top[0]).toBe("a");
  expect(top[1]).toBe("z"); // 拖拽换序真的进了图
  const g = saved.body.step_graph.nodes.find((n) => n.key === "g");
  expect(g.children[0].disable).toBe(true); // 勾选框 = disable 字段
  expect(top.length).toBe(5); // a, z, g, 粘贴体 ×2
});

// D115：往下拖必须**恰好**落在目标之后。原先列表与画布两处都用「删除前」的下标 +1
// 交给先删后插的 moveNode ⇒ 被拖节点自己那一格被抽掉后目标前移，落点越过目标一格。
// 现有那条拖拽钉的是「末行拖到首行」（往上），恰好躲过这个偏一位；往上拖本来就对，
// 所以只有往下拖才测得到——fixture 因此要 4 个平铺兄弟、且目标不是最后一个
// （目标是末位时 index 会被 clamp，缺陷被遮住，实测踩过）。
test("D115 往下拖：a 落到 b 之后就是 b 紧接 a，两种模式同图同结果", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t20down");
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "向下换序", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "a", kind: "sleep", name: "一", config: { ms: 10 } },
      { key: "b", kind: "sleep", name: "二", config: { ms: 10 } },
      { key: "c", kind: "sleep", name: "三", config: { ms: 10 } },
      { key: "d", kind: "sleep", name: "四", config: { ms: 10 } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  await page.goto("http://127.0.0.1:5173/#/scene/" + sc.body.id);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();

  const topKeys = () => page.evaluate(() =>
    [...document.querySelectorAll("[data-testid='scene-list-row']")]
      .map((r) => r.getAttribute("data-key")));

  // ① 列表模式：a 拖到 b 上
  await page.getByTestId("scene-mode-list").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(4);
  await html5Drag(page, page.getByTestId("scene-list-row").filter({ hasText: "一" }).first(),
    page.getByTestId("scene-list-row").filter({ hasText: "二" }).first());
  await expect.poll(topKeys).toEqual(["b", "a", "c", "d"]);

  // ② 画布同一 store、同一条「插到其后」通路：b 拖到 c 上（b 在 c 前面 → 命中先删后插）。
  // 目标必须选**中位**不能选末尾：拖到最后一个节点时 index 会被 clamp 成末尾，
  // 把「多挪一格」掩成「追加」，这一腿就白测了——第一版拖 c→d 就是这样假绿的。
  await page.getByTestId("scene-mode-canvas").click();
  await expect(page.getByTestId("scene-node-b")).toBeVisible();
  await html5Drag(page, page.getByTestId("scene-node-b"), page.getByTestId("scene-node-c"));
  await page.getByTestId("scene-mode-list").click();
  await expect.poll(topKeys).toEqual(["a", "c", "b", "d"]);

  // ③ 落进服务端：换序不是只在内存里好看
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + sc.body.id + "?project_id=" + projectId);
  expect(saved.body.step_graph.nodes.map((n) => n.key)).toEqual(["a", "c", "b", "d"]);
});

test("场景级面板：变量 uid=1 保存重载仍在；失败策略切忽略继续 → fail_fast=false；定时绑定是真入口", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t20panel");
  const scenarioId = await seedScenario(token, projectId, "场景级面板");
  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();

  // 未选中步骤 → 右栏是场景级面板
  await expect(page.getByTestId("scene-props-scenario")).toBeVisible();
  // 定时绑定 1E 已交付（schedule 服务面 + /schedules 页）：假占位「1E 开放」翻真——
  // 先有跳转按钮（真导航），再 API 建一条真绑到本场景的定时任务，面板必须反查展示出来
  //（GET /schedule-tasks 按 subject_id 过滤，不是写死的文案）。
  await expect(page.getByTestId("cron-bind-empty")).toBeVisible();
  await expect(page.getByTestId("cron-bind-goto")).toBeEnabled();
  const cronTask = await asUser(token, "post", "schedule-tasks", { data: {
    project_id: projectId, name: "夜间回归", subject_type: "scenario",
    subject_id: scenarioId, cron: "0 2 * * *", enabled: 1, notify_channel_ids: [],
  } });
  expect(cronTask.status).toBe(201);
  await page.reload();
  await expect(page.getByTestId("scene-props-scenario")).toBeVisible();
  await expect(page.getByTestId("cron-bind-task-" + cronTask.body.id)).toContainText("夜间回归");
  await expect(page.getByTestId("cron-bind-task-" + cronTask.body.id)).toContainText("0 2 * * *");
  await expect(page.getByTestId("scene-cron-bind")).not.toContainText("1E 开放");

  // 场景变量：加 uid=1 → 保存 → 库里 variables={"uid":"1"}
  await page.getByTestId("var-add").click();
  await page.getByTestId("var-key-0").fill("uid");
  await page.getByTestId("var-val-0").fill("1");
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(saved.body.variables).toEqual({ uid: "1" });

  // 重载后变量行还在（不是只活在内存里）
  await page.reload();
  await expect(page.getByTestId("scene-props-scenario")).toBeVisible();
  await expect(page.getByTestId("var-key-0")).toHaveValue("uid");
  await expect(page.getByTestId("var-val-0")).toHaveValue("1");

  // 失败策略：忽略继续 → fail_fast=false
  await page.getByTestId("scene-fail-continue").click();
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const ff = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(ff.body.fail_fast).toBe(false);
  await page.reload();
  await expect(page.getByTestId("scene-props-scenario")).toBeVisible();
  await expect(page.getByTestId("scene-fail-continue")).toHaveAttribute("aria-checked", "true");

  // 执行超时：默认展示 30min（1800000ms）口径，改动后进库
  await expect(page.getByTestId("scene-max-runtime")).toBeVisible();
  await page.getByTestId("scene-max-runtime").fill("60000");
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const rt = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(rt.body.max_runtime_ms).toBe(60000);

  // R85 公共断言：空列表 = 没启用，面板要如实说出来（不能画假绿）
  await expect(page.getByTestId("scene-cassert-empty")).toBeVisible();
  await expect(page.getByTestId("scene-cassert-empty")).toContainText("未启用");

  // 加一条并改成 json_path_equals（把共用行编辑的 type/path/expected 三个控件都走一遍）
  await page.getByTestId("scene-cassert-add").click();
  await page.getByTestId("scene-cassert-0").locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:visible").getByText("JSON 路径相等").click();
  await page.getByTestId("scene-cassert-0").locator("input[placeholder=\"$.status\"]").fill("$.status");
  await page.getByTestId("scene-cassert-0").locator("input[placeholder=\"预期值\"]").fill("ok");
  // 改了公共断言 = 草稿有未保存内容：脏点必须亮（selectDirty 少了这条会在这里红）
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 保存 → 库里要有 common_assertions；重载 → 行还在。
  // 后端半边（迁移 0017 + schemas + run_graph，R85）没接上前这两条**就该红**——
  // 红是证据不是障碍：别为了变绿改字段名或放宽断言。
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const ca = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(ca.body.common_assertions).toEqual([
    { type: "json_path_equals", path: "$.status", expected: "ok" },
  ]);
  await page.reload();
  await expect(page.getByTestId("scene-props-scenario")).toBeVisible();
  await expect(page.getByTestId("scene-cassert-0")).toBeVisible();
  // 空态提示节点的真 id 是 prefix + "-empty" = scene-cassert-empty（PropsPanel.tsx:262 传
  // prefix="scene-cassert"，:696 拼 -empty）。这里原先写的是 scene-common-assertions-empty——
  // 那个容器 testid（:261）从来不会带 -empty 后缀，所以这条 toHaveCount(0) 在任何树上都恒绿，
  // 空态真回来了它也不红。改名之后这条才第一次有否决权。
  await expect(page.getByTestId("scene-cassert-empty")).toHaveCount(0);

  // 引用提示：列出了步骤引用的靶场健康检查（http_direct 不引用资产 → 场景变量之外零引用，
  // 面板要如实说「没有引用任何接口用例」而不是装没这块）
  await expect(page.getByTestId("scene-refs-hint")).toBeVisible();
});

test("调试抽屉：跑未保存草稿 → 步骤树 → 终态徽标 passed → 点步骤出响应日志", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t20debug");
  const scenarioId = await seedScenario(token, projectId, "草稿调试");
  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();

  // 制造「未保存草稿」：画布上加一个等待步骤（不保存）
  await page.getByTestId("logic-add-sleep").click();
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 点调试 → 抽屉出现 → 跑的是 4 步草稿（3 顶层 + 1 子步 + 新加的等待 = 5 步），
  // 而服务器上的场景还是 v1（3 步）——「跑当前未保存草稿」两半边都要钉。
  await page.getByTestId("scene-debug").click();
  await expect(page.getByTestId("debug-drawer")).toBeVisible();
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "passed",
    { timeout: 30_000 });
  await expect(page.getByTestId("debug-step-row")).toHaveCount(5);
  const sc = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(sc.body.version).toBe(1);
  expect(sc.body.step_graph.nodes.length).toBe(3);
  // debug 是过程不是结论：不回写「最近结果」（Review Focus 11）
  expect(sc.body.last_run_status).toBe(null);

  // 点健康检查那一步 → 右栏出响应日志（靶场真的被打了）
  await page.getByTestId("debug-step-row").filter({ hasText: "健康检查" }).click();
  await expect(page.getByTestId("debug-step-detail")).toContainText("ok");

  // 抽屉可关；再次打开仍可用（不是一次性组件）
  await page.getByTestId("debug-drawer-close").click();
  await expect(page.getByTestId("debug-drawer")).toBeHidden();
  await page.getByTestId("scene-debug").click();
  await expect(page.getByTestId("debug-drawer")).toBeVisible();
});
