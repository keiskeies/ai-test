/**
 * **"没人调的导出函数"守卫** —— 补 `unread-fields.mjs` 与 `dead-iface-fields.mjs`
 * 都看不见的那一格：**函数**。
 *
 * ## 为什么要有这一道
 *
 * 前两道守卫判的都是**字段**（zod schema 的字段 / 非 zod interface 的字段）。
 * 而 `coverageDelta` 那一格挂了两轮的形状是「函数有、测试有、**生产侧零调用**」——
 * 一个字段级的扫描器永远看不见它。本轮给它补调用方时，顺手把同一判据扫了一遍全仓，
 * 当场撞出七个（`evidencePaths` / `isPassing` / `putText` / `causeHint` /
 * `isRefValue` / `isExprValue` / `isGenValue`），**没有一个是我先想到再去验的**。
 * 七个里有三个不是"忘了删"，而是**判据被手抄走了**：
 *  - `isPassing` 死着，而 `status === 'pass'` 手抄在 `ir/trace.ts` 与
 *    `engine/interpreter.ts` 两处（本轮把它们接回 `isPassing`）；
 *  - `evidencePaths(dir, runId)` 的 `runId` **从来没被读过**。⚠ 我一开始给它写的理由
 *    是"它算的 `<dir>/artifacts` 与真实布局矛盾"—— **那句是假的**（真实装配
 *    `commands.ts` → `wiring.ts` 算出的 store 根就是 `<evidenceDir>/artifacts`，
 *    与它返回的 `storeDir` 逐字相同，实测两串相等）。真的那半在 `dir`：
 *    它返回的是**证据根**，而生产侧要的是**某一次 run 的目录**
 *    `join(evidenceDir, safeRunId(runId))`，而 `safeRunId` 是 `commands.ts` 的私有函数。
 *    照它的名字接线 = `join(evidenceDir, runId)`，少那层清洗就是
 *    `safeRunId` 函数头记着的那次实测事故（`--run-id ..` → 产物摊到上一级、
 *    且不被 .gitignore 收进忽略）。**所以它是删而不是接** ——
 *    "零调用"通常的下一句是"接上就好"，这里"接上"等于复活一个已修掉的缺陷。
 *  - `causeHint` 读的那份 `CAUSE_HINT` 词表**已经和 `FAILURE_CAUSE` 枚举对不上**
 *    （枚举里是 `locator-stale`，它写着 `locator-unstable`，还少两格），
 *    活的那份在 `engine/src/html.ts` 的 `CAUSE_LABEL`。**一份没人读的过期词表
 *    比没有词表更坏**：下一个人会以为归因文案已经统一了。
 *
 * ## 判据：两档，而只有第一档能让 CI 变红
 *
 *  - `unused` —— **生产侧、测试侧、本文件内**三处都零引用 → **红线**。
 *  - `testOnly` —— **只有测试在调**（生产侧与本文件内都不调）→ 只印不拦。
 *    这就是 `coverageDelta` 挂了两三轮的那个形状。不拦的理由见 `report` 那段注释：
 *    那一档里"该删"与"该接线"计数完全相同而动作相反，压成一个退出码只能选一边。
 *
 * ⚠ **这一段原先写的是"只有一档，判据是整仓命中恰好 1 次"** —— 那是第一版的判据，
 * 而它抓不到本守卫存在的理由本身：`coverageDelta` 有 index 转发、有一整个测试文件，
 * 命中数远大于 1，它缺的只是**生产调用方**。改成按"谁能看见它"分池计数之后，
 * 那个形状才落进 `testOnly`。**登记与实现不一致比没登记更难查**，所以把改过这件事留在原地。
 *
 * 第一档不需要 interface 那道守卫的"1~2 次算判不出"中间层：函数名不像字段名
 * 那样会被解构 / 建对象 / spread 藏起来 —— 调用一个函数在词法上必然写出它的名字
 * （而"写了名字但没用"那两种形态 —— `import` 与 `export {} from` —— 由
 * `stripModuleSyntax` 排除，那是本守卫判据的核心，不是清洗）。
 *
 * 剩下的失效方向分两侧写清：
 *  - **假阴**：动态调用（`registry[name](…)`、`obj["f"]()`）与字符串里的反射名。
 *    本仓没有实例；一旦出现就看不见那个消费者，代价是死代码留着，不是删错东西。
 *  - **假阳**：只剩这一类曾经存在过 —— 模板字符串里的 `${…}` 调用。
 *    它把一个**同一文件上一行刚被真调用着**的函数报成死，是本项目最贵的那种错
 *    （名字对、文件对，只有"没人用"是假的）。已由 `codeMask` 修掉，
 *    过程与量出来的规模写在那个函数的注释里。
 *
 * ⚠ **导出但只在本文件内用**不算死（`normalizeSecretRef` 那种）。
 * 它是一条"对外契约开大了"的味道，不是缺陷：功能在跑，只是没人从外面调。
 * 把它算成死会让人去删活代码，那种误报的守卫等于没有守卫
 * （`dead-iface-fields.mjs` 文件头同一条纪律）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskCommentsOnly, maskNonCode } from './unread-fields.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.scratch', 'coverage', 'tmp', 'evidence']);

/**
 * 声明形态。**只认导出。**
 *
 * ⚠ **这一条的理由原先写的是"没导出的内部函数若零调用，`tsc --noUnusedLocals` 早就管了"——
 * 那句是我没查就写的，而它是假的。** 本仓没有任何地方开 `noUnusedLocals`，
 * 也没有 eslint 配置；实测往 `packages/ir/src` 塞一个定义了却从不调用的
 * `const unusedHelper = (): number => 1;`，`tsc --noEmit` **一声不响**。
 * （同一个坑我又踩了一次：前一轮给 `putText` 写的"真正那条路走 `putStream`" 也不存在。
 * 一句没验的理由和一句没验的结论在这里是同一件事。）
 *
 * 真实的理由是**判据不同，不是委托给别人**：**"导出"正是"别人可以调"的那个开关**，
 * 而一个名字的引用可能出现在全仓任何一个文件里 —— 单文件编译器按作用域工作，
 * 看不见跨文件的"有人调了吗"。所以"导出了而没人调"是**只有全仓扫描才看得见的形状**，
 * 本守卫的存在理由就是这一格。
 *
 * ⚠ 顺带把一个**已知缺口**登记在这里而不是留着不说：**未导出的死函数今天无人值守**
 * （`noUnusedLocals` 没开，本守卫只认导出）。补它该走"把那个开关打开"这条路，
 * 而那是另一轮的事：它会先把现有代码里所有未用参数一起报出来，
 * 且仍管不到"被调了一次、而那一次本身也是死的"这种链式死码。
 */
const DECL_RES = [
  /^export (?:async )?function\*?[ \t]+([A-Za-z0-9_$]+)/gm,
  /^export (?:abstract )?class[ \t]+([A-Za-z0-9_$]+)/gm,
  /**
   * 导出的函数常量：`export const f = (…) => …` / `= async (…) => …` / `= function …`，
   * **以及带类型标注那种** `export const f: (a: number) => number = (a) => a;`。
   *
   * ⚠ 标注那一段第一版写的是 `[^=\n]+`，而**箭头函数自己的 `=>` 里就有一个 `=`**：
   * 于是标注里带 `=>` 的声明一条都抽不出来（`export const f: (a) => number = (a) => a`
   * 整条被看漏）。是测试逼出来的，不是想到的 —— 本仓今天**零个**这种写法，
   * 所以这是一个"看不见"级的假阴而不是误报，方向与文件头那条取舍一致；
   * 但抽取器漏一种常见写法属于"守卫自己漏报"，比没有守卫更坏，所以还是补了。
   *
   * 改成懒惰的 `[^;\n]+?` 后多出来的唯一提错名字的风险是
   * `export const a = 1, b = () => …` 这种**一行多个声明符**的写法
   * （会把名字提成 `a`）；实测本仓零处。真出现时报出来的名字会明显对不上
   * 代码，属于"有人来看"的失效，不是"永远没人知道"。
   */
  /^export const ([A-Za-z0-9_$]+)[ \t]*(?::[^;\n]+?)?=[ \t]*(?:async[ \t]*(?:\(|function)|\()/gm,
];

/** 扫"谁调了它"的范围：各包 src + test + tooling + bin（CLI/服务端的真入口都在 bin 里） */
const SCAN_DIRS = ['packages', 'tooling'];

export function listSourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = `${dir}/${name}`;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(?:mjs|mts|cjs|cts|ts|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const d of SCAN_DIRS) walk(`${root}/${d}`);
  // SCAN_DIRS 覆盖不到源码目录：真入口在 bin 下（`packages/cli/bin/atest.mjs`），
  // 它在 `packages` 下面、扩展名也在过滤里，所以已经被走到了 —— 这里不需要补目录。
  // ⚠ 原先这里写着一句没写完的问句（"不匹配上面的扩展名过滤？……只补 tooling
  // 之外可能漏的目录"）。那半句是**没决定的猜测挂着**，读的人无从判断它是否还要做。
  //
  // 实测根下唯一的另一个可能含码的目录是 `examples/`，而它**一个码文件都没有**
  // （只有 .json/.zip/.xml/.txt/.jsonl/.html 这些夹具），所以今天没有漏掉的调用方。
  // 真要在根下加第三个源码目录，要改的是 SCAN_DIRS；漏加的失效方向是
  // "那个目录里的真调用者看不见" = **假阳** = 把活函数报成死，
  // 也就是文件头写着的最贵的那种错（名字对、文件对，只有"没人用"是假的），
  // 不是安静漏报 —— 所以这条真要踩上了会当场有人喊，不用在这儿设防。
  return out;
}

/** 一个文件里的导出声明（名字 + 声明所在行号） */
export function findDeclarations(text) {
  const out = [];
  for (const re of DECL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ name: m[1], line: text.slice(0, m.index).split('\n').length });
    }
  }
  // 同一名字可能被两条规则都命中（`export const f = ...` 同时被 class 规则漏掉时不会，
  // 但重复声明在同一文件里本就非法）—— 去重保证计数不重复
  const seen = new Set();
  return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

/**
 * **本守卫要的掩码 = 遮掉注释与字符串正文，但把模板字符串里 `${…}` 的表达式还回来。**
 *
 * ## 这一格是量出来的，不是想到的
 *
 * 第一版直接用 `maskNonCode`，它把整个模板字符串连 `${...}` 一起遮成空格。
 * 于是 `headers.authorization = \`Basic ${base64Utf8(v)}\`` 这行里的 `base64Utf8`
 * **在掩码文本里根本不存在**，函数被报成"三处零引用"。
 * 而 `base64Utf8` 恰恰就在**同一个文件的上一行**被真调用着 ——
 * 这是本守卫自己的第一个假阳性，而且是**最坏的那种**：报出来的名字、
 * 报出来的文件都对，只有"没人用"这半句是假的，
 * 照着它删就会删掉一行活代码（文件头那条"误报的守卫会让人去删活代码"）。
 * 实测这个盲区不小：**200 个不同名字**的引用只出现在 `${...}` 里
 * （`stringify` 135 处、`join` 61 处 —— 全是模板拼串）。
 *
 * ## 为什么不干脆改用 maskCommentsOnly
 *
 * 那样字符串正文会全部回来，而**字符串正文正是必须遮的那一半**：
 * 本仓到处写着 `'coverageDelta'`、`'existingCombinations'` 这种
 * 出现在报错文案 / 测试标题 / lint 消息里的**函数名本身**。
 * 放开字符串的话，那些名字每个都白拿一次"有人在用"，
 * 守卫退回永远报零 —— 和把 import 当成调用是同一类错误，只是方向相反。
 *
 * ## 做法与其代价
 *
 * 两个掩码都**保长度、保位置**（实测两文件 8017/8017、23282/23282），
 * 所以可以逐字符合并：取 `maskNonCode` 做底，把原文里 `${` 与配平的 `}`
 * 之间那一段按原文填回去。字面文本、注释、普通字符串仍然是遮的。
 *
 * ⚠ 认 `${...}` 的配对用**朴素的花括号平衡**，不认嵌套模板里的花括号字符串
 * （`` `${ {a:"}"} }` `` 这种）。全仓没有这种写法；真要出现，
 * 代价是把一个死函数算成活的（假阴），不是删掉活代码（假阳）——
 * 与本守卫所有其他取舍同向。
 */
export function codeMask(src) {
  const masked = maskNonCode(src);
  // 注释里的 `${foo}` **不算使用**。判据是"这个 `${` 在只遮注释的掩码里还活着"：
  // maskCommentsOnly 遮注释而留模板文本，所以注释里的插值在它那儿是空格。
  // 不加这一道的话，文件头写一句 `// 用法：\`Basic ${base64Utf8(v)}\`` 就能把
  // 一个死函数洗成活 —— 而本仓的注释里恰恰到处是这样的示例。
  const code = maskCommentsOnly(src);
  const chars = masked.split('');
  let i = 0;
  while ((i = src.indexOf('${', i)) !== -1) {
    let depth = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    if (code[i] === '$') {
      // 保留 `${` 与 `}` 本身是遮的，只还中间那段
      for (let k = i + 2; k < j; k++) chars[k] = src[k];
    }
    i = j + 1;
  }
  return chars.join('');
}



/**
 * 把**模块语法**从掩码后的文本里抹掉：`import {a,b} from '…'`、
 * `export {a,b} from '…'`、`export * from '…'`、以及不带 `from` 的
 * `export {a,b}` 转发列表。
 *
 * ## 为什么这一步是本守卫的判据核心而不是清洗
 *
 * **`import { f }` 不是"用了 f"，是"我准备用 f"。** 不抹掉它的话，一条
 * "导入了、转发了、从来没调"的函数会拿到 2 次命中（import 一次 + export 一次），
 * 于是永远落在红线之外 —— 而**这正是本守卫要抓的那个形状**。
 * 第一版就是这么错的：我先按"文件名叫 index.ts"排除 barrel，
 * 结果 `packages/server/src/index.ts`（整个服务端本体，真调用者）被当成 barrel
 * 排除掉，两个本来活着的函数被报成死；反过来那些真转发列表又被算成了调用。
 * **两侧同时错**，因为"谁在转发"被当成文件属性去猜，而它其实是逐条语句的属性。
 * 现在不问"这个文件是什么"，只问"这一行在做什么"。
 *
 * ⚠ 抹的是整条语句，**不区分名字**：`export { a, b } from './x.js'` 里
 * 的 a 与 b 一起消失。这是刻意的 —— 转发本来就不该算调用，
 * 而"它有没有别的真调用"由别的文件里的命中数回答。
 *
 * 只处理**掩码后**的文本，所以注释里的 `import` 示例不会被误抹成真代码，
 * 真代码里的字符串（含 `'import'` 这种字面量）也已经在掩码阶段变成引号壳。
 */
const MODULE_SYNTAX = [
  // **每条都不许越过行**（花括号内那一段除外）。第一版这里写的是 `[\s\S]*?`，
  // 那会让 `^export` 从 `export function foo() {` 一路懒配到文件后面某行结尾的
  // `from './x.js'` —— 中间的真代码整段被抹掉，守卫会安静地把一批活函数报成死。
  // 换成 `[^}]*`：它天然在闭合花括号处停下，跨行只可能发生在 `{ … }` 内部
  // （本仓 src 里有 7 处 `import {` 换行的写法，所以花括号内允许跨行）。
  //
  // ⚠ **模块路径那一截写成 `[^;\n]*` 而不是 `['"][^'"]*['"]`**：
  // 传进来的文本已经过 `maskNonCode`，字符串连引号一起被换成空格了
  // （实测 `from 'node:http'` 变成 `from            ;`）。
  // 按引号写正则的话**一条都匹配不上**，于是 import 照样算成调用、
  // 整个守卫退回"永远报零"。这个坑是打印掩码文本才看出来的，不是想出来的。
  /^import\s+(?:type\s+)?\{[^}]*\}\s*(?:from[^;\n]*)?;?[ \t]*$/gm,
  /^export\s+(?:type\s+)?\{[^}]*\}(?:\s*from[^;\n]*)?;?[ \t]*$/gm,
  /^export\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z0-9_$]+)?\s*(?:from[^;\n]*)?;?[ \t]*$/gm,
  /** 无花括号的导入：默认 / 命名空间 / 裸副作用。`[^;{]` 保证不碰上面那条的形态 */
  /^[ \t]*import\s+[^;{]*;[ \t]*$/gm,
];
export function stripModuleSyntax(masked) {
  let out = masked;
  for (const re of MODULE_SYNTAX) out = out.replace(re, '');
  return out;
}



/** 名字 → 命中次数（掩码 + 去模块语法后，按词边界） */
export function countMentions(masks, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`, 'g');
  let n = 0;
  for (const m of masks) {
    const hits = m.masked.match(re);
    if (hits) n += hits.length;
  }
  return n;
}

/** 测试侧文件。判据见下面 scan 里"为什么 test/ 下的夹具不算死"那一段 */
const IS_TEST = /(^|\/)test\//;

/**
 * 扫描，按"谁能看见它"分档。
 *
 * 三档的**分界不是严重程度，是"该由谁来处置"**：
 *
 *  - `unused` —— **生产侧、测试侧、本文件内**三处都零引用。写了而没有任何人用。
 *    这是唯一可以当 CI 红线的一档：删掉它不会让任何测试变红，也不会改变任何行为。
 *  - `testOnly` —— **只有测试在调**（生产侧与本文件内都不调）。
 *    这就是 `coverageDelta` 挂了两轮的那个形状：函数有、测试有、生产侧零调用。
 *    ⚠ **不当红线**，理由写在下面 report 的那段注释里。
 *  - 其余 —— 生产侧有人调，或只在本文件内用（后者是"对外契约开大了"，不是缺陷）。
 *
 * `testOnly` 与 `unused` 用**同一套计数**算出来，只差一个 `test > 0`：
 * 分成两个函数就会被改成分叉的两套判据，而这两档的差别恰好只有那一个条件。
 */
export function scan(root = ROOT) {
  const files = listSourceFiles(root);
  const rels = files.map((f) => relative(root, f).split('\\').join('/'));
  // 每个文件两份掩码，**用途不同，不能合成一份**：
  //  - `decl` 用 `maskNonCode`：注释与字符串正文全遮。找"声明"要多遮这一层 ——
  //    代码生成器与文档生成器会把 `export function foo()` 当**字面文本**写进
  //    模板字符串里，那种不是声明，抽出来就会多出一个"没人调的导出"。
  //  - `use` 用 `codeMask`：把 `${…}` 还回来，因为那是**真调用**。
  //    反过来（用 use 找声明）与只用 noncode（用 noncode 数使用）都会错，
  //    后者就是 base64Utf8 那个假阳性。两个方向各错一次才知道要分两份。
  //  两份都保长度、保行号，所以同一份 decl 行号能直接用在 use 文本上。
  const perFile = files.map((f, i) => {
    const src = readFileSync(f, 'utf8');
    return { rel: rels[i], decl: maskNonCode(src), use: stripModuleSyntax(codeMask(src)) };
  });
  const unused = [];
  const testOnly = [];
  let decls = 0;
  for (let i = 0; i < files.length; i++) {
    const self = rels[i];
    const declText = perFile[i].decl;
    // 两个池子按 i 建**一次**，不在每个声明里重建：本仓三百多个声明 × 近两百个文件，
    // 建在里面的话光是搭池子就比数数还贵（慢门禁的下场见文件头）。
    // `masked` 这个字段名是 countMentions 的接口，这里从 `use` 映射过去 ——
    // **数使用一律用 use 那份**（含 `${…}`），拿 decl 那份数就会漏掉模板里的调用。
    const testPool = perFile.filter((m, j) => j !== i && IS_TEST.test(m.rel)).map((m) => ({ masked: m.use }));
    const prodPool = perFile.filter((m, j) => j !== i && !IS_TEST.test(m.rel)).map((m) => ({ masked: m.use }));
    for (const d of findDeclarations(declText)) {
      decls++;
      const inTest = countMentions(testPool, d.name);
      const inProd = countMentions(prodPool, d.name);

      // 本文件内除声明那一句之外还有没有引用（`isPassing` 那种：函数死着，
      // 判据被人手抄成 `status === 'pass'` —— 本文件内有人按名字用，就不算"没人用"）
      const selfUse = countMentions([withoutLine(perFile[i].use, d)], d.name);

      const item = { name: d.name, file: self, line: d.line, testHits: inTest, prodHits: inProd, selfUse };
      if (inProd > 0 || selfUse > 0) continue;
      if (inTest > 0) {
        // test/ 目录**自己**导出的夹具（`scn` / `getStep` / `browserBin` 那种）
        // 的"生产侧"就是测试本身 —— 要求它们有生产调用方等于要求测试夹具上生产
        if (!IS_TEST.test(self)) testOnly.push(item);
      } else {
        unused.push(item);
      }
    }
  }
  return { unused, testOnly, files: files.length, decls };
}

/**
 * 本文件的掩码文本，**去掉声明那一行**，用来数"文件内除了声明还有没有别的引用"。
 *
 * 两个细节都不是随手写的：
 *  - **不按"总数减 1"算。** `export function fact(n){ return n<=1?1:fact(n-1) }`
 *   这种自递归的活函数，名字出现两次，减 1 之后仍是 1 —— 看着像"没人用"。
 *   递归只是最容易想到的那个；默认参数、`typeof foo` 自检都一样。
 *  - **同样过一遍 stripModuleSyntax。** 文件末尾那句
 *   `export { lintScenario, toReport };`（`engine/src/dryrun.ts` 真有）
 *   是**对外转发**，不是"本文件用了一下"。不抹的话每个被转发出去的函数
 *   都白拿一次 selfUse，于是这一档永远报零 —— 和 import 那一侧是同一个错误。
 */
function withoutLine(useText, d) {
  const lines = useText.split('\n');
  lines[d.line - 1] = '';
  return { rel: 'self-without-decl', masked: stripModuleSyntax(lines.join('\n')) };
}


/**
 * 打印 + 决定退出码。
 *
 * ## 只有 `unused` 那一档能让 CI 变红，`testOnly` 只印不拦
 *
 * 这不是手软，是**这一档的两种真相不能用一个退出码区分**：
 * "该删"与"该接线"在计数上长得一模一样（都是生产侧 0），
 * 而它们要求的动作相反 —— 一个是删代码，一个是**加代码**。
 * `unread-fields.mjs` 对付同一件事的办法是 baseline 豁免 + 写理由，
 * 这里沿用同一套：`testOnly` 全部印出来当**清单**，
 * 想让它变红线得先逐个处置（接上或删除），而不是把整档压成一个数。
 * 压成一个数的下场是要么放行要么逼人删掉有用的东西，
 * 后者比前者更坏 —— **误报的守卫会让人去删活代码**。
 *
 * `minDecls` 是自检下限：**扫描一个什么都没抽到的仓库不是"干净"，是坏了**。
 * 下限给得比当前读数低一大截，只为挡"抽取器整个失效"这一种事故，
 * 不做"数量不许下降"那种会逼人写假声明的断言。
 */
export function report(res, { minDecls = 150, quiet = false } = {}) {
  if (!quiet) console.log(`导出函数/类扫描：${res.files} 个文件、${res.decls} 个导出声明`);
  if (res.decls < minDecls) {
    console.error(`✗ 只抽到 ${res.decls} 个导出声明（下限 ${minDecls}）—— 抽取器大概失效了，本轮结论无意义`);
    return 1;
  }
  let bad = false;
  if (res.unused.length) {
    console.error(`✗ 生产侧、测试侧、本文件内**三处都零引用**的导出 ${res.unused.length} 个：`);
    for (const d of res.unused) console.error(`    ${d.name}  (${d.file}:${d.line})`);
    console.error('  要么删掉，要么接上并留一条断言。留着的话，下一个人会以为它有消费者。');
    bad = true;
  } else if (!quiet) {
    console.log('✓ 没有"三处都零引用"的导出函数/类');
  }
  if (!quiet && res.testOnly.length) {
    console.log(`⚠ 只有测试在调、生产侧零调用的导出 ${res.testOnly.length} 个（不拦 CI，见 report 注释）：`);
    for (const d of res.testOnly) console.log(`    ${d.name}  (${d.file}:${d.line})`);
    console.log('  每一个要么是真该接的生产缺口，要么是纯内部工具该收成非导出。分不清就看它的测试在测什么。');
  }
  return bad ? 1 : 0;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  process.exit(report(scan()));
}
