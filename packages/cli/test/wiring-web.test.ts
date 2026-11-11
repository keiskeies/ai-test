/**
 * Web adapter 的**装配**测试（wiring.ts 里那段按需建 adapter 的逻辑）。
 *
 * 为什么单独测装配而不是只测 adapter：上一轮就是栽在这条缝上 ——
 * adapter 那一半写得再齐，**零调用方**就等于不存在（本仓把这个缺陷类
 * 叫"上半截很完整、下半截没人接"）。所以这几条测的全是"接上了没有"：
 * 什么条件会建、建不起来时报什么错、纯 API 场景会不会被连累。
 *
 * 全部**不起浏览器**：真浏览器路径由 adapter-web 的测试负责，
 * 这里要验的是判断与报错，用真浏览器反而验不到"没浏览器时怎么办"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsWeb } from '../src/wiring.js';
import { assemble, CliError, DocRegistry } from '../src/wiring.js';
import { parseScenario, type Scenario } from '@atest/ir';

// 夹具形态照 packages/cli/test/gate.test.ts：**env 只有 environmentRef**
// （envRevision 是运行参数不是场景字段），targets/mode/frozen 由 schema 补默认值。
// 这里的 targets 刻意不写：needsWeb 走的是 deriveTargets(body) 推导，
// 写死一个 'web' 会让"needsWeb 其实在读那个冗余字段"这种实现也通过
const base = {
  schemaVersion: '1' as const, id: 'scn.wiring', name: 'n',
  env: { environmentRef: 'unit' },
};
const step = (kind: string, extra: Record<string, unknown> = {}) => ({ id: `_${kind}`, kind, ...extra });
const scen = (steps: unknown[]): Scenario => {
  const r = parseScenario({ ...base, body: steps });
  if (!r.ok || !r.scenario) throw new Error(`夹具 IR 不合法：${r.errors.map((e) => `${e.path} → ${e.message}`).join('; ')}`);
  return r.scenario;
};

const savedBin = process.env.ATEST_BROWSER_BIN;
function withoutBrowser(fn: () => Promise<void> | void): Promise<void> | void {
  delete process.env.ATEST_BROWSER_BIN;
  const run = async () => { try { await fn(); } finally { if (savedBin !== undefined) process.env.ATEST_BROWSER_BIN = savedBin; } };
  return run();
}

test('needsWeb 认 Web 那一档；**assertPage 是 Web、assertUi 是移动端**', () => {
  assert.equal(needsWeb(scen([step('navigate', { url: 'https://x/' })])), true);
  assert.equal(needsWeb(scen([step('act', { action: 'click', locator: { intent: 'x', primary: { by: 'css', value: 'a' } } })])), true);
  // 这条是命名陷阱的看门人：名字更"通用"的那个 assertUi 属于**移动端**，
  // 把它当成 Web 的会白起一个浏览器，还会让移动端场景以为缺 ui adapter
  assert.equal(needsWeb(scen([step('assertPage', { assertKind: 'url', expected: 'x' })])), true, 'assertPage 该算 Web');
  assert.equal(needsWeb(scen([step('http', { request: { method: 'GET', url: 'https://x/' } })])), false);
  assert.equal(needsWeb(scen([step('log', { level: 'info', message: 'm' })])), false, '控制流/日志不该把浏览器拉起来');
});

test('容器里的 Web 步骤也算（只看顶层等于漏判）', () => {
  // switch 的 cases 走的是 CHILD_KEYS 之外的字段，**只有 IR 自己的 walk 认它**。
  // 这条就是防止将来有人把 needsWeb 换成"扫一遍 body 顶层"
  const nested = scen([
    { id: 'seq1', kind: 'sequence', steps: [step('navigate', { url: 'https://x/' })] },
  ]);
  assert.equal(needsWeb(nested), true, 'sequence 里的 navigate 也要拉起泡览器');
});

test('Web 步骤在 **setup / teardown** 里也算（改前只看 body，同一条断言换个数组换一整个世界）', () => {
  /*
   * docs/15 §3.6。改前 `needsWeb` 走的是 `deriveTargets(scenario.body)`，
   * 于是同一个 `navigate`：写在 body → 建 Web adapter；写在 setup → 不建，
   * 运行时才报"ui adapter 未注册"（探针实测那一步是 error）。
   *
   * 坏的不是"多判一次"，是**配置缺失换了出口**：本文件下面那条
   * "用到 Web 而没配浏览器 => 装配期报错"存在的理由写得很清楚 ——
   * 配置缺失不该以 env-unavailable 进步骤结论，因为流水线会照 CI_HINT 重试，
   * 而配置缺失重试一万次也不会好。setup-only 的写法把这条纪律绕过去了。
   *
   * **三层都要单独点一次**：body 由上面那条覆盖，setup/teardown 各是本条的新增面。
   * 只测 setup 的话，"顺手只加了 setup"这种半吊子改法能过 ——
   * teardown 里的 `capture`（收尾截图是很自然的写法）照样漏。
   */
  const nav = { id: 'nav1', kind: 'navigate', url: 'https://x/' };
  const at = (extra: Record<string, unknown>) => {
    const r = parseScenario({ ...base, body: [step('http', { request: { method: 'GET', url: 'https://x/' } })], ...extra });
    if (!r.ok || !r.scenario) throw new Error(`夹具 IR 不合法：${r.errors.map((e) => `${e.path} → ${e.message}`).join('; ')}`);
    return r.scenario;
  };
  assert.equal(needsWeb(at({ setup: [nav] })), true, 'setup 里的 navigate 也要拉起浏览器');
  assert.equal(needsWeb(at({ teardown: [nav] })), true, 'teardown 里的 navigate 也要拉起浏览器');
  // **反向对照**：没有 Web 步骤时三层都不该把浏览器拉起来
  // （否则"永远建 adapter"这种修法能骗过上面两句，而那条"纯 API 场景照跑"的
  //  用例是异步路径，单独靠它看不出 needsWeb 有没有被放宽成恒真）
  assert.equal(needsWeb(at({ setup: [step('log', { level: 'info', message: 'm' })], teardown: [step('sleep', { ms: 1 })] })), false,
    'setup/teardown 里的非 Web 步骤不该拉起浏览器');
});

test('用到 Web 而没配浏览器 => **装配期**报错并点名 ATEST_BROWSER_BIN', async () => {
  // 判据不是"抛了个错"，而是**错在哪一层**：
  // 让它以引擎的 env-unavailable 进退出码，流水线会照 CI_HINT 重试一次，
  // 而配置缺失重试一万次也不会好（commands.ts 里 requireAdapters 同一条理由）
  await withoutBrowser(async () => {
    const registry = await DocRegistry.load([]);
    await assert.rejects(
      () => assemble({
        scenario: scen([step('navigate', { url: 'https://x/' })]),
        env: {}, registry, evidenceDir: '/tmp/atest-wiring-test', clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
      }),
      (e: unknown) => {
        assert.ok(e instanceof CliError, `要是 CliError（配置错误），实际 ${(e as Error).name}: ${(e as Error).message}`);
        assert.match((e as Error).message, /ATEST_BROWSER_BIN/, '要指名该设哪个变量');
        // **不能把环境里其它变量当"值"回显**：这条命令跑在 CI 里，报错会进日志
        return true;
      },
    );
  });
});

test('一条**等待**问哪一世界，也拉动装配（改前整条场景只有一个界面等待时完全隐形）', async () => {
  /*
   * `needsWeb` **就是** `webSources(...).length > 0`（见 wiring.ts 那句注释），
   * 所以这一格真正测的是"装配侧能不能看见等待问的那一档"。
   *
   * 改前的形状（读数表在 `packages/ir/test/wait-worlds.test.ts` 文件头，
   * 那里逐条件量过 `needsWeb` 与真跑出来的结果）：`STEP_TARGET.wait` 是 `'any'`
   * 而 `targetsOfStep` 里没有任何一格读 `world`，于是**全场只有一条界面等待**的
   * 场景 `needsWeb` 恒 false ⇒ 不建浏览器 ⇒ 运行期抛 `NoConditionAdapter` /
   * `NoNetworkObserver` / `NoNewPageObserver`，归因 `env-unavailable`。
   * 那句话会进退出码，而 CI 照 `CI_HINT` 白重试一次 —— 装配期这句
   * 「设 ATEST_BROWSER_BIN」存在的**全部理由**就是把这件事挡在重试之前。
   *
   * **为什么不满足于 IR 侧那几条**：那边测的是判据本身，而判据到装配之间还隔着
   * `webSources` 那三层数组与 `targetSources` 的逐步判据。本仓为这一族记过多次账
   * （"每个消费者都各自正确，而对同一件事的假设互不相容"），所以这里从**装配出口**
   * 再问一次：`needsWeb` 与那句报错点名的 id 集合。
   */
  const LOC = { intent: 'x', primary: { by: 'css', value: 'a' } };
  const w = (condition: unknown, id = 'w1') => ({ id, kind: 'wait', condition, timeoutMs: 500 });

  // 硬需求那一侧：写了 web 的界面条件 + 只有浏览器看得见的两种观测口
  assert.equal(needsWeb(scen([w({ type: 'uiPredicate', target: LOC, world: 'web' })])), true,
    'wait{uiPredicate,world:"web"} 要浏览器（改前是 false）');
  assert.equal(needsWeb(scen([w({ type: 'template', target: LOC, world: 'web' })])), true);
  assert.equal(needsWeb(scen([w({ type: 'uiIdle', world: 'web' })])), true);
  assert.equal(needsWeb(scen([w({ type: 'response', urlPattern: '/api/x' })])), true,
    'response 恒要浏览器（它没有 world 可写，判据是接线事实）');
  assert.equal(needsWeb(scen([w({ type: 'newPage' })])), true);
  // 容器里的等待也算（needsWeb 走 walk，这条与上面那条"容器里的 Web 步骤"同一族）
  assert.equal(needsWeb(scen([{ id: 's1', kind: 'sequence', steps: [w({ type: 'uiPredicate', target: LOC, world: 'web' })] }])), true);
  // setup 里也算（三层数组那一格对本格同样成立）
  // setup 那一份要自己造（上面的 scen 夹具只接 body），否则"顺手只算了 body"这种半吊子改法能过
  const setupOnly = parseScenario({ ...base, body: [{ id: 'p', kind: 'noop' }], setup: [w({ type: 'newPage' })] });
  if (!setupOnly.ok || !setupOnly.scenario) throw new Error('夹具不合法');
  assert.equal(needsWeb(setupOnly.scenario), true, '等待写在 setup 里也要拉起浏览器');

  // **不许多报**：多报的代价是白起一个 Chrome（1~2s、几百 MB），
  // 而"没装 Chrome 的机器上纯 API / 纯移动端用例必须照跑"是按需装配存在的全部理由
  assert.equal(needsWeb(scen([w({ type: 'uiPredicate', target: LOC })])), false,
    '没写 world 不算硬需求 —— 这是本轮第一版写错的那一格（把纯安卓场景挡在装配期）');
  assert.equal(needsWeb(scen([w({ type: 'uiPredicate', target: LOC, world: 'mobile' })])), false,
    '问移动端的等待不许拉浏览器（它要的是一台机器，那是 deriveNeedsDevice 那一问）');
  assert.equal(needsWeb(scen([w({ type: 'expr', expr: '1 == 1' })])), false);
  assert.equal(needsWeb(scen([w({ type: 'dbRow', sql: 'SELECT 1' })])), false,
    'dbRow 要的是 db adapter，算成 web 会白起一个浏览器');

  // 报错点名：等待是"谁要浏览器"的答案里新出现的一种 kind，它必须说得出**是哪一步**，
  // 而 `world:'mobile'` 那一步不许被列成 web 需求来源（那是本轮从端集合里删掉的同一件坏事）
  const registry = await DocRegistry.load([]);
  let msg = '';
  await withoutBrowser(async () => {
    try {
      await assemble({
        scenario: scen([w({ type: 'newPage' }, 'waitNew'), w({ type: 'uiPredicate', target: LOC, world: 'mobile' }, 'waitDev')]),
        env: {}, registry, evidenceDir: '/tmp/atest-wiring-test',
        clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
      });
    } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  });
  assert.match(msg, /ATEST_BROWSER_BIN/, '仍然要指名该设哪个变量');
  assert.match(msg, /waitNew/, `要点名那条真要浏览器的等待：${msg}`);
  assert.ok(!/waitDev/.test(msg), `问移动端的那条不许被列成 web 需求来源：${msg}`);
});

test('报错点名"Web 需求来自哪几步"：容器不当罪名、截断要说出口', async () => {
  /*
   * docs/15 §3.3 五步链的第 3 步，本轮第一次量到：一份只有 `app` 步骤
   * + 一条**误写的** `assertPage` 的纯移动端场景，装配期报
   * 「本次场景用到 Web 步骤，但没配浏览器」—— 字面没错，而人会去装 Chrome，
   * 不会去想"我这个纯 app 场景里哪来的 Web 步骤"。
   * 现在文案要点名来源，并且：
   *  1. **只点真要 web 的步骤**。本轮第一版把容器的子步骤判据写成了
   *     `deriveTargets([s])`（那个函数会 walk 进子步骤），于是报错报出
   *     「sequence（seq1）、navigate（n2）」—— 一句**精确的错指责**比原先
   *     那句含糊的话更坏：含糊让人去查环境，精确的错指责让人去改无辜的用例。
   *     所以下面那条"真 web 场景"的正向对照里，`seq1` 只能以**父链**身份出现，
   *     不能以罪名出现（两种文本都含 `seq1`，所以判据写成"不能有 `sequence（seq1）`"）。
   *  2. **截断必须说出来**：一份列了 8 处的报告读起来像"就这 8 处"，
   *     而第 9 处很可能正是那条误写的那一条。
   *  3. 名字必须与 `needsWeb` 同判据（共用 ir 的 targetsOfStep）：
   *     分叉的表现是"报错点名的步骤里没有一个需要浏览器"，
   *     而两个函数各自看都自洽 —— 所以这里只能从**外部**比：
   *     报出的 id 集合 == 该场景里所有 web 档步骤的 id 集合。
   */
  const registry = await DocRegistry.load([]);
  const run = async (steps: unknown[]): Promise<string> => {
    let err: unknown;
    // withoutBrowser 只透传 Promise、不透传返回值，所以报错文本从这里往外带
    await withoutBrowser(async () => {
      try {
        await assemble({
          scenario: scen(steps),
          env: {}, registry, evidenceDir: '/tmp/atest-wiring-test',
          clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
        });
      } catch (e) { err = e; }
    });
    assert.ok(err instanceof CliError, `该抛 CliError，实际 ${err === undefined ? '没抛' : `${(err as Error).name}: ${(err as Error).message}`}`);
    const m = (err as Error).message;
    assert.match(m, /ATEST_BROWSER_BIN/, '仍然要指名该设哪个变量（点名来源不能顶掉这一句）');
    assert.equal((err as CliError).code, 4, '退出码仍是 ENV=4：改了文案不许改退出码');
    return m;
  };

  // ① 真实形状：纯 app 场景里那条误写的 assertPage
  const mis = await run([
    { id: 'dev1', kind: 'device', target: 'android' },
    { id: 'app1', kind: 'app', action: 'launch', package: 'com.x' },
    { id: 'ap1', kind: 'assertPage', assertKind: 'url', expected: 'x' },
  ]);
  assert.match(mis, /assertPage（ap1）/, `要直接点出那条误写的步骤：${mis}`);
  assert.ok(!/app（app1）|device（dev1）/.test(mis), `不许把无辜的移动端步骤列成 Web 需求来源：${mis}`);
  assert.match(mis, /assertUi/, `名单里有 assertPage 时，要给"你大概想写 assertUi"这条提示：${mis}`);

  // ② 正向对照：真 web 场景 + 容器 —— 罪名是里面那一步，容器只作为父链出现
  const real = await run([
    { id: 'seq1', kind: 'sequence', steps: [{ id: 'n2', kind: 'navigate', url: 'https://x/' }] },
  ]);
  assert.match(real, /seq1 > navigate（n2）/, `容器里的步骤要说得出在哪个容器里：${real}`);
  assert.ok(!/sequence（seq1）/.test(real), `容器自己不需要浏览器，不许当罪名（它可以出现在父链里）：${real}`);
  // **反向对照**：真的要跑浏览器的场景，不该收到"你大概想写 assertUi"
  // （那句是命名陷阱的提示，对一份纯 web 用例是错建议；挂在每一句报错上，
  //  读的人会以为自己写错了 kind 而去改一条本来对的 navigate）
  assert.ok(!/assertUi/.test(real), `名单里没有 assertPage 时不该给那条提示：${real}`);

  // ③ 截断：9 处只列 8 处时，**少的几个必须写在脸上**
  const many = await run(Array.from({ length: 9 }, (_, i) => ({ id: `nv${i + 1}`, kind: 'navigate', url: 'https://x/' })));
  assert.match(many, /另有 1 处/, `列到上限时要说少了几个：${many}`);
  assert.match(many, /（nv8）/, '前 8 处仍要逐个列出（少了几个 ≠ 少列）');
  assert.ok(!/（nv9）/.test(many), '第 9 处确实被截掉了（否则"另有 1 处"是句假话）');

  // ④ 名字与 needsWeb 同判据：报出的 id 集合恰好等于场景里所有 web 档步骤
  const mixed = await run([
    { id: 'navA', kind: 'navigate', url: 'https://x/' },
    { id: 'httpA', kind: 'http', request: { method: 'GET', url: 'https://x/' } },
    { id: 'capA', kind: 'capture', mode: 'screenshot' },
    { id: 'uiA', kind: 'assertUi', assertKind: 'visible', target: 'x' },
  ]);
  assert.match(mixed, /navA/, 'web 档步骤必须被点名');
  assert.match(mixed, /capA/, 'capture 也属于 web 档，同要被点名');
  assert.ok(!/httpA/.test(mixed) && !/uiA/.test(mixed), `http 与 assertUi 都不属于 web 档，不许出现在名单里：${mixed}`);
});

test('纯 API 场景在**没配浏览器**的机器上照跑（不被 Web 端的配置问题连累）', async () => {
  /*
   * 这条是"按需建"存在的全部理由，也是它唯一能被证伪的方式：
   * 无条件建 adapter 的话，这里会变成 ATEST_BROWSER_BIN 缺失导致的失败，
   * 于是一个端的配置问题阻塞了另一个端 —— 而失败信息长得像"用例跑不了"。
   */
  await withoutBrowser(async () => {
    const registry = await DocRegistry.load([]);
    const a = await assemble({
      scenario: scen([step('http', { request: { method: 'GET', url: 'https://example.com/' } })]),
      env: {}, registry, evidenceDir: '/tmp/atest-wiring-test', clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
    });
    assert.equal(a.web, undefined, '纯 API 场景不该建 Web adapter');
    assert.ok(a.runOptions.adapters.http, 'http adapter 仍要无条件在（与"有没有导 spec"无关）');
    assert.equal(a.runOptions.adapters.ui, undefined, '没建 adapter 就不该有 ui 端口');
  });
});

test('env.viewport 写错时报错，不猜一个默认值', async () => {
  /*
   * 视口决定响应式断点，猜一个 = 用例在没人知道的尺寸下跑过。
   *
   * 这条**必须给一个浏览器路径**（哪怕是假路径）：装配顺序是先查 ATEST_BROWSER_BIN
   * 再解析 viewport，不设的话报的是"没配浏览器"，那条断言就会去匹配一个
   * 永远不可能出现的 /viewport/ —— 而我把第一版写成不设变量，它"通过"不了
   * 恰好说明判据是活的。给假路径也够：parseViewport 在 createWebAdapter
   * **被调用之前**就抛了，压根不会去 spawn。
   */
  const saved = process.env.ATEST_BROWSER_BIN;
  process.env.ATEST_BROWSER_BIN = '/nonexistent/browser-binary';
  try {
    const registry = await DocRegistry.load([]);
    await assert.rejects(
      () => assemble({
        scenario: scen([step('navigate', { url: 'https://x/' })]),
        env: { viewport: '1440*900' }, registry, evidenceDir: '/tmp/atest-wiring-test',
        clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
      }),
      (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /viewport/, `要报在 viewport 上，而不是去起浏览器：${m}`);
        assert.ok(!/nonexistent/.test(m), `不该走到 spawn 那一步：${m}`);
        return true;
      },
    );
  } finally {
    if (saved !== undefined) process.env.ATEST_BROWSER_BIN = saved; else delete process.env.ATEST_BROWSER_BIN;
  }
});
