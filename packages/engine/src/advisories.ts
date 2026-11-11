/**
 * 运行期 `lint.reported` 事件的**唯一一份人读出口**。
 *
 * ## 为什么要有这个文件（它不是"再做一个报告"）
 *
 * 引擎在运行期发十一条 `lint.reported` 事件，内容全都不是"顺便记一笔"，
 * 而是**结论有水分**或**某道闸压根没生效**：
 *
 * | code | 说的是什么 |
 * |---|---|
 * | `ROW_LEASE_NOT_IMPLEMENTED` | `leaseRows=true`，但行租约一行代码都没有 —— 两个并发 run 会抢同一行 |
 * | `VALIDATE_REQUEST_UNAVAILABLE` | 人要求校验请求体，adapter 没实现，**这一步压根没校验** |
 * | `RESPONSE_SCHEMA_MISMATCH` | 文档与实现不符（report-only，不进红绿） |
 * | `ARTIFACT_STORE_MISSING` | 没接证据盘，evidence.zip 是个只有元数据的空壳而它看起来是好的 |
 * | `DEPRECATED_OPERATION` | 调的是 spec 里标了废弃的接口 |
 * | `TEARDOWN_FAILED` | 清理没做干净，**可能留脏数据**给下一条用例 |
 * | `REQUEST_SCHEMA_MISMATCH` / `LLM_ADAPTER_MISSING` / `LOOP_*` | …（这些另有可见状态或专门提示带） |
 *
 * 而改动前它们**一条都到不了人眼前**。实测（`leaseRows=true` 的一条 dataSource）：
 *
 * ```
 * 事件里有这条 = true     步骤状态 = pass
 * report.html 提到 = false   junit.xml 提到 = false   CLI 输出提到 = false
 * ```
 *
 * 唯一的落点是 `trace.jsonl` 里的一行 JSON。这不是"信息在但没人看"那种软问题：
 * `docs/14` §5 里**登记着**"发这条事件是为了不让行租约静默地看起来已启用"，
 * 而那句话是假的 —— 一个只读 `report.html` 与退出码的人（也就是绝大多数人）
 * 拿到的是"全绿"。所以本轮改的是**这些事件必须到人眼前**，
 * 而不是"再加一条事件"。
 *
 * ## 为什么判据取事件而不是给每个 emit 点加一个字段
 *
 * 十一条 emit 点分散在四个文件与三种上下文里（有的带 stepId、有的不带，
 * 有的在一次 run 里发很多次如 `ARTIFACT_STORE_MISSING` 那样刻意只发一次）。
 * 挨个给 StepResult 加字段意味着：新增一条 emit 时**必须记得**同时加字段，
 * 忘了就等于这条静默 —— 那正是本仓反复出现的那个缺陷类
 * （schema 有字段、执行侧没人读）的镜像：**有生产者、没有载体，
 * 而载体是逐条手接的**。取事件做载体，新增一条 emit **天然**进得了页面，
 * 因为这里是按 `kind` 筛而不是按 code 白名单筛。
 *
 * ## 三个出口共用这一份（与 redact 那条"三个出口"是同一条理由）
 *
 * `report.html` 的提示带、`junit.xml` 的 `<property name="atest.advisories">`、
 * `summaryText` 最后那一段（CLI 打的就是这一份）。
 * 各写一遍筛选逻辑，迟早只改一处 —— 本仓那族毛病的标准形状。
 *
 * ## 为什么这里**不**改任何状态、不进门禁
 *
 * 提醒不该让 CI 变红：`ARTIFACT_STORE_MISSING` 是部署配置问题（一次 run
 * 只吼一声就是为此），`RESPONSE_SCHEMA_MISMATCH` 按 docs/05 §1.1 必须 report-only，
 * `LOOP_*` 的上限常常是故意的。要不要让某一条进门禁是**逐条**的产品决定，
 * 登记在 `docs/14` §5；本轮只把"必须看得见"这一件事做实。
 */
import type { TraceEvent } from '@atest/ir';

/** 一条提醒的聚合结果：同一个 code **且同一句 detail** 在一次 run 里出现多次时合成一条 */
export interface Advisory {
  code: string;
  /** 那句 detail（adapter 或引擎写的）。渲染前由各自出口脱敏，这里只负责截断 */
  detail: string;
  /** 这一类（code + detail 相同）在这次运行里出现了几次 */
  count: number;
  /** 涉及的步骤 id，**全列**（渲染时才截断）。没有步骤归属时是空数组 */
  stepIds: string[];
  /** 只上报、不参与红绿（emit 点显式带的标记位，目前只有响应侧符合性检查用） */
  reportOnly: boolean;
}

/** 步骤 id 最多列几个。再多对"这一类提醒存在"这个信息没有增量，只会把提示带撑爆 */
const MAX_STEP_IDS = 8;
/**
 * 提示带最多列几条。
 *
 * 上限存在是为了**不让提示带吃掉整页**，但它必须是"截断 + 说明"而不是"截断"：
 * 少了标记，一份有 30 类提醒的报告读起来就是"只有 20 类"，
 * 而那正是本仓最恨的那种失真（真话在报告里、不在产物里 —— 反过来，
 * 产物说"就这些"而实际更多，是同一件事的另一半）。
 */
const MAX_LINES = 20;
/**
 * detail 的展示长度上限（字符）。
 *
 * **必须有**：`REQUEST_SCHEMA_MISMATCH` / `RESPONSE_SCHEMA_MISMATCH` 的 detail 是
 * adapter 的 `violations.join('; ')`，一条 schema 有几十个违规字段时那就是几 KB，
 * 而提示带是放在页面上方的整块区域 —— 撑爆它等于把报告最上面一屏变成垃圾。
 * 截断要**说出来**（尾部留标记），静默截断会让人以为"违规就这几条"。
 */
const MAX_DETAIL = 280;

/** 事件流里是不是运行期提醒。按 kind 筛、不按 code 白名单筛 —— 理由见文件头 */
const isAdvisory = (e: TraceEvent): boolean => e.kind === 'lint.reported';

/** 事件 data 里的 code。没有 code 的事件不算提醒（宁可漏展示，也不在页面上造一个空条目） */
const codeOf = (e: TraceEvent): string | undefined => {
  const c = (e.data as { code?: unknown } | undefined)?.code;
  return typeof c === 'string' && c.length > 0 ? c : undefined;
};

/** detail 取值 + 截断。非字符串（有人塞了个对象）走 JSON，实在拿不到就给空串 */
function detailOf(e: TraceEvent): string {
  const d = (e.data as { detail?: unknown } | undefined)?.detail;
  let s: string;
  if (typeof d === 'string') s = d;
  else if (d === undefined || d === null) s = '';
  // 数组/对象都要给得出来：detail 的写法由 emit 点定，这里不许假设它是字符串
  // （假设错了的表现是页面上那一行变成 [object Object]，也就是又一次"说了等于没说"）
  else {
    try { s = JSON.stringify(d); } catch { s = '（该 detail 无法序列化）'; }
  }
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…（已截断，全文在 trace.jsonl）` : s;
}

/**
 * 事件流 → 人读的提醒清单。
 *
 * **聚合键是 code + detail，不是只看 code**。只看 code 会把两类不同的事合成一句：
 * `DEPRECATED_OPERATION` 的 detail 就是那个废弃接口名、`LOOP_TRUNCATED` 的是
 * 「数据 5 条被 maxIterations=2 截断」—— 三个不同的循环合成一行、
 * 只显示第一个的数目，就是**少报了**。所以宁可多占一行，也不合并不同的事实。
 *
 * 真正会刷屏的那个形状由 count 收掉：**同一个步骤被迭代多次**
 * （dataSource 在 forEach 体里跑 5 轮 => 同一 code 同一 detail 五条事件）合成一条 `×5`。
 *
 * 保持**首次出现顺序**（trace 里的时间顺序），因为"第一条响的通常就是根因"，
 * 重排会把根因埋到列表中间。
 */
export function collectAdvisories(events: readonly TraceEvent[]): Advisory[] {
  const byKey = new Map<string, Advisory>();
  for (const e of events) {
    if (!isAdvisory(e)) continue;
    const code = codeOf(e);
    if (!code) continue;
    const detail = detailOf(e);
    const reportOnly = (e.data as { reportOnly?: unknown } | undefined)?.reportOnly === true;
    // 键用 JSON.stringify 而不是字符串拼接：手挑分隔符（空格 / `|` / `::`）
    // 总会撞上 detail 里本来就有的东西，于是两条**不同的事实**合成一条 ——
    // 少报一条提醒比多占一行严重得多。JSON 编码是自分隔的，不可能撞。
    const key = JSON.stringify([code, detail]);
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, { code, detail, count: 1, reportOnly, stepIds: e.stepId ? [e.stepId] : [] });
      continue;
    }
    hit.count++;
    // reportOnly 取"有一条是就说是"：这条标志的含义是"它不参与红绿"，
    // 一个 code 里有一条标明不参与，就不该在页面上把它写成像是要拦人的样子
    if (reportOnly) hit.reportOnly = true;
    if (e.stepId && !hit.stepIds.includes(e.stepId)) hit.stepIds.push(e.stepId);
  }
  return [...byKey.values()];
}

/** 一行条目（不含任何 HTML/XML 标记）。三个出口共用同一句措辞，措辞漂移本身就是分叉 */
function lineOf(a: Advisory): string {
  const shown = a.stepIds.slice(0, MAX_STEP_IDS);
  const where = shown.length
    ? `（${shown.join('、')}${a.stepIds.length > shown.length ? ` …另有 ${a.stepIds.length - shown.length} 处` : ''}）`
    : '';
  // ×N 只在**真的重复**时出现：一次的事件标 ×1 会让人以为"这里有个计数器在聚合"，
  // 从而怀疑还有别的没显示
  const times = a.count > 1 ? ` ×${a.count}` : '';
  const only = a.reportOnly ? '（只上报，不计红绿）' : '';
  return `${a.code}${times}${only}${where}${a.detail ? ` —— ${a.detail}` : ''}`;
}

/** 截断标记。两个出口都要用，所以在这里给一句而不是各写一遍 */
export const ADVISORY_MORE_PREFIX = '…另有 ';
export const ADVISORY_MORE_SUFFIX = ' 类提醒未列出，全文在 trace.jsonl';

/**
 * 纯文本那一份（`summary.txt` 与 CLI 摘要）。
 *
 * **这里不脱敏**，看着像漏了、其实不是：detail 的脱敏发生在**序列化那一刻**
 * （`summaryText` 末尾的 `plainSafe`、html.ts 的 `esc`、report.ts 的 `xmlSafe`），
 * 而在**拼句子的这一层**再脱一次的问题是这一层的输出会被送进那三个出口，
 * 于是同一段文字过两遍规则。两遍是幂等的（`report-redaction.test.ts` 钉着），
 * 但幂等性是对脱敏实现的**假设**，把它当成正确性依赖就是欠债：
 * 将来谁往值形态规则表里加一条会命中占位符写法（`«…:已脱敏»`）的规则，
 * 二次脱敏就会产出套娃文本，而三个出口里只有两个会红。
 * 所以这里只排版，各出口自己脱。
 */
export function advisoriesText(list: readonly Advisory[]): string {
  const head = `运行期提醒（${list.length} 类，不影响红绿；每一条说的都是"结论有水分"或"某道闸压根没生效"）：`;
  const lines = list.slice(0, MAX_LINES).map((a) => `  ! ${lineOf(a)}`);
  if (list.length > MAX_LINES) lines.push(`  ${ADVISORY_MORE_PREFIX}${list.length - MAX_LINES}${ADVISORY_MORE_SUFFIX}`);
  return list.length ? [head, ...lines].join('\n') : '';
}

/** HTML 用的条目文本。**不做转义**：由 html.ts 的 esc 负责（那是唯一的转义出口） */
export function advisoryItems(list: readonly Advisory[]): Array<{ code: string; text: string }> {
  return list.slice(0, MAX_LINES).map((a) => ({ code: a.code, text: lineOf(a) }));
}

/** 提示带被截断时少掉了几类（HTML 侧要说明，理由同 advisoriesText） */
export const advisoriesHidden = (list: readonly Advisory[]): number => Math.max(0, list.length - MAX_LINES);

/**
 * JUnit 用的机器可读值：`code:次数` 的逗号清单。
 *
 * **这里按 code 再聚合一次**（与上面"按 code+detail 分行"相反），因为两个出口的
 * 消费者不同：页面上那一行要说得清**是哪几个**循环/接口（不同 detail 是不同的事实，
 * 合成一行就是少报），而 CI 侧拿 property 做的是"这类提醒有没有出现"的判断与聚合
 * —— 对它来说 `DEPRECATED_OPERATION` 出现 200 次就是这一个 code 出现 200 次，
 * 列 200 个同名条目会把一个本可以一行判掉的东西变成一份要解析的长表。
 *
 * 也不给 detail：一份是给机器的、一份是给人的，把散文塞进 XML 属性会得到
 * 一份既不好解析也不好读的东西。detail 要看去 trace.jsonl 或 report.html。
 */
export function advisoriesProperty(list: readonly Advisory[]): string {
  const byCode = new Map<string, number>();
  for (const a of list) byCode.set(a.code, (byCode.get(a.code) ?? 0) + a.count);
  // 顺序仍按**首次出现**（Map 的插入序），与页面上那份保持一致：
  // 两份产物里"第一个响的"是同一个 code，排查时才对得上
  return [...byCode].map(([code, n]) => `${code}:${n}`).join(',');
}

