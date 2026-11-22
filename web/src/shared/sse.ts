// 通用 SSE 订阅（§12.2）：fetch + Authorization 头（EventSource 不能带 header），
// 断线自动续传 Last-Event-ID，seq 去重，固定 1500ms 重连间隔。
// 由 agent/sse.ts 抽出（T15 纯重构，行为不变），agent 与 run 两条通道共用同一实现：
//   - agent 通道：GET /api/v1/events/agent/{session_id}（信封多一个 run_id 字段）
//   - run   通道：GET /api/v1/events/run/{run_id}（T11 提供；信封 {seq, ts, type, payload}）
// 服务端语义（core/sse.py）：先订阅 → 重放 seq > cursor → 直播按 seq 去重 ⇒ 不重不漏。
import { getToken, onUnauthorized, refreshOnce } from "../api/client";

/** 事件信封的公共形状；通道各自的扩展字段由类型参数补齐。 */
export interface StreamEnvelope {
  seq: number;
  ts: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** run 通道事件（run_event 表重放与直播同信封，§12.2）。
 *  用 type 而非 `interface RunEvent extends StreamEnvelope {}`：后者一个成员都不加，
 *  与父接口完全等价（lint 的 no-empty-object-type 就是钉这个空壳）。真长出扩展字段
 *  那天再写回 interface。 */
export type RunEvent = StreamEnvelope;

export interface SseHandle { close: () => void; }

export interface StreamHandlers<T> {
  onEvent: (ev: T) => void;
  onOpen?: () => void;
  onDown?: () => void;
}

/**
 * 打开通用事件流。path 是完整端点（含 /api/v1 前缀）。
 * 续传契约（两条通道一致）：重连时带 Last-Event-ID 头，服务端 core/sse.py 的
 * _cursor_from 在无显式 cursor 时回落到该头，按 seq > cursor 重放差集 + 直播按 seq 去重。
 * agent 路由额外接受 ?cursor= 覆盖（查询参数优先于头）；前端统一用头，不用参数。
 */
export function openStream<T extends StreamEnvelope>(
  path: string,
  handlers: StreamHandlers<T>,
): SseHandle {
  let closed = false;
  let lastSeq = 0;
  // 每次尝试一个新 AbortController：controller 建在循环外时，一条被 abort 过的
  // signal 永久失效，若 abort 与 close 分离（调用方自己掐流、稍后再 close 句柄），
  // 重连会被同一个废 signal 秒拒。按尝试建 + close 掐当前在飞的一条，语义最直接。
  // （T21 的断线重连 e2e 第一次让「外部 abort」穿过这条路径，旧形状只是没被测到。）
  let controller: AbortController | null = null;

  async function pump() {
    // 本轮断连后是否已经试过一次静默刷新。必须是「每轮断连一次」而不是「不限次数」：
    // 不限的话，若 401 的原因不是过期（权限改判、时钟歪、后端把 403 之外的也报 401），
    // refresh 会成功、重连仍 401，于是变成拿 /auth/refresh 打洪——把一个静默死循环
    // 换成另一个更吵的死循环。也不设「整条流只一次」：一条能挂几小时的流，中途网络
    // 抖一下时 access 早已过期，那次刷新是正当需要，不该被第一次断连用掉。
    let refreshedThisGap = false;
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await fetch(path, {
          headers: {
            Accept: "text/event-stream",
            Authorization: "Bearer " + (getToken() ?? ""),
            ...(lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : {}),
          },
          signal: controller.signal,
        });
        if (res.status === 401) {
          // 认证过期走 client 的同一套静默刷新。刷得动就带着新 access 立刻重连
          // （Last-Event-ID 还在，服务端按 seq 补差集，不重不漏）；刷不动就是真登不上
          // 去了，登出并停手。**不能**像下面的网络错那样 1500ms 后硬重试：手里那枚
          // 过期 access 永远不会突然变有效，那是每 1.5 秒空转一次的死循环，而界面上
          // 只表现为「进度不动了、也没提示」（§13 纪律 1：不许静默降级）。
          if (refreshedThisGap || !getToken() || !(await refreshOnce())) {
            onUnauthorized();
            return;
          }
          refreshedThisGap = true;
          continue;
        }
        if (!res.ok || !res.body) throw new Error("sse http " + res.status);
        refreshedThisGap = false; // 连上了，下一轮断连重新有一次刷新额度
        handlers.onOpen?.();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = block.split("\n").find((x) => x.startsWith("data: "));
            if (!line) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as T;
              if (ev.seq > lastSeq) {
                lastSeq = ev.seq;
                handlers.onEvent(ev);
              }
            } catch {
              /* 坏帧丢弃，等待直播补齐 */
            }
          }
        }
      } catch {
        if (closed) return;
      }
      if (closed) return;
      handlers.onDown?.();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  void pump();
  return {
    close: () => {
      closed = true;
      controller?.abort();
    },
  };
}

/** run 通道：场景执行实时进度（running/pass/fail/skip/error、row_progress、run_end）。
 *  project_id 必带：路由的数据权限门认的是 payload 里的 project_id（同制品下载的口径），
 *  光靠 run_id 判不出项目归属。 */
export function openRunStream(
  projectId: string,
  runId: string,
  handlers: StreamHandlers<RunEvent>,
): SseHandle {
  return openStream<RunEvent>(
    "/api/v1/events/run/" + runId + "?project_id=" + encodeURIComponent(projectId),
    handlers,
  );
}
