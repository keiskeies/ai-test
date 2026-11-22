// 1E T9：导入向导（§11.4.6，前端 commit 5032cc1 / 后端 import_services.py）的 e2e。
// 钉计划 T9 的三条：三步走真样本 × 三格式、冲突逐条跳过后行数不变、回滚整批后行数不变；
// 外加蓝图 §1.5 判据第 1 条的两半边：「导入腿→场景→执行→报告」链条（用例 ⑥，计划
// 2026-11-16 §T9 补记）与「导入 20 接口」的量级（用例 ⑦，vendor 真样本 Google Books v1）。
//
// 判据诚实口径（计划原文：「不许默默当作已完成」）：
// 用例 ⑥ 是蓝图 :50 判据第 1 条（新人 30 分钟走通：建项目 → 导入 20 接口 → 建混合场景 →
// 执行 → 看报告）之**导入腿＋场景执行链前段的代理证据，不等于业主手测 30 分钟走通**——
// 「30 分钟走通」本质是人工验收口径，任何自动化都只能证明「链条每一步都真能走、每步有门禁」，
// 体感耗时与卡点在哪仍需业主按演示手册手动走一遍对照。本文件不据此宣称判据第 1 条已完成。
// 判据的「混合场景（API+等待+判断+ADB）」半边由 mixedScene.spec.mjs 专钉，⑥ 不重复造轮子，
// 只补两者中间断掉的那截：**场景引用的接口必须是从导入向导真进来的资产**。
//
// 如实口径：
// ① 样本一律逐字读 backend/tests/fixtures/import/ 的三个真夹具（与后端 test_api_import.py
//    同一份文件），不在 spec 里现编 JSON。用例 ①–⑤ 写成夹具**原始字节逐字 fill 进 iw-text**
//    （当时向导无文件入口，spec commit c7c4ff9 早于 picker）；cc758ae 补上真 [选择文件] 入口
//    （FileTextPicker / iw-file-input）后，用例 ⑥ 改用 setInputFiles 喂**真夹具文件**——
//    两条都是真样本，⑥ 额外吃到真实选文件通路。
// ② 「整批回滚」在 UI 上**没有按钮入口**（计划 T4 原文：回滚的实现就是 commit 不 commit）。
//    唯一能被用户走到的回滚路径 = 批次里有一条失败 → 回执如实「整批已回滚」。本文件第 5 条
//    就走这条真路径：库里预置一个「同接口名、不同 method+path 键」的接口（走 API 造数据，
//    helpers 的既有约定），导入真 petstore 时「列出宠物」键是新增但名字被占 → 整批失败 →
//    回执如实报失败、列表一行未动。文档本身仍是逐字的真夹具，改动只发生在库侧。
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

const FIX = path.resolve(import.meta.dirname, "..", "..", "backend", "tests", "fixtures", "import");
const PETSTORE = readFileSync(path.join(FIX, "petstore_openapi3.json"), "utf8");
const SWAGGER2 = readFileSync(path.join(FIX, "order_swagger2.json"), "utf8");
const POSTMAN = readFileSync(path.join(FIX, "echo_postman_v2.json"), "utf8");
const POSTMAN_FILE = path.join(FIX, "echo_postman_v2.json");
// ⑥ 的「导入腿」账本：三份真夹具可解析条目 5+3+4=12 条，其中 Postman 的「创建订单-JSON」
// 「查询订单」与 Swagger2 行撞同一 method+归一路径键（/order、/order/{id}）→ 冲突条目，
// 一个勾跳过、一个默认覆盖 → 同项目真落库 10 行。名单逐字对账，名单变了先红。
const CHAIN_DEFS = [
  "列出宠物", "创建宠物", "查询宠物", "删除宠物", "上传宠物照片（体引用外部文档）",
  "查询订单", "创建订单", "表单改单", "健康检查", "表单提交",
];
// ⑦ 的逐名对账名单：本地对 vendor 真样本跑 importers.parse_openapi3 逐字抄回（51 个
// operationId 原名，零重名）。名单变了先红——和 CHAIN_DEFS 同一纪律。
const BOOKS_DEFS = [
  "books.bookshelves.get", "books.bookshelves.list", "books.bookshelves.volumes.list",
  "books.cloudloading.addBook", "books.cloudloading.deleteBook", "books.cloudloading.updateBook",
  "books.dictionary.listOfflineMetadata", "books.familysharing.getFamilyInfo",
  "books.familysharing.share", "books.familysharing.unshare", "books.layers.annotationData.get",
  "books.layers.annotationData.list", "books.layers.get", "books.layers.list",
  "books.layers.volumeAnnotations.get", "books.layers.volumeAnnotations.list",
  "books.myconfig.getUserSettings", "books.myconfig.releaseDownloadAccess",
  "books.myconfig.requestAccess", "books.myconfig.syncVolumeLicenses",
  "books.myconfig.updateUserSettings", "books.mylibrary.annotations.delete",
  "books.mylibrary.annotations.insert", "books.mylibrary.annotations.list",
  "books.mylibrary.annotations.summary", "books.mylibrary.annotations.update",
  "books.mylibrary.bookshelves.addVolume", "books.mylibrary.bookshelves.clearVolumes",
  "books.mylibrary.bookshelves.get", "books.mylibrary.bookshelves.list",
  "books.mylibrary.bookshelves.moveVolume", "books.mylibrary.bookshelves.removeVolume",
  "books.mylibrary.bookshelves.volumes.list", "books.mylibrary.readingpositions.get",
  "books.mylibrary.readingpositions.setPosition", "books.notification.get",
  "books.onboarding.listCategories", "books.onboarding.listCategoryVolumes",
  "books.personalizedstream.get", "books.promooffer.accept", "books.promooffer.dismiss",
  "books.promooffer.get", "books.series.get", "books.series.membership.get",
  "books.volumes.associated.list", "books.volumes.get", "books.volumes.list",
  "books.volumes.mybooks.list", "books.volumes.recommended.list", "books.volumes.recommended.rate",
  "books.volumes.useruploaded.list",
];

/** 打开接口页 → 点「导入」进向导第①步。 */
async function openWizard(page) {
  await page.goto("/#/api");
  await expect(page.getByTestId("page-api")).toBeVisible();
  await page.getByTestId("api-import").click();
  // Modal 的 data-testid 落在 ant-modal-root（零尺寸包裹层，Playwright 判 hidden）——
  // 断第①步的活控件 iw-parse 可见才算向导真开
  await expect(page.getByTestId("iw-parse")).toBeVisible();
}

/** 第①步：选来源（默认 openapi3）→ 贴真样本 → 解析 → 到第②步。 */
async function parseFixture(page, source, text) {
  if (source !== "openapi3") {
    await page.getByTestId("iw-source").getByText({ swagger2: "Swagger2", postman: "Postman" }[source]).click();
  }
  await page.getByTestId("iw-text").fill(text);
  await page.getByTestId("iw-parse").click();
  await expect(page.getByTestId("iw-counts")).toBeVisible();
}

async function commit(page) {
  await page.getByTestId("iw-commit").click();
  await expect(page.getByTestId("iw-receipt")).toBeVisible();
}

test("三步走·OpenAPI3 真样本（petstore）：解析告警人话 + 新增5 + 回执对账 + 列表与库一致", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "1e导入openapi3");
  await openWizard(page);
  await parseFixture(page, "openapi3", PETSTORE);
  // 计数：5 条真条目全新增（外链 $ref 的字段被忽略，但条目本身仍解析成功）
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 5 · 覆盖 0 · 跳过 0");
  // 解析告警不静默吞：1 条「外部引用」人话明细（对齐 petstore 夹具里 evil.example.com 的设计）
  await expect(page.getByTestId("iw-errors")).toContainText("解析告警 1 条");
  await expect(page.getByTestId("iw-errors")).toContainText("不支持的外部引用");
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 5 · 失败 0");
  await expect(page.getByTestId("iw-receipt")).toContainText("新增 5");
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(5);
  // 库侧事实：名字逐个对上夹具解析结果（UI 绿了不算，库里得真有条目）
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items.map((d) => d.name).sort())
    .toEqual(["上传宠物照片（体引用外部文档）", "删除宠物", "列出宠物", "创建宠物", "查询宠物"].sort());
});

test("三步走·Swagger2 真样本（order）：host/basePath 拼进 url + 新增3 + 二次导入走覆盖且行数不变", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "1e导入swagger2");
  await openWizard(page);
  await parseFixture(page, "swagger2", SWAGGER2);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 3 · 覆盖 0 · 跳过 0");
  await expect(page.getByTestId("iw-errors")).toHaveCount(0); // 这份夹具零告警：告警框不许虚胖
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 3 · 失败 0");
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(3);

  // 同文件再导一次、一条不勾（默认=覆盖）：冲突表出现、回执走 updated、行数仍 3
  await openWizard(page);
  await parseFixture(page, "swagger2", SWAGGER2);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 0 · 覆盖 3 · 跳过 0");
  await expect(page.getByTestId("iw-skip-0")).toBeVisible(); // 冲突条目给逐条勾选
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("覆盖 3");
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(3);
  // 覆盖的账落在 version 上（update +1），不是行数
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items.every((d) => d.version === 2)).toBeTruthy();
});

test("三步走·Postman 真样本（echo）：嵌套 folder 展平 + 坏条目告警 + 新增4", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "1e导入postman");
  await openWizard(page);
  await parseFixture(page, "postman", POSTMAN);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 4 · 覆盖 0 · 跳过 0");
  // 「坏条目没有请求」被解析器如实归进 errors（条目 4 条，不是 5 条）
  await expect(page.getByTestId("iw-errors")).toContainText("没有 request 字段");
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 4 · 失败 0");
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(4);
  // 三层 folder 里的「创建订单-JSON」确实展平进了库
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items.map((d) => d.name).sort())
    .toEqual(["健康检查", "创建订单-JSON", "查询订单", "表单提交"].sort());
});

test("冲突逐条跳过：同文件二次导入 → 逐条勾「跳过」→ 列表行数与 version 都不动", async ({ page }) => {
  test.setTimeout(150_000);
  const { token, projectId } = await seedProject(page, "1e导入跳冲突");
  // 第一遍：正常导入 5 条
  await openWizard(page);
  await parseFixture(page, "openapi3", PETSTORE);
  await commit(page);
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(5);

  // 第二遍：同一份文件 → 冲突表整屏（新增 0 · 覆盖 5）
  await openWizard(page);
  await parseFixture(page, "openapi3", PETSTORE);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 0 · 覆盖 5 · 跳过 0");

  // 逐条（不是点「全跳过」按钮）勾掉 5 条冲突：每勾一条计数当场 ±1（D26 的活账）
  for (let i = 0; i < 5; i += 1) {
    await page.getByTestId("iw-skip-" + i).click();
    await expect(page.getByTestId("iw-counts"))
      .toHaveText(`新增 0 · 覆盖 ${4 - i} · 跳过 ${i + 1}`);
  }
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 0 · 失败 0");
  await expect(page.getByTestId("iw-receipt")).toContainText("跳过 5");
  await page.getByTestId("iw-close").click();
  await expect(page.getByTestId("api-row")).toHaveCount(5);
  // 库里逐条对账：勾了跳过 = 一行没写。version 全 1 是最硬的事实（覆盖会让 version+1）
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items).toHaveLength(5);
  expect(defs.body.items.every((d) => d.version === 1)).toBeTruthy();
});

test("整批回滚后列表行数不变：批次含重名失败 → 回执如实「整批已回滚」→ 现有接口一行未动", async ({ page }) => {
  test.setTimeout(150_000);
  const { token, projectId } = await seedProject(page, "1e导入回滚");
  // 造失败条件（库侧，不动样本）：名字「列出宠物」被占，但 method+path 键 (/custom/dup)
  // 与 petstore 的 GET /pets 不同 → 该条目在预览里是「新增」，commit 时才撞名失败。
  const dup = await asUser(token, "post", "api-definitions", {
    data: {
      project_id: projectId, name: "列出宠物", method: "GET", path: "/custom/dup",
      request: { method: "GET", url: "http://127.0.0.1:9999/healthz" },
    },
  });
  expect(dup.ok, JSON.stringify(dup.body)).toBeTruthy();

  await openWizard(page);
  await parseFixture(page, "openapi3", PETSTORE);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 5 · 覆盖 0 · 跳过 0");
  await commit(page);
  // 回执如实：失败 → 「整批已回滚，现有接口一行未动」，不演成功
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 0 · 失败 1——整批已回滚");
  await expect(page.getByTestId("iw-report")).toContainText("列出宠物：接口名已存在");
  await page.getByTestId("iw-close").click();
  // 列表口径与回执当面对得上：仍然只有那 1 条预置接口，另外 4 条「本来能成」的也没落库
  await expect(page.getByTestId("api-row")).toHaveCount(1);
  await expect(page.getByTestId("api-row")).toHaveText("列出宠物");
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items).toHaveLength(1);
  expect(defs.body.items[0].path).toBe("/custom/dup");
});

// ══════ ⑥ 蓝图 §1.5 判据第 1 条的「导入腿→场景→执行→报告」链（计划 T9 补记）══════
// 串法：真点向导三步 × 三份真夹具（第三份走 cc758ae 的 [选择文件] 真通路，含冲突逐条勾选）
// → 用**导入进来的接口**建用例（api-cases 挂 definition_id）→ 建混合场景（api_case+sleep+if）
// → API 执行 → 报告中心出现该 run、详情页 api_case 步真绿。
// 「导入 20 接口」如实口径：三份官方夹具的可解析条目只有 12 条（5+3+4，条数由 ①②③ 各自
// 钉死），其中 2 条跨格式撞键（Postman 的 POST /order、GET /order/{id} 与 Swagger2 行同键）
// → 真落库 10 行。**没有 20 条真样本就不演 20 条**（纪律 1）：按实际条数逐名对账，
// 凑数的手编假 JSON 反而会让「导入腿」测的是假资产。此前的口径是「判据的『20 接口』量级
// 仍需业主/后端补一份 ≥20 条的真样本后加强用例」——该缺口现由 ⑦ 用 vendor 真样本
// （google_books_openapi3.json，51 操作）钉死；⑥ 保持 10 行账不动，量级判据看 ⑦。
test("⑥ 判据第 1 条链条：三夹具全导入(12 条/10 行, 真点选文件+冲突跳过) → 导入的接口建场景 → 执行 → 报告中心见 run", async ({ page }) => {
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const { token, projectId } = await seedProject(page, "1e判据链条");

  // —— 导入腿 1/2：petstore + swagger2 走粘贴框（①②已各自单测过计数，这里只串链） ——
  await openWizard(page);
  await parseFixture(page, "openapi3", PETSTORE);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 5 · 覆盖 0 · 跳过 0");
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 5 · 失败 0");
  await page.getByTestId("iw-close").click();

  await openWizard(page);
  await parseFixture(page, "swagger2", SWAGGER2);
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 3 · 覆盖 0 · 跳过 0");
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 3 · 失败 0");
  await page.getByTestId("iw-close").click();

  // —— 导入腿 3：Postman 走 [选择文件] 真通路（cc758ae FileTextPicker，喂真夹具文件字节）——
  await openWizard(page);
  await page.getByTestId("iw-source").getByText("Postman").click();
  await page.getByTestId("iw-file-input").setInputFiles(POSTMAN_FILE);
  await expect(page.getByTestId("iw-text")).toHaveValue(/Echo Collection/); // 真读进了文件
  await page.getByTestId("iw-parse").click();
  await expect(page.getByTestId("iw-counts")).toBeVisible();
  // 2 新增 + 2 与 Swagger2 撞 method+归一路径键（POST /order、GET /order/{id}）
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 2 · 覆盖 2 · 跳过 0");
  // 冲突逐条（③的条目序：0 健康检查 / 1 创建订单-JSON / 2 查询订单 / 3 表单提交）
  await expect(page.getByTestId("iw-skip-1")).toBeVisible();
  await expect(page.getByTestId("iw-skip-2")).toBeVisible();
  await page.getByTestId("iw-skip-1").click(); // 勾掉「创建订单-JSON」：覆盖让位给跳过
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 2 · 覆盖 1 · 跳过 1");
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 3 · 失败 0");
  await expect(page.getByTestId("iw-receipt")).toContainText("新增 2 · 覆盖 1 · 跳过 1");
  await page.getByTestId("iw-close").click();

  // 列表与库逐名对账：12 条可解析条目 - 1 条勾跳 = 真落库 10 行，名单一个不多一个不少
  await expect(page.getByTestId("api-row")).toHaveCount(10);
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.body.items.map((d) => d.name).sort()).toEqual([...CHAIN_DEFS].sort());

  // —— 用导入进来的接口建用例：definition 必须是向导落的那行（按名字取，来源唯一）——
  const listPets = defs.body.items.find((d) => d.name === "列出宠物");
  expect(listPets, "向导导入的「列出宠物」不在库里").toBeTruthy();
  const created = await asUser(token, "get", "api-definitions/" + listPets.id, { params: { project_id: projectId } });
  expect(created.ok, JSON.stringify(created.body)).toBeTruthy();
  // 夹具的 url 指向 example.com（真样本原值）：执行必须覆盖到本地靶场才可能绿
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: listPets.id, name: "判据链用例-" + tag, priority: "P1",
    request: { url: "http://127.0.0.1:9999/healthz" },
    assertions: [{ type: "status_code", expected: 200 }],
  } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  expect(c.body.definition_id).toBe(listPets.id); // 用例真挂在导入的接口下
  const caseId = c.body.id;

  // —— 混合场景（API+等待+判断的三主体形状；ADB 半边由 mixedScene.spec 专钉）——
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "判据链场景-" + tag, priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "api", kind: "api_case", name: "导入的接口：列出宠物", ref: caseId, config: {} },
      { key: "nap", kind: "sleep", name: "等待步", config: { ms: 100 } },
      { key: "gate", kind: "if", name: "判断步", config: { branches: [
        { cond: "ctx.vars['never_set'] == '1'", children: [
          { key: "gate.dead", kind: "sleep", name: "不该走到的分支", config: { ms: 10 } }] },
        { cond: "else", children: [
          { key: "gate.live", kind: "sleep", name: "兜底分支", config: { ms: 10 } }] } ] } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status, JSON.stringify(sc.body)).toBe(201);
  const scenarioId = sc.body.id;

  // —— 执行 + 报告：run 终态 passed，报告中心与详情页都见得到 ——
  const run = await asUser(token, "post", "scenarios/" + scenarioId + "/run", { data: { project_id: projectId } });
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 120_000, intervals: [1000] }).toMatch(/passed|failed|error|cancelled/);
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.body.status, JSON.stringify(rep.body)).toBe("passed");
  expect(rep.body.subject_type).toBe("scenario");
  expect(rep.body.stats).toMatchObject({ total: 3, pass: 3, fail: 0, error: 0 });

  // UI：报告中心（默认近 7 天视图）筛「场景」后能看见这条 run——判据的「看报告」落点
  await page.goto("/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await page.getByTestId("reports-filter-subject-type").click();
  await pickOption(page, "场景");
  const row = page.getByTestId("reports-row").filter({ hasText: "判据链场景-" + tag });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId("report-status")).toHaveText("通过");

  // 详情页：api_case 步（跑的就是导入接口的用例）真绿，断言表有那条 status_code
  await page.goto("/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-subject-type")).toHaveText("场景");
  await expect(page.locator("[data-testid='report-step-row'][data-key='api']"))
    .toHaveAttribute("data-status", "pass");
  await expect(page.locator("[data-testid='report-step-row'][data-key='gate.live']")).toBeVisible();
  await expect(page.locator("[data-testid='report-step-row'][data-key='gate.dead']")).toHaveCount(0);
  await page.locator("[data-testid='report-step-row'][data-key='api']").click();
  const panel = page.getByTestId("report-step-detail");
  await expect(panel.getByTestId("report-assert-row").first()).toContainText("status_code");
});

// ══════ ⑦ 蓝图 §1.5 判据第 1 条的「导入 20 接口」量级半边（⑥ 账本里挂的账，这里还）══════
// 此前的口径（见 ⑥ 头注）：三份小夹具只有 12 条，判据的「20 接口」量级缺一份 ≥20 条的
// 真样本。现在样本有了：google_books_openapi3.json 是 Google Books API v1 官方发布的
// OpenAPI 3.0 文档**逐字**入库（237,147 字节 / 49 paths / 51 操作），不裁剪不手编。
// 本用例只证「51 条真接口一次导入真落库」这一段量级；「30 分钟体感」仍是业主手测口径
// （文件头注的诚实声明对 ⑦ 同样成立）。计数与名单为本地对 parse_openapi3 的实测值：
// 51 条全新增、0 冲突（51 个 operationId 零重名、method+path 零撞键）、16 条字段级
// 「本地引用嵌套超过一层」截断告警（告警只削字段，条目一条不丢）。
test("⑦ 判据第 1 条量级：vendor 真样本 Google Books（51 操作）一次导入 → 预览/回执/列表三方 51 行逐名对账（≥20 接口）", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "1e判据量级51");

  // —— 第①步走 [选择文件] 真通路（与 ⑥ 的 Postman 腿同路；237KB 真文件，不粘贴）——
  await openWizard(page);
  await page.getByTestId("iw-file-input").setInputFiles(path.join(FIX, "google_books_openapi3.json"));
  await expect(page.getByTestId("iw-text")).toHaveValue(/Google Books API/); // 真读进了文件
  await page.getByTestId("iw-parse").click();
  await expect(page.getByTestId("iw-counts")).toBeVisible();

  // —— 第②步计数：新项目的空库里 51 条全新增，无一条冲突 ——
  await expect(page.getByTestId("iw-counts")).toHaveText("新增 51 · 覆盖 0 · 跳过 0");
  // 告警不静默吞也不虚胖：16 条 $ref 嵌套截断（对齐 parse_openapi3 对这份文档的实测）
  await expect(page.getByTestId("iw-errors")).toContainText("解析告警 16 条");
  await expect(page.getByTestId("iw-errors")).toContainText("本地引用嵌套超过一层");

  // —— 第③步回执：51 条整批一次事务落库成功 ——
  await commit(page);
  await expect(page.getByTestId("iw-receipt")).toContainText("成功 51 · 失败 0");
  await expect(page.getByTestId("iw-receipt")).toContainText("新增 51 · 覆盖 0 · 跳过 0");
  await page.getByTestId("iw-close").click();

  // —— 列表侧事实：判据的「≥20 接口」是硬门槛，精确账是 51 行逐名对账 ——
  // 列表端点是键集分页（{items,next_cursor}，无 total；size 上限 200）：51<200 一页取满，
  // next_cursor 必须为 null，否则「51 行」的账只数了第一页。
  await expect(page.getByText(/共 51 条/)).toBeVisible();
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 200 } });
  expect(defs.ok, JSON.stringify(defs.body)).toBeTruthy();
  expect(defs.body.items.length).toBeGreaterThanOrEqual(20); // 判据第 1 条的「20 接口」量级
  expect(defs.body.next_cursor, "51 行不该翻页：next_cursor 应为 null").toBeNull();
  expect(defs.body.items.map((d) => d.name).sort()).toEqual([...BOOKS_DEFS].sort());
});
