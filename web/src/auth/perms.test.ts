// isReadOnlyPatterns 单测（§11.5.1 只读横幅的唯一信号）。
// 这个谓词只决定一条提示横幅的显隐，判错的代价是「多/少一句提示」，
// 但判歪的形态必须逐个钉死：把缺某一位写权限的 MEMBER 说成只读、或把真只读说成可写，
// 都是对用户撒谎（§13 纪律 1）。
import { describe, expect, it } from "vitest";
import { ROLE_PATTERNS, isReadOnlyPatterns } from "./perms";

describe("isReadOnlyPatterns（只读横幅信号）", () => {
  it("READONLY 内置模式 [\"*:read\",\"-system:*\"] → 只读", () => {
    expect(isReadOnlyPatterns(ROLE_PATTERNS.READONLY)).toBe(true);
  });

  it("自定义角色只给精确读位 → 只读", () => {
    expect(isReadOnlyPatterns(["api:def:read", "api:case:read", "env:config:read"])).toBe(true);
  });

  it("[\"*\"] → 非只读（全通配必含写）", () => {
    expect(isReadOnlyPatterns(["*"])).toBe(false);
  });

  it("[\"*\",\"-system:*\"]（PROJECT_ADMIN）→ 非只读：拒绝条目不抹掉 * 的写入能力", () => {
    expect(isReadOnlyPatterns(ROLE_PATTERNS.PROJECT_ADMIN)).toBe(false);
  });

  it("MEMBER 内置模式 → 非只读：缺 delete/manage 不等于没有任何写权限", () => {
    // 这条就是「拿单个权限位反推只读」会翻车的现场：MEMBER 没有 api:def:delete，
    // 但它 api:def:create/update 齐全。
    expect(isReadOnlyPatterns(ROLE_PATTERNS.MEMBER)).toBe(false);
  });

  it("单个写位挂在读位旁边 → 非只读（精确 create/update/run/debug 各验一型）", () => {
    expect(isReadOnlyPatterns(["*:read", "api:def:create"])).toBe(false);
    expect(isReadOnlyPatterns(["*:read", "api:def:update"])).toBe(false);
    expect(isReadOnlyPatterns(["*:read", "api:debug:run"])).toBe(false);
    expect(isReadOnlyPatterns(["*:read", "project:member:manage"])).toBe(false);
  });

  it("disable 是写：R158 实测抓到第一版词表漏了 system:user:disable", () => {
    expect(isReadOnlyPatterns(["*:read", "system:user:disable"])).toBe(false);
  });

  it("前缀通配 x:* 与 *:动词 后缀通配按语义判定", () => {
    expect(isReadOnlyPatterns(["api:def:*"])).toBe(false); // 必含 create
    expect(isReadOnlyPatterns(["*:update"])).toBe(false);  // 后缀通配命中 update
    expect(isReadOnlyPatterns(["*:read"])).toBe(true);     // 后缀通配只读
  });

  it("空数组 / undefined → 非只读：patternsForProject 对未知角色的空兜底是「无情报」不是「查过确实读」", () => {
    expect(isReadOnlyPatterns([])).toBe(false);
    expect(isReadOnlyPatterns(undefined)).toBe(false);
  });
});
