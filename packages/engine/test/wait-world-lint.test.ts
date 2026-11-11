/**
 * `WAIT_WORLD_UNDECLARED`：界面等待没写 `world`，而这一场两档都会在场。
 *
 * ## 这条规则补的是哪个洞
 *
 * `ir/test/wait-worlds.test.ts` 里量出来的一件事：装配判据（`waitWorldDemand`）
 * 对"没写 `world`"故意**什么都不报** —— 因为任一档都能服务它，没有哪一档是硬需求。
 * 那个决定是对的（把两档都算成需求会把一份**今天跑得好好的**纯安卓场景挡在装配期，
 * 实测 `.scratch/probe-undeclared-world-assembly.mts`），但它留下一个洞：
 * **作者没说清问哪一世界**这件事从此没人说。本文件就是那个载体。
 *
 * 没有它，本轮就成了"为了修一个误报，顺手删掉一条真提示" —— 而运行期那条
 * `AmbiguousWaitWorld` 是**报错**，不是提示；本平台的主要用例产出者是 LLM，
 * lint 是它唯一能在提交前拿到反馈的那道闸。
 *
 * ## 三个"这条规则会不会白报"的方向各有一组
 *
 *  1. **前置条件**：只有两档都会在场时才报。纯 Web / 纯移动场景里没写 `world`
 *     运行期走的是"只有一档在场就用它"，**行为与改动前逐字相同**，报它是误报；
 *  2. **级别**：warning 而不是 error。今天 `wiring.ts` 压根不装配 `adapters.device`
 *     （ADB 那半边没开工），所以真实运行里永远走不到歧义那支 ——
 *     一个 error 会说"这条跑不起来"，那句今天是**假话**；
 *  3. **不许恒真/恒假**：写了 `world` 的不报、非界面条件不报、容器里的要报。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintScenario, toReport, type LintCode } from '../src/index.js';
import { b, scen, tapStep, getStep, loc, type StepDraft } from './helpers.js';

const dev = (target: 'android' | 'ios' | 'harmony' = 'android'): StepDraft =>
  ({ ...b('d'), kind: 'device', target, require: { requires: [] } }) as StepDraft;
const nav = (id = 'n'): StepDraft => ({ ...b(id), kind: 'navigate', url: 'https://x/' }) as StepDraft;
const uiWait = (id: string, condition: Record<string, unknown>): StepDraft =>
  ({ ...b(id), kind: 'wait', condition, timeoutMs: 500 }) as StepDraft;
const uiPredicate = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ type: 'uiPredicate', target: loc(), ...over });

/** web 档那四个 kind 各自的最小合法写法（`.strict()` 会拒共用一个对象，所以逐个写） */
const actStep = (id: string): StepDraft =>
  ({ ...b(id), kind: 'act', locator: loc(), action: 'click' }) as StepDraft;
const assertPageStep = (id: string): StepDraft =>
  ({ ...b(id), kind: 'assertPage', assertKind: 'text', contains: '你好' }) as StepDraft;
const captureStep = (id: string): StepDraft =>
  ({ ...b(id), kind: 'capture', mode: 'screenshot' }) as StepDraft;
const WEB_KIND_STEP: Partial<Record<string, StepDraft>> = {
  navigate: nav('w2'), act: actStep('w2'), assertPage: assertPageStep('w2'), capture: captureStep('w2'),
};

const issuesOf = (body: StepDraft[], extra: object = {}) =>
  lintScenario(scen(body as never[], extra as never)).filter((i) => i.code === 'WAIT_WORLD_UNDECLARED');
const codesOf = (body: StepDraft[], extra: object = {}): LintCode[] =>
  lintScenario(scen(body as never[], extra as never)).map((i) => i.code);

/** 混合场景的公共部分：一条 web 需求 + 一条设备需求，让两个槽位都会在场 */
const mixed = (wait: StepDraft): StepDraft[] => [dev(), tapStep('t'), nav(), wait];

describe('WAIT_WORLD_UNDECLARED：只在两档都会在场时报', () => {
  test('混合场景 + 没写 world 的界面等待 => 报，且指到那一步', () => {
    const list = issuesOf(mixed(uiWait('w', uiPredicate())));
    assert.equal(list.length, 1, `该报一条。实际 ${JSON.stringify(list.map((i) => i.code))}`);
    assert.equal(list[0]!.stepId, 'w', '报错要点名是哪一条等待，而不是整场一句');
    // 措辞要说**为什么会歧义**，只说"没写 world"人不知道该写哪个
    assert.match(list[0]!.message, /world/);
    assert.match(list[0]!.message, /Web|浏览器/);
    assert.match(list[0]!.fix ?? '', /world:"web"|world:"mobile"/);
  });

  for (const [name, cond] of [
    ['uiPredicate', uiPredicate()],
    ['template', { type: 'template', target: loc() }],
    ['uiIdle', { type: 'uiIdle' }],
  ] as const) {
    test(`${name} 也在这一查的范围内（三种界面条件共用一份判据）`, () => {
      assert.equal(issuesOf(mixed(uiWait('w', cond))).length, 1, `${name} 漏了`);
    });
  }

  test('写了 world 就不报，两个值都不报', () => {
    for (const world of ['web', 'mobile']) {
      const list = issuesOf(mixed(uiWait('w', uiPredicate({ world }))));
      assert.equal(list.length, 0, `写了 world:"${world}" 而仍报 => 这一查会变成噪音：${JSON.stringify(list)}`);
    }
  });

  test('纯 Web 场景不报（运行期只有一档在场，走"用它"那一支，与改动前逐字相同）', () => {
    /*
     * 这一格是**误报方向**的主钉子，而它是这条规则存在的前提：
     * 装配侧那条被实测否掉的第一版就是死在这同一个形状上（那时 needsWeb
     * 被撑成 true，纯安卓场景在装配期就要 Chrome）。
     * 误报的代价本仓量过一次：一道常被误报的闸会被人关掉。
     */
    assert.equal(issuesOf([nav(), uiWait('w', uiPredicate())]).length, 0);
  });

  test('纯移动场景不报（同一个形状的另一半：不该因此去装浏览器）', () => {
    assert.equal(issuesOf([dev('ios'), tapStep('t'), uiWait('w', uiPredicate())]).length, 0);
  });

  test('纯 API 场景不报（三种形态全不报，这条查的不是"有没有 wait"）', () => {
    const list = issuesOf([getStep('h'), uiWait('w', uiPredicate())]);
    assert.equal(list.length, 0, `纯 API 场景被烦了：${JSON.stringify(list.map((i) => i.message))}`);
  });
});

describe('级别与判据形状', () => {
  test('是 warning 而不是 error（今天它跑不出来，报 error 就是假话）', () => {
    /*
     * 判据依据：`wiring.ts` 不装配 `adapters.device`（docs/14 §5 那条"ADB 那半边没开工"），
     * 所以真实运行里最多一个槽位在场，运行期永远走"只有一档在场就用它"，
     * 压根不会抛 AmbiguousWaitWorld。一个 error 级 finding 等于说"这条跑不起来"，
     * 而那句今天是假的 —— 本仓为同一族错话删过 `NOT_EVALUATED` 那句
     * "运行期会抛"（一句过期的安慰话比不安慰更坏，一句过期的恐吓也一样）。
     */
    const [i] = issuesOf(mixed(uiWait('w', uiPredicate())));
    assert.ok(i);
    assert.equal(i!.level, 'warning', '升成 error 要连着 docs/15 §3.6 那句"它今天靠测试活着"一起改');
  });

  test('warning 不拦人：同一份场景 toReport 仍然 ok（并带一条反向对照）', () => {
    /*
     * 上面那条断的是**级别**，这一条断的是**后果**，两者不是重复：
     * `toReport` 判的是 `level === 'error'`，而这个判断哪天改了（比如
     * 加一条"warning 满 N 条也算不通过"），级别那条照绿而 CI 会被这条新规则拦住。
     * 拦住一份**今天跑得好好的**用例，正是本轮否掉第一版时用的同一条理由。
     *
     * 三件事必须同时成立，缺任何一件这条测试都会放水：
     *  1. 带一条真断言的夹具 => `ok === true`（我们的 warning 不拦人）；
     *  2. **同一个 warning 仍在报告的 warnings 里** —— 只断 ok 的话，
     *     "把这条码从 issues 里过滤掉"这种改法会同时满足两条断言，那句提示就静默了；
     *  3. **反向对照**：一份不拦人的 warning 之外还有 error 时 `ok === false`。
     *     少了这一句，`toReport` 退化成"永远 ok"也能让上面两条全绿，
     *     而那是本仓那一族的形状：**只断"不该拦"而不断"该拦时真拦"，
     *     判据就退化成恒真**。
     *
     * ⚠ 为什么第 1 格的夹具**必须自己带一条断言**（本条第一版就是漏了它，
     * 当场红在 `ok === false`，而那句红与新规则毫无关系）：
     * `toReport` 吃的是**整份** issues，`ASSERT_FREE_SCENARIO` 是 error 级，
     * 所以一份零断言的夹具会带着一条与等待无关的 error 进来。
     * 那个形状拿来断 `ok === false` 是对的（就是下面第 3 格用的那份），
     * 拿来断 `ok === true` 则永远不可能对 —— 读数差别只在"夹具里有没有
     * 一条 assertPage"，看的人会以为是新规则把场景判死了。
     */
    const warnOnly = scen([...mixed(uiWait('w', uiPredicate())), assertPageStep('a1')] as never[]);
    const rep = toReport(lintScenario(warnOnly));
    assert.equal(rep.ok, true, `一句 warning 不该让静态闸判不通过。实际 errors=${JSON.stringify(rep.errors.map((i) => i.code))}`);
    assert.equal(rep.errors.length, 0);
    assert.ok(rep.warnings.some((i) => i.code === 'WAIT_WORLD_UNDECLARED'),
      '不拦人 ≠ 不出现：这一句必须还在报告里（否则"warning"变成了"删掉"）');

    // 反向对照：同一份场景去掉那条断言 => 唯一的差别是多了一条 error 级的
    // ASSERT_FREE_SCENARIO，于是 ok 翻成 false 而**同一个 warning 照旧在场**。
    // 这一半在 `engine/test/lint.test.ts` 里另有一条总的（「toReport 只在有 error 时
    // 判不通过」那条断的是"有 error 的脏场景 ok===false"），所以它不是全仓唯一的
    // 反向钉子；留在这里的理由是**配对**：那份夹具与等待无关，读的人拿不到
    // "同一份场景、同一个 warning，只因为旁边多了一条 error 就整体不通过"这个对照，
    // 而那正是这一格要说清的事 —— warning 不拦人 ≠ 场景不拦人。
    const withError = scen(mixed(uiWait('w', uiPredicate())) as never[]);
    const rep2 = toReport(lintScenario(withError));
    assert.equal(rep2.ok, false, 'error 级 finding 必须让静态闸判不通过（否则上面那句 ok===true 是恒真好听）');
    assert.ok(rep2.errors.some((i) => i.code === 'ASSERT_FREE_SCENARIO'),
      `拦人的必须是那条 error，而不是新规则：${JSON.stringify(rep2.errors.map((i) => i.code))}`);
    assert.ok(rep2.errors.every((i) => i.code !== 'WAIT_WORLD_UNDECLARED'),
      '新规则不许出现在 errors 里（它是 warning；升成 error 要连着 docs/15 §3.6 一起改）');
    assert.ok(rep2.warnings.some((i) => i.code === 'WAIT_WORLD_UNDECLARED'),
      '场景被别的规则拦住时，这一句也不许从报告里消失');
  });

  test('非界面条件不算（expr / httpStatus / dbRow / response / newPage 全不报）', () => {
    /*
     * `response` 与 `newPage` 特别值得点名：它们**确实**只有浏览器能观测，
     * 而它们**没有** `world` 可写（schema `.strict()` 拒），所以"没写 world"
     * 对它们不是缺陷。把它们算进来会让一份完全正确的场景收到一句
     * "请写一个你写不了的字段"。
     */
    for (const cond of [
      { type: 'expr', expr: '1 == 1' },
      { type: 'httpStatus', ref: '$.h', in: [200] },
      { type: 'dbRow', sql: 'SELECT 1' },
      { type: 'response', urlPattern: '/api/x' },
      { type: 'newPage' },
    ]) {
      const list = issuesOf(mixed(uiWait('w', cond)));
      assert.equal(list.length, 0, `${cond.type} 不该被这一查报：${JSON.stringify(list.map((i) => i.message))}`);
    }
  });

  test('容器里的界面等待也报（walk 走得进去，与 needsDevice 同一套遍历）', () => {
    for (const [name, wrap] of [
      ['sequence', (w: StepDraft): StepDraft => ({ ...b('s'), kind: 'sequence', steps: [w] }) as StepDraft],
      ['parallel', (w: StepDraft): StepDraft => ({ ...b('p'), kind: 'parallel', steps: [w] }) as StepDraft],
      ['if', (w: StepDraft): StepDraft => ({ ...b('i'), kind: 'if', condition: '1 == 1', then: [w], else: [] }) as StepDraft],
      ['switch', (w: StepDraft): StepDraft => ({ ...b('sw'), kind: 'switch', value: '1 == 1', cases: [{ is: 'a', steps: [w] }], default: [] }) as StepDraft],
    ] as const) {
      const body = [dev(), tapStep('t'), nav(), wrap(uiWait('w', uiPredicate()))];
      assert.equal(issuesOf(body).length, 1, `${name} 里的那条等待漏了`);
    }
  });

  test('嵌套谓词树里的界面条件也算（allOf / anyOf / noneOf）', () => {
    for (const key of ['allOf', 'anyOf', 'noneOf']) {
      const list = issuesOf(mixed(uiWait('w', { [key]: [{ type: 'expr', expr: '1 == 1' }, uiPredicate()] })));
      assert.equal(list.length, 1, `${key} 里的那一支漏了`);
    }
  });

  test('一条等待里三个没写的条件只报一句（按步骤去重，不按条件）', () => {
    /*
     * 与 `EXPR_SYNTAX` 那条"同一条表达式在 dry-run 里出现两次"同一个症状：
     * 编辑器面板把它渲染成三行一样的红字，而修的地方是同一处。
     *
     * ⚠ 这一格钉的是**步内**去重，而它很容易被"顺手删掉 walk 里那层循环"之外的
     * 改动破坏 —— 所以它下面那一格（两条等待各报一句）才是它的反向钉子：
     * 若有人改成"整场只报一句"，上一格仍然绿，只有下一格会红。
     */
    const list = issuesOf(mixed(uiWait('w', { allOf: [uiPredicate(), { type: 'uiIdle' }, { type: 'template', target: loc() }] })));
    assert.equal(list.length, 1, `该按步骤收成一句，实际 ${list.length} 句`);
  });

  test('两条等待各报一句（不同步骤是不同问题）', () => {
    const body = [...mixed(uiWait('w1', uiPredicate())), uiWait('w2', { type: 'uiIdle' })];
    assert.deepEqual(issuesOf(body).map((i) => i.stepId), ['w1', 'w2']);
  });
});

describe('这条码本身被登记着（新增码不登记会编译不过，这里补运行时那一半）', () => {
  test('LINT_DOCS 里有它，且 doc 字段真的指到文档', () => {
    const [i] = issuesOf(mixed(uiWait('w', uiPredicate())));
    assert.ok(i);
    assert.ok(i!.doc && /docs\/\d/.test(i!.doc), `报错要带出处。实际 ${String(i!.doc)}`);
  });

  for (const kind of ['navigate', 'act', 'assertPage', 'capture'] as const) {
    test(`${kind}（web 档）单独就能成立那一半前置`, () => {
      /*
       * 逐个 web 档 kind 点名列出，而不是从 STEP_TARGET 里过滤出来遍历：
       * 过滤式写法看着像"覆盖了整张表"，而它其实只测了"表里标成 web 的 kind
       * 让 deriveTargets 里有 web" —— 那一格在 `ir/test/target-sources.test.ts`
       * 已经钉过，这里是**同一件事的第三次抄写**，而抄来的判据正是本仓记账最多的那族。
       * 手工列出的代价是新增 web 档 kind 不会自动被覆盖，换来的是这一格
       * 只依赖 lint 的公开行为：配一个 device + 一条没写 world 的界面等待，
       * 报与不报由这一格说了算。
       */
      const step = WEB_KIND_STEP[kind]!;
      const body = [dev(), tapStep('t'), step, uiWait('w', uiPredicate())];
      assert.equal(issuesOf(body).length, 1, `${kind} 属于 web 档，却没让这一查的前置成立 => 前置判据与端集合判据分叉了`);
    });
  }

  test('不是"只要有个 wait 就报"：没有移动端那一半时同样不报', () => {
    // 与「纯 Web 场景不报」同一方向，只是把 web 那一半换成 act 而不是 navigate，
    // 保证不报的原因是**缺设备那一半**，不是 navigate 这个 kind 碰巧被特殊处理。
    const body = [actStep('a'), uiWait('w', uiPredicate())];
    assert.equal(issuesOf(body).length, 0);
  });

  test('反方向：没有任何 web 档步骤时，即使有移动端步骤也不报', () => {
    // 上一格测了"每个 web kind 都能触发"，这一格保证不是"恒触发"
    const body = [dev('harmony'), tapStep('t'), uiWait('w', uiPredicate())];
    assert.ok(!codesOf(body).includes('WAIT_WORLD_UNDECLARED'),
      '纯移动场景被报了 => 前置判据里那个 web 条件是恒真的');
  });
});
