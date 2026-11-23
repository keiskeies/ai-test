// 个人中心 / API Key 前端镜像（D198）。
import { get, patch, post } from "./client";

export type Profile = {
  id: string;
  account: string;
  name: string;
  email: string | null;
  is_system_admin: boolean;
  prefs: Record<string, unknown>;
  created_at: string | null;
};

export type RecentProject = { id: string; name: string; role_code: string; updated_at: string | null };
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};
export type ApiKeyCreated = ApiKey & { key: string };

export const personalApi = {
  profile: () => get<Profile>("/personal/profile"),
  updateProfile: (body: { name?: string; email?: string | null; prefs?: Record<string, unknown> }) =>
    patch<Profile>("/personal/profile", body),
  recentProjects: () => get<{ items: RecentProject[] }>("/personal/recent-projects"),
  myAssets: () => get<{ counts: Record<string, number> }>("/personal/my-assets"),
  keys: () => get<{ items: ApiKey[] }>("/personal/api-keys"),
  createKey: (body: { name: string; expires_at?: string | null }) =>
    post<ApiKeyCreated>("/personal/api-keys", body),
  revokeKey: (id: string) =>
    post<{ ok: boolean }>("/personal/api-keys/" + encodeURIComponent(id) + "/revoke", { key_id: id }),
};

export const ASSET_LABELS: Record<string, string> = {
  api_definitions: "接口",
  api_cases: "接口用例",
  scenarios: "场景",
  ui_cases: "UI 用例",
  adb_cases: "ADB 用例",
  functional_cases: "功能用例",
  defects: "缺陷",
};

export const ROLE_LABELS: Record<string, string> = {
  SYSTEM_ADMIN: "系统管理员",
  PROJECT_ADMIN: "项目管理员",
  MEMBER: "测试工程师",
  READONLY: "只读",
};
