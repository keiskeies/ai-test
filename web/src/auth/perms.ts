// 前端权限渲染（§10.1）：与后端 app/core/permissions.py match_perm 逐语义对齐。
// 仅用于按钮/菜单显隐——真正的门禁永远在后端；这里做少了是体验问题，做多了也不会越权。

function matchOne(pattern: string, perm: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return perm.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*:")) return perm.endsWith(pattern.slice(1));
  return pattern === perm;
}

export function matchPerm(patterns: string[], perm: string): boolean {
  for (const p of patterns) {
    if (p.startsWith("-") && matchOne(p.slice(1), perm)) return false; // 显式拒绝优先
  }
  return patterns.some((p) => !p.startsWith("-") && matchOne(p, perm));
}

// 内置角色的兜底表：仅在服务端没随项目下发 my_perms 时用（例如 localStorage 里存的是
// 升级前的旧快照）。正常路径见 patternsForProject —— 角色模板可编辑，前端不许猜。
// READONLY 的 `-system:*` 是 R30 第二半：`*:read` 后缀通配会顺手盖住 system:user:read，
// 与后端 iam/project_services.PLATFORM_DENY 保持同一条拒绝。
export const ROLE_PATTERNS: Record<string, string[]> = {
  SYSTEM_ADMIN: ["*"],
  PROJECT_ADMIN: ["*", "-system:*"],
  // D102：MEMBER 的 `-*:delete/-*:manage` 罩不住 `agent:full:use`（尾词不在其列），
  // `-agent:full:*` 与后端 iam/roles.BUILTIN_ROLES 的 MEMBER 行逐字同步——兜底表
  // 比生产表宽一个位，就是让 MEMBER 在本机旧快照下多看见一个按不动的模式档。
  MEMBER: ["*", "-*:delete", "-*:manage", "-system:*", "-agent:full:*"],
  READONLY: ["*:read", "-system:*"],
};

export function can(patterns: string[] | undefined, perm: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return matchPerm(patterns, perm);
}

export function patternsForRole(role: string | undefined, isSystemAdmin: boolean | undefined): string[] {
  if (isSystemAdmin) return ROLE_PATTERNS.SYSTEM_ADMIN;
  return ROLE_PATTERNS[role ?? ""] ?? [];
}

/** 当前项目的生效权限模式：服务端 my_perms 优先，前端内置表只兜底。 */
export function patternsForProject(
  project: { my_role?: string | null; my_perms?: string[] | null } | null,
  isSystemAdmin: boolean | undefined,
): string[] {
  if (isSystemAdmin) return ROLE_PATTERNS.SYSTEM_ADMIN;
  if (project?.my_perms && project.my_perms.length > 0) return project.my_perms;
  return ROLE_PATTERNS[project?.my_role ?? ""] ?? [];
}

// 后端 effect 词表（写类的动词条尾）：词表本身由 backend/tests/test_r158_readonly_verb_drift.py
// 对着运行时 REGISTRY 钉住——后端新增一个写动词而这里没跟上，那条 pin 先红（实测抓到过漏
// `system:user:disable`）。`auth:password:self` 故意不在词表里：改自己密码与项目角色无关，
// 算进去等于把横幅废掉。已知宽判：`api:def:create` 同挂在只读服务上（api_import_preview），
// 持它的自定义角色会被判「可写」而少一条横幅——少一句提示不撒谎，把只读说成可写才是。
// D191：`comment` 是缺陷域新增的写动词（defect:defect:comment，effect=write）。
// 不进来就会把只挂评论位的自定义角色判成「只读」——后端 test_r158 的跨语言漂移钉会先红。
// D196：`stop` 是任务中心的写动词（task:center:stop）。
// D204：`execute` 是计划内功能用例的人工结论写动词（testplan:functional:execute）。
const WRITE_TAIL = /:(create|update|delete|run|debug|manage|write|disable|comment|stop|execute)$/;

/**
 * 「本项目无任何可写入口」（§11.5.1 只读横幅的唯一信号，不参与任何门禁）。
 * 不能拿单个权限位（如 api:def:update）反推只读——缺那一位的 MEMBER 会被误判；
 * 这里逐条看模式自身是否写得起：`*` / `x:*` 前缀通配必含 create，
 * 精确位与 `*:动词` 后缀通配按词尾判定。空/未定义是 patternsForProject 对
 * 未知角色的「无情报」兜底，不等于只读——诚实起见这时不横幅。
 * 已知局限：不建模「正通配 + 把每位写权限逐条 deny」的极端组合（真实角色表里
 * 不存在；真正的门禁永远在后端，这里只决定一条提示横幅的显隐）。
 */
export function isReadOnlyPatterns(patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return !patterns.some((p) => {
    if (p.startsWith("-")) return false; // 显式拒绝不贡献写入能力
    if (p === "*" || p.endsWith(":*")) return true;
    return WRITE_TAIL.test(p);
  });
}
