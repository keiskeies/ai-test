/**
 * **IR 说"这里可以写引用/表达式/生成器"，执行侧就必须真的求值它。**
 *
 * ## 这一族测试存在的理由：改动前它是**假绿**，不是"功能没做"
 *
 * `act.value` / `input.value` / `assertPage.contains` / `assertPage.expected`
 * 在 IR 里都是 `ValueSchema` —— 四种形态（字面量 / `{path}` / `{expr}` / `{gen}`）
 * 都合法。而改动前这几处**一个都没求值**，直接把 IR 里那个对象原样交给 adapter：
 *
 * ```
 * act{action:'fill', value:{expr:'1 + 1'}}
 *   => 该步 pass；adapter 收到的 op.value 是 {"expr":"1 + 1"} 这个对象本身
 *   => adapter-web 那句 String(o.value ?? '') 把它变成往输入框里打进 "[object Object]"
 * ```
 *
 * 也就是说**表单填错了、用例全绿、退出码 0**。这是本仓记过十几轮的缺陷类 (a)
 * （schema 有字段、执行侧没人读）里**后果最直接的一例**：不是"少个能力"，
 * 是"给你一个看起来成功的错误结果"。
 *
 * ## 每条都配一个反方向
 *
 * 只测"`{expr}` 现在生效了"会被两种实现骗过：恒把值丢掉的（`() => undefined`）、
 * 以及把所有字段都丢进求值器的（那会把 `url: 'a?x=1'` 这种字面量判成坏表达式 ——
 * 反方向的错，比原来更坏）。所以**字面量必须逐字节不变**、**不是 ValueSchema 的
 * 字段不许被碰**，两组都各有条目。判据一律落在"adapter 真收到了什么"上，
 * 不落在摘要文本上（摘要说对了而 adapter 收到对象，是这个缺陷本来的样子）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { StepSchema, ValueSchema, defineScenario, type ScenarioDraft } from '@atest/ir';
import { b, run, scen, type StepDraft } from './helpers.js';
import { lintScenario, type AdapterRegistry } from '../src/index.js';

const loc = { intent: '输入框', primary: { by: 'testid', value: 'q' } } as never;

/**
 * 每条测试都带这个输入声明：`$who` / `{path:'$who'}` 要引用一个**真实存在**的变量。
 * 用"有默认值的输入"而不是先跑一步 set，是为了让每一条测试**只有一处被测**：
 * 求值坏了就是坏了，不会与 set 那一步的结论混在一起。
 */
const WHO = [{ name: 'who', type: 'string', required: false, default: '张三' }] as never;

/**
 * 一步说过的话。
 *
 * **`StepResult` 上只有 `assertionSummary` 一个摘要字段**（`ir/src/trace.ts` 的
 * `StepResultSchema` 是 `.strict()`，没有 `summary`）。`summary` 这个名字存在于
 * 别处：trace 事件 `step.finished` 的 `data.summary`、`interpreter.ts` 里那个
 * 中间产物 `{status, summary?, cause?}`、`RunReport.summary` —— 名字一样、类型不同。
 *
 * 这个坑本轮踩了**两次**，而且两次坏法不同，都值得留着：
 *  1. 第一版写 `assert.doesNotMatch(step.summary ?? '', /语法/)` —— 而 `?? ''`
 *     把"这个字段压根不存在"读成"这一步什么都没说"，于是那条**恒成立**，
 *     看着在钉归因顺序、其实什么都没钉（`npm test` 全绿）。
 *  2. 修它的时候把 `step.summary` 当字符串拼进报错消息 —— 这一次是
 *     `npm run typecheck:test` 报的（9 处 TS2339）。也就是说**第 1 类写法只在
 *     带 `?? ''` 时才静默**，而 `?? ''` 恰好是" defensive 写法"的手感，
 *     很容易顺手写。所以这里包一个函数，让"读哪个字段"只有一处可写错。
 */
const said = (r: { assertionSummary?: string }): string => r.assertionSummary ?? '';

interface Spy { ops: Record<string, unknown>[]; asserts: Record<string, unknown>[] }

/**
 * 记下游标的 ui adapter。
 *
 * `resolve` 必须返回**真的 handle 形状**：定位失败的分支会在 perform 之前返回，
 * 于是 perform 一次都调不到、`spy.ops` 是空数组，而"断言 ops[0].value === …"
 * 会因为 undefined !== 期望值而红 —— 红得很有迷惑性，看起来像求值没生效。
 * （同类坑记在 `ui-assert-world.test.ts`："规则压根没命中，perform 没被调用，
 * 于是断它的端等于断空气"。）所以每条测试都先断"这一步真的到了 adapter"。
 */
function spyUi(): { ui: AdapterRegistry['ui']; spy: Spy } {
  const spy: Spy = { ops: [], asserts: [] };
  const ui = {
    async perform(o: unknown) { spy.ops.push(o as Record<string, unknown>); },
    async snapshot() { return { kind: 'aria', data: '订单 已完成 金额 100' }; },
    async resolve() { return { handle: 'h', resolvedBy: 'testid', rung: 0, confidence: 1, nonReplayable: false, costUsd: 0 }; },
    async assertUi(p: unknown) { spy.asserts.push(p as Record<string, unknown>); return { passed: true, actual: '', expected: '' }; },
  } as unknown as AdapterRegistry['ui'];
  return { ui, spy };
}

/** 一步 act + 一步断言，跑完把 adapter 收到的东西与这一步的结论一起交出来 */
async function actOnce(value: unknown, extra: Record<string, unknown> = {}) {
  const { ui, spy } = spyUi();
  const steps = [{ ...b('a'), kind: 'act', locator: loc, action: 'fill', value, ...extra } as unknown as StepDraft];
  const r = await run(scen(steps, { inputs: WHO }), { adapters: { ui } });
  return { step: r.results.find((x) => x.stepId === 'a')!, op: spy.ops[0], calls: spy.ops.length };
}

describe('act.value：四种形态都必须求值后才交给 adapter', () => {
  test('先到 adapter 再谈值：这一步必须真的把 perform 打到 adapter 上', async () => {
    const { calls } = await actOnce('abc');
    assert.equal(calls, 1, 'perform 一次都没被调到 —— 下面那组断言会全部断在 undefined 上，看着像"求值坏了"');
  });

  test('字面量照旧原样（这条是反方向的钉子：求值不许改写合法值）', async () => {
    const { step, op } = await actOnce('abc');
    assert.equal(step.status, 'pass');
    assert.equal(op?.value, 'abc', `字面量被改了：${JSON.stringify(op?.value)}`);
  });

  test('含 `$` / 空串 / 数字这类"看着像形态其实不是"的字面量，逐字节不变', async () => {
    /*
     * `价格 3$`、`$100 起`、`{"k":1}` 都是合法输入值（往输入框里填的东西本来就可能含 `$`）。
     * 它们既不许被当表达式**校验**（`expr-strict.test.ts` 里那条钉 lint 那一侧），
     * 也不许在**递给别人之前**被吃掉或转义 —— 两侧都过一遍求值器才算同一个语义。
     */
    for (const lit of ['价格 3$', '$100 起', 'a,b', '', '0', '{"k":1}']) {
      const { step, op } = await actOnce(lit);
      assert.equal(step.status, 'pass', `${lit} 被拦了：${said(step)}`);
      assert.equal(op?.value, lit, `${JSON.stringify(lit)} 被改成 ${JSON.stringify(op?.value)}`);
    }
  });

  test('{expr} 求值成真实值（改前 adapter 收到的是那个对象本身，于是输入框里被填进 [object Object]）', async () => {
    const { step, op } = await actOnce({ expr: '$who + "!"' }, {});
    assert.equal(step.status, 'pass', `这一步不该红：${said(step)}`);
    assert.equal(op?.value, '张三!', `adapter 收到的是 ${JSON.stringify(op?.value)}`);
  });

  test('{path} 求值成被引用的值', async () => {
    const { step, op } = await actOnce({ path: '$who' });
    assert.equal(step.status, 'pass', said(step));
    assert.equal(op?.value, '张三');
  });

  test('{gen} 求值成生成出来的值（改前 adapter 收到 {gen:"uuid"}，填进输入框的是那六个字母）', async () => {
    const { step, op } = await actOnce({ gen: 'uuid' });
    assert.equal(step.status, 'pass', said(step));
    assert.match(String(op?.value), /^[0-9a-f-]{36}$/, `uuid 生成器没生效：${JSON.stringify(op?.value)}`);
  });

  test('没有 value 的动作（click）不凭空多出一个 value 键', async () => {
    const { ui, spy } = spyUi();
    await run(scen([{ ...b('a'), kind: 'act', locator: loc, action: 'click' } as unknown as StepDraft], { inputs: WHO }), { adapters: { ui } });
    assert.equal('value' in (spy.ops[0] ?? {}), true);
    assert.equal(spy.ops[0]!.value, undefined, 'click 也去求值的话会把 undefined 变成一次真实的求值调用');
  });

  test('表达式写坏了 => error + case-stale，**不再 pass**', async () => {
    /*
     * 这是本轮那处假绿最直接的对照：**改前这一步是 pass**。
     * 归因取 case-stale（用例写坏了）而不是 product-bug / env-unavailable ——
     * 与 `when` / 断言表达式那一族同一个判据（`errors.ts` 的 causeOfError），
     * 不在这里另定一份。
     */
    const { step, calls } = await actOnce({ expr: '1 +' });
    assert.equal(step.status, 'error', `坏表达式必须响：${step.status} / ${said(step)}`);
    assert.equal(step.cause, 'case-stale', `归因指向错的地方：${step.cause}`);
    assert.equal(calls, 0, '这一步已经坏了，**一次都不该动页面**（动了就是往产品里写脏数据）');
  });

  test('引用未定义同样 error 而不是把 undefined 递下去', async () => {
    const { step } = await actOnce({ path: '$.没这个变量' });
    assert.equal(step.status, 'error', said(step));
  });
});

describe('input.value：ADB 那一侧同一条规则（同一个字段名，不许两端不同语义）', () => {
  test('{expr} 求值后才给 adapter', async () => {
    const seen: Record<string, unknown>[] = [];
    const device = {
      async lease() { return { id: 'L', deviceRef: 'e1', expiresAt: new Date(Date.now() + 6e5).toISOString() }; },
      async renew() { return { expiresAt: new Date(Date.now() + 6e5).toISOString() }; },
      async release() {},
      async snapshot() { return { kind: 'hierarchy', data: '<h/>', sha: 'x' }; },
      async perform(o: unknown) { seen.push(o as Record<string, unknown>); return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
      async app() { return null; },
      async resolve() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
      async assertUi() { return { passed: true, actual: '', expected: '' }; },
    } as unknown as AdapterRegistry['device'];
    const r = await run(scen([
      { ...b('d'), kind: 'device', target: 'android' } as StepDraft,
      { ...b('i'), kind: 'input', value: { expr: '$who' } } as StepDraft,
    ], { inputs: WHO }), { adapters: { device } });
    assert.equal(r.results.find((x) => x.stepId === 'i')?.status, 'pass',
      `这一步要真跑到 adapter：${JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.assertionSummary]))}`);
    assert.equal(seen.length, 1, 'perform 没被调到，下面的断言等于断空气');
    assert.equal(seen[0]!.value, '张三', `移动端按键入值没求值：${JSON.stringify(seen[0]!.value)}`);
  });
});

describe('assertPage / assertUi 的 contains 与 expected：同一个根，修在同一个机制上', () => {
  async function assertOnce(payload: Record<string, unknown>) {
    const { ui, spy } = spyUi();
    const r = await run(scen([{ ...b('p'), kind: 'assertPage', assertKind: 'text', ...payload } as unknown as StepDraft], { inputs: WHO }), { adapters: { ui } });
    return { step: r.results.find((x) => x.stepId === 'p')!, got: spy.asserts[0], calls: spy.asserts.length };
  }

  test('先到 adapter：这条测试不许断在"根本没调 adapter"上', async () => {
    const { calls } = await assertOnce({ contains: 'x' });
    assert.equal(calls, 1, 'assertUi 一次都没被调到');
  });

  test('contains 的 {expr} 求值后才交给 adapter（改前是那个对象本身，断言照样 pass）', async () => {
    const { step, got } = await assertOnce({ contains: { expr: '$who' } });
    assert.equal(step.status, 'pass', said(step));
    assert.equal(got?.contains, '张三', `adapter 收到 ${JSON.stringify(got?.contains)}`);
  });

  test('expected 也一样', async () => {
    const { got } = await assertOnce({ expected: { gen: 'uuid' } });
    assert.match(String(got?.expected), /^[0-9a-f-]{36}$/);
  });

  test('字面量 contains 逐字节不变', async () => {
    const { got } = await assertOnce({ contains: '订单 已完成' });
    assert.equal(got?.contains, '订单 已完成');
  });

  test('不是 ValueSchema 的字段**不许**被求值（ariaYaml 是 z.string()）', async () => {
    /*
     * 反方向的钉子。`ariaYaml` / `target` 在 schema 里是 `z.string()`，
     * 顺手"整个 payload 过一遍求值"会把这些合法字符串喂进表达式编译器，
     * 于是 `ariaYaml: "- button: 提交"` 变成"表达式语法错误" ——
     * 那是把一处静默换成一处误报，而误报的代价是大家把闸关掉。
     */
    const { step, got } = await assertOnce({ ariaYaml: '- button: 提交 $x' });
    assert.equal(step.status, 'pass', `合法 ariaYaml 被拦了：${said(step)}`);
    assert.equal(got?.ariaYaml, '- button: 提交 $x');
  });

  test('缺 adapter 时报的还是"缺 adapter"，**不是**"表达式写坏了"', async () => {
    /*
     * 值求值排在 adapter 可用性那道闸**之后**，位置是选出来的：
     * 放前面的话 `contains:{expr:'坏表达式'}` + 没配 adapter 时先抛 ExprError，
     * 于是这一步的归因说"用例写坏了"，而该说的是"平台没配 adapter"。
     * 两道闸的先后决定报错里哪句是真话。
     */
    const r = await run(scen([{ ...b('p'), kind: 'assertPage', assertKind: 'text', contains: { expr: '1 +' } } as unknown as StepDraft], { inputs: WHO }), { adapters: {} });
    const step = r.results.find((x) => x.stepId === 'p')!;
    assert.equal(step.status, 'error');
    assert.match(said(step), /adapter/, `报错该点名缺 adapter：「${said(step)}」`);
    assert.doesNotMatch(said(step), /语法|表达式/, `不该抢着报表达式语法：「${said(step)}」`);
  });

  test('成对反向：**配了** adapter 时，同一份场景报的才是那句语法错', async () => {
    /*
     * 上面那条是 doesNotMatch —— 万一哪天两栏 summary 都成了空串，
     * `doesNotMatch('')` 会恒成立，那条"归因顺序"的钉子就静默失效了
     * （本轮已经在这两个字段上栽过一次）。这条正向断言保证
     * "语法"那句**在这一步该出现的时候确实会出现**，于是上面那条的
     * 不匹配是真不匹配，不是没内容可匹配。
     */
    const { ui } = spyUi();
    const r = await run(scen([{ ...b('p'), kind: 'assertPage', assertKind: 'text', contains: { expr: '1 +' } } as unknown as StepDraft], { inputs: WHO }), { adapters: { ui } });
    const step = r.results.find((x) => x.stepId === 'p')!;
    assert.equal(step.status, 'error');
    assert.equal(step.cause, 'case-stale', `有 adapter 时这就是用例的问题，不是环境问题：${step.cause}`);
    assert.match(said(step), /语法|ExprError/, `该报语法错却没报：「${said(step)}」`);
  });
});

describe('值形态求值接线的完整性（防止"只修了被测到的那两处"）', () => {
  test('IR 里每一个 ValueSchema 位置都被**显式判过**：要么求值、要么写明不求值', () => {
    /*
     * 这一条不是形式检查。本轮查出这个缺陷的经过就是"抽了两个字段看"，
     * 而同一族位置远不止那两个 —— 只修两个的话，症状变成"`act.value` 里的 `{expr}`
     * 生效、`call.args` 里的不生效"，那比"全都静默"更难查（一半能用）。
     *
     * 判据来自 schema 本体（`ValueSchema` 出现在哪些步骤字段上），
     * 与下面那两张手写的清单对撞。**清单是测试的覆盖范围**，不是运行时判据，
     * 所以它可以手写；但它必须"每个位置都落进某一张"，否则红。
     *
     * ⚠ **遍历必须递归**（本轮改的就是这一点）：第一版只走步骤 shape 的**一层**字段，
     * 于是 `switch.cases[].is` 与 `http.request.formData` 这六个
     * 藏在嵌套对象/数组/record 里的位置**压根不在扫描结果里** ——
     * 而那条"没被覆盖就红"的断言对它们是**空的**。
     * 一条自称"防漏"的守卫自己漏了六个，其中一个（`formData`）本轮量出来
     * **引擎一个字段都不读、发请求时整栏丢掉、步骤判 pass**
     * （明细 docs/14 §5 那一行）。守卫漏报比没有守卫更坏：它让人以为数过了。
     */
    type Shape = Record<string, unknown>;
    const unwrap = (s: unknown): unknown => {
      const inner = (s as { def?: { innerType?: unknown } } | null)?.def?.innerType;
      return inner ? unwrap(inner) : s;
    };
    /** 这一支（往任意深度走）能不能装一个 ValueSchema */
    const holdsValue = (s: unknown, depth = 0): boolean => {
      if (depth > 8) return false; // 递归 schema（子步骤列表）的兜底，见下面 findValues 同一条
      const u = unwrap(s) as { def?: { type?: string; valueType?: unknown; element?: unknown; options?: unknown[]; shape?: Shape } } | null;
      if (!u) return false;
      if ((u as unknown) === ValueSchema) return true;
      const t = u.def?.type;
      if (t === 'record') return holdsValue(u.def?.valueType, depth + 1);
      if (t === 'array') return holdsValue(u.def?.element, depth + 1);
      // 嵌套对象：任一字段装得下就算。**这条是递归之所以会死循环的地方** ——
      // 容器的 steps 是 `z.lazy(子步骤列表)`，绕回 union 自身。所以 object 这一支
      // 只在 depth 限内展开，而 findValues 那里对 lazy 直接不进（理由写在那一侧）。
      if (t === 'object' && u.def?.shape) return Object.values(u.def.shape).some((v) => holdsValue(v, depth + 1));
      if (Array.isArray(u.def?.options)) return u.def.options.some((o) => holdsValue(o, depth + 1));
      return false;
    };
    /** 递归找位置。数组元素写 `[]`、record 的值写 `.*`，与下面那两张清单的写法一致 */
    const findValues = (s: unknown, path: string, out: Set<string>, depth = 0): void => {
      if (depth > 8 || out.has(path)) return;
      const u = unwrap(s) as { def?: { type?: string; valueType?: unknown; element?: unknown; options?: unknown[]; shape?: Shape } } | null;
      if (!u) return;
      if ((u as unknown) === ValueSchema) { out.add(path); return; }
      const t = u.def?.type;
      if (t === 'record') return findValues(u.def?.valueType, `${path}.*`, out, depth + 1);
      if (t === 'array') return findValues(u.def?.element, `${path}[]`, out, depth + 1);
      if (t === 'object' && u.def?.shape) {
        for (const [f, v] of Object.entries(u.def.shape)) {
          if (f === 'when' || f === 'kind') continue;
          if (holdsValue(v)) findValues(v, `${path}.${f}`, out, depth + 1);
        }
        return;
      }
      // union 成员不额外标层：同一个路径上的几种形态算一处
      if (Array.isArray(u.def?.options)) {
        for (const o of u.def.options) if (holdsValue(o)) return findValues(o, path, out, depth + 1);
      }
    };
    const sites = new Set<string>();
    for (const opt of (StepSchema as unknown as { options: Array<{ def?: { shape?: Shape } }> }).options) {
      const shape = opt?.def?.shape;
      const kind = shape?.kind as { value?: string } | undefined;
      if (!shape || typeof kind?.value !== 'string') continue;
      for (const [f, v] of Object.entries(shape)) {
        if (f === 'when' || f === 'kind') continue;
        // 只在**这一支真的装得下值**时才下去：否则 `container.steps` 那种
        // 绕回自身的 lazy 会把整棵步骤树扫一遍（不无限，但会把每个 kind 都标上）
        if (holdsValue(v)) findValues(v, `${kind.value}.${f}`, sites);
      }
    }
    /*
     * 数量自检。**不许只写 `>= 10`**：一层遍历当时给的是 10 个，递归之后是 20 个，
     * 而"扫到 10 个"在那一版里也满足 `>= 10` —— 一条阈值断言挡不住"少扫一半"。
     * 有内容的版本是：认出几个 kind、以及下面那两张清单**加起来正好覆盖扫到的一切**
     * （多一个少一个都红，所以清单和扫描互相核对）。
     */
    assert.ok(sites.size >= 15, `只认出 ${sites.size} 个 ValueSchema 位置：遍历又退化成一层了？`);
    /** 已经求值、且本文件里逐位置测过的位置 */
    const resolved = [
      'act.value', 'input.value', 'assertPage.contains', 'assertPage.expected',
      'assertUi.contains', 'assertUi.expected', 'call.args.*', 'db.vars.*',
      'openapiCall.body', 'openapiCall.headers.*', 'openapiCall.pathParams.*', 'openapiCall.queryParams.*',
      'set.assign.*', 'table.rows[].*',
      // `dataSource` 步的 vars 与 `db` 步的 vars 是**两个位置、同一个 strMap**
      // （interpreter 里那两处调用共用同一个绑定，见 docs/15 §3.2）
      'dataSource.source.vars.*',
      // 嵌套对象里的三处（第一版看不见的那一层）
      'http.request.body', 'http.request.headers.*', 'http.request.query.*',
      /*
       * `http.request.formData` —— 本轮查出、**本轮也真的接上了**（`strMap` ->
       * `send({form})` -> adapter 的 `URLSearchParams`）。它原本和 `act.value`
       * 那一族是同一个缺陷（引擎一个字段都不读、请求照发、步骤判 pass），
       * 差别只在**端口与 adapter 那一半本来就有人走**（`HttpExec.send` 有 `form`，
       * `adapter-http` 的 client 会 `URLSearchParams` + urlencoded 头），
       * 所以这一处能当场修完而不是只登记。下面那组测试钉的就是这条接线。
       */
      'http.request.formData.*',
      /*
       * `switch.value` 是 ExprSchema（整段表达式），而比较项 `cases[].is` 是 ValueSchema
       * —— 同一个 switch 步骤上两种形态并存。求值点在 interpreter 的 switch 分支
       * （同一个 `resolveValue`）。**钉住它的那条测试在 `executor.test.ts`**
       * （`switch 命中 case / 落到 default 都等价`，那里写的正是 `is: {expr:'true'}`）。
       * 这一格是本轮**量出来的**，不是猜的：把那一处的 `resolveValue(c.is, vars)` 拆掉，
       * `control.test.ts`、`lang.test.ts`、本文件**一个都不红**（30/30、全绿、24/24），
       * 只有 `executor.test.ts` 红 —— 因为前几处的 `is:` 全是字面量。
       * "假绿在字面量上不可见"这条规矩又验证了一次：写覆盖面清单时，
       * 要问的不是"哪个文件里有 switch 的测试"，是"哪个文件里有**用了值形态的** switch 测试"。
       */
      'switch.cases[].is',
    ];
    /**
     * 判过、**刻意不求值**的位置。每一格都要有理由，否则它就是一个待修的洞。
     * 这一张存在的意义：没有它，"不求值的位置"只能靠"清单里没它"来表达，
     * 而"没列出来"与"忘了列"长得一模一样。
     *
     * **今天它是空的**（本轮把 `formData` 与 `switch.cases[].is` 两格都移到了上面
     * 那张"已求值"里，因为两处都真的接上了）。空表不是"这张没用了"：
     * 下一轮如果有人新增一个值形态位置而**决定不求值**，他必须在这里加一格并写理由，
     * 否则上面那条 `unjudged` 会红。这正是它要在**还没有内容的时候**就存在的原因。
     */
    const deliberatelyUnresolved: Record<string, string> = {};
    /*
     * ⚠ **这一张表管不到场景级的位置**，而这不是疏忽而是上面那个扫描器的边界：
     * 它走的是 `StepSchema` 的 union 成员，所以 `inputs[].default`（不在任何步骤里）
     * **压根不会出现在 `sites` 里**。于是"清单里有而 schema 扫不到 = 过期"那一条
     * 也不会因为我没列它而响 —— 也就是说**这一格在本文件里既查不到也漏不掉**。
     *
     * 记在这里而不是"顺手把它加进 resolved"：加进去会被 `stale` 那一条判成过期
     * （扫描器扫不到它），那是对的 —— 这张表只能装**扫描器认得的**位置。
     *
     * `inputs[].default` 现在的守卫在别处，两处都是实的：
     *  · 求值本身（四种形态 × 三个真入口）→ `input-defaults.test.ts`
     *  · 语法预先校验 → `value-form-syntax.test.ts` 那一组
     * 要真把它也纳入本文件的对撞，得先给扫描器加"从 `ScenarioSchema` 起扫、
     * 跳过三段步骤树"的第二条根，而那是另一件事（登记在 docs/14 §5）。
     */
    /*
     * 同一个 request 对象上紧挨着 formData 的那一格 —— `files[].fixtureRef`
     * —— **不是 ValueSchema**（`z.string()`），所以它不进这张表（进了就会被下面
     * 那条"清单里有而 schema 扫不到"判成过期，那是对的：这张表只能装值形态位置）。
     * 它在这里以注释形式留一句，是因为**同一轮里一起量出来的另一半缺口**别丢掉：
     * fixtureRef 全仓没有解析器（`unread-baseline.json` 里登记 P1），
     * 所以 multipart 上传今天做不了。本轮至少让它不再静默 ——
     * lint 的 `REQUEST_PART_NOT_IMPLEMENTED`（error）+ 运行时**不发**那个少附件的请求，
     * 两组钉子在本文件最后一组。
     */
    const listed = new Set([...resolved, ...Object.keys(deliberatelyUnresolved)]);
    const unjudged = [...sites].filter((s) => !listed.has(s)).sort();
    assert.deepEqual(unjudged, [], `这些位置能写值形态而没人判过它求不求值：${unjudged.join('、')}`);
    const stale = [...listed].filter((s) => !sites.has(s)).sort();
    assert.deepEqual(stale, [], `清单里有这些位置而 schema 扫不到 = 字段改名了或遍历又变浅了：${stale.join('、')}`);
    /*
     * 两张清单**不许有交集**。交集意味着同一个位置同时被声明"求值了"和"刻意不求值"
     * —— 那种状态在本仓出现过（`switch.value` 到底是 ExprSchema 还是 ValueSchema，
     * 两张表各说一次），而它对读代码的人给出的信息是零：既像修了又像没修。
     *
     * ⚠ 今天这张表是空的，所以**这一条与下面那条 for 都还打不中任何东西**。
     * 留着它们不是"以防万一"的装饰：`stale`/`unjudged` 那两条**查不出交集**
     * （一个位置同时在两张表里时，两个差集都是空）。也就是说等下一轮有人往
     * `deliberatelyUnresolved` 里加格子，这两条是**唯一**会响的东西。
     * 与 §4.7 那条"永不到达的分支不要留"不冲突：那条说的是**生产代码**里的死分支，
     * 这里是给未来的编辑准备的判据，而它今天为空是本轮修完两处之后的**事实**。
     */
    const both = resolved.filter((s) => s in deliberatelyUnresolved);
    assert.deepEqual(both, [], `这些位置同时出现在"已求值"与"刻意不求值"两张表里：${both.join('、')}`);
    /*
     * `deliberatelyUnresolved` 的每一格必须**说得出理由**（值非空）。
     * 空着理由的格子等于"这里没修，原因我不写了"，而下一轮的人只会把它当笔误删掉
     * —— 然后那个洞以"看着已经修过"的形态回来。
     */
    for (const [k, why] of Object.entries(deliberatelyUnresolved)) {
      assert.ok(why.length >= 10, `${k} 这一格没写理由（或太短），它会被下一个人当笔误删掉`);
    }
  });
});

describe('http.request.formData：值形态求值 + 真的进请求（本轮查出的第二例同类缺陷）', () => {
  /** 记下游的 http adapter。只记 send 的入参 —— 判据是"发出去的那份东西里有没有表单" */
  function spyHttp() {
    const sent: Record<string, unknown>[] = [];
    const http = {
      async send(o: unknown) {
        sent.push(o as Record<string, unknown>);
        return { status: 200, headers: {}, body: {}, bodyText: '{}', durationMs: 1, bytes: 2, truncated: false };
      },
    } as unknown as AdapterRegistry['http'];
    return { http, sent };
  }
  const req = (over: Record<string, unknown>) => ({ method: 'POST', url: 'http://x/up', ...over });
  async function httpOnce(over: Record<string, unknown>) {
    const { http, sent } = spyHttp();
    const r = await run(scen([{ ...b('h'), kind: 'http', request: req(over) } as unknown as StepDraft], { inputs: WHO }), { adapters: { http } });
    return { step: r.results.find((x) => x.stepId === 'h')!, sent: sent[0], calls: sent.length };
  }

  test('formData 的四种形态都求值后才交给 adapter（改前整个字段没人读，请求照发、步骤判 pass）', async () => {
    const { step, sent } = await httpOnce({ formData: { name: { path: '$who' }, expr: { expr: '$who + "!"' }, id: { gen: 'uuid' }, plain: 'p', n: 5 } });
    assert.equal(step.status, 'pass', said(step));
    const form = sent?.form as Record<string, unknown>;
    assert.deepEqual(form, { name: '张三', expr: '张三!', id: form.id, plain: 'p', n: '5' }, `表单没求值或没送出去：${JSON.stringify(sent?.form)}`);
    assert.match(String(form.id), /^[0-9a-f-]{36}$/, 'gen 形态没生效');
  });

  test('没有 formData 时**不凭空多一个 form 键**（免得 adapter 以为这是表单请求而改 content-type）', async () => {
    const { sent } = await httpOnce({ body: { a: 1 } });
    assert.ok(sent && !('form' in sent), `空 formData 也塞了 form：${JSON.stringify(sent?.form)}`);
  });

  test('body 与 formData 同时写 => error + case-stale，**一个字节都不发**', async () => {
    const { step, calls } = await httpOnce({ body: { a: 1 }, formData: { n: 'x' } });
    assert.equal(step.status, 'error', `两个载荷必须有人拦：${step.status}`);
    assert.equal(step.cause, 'case-stale', `是用例写坏了，不是环境：${step.cause}`);
    assert.match(said(step), /body.*formData|formData.*body/, `报错要点名这两个字段：「${said(step)}」`);
    assert.equal(calls, 0, '已经判坏了，一次都不该发（发了就是往被测系统里写一条载荷不完整的请求）');
  });

  test('files 非空 => 静态闸 error + 运行时报错且**不发**那个少附件的请求', async () => {
    /*
     * 改前的形状值得原样记住：`files` 全仓没人读，所以一条"上传发票"的用例是
     * **附件一个都没发出去而步骤判 pass**。本轮不做 multipart（`fixtureRef`
     * 压根没有解析器，那是 P1 的 fixture 仓库），但**不再报绿**。
     * "至少把表单字段发出去"那种折中刻意不采纳：后端字段可选时照收，
     * 于是那条用例永久绿 —— 那还是同一个假绿，只是换了来源。
     */
    const body = [{ ...b('h'), kind: 'http', request: req({ formData: { n: 'x' }, files: [{ field: 'doc', fixtureRef: 'f1' }] }) } as unknown as StepDraft];
    const { step, calls } = await httpOnce({ formData: { n: 'x' }, files: [{ field: 'doc', fixtureRef: 'f1' }] });
    assert.equal(step.status, 'error', `带附件的步骤不许绿：${step.status} / ${said(step)}`);
    assert.equal(calls, 0, '发了一个没有附件的请求 = 用例绿了而附件没上传');
    const codes = lintScenario(scen(body, { inputs: WHO }), {}).filter((f) => f.code === 'REQUEST_PART_NOT_IMPLEMENTED');
    assert.equal(codes.length, 1, '静态闸要报（跑之前就能确定这一栏非空，不需要起任何网络）');
    assert.equal(codes[0]!.level, 'error', '假绿必须 error 级，否则 `atest lint` 退码不拦、CI 照跑');
    assert.equal(codes[0]!.stepId, 'h', 'finding 要指到那一步');
  });

  test('**反方向**：不写 files 的普通请求零 finding（新增规则不许把存量场景全判坏）', async () => {
    for (const over of [{ formData: { n: 'x' } }, { body: { a: 1 } }, {}, { query: { q: { expr: '$who' } } }]) {
      const codes = lintScenario(scen([{ ...b('h'), kind: 'http', request: req(over) } as unknown as StepDraft], { inputs: WHO }), {})
        .filter((f) => f.code === 'REQUEST_PART_NOT_IMPLEMENTED');
      assert.deepEqual(codes.map((c) => c.message), [], `${JSON.stringify(over)} 被误报了`);
    }
  });

  test('setup / teardown 里的 http 步同样被查（解释器对三段都真跑）', () => {
    const body = [{ ...b('h'), kind: 'http', request: req({ files: [{ field: 'f', fixtureRef: 'x' }] }) } as unknown as StepDraft];
    // body 不能是空数组（IR 要求 >= 1 步），所以放一条 noop 而不是把 body 留空
    const inSetup = lintScenario(defineScenario({
      schemaVersion: '1', id: 'scn.t2', name: 't', env: { environmentRef: 'unit' },
      setup: body, body: [{ ...b('n'), kind: 'noop' } as unknown as StepDraft], teardown: [],
    } as unknown as ScenarioDraft)).filter((f) => f.code === 'REQUEST_PART_NOT_IMPLEMENTED');
    assert.equal(inSetup.length, 1, '前置里的上传步骤逃过了检查：前置里"先传个附件"恰恰是最常见的位置');
  });
});

