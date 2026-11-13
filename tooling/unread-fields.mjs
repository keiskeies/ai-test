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
 * 两份掩码**共用**的那一个扫描器：走一遍源码，认出注释 / 单双引号字符串 /
 * 模板串（含任意层 `${…}` 嵌套）/ 正则字面量，每认出一段就交给 `onBlank`。
 * `keepStrings` 为真时只交注释（字符串与模板仍然要**走过去**，否则
 * `url.includes('http://x')` 里那个 `//` 会被当注释起点）。
 *
 * ## 为什么两份要共用一份（以及这份以前错在哪）
 *
 * 以前两份各抄了一遍模板串扫描，而抄的那一份**只认一层 `${…}`**：
 * 它用一个 `depth` 计数器数花括号，遇到 `${` 加一、`}` 减一，遇到反引号且
 * `depth === 0` 就认为模板结束 —— 于是 `${…}` 里面那个**内层模板**的收尾反引号
 * 被当成外层模板的收尾（`` xs.map((x) => `{${x}}`).join('、') `` 是最小形态，
 * 实测 `tooling/mutate/mask-template-nesting.json`）。外层"提前结束"之后，扫描器
 * 从字符串**中间**恢复扫描，接着把后面真正的代码一路当成非代码抹掉。
 *
 * 抹掉活代码比漏抹严重得多，因为两个守卫都拿"命中数为 0"当结论：
 * 真仓库里 `interpreter.ts` 从第 1658 行那个嵌套模板开始失步，一路抹到 2243 行
 * 那句**活着的** `evaluateAssertions(...)`，于是 `dead-exports` 把这个仍在生产侧
 * 被调用的导出报成"三处零引用"（CI 红线），而 `unread-fields` 把仍在读的字段
 * 算成没被读。**守卫漏报比没有守卫更坏**（docs/08 §3）在这里反过来同样成立：
 * 守卫误报一次，人就去放宽判据，而放宽之后真正的缺陷再也没有眼睛看。
 *
 * ## 为什么必须是一个栈
 *
 * 要正确走出 `` `a${ {k: `b`} }c` `` 这种串，"数花括号"不够：`${…}` 里的代码
 * 本身还能含字符串、注释、正则和**更深的模板**（内层模板里又有一个 `${`）。
 * 每一层字面量都是独立的一段状态，所以用栈：
 *  - `tmpl` —— 在模板串的字面文本里（还没进 `${`）；
 *  - `interp` + `depth` —— 在某个 `${…}` 的代码里，`depth` 是这层里额外开了几层花括号
 *    （`{ id: 1 }` 这种对象字面量、以及嵌套的 `${}` 都会加它）。
 * 深度就是源码里模板嵌套的真实层数（全仓最深 2 层），不会真用到几百层。
 */
function walkMask(src, keepStrings, onBlank) {
  const n = src.length;
  /** 上一个"有意义"的代码字符，用来判 `/` 是正则还是除号 */
  let prev = '';
  const regexOkHere = () => prev === '' || '(=,:[!&|?{};+-*%~^<>'.includes(prev);
  const stack = [];

  let i = 0;
  while (i < n) {
    const frame = stack[stack.length - 1];

    // ---- 模板串的字面文本：只认 `\` / 反引号 / `${`，别的一律原样走过去 ----
    if (frame && frame.kind === 'tmpl') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        stack.pop();
        // 整段（含 `${…}` 里的代码）一起交出去：maskNonCode 本来就把模板整段洗掉
        // —— ir/src 的 schema 体里没有模板串，而消费者里 `${}` 出现标识符是常事，
        // 宁可少认一个命中（见文件头第 2 条）。内层模板被外层这段包住，不必单独交。
        if (!keepStrings && stack.length === 0) onBlank(frame.start, i + 1);
        prev = '`';
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'interp', depth: 0 });
        // `${` 之后允许正则（`(=,:[!&|?{};…` 里那个 `{` 本来就在集合里，这里显式写上）
        prev = '{';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- 代码态：顶层，或某个 `${…}` 里面 ----
    const c = src[i];
    const c2 = src[i + 1];
    // 与本层 `${` 配平的那个 `}`：交回上一层（模板的字面文本）
    if (frame && c === '}' && frame.depth === 0) {
      stack.pop();
      prev = '}';
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      onBlank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      onBlank(i, j);
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
      if (!keepStrings) onBlank(i, Math.min(j, n));
      prev = c;
      i = j;
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'tmpl', start: i });
      prev = '`';
      i++;
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
        if (!keepStrings) onBlank(i, closed + 1);
        i = closed + 1;
        prev = '/';
        continue;
      }
    }
    // 花括号配对只在代码态数（字符串/注释/正则里的那些已经在上面整段走过去了）
    if (frame && (c === '{' || c === '}')) frame.depth += c === '{' ? 1 : -1;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
    i++;
  }

  /*
   * 文末仍在栈上的模板（源码里那个反引号本来就落单，或者整份文件是截断的片段）：
   * maskNonCode 仍然要把这一段抹到文末 —— 改前那份是 `blank(i, min(j, n))`，
   * 不补这一笔的话"未闭合模板"从"整段抹掉"变成"整段留着"，
   * 于是脏文件里凭空多出一批假命中（假阳方向，会红，但红得没有意义）。
   * 这里**不抛**：语法脏的文件也要给得出结论，门禁的失败该是"报了某条"，
   * 不是扫描器自己崩掉之后什么都不报。
   */
  if (!keepStrings) {
    for (const f of stack) if (f.kind === 'tmpl') onBlank(f.start, n);
  }
}

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
  // 从**原文**出发，只把非代码区间抹成空格。
  // （这里曾经写成"全部初始化为空格"：结果整份文件被抹平，扫出 0 个字段，
  //  然后输出一句"全部有豁免"就 exit 0 —— 扫描器抽不到任何东西时不会报错，它只会报告干净。）
  const n = src.length;
  const out = src.split('');
  walkMask(src, false, (from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, n); i++) if (src[i] !== '\n') out[i] = ' ';
  });
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
export function matchBrace(masked, open) {
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
  // `{ foo` / `, foo` 后面跟 `,` `}` `)` —— **解构**，是在读
  if ((prev === '{' || prev === ',' || prev === '(') && (next === ',' || next === '}' || next === ')')) return 'binding';
  /*
   * 后面跟 `:` 是**另一件事**：那是"往一个键上放值"（对象字面量、interface/type 里的
   * 成员声明、函数形参名），读的是**冒号右边**，不是这个标识符。
   *
   * 这一格从前算强证据，于是**"生产一个 IR 形状的对象"被当成了"消费这个字段"**。
   * 本轮实测（写压测那条路时撞出来的）：`press.ts` 里 `{ runnerCount: 1, connections: o.vus }`
   * 与 `{ model: 'closed' }`、`plan.ts` 里 `scenarioId: scenario.id` 一共把
   * **六条仍然没人读的字段**判成"读过"，于是它们身上那些写着 P7 的豁免被报成
   * "已过期、删掉吧"。照做的话下一次这些字段落回未读时门禁直接红，
   * 而人看到的报错是"新增未读字段"—— 与下面那条"裸词不算读过"是同一个方向的漏：
   * **只在消费侧守、在生产侧漏**。本工具防的缺陷类正是"有载体、没有生产者"，
   * 把生产者当消费者等于让这一族缺陷自己给自己作证。
   *
   * 代价要说清：`const { id: _id } = s` 这种**改名的解构**会跟着落到这一格，
   * 于是它不再算读过。全仓这种写法只有个位数（`grep -c 'const { \w*: '`），
   * 而现存那几处恰恰是 `plan.ts` 里**故意丢掉字段**的用法，本来就不是读。
   * 反过来若保守地保留它，"写了个同名键"与"读了个字段"就永远分不开 ——
   * 那正是这一版坏掉的方式。
   */
  if ((prev === '{' || prev === ',' || prev === '(') && next === ':') return 'writeKey';
  return 'bare';
}

/** 强证据的两种角色。bare 不算：同名局部变量、TS 断言关键字都会造出一堆假命中。 */
const STRONG_ROLES = new Set(['member', 'binding']);

/**
 * 只抹注释、**保留字符串与模板内容**的那一份掩码。
 *
 * 为什么需要第二份掩码（而不是复用 maskNonCode）：collectTokens 的字符串取词
 * 原先跑在**原文**上，于是注释里的引号词也算命中。这不是理论问题 —— 实测有 157 个
 * token 只活在注释的引号里，其中 5 个是 IR 字段名，于是 4 条**真·没人读**的字段
 * （OperationSchema.amount / ScenarioVersionMetaSchema.ver /
 *  LocatorRuleSchema.role / DeviceRequirementSchema.requires）被算成"碰过"，
 * 从 unread 掉进 inconclusive 而躲过门禁。本工具存在的目的正是抓这一类，
 * 结果它自己被这一类糊住了。
 *
 * 触发它的是一次改名：为了躲开 `opts.scenarioId` 的假强证据，我在 html.ts
 * 写了一段解释"为什么别叫 scenarioId"的注释，而注释里带着 `scenarioId` 的反引号 ——
 * 于是判不出桶 +1，撞破登记的天花板。**写注释把字段本身藏得更深**，这个方向必须堵。
 *
 * 保留字符串内容是为了不丢真证据：脱敏规则表 `['password','api_key']`
 * 那种"按字段名查表"的写法是合法的消费者（见 test 里那条同名用例）。
 */
export function maskCommentsOnly(src) {
  const n = src.length;
  const out = src.split('');
  walkMask(src, true, (from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, n); i++) if (src[i] !== '\n') out[i] = ' ';
  });
  return out.join('');
}

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
  /*
   * 字符串里的词**永远只算弱证据**：脱敏规则表里有 'password' 不等于读了 password 字段。
   * 而且取词跑在 **maskCommentsOnly** 上而不是原文上 —— 注释里的引号词不算命中
   * （理由与被堵掉的 4 条字段一起写在 maskCommentsOnly 上）。
   * 模板串不参与：maskNonCode 那侧已经把 ${} 洗掉了，而模板正文里的裸词
   * 走的是上面那条 identifier 通路，角色由 roleOf 定。
   */
  const noComment = maskCommentsOnly(src);
  for (const m of noComment.matchAll(/['"`]([^'"`\n]{1,120})['"`]/g)) {
    for (const w of m[1].split(/[^A-Za-z0-9_$]+/)) {
      if (!w) continue;
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

/**
 * baseline 与扫描结果对账。
 *
 * @param fields    全量字段
 * @param unread    一个命中都没有的字段
 * @param baseline  豁免表
 * @param buckets   { inconclusive }。**不传就当没有**（老签名调用方行为不变）
 */
export function classify(fields, unread, baseline, buckets = {}) {
  const exempt = new Map((baseline?.fields ?? []).map((e) => [e.id, e]));
  const present = new Set(fields.map((f) => f.id));
  const inconclusive = new Set((buckets.inconclusive ?? []).map((f) => f.id));
  const out = { newUnread: [], staleExempt: [], dangling: [], exemptInconclusive: [], ok: [] };
  for (const f of unread) {
    const e = exempt.get(f.id);
    if (e) out.ok.push({ ...f, reason: e.reason, milestone: e.milestone });
    else out.newUnread.push(f);
  }
  // 豁免表里的每一条都要能对上号，对不上就必须说出来。几种情形各有各的修法：
  //  - id 根本不在字段表里 → **悬空**（字段被删了，或整个 schema 被改名了）
  //  - id 在字段表里、且仍然没人读、但没登记在未读里 → 不可能出现，忽略
  //  - id 在字段表里、现在**有人读了** → **过期**（把豁免删掉；留着的话，
  //    将来这个字段被改回不读时扫描会闭嘴，等于自己把自己的闸拆了）
  //  - id 在字段表里、现在**判不出** → 进 exemptInconclusive，**不算过期**
  //
  // 最后一条是实测补的（漏判方向是"把还需要的豁免删掉"，比多留一条危险得多）：
  // 原先的判据是 `!unread.some(id)`，而"不在 unread 里"包含两种完全不同的意思 ——
  // "**有强证据说它被读了**"和"**只是碰上了裸词、扫描器看不出**"。后者被当成前者，
  // 就会让人去删一条仍然需要的豁免：删掉之后那条字段一旦落回 unread，
  // 门禁直接红，而人看到的报错是"新增未读字段"，不是"你刚删的那条豁免本来管的是它"。
  // 这与文件头第 2 条是同一条纪律：**宁可承认判不出，也不要让"碰过"冒充"读过"** ——
  // 那条纪律写在 scan() 里，原先却没管到 classify()，等于只在产出侧守、在处置侧漏。
  //
  // 具体触发例：写 packages/engine/src/html.ts 时，模板里的 `<meta name="viewport">`
  // 给 EnvFingerprintSchema.viewport 造了一处**裸词**命中，于是它从 unread
  // 挪进 inconclusive，豁免被判成"过期"。那个字段仍然没人读（消费者是服务端的 run 表）。
  //
  // 另外：判悬空之前**不再**拿 e.schema 去替换 id 里的 "(匿名)"。原先那层替换意图是
  // 容忍"内联对象改了归属"，但它同时会把"字段被挪到别的 schema"这条真实漂移洗掉 ——
  // 豁免静默失效与本仓那个缺陷类是同一件事。宁可让 id 严格全等。
  for (const [id, e] of exempt) {
    if (!present.has(id)) { out.dangling.push({ id, reason: e.reason }); continue; }
    if (unread.some((f) => f.id === id)) continue;
    if (inconclusive.has(id)) { out.exemptInconclusive.push({ id, reason: e.reason }); continue; }
    out.staleExempt.push({ id, reason: e.reason });
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
  const inc = res.inconclusive ?? [];
  const c = classify(res.fields, res.unread, base, { inconclusive: inc });
  const lines = [];
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
    lines.push(`~ 豁免已过期 ${c.staleExempt.length} 个（字段现在已经**有强证据**被读，把豁免条目删掉）：`);
    for (const f of c.staleExempt) lines.push(`  ${f.id}`);
  }
  /*
   * "豁免的字段现在落进判不出桶"单独列一句，**不算失败也不算通过不提**。
   * 不提的代价是误判会伪装成"豁免过期"（就是这一条 bug 的来源）：现在既然分开了，
   * 就要让人看见"这条豁免还在生效，只是扫描器暂时看不出它没被读" ——
   * 否则它会静默待在 ok 之外的某个角落，而 ok 的数量看起来少了 1，
   * 人就会开始猜"少了的那条去哪了"。
   */
  if (c.exemptInconclusive.length) {
    lines.push('');
    lines.push(`~ 豁免中的字段现在有**裸词**命中（判不出，仍按豁免处理，别删） ${c.exemptInconclusive.length} 个：`);
    for (const f of c.exemptInconclusive) lines.push(`  ${f.id}`);
    lines.push('  裸词命中可能是同名局部变量、CSS/HTML 里的字面词，也可能真是读了 —— 词法层面分不出。');
    lines.push('  要让它脱离"判不出"：把命中的那个标识符改成不撞名的写法（例：html 里的入参别叫 IR 字段名）。');
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
    process.stdout.write(JSON.stringify({ total: res.fields.length, unread: res.unread, inconclusive: res.inconclusive, exempt: classify(res.fields, res.unread, loadBaseline(), { inconclusive: res.inconclusive }).ok }, null, 2) + '\n');
    return;
  }
  // 打印与判定都出自 report() 一处。main 里再补一段的话，--evidence 的输出
  // 就只有命令行看得到、测试测不到，而它恰恰是"抽查这判据有多粗"的那部分。
  const { lines, failed } = report(res, loadBaseline(), opts);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
