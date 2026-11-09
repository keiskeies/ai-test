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
import { ASSERTION_KINDS, CONTAINER_KINDS, countsTowardPassRate, walk, type Scenario, type Step, type StepResult } from '@atest/ir';
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

  /**
   * **容器自己下的结论**（不是把子步骤的结论往上递的那一份）。
   *
   * 容器的 fail/error 有两种来源，退出码必须区别对待：
   *  - **传递**：`runChildren` 遇到子步骤 fail/error 时 `return { status: r.status, ... }`
   *    （interpreter.ts:320-324），parallel 分支失败同理（:502-505）。这时**叶子那条
   *    结果也在 results 里**，把它算第二遍就是"一次循环失败数出 N 条失败"——
   *    上面那份 leaves 过滤存在的唯一理由，`gate.test.ts` 里 "1 个断言失败" 那条钉的就是它。
   *  - **自己下的**：容器压根没跑到子步骤。`parallel` 撞名被运行时闸拒（error/case-stale）、
   *    `if` 的 condition 表达式求值抛错、`forEach` 的 items 不是可迭代对象 ——
   *    这三种都是"容器记了一条结论，而**没有任何一条叶子结论替它背书**"。
   *
   * 第二种以前**完全进不了退出码**（本文件此前的行为，实测见 test 里那三条新用例）：
   * parallel 被闸拒 + 两条会过的断言 => 退出码 **0**，附一句"2 个断言全部通过。"
   * 判据用"叶子有没有同状态的结论"而不是给 StepResult 加 `delegated` 字段：
   * 后者要动磁盘格式（证据包里的 step_results 是 strict schema），而前者在
   * "叶子有同状态结论"时两条路径给出的退出码本来就相同（error 优先于 fail 的
   * 优先级对传递与不传递一致），区别只出现在传递时**不重复计数**这一点上。
   *
   * fail 与 error 一视同仁是**规则好陈述**的取舍（"容器结论只在没有叶子替它背时计入"），
   * 实测只有 error 那条路径能用真实 IR 造出来：fail 型只在 RunAborted 从 parallel
   * worker 里逃出来时才出现（interpreter.ts:504），而那条路径会在外层 catch 里
   * 追加 `__run__` 的 error 叶子，退出码已经是 RUNTIME。留对称的另一半是为了
   * 不让人以后加容器 kind 时来猜"fail 为什么不算"。
   */
  const isContainer = (r: StepResult) => CONTAINER_KINDS.includes(r.kind);
  const orphanErrors = errors.length ? [] : report.results.filter((r) => isContainer(r) && r.status === 'error');
  const orphanFails = fails.length ? [] : report.results.filter((r) => isContainer(r) && r.status === 'fail');

  /**
   * **"至少得有一条能当门禁的结论"**。
   *
   * 原来只判 `!leaves.length`，漏掉了"结果里明明有条目、却一条都没验"的形态。
   * 三种都用真实 IR 跑 runScenario 实测过（引号里的就是当时的实际输出）：
   *  - 唯一一条断言被守卫 `when` 跳过 => 退出码 **0**，理由写着"1 个断言全部通过"；
   *  - 断言全是 assertLlm 且判成 triaged => 同样 0，同样报"全部通过"；
   *  - 断言全是 assertLlm 且模型判"是" => status 是 `pass`，**光看状态一条都拦不住**
   *    （所以判据必须同时看 kind 与 gatePolicy，见 isConclusive）。
   *
   * 两条判据各治一半，缺一不可：
   *  - 状态：用 ir 的 `countsTowardPassRate`（skipped/triaged 不算）。不另写一份 ——
   *    "什么算一条真结论"在通过率分母那里已经答过一次，第二份答案必然漂移。
   *  - 范围：**只数 ASSERTION_KINDS**。这是被自己的测试逼出来的：我第一版拿
   *    `leaves`（非容器步骤）当结论集，于是 `set`/`http`/`sleep` 全被算成"通过了一条结论"，
   *    "seed(set) + 一条 report-only assertLlm" 照样 0 —— 测试当场报出来了。
   *    而且那句"2 个断言全部通过"里数进 set 步骤，**这句话本来就是假的**。
   *
   * **call 的子场景怎么算**：见下面 scopes 那段。以前是"IR 里声明了 call 就一律放行"，
   * 那个豁免有两个洞（子场景全 skipped / 只有一条 report-only assertLlm 时都照样绿），
   * 现在按 `report.childRuns` 里**实际跑出来的那份 IR** 判。
   *
   * 落在 INVALID 而不是新增一个码：它和"空场景"是同一件事（用例结构没给出结论），
   * CI 侧的动作也相同（改用例，不是查产品、也不是重试）。
   *
   * **这条闸仍盖不住的形状**（记在 docs/08）：一条确定性断言 + 一堆 assertLlm 时
   * `conclusive` 非空、退出码照旧。"report-only 占比过高"是治理指标，不是退出码。
   */
  // 结论**按 IR 作用域分别算**（理由见 Scope 的注释：gatePolicy 住在各自那份 IR 里，
  // 父子同 id 时混成一个集合会拿错的 gatePolicy 去判，然后给人一句查不出来的提示）。
  // 父场景单独命名一份，而不是拼进数组再取 [0]：那个下标在类型上证明不了非空，
  // 而命名顺便把"哪些数字是本场景的、哪些是子场景的"写进了变量名。
  const ownScope: Scope = { scenario: i.scenario, results: leaves, label: '' };
  const childScopes: Scope[] = (report.childRuns ?? []).map((c) => ({
    scenario: c.scenario,
    // 容器步骤同样要剔掉：子场景里的 forEach 结论是控制流的，不是业务结论，
    // 数进"几条断言"就是虚报（与上面 leaves 同一条理由，两个作用域共用一条规则）
    results: c.results.filter((r) => !CONTAINER_KINDS.includes(r.kind)),
    label: `${c.callStepId}→${c.ref}`,
  }));
  const own = scopeConclusions(ownScope);
  // 父那份直接复用上面算好的 own，不重算第二遍
  const judged = [{ sc: ownScope, ...own }, ...childScopes.map((sc) => ({ sc, ...scopeConclusions(sc) }))];
  const totalLeaves = judged.reduce((n, j) => n + j.sc.results.length, 0);
  const conclusive = judged.flatMap((j) => j.conclusive);
  /** 断言叶子里没被算作结论的那几条。要如实点名，不能说一句"全过"就完事 */
  const nonConclusive = judged.flatMap((j) => j.nonConclusive.map((r) => ({ r, from: j.sc.label, isReportOnlyLlm: j.isReportOnlyLlm })));
  const assertionLeaves = judged.flatMap((j) => [...j.conclusive, ...j.nonConclusive]);
  /**
   * **只在门禁拿不到子运行数据时**才保留的宽容。
   *
   * 旧的判据是 `hasCallStep`（"IR 里声明了 call 就别拦"），它有两个洞：
   *  - 子场景全 skipped 时照样放行 => 场景永远绿（"声明了 call"与"验到了东西"是两件事）；
   *  - 子场景只有一条 report-only 的 assertLlm 时照样放行 => 洞 3 从 call 这道门重开。
   *
   * 现在 `report.childRuns` 带着**每个子场景自己的 IR 与 results**，
   * 上面那些都能照实判，所以宽容的条件收到最窄：
   * **声明了 call，且这份报告压根没记子运行**（手写 fixture、别的引擎实现）。
   * `childRuns === undefined` 与 `[]` 必须可区分就是这个原因：
   * `[]` 是"记了，确实没跑 call"，那种没理由宽容；undefined 才是"我不知道"。
   * 保留它而不是彻底删掉，是因为**误拦合法用例比漏拦更糟** ——
   * 但方向要说清：这是对**数据缺失**的让步，不是对 call 这种写法的让步。
   */
  const declaresButUnmeasured = declaresCall(i.scenario) && report.childRuns === undefined;

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
  if (errors.length || orphanErrors.length) {
    const all = [...errors, ...orphanErrors];
    reasons.push(`${all.length} 个步骤**出错**（不是断言失败）：${all.map((r) => `${r.stepId}${r.cause ? `[${r.cause}]` : ''}`).join('、')}。`);
    if (orphanErrors.length) {
      reasons.push(
        `其中 ${orphanErrors.length} 个是控制流步骤自己报的错（${orphanErrors.map((r) => r.stepId).join('、')}）—— 它连子步骤都没跑到，不是某个断言失败。`,
      );
    }
    reasons.push('error 意味着"没测成"，先修环境或用例，此时 fail 的结论也不可信。');
    return { code: EXIT.RUNTIME, reasons, refused: false, suppressedFails: suppressed, attention };
  }
  // 容器的 fail 单独一条、**不受 triage 降级**，与叶子 fail 分开写。
  // triage 降级的对象是"生成的断言第一轮过严"（docs/05 §3 要点 1），
  // 而容器自己报 fail 的含义是"控制流压根没把子步骤跑出来" —— 那不是过严，是没测。
  // 让它跟着 triage 一起降级，等于一个带 triage 标签的场景可以什么都没验还拿 0，
  // 正是这条 fix 要关的那个洞。
  if (orphanFails.length) {
    reasons.push(`${orphanFails.length} 个控制流步骤自己报失败但没有任何断言结论：${orphanFails.map((r) => r.stepId).join('、')}。`);
    reasons.push('这类失败**不因 triage 降级**：triage 降级的是"断言过严"，而这里是"压根没断言到"。');
    return { code: EXIT.TEST_FAILED, reasons, refused: false, suppressedFails: suppressed, attention };
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
  // **"没有一条能当门禁的结论"这条闸放在所有 error/fail/healed 分支之后**，
  // 而且必须放最后 —— 不是我偏好这个顺序，是放前面会**报错因**：
  // http 步骤连不上（error）会连带断言一步没跑，于是"没有任何断言结论"先返回，
  // 人拿到 3 与一句"你没用例"，而真相是"环境没通"（5，可重试）。
  // 被 e2e 的 init 契约测试抓到过一次（那条 fixture 就是 http 打不通 + 一条断言）。
  //
  // 三种"结果里有条目、却一条都没验"的形态（都跑真 runScenario 实测过，
  // 引号里是当时的实际输出）：
  //  - 唯一一条断言被守卫 when 跳过 => 0，理由写着"1 个断言全部通过"；
  //  - 断言全是 assertLlm 且判成 triaged => 同样 0，同样报"全部通过"；
  //  - 断言全是 assertLlm 且模型判"是" => status 是 `pass`，**光看状态一条都拦不住**
  //    （所以判据要同时看 kind 与 gatePolicy，见 isReportOnlyLlm）。
  //
  // 两条判据各治一半，缺一不可：
  //  - 状态用 ir 的 countsTowardPassRate（skipped/triaged 不算）。不另写一份：
  //    "什么算一条真结论"在通过率分母那里已经答过一次，第二份答案必然漂移。
  //  - 范围只数 ASSERTION_KINDS。这是被自己的测试逼出来的：第一版拿 leaves
  //    （非容器步骤）当结论集，于是 set/http/sleep 全被算成"通过了一条结论"，
  //    "一条 set + 一条 report-only assertLlm"照样 0。
  //
  // **子场景的失败/错误为什么不在这里数第二遍**：`childRuns` 带回来的是「子场景跑的那份
  // IR + 那份 results」，而它**只用来回答「这次有没有一条能当门禁的结论」**。
  // 失败与错误仍然只看父侧那一份，这不是遗漏：子场景的 fail/error 会由 call 步骤
  // 自己带上来（interpreter.ts 的 call 分支 `return { status: rep.status }`），
  // 再把子侧数一遍就是「一次子场景失败数出两条」—— 与上面 leaves 过滤存在的同一条理由，
  // 也实测确认过（子里一条断言失败 => 父侧只有 `c1/call=fail` 一条）。
  //
  // 落在 INVALID 而不是新码：它与"空场景"是同一件事（用例结构没给出结论），
  // CI 侧动作也相同（改用例，不是查产品、也不是重试）。
  //
  // **仍盖不住**（记 docs/08）：一条确定性断言 + 一堆 assertLlm 时 conclusive 非空、
  // 退出码照旧。"report-only 占比过高"是治理指标，不是退出码能表达的。
  if (!conclusive.length && !declaresButUnmeasured) {
    const why = assertionLeaves.length
      ? `${assertionLeaves.length} 条断言没有一条给出可门禁的结论（${skippedNote(nonConclusive)}）`
      : `${totalLeaves} 个步骤里没有一条断言`;
    reasons.push(`本次运行没有任何断言结论（${why}）。空场景判"通过"是最危险的假绿：它什么也没测。`);
    if (nonConclusive.some((n) => n.isReportOnlyLlm(n.r))) {
      reasons.push(
        '结论全部来自 report-only 的 assertLlm。它按 docs/02 §4 不进门禁：判"否"不配让 CI 红，判"是"同样不配让 CI 绿。'
        + '两条出路：补至少一条确定性断言，或给要进门禁的那条显式写 gatePolicy:"blocking"。',
      );
    }
    const skipped = nonConclusive.filter((n) => n.r.status === 'skipped');
    if (skipped.length) {
      // **两种 skipped 的下一步动作相反**，所以不能共用一句话：
      //  - 守卫 `when` 不成立 => 去把数据/环境准备好（或承认这条守卫不该在 CI 里）；
      //  - 循环体一次没跑 => 守卫没问题，是**数据是空的 / 条件一开始就为假**，
      //    要查的是"这批数据为什么是空的"，去查守卫会白查一晚上。
      // 判据取引擎放在 keyContext 里的结构化成因，而不是匹配 assertionSummary 的措辞
      // —— 跨包匹配一句话前缀是迟早会悄悄断的耦合。
      const neverRun = skipped.filter((n) => typeof n.r.keyContext?.neverRun === 'string');
      if (neverRun.length) {
        reasons.push(
          `${neverRun.length} 步没跑是因为**循环体一次都没进**（${[...new Set(neverRun.map((n) => n.r.keyContext?.neverRun))].join('；')}）。`
          + '容器自己报 pass 是对的（空数据是合法输入），但"里面那条断言"这次压根没执行：'
          + '先确认取数步骤有没有真拿到数据，再决定这条场景是否应该在空数据下跑。',
        );
      }
      if (neverRun.length < skipped.length) {
        reasons.push('skipped 的常见成因：步骤上的守卫 when 不成立（数据/环境没准备好，于是整段静默跳过）。守卫是给自己看的，不是给门禁看的。');
      }
    }
    return { code: EXIT.INVALID, reasons, refused: false, suppressedFails: suppressed, attention };
  }
  // 计数分两侧说，是因为**这句话里的数字必须能和 JUnit 的 tests 对上**。
  // 子场景的断言不进父报告的 results，也就没进 JUnit 的计数；把它们算进"N 条断言全部通过"，
  // 得到的就是本文件在别处警告过的那个症状："CI 退出码与报告里的用例数对不上"。
  // 所以：本场景自己的数字说自己的，子场景的另起一句、明说不计入。
  const ownCount = own.conclusive.length;
  const childCount = conclusive.length - ownCount;
  const childNote = childCount
    ? `；另有 call 子场景给出 ${childCount} 条结论（**不计入本场景的用例数**，子结果尚未并进父报告，见 docs/08）`
    : '';
  // 本场景自己一条结论都没有、全靠子场景时，"0 条断言全部通过"是句读不通的假话，
  // 而"1 条断言全部通过"又是虚报 —— 所以这种形状换一种说法。
  reasons.push(ownCount
    ? `${ownCount} 条断言全部通过${softTail(nonConclusive.filter((n) => !n.from))}${childNote}`
    : `本场景自身没有断言，${childCount} 条结论全部来自 call 子场景（不计入本场景的用例数，见 docs/08）${softTail(nonConclusive.filter((n) => !n.from))}`);
  return { code: EXIT.OK, reasons, refused: false, suppressedFails: suppressed, attention };
}

/** 场景三段里所有步骤（遍历入口唯一：walk 覆盖嵌套与 switch 分支）。 */
function allSteps(scenario: Scenario): Step[] {
  const out: Step[] = [];
  for (const steps of [scenario.setup, scenario.body, scenario.teardown]) walk(steps, (s) => out.push(s));
  return out;
}

/**
 * 场景的 IR 里有没有 `call` 节点。**只在报告没记子运行时**才用它放行（见调用点）。
 *
 * 为什么不能只凭「IR 里声明了 call」就放行：那与「验到了东西」是两件事 ——
 * 子场景全 skipped、或子场景只有一条 report-only 的 assertLlm 时，
 * 声明照样成立而一条结论都没有，据它放行就是放行一个空场景（判据与实测在 `declaresButUnmeasured`）。
 */
function declaresCall(scenario: Scenario): boolean {
  return allSteps(scenario).some((s) => s.kind === 'call');
}

/**
 * 一次运行里的**一个结论作用域**：一份 IR + 那份 IR 自己跑出来的 results。
 *
 * 为什么要有这个概念：`gatePolicy` 住在 IR 里，而"这个 stepId 是不是 report-only"
 * 必须拿**它自己那份 IR**去问。`call` 的子场景是另一份 IR（运行时由 CallResolver 取回），
 * 把子场景的 stepId 并进父场景那一个 Set 里会串味 —— 父子同 id 时，
 * 父侧那条 blocking 的断言会被子侧同名的 report-only 顶掉，
 * 于是人拿到一句"你的断言没计入结论"，去查一个本来就写对了的 gatePolicy。
 * 分作用域算，这个形状**不可表达**，而不是"尽量避免"。
 */
interface Scope {
  scenario: Scenario;
  /** 该作用域里筛过的叶子结果（容器步骤已经去掉） */
  results: StepResult[];
  /** 报给人看时怎么称呼这个作用域。父侧是空串（"本场景"不用点名） */
  label: string;
}

/** 一个作用域里"能当门禁的结论"与"不能"各有哪些。 */
function scopeConclusions(sc: Scope): {
  conclusive: StepResult[]; nonConclusive: StepResult[];
  isReportOnlyLlm: (r: StepResult) => boolean;
} {
  const reportOnly = reportOnlyLlmIds(sc.scenario);
  const isReportOnlyLlm = (r: StepResult) => r.kind === 'assertLlm' && reportOnly.has(r.stepId);
  const leaves = sc.results.filter((r) => ASSERTION_KINDS.includes(r.kind));
  return {
    conclusive: leaves.filter((r) => countsTowardPassRate(r.status) && !isReportOnlyLlm(r)),
    nonConclusive: leaves.filter((r) => !(countsTowardPassRate(r.status) && !isReportOnlyLlm(r))),
    isReportOnlyLlm,
  };
}

/**
 * report-only 语义断言的步骤 id 集合（从 **IR** 读，不从 StepResult 猜）。
 *
 * 为什么不按 `kind === 'assertLlm'` 一律排除：assertLlm 上有 `gatePolicy`
 * （`ir/src/asserts.ts`，默认 report-only），显式写 `"blocking"` 是**文档化的门禁 opt-in**
 * （要 UI 二次确认），引擎侧也确实让它判"否"时返回 fail（`assertions.ts:184`）。
 * 按 kind 一刀切会把那个 opt-in 悄悄作废 —— 人显式要求"这条进门禁"，
 * 门禁说"你没进"，而现象是"我加了 blocking 还是不拦"，比不加还难查。
 *
 * 也**不往 StepResult 加 gatePolicy 字段**：那是磁盘格式（证据包里的
 * step_results 走 strict schema），而这个判断要的只是"这个 id 在 IR 里是不是
 * report-only"，而 IR 就在调用方手里（见 Scope）。
 */
function reportOnlyLlmIds(scenario: Scenario): Set<string> {
  const ids = new Set<string>();
  for (const s of allSteps(scenario)) {
    const p = s as unknown as { gatePolicy?: string };
    if (s.kind === 'assertLlm' && p.gatePolicy !== 'blocking') ids.add(s.id);
  }
  return ids;
}

/**
 * 未计入结论的断言的分布描述，例：'2 个 skipped、1 个 triaged'。无则空串。
 *
 * 参数是**已经筛过的**"不算结论"的那批，每条自带"它属于哪个 IR 作用域"。
 * 作用域标签只在**非空**（也就是来自 call 子场景）时才拼上：
 * 父侧的步骤人就在看本场景，点名是噪音；而子场景那条不点名，
 * 人会拿父场景的 IR 去找一个在别的文件里的 stepId，找不到就以为报告坏了。
 */
function skippedNote(rest: { r: StepResult; from: string; isReportOnlyLlm: (r: StepResult) => boolean }[]): string {
  if (!rest.length) return '';
  const by = new Map<string, number>();
  for (const n of rest) {
    // report-only 的 assertLlm 按原因分桶而不是按 status：它的 pass 与 triaged
    // 是同一个原因，分成两桶会让人以为其中一半"跑过了所以没问题"。
    //
    // **循环体没跑的 skipped 同理**：它和"守卫不成立"是两种下一步动作相反的成因
    // （一个去查数据取回没取回，一个去查守卫），混成一句"另有 N 个 skipped"就等于
    // 说了等于没说 —— 而那半边场景（体外有真断言）退出码是 0，这行是唯一的提示。
    // 判据取引擎放在 keyContext 里的结构化成因，不匹配 assertionSummary 的措辞。
    const neverRun = typeof n.r.keyContext?.neverRun === 'string';
    const key = (n.isReportOnlyLlm(n.r) ? 'assertLlm（report-only）'
      : neverRun ? `${n.r.status}（循环体一次都没进）`
        : n.r.status) + (n.from ? `（在 ${n.from}）` : '');
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([k, cnt]) => `${cnt} 个 ${k}`).join('、');
}

/** 绿灯结论后面的尾巴：把**没计入结论**的叶子如实报出来。没有则空串，不制造噪音。 */
function softTail(nonConclusive: { r: StepResult; from: string; isReportOnlyLlm: (r: StepResult) => boolean }[]): string {
  const note = skippedNote(nonConclusive);
  return note ? `，另有 ${note} 未计入结论（不算通过，也不算失败）` : '';
}
