// 平台运维前端镜像（D203）：服务集成 / 资源池 / 插件登记。
import { get, patch, post } from "./client";

export type Integration = {
  id: string; project_id: string; kind: string; name: string; base_url: string;
  has_token: boolean; token_hint: string | null; description: string | null;
  enabled: boolean; created_by: string | null; created_at: string | null; updated_at: string | null;
};
export type Pool = {
  id: string; project_id: string; name: string; kind: string; description: string | null;
  capacity: number; enabled: boolean; created_by: string | null;
  created_at: string | null; updated_at: string | null;
};
export type Plugin = {
  id: string; project_id: string; name: string; kind: string; version: string;
  description: string | null; config: string; enabled: boolean; loadable: boolean;
  created_by: string | null; created_at: string | null; updated_at: string | null;
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

export const platformOpsApi = {
  // 服务集成
  integrationMeta: (projectId: string) =>
    get<{ kinds: string[] }>("/service-integrations/meta" + qs({ project_id: projectId })),
  integrations: (projectId: string, keyword?: string, enabledOnly?: boolean) =>
    get<{ items: Integration[] }>("/service-integrations" + qs({
      project_id: projectId, keyword, enabled_only: enabledOnly || undefined })),
  createIntegration: (body: {
    project_id: string; kind: string; name: string; base_url: string;
    token?: string | null; description?: string | null; enabled?: boolean;
  }) => post<Integration>("/service-integrations", body),
  updateIntegration: (projectId: string, id: string, body: {
    name?: string; base_url?: string; token?: string; description?: string | null; enabled?: boolean;
  }) => patch<Integration>("/service-integrations/" + enc(id), { project_id: projectId, ...body }),
  deleteIntegration: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/service-integrations/" + enc(id) + "/delete",
      { project_id: projectId, integration_id: id }),
  setIntegrationStatus: (projectId: string, id: string, enabled: boolean) =>
    post<Integration>("/service-integrations/" + enc(id) + "/status",
      { project_id: projectId, integration_id: id, enabled }),

  // 资源池
  pools: (projectId: string, keyword?: string, enabledOnly?: boolean) =>
    get<{ items: Pool[] }>("/resource-pools" + qs({
      project_id: projectId, keyword, enabled_only: enabledOnly || undefined })),
  createPool: (body: {
    project_id: string; name: string; kind?: string; description?: string | null;
    capacity?: number; enabled?: boolean;
  }) => post<Pool>("/resource-pools", body),
  updatePool: (projectId: string, id: string, body: {
    name?: string; kind?: string; description?: string | null; capacity?: number; enabled?: boolean;
  }) => patch<Pool>("/resource-pools/" + enc(id), { project_id: projectId, ...body }),
  deletePool: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/resource-pools/" + enc(id) + "/delete",
      { project_id: projectId, pool_id: id }),

  // 插件
  pluginMeta: (projectId: string) =>
    get<{ kinds: string[]; note: string }>("/plugins/meta" + qs({ project_id: projectId })),
  plugins: (projectId: string, keyword?: string, enabledOnly?: boolean) =>
    get<{ items: Plugin[] }>("/plugins" + qs({
      project_id: projectId, keyword, enabled_only: enabledOnly || undefined })),
  createPlugin: (body: {
    project_id: string; name: string; kind?: string; version?: string;
    description?: string | null; config?: string; enabled?: boolean;
  }) => post<Plugin>("/plugins", body),
  updatePlugin: (projectId: string, id: string, body: {
    name?: string; kind?: string; version?: string; description?: string | null;
    config?: string; enabled?: boolean;
  }) => patch<Plugin>("/plugins/" + enc(id), { project_id: projectId, ...body }),
  deletePlugin: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/plugins/" + enc(id) + "/delete",
      { project_id: projectId, plugin_id: id }),
  setPluginStatus: (projectId: string, id: string, enabled: boolean) =>
    post<Plugin>("/plugins/" + enc(id) + "/status",
      { project_id: projectId, plugin_id: id, enabled }),
};
