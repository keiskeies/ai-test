// 1E T9：通知渠道页（§11.4.26，前端 commit df99402 / 后端 notify/service.py）的 e2e。
// 钉计划 T9 的三件事：渠道 CRUD 贯通、「测试发送」行内 ✓/✗ 回执、打码回显。
//
// 三条如实口径：
// ① 打码回显断言 = 「UI 显示的 = 后端 GET 回来的掩码原串」：先 asUser 拿后端 config，
//    再拿这个**后端原值**去 UI 行里断言逐字出现——前端若自己截 •••• 就对不上。
//    已知后端形状（senders.mask_config）：敏感键露前 5 位 + ••••；url 的 query 段整体
//    urlencode 成 %5B已配置%5D 家族——断言用后端返回值本身，不把这些拼法写死在 spec 里。
// ② 真发目标用 e2e 靶场 :9999（webServer 自带），三种回执形状各有真目标：
//    POST /ui/login 对任何 JSON body 都回 302 空体——状态 <400，发送器如实判 ✓，
//    raw 如实是空串（实测 content-length: 0，UI 的 raw 块就在，但里面没字，不编内容）；
//    POST /login 对错误凭据回 401 + JSON 原文——≥400 如实 ✗，且原始响应块有对端原文；
//    不可达目标（127.0.0.1:1，端口必拒）演成**如实的 ✗**：行内红标 + 弹窗 error 原话、
//    无对端 raw（网络层失败没有响应体，UI 不许编），绝不断言成功。
// ③ 渠道是平台级资源（表无 project_id，列表不带项目过滤）——行定位一律用唯一名称过滤，
//    用例结束自删自己的渠道，不给共享 e2e 库留垃圾。
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

const APP = "http://127.0.0.1:5173";
const OK_URL = "http://127.0.0.1:9999/ui/login"; // 302 < 400 → 如实 ✓
const DEAD_URL = "http://127.0.0.1:1/hook"; // 回环 1 端口必拒 → 如实 ✗

const uniq = (tag) => "1e渠道" + tag + "-" + Date.now().toString(36);

async function openPage(page) {
  await page.goto(APP + "/#/notify/channels");
  await expect(page.getByTestId("page-notify-channels")).toBeVisible();
}

/** UI 新建渠道：名称 + 类型（默认 WEBHOOK）+ 各配置键；保存后返回后端行（含 id）。 */
async function createChannel(page, token, { name, type, fields }) {
  await page.getByTestId("notify-channel-create").click();
  await page.getByTestId("notify-field-name").fill(name);
  if (type && type !== "WEBHOOK") {
    await page.getByTestId("notify-field-type").click();
    await pickOption(page, type);
  }
  for (const [key, val] of Object.entries(fields)) {
    await page.getByTestId("notify-field-" + key).fill(val);
  }
  await page.getByTestId("notify-channel-save").click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  const list = await asUser(token, "get", "notify-channels", { params: { size: 200 } });
  expect(list.ok, JSON.stringify(list.body)).toBeTruthy();
  const row = list.body.items.find((r) => r.name === name);
  expect(row, "渠道没落后端库").toBeTruthy();
  return row;
}

function channelRow(page, name) {
  return page.getByRole("row").filter({ hasText: name });
}

test("CRUD 贯通：UI 建 → 后端查 → 编辑改名（掩码原样 PATCH 不毁密钥）→ 测试发送 ✓ → UI 删 → 后端 404", async ({ page }) => {
  test.setTimeout(120_000);
  const { token } = await seedProject(page, "1e渠道crud");
  await openPage(page);
  const name = uniq("webhook");
  const created = await createChannel(page, token, { name, fields: { url: OK_URL } });

  // 新建后行形状：类型徽标 + 「从未发送」（null 绝不画成 ✓）
  const row = channelRow(page, name);
  await expect(row.getByTestId("notify-channel-type")).toContainText("通用 Webhook WEBHOOK");
  await expect(row.getByText("从未发送")).toBeVisible();

  // 编辑抽屉改名；config 未动 = 打码回显原样 PATCH（后端 merge 视为没改）
  await row.getByTestId("notify-channel-edit-" + created.id).click();
  await expect(page.getByTestId("notify-field-name")).toHaveValue(name);
  const renamed = name + "-改名";
  await page.getByTestId("notify-field-name").fill(renamed);
  await page.getByTestId("notify-channel-save").click();
  await expect(channelRow(page, renamed)).toBeVisible();
  const afterPatch = await asUser(token, "get", "notify-channels/" + created.id);
  expect(afterPatch.body.name).toBe(renamed);
  expect(afterPatch.body.config.url).toBe(created.config.url);

  // 测试发送：真打靶场 → 弹窗如实报成功 + 对端原文 → 行内 ✓ 回执落账
  await channelRow(page, renamed).getByTestId("notify-channel-test-" + created.id).click();
  await expect(page.getByTestId("notify-test-result")).toBeVisible();
  await expect(page.getByTestId("notify-test-result")).toContainText("发送成功");
  await expect(page.getByTestId("notify-test-raw")).toHaveText(""); // 靶场 302 空体：raw 如实是空串
  await page.getByTestId("notify-test-close").click();
  const okRow = channelRow(page, renamed);
  await expect(okRow.getByTestId("notify-last-send")).toContainText("✓");
  // 行内展开：last_send.raw 原文直出（§11.4.26 原始响应列）。展开体是**兄弟 <tr>**
  // （.ant-table-expanded-row），不在本行 <tr> 里 → 用 id 专属 testid 在页级定位。
  await okRow.locator(".ant-table-row-expand-icon").click();
  await expect(page.getByTestId("notify-channel-raw-" + created.id)).toBeVisible();
  // 刷新后 ✓ 仍在：回执落在库（last_send），不是内存里演的
  await page.reload();
  await expect(channelRow(page, renamed).getByTestId("notify-last-send")).toContainText("✓");
  const ls = (await asUser(token, "get", "notify-channels/" + created.id)).body.last_send;
  expect(ls.ok).toBe(true);

  // UI 删除（确认弹窗）→ 行消失 → 后端 404
  await channelRow(page, renamed).getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  await expect(channelRow(page, renamed)).toHaveCount(0);
  expect((await asUser(token, "get", "notify-channels/" + created.id)).status).toBe(404);
});

test("打码回显：列表显示的就是后端掩码原串；掩码原样保存不毁密钥；URL query 段整段打码", async ({ page }) => {
  test.setTimeout(120_000);
  const { token } = await seedProject(page, "1e渠道打码");
  await openPage(page);
  const name = uniq("钉钉");
  const created = await createChannel(page, token, {
    name, type: "钉钉",
    fields: { url: OK_URL + "?access_token=tk-query-777", access_token: "abc123456789" },
  });

  // 后端掩码原串（前 5 位 + ••••；query 段整段替换）——UI 断言全部以这份原值为尺
  const masked = (await asUser(token, "get", "notify-channels/" + created.id)).body.config;
  expect(masked.access_token).toBe("abc12••••"); // 后端形状核对（写歪了这里先红，别赖 UI）
  const row = channelRow(page, name);
  const cell = page.getByTestId("notify-channel-config-" + created.id);
  await expect(cell).toContainText("access_token: " + masked.access_token);
  await expect(cell).toContainText("url: " + masked.url);
  // 明文与密文都不许出现在回显里（前端截断/后端漏码都会在这里红）
  await expect(cell).not.toContainText("abc123456789");
  await expect(cell).not.toContainText("tk-query-777");
  expect(JSON.stringify(created.config)).not.toContain("gAAAA"); // 掩码不是密文原串

  // 编辑抽屉逐字预填掩码原串（显示口径 = PATCH 语义）
  await row.getByTestId("notify-channel-edit-" + created.id).click();
  await expect(page.getByTestId("notify-field-access_token")).toHaveValue(masked.access_token);
  await page.getByTestId("notify-channel-save").click(); // 一个字不改直接保存
  const again = (await asUser(token, "get", "notify-channels/" + created.id)).body.config;
  expect(again.access_token).toBe("abc12••••"); // 没把 •••• 当新值再加密一层

  // 最硬的证明：掩码回环保存后测试发送仍 ✓（若二次加密，解密必炸 → 如实 ✗）
  await row.getByTestId("notify-channel-test-" + created.id).click();
  await expect(page.getByTestId("notify-test-result")).toContainText("发送成功");
  await page.getByTestId("notify-test-close").click();
  await expect(row.getByTestId("notify-last-send")).toContainText("✓");

  // 清理
  await row.getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  await expect(channelRow(page, name)).toHaveCount(0);
});

test("对端 401 如实 ✗ 且原始响应直出：状态 ≥400 不算成功，raw 就是对端 JSON 原文", async ({ page }) => {
  test.setTimeout(120_000);
  const { token } = await seedProject(page, "1e渠道401");
  await openPage(page);
  const name = uniq("吃401");
  const created = await createChannel(page, token, { name, fields: { url: "http://127.0.0.1:9999/login" } });
  const row = channelRow(page, name);

  await row.getByTestId("notify-channel-test-" + created.id).click();
  await expect(page.getByTestId("notify-test-result")).toContainText("发送失败");
  await expect(page.getByTestId("notify-test-result")).toContainText("HTTP 401");
  // §11.4.26「原始响应」：对端 JSON 原文逐字回显（不翻译不改写）
  await expect(page.getByTestId("notify-test-raw")).toContainText("账号或密码错误");
  await page.getByTestId("notify-test-close").click();
  await expect(row.getByTestId("notify-last-send")).toContainText("✗");

  await row.getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  await expect(channelRow(page, name)).toHaveCount(0);
});

test("不可达目标如实 ✗：弹窗报错误原话、行内红标、刷新后 ✗ 落库仍在", async ({ page }) => {
  test.setTimeout(120_000);
  const { token } = await seedProject(page, "1e渠道不可达");
  await openPage(page);
  const name = uniq("死链");
  const created = await createChannel(page, token, { name, fields: { url: DEAD_URL } });
  const row = channelRow(page, name);

  await row.getByTestId("notify-channel-test-" + created.id).click();
  await expect(page.getByTestId("notify-test-result")).toBeVisible();
  await expect(page.getByTestId("notify-test-result")).toContainText("发送失败");
  // 错误原话直出（type+原文，不翻译不精简）：连接被拒家族
  await expect(page.getByTestId("notify-test-result").getByTestId("notify-test-raw")).toHaveCount(0); // 网络层失败无对端 raw——不许编
  const rowText = await page.getByTestId("notify-test-result").textContent();
  expect(rowText).toMatch(/ConnectError|ConnectTimeout|OSError|WinError/);
  await page.getByTestId("notify-test-close").click();

  // 行内 ✗（绝不画成 ✓），且 last_send 落库后刷新仍在
  await expect(row.getByTestId("notify-last-send")).toContainText("✗");
  const ls = (await asUser(token, "get", "notify-channels/" + created.id)).body.last_send;
  expect(ls.ok).toBe(false);
  expect(ls.error).toBeTruthy();
  await page.reload();
  await expect(channelRow(page, name).getByTestId("notify-last-send")).toContainText("✗");

  await channelRow(page, name).getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  await expect(channelRow(page, name)).toHaveCount(0);
});

test("删除被 409 拦下：渠道被定时任务引用 → 弹窗点名引用方 → 解绑后可删", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "1e渠道引用");
  await openPage(page);
  const name = uniq("被引用");
  const created = await createChannel(page, token, { name, fields: { url: OK_URL } });

  // 引用方走 API 造（定时任务页归 scheduleNotify.spec）：subject 只校验类型，id 存期不校验
  const taskName = uniq("定时引用");
  const task = await asUser(token, "post", "schedule-tasks", {
    data: {
      project_id: projectId, name: taskName, subject_type: "scenario",
      subject_id: "subj-1e-t9", cron: "0 3 * * *", notify_channel_ids: [created.id],
    },
  });
  expect(task.ok, JSON.stringify(task.body)).toBeTruthy();

  await channelRow(page, name).getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  // 拦截不是失败：弹窗点名计数与引用方（admin 有 schedule:read → 明细可见）
  await expect(page.getByTestId("notify-inuse")).toContainText("1");
  await expect(page.getByTestId("notify-inuse-task")).toHaveText(taskName);
  await page.getByTestId("notify-inuse-close").click();
  await expect(channelRow(page, name)).toBeVisible(); // 拦下了，渠道还在

  // 解绑（删任务）后删除通过
  const del = await asUser(token, "post", "schedule-tasks/" + task.body.id + "/delete", {
    data: { project_id: projectId, task_id: task.body.id },
  });
  expect(del.ok, JSON.stringify(del.body)).toBeTruthy();
  await channelRow(page, name).getByTestId("notify-channel-remove-" + created.id).click();
  await page.getByTestId("notify-channel-delete-ok").click();
  await expect(channelRow(page, name)).toHaveCount(0);
});
