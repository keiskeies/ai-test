// 角色生码 → 中文名（唯一一份）。
//
// 为什么要有这个文件：`project.my_role` 是后端发来的**生码**（SYSTEM_ADMIN / PROJECT_ADMIN /
// MEMBER / READONLY，见 auth/perms.ts 的 ROLE_PATTERNS），而界面上写字的地方至少两处
// ——工作台「我的角色」与系统设置抬头。此前只有工作台本地抄了一张表，设置页直接把
// `PROJECT_ADMIN` 这种生码摊给业主读；再各抄一份就是第三份会漂移的词表。
//
// 口径与 workbench 的旧表逐字一致（改词要一起改，别让两个页面说两种名字）。
// 查不到的生码**原样返回**：那是后端加了一个前端还不认识的角色，把它翻译成
// 「未知角色」等于把没见过的说成见过的（runVocab.ts 记过这笔账）；原样露生码
// 虽然不好读，但它至少是真的，而且一眼能看出「前端还没跟上」。
export const ROLE_NAMES: Record<string, string> = {
  SYSTEM_ADMIN: "系统管理员",
  PROJECT_ADMIN: "项目管理员",
  MEMBER: "测试工程师",
  READONLY: "只读",
};

/** 生码 → 中文名；查不到时返回生码本身（不许编一个友好词顶上）。 */
export function roleLabel(code: string | null | undefined): string {
  if (!code) return "";
  return ROLE_NAMES[code] ?? code;
}