/**
 * `targetsOfStep` / `deriveTargets` / `targetSources` 三者的判据一致性。
 *
 * ## 为什么单开一个文件
 *
 * `targetSources` 存在的理由是**报错文案要说得出"因为哪几步"**
 * （docs/15 §3.3 五步链的第 3 步：一份只有 `app` 步骤 + 一条误写的 `assertPage`
 * 的纯移动端场景，装配期报「本次场景用到 Web 步骤」，人于是去装 Chrome，
 * 不会去想"我这个纯 app 场景里哪来的 Web 步骤"）。
 * 而报错文案一旦与"要不要建 adapter"的判据分叉，坏法比原先那句含糊的话更糟：
 * **含糊让人去查环境，精确的错指责让人去改无辜的用例**。
 * 所以这里守的不是"文案好不好看"，是"两个问法必须同一个判据"。
 *
 * ## 本轮真实翻车两次，各有一条测试守着
 *
 * 1. `targetSources` 第一版的逐步判据写的是 `deriveTargets([s]).includes(target)`，
 *    看着是"复用同一个函数、绝不分叉"的最稳写法。实测报错却报出
 *    「Web 需求来自这些步骤：sequence（seq1）、navigate（n2）」——
 *    **`deriveTargets` 会 walk 进子步骤**，所以容器自己也算"需要 web"，
 *    而 sequence 自己什么都不要（`STEP_TARGET.sequence === 'any'`）。
 *    我要修的错归因，被我的修法**复制了一份**。
 * 2. 写"mobile 那一档靠 `s.target` 细分"这条注释时，我以为所有移动端步骤都带平台。
 *    实测**只有 `device` 的平台是真的**：`tap`/`input`/`key` 的 `target` 是**定位器**
 *    （对象，永远不等于 'ios'），`app`/`swipe`/`watcher`/`logcat`/`manualHandoff`
 *    压根没有这个字段，于是它们**永远**落进 `android`；
 *    而 `assertUi.target` 是**字符串引用**，`target:'ios'`（一个叫 ios 的元素）
 *    会被读成"这条场景要 iOS 设备"。一个是漏、一个是凭空多，两条都在第 2 条测试里钉着。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  LEASE_REQUIRED, STEP_TARGET, STEP_KINDS, StepSchema, deriveNeedsDevice, deriveTargets, flatten,
  parseScenario, targetSources, targetsOfStep, withDerivedTargets, type ScenarioDraft, type Step, type TargetKind,
} from '../src/index.js';

const ALL_KINDS = STEP_KINDS as readonly Step['kind'][];
const LOC = { intent: 'x', primary: { by: 'css', value: 'a' } };

/**
 * 每个 kind 一个**能过 schema** 的最小合法样本。
 *
 * 为什么非要过 schema：不校验的话，字段名写错的 fixture 照样能被判（walk 只认字段名），
 * 于是这条测试会在"IR 里根本不存在的对象"上通过、在真对象上失败 —— 等于白写。
 * （本轮第一版就是十个样本过不了 schema，而失败信息是 zod 的一句 `Invalid input`，
 *  看不出是哪个字段 —— 所以这里把"过不了 schema"直接翻译成带 kind 的错误。）
 *
 * 清单从 `STEP_KINDS` 现取，所以"新增一个 kind 而这里没样本"当天就红。
 */
const SAMPLE: Record<string, unknown> = {
  sequence: { id: 'k_seq', kind: 'sequence', steps: [{ id: 'c1', kind: 'noop' }] },
  if: { id: 'k_if', kind: 'if', condition: '1 == 1', then: [{ id: 'c2', kind: 'noop' }], else: [] },
  switch: { id: 'k_swch', kind: 'switch', value: 'x', cases: [{ is: 1, steps: [{ id: 'c3', kind: 'noop' }] }], default: [] },
  forEach: { id: 'k_fe', kind: 'forEach', items: 'xs', as: 'x', maxIterations: 2, steps: [{ id: 'c4', kind: 'noop' }] },
  while: { id: 'k_wh', kind: 'while', condition: '1 == 1', maxIterations: 2, steps: [{ id: 'c5', kind: 'noop' }] },
  repeat: { id: 'k_rp', kind: 'repeat', times: 2, steps: [{ id: 'c6', kind: 'noop' }] },
  parallel: { id: 'k_pl', kind: 'parallel', steps: [{ id: 'c7', kind: 'noop' }] },
  call: { id: 'k_call', kind: 'call', scenarioRef: 'scn.x@1' },
  wait: { id: 'k_wt', kind: 'wait', condition: { type: 'expr', expr: '1 == 1' }, timeoutMs: 500 },
  sleep: { id: 'k_sleep', kind: 'sleep', ms: 1 },
  set: { id: 'k_set', kind: 'set', assign: { a: 1 } },
  extract: { id: 'k_ex', kind: 'extract', from: '$k_http', rules: [{ var: 'v1', path: '$.id' }] },
  table: { id: 'k_tb', kind: 'table', rows: [{ a: 1 }] },
  dataSource: { id: 'k_ds', kind: 'dataSource', source: { type: 'mysql', datasource: 'd', sql: 'select 1' }, as: 'rows' },
  script: { id: 'k_sc', kind: 'script', lang: 'ts', code: 'export default 1' },
  http: { id: 'k_http', kind: 'http', request: { method: 'GET', url: 'https://x/' } },
  openapiCall: { id: 'k_oac', kind: 'openapiCall', docRef: 'd', operationId: 'op' },
  navigate: { id: 'k_nav', kind: 'navigate', url: 'https://x/' },
  act: { id: 'k_act', kind: 'act', action: 'click', locator: LOC },
  capture: { id: 'k_cap', kind: 'capture', mode: 'screenshot' },
  device: { id: 'k_dev', kind: 'device', target: 'android' },
  app: { id: 'k_app', kind: 'app', action: 'launch', package: 'com.x' },
  tap: { id: 'k_tap', kind: 'tap', target: LOC },
  input: { id: 'k_in', kind: 'input', value: 'a' },
  swipe: { id: 'k_sw', kind: 'swipe', from: [1, 1], to: [2, 2] },
  key: { id: 'k_key', kind: 'key', key: 'enter' },
  watcher: { id: 'k_wa', kind: 'watcher', rules: [{ match: { text: 'ok' } }] },
  logcat: { id: 'k_lc', kind: 'logcat', filter: 'x' },
  assert: { id: 'k_as', kind: 'assert', against: '$a', jsonPath: { $: { eq: 1 } } },
  assertLlm: { id: 'k_al', kind: 'assertLlm', question: '这个响应看起来对吗', evidenceFrom: '$a' },
  assertPerf: { id: 'k_apf', kind: 'assertPerf', against: '$a', lte: 100 },
  assertPage: { id: 'k_ap', kind: 'assertPage', assertKind: 'url', expected: 'x' },
  assertUi: { id: 'k_au', kind: 'assertUi', assertKind: 'visible', target: 'x' },
  db: { id: 'k_db', kind: 'db', datasource: 'd', sql: 'select 1' },
  log: { id: 'k_log', kind: 'log', message: 'm' },
  fail: { id: 'k_fail', kind: 'fail', reason: 'r' },
  noop: { id: 'k_noop', kind: 'noop' },
  manualHandoff: { id: 'k_mh', kind: 'manualHandoff', reason: '插上设备' },
  useIdentity: { id: 'k_ui', kind: 'useIdentity', name: 'u' },
};

const parsed = (kind: string): Step => {
  const raw = SAMPLE[kind];
  assert.ok(raw, `STEP_KINDS 里的 ${kind} 在本文件的样本表里没有条目 —— 补样本，别改这条测试`);
  try {
    return StepSchema.parse(raw) as Step;
  } catch (e) {
    // zod 在 union 上只给一句 Invalid input，看不出是哪个 kind 的哪个字段
    throw new Error(`样本 "${kind}" 过不了 StepSchema（样本自己错了，不是被测代码）：${String((e as Error).message).slice(0, 300)}`);
  }
};

/** 把样本换成某个 target 再解析（解析不过就说明那个 kind 的 target 不是平台字段——这本身就是要测的事实） */
const withTarget = (kind: string, target: unknown): Step | undefined => {
  const raw = SAMPLE[kind] as Record<string, unknown>;
  const r = StepSchema.safeParse({ ...raw, target });
  return r.success ? (r.data as Step) : undefined;
};

test('每个 kind 的 targetsOfStep 与 STEP_TARGET 那张权威表逐条一致', () => {
  /*
   * 这条是"两个问法同一个判据"里**面向表**的那一半。
   * 期望值从 STEP_TARGET 现取，不手抄 —— 手抄的话我抄错什么它就钉错什么。
   *
   * ⚠ mobile 那一档本轮起**不再要求"恰好一个端"**（下面那个 else 分支对它跳过长度断言）。
   * 跳过的是"数量"，不是"这一档"：非 mobile 的 kind 照样必须给且只给一个端，
   * 而 mobile 那一档给什么由下面那条逐 kind 的测试钉（只有 device 报平台、其余报空）。
   * 为什么不能让它继续要求长度 1：那份要求会把"替 tap 猜一个 android"写成契约 ——
   * 而猜出来的那一端正是本轮修的缺陷本体。
   */
  for (const kind of ALL_KINDS) {
    const s = parsed(kind);
    const got = targetsOfStep(s);
    const table = STEP_TARGET[kind];
    if (table === 'any') {
      assert.deepEqual(got, [], `${kind} 在表里是 any（自己不需要任何端），实际给了 ${JSON.stringify(got)}`);
    } else if (table === 'mobile') {
      // 这一档报的必须是"平台里的某一个"或"什么都不报"，不许报出 api/web 这种跨档的端
      for (const t of got) {
        assert.ok(['android', 'ios', 'harmony'].includes(t),
          `${kind} 属于 mobile 档却报了 ${t}：档位与端对不上`);
      }
      assert.ok(got.length <= 1, `${kind} 一个步骤不可能同时要多端：${JSON.stringify(got)}`);
    } else {
      assert.equal(got.length, 1, `${kind} 应该只给出一个端：${JSON.stringify(got)}`);
      assert.deepEqual(got, [table], `${kind} 表里是 ${table}，targetsOfStep 给 ${JSON.stringify(got)}`);
    }
  }
  /*
   * 反向的一半（本轮补）：mobile 那一档里**只有 device 真的报端**。
   * 上面那个循环对非 mobile 档能抓出"报错档"，对 mobile 档却抓不出"凭空报一个"，
   * 因为 android 本身就是合法的平台词。所以这一格得单独数：
   * 谁报了端，只许是 device。少了这一格，"给 tap 加一个默认 ios"这种改动能全绿通过。
   */
  const reporting = ALL_KINDS
    .filter((k) => STEP_TARGET[k] === 'mobile')
    .filter((k) => targetsOfStep(parsed(k)).length > 0);
  assert.deepEqual(reporting, ['device'],
    `mobile 那一档里会报端的 kind 只该是 device（平台只有它说得出），实际 ${JSON.stringify(reporting)}。`
    + ' 多出来 => 有人又开始替别的步骤猜平台了（本轮修的缺陷：猜出来的 android 会让纯 iOS 场景多要一台安卓机）；'
    + ' 空了 => device 那一支断了，iOS 场景会一个端都不报。');
});

test('mobile 那一支只读 device.target：其余 mobile 步骤**什么都不报**', () => {
  /*
   * `targetsOfStep` 的 mobile 那一支从前读**任何叫 `target` 的字段**，而那一档里
   * 那个字段有三种互不相干的含义（本轮逐个量过，不是推的）：
   *
   * | kind | target 字段是什么 | 改前读成 | 现在 |
   * |---|---|---|---|
   * | `device` | **平台枚举** | 对（ios/harmony/android） | 不变 |
   * | `tap` / `input` / `key` / `swipe` | **LocatorSpec**（对象） | 落 android（凭空多） | 报空 |
   * | `assertUi` | **字符串引用**（`z.string()`） | `target:'ios'` => 要 iOS 设备 | 报空 |
   * | `app`/`swipe`/`watcher`/`logcat`/`manualHandoff` | 没有这个字段 | 落 android（凭空多） | 报空 |
   *
   * 为什么"报空"是正确答案而不是偷懒：这些步骤**确实要设备，但说不出要哪一端**。
   * 替它们猜一个 android 是把"我不知道"写成"我知道"，而写出来的那一端会被人当事实读
   * （前端那一栏直接画成「端 ios / android」）。"要不要设备"是另一个问题，
   * 由 `deriveNeedsDevice` 答 —— 两问两答才是这一格的本轮结论。
   *
   * 断言里刻意保留"改前是什么"，因为这几行是**这份文件唯一的读数记录**：
   * 只写"现在报空"的话，下一个人无从知道这是修好的还是本来就这样。
   */
  const ios = withTarget('device', 'ios');
  assert.ok(ios, 'device 带 target=ios 必须能过 schema（否则这条测试连被测对象都没有）');
  assert.deepEqual(targetsOfStep(ios), ['ios'], 'device 的 target 真的是平台，被正确细分');
  const harmony = withTarget('device', 'harmony');
  assert.ok(harmony);
  assert.deepEqual(targetsOfStep(harmony), ['harmony']);

  // tap.target 是定位器：写平台名过不了 schema，所以"tap 能分到 ios"是个假命题
  assert.equal(withTarget('tap', 'ios'), undefined, 'tap.target 是 LocatorSpec，不接受平台名');
  assert.deepEqual(targetsOfStep(parsed('tap')), [],
    '改前是 ["android"]（凭空多出的那一端就是本轮的缺陷本体）；现在报空：tap 要设备，但说不出哪一端');

  // assertUi.target 是**字符串引用**：'ios' 合法，改前会被读成平台
  const au = withTarget('assertUi', 'ios');
  assert.ok(au, '前提：assertUi.target 是 z.string()，任何字符串都合法（包括 "ios"）');
  assert.deepEqual(targetsOfStep(au), [],
    '改前是 ["ios"]：一个名叫 ios 的**元素引用**让整条场景声称需要 iOS 设备。现在报空');
  assert.deepEqual(targetsOfStep(parsed('assertUi')), [], '同一格换个引用名，改前落 android、现在也报空');

  // 全量扫一遍"哪些 kind 的 target 会被读成平台"，把上面那张表钉成判据而不是散文
  const mobileKinds = ALL_KINDS.filter((k) => STEP_TARGET[k] === 'mobile');
  assert.ok(mobileKinds.length >= 9, `mobile 那一档只有 ${mobileKinds.length} 个 kind？表变了就来看这条`);
  /*
   * 这里扫的仍是"**schema 让不让写**"（`withTarget(k,'ios')` 过不过），而不是"读不读"。
   * 两者今天不再相同，而那个**差别本身**就是这一格要钉的东西：
   * `assertUi.target` 依然可以写 'ios'（schema 没收紧），但已经没人读它了。
   */
  const writable = mobileKinds.filter((k) => withTarget(k, 'ios') !== undefined);
  assert.deepEqual(writable, ['device', 'assertUi'],
    `schema 上能写 target='ios' 的 mobile kind 应当只有这两个（device 是真平台、assertUi 是同名巧合的引用）。实际 ${JSON.stringify(writable)}。\n`
    + '  多出来 => IR 给别的移动端步骤加了叫 target 的字段，要回来看这一支会不会又撞上；\n'
    + '  少了 assertUi => 它的 target 收紧成定位器了，那个同名巧合的**根源**没了，'
    + '连着上面那句"改前是 [ios]"与 docs/14 §5 那一格一起改掉。');
  // 而"能写"不等于"被读"：这一句是本轮改动的全部要点，值得单独一行
  assert.deepEqual(mobileKinds.filter((k) => targetsOfStep(parsed(k)).length > 0), ['device'],
    '能写 ≠ 被读：只有 device 真的被读成平台');
});

test('deriveTargets 与"对 flatten 里每一步调 targetsOfStep"逐字相同（判据只有一份）', () => {
  /*
   * 本轮把 `deriveTargets` 里那段 inline 判据抽成了 `targetsOfStep`。
   * **"重构没改行为"这句话不许由我自己声明** —— 所以这里把等价关系写成判据：
   * 整段的端 == 逐步的端的并集（walk 覆盖嵌套与 switch 分支已由 kind-tables.test.ts 钉着）。
   * 两种问法分叉的表现：`needsWeb` 说"要建浏览器"而报错点名一批不需要浏览器的步骤
   * （或反过来点了个空的），而**两个函数各自看都自洽**。
   */
  const bodies: string[][] = [
    ['noop'],
    ['navigate'],
    ['app', 'assertPage'],
    ['http', 'assertUi'],
    ['device'],
    ['http', 'sequence', 'app'],
    ['if'], ['switch'], ['forEach'], ['while'], ['repeat'], ['parallel'],
  ];
  for (const kinds of bodies) {
    const steps = kinds.map(parsed);
    const union = new Set<TargetKind>();
    for (const s of flatten(steps)) for (const t of targetsOfStep(s)) union.add(t);
    assert.deepEqual(
      [...deriveTargets(steps)].sort(),
      [...union].sort(),
      `整段与逐步的并集分叉（步骤：${kinds.join('、')}）`,
    );
  }
});

test('targetSources **不点名容器**：容器自己没有端，需要浏览器的是它里面那一步', () => {
  /*
   * 本轮真实翻车的地方。第一版写 `deriveTargets([s]).includes('web')`，
   * 而那个函数会 walk 进子步骤，于是 sequence 也被列进"Web 需求来源"。
   * 报错于是说「Web 需求来自这些步骤：sequence（seq1）、navigate（n2）」——
   * 一句**精确的错指责**，比原先那句含糊的话更容易让人去改错的东西
   * （人会去看那个 sequence 为什么在这，而它什么都没错）。
   */
  const nested = [StepSchema.parse({
    id: 'outer', kind: 'sequence',
    steps: [StepSchema.parse(SAMPLE.navigate), StepSchema.parse(SAMPLE.capture)],
  }) as Step];
  const src = targetSources(nested, 'web');
  assert.deepEqual(src.map((s) => s.what), ['navigate', 'capture'], `容器不该出现在名单里：${JSON.stringify(src)}`);
  assert.deepEqual(src.map((s) => s.chain), [['outer', 'k_nav'], ['outer', 'k_cap']], 'chain 要说得出它在哪个容器里');
  // 顺序 = 遍历顺序（"第一个响的通常就是根因"，重排会把根因埋进中间）
  assert.equal(src[0]!.at, 'k_nav');
});

test('targetSources 与 deriveTargets 双向对得上：说得出来源，也不无中生有', () => {
  /*
   * 两个方向都钉，因为它们各自的失效不同：
   *  - **deriveTargets 说有 web 而 targetSources 给空** => 报错点名一个空清单
   *    （"Web 需求来自这些步骤："后面什么都没有），读的人拿到一个更没用的信号；
   *  - **targetSources 报了而 deriveTargets 说不需要** => 点了不该点的步骤。
   * 判据从 STEP_KINDS 现取全量遍历，不挑几个样本 —— 挑样本就是赌"我挑的那些形状全"。
   */
  for (const kind of ALL_KINDS) {
    const s = parsed(kind);
    // 容器跳过：deriveTargets([容器]) 含子步骤的端而容器自己不含，那是上面那条在管的事
    if (STEP_TARGET[kind] === 'any') continue;
    for (const t of ['api', 'web', 'android', 'ios', 'harmony'] as TargetKind[]) {
      const needed = deriveTargets([s]).includes(t);
      const named = targetSources([s], t);
      assert.equal(named.length > 0, needed,
        `${kind} 在端 ${t} 上两个问法不一致：deriveTargets=${needed}，targetSources=${JSON.stringify(named)}`);
      if (named.length) assert.equal(named[0]!.at, s.id, `${kind} 该点名自己`);
    }
  }
  // 正向对照：误写 assertPage 的那个真实形状 —— 名单里只该有它
  const mixed = [SAMPLE.app, SAMPLE.assertPage].map((b) => StepSchema.parse(b) as Step);
  assert.ok(deriveTargets(mixed).includes('web'));
  assert.deepEqual(targetSources(mixed, 'web').map((x) => `${x.what}@${x.at}`), ['assertPage@k_ap'],
    '纯 app 场景里唯一的 Web 来源就是那条误写的 assertPage');
});

test('iOS 场景的 targets 只有 ios：那个多余的 android 是本轮删掉的（登记里那句"这是一次迁移"量下来不成立）', () => {
  /*
   * 这一格从前是一条**钉子**，标题写着「【当前行为，等版本表/迁移一起改】…会多出一个 android」，
   * 里面列了三条"今天不咬人"的理由和一条"改它 = 改所有已冻结场景的 irSha，那是一次迁移"。
   * 本轮把那条前提**逐条量了一遍**（`.scratch/probe-irsha-migration.mts`，四个读数 A/B/C/D）。
   * 前两条今天仍然成立，第三条**说反了方向**：
   *
   *  1. `needsWeb` 只看 `includes('web')` —— **仍然成立**，本轮那一支一个字没动；
   *  2. `dryrun.ts` 的 `estimate.needsDevice` 读那个冗余字段 —— **本轮改掉了**，
   *     而它同时暴露出第二个缺陷：那个字段只从 `body` 推，所以"device 在 setup、
   *     tap 在 body"这种**最常见**的移动端写法它答"不要设备"（探针读数 D：
   *     `scenario.targets` 是 `[]` → 改前 `needsDevice=false`，面板上就写着"不要设备"，
   *     而那份场景要一台 iOS 机）。判据换成 `deriveNeedsDevice`（见那条）；
   *  3. 「改它 = 一次迁移」这句**把两件不同的事混成了一件**。量出来的四个读数：
   *     - **A**：全仓被 git 跟踪的 IR 文件只有 `examples/demo/cases/*.json` 三份，
   *       而它们**都显式写了 `targets`** —— `withDerivedTargets` 对写了的目标直接返回，
   *       所以改推导函数对**这三份**一个字节都不改；
   *     - **B**：被 git 跟踪、且含 `"irSha"` 键的文件 = **0 个**。证据清单写在
   *       `.gitignore` 的 `evidence/` 里，所以今天没有任何一份**落盘而可比**的 irSha；
   *     - **C**：同一份 frozen 场景（不写 targets 的那种），旧算法 `["ios","android"]` →
   *       `adf16ee2…`，新算法 `["ios"]` → `9d1e8bbc…`。**sha 确实会变**，
   *       而除 targets 外其余字段逐字相同 —— 所以"漂移"这件事本身是真的；
   *     - 且全仓**没有任何一处代码比较两个 irSha**（grep `irSha ===` 一类为空），
   *       P1 版本表（那个真正"按 irSha 去重"的消费者）在 `packages/store` 里
   *       **压根没有实现**（那里只有 artifacts/evidence/ir-hash/zip 四个模块）。
   *
   * 所以准确的说法不是"改它不产生迁移"，而是：**sha 会变，但今天没有任何东西会因为它变而坏掉**
   * —— 没有历史值可比、没有比较者、没有按它去重的表。登记那句把"会变"（真）
   * 直接当成了"会变所以不能动"（假，因为无物可坏），于是一个不可动的前提建立在一个
   * 还不存在的消费者上；而它挡住的是**三个人此刻在读的假事实**：
   * 前端场景列表那一栏（`app.ts` 直接 `targets.join(' / ')`）把纯 iOS 场景画成
   * 「端 ios / android」，`dryrun` 的 `estimate.targets` 回显同一个假端，
   * 而 `deriveTargets` 说有 android、`targetSources(…,'android')` 给空 ——
   * **两个问法当时互相打脸**（下面那两句断言钉的就是这一对）。
   *
   * ⚠ 这一条**不是**说"irSha 稳定性不重要"。`canonicalScenario` 那四条规则（尤其规则 3
   *   "不补默认值"）本轮一条都没动，历史证据里那些旧读数也不回填 ——
   *   改的是**推导函数**，不是哈希算法。老证据写着 `["android","ios"]` 是**旧版算法的正确答案**，
   *   它仍然能回答"这份证据出自哪一版"（同一个 sha 找到同一份 IR），
   *   只是那一版算法会把 tap 猜成安卓机。这跟"同一份内容算出两个 sha"是两回事，
   *   后者才是规则 3 防的事故。**等 P1 版本表落地（那时才有"按 irSha 去重"这个真读者），
   *   这一格的前置条件就要重新量一次** —— 所以下面那条守卫盯着的不是这个数，
   *   是"这些前提还成不成立"。
   *
   * 这一格现在断的是**修好之后的行为**。它还是那条会红的钉子，只是方向反了：
   * 谁再把 mobile 那一支改回"替非 device 步骤猜一个端"，它立刻红。
   */
  const iosScenario = [
    { id: 'd', kind: 'device', target: 'ios' },
    { id: 't', kind: 'tap', target: LOC },
    { id: 'a', kind: 'assertUi', assertKind: 'visible', target: 'x' },
  ].map((b) => StepSchema.parse(b) as Step);
  assert.deepEqual([...deriveTargets(iosScenario)], ['ios'],
    '一份纯 iOS 场景只该报 ios。改前是 ["ios","android"]：多的那个来自 tap/assertUi 被替它们猜出来的那一端');
  // 而"因为谁"这一侧一直是**准的**：它从来没替那个多余的 android 编过一个来源
  assert.deepEqual(targetSources(iosScenario, 'ios').map((s) => s.at), ['d'],
    'ios 的来源只有 device 那一步（这才是 targetSources 存在的意义）');
  assert.deepEqual(targetSources(iosScenario, 'android'), [],
    '反过来也不许无中生有：改前 deriveTargets 说有 android 而这里给空 —— 两个问法当时是**互相打脸**的，那正是 targetSources 那套"共用判据"要防的形状，而共用判据当时把错也一起共用了');
});

describe('deriveNeedsDevice：要设备 ≠ 要哪一端', () => {
  /*
   * 这个函数是本轮从"lint 那道前置过滤差点被改成静默"里抽出来的（那个形状的实测读数
   * 在 `engine/test/lease-scope.test.ts` 的「前置过滤不许比报错那一格窄」）。
   * 放在 ir 侧测的理由：判据住在 ir，而 engine 侧那条测的是"接线对不对"，
   * 两边各钉各的层面 —— 与 `docs/14` §4 那套"判据在引擎、供数在 adapter"同一分层。
   */
  const kinds = (ks: string[]): Step[] => ks.map((k) => parsed(k));

  test('漏写 device 步的裸 tap：targets 是空集而 needsDevice 是 true（这一格就是那个缺陷的形状）', () => {
    const bare = kinds(['tap']);
    assert.deepEqual(deriveTargets(bare), [],
      '端集合里确实没有 android 了 —— 派生判据到这一步会说"不要设备"');
    assert.equal(deriveNeedsDevice(bare), true,
      '而它百分百要设备。这两个读数**必须同时成立**：只有前者成立就是那个静默缺陷');
  });

  test('setup 里 device + body 里 tap：needsDevice 与端集合都答对（改前冗余字段答"不要设备"）', () => {
    // 这个形状就是 dryrun 那个缺陷的本体：`targets` 只从 body 推，body 里只有 tap，
    // 而 tap 现在（正确地）不报端 —— 所以任何"从端集合派生 needsDevice"的写法
    // 对这个**最常见的移动端写法**都会答 false。
    assert.equal(deriveNeedsDevice(kinds(['tap'])), true);
    assert.deepEqual(deriveTargets(kinds(['tap'])), []);
  });

  test('逐 kind 对照：needsDevice 是 LEASE_REQUIRED 的超集（少了这一格，加个移动端 kind 忘了登记就会静默）', () => {
    /*
     * 为什么必须是**逐个 kind 扫**而不是挑几个样本：这条要钉的是两张表的关系，
     * 而"漏一个 kind"恰恰是样本扫不出来的那种坏 ——
     * 新增一个移动端 kind 而忘了加进 LEASE_REQUIRED，会让 lint 那条闸对它永不响，
     * 而所有已有样本照旧全绿。
     *
     * 判据方向要说准：**超集**才允许当前置过滤。
     *   needsDevice(kind) == true  ⊇  LEASE_REQUIRED.includes(kind)
     * 差集（要设备但不需要租约）今天是且仅是一个已知集合 —— 显式写死，
     * 这样"多出一个差集成员"会红，而不是被 every 那一句默默放过。
     */
    const mobileKinds = ALL_KINDS.filter((k) => STEP_TARGET[k] === 'mobile');
    assert.ok(mobileKinds.length >= 9, `mobile 档只有 ${mobileKinds.length} 个 kind？表变了就来看这条`);
    for (const k of ALL_KINDS) {
      const needs = deriveNeedsDevice([parsed(k)]);
      const requires = LEASE_REQUIRED.includes(k as never);
      assert.ok(!requires || needs,
        `${k} 在 LEASE_REQUIRED 里（要租约）却被 deriveNeedsDevice 答成不要设备：前置过滤会把它整条跳过 = 静默漏报`);
      assert.equal(needs, STEP_TARGET[k] === 'mobile', `${k}：needsDevice 应当严格等于"属于 mobile 档"`);
    }
    const noLease = mobileKinds.filter((k) => !LEASE_REQUIRED.includes(k as never)).sort();
    assert.deepEqual(noLease, ['device', 'watcher'],
      `要设备但不要租约的 kind 今天只有这两个：device 是租约的**来源**，watcher 跑在别的步骤挣来的那台上。`
      + `实际 ${JSON.stringify(noLease)}。\n  多出来 => 新增的移动端 kind 没登记进 LEASE_REQUIRED，`
      + 'lint 那条 RESOURCE_LEASE_MISSING 对它永不响（运行时却要求租约 = 静态闸与运行事实分叉）；\n'
      + '  少了 => 有人把 device/watcher 加进租约名单了，去确认那件事是不是真换了语义。');
  });

  test('容器里的移动端步骤也算要设备（walk 走嵌套与 switch 分支）', () => {
    /*
     * 这一格防的是"顺手写成 scenario.body.some(...)"：那种写法只看顶层，
     * 而 `parallel`/`if`/`switch` 里的 tap 一样要机器。
     * 用 switch 而不是只用 sequence，是因为 CHILD_KEYS 不含 `cases[].steps`，
     * 那一段是 walk 里**单独一段代码**在管（`steps.ts` 那个 walk 的 cases 分支）——
     * 只测 sequence 的话，那条分支坏了这条照样绿。
     *
     * 夹具一律从本文件那张 SAMPLE 表上改出来，不另写形状：第一版我照记忆写了
     * `switch{expression, cases[].when}`，而真的 schema 是 `value` / `cases[].is`，
     * 于是 StepSchema.parse 直接抛 —— 一个测不出任何东西的 fixture 比没夹具更坏，
     * 它会让人以为"walk 的 cases 分支有人测过"。
     */
    const sw = StepSchema.parse({
      ...(SAMPLE.switch as Record<string, unknown>),
      cases: [{ is: 1, steps: [SAMPLE.tap] }],
    }) as Step;
    assert.equal(deriveNeedsDevice([sw]), true, 'switch 分支里的 tap 也要机器');
    // parallel 的一"段"是 steps 里的**一个元素**（一支分支），不是整个数组
    const par = StepSchema.parse({ ...(SAMPLE.parallel as Record<string, unknown>), steps: [SAMPLE.tap] }) as Step;
    assert.equal(deriveNeedsDevice([par]), true, 'parallel 分支里的 tap 也要机器');
    const seq = StepSchema.parse({ ...(SAMPLE.sequence as Record<string, unknown>), steps: [SAMPLE.tap] }) as Step;
    assert.equal(deriveNeedsDevice([seq]), true, 'sequence 里的 tap 也要机器');
    // 反向对照：纯 http 场景不许被误判成要设备（否则每条 API 用例都要去抢一台机器）
    assert.equal(deriveNeedsDevice(kinds(['http', 'navigate', 'assert'])), false);
    // 而"容器里全是非移动端步骤"也不许误判（walk 走得进去不等于无条件为真）
    const seqHttp = StepSchema.parse({ ...(SAMPLE.sequence as Record<string, unknown>), steps: [SAMPLE.http] }) as Step;
    assert.equal(deriveNeedsDevice([seqHttp]), false, '容器里有 http 不等于要设备');
  });
});

describe('withDerivedTargets：冗余字段的两个判据（显式优先 + 三层）', () => {
  /*
   * 这个函数只有四行，而它决定的是**所有人看到的那一栏**：
   * `server` 把 `scenario.targets` 直接回给前端画成「端 x/y」，`dryrun` 的
   * `estimate.targets` 回显同一个值。它有两条判据，本轮之前两条都坏：
   *  - 推的只有 `body`（"device 在 setup + tap 在 body"这份**推荐写法**推出空集）；
   *  - 更麻烦的是"显式优先"那一条**一个测试都没有** —— 本轮实测过：
   *    把 `if (draft.targets !== undefined) return draft;` 整句删掉，
   *    **全仓 1678 条测试全绿**（`.scratch/probe-explicit-targets.mts`，
   *    永久落点就是下面第一条）。一个删掉无人发现的判据，等于一个没写的判据，
   *    而它的坏法很安静：屏幕上那一栏与 IR 文件不一致，谁都不会当场报错。
   */
  const draft = (extra: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: '1', id: 'scn.wdt', name: 'wdt', env: { environmentRef: 'unit' },
    body: [SAMPLE.http], ...extra,
  });
  const targetsOf = (d: Record<string, unknown>): unknown =>
    (withDerivedTargets(d as ScenarioDraft) as { targets?: unknown }).targets;

  test('显式写了 targets 就以它为准（多出来的一端不许被推导抹掉，明确的空也不算"没写"）', () => {
    /*
     * 这一条守的是**语义**而不是形状：写下来的 `targets` 是作者在**声明能力**
     * （"这条还要一台 iOS 机做对照"、"这条要能碰生产端"），比从步骤推出来的强。
     * 推导覆盖它会有两个坏处：
     *  1. 屏幕上那一栏与 IR 文件不一致，而 IR 是唯一真相源；
     *  2. 装配期按端建 adapter 的那一侧会少建一个 —— 用例跑到那一步才炸，
     *     而报错写的是"没有可用的 web adapter"这类与真实原因（有人覆盖了声明）无关的话。
     *
     * 两个方向都要断：只断"写了就保留一个多出来的端"，那么"永远用推导覆盖"这一种坏法
     * 会在**另一格**被放掉（推出来的恰好是子集时看不出问题）；所以第二条用
     * `targets: []`（作者明确说"什么都不要"）配一个会推出 api 的 body。
     */
    assert.deepEqual(targetsOf(draft({ targets: ['api', 'ios'] })), ['api', 'ios'],
      '声明里多出来的那一端不许被推导抹掉（步骤推不出 ios，而作者说了要）');
    assert.deepEqual(targetsOf(draft({ targets: [] })), [],
      '而明确写了"空"也不许被推导填上 —— 同一句提前返回的两个方向');
    // 并且它是**真的接线**，不只是这个函数自己正确：走一遍 parseScenario
    const parsedScenario = parseScenario(draft({ targets: ['api', 'ios'] }));
    assert.ok(parsedScenario.ok && parsedScenario.scenario, '夹具本身要合法，否则上面那些断言在测空气');
    assert.deepEqual(parsedScenario.scenario?.targets, ['api', 'ios'],
      'parseScenario 没接上这句提前返回的话，上面两条只是自说自话');
  });

  test('没写 targets 时按**三层**推（本轮改的那一行；改前只看 body）', () => {
    /*
     * 这一条与 dryrun 那条「缺陷 1」是同一个根因的两个载体：这里钉**推导**，
     * 那边钉**人看的那一栏**。变异 T11 打的就是本行下面这一句，
     * 它红在 dryrun 那一侧而不是这里 —— 两个载体各有一条，所以两侧都不会单独坏掉。
     */
    const d = draft({ setup: [SAMPLE.device] });
    assert.deepEqual(targetsOf(d), ['android', 'api'],
      'setup 里的 device 也是这条场景要端的原因（改前这里是空集，屏幕上就写着空）。\n  '
      + '顺序是遍历顺序 setup → body → teardown，所以 android 在 api 前面。');
    const d2 = draft({ teardown: [{ ...(SAMPLE.navigate as Record<string, unknown>), id: 'k_nav_teardown' }] });
    assert.deepEqual(targetsOf(d2), ['api', 'web'], 'teardown 同理');
  });

  test('书写形态里 setup/teardown 可能是 undefined（本函数跑在 schema **之前**）', () => {
    /*
     * `.default([])` 要等 schema 跑完才存在，而这个函数的用处正是"parse 之前给草稿补值"。
     * 所以它必须扛住 undefined。这一条看着像废话，但它挡的是一个具体的手滑：
     * 有人把 `Array.isArray(a) ? a : []` 简写成 `a ?? []` 之外的写法（比如直接 spread）
     * 会在 undefined 上抛 TypeError —— 而那发生在**所有**没写 setup 的草稿上。
     */
    assert.deepEqual(targetsOf({ schemaVersion: '1', id: 's', name: 'n', env: { environmentRef: 'u' }, body: [SAMPLE.http] }), ['api']);
    assert.doesNotThrow(() => targetsOf(draft({ setup: undefined, teardown: undefined })));
    // 而不是把 undefined 变成"什么都不推"：非数组的脏输入要跳过而不是崩，也不牵连别的层
    assert.deepEqual(targetsOf(draft({ setup: '不是数组' })), ['api'],
      '脏的一层跳过，另一层照常推 —— 一个字段写错不该让整栏变空');
  });
});
