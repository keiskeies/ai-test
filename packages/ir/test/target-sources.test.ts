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
import { test } from 'node:test';

import {
  STEP_TARGET, STEP_KINDS, StepSchema, deriveTargets, flatten,
  targetSources, targetsOfStep, type Step, type TargetKind,
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
   */
  for (const kind of ALL_KINDS) {
    const s = parsed(kind);
    const got = targetsOfStep(s);
    const table = STEP_TARGET[kind];
    if (table === 'any') {
      assert.deepEqual(got, [], `${kind} 在表里是 any（自己不需要任何端），实际给了 ${JSON.stringify(got)}`);
    } else {
      assert.equal(got.length, 1, `${kind} 应该只给出一个端：${JSON.stringify(got)}`);
      if (table !== 'mobile') {
        assert.deepEqual(got, [table], `${kind} 表里是 ${table}，targetsOfStep 给 ${JSON.stringify(got)}`);
      }
    }
  }
});

test('mobile 那一支读 target 的**实际范围**：device 是对的，assertUi 是误读', () => {
  /*
   * `targetsOfStep` 的 mobile 那一支读 `s.target`，注释从前写着"靠 s.target 再细分"，
   * 读起来像所有移动端步骤都能分。本轮实测（不是推断）：
   *
   * | kind | target 字段是什么 | 读成平台之后 |
   * |---|---|---|
   * | `device` | **平台枚举**（android/ios/harmony） | 对 |
   * | `tap` / `input` / `key` | **LocatorSpec**（点哪个元素，是个对象） | 对象永远不等于 'ios' => 落 android |
   * | `assertUi` | **字符串引用**（指向哪个步骤的输出，schema 是 `z.string()`） | **`target:'ios'` 会被当成"这条场景要 iOS 设备"** |
   * | `app`/`swipe`/`watcher`/`logcat`/`manualHandoff` | 没有这个字段 | 落 android |
   *
   * 两个方向的坏都在：`tap` 那一族是**漏**（真 iOS 场景多出一个 android），
   * `assertUi` 那一格是**凭空多**（一个叫 `ios` 的**元素引用**让场景看起来要 iOS 设备）。
   * 后者更隐蔽：`target` 是引用，作者写 `target: '$ios'` 或 `target: 'ios'`
   * 指的是"iOS 那个按钮"，与设备端无关。
   *
   * 所以这一支的正确读法是"**只有 device.target 是平台**，其余是被同名巧合撞上的字段"。
   * 本轮只把判据抽成一份 + 让报错说得出来源，**不改这一支的行为**：
   * `deriveTargets` 的输出进了 `canonicalScenario`，改它 = 改所有已冻结场景的 irSha，
   * 那是一次迁移（wiring.ts 里"那是一次迁移而不是一个修复"说的就是这件事）。
   * 缺陷本体登记在 docs/14 §5，最后那条测试钉住当前行为以便改动时必红。
   */
  const ios = withTarget('device', 'ios');
  assert.ok(ios, 'device 带 target=ios 必须能过 schema（否则这条测试连被测对象都没有）');
  assert.deepEqual(targetsOfStep(ios), ['ios'], 'device 的 target 真的是平台，被正确细分');
  const harmony = withTarget('device', 'harmony');
  assert.ok(harmony);
  assert.deepEqual(targetsOfStep(harmony), ['harmony']);

  // tap.target 是定位器：写平台名过不了 schema，所以"tap 能分到 ios"是假命题
  assert.equal(withTarget('tap', 'ios'), undefined, 'tap.target 是 LocatorSpec，不接受平台名');
  assert.deepEqual(targetsOfStep(parsed('tap')), ['android'], 'tap 只能落 android（真 iOS 场景因此多出一个 android）');

  // assertUi.target 是**字符串引用**：'ios' 合法，于是它会被读成平台 —— 这是误读，不是特性
  const au = withTarget('assertUi', 'ios');
  assert.ok(au, '前提：assertUi.target 是 z.string()，任何字符串都合法（包括 "ios"）');
  assert.deepEqual(targetsOfStep(au), ['ios'],
    '当前行为（缺陷）：一个名叫 ios 的**元素引用**让这条场景声称需要 iOS 设备');
  assert.deepEqual(targetsOfStep(parsed('assertUi')), ['android'], '同一格、换个引用名，又落回 android');

  // 全量扫一遍"哪些 kind 的 target 会被读成平台"，把上面那张表钉成判据而不是散文
  const mobileKinds = ALL_KINDS.filter((k) => STEP_TARGET[k] === 'mobile');
  assert.ok(mobileKinds.length >= 9, `mobile 那一档只有 ${mobileKinds.length} 个 kind？表变了就来看这条`);
  const readAsPlatform = mobileKinds.filter((k) => withTarget(k, 'ios') !== undefined);
  assert.deepEqual(readAsPlatform, ['device', 'assertUi'],
    `会被读成平台的 kind 应当只有这两个（device 是对的、assertUi 是误读）。实际 ${JSON.stringify(readAsPlatform)}。\n`
    + '  多出来 => IR 给别的移动端步骤加了 target，要回来看这一支；\n'
    + '  少了 assertUi => 它的 target 收紧成定位器了，**那条误读缺陷修好了**，'
    + '连着最后那条缺陷测试与 docs/14 §5 那一格一起改掉。');
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

test('【当前行为，等版本表/迁移一起改】iOS 场景的 targets 里会多出一个 android', () => {
  /*
   * 本轮写 targetSources 时**顺带量出来的独立缺陷**，不是本轮引入的
   * （本轮只是把那段 inline 判据原样抽成 targetsOfStep，等价性由上面那条钉着）。
   *
   * 一份真 iOS 场景（`device{target:'ios'}` + `tap` + `assertUi`）推出来是
   * `["ios","android"]`。多的那个 android 来自 tap 与 assertUi：
   * 它们属于 STEP_TARGET 的 mobile 档，而**没有平台可分**
   * （tap 的 target 是定位器、assertUi 压根没有 target），
   * 于是 targetsOfStep 的"其余落 android"那一支无条件命中。
   *
   * 为什么**今天没造成故障**、因而本轮不改判据：
   *  - `needsWeb` 只看 `includes('web')`，不受影响；
   *  - `lint.ts` 的 needsDevice 是 `.some([android,ios,harmony])`，多一个也算同一个人
   *    （而且它刻意不读这个冗余字段，现算三层）；
   *  - `dryrun.ts` 的 `estimate.needsDevice` **确实在读这个被污染的字段**，同样只
   *    `.some(...)`，而它回显的 `estimate.targets` 今天就会列出一个不存在的端 ——
   *    只是 `dryRun()` 还没有生产调用方。**"没人读"与"读的人还不存在"是两件事**，
   *    按平台分别申请设备的那个读者出现的那天，就是这条咬人的那天。
   *
   * 为什么本轮**不能**顺手改对：`canonicalScenario` 把 targets 一起序列化，
   * 改 deriveTargets 的输出 = 改所有已冻结场景的 irSha（wiring.ts 里
   * 那句"那是一次迁移而不是一个修复"说的就是这件事）。
   *
   * 所以这里**断言当前行为**：将来谁把 mobile 那一支改对（或给别的移动端步骤
   * 加了平台字段），这条会红 —— 那是它该有的结局，届时连同迁移一起把它改掉。
   */
  const iosScenario = [
    { id: 'd', kind: 'device', target: 'ios' },
    { id: 't', kind: 'tap', target: LOC },
    { id: 'a', kind: 'assertUi', assertKind: 'visible', target: 'x' },
  ].map((b) => StepSchema.parse(b) as Step);
  assert.deepEqual([...deriveTargets(iosScenario)].sort(), ['android', 'ios'],
    '当前行为：android 是多余的那个。这条若变红，说明 mobile 细分改对了 —— 连同 irSha 迁移一起处理');
  // 而"因为谁"这一侧是**准的**：它不会替那个多余的 android 编一个来源
  assert.deepEqual(targetSources(iosScenario, 'ios').map((s) => s.at), ['d'],
    'ios 的来源只有 device 那一步（这才是 targetSources 存在的意义）');
});
