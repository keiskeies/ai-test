// 蓝图 §11.4.4 / docs/2026-11-13-ai-test-platform-design.md:1426
// 「接口/用例详情 | 编辑器空态『口述生成请求体』; 调试失败 → 『让 Pilot 分析』(带响应体)」
// 本文件只实现后半句，且走 D84 的「诚实切片」口径：拼好的草稿经
// nav("/bench", { state: { pilotDraft } }) 预填进 Pilot 输入框，人过目后自己按发送。
// 不自动发、不建会话、不给 MessageIn 加 context 字段（那半截待业主裁）。
// 前半句「口述生成请求体」本轮没做，账记在 1G 计划里，不在这里假称完成。
// 本模块不 import antd、不 import react-router：它是 src/api/debugPilot.test.ts
// （node 环境，无 DOM）能跑的前提——一个 message.info 就够把纯逻辑单测炸在
// `document is not defined`。提示语属渲染层，在 DebugPanel 的按钮里。
import type { DebugResult } from "./DebugPanel";

/** 与 reportDetail.tsx:70 / adbDevices.tsx:96 同一个上限：后端 MessageIn.content max_length=20000。 */
export const PILOT_DRAFT_MAX = 20000;
/** 结果行的上限：断言行、报错行、请求行共用一条口径。 */
export const PILOT_ROW_LINE_CLIP = 120;
/** 响应体逐字进草稿的上限。断言结果条数**没有上限**（用户能配多少条就有多少条），
 *  所以「头 + 断言 + 响应体」的总额无法先算出来——响应体先按 19500 取，
 *  整段再由 PILOT_DRAFT_MAX 兜底；真兜到底时会在草稿里明说少了多少字符。 */
export const PILOT_BODY_CLIP = 19500;

/**
 * 截断必须留痕：`clip` 在 reportDetail.tsx:73 是私有件且「不标记」，本处不能借用——
 * 响应体被剪掉一段却不说明，就是拿一段截断的报文冒充完整报文（§13 纪律 1）。
 */
export function clipMarked(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…（已截断：原文 " + s.length + " 字符，只带前 " + max + "）";
}

type Row = Record<string, unknown>;

const brief = (v: unknown): string =>
  JSON.stringify(v === undefined ? null : v) ?? String(v);

/** 断言结果行 → 一行话术：类型 · 路径 · 期望/实际（实际缺席就不编）· 行内 error。 */
export function describeAssertRow(a: Row): string {
  const type = typeof a.type === "string" ? a.type : "（无类型）";
  const path = typeof a.path === "string" && a.path !== "" ? " " + a.path : "";
  const parts = [(a.passed ? "[过] " : "[败] ") + type + path];
  if ("expected" in a) parts.push("期望 " + brief(a.expected));
  if ("actual" in a) parts.push("实际 " + brief(a.actual));
  if (typeof a.error === "string" && a.error !== "") parts.push("报错 " + a.error);
  return clipMarked(parts.join(" · "), PILOT_ROW_LINE_CLIP);
}

/**
 * 判定「要不要递刀子」只在生产端做（本函数），渲染端不拿它当存在性判据：
 * 生产端判 false 时按钮压根不渲染（DebugPanel 的 subject 不传），渲染端再判一次
 * 就是两处口径各自漂移的开始。
 * 「请求本身失败」（!ok）递；「请求成功但断言有败」（!passed）递；全过不递。
 * 零断言行 + ok 的情况 passed 会是后端 all([]) === true，落进「全过」，不递——
 * 与 DebugPanel 徽标那套「未校验」口径同源（零行时不猜原因）。
 */
export function debugFailedForPilot(r: DebugResult): boolean {
  if (!r.ok) return true;
  return !r.passed;
}

/**
 * 调试结果 → 给 Pilot 的草稿。逐段「宁缺不编」：字段没值就整行省略，
 * 响应体逐字（带截断标记），不压成「大概是个 JSON」这种结论。
 */
export function buildDebugPilotDraft(
  subject: string,
  r: DebugResult,
  requestLine?: string | null,
): string {
  const lines: string[] = ["这次调试失败了，帮我分析一下原因。", "", "对象：" + subject];
  if (!r.ok) lines.push("请求本身失败（没拿到响应）");
  else lines.push("请求发出去了，但有断言没过");
  lines.push("运行 ID：" + (r.run_id !== "" ? r.run_id : "（本次调试没落运行记录）"));
  if (r.status != null) lines.push("状态码：" + r.status);
  if (r.env_name) lines.push("环境：" + r.env_name);
  lines.push("耗时：" + r.elapsed_ms + " ms");
  if (requestLine) lines.push("请求：" + requestLine);
  if (r.error) lines.push("报错：" + clipMarked(r.error, PILOT_ROW_LINE_CLIP));
  if (r.body_size > 0 || r.body_text != null) lines.push("响应体大小：" + r.body_size + " 字节");
  const rows = (r.assertions ?? []) as Row[];
  if (rows.length > 0) {
    lines.push("", "断言结果（共 " + rows.length + " 条）：");
    rows.forEach((a, i) => lines.push((i + 1) + ". " + describeAssertRow(a)));
  }
  lines.push("", "响应体：");
  lines.push(r.body_text == null ? "（无响应体）" : clipMarked(r.body_text, PILOT_BODY_CLIP));
  const draft = lines.join("\n");
  if (draft.length <= PILOT_DRAFT_MAX) return draft;
  // 兜底：断言结果条数没有上限（用户配多少条就有多少行），所以总额可能顶穿。
  // 先给提示句留出固定额度再截头——这样「未带入 N 字符」说的是**真没带进去**的量，
  // 不会拿截断前的长度报一个偏小的数（那是另一个方向的撒谎，只是比较客气）。
  const head = draft.slice(0, PILOT_DRAFT_MAX - NOTE_BUDGET);
  return head + "\n…（草稿整体超限，末尾内容未带入：" + (draft.length - head.length) + " 字符）";
}

/** 超限提示句的额度：句式 21 字 + 数字，留 64 足够（要超到装不下得先攒出 10^39 字符草稿）。 */
const NOTE_BUDGET = 64;

/**
 * 发送端唯一的动作：拼稿 → 交 nav。nav 由调用方注入（生产传 useNavigate()，单测传 spy），
 * 所以「预填不偷发」这一类断言不需要 Router、也不需要 DOM 就能钉。
 */
export function askPilotAboutDebug(
  subject: string,
  r: DebugResult,
  nav: (to: string, opts?: { state?: unknown }) => void,
  requestLine?: string | null,
): void {
  nav("/bench", { state: { pilotDraft: buildDebugPilotDraft(subject, r, requestLine) } });
}
