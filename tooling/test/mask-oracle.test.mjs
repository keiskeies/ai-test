/**
 * 掩码的**判据来自 TypeScript 编译器**，而不是我自己再写一遍正则去"对照"自己。
 *
 * ## 为什么这一条要单独成文件、还要真起编译器
 *
 * `maskNonCode` / `maskCommentsOnly` 是三个守卫（unread-fields、dead-exports、
 * dead-iface-fields）的**共同地基**，而它们拿掩码结果当"结论"：命中数为 0 就等于
 * "这个导出没人用 / 这个字段没人读"。所以掩码错一个字符，错的方向是**两边都能骗人**：
 * 抹掉活代码 => 活的导出被报成死的（CI 假红，人会去放宽判据）；
 * 该抹的没抹 => 注释里写一句名字就把死东西洗成活（假绿，缺陷从此没人看）。
 *
 * 本轮实测到的真实缺陷就是这个的第一类：两份掩码各抄了一遍模板串扫描，而抄的那份
 * **只认一层 `${…}`** —— 内层模板的收尾反引号被当成外层的收尾，扫描器从字符串中间
 * 恢复扫描，接着把后面真正的代码一路抹掉。以 `interpreter.ts` 里那句
 * `` …${composedHttp.missing.map((m) => `{${m}}`).join('、')}… `` 为起点，
 * 一路抹到 assert 分派那句**活着的**调用，于是 `dead-exports` 把仍在生产侧被调用的
 * 导出报成"三处零引用"。改前/改后用本文件的判据量：**被抹掉的活代码 1708 -> 0，
 * 没抹掉的注释 30 -> 2**（那 2 处见下面 `inTemplateText` 的说明，是判据自己的边角）。
 *
 * ## 为什么判据不能用"再写一个正则"
 *
 * 手写对照正则的测试只能证明"我对同一个语法的两种写法一致"，而本轮的错恰恰是
 * **对嵌套模板这条语法只有一种写法、而且两种都错**。编译器认得的语法比手写正则多，
 * 而且它不与我共享失败方式。typescript 本来就是 devDependency（typecheck 用它），
 * 这里直接复用，74 个文件全扫一遍实测 0.7s，跑得进 npm test。
 *
 * ## 三条被钉住的性质
 *
 *  1. **代码不许被动**：编译器认定为代码标识符、且落在模板**字面文本**之外的位置，
 *     掩码后必须与原文逐字相同。（模板整段含 `${…}` 里的代码是**故意**遮的，
 *     理由写在 `maskNonCode` 上；`dead-exports` 的 `codeMask` 再把 `${…}` 那段填回去，
 *     所以那条豁免只作用于 maskNonCode，不作用于 maskCommentsOnly。）
 *  2. **非代码不许活着**：注释与单双引号字符串的内容必须被抹掉。
 *  3. **两份掩码各管各的**：`maskCommentsOnly` 必须保留字符串（脱敏规则表
 *     `['password']` 那类合法消费者），`maskNonCode` 必须抹掉字符串。
 *     这一条双向钉：任何一份被"顺手"改成另一份的行为，这里就红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { maskNonCode, maskCommentsOnly } from '../unread-fields.mjs';

/** 被扫的目录：两个掩码的所有真实消费者 + 工具自己（工具也是掩码的客户端）。 */
const DIRS = [
  'packages/engine/src', 'packages/adapter-http/src', 'packages/ir/src',
  'packages/store/src', 'packages/cli/src', 'packages/server/src', 'packages/web/src',
  'tooling',
];

function listFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
  };
  for (const d of DIRS) walk(d);
  return out;
}

/**
 * 用编译器把一份源码切成"代码标识符 / 字符串字面量 / 注释 / 模板字面文本"四类跨度。
 *
 * `templateText` 是模板的**字面文本部分**（head / middle / tail / 无反引号插值的那种），
 * 不含 `${…}` 里的代码。它有两个用途：
 *  - 标识符落在它里面时，允许被 maskNonCode 遮（那是刻意的）；
 *  - **注释**的跨度落在它里面时，那不是一个真注释 —— 裸 trivia 扫描器不认识字符串，
 *    会把 `` `http://127.0.0.1:${port}` `` 里的 `//` 和 `` `${d}/**（说明）` `` 里的
 *    `/*` 当成注释起点报给我。这就是上面"2 -> 那 2 处"的来源：判据自己的边角，
 *    不是掩码的漏。真实注释（`${ /* 真注释 *\/ x }`）不在字面文本里，照样被检查。
 */
function parse(src, rel) {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const ids = [];
  const strings = [];
  const templateText = [];
  // `inInterp` = 这个标识符在某个 `${…}` 的代码里。它是**唯一**一处
  // maskNonCode 允许遮掉代码的地方（模板整段算非代码，理由写在 maskNonCode 上，
  // 而 dead-exports 的 codeMask 再按原文把这段填回去）。
  const walk = (n, inInterp = false) => {
    if (ts.isIdentifier(n)) ids.push({ s: n.getStart(sf), e: n.getEnd(), inInterp });
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isJsxAttribute(n.parent)) {
      strings.push({ s: n.getStart(sf), e: n.getEnd() });
    }
    if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      templateText.push({ s: n.getStart(sf), e: n.getEnd() });
    }
    // 模板的字面文本（head/middle/tail）里没有标识符，所以 TemplateSpan 只需要
    // 把表达式那半边标成"在插值里"交下去。⚠ 但**必须顺手把字面文本记下来再返回** ——
    // 少了这一笔的话 tail 那段没进 templateText，` `${a}/**（说明）` ` 里那个 `/*`
    // 就会被当成一个没被抹掉的注释（判据自己假红，而且只红在少数几个文件上）。
    if (ts.isTemplateSpan(n)) {
      walk(n.expression, true);
      const lit = n.literal;
      templateText.push({ s: lit.getStart(sf), e: lit.getEnd() });
      return;
    }
    n.forEachChild((c) => walk(c, inInterp));
  };
  walk(sf);

  const comments = [];
  const sc = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ false, ts.LanguageVariant.Standard, src);
  const inTemplateText = (pos) => templateText.some((t) => pos > t.s && pos < t.e);
  for (let t = sc.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = sc.scan()) {
    if (!ts.isTrivia(t)) continue;
    const start = sc.getTokenPos();
    const end = sc.getTextPos();
    const txt = src.slice(start, end);
    if (!(txt.startsWith('//') || txt.startsWith('/*'))) continue;
    if (inTemplateText(start)) continue;
    comments.push({ s: start, e: end });
  }
  return { ids, strings, comments };
}

test('两份掩码在**真仓库**上满足三条性质（判据来自 TypeScript 编译器）', () => {
  const files = listFiles();
  // 夹具自检：DIRS 写错一个字母，这里会扫到 0 个文件，而"扫到 0 个"的测试是**永真**的。
  assert.ok(files.length > 50, `夹具：该扫到几十个源文件，实际 ${files.length}（DIRS 里某个目录不见了？）`);

  const broken = [];
  const record = (kind, f, detail) => {
    if (broken.length < 12) broken.push(`${kind} ${f} ${detail}`);
  };
  let nIds = 0, nStrings = 0, nComments = 0;

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const m1 = maskNonCode(src);
    const m2 = maskCommentsOnly(src);
    // 长度与换行数不变是**前提**：两份掩码的下标要能直接套在原文上（切片取键名、算行号）。
    // 它坏了的话后面每一条断言都在错位的下标上比，报出来的"没问题"毫无意义，所以单独先查。
    if (m1.length !== src.length || m1.split('\n').length !== src.split('\n').length) broken.push(`长度/换行变了 maskNonCode ${f}`);
    if (m2.length !== src.length || m2.split('\n').length !== src.split('\n').length) broken.push(`长度/换行变了 maskCommentsOnly ${f}`);

    const parts = parse(src, f);
    for (const id of parts.ids) {
      nIds++;
      const text = src.slice(id.s, id.e);
      // ① 代码不许被动 —— **除了** `${…}` 里那一处（那是两份掩码的分工，单独成一条测试钉住）
      if (!id.inInterp && m1.slice(id.s, id.e) !== text) record('活代码被抹', f, `${text}@${id.s}`);
      // ③ maskCommentsOnly 只该遮注释：`${…}` 里的代码在它那儿必须活着
      //    （dead-exports 的 codeMask 正是靠"这个 `${` 在它那儿还活着"区分
      //     真插值与注释里的示例，遮了就等于给死导出开后门）
      if (m2.slice(id.s, id.e) !== text) record('注释掩码动了代码', f, `${text}@${id.s}`);
    }
    for (const s of parts.strings) {
      nStrings++;
      const lit = src.slice(s.s, s.e);
      const inner = src.slice(s.s + 1, s.e - 1);
      if (!inner.trim()) continue; // '' 与 "  " 这种没有可比内容
      // ② 单双引号字符串的内容必须被 maskNonCode 抹掉
      if (m1.slice(s.s + 1, s.e - 1).trim()) record('字符串没抹', f, JSON.stringify(lit));
      // ③ 而 maskCommentsOnly 必须**原样保留**它（脱敏规则表 `['password']` 是合法消费者）
      if (m2.slice(s.s, s.e) !== lit) record('注释掩码误抹字符串', f, JSON.stringify(lit));
    }
    for (const c of parts.comments) {
      nComments++;
      const lit = src.slice(c.s, c.e);
      // ② 注释必须**两份都**抹掉：注释里写一句字段名/导出名不算有人用
      //    （本仓实测过 157 个 token 只活在注释的引号里，其中 5 个是 IR 字段名）
      if (m1.slice(c.s, c.e).trim()) record('maskNonCode 没抹注释', f, JSON.stringify(lit.slice(0, 40)));
      if (m2.slice(c.s, c.e).trim()) record('maskCommentsOnly 没抹注释', f, JSON.stringify(lit.slice(0, 40)));
    }
  }

  // 夹具自检（同上思路）：如果一份标识符/注释都没扫到，上面三条断言全是空转。
  assert.ok(nIds > 5000 && nComments > 200 && nStrings > 500, `夹具：样本量太小（标识符 ${nIds}、注释 ${nComments}、字符串 ${nStrings}）`);
  assert.deepEqual(broken, [], `掩码在真仓库上破坏了性质（前 12 条）：\n${broken.join('\n')}`);
});

test('`${…}` 里的代码：maskNonCode 刻意遮掉，maskCommentsOnly 必须留着', () => {
  /*
   * 这一对是 codeMask 的**全部依赖**，而它以前没有任何一条测试在钉
   * （dead-exports.mjs 的注释里写着"判据是 maskCommentsOnly 会保留模板文本"——
   * 一句写在另一个文件的注释里、没有测试兜着的判据）。
   * 反向也要钉：有人把 maskCommentsOnly 改成"和 maskNonCode 一样"的话，
   * 注释里的 `// 用法：\`fmt(v)\`` 就能把 fmt 这个死函数洗成"有人调用"。
   */
  const src = 'const y = `a${ alpha(v) }b`;';
  assert.ok(!maskNonCode(src).includes('alpha'), 'maskNonCode 连 ${…} 里的代码一起遮（模板整段不算消费者）');
  assert.ok(maskCommentsOnly(src).includes('alpha'), 'maskCommentsOnly 必须保留 ${…} 里的代码');
  // 标识符名字刻意取成互不为前缀的两串（beta 不是 alpha 的子串）：写成 fmt / fmt2
  // 的话"注释里没有 fmt"这条会因为 beta 那种包含关系而假红/假绿，测的只是字符串包含。
  const commented = '// 用法：`beta(v)`\nconst z = `a${ gamma(v) }b`;';
  assert.ok(!maskCommentsOnly(commented).includes('beta'), '注释里的示例仍然是遮的（否则死导出能靠注释复活）');
  assert.ok(maskCommentsOnly(commented).includes('gamma'), '而真代码里的插值仍然活着');
});

test('反引号落单（截断的片段）时抹到文末，而不是整段留着', () => {
  /*
   * 这一格在**真仓库上量不到**：本轮把"未闭合模板抹到文末"那一支整个删掉，
   * 与真仓库上 74 个文件的掩码输出**逐字节相同**（`.scratch/probe-tail-diff.mjs` 量的）——
   * 盘上没有真正未闭合的模板，奇数反引号那两个文件里的反引号都在注释文本里，
   * 而注释本来就被抹掉了。所以判据只能喂**内存里的假源码**
   * （与 ref-lint.mjs 给自己定的同一条纪律：管不到真实文件的那一支，就喂假文件）。
   *
   * 为什么仍然要钉：`extractFields` 那边写着"花括号配不上时整个跳过"，说明
   * "喂进来的东西语法不完整"是这条路径**真会遇到**的输入（半份文件、被截取的片段、
   * 或将来某个掩码判错的角落）。少了这一支，未闭合模板包着的内容从"整段抹掉"
   * 变成"整段留着"，方向是**假绿**：字段被算成"碰过"而躲过门禁。
   */
  const cut = 'const a = 1;\nconst b = `未闭合的字面文本 gone 1';
  assert.ok(!maskNonCode(cut).includes('gone'), '未闭合模板之后的内容必须仍然算非代码');
  // 反向：不能为了这一格把"文末"扩大解释成"从这里到文末的所有东西都要抹"，
  // 那会让下一个真代码段消失 —— 所以同一份文本里模板**之前**的代码要原样活着
  assert.ok(maskNonCode(cut).includes('const a = 1'), '模板之前的代码不许被动');
  // 插值里落单同理（栈上还剩 interp 帧而不是 tmpl 帧，走的是同一支的入口条件之外）
  assert.ok(!maskNonCode('const c = `a${ gone').includes('gone'), '停在 ${…} 里的片段也算未闭合');
});
