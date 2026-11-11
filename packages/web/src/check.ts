/**
 * 校验这一侧 —— **浏览器里跑的是真引擎，不是它的复刻品**。
 *
 * ## 为什么这一格是整个前端的存在理由
 *
 * docs/01 §8.2 立的约束是："引擎必须能在浏览器里跑只读校验，
 * 否则 GUI 就得维护第二套校验逻辑，GUI 与执行器开始分叉 ——
 * 这是 Postman↔Newman / Apifox GUI↔CI runner / MeterSphere UI↔runner 全都踩过的坑"。
 * `tooling/lint-layers.mjs` 拦 ir/engine 的 node 内置依赖，就是为了让这条成立。
 *
 * 但"没有 node 依赖"只是**必要条件**。真要说得上话，得让真浏览器真的调一次
 * `lintScenario` 并把它的回答原样显示出来 —— 这就是这个文件干的全部事情：
 * 它不实现任何一条规则，只 import 引擎的函数、调它、渲染它的返回值。
 *
 * 实测过这条路通（`.scratch/probe-browser-ir.mts`，永久落点
 * `packages/web/test/browser-modules.test.ts`）：Chrome 里
 * `lintScenario(那份夹具)` 交出 `["ASSERT_FREE_SCENARIO","DEPENDENCY_CYCLE"]`，
 * `STEP_STATUS` 交出六态，`Object.keys(STEP_TARGET).length` = 39。
 *
 * ## 与真跑的关系：这里**只**做静态那三查
 *
 * `ScenarioSchema.parse`（IR 合不合法）、`lintScenario`（静态闸）、`dryRun`（输入完备性 + 预估）。
 * 一次真执行**不在这里**，走 `POST /api/run` 到服务端再走 CLI ——
 * 因为真执行有副作用（POST/下单/删除，docs/02 §5 的不可逆动作纪律），
 * 那些副作用该由**服务端与 CLI 那一条已经接好线的路径**负责（信号、门禁、证据、租约归还），
 * 浏览器里既没有那些能力，也不该假装有。
 */
import { ScenarioSchema, canonicalScenario, type Scenario } from '@atest/ir';
import { lintScenario, dryRun, type LintIssue, type DryRunResult } from '@atest/engine';

/** 一次校验的全部产出。**全部字段都来自引擎的回答**，这里不加判据 */
export interface CheckResult {
  /** IR 解析是否通过。不通过时后面的都判不了（schema 没过，lint 拿到的对象是残缺的） */
  parsed: boolean;
  /** schema 那一条的原始报错，原样带出（zod 的 message 已经点名到字段） */
  parseError?: string;
  /** 解析成功后的那份 IR（zod 补过 default 之后的，不是磁盘上那个原始 JSON） */
  scenario?: Scenario;
  issues: LintIssue[];
  dry?: DryRunResult;
  /** canonical 序列化后的 JSON 文本。与 CLI 侧 `irShaOf` 的**输入**是同一串 */
  canonical?: string;
  /** 那份 canonical 的 sha256。取不到时说明原因，不编一个 hash */
  irSha?: string;
  irShaError?: string;
}

/**
 * sha256。CLI 侧走 `node:crypto`（packages/store/ir-hash.ts），这一侧走 Web Crypto。
 *
 * **两份实现**——这一句在这个仓里是刺眼的，所以把边界说清：
 * 两边喂的是**同一个 `canonicalScenario()` 的输出**，哈希的是同一串字节，
 * 所以"浏览器里那个 sha 与服务端 manifest 里的 sha 相等"是一个**可核对的事实**，
 * 而不是两个各算各的数。分叉点在 canonical（只有一份、在 IR），不在哈希。
 *
 * 取不到时（非安全上下文里 `crypto.subtle` 不存在，比如有人 file:// 打开这个页面）
 * **不写一个假 hash，也不静默省略**：把原因交出去，让页面上那一格说实话。
 */
async function sha256Hex(text: string): Promise<{ sha?: string; error?: string }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { error: '这个上下文里没有 Web Crypto（crypto.subtle），算不出 sha —— 请用 http://127.0.0.1 打开，不要用 file://' };
  try {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return { sha: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('') };
  } catch (e) {
    return { error: `sha256 计算失败：${(e as Error).message}` };
  }
}

/**
 * 校验一份 IR 文本。**没有 try/catch 包住引擎调用**：
 * 引擎抛异常是我们的 bug，那种情况要让页面红着说"引擎抛了"，
 * 而不是被兜成"这份 IR 有问题"—— 那是把我们的错算到用户用例上，
 * 这一族在本仓修过不止一次（CLI 顶层那个"这不是你的用例的问题"是同族）。
 * 只有 zod 的 `parse` 是**预期会失败**的，那一处单独兜。
 */
export async function checkIr(text: string, inputs: Record<string, unknown> = {}): Promise<CheckResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { parsed: false, parseError: `不是合法 JSON：${(e as Error).message}`, issues: [] };
  }
  let scenario: Scenario;
  try {
    scenario = ScenarioSchema.parse(raw);
  } catch (e) {
    // zod 的 message 里带字段路径，原样给出。这里**不重排版**：
    // 重排一次就是"第二份对同一个错的描述"，而它会和 zod 升级后的那份分叉
    return { parsed: false, parseError: (e as Error).message, issues: [] };
  }
  const issues = lintScenario(scenario);
  const canonical = canonicalScenario(scenario);
  const { sha, error } = await sha256Hex(canonical);
  return {
    parsed: true,
    scenario,
    issues,
    dry: dryRun(scenario, inputs),
    canonical,
    ...(sha === undefined ? { irShaError: error } : { irSha: sha }),
  };
}

/**
 * lint 侧栏用的一份 ctx —— **图由服务端给，不在这里猜**。
 *
 * `DEPENDENCY_CYCLE` 要 `ctx.scenarioGraph`。生产里那张图是
 * `cli` 的 `buildScenarioGraph` 沿 resolver 走可达闭包出来的（要读文件系统），
 * 浏览器里没有文件系统，所以这一侧**只能拿服务端给的图**。
 * 拿不到时**如实传空 ctx**，于是那条规则不响 —— 而页面必须同时说明"这一查没跑"，
 * 否则"没报环"会被读成"查过、没有环"，那正是 `CALL_GRAPH_INCOMPLETE`
 * 这个 code 存在的理由（图不全时"没有环"是超出证据的结论）。
 */
export const GRAPH_NOT_AVAILABLE = '浏览器这一侧没有调用图：跨场景的环要服务端给图才查得到，本页只查场景内那部分。';
