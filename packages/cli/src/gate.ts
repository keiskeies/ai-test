/**
 * 门禁判定：一次运行**该以什么退出码结束**。
 *
 * 单独一个纯函数模块，因为这是 CLI 里唯一会直接影响"流水线红不红"的判断，
 * 必须能被直接调用测试 —— 走"起子进程跑一次 atest"来验它，
 * 测到的是子进程管理与 spawn 参数，而不是判定本身。
 *
 * 四条判据都有出处：
 *  1. `--ci` 且 frozen=false → 拒绝执行（docs/02 §1：把 Agent 对话入口与 CI 门禁隔开）。
 *     **不跑**任何东西就返回。跑了再拒绝等于把副作用（POST、下单、清理）先做完了再说"这次不算"。
 *  2. `--ci` 且缺 provenance → 拒绝。没有来源记录的场景无法回答"这是谁依据什么写的"，
 *     出问题时没人能判断用例本身对不对（M7 的判据）。
 *  3. 带 tag `triage` 的场景 → **失败不算失败**，只出清单（docs/05 §3 要点 1：
 *     首轮必一片红，一片红的第一天 = 用户关掉整个门禁）。
 *     这条必须显式、可见、带下一步动作，否则就是"把红灯涂绿"。
 *  4. error 与 fail 分开。error 是"没测成"，fail 是"测出来是坏的"，
 *     混起来会让人在环境问题上查产品代码。
 */
import type { RunReport } from '@atest/engine';
import { CONTAINER_KINDS, type Scenario } from '@atest/ir';
import { EXIT } from './exit.js';

export interface GateInput {
  scenario: Scenario;
  report?: RunReport;
  /** 本次是 CI 模式（--ci） */
  ci: boolean;
  /** 显式允许未冻结场景进 CI。默认关；给了要能在输出里看见 */
  allowUnfrozen: boolean;
}

export interface GateDecision {
  code: number;
  /** 打给人看的理由（每行一条）。CI 日志里必须能看到"为什么是这个码" */
  reasons: string[];
  /** 拒绝执行（report 为 undefined 时用它）：不跑任何东西 */
  refused: boolean;
  /** triage 降级掉了多少步失败。不显示这个数字就是在偷偷涂绿 */
  suppressedFails: number;
  /** 待确认清单（triage 场景里的失败步骤） */
  attention: string[];
}

/** 场景是不是"首轮待确认"。tag 是 IR 的正式字段（ScenarioSchema 是 strict 的，塞不进自定义布尔） */
export function isTriage(scenario: Scenario): boolean {
  return scenario.tags.includes('triage');
}

/**
 * 执行**前**的闸。返回 refusal 时命令侧不得开始跑。
 *
 * 顺序有讲究：先查 frozen 再查 provenance。
 * 未冻结是"这场景还没定稿"，缺 provenance 是"定稿了但不知道哪来的" ——
 * 前者是更前置的状态，报后者的话人会先去补 provenance，白做功。
 */
export function gateBeforeRun(i: GateInput): GateDecision {
  const reasons: string[] = [];
  if (!i.ci) return { code: EXIT.OK, reasons, refused: false, suppressedFails: 0, attention: [] };

  if (!i.scenario.frozen && !i.allowUnfrozen) {
    reasons.push(
      `场景 ${i.scenario.id} 的 frozen=false，CI 模式拒绝执行。`,
      'frozen 的含义是"人已确认可当门禁依据"（docs/02 §1）。确认过就把 IR 里改成 true 并提交；',
      '临时想跑一次（比如手工触发验证生成结果）加 --allow-unfrozen，但它同样会记进证据包。',
    );
    return { code: EXIT.INVALID, reasons, refused: true, suppressedFails: 0, attention: [] };
  }

  if (!i.scenario.provenance) {
    reasons.push(
      `场景 ${i.scenario.id} 没有 provenance，CI 模式拒绝执行（M7）。`,
      '缺它就无法回答"这条用例是谁、依据哪个版本的 spec、用哪个模型生成的"，',
      '失败了没人能判断是产品坏了还是用例本来就写错了。补法：provenance.origin + specHash（生成器会自动写）。',
    );
    if (!i.scenario.frozen) reasons.push('（同时 frozen=false，两项都要补）');
    return { code: EXIT.INVALID, reasons, refused: true, suppressedFails: 0, attention: [] };
  }

  if (!i.scenario.frozen && i.allowUnfrozen) {
    reasons.push(`已按 --allow-unfrozen 执行未冻结场景 ${i.scenario.id}。这次的结果不能当质量门禁依据，frozen=false 也记进了证据包。`);
  }
  return { code: EXIT.OK, reasons, refused: false, suppressedFails: 0, attention: [] };
}

/**
 * 执行**后**的判定。
 *
 * `report.status` 不直接等于退出码，因为：
 *  - 六态里 error/healed/triaged 各要不同处理，而 status 是归约后的单值；
 *  - triage 场景的 fail 要降级；
 *  - "什么都没跑"（results 为空）不是通过 —— 那是绿得可疑。
 */
export function gateAfterRun(i: GateInput): GateDecision {
  const before = gateBeforeRun(i);
  if (before.refused) return before;
  const report = i.report;
  if (!report) return before;

  const reasons = [...before.reasons];
  const triage = isTriage(i.scenario);

  // 叶子步骤才算结论。清单来自 ir 的 CONTAINER_KINDS（与 JUnit 计数同一份），
  // 不在这儿手写一遍：两处清单迟早漂移，而漂移的表现是"CI 退出码与报告里的用例数对不上"
  const leaves = report.results.filter((r) => !CONTAINER_KINDS.includes(r.kind));
  const fails = leaves.filter((r) => r.status === 'fail');
  const errors = leaves.filter((r) => r.status === 'error');
  const healed = leaves.filter((r) => r.status === 'healed');
  const attention: string[] = [];

  if (!leaves.length) {
    reasons.push('本次运行没有任何断言结论（0 个叶子步骤）。空场景判"通过"是最危险的假绿：它什么也没测。');
    return { code: EXIT.INVALID, reasons, refused: false, suppressedFails: 0, attention };
  }

  let suppressed = 0;
  if (triage && fails.length) {
    suppressed = fails.length;
    attention.push(...fails.map((r) => `${r.stepId}: ${r.assertionSummary ?? '（无摘要）'}`));
    reasons.push(
      `本场景带 tag triage，${fails.length} 个失败降级为"待确认清单"，**不计入退出码**（docs/05 §3 要点 1）。`,
      '这些策略（requiredMissing/typeViolation/negativeFuzz）第一轮通常一片红，因为后端不做参数校验是常态。',
      '人工确认哪些是真缺陷后，把 triage 标签去掉它们就进门禁。',
    );
  }
  if (healed.length) {
    attention.push(...healed.map((r) => `~ ${r.stepId}（自愈待审）: ${r.assertionSummary ?? ''}`));
  }

  // error 优先于 fail：环境/用例问题要先解决，否则 fail 的结论本身不可信。
  //
  // 这里**刻意不按 cause 细分退出码**（一度想把 env-unavailable 归到 ENV）。
  // 归不动：cause 是引擎侧的粗分类，`env-unavailable` 同时覆盖
  // "没注册 adapter（配置缺失，重试也没用）"与"被测环境连不上（值得重试）"。
  // 一旦按它分，配置缺失与目标临时挂掉就共用一个码，
  // CI 的"5 就重试一次"要么白重试、要么该重试的不重试 —— 两者都静默。
  // 正确的修法是在**跑之前**把能确定的配置问题拦掉（见 commands.ts 的
  // requireAdapters），剩下的错误统一按"没测成、可重试一次"处理。
  if (errors.length) {
    reasons.push(`${errors.length} 个步骤**出错**（不是断言失败）：${errors.map((r) => `${r.stepId}${r.cause ? `[${r.cause}]` : ''}`).join('、')}。`);
    reasons.push('error 意味着"没测成"，先修环境或用例，此时 fail 的结论也不可信。');
    return { code: EXIT.RUNTIME, reasons, refused: false, suppressedFails: suppressed, attention };
  }
  if (fails.length && !triage) {
    reasons.push(`${fails.length} 个断言失败：${fails.map((r) => `${r.stepId}${r.cause ? `[${r.cause}]` : ''}`).join('、')}。`);
    return { code: EXIT.TEST_FAILED, reasons, refused: false, suppressedFails: 0, attention };
  }
  if (healed.length) {
    // healed 计入分母不计入分子：它"跑通了"但没人审过定位器改动
    reasons.push(`${healed.length} 步靠自愈通过，**等人审**（改了定位器/等待策略的用例必须被看见，否则自愈会慢慢把用例改成"永远通过"）。`);
    return { code: EXIT.TEST_FAILED, reasons, refused: false, suppressedFails: suppressed, attention };
  }
  reasons.push(`${leaves.length} 个断言全部通过。`);
  return { code: EXIT.OK, reasons, refused: false, suppressedFails: suppressed, attention };
}
