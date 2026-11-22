// Ctrl+K 全局快捷查找（T22，§11.4.19/R51；1C T12/R109 扩五组）：居中浮层三路 → 五路
// （定义/用例/场景 + 元素/UI 用例），↑↓ 选择、Enter 直达（hash 路由断言）、Esc 关闭；
// 后端 search_assets 是数据源，前端不装假结果——没搜到就分节说「无匹配」。
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { asUser, seedProject } from "./helpers.mjs";
import { E2E_DB_URL } from "./dbEnv.mjs";

// UI 行的种子：ui_element/ui_case 的 CRUD API 到 T5/T6 才落，1C T12 时点唯一的真相源
// 是表本身（migration 0018）。直插 e2e 库（playwright webServer 连的同一个库），
// 与后端搜索读的是同一张表——这就是「真后端」，不是前端造数。
const PY = process.env.TP_PYTHON
  ?? path.resolve(import.meta.dirname, "..", "..", "backend", ".venv", "Scripts", "python.exe");
const E2E_DB = E2E_DB_URL;

function seedUiRows(projectId, ids) {
  const sql = E2E_DB.replace("+asyncmy", "+pymysql");
  execFileSync(PY, ["-I", "-c", `
import pymysql, uuid
from datetime import datetime, UTC
u = """${sql}""".split("?", 1)[0]
# mysql+asyncmy://user:pw@host:port/db → pymysql 直连
rest = u.split("://", 1)[1]; cred, hostpart = rest.split("@", 1)
host, db = hostpart.split("/", 1)
host, port = (host.split(":", 1) + ["3306"])[:2]
user, pw = cred.split(":", 1)
now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
conn = pymysql.connect(host=host, port=int(port), user=user, password=pw, database=db, autocommit=True)
with conn.cursor() as c:
    c.execute("INSERT INTO ui_element (id,project_id,module_id,name,locator_type,locator,comment,owner_id,project_public,status,updated_by,created_at,updated_at) "
              "VALUES (%s,%s,NULL,%s,'css','button.submit',NULL,NULL,1,'normal',NULL,%s,%s)",
              (${JSON.stringify(ids.elementId)}, ${JSON.stringify(projectId)}, "登录页提交按钮", now, now))
    c.execute("INSERT INTO ui_case (id,project_id,module_id,name,priority,enabled,steps,env_id,owner_id,project_public,status,step_count,last_run_at,last_run_status,updated_by,created_at,updated_at) "
              "VALUES (%s,%s,NULL,%s,'P1',1,%s,NULL,NULL,1,'normal',1,NULL,NULL,NULL,%s,%s)",
              (${JSON.stringify(ids.caseId)}, ${JSON.stringify(projectId)}, "登录页冒烟UI用例",
               '[{"id":"c1","type":"open","input":"http://127.0.0.1:9999/"}]', now, now))
conn.close()
`], { stdio: "pipe" });
}

async function seedAssets(token, projectId) {
  const defA = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单A", method: "GET", path: "/order/a",
    request: { method: "GET", url: "http://127.0.0.1:9999/order/a" },
  } });
  expect(defA.status).toBe(201);
  const defB = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单B", method: "GET", path: "/order/b",
    request: { method: "GET", url: "http://127.0.0.1:9999/order/b" },
  } });
  expect(defB.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: defA.body.id, name: "登录冒烟用例", priority: "P1",
  } });
  expect(c.status).toBe(201);
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "下单回归场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "sleep", name: "等待", config: { ms: 10 } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  return { defA: defA.body.id, defB: defB.body.id, caseId: c.body.id, scenarioId: sc.body.id };
}

async function openPalette(page) {
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-overlay")).toBeVisible();
}

test("Ctrl+K：搜定义分组命中两条 → ↓ 移焦 → Enter 跳定义详情（hash 路由）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t22pal");
  const ids = await seedAssets(token, projectId);
  await page.goto("http://127.0.0.1:5173/#/scene");
  await expect(page.getByTestId("page-scene")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("订单");
  // 两组定义命中；用例/场景组各自说「无匹配」（空结果分节提示，不是整屏空白）
  const defItems = page.locator("[data-testid='palette-item'][data-kind='definition']");
  await expect(defItems).toHaveCount(2);
  await expect(page.locator("[data-testid='palette-group'][data-kind='case']"))
    .toContainText("无匹配");
  await expect(page.locator("[data-testid='palette-group'][data-kind='scenario']"))
    .toContainText("无匹配");
  // 默认首项即焦点（Enter 直接可走），↓ 移到第二项。
  // 不钉「第二项=查询订单B」：后端按 id（uuid）排序，创建顺序≠展示顺序——
  // 取第二项实际显示的名字去验 Enter 的落点，测的是「Enter 打开焦点项」而不是排序实现。
  await expect(defItems.first()).toHaveAttribute("data-active", "true");
  await page.getByTestId("palette-input").press("ArrowDown");
  await expect(defItems.nth(1)).toHaveAttribute("data-active", "true");
  const activeName = (await defItems.nth(1).innerText()).trim();
  expect(activeName.length).toBeGreaterThan(0);
  await page.getByTestId("palette-input").press("Enter");

  await expect(page).toHaveURL(/#\/api\?def=/);
  await expect(page.getByTestId("api-detail-drawer")).toBeVisible();
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  // 抽屉开的正是焦点那一条
  await expect(page.locator(".ant-drawer-title")).toContainText(activeName.slice(0, 5));
  void ids.defA;
});

test("Enter 用例跳所属定义详情并开用例页签；场景跳编辑器；Esc 关闭；搜索框点击同样打开", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t22pal2");
  const ids = await seedAssets(token, projectId);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  // 用例：副行要带所属定义名（同名用例分不出是谁家的）
  await openPalette(page);
  await page.getByTestId("palette-input").fill("冒烟");
  const caseItem = page.locator("[data-testid='palette-item'][data-kind='case']");
  await expect(caseItem).toHaveCount(1);
  await expect(caseItem).toContainText("登录冒烟用例");
  await expect(caseItem).toContainText("查询订单A");
  await page.getByTestId("palette-input").press("Enter");
  await expect(page).toHaveURL(new RegExp("#/api\\?def=" + ids.defA));
  await expect(page.getByTestId("api-detail-drawer")).toBeVisible();
  await expect(page.getByTestId("case-panel")).toBeVisible();
  await expect(page.getByTestId("case-row")).toContainText("登录冒烟用例");

  // 场景：Enter → 场景编辑器路由
  await openPalette(page);
  await page.getByTestId("palette-input").fill("回归");
  const scItem = page.locator("[data-testid='palette-item'][data-kind='scenario']");
  await expect(scItem).toHaveCount(1);
  await page.getByTestId("palette-input").press("Enter");
  await expect(page).toHaveURL(new RegExp("#/scene/" + ids.scenarioId));
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();

  // Esc 关闭；Esc 后页面恢复可操作
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();

  // 顶栏搜索框不再是 disabled 摆设：点击同样唤起浮层
  await page.getByTestId("shell-search").click();
  await expect(page.getByTestId("palette-overlay")).toBeVisible();
});

test("空结果：三路都无匹配说人话；搜索走真后端（关键词含 LIKE 通配符按字面）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t22pal3");
  await seedAssets(token, projectId);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("不存在的东西");
  await expect(page.getByTestId("palette-empty")).toBeVisible();
  await expect(page.getByTestId("palette-empty")).toContainText("没有匹配");

  // 通配符字面化（后端 services.py 的口径）：搜「%」不能命中任何东西
  await page.getByTestId("palette-input").fill("%");
  await expect(page.getByTestId("palette-empty")).toBeVisible();
});

test("搜索失败 ≠ 没有匹配：搜索端点断供时报「暂时搜不到」，不伪装成空结果", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t22pal4");
  await seedAssets(token, projectId);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  // 断供：库里明明有「订单」，但搜索服务没回应——旧实现把失败塞成空结果，
  // 业主会对着真实存在的资产看到「没有匹配」，这是撒谎，必须红给他看
  await page.route("**/search-assets**", (route) => route.abort());
  await openPalette(page);
  await page.getByTestId("palette-input").fill("订单");
  await expect(page.getByTestId("palette-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("palette-error")).toContainText("暂时搜不到");
  await expect(page.getByTestId("palette-empty")).toHaveCount(0); // 不许画空结果模板
  // 恢复供给：改一下关键词触发重搜，真结果回来
  await page.unroute("**/search-assets**");
  await page.getByTestId("palette-input").fill("订单 ");
  await page.getByTestId("palette-input").fill("订单");
  await expect(page.getByTestId("palette-error")).toHaveCount(0);
  await expect(page.locator("[data-testid='palette-item'][data-kind='definition']"))
    .toHaveCount(2);
});

// ---- 1C T12（R109）：五组形态 ----
// 元素库 / UI 用例页在 T13/T14/T17 才注册路由，所以「Enter 落点」的 UI 侧断言此刻只能
// 钉到 hash——但绝不是空断言：先证明路由不存在（红给他看），导航发生即证明 Enter
// 真的动了（overlay 关闭 + hash 变成落点），T13 注册路由后本用例只需追加
// 「page-ui-elements / 详情页可见」一行，落点断言零改动。
// Enter 落点映射本身的「每个 kind 都有落点、不许 null」由纯测试钉（src/ui/paletteNav.test.ts）。

test("1C：搜元素名 → 元素组命中，Enter 把 hash 打到元素库 ?q=<id> 并高亮", async ({ page }) => {
  test.setTimeout(120_000);
  const { projectId } = await seedProject(page, "t12pal5"); // 不取 token：下面 seedUiRows 直连 SQL 造数，不发带鉴权的请求
  const ids = { elementId: "t12e-" + Date.now().toString(36), caseId: "t12c-" + Date.now().toString(36) };
  seedUiRows(projectId, ids);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("提交按钮");
  const elItems = page.locator("[data-testid='palette-item'][data-kind='ui_element']");
  await expect(elItems).toHaveCount(1);
  await expect(elItems).toContainText("登录页提交按钮");
  // 组标题在（组存在本身就是「这一组无匹配 vs 没有这一组」的分界）
  await expect(page.locator("[data-testid='palette-group'][data-kind='ui_element']"))
    .toContainText("元素");

  // T13/T14 之后路由是真的：这条从「钉通配重定向」翻成「钉真落点」——
  // 计划预留的追加（「注册路由后本用例只需追加落点可见一行」）今天兑现。
  // 顺带钉一条产品规矩：上面那次 Ctrl+K 的浮层**不许**跟着活过路由——hash 直访是同文档
  // 导航、组件不重建，浮层留着就是盖在元素库上的一层幕布 + 上一次搜索的残留结果。
  await page.goto("http://127.0.0.1:5173/#/ui/elements?q=" + ids.elementId);
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  expect(page.url()).toContain("ui/elements?q=" + ids.elementId);
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  // 真高亮（R121）：这条用例的名字一直写着「并高亮」，而 T12 当时只钉到 hash——
  // 元素库根本不读 ?q=，落点等于「打开了一个页面」。现在页面认这个 id，
  // 于是这里钉两件：横幅说出定位到了哪一条、那一行真的带高亮类。
  await expect(page.getByTestId("ui-element-hit")).toContainText("登录页提交按钮");
  await expect(page.getByTestId("ui-element-row-name").filter({ hasText: "登录页提交按钮" })
    .locator("xpath=ancestor::tr[1]")).toHaveClass(/tp-row-hit/);
  // 反向钉：换一个不存在的 id 时不许硬说「定位到了」
  await page.goto("http://127.0.0.1:5173/#/ui/elements?q=nope-" + ids.elementId);
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  await expect(page.getByTestId("ui-element-hit")).toHaveCount(0);

  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await openPalette(page);
  await page.getByTestId("palette-input").fill("提交按钮");
  await expect(elItems).toHaveCount(1);
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  // 落点是真页面：Enter 后必须站在元素库且带着 ?q=<id>（回退成 #/ 首页 = 假落点，红）。
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  expect(page.url()).toContain("ui/elements?q=" + ids.elementId);
});

test("1C：搜 UI 用例名 → UI 用例组命中带优先级，Enter 把 hash 打到它自己的详情页", async ({ page }) => {
  test.setTimeout(120_000);
  const { projectId } = await seedProject(page, "t12pal6"); // 同上：这条也不用 token
  const ids = { elementId: "t12e2-" + Date.now().toString(36), caseId: "t12c2-" + Date.now().toString(36) };
  seedUiRows(projectId, ids);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("冒烟UI");
  const ucItems = page.locator("[data-testid='palette-item'][data-kind='ui_case']");
  await expect(ucItems).toHaveCount(1);
  await expect(ucItems).toContainText("登录页冒烟UI用例");
  await expect(ucItems).toContainText("P1"); // 优先级徽标（与场景同形）

  // T17 之后详情页是真的：直访落点必须站在详情页（翻掉 T13 前的「回首页」钉）。
  await page.goto("http://127.0.0.1:5173/#/ui/cases/" + ids.caseId);
  await expect(page.getByTestId("page-ui-case-detail")).toBeVisible();
  await expect(page.getByTestId("palette-overlay")).toBeHidden(); // 浮层不跟着换页（同上）

  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await openPalette(page);
  await page.getByTestId("palette-input").fill("冒烟UI");
  await expect(ucItems).toHaveCount(1);
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  // Enter 的落点是详情页本体（停在 #/reports 或弹回 #/ 都红）。
  await expect(page.getByTestId("page-ui-case-detail")).toBeVisible();
  expect(page.url()).toContain("ui/cases/" + ids.caseId);
});

test("1C：只命中新两组时，老三组各自说「无匹配」（不是整屏空白）；全空仍是一块「没有匹配」", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t12pal7");
  await seedAssets(token, projectId); // API 三组里只有「订单/登录/回归」字样
  seedUiRows(projectId, { elementId: "t12e3-" + Date.now().toString(36),
    caseId: "t12c3-" + Date.now().toString(36) });
  // 命中面隔离：「登录页」只在直插的两条 UI 行名字里（API 三组是 订单/登录冒烟/下单回归，
  // 都不含「登录页」三字连排）——老三组必须逐组说「无匹配」
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("登录页");
  for (const k of ["definition", "case", "scenario"]) {
    await expect(page.locator("[data-testid='palette-group'][data-kind='" + k + "']"))
      .toContainText("无匹配");
  }
  await expect(page.locator("[data-testid='palette-item'][data-kind='ui_element']"))
    .toHaveCount(1);
  await expect(page.locator("[data-testid='palette-item'][data-kind='ui_case']"))
    .toHaveCount(1);
  // 有命中时不许出现整屏空态
  await expect(page.getByTestId("palette-empty")).toHaveCount(0);

  // 五组全空 → 一块「没有匹配」，文案带上新两组（1B 的口径不许被扩组稀释）
  await page.getByTestId("palette-input").fill("五个字都没有");
  await expect(page.getByTestId("palette-empty")).toBeVisible();
  await expect(page.getByTestId("palette-empty")).toContainText("UI 用例");
});

// ---- 1D（R109 四处同改的 e2e 半边；T11 门禁轮实跑绿）----
// 「设备」组是本地导航项（没有可搜 kind，不编搜索结果）：搜任何词都挂一条、Enter 落卡片墙。
// ADB 用例组的命中依赖后端搜索 kind 表补 adb_case（并行批次）——这里只钉诚实降级：
// 后端没回 adb_cases 键时该组如实「无匹配」，绝不出现编造的条目。
test("1D：设备组恒在且 Enter 落卡片墙；ADB 用例组存在、空时如实「无匹配」", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9pal");
  await seedAssets(token, projectId);
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("订单");
  // ADB 组标题在场：无论后端 kind 表有没有并流，组不许消失（消失 = 组被悄悄删）
  await expect(page.locator("[data-testid='palette-group'][data-kind='adb_case']"))
    .toContainText("ADB 用例");
  // 设备组恰好一条（本地导航，不随关键词增减）
  const devItem = page.locator("[data-testid='palette-item'][data-kind='nav_device']");
  await expect(devItem).toHaveCount(1);

  // 落设备组并 Enter：站在设备卡片墙上（hash 落错 / 浮层不关都红）。
  // hover（不是 click）选行——click 当场就导航走了，Enter 那段等于没测；
  // hover 只挪高亮（onMouseEnter→setActive），焦点留在输入框，Enter 才真的走键盘通路。
  await devItem.hover();
  await expect(devItem).toHaveAttribute("data-active", "true");
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  await expect(page.getByTestId("page-adb-devices")).toBeVisible();
  expect(page.url()).toContain("/adb/devices");
});

// ---- 1E T9（R109 四处同改的 e2e 半边；未实测，领导收敛跑全量 e2e 门禁时兑现）----
// 新两组「定时任务」「通知渠道」：命中面走真后端——定时任务经 API 建（项目级，
// schedule:task:read 命中）、渠道经 API 建（平台级，notify:channel:read 命中）。
// 名字都带唯一 tag：渠道名有平台级唯一约束、e2e 库跨轮存活，固定名会在第二轮 409/
// 串扰计数——tag 是唯一可靠的命中隔离面。Enter 落点：#/schedules、#/notify/channels。
test("1E：定时任务/通知渠道两组命中，Enter 分别落定时任务页与渠道页", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9pal1e");
  const tag = "夜巡" + Date.now().toString(36);
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: tag + "定时场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "sleep", name: "等待", config: { ms: 10 } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  const task = await asUser(token, "post", "schedule-tasks", { data: {
    project_id: projectId, name: tag + "定时任务", subject_type: "scenario",
    subject_id: sc.body.id, cron: "0 2 * * *",
  } });
  expect(task.status).toBe(201);
  const chan = await asUser(token, "post", "notify-channels", { data: {
    name: tag + "渠道", type: "WEBHOOK",
    config: { url: "http://127.0.0.1:45991/hook?token=sec" + tag },
  } });
  expect(chan.status).toBe(201);

  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  // 组内顺序 = flat 拼装顺序（schedule 在 notify_channel 前），默认焦点即 schedule 项
  await openPalette(page);
  await page.getByTestId("palette-input").fill(tag);
  const taskItem = page.locator("[data-testid='palette-item'][data-kind='schedule']");
  await expect(taskItem).toHaveCount(1);
  await expect(taskItem).toContainText(tag + "定时任务");
  const chanItem = page.locator("[data-testid='palette-item'][data-kind='notify_channel']");
  await expect(chanItem).toHaveCount(1);
  await expect(chanItem).toContainText(tag + "渠道");
  // 泄密反向钉：渠道条目只有名字——URL/token 住在 config（D24），不许出现在浮层里
  await expect(chanItem).not.toContainText("45991");
  await expect(chanItem).not.toContainText("sec" + tag);
  await taskItem.first().hover();
  await expect(taskItem.first()).toHaveAttribute("data-active", "true");
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  await expect(page.getByTestId("page-schedules")).toBeVisible();
  expect(page.url()).toContain("/schedules");

  // 渠道组：Enter 落 #/notify/channels（关键词加「渠道」只命中渠道一条）
  await openPalette(page);
  await page.getByTestId("palette-input").fill(tag + "渠道");
  const chanOnly = page.locator("[data-testid='palette-item'][data-kind='notify_channel']");
  await expect(chanOnly).toHaveCount(1);
  await chanOnly.first().hover();
  await expect(chanOnly.first()).toHaveAttribute("data-active", "true");
  await page.getByTestId("palette-input").press("Enter");
  await expect(page.getByTestId("palette-overlay")).toBeHidden();
  await expect(page.getByTestId("page-notify-channels")).toBeVisible();
  expect(page.url()).toContain("/notify/channels");
});

test("1E：新两组标题恒在，无匹配时逐组说「无匹配」（不是整屏空白）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9pal1e2");
  await seedAssets(token, projectId); // 只有「订单/登录冒烟/下单回归」字样
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();

  await openPalette(page);
  await page.getByTestId("palette-input").fill("订单");
  await expect(page.locator("[data-testid='palette-group'][data-kind='schedule']"))
    .toContainText("定时任务");
  await expect(page.locator("[data-testid='palette-group'][data-kind='schedule']"))
    .toContainText("无匹配");
  await expect(page.locator("[data-testid='palette-group'][data-kind='notify_channel']"))
    .toContainText("通知渠道");
  await expect(page.locator("[data-testid='palette-group'][data-kind='notify_channel']"))
    .toContainText("无匹配");
});
