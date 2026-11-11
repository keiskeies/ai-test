/**
 * 静态资源的路径解析 —— **白名单，不是黑名单**。
 *
 * ## 为什么这件事在这个仓里要单独写一格
 *
 * 服务端要发的东西跨两个风险等级完全不同的区域：
 *  - `packages/<包>/dist`、`node_modules/zod` —— 纯代码，公开无害；
 *  - `<evidenceDir>/<runId>/…` —— **真实响应体，可能带未脱敏 PII**
 *    （`cmdInit` 就是为这个才在初始化时提醒"先确认 .gitignore 有它再提交"）。
 *
 * 黑名单在这里有两条走不通的路，两条都是这仓记过的形状：
 *  1. **"挡掉 `..` 就算安全"** —— 编码变体（`%2e%2e%2f`）、URL 双解码、
 *     反斜杠、绝对路径……每一种都要想到。`html.ts` 里那段白名单注释讲的就是这个：
 *     "`javascript:`/`data:` 一律禁止"是黑名单，而相对路径 `..%2F` 能指到包外。
 *  2. **先落一个"根目录"再往里收** —— 根目录一旦是仓库根，
 *     漏一条规则就把 `atest.json`、`.git`、`env/*.json`（环境文件里是**真实 baseUrl 与密钥 ref**）
 *     一起发出去了。
 *
 * 所以这里的结构是：**根 = 一个显式枚举的集合，每个根再限制扩展名**。
 * 判据是 `Set.has(扩展名) && 根前缀命中`，两边都是精确相等，
 * 没有"这种写法应该过不了吧"这种要靠记全的东西。
 *
 * ## 为什么归一化放在解码之后、且只认 `/`
 *
 * `decodeURIComponent` 之后才比前缀，于是 `%2e%2e/` 与 `../` 在这里是同一个字符串，
 * 一次判掉两种写法。反斜杠**不在 Windows 之外有意义**，但 macOS/Linux 上
 * `a\b` 是一个合法文件名 —— 所以这里显式把 `\` 当分隔符处理掉，
 * 而不是指望它不出现在 URL 里（它会：手打的、从 Windows 复制的）。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export interface StaticRoot {
  /** URL 前缀，必须以 `/` 开头且以 `/` 结尾，例如 `/packages/ir/dist/` */
  urlPrefix: string;
  /** 磁盘目录（绝对路径） */
  dir: string;
  /** 允许外发的扩展名。**空集合 = 一个文件都不发**，而不是"什么都发" */
  extensions: ReadonlySet<string>;
  /** 给人看的理由：报错要说清"为什么这一格不发"，否则人只会去放宽规则 */
  why: string;
}

/** 会被当成"路径分隔"的字符。URL 里出现反斜杠不是异常，是常态。 */
const SEPARATORS = /[\\/]/g;

/**
 * 把 URL 里的路径段折成"相对 root 的纯相对路径"。
 * 返回 undefined 表示**这个 URL 根本不该被服务**（越界、空段、隐藏文件）。
 *
 * 为什么把 `.`/`..` 段丢掉而不是 join 之后再判："join 之后再判"要先相信
 * `resolve` 的输出形态在所有平台一致；而这里丢掉所有点段之后，
 * 结果里**结构上不可能**有点段，`resolve(root, rel)` 也就不可能跳出 root。
 * 少依赖一条平台行为，就多一分确定性。
 */
function toRelative(pathname: string): string | undefined {
  const decoded = (() => {
    try { return decodeURIComponent(pathname); } catch { return undefined; }
  })();
  if (decoded === undefined) return undefined;
  const segments = decoded.replace(SEPARATORS, '/').split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  // 隐藏文件一律不发：`.git/`、`.env`、`.npmrc` 这些都在仓库根附近，
  // 而"它在前缀白名单里所以能发"并不是"它应该被发到浏览器里"的理由
  if (segments.some((s) => s.startsWith('.'))) return undefined;
  return segments.join('/');
}

export interface ResolvedFile {
  absolute: string;
  /** 命中的那个根（报错与日志要用） */
  root: StaticRoot;
}

/** 目录请求要落到的那个文件名。只在"这个根本来就发 .html"时才用 */
const INDEX = 'index.html';

/**
 * URL 路径 → 磁盘文件。**不命中白名单一律 undefined**，由调用方发 404。
 *
 * 404 而不是 403：403 会说"这里有个东西但不给你"，
 * 而"哪一格有东西"本身就是信息（证据目录是否存在、跑了几个场景）。
 *
 * `rel` 为空（请求打到前缀本身，例如 `/app/`）时只在**这个根允许发 .html**
 * 的前提下落到 `index.html`。为什么要这个前提：`/pkg/ir/` 那种根只发 `.js`，
 * 给它一个 index 行为等于凭空造出一个"目录能开"的假入口；
 * 而前端那一格本来就要发 html，index 是它真实需要的能力。
 *
 * ## **最长前缀拥有这个请求**（不 fallthrough）
 *
 * 这一条是后来补的，原先是"这一格判不出就换下一格"，而那会让**每棵根的扩展名
 * 白名单整体失效**：`/pkg/ir/x.html` 在只发 `.js` 的 ir 那一格判不出之后，
 * 掉进 `/` 那一格，于是去 `web/static/` 里读 `pkg/ir/x.html` ——
 * 跨根借文件。判据从"成员名的集合"退化成"折叠后看起来像某格的成员"，
 * 那是黑名单形状（本文件开头讲的正是这个）。
 *
 * 现在的语义：**命中的最长前缀拥有这个请求**，它判不出就是 404，不再往下找。
 * 这也是所有静态文件服务器的通行语义，读代码的人不需要想一想。
 */
export function resolveStatic(pathname: string, roots: readonly StaticRoot[]): ResolvedFile | undefined {
  // 先按**前缀长度降序**排：`/app/` 与 `/` 同时在表里时，长的那一条必须赢
  const ordered = [...roots].sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  for (const root of ordered) {
    if (!pathname.startsWith(root.urlPrefix)) continue;
    // 命中即拥有：下面三条出口一律 return，不再看更短的根
    const rel = toRelative(pathname.slice(root.urlPrefix.length - 1));
    if (rel === undefined) return undefined;
    if (rel === '') {
      if (!root.extensions.has('.html')) return undefined;
      return { absolute: join(root.dir, INDEX), root };
    }
    const ext = extname(rel).toLowerCase();
    if (!root.extensions.has(ext)) return undefined;
    return { absolute: resolve(root.dir, rel), root };
  }
  return undefined;
}

/**
 * 证据包里**能被浏览器直接取**的成员（`artifacts/<64hex>` 也在内）。
 *
 * 与 `html.ts` 的 `memberHref` 是**同一族判据、不同一侧**：
 * 那边决定"报告里允许出现哪些链接"，这边决定"这些链接指向的文件允许被读"。
 * 两侧都必须是白名单，否则一侧收紧另一侧放宽，净效果等于没收。
 *
 * runId 这一格单独判。原先这里只过一遍字符集 `[A-Za-z0-9._-]`，理由是
 * "目录名由 `safeRunId()` 算出，所以不含点段" —— **那句理由是错的，实测过**：
 * `.` 与 `..` 两个字符全在那个字符集里，`runId = ".."` 原样穿过清洗，
 * 于是 `join(evidenceDir, '..', 'manifest.json')` 指到证据目录**外面**那一份 manifest。
 * 判据挂在"字符集"上就永远判不住这一条，因为 `..` 是**合法字符组成的非法名字**，
 * 只能按整个名字判 —— 所以多了下面那个 RESERVED。
 *
 * （写侧那一格已经一起修了：`commands.ts` 的 `safeRunId` 现在显式拒保留段，
 *   载体是 `packages/cli/test/e2e.test.ts` 里「--run-id 不能把产物写到证据目录之外」
 *   那条。读侧仍然自己判一遍，因为**读侧的判据不能依赖写侧一直正确** ——
 *   证据目录里真躺着一个 `_..` 或 `..` 名字的目录，本身就说明已经绕过一次了。）
 */
const RUN_ID = /^[A-Za-z0-9._-]+$/;
/**
 * **整段都是点**的名字（`.`、`..`、`...`）一律拒。
 *
 * 只拒 `.` 与 `..` 不够：`...` 在 macOS/Linux 上不是保留段，但
 * `join(evidenceDir, '...')` 之后 member 那一格再叠一个 `..` 就出得去，
 * 而且写侧 `safeRunId` 对 `...` 也是同样处理（它把整段点都改名），
 * 两侧判据一致才不会"写侧拦了读侧没拦"或反之。
 *
 * 反过来讲清楚**不拒**什么：`.hidden` 这种"以点开头但不是全点"的名字照过 ——
 * 它 join 出来还在证据目录里面，不构成越界；而把它判成非法会让那次 run 的产物
 * 在界面上变成"不存在"，那正是这仓最反感的一种错法（存在、但说读不出）。
 */
const ALL_DOTS = /^\.+$/;
const MEMBER = /^(?:trace\.jsonl|junit\.xml|manifest\.json|summary\.txt|report\.html)$/;
const ARTIFACT = /^artifacts\/[0-9a-f]{64}$/;

export function resolveEvidence(evidenceDir: string, runId: string, member: string): string | undefined {
  if (!RUN_ID.test(runId) || ALL_DOTS.test(runId)) return undefined;
  const clean = member.replace(SEPARATORS, '/').split('/').filter((s) => s !== '' && s !== '.').join('/');
  if (clean.includes('..')) return undefined;
  if (!(MEMBER.test(clean) || ARTIFACT.test(clean))) return undefined;
  return join(evidenceDir, runId, clean);
}

/** 读文件并顺手拒掉目录（目录会让 res.end 抛，症状是连接重置而不是报错） */
export async function readIfFile(absolute: string): Promise<Buffer | undefined> {
  try {
    const st = await stat(absolute);
    if (!st.isFile()) return undefined;
    return await readFile(absolute);
  } catch {
    return undefined;
  }
}
