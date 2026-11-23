// API Mock 前端镜像（D201）。
import { get, patch, post } from "./client";

export type MockService = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rule_count: number;
  mock_base: string;
  created_at: string | null;
  updated_at: string | null;
};

export type MockRule = {
  id: string;
  project_id: string;
  service_id: string;
  name: string;
  method: string;
  path: string;
  match_type: "exact" | "prefix" | "regex";
  status_code: number;
  headers: Record<string, string> | null;
  body: string | null;
  delay_ms: number;
  priority: number;
  enabled: boolean;
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

export type RuleBody = {
  project_id: string;
  service_id: string;
  name: string;
  method: string;
  path: string;
  match_type: string;
  status_code: number;
  headers?: Record<string, string> | null;
  body?: string | null;
  delay_ms?: number;
  priority?: number;
  enabled?: boolean;
};

export const mockApi = {
  services: (projectId: string) =>
    get<{ items: MockService[] }>("/mock-services" + qs({ project_id: projectId })),
  createService: (body: { project_id: string; name: string; description?: string | null;
                          enabled?: boolean }) =>
    post<MockService>("/mock-services", body),
  updateService: (id: string, body: { project_id: string; name?: string;
                                      description?: string | null; enabled?: boolean }) =>
    patch<MockService>("/mock-services/" + enc(id), { ...body, service_id: id }),
  deleteService: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/mock-services/" + enc(id) + "/delete",
      { project_id: projectId, service_id: id }),

  rules: (projectId: string, serviceId: string, filter?: string) =>
    get<{ items: MockRule[] }>("/mock-services/" + enc(serviceId) + "/rules"
      + qs({ project_id: projectId, filter })),
  createRule: (body: RuleBody) => post<MockRule>("/mock-rules", body),
  updateRule: (id: string, projectId: string, body: Partial<RuleBody>) =>
    patch<MockRule>("/mock-rules/" + enc(id), { ...body, project_id: projectId, rule_id: id }),
  deleteRule: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/mock-rules/" + enc(id) + "/delete",
      { project_id: projectId, rule_id: id }),
  testRule: (projectId: string, serviceId: string, method: string, path: string) =>
    post<{ matched: boolean; rule: MockRule | null }>("/mock-rules/test",
      { project_id: projectId, service_id: serviceId, method, path }),
};
