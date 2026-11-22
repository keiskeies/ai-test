// 设置页与按钮级权限（§10.1 / §11.4.27）。
// 核心断言不是「点得动」，而是「不该出现的按钮根本不在 DOM 里」：只读成员看得见
// 接口管理（他有 *:read），但「+新建」必须消失——藏不藏按钮是体验问题，后端 403 才是门禁。
import { test, expect } from "@playwright/test";
import { asUser, pickOption, seedMember, seedProject, wallClock } from "./helpers.mjs";

test("只读成员：nav-api 可进，但「+新建」等写按钮一律不渲染", async ({ page }) => {
  const { projectId, project } = await seedMember(page, "t16只读", "READONLY", "ro_ui");
  // 服务端确实下发了只读模式串（前端不是按内置角色表猜的）
  expect(project.my_role).toBe("READONLY");
  expect(project.my_perms).toContain("*:read");
  expect(project.my_perms).toContain("-system:*");

  await page.goto("/#/api");
  await expect(page.getByTestId("page-api")).toBeVisible();
  // 读得到的东西照常显示
  await expect(page.getByTestId("module-tree")).toBeVisible();
  // 写入口一个都不渲染（不是 disabled，是不存在）
  await expect(page.getByTestId("api-new")).toHaveCount(0);
  await expect(page.getByTestId("module-create")).toHaveCount(0);
  // 环境「查看」入口保留（只读也得知道跑的是哪个环境），但面板里的写按钮必须消失
  await page.getByTestId("env-manage").click();
  await expect(page.getByTestId("env-new")).toHaveCount(0);
  await expect(page.getByTestId("env-delete")).toHaveCount(0);
  await page.locator(".ant-modal-root .ant-modal-close").click();
  // 导航项本身还在：只读也是能看的人，不该被从菜单里踢出去
  await expect(page.getByTestId("nav-api")).toBeVisible();

  // 数据集页同理：读得到列表，建不了
  await page.goto("/#/datasets");
  await expect(page.getByTestId("page-datasets")).toBeVisible();
  await expect(page.getByTestId("ds-new")).toHaveCount(0);

  // 设置页：成员 Tab 在（只读也能看成员名单），但「添加成员」不渲染；
  // 平台用户 / 审计日志两个 Tab 对他 403，所以整个 Tab 都不出现
  await page.goto("/#/settings");
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await expect(page.getByTestId("tab-members")).toBeVisible();
  await expect(page.getByTestId("member-add")).toHaveCount(0);
  await expect(page.getByTestId("member-remove")).toHaveCount(0);
  // 角色下拉也不给：只读改不了角色（后端 project:member:manage 会 403）
  await expect(page.getByTestId("member-role")).toHaveCount(0);
  await expect(page.getByTestId("member-role-static")).not.toHaveCount(0);
  // 那两个口对只读成员永远 403，所以整个 Tab 都不出现（AntD 的 tab 是 div，按类名取）
  const tabs = page.locator(".ant-tabs-tab");
  await expect(tabs.filter({ hasText: "平台用户" })).toHaveCount(0);
  await expect(tabs.filter({ hasText: "审计日志" })).toHaveCount(0);

  // 后端仍然兜底：绕过 UI 直接调写接口 → 403（按钮只是省得你撞墙）
  const roToken = await page.evaluate(() => localStorage.getItem("tp_token"));
  const w = await asUser(roToken, "post", "envs", { data: { project_id: projectId, name: "偷跑环境" } });
  expect(w.status).toBe(403);
  expect(w.body.code).toBe("insufficient_permission");
});

test("项目管理员：加成员→改角色→对方按钮立刻跟着变", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t16成员");
  await page.goto("/#/settings");
  await expect(page.getByTestId("tab-members")).toBeVisible();

  // 1) 按姓名/账号搜索候选人（不是粘 UUID——项目管理员拿不到别人的平台信息）
  await page.getByTestId("member-add").click();
  // rc-dialog 不透传未知 props：data-testid 落在 ant-modal-root（它是 hidden 的壳），
  // 可见性要问真正渲染的 .ant-modal-content
  await expect(page.locator(".ant-modal-content")).toBeVisible();
  // data-testid 挂在 .ant-select 外壳上，真正能输入的是里面那个 <input>
  await page.getByTestId("member-candidate").locator("input").fill("admin");
  await expect(page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "admin" }).first()).toBeVisible();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "admin" }).first().click();
  await page.getByTestId("member-new-role").click();
  await pickOption(page, "只读");
  await page.getByTestId("member-add-ok").click();
  // admin 本来就是创建者 → 这一行从一开始就在表里，「行可见」证明不了写请求已完成。
  // 等弹窗关掉 + 角色下拉真的显示新角色，再去后端核对。
  await expect(page.locator(".ant-modal-content")).toHaveCount(0, { timeout: 10_000 });
  const rowOf = (name) => page.getByTestId("member-account").filter({ hasText: name })
    .locator("xpath=ancestor::tr[1]");
  await expect(rowOf(/^admin/).getByTestId("member-role")).toContainText("只读", { timeout: 10_000 });

  // 2) 后端事实核对：成员表里角色真的变了
  const ms = await asUser(token, "get", "projects/" + projectId + "/members");
  expect(ms.ok).toBeTruthy();
  const adminRow = ms.body.items.find((m) => m.account === "admin");
  expect(adminRow).toBeTruthy();
  expect(adminRow.role_code).toBe("READONLY");

  // 3) 改成测试工程师：下拉是项目管理员的常规操作
  await rowOf(/^admin/).getByTestId("member-role").click();
  await pickOption(page, "测试工程师");
  await expect(rowOf(/^admin/).getByTestId("member-role")).toContainText("测试工程师", { timeout: 10_000 });

  const ms2 = await asUser(token, "get", "projects/" + projectId + "/members");
  expect(ms2.body.items.find((m) => m.account === "admin").role_code).toBe("MEMBER");


  // 4) 平台管理员看得到「平台用户」Tab，并且建用户 Modal 里写清了密码去向
  await page.locator(".ant-tabs-tab").filter({ hasText: "平台用户" }).click();
  await expect(page.getByTestId("tab-users")).toBeVisible();
  await page.getByTestId("user-create").click();
  await expect(page.locator(".ant-modal-content").last()).toBeVisible();
  await expect(page.locator(".ant-modal-content").last())
    .toContainText("新密码将告知用户，平台不保存明文");
  await page.locator(".ant-modal-content").last().getByRole("button", { name: /取/ }).click();
});

test("系统管理员：审计 Tab 查得到刚才的写操作", async ({ page }) => {
  const { token, projectId } = await seedProject(page, "t16审计");
  // 造一条必然落审计的写操作：建环境（POST /envs → env_create）
  const e = await asUser(token, "post", "envs", { data: { project_id: projectId, name: "审计靶环境" } });
  expect(e.ok).toBeTruthy();
  // 再造一条失败的：同名冲突 → ok=false 也要留痕
  const dup = await asUser(token, "post", "envs", { data: { project_id: projectId, name: "审计靶环境" } });
  expect(dup.status).toBe(409);

  await page.goto("/#/settings");
  await page.locator(".ant-tabs-tab").filter({ hasText: "审计日志" }).click();
  await expect(page.getByTestId("tab-audit")).toBeVisible();
  await page.getByTestId("audit-filter-action").fill("env_create");
  await page.getByTestId("audit-filter-action").press("Enter");
  await expect(page.getByTestId("audit-action").filter({ hasText: "env_create" }).first())
    .toBeVisible({ timeout: 15_000 });
  // 成功与失败两条都在
  await expect(page.getByTestId("audit-ok").filter({ hasText: "失败" }).first()).toBeVisible();
  await expect(page.getByTestId("audit-entry").first()).toHaveText("HTTP");
  // 时间列换成东八区墙钟（R68）：原先是 slice(0,19)，画的是 UTC 钟点，早 8 小时，
  // 而这一列此前**根本没被断言过**——审计页只测了动作和结果。逐行比 API 的 ts 独立换算值。
  const apiAudit = await asUser(token, "get", "audit?project_id=" + projectId + "&action=env_create");
  expect(apiAudit.status).toBe(200);
  const tsById = Object.fromEntries(apiAudit.body.items.map((a) => [a.id, a.ts]));
  for (let i = 0; i < 2; i += 1) {
    const row = page.getByTestId("audit-row").nth(i);
    const aid = await row.getAttribute("data-audit-id");
    expect(tsById[aid], "审计这条在 API 侧找不到: " + aid).toBeTruthy();
    const shown = await row.getByTestId("audit-time").innerText();
    expect(shown).toBe(wallClock(tsById[aid]));
    expect(shown).not.toBe(tsById[aid].slice(0, 19).replace("T", " "));
  }
  // 失败记录点开看得到原因，而不是只有一句「失败了」
  await page.getByTestId("audit-filter-ok").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "失败" }).first().click();
  await expect(page.getByTestId("audit-row")).toHaveCount(1, { timeout: 10_000 });
  await page.getByTestId("audit-detail").first().click();
  await expect(page.getByTestId("audit-detail-card")).toContainText("error");
});
