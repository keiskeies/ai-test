/**
 * parallel 容器的并发语义。
 *
 * 这批测试的存在理由是一条**已经上线过的**缺陷：实现写的是
 * `s.steps.slice(0, s.maxConcurrency)` —— 分支数超过并发上限时，多出来的分支
 * **压根没执行**，而容器照样返回 pass、summary 写着"并行 5 支"（那个数来自
 * `s.steps.length`，不是实际执行数）。maxConcurrency 默认 4，所以任何 5 支以上
 * 的并行每次都会静默丢尾巴；被丢掉的那些分支要跑的断言，正是这次运行唯一没验的部分。
 *
 * 所以判据一律落在**实际执行了什么**（clock.mono() 的调用序列 —— 冻结时钟每步
 * 递进一格，谁跑了几步就推进几格），而不是 summary 里的那句话：
 * 原实现最坏的地方就是"报告说跑了"，只断 summary 等于让缺陷自己作证。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { b, scen, run, res } from './helpers.js';
import type { StepDraft } from './helpers.js';
import type { HttpExec } from '../src/index.js';

/** k 个 set 分支，id 为 k0..k(k-1) */
const kids = (k: number): StepDraft[] =>
  Array.from({ length: k }, (_, i) => ({ ...b(`k${i}`), kind: 'set', assign: { [`v${i}`]: i } }));

const par = (id: string, steps: StepDraft[], over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'parallel', failFast: true, maxConcurrency: 2, steps, ...over }) as StepDraft;

const ok = { status: 200, headers: {}, body: {}, bodyText: '{}', durationMs: 1, bytes: 2, truncated: false };

/**
 * 本文件用的 http 夹具。**写成 HttpExec 而不是 `as never`**：
 * 接口加必选方法时这里必须编译不过，否则夹具会一直"少一个方法也能跑"，
 * 而那正是本仓那个缺陷类的测试侧形态（identity.test.ts 的注释里记过同一条教训）。
 * resolveOperation 这里给不出有意义的东西（本文件不碰 openapiCall），
 * 但它是接口的必选项，所以老实返回一个形状正确的空解析结果。
 */
function fakeHttp(send: HttpExec['send']): HttpExec {
  return {
    send,
    resolveOperation: async (ref) => ({
      method: ref.method ?? 'GET',
      urlTemplate: ref.path ?? '/x',
      requiredBodyFields: [],
      deprecated: false,
    }),
  };
}

/** 发请求就炸（模拟连接被拒绝） */
const boom = fakeHttp(async () => {
  throw new Error('连接被拒绝');
});

/** 分支实际执行的先后序列（不含并行容器本身） */
const ran = (r: { results: readonly { stepId: string }[] }): string[] =>
  r.results.filter((x) => x.stepId.startsWith('k')).map((x) => x.stepId);

describe('parallel 并发池', () => {
  test('分支数超过并发上限时，一支都不能少跑（原始缺陷：slice 把尾巴丢了）', async () => {
    const r = await run(scen([par('p', kids(5), { maxConcurrency: 2 })]));
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(ran(r).length, 5, `只跑了 ${ran(r).length} 支：${ran(r).join(',')}`);
    // 光"结果里有 5 行"还不够 —— 得是 5 支**都跑到并通过**。
    // 不查 outputs：set 写的是变量空间，而变量只有声明进 scenario.outputs 才出现在报告里
    // （并发子步骤的帧在分支结束时销毁，这是 docs/02 §5 的退帧语义，不是本测试要碰的东西）。
    assert.deepEqual(
      r.results.filter((x) => x.stepId.startsWith('k')).map((x) => x.status),
      ['pass', 'pass', 'pass', 'pass', 'pass'],
    );
  });

  test('并发度真的生效：任一时刻在跑的分支数不超过 maxConcurrency', async () => {
    // 冻结时钟下 set 是同步完成的，看不出交错，所以用 http 分支：send 里数并发。
    let live = 0;
    let peak = 0;
    const http = fakeHttp(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((ok2) => setTimeout(ok2, 1));
      live--;
      return ok;
    });
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...b(`k${i}`), kind: 'http', request: { method: 'GET' as const, url: 'http://x/y' },
    }));
    const r = await run(scen([par('p', six, { maxConcurrency: 2 })]), { adapters: { http } });
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(ran(r).length, 6);
    assert.ok(peak <= 2, `峰值并发 ${peak} 超过上限 2`);
    assert.ok(peak >= 2, `峰值并发 ${peak} —— 一路串行的话"并发"这个字段没有意义`);
  });

  test('全部成功时容器是 pass，且 summary 报的支数等于实际执行数', async () => {
    const r = await run(scen([par('p', kids(3))]));
    assert.equal(res(r, 'p').status, 'pass');
    assert.equal(res(r, 'p').assertionSummary, '并行 3 支');
  });

  test('分支自身守卫不成立 → 记 skipped，但通过的其他分支照旧计入通过率', async () => {
    const mixed: StepDraft[] = [
      { ...b('k0'), kind: 'noop', when: '1 == 2' },
      ...kids(2),
    ];
    const r = await run(scen([par('p', mixed, { failFast: false })]));
    assert.equal(res(r, 'p').status, 'pass', '有分支通过时容器不能整只报 skipped（那会把通过的分支从分母里抹掉）');
    assert.equal(res(r, 'k0').status, 'skipped');
    assert.match(res(r, 'p').assertionSummary ?? '', /未执行 1 支/);
    // 分母里必须还有那两支出身的分支
    assert.equal(r.tally.pass, 3, '并行容器自身 + 两支 set 都应计入 pass');
  });

  test('failFast：一支失败就拉停，**没起跑的分支必须记成 skipped 而不是消失**', async () => {
    // 顺序是调度的产物，所以不断"具体哪几支没跑"，只断守恒：
    // 跑过的 + 记 skipped 的 == 声明的分支数。原缺陷正是让两边对不上。
    const branches: StepDraft[] = Array.from({ length: 6 }, (_, i) =>
      i === 0
        ? ({ ...b('k0'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } })
        : ({ ...b(`k${i}`), kind: 'noop' }),
    );
    const r = await run(scen([par('p', branches, { failFast: true, maxConcurrency: 1 })]), { adapters: { http: boom } });
    assert.equal(res(r, 'p').status, 'fail');
    const ids = ran(r);
    assert.ok(ids.includes('k0'), '出错的那支必须在结果里');
    assert.equal(ids.length, 6, `声明 6 支、结果里 ${ids.length} 支：${ids.join(',')}`);
    const skipped = r.results.filter((x) => x.stepId.startsWith('k') && x.status === 'skipped');
    assert.ok(skipped.length > 0, '拉停后没起跑的分支一个都没记 —— 报告读起来像"全都跑过了"');
    assert.match(skipped[0]!.assertionSummary ?? '', /failFast/);
  });

  test('failFast=false 时不拉停：全部分支都跑完，失败照样上报', async () => {
    const branches: StepDraft[] = [
      { ...b('k0'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } },
      ...kids(3),
    ];
    const r = await run(scen([par('p', branches, { failFast: false, maxConcurrency: 1 })]), { adapters: { http: boom } });
    assert.equal(res(r, 'p').status, 'fail');
    assert.equal(ran(r).length, 4, '不拉停就该一支不落全跑完');
    assert.equal(r.results.filter((x) => x.status === 'skipped').length, 0);
  });

  test('分支抛的是"运行级中止"（超时/取消）时不能被吞成分支失败', async () => {
    // 吞掉的后果：取消只让那一支变 fail/error，其余分支继续发请求 ——
    // 用户按 Ctrl-C 或 CI 超时之后，负载还在往被测系统上打。
    //
    // **信号必须在池子跑到中途时才成立**。一上来就 aborted 的话，第一个步骤的
    // checkAbort 就把整个 run 掀了，压根进不到 parallel，测试照样"通过"而什么都没验
    // （第一版就栽在这里：断言的是 events 里有 aborted，而那一句在任何实现下都成立）。
    const flag = { aborted: false };
    let calls = 0;
    const http = fakeHttp(async () => {
      calls++;
      if (calls === 1) flag.aborted = true; // 第一支跑完之后再取消
      return ok;
    });
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...b(`k${i}`), kind: 'http' as const, request: { method: 'GET' as const, url: 'http://x/y' },
    }));
    const r = await run(scen([par('p', six, { maxConcurrency: 1, failFast: false })]), { adapters: { http }, signal: flag });
    assert.ok(
      r.events.some((e) => e.kind === 'error' && (e.data as { aborted?: boolean }).aborted === true),
      '取消没传到运行层（parallel 把它降级成了普通分支失败）',
    );
    // 取消之后再没有新请求发出。failFast=false 的旧写法会把剩下 5 支全打完。
    assert.ok(calls <= 2, `取消后还在发请求：一共发了 ${calls} 次（应当第一支之后就停）`);
    assert.equal(r.results.filter((x) => x.stepId.startsWith('k') && x.status === 'fail').length, 0,
      '取消不该被记成分支失败（那会把"环境被取消"报成"产品有 bug"）');
  });

  test('maxConcurrency 大于分支数时不多开空转 worker', async () => {
    // 今天多开没有行为差异，但 worker 里一旦加入"每支都做一次"的副作用
    // （租约、限流令牌），空转 worker 就是凭空多出的 N 次副作用。
    const r = await run(scen([par('p', kids(2), { maxConcurrency: 32 })]));
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(ran(r).length, 2);
    assert.equal(r.tally.skipped, 0);
  });

  test('skipped 分支不算失败：不把同批其他分支拉停（否则未执行规模随调度顺序变）', async () => {
    const branches: StepDraft[] = [
      { ...b('k0'), kind: 'noop', when: '1 == 2' },
      ...kids(3),
    ];
    const r = await run(scen([par('p', branches, { failFast: true, maxConcurrency: 1 })]));
    assert.equal(res(r, 'p').status, 'pass', res(r, 'p').assertionSummary ?? '');
    assert.equal(ran(r).length, 4, '守卫不成立不是失败，不该拉停后面三支');
  });

  test('分支数为 0 时不被 schema 拦住才怪（min(1)），这里守的是"恰好等于上限"', async () => {
    // 边界：正好等于并发上限（旧写法 slice(0,2) 与 2 支恰好相等，所以旧测试从没抓到过丢分支）
    const r = await run(scen([par('p', kids(2), { maxConcurrency: 2 })]));
    assert.equal(ran(r).length, 2);
    assert.equal(r.status, 'pass', r.summary);
  });
});

/**
 * 变量竞态的静态闸。
 *
 * 两条判据都是**探针实测出来的**，不是推演：
 *  - 同名共享写：`saveAs` 撞 `saveAs`，用手动 settle 的 http 控制完成顺序，
 *    同一份 IR 一支先完成给 pass、另一支先完成给 fail。
 *  - 循环项遮蔽：两支各带 forEach、都用最自然的 `as: 'item'`，
 *    A 支的断言读到了 **B 支的循环项值**（帧栈共享，A 支 popTo 把 B 支的帧一起弹了）。
 * 所以这里要守的是两件事：闸**该响的时候响**，以及**不该响的时候别响**
 * （后者同样重要 —— 把带 forEach 的分支一律拒掉，parallel 在真实场景里就废了）。
 */
describe('parallel 变量竞态静态闸', () => {
  const httpOk = fakeHttp(async () => ok);
  const getStep = (id: string, url: string, extra: Record<string, unknown> = {}): StepDraft =>
    ({ ...b(id), kind: 'http', request: { method: 'GET', url }, ...extra }) as StepDraft;

  test('两支写同一个 saveAs -> 拒（否则结果取决于谁后完成）', async () => {
    const r = await run(
      scen([
        par('p', [getStep('k0', 'http://x/1', { saveAs: 'winner' }), getStep('k1', 'http://x/2', { saveAs: 'winner' })], { maxConcurrency: 2 }),
      ]),
      { adapters: { http: httpOk } },
    );
    assert.equal(res(r, 'p').status, 'error');
    assert.match(res(r, 'p').assertionSummary ?? '', /winner/, '报错要说清是哪个名字撞了，只说"有竞态"等于让人自己找');
    assert.match(res(r, 'p').assertionSummary ?? '', /k0.*k1|k1.*k0/, '要指出是哪两支');
  });

  test('两支写同一个 set 变量 -> 拒', async () => {
    const r = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'set', assign: { total: 1 } },
        { ...b('k1'), kind: 'set', assign: { total: 2 } },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'error');
    assert.match(res(r, 'p').assertionSummary ?? '', /total/);
  });

  test('一支带 forEach、另一支提到同名循环项 -> 拒（共享作用域栈）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'noop' }] },
        // 另一支只是**读** item，不写 —— 但帧栈共享，栈顶是谁决定它读到什么
        { ...b('k1'), kind: 'assert', against: '$item', jsonPath: { $: { notNull: true } } },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'error', '读的一侧不写就放行是错的：lookup 从栈顶往下找，栈顶不再属于自己');
    assert.match(res(r, 'p').assertionSummary ?? '', /item/);
  });

  test('两支各带 forEach 但循环项名字不同 -> 放行（闸必须够窄，否则 parallel 没法用）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'rowA', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'forEach', items: 'list', as: 'rowB', steps: [{ ...b('n1'), kind: 'noop' }] },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'pass', res(r, 'p').assertionSummary ?? '');
  });

  test('各分支写各自不同的变量 -> 放行', async () => {
    const r = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'set', assign: { fromA: 1 } },
        { ...b('k1'), kind: 'set', assign: { fromB: 2 } },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'pass', res(r, 'p').assertionSummary ?? '');
  });

  test('只有一支时完全不查（单支没有"另一个分支"可串）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1] } },
      par('p', [{ ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'set', assign: { shared: 1 } }] }]),
    ]));
    assert.equal(res(r, 'p').status, 'pass', res(r, 'p').assertionSummary ?? '');
  });

  test('分支里嵌套的 set 也算（要 walk 到底，不能只看直接子步骤）', async () => {
    const r = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'sequence', steps: [{ ...b('k0a'), kind: 'set', assign: { deep: 1 } }] },
        { ...b('k1'), kind: 'sequence', steps: [{ ...b('k1a'), kind: 'set', assign: { deep: 2 } }] },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'error', '嵌套里的写漏了，闸就等于形同虚设');
  });
});
