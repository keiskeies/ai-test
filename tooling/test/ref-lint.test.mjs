/**
 * 引用存活检查（tooling/ref-lint.mjs）的自测。
 *
 * ── 为什么这条测试必须存在 ─────────────────────────────────────
 * 这条检查的失效方向**全部长得像"检查通过"**：正则漏一种写法、免检判据放宽一寸、
 * 词表吃掉一个真标识符，结果都是安静地全绿。本仓对这一族记过多次账
 *（lint-layers.test.mjs 开头那句"一条静默失效的 lint 比没有 lint 更糟"，同一个理由）。
 * 所以重点不是"好的输入判成 ok"（那几乎不会错），而是坏指针必须真的红、
 * 免检判据不许被放宽、词表不许宽到"任一命中"。
 *
 * ── 为什么这个文件里还带一套变异扫（见下面的 MUTATIONS） ────────
 * 因为上面那句话本身差点又变成一句**没被验过的断言**。
 * 这套自测最初写完是 29 例全绿；把 ref-lint 的判据分支逐个改坏跑它，
 * **22 个变异杀掉 17 个，活下来的 5 个全部落在"候选词怎么取"上** ——
 * 也就是说 ref-lint.mjs 文件头第 1、2 条那些"先错过一次才改对"的说法，
 * 当时只写在注释里：把窗口半径改成 0、把停词表清空、把整词边界去掉，
 * 自测**照样全绿**。那五条后来补了夹具，扫变成 22/22。
 *
 * 但"我跑过一次 22/22"就又是一句会被下一个人当事实抄的数 ——
 * 与本文开头批评的那些写死数字没区别。所以扫本身**留在测试里**，
 * 每次 `npm test` 都真跑一遍，而不是记一条"某年某月抓到 N 例"。
 *
 * 为什么放这里而不是 `tooling/mutate/*.json`：那套驱动每个 case 强制
 * `npm run build`（为了堵"改了 src 而 dist 还是旧的"），而本文件与 ref-lint 都是 .mjs，
 * tsc 压根不编译它们 —— 22 个 case 就是 44 次全仓 tsc（几分钟），
 * 换来的防护一条都没多。两条路各自要付的代价不同，不该强行统一。
 *
 * ⚠ 与驱动同源的三条纪律在这里也照办，因为它们防的是同一类假结论：
 *  1. **锚点匹配不到不等于"未被抓到"**，单独报 ANCHOR_NOT_FOUND 并红 ——
 *     锚点过期时这套扫会退化成"什么都没测而全绿"，那是最坏的方向；
 *  2. **变异把源码改成语法错误不算抓到**（等价于驱动的 BUILD_FAILED），
 *     单独报 BROKEN 并红 —— 语法错的代码当然让测试红，但它什么都没证明；
 *  3. **子进程一条测试都没跑不算抓到**，单独报 NO_TESTS 并红。
 *
 * 夹具是 `mkdtemp` 下的一次性小树（`after()` 整棵删掉），**不指向真仓库**：
 * 本工具对自己的两个文件免检（见 SELF_SKIP），若测试里的引用指向真文件真行号，
 * 它就落在自己管不到的地方 —— 那些引用坏了没人知道。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkRefs, violations, candidates, isPast, resolveTarget, REF_RE, WEAK_POOL } from '../ref-lint.mjs';

const SELF = fileURLToPath(import.meta.url);
const CHECKER = join(import.meta.dirname, '..', 'ref-lint.mjs');
/** 扫的递归闸门：子进程里不再跑扫（否则无限递归） */
const CHILD_ENV = 'ATEST_REFLINT_CHILD';

const ROOT = mkdtempSync(join(tmpdir(), 'reflint-'));
let caseNo = 0;
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** 建一棵最小可扫描的树（ref-lint 只扫 SCAN_DIRS 里的三个顶层目录） */
const tree = (files) => {
  const root = mkdtempSync(join(ROOT, `case${caseNo++}`));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return root;
};

const run = (args, cwd, env = {}) => {
  const e = { ...process.env, ...env };
  /*
   * **必须删掉 NODE_TEST_CONTEXT。** 在测试进程里它被设成 `child-v8`，
   * 子进程继承了它就改用另一套上报格式而**不再往 stdout 打 TAP** ——
   * 于是 `# pass N` 永远取不到、恒为 0。
   * 本轮第一次跑这套扫就是这么红的（"一条测试都没跑"），
   * 而它**本来可以安静地全绿**：如果我把那个 0 当成"未被抓到"而不是报错，
   * 22 个变异会全部记成 survived 或者全部记成抓到，两种都毫无意义。
   * 这正是上面第 3 条纪律存在的理由，而它在我写完的三十秒内就兑现了一次。
   */
  delete e.NODE_TEST_CONTEXT;
  try {
    return { red: false, out: execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: e, timeout: 60_000 }) };
  } catch (err) {
    /*
     * 超时单独成一种，不能落到"红 = 抓到了"那一堆里。
     * 一个把 ref-lint 改成死循环的变异会让子进程永不退出，而这条测试在 `npm test` 里 ——
     * 没有 timeout 的话它不是"抓到一条变异"，是**整个 npm test 卡死**（驱动也传 timeout，同一个理由）。
     */
    if (err && (err.code === 'ETIMEDOUT' || err.signal)) return { red: true, timedOut: true, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    // 非零退出也要把 stdout 取回来（驱动第 1 条坑：丢了它就只能记"无法判定"）
    return { red: true, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

/* ══════════════════════════════════════════════════════════════════
 * 夹具表。**唯一的**一处夹具定义：下面的描述式测试和变异扫都从这里取，
 * 两边不可能漂开（漂开的形状 = 扫扫的是一套夹具、人读的是另一套，
 * 那种扫绿了而真断言早就没人管了）。
 * 每条的 `why` 说这条夹具在钉什么；`want` 是正确代码给出的判定，
 * 只在下面被逐条 assert（扫本身不断言判定，它只要求"至少一条断言变红"）。
 * ══════════════════════════════════════════════════════════════════ */
const FX = {
  'stale-landing': {
    want: 'stale',
    why: '落点与作者说的东西毫无交集 —— 这条检查存在的唯一理由',
    files: {
      'packages/engine/src/target.ts': [
        'export const unrelated = 1;',
        'export function totallyDifferent() { return 2; }',
        'export const nothingAlike = 3;',
      ].join('\n'),
      'packages/engine/src/referrer.ts': '// 见 target.ts:2 里那个 computeLeaseKey 的算法',
    },
  },
  'missing-target': {
    want: 'missing-file',
    why: '目标文件压根不存在，要计入退出码而不是安静放行',
    files: { 'packages/engine/src/a.ts': '// 见 nonexistent.module.ts:10 里的 thingName' },
  },
  'line-beyond-end': {
    want: 'stale',
    why: '行号超出文件末尾（成因与"内容不对"不同，detail 要分开说）',
    files: {
      'packages/engine/src/short.ts': 'export const computeLeaseKey = () => 1;',
      'packages/engine/src/a.ts': '// 算法在 short.ts:9999 里的 computeLeaseKey',
    },
  },
  'neighbor-window-known-limit': {
    want: 'ok',
    why: '差一行而邻行带同一个词 => 放过。**已知限度**，钉成断言免得被当成保证',
    files: {
      'packages/engine/src/target.ts': [
        'export function computeLeaseKey() { return 1; }',
        'export const theThing = 2;',
      ].join('\n'),
      'packages/engine/src/a.ts': '// 见 target.ts:2 里的 computeLeaseKey',
    },
  },
  'plain-ok': {
    want: 'ok',
    why: '最普通的活引用，不许误报',
    files: {
      'packages/engine/src/target.ts': 'export function computeLeaseKey() { return 1; }',
      'packages/engine/src/a.ts': '// computeLeaseKey 的公式见 target.ts:1',
    },
  },
  'target-side-window': {
    want: 'ok',
    // 这里从前写的是 `retry.test.ts:293`（本文件在 SELF_SKIP 里，那个行号坏了没人知道 ——
    // 检查器管不到自己的文件，正是它文件头第 5 条记下的代价），如今按事实描述：
    why: '目标侧也开窗：真仓库里 retry.test.ts 那条讲 humanize() 丢信息的好引用就靠这一条不被误报',
    files: {
      'packages/engine/src/target.ts': [
        'const a = 1;',
        'const b = 2;',
        '// 这一行讲的是 humanize 丢了信息',
        'export function computeLeaseKey() { return 3; }',
      ].join('\n'),
      'packages/engine/src/a.ts': '// 见 target.ts:3 里 computeLeaseKey 那段',
    },
  },
  'doc-shorthand-path': {
    want: 'ok',
    why: '文档里写 `cli/wiring.ts:1`（省了 packages/ 与 src/）要能解析到',
    files: {
      'packages/cli/src/wiring.ts': 'export function needsWeb(s: unknown) { return Boolean(s); }',
      'docs/x.md': '| 步 | 发生什么 | 依据 |\n| 2 | 建 adapter | `cli/wiring.ts:1` 里的 needsWeb |',
    },
  },
  'range-tail-hit': {
    want: 'ok',
    why: '区间引用取那一段。被指物放在**段首 ±2 够不到**处，否则测不到有没有用 n1',
    files: (() => {
      const body = Array.from({ length: 12 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
      body[8] = 'export const computeThing = 9;';
      return {
        'packages/engine/src/target.ts': body.join('\n'),
        'packages/engine/src/a.ts': '// computeThing 的定义范围见 target.ts:1-9',
      };
    })(),
  },
  'history-cross-line': {
    want: 'skip:history',
    why: '标记在上行、引用在下行。不认跨行句式的话，老实交代历史的注释全被报成缺陷',
    files: {
      'packages/ir/src/target.ts': 'export const somethingElse = 1;',
      'packages/ir/src/a.ts': [
        '// 引用一律用符号名 —— 这里从前写的是',
        '`target.ts:1`，而那一行如今讲的是别的事',
      ].join('\n'),
    },
  },
  'past-in-neighbor-line': {
    want: 'stale',
    why: '本轮真错过的形状：ui.ts 那句里的"原本"说的是一次被删掉的 emit，与行号无关',
    files: {
      'packages/engine/src/target.ts': 'export const totallyUnrelated = 1;',
      'packages/adapter-web/src/ui.ts': [
        '// 这里原本还自己 emit 了一条，删掉了。',
        '// 引擎内部已经发过一条（target.ts:1），它带的是 data.id。',
      ].join('\n'),
    },
  },
  'past-in-other-sentence': {
    want: 'stale',
    why: '历史标记在上一句里（硬句界切开后与引用不同句）=> 不免检',
    files: {
      'packages/engine/src/target.ts': 'export const totallyUnrelated = 1;',
      'packages/engine/src/a.ts': '// 从前这条链路的成本很贵。详见 target.ts:1 里的 computeLeaseKey 算法',
    },
  },
  'quoted-tool-output': {
    want: 'skip:quoted',
    why: '反引号里含 <- 的是贴出来的工具输出（html.ts 里那段是 unread-fields 的坏例子本身）',
    files: {
      'packages/engine/src/target.ts': 'function renderTitle() { return 1; }',
      'packages/engine/src/a.ts': '// 它给出 `Baseline.scenarioId <- packages/engine/src/target.ts:1` 这样一条假证据',
    },
  },
  'backtick-without-arrow': {
    want: 'stale',
    why: '反引号本身不是免检理由，否则所有引用都能躲进去',
    files: {
      'packages/engine/src/target.ts': 'function renderTitle() { return 1; }',
      'packages/engine/src/a.ts': '// 详见 `target.ts:1` 里 computeLeaseKey 的写法',
    },
  },
  'escaped-inline': {
    want: 'skip:escaped',
    why: '行内 ref-lint:ignore 是唯一一个逃逸标记的拼写',
    files: {
      'packages/engine/src/target.ts': 'export const totallyUnrelated = 1;',
      'packages/engine/src/a.ts': '// 快照里写死了 target.ts:1（ref-lint:ignore：磁盘格式里的历史串）',
    },
  },
  'weak-when-pool-big': {
    want: 'weak',
    why: '长表行里候选过多 => 降级。不让文档排版替坏指针作证（docs/08 那条就是这么漏的）',
    files: (() => {
      const many = ['totallyUnrelated', ...Array.from({ length: WEAK_POOL + 6 }, (_, i) => `alphaIdentifier${i}`)].join('、');
      return {
        'packages/engine/src/target.ts': 'export const totallyUnrelated = 1;',
        'packages/engine/src/a.ts': `| 问题 | ${many} 之类的东西，详见 target.ts:1 | 结论 |`,
      };
    })(),
  },
  'skip-dirs': {
    want: null,
    why: '.scratch/（不在 SCAN_DIRS）与 packages/**/dist/（走 SKIP_DIRS）两道闸都要按住。'
      + '⚠ 产物那份故意用 .ts 结尾：SCAN_EXTS 本来不收 .js，用 .js 测的是扩展名过滤，SKIP_DIRS 那半等于没测',
    files: {
      '.scratch/probe.ts': '// 见 whatever.module.ts:9 里的 someIdentifier',
      'packages/engine/dist/x.ts': '// 见 whatever.module.ts:9 里的 someIdentifier',
      'packages/engine/src/ok.ts': 'export const a = 1;',
    },
  },
  'self-files': {
    want: 'skip:self',
    why: '本工具自己的两个文件里全是模式演示，不豁免就全被判成"目标不存在"',
    files: { 'tooling/ref-lint.mjs': '// 例：foo.module.ts:12 这种写法' },
  },
  'prose-not-a-ref': {
    want: null,
    why: '"interpreter.ts 第 320 行"这种散文写法不匹配（范围划界，不是逃逸口）',
    files: { 'packages/engine/src/a.ts': '// 见 interpreter.ts 第 320 行那个东西' },
  },
  'no-identifier': {
    want: 'skip:no-identifier',
    why: '提不出候选词要**明说**判不出，不许退化成 ok；但它不算违规（与 weak 的区别正在这里）',
    files: {
      'packages/engine/src/target.ts': 'export const totallyUnrelated = 1;',
      'packages/engine/src/a.ts': '// 上面那个算法的细节见 target.ts:1',
    },
  },
  'two-refs-one-line': {
    want: null,
    why: '同一行里一条活一条死，各自判对（不能整行一起放行）',
    files: {
      'packages/engine/src/live.ts': 'export function computeLeaseKey() { return 1; }',
      'packages/engine/src/dead.ts': 'export const totallyUnrelated = 2;',
      'packages/engine/src/a.ts': '// computeLeaseKey 见 live.ts:1；另一处见 dead.ts:1 里的同一个算法',
    },
  },
  'referrer-side-window': {
    want: 'ok',
    why: '被指物的名字写在上一行时也要捞到。窗口收成 0 => 退化成 skip:no-identifier（静默跳过）',
    files: {
      'packages/engine/src/target.ts': 'export function computeLeaseKey() { return 1; }',
      'packages/engine/src/a.ts': ['// computeLeaseKey 的公式在这里，', '// 见 target.ts:1'].join('\n'),
    },
  },
  'ref-blanked-from-pool': {
    want: 'skip:no-identifier',
    why: '窗口里要先抹掉引用本身，否则路径段（ir / humanize）变成"证据"，指这些文件的引用全部自动算活',
    files: {
      'packages/ir/src/humanize.ts': 'export function humanize(s: string) { return s; }',
      'packages/engine/src/a.ts': '// 详见 packages/ir/src/humanize.ts:1',
    },
  },
  'filename-not-evidence': {
    want: 'skip:no-identifier',
    why: '散文里又提一次文件名时（REF_RE 不匹配那处，没有 :NN），文件名不许替指针作证',
    files: {
      'packages/engine/src/target.ts': 'export const target = 1;',
      'packages/engine/src/a.ts': ['// target.ts 那个文件里，', '// 详见 target.ts:1'].join('\n'),
    },
  },
  'stem-not-evidence': {
    want: 'skip:no-identifier',
    why: '引用者所在文件的主名不算证据。⚠ 只排这一个名，不排"所有像文件名的词"'
      + '（docs/14 写 adapter-web/src/ui.ts:100 时 `ui` 恰是被指的文件，一起排掉会把好引用判成坏）',
    files: {
      'packages/engine/src/target.ts': 'export const locator = 1;',
      'packages/engine/src/locator.ts': '// 详见 target.ts:1 里的 locator 用法',
    },
  },
  'stopword-not-evidence': {
    want: 'stale',
    why: '`error` 这种注释里每句都有的词不许替坏指针作证（停词表的作用）',
    files: {
      'packages/engine/src/target.ts': '// 这一行的 error 分支已经被删掉了',
      'packages/engine/src/a.ts': '// computeLeaseKey 那处 error 的处理见 target.ts:1',
    },
  },
  'whole-word-only': {
    want: 'stale',
    why: '整词命中：ctx 不该被 ctxBase 满足。放开成子串匹配 => 判据退化成"任一命中"'
      + '（目标行故意用小写的 ctxBase；用 buildCtxBase 的话子串也命中不了，这条就什么都测不到）',
    files: {
      'packages/engine/src/target.ts': 'export const ctxBase = 1;',
      'packages/engine/src/a.ts': '// 见 target.ts:1 里 ctx 的传递',
    },
  },
};

/** 取一条夹具的判定（夹具里通常只有一条引用） */
const fx = (id) => {
  const refs = checkRefs(tree(FX[id].files));
  assert.ok(refs.length >= 1, `夹具 ${id} 一条引用都没产出 —— 正则漏了这种写法，这条测试等于没跑`);
  return refs[0];
};

/* ══════════════════════════════════════════════════════════════════
 * 变异扫：把 ref-lint 的判据分支逐个改坏，要求这套自测**变红**。
 * 每个条目的 anchor 必须是 ref-lint.mjs 里**唯一命中**的原文（与 mutate.mjs 同一条纪律：
 * 命中 0 次 = 锚点过期，命中多次 = 会改到不该改的地方，两种都不能当结论）。
 * ══════════════════════════════════════════════════════════════════ */
const MUTATIONS = [
  {
    label: '历史免检放宽回"邻行有标记就算"（本轮真错过的那一次）',
    anchor: `if (isPast(lines, i, m.index)) { ref.verdict = 'skip:history'; continue; }`,
    replace: `if (lines.slice(Math.max(0, i - 2), i + 3).join('\\n').match(/从前|以前|原本/)) { ref.verdict = 'skip:history'; continue; }`,
  },
  {
    label: '历史免检整个关掉（老实交代历史的注释会被报成缺陷）',
    anchor: `if (isPast(lines, i, m.index)) { ref.verdict = 'skip:history'; continue; }`,
    replace: ``,
  },
  {
    label: '贴输出免检放宽到"行里有反引号"（所有引用都能躲进去）',
    anchor: `if (isQuotedOutput(line, m.index, m.index + token.length)) { ref.verdict = 'skip:quoted'; continue; }`,
    replace: `if (line.includes('\`')) { ref.verdict = 'skip:quoted'; continue; }`,
  },
  {
    label: '贴输出免检整个关掉（unread-fields 那个坏例子会被报成坏指针）',
    anchor: `if (isQuotedOutput(line, m.index, m.index + token.length)) { ref.verdict = 'skip:quoted'; continue; }`,
    replace: ``,
  },
  {
    label: '行内标记免检整个关掉',
    anchor: `if (hitEscape) { ref.verdict = 'skip:escaped'; continue; }`,
    replace: ``,
  },
  {
    label: '自身文件免检整个关掉（工具自己的示例全被判成目标不存在）',
    anchor: `if (selfFile) { ref.verdict = 'skip:self'; continue; }`,
    replace: ``,
  },
  {
    label: '目标侧不开窗口（只看那一行）',
    anchor: String.raw`const seg = cl.slice(Math.max(0, a - 1 - WINDOW), Math.min(cl.length, b + WINDOW)).join('\n');`,
    replace: String.raw`const seg = cl.slice(a - 1, b).join('\n');`,
  },
  {
    label: '区间当成单行（忽略 n1）',
    anchor: `const b = n1 ? Number(n1) : a;`,
    replace: `const b = a;`,
  },
  {
    label: '候选过多时仍报 ok（撤掉 weak 那一档）',
    anchor: `if (hit) ref.verdict = pool.length > WEAK_POOL ? 'weak' : 'ok';`,
    replace: `if (hit) ref.verdict = 'ok';`,
  },
  {
    label: 'weak 不计入退出码（常年"另有 N 条判不出"而从不拦人）',
    anchor: `return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'missing-file' || r.verdict === 'weak');`,
    replace: `return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'missing-file');`,
  },
  {
    label: 'missing-file 不计入退出码',
    anchor: `return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'missing-file' || r.verdict === 'weak');`,
    replace: `return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'weak');`,
  },
  {
    label: '引用侧不开窗口（只看那一行 => 静默退化成 no-identifier）',
    anchor: `for (let i = refLineIdx - WINDOW; i <= refLineIdx + WINDOW; i++) {`,
    replace: `for (let i = refLineIdx; i <= refLineIdx; i++) {`,
  },
  {
    label: '窗口里不抹掉引用本身（路径段变成候选证据）',
    anchor: `const text = raw.replace(REF_RE, (s) => ' '.repeat(s.length));`,
    replace: `const text = raw;`,
  },
  {
    label: '不做简写路径回退（只认仓库根起的全路径 => 文档里的写法全被判坏）',
    anchor: `  const dir = join(root, ...file.split('/').slice(0, -1));`,
    replace: `  return [];
  const dir = join(root, ...file.split('/').slice(0, -1));`,
  },
  {
    label: '裸文件名不查同名表',
    anchor: `if (!file.includes('/')) return byName.get(basename(file)) ?? [];`,
    replace: `if (!file.includes('/')) return [];`,
  },
  {
    label: 'dist 不再跳过（产物里的引用进判定）',
    anchor: `const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.scratch', '.git', 'tmp']);`,
    replace: `const SKIP_DIRS = new Set(['node_modules', 'coverage', '.scratch', '.git', 'tmp']);`,
  },
  {
    label: '历史动词判据放宽成"有标记就算"',
    anchor: 'if (new RegExp(`${PAST_VERB}[^。；;]{0,30}[:：]?$`, \'s\').test(between)) return true;',
    replace: `return true;`,
  },
  {
    label: '硬句界不生效（标记在上一句也算同一句）',
    anchor: `for (const m of buf.matchAll(/[。；;！!?？]/g)) {`,
    replace: `for (const m of [].matchAll(/(?!)/g)) {`,
  },
  {
    label: '停词表失效（万金油词也替坏指针作证）',
    anchor: `if (STOPWORDS.has(lower) || seen.has(tok)) continue;`,
    replace: `if (seen.has(tok)) continue;`,
  },
  {
    label: '被指向文件名不排（指针自己给自己作证）',
    anchor: String.raw`if (lower.replace(/\.[a-z]+$/, '') === refBase) continue;`,
    replace: ``,
  },
  {
    label: '出界行号不再记录原因（修法提示会指错方向）',
    anchor: `if (a > cl.length) { beyondEnd = true; continue; }`,
    replace: `if (a > cl.length) { continue; }`,
  },
  {
    label: '词边界取消（子串命中即算活）',
    anchor: 'return new RegExp(`(?<![A-Za-z0-9_$.])${esc}(?![A-Za-z0-9_$])`).test(text);',
    replace: `return text.includes(tok);`,
  },
];

/** 把（可能改坏的）ref-lint 与这份自测拷进一棵临时树，跑子进程 */
const runChild = (checkerSource) => {
  const box = mkdtempSync(join(ROOT, `sweep${caseNo++}`));
  mkdirSync(join(box, 'tooling/test'), { recursive: true });
  const dest = join(box, 'tooling/ref-lint.mjs');
  writeFileSync(dest, checkerSource, 'utf8');
  copyFileSync(SELF, join(box, 'tooling/test/ref-lint.test.mjs'));
  const syntax = run(['--check', dest], box);
  if (syntax.red) return { broken: true, out: syntax.out };
  const r = run(['--test', 'tooling/test/ref-lint.test.mjs'], box, { [CHILD_ENV]: '1' });
  // 超时要在解析汇总行**之前**分流：死循环的输出里压根没有汇总行，
  // 不先分的话它会落进 noTap，报出来的原因就是错的
  if (r.timedOut) return { timedOut: true, out: r.out };
  /*
   * 与 mutate.mjs 的 noTestsIn 同一个口径：**明确解析到 pass 0 且 fail 0** 才算"一条没跑"
   *（全被 skip 时 node:test 给的就是 pass 0 / fail 0 / 退出码 0 —— 看着是绿）。
   * 解析不到汇总行是另一回事（环境问题，见上面 NODE_TEST_CONTEXT 那条），单独报。
   * 正则用 `^…$` + `m`：驱动那边写过 `(^|\n)`，于是数字落到捕获组 2、
   * `[1]` 是那个换行，`Number("\n") === 0`，**只要两行汇总都在就恒真** ——
   * 症状是"每条变异都判成没跑测试"，整个 harness 废掉。这里不重犯。
   */
  const pass = /^# pass (\d+)$/m.exec(r.out);
  const fail = /^# fail (\d+)$/m.exec(r.out);
  if (!pass || !fail) return { noTap: true, out: r.out };
  return { red: r.red, passed: Number(pass[1]), failed: Number(fail[1]), out: r.out };
};

test(`变异扫：ref-lint 的 ${MUTATIONS.length} 个判据分支逐个改坏，这套自测必须逐个变红`, { skip: process.env[CHILD_ENV] ? '子进程里不跑扫' : false }, () => {
  const original = readFileSync(CHECKER, 'utf8');
  // 基线：先确认干净代码下这套测试自己是绿的。基线就红的话，
  // 后面每一条"变红"都是真的，但原因可能压根不是那条变异（驱动也是这么办的）
  const base = runChild(original);
  assert.ok(!base.broken, `ref-lint.mjs 在干净状态下就语法不过：${base.out}`);
  assert.ok(!base.timedOut, `干净状态下这套自测跑不完（超时）：${base.out}`);
  assert.ok(!base.red, `干净状态（未施加任何变异）下这套自测就是红的，后面的扫结论全部无效：\n${base.out}`);
  assert.ok((base.passed ?? 0) > 0, `干净状态下一条测试都没跑（${JSON.stringify({ pass: base.passed, fail: base.failed })}），这不是"绿"，这是没执行`);

  /*
   * 五种失败**分开报**。合成一条"没通过"就看不出该修测试、该修锚点、还是该修环境，
   * 而这一族缺陷的本名就是"把没测读成结论"。
   */
  const buckets = { noAnchor: [], broken: [], timedOut: [], noTap: [], noTests: [], survived: [] };
  for (const m of MUTATIONS) {
    const hits = original.split(m.anchor).length - 1;
    // 命中 0 次 = 锚点过期；多次 = 会改到不该改的地方。两种都**没执行过**（驱动教训 3）
    if (hits !== 1) { buckets.noAnchor.push(`${m.label}（命中 ${hits} 次）`); continue; }
    const r = runChild(original.split(m.anchor).join(m.replace));
    if (r.broken) { buckets.broken.push(m.label); continue; }
    if (r.timedOut) { buckets.timedOut.push(m.label); continue; }
    if (r.noTap) { buckets.noTap.push(m.label); continue; }
    // pass 0 且 fail 0 = 全被跳过或一条没注册，退出码仍是 0，看着是绿（驱动教训 3 的第四个入口）
    if (r.passed === 0 && r.failed === 0) { buckets.noTests.push(m.label); continue; }
    if (!r.red) buckets.survived.push(`${m.label}（${r.passed} 例仍全绿）`);
  }
  assert.deepEqual(buckets.noAnchor, [], '这些变异的锚点在 ref-lint.mjs 里匹配不到/不唯一 —— 它们**根本没执行过**，'
    + '别把这一轮的扫读成"全部被抓到"。多半是被指的代码被重构走了，跟着改锚点');
  assert.deepEqual(buckets.broken, [], '这些变异把 ref-lint.mjs 改成了语法错误。语法错的代码当然让测试红，'
    + '但它什么都没证明（等价于 mutate.mjs 的 BUILD_BROKEN）。把 replace 写成合法源码');
  assert.deepEqual(buckets.timedOut, [], '这些变异让 ref-lint 跑不完（多半是死循环）。'
    + '超时不是"抓到了"，它连测试有没有跑到断言都不知道');
  assert.deepEqual(buckets.noTap, [], '这些变异下子进程没有输出 TAP 汇总行 —— 环境/加载期故障，'
    + '与变异结论无关。别把它读成"抓到了"（本轮那个 NODE_TEST_CONTEXT 就是这一类）');
  assert.deepEqual(buckets.noTests, [], '这些变异下一条测试都没跑 —— 不是"未被抓到"，是什么都没执行');
  assert.deepEqual(buckets.survived, [], '这些判据被改坏后这套自测仍然全绿 = 它们没被任何断言钉住。'
    + '\n修法不是把数改掉，是给每一条补一个夹具（"正确代码给 A、改坏给 B"，断言死盯 A）');
});

/* ══════════════════════════════════════════════════════════════════
 * 下面逐条断言每条夹具的判定。判定值取自 FX[id].want 的都在这里扫一遍，
 * 剩下几条带具体 detail/计数要求的单独写。
 * ══════════════════════════════════════════════════════════════════ */
describe('每条夹具的判定', () => {
  for (const [id, f] of Object.entries(FX)) {
    if (f.want === null) continue;
    test(`${id} => ${f.want}`, () => {
      const r = fx(id);
      assert.equal(r.verdict, f.want, `${f.why}\n实际 ${r.verdict}｜${r.detail}`);
    });
  }
});

describe('坏指针必须红（这条检查存在的唯一理由）', () => {
  test('目标文件不存在 => missing-file，且计入退出码', () => {
    const refs = checkRefs(tree(FX['missing-target'].files));
    assert.equal(violations(refs).length, 1, '找不到的目标必须计入退出码，不能安静放行');
  });

  test('行号出界要在 detail 里说明，因为修法和"内容不对"不同', () => {
    assert.match(fx('line-beyond-end').detail, /没有那一行/, `实际 ${fx('line-beyond-end').detail}`);
  });
});

describe('判不出与免检怎么计入退出码', () => {
  test('weak 计入退出码', () => {
    const refs = checkRefs(tree(FX['weak-when-pool-big'].files));
    const pool = candidates(FX['weak-when-pool-big'].files['packages/engine/src/a.ts'].split('\n'), 0, 'target.ts', 'a');
    assert.ok(pool.length > WEAK_POOL, `夹具得真的产出一大堆候选，否则什么都没测。实际 ${pool.length} 个`);
    assert.equal(violations(refs).length, 1,
      'weak 要计入退出码：一条常年"另有 N 条判不出"而从不拦人的命令，'
      + '与文档里写句"记得核对"是同一件没用的事。它今天可能指对了，所以这不是抓到缺陷，'
      + '而是要求作者把这条变成可判定的 —— 修法与坏指针同一个且更便宜：去掉行号改用符号名');
  });

  test('skip:no-identifier 不计入退出码', () => {
    const refs = checkRefs(tree(FX['no-identifier'].files));
    assert.deepEqual(violations(refs), [],
      '判不出 ≠ 违规，否则会把人推向"往注释里塞个假标识符消红"。'
      + '与 weak 的区别正在这里：weak 是"有得判、但判据被噪声淹了"，那个能修，所以计违规');
  });
});

describe('扫描范围与正则边界', () => {
  test('.scratch/ 与 dist/ 里的引用不进判定', () => {
    const refs = checkRefs(tree(FX['skip-dirs'].files));
    assert.equal(refs.length, 0, `探针与产物里的引用不该进判定：${JSON.stringify(refs.map((r) => r.target))}`);
  });

  test('本工具自己的两个文件都免检', () => {
    for (const f of ['tooling/ref-lint.mjs', 'tooling/test/ref-lint.test.mjs']) {
      const refs = checkRefs(tree({ [f]: FX['self-files'].files['tooling/ref-lint.mjs'] }));
      assert.equal(refs[0].verdict, 'skip:self', `${f}：里面每一处示例都是模式演示`);
    }
  });

  test('散文写法不匹配（要求扩展名紧贴冒号）', () => {
    assert.equal(checkRefs(tree(FX['prose-not-a-ref'].files)).length, 0);
  });

  test('同一行里的多条引用各自独立判定', () => {
    const refs = checkRefs(tree(FX['two-refs-one-line'].files));
    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((r) => r.verdict).sort(), ['ok', 'stale'],
      '同一行里一条活一条死，各自要判对（不能整行一起放行）');
  });

  test('REF_RE 不吃进下一个 token，也不匹配无扩展名的东西', () => {
    assert.deepEqual([...['见 a.ts:12-30 与 b.ts:8'].flatMap((l) => [...l.matchAll(REF_RE)].map((m) => m[0]))],
      ['a.ts:12-30', 'b.ts:8']);
    assert.deepEqual([...['见 gate 第 9 行、docs/08 §6'].flatMap((l) => [...l.matchAll(REF_RE)].map((m) => m[0]))], [],
      '没有扩展名 + 冒号的形式不该匹配');
  });
});

describe('resolveTarget 的解析层级', () => {
  test('裸文件名同名多份时给出全部候选，不猜', () => {
    const root = tree({
      'packages/ir/src/locator.ts': 'export const a = 1;',
      'packages/adapter-web/src/locator.ts': 'export const b = 2;',
    });
    const byName = new Map();
    for (const f of ['packages/ir/src/locator.ts', 'packages/adapter-web/src/locator.ts']) {
      byName.set('locator.ts', [...(byName.get('locator.ts') ?? []), join(root, f)]);
    }
    assert.equal(resolveTarget('locator.ts', root, byName).length, 2,
      '"任一命中"是故意放宽：严判会把好引用判成违规，而误报多了以后人会直接忽略这条命令的输出');
  });

  test('解析不到时给空数组而不是抛', () => {
    assert.deepEqual(resolveTarget('nope/missing.ts', ROOT, new Map()), [],
      '上层靠长度判 missing-file，抛异常会把整轮扫描带走');
  });
});

describe('isPast 的句式判据（纯函数级，绕开文件系统）', () => {
  /*
   * [行数组, 引用所在行号(0 基), 该行内起始列(0 基), 期望, 这条在测什么]。
   * 列号口径与 checkRefs 传的 m.index 一致。
   * 这一组直接打 isPast，是为了让"句式判据"这件事有独立的形状：走 checkRefs 的话，
   * 一个 skip:history 的失败可能是路径没解析到造成的，分不清是判据松了还是解析器坏了。
   */
  const cases = [
    [['**引用一律用符号名不用行号** —— 这里从前写的是', '`target.ts:1`，而那一行如今讲的是别的事'],
      1, 1, true, '标记在上行、引用在下行（只按单行切句就认不出来）'],
    [['以前这里是 `gate.ts:9`'], 0, 7, true, '"以前这里是"'],
    [['这里从前写的是 gate.ts:9'], 0, 8, true, '判据是动词，不要求行内出现"行号"二字'],
    [['从前很贵，见 gate.ts:9'], 0, 6, false, '标记后面没有"写/指/引用"这类动词'],
    [['这条引用的出处见 gate.ts:9'], 0, 9, false, '压根没有历史标记'],
    [['从前线很贵。见 gate.ts:9'], 0, 8, false, '标记在上一句里（硬句界切开）'],
  ];
  for (const [lines, li, col, want, label] of cases) {
    test(label, () => assert.equal(isPast(lines, li, col), want, `${JSON.stringify(lines)} @${li}:${col}`));
  }
});
