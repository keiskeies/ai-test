#!/usr/bin/env node
/**
 * 「schema 有字段、执行侧没人读」扫描器（docs/08 §3 那条缺陷类的机器化版本）。
 *
 * 为什么要有这个脚本：那个缺陷类已出现**八次**，八次全是**读代码时偶然发现**的。
 * docs/08 §3 早就写着"列出 ir/src 所有 zod 字段名，逐个查执行侧有没有读过 ——
 * 一次脚本就能跑出来，别靠偶然发现"。写了八次同一个 bug 之后，这句话就该变成代码。
 *
 * 三个刻意的设计决定，每个都对应一类会假装成功的失败：
 *
 *  1. **只看各包的 src 目录，测试目录不算消费者。**
 *     字段只被自己的测试读，正是这个缺陷类的标准形态：测试断的是"schema 接受这个字段"，
 *     执行侧一行没读，测试照样全绿。把 test 算进来等于让每条缺陷自己给自己作证。
 *
 *  2. **判"读过"用标识符出现（点号 / 解构 / ['名'] / 字符串字面量），不做类型级数据流。**
 *     这是**过近似**：同名字段（`step.id` vs `doc.id`）会被算成读过，可能漏报。
 *     方向是故意的 —— 这个工具的产出是一个**结论**（"这字段有人管"），
 *     一个会把干净代码报成脏的工具会有人去修代码，
 *     一个把脏代码报成干净的工具会让所有人继续信那句假话。
 *     过近似的代价是多算，而多算的部分用 `--evidence` 能一眼看出来（每条命中给位置）。
 *
 *  3. **未读要有 baseline 豁免，豁免必须写理由和归属阶段。**
 *     IR 里本来就有一批字段是"给 P1/P2/P2.5 用的、现在还没开工"（docs/08 §3 末尾
 *     把这种"未读是没开工、不是接错线"讲清楚了）。没有 baseline 的扫描器第一版
 *     就报几十条，第二天就没人跑了。反过来，**豁免条目本身也被检查**：
 *     字段已经有人读了还挂着豁免 → 报"豁免过期"；字段整个不见了 → 报"指向不存在的字段"
 *     （改名/删字段时顺手漏掉的豁免，和漏掉一条新缺陷一样会静默留在表里）。
 *
 * 局限（不掩盖）：不做跨文件常量转发（`const K='foo'; obj[K]`）；模板字符串里的 `${}` 整段
 * 当非代码洗掉；正则字面量按启发式识别（识别失败时最坏是把一行代码洗掉，不会凭空造字段）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 字段定义处：只此一处。zod schema 全部在 packages/ir/src（已核实：其他包 src 里零个 z.object）。 */
const SCHEMA_DIR = 'packages/ir/src';
/** 消费者：真正执行的那几个包。不含 tooling/ —— 扫描工具读字段名不等于运行时会读。 */
const CONSUMER_DIRS = ['packages/engine/src', 'packages/adapter-http/src', 'packages/store/src', 'packages/cli/src'];

const BASELINE_REL = 'tooling/unread-baseline.json';

/* ------------------------------------------------------------------ 掩码 */

/**
 * 把注释与字符串/模板/正则**内容**换成空格，长度与换行数完全不变。
 *
 * 为什么要先掩码再找 `{`：`z.object` 在 ir/src 的**注释里**也出现
 * （locator.ts 的 JSDoc、以及任何一句解释 schema 的注释）。直接对 z.object 计数或
 * 对原文做括号配对，会因为注释里多出来的一对花括号把整个对象的边界配错 ——
 * 配错的后果不是报错，是**静默少抽几个字段**，也就是"这个字段其实没人读但没报出来"。
 *
 * 保留长度与换行，是为了让掩码后的下标能直接用在原文上（切片取键名、算行号）。
 */
export function maskNonCode(src) {
  const n = src.length;
  // 从**原文**出发，只把非代码区间抹成空格。
  // （这里曾经写成"全部初始化为空格"：结果整份文件被抹平，扫出 0 个字段，
  //  然后输出一句"全部有豁免"就 exit 0 —— 扫描器抽不到任何东西时不会报错，它只会报告干净。）
  const out = src.split('');
  /** 上一个"有意义"的字符，用来判 `/` 是正则还是除号 */
  let prev = '';
  const regexOkHere = () => prev === '' || '(=,:[!&|?{};+-*%~^<>'.includes(prev);

  const blank = (from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, n); i++) if (src[i] !== '\n') out[i] = ' ';
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      blank(i, Math.min(j, n));
      prev = c;
      i = j;
      continue;
    }
    if (c === '`') {
      // 模板串整段洗掉（含 ${…}）。ir/src 的 schema 体里没有模板串，
      // 而消费者里模板串中的 ${} 出现标识符是常事 —— 宁可少认一个命中（见文件头第 2 条）。
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`' && depth === 0) { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (src[j] === '}' && depth > 0) { depth--; j++; continue; }
        j++;
      }
      blank(i, Math.min(j, n));
      prev = '`';
      i = j;
      continue;
    }
    if (c === '/' && regexOkHere()) {
      // 正则字面量：只在同一行内找收尾的 /，找不到就当除号（`a / b` 很常见）。
      let j = i + 1;
      let closed = -1;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') { j++; while (j < n && src[j] !== ']' && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } continue; }
        if (src[j] === '/') { closed = j; break; }
        j++;
      }
      if (closed > 0) {
        blank(i, closed + 1);
        i = closed + 1;
        prev = '/';
        continue;
      }
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
    i++;
  }
  return out.join('');
}

/* -------------------------------------------------------------- 抽字段 */

/**
 * 行号计数器。**先数好所有换行的位置，再二分** —— 不能写成
 * `text.slice(0, index).split('\n').length`：那是对每个命中切一次前缀，
 * 一个 2000 行文件里几千个标识符就把整份文件重切几千遍（O(n²)，实测会跑到秒级，
 * 而一个要挂进 npm test 的门禁跑到秒级，人就会开始怀疑跑它值不值）。
 */
export function makeLineOf(text) {
  const nl = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') nl.push(i);
  return (index) => {
    let lo = 0;
    let hi = nl.length; // 找第一个 > index 的换行位置
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/** 从 `{` 的下标开始做深度配对，返回收尾 `}` 的下标；不配对则返回 -1。掩码文本上跑。 */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 取对象体（不含外层花括号）里**深度 0** 的键名。 */
export function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; i++; continue; }
    if (depth !== 0) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < body.length && /[A-Za-z0-9_$]/.test(body[j])) j++;
      const name = body.slice(i, j);
      let k = j;
      while (k < body.length && (body[k] === ' ' || body[k] === '\n' || body[k] === '\t')) k++;
      // `k?: T` 与 `k: T` 都算键；`a => b` 的 `=>` 前面不是冒号（除非是三元，三元在括号里 → depth>0）。
      if (body[k] === '?' && body[k + 1] === ':') keys.push(name);
      else if (body[k] === ':') keys.push(name);
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

/**
 * **`z` 与 `.object` 之间必须允许换行。** ir/src 里两种写法都有：
 * steps.ts 是 `z.object({ … })` 单行链（23 处），locator/scenario/trace/baseline
 * 是 Prettier 风格的 `z\n  .object({ … })` 断链（19 处）。
 * 只匹配单行那种的话，扫出来的字段少了将近一半，而输出依然是一句"全部有豁免"——
 * 一个"抽不到字段"的扫描器不会报错，它只会**报告干净**，这正是最坏的错误形态。
 * 所以字段总数有下限断言（tooling/test/unread-fields.test.mjs）。
 */
const OBJ_RE = /z\s*\.\s*(?:object|strictObject|looseObject)\s*\(\s*\{/g;
const CONST_RE = /(?:export\s+)?(?:const|let|var|function)\s+([A-Za-z0-9_$]+)/g;

/** 离 pos 最近的那个 const 名 —— 内联嵌套对象因此归到包着它的那个具名 schema。 */
function nearestName(masked, pos) {
  let last = null;
  CONST_RE.lastIndex = 0;
  let m;
  while ((m = CONST_RE.exec(masked)) && m.index < pos) last = m[1];
  return last ?? '(匿名)';
}

/** 一个 schema 字段。 */
export function extractFields(relPath, src) {
  const masked = maskNonCode(src);
  const lineOf = makeLineOf(masked);
  const fields = [];
  for (const m of masked.matchAll(OBJ_RE)) {
    const open = masked.indexOf('{', m.index);
    const close = matchBrace(masked, open);
    if (close < 0) continue; // 配不上对：宁可整个跳过也不要在错误范围里抽键（会抽出假字段）
    const owner = nearestName(masked, m.index);
    for (const key of topLevelKeys(masked.slice(open + 1, close))) {
      // 从对象体起点往后找键名，而不是在整个文件里找：同一个词可能在注释里、
      // 在别的 schema 里先出现过，那样行号会指到无关位置（行号错了，人按图索骥
      // 打开文件看到的却是另一回事 —— 这比没有行号更坏）。
      const at = masked.indexOf(key, open + 1);
      fields.push({
        file: relPath,
        schema: owner,
        key,
        line: at < 0 || at > close ? 0 : lineOf(at),
        id: `${relPath}#${owner}.${key}`,
      });
    }
  }
  return fields;
}

/* ----------------------------------------------------------- 找消费者 */

export function listTsFiles(dirAbs) {
  const out = [];
  if (!existsSync(dirAbs)) return out;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e === 'node_modules' || e === 'dist' || e === 'test') continue;
        walk(p);
      } else if (e.endsWith('.ts')) out.push(p);
    }
  };
  walk(dirAbs);
  return out.sort();
}

/** readers 累加一条命中（同名的多次出现都留着，--evidence 时要能给人看位置） */
function addRead(readers, token, rec) {
  const list = readers.get(token);
  if (list) list.push(rec);
  else readers.set(token, [rec]);
}

/*
 * ── 证据分级 ─────────────────────────────────────────────────────────────
 *
 * 起因：`as` 这个字段名在消费者代码里有 **194 处裸词命中**（`x as Type` 的
 * TypeScript 断言、`import ... as ...`），但只有个位数是"在读某个对象的 as 成员"。
 * 用裸词判"读过"，`table.as` 与 `dataSource.as` 这两条**真·没人读**的字段会被算成
 * "211 处读过"，扫描器对它们**永久失明**。而 IR 里字段名撞上高频词/关键字的不止这两个
 * （`kind`/`name`/`type`/`id`/`path`/`mode`/`source`/`scope`/`rows`… 全中）。
 *
 * 于是分三级，**并且承认第三级判不了**：
 *  - **read**：有强证据（成员访问 / 解构 / 下标），且这个名字只在一个 schema 里声明过
 *    —— 能确定这条访问就是冲它来的。
 *  - **inconclusive**：只有裸词命中，或者这个名字在多个 schema 里同名。
 *    后一条是**结构性**的判不了：`s.as` 那唯一一处成员访问属于 forEach，
 *    而 table/dataSource 的 `as` 一次都没被读 —— 词法层面**分不出这两个 as**。
 *    要分只能上类型级（TypeScript 编译器 API 看变量的声明类型），记在 docs/08 当 P2。
 *  - **unread**：一个命中都没有。这一级才是扫描器能负责的。
 *
 * 关键是**别让 inconclusive 冒充 read**：它冒充一次，那条字段就从此没人再看，
 * 而"配了没生效"的缺陷正是靠这种"看起来有人管"活着（docs/08 §3 那个缺陷类）。
 */

/** 一个标识符在代码里的角色：成员访问 / 解构或对象键 / 下标字符串 / 裸词 */
export function roleOf(masked, start, end) {
  let p = start - 1;
  while (p >= 0 && /\s/.test(masked[p])) p--;
  const prev = p >= 0 ? masked[p] : '';
  if (prev === '.') return 'member';
  /*
   * `[foo]` **不算证据**。掩码之后字符串内容已经空了，所以这里能看到的
   * `[x]` 一定是 `arr[i]` 这种**把标识符当数组下标用**的写法 ——
   * 它读的是那个下标变量，不是"某个对象的 foo 字段"。
   * 早先把它算成强证据，实测会把 `path`/`key`/`id`/`name` 这些
   * "恰好被拿来当索引"的名字判成读过（42 个标识符里有 9 个是 IR 字段名）。
   * 判不出来就落到 bare，宁可多几条"判不出"。
   */
  let n = end;
  while (n < masked.length && /\s/.test(masked[n])) n++;
  const next = n < masked.length ? masked[n] : '';
  // `{ foo` / `, foo` 后面跟 `,` `}` `:` —— 解构或对象字面量的键
  if ((prev === '{' || prev === ',' || prev === '(') && (next === ',' || next === '}' || next === ':' || next === ')')) return 'binding';
  return 'bare';
}

/** 强证据的两种角色。bare 不算：同名局部变量、TS 断言关键字都会造出一堆假命中。 */
const STRONG_ROLES = new Set(['member', 'binding']);

/**
 * 收集一个文件里所有"标识符 + 它在代码里的角色"。
 *
 * 单独成函数是为了**能被测**：这段逻辑原先直接写在 scan() 的循环里，
 * 于是想测它只能在测试里重抄一遍同样的正则 —— 重抄的那份和真正跑的那份
 * 可以各自漂移，而测试永远是绿的（本仓那个缺陷类的测试侧镜像）。
 */
export function collectTokens(src, rel = '') {
  const masked = maskNonCode(src);
  // 一个计数器就够：maskNonCode 只把内容换成空格，长度与换行位置与原文完全一致，
  // 所以掩码文本上的下标能直接用原文的行号表来查。
  const lineOf = makeLineOf(src);
  const out = [];
  for (const m of masked.matchAll(/[A-Za-z0-9_$]+/g)) {
    out.push({ token: m[0], role: roleOf(masked, m.index, m.index + m[0].length), file: rel, line: lineOf(m.index) });
  }
  for (const m of src.matchAll(/['"`]([^'"`\n]{1,120})['"`]/g)) {
    for (const w of m[1].split(/[^A-Za-z0-9_$]+/)) {
      if (!w) continue;
      // 字符串里的词**永远只算弱证据**：脱敏规则表里有 'password' 不等于读了 password 字段
      out.push({ token: w, role: 'bare', viaString: true, file: rel, line: lineOf(m.index) });
    }
  }
  return out;
}

/** 跑一遍全量扫描。返回 { fields, unread, hits }。 */
export function scan(root = ROOT) {
  const fields = [];
  for (const f of listTsFiles(join(root, SCHEMA_DIR))) {
    const rel = relative(root, f).split(sep).join('/');
    fields.push(...extractFields(rel, readFileSync(f, 'utf8')));
  }
  // 同名字段可能出现在两个 schema 里；按 id 去重（id 含文件名与 schema 名）。
  const uniq = new Map();
  for (const f of fields) if (!uniq.has(f.id)) uniq.set(f.id, f);

  const readers = new Map(); // token → [{file, line, role}]
  for (const dir of CONSUMER_DIRS) {
    for (const f of listTsFiles(join(root, dir))) {
      const rel = relative(root, f).split(sep).join('/');
      // 取词一律走 collectTokens —— 它是**被测的那一份**。
      // 早先这里内联了一份同样的正则，而测试只能在测试里重抄第三份：
      // 三份各自漂移也不会红，因为跑的这份没人测（本仓缺陷类的测试侧镜像）。
      for (const t of collectTokens(readFileSync(f, 'utf8'), rel)) addRead(readers, t.token, t);
    }
  }

  // 同一个字段名在几个 schema 里声明过。>1 时**任何命中都无法归到具体某一条**：
  // `.as` 那一处访问属于 forEach，而 table/dataSource 的 as 一次都没被读 ——
  // 词法层面分不出这两个 as（要分只能上类型级数据流，见 docs/08）。
  const declCount = new Map();
  for (const f of uniq.values()) declCount.set(f.key, (declCount.get(f.key) ?? 0) + 1);

  const unread = [];
  const inconclusive = [];
  const hits = new Map();
  for (const [id, f] of uniq) {
    const rec = readers.get(f.key) ?? [];
    hits.set(id, rec);
    if (!rec.length) { unread.push(f); continue; }
    const strong = rec.filter((r) => STRONG_ROLES.has(r.role));
    // 只有"强证据 + 这个名字全局唯一"才敢说读过
    if (strong.length && (declCount.get(f.key) ?? 0) === 1) continue;
    inconclusive.push(f);
  }
  return { fields: [...uniq.values()], unread, inconclusive, hits, readers, declCount };
}

/* ------------------------------------------------------------ 对照豁免 */

/** baseline 与扫描结果对账。三种不一致都算门失败。 */
export function classify(fields, unread, baseline) {
  const exempt = new Map((baseline?.fields ?? []).map((e) => [e.id, e]));
  const present = new Set(fields.map((f) => f.id));
  const out = { newUnread: [], staleExempt: [], dangling: [], ok: [] };
  for (const f of unread) {
    const e = exempt.get(f.id);
    if (e) out.ok.push({ ...f, reason: e.reason, milestone: e.milestone });
    else out.newUnread.push(f);
  }
  // 豁免表里的每一条都要能对上号，对不上就必须说出来。三种情形各有各的修法：
  //  - id 根本不在字段表里 → **悬空**（字段被删了，或整个 schema 被改名了）
  //  - id 在字段表里、且仍然没人读、但没登记在未读里 → 不可能出现，忽略
  //  - id 在字段表里、现在**有人读了** → **过期**（把豁免删掉；留着的话，
  //    将来这个字段被改回不读时扫描会闭嘴，等于自己把自己的闸拆了）
  // 原先这里在判悬空之前先拿 e.schema 去替换 id 里的 "(匿名)"，意图是容忍
  // "内联对象改了归属"。但它同时会把"字段被挪到别的 schema"这条真实漂移洗掉 ——
  // 豁免静默失效与本仓那个缺陷类是同一件事。宁可让 id 严格全等。
  for (const [id, e] of exempt) {
    if (!present.has(id)) { out.dangling.push({ id, reason: e.reason }); continue; }
    if (!unread.some((f) => f.id === id)) out.staleExempt.push({ id, reason: e.reason });
  }
  return out;
}

export function loadBaseline(root = ROOT) {
  const p = join(root, BASELINE_REL);
  if (!existsSync(p)) return { fields: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}

/* ---------------------------------------------------------------- main */

export function report(res, base, opts = {}) {
  const c = classify(res.fields, res.unread, base);
  const lines = [];
  const inc = res.inconclusive ?? [];
  const read = res.fields.length - res.unread.length - inc.length;
  lines.push(`schema 字段 ${res.fields.length} 个：读过 ${read}、未读 ${res.unread.length}（已豁免 ${c.ok.length}）、**判不出 ${inc.length}**`);
  // 这句**无条件说**。它比任何一条未读列表都重要。
  lines.push('  "读过"要求**强证据**（成员访问 / 解构 / 下标）且该字段名全局唯一；');
  lines.push('  只有裸词命中、或同名字段出现在多个 schema 里（`.as` 分不清是 forEach 还是 table 的）');
  lines.push('  都只算**判不出** —— 宁可承认判不出，也不要让"碰过"冒充"读过"：');
  lines.push('  一条字段一旦被算成"有人管"，就从此没人再看，而那正是缺陷活着的方式。');
  lines.push('  另外**碰过也不等于用对了**（parallel.maxConcurrency 就是读了当 slice 下标用）——');
  lines.push('  用法对不对只有测试与变异检查能答。');
  if (opts.evidence) {
    const n = opts.evidenceN ?? 8;
    const sample = res.fields.filter((f) => (res.hits.get(f.id) ?? []).length).slice(0, n);
    lines.push('');
    lines.push(`—— 抽样 ${sample.length} 条"读过"的字段及其命中位置（用来人工抽查上面那句过近似有多粗）：`);
    for (const f of sample) {
      const at = (res.hits.get(f.id) ?? []).slice(0, 2).map((h) => `${h.file}:${h.line}${h.viaString ? '(字符串里)' : ''}`).join(', ');
      lines.push(`  ${f.schema}.${f.key} <- ${at}`);
    }
  }
  if (c.newUnread.length) {
    lines.push('');
    lines.push(`✗ 新增未读字段 ${c.newUnread.length} 个（不在 ${BASELINE_REL} 里）：`);
    for (const f of c.newUnread) lines.push(`  ${f.file}:${f.line}  ${f.schema}.${f.key}`);
    lines.push('');
    lines.push('  两种可能，必须分清：**没开工**（那就加进 baseline 并写清归属阶段与理由）');
    lines.push('  还是**接错线/压根忘了读**（那就是本仓那个缺陷类，改代码，别改 baseline）。');
    lines.push('  九例的历史教训是：这一类的症状永远是"用户以为自己在用一个功能，其实没有"。');
  }
  if (c.staleExempt.length) {
    lines.push('');
    lines.push(`~ 豁免已过期 ${c.staleExempt.length} 个（字段现在已经有人读，把豁免条目删掉）：`);
    for (const f of c.staleExempt) lines.push(`  ${f.id}`);
  }
  if (c.dangling.length) {
    lines.push('');
    lines.push(`~ 豁免指向不存在的字段 ${c.dangling.length} 个（改名/删字段后漏清，和漏一条新缺陷一样会静默留着）：`);
    for (const f of c.dangling) lines.push(`  ${f.id}`);
  }
  /*
   * 判不出的那些**不逐条要求豁免**（233 条会淹没新增未读），但要有**上限**：
   * 新增一个字段名撞上高频词的字段（比如再来一个 `as`/`type`），它会静默落进
   * 这个桶里、永远不会被追问 —— 上限就是专门抓这件事的。
   * 收紧靠"给新字段起个不撞名的名字"，这是真能做到的：字段名是 IR 的一部分，
   * 起得具体（rowVariable 而不是 as）本来就是更好的命名。
   */
  /*
   * 上限**没登记就算失败**（当有判不出的字段时）。
   * 早先写的是 `?? inc.length` —— 那是自我取消的检查：没登记时上限等于当前值，
   * 永远不超标，加了等于没加。现在没登记就要求人去登记一次。
   */
  const hasCeiling = typeof base.inconclusiveCeiling === 'number';
  const missingCeiling = !hasCeiling && inc.length > 0;
  const overCeiling = hasCeiling && inc.length > base.inconclusiveCeiling;
  if (missingCeiling) {
    lines.push('');
    lines.push(`✗ 有 ${inc.length} 个字段判不出，但 ${BASELINE_REL} 里没登记 inconclusiveCeiling。`);
    lines.push('  登记一次当前值即可。不接受"省略就等于不检查"。');
  }
  if (overCeiling) {
    lines.push('');
    lines.push(`✗ 判不出的字段 ${inc.length} 个，超过登记的 ${base.inconclusiveCeiling} 个：新加的字段名撞上了高频标识符，扫描器对它失明。`);
    lines.push(`  做法：把字段名改具体（例：as -> rowVariable），或确实需要的话在 ${BASELINE_REL} 里`);
    lines.push('  抬高 inconclusiveCeiling 并写清为什么。');
    for (const f of inc.slice(0, 8)) lines.push(`    ~ ${f.id}`);
    if (inc.length > 8) lines.push(`    …（共 ${inc.length} 条）`);
  }
  if (!c.newUnread.length && !c.staleExempt.length && !c.dangling.length && !overCeiling && !missingCeiling) {
    lines.push('✓ 未读字段全部有豁免，没有过期豁免，判不出的数量未增长');
  }
  return {
    lines, c,
    failed: c.newUnread.length + c.staleExempt.length + c.dangling.length > 0 || overCeiling || missingCeiling,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: argv.includes('--json'), evidence: argv.includes('--evidence') };
  const res = scan();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ total: res.fields.length, unread: res.unread, exempt: classify(res.fields, res.unread, loadBaseline()).ok }, null, 2) + '\n');
    return;
  }
  // 打印与判定都出自 report() 一处。main 里再补一段的话，--evidence 的输出
  // 就只有命令行看得到、测试测不到，而它恰恰是"抽查这判据有多粗"的那部分。
  const { lines, failed } = report(res, loadBaseline(), opts);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
