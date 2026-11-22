// Agent SSE 订阅：通用实现见 shared/sse.ts（T15 纯重构抽出，行为不变），本文件只是
// agent 通道的薄封装——端点拼好、信封类型钉成 AgentEvent。
// 注：run_id 历史上被声明为必有字段，但服务端信封（agent/store.py）一直是
// {seq, ts, type, payload}，前端也从没读过它；改为可选只是让类型不再撒谎。
import { openStream, type SseHandle, type StreamEnvelope } from "../shared/sse";

export interface AgentEvent extends StreamEnvelope {
  run_id?: string | null;
}

export type { SseHandle };

export function openAgentStream(
  sessionId: string,
  handlers: {
    onEvent: (ev: AgentEvent) => void;
    onOpen?: () => void;
    onDown?: () => void;
  },
): SseHandle {
  return openStream<AgentEvent>("/api/v1/events/agent/" + sessionId, handlers);
}
