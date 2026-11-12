/**
 * **接口字段里的"幽灵字段"守卫** —— `packages 各包的 src` 里那些**声明了而全仓没人碰**的
 * 非 zod interface 字段。
 *
 * ## 它补的是哪一格：`unread-fields.mjs` 看不见这里
 *
 * `tooling/unread-fields.mjs` 只扫 `packages/ir/src` 里的 **zod schema**
 * （它自己的注释写着"字段定义处只此一处"）。所以「有字段、没生产者、没读者」
 * 这个本仓列为权威缺陷族的形状（docs/08 §3 (a)/(e)），
 * **只要长在 IR 之外就全程无人报警** —— 这不是推测：
 * `DryRunResult.exprSummaries` 恒空挂了整整两轮，扫描器一次都没响，
 * 而它是 `engine/src` 里一个普通 TS interface 的字段。
 *
 * ## 判据为什么这么窄（以及为什么只有一档会失败）
 *
 * 名字命中**不等于**读过（`unread-fields.mjs` 文件头同一条纪律：
 * 宁可承认判不出，也不要让"碰过"冒充"读过" —— 一条字段一旦被算成"有人管"就从此没人再看）。
 * 而这里更严一档：**只报"整个仓库的代码里，除了它自己那句声明，一次都没出现过"**的字段。
 *
 * 这不是偷懒，是量出来的取舍（**读数按「实测不进文档」的规矩放测试里**：
 * `tooling/test/dead-iface-fields.test.mjs` 那条「宽松判据现场算」每次跑都重算
 * 两条判据的量级关系，不抄写死的数字）。宽松判据（"src 里没有任何 `.字段` 命中"）
 * 点名的绝大多数是误报 —— 解构、建对象、spread、同名方法都会让"读过"在词法层面看不见。
 * 本轮逐个手查过：它当时点名的字段里只有两个真死
 * （`ServeOptions.onOutput` 与 `AxNode.backendDOMNodeId`，本轮都删了，
 * 见 `packages/server/src/index.ts` 与 `adapter-web/src/session.ts` 里那两段）。
 * ⚠ 我先前把这一格写成"26 个里 26 个是误报"，那句在第二个真死字段被删的当天
 * 就已经不精确 —— 而"宽松判据点名的**都**不是真死的"这个方向根本不该断言：
 * 真死的字段被两条判据同时点名很正常，两条判据没有包含关系。
 * 所以这一道**只做那一个判据**，宁可漏报。
 *
 * 漏掉的那一类不是不知道：`MockServer.requests` 那种"src 里没人 `.读` 但被建出来"的
 * 形状，本工具**不报**。它的存在写在下面 `inconclusive` 那一档的计数里，
 * 让人看得见"还有一片看不清的地方"，而不是假装覆盖到了。
 *
 * ## 三档
 *
 *  - **死**（`codeMentions === 0`）→ 报并**让 lint 失败**。
 *  - **判不出**（1~2 次命中）→ 打出来给人看，不失败。
 *  - **有人碰**（≥3 次）→ 不管。
 *
 * 命中只数**代码**（注释与字符串掩掉，复用 `unread-fields.mjs` 那两套掩码）：
 * 一个名字只在散文里出现，不算"有人读" —— 而**它反过来也不该救活一个死字段**。
 * 掩码同时挡掉另一类假阴：`.scratch/probe-*` 与 `docs/**` 里的**散文提及**。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskCommentsOnly, maskNonCode, matchBrace } from './unread-fields.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** 被扫的"字段定义侧"：各包的 src（不含 .d.ts，那里面本来就只有声明） */
const SRC_GLOBS = ['packages', 'tooling'];
/** 找"有没有人碰"的范围：整仓代码（含 test / bin / tooling），但不含依赖与产物 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.scratch', 'coverage', 'tmp', 'evidence']);

/** @returns 仓库里所有可能含代码的文件绝对路径 */
export function listSourceFiles(root = ROOT, dirs = SRC_GLOBS) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs)$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

const IFACE_RE = /^[ \t]*(?:export[ \t]+)?interface[ \t]+[A-Za-z0-9_$][A-Za-z0-9_$]*(?:<[^{};]*>)?[^{]*\{/gm;
// 字段名前面允许是**行首**、`{`、`;`、或换行 —— 都算"这个 name 挂在这一层"。
// 从前只认行首（`^[ \t]{2,}`），于是 `interface B { deep: number }` 这种**单行 interface**
// 整段抽不出字段（`deep` 前面是 `{` 不是行首）。方法名不会被误收：
// `f(x: number): string;` 里 `f` 后面紧跟 `(`，不满足"name 后面是 `:`"。
const FIELD_RE = /(?<=[{;\n])[ \t]*(?:readonly[ \t]+)?([A-Za-z0-9_$]+)[ \t]*\??[ \t]*:/gm;

/**
 * 从一个文件里抽出所有 `interface X { field: ... }` 的字段。
 * 只认**行首缩进两格以上**的 `name:` —— 那挡住了函数体里的对象字面量
 * （它们的缩进通常更深，但更关键的是本函数只走进 interface 的花括号范围）。
 *
 * 扫的是**掩码后**的文本，所以注释里那些"举个 interface 例子"的代码块不会产字段；
 * 而字段名与行号从**原文**取（掩码会把内容换成空格，位置不变）。
 */
export function extractInterfaceFields(relPath, src) {
  const masked = maskCommentsOnly(src);
  const fields = [];
  IFACE_RE.lastIndex = 0;
  for (const m of masked.matchAll(IFACE_RE)) {
    // 掩码文本上找 `{`（掩码把注释与字符串整段抹成空格、**长度不变**，
    // 所以找到的下标在原文里同样是那个 `{`）—— 而"下一个 `{`"是错的：
    // `interface B { deep: number }` 里下一个 `{` 是嵌套对象的，
    // 于是 `B` 整段被跳过，`deep` 永远不被报（`.scratch` 探针量出来的）。
    let open = m.index;
    { let i = open; while (i < masked.length && masked[i] !== '{') i++; open = i; }
    if (open < 0) continue;
    const close = matchBrace(masked, open);
    if (close < 0) continue;
    const mIface = m[0].match(/interface[ \t]+([A-Za-z0-9_$]+)/);
    if (!mIface) continue;
    const iface = mIface[1];
    // 逐条判断"这个 `name:` 挂不挂在外层 interface 上"：它前面到 `{` 之间
    // 不能有未闭合的 `{` 或 `(`。
    //  · `{` 那一半挡的是内联对象（`nested: { a: 1; b: 2 }` 里的 a/b 不是外层字段）；
    //  · `(` 那一半挡的是**跨行写的方法签名** —— `fn(\n  cb: () => void,\n): void;`
    //    里那个 `cb` 在 `{}` 深度上是 0，只看花括号会把它当成字段，
    //    而它一旦哪天没人引用就会被报成"死字段"（假阳性，本工具最不该产出的东西）。
    //    探针 `.scratch` 量过这个形状，仓库里 `cdp.ts` / `resolve.ts` 的 constructor 就是它。
    // 方法名本身（`f(x: number): string;`）不会被收：`f` 后面紧跟 `(`，不满足"name 后面是 `:`"。
    FIELD_RE.lastIndex = 0;
    // 切片**从 `{` 那一格开始**（不是 open+1）：FIELD_RE 的前置断言要找的正是那个 `{`，
    // 切掉它的话单行 interface（`interface B { deep: number }`）里 `deep` 前面只剩空格，
    // 前置断言永远不成立 —— 这一格我先前改过一次而没生效，就是栽在这里。
    for (const fm of masked.slice(open, close).matchAll(FIELD_RE)) {
      const between = masked.slice(open + 1, open + 1 + fm.index);
      let brace = 0, paren = 0;
      for (const ch of between) {
        if (ch === '{') brace++;
        else if (ch === '}') brace--;
        else if (ch === '(') paren++;
        else if (ch === ')') paren--;
      }
      if (brace !== 0 || paren !== 0) continue;
      fields.push({ iface, field: fm[1], file: relPath, start: open + 1, end: close, raw: src });
    }
  }
  return fields;
}

/**
 * 把整份语料掩码**一次**。
 * ⚠ 这个"一次"是必需的，不是风格：本轮先前写成在 `countCodeMentions` 里面掩，
 * 于是每个字段 × 每个文件各掩一遍全文（683 × 191 次），整条守卫跑到分钟级
 * 而被我中断 —— 一条要跑很久的门禁的下场就是被人关掉，那比没有门禁更坏。
 */
export function maskTexts(texts) {
  return new Map([...texts].map(([f, t]) => [f, maskNonCode(t)]));
}

/**
 * 统计一个字段名在**代码**里出现的次数，排除它自己声明所在的那段 interface body。
 * 第三个参数是**已经掩好**的语料（用 {@link maskTexts} 造）：
 * 掩码把注释与字符串都掉，所以 `foo.onOutput` 这种真代码算命中，
 * 而 `// 将来 onOutput 可以…` 与 `'onOutput'` 这种散文不算。
 */
export function countCodeMentions(field, files, maskedTexts, { file, start, end }) {
  const re = new RegExp(`\\b${field}\\b`, 'g');
  let n = 0;
  for (const f of files) {
    const masked = maskedTexts.get(f);
    if (f === file) {
      // 只挖掉**这一处**声明所在的那个 interface body（同名 interface 在别处还有声明时要照数）
      const before = masked.slice(0, start + 1);
      const after = masked.slice(end);
      n += (before.match(re) || []).length + (after.match(re) || []).length;
    } else {
      n += (masked.match(re) || []).length;
    }
  }
  return n;
}

export function scan(root = ROOT) {
  const files = listSourceFiles(root);
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const maskedTexts = maskTexts(texts);
  const fields = [];
  let scannedFileCount = 0;
  for (const f of files) {
    const rel = relative(root, f);
    // 字段定义侧只认 packages 各包的 src：tooling 里的 interface 是工具自己的形状，
    // 报它没意义（没人拿它当"平台对外契约"）
    if (!/^packages\/[^/]+\/src\//.test(rel)) continue;
    scannedFileCount++;
    for (const rec of extractInterfaceFields(rel, texts.get(f))) {
      rec.abs = f;
      fields.push(rec);
    }
  }
  const dead = [];
  const inconclusive = [];
  for (const rec of fields) {
    const n = countCodeMentions(rec.field, files, maskedTexts, { file: rec.abs, start: rec.start, end: rec.end });
    const item = { key: `${rec.iface}.${rec.field}`, file: rec.file, mentions: n };
    if (n === 0) dead.push(item);
    else if (n <= 2) inconclusive.push(item);
  }
  return { files: scannedFileCount, fields, dead, inconclusive };
}

export function report(res, { minFields = 200 } = {}) {
  const lines = [];
  let failed = false;
  lines.push(`interface 字段扫描：${res.files} 个文件、${res.fields.length} 个非 zod interface 字段`);
  if (res.dead.length) {
    failed = true;
    lines.push(`✗ 全仓代码里**除声明外零提及**的字段 ${res.dead.length} 个（幽灵字段：写了而没人用，而它看着像个可用接口）：`);
    for (const d of res.dead) lines.push(`    ${d.key}  (${d.file})`);
    lines.push('  要么删掉它，要么把它接上并留一条断言。留着的话，下一个人会以为传了就有效。');
  } else {
    lines.push('✓ 没有"除声明外零提及"的 interface 字段');
  }
  lines.push(`~ 只有 1~2 次代码提及、判不出的 ${res.inconclusive.length} 个（**不报为缺陷** —— `
    + `解构 / 建对象 / spread 都能让"读过"在词法层面看不见，误报的守卫等于没有守卫）`);
  // 自检：扫描本身得真的扫到了东西，否则上面那句"✓"是空转出来的。
  // 下限可由调用方降（临时夹具只有几个字段），**默认值就是真实仓库的那一档**。
  if (res.fields.length < minFields) {
    failed = true;
    lines.push(`✗ 只扫到 ${res.fields.length} 个 interface 字段（下限 ${minFields}），这个扫描不可信（"零死字段"是空转出来的）`);
  }
  return { lines, failed };
}

function main() {
  const res = scan();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ fields: res.fields.length, dead: res.dead, inconclusive: res.inconclusive.length }, null, 2) + '\n');
    return;
  }
  const { lines, failed } = report(res);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

// 与 unread-fields.mjs **同一个**入口判据（两份工具不一致的话，其中一份会静默不跑）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
