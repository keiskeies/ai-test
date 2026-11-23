// 文件库 / 附件前端镜像（D195）。上传/下载走独立 router（multipart / 字节流）。
import { get, patch, post } from "./client";
import { getToken } from "./client";

export type FolderNode = {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  status: string;
  file_count: number;
  children: FolderNode[];
};

export type FolderTree = { tree: FolderNode[]; recycled: FolderNode[] };

export type FileBlob = {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  original_name: string;
  created_at?: string | null;
};

export type FileEntry = {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  description: string | null;
  tags: string[];
  version: number;
  is_latest: boolean;
  recycled: boolean;
  blob: FileBlob;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string | null;
};

export type FilePage = { items: FileEntry[]; total: number | null };

export type Attachment = {
  id: string;
  target_type: "bug" | "functional_case";
  target_id: string;
  role: "attachment" | "richtext";
  display_name: string | null;
  blob: FileBlob;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string | null;
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

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const tok = getToken();
  const headers = new Headers(init.headers);
  if (tok) headers.set("Authorization", "Bearer " + tok);
  return fetch("/api/v1" + path, { ...init, headers, credentials: "include" });
}

export const fileApi = {
  folders: (projectId: string, includeRecycled = false) =>
    get<FolderTree>("/file-folders/tree" + qs({
      project_id: projectId, include_recycled: includeRecycled || undefined })),
  createFolder: (body: { project_id: string; parent_id?: string | null; name: string; sort?: number }) =>
    post<FolderNode>("/file-folders", body),
  updateFolder: (id: string, body: { project_id: string; name?: string; sort?: number;
                                      parent_id?: string | null; parent_set?: boolean }) =>
    patch<FolderNode>("/file-folders/" + enc(id), body),
  deleteFolder: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/file-folders/" + enc(id) + "/delete",
      { project_id: projectId, folder_id: id }),
  restoreFolder: (projectId: string, id: string) =>
    post<FolderNode>("/file-folders/" + enc(id) + "/restore",
      { project_id: projectId, folder_id: id }),
  purgeFolder: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean; purged_folders: number }>("/file-folders/" + enc(id) + "/purge",
      { project_id: projectId, folder_id: id, confirm_name: confirmName }),

  list: (q: { project_id: string; folder_id?: string; unfiled_only?: boolean;
              keyword?: string; recycled?: boolean;
              /** D222：高级搜索条件（JSON 串，形状见 backend shared/filter_registry） */
              filter?: string; current: number; size: number }) =>
    get<FilePage>("/files" + qs(q)),
  get: (projectId: string, id: string) =>
    get<FileEntry>("/files/" + enc(id) + qs({ project_id: projectId })),
  update: (id: string, body: { project_id: string; name?: string; description?: string | null;
                               tags?: string[]; folder_id?: string | null; folder_set?: boolean }) =>
    patch<FileEntry>("/files/" + enc(id), body),
  remove: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/files/" + enc(id) + "/delete", { project_id: projectId, file_id: id }),
  restore: (projectId: string, id: string) =>
    post<FileEntry>("/files/" + enc(id) + "/restore", { project_id: projectId, file_id: id }),
  purge: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean }>("/files/" + enc(id) + "/purge",
      { project_id: projectId, file_id: id, confirm_name: confirmName }),

  attachments: (projectId: string, targetType: "bug" | "functional_case", targetId: string,
                role: "attachment" | "richtext" = "attachment") =>
    get<{ items: Attachment[] }>("/attachments" + qs({
      project_id: projectId, target_type: targetType, target_id: targetId, role })),
  linkAttachments: (projectId: string, targetType: "bug" | "functional_case", targetId: string,
                    blobIds: string[], role: "attachment" | "richtext" = "attachment") =>
    post<{ created: number; skipped: number }>("/attachments",
      { project_id: projectId, target_type: targetType, target_id: targetId,
        blob_ids: blobIds, role }),
  unlinkAttachment: (projectId: string, linkId: string) =>
    post<{ ok: boolean }>("/attachments/" + enc(linkId) + "/delete",
      { project_id: projectId, link_id: linkId }),

  /** 仓库上传（multipart，浏览器自己带 boundary，绝不手填 Content-Type）。 */
  upload: async (projectId: string, file: File, folderId?: string | null, name?: string): Promise<FileEntry> => {
    const fd = new FormData();
    fd.append("project_id", projectId);
    if (folderId) fd.append("folder_id", folderId);
    fd.append("name", name || file.name);
    fd.append("file", file, file.name);
    const res = await rawFetch("/files/upload", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.message ?? "上传失败");
    return body as FileEntry;
  },

  /** 附件专用：只建 blob（不建仓库条目）。 */
  uploadBlob: async (projectId: string, file: File): Promise<FileBlob> => {
    const fd = new FormData();
    fd.append("project_id", projectId);
    fd.append("file", file, file.name);
    const res = await rawFetch("/files/blobs", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.message ?? "上传失败");
    return body.blob as FileBlob;
  },

  download: async (projectId: string, blob: FileBlob): Promise<void> => {
    const res = await rawFetch("/files/" + enc(blob.id) + "/content"
      + qs({ project_id: projectId, disposition: "attachment" }), { method: "GET" });
    if (!res.ok) {
      let msg = "下载失败";
      try { msg = (await res.json())?.message ?? msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.blob();
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url; a.download = blob.original_name || "file";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },
};

export function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
