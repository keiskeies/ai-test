// 项目设置前端镜像（D199）：应用开关 + 误报库。
import { get, patch, post } from "./client";

export type ApplicationItem = {
  key: string;
  group: string;
  label: string;
  description: string;
  default: boolean;
  enabled: boolean;
};

export type FakeErrorRule = {
  id: string;
  project_id: string;
  name: string;
  pattern: string;
  match_type: "contains" | "regex" | "exact";
  description: string | null;
  enabled: boolean;
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

export const projectSettingsApi = {
  applications: (projectId: string) =>
    get<{ items: ApplicationItem[] }>("/project-applications" + qs({ project_id: projectId })),
  updateApplication: (projectId: string, key: string, enabled: boolean) =>
    patch<ApplicationItem>("/project-applications/" + enc(key),
      { project_id: projectId, key, enabled }),

  fakeErrors: (projectId: string, keyword?: string, enabledOnly?: boolean) =>
    get<{ items: FakeErrorRule[] }>("/fake-errors" + qs({
      project_id: projectId, keyword, enabled_only: enabledOnly || undefined })),
  createFakeError: (body: { project_id: string; name: string; pattern: string;
                            match_type: string; description?: string | null; enabled?: boolean }) =>
    post<FakeErrorRule>("/fake-errors", body),
  updateFakeError: (projectId: string, id: string, body: {
    name?: string; pattern?: string; match_type?: string; description?: string | null;
    enabled?: boolean;
  }) => patch<FakeErrorRule>("/fake-errors/" + enc(id), { project_id: projectId, rule_id: id, ...body }),
  deleteFakeError: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/fake-errors/" + enc(id) + "/delete",
      { project_id: projectId, rule_id: id }),
};
