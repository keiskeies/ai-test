/**
 * 编辑器「校验」那条路的**另一半**（`dryRun` 那半）的载体。
 *
 * ## 这份文件存在的理由：那一整半此前一个断言都没有
 *
 * `checkIr` 一次交三样东西：schema、`lintScenario`、`dryRun`。仓里已有的那几条
 * 浏览器测试点的是 lint 那一半（`browser-modules.test.ts` 断的是 `checked.issues`
 * 里有 `DEPENDENCY_CYCLE`）与**运行**那一半（`browser-run-button.test.ts` 整个文件）。
 * 改前在 `packages` 各包的 test 目录里 grep `missingInputs` 是**零命中** —— 那一栏有类型、
 * 有判据、有读者（`app.ts` 真把它画成一张卡），唯独没有会让它红的东西：
 * docs/08 §3 的 (f)「有生产者、没有载体」。
 *
 * **载体缺位的下游产物比载体缺位本身更贵**：改前三处源码注释（`engine/src/lint.ts`、
 * `ir/src/steps.ts`、`engine/src/dryrun.ts`，外加 `engine/test/expr-strict.test.ts`
 * 里一段）都写着「`dryRun` 生产里零调用方」。那句话在 `web/src/check.ts` 落地之后
 * 就是假的，而它读起来像一条经过核对的口径，于是每个读到的人都会顺手拿它当
 * "这一侧不必测"的理由 —— **假注释会把测试欠账固定下来**。本轮先把载体落下（本文件），
 * 再回去把那几处改成实测过的说法。
 *
 * ## 为什么拆成两半，而且两半都要
 *
 *  - **node 半**（前半那几条）测**内容**：`dryRun` 对一份合法 IR 到底交出什么。
 *    `@atest/engine` 与 `@atest/ir` 都不碰 node 内置模块（`tooling/lint-layers.mjs`
 *    拦的就是这条），所以它们**本来就能在 node 里跑**，这一半不需要浏览器。
 *  - **浏览器半**（最后两条）测**接线**：屏幕真发了那一次调用、真把回答画了出来。
 *
 * 两半都要，理由不是"多一层保险"：浏览器半在没有 Chrome 的机器上是 `test.skip`
 * （`browser-harness.ts` 那句 `BROWSER ? test : test.skip`），而 node:test 对全跳过的
 * 文件给 pass 0 / fail 0 / **退出码 0**。所以判据**不许只存在于浏览器那一半** ——
 * 否则换台机器上"这一侧全绿"的意思是"什么都没跑"（`tooling/mutate.mjs` 里
 * `noTestsIn` 挡的就是这个形状）。反过来 node 半给不出"按钮接上了没"：`checkIr`
 * 里那句 `dry:` 被删掉时，`app.ts` 两处消费方写的是 `r.dry?.missingInputs ?? []`
 * 与 `est ? … : []` —— **可选链把"少了半份"读成"这半份没问题"**，屏幕上既没有卡
 * 也没有预估行，而角标照样是绿的。那种坏法下 node 半会红（第一条就是地板），
 * 浏览器半才有"人真的看不看得见"那一格。
 *
 * ## 顺带量到并治掉的一处说谎（读数钉在这里，治法写在 app.ts）
 *
 * 改前实测那份夹具：`r.issues` 是**空数组**，`r.dry.errors` 是 `["VAR_UNDEFINED"]`、
 * `r.dry.ok` 是 `false`。而角标与那张卡读的都是 `r.issues`，于是屏幕上同时出现
 * 角标「静态闸通过」+ 卡片「引擎没报任何问题」+「缺少必填输入 who」。
 * 卡片那句是**假话**：`dryRun` 也是引擎（`check.ts` 头上写着三查都在引擎里），
 * 它刚报了一条 error。角标那句单独看是对的，但它旁边没有第二个信号，
 * 只扫一眼的人会以为整个校验只有一个结论。
 * 本轮的治法是把两句话都**收窄到各自真的覆盖面**（角标点名"静态闸/与 CI 退码同口径"，
 * 另挂一枚只在缺输入时出现的「还缺 N 个必填输入」徽章），而不是把 dry 那几条
 * 并进静态闸那张卡 —— 理由写在 `app.ts` 的 renderIssues 上。
 * 本仓那一族：「**每个消费者都各自正确，而它们对同一件事的假设互不相容**」（docs/08 §3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ScenarioSchema } from '@atest/ir';
import { dryRun, lintScenario } from '@atest/engine';

import { checkIr } from '../src/check.js';
import { browserTest, evalOnce, evalWait, openPage, serveSite } from './browser-harness.js';

/*
 * 一份**合法、且静态闸一条 finding 都不报**的 IR，只多一条必填输入。
 * 步骤形状照抄 `examples/demo/cases/login.json`（`set` 造一份响应 + `assert` 指回它）。
 *
 * 干净不是审美问题。`dryRun` 的 issues = `lintScenario` 的结果 + 「缺少必填输入」那一条，
 * 夹具里混进任何别的 finding（最省事的一份 IR 就会中 `ASSERT_FREE_STEP` 与
 * `TEARDOWN_DIRTY` —— 我第一版就是这么写的，那两条 error 让"静态闸有没有过"这一格
 * 直接失去意义，红的时候分不开是谁）就会把要量的那一格埋掉。
 * 上面那段"实测"读数就是把这个夹具修干净之后重量的。
 */
const bodyUsesInput = [
  { id: 'g', kind: 'set', assign: { greeting: { path: '$who' } } },
  { id: 'a1', kind: 'assert', against: '$.step.g.greeting', jsonPath: { $: { notNull: true } } },
];
const bodyClean = [
  { id: 'g', kind: 'set', assign: { greeting: 'hello' } },
  { id: 'a1', kind: 'assert', against: '$.step.g.greeting', jsonPath: { $: { exact: 'hello' } } },
];
const scen = (inputs: readonly unknown[], body: readonly unknown[] = bodyUsesInput): Record<string, unknown> => ({
  schemaVersion: '1', id: 'scn.dry', name: '校验路径夹具', frozen: false,
  env: { environmentRef: 'unit' }, targets: ['api'], inputs, body,
});
const REQUIRED = [{ name: 'who', type: 'string', required: true }];

/** 桩服务端：只发真 `index.html` + 一条 `/api/scenario`（其余 api 路由由 harness 大声 404） */
async function stubScenarioSite(s: Record<string, unknown>): Promise<{ site: Awaited<ReturnType<typeof serveSite>>; close(): Promise<void> }> {
  const site = await serveSite({
    index: { file: 'packages/web/static/index.html' },
    api: (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
      if (url.pathname === '/api/scenario' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s, null, 2));
        return true;
      }
      return false;
    },
  });
  return { site, close: () => site.close() };
}

const click = (sel: string): string => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NO_NODE'; el.click(); return 'OK'; })()`;
const cardTexts = `[...document.querySelectorAll('section.card')].map((c) => c.textContent ?? '')`;
/*
 * 「缺少必填输入」那张卡上**点名了谁**，只问那些 `<code>` 小片子。
 *
 * 不能对整张卡的 textContent 匹配 `who` —— 那张卡底下有两句修法说明，
 * 其中一句里就写着 `--input who=<值>`，整卡匹配会在"芯片根本没画出来"的时候
 * 照样命中那句话而绿。本仓记过这一族：**针落在散文上而不是落在数据上**。
 * 这里我自己先踩了一次（写卡片提示文本的时候没想过测试会撞上它），
 * 所以把选择器收窄到 `code`，并在 check-lines.test.ts 里留了一条前提哨兵。
 */
const missingChips = `[...document.querySelectorAll('section.card')]
  .filter((c) => (c.querySelector('h2')?.textContent ?? '').includes('缺少必填输入'))
  .flatMap((c) => [...c.querySelectorAll('code')].map((n) => n.textContent ?? ''))`;

/* ═══════════ node 半：内容 ═══════════ */

test('编辑器那条路上，合法 IR 的 dry 半**真的给出读数**（不是 undefined）', async () => {
  /*
   * 本文件的地板。它挡的坏法写在文件头：`dry:` 那一行被删掉时消费方的可选链
   * 会把"少了半份"读成"这半份没问题"，而角标仍是绿的。
   */
  const r = await checkIr(JSON.stringify(scen([], bodyClean)));
  assert.equal(r.parsed, true, `夹具没过 schema，后面都判不了：${r.parseError}`);
  assert.ok(r.dry, 'checkIr 交出的 dry 是 undefined：编辑器那一侧的输入完备性与预估整半没人接');
  assert.deepEqual(r.dry.missingInputs, [], '没有必填输入时这一栏要空数组而不是 undefined（消费方直接 .length）');
  assert.equal(r.dry.estimate.steps, 2, `预估步数不对：${JSON.stringify(r.dry.estimate)}`);
  assert.equal(r.dry.estimate.needsDevice, false, '纯 API 场景要说不要设备，这条不许是恒真');
  assert.deepEqual(r.dry.estimate.targets, ['api'], `端集合读的是声明那一份：${JSON.stringify(r.dry.estimate.targets)}`);
  assert.ok(Array.isArray(r.dry.errors) && Array.isArray(r.dry.warnings), 'dry 里没有 errors/warnings 两栏');
});

test('必填输入缺失被**点名**，而且 dry 侧判不通过', async () => {
  const r = await checkIr(JSON.stringify(scen(REQUIRED)));
  assert.equal(r.parsed, true, `夹具没过 schema，后面都判不了：${r.parseError ?? ''}`);
  assert.deepEqual(r.dry?.missingInputs, ['who'],
    `没点名缺哪个输入：${JSON.stringify(r.dry?.missingInputs)}。只报"参数不全"等于让人去猜`);
  assert.equal(r.dry?.ok, false, '缺必填输入而 dry 说通过：这一栏的全部意义就是拦这个');
  const hit = (r.dry?.issues ?? []).filter((i) => i.code === 'VAR_UNDEFINED' && /缺少必填输入/.test(i.message));
  assert.equal(hit.length, 1, `「缺少必填输入」要作为一条 error 出现在 dry.issues 里，实际 ${JSON.stringify((r.dry?.issues ?? []).map((i) => [i.level, i.code]))}`);
  assert.equal(hit[0]!.level, 'error');
});

test('给了那个输入，missingInputs 就**清空**（不许是恒报）', async () => {
  /*
   * 与上一条是同一个夹具的两个方向。只断"缺时报"的那条判据，在
   * `missingInputs = scenario.inputs.map(p => p.name)`（忘了 `in inputs` 那一半）下
   * 照绿 —— 本仓反复量的那一族：只断"该响"不断"该不响"，判据退化成恒真。
   */
  const parsed = ScenarioSchema.parse(scen(REQUIRED));
  assert.deepEqual(dryRun(parsed, { who: 'tester' }).missingInputs, [], '已经给了 who 还说缺');
  assert.equal(dryRun(parsed, { who: 'tester' }).ok, true, '给了输入而 dry 仍判不通过');
  /*
   * 空字符串算**给了**：判据是 `name in inputs` 而不是"值非空"。
   * 这一格刻意钉下来而不是修掉 —— 空串是不是合法入参是**场景作者**用 schema
   * 能表达的事（要拦空串该写 `minLength` 或 lint 规则），而 dryRun 这一侧
   * 一旦把"空值"当"缺失"，就没法表达"这个参数就该是空串"的合法用例。
   */
  assert.deepEqual(dryRun(parsed, { who: '' }).missingInputs, [],
    '判据是"这个键在不在"。空字符串是**给了**（它是合法值，不是缺失）');
});

test('**不该点名的两种输入**：可选的、以及自带 default 的（反向对照，不许恒报）', async () => {
  /*
   * 这两格是被变异**逼出来的**，不是我想到要写的：`missingInputs` 的判据是三个
   * 条件与出来的（`p.required && !(p.name in inputs) && p.default === undefined`），
   * 而上面那几条只覆盖了"必填 + 没给 + 没 default"那一格。
   * 拿掉 `p.required` 或拿掉 `p.default === undefined`，上面**每一条都照绿** ——
   * 于是屏幕上会出现一张点名了一个**根本不用填**的输入的卡，
   * 而人会照着那句"命令行传 --input xxx=<值>"去传一个可选参数（或直接改用例）。
   * docs/08 §3 那一族的正字反写：**只断该响，等于没断**。
   * 变异集 dry-run-check.json 的 M1/M3 就是这两格的牙（读数在 spec 的 _measured 里）。
   */
  const optional = await checkIr(JSON.stringify(scen([{ name: 'who', type: 'string', required: false }])));
  assert.equal(optional.parsed, true, `可选这条 IR 没解析过：${optional.parseError ?? ''}`);
  assert.deepEqual(optional.dry?.missingInputs, [],
    '可选输入被点名成"缺少必填输入"：判据把 required 这一半丢了');

  const withDefault = await checkIr(JSON.stringify(scen([{ name: 'who', type: 'string', required: true, default: { gen: { kind: 'uuid' } } }])));
  assert.equal(withDefault.parsed, true, `带 default 这条 IR 没解析过：${withDefault.parseError ?? ''}`);
  assert.deepEqual(withDefault.dry?.missingInputs, [],
    '自带 default 的输入被点名：default 的意思就是"这一格运行时会自己补上，不用传"。'
    + '形状取自 examples/demo/cases/login.json 的 userId —— 那是本仓自己的推荐写法');
  assert.equal(withDefault.dry?.ok, true,
    `有 default 而 dry 判不通过：${JSON.stringify((withDefault.dry?.issues ?? []).map((i) => [i.level, i.code]))}`);
});

test('静态闸与 dry-run 是**两份读数**：同一份场景前者零 error、后者一条 error', async () => {
  /*
   * 这条钉的是**数据层的事实**，与屏幕上怎么措辞无关。刻意与显示层分开：
   * 显示层那句话本轮改过一次（从「引擎没报任何问题」收窄成「静态闸这一查没报
   * 任何问题」），而**改措辞不该让这条红** —— 它要为"这是两份读数"这件事
   * 长期作证，而不是当一次措辞变更的连带受害者。
   *
   * 三格必须同时成立，缺一格这条就退化成 dryrun 侧的重复测试：
   *  1. `r.issues`（= 静态闸那一份）里没有 error —— 所以角标那句「静态闸通过」
   *     对它问的那件事是对的；
   *  2. `r.dry.errors` 里有那一条、`r.dry.ok` 是 false —— 另一查没过；
   *  3. 从 lint 那一侧**独立**再核一遍，排除"是 checkIr 替我算过所以才对"。
   * 于是"通过"与"没报问题"与"缺少必填输入"三句话会同时出现在一块屏幕上。
   */
  const r = await checkIr(JSON.stringify(scen(REQUIRED)));
  assert.deepEqual(r.issues, [],
    `静态闸本身上有 finding，这三格就不再互相区分了：${JSON.stringify(r.issues.map((i) => [i.level, i.code]))}`);
  assert.deepEqual(r.dry?.errors.map((i) => i.code), ['VAR_UNDEFINED'],
    `dry 侧那条 error 没进来：${JSON.stringify(r.dry?.errors ?? [])}`);
  assert.equal(r.dry?.ok, false, 'dry 侧没过 —— 这一格是那句读数偏差的前提');
  assert.deepEqual(lintScenario(ScenarioSchema.parse(scen(REQUIRED))), [],
    '从 lint 那一侧独立核对：结论不该依赖 checkIr 有没有替我算过');
});

/* ═══════════ 浏览器半：接线 ═══════════ */

browserTest('点「校验」之后，屏幕上真的出现「缺少必填输入」那张卡与预估那一行', async () => {
  /*
   * 这一格要的是：**引擎在浏览器里那一次 dryRun 的回答，真的到了屏幕上**。
   * 三样东西各钉一处，缺一处含义不同：
   *  · 卡上点名 `who` —— missingInputs 这条链（IR → dryRun → 渲染）在浏览器里通；
   *  · 预估那一行（`约 2 步 · 不要设备 · 端 api`）—— `estimate` 那一栏此前只在
   *    engine 侧有断言，这里补"前端真把它画出来了"那一半；
   *  · irSha 那一格 —— 顺手为"浏览器里那份 canonical 与服务端同源"留一个屏幕侧读数
   *    （哈希本身对不对由 `browser-modules.test.ts` 与 `store/test/ir-hash.test.ts` 管）。
   */
  const s = await stubScenarioSite(scen(REQUIRED));
  const { cdp, kill } = await openPage(s.site);
  try {
    await cdp.send('Page.navigate', { url: `${s.site.url}#/scenario/scn.dry` });
    await evalWait(cdp, `document.querySelector('#check-btn')`, 20_000);
    assert.equal(await evalOnce(cdp, click('#check-btn')), 'OK', '校验按钮没找到或点不动');

    const screen = await evalWait(cdp, `(() => {
      const cards = ${cardTexts};
      if (!cards.some((t) => t.includes('缺少必填输入'))) return null;
      const t = (s) => { const n = document.querySelector(s); return n ? n.textContent : null; };
      return { status: t('#status-line'), cards, chips: ${missingChips} };
    })()`, 20_000) as { status: string | null; cards: string[]; chips: string[] };

    assert.deepEqual(screen.chips, ['who'],
      `「缺少必填输入」那张卡上的 <code> 芯片不是 ['who']：${JSON.stringify(screen.chips)}。`
      + 'missingInputs 这条链（IR → 浏览器里的 dryRun → 渲染）断了就是这里');
    assert.match(screen.status ?? '', /约 2 步/, `状态行里没有预估的步数：${screen.status}`);
    assert.match(screen.status ?? '', /不要设备/, `预估说错要不要设备：${screen.status}`);
    assert.match(screen.status ?? '', /端 api/, `预估的端不对：${screen.status}`);
    assert.match(screen.status ?? '', /irSha [0-9a-f]{12}/, `状态行没有 irSha：${screen.status}`);
    /*
     * 卡片上那两句**修法**也在屏幕上（不是只在类型里有）。
     * 断的是"有没有这两句"，不逐字比对句子本体 —— 句子的字由
     * `check-lines.test.ts` 在 node 里钉（那边没有 skip 的问题），
     * 这边只钉"它画出来了"。**两处各测一件事，改措辞不会连带红这条。**
     */
    const card = screen.cards.find((t) => t.includes('缺少必填输入')) ?? '';
    assert.match(card, /--input/, `卡片没说清上哪儿填：${card}`);
    assert.match(card, /ps aux|shell 历史/, `卡片没提密钥不该走 --input：${card}`);
    assert.match(card, /secret:/, '卡片给了命令却没给密钥的替代路径：' + card);
  } finally {
    kill();
    await s.close();
  }
});

browserTest('缺必填输入时角标上**真的挂出了第二枚徽章**（句子本身由 node 那条钉）', async () => {
  /*
   * `check-lines.test.ts` 里那条"必须有两枚徽章"测的是**函数**；
   * 这一条测的是**页面真的照它画了**。两者会分叉：`renderStatus` 从前自己
   * 拼那几句话（本轮才挪进纯模块），谁都能哪天又在那里拼一份新的 ——
   * 那时 node 那条全绿而屏幕上没有那枚徽章。这正是 docs/08 §3 的
   * "每个消费者都各自正确，而它们对同一件事的假设互不相容"的前端版。
   */
  const s = await stubScenarioSite(scen(REQUIRED));
  const { cdp, kill } = await openPage(s.site);
  try {
    await cdp.send('Page.navigate', { url: `${s.site.url}#/scenario/scn.dry` });
    await evalWait(cdp, `document.querySelector('#check-btn')`, 20_000);
    assert.equal(await evalOnce(cdp, click('#check-btn')), 'OK');
    await evalWait(cdp, `document.querySelectorAll('#status-line .badge').length >= 2`, 20_000);
    const badges = await evalOnce(cdp, `[...document.querySelectorAll('#status-line .badge')].map((b) => (b.textContent ?? '') + '|' + b.getAttribute('data-s'))`) as string[];
    assert.ok(badges.some((b) => /必填输入/.test(b) && /\|fail$/.test(b)),
      `那枚"缺输入"的徽章没画出来，或画成了别的颜色：${JSON.stringify(badges)}。`
      + 'data-s 必须是 fail —— 它不是"提醒一下"那一档（docs/13 §6：色、图标、文字三重编码要一致）');
    assert.ok(badges.some((b) => /静态闸/.test(b)),
      `静态闸那枚徽章不在（${JSON.stringify(badges)}）：两枚徽章各说各的范围，少一枚就退化成一个结论`);
  } finally {
    kill();
    await s.close();
  }
});

browserTest('没填输入的那份场景跑不起来，而屏幕上**没有任何入口能填它**（现状钉下来）', async () => {
  /*
   * 这条测的是**缺一样东西**，所以写法要格外小心：断"屏幕上不存在某个入口"
   * 极易写成恒真（选择器取错、DOM 结构换掉，全都表现为"不存在"从而照绿）。
   * 所以这里先**正向**为"屏幕确实渲染完了、按钮都在"作证，再问那个入口在不在；
   * 并且不靠"有没有 input 标签"这种实现细节，而是问**跑起来会不会带上 inputs**
   * —— 那才是这件事的可观测后果：`submitRun` 与 `/api/run` 都支持 inputs
   * （服务端把它拼成 CLI 的 `--input k=v`），而 `app.ts` 的 `runIt` 一个都不传。
   *
   * 于是这一格是 docs/08 §3 的 (f) 又一个实例：**判据有、提示有、运行通道也通，
   * 唯独没有让人填的那一格**。人看见「缺少必填输入：who」之后，能做的只有去改 IR
   * 正文给它写个 default（那会把"每次运行传不同值"这类用例直接毁掉）。
   * 修法登记在 docs/14 §5，这一格只保证：**修好之后这条会红**，红了就换判据。
   */
  const runs: Array<Record<string, unknown>> = [];
  const site = await serveSite({
    index: { file: 'packages/web/static/index.html' },
    api: (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
      const p = url.pathname;
      if (p === '/api/scenario' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(scen(REQUIRED), null, 2));
        return true;
      }
      if (p === '/api/run' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          runs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ exitCode: 2, output: '' }));
        });
        return true;
      }
      return false;
    },
  });
  const { cdp, kill } = await openPage(site);
  try {
    await cdp.send('Page.navigate', { url: `${site.url}#/scenario/scn.dry` });
    await evalWait(cdp, `document.querySelector('#check-btn')`, 20_000);
    assert.equal(await evalOnce(cdp, click('#check-btn')), 'OK');
    await evalWait(cdp, `${cardTexts}.some((t) => t.includes('缺少必填输入'))`, 20_000);

    // 正向作证：屏幕渲染完了，两个按钮都在（否则下面那句"没有入口"是恒真）
    assert.deepEqual(await evalOnce(cdp, `['#check-btn', '#run-btn'].map((s) => !!document.querySelector(s))`), [true, true],
      '两个按钮有一个不在，这条测试的前提就没了 —— 那种情况下"没有填输入的入口"是白说的');

    assert.equal(await evalOnce(cdp, click('#run-btn')), 'OK');
    await evalWait(cdp, `document.querySelector('[id^="job-"]')`, 5_000);
    assert.equal(runs.length, 1, `点了运行而桩没收到 /api/run：${JSON.stringify(runs)}`);
    assert.deepEqual(runs[0]!.inputs ?? null, null,
      `提交体里居然带了 inputs（${JSON.stringify(runs[0])}）—— 那么"没有入口能填"已经不成立了。`
      + '这是**好的红**：把本条改成"填了 who 就会带上"，并连着 docs/14 §5 那一行一起改');
  } finally {
    kill();
    await site.close();
  }
});
