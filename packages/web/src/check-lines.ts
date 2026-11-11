/**
 * 校验状态行与那两张卡上的**句子**。纯数据、不碰 DOM，所以能在 node 里测。
 *
 * ## 为什么要把这几句话从 app.ts 挪出来
 *
 * 直接写在 `app.ts` 里也能跑，但它会让这几句话的**唯一载体变成浏览器测试**，
 * 而 `browserTest` 在没有 Chrome 的机器上是 `test.skip`
 * （`browser-harness.ts` 那句 `BROWSER ? test : test.skip`），node:test 对全跳过的文件
 * 给 pass 0 / fail 0 / **退出码 0**。于是"这几句话有没有被守住"取决于一台机器的
 * `~/Applications` 里躺着什么 —— 那种守卫不算守卫（`tooling/mutate.mjs` 里
 * `noTestsIn` 挡的就是这个形状）。
 *
 * 拆出来之后分工是干净的：**句子在这一格，node 测句子；接线在浏览器测**
 * （`dry-run-check.test.ts` 断的是"屏幕上真的出现了这句话"）。
 * 同一个 `status.ts` 的先例：那里也是"说什么"在纯模块里、"画出来"在页面上。
 *
 * ## 这一格里每一句话都点名了自己的**范围**
 *
 * 这不是文案洁癖。改前那句「引擎没报任何问题」在缺必填输入的当口是**假话**
 * （`dryRun` 也是引擎，而它刚报了一条 error），而它旁边那张卡正好写着
 * 「缺少必填输入：who」。本仓那一族：「**每个消费者都各自正确，而它们对同一件事的
 * 假设互不相容**」（docs/08 §3）。所以这里每一句都写成"哪一查的结论"，
 * 读的人不会把一句范围受限的"通过"读成整场校验的"通过"。
 *
 * ⚠ 不许在这里加任何**判定**。判定在引擎（`lintScenario` / `dryRun`），
 * 这一格只把引擎已经给出的读数换成人话。在这里 `if` 一下，
 * 就造出了第二份"这份场景算不算通过"，而那份没有测试。
 */
import type { StepStatus } from '@atest/ir';
import type { CheckResult } from './check.js';

/** 状态行上的一个元素。形状而不是节点：页面负责画，这里只管说什么 */
export type StatusLine =
  | { kind: 'badge'; status: StepStatus; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/**
 * 「静态闸通过」那句要带上"与 CI 退码同口径"，而这不是装饰：
 * `atest lint` / `run --strict` 的退码判据是 `lintScenario` 的 error 数，
 * **不含** dry-run 那条「缺少必填输入」（CI 从命令行传 `--input`，
 * 那一侧的"缺"与浏览器里的"缺"不是同一件事）。不点名范围，人就会拿屏幕上
 * 那枚红徽章去质疑一个本来绿的 CI —— 那时说谎的是屏幕，而受损的是 CI 的可信度。
 */
export const STATIC_GATE_PASS = '静态闸通过（与 CI 退码同口径）';

/** 缺必填输入时那枚**额外**的徽章。只在真缺的时候出现，不许常态挂着变噪音 */
export const missingInputsBadge = (n: number): string => `还缺 ${n} 个必填输入（不计入 CI 退码）`;

/** 静态闸那张空态卡。最后一句是既有的：跨场景的调用图在浏览器里拿不到，那一查没跑 */
export const EMPTY_STATIC_GATE =
  '静态闸这一查没报任何问题（输入完备性看上面那张卡）。注意下面这一行 —— 还有一查在这里压根没跑。';

export const staticGateCardTitle = (n: number): string => `静态闸报错（${n} 条）`;

/**
 * 「缺少必填输入」那张卡的两句修法。
 *
 * 第二句不许删。屏幕上告诉人"命令行传 `--input who=<值>`"，而人很可能顺手就把
 * 口令填进那个位置 —— 那正好撞上本仓对密钥立的那条纪律（`--input` 的值会进
 * `ps aux`、shell 历史与 CI 的命令日志，所以**从来不许有 `--secret <值>` 这种旗标**）。
 * 既然这里主动给了那条命令，就必须同时给出密钥该走的那条路：`secret:<ref>`
 * 配 `ATEST_SECRET_*` 环境变量（docs/02 §5）。
 */
export const missingInputHint = (missing: readonly string[]): string =>
  `本页填不了输入：命令行传 —— ${missing.map((m) => `--input ${m}=<值>`).join(' ')}`
  + '（或给它们写 default）。屏幕上那个「运行」按钮不会替你补上';
export const SECRET_ROUTE_HINT =
  '值是密钥的话不要走 --input：它会进 ps aux 与 shell 历史。改用 secret:<ref> 配 ATEST_SECRET_* 环境变量（docs/02 §5）';

/**
 * 校验状态行那一系列元素。顺序即屏幕顺序。
 *
 * **两枚徽章各说各的范围，不合成一个"通过/不通过"**，两个方向都坏：
 *  1. 合成一个数 → 屏幕上"1 个 error"而 CI 绿，人开始不信 CI；
 *  2. 只留静态闸那枚 → 缺必填输入时角标是绿的，而那条场景在本地**根本跑不起来**，
 *     唯一说真话的是屏幕下面一张卡。"绿徽章 + 红卡片"能接受，
 *     "绿徽章 + 没有第二个信号"不能：那让人以为整个校验只有一个结论。
 */
export function checkStatusLines(r: CheckResult): StatusLine[] {
  if (!r.parsed) return [{ kind: 'error', text: `IR 不合法：${r.parseError ?? ''}` }];
  const errs = r.issues.filter((i) => i.level === 'error').length;
  const warns = r.issues.filter((i) => i.level === 'warning').length;
  const est = r.dry?.estimate;
  const missing = r.dry?.missingInputs ?? [];
  const out: StatusLine[] = [
    { kind: 'badge', status: errs > 0 ? 'fail' : 'pass', text: errs > 0 ? `${errs} 个静态闸 error` : STATIC_GATE_PASS },
  ];
  if (missing.length) out.push({ kind: 'badge', status: 'fail', text: missingInputsBadge(missing.length) });
  if (warns) out.push({ kind: 'badge', status: 'triaged', text: `${warns} 个 warn` });
  if (est) {
    out.push({ kind: 'note', text: `约 ${est.steps} 步 · ${est.needsDevice ? '要设备' : '不要设备'} · 端 ${est.targets.join('/') || '—'}` });
  }
  // irSha 取不到时给的是**原因**而不是空白 —— 那条纪律写在 check.ts 的 sha256Hex 上
  if (r.irSha) out.push({ kind: 'note', text: `irSha ${r.irSha.slice(0, 12)}…` });
  if (r.irShaError) out.push({ kind: 'error', text: r.irShaError });
  return out;
}
