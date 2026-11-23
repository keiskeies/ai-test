// 环境组 + 公共脚本前端镜像（D200 / C1+C2）。
import { get, patch, post } from "./client";

export type EnvBrief = { id: string; name: string };
export type EnvGroup = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  envs: EnvBrief[];
  created_at: string | null;
  updated_at: string | null;
};
export type ScriptRow = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  language: "python" | "javascript" | "groovy" | "shell";
  content: string;
  enabled: boolean;
  version: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function qs(q: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

const enc = encodeURIComponent;

export const projectAssetsApi = {
  // D249：filter 是环境组高级搜索条件 JSON 串（空 = 不传）。
  envGroups: (projectId: string, filter?: string) =>
    get<{ items: EnvGroup[] }>("/env-groups" + qs({ project_id: projectId, filter })),
  createEnvGroup: (body: { project_id: string; name: string; description?: string | null;
                           env_ids?: string[] }) =>
    post<EnvGroup>("/env-groups", body),
  updateEnvGroup: (id: string, body: { project_id: string; name?: string;
                                       description?: string | null; env_ids?: string[] }) =>
    patch<EnvGroup>("/env-groups/" + enc(id), body),
  deleteEnvGroup: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/env-groups/" + enc(id) + "/delete",
      { project_id: projectId, group_id: id }),

  // D250：filter 是高级搜索条件 JSON 串（空 = 不传），与 keyword 快轴并行。
  scripts: (projectId: string, opts: { keyword?: string; filter?: string } = {}) =>
    get<{ items: ScriptRow[] }>("/public-scripts" + qs({ project_id: projectId, ...opts })),
  createScript: (body: { project_id: string; name: string; description?: string | null;
                         language?: string; content: string; enabled?: boolean }) =>
    post<ScriptRow>("/public-scripts", body),
  updateScript: (id: string, body: { project_id: string; name?: string;
                                     description?: string | null; language?: string;
                                     content?: string; enabled?: boolean }) =>
    patch<ScriptRow>("/public-scripts/" + enc(id), { ...body, script_id: id }),
  deleteScript: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/public-scripts/" + enc(id) + "/delete",
      { project_id: projectId, script_id: id }),
};
