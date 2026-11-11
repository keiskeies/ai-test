/**
 * 引用存活检查：注释与文档里 `文件名.ts:NN` 形式的指针，是否还指着作者说的那样东西
 * （docs/14 §6 第 8 条）。
 *
 * ── 管什么、不管什么 ───────────────────────────────────────────
 * **只判一件事**：指针落点附近那一小段，和引用者嘴里说的东西，有没有一个词对得上。
 * 对不上 = 那一行早已是别的事。这是行号引用坏掉**唯一能被机器看见**的形状。
 *
 * 它**不能**证明引用是对的。两种它天生看不见的情形：
 *  - 只差一两行，而相邻那几行恰好带同一个词；
 *  - 指向同一段里另一件相关的事（词对得上，语义指错）。
 * 所以**红的时候基本可信，绿的时候只说明"没有一条落在明显无关的代码上"**。
 * 与 unread-fields.mjs 同一个定位：把"没人回头同步"变成一条会红的命令，
 * 而不是把"引用都对"变成一个可以被误信的保证。
 *
 * ── 为什么不用人工核对代替 ─────────────────────────────────────
 * 本轮人工核对过一遍，抓出一批坏指针。而人工核对**不会被第二次执行** ——
 * 下一个改代码的人不会重跑那份清单。写成人话：核对过 = 没核对。
 *
 * ── 判据里几个刻意的选择（每条都是先错过一次才改对的） ──────────
 * 1) **候选词取引用行 ±2 行**，且目标侧也取 ±2 行。两侧对称是必须的：
 *    目标侧只看那一行的话，「`engine/test/retry.test.ts` 里那条重试测试」这种写法
 *    会去被指那一行找 "retry" —— 而那一行讲的是 humanize() 把信息丢了，
 *    "retry" 只在**文件名**里。好引用被报成坏。
 *    ⚠ 这里从前给的是那条引用的**具体行号**，本轮去掉：本文件在 SELF_SKIP 里，
 *    写在这里的行号坏了**没有任何东西会红**，而它偏偏是一句现在时的事实陈述。
 *    引用一律按内容描述 —— 这是本文件对自己唯一可行的纪律。
 *    引用侧同理：只看引用那一行，「（interpreter 那段，见 interpreter.ts 第
 *    320-324 行）」这种括号式引用里根本没有被指物的名字，全退化成"提不出候选 => 跳过"，
 *    那条静默的跳过就是检查失效的形状。
 * 2) **候选词的过滤靠显式词表，不靠词的长相。**
 *    第一版用"有驼峰/下划线就只用强标识符"的分层，本意是不让 `error` 这种万金油词
 *    替坏指针作证；实测它反过来吃掉两条**好**引用（`humanize` 小写无下划线 =>
 *    落进弱档 => 不参与判定 => 报成坏）。分层把真假都判错了。
 *    **判"这个词没有区分度"是词表的事**，见 STOPWORDS。
 * 3) **历史句式免检，但必须同句 + 带动词 + 跨行拼句。**
 *    「这里从前写的是 `steps.ts:423`，而那一行如今讲的是别的事」—— 那种行号
 *    把它删掉会让人以为那句假话是本轮才产生的（humanize.ts 里就留着一处这样的历史交代）。
 *    ⚠ 两个方向都错过：
 *     - 只按邻行找"原本/以前" => 放过了真坏指针（那句里的"原本"说的是一次被删掉的
 *       多余 emit，与行号无关，而行号引的是当前行为）；
 *     - 只按单行切句 => 中文注释折行后，"—— 这里从前写的是"在上行、行号在下行，
 *       最典型的历史句式永远认不出来，于是**老实交代历史的注释全被报成缺陷**。
 *       老实交代正是该奖励的写法。
 * 4) **反引号里含 `<-` 的引用 = 贴出来的工具输出**，不是指针。
 *    html.ts 里那段贴的是 unread-fields `--evidence` 的**坏例子本身**
 *    （它的论点正是"这条证据指着一个毫不相关的入参"），按指针判它必然红。
 *    判据要窄到"同一段反引号里有 `<-`"，否则所有反引号里的引用都免检了。
 * 5) **本检查自己的两个文件免检**（见 SELF_SKIP）——代价是它管不到自己，
 *    所以自测里的引用一律指向内存里的假文件。
 * 6) **同名文件不猜**：带路径的精确取；裸文件名时同包候选优先，其余逐个试、
 *    任一命中即算活。"任一命中"是故意放宽 —— 严判会把 `locator.ts` 那条
 *    （ir 与 adapter-web 各一份，作者指 ir 那份）判成违规，
 *    而误报多了以后人会直接忽略这条命令的输出。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描范围。.scratch/ 是一次性探针（gitignore 掉的），不进判定 */
export const SCAN_DIRS = ['packages', 'docs', 'tooling'];
const SCAN_EXTS = ['.ts', '.mts', '.mjs', '.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.scratch', '.git', 'tmp']);

/**
 * `foo.ts:12` / `foo.ts:12-30`，前面允许带路径。
 * 刻意**要求扩展名紧贴冒号**：`interpreter.ts 第 320-324 行` 这种散文写法不匹配。
 * 这不是逃逸口（逃逸口是 isPast 的句式与 ref-lint:ignore），而是**范围划界**：
 * 散文里人本来就在描述而不是在指，硬收进判定只会稀释真信号。
 */
export const REF_RE = /((?:[A-Za-z0-9_./-]+\/)?[A-Za-z0-9_.-]+\.(?:ts|mts|mjs|json)):(\d{1,5})(?:-(\d{1,5}))?/g;

/** 行内逃逸标记：与"从前写的是 :NN"并列的另一条免检路，只有这一个拼写 */
export const ESCAPE = 'ref-lint:ignore';

/**
 * 本文件与它的自测文件里的引用一律免检。
 * 这两个文件的**存在理由**是描述上面那个正则，里面每一处示例都是模式演示。
 * 不豁免的话它们全被判成"目标文件不存在"，而一条常年误报的检查等于没有检查。
 * 代价如实记在这：检查器管不到自己。
 */
export const SELF_SKIP = ['tooling/ref-lint.mjs', 'tooling/test/ref-lint.test.mjs'];

/**
 * 历史标记词。判据比"邻行出现这些词"严得多，见 isPast()。
 * 为什么这么严（第一轮就踩到）：ui.ts 那句「**这里原本还自己 emit 了一条，删掉了。**
 * 引擎的 ctxBase.saveArtifact 内部已经发过一条（interpreter 那一段）」里的「原本」
 * 说的是**被删掉的那次 emit**，与行号无关；而那句引用是对**当前行为**的断言，
 * 且真的是坏的。
 */
export const PAST_MARKERS = ['从前', '以前', '此前', '原本', '过去', '当年', '曾经'];
/** 标记之后允许出现的"指向写法"的动词（"从前写的是 X"、"以前这里是 X"） */
const PAST_VERB = '(?:写|写作|这里|指|引用|标|记)';

/**
 * 通用词：命中它们不能算"指对了"。
 * 只放"本仓注释里几乎每句都有、且不可能是被指向之物"的词。
 * ⚠ **不放** `status`/`cause`/`kind`：它们既是常用词、也确实常是被指向的字段名
 * （`StepResultSchema.cause`）。那种歧义只能靠人读 —— 本检查只保证抓到
 * "落点与作者说的东西毫无词汇交集"这一种坏形状。
 */
export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but', 'you', 'your',
  'todo', 'fixme', 'http', 'https', 'tsx', 'json', 'md', 'vs', 'etc',
  'grep', 'lint', 'test', 'tests', 'src', 'docs', 'tooling', 'packages', 'engine',
  'true', 'false', 'undefined', 'string', 'number', 'boolean', 'return', 'const', 'async', 'await',
  'error', 'errors',
]);

/**
 * 候选词超过这个数 => 判定降级为 `weak`，**不报 ok**。
 *
 * 为什么需要这一档：docs/08 的登记表是一行一格的 Markdown 表，
 * 一行动辄上千字。引用写在这种行里时，窗口能捞出两百多个候选词，
 * 于是"任一候选命中"这个判据几乎必然成立 —— 它不再是证据，是噪声。
 * 实测正是这样：`docs/08` 那行里指向解释器 `runChildren` 那一段的引用被判 ok，
 * 而同一个坏指针写在 gate.ts 的普通注释里（候选 9 个）就被抓到了。
 * 换成 ok 就等于**让文档的排版替坏指针作证**，而"看着精确所以没人怀疑"
 * 恰恰是本类缺陷的原形。
 *
 * 判 weak 而不是判 stale：它今天确实可能指对了，只是**无法从这段文字判断**。
 * 处理办法和别的 weak 一样 —— 把行号引用改成符号名引用，这条自然就消失了。
 */
export const WEAK_POOL = 20;

/** 窗口半径，引用侧与目标侧共用（不对称会让一侧的系统性偏移变成另一侧的误报） */
export const WINDOW = 2;

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*/g;

const listFiles = (dirAbs, acc = []) => {
  for (const name of readdirSync(dirAbs)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dirAbs, name);
    if (statSync(p).isDirectory()) listFiles(p, acc);
    else if (SCAN_EXTS.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
};

export function findSources(root = ROOT) {
  const out = [];
  for (const d of SCAN_DIRS) {
    const p = join(root, d);
    if (existsSync(p)) listFiles(p, out);
  }
  return out;
}

/** 一个词是不是作为独立词出现（`ctx` 不该被 `ctxBase` 满足；`a.b` 允许出现在 `obj.a.b` 里） */
export const hasWord = (text, tok) => {
  const esc = tok.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$.])${esc}(?![A-Za-z0-9_$])`).test(text);
};

/**
 * 引用者周围是不是在说历史。判据见文件头第 3 条。
 * @param lines 全文按行
 * @param refLineIdx 引用所在行（0 基）
 * @param refCol 引用 token 在该行的起始列（0 基）
 */
export function isPast(lines, refLineIdx, refCol) {
  const from = Math.max(0, refLineIdx - 2);
  const to = Math.min(lines.length - 1, refLineIdx + 2);
  const buf = lines.slice(from, to + 1).join('\n');
  let off = refCol;
  for (let i = from; i < refLineIdx; i++) off += lines[i].length + 1;
  /*
   * 句子边界含换行：折行的注释在"一句"里的两段文字要能连起来看，
   * 但换行本身不能成为句界的话……这里取**两者之间**的处理 ——
   * 以换行为软界（同一句里允许跨行），以句读为硬界。
   * 实现上：先按硬界切，切出来的"句"内部保留换行，标记与引用落在同一硬句内即可。
   */
  let start = 0;
  const hard = [];
  for (const m of buf.matchAll(/[。；;！!?？]/g)) {
    hard.push({ text: buf.slice(start, m.index), start, end: m.index });
    start = m.index + 1;
  }
  hard.push({ text: buf.slice(start), start, end: buf.length });
  for (const s of hard) {
    if (off < s.start || off >= s.end) continue;
    const head = s.text.slice(0, off - s.start);
    for (const mk of PAST_MARKERS) {
      const at = head.lastIndexOf(mk);
      if (at < 0) continue;
      // 标记与引用之间只允许隔"写的是 / 这里是 / 指的是"这种短距离（可跨行）
      const between = head.slice(at + mk.length).trimEnd();
      if (new RegExp(`${PAST_VERB}[^。；;]{0,30}[:：]?$`, 's').test(between)) return true;
    }
  }
  return false;
}

/** 反引号里含 `<-` => 这段是贴出来的工具输出（多半还是坏例子），不是指针 */
export function isQuotedOutput(line, refStart, refEnd) {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const s = m.index;
    if (refStart >= s && refEnd <= s + m[0].length && m[1].includes('<-')) return true;
  }
  return false;
}

/**
 * 引用周边窗口里的候选词。
 * @param refFile 被指向的文件名（`ui.ts`）：它自己不算证据 —— `ui.ts:100` 里的 `ui`
 *        是**指针的写法**，拿它去目标行里找词等于让路径名替作者作证。
 * @param stem 引用者所在文件的主名（`gate.ts` => `gate`）：同理不指自己。
 *        ⚠ 只排**这一个**名，不排"所有看起来像文件名的词"：文档里写
 *        `adapter-web/src/ui.ts` 那种全路径时，`ui` 恰恰就是被指向的文件，一起排掉
 *        会把好引用判成坏（本轮就这么错过一条）。
 */
export function candidates(lines, refLineIdx, refFile, stem) {
  const pool = [];
  const seen = new Set();
  const refBase = refFile.toLowerCase().replace(/\.[a-z]+$/, '');
  for (let i = refLineIdx - WINDOW; i <= refLineIdx + WINDOW; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    // 抹掉窗口里所有引用本身再提词（否则路径段会成为候选证据）
    const text = raw.replace(REF_RE, (s) => ' '.repeat(s.length));
    const d = Math.abs(i - refLineIdx);
    for (const m of text.matchAll(TOKEN_RE)) {
      const tok = m[0];
      const lower = tok.toLowerCase();
      if (STOPWORDS.has(lower) || seen.has(tok)) continue;
      if (lower.replace(/\.[a-z]+$/, '') === refBase) continue;
      if (stem && lower === stem.toLowerCase()) continue;
      pool.push({ t: tok, d });
      seen.add(tok);
    }
  }
  // 近的优先只影响 --evidence 里先看到哪个候选；判定是"任一命中"
  return pool.sort((a, b) => a.d - b.d).map((x) => x.t);
}

/**
 * 目标文件定位。文档里常写**省掉 `packages/`（有时还有 `src/`/`test/`）的简写**：
 * 写 `cli/wiring.ts:526` 时实际指 `packages/cli/src/wiring.ts`。
 * （这里本来举的是本仓某条真实简写引用的原行号，本轮把它改成虚构示例 ——
 * 本文件免检，写一个真行号在这里就是写一个**永远不会红**的可能过期的断言。）
 * 这一层必须容忍 —— 否则**每一条这样写的引用都因为"文件不存在"被判坏**，
 * 而一条常年误报的检查等于没有检查（本仓记过好几次"检查红了没人看"的账）。
 */
export function resolveTarget(file, root, byName) {
  if (!file.includes('/')) return byName.get(basename(file)) ?? [];
  const direct = join(root, file);
  if (existsSync(direct)) return [direct];
  const dir = join(root, ...file.split('/').slice(0, -1));
  for (const p of ['', 'src/', 'test/']) {
    const cand = join(dir, p + basename(file));
    if (existsSync(cand)) return [cand];
  }
  const pkgDir = join(root, 'packages', ...file.split('/').slice(0, -1));
  for (const p of ['', 'src/', 'test/']) {
    const cand = join(pkgDir, p + basename(file));
    if (existsSync(cand)) return [cand];
  }
  return [];
}

/**
 * 主判定。返回全部引用 + 每条判定，`--evidence` 直接给人看。
 * verdict: ok | stale | missing-file | skip:history | skip:quoted | skip:no-identifier | skip:self | skip:escaped
 */
export function checkRefs(root = ROOT) {
  const files = findSources(root);
  const byName = new Map();
  for (const f of files) {
    const k = basename(f);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const cache = new Map();
  const linesOf = (p) => {
    if (!cache.has(p)) cache.set(p, readFileSync(p, 'utf8').split('\n'));
    return cache.get(p);
  };
  const refs = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const lines = linesOf(f);
    const stem = basename(f).replace(/\.[a-z]+$/, '');
    const selfFile = SELF_SKIP.includes(rel);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hitEscape = line.includes(ESCAPE);
      for (const m of line.matchAll(REF_RE)) {
        const [token, file, n0, n1] = m;
        const ref = { file: rel, line: i + 1, target: `${file}:${n0}${n1 ? `-${n1}` : ''}`, verdict: '', detail: '' };
        refs.push(ref);
        if (selfFile) { ref.verdict = 'skip:self'; continue; }
        if (hitEscape) { ref.verdict = 'skip:escaped'; continue; }
        if (isPast(lines, i, m.index)) { ref.verdict = 'skip:history'; continue; }
        if (isQuotedOutput(line, m.index, m.index + token.length)) { ref.verdict = 'skip:quoted'; continue; }
        const myPkg = rel.split('/')[1] ?? '';
        const cands = resolveTarget(file, root, byName);
        if (cands.length === 0) { ref.verdict = 'missing-file'; continue; }
        // 同包候选排前面；判定仍是"任一命中"（文件头第 6 条）
        const samePkg = (p) => (p.slice(root.length + 1).split('/')[1] === myPkg ? 0 : 1);
        const ordered = [...cands].sort((a, b) => samePkg(a) - samePkg(b));
        const pool = candidates(lines, i, basename(file), stem);
        if (pool.length === 0) { ref.verdict = 'skip:no-identifier'; continue; }
        ref.detail = `候选 ${pool.slice(0, 5).join(', ')}`;
        let beyondEnd = false;
        let hit = false;
        for (const c of ordered) {
          const cl = linesOf(c);
          const a = Number(n0);
          const b = n1 ? Number(n1) : a;
          if (a > cl.length) { beyondEnd = true; continue; }
          // 目标侧同样开 ±WINDOW 的窗口，理由见文件头第 1 条
          const seg = cl.slice(Math.max(0, a - 1 - WINDOW), Math.min(cl.length, b + WINDOW)).join('\n');
          if (pool.some((t) => hasWord(seg, t))) { hit = true; break; }
        }
        if (hit) ref.verdict = pool.length > WEAK_POOL ? 'weak' : 'ok';
        else {
          ref.verdict = 'stale';
          if (beyondEnd) ref.detail += '；目标文件没有那一行';
        }
      }
    }
  }
  return refs;
}

/**
 * 违规 = 坏指针 **+ 判不出**。
 * 把 weak 也算进退出码是有取舍的：它今天可能指对了，所以这不是"抓到缺陷"而是
 * "要求作者把这条变成可判定的"。修法与坏指针同一个、且更便宜 —— 去掉行号改用符号名。
 * 留在绿里不行：一条常年输出"另有 N 条判不出"而从不拦人的命令，
 * 与文档里写一句"记得核对引用"是同一件没用的事。
 */
export function violations(refs) {
  return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'missing-file' || r.verdict === 'weak');
}

export function printReport(refs, { evidence = false } = {}) {
  const bad = violations(refs);
  const n = (v) => refs.filter((r) => r.verdict === v).length;
  const nBad = n('stale') + n('missing-file');
  /*
   * 四种跳过**全部印在摘要里**，不折成一句"其余免检"。
   * 这条检查的价值全在"绿有多少是真绿"：skip:no-identifier 堆到几十条而屏幕
   * 只写"全部通过"，那个绿就是被跳过撑起来的，与没检查一样
   *（unread-fields 也直接印未读数，不藏进"已豁免"）。
   */
  console.log(`引用存活检查：共 ${refs.length} 条 —— 活 ${n('ok')}、坏 ${nBad}、`
    + `判不出（候选过多）${n('weak')}、历史句式免检 ${n('skip:history')}、`
    + `贴的工具输出 ${n('skip:quoted')}、提不出候选词 ${n('skip:no-identifier')}、`
    + `本检查自身文件 ${n('skip:self')}、行内标记 ${n('skip:escaped')}`);
  /* 打印时分开：weak 虽计入退出码（见 violations），但它不是"抓到缺陷"，
     混在坏指针列表里会让人以为这两类的处理紧迫性一样。 */
  for (const r of refs.filter((x) => x.verdict === 'stale' || x.verdict === 'missing-file')) {
    console.log(`  坏  ${r.file}:${r.line}  ->  ${r.target}`
      + `${r.verdict === 'missing-file' ? '（找不到目标文件）' : `（落点附近找不到 ${r.detail}）`}`);
  }
  for (const r of refs.filter((x) => x.verdict === 'weak')) {
    console.log(`  判不出  ${r.file}:${r.line}  ->  ${r.target}  ${r.detail} —— 候选太多，任一命中等于没命中`);
  }
  if (evidence) for (const r of refs) console.log(`  ${r.verdict.padEnd(20)} ${r.file}:${r.line} -> ${r.target}  ${r.detail}`);
  return bad;
}

function main() {
  const refs = checkRefs();
  const bad = printReport(refs, { evidence: process.argv.includes('--evidence') });
  if (bad.length) {
    /*
     * 「坏 0 却退出 1」是可能出现的：只剩判不出那档时就是这样（weak 计退出码、
     * 不计入"坏"那个数）。不点明的话，人看到的第一反应是"这条命令自己有 bug"，
     * 于是去查工具而不是去改引用 —— 与"印全四个 skip 数"是同一条理由。
     */
    if (!refs.some((r) => r.verdict === 'stale' || r.verdict === 'missing-file')) {
      console.log('\n（这一轮没有抓到坏指针，红的原因是**判不出**的那几条：'
        + '它们今天可能指对了，但这段文字不足以判定，所以照样拦。）');
    }
    console.log('\n行号引用是注释里最容易烂掉的一种引用：改一个名字不会有人回来同步。'
      + '\n首选修法：改成**按符号名引用**（`StepSchema`、`WaitOptionsSchema.onTimeout`），'
      + '行号本来就不该出现在注释里。'
      + '\n确实要留行号时，把"这里从前写的是 :NN"单独成句（那个句式免检），'
      + '或在行尾加 `ref-lint:ignore` 并写明理由。');
  }
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
