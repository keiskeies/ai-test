// 展示层时间口径（蓝图 §3.4-6：时刻一律 **UTC 存储，展示层 Asia/Shanghai**）。
//
// 为什么单独一个文件：这个换算在 1B 之前根本不存在——runs / scenes / 审计三个页面各自
// 把 ISO 字符串 `replace("T"," ").slice(0,19)` 截断就完事，于是**全站显示的时间比真实
// 时间早 8 小时**（ledger R68，实测：同一条 ISO 截断得 03:24:05，换算得 11:24:05）。
// 形状正则的 e2e 断言（`/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/`）对此完全无感，
// 所以这是「绿的，但是错的」的典型形状。换算收口在这里，页面不许再各写一套。
//
// 入参口径：后端**两种 emitter，输出形状不同**，前端必须两种都吃：
//   ① `scenario/services._iso` 显式补偏移 → 永远带 `+00:00`（它 docstring 自己就是这么要求的）；
//   ② `execution/timefmt.iso_dt` 是裸 `dt.isoformat()` → **偏移取决于喂进来的那一列**。
// ⚠ 此处原先写「实测两者的输出**都带** `+00:00`」——**过度泛化，实测不成立**
//   （`backend/.tmp/timefmt/measure-offset.py`，:memory: SQLite，一跑就出）：
//   带不带偏移由**列上有没有挂 `core/db.UtcDateTime`** 决定，而不是由 emitter 决定 ——
//   `UtcDateTime.process_result_value` 读回时 attach tzinfo=UTC，裸 `DateTime` 读回 naive。
//   于是**同一行数据里两种形状并存**：`RunRecord.created_at`（TimestampMixin→UtcDateTime）
//   出 `...T03:24:05+00:00`，而 `started_at`/`finished_at`（models.py 裸 DateTime）出裸串；
//   `iso_dt` 自己**两种都发**（它只 `dt.isoformat()`，形状跟着列走）：报告详情/工作台/运行列表
//   的 started_at、finished_at 与 RunArtifact.created_at 是裸列 → 裸串；workbench
//   「我最近编辑」的 `iso_dt(u)` 喂的是 Scenario/UiCase.updated_at（TimestampMixin）→ 带偏移。
//   **报告详情页那个 fixture 此前手写 `+00:00`，恰好把这条遮住了**——已在
//   reportDetail.test.tsx 就地更正为裸串（期望显示不变，变的只是"后端发的是什么"）。
// 那「没有偏移」的兜底分支还有必要吗？**比原先以为的更是主路**：裸列这一路现在天天在跑，
// 不是"将来谁改用裸 SQL 才会遇到"。它仍不是正确性的唯一支点，而是**口径的唯一收口**：
// 库里存的确实是 naive UTC，裸 SQL / 列元组取时间（`list_projects` 就是那种写法）、
// 或后端谁把 TypeDecorator 换掉，拿回来的同样是裸串——到了前端 `new Date()`
// 会按**本地时区**解析，UTC 的 03:24 被当成东八区的 03:24，又是错的 8 小时。
// 在一个函数里兜住，好过在某个字段上静默少个 `+00:00`。

/** 展示时区：蓝图写死 Asia/Shanghai（一期不做 i18n，§3.4-6 同条）。 */
export const DISPLAY_TZ = "Asia/Shanghai";

const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** ISO（带或不带偏移）→ Date；无偏移按 UTC（见文件头口径说明）。 */
export function parseUtc(iso: string): Date | null {
  const s = iso.trim();
  if (!s) return null;
  const d = new Date(OFFSET.test(s) ? s : s + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 展示用时刻。`seconds=false` 出 `2026-11-15 11:24`（列表列宽装不下秒时用），
 * 默认出 `2026-11-15 11:24:05`。空/非法 → null（调用方画「—」，**不要**画一个假时刻）。
 */
export function fmtTime(iso: string | null | undefined, opts: { seconds?: boolean } = {}): string | null {
  if (!iso) return null;
  const d = parseUtc(iso);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: DISPLAY_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", ...(opts.seconds === false ? {} : { second: "2-digit" }),
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // hour12:false 在 zh-CN 下可能给 "24"（午夜），统一折回 "00"，免得出现 24:05 这种读不懂的值
  const hh = get("hour") === "24" ? "00" : get("hour");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const clock = `${hh}:${get("minute")}${opts.seconds === false ? "" : `:${get("second")}`}`;
  return `${date} ${clock}`;
}
