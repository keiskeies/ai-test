// 展示层时间口径的单测（§3.4-6）。
//
// 这条测试存在的唯一理由：R68 之前全站把 ISO 串 `slice(0,19)` 截断当展示，
// 于是页面画的是 **UTC 钟点**，比真实时间早 8 小时，而当时 e2e 的断言是
// `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/` —— 形状对就绿，钟点错看不见。
// 所以这里必须钉住**具体钟点**：输入 UTC 03:24:05，只能得到东八区 11:24:05。
// 断言里任何一条退化成「形状对就行」，这条测试就失去意义（会变成第二个绿锁）。
import { describe, expect, it } from "vitest";
import { DISPLAY_TZ, fmtTime, parseUtc } from "./timefmt";

/** 独立实现的 UTC→东八区墙钟（固定 +08:00，Asia/Shanghai 无夏令时）。
 *  故意不复用 timefmt 里的 Intl：被测件与预期值不能共用同一条换算路径，
 *  否则换算整个写错时两边一起错，测试照样绿。 */
function shanghaiWallClock(iso: string): string {
  const d = new Date(iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z");
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

describe("fmtTime：UTC 存储 / Asia/Shanghai 展示", () => {
  it("带偏移的 UTC 时刻换算成东八区钟点（不是截断）", () => {
    // 这就是 R68 的实测数据：同一条 ISO，截断得 03:24:05，换算得 11:24:05
    expect(fmtTime("2026-11-15T03:24:05+00:00")).toBe("2026-11-15 11:24:05");
    expect(fmtTime("2026-11-15T03:24:05Z")).toBe("2026-11-15 11:24:05");
  });

  it("无偏移的裸串按 UTC 解释（库里存的就是 naive UTC）", () => {
    // ⚠ 更正这句旧注释：「现在的 emitter 都带 +00:00，这条兜的是**将来**」——**裸串现在是主路**，
    //   不是将来时。带不带偏移由**列**决定：`core/db.UtcDateTime` 读回挂 tzinfo=UTC（出 +00:00），
    //   裸 `DateTime` 读回 naive（出裸串）。实测见 backend/.tmp/timefmt/measure-offset.py。
    //   实测见 backend/.tmp/timefmt/measure-offset.py。**同一个 iso_dt 两种输出都发**
    //   （它只 `dt.isoformat()`，形状跟着喂进来的列走）：
    //     裸串 ← started_at / finished_at（execution/models.py 裸 DateTime）、RunArtifact.created_at；
    //     带偏移 ← workbench `recent edits` 的 `iso_dt(u)`，u 是 Scenario/UiCase.updated_at
    //              （TimestampMixin → UtcDateTime）。
    //   所以报告详情/工作台的 started_at/finished_at **一直**在走这条腿（不是"将来"），
    //   同一屏的 created_at 却仍带 +00:00 —— **两种形状并存**，见 timefmt.ts 文件头。
    // 谁改用裸 SQL 取时间列同理，少了这步浏览器按本地时区解析，又错 8 小时。
    expect(fmtTime("2026-11-15T03:24:05")).toBe("2026-11-15 11:24:05");
  });

  it("跨日：UTC 16:00 之后是东八区次日", () => {
    expect(fmtTime("2026-11-15T16:00:00Z")).toBe("2026-11-16 00:00:00");
    expect(fmtTime("2026-11-15T16:30:00Z")).toBe("2026-11-16 00:30:00");
  });

  it("午夜折回 00 而不是 24", () => {
    expect(fmtTime("2026-11-15T16:00:00Z")).toContain(" 00:00:00");
    expect(fmtTime("2026-11-15T16:00:00Z")).not.toContain("24:");
  });

  it("seconds=false 出分钟级（场景列表列宽装不下秒）", () => {
    expect(fmtTime("2026-11-15T03:24:05+00:00", { seconds: false })).toBe("2026-11-15 11:24");
  });

  it("与独立换算逐条一致（随机时刻也不许漂）", () => {
    for (let i = 0; i < 200; i += 1) {
      const iso = new Date(1_700_000_000_000 + i * 7_331_000).toISOString();
      expect(fmtTime(iso)).toBe(shanghaiWallClock(iso));
    }
  });

  it("空值与脏数据返回 null，绝不编造一个时刻", () => {
    expect(fmtTime(null)).toBeNull();
    expect(fmtTime(undefined)).toBeNull();
    expect(fmtTime("")).toBeNull();
    expect(fmtTime("not-a-date")).toBeNull();
    // 后端列可空（如 started_at 在 queued 期为 NULL），前端必须画「—」而不是 1970-01-01
    expect(fmtTime(null) ?? "—").toBe("—");
  });

  it("亚秒与微秒不炸（MySQL DATETIME(0) 截到秒，但 API 层不保证）", () => {
    expect(fmtTime("2026-11-15T03:24:05.123456+00:00")).toBe("2026-11-15 11:24:05");
    expect(fmtTime("2026-11-15T03:24:05.999Z")).toBe("2026-11-15 11:24:05");
  });

  it("展示时区是蓝图写死的 Asia/Shanghai", () => {
    expect(DISPLAY_TZ).toBe("Asia/Shanghai");
  });
});

describe("parseUtc", () => {
  it("naive 与带偏移两种口径落到同一个瞬间", () => {
    expect(parseUtc("2026-11-15T03:24:05")?.getTime())
      .toBe(parseUtc("2026-11-15T03:24:05+00:00")?.getTime());
  });

  it("明确带偏移的串不被改写", () => {
    // 带 -08:00 的串若被误加 Z，会错 8 小时
    expect(parseUtc("2026-11-15T03:24:05-08:00")?.getTime())
      .toBe(parseUtc("2026-11-15T11:24:05Z")?.getTime());
  });

  it("脏串返回 null 而不是 Invalid Date", () => {
    expect(parseUtc("abc")).toBeNull();
    expect(parseUtc("   ")).toBeNull();
  });
});
