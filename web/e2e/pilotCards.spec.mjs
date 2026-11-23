// 1F T6：候选场景卡片的业主 e2e 演示路径（一期 DoD 第四条 §1.5 :51 的 UI 半边）。
// 动线：进 bench → 选假模型 → 发一句话 → ≥2 张候选卡 → [画布预览] 新 Tab 只读画布
// → 预览页顶部「Pilot 候选预览（未落库）」+ [保存为场景] 接真（D264：弹窗落库 → 已保存）
// → [选择] 回写用户消息进事件流。
//
// 模型走行（计划 T6 原文 + 1A 金线先例）：seed 一条 base_url=fake://two_candidate_plans
// 的 CHAT 模型配置——假模型回放脚本（backend/tests/fixtures/fake_model/，T5 钉死的那份）
// 在真 HTTP 进程里同样被 gateway_from_config 认下（gateway.py :168 fake:// 前缀 → FakeGateway）。
// 卡的 graph 节点 ref 走 {{TR:search_test_assets:...}} 链式引用：项目里必须真有两「登录」
// 用例，检索不到源结果就抛（宁抛不装绿）——所以每个用例先经 API 造两条真资产。
//
// 诚实口径（写进手册同款）：这条 e2e 钉的是**协议 + 渲染 + 路径贯通**，
// 不证明真模型聪明（§14 :1623：真模型冒烟放 nightly，不进 PR 门禁）。
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

const FIXTURE = "fake://two_candidate_plans";

/** 造数据：专属项目 + 两条「登录」api_case（夹具 TR 引用 items.0/items.1 的资产底座）
 *  + 一条 fake:// 的 CHAT 模型配置（不动默认模型 fake-basic，用例里显式选它）。 */
async function seedBenchPage(page, label) {
  const { token, projectId } = await seedProject(page, label);
  for (const name of ["登录成功用例", "登录失败锁定用例"]) {
    const d = await asUser(token, "post", "api-definitions", {
      data: {
        project_id: projectId, name: "登录接口-" + name, method: "POST", path: "/login",
        request: { method: "POST", url: "http://127.0.0.1:9999/login" },
      },
    });
    expect(d.ok, JSON.stringify(d.body)).toBeTruthy();
    const c = await asUser(token, "post", "api-cases", {
      data: { project_id: projectId, definition_id: d.body.id, name },
    });
    expect(c.ok, JSON.stringify(c.body)).toBeTruthy();
  }
  const cfgName = "e2e-two-cand-" + Date.now().toString(36);
  const cfg = await asUser(token, "post", "model-cfgs", {
    data: {
      name: cfgName, model_type: "CHAT", protocol: "OPENAI_COMPAT",
      base_url: FIXTURE, model_name: "fake-two-candidate",
    },
  });
  expect(cfg.ok, JSON.stringify(cfg.body)).toBeTruthy();
  return { token, projectId, cfgName };
}

/** 建会话 → 选假模型 → 发 DoD 那句话 → 等候选卡出现（假模型回放是本地脚本，15s 足够）。 */
async function sendDodMessage(page, cfgName) {
  await page.goto("/#/bench");
  await expect(page.getByTestId("bench")).toBeVisible();
  // seedProject 注入的 tp_project 会被 bench 预选为当前项目，无需手选
  await page.getByTestId("bench-start").click();
  await expect(page.getByTestId("bench-model-select")).toBeVisible();
  await page.getByTestId("bench-model-select").click();
  // 键入过滤，别在浮层里滚着找：e2e 库**跨轮次保留**，每跑一遍就多留一条 fake:// 配置，
  // 实测第 2 个用例起下拉里已有 5 条同名前缀项，antd 虚拟列表根本不渲染目标项 → 120s 点不到。
  // 靠 showSearch + optionFilterProp="label"（bench.tsx）把候选收敛成 1 条。
  await page.keyboard.type(cfgName);
  await pickOption(page, cfgName);
  await page.getByTestId("bench-input").fill("创建一个登录功能的回归测试");
  await page.getByTestId("bench-send").click();
  await expect(page.getByTestId("scenario-plans-card").first()).toBeVisible({ timeout: 20_000 });
  // 单 run 收敛（假模型脚本播完 → RUN_END → 空闲）；「选择」钮要等 busy 解除才可点
  await expect(page.getByTestId("bench-status")).toHaveText("空闲", { timeout: 20_000 });
}

test("候选卡 ×2 + 画布预览只读页：banner、[保存为场景] 落库成真场景、节点真渲染", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId, cfgName } = await seedBenchPage(page, "1f候选卡预览");
  await sendDodMessage(page, cfgName);

  // ≥2 张候选卡（DoD 判据第 1 条的卡片面）+ 步骤预览非空 + 方案名来自夹具
  const cards = page.getByTestId("plan-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("登录冒烟（方案A）");
  await expect(cards.nth(1)).toContainText("登录重试（方案B）");
  await expect(page.getByTestId("step-preview-row").first()).toHaveText("调登录接口");

  // [画布预览] 开新 Tab（同 Tab 跳会丢 bench 会话现场——T4 的成型行为）
  const popupPromise = page.context().waitForEvent("page");
  await cards.nth(0).getByTestId("plan-preview").click();
  const preview = await popupPromise;
  await preview.waitForLoadState();
  await expect(preview.getByTestId("page-scene-preview")).toBeVisible();

  // 顶部说明条：预览 ≠ 落库（一句话口径逐字钉，改了字就是改了诚实承诺）
  await expect(preview.getByTestId("preview-banner")).toContainText("Pilot 候选预览（未落库）");
  await expect(preview.getByTestId("preview-banner"))
    .toContainText("方案「登录冒烟（方案A）」是 Pilot 给出的候选，尚未保存为场景，仅在此只读预览。");

  // D264：保存接真——[保存为场景] 可点；弹窗改名 → POST /scenarios → 「已保存」+ 场景链接
  // （e2e 库跨轮次保留，名字加时间戳避开 409 同名）
  await preview.getByTestId("plan-save").click();
  const savedName = "e2e落库-" + Date.now().toString(36);
  await preview.getByTestId("plan-save-name").fill(savedName);
  await preview.getByTestId("plan-save-ok").click();
  await expect(preview.getByTestId("plan-saved")).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByTestId("plan-saved-open")).toHaveAttribute("href", /#\/scene\//);
  // 横幅翻面：页面上不许同时出现「尚未保存」与「已保存」
  await expect(preview.getByTestId("preview-banner")).toContainText("已保存为正式场景");
  await expect(preview.getByTestId("preview-banner")).not.toContainText("尚未保存为场景");
  // 库里得真有一条（UI 绿了不算）：按名字回查项目的场景列表
  const found = await asUser(token, "get",
    "scenarios?project_id=" + encodeURIComponent(projectId) + "&keyword=" + encodeURIComponent(savedName));
  expect(found.ok, JSON.stringify(found.body)).toBeTruthy();
  expect(found.body.items.map((it) => it.name)).toContain(savedName);

  // 只读画布真出节点（夹具方案A 的单节点 key=s1；sessionStorage 传 graph 的链路通了才有这行）
  await expect(preview.getByTestId("preview-canvas")).toBeVisible();
  await expect(preview.getByTestId("scene-node-s1")).toBeVisible();
});

test("候选卡 [选择]：回写「[卡片操作] 选择方案：…」进事件流（单 run 假模型播完即收敛）", async ({ page }) => {
  test.setTimeout(120_000);
  const { cfgName } = await seedBenchPage(page, "1f候选卡选择");
  await sendDodMessage(page, cfgName);
  await expect(page.getByTestId("plan-card")).toHaveCount(2);

  // 点第二张卡的 [选择]：拼前缀走 POST messages——事件流里出现该 USER 卡才算回写贯通
  await page.getByTestId("plan-select").nth(1).click();
  const userCard = page.getByTestId("event-card").filter({ hasText: "[卡片操作] 选择方案：登录重试（方案B）" });
  await expect(userCard.first()).toBeVisible({ timeout: 15_000 });
  // 第二条消息又起一个 run；FakeGateway 一次性消费：脚本播完 → 空流 → 收敛回空闲（不挂死）
  await expect(page.getByTestId("bench-status")).toHaveText("空闲", { timeout: 20_000 });
});
