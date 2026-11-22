// 统一 fetch 封装：token 注入 / 401 登出 / 错误信封 {code,message,details} toast。
import { message } from "antd";

export class ApiErr extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, msg: string, status: number, details?: unknown) {
    super(msg);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = "tp_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export function onUnauthorized(): void {
  setToken(null);
  if (!location.hash.startsWith("#/login")) location.hash = "#/login";
}

// ── 401 → 单次 refresh → 重试原请求 ──────────────────────────────────────────
// 后端 /auth/refresh 靠 HttpOnly Cookie 里的 refresh 令牌换发新 access；
// 并发的多个 401 共享同一次 refresh（refreshPromise 复用），不各刷各的。
// /auth/login 与 /auth/refresh 自身的 401 绝不触发刷新（否则登录失败会自循环）。
const NO_REFRESH_PATHS = ["/auth/login", "/auth/refresh"];

let refreshPromise: Promise<boolean> | null = null;

/**
 * 静默刷新：成功返回 true 且新 access 已落到 localStorage。
 *
 * 导出是给 client.ts 之外的两条自带 Authorization 的路用的——SSE（shared/sse.ts）与
 * 制品取字节（shared/artifactSrc.ts）都是手搓 fetch，不经过下面的 api()，所以不会自动
 * 享受 401→refresh。三条路必须共用这一个函数而不是各写一份：refreshPromise 是「并发
 * 只刷一次」的唯一实现点，抄一份就少一份防踩踏，而 SSE 断线重连每 1.5 秒就可能再撞一次。
 */
export function refreshOnce(): Promise<boolean> {
  if (!refreshPromise) {
    const p: Promise<boolean> = (async () => {
      try {
        const res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "include" });
        if (!res.ok) return false;
        const body = (await res.json()) as { token?: string };
        if (!body?.token) return false;
        setToken(body.token);
        return true;
      } catch {
        return false;
      }
    })();
    refreshPromise = p;
    // 落定即清空：下一次过期还能再刷；进行中的共享同一个 p（防踩踏）。
    void p.finally(() => {
      if (refreshPromise === p) refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function rawFetch(path: string, opts: RequestInit, headers: Record<string, string>): Promise<Response> {
  const tok = getToken();
  const h: Record<string, string> = { ...headers };
  if (tok) h["Authorization"] = "Bearer " + tok;
  // include：5173→8000 代理下 dev 端口号不同仍是同源（vite 代理不改端口），
  // 但显式 include 让 refresh 用的 HttpOnly Cookie 在任何部署形态下都随请求发出。
  return fetch("/api/v1" + path, { ...opts, headers: h, credentials: "include" });
}

export async function api<T = unknown>(path: string, opts: RequestInit & { silent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  let res = await rawFetch(path, opts, headers);
  const refreshable = !NO_REFRESH_PATHS.some((p) => path.startsWith(p)) && !!getToken();
  if (res.status === 401 && refreshable && (await refreshOnce())) {
    // 只重试这一次；重试再 401 就按普通 401 走登出，不循环。
    res = await rawFetch(path, opts, headers);
  }
  if (res.status === 204) return undefined as T;
  let body: unknown; // 不写 `= null`：try 与 catch 两条路都会赋值，初值永远读不到（lint 的 no-useless-assignment）
  try {
    body = await res.json();
  } catch {
    body = null; // 非 JSON 的错误体（网关 HTML 页之类）按「没有信封」处理，不让解析失败盖掉真状态码
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; message?: string; details?: unknown };
    const err = new ApiErr(b.code ?? "http_" + res.status, b.message ?? "请求失败", res.status, b.details);
    if (!opts.silent) message.error(err.message);
    // 非登录接口的 401（含 refresh 失败/重试仍 401）：统一登出（登录失败留在登录页，只提示）
    if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized();
    throw err;
  }
  return body as T;
}

export const get = <T>(path: string, opts?: RequestInit & { silent?: boolean }) =>
  api<T>(path, opts ?? {});
export const post = <T>(path: string, body?: unknown, opts?: RequestInit & { silent?: boolean }) =>
  api<T>(path, { ...opts, method: "POST", body: JSON.stringify(body ?? {}) });
// PUT 用于「按 id 幂等设置」的接口（如项目成员角色）
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
// DELETE 也带 JSON body：后端入参模型统一从 body 读 project_id 等字段
export const del = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "DELETE", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** 登出：让后端清掉 HttpOnly 的 refresh Cookie。静默、失败不拦本地登出
 * （本地态已清，服务端 Cookie 清不掉只影响这台浏览器还能不能再 refresh）。 */
export function callLogout(): void {
  void fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
}
