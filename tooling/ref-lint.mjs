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
/**
 * 两道规则共用一份跳过集。
 *
 * `.scratch/` 必须跳掉：探针是草稿，里面爱写什么写什么。
 * 但它跳的是**探针文件本身**，与探针规则管的东西无关 —— 那条规则管的是
 * src/ 与 docs/ 里那些**引用**探针的地方，那些文件照扫。
 *
 * 从前这里另有两份跳过集，第二份多出一项 `mutate`，注释说它挡住
 * 「tooling/mutate/*.json 里写的探针路径」。那是**永远不生效**的配置：
 * SCAN_EXTS 只收 .ts/.mts/.mjs/.md，**.json 压根不在扫描范围内**。
 * 注释读起来像它挡住了什么，和"永远为真的条件"是同一族错误、只是方向相反
 * —— 挡不住东西的跳过项，和抓不到问题的检查一样，都是零。
 * 真实原因记在这儿：想让 JSON 进扫描范围的话，得先答"落点窗口"在未解析
 * 的 JSON 文本上是什么意思（现在的候选池是按 .ts 顶层声明抓的），
 * 别直接把这项加回来当解决。
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.scratch', '.git', 'tmp']);

/**
 * 探针引用：`.scratch/probe-xxx.mts` 这种。
 * 它不是"代码位置"指针而是**证据指针**，所以判据完全不同（见 checkProbes 的注释）。
 *
 * **要求以扩展名结尾**，为的是把"引用某个探针文件"与"在讲 `.scratch/probe-*` 这个形状"分开。
 * 不要求的话，本仓自己讲这道规则的那两处写法（README 的规则表、docs/15 §0 那句
 * "凡是引用 `.scratch/probe-*.mts` 的地方…"）会被 `probe-` 这段前缀匹配上，
 * 于是**解释规则的句子上也挂了一条判定** —— 而 README 那一处判成了 skip:measured-past，
 * 理由是那句话里出现了"改前实测"四个字（作为**被讲解的词**出现）。
 * 一张靠巧合发出去的免检牌，正是本节另一边禁的那种东西。
 * 与 REF_RE 要求"扩展名紧贴冒号"是同一条**范围划界**的纪律，不是逃逸口。
 */
export const PROBE_RE = /\.scratch\/[A-Za-z0-9._-]*\.(?:mts|ts|mjs|js|json|md)/g;

/**
 * 探针引用要在一句"实测"旁边点名**永久落点**（测试文件 / 变异集 / 登记文档，见 PERMANENT_RE）。
 * 半径比行号规则宽得多（±2 会逼作者把句子写残去迁就检查器），
 * 但它只是**上限**：真正的边界是"同一个块"，见 PROBE_BLOCK_BREAK。
 */
export const PROBE_WINDOW = 10;

/**
 * 块级硬界的**源码**（不是正则对象）。两处要用不同 flag，所以只能共用字符串：
 *  - `sentences()` 里要 `gm`（`matchAll` 要 g，`^` 要 m）；
 *  - 探针窗口那边是**逐行** `.test(line)`，绝对不能带 g ——
 *    带 g 的正则每调一次 `.test` 就推进 `lastIndex`，同一行问第二次会给出不同答案，
 *    那是本文件最讨厌的一类"看着对、其实每两轮错一次"。
 * 共用一段源而不是抄两份字面量：这两处必须认同样的东西，
 * 而"抄两份然后其中一份不一样"正是本仓记账记到现在的那个形状。
 */
const BLOCK_BREAK_SRC = '^[ \\t]*(?:\\*+[ \\t]*)?(?:#{1,6}\\s|\\||`{3})|^[ \\t]*\\*?[ \\t]*$';

/**
 * 落点窗口的**块边界**：标题行、表格行、代码围栏、空行（含 JSDoc 里那根孤零零的 `*`）。
 * 与 sentences() 用的是同一族判据，理由也一样，但这里更关键：
 *
 * 光按 ±10 行开窗口，本仓第一批 ok 里有两条是从**别的东西**的正文里捞到落点的 ——
 * docs/08 那一条的窗口里捞出 21 个测试文件名，docs/15 的开头那一段捞出 14 个。
 * 那等于"这附近某处提到过某个测试文件"就算作证，而任何一段写得够长的
 * 技术说明都会提到测试文件名。判据退化成永远成立，检查器就反过来**替坏引用作证**
 * —— 这是 weak 那一档存在的同一个病，只是这次长在探针规则上。
 *
 * 收紧之后（本轮量的）：原先判 ok 的里有 8 条在块内点不出名字。
 * 逐条看过，**没有一条是"落点本来就在隔壁块、只是隔了个标题"** ——
 * 三条本来就写着"改前实测"（被宽窗口顺带捞到了别的落点才误判成 ok），
 * 另外五条是真没有落点，本轮逐条补上了测试名。
 * 也就是说这 8 条全是宽窗口的功劳，一条都不该过。
 */
export const PROBE_BLOCK_BREAK = new RegExp(BLOCK_BREAK_SRC, '');

/**
 * 永久落点的形状。**判据只有一条：这个文件别人 clone 得到。**
 *
 * 三种形状：
 *  1. `xxx.test.ts` —— 落点就是钉住这件事的那条测试；
 *  2. `tooling/mutate/x.json` 的某条 case —— 落点是"把源码改坏之后这条会红"，
 *     它比测试更强，因为它同时说明"没有这条测试的话就没人管"；
 *  3. `docs/08` 这类登记文档 —— 给的是**刻意不修**的那一类。
 *     没有第三种的话，docs/08 里"这个问题未决、本轮不修"那些行会全部无路可走：
 *     未决问题**不该**有测试（钉一个没实现的语义，测试就替错误设计背书），
 *     而 src/ 与 gate.ts 早就在用"记在 docs/08"这个写法了，
 *     所以这条不是新发明的出口，是把已经在用的写法认下来。
 *
 * ⚠ 主名**允许不带目录**（`vacuity.test.ts` 而不是只认 `a/b/vacuity.test.ts`）——
 * 从前那个写法有个洞：`.scratch/vacuity.test.ts` 里"`.scratch/`"这部分
 * 因为要求目录末尾有 `/`、而它后面接的是 `vacuity`（不是 `/`），压根没被匹配上，
 * 于是**探针文件靠自己的文件名给自己发了张永久落点的证明**。
 * 而这条规则的全部意义就是"别拿 clone 拿不到的东西作证"。
 * 现在裸主名认了（这才是人的写法），但 `.scratch/` 与 `/tmp/` 起头的
 * 那一律**不算**，见 NOT_PERMANENT。
 */
export const PERMANENT_RE =
  /((?:[A-Za-z0-9._/-]*\/)?[A-Za-z0-9._-]+\.test\.ts)|tooling\/mutate\/[A-Za-z0-9._-]+|(docs\/\d[A-Za-z0-9._一-龥-]*\.md)/g;

/**
 * 就算长得像落点也不算 —— 这些路径 clone 下来不存在。
 * 单独一张表而不是写进上面的正则：这样"为什么排除"有地方写，
 * 而且**能在报告里指名道姓**（"你点的这个本身是 gitignore 掉的"比"没找到落点"有用得多）。
 */
export const NOT_PERMANENT = /^(\.scratch\/|\/tmp\/|~\/|tmp\/)/;

/**
 * "这次测量**不是**当前行为"的标记词。
 * 为什么这一类免检：测试断的是**今天**的行为，改前的行为本来就没有、也不该有测试；
 * 而本仓大量注释的价值恰恰在"这里从前是什么、为什么不是了"。
 * 要求给改前行为补测试是荒谬的，所以这一类只要求**说清它不是现状**。
 * ⚠ 免检条件是"这句自己承认不是现状"，不是"附近出现过这些词" ——
 * 与行号规则那条同一条窄性纪律（那边真错过一次，见 isPast）。
 *
 * ── 「原本」本轮被从这张表里去掉了 ──────────────────────────
 * 它命中的那一处是「**我原本以为**会看到 X，探针给的是 Y」——
 * "原本"修饰的是**作者的预期**，不是那次测量的时间。
 * 那一处**照样该免检**，但理由是另一件：那句还写着「把缺陷写回后跑」，
 * 测的是**刻意重新引入的缺陷**。于是加了 `写回` 这一类，删了 `原本`。
 * 这不是抠字眼：留着 `原本`，"这里原本还发过一条事件，实测（探针 X）"
 * 这种句子（本仓真有同形状的）会拿到一张免检牌，而它说的可能是现状。
 * 一张发错的免检牌比一张漏发的牌贵 —— 漏发的那张人会来问，
 * 发错的那张没人会再看。
 */
export const MEASURED_PAST = ['改前', '修改前', '改动前', '原先', '从前', '以前', '此前', '当年', '曾经', '当时', '写回'];

/**
 * "这件事**至今没修**"的标记词 —— 单独一档，不并进 MEASURED_PAST。
 *
 * 理由不是分类癖，是这两种免检的**下一步动作**不同：
 *  - "改前实测"：东西已经修好了，去看那条测试就行；
 *  - "未决/刻意不修"：**没有**测试可看，也不该有（钉一个没实现的语义，
 *    测试就替错误设计背书）。它的永久落点是登记文档里那一行本身。
 * 合成一档的话，报告上"另有 N 条改前实测"会谎报第二种的存在情况 ——
 * 而读报告的人正是靠这个数字决定"还要不要回去看"。
 *
 * 判据仍然是"这句自己承认"，与 MEASURED_PAST 同严：同一个硬句里要有这些词。
 */
export const OPEN_ISSUE = ['未决', '只登记不修', '本轮不修', '刻意不修', '没有测试', '暂不修'];


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

/**
 * 跳过集传进来（而不是模块里共用一份常量），是为了让"这条规则扫哪些文件"
 * 在调用点上就能看见。目前两道规则用的是同一份 —— 从前它们是两份，
 * 差的那一项从不生效，原因写在 SKIP_DIRS 那里。
 * 保留参数是因为真假跳过项混在一起的代价是"看着扫了、其实没扫"，
 * 值得调用点自己声明。
 */
const listFiles = (dirAbs, skip, acc = []) => {
  for (const name of readdirSync(dirAbs)) {
    if (skip.has(name)) continue;
    const p = join(dirAbs, name);
    if (statSync(p).isDirectory()) listFiles(p, skip, acc);
    else if (SCAN_EXTS.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
};

export function findSources(root = ROOT, skip = SKIP_DIRS) {
  const out = [];
  for (const d of SCAN_DIRS) {
    const p = join(root, d);
    if (existsSync(p)) listFiles(p, skip, out);
  }
  return out;
}

/** 一个词是不是作为独立词出现（`ctx` 不该被 `ctxBase` 满足；`a.b` 允许出现在 `obj.a.b` 里） */
export const hasWord = (text, tok) => {
  const esc = tok.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$.])${esc}(?![A-Za-z0-9_$])`).test(text);
};

/**
 * 把一段文本按**硬句界**切开，保留每句在原缓冲区里的偏移区间。
 *
 * 换行是**软界**（折行的注释在"一句"里的两段文字要能连起来看），
 * 句读才是硬界。这个区别不是讲究：只按单行切句的话，中文注释一折行，
 * 「—— 这里从前写的是」在上行、行号在下行，最典型的历史句式永远认不出来，
 * 于是**老实交代历史的注释全被报成缺陷**（本仓的行号规则真错过这一次，见文件头第 3 条）。
 * 两道规则共用这一份切句逻辑，就是为了不再各写一遍、各错一遍。
 *
 * ── 但有三类换行是**硬**的 ────────────────────────────────────
 * 空行（含 JSDoc 里只有一根 `*` 的那行）、Markdown 标题行、表格行起点。
 * 加它们是因为本轮量到一个真实的误免检：docs/15 里
 * 「…豁免理由原先写的是"web/adb adapter 未开工"…」是**表格最后一格的结尾**，
 * 下一行才是 `#### inheritToChildren：…（本轮实测）` 这个标题 ——
 * 软换行把两者粘成"一句"，于是表格里的「原先」给一句**描述当前行为**的
 * "本轮实测"发了免检牌。这正是本文件反复禁的那种"看着严、其实漏"：
 * 免检条件的边界比被免检的东西松，检查就反过来了 —— 它替坏引用作证。
 *
 * 表格行与标题行按"块"处理而不是只把那一行切开：它们本来就不是散文，
 * 一格一行、一行一个主题，跨行连读在语义上不成立。
 */
/** 整段缓冲区版本：`matchAll` 要 g，`^` 要 m。源与逐行那份共用（见 BLOCK_BREAK_SRC） */
const BLOCK_BREAK = new RegExp(BLOCK_BREAK_SRC, 'gm');

export function sentences(buf) {
  const out = [];
  /** 先在块级硬界处断开，再在每块内部按句读切 —— 偏移靠切片传递，不重数 */
  const cuts = [0];
  for (const m of buf.matchAll(BLOCK_BREAK)) cuts.push(m.index);
  cuts.push(buf.length);
  for (let c = 0; c < cuts.length - 1; c++) {
    const from = cuts[c];
    const to = cuts[c + 1];
    if (to <= from) continue;
    const chunk = buf.slice(from, to);
    let start = 0;
    for (const m of chunk.matchAll(/[。；;！!?？]/g)) {
      out.push({ text: chunk.slice(start, m.index), start: from + start, end: from + m.index });
      start = m.index + 1;
    }
    out.push({ text: chunk.slice(start), start: from + start, end: to });
  }
  return out;
}

/** 缓冲区里 off 这一处落在哪一句；找不到给 null */
export function sentenceAt(buf, off) {
  for (const s of sentences(buf)) if (off >= s.start && off < s.end) return s;
  return null;
}

/** 行号 + 列号 => 在以 from 行起的那段缓冲区里的偏移 */
export function offsetOf(lines, from, lineIdx, col) {
  let off = col;
  for (let i = from; i < lineIdx; i++) off += lines[i].length + 1;
  return off;
}

/**
 * 探针引用是不是在说"这次量的**不是现状**"。
 *
 * 与行号规则那条 `isPast` **刻意同严**：标记要与引用落在同一个硬句里，
 * 邻行/邻句有"原先"不算。理由不是抄过来的 —— 是同一句话在这里会同样骗人：
 * 本轮就量到一处，「…豁免理由**原先**写的是 X」是一个表格单元格的结尾，
 * 下一行才是讲当前行为的小标题；软换行把两者粘成"一句"，
 * 那个"原先"就给一句描述**现状**的实测发了免检牌。放宽一寸，免检就会吞掉真该补落点的引用。
 *
 * 不需要动词判据（行号那边要"写的是/指的是"是因为它要区分"提到行号"与"说行号是旧的"），
 * 这里的语义就是"这次测量属于过去"，`改前实测` / `原先…实测` 本身就说明了。
 *
 * 词表可换：MEASURED_PAST（已经改掉了）与 OPEN_ISSUE（至今没修）走同一个判据、
 * 两种判定，因为它们的下一步动作不同（见 OPEN_ISSUE 的注释）。
 * 共用这一个函数而不是各写一份，是因为"同一个硬句"这条边界两处都得一样严；
 * 各写一份的话迟早只有一处记得改。
 */
export function isMeasuredPast(buf, off, words = MEASURED_PAST) {
  const s = sentenceAt(buf, off);
  if (!s) return false;
  return words.some((w) => s.text.includes(w));
}

/**
 * 引用者周围是不是在说历史。判据见文件头第 3 条。
 * @param lines 全文按行
 * @param refLineIdx 引用所在行（0 基）
 * @param refCol 引用 token 在该行的起始列（0 基）
 */
export function isPast(lines, refLineIdx, refCol, window = WINDOW) {
  const from = Math.max(0, refLineIdx - window);
  const to = Math.min(lines.length - 1, refLineIdx + window);
  const buf = lines.slice(from, to + 1).join('\n');
  const off = offsetOf(lines, from, refLineIdx, refCol);
  const s = sentenceAt(buf, off);
  if (!s) return false;
  const head = s.text.slice(0, off - s.start);
  for (const mk of PAST_MARKERS) {
    const at = head.lastIndexOf(mk);
    if (at < 0) continue;
    // 标记与引用之间只允许隔"写的是 / 这里是 / 指的是"这种短距离（可跨行）
    const between = head.slice(at + mk.length).trimEnd();
    if (new RegExp(`${PAST_VERB}[^。；;]{0,30}[:：]?$`, 's').test(between)) return true;
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
 * 探针引用检查（第二道规则，与上面 `文件:NN` 那道并列）。
 *
 * ── 它管的是什么形状 ─────────────────────────────────────────
 * `.gitignore` 里对 `.scratch/` 的立场是清楚的：探针是**当下唯一的证据**，
 * 所以留着；但**结论要留在测试里，而不是留在探针里**。
 * 于是有一种失效是这两件事之间的缝：注释写"实测（`.scratch/probe-x.mts`）"，
 * 而 clone 出来的人**打不开那个文件**（它被 gitignore 了），于是那句"实测"
 * 在仓库之外不可验证。更坏的是它**永远不红** —— `文件:NN` 那道规则看不见它
 * （探针路径后面没有冒号行号），人也不会回去核。
 *
 * 本轮量过：非测试文件里有 17 处这样的引用，**没有一处**点名永久落点。
 *
 * ── 判据（两条都放行，缺一条就报） ───────────────────────────
 *  1. 同一句附近点名**永久落点**：某个 `xxx.test.ts` 或 `tooling/mutate/xxx.json`；
 *  2. 或者这句话自己承认测的是**改动前**（"改前实测"、"原先…实测"）。
 *     这一类必须免检：测试断的是今天的行为，改前的行为本来就没有测试，
 *     要求给它补一条是荒谬的；而"这里从前是什么"正是本仓注释的主要价值之一。
 *
 * ── 为什么测试文件本身不查 ───────────────────────────────────
 * 测试函数自己就是永久落点，在自己的测试里写自己所在文件的文件名是纯粹的噪声。
 * 要查的是**注释替行为作证**的那些地方：src/ 的注释、docs/ 的表格。
 *
 * ── 顺带查的一件事 ──────────────────────────────────────────
 * 点了名的 `xxx.test.ts` **在不在**。这条便宜且没有误报空间：
 * 测试文件改名而注释没跟上，是"引用存活"那道规则管不到的另一种写法
 * （没有冒号行号）。落点不存在，等于这条规则什么都没保证。
 */
export function checkProbes(root = ROOT) {
  const files = findSources(root, SKIP_DIRS);
  const out = [];
  const cache = new Map();
  const linesOf = (p) => {
    if (!cache.has(p)) cache.set(p, readFileSync(p, 'utf8').split('\n'));
    return cache.get(p);
  };
  // 全仓测试文件的主名集合，用来判"点名的那条测试存不存在"
  const testNames = new Set(
    findSources(root, SKIP_DIRS).filter((f) => f.endsWith('.test.ts')).map((f) => basename(f)),
  );
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    // 测试文件与测试目录里的引用不查（见文件头）
    if (rel.includes('/test/') || /\.test\.[a-z]+$/.test(rel)) continue;
    /*
     * 本文件也免检 —— 它通篇在讲 `.scratch/probe-xxx.mts` 这个**形状**，
     * 那些都是模式演示，不是证据引用。
     * ⚠ 从前漏了这一条，第一版跑出来第一批"违规"全是检查器自己在解释规则的句子。
     * 代价与行号规则同一句话：检查器管不到自己。
     */
    if (SELF_SKIP.includes(rel)) continue;
    const lines = linesOf(f);
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(PROBE_RE)) {
        const item = { file: rel, line: i + 1, target: m[0], verdict: '', detail: '' };
        out.push(item);
        if (lines[i].includes(ESCAPE)) { item.verdict = 'skip:escaped'; continue; }
        /*
         * 窗口在块边界处**截断**（见 PROBE_BLOCK_BREAK 的注释）。
         * 块内点不出名字时，还要再给一次机会：往整个 ±PROBE_WINDOW 的原始范围里
         * 找一遍"这句自己承认是改前"。免检判据比落点判据宽一寸是**故意相反**的
         * 方向 —— 少报一条免检会让老实写了"改前实测"的作者被误伤，
         * 而多报一条免检会让坏引用溜过去；两者里后者才是这条规则要防的东西，
         * 所以宽出来的那一寸只用在**放行历史叙述**上，不用在作证上。
         */
        const from = Math.max(0, i - PROBE_WINDOW);
        const to = Math.min(lines.length - 1, i + PROBE_WINDOW);
        let a = i; while (a > from && !PROBE_BLOCK_BREAK.test(lines[a - 1])) a--;
        let b = i; while (b < to && !PROBE_BLOCK_BREAK.test(lines[b + 1])) b++;
        const win = lines.slice(a, b + 1).join('\n');
        // 点名了落点：先剔掉"看着像落点、其实 clone 拿不到"的，再剔掉**自己指自己**的
        const rawNamed = [...win.matchAll(PERMANENT_RE)].map((x) => x[1] ?? x[2] ?? x[0]);
        const selfName = basename(rel);
        const named = rawNamed.filter((n) => !NOT_PERMANENT.test(n) && basename(n) !== selfName);
        const unreal = rawNamed.filter((n) => NOT_PERMANENT.test(n));
        if (named.length) {
          const stemNamed = named.some((n) => testNames.has(basename(n)));
          const specNamed = named.some((n) => n.startsWith('tooling/mutate/') && existsSync(join(root, n)));
          const docNamed = named.some((n) => n.startsWith('docs/') && existsSync(join(root, n)));
          if (stemNamed || specNamed || docNamed) {
            item.verdict = 'ok';
            item.detail = `落点 ${[...new Set(named.map((n) => basename(n)))].join('、')}`;
          } else {
            item.verdict = 'missing-landing';
            item.detail = `点名的落点 clone 下来不存在：${named.map((n) => basename(n)).join('、')}（测试文件改名了？）`;
          }
          continue;
        }
        /*
         * 块内**只**点到 `.scratch/` 之类的，不单列一种判定 —— 它和"什么都没点"
         * 是同一种错（没有 clone 得到的落点），单列会让两种错的分担数各算一份、
         * 摘要里多一个永远只有个位数的一行。但它**要写进消息**：
         * "什么都没点"会让人去找漏点的测试，而真相是"点错了对象"，改法不一样。
         */
        // 没点名 => 只有"明说这不是现状"才放行。
        // ⚠ 这里用的是**未截断**的 wide 缓冲区，偏移也必须按 wide 的起点算：
        // 上面 win 按块界截断、若偏移仍按 from 算，两个数字对不上，
        // isMeasuredPast 会在错位的地方找句子（本轮差点留下去）。
        const wide = lines.slice(from, to + 1).join('\n');
        const wideOff = offsetOf(lines, from, i, m.index);
        if (isMeasuredPast(wide, wideOff)) { item.verdict = 'skip:measured-past'; continue; }
        // 第二张免检牌：**至今没修**的那一类（它本来就没有测试可指，见 OPEN_ISSUE）
        if (isMeasuredPast(wide, wideOff, OPEN_ISSUE)) { item.verdict = 'skip:open-issue'; continue; }
        item.verdict = 'no-landing';
        item.detail = (unreal.length
          ? `块内只点到 clone 拿不到的路径（${[...new Set(unreal.map((n) => basename(n)))].join('、')}）—— `
            + '它自己就在 gitignore 里，不能给自己作证。'
          : '这句"实测"旁边没有任何永久落点。')
          + '要么点名落点（xxx.test.ts / tooling/mutate/x.json / docs/08 那样的登记文档），'
          + '要么写明这是**改前**的实测';
      }
    }
  }
  return out;
}

/**
 * 主判定。返回全部引用 + 每条判定，`--evidence` 直接给人看。
 * verdict: ok | stale | missing-file | skip:history | skip:quoted | skip:no-identifier | skip:self | skip:escaped
 */
export function checkRefs(root = ROOT) {
  const files = findSources(root, SKIP_DIRS);
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
 * 违规 = 坏指针 **+ 判不出 + 探针引用没有永久落点**。
 * 把 weak 也算进退出码是有取舍的：它今天可能指对了，所以这不是"抓到缺陷"而是
 * "要求作者把这条变成可判定的"。修法与坏指针同一个、且更便宜 —— 去掉行号改用符号名。
 * 留在绿里不行：一条常年输出"另有 N 条判不出"而从不拦人的命令，
 * 与文档里写一句"记得核对引用"是同一件没用的事。
 */
export function violations(refs) {
  return refs.filter((r) => r.verdict === 'stale' || r.verdict === 'missing-file'
    || r.verdict === 'weak' || r.verdict === 'no-landing' || r.verdict === 'missing-landing');
}

export function printReport(refs, probes, { evidence = false } = {}) {
  const bad = violations([...refs, ...probes]);
  const n = (v) => refs.filter((r) => r.verdict === v).length;
  const q = (v) => probes.filter((r) => r.verdict === v).length;
  const nBad = n('stale') + n('missing-file');
  /*
   * 四种跳过**全部印在摘要里**，不折成一句"其余免检"。
   * 这条检查的价值全在"绿有多少是真绿"：skip:no-identifier 堆到几十条而屏幕
   * 只写"全部通过"，那个绿就是被跳过撑起来的，与没检查一样
   *（unread-fields 也直接印未读数，不藏进"已豁免"）。
   * 探针那三种免检同理 —— 尤其 skip:open-issue，它意味着"这件事没有测试"，
   * 读报告的人要靠这个数字知道有几个这样的洞，而不是只看到"全部通过"。
   */
  console.log(`引用存活检查：共 ${refs.length} 条 —— 活 ${n('ok')}、坏 ${nBad}、`
    + `判不出（候选过多）${n('weak')}、历史句式免检 ${n('skip:history')}、`
    + `贴的工具输出 ${n('skip:quoted')}、提不出候选词 ${n('skip:no-identifier')}、`
    + `本检查自身文件 ${n('skip:self')}、行内标记 ${n('skip:escaped')}`);
  console.log(`探针引用检查：共 ${probes.length} 条 —— 有永久落点 ${q('ok')}、`
    + `没落点 ${q('no-landing')}、落点不存在 ${q('missing-landing')}、`
    + `明说是改前实测 ${q('skip:measured-past')}、明说是未决/没修 ${q('skip:open-issue')}、`
    + `行内标记 ${q('skip:escaped')}`);
  /* 打印时分开：weak 虽计入退出码（见 violations），但它不是"抓到缺陷"，
     混在坏指针列表里会让人以为这两类的处理紧迫性一样。 */
  for (const r of refs.filter((x) => x.verdict === 'stale' || x.verdict === 'missing-file')) {
    console.log(`  坏  ${r.file}:${r.line}  ->  ${r.target}`
      + `${r.verdict === 'missing-file' ? '（找不到目标文件）' : `（落点附近找不到 ${r.detail}）`}`);
  }
  for (const r of refs.filter((x) => x.verdict === 'weak')) {
    console.log(`  判不出  ${r.file}:${r.line}  ->  ${r.target}  ${r.detail} —— 候选太多，任一命中等于没命中`);
  }
  for (const r of probes.filter((x) => x.verdict === 'no-landing' || x.verdict === 'missing-landing')) {
    console.log(`  探针无落点  ${r.file}:${r.line}  ->  ${r.target}  ${r.detail}`);
  }
  if (evidence) {
    for (const r of refs) console.log(`  ${r.verdict.padEnd(20)} ${r.file}:${r.line} -> ${r.target}  ${r.detail}`);
    for (const r of probes) console.log(`  ${r.verdict.padEnd(20)} ${r.file}:${r.line} -> ${r.target}  ${r.detail}`);
  }
  return bad;
}

function main() {
  const refs = checkRefs();
  const probes = checkProbes();
  const bad = printReport(refs, probes, { evidence: process.argv.includes('--evidence') });
  if (bad.length) {
    /*
     * 每段提示都要**按那道规则真的贡献了红**才印，不能按"另一道没红"推。
     * 「坏 0 却退出 1」有两种成因（只剩判不出 / 只剩探针无落点），
     * 从前这里只看了前者，于是纯探针那一类的红会被解释成"红的原因是判不出"——
     * 一句话把读者指向错的那道规则，而这段提示的存在理由恰恰是不让人去查工具。
     */
    const refBad = refs.some((r) => r.verdict === 'stale' || r.verdict === 'missing-file');
    const probeBad = probes.some((r) => r.verdict === 'no-landing' || r.verdict === 'missing-landing');
    const weakBad = refs.some((r) => r.verdict === 'weak');
    if (!refBad && weakBad) {
      console.log('\n（这一轮没有抓到坏指针，行号那道红的原因是**判不出**的那几条：'
        + '它们今天可能指对了，但这段文字不足以判定，所以照样拦。）');
    }
    if (!refBad && !weakBad && probeBad) {
      console.log('\n（这一轮行号那道全过，红**只**来自探针引用没有永久落点那几条。）');
    }
    if (!probeBad) {
      console.log('\n行号引用是注释里最容易烂掉的一种引用：改一个名字不会有人回来同步。'
        + '\n首选修法：改成**按符号名引用**（`StepSchema`、`WaitOptionsSchema.onTimeout`），'
        + '行号本来就不该出现在注释里。'
        + '\n确实要留行号时，把"这里从前写的是 :NN"单独成句（那个句式免检），'
        + '或在行尾加 `ref-lint:ignore` 并写明理由。');
    }
    if (probeBad) {
      console.log('\n探针（`.scratch/…`）被 gitignore 掉了，clone 下来的人打不开它 ——'
        + '\n所以"实测（某探针）"这句话在仓库之外不可验证。三条出口：'
        + '\n  1. 点名**永久落点**：那条结论现在的测试（`xxx.test.ts`）、变异集里那条 case，'
        + '或未决问题的登记文档（`docs/08` 那种）；'
        + '\n  2. 写明这是**改前**的实测（"改前实测…"单独成句）—— 改前的行为本来就不该有测试；'
        + '\n  3. 写明这件事**至今没修**（"未决""只登记不修"）—— 它本来就没有测试可指。'
        + '\n（讲**规则本身**时举的例子不算引用：那种句子写成"某个 `probe-*.mts`"，'
        + '或者整行加 `ref-lint:ignore` 并写明它是示例。）');
    }
  }
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
