// 组织层 API（D269/D270）。组织是管理与分组层：这些口不进项目作用域，读接口也用 POST
// （后端 dynamic_perm：授权按「是否为该组织成员/管理员/组权限持有者」在体内判定）。
import { post } from "./client";

/** 组织管理位（逐字对齐后端 ORG_GROUP_PERMS；顺序也一致，便于比对）。 */
export const ORG_CAP = {
  update: "system:org:update",
  member: "system:org:member:manage",
  project: "system:org:project:manage",
  group: "system:org:group:manage",
  defect: "system:org:defect:manage",
} as const;

/** 用户组可勾选的管理位（界面文案；值必须与后端白名单一致，否则 422）。 */
export const ORG_CAP_OPTIONS: { value: string; label: string }[] = [
  { value: ORG_CAP.update, label: "改组织资料" },
  { value: ORG_CAP.member, label: "管组织成员" },
  { value: ORG_CAP.project, label: "管项目归属" },
  { value: ORG_CAP.group, label: "管用户组" },
  { value: ORG_CAP.defect, label: "管缺陷状态流" },
];

export function hasCap(org: Pick<OrgItem, "my_perms">, cap: string): boolean {
  return (org.my_perms ?? []).includes(cap);
}

export interface OrgItem {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: string;
  member_count: number;
  project_count: number;
  my_role: string | null;
  /** 我在本组织实际持有的管理位（D270；系统管理员/ORG_ADMIN 为全部五枚）。 */
  my_perms: string[];
  created_at: string | null;
}

export interface OrgGroupRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  perms: string[];
  member_count: number;
  created_at: string | null;
}

export interface OrgGroupMemberRow {
  id: string;
  group_id: string;
  user_id: string;
  account: string | null;
  name: string | null;
}

export interface OrgMemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role_code: string;
  account: string | null;
  name: string | null;
}

export interface OrgProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

export interface OrgPayload {
  name: string;
  code: string;
  description?: string | null;
}

export const orgApi = {
  list: (q = "") => post<{ items: OrgItem[] }>("/system/orgs/query", { q }),
  get: (orgId: string) => post<OrgItem>("/system/orgs/get", { org_id: orgId }),
  create: (body: OrgPayload) => post<OrgItem>("/system/orgs", body),
  update: (orgId: string, body: { name?: string; description?: string | null; status?: string }) =>
    post<OrgItem>("/system/orgs/update", { org_id: orgId, ...body }),
  remove: (orgId: string) => post<{ ok: boolean }>("/system/orgs/delete", { org_id: orgId }),
  members: (orgId: string) =>
    post<{ items: OrgMemberRow[] }>("/system/orgs/members/query", { org_id: orgId }),
  setMember: (orgId: string, account: string, roleCode: string) =>
    post<OrgMemberRow>("/system/orgs/members/set", { org_id: orgId, account, role_code: roleCode }),
  removeMember: (orgId: string, userId: string) =>
    post<{ ok: boolean }>("/system/orgs/members/remove", { org_id: orgId, user_id: userId }),
  projects: (orgId: string) =>
    post<{ items: OrgProjectRow[] }>("/system/orgs/projects/query", { org_id: orgId }),
  assignProject: (orgId: string, projectId: string) =>
    post<OrgProjectRow>("/system/orgs/projects/assign", { org_id: orgId, target_project_id: projectId }),
  unassignProject: (orgId: string, projectId: string) =>
    post<{ ok: boolean }>("/system/orgs/projects/remove", { org_id: orgId, target_project_id: projectId }),
  // D270 组织级用户组：组 = 一份组织管理权限集（不扩大项目数据权限）。
  groups: (orgId: string) =>
    post<{ items: OrgGroupRow[] }>("/system/orgs/groups/query", { org_id: orgId }),
  createGroup: (orgId: string, name: string, perms: string[], description?: string | null) =>
    post<OrgGroupRow>("/system/orgs/groups", { org_id: orgId, name, perms, description }),
  updateGroup: (groupId: string, body: {
    name?: string; description?: string | null; perms?: string[];
  }) => post<OrgGroupRow>("/system/orgs/groups/update", { group_id: groupId, ...body }),
  removeGroup: (groupId: string) =>
    post<{ ok: boolean }>("/system/orgs/groups/delete", { group_id: groupId }),
  groupMembers: (groupId: string) =>
    post<{ items: OrgGroupMemberRow[] }>("/system/orgs/groups/members/query", { group_id: groupId }),
  addGroupMember: (groupId: string, account: string) =>
    post<OrgGroupMemberRow>("/system/orgs/groups/members/set", { group_id: groupId, account }),
  removeGroupMember: (groupId: string, userId: string) =>
    post<{ ok: boolean }>("/system/orgs/groups/members/remove",
      { group_id: groupId, user_id: userId }),
};
