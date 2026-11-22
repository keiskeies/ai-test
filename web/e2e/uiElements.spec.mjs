// 元素库页（T14，§11.4.11 / §11.5.4）：新建 → 引用检测删除（R106 硬拦）→ 回收/恢复 →
// 逐字输名彻底删除 → 模块彻底删除元素不陪葬；另一条只读成员「写入口一个都不渲染」。
// 造数据走 API，UI 只验 UI（helpers.mjs 约定）；⑥ 的 toast 同时钉 ModuleTree 彻底删除
// 回执修复——旧代码只认 detached_definitions/detached_scenarios，「N 个元素转为未分类」会静默丢失。
import { expect, request, test } from "@playwright/test";
import { ADMIN, BASE, asUser, pickOption, seedMember, seedProject } from "./helpers.mjs";

/** 管理员 token（只读成员那条需要一个旁观者往她项目里放数据）。 */
async function adminToken() {
  const ctx = await request.newContext({ baseURL: BASE + "/" });
  const r = await ctx.post("auth/login", { data: ADMIN });
  expect(r.ok()).toBeTruthy();
  const token = (await r.json()).token;
  await ctx.dispose();
  return token;
}

test("元素库：新建 → 引用拦截 → 回收恢复 → 输名彻底删除 → 模块 purge 元素不陪葬", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "ui-elements");
  await page.goto("http://127.0.0.1:5173/#/ui/elements");
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  await expect(page.getByTestId("ui-element-new")).toBeVisible();

  // ① 新建：名称 / 类型▾ / 表达式 → 行出现，定位方式是徽标，超长表达式省略 + 复制入口
  await page.getByTestId("ui-element-new").click();
  await page.getByTestId("ui-element-name").fill("登录按钮");
  await page.getByTestId("ui-element-type").click();
  await pickOption(page, "xpath");
  await page.getByTestId("ui-element-new-locator")
    .fill("#app > div.container > form.login-form > button[type=submit]:nth-child(3) > span.label");
  await page.getByTestId("ui-element-new-ok").click();
  const rowA = page.getByRole("row").filter({ hasText: "登录按钮" });
  await expect(rowA.getByTestId("ui-element-row-name")).toHaveText("登录按钮");
  await expect(rowA.getByTestId("ui-element-tag-xpath")).toBeVisible();
  await expect(rowA.getByTestId("ui-element-used-by")).toHaveText("0");
  // 省略生效（antd Typography ellipsis 的类）+ hover 复制入口在
  await expect(rowA.locator(".ant-typography.ant-typography-ellipsis")
    .filter({ hasText: "login-form" })).toBeVisible();
  await expect(rowA.locator(".ant-typography-copy").first()).toBeVisible();

  // ② 被未回收用例引用 → 删除弹窗列出用例名，删不掉（后端 409，前端如实展示）
  const els = await asUser(token, "get", "ui-elements?project_id=" + projectId);
  expect(els.status).toBe(200);
  const elId = els.body.items.find((e) => e.name === "登录按钮").id;
  const uc = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name: "登录流程", priority: "P1",
    steps: [{ id: "s1", type: "click", element_id: elId }],
  } });
  expect(uc.status).toBe(201);
  await page.getByTestId("ui-element-reload").click();
  await expect(rowA.getByTestId("ui-element-used-by")).toHaveText("1"); // used_by 与拦截同源
  await rowA.getByTestId("ui-element-delete").click();
  await page.getByTestId("ui-element-del-ok").click();
  const refs = page.getByTestId("ui-element-refs");
  await expect(refs).toBeVisible();
  await expect(refs.getByTestId("ui-element-ref-case")).toContainText("登录流程");
  await expect(refs).toContainText("先解引用再来");
  await expect(rowA).toBeVisible(); // 弹窗关掉也没删掉
  const still = await asUser(token, "get", "ui-elements/" + elId + "?project_id=" + projectId);
  expect(still.status).toBe(200);
  expect(still.body.status).toBe("normal");
  await page.getByTestId("ui-element-refs-ok").click();

  // ③ 回收 → 回收站视图能恢复
  await page.getByTestId("ui-element-new").click();
  await page.getByTestId("ui-element-name").fill("临时占位");
  await page.getByTestId("ui-element-new-locator").fill("#tmp-placeholder");
  await page.getByTestId("ui-element-new-ok").click();
  const rowB = page.getByRole("row").filter({ hasText: "临时占位" });
  await expect(rowB).toBeVisible();
  await rowB.getByTestId("ui-element-delete").click();
  await page.getByTestId("ui-element-del-ok").click();
  await expect(rowB).toHaveCount(0);
  await page.getByTestId("module-recycled-toggle").click();
  await expect(rowB.getByTestId("ui-element-restore")).toBeVisible();
  await rowB.getByTestId("ui-element-restore").click();
  await page.getByTestId("module-recycled-toggle").click();
  await expect(rowB.getByTestId("ui-element-delete")).toBeVisible();

  // ④ 彻底删除要逐字输名：差一个字符按钮是灰的
  await rowB.getByTestId("ui-element-delete").click();
  await page.getByTestId("ui-element-del-ok").click();
  await page.getByTestId("module-recycled-toggle").click();
  await rowB.getByTestId("ui-element-purge").click();
  const ok = page.getByTestId("ui-element-purge-ok");
  await expect(ok).toBeDisabled();
  await page.getByTestId("ui-element-purge-confirm").fill("临时占位 ");
  await expect(ok).toBeDisabled(); // 尾部差一个空格都不行（服务端同样硬校验）
  await page.getByTestId("ui-element-purge-confirm").fill("临时占位");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(rowB).toHaveCount(0);
  const rec = await asUser(token, "get", "ui-elements?project_id=" + projectId + "&recycled=true");
  expect(rec.body.items.find((e) => e.name === "临时占位")).toBeFalsy();

  // ⑥ 建子模块 → 子模块下建元素 → 回收 + 彻底删除子模块：元素仍在且归「未分类」。
  //    toast 里「1 个元素转为未分类」是 ModuleTree purge 回执读到 detached_elements 的证据。
  await page.getByTestId("module-recycled-toggle").click(); // 退出回收站
  await page.getByTestId("module-create").click();
  await page.getByTestId("module-name").fill("登录页");
  await page.getByTestId("module-name").press("Enter");
  const modNode = page.locator(".ant-tree-treenode").filter({ hasText: "登录页" }).first();
  await expect(modNode).toBeVisible();
  await modNode.getByLabel("模块菜单-登录页").hover();
  await page.getByRole("menuitem", { name: "新建子模块" }).click();
  await page.getByTestId("module-name").fill("表单");
  await page.getByTestId("module-name").press("Enter");
  // 新建子模块后必须手动展开父节点：antd Tree 的 defaultExpandAll 只在挂载时生效，
  // 数据刷新后新增的子节点是收起的（实测：不展开时子节点根本不在 DOM 里）
  await modNode.locator(".ant-tree-switcher").click();
  const subNode = page.locator(".ant-tree-treenode").filter({ hasText: "表单" }).first();
  await expect(subNode).toBeVisible();
  await subNode.locator(".ant-tree-node-content-wrapper").click();
  await page.getByTestId("ui-element-new").click();
  await page.getByTestId("ui-element-name").fill("用户名输入框");
  await page.getByTestId("ui-element-new-locator").fill("#username");
  await page.getByTestId("ui-element-new-ok").click();
  const rowC = page.getByRole("row").filter({ hasText: "用户名输入框" });
  // 选中的是叶子模块「表单」，列表就是它自己的行（按模块筛选只看该模块自己的行，
  // 与树徽标「count=直属…」同口径，R120——这里不是「含子树」的证明，叶子没子孙）
  await expect(rowC).toBeVisible();
  const els2 = await asUser(token, "get", "ui-elements?project_id=" + projectId);
  const rowCEl = els2.body.items.find((e) => e.name === "用户名输入框");
  expect(rowCEl.module_id).toBeTruthy(); // 归属子模块坐实

  // ⑤′ 徽标口径（R122）：UI 模块树的 count = 直属「未回收元素 + UI 用例」合计，
  //    而本页列表只列元素。往「表单」模块里塞一条用例，徽标就从 1 变 2、行数还是 1——
  //    这正是演示项目里「徽标 5 / 列表 4 行」的真冲突形状。界面上必须有 Tooltip 说清，
  //    否则看着像计数坏了（演示时真被问过）。
  const mods = await asUser(token, "get", "ui-modules?project_id=" + projectId);
  const formMod = (function find(ns) {
    for (const n of ns || []) { if (n.name === "表单") return n; const r = find(n.children); if (r) return r; }
    return null;
  })(mods.body.tree);
  expect(formMod).toBeTruthy();
  expect(formMod.count).toBe(1); // 先钉「只有 1 个元素」的基线
  const inForm = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name: "表单模块的用例", priority: "P2", module_id: formMod.id,
    steps: [{ id: "s1", type: "click", element_id: rowCEl.id }],
  } });
  expect(inForm.status).toBe(201);
  await page.getByTestId("ui-element-reload").click();
  const badge = page.getByTestId("module-count-表单");
  await expect(badge).toHaveText("2"); // 元素 1 + 用例 1
  await expect(rowC).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "用户名输入框" })).toHaveCount(1);
  await badge.hover();
  await expect(page.locator(".ant-tooltip:not(.ant-tooltip-hidden)"))
    .toContainText("元素 + UI 用例合计");

  await subNode.getByLabel("模块菜单-表单").hover();
  await page.getByRole("menuitem", { name: "放入回收站" }).click();
  await page.getByRole("button", { name: "放入回收站" }).click(); // Modal.confirm 的确认
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("module-purge-表单")).toBeVisible();
  await page.getByTestId("module-purge-表单").click();
  await page.getByTestId("module-purge-confirm").fill("表单");
  await page.getByTestId("module-purge-ok").click();
  // 回执两句都要说：这个模块回收站里彻底删掉时，1 个元素 + ⑤′ 那条用例一起转未分类。
  // 旧消息只报元素那一侧（detached_cases 被丢掉）——少说一件事的成功提示仍是说错话（R122）。
  await expect(page.locator(".ant-message")).toContainText("1 个元素转为未分类");
  await expect(page.locator(".ant-message")).toContainText("1 条 UI 用例转为未分类");
  await page.getByTestId("module-recycled-toggle").click();
  await expect(rowC).toBeVisible(); // 元素没陪葬
  const after = await asUser(token, "get", "ui-elements/" + rowCEl.id + "?project_id=" + projectId);
  expect(after.status).toBe(200);
  expect(after.body.module_id).toBeNull(); // 归「未分类」（后端语义的前端可见性）
});

test("元素库只读成员：新建 / 删除 / 回收站入口不在 DOM 里（不是 disabled）", async ({ page }) => {
  const { projectId } = await seedMember(page, "t14只读", "READONLY", "ro_el");
  // 管理员先在这个项目放一个元素：让「有数据可删但按钮不渲染」这件事真的成立
  const admin = await adminToken();
  const made = await asUser(admin, "post", "ui-elements", { data: {
    project_id: projectId, name: "只读可见元素", locator_type: "id", locator: "ro-el",
  } });
  expect(made.status).toBe(201);

  await page.goto("http://127.0.0.1:5173/#/ui/elements");
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  await expect(page.getByTestId("ui-element-row-name")).toHaveText("只读可见元素");
  // settings.spec 钉的手感：写入口一个都不渲染
  await expect(page.getByTestId("ui-element-new")).toHaveCount(0);
  await expect(page.getByTestId("module-create")).toHaveCount(0);
  await expect(page.getByTestId("module-recycled-toggle")).toHaveCount(0);
  await expect(page.getByTestId("ui-element-delete")).toHaveCount(0);
});
