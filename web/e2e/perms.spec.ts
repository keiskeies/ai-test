// 权限模式串单测：钉死与后端 match_perm 同语义（拒绝优先 / 三段通配 / 角色模板）。
import { test, expect } from "@playwright/test";
import { can, matchPerm, patternsForProject, patternsForRole, ROLE_PATTERNS } from "../src/auth/perms";

test("拒绝优先：MEMBER 有 * 但无删除/管理", () => {
  const m = ROLE_PATTERNS.MEMBER;
  expect(can(m, "api:def:create")).toBe(true);
  expect(can(m, "api:def:read")).toBe(true);
  expect(can(m, "api:def:delete")).toBe(false);
  expect(can(m, "api:module:delete")).toBe(false);
  expect(can(m, "system:user:create")).toBe(false);
  expect(can(m, "api:def:manage")).toBe(false);
});

test("只读只见读；项目管理员可管不可碰系统", () => {
  expect(can(ROLE_PATTERNS.READONLY, "api:def:read")).toBe(true);
  expect(can(ROLE_PATTERNS.READONLY, "api:def:create")).toBe(false);
  expect(can(ROLE_PATTERNS.PROJECT_ADMIN, "api:def:delete")).toBe(true);
  expect(can(ROLE_PATTERNS.PROJECT_ADMIN, "system:user:create")).toBe(false);
  expect(can(ROLE_PATTERNS.SYSTEM_ADMIN, "system:user:create")).toBe(true);
});

test("matchPerm 边界：空集合全拒；前缀/后缀通配；无权限位默认拒", () => {
  expect(matchPerm([], "*")).toBe(false);
  expect(can(undefined, "api:def:read")).toBe(false);
  expect(matchPerm(["api:*"], "api:def:read")).toBe(true);
  expect(matchPerm(["api:*"], "api_test:def:read")).toBe(false);
  expect(matchPerm(["*:read"], "auth:password:self")).toBe(false);
  // READONLY 必须自带 -system:*：单看 "*:read" 这条后缀通配会顺手盖住
  // system:user:read / system:audit:read（R30 泄漏），拒绝项才是止血的地方。
  expect(can(ROLE_PATTERNS.READONLY, "system:user:read")).toBe(false);
  expect(can(ROLE_PATTERNS.READONLY, "system:audit:read")).toBe(false);
  expect(patternsForRole("READONLY", false)).toContain("-system:*");
  expect(patternsForRole("READONLY", true)).toEqual(["*"]);
  // 未知角色（自定义模板）在前端没有兜底表 → 空集合，只渲染只读外壳
  expect(patternsForRole("QA_JUNIOR", false)).toEqual([]);
});

test("生效权限以服务端下发的 my_perms 为准（前端不许猜自定义角色）", () => {
  // 与后端真实词表同形（三段：域:资源:动作），自定义模板只会给出更窄的读位
  const proj = { my_role: "QA_JUNIOR", my_perms: ["api:def:read", "api:run:read", "-system:*"] };
  const p = patternsForProject(proj, false);
  expect(p).toEqual(proj.my_perms);
  expect(can(p, "api:def:read")).toBe(true);
  expect(can(p, "env:config:read")).toBe(false);   // 模板没给就是没有，不继承任何默认读
  expect(can(p, "system:audit:read")).toBe(false);  // 平台口一律拒绝
  // 系统管理员无视项目角色
  expect(patternsForProject(proj, true)).toEqual(["*"]);
  // 旧快照没有 my_perms → 退回内置表，不至于把所有按钮藏光
  expect(patternsForProject({ my_role: "PROJECT_ADMIN" }, false)).toContain("-system:*");
  expect(can(patternsForProject({ my_role: "PROJECT_ADMIN" }, false), "api:def:delete")).toBe(true);
  expect(patternsForProject(null, false)).toEqual([]);
});
