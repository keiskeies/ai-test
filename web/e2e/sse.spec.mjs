// SSE 断线续传回归（Review Focus 3 的服务端半边）：
// 重连带 Last-Event-ID: N 时，只重放 seq > N，不重不漏。
//
// 两条通道（agent / run）的游标逻辑同源：都走 core/sse.py 的 _cursor_from——
// 显式 ?cursor= 优先，缺省回落到 Last-Event-ID 头（agent 与 run 皆如此）。
// 本文件钉 agent 通道（活路由）；run 通道（GET /api/v1/events/run/{run_id}）由 T11
// 交付后才存在，此处**不造假路由**：T11 落地后在本文件补 run 半边（同一断言，
// 事件由 scenario_run 驱动，channel 为 run.{run_id}）。
import { test, expect } from "@playwright/test";
import { seedProject, asUser, BASE } from "./helpers.mjs";

/** 直连 SSE 端点读流：收够 want 帧就 abort；返回解析出的事件数组。 */
async function readSse(token, sessionId, lastEventId, want) {
  const ctrl = new AbortController();
  const r = await fetch(BASE + "/events/agent/" + sessionId, {
    headers: {
      Accept: "text/event-stream",
      Authorization: "Bearer " + token,
      ...(lastEventId === null ? {} : { "Last-Event-ID": String(lastEventId) }),
    },
    signal: ctrl.signal,
  });
  if (!r.ok || !r.body) throw new Error("sse http " + r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
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
      events.push(JSON.parse(line.slice(6)));
      if (events.length >= want) {
        ctrl.abort();
        return events;
      }
    }
  }
  return events;
}

test("SSE 重连 Last-Event-ID：只重放 seq > N（agent 通道）", async ({ page }) => {
  const { token, projectId } = await seedProject(page, "e2e-sse");
  const sr = await asUser(token, "post", "agent/sessions", {
    data: { project_id: projectId, model_id: null, thinking: "off", mode: "FULL" },
  });
  expect(sr.status, "建会话失败: " + JSON.stringify(sr.body)).toBe(201);
  const sid = sr.body.id;

  // 用 fake 模型跑一轮，产生确定性的持久事件序列（终态 RUN_END 落 agent_message 表）
  await asUser(token, "post", "agent/sessions/" + sid + "/messages", { data: { content: "列一下环境" } });
  let items = [];
  await expect(async () => {
    const r = await asUser(token, "get", "agent/sessions/" + sid + "/messages?cursor=0");
    items = r.body.items;
    expect(items.some((e) => e.type === "RUN_END")).toBeTruthy();
  }).toPass({ timeout: 20_000 });

  const total = items.length;
  const N = items[1].seq; // seq 从 1 连号：中段游标取第 2 条

  // ① 带 Last-Event-ID: N 重连 → 恰好收到 seq N+1..total，不重不漏
  const resumed = await readSse(token, sid, N, total - N);
  expect(resumed.map((e) => e.seq)).toEqual(
    Array.from({ length: total - N }, (_, i) => N + 1 + i),
  );

  // ② 不带 Last-Event-ID → 全量重放 seq 1..total（游标回落 0）
  const full = await readSse(token, sid, null, total);
  expect(full.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
});
