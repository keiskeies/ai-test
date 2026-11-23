// 分享链接前端镜像（D202）。
import { ApiErr, get, post } from "./client";

export type ShareLink = {
  id: string;
  token: string;
  share_path: string;
  target_type: "report" | "plan_report" | "api_doc";
  target_id: string;
  title: string;
  has_password: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string | null;
};

export type SharePayload = {
  type: "report" | "plan_report" | "api_doc";
  title: string;
  report?: Record<string, unknown>;
  definition?: Record<string, unknown>;
};

export const shareApi = {
  create: (body: { project_id: string; target_type: string; target_id: string;
                   title?: string; password?: string; expires_at?: string | null }) =>
    post<ShareLink>("/share-links", body),
  list: (projectId: string, targetType: string, targetId: string) =>
    get<{ items: ShareLink[] }>("/share-links?project_id=" + encodeURIComponent(projectId)
      + "&target_type=" + encodeURIComponent(targetType) + "&target_id=" + encodeURIComponent(targetId)),
  revoke: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/share-links/" + encodeURIComponent(id) + "/revoke",
      { project_id: projectId, share_id: id }),
  // 公开读走裸 fetch：client.ts 的 401 会触发登出跳转，而「分享要密码」正是 401。
  publicGet: async (token: string, password?: string): Promise<SharePayload> => {
    const res = await fetch("/api/v1/share/" + encodeURIComponent(token)
      + (password ? "?password=" + encodeURIComponent(password) : ""));
    const body = await res.json().catch(() => null) as
      (SharePayload & { code?: string; message?: string; details?: unknown }) | null;
    if (!res.ok) {
      throw new ApiErr(body?.code ?? "http_" + res.status, body?.message ?? "分享读取失败",
        res.status, body?.details);
    }
    return body as SharePayload;
  },
};

/** 分享 URL：前端是 hash 路由，orchestrator 返回的是后端路径，页面地址得带 `#`。 */
export function shareUrl(token: string): string {
  return window.location.origin + "/#/share/" + encodeURIComponent(token);
}
