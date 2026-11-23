// Pilot 试验台（§11.3/§11.4.30 简化版）：项目→会话→消息→SSE 事件流；模式/思考/模型选择器；发送/中断。
// 产品决策（R23）：会话在首次发送时惰性创建（放弃草稿不留垃圾会话）；D263 起 ASK 的写工具
// 在审批卡上直接回传（批准本次/本会话/拒绝），中断仍是另一条随时可走的出口。
// D55 判据3：刷新不再失忆——sessionId 落 localStorage（按项目键），挂载时 GET /agent/sessions/{id}/messages
// 回放历史喂进同一条 applyEvent，再挂直播流续传。
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Card, Select, Space, Tag, Typography, message } from "antd";
import { PauseCircleOutlined, SendOutlined } from "../ui/icons";
import { ApiErr, get, getToken, post } from "../api/client";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { openAgentStream } from "../agent/sse";
import type { AgentEvent, SseHandle } from "../agent/sse";
import EventCard from "../agent/EventCard";
import type { EffectMap } from "../agent/EventCard";
import { foldPlanListCards } from "../agent/cards/fold"; // 计划列表「原地更新」合流（§11.4.33）
import { foldToolCalls } from "../agent/turns"; // 一次工具的两条信封合成一行 chip
import { producedRefs, producedHref, producedLabel, turnStats } from "../agent/sidepanel";
import { savePlanAsScenario } from "../shared/planSave";
import { fmtTime } from "../shared/timefmt";
import { tp, tpv } from "../theme";
import { FilterBar } from "../ui/Toolbar";
import StateView from "../ui/StateView";
import type { CardContext } from "../agent/cards";

type Mode = "PLAN" | "ASK" | "FULL";
type Think = "off" | "low" | "medium" | "high";
type Status = "未开始" | "空闲" | "运行中" | "等待审批" | "出错";

// D55 判据3：会话 id 按项目落本地——换项目各存各的，A 项目的会话不会在 B 项目里还魂
// （恢复路径反正要 GET 校验，已删会话的 404 兜底见下方 D55 恢复 effect）。
const SESSION_KEY = "tp.bench.session.";

interface ModelOut {
  id: string; name: string; model_type: string; enabled: boolean; is_default: boolean;
  /** D104 D 态：后端 model_cfg 一直在发这个字段（gateway 靠它丢 tools 优雅降级），
   *  此前本地接口没接——「数据在库、前端不吃」。见模型下拉 label 的「（不支持工具）」标注。 */
  supports_tools: boolean;
}

export default function Bench() {
  const nav = useNavigate();
  const location = useLocation();
  const authProject = useAuth((s) => s.project);
  const authUser = useAuth((s) => s.user);
  const [projects, setProjects] = useState<ProjectOut[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOut[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  // 默认只读 PLAN：D263 起 ASK 已有页面审批出口，但「只读预览」仍是更安全的默认档；
  // FULL 仍按 agent:full:use 隐藏。三档都可手选。
  const [mode, setMode] = useState<Mode>("PLAN");
  const [thinking, setThinking] = useState<Think>("medium");
  const [armed, setArmed] = useState(false); // 已「开始会话」（会话本体惰性到首条消息）
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("未开始");
  // D263：审批回传在途（防连点）。决策事件一到，卡片自己会翻成「已处理」。
  const [approving, setApproving] = useState(false);
  // D55 判据3：历史回放中标记。它锁发送（历史没喂完就发送 = 消息插进半截时间线），
  // 但它【不是】「运行中」：回放没在跑任何 run，中断钮（running 门）不认它。
  const [replaying, setReplaying] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [effects, setEffects] = useState<EffectMap>({});
  const [draft, setDraft] = useState("");
  const streamRef = useRef<SseHandle | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // D179 世代号：SSE 落定屏上状态与「重新开始」都不是发送方自己做的跃迁，在途的 send/sendText
  // 收尾只认自己那一代。两个计数器分工不同，不能合成一个：
  // · stGen 锁状态收尾——迟到的失败 catch 若把状态还回快照，就把 SSE 刚推来的「等待审批」洗成
  //   「空闲」，中断钮（S0 挂起态的唯一出口）随之消失。
  // · runGen 只在**终态** +1——挂起仍属本轮，迟到的 run_id 必须照常认领，否则中断钮永远拿不到 id
  //   （interrupt() 首行 return），那是把一个能修的洞换成不能修的洞。
  const stGen = useRef(0);
  const runGen = useRef(0);
  const inputGen = useRef(0); // 输入框每改一次 +1：send() 只许擦自己发出去的那份草稿

  useEffect(() => {
    get<{ items: ProjectOut[] }>("/projects?size=200").then((r) => setProjects(r.items)).catch(() => undefined);
    if (authProject) setProjectId(authProject.id);
    // 模型列表：model:cfg:* 仅系统管理员（R19）→ 403 时隐藏选择器，用后端默认模型
    get<{ items: ModelOut[] }>("/model-cfgs?size=200", { silent: true })
      .then((r) => {
        const chat = r.items.filter((m) => m.enabled && m.model_type === "CHAT");
        setModels(chat);
        setModelsFailed(false);
        const d = chat.find((m) => m.is_default);
        if (d) setModelId(d.id);
      })
      // 403 = 权限规则（R19），按设计静默降级；500/断网 = 取数失败，不许伪装成
      // 「你没权限/没模型」——那是把没拿到的判定说成拿到了。
      .catch((e: unknown) => {
        setModels([]);
        setModelsFailed(!(e instanceof ApiErr && e.status === 403));
      });
    return () => streamRef.current?.close();
    // 挂载一次性取数（项目/模型）：authProject 变化不该重新武装页面，也不该重置会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // D84 诚实切片：「问 Pilot」入口 nav("/bench", { state: { pilotDraft } }) 只预填输入框，
  // 人读完自己按发送——绝不自动发（那才是偷偷建会话）。只认挂载时的一次性注入：seed 后
  // 立即 replace 清掉 location.state，刷新/再次导航到本页不会把同一段草稿倒回来第二遍。
  useEffect(() => {
    const seeded = (location.state as { pilotDraft?: unknown } | null)?.pilotDraft;
    if (typeof seeded === "string" && seeded.trim() !== "") {
      setDraft(seeded);
      nav(location.pathname + location.search, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  // D55 判据3：刷新不再失忆。本项目键下有存档会话 → GET /agent/sessions/{id}/messages
  // 回放历史（next_cursor 分页，封顶 3 页），每条信封喂进与直播【同一条】applyEvent——
  // 同一个 reducer、没有第二套渲染；然后挂直播流续传，还在跑的 run 从回放末尾继续出事件。
  // openAgentStream 没有起始 cursor 参数（shared/sse.ts 只在重连时带 Last-Event-ID），
  // 首连会全量重放——reducer 的 seq 去重（applyEvent）把重放吃掉，不重不漏，故不开新参数。
  // 状态诚实（判据4）：回放不伪造「运行中」——屏上状态只由事件落定：历史里的终态/挂起
  // 信封照常经 applyEvent 落状态；历史没跑到终态就停在「空闲」基线，run 若实际在跑，
  // 由挂上后的直播事件自己来说。runId 回放不恢复（服务端信封不带 run_id），恢复出的
  // 挂起态下中断钮按后端既有约定为空操作（interrupt 首行 return）——信封不撒谎的代价。
  useEffect(() => {
    if (!projectId || armed || sessionId) return; // 有在用的活会话/已武装则不碰
    const sid = localStorage.getItem(SESSION_KEY + projectId);
    if (!sid) return; // 没有存档锚点 = 一条恢复请求都不发（与今天完全同屏）
    const mySt = stGen.current; // 回放途中按「重新开始」= 放弃，整段作废
    // 本回放独有的作废旗：卸载或 StrictMode 的假卸载都会撤销它，只有当下仍在世的那次回放
    // 有资格落状态/开流（流泄漏 = 每 1.5s 重连风暴）。与 GET /projects 同款：dev 双跑一次。
    let cancelled = false;
    // 立刻进「已武装 + 回放中」屏：输入框可见但发送被 busy 闸拦下（历史没喂完就发送 =
    // 消息插进半截时间线），状态槽显示「正在回放历史…」。失败/404 再退回未武装全新屏。
    setReplaying(true);
    setArmed(true);
    loadToolEffects(projectId); // 回放出的 TOOL_CALL 徽标与直播同一张效果表
    void (async () => {
      const pages: AgentEvent[][] = [];
      try {
        let cursor = 0;
        for (let page = 0; page < 3; page += 1) {
          const r = await get<{ items: AgentEvent[]; next_cursor: string | null }>(
            "/agent/sessions/" + sid + "/messages?cursor=" + cursor + "&size=200",
            { silent: true }, // 404 是自己兜底的分支，不许 client 抢着弹「会话不存在」
          );
          pages.push(r.items);
          if (r.next_cursor === null) break;
          cursor = Number(r.next_cursor);
        }
      } catch (e) {
        // 会话已删（404）：锚点作废 → 清键，回到今天的「未武装全新」屏。
        // 其它失败（500/断网）：键【保留】——没拿到 ≠ 已删除，下次刷新还能救；屏同样退回全新。
        if (e instanceof ApiErr && e.status === 404) localStorage.removeItem(SESSION_KEY + projectId);
        if (!cancelled && mySt === stGen.current) { setArmed(false); setReplaying(false); }
        return;
      }
      if (cancelled || mySt !== stGen.current) return; // 「重新开始」已换屏：这些历史没有上屏资格
      const stBefore = stGen.current;
      for (const pg of pages) for (const ev of pg) applyEvent(ev);
      // 历史没落定任何状态（无终态/挂起信封）才回到 start() 同款「空闲」基线；
      // 落定过就尊重事件说的那一档，不覆盖。
      if (stBefore === stGen.current) setStatus("空闲");
      setSessionId(sid);
      streamRef.current?.close();
      streamRef.current = openAgentStream(sid, { onEvent: applyEvent });
      setReplaying(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function applyEvent(ev: AgentEvent) {
    if (ev.type === "RUN_END") {
      // 终态事件携带最终状态（全集见 backend/app/modules/agent/models.py:43）：
      // WAIT_APPROVAL = 挂起（D263 可在审批卡回传，也可中断）；ERROR = run 抛异常
      // （tasks.py:81/:92）——崩掉的 run 不许洗回绿色「空闲」，如实上屏「出错」；
      // DONE（runner.py:53）/ CANCELLED（routes.py:131 中断后回到可操作态）及
      // 未知值 → 空闲。三个终态都清 runId：run 已终态，没东西可中断。
      // run 在 messages 回包之前就终态是常态（快 run + SSE 比 POST 先到）：屏上状态一旦由
      // SSE 落定，在途 send 的收尾就再没有资格改写它。
      // 屏上状态一旦由 SSE 落定，在途发送的收尾就再没有资格改写它；终态另计一代：那之后
      // 才回来的 run_id 属于一个已经结束的 run，认领它会让下一条消息的中断钮按错 id（后端 404 还被静默吞掉）。
      stGen.current += 1;
      const st = String((ev.payload as { status?: string }).status ?? "");
      if (st === "WAIT_APPROVAL") {
        setStatus("等待审批");
      } else {
        runGen.current += 1;
        setStatus(st === "ERROR" ? "出错" : "空闲");
        setRunId(null);
      }
      return;
    }
    if (ev.type === "APPROVAL_REQ") {
      stGen.current += 1;
      setStatus("等待审批");
      // D263：刷新/重连后只有事件回放能重建「这是哪一轮」，run_id 随审批卡落库。
      // 没有它，未决审批卡的按钮只能恒灰——「重开会话依旧可操作」就是空话。
      const rid = String((ev.payload as { run_id?: string }).run_id ?? "");
      if (rid) setRunId(rid);
    }
    setEvents((old) => (old.some((e) => e.seq === ev.seq) ? old : [...old, ev]));
  }

  function start() {
    if (!projectId) {
      message.warning("请先选择项目");
      return;
    }
    streamRef.current?.close();
    streamRef.current = null;
    // 重开 = 旧会话的在途请求再没有资格改屏上状态，也没有资格认领 run_id
    stGen.current += 1;
    runGen.current += 1;
    // D55 判据3：「重新开始」= 放弃存档会话，恢复锚点必须跟着清，否则刷新又把旧会话还魂；
    // 回放若还在途，世代已 bump 拦得住它的提交，但回放中标记得立刻撤，不然发送闸永远合不上。
    localStorage.removeItem(SESSION_KEY + projectId);
    setReplaying(false);
    setEvents([]);
    setSessionId(null);
    setRunId(null);
    setStatus("空闲");
    setArmed(true);
    loadToolEffects(projectId);
  }

  // 工具效果映射（徽标口径唯一来源）：start() 与 D55 恢复回放共用，回放出的 TOOL_CALL
  // 徽标必须和直播同一张表，否则同一事件在两条路上画出两种效果。
  function loadToolEffects(pid: string) {
    void get<{ items: { name: string; effect: "read" | "write" | "destructive" }[] }>(
      "/agent/tools?project_id=" + encodeURIComponent(pid))
      .then((r) => {
        const m: EffectMap = {};
        for (const t of r.items) m[t.name] = t.effect;
        setEffects(m);
      })
      .catch(() => setEffects({}));
  }

  // 忙判定唯一口径 = 中断钮出现判定：「等待审批」时 run 仍挂着，此时 POST messages 后端必回 409
  const running = status === "运行中" || status === "等待审批";
  // D55 判据3：回放历史时同样锁发送——历史没喂完就发送 = 消息插进半截时间线。
  // 「回放中」不是「运行中」：没在跑任何 run，中断钮（running 门）不认它。
  const busy = running || replaying;

  async function send() {
    const text = draft.trim();
    if (!text || !projectId || busy) return;
    const prev = status; // 调用时刻的快照：失败原样还回，不替用户编一个新状态
    // 发起时的世代与草稿快照：收尾要能认出「这中间屏上/输入框已被别人（SSE、用户）动过」
    const mySt = stGen.current;
    const myRun = runGen.current;
    const myInput = inputGen.current;
    try {
      let sid = sessionId;
      if (!sid) {
        const s = await post<{ id: string }>("/agent/sessions", {
          project_id: projectId, model_id: modelId ?? undefined, thinking, mode,
        });
        // 建会话期间用户按了「重新开始」（只有它能在这一刻 bump 世代）：这条消息属于已经
        // 被放弃的会话，认领它 = 认下一个不在屏上的会话 + 白开一条 SSE 流（:7 钉的流泄漏）。
        if (mySt !== stGen.current) return;
        sid = s.id;
        setSessionId(sid);
        // D55 判据3：会话一建成就落盘——此刻起任何刷新都能按 sid 回放历史续命
        localStorage.setItem(SESSION_KEY + projectId, sid);
        streamRef.current = openAgentStream(sid, { onEvent: applyEvent });
      }
      setStatus("运行中");
      const r = await post<{ run_id: string }>("/agent/sessions/" + sid + "/messages", { content: text });
      // 只有本轮仍未终态才认领 run_id：在途窗口里 run 已经 DONE，迟到的 id 会让中断钮在空闲会话上复活
      if (myRun === runGen.current) setRunId(r.run_id);
      // 只擦「我发出去的那一份」：窗口里用户新打的字留在屏上，否则一次慢发送会吃掉刚敲的半句话。
      // 比的是代数而不是 draft 本身——send 是每次渲染重建的闭包，这里读到的 draft 永远等于快照值。
      if (myInput === inputGen.current) setDraft("");
    } catch (e) {
      // 失败前是什么状态就回到什么；世代已动说明屏上状态是更晚的事实（挂起态尤其），不许还回快照——
      // 那会拆掉中断钮，把「等人工」的 run 洗成看着空闲。
      if (mySt === stGen.current) setStatus(prev);
      void e;
    }
  }

  // 卡片操作回写（R149/D32）：拼可读前缀 + 调既有 POST messages——cards/ 侧只见这个回调。
  // 运行中不排队不吞点击：sendText 前的忙判定与 send() 同口径。
  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || !projectId || busy) return;
    if (!sessionId) {
      void message.warning("先开始会话再操作卡片");
      return;
    }
    const prev = status;
    const mySt = stGen.current;
    const myRun = runGen.current;
    try {
      setStatus("运行中");
      const r = await post<{ run_id: string }>("/agent/sessions/" + sessionId + "/messages", { content: text });
      // 同 send()：本轮已终态则这个 id 属于一个已经结束的 run，认领它会让中断钮复活并按错 id 中断
      if (myRun === runGen.current) setRunId(r.run_id);
    } catch (e) {
      // 同 send()：还原调用前状态，挂起态不被失败改写；世代已动则屏上才是更晚的事实
      if (mySt === stGen.current) setStatus(prev);
      void e;
    }
  }

  // 当前项目的生效权限：项目列表回包自带 my_perms，authProject 只作未加载完的兜底
  // （权限是项目作用域的，拿另一个项目的位给这个项目放行就是假门）。
  const activeProject = projects.find((p) => p.id === projectId) ?? authProject;
  // D264：候选方案落库 = POST /scenarios，位是 scenario:create。缺位不注入实现 →
  // 卡片不画保存钮（写钮缺位，不画假门）；预览页也靠 entry 里的 projectId 自行判定。
  const canCreateScenario = can(patternsForProject(activeProject, authUser?.is_system_admin), "scenario:create");

  const cardCtx: CardContext = {
    onUserMessage: (t) => void sendText("[卡片操作] " + t),
    busy,
    projectId: projectId ?? undefined,
    onSaveScenarioPlan: canCreateScenario && projectId
      ? (name, graph) => savePlanAsScenario(projectId, name, graph)
      : undefined,
  };

  async function interrupt() {
    if (!sessionId || !runId) return;
    try {
      await post("/agent/sessions/" + sessionId + "/interrupt", { run_id: runId }, { silent: true });
    } catch {
      /* 已结束 */
    }
  }

  /** D263：审批回传 → 后端落决策并异步续推；本函数只负责发请求与在途态。
   *  先切「运行中」是为了让输入区与审批钮同时上锁：决策一落，后端已把 run 拉回 RUNNING。 */
  async function decideApproval(toolCallId: string, decision: "once" | "session" | "deny") {
    if (!runId || !toolCallId || approving) return;
    const prev = status;
    setApproving(true);
    setStatus("运行中");
    try {
      await post("/agent/runs/" + runId + "/approval", { tool_call_id: toolCallId, decision });
    } catch {
      // 409 already_decided / run_not_waiting 等：回到原状态，让卡片自己按事件流翻面
      setStatus(prev);
    } finally {
      setApproving(false);
    }
  }

  // 回放里的决策：同一 tool_call_id 的 APPROVAL_DECISION 一旦出现，卡片就不再可点。
  const approvalDecisions = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "APPROVAL_DECISION") continue;
    const a = e.payload as { tool_call_id?: string; decision?: string };
    if (a.tool_call_id && a.decision) approvalDecisions.set(a.tool_call_id, a.decision);
  }

  const canModelSelect = models.length > 0;
  // 右栏两个读数都从事件流当场数出来（sidepanel.ts 纯函数），页面上不存在第二个计数器。
  const stat = turnStats(events);
  const produced = producedRefs(events);
  // D102：FULL == 写能力（唯一不拦的档），按 agent:full:use 出选项。判定按**当前选中项目**
  // 的位（activeProject 见上），authProject 只作未加载完的兜底——权限是项目作用域的，
  // 拿另一个项目的位给这个项目放行就是假门。选择器选项不是写入口，「隐藏不是禁用」的
  // 口径不强制——这里取隐藏：没勾上的人不该看见一个按了必 403 的档位（后端建会话同位 403 兜底）。
  // 初值 PLAN（R44 翻案）天然安全：隐藏 FULL 后无位用户到不了 FULL 的两条路（默认档/手选）。
  const canFull = can(patternsForProject(activeProject, authUser?.is_system_admin), "agent:full:use");
  const modeOptions = [
    { value: "PLAN", label: "只读（PLAN）" },
    { value: "ASK", label: "询问（ASK）" },
    ...(canFull ? [{ value: "FULL", label: "全自动（FULL）" }] : []),
  ];

  return (
    // 整页 = .tp-fill 纵向填满视口（遮挡高度从 metrics 反解，见 styles.css），块间距靠 gap。
    // 旧版 `calc(100vh - 330px)` 是拿常量猜骨架高度，骨架一动就错、还多出一条滚动条。
    <div data-testid="bench" className="tp-fill tp-fill--head" style={{ gap: tp.gap.sm }}>
      <div className="tp-page-head">
        <span className="tp-page-title">Pilot 试验台</span>
        <Space>
          <span data-testid="bench-status-tag">
            <Tag color={status === "空闲" ? "green" : status === "运行中" ? "processing" : status === "等待审批" ? "orange" : status === "出错" ? "red" : "default"}>
              状态：<span data-testid="bench-status">{replaying ? "正在回放历史…" : status}</span>
            </Tag>
          </span>
        </Space>
      </div>

      {/* 会话参数条：常驻，未武装时只有它（项目 + 开始），武装后项目锁死。
          筛选件进 FilterBar 左侧、主按钮进 actions 最右（同屏唯一 primary）。 */}
      <FilterBar actions={(
        <Button type="primary" data-testid="bench-start" disabled={!projectId || running} onClick={start}>
          {armed ? "重新开始" : "开始新会话"}
        </Button>
      )}>
        <Select
          data-testid="bench-project-select"
          placeholder="选择项目"
          style={{ minWidth: 220 }}
          value={projectId}
          disabled={armed}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => setProjectId(v)}
        />
        <span className="tp-text-sm tp-tertiary">
          {armed ? "会话进行中——换项目请先「重新开始」" : "选项目后开始会话，会话在首条消息时创建"}
        </span>
      </FilterBar>

      {armed && (
        // 窄容器兜底：会话列 basis 360 + 右栏 256 折行阈值 ~632px，容器再窄右栏整块换到下一行，
        // 而不是把两列一起挤扁（jsdom/无 matchMedia，用 flex-wrap 做容器断点）。
        <div className="tp-fill-body" style={{ display: "flex", flexWrap: "wrap", gap: tp.gap.md }}>
          <div style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div
              ref={listRef}
              data-testid="bench-stream"
              className="tp-fill-body"
              style={{ overflowY: "auto", paddingRight: 8 }}>
              {events.length === 0 && (
                <StateView title="发一条消息，看 Pilot 一步步干活"
                  desc="Pilot 会把每一步工具调用、参数与返回，以及产出的资源都落在这条流里。"
                  testId="bench-stream-empty" />
              )}
              {/* 两层合流都在渲染侧，applyEvent 不被动过：
                  计划列表卡只留最新一份（§11.4.33），一次工具的两条信封只画一行 chip。 */}
              {foldToolCalls(foldPlanListCards(events)).map(({ ev, result }) => {
                // 审批卡按 tool_call_id 对回决策：已决 → 只读徽标；未决 → 三档按钮。
                const tcId = ev.type === "APPROVAL_REQ"
                  ? String((ev.payload as { tool_call_id?: string }).tool_call_id ?? "") : "";
                return (
                  <EventCard key={ev.seq} ev={ev} result={result} effects={effects} cardCtx={cardCtx}
                    approvalDecision={tcId ? approvalDecisions.get(tcId) ?? null : undefined}
                    approvalBusy={approving}
                    onApproval={tcId && runId && !replaying ? decideApproval : undefined} />
                );
              })}
            </div>

            {/* 汇总 pill（改版）：参考图上是「3 个文件已修改 +2 -6」，本后端不产 diff 统计，
                所以这里只报事件流真说得出的两件事，且没改动过资源就整块不出现（不摆一个 0）。 */}
            {produced.length > 0 && (
              <div data-testid="bench-summary-pill" style={{ display: "inline-flex", alignItems: "center", gap: 8, margin: "8px 0 0", padding: "4px 12px", borderRadius: tp.radius.pill, border: `1px solid ${tpv.primary[200]}`, background: tpv.primary[50], fontSize: tp.fontSize.sm, color: tpv.primary[700] }}>
                <span data-testid="bench-pill-produced">已改动 {produced.length} 个资源</span>
                <span style={{ color: tpv.primary[300] }}>·</span>
                <span data-testid="bench-pill-tools">工具调用 {stat.toolCalls} 次</span>
              </div>
            )}

            {/* 输入区（改版）：一个圆角容器把输入与操作条兜在一起，正文与操作条共边。 */}
            <div data-testid="bench-composer" style={{ marginTop: 8 }}>
              <textarea
                data-testid="bench-input"
                value={draft}
                onChange={(e) => { inputGen.current += 1; setDraft(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
                }}
                placeholder="例如：帮我建一个查询订单接口（Ctrl+Enter 发送）"
                rows={2}
                style={{
                  width: "100%", boxSizing: "border-box", resize: "none", display: "block",
                  background: tpv.bg.container, border: `1px solid ${tpv.border}`, borderRadius: tp.radius.xl,
                  padding: "8px 12px 0", fontSize: tp.fontSize.base, outline: "none", fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 8px 8px 12px" }}>
                <Select
                  data-testid="bench-mode-select" size="small" variant="borderless" popupMatchSelectWidth={false}
                  value={mode} disabled={running || sessionId !== null} onChange={(v) => setMode(v)}
                  options={modeOptions}
                />
                <Select
                  data-testid="bench-thinking-select" size="small" variant="borderless" popupMatchSelectWidth={false}
                  value={thinking} disabled={running || sessionId !== null} onChange={(v) => setThinking(v)}
                  options={[
                    { value: "off", label: "思考：关闭" },
                    { value: "low", label: "思考：低" },
                    { value: "medium", label: "思考：中（默认）" },
                    { value: "high", label: "思考：高" },
                  ]}
                />
                {canModelSelect && (
                  // D104 D 态：supports_tools=false 的模型照样可选（后端 gateway 丢 tools
                  // 优雅降级，禁选/隐藏都是过度纠正），但必须明说它不带工具。
                  <Select
                    data-testid="bench-model-select" size="small" variant="borderless" popupMatchSelectWidth={false}
                    style={{ minWidth: 140 }} value={modelId ?? undefined}
                    disabled={running || sessionId !== null} placeholder="平台默认模型"
                    onChange={(v) => setModelId(v)}
                    showSearch optionFilterProp="label"
                    options={models.map((m) => ({
                      value: m.id,
                      label: m.name + (m.is_default ? "（默认）" : "")
                        + (m.supports_tools === false ? "（不支持工具）" : ""),
                    }))}
                  />
                )}
                <span style={{ flex: 1 }} />
                <Button
                  type="primary" shape="round" icon={<SendOutlined />} data-testid="bench-send"
                  disabled={!draft.trim() || busy} loading={status === "运行中"} onClick={() => void send()}>
                  发送
                </Button>
                {running && (
                  <Button danger shape="round" icon={<PauseCircleOutlined />} data-testid="bench-interrupt" onClick={() => void interrupt()}>
                    中断
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* 右栏（改版）：只放事件流真说得出的事实。截图里的「+2 -6 文件改动」「来源列表」
              本后端不产（无 diff 统计、无引用来源），照抄就是假面板，故整块不做。 */}
          <div data-testid="bench-side" style={{ width: 256, flexShrink: 0, borderLeft: `1px solid ${tpv.split}`, paddingLeft: 16 }}>
            <Typography.Text type="secondary" className="tp-text-sm">会话进度</Typography.Text>
            <div data-testid="bench-side-progress" className="tp-text-md" style={{ marginTop: 6 }}>
              <div>工具调用 <span className="tp-mono">{stat.toolCalls}</span> 次
                {stat.toolFails > 0 && <Typography.Text type="danger"> · 失败 {stat.toolFails}</Typography.Text>}
              </div>
              <div className="tp-mono tp-text-sm" style={{ color: tpv.text[2] }}>
                tokens 入 {stat.inputTokens} / 出 {stat.outputTokens}
              </div>
              {/* 没有带 ts 的信封就画「—」：拿当前时间冒充「最近更新」是编一个没拿到的读数 */}
              <div className="tp-text-sm" style={{ color: tpv.text[3] }}>
                更新于 {fmtTime(stat.lastTs, { seconds: false }) ?? "—"}
              </div>
            </div>

            <Typography.Text type="secondary" className="tp-text-sm" style={{ display: "block", marginTop: 16 }}>产出</Typography.Text>
            {produced.length === 0 ? (
              // 空态说清「为什么空」：只读档确实一个资源都不该动。
              <Typography.Text data-testid="bench-side-produced-empty" type="secondary" className="tp-text-sm" style={{ display: "block", marginTop: 6 }}>
                这次会话 pilot 还没改动任何资源
              </Typography.Text>
            ) : (
              <div data-testid="bench-side-produced" style={{ marginTop: 6 }}>
                {produced.map((r) => {
                  const href = producedHref(r.kind, r.id);
                  const line = `${producedLabel(r.kind)} · ${r.name}`;
                  return (
                    <div key={r.kind + ":" + r.id} className="tp-text-md" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {href
                        ? <a href={href}>{line}</a>
                        : <Typography.Text type="secondary">{line}</Typography.Text>}
                    </div>
                  );
                })}
              </div>
            )}

            {!canModelSelect && modelsFailed && (
              <div style={{ marginTop: 12 }}>
                <Typography.Text type="danger" data-testid="bench-model-unavailable">
                  模型列表没取到（不是没有权限），本次会话用平台默认模型 · 刷新本页可重试
                </Typography.Text>
              </div>
            )}
            {getToken() && (
              <Typography.Text type="secondary" className="tp-text-sm" style={{ display: "block", marginTop: 16 }}>
                提示：写类操作会真实落库，试验请用演示项目。
              </Typography.Text>
            )}
          </div>
        </div>
      )}
      {!armed && (
        // 空态 Card 撑满 tp-fill 余高并垂直居中（同 adb 设备管理空态），否则 206px 卡贴顶、
        // 下方留约 421px 死空（2026-11-22 量测：面板 747 高、卡 y200→406）。
        <Card style={{ flex: "1 1 0", minHeight: 0 }}
          styles={{ body: { padding: 16, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" } }}>
          {/* 空白态不再摆第二个 primary：上方参数条里的「开始新会话」是全局唯一的主动作
              （§11.6.6 每屏 ≤1 个主色实底按钮）。这里只解释「为什么是空的」。 */}
          <StateView title="选择项目并点「开始新会话」"
            desc="会话在首条消息时创建——不开始、不落库，不留空会话。" />
        </Card>
      )}
    </div>
  );
}
