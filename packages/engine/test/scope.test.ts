/**
 * parallel 的**作用域**语义（每支一份局部帧，global 帧按引用共享）。
 *
 * 这批测试对应的缺陷是探针实测出来的，不是推演的（原始探针 output 记在
 * docs/04「parallel 的作用域模型」一节）：变量空间**全仓只有一条帧栈**，
 * 并发分支各自 push/pop 同一条栈。分支 B 里一句 `set mineOnly = 42` 走到
 * set→declare 时写的是**当时栈顶那一帧**，而那一刻栈顶可能是分支 A 的
 * forEach 刚压的迭代帧 —— A 的迭代结束 popTo 把那一帧弹掉，B 写进去的值跟着没了。
 * B 那一步报 **pass**，`$mineOnly` 却永远查不到。
 *
 * 为什么这里既有"该拒的"也有"该放的"：**闸变窄与变宽一样危险**。
 * 只测"会拒"的话，把闸改成"任何带 forEach 的分支都拒"也能全绿，
 * 而那种 parallel 在真实场景里没法用（分支里十有八九有循环）。
 * 所以下面每一条拒绝的用例，都配一条形状相近但必须放行的用例。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { b, scen, run, res, stubComposeUrl } from './helpers.js';
import type { StepDraft } from './helpers.js';
import type { HttpExec } from '../src/index.js';

const par = (id: string, steps: StepDraft[], over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'parallel', failFast: true, maxConcurrency: 2, steps, ...over }) as StepDraft;

const ok = { status: 200, headers: {}, body: {}, bodyText: '{}', durationMs: 1, bytes: 2, truncated: false };
const httpOk = fakeHttp(async () => ok);

function fakeHttp(send: HttpExec['send']): HttpExec {
  return {
    send,
    composeUrl: stubComposeUrl(),
    resolveOperation: async (ref) => ({
      method: ref.method ?? 'GET',
      urlTemplate: ref.path ?? '/x',
      requiredBodyFields: [],
      deprecated: false,
    }),
  };
}

describe('parallel 分支作用域隔离', () => {
  /*
   * 原始缺陷本身。另一半（另一支只是 sleep、不压帧）也必须测：
   * 那一半在修之前**就是过的**，它是这条缺陷的对照组 ——
   * 只测坏的那一半，等于把"另一支压不压帧"这个真正的自变量从测试里删掉，
   * 于是"随便怎么改都能过"和"真的修好了"长得一模一样。
   */
  test('分支里新声明的名字不会写进别的支持分支的循环帧里（原缺陷）', async () => {
    const mk = (sibling: StepDraft): ReturnType<typeof scen> =>
      scen([
        { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
        par('p', [sibling, { ...b('kB'), kind: 'set', assign: { mineOnly: 42 } }]),
        { ...b('after'), kind: 'assert', against: '$mineOnly', jsonPath: { $: { eq: 42 } } },
      ]);
    const framed = await run(mk({ ...b('kA'), kind: 'forEach', items: 'list', as: 'rowA', steps: [{ ...b('nA'), kind: 'sleep', ms: 1 }] }));
    assert.equal(res(framed, 'after').status, 'pass', '另一支带 forEach 时，本支新声明的名字跟着别人的帧一起被弹掉');
    const plain = await run(mk({ ...b('kA'), kind: 'sleep', ms: 1 }));
    assert.equal(res(plain, 'after').status, 'pass', '对照组：另一支不压帧时本来就该过');
  });

  test('parallel 之后能读到各分支新声明的名字（合并）', async () => {
    const r = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'set', assign: { fromA: 1 } },
        { ...b('k1'), kind: 'set', assign: { fromB: 2 } },
      ]),
      { ...b('a1'), kind: 'assert', against: '$fromA', jsonPath: { $: { eq: 1 } } },
      { ...b('a2'), kind: 'assert', against: '$fromB', jsonPath: { $: { eq: 2 } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('分支里 saveAs 的响应，parallel 之后仍可被 $.step.<id> 引用', async () => {
    const r = await run(
      scen([
        par('p', [
          { ...b('k0'), kind: 'http', request: { method: 'GET', url: 'http://x/1' }, saveAs: 'rA' },
          { ...b('k1'), kind: 'http', request: { method: 'GET', url: 'http://x/2' }, saveAs: 'rB' },
        ]),
        { ...b('chk'), kind: 'assert', against: '$.step.k0.resp.status', jsonPath: { $: { eq: 200 } } },
      ]),
      { adapters: { http: httpOk } },
    );
    // 步骤导出各支一份 Map，收尾整体并回 —— 漏并的话这里会得到"步骤 k0 尚无输出"，
    // 一个只在并发下出现、单跑必过的假失败
    assert.equal(res(r, 'chk').status, 'pass', res(r, 'chk').assertionSummary ?? '');
  });

  /*
   * 判据是 **has（只看帧）**而不是 knows（帧+inputs+env）。
   *
   * 顺序执行时 `set token = "x"` 而 token 只存在于 env，走的是 declare ——
   * 在当前帧新建一个遮蔽它的变量，之后读 `$token` 得到 "x"。
   * 用 knows 的话，env 里有 token 就跳过合并，于是**同一步挪进 parallel 就被静默丢弃** ——
   * 同一份 IR 换个位置就换行为，正是本仓反复出现的"看着一样、实际两套语义"。
   * 这条测试存在的意义就是让 knows 那一版跑不过。
   */
  test('分支写一个只在 env 里存在的同名变量 → 遮蔽它，与顺序执行同语义', async () => {
    const body = (inParallel: boolean): ReturnType<typeof scen> =>
      scen(inParallel
        ? [par('p', [{ ...b('k0'), kind: 'set', assign: { token: 'branched' } }]),
           { ...b('chk'), kind: 'assert', against: '$token', jsonPath: { $: { exact: 'branched' } } }]
        : [{ ...b('k0'), kind: 'set', assign: { token: 'sequential' } },
           { ...b('chk'), kind: 'assert', against: '$token', jsonPath: { $: { exact: 'sequential' } } }]);
    const env = { token: 'from-env' };
    const seq = await run(body(false), { env });
    const parR = await run(body(true), { env });
    assert.equal(res(seq, 'chk').status, 'pass', '顺序情形是基准：set 遮蔽 env');
    assert.equal(res(parR, 'chk').status, 'pass', '并行情形必须与顺序一致，而不是把这次写静默丢掉');
  });

  /*
   * 钉的是"分支里已退掉的循环帧不参与合并"：循环项 marker 与分支层的 marker 同名，
   * 迭代帧随循环销毁，合并不该把它带出来。
   *
   * **这条不钉帧的遍历顺序** —— 我一度以为它钉，写了"浅帧优先"的说法。
   * 变异验证：把 adoptFrom 的循环改成从最深帧往回遍历，**测试全绿**，
   * 因为分支跑到 parallel 结束时，循环帧早就 pop 掉了，压根没有多帧可排序。
   * 也就是这条断言对"遍历方向"这个实现细节是**盲的**，别把它读成钉住了方向。
   * （记下来是因为"我以为它测到了"这件事本身值得留痕：
   *  注释里对测试能力的高估，和缺陷类的"看起来有防护"是同一个东西。）
   */
  test('合并取分支跑完时可见的值，不是循环帧里的残留', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'sequence', steps: [
          { ...b('s1'), kind: 'set', assign: { marker: 'branchLevel' } },
          // 循环项与上面**同名**：它在自己的迭代帧里，随帧销毁
          { ...b('s2'), kind: 'forEach', items: 'list', as: 'marker', steps: [{ ...b('s3'), kind: 'noop' }] },
        ] },
        { ...b('k1'), kind: 'noop' },
      ]),
      { ...b('chk'), kind: 'assert', against: '$marker', jsonPath: { $: { exact: 'branchLevel' } } },
    ]));
    assert.equal(res(r, 'chk').status, 'pass', `拿到的是循环项残留：${res(r, 'chk').assertionSummary ?? ''}`);
  });

  /*
   * 步骤导出各支一份 Map，这条才真的被观察到。
   *
   * 上一条测的是"parallel 之后读得到"（合并的结果），共享一份 Map 也能过 ——
   * 所以那条**没有钉住隔离本身**。这条钉：分支里读别的支持分支的步骤输出，
   * 得到的是确定的"尚无输出"，而不是"取决于对方跑到哪了"。
   * 共享 Map 时后者会发生（A 支可能在 k1 发完请求前或后读），
   * 那正是"同一份冻结场景两种结论"的形态。
   */
  test('分支读别的支持分支的步骤输出 → 确定的"尚无输出"，不是随进度变化', async () => {
    /*
     * 排布是刻意选的：**k1 先跑完并发出导出，k0 之后才读**。
     * 第一版我把读的那支写在前面，配上 maxConcurrency: 2，于是读的时候对方
     * 压根还没导出 —— 共享一份 Map 也照样报"尚无输出"，测试全绿却什么都没测到
     * （变异检查实测：把 stepExports 改成共享父 Map，全套 0 失败）。
     * 现在用 maxConcurrency: 1，池子按**声明顺序**跑，k1 的导出确定性地先发生。
     */
    const one = () => run(
      scen([
        par('p', [
          { ...b('k1'), kind: 'http', request: { method: 'GET', url: 'http://x/1' }, saveAs: 'r1' },
          { ...b('k0'), kind: 'assert', against: '$.step.k1.resp.status', jsonPath: { $: { eq: 200 } } },
        ], { maxConcurrency: 1 }),
      ]),
      { adapters: { http: httpOk } },
    );
    // 先自证排布成立：k1 的结果确实排在 k0 前面，否则这条又是空的
    const probe = await one();
    const ids = probe.results.map((x) => x.stepId);
    assert.ok(ids.indexOf('k1') < ids.indexOf('k0'), `排布不成立：${ids.join(',')}`);
    assert.equal(res(probe, 'k1').status, 'pass', 'k1 必须先成功导出');

    assert.equal(res(probe, 'k0').status, 'error', '跨支读步骤输出应当查不到（各支一份导出表）');
    assert.match(res(probe, 'k0').assertionSummary ?? '', /k1/);
    for (let i = 0; i < 8; i++) {
      assert.equal(res(await one(), 'k0').status, 'error', `第 ${i + 2} 次读到了 —— 导出表被共享了`);
    }
  });

  /*
   * 隔离必须**在跑的过程中**也成立，不只是结束时。
   *
   * 这条是补上来的，因为变异检查暴露了一个盲点：把"给这一支加一帧"删掉
   * （分支的新写直接落到共享帧上）时，前面所有测试全绿 ——
   * 原缺陷那条测的是"值会不会消失"，而删掉那一帧之后值确实不会消失
   * （各支仍各有各的帧数组，谁也无法把别人的帧弹掉），
   * 于是**隔离实际上没了，测试却看不见**。
   *
   * 能看见的判据只有一个：一边写、另一边在**同一次运行中**去读。
   * 隔离做对了 → 读不到（各支一份）；没做对 → 读到，而且读到与否取决于
   * 对方有没有先跑到那一步 —— 就是"同一份 IR 两种结论"那个老形态。
   */
  test('一支新写的变量，另一支在运行中读不到（隔离要在过程中也成立）', async () => {
    const one = () => run(scen([
      par('p', [
        // k0 先写一个**新**名字；k1 读它。并发池里 k0 一定先跑完（maxConcurrency=1 排除交错干扰）
        { ...b('k0'), kind: 'set', assign: { freshInBranch: 'yes' } },
        { ...b('k1'), kind: 'assert', against: '$freshInBranch', jsonPath: { $: { exact: 'yes' } } },
      ], { maxConcurrency: 1 }),
    ]));
    const first = await one();
    assert.equal(res(first, 'k1').status, 'error', '另一支里读到了别支的局部变量（隔离失效，只是没让值消失而已）');
    assert.match(res(first, 'k1').assertionSummary ?? '', /freshInBranch/);
    for (let i = 0; i < 5; i++) {
      assert.equal(res(await one(), 'k1').status, 'error', `第 ${i + 2} 次读到了 —— 说明它其实可读，结果随进度变`);
    }
    // 但 parallel **之后**必须读得到（收尾合并），否则这条隔离只是"变量凭空消失"
    const after = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'set', assign: { freshInBranch: 'yes' } },
        { ...b('k1'), kind: 'noop' },
      ], { maxConcurrency: 1 }),
      { ...b('chk'), kind: 'assert', against: '$freshInBranch', jsonPath: { $: { exact: 'yes' } } },
    ]));
    assert.equal(res(after, 'chk').status, 'pass', res(after, 'chk').assertionSummary ?? '');
  });

  test('外层已声明的名字：分支里写它仍然写进外层（累加器语义不能坏）', async () => {
    const r = await run(scen([
      { ...b('init'), kind: 'set', assign: { hit: 0 } },
      par('p', [
        { ...b('k0'), kind: 'set', assign: { hit: 1 } },
        { ...b('k1'), kind: 'noop' },
      ]),
      { ...b('chk'), kind: 'assert', against: '$hit', jsonPath: { $: { eq: 1 } } },
    ]));
    assert.equal(res(r, 'chk').status, 'pass', 'parallel 之前声明的名字必须还能被分支里的写覆盖到');
  });

  test('分支里循环项遮蔽外层同名变量，且不漏到外层（与顺序 forEach 同语义）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [7, 8], item: 'outer' } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'noop' },
      ]),
      { ...b('chk'), kind: 'assert', against: '$item', jsonPath: { $: { exact: 'outer' } } },
    ]));
    assert.equal(res(r, 'chk').status, 'pass', res(r, 'chk').assertionSummary ?? '');
  });

  /*
   * 合并落点是**外层栈顶那一帧**，不是 global 帧。这条是它唯一的观察入口：
   * 把合并改成提到 global，下面每条断言都还是绿的 —— 因为名字仍然"读得到"，
   * 只是活得比它该死的范围久了。
   *
   * 为什么要较真：parallel 写在 forEach 里面（"每条数据并发跑一遍"）很常见，
   * 提到 global 等于让循环里的并发把变量漏到循环外，
   * 而 docs/02 §5 的语义是"帧退栈即销毁"。
   * 这是原缺陷的镜像形态：一个是值凭空消失，一个是值凭空活着出来。
   */
  test('forEach 里的 parallel：分支新声明的名字随循环帧一起销毁', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      { ...b('loop'), kind: 'forEach', items: 'list', as: 'row', steps: [
        par('p', [
          { ...b('k0'), kind: 'set', assign: { onlyInsideLoop: 'yes' } },
          { ...b('k1'), kind: 'noop' },
        ]),
      ] },
      // 循环外读它：应当查不到（随迭代帧销毁），而不是拿到最后一轮的值
      { ...b('leak'), kind: 'assert', against: '$onlyInsideLoop', jsonPath: { $: { notNull: true } } },
    ]));
    assert.equal(res(r, 'leak').status, 'error', '分支里新声明的名字漏到了循环外');
    assert.match(res(r, 'leak').assertionSummary ?? '', /onlyInsideLoop/);
  });

  test('嵌套 parallel 在 forEach 里时，分支看得到那层迭代帧', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [5] } },
      { ...b('loop'), kind: 'forEach', items: 'list', as: 'row', steps: [
        par('p', [
          // 不预先声明 rowCopy：写进来的名字并回的是**循环那一帧**（不是 global），
          // 所以它在循环外不可见，但在本层可见 —— 这里直接在分支里读迭代项最直观
          { ...b('k0'), kind: 'assert', against: '$row', jsonPath: { $: { eq: 5 } } },
          { ...b('k1'), kind: 'noop' },
        ]),
      ] },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('跨支读对方**分支内部**的变量 → 清晰报错（不是读到别人的值，也不是静默 undefined）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'assert', against: '$item', jsonPath: { $: { notNull: true } } },
      ]),
    ]));
    assert.equal(res(r, 'k1').status, 'error');
    assert.match(res(r, 'k1').assertionSummary ?? '', /\$?item/, '报错必须点名那个变量');
    assert.match(res(r, 'k1').assertionSummary ?? '', /未找到|未定义/);
    // 关键：它**不再**是"读到别人那一支的循环项值"（那是原缺陷的形态，
    // 值随调度顺序变）。现在是确定性的"查不到"，与运行次序无关。
    assert.equal(res(r, 'k1').cause, 'case-stale', '应当被归成用例问题，不是产品缺陷');
  });
});

/**
 * 合并顺序。这一组是这批测试里最容易"看着过了其实什么都没测"的地方：
 * 只断言最终值 9，**顺序对调也会给出 9**（两支各写各的帧，先并谁都是 9）。
 * 所以顺序必须靠"两支同名"来观察 —— 同名时先并的那支赢。
 */
describe('同名合并按分支声明顺序（确定性）', () => {
  /*
   * 先钉"这件事到底会不会随调度顺序变"。探针实测：**不共享写的时候，
   * 两支各自声明同名变量的行为是确定的**（各支局部帧，收尾按声明顺序并）。
   *
   * 但"确定"不等于"对"：作者的意图是两份都要，静默挑一份等于替用户猜。
   * 所以 parallelHazards 照样把"两支写同一个名字"拒掉（外层已声明 → 真竞态；
   * 两支各自新声明 → 合并只能留一份）。这条测试因此**断的是拒绝**，
   * 而不是某个胜出值 —— 早先这里写的是"先声明者赢 + 断 fromA === 1"，
   * 那测的是一个已经被拒绝的行为。
   */
  const bothWrite = (order: [string, string]): ReturnType<typeof scen> =>
    scen([
      par('p', [
        { ...b(`k${order[0]}`), kind: 'set', assign: { fromA: 1, winner: order[0] === '0' ? 'A' : 'B' } },
        { ...b(`k${order[1]}`), kind: 'set', assign: { fromB: 2, winner: order[1] === '0' ? 'A' : 'B' } },
      ], { maxConcurrency: 2 }),
    ]);

  test('两支写同名 → 拒，而不是静默挑一份', async () => {
    for (const order of [['0', '1'], ['1', '0']] as [string, string][]) {
      const r = await run(bothWrite(order));
      assert.equal(res(r, 'p').status, 'error', `声明顺序 ${order.join('→')} 时应该拒`);
      assert.match(res(r, 'p').assertionSummary ?? '', /winner/);
    }
  });

  /*
   * M7 的确定性口径是**同一份 IR 跑 N 次结果一致**，不是"换一种 IR 也给同样结果"。
   * 这条原先写的是"比较两种分支声明顺序的报错文本相等" —— 那是我在考错的东西，
   * 而且它**活该失败**：报错里列的是分支 id，IR 顺序换了文本就该换。
   * 真正要钉的是同一份 IR 重复跑：调度交错每次不同，结论必须次次相同。
   */
  test('同一份 IR 重复跑 12 次，结论与报错完全一致（M7 口径）', async () => {
    // 工厂只写一份 IR，重复跑的就是**同一个值**：
    // 三处各贴一份 IR 的话，改一处就悄悄变成"比较三份不同的 IR"
    const mixedRace = (): ReturnType<typeof scen> =>
      scen([
        { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
        par('p', [
          { ...b('k0'), kind: 'http', request: { method: 'GET', url: 'http://x/1' }, saveAs: 'w' },
          { ...b('k1'), kind: 'http', request: { method: 'GET', url: 'http://x/2' }, saveAs: 'w' },
          { ...b('k2'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n2'), kind: 'noop' }] },
          { ...b('k3'), kind: 'set', assign: { w: 3 } },
        ], { maxConcurrency: 3 }),
      ]);
    const sig = (r: Awaited<ReturnType<typeof run>>): string =>
      `${r.status}|${res(r, 'p').status}|${res(r, 'p').assertionSummary ?? ''}|${ran(r).join(',')}`;
    const base = sig(await run(mixedRace()));
    for (let i = 0; i < 12; i++) assert.equal(sig(await run(mixedRace())), base, `第 ${i + 2} 次跑出了不同结论`);
    assert.match(base, /error/, '这份 IR 有三支写 w，必须拒；不拒的话"一致"也可能是"一致地错"');
  });

  /** 分支实际执行序列（含嵌套），用来确认"每次跑的都是同样那几支" */
  const ran = (r: { results: readonly { stepId: string }[] }): string[] =>
    r.results.filter((x) => x.stepId !== 'seed' && x.stepId !== 'p').map((x) => x.stepId).sort();

  /*
   * 上面那条钉的是"不共享写时不会 flaky"。这条钉**共享写仍然要被拒** ——
   * 名字在 parallel 之前就存在，两支写的确实是同一份，谁后跑谁赢。
   * 这条是闸现在唯一的判据，漏掉它等于把唯一的防护拆了。
   */
  test('两支写外层已声明的同名变量 → 仍然拒（真竞态，作用域救不了）', async () => {
    const r = await run(scen([
      { ...b('init'), kind: 'set', assign: { shared: 0 } },
      par('p', [
        { ...b('k0'), kind: 'set', assign: { shared: 1 } },
        { ...b('k1'), kind: 'set', assign: { shared: 2 } },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'error');
    assert.match(res(r, 'p').assertionSummary ?? '', /shared/);
  });

  test('两支 saveAs 同名 → 仍然拒（同名合并只能留一份）', async () => {
    const r = await run(
      scen([
        par('p', [
          { ...b('k0'), kind: 'http', request: { method: 'GET', url: 'http://x/1' }, saveAs: 'w' },
          { ...b('k1'), kind: 'http', request: { method: 'GET', url: 'http://x/2' }, saveAs: 'w' },
        ], { maxConcurrency: 2 }),
      ]),
      { adapters: { http: httpOk } },
    );
    assert.equal(res(r, 'p').status, 'error');
    assert.match(res(r, 'p').assertionSummary ?? '', /\bw\b/);
  });
});

/**
 * 窄。这四条是上面所有"拒"的对照组 —— 没有它们，
 * "把带 forEach 的分支一律拒掉"这种把 parallel 废掉的实现也能全绿。
 */
describe('闸的窄度（放行侧对照组）', () => {
  test('两支各带 forEach、循环项同名 → 放行（各支一份帧，物理上互不可见）', async () => {
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n1'), kind: 'noop' }] },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'pass', res(r, 'p').assertionSummary ?? '');
    // 两支都真的把 2 次迭代跑完了（不是"看起来过了其实没跑"）
    assert.equal(r.results.filter((x) => x.stepId === 'n0').length, 2);
    assert.equal(r.results.filter((x) => x.stepId === 'n1').length, 2);
  });

  test('分支里 while + 另一支 set 新名字 → 放行且两边都生效', async () => {
    const r = await run(scen([
      { ...b('x'), kind: 'set', assign: { n: 0 } },
      par('p', [
        { ...b('k0'), kind: 'while', condition: '$n < 2', maxIterations: 5, steps: [{ ...b('inc'), kind: 'set', assign: { n: { expr: '$n + 1' } } }] },
        { ...b('k1'), kind: 'set', assign: { fresh: 'yes' } },
      ], { maxConcurrency: 1 }),
      { ...b('chk'), kind: 'assert', against: '$fresh', jsonPath: { $: { exact: 'yes' } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('分支里嵌套的 set 也算写（判据要 walk 到底，不能只看直接子步骤）', async () => {
    // 外层已声明 → 两支写同一份 → 该拒。这条测的是"嵌套深度不逃过判据"，
    // 而不是"新名字会串"（新名字是隔离的，见上面的用例）
    const r = await run(scen([
      { ...b('init'), kind: 'set', assign: { deep: 0 } },
      par('p', [
        { ...b('k0'), kind: 'sequence', steps: [{ ...b('s0'), kind: 'set', assign: { deep: 1 } }] },
        { ...b('k1'), kind: 'if', condition: 'true', then: [{ ...b('s1'), kind: 'set', assign: { deep: 2 } }], else: [] },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'error', '藏在 sequence/if 里的同名写也要被抓到');
  });

  test('各分支写各自不同的新变量 → 放行', async () => {
    const r = await run(scen([
      par('p', [
        { ...b('k0'), kind: 'set', assign: { fromA: 1 } },
        { ...b('k1'), kind: 'set', assign: { fromB: 2 } },
      ], { maxConcurrency: 2 }),
    ]));
    assert.equal(res(r, 'p').status, 'pass');
  });
});
