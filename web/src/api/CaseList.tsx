// 接口详情里的用例列表（§11.4.5）：继承 + 按键覆盖 + 数据集绑定 + 单用例调试。
//
// 覆盖层只在「用户真动过」时才提交：打开新建即完全继承（overlay=null），
// 改一项就只有那一项进覆盖层——把接口的 URL 抄一遍存进用例，接口改了用例不会跟，
// 这是继承语义最容易被做错的地方。「恢复继承」走 request_unset 把键真删掉。
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { BugOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RestOutlined, UndoOutlined } from "../ui/icons";
import { ApiErr, get, patch, post } from "../api/client";
import type { ApiDef, CaseRow, DatasetRow } from "./api";
import type { Assertion } from "./req";
import DebugPanel from "./DebugPanel";
import type { DebugResult } from "./DebugPanel";
import RequestEditor, { fromDraft, toDraft } from "./RequestEditor";
import type { Draft } from "./RequestEditor";
import { can } from "../auth/perms";
import { cleanRequest } from "./req";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };
const OVERLAY_KEYS = ["method", "url", "params", "headers", "auth", "body", "timeout_ms"] as const;
type OverlayKey = (typeof OVERLAY_KEYS)[number];
const KEY_LABEL: Record<string, string> = {
  method: "方法", url: "URL", params: "参数", headers: "请求头", auth: "认证", body: "Body",
  timeout_ms: "超时",
};

// —— 「被场景引用」409 的共用拦截态（D86）——
// 接口回收（api.tsx removeDef）与用例回收（本页 remove）吃同一套后端错误体：
// case_services._blocked 与 services._blocked_definition 同码 referenced_by_scenario、
// 同形状 details（只有顶层键 case_id/definition_id 不同），所以两处的拦截 DOM 共用这一份。
// 放本文件、由 api.tsx 具名引入：api.tsx 本就 import 本文件，不引入新循环。
// 口径沿用 uiElements.tsx:320（details 原样列出 + 隐瞒的诚实分支）与
// notifyChannels.tsx:465（count 加粗 + 逐条 <li>），不发明第三种。
export interface ScenarioRefItem { scenario_id: string; scenario_name: string; step_keys: string[] }
export interface ScenarioBlockDetails { count: number; scenarios: ScenarioRefItem[]; reason?: string }

/** 409 referenced_by_scenario → 拦截态数据；其它错误返回 null（照旧走 client 的 toast）。 */
export function scenarioBlockOf(e: unknown): ScenarioBlockDetails | null {
  if (!(e instanceof ApiErr) || e.code !== "referenced_by_scenario") return null;
  const d = (e.details ?? {}) as { count?: number; scenarios?: ScenarioRefItem[]; reason?: string };
  return { count: d.count ?? 0, scenarios: d.scenarios ?? [], reason: d.reason };
}

/**
 * 拦截弹窗：点名引用者（「场景名」步骤 a、b 逐条列出）+ 明细可见时的 force 第二步。
 * reason=missing_scenario_read（明细被隐瞒）时后端连 force 一起拦
 * （case_services.py:269、services.py:243——不知道断的是谁的步骤就不许硬断），
 * 所以这里只给「知道了」：摆一个按下去仍 409 的 force 是假门（§13 纪律 1）。
 */
export function ScenarioRefsBlockModal({ subject, details, blurb, testid, busy, maySeeRefs, onCancel, onForce }: {
  subject: string; details: ScenarioBlockDetails | null; blurb: string; testid: string;
  busy?: boolean; maySeeRefs: boolean; onCancel: () => void; onForce: () => void;
}) {
  // 双保险口径照 notifyChannels.tsx:474（details_hidden || !maySeeSchedule）：
  // 服务端 reason 为准，前端 scenario:read 判定是同尺兜底——两边任一说不许看，
  // 就不摆 force（后端 services.py:243 在 hidden 时连 force 一起拦，摆出来就是假门）。
  const hidden = details?.reason === "missing_scenario_read" || !maySeeRefs;
  const shown = details?.scenarios ?? [];
  return (
    <Modal open={details !== null} destroyOnHidden width={560} centered
      title="回收被拦截：还有场景在引用它"
      okText={hidden ? "知道了" : "仍要回收（会断掉这些步骤）"}
      okButtonProps={{ danger: !hidden, loading: busy, ...(hidden ? {} : { "data-testid": testid + "-force" }) }}
      cancelText="取消" cancelButtonProps={hidden ? { style: { display: "none" } } : undefined}
      onOk={() => (hidden ? onCancel() : onForce())} onCancel={onCancel}>
      <div data-testid={testid}>
        <Typography.Paragraph>
          「{subject}」被 <Typography.Text strong>{details?.count ?? 0}</Typography.Text> 个未回收场景引用。
        </Typography.Paragraph>
        {hidden ? (
          <Typography.Paragraph type="secondary" data-testid={testid + "-hidden"}>
            引用明细需要 scenario:read 权限，当前看不到是哪些场景——数量照报、明细隐瞒是刻意的，
            请联系有该权限的成员先在场景里解绑（这种情况带 force 后端同样会拒）。
          </Typography.Paragraph>
        ) : (
          <>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {shown.map((s) => (
                <li key={s.scenario_id} data-testid={testid + "-item"}>
                  <Typography.Link href={"#/scene/" + s.scenario_id}>「{s.scenario_name}」</Typography.Link>
                  {s.step_keys.length > 0 && (
                    <Typography.Text type="secondary"> 步骤 {s.step_keys.join("、")}</Typography.Text>
                  )}
                </li>
              ))}
            </ul>
            {(details?.count ?? 0) > shown.length && (
              <Typography.Text type="secondary">…等 {details?.count} 个场景</Typography.Text>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              {blurb}
            </Typography.Paragraph>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function CaseList({ def, envId, perms, onChanged, onCount }: {
  def: ApiDef; envId: string | null; perms: string[];
  onChanged?: () => void; onCount?: (n: number | null) => void;
}) {
  const canCreate = can(perms, "api:case:create");
  const canUpdate = can(perms, "api:case:update");
  const canDelete = can(perms, "api:case:delete");
  const canDebug = can(perms, "api:debug:run");
  const canRun = can(perms, "api:case:run");
  // 列表取失败 ≠ 查到了 0 条（第 7 处同款：datasets/reports/runs/scenes/api/adbCases 都改过，
  // 这里漏了）。failed 同时管三件事：表格空态说人话、Tab 计数改口、上方亮一条不可关的横幅。
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  // 数据集那腿单独一组旗标：它和用例列表是两只独立的 GET，用同一个 failed 会让
  // 「用例取到了、只有数据集没取到」也把整页判成加载失败。
  const [dsFailed, setDsFailed] = useState(false);
  const [dsDenied, setDsDenied] = useState(false);
  const [failed, setFailed] = useState(false);
  // 403 单独一句：刷新的确不会改变结论，而「网络不通」会把缺权限说成等一会儿就好。
  // 两条 403 来路（非成员 / 缺 api:case:read）前端分不出细节，句子按两者并列说。
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<CaseRow | "new" | null>(null);
  const [name, setName] = useState("");
  const [prio, setPrio] = useState("P2");
  const [dsId, setDsId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [touched, setTouched] = useState<OverlayKey[]>([]);
  const [unset, setUnset] = useState<OverlayKey[]>([]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DebugResult | null>(null);
  // 「让 Pilot 分析」的对象名：哪条用例只有 debugOne 知道，故跟着 result 成对存、成对清。
  // 单存 result 再让面板猜名字，猜出来的就是撒谎（§13 纪律 1）。
  const [resultSubject, setResultSubject] = useState<string | null>(null);
  const [debugging, setDebugging] = useState<string | null>(null);
  // D228「运行」：独立执行接口用例（落 api_case run，trigger=manual），与「调试」
  // 共用后端执行链；这里只回一句结论并刷新列表，不抢调试面板的位置。
  const [running, setRunning] = useState<string | null>(null);
  // 回收站视图（§11.4.5/§4.4）：用例能回收，就得看得见、回得来、也能彻底删掉
  const [inRecycled, setInRecycled] = useState(false);
  // D273：批量选择（正常视图=批量回收，回收站视图=批量恢复）。换接口/换视图一律清空：
  // 选中行在另一个视图里根本不可见，留着就是拿看不见的名单按下批量钮。
  const [selected, setSelected] = useState<string[]>([]);
  const [purge, setPurge] = useState<CaseRow | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  // 回收 409「被场景引用」的拦截态（D86）：非空即弹窗，force 成功后清空
  const [blocked, setBlocked] = useState<{ case: CaseRow; details: ScenarioBlockDetails } | null>(null);
  const [blocking, setBlocking] = useState(false);

  // 接口的请求对象 = 继承基线：编辑框拿它当显示值，恢复继承也回到它
  const base = useMemo(() => toDraft(def.request ?? null), [def.request]);
  const dsName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of datasets) m[d.id] = d.name;
    return m;
  }, [datasets]);

  async function load(): Promise<void> {
    setLoading(true);
    setFailed(false);
    try {
      const r = await get<{ items: CaseRow[] }>("/api-cases?project_id=" + encodeURIComponent(def.project_id)
        + "&definition_id=" + encodeURIComponent(def.id)
        + (inRecycled ? "&recycled=true" : ""), { silent: true });
      setRows(r.items);
    } catch (e: unknown) {
      setRows([]); setFailed(true);
      setDenied(e instanceof ApiErr && e.status === 403);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [def.id, def.version, inRecycled]);
  // 换个接口就退出回收站：停在上一个接口的墓碑堆里看新接口，只会让人以为它被删空了
  useEffect(() => { setInRecycled(false); setSelected([]); }, [def.id]);
  // D273：切视图清选择——批量钮只对当前视图的行有意义（回收站的名单不该带进正常视图）
  useEffect(() => { setSelected([]); }, [inRecycled]);
  // 计数徽标只报正常视图：切进回收站不该让列表上的「N 条用例」变成墓碑数。
  // 取失败时报 null 而不是 0：Tab 上「用例(0)」是把「没查到」演成「查到了 0 条」，
  // api.tsx:706 收到 null 就只写「用例」，不带数字。
  useEffect(() => { if (!inRecycled) onCount?.(failed ? null : rows.length); },
    [rows.length, onCount, inRecycled, failed]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await get<{ items: DatasetRow[] }>("/datasets?project_id=" + encodeURIComponent(def.project_id),
          { silent: true });
        setDatasets(r.items);
        setDsFailed(false);
        // dsDenied 不在这里清：缺 api:dataset:read 是身份问题，重拉一百次也不会变成有权限。
      } catch (e: unknown) {
        setDatasets([]);
        setDsFailed(true);
        setDsDenied(e instanceof ApiErr && e.status === 403);
      }
    })();
  }, [def.project_id]);

  function openCreate(): void {
    setEditing("new"); setName(""); setPrio("P2"); setDsId(null);
    // 显示继承来的值（用户看得见将要执行什么），但不写进覆盖层
    setDraft({ ...toDraft(def.request ?? null), assertions: [] });
    setTouched([]); setUnset([]); setResult(null); setResultSubject(null);
  }

  function openEdit(c: CaseRow): void {
    setEditing(c); setName(c.name); setPrio(c.priority); setDsId(c.dataset_id);
    // effective_request 是定义←覆盖的合并结果：编辑时展示真正会发出去的东西
    setDraft(toDraft(c.effective_request ?? def.request ?? null));
    // 断言列表示例自加的追加断言（定义断言在提示里只读列出）
    setDraft((d) => ({ ...d, assertions: (c.assertions ?? []).map((a) => ({ ...a })) as unknown as Assertion[] }));
    const ov = Object.keys(c.request ?? {}) as OverlayKey[];
    setTouched(OVERLAY_KEYS.filter((k) => ov.includes(k)));
    setUnset([]); setResult(null); setResultSubject(null);
  }

  /** 编辑器每次改动：与上一版比，哪些覆盖键变了就标成「已覆盖」。 */
  function editDraft(next: Draft): void {
    const changed = OVERLAY_KEYS.filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(next[k]));
    if (changed.length) {
      setTouched((t) => [...new Set([...t, ...changed])]);
      setUnset((u) => u.filter((k) => !changed.includes(k)));
    }
    setDraft(next);
  }

  function reinherit(k: OverlayKey): void {
    setDraft((d) => ({ ...d, [k]: base[k] }) as Draft);
    setTouched((t) => t.filter((x) => x !== k));
    // 编辑既有覆盖时要点「恢复继承」才算删键：只把显示值改回基线，库里覆盖还在
    setUnset((u) => (u.includes(k) ? u : [...u, k]));
  }

  async function save(): Promise<void> {
    const v = name.trim();
    if (!v) { message.warning("用例名不能为空"); return; }
    if (!draft.url.trim()) { message.warning("URL 为空：接口没有请求对象，用例必须自己填"); return; }
    const full = cleanRequest(fromDraft(draft));
    const overlay: Record<string, unknown> = {};
    for (const k of touched) overlay[k] = full[k];
    setSaving(true);
    try {
      if (editing === "new") {
        await post("/api-cases", {
          project_id: def.project_id, definition_id: def.id, name: v, priority: prio,
          request: Object.keys(overlay).length ? overlay : null,
          assertions: full.assertions, dataset_id: dsId,
        });
        message.success("用例已创建");
      } else if (editing) {
        await patch<CaseRow>("/api-cases/" + editing.id, {
          project_id: def.project_id, name: v, priority: prio,
          request: Object.keys(overlay).length ? overlay : null,
          request_unset: unset.filter((k) => !touched.includes(k)),
          assertions: full.assertions, dataset_id: dsId, dataset_set: true,
        });
        message.success("用例已保存");
      }
      setEditing(null);
      await load();
      onChanged?.();
    } catch { /* toast */ } finally { setSaving(false); }
  }

  async function remove(c: CaseRow): Promise<void> {
    try {
      await post("/api-cases/" + c.id + "/delete", { project_id: def.project_id });
      message.success("用例已放入回收站");
      await load(); onChanged?.();
    } catch (e) {
      // 被场景引用的 409 不是「一句 toast 就完了」的失败：它是保护，details 里点名了
      // 是谁在引用（case_services._blocked）。摆成拦截弹窗，用户才有的可解（D86）。
      const blk = scenarioBlockOf(e);
      if (blk) setBlocked({ case: c, details: blk });
      // 其余错误 client 已 toast
    }
  }

  // force 第二步只对「已看见引用清单」的人开放；hidden 分支弹窗里根本不给这扇钮
  // （后端 case_services.py:269 在 hidden 时连 force 一起拦，UI 不许摆假门）。
  async function forceRemove(): Promise<void> {
    if (!blocked) return;
    setBlocking(true);
    try {
      await post("/api-cases/" + blocked.case.id + "/delete",
        { project_id: def.project_id, force: true });
      message.success("用例已放入回收站（引用它的场景步骤会当场解析失败）");
      setBlocked(null);
      await load(); onChanged?.();
    } catch { /* toast；弹窗保持打开，可取消回场景解绑 */ } finally { setBlocking(false); }
  }

  async function restoreCase(c: CaseRow): Promise<void> {
    try {
      await post("/api-cases/" + c.id + "/restore", { project_id: def.project_id });
      message.success("用例已恢复");
      await load(); onChanged?.();
    } catch { /* toast */ }
  }

  // —— D273 批量回收/恢复（判据在后端：全有或全无；批量不提供 force）——
  const [batchRemoving, setBatchRemoving] = useState(false);
  async function doBatchRemove(): Promise<void> {
    setBatchRemoving(true);
    try {
      await post("/api-cases/batch-delete", { project_id: def.project_id, case_ids: selected });
      message.success("已放入回收站（" + selected.length + " 条用例）");
      setSelected([]);
      await load(); onChanged?.();
    } catch (e) {
      // 与单删的 409 不同，批量的 details 是 blocked 清单（每条各带引用数）：
      // 翻译成弹窗点名，不吞进 toast（api.tsx 的 D251 批量条同口径）。
      const blk = (e instanceof ApiErr
        ? (e.details as { blocked?: { name: string; count: number }[]; reason?: string } | null)
        : null)?.blocked;
      if (blk && blk.length > 0) {
        Modal.error({
          centered: true,
          title: "整批未回收：有用例被场景引用",
          content: (
            <div>
              <p>{blk.map((b) => b.name + "（" + b.count + " 个场景）").join("、")}</p>
              <p>整批一行未动。请先在场景里解除引用；确认要连带断掉场景步骤时，请逐个回收。</p>
            </div>
          ),
        });
      }
      // 其余错误 client 已 toast
    } finally { setBatchRemoving(false); }
  }
  function batchRemove(): void {
    Modal.confirm({
      centered: true,
      title: "把选中的 " + selected.length + " 条用例放入回收站？",
      content: "全有或全无：只要有一条被未回收场景引用，整批都不会删。",
      okText: "放入回收站",
      okButtonProps: { danger: true },
      onOk: doBatchRemove,
    });
  }

  const [batchRestoring, setBatchRestoring] = useState(false);
  async function doBatchRestore(): Promise<void> {
    setBatchRestoring(true);
    try {
      await post("/api-cases/batch-restore", { project_id: def.project_id, case_ids: selected });
      message.success("已恢复（" + selected.length + " 条用例）");
      setSelected([]);
      await load(); onChanged?.();
    } catch { /* client 已 toast；选择保留让用户改名单 */ }
    finally { setBatchRestoring(false); }
  }
  function batchRestore(): void {
    Modal.confirm({
      centered: true,
      title: "恢复选中的 " + selected.length + " 条用例？",
      content: "全有或全无：只要有一条不在回收站，或绑定的数据集已被删除，整批都不会恢复。",
      okText: "恢复",
      onOk: doBatchRestore,
    });
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await post("/api-cases/" + purge.id + "/purge",
        { project_id: def.project_id, confirm_name: purge.name });
      message.success("已彻底删除");
      setPurge(null); setPurgeName("");
      await load(); onChanged?.();
    } catch { /* toast；保持弹窗打开，改名重试或取消 */ } finally { setPurging(false); }
  }

  async function debugOne(c: CaseRow): Promise<void> {
    setDebugging(c.id);
    try {
      const r = await post<DebugResult>("/api-debug", {
        project_id: def.project_id, case_id: c.id, env_id: envId });
      setResult(r); setResultSubject(c.name);
      onChanged?.();
    } catch (e) {
      // 缺变量/不可执行这类前置失败是 422：toast 三秒就没了，用户回头不知道发生了什么，
      // 所以把它摆进结果面板，并给出下一步（缺变量→绑数据集/定义变量；不可执行→补 URL）。
      // 「这类」在后端是两条码：validation_error（缺变量，services.py:432）、
      // validation_failed（不可执行，services.py:397）——少认一条，那条就落回裸 toast。
      if (e instanceof ApiErr
        && (e.code === "validation_error" || e.code === "validation_failed")) {
        const dv = (e.details as { var?: string } | null)?.var;
        // 刻意不给 resultSubject：这条是**前置**失败（请求根本没发出去），面板里的 error
        // 原话已经给了下一步（绑数据集/定义变量）。若挂上「让 Pilot 分析」，草稿会写
        // 「请求本身失败（没拿到响应）」——那是把「没发出去」说成「发了没回」，一句假话。
        setResultSubject(null);
        setResult({
          run_id: "", ok: false, passed: false, status: null, headers: {}, body_text: null,
          truncated: false, body_size: 0, elapsed_ms: 0, assertions: [], env_name: null,
          error: e.message + (dv
            ? "：绑一个数据集（执行时取首行供给变量）或在环境/全局配置里定义 " + dv
            : e.code === "validation_failed"
              ? "：编辑用例补上 URL（或给接口定义补上请求对象）"
              : ""),
        });
      }
    } finally { setDebugging(null); }
  }

  async function runOne(c: CaseRow): Promise<void> {
    setRunning(c.id);
    try {
      const r = await post<{ run_id: string; ok: boolean; passed: boolean; status: number | null }>(
        "/api-cases/" + c.id + "/run",
        { project_id: def.project_id, case_id: c.id, env_id: envId });
      const code = r.status === null ? "无响应" : "HTTP " + r.status;
      if (r.passed) message.success("执行通过（" + code + "）");
      else message.warning("执行完成：断言未通过（" + code + "）");
      onChanged?.();
    } catch { /* toast；失败原因由 client 统一弹出 */ } finally { setRunning(null); }
  }

  const inherited = (def.request?.assertions ?? []) as { type: string; path?: string }[];
  return (
    <div data-testid="case-panel">
      <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
        <Typography.Text type="secondary">
          用例默认完全继承接口：只改要改的，其余跟着接口走；断言追加在接口断言之后。
        </Typography.Text>
        {(canCreate && !inRecycled) || canUpdate || canDelete ? (
          <Space size={8}>
            {canCreate && !inRecycled && (
              <Button size="small" type="primary" ghost icon={<PlusOutlined />}
                data-testid="case-new" onClick={openCreate}>新建用例</Button>
            )}
            {(canUpdate || canDelete) && (
              <Button size="small" type="text" icon={inRecycled ? <UndoOutlined /> : <RestOutlined />}
                data-testid="case-recycled-toggle"
                onClick={() => { setInRecycled(!inRecycled); setResult(null); setResultSubject(null); }}>
                {inRecycled ? "退出回收站" : "回收站"}
              </Button>
            )}
          </Space>
        ) : null}
      </Space>
      {failed && (
        // 刻意不给 ×：这条横幅是「这一屏没查到」的唯一证据，关掉就等于把失败抹成空列表。
        // 同 scenes.tsx:416 的口径（第十五轮把 closable 摘掉的那一批）。
        <Alert type="error" showIcon style={{ marginBottom: 8 }} data-testid="case-load-error"
          message={inRecycled ? "回收站列表没取到" : "用例列表没取到"}
          description={denied ? "你已不是本项目成员或没有读取这个接口用例的权限，刷新不会改变结论"
            : "可能是网络不通或后端没起，恢复后重新进入本接口即可"} />
      )}
      {/* D273 批量条（api.tsx 的 D251/D252 同口径）：选中才出现；
          正常视图 [批量回收]，回收站 [批量恢复]——彻底删除仍要求逐字确认名称，不做批量。 */}
      {canDelete && !inRecycled && selected.length > 0 && (
        <Space style={{ marginBottom: 8 }} data-testid="case-batch-bar">
          <Typography.Text>已选 {selected.length} 项</Typography.Text>
          <Button size="small" danger icon={<DeleteOutlined />} data-testid="case-batch-delete"
            loading={batchRemoving} onClick={batchRemove}>批量回收</Button>
          <Button size="small" data-testid="case-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
        </Space>
      )}
      {canUpdate && inRecycled && selected.length > 0 && (
        <Space style={{ marginBottom: 8 }} data-testid="case-batch-bar">
          <Typography.Text>已选 {selected.length} 项</Typography.Text>
          <Button size="small" type="primary" icon={<ReloadOutlined />} data-testid="case-batch-restore"
            loading={batchRestoring} onClick={batchRestore}>批量恢复</Button>
          <Button size="small" data-testid="case-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
        </Space>
      )}
      <Table size="small" rowKey="id" loading={loading} dataSource={rows}
        rowSelection={(!inRecycled && canDelete) || (inRecycled && canUpdate) ? {
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
          preserveSelectedRowKeys: false,
        } : undefined}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={failed
            ? (inRecycled ? "回收站没取到，以上方的加载失败提示为准" : "用例没取到，以上方的加载失败提示为准")
            : (inRecycled ? "回收站是空的" : "还没有用例")} /> }}
        columns={[
          { title: "用例", dataIndex: "name", render: (v: string) => <Typography.Text data-testid="case-row">{v}</Typography.Text> },
          { title: "优先级", dataIndex: "priority", width: 80, render: (v: string) => <Tag color={PRIO_COLOR[v] ?? "default"}>{v}</Tag> },
          { title: "覆盖", key: "over", width: 140, render: (_: unknown, r: CaseRow) => {
              const keys = OVERLAY_KEYS.filter((k) => k in (r.request ?? {}));
              return keys.length
                ? <Tag data-testid="case-overlay">{keys.map((k) => KEY_LABEL[k]).join("/")}</Tag>
                : <Tag color="blue" data-testid="case-inherit">全继承</Tag>;
            } },
          { title: "数据集", key: "ds", width: 120, render: (_: unknown, r: CaseRow) => (
              r.dataset_id
                ? <Tag color="purple" data-testid="case-dataset-tag">{
                    dsDenied ? "无数据集读取权限"
                      : dsFailed ? "数据集没取到"
                      : dsName[r.dataset_id] ?? "已删除"
                  }</Tag>
                : <Typography.Text type="secondary">—</Typography.Text>
            ) },
          { title: "追加断言", key: "as", width: 88, render: (_: unknown, r: CaseRow) => `${(r.assertions ?? []).length} 条` },
          { title: "可执行", key: "ex", width: 88, render: (_: unknown, r: CaseRow) => (
              r.effective_request ? <Tag color="green">可执行</Tag> : <Tag color="orange">缺 URL</Tag>
            ) },
          // 列宽含格子 padding 8×2：回收行自然宽 172（恢复 64 + 彻底删除 92 + 2×gap8）→ 192；
          // 普通行 200（调试 64 + 运行 64 + 两个图标钮 28×2 + 3×gap8）→ 224。small 钮宽 = 内文 + 图标14+8 + 7×2。
          { title: "", key: "ops", width: inRecycled ? 192 : 224, render: (_: unknown, r: CaseRow) => (
              <Space size={8}>
                {!inRecycled && canRun && (
                  <Button size="small" icon={<PlayCircleOutlined />} data-testid="case-run"
                    loading={running === r.id}
                    onClick={() => void runOne(r)}>运行</Button>
                )}
                {!inRecycled && canDebug && (
                  <Button size="small" icon={<BugOutlined />} data-testid="case-debug" loading={debugging === r.id}
                    onClick={() => void debugOne(r)}>调试</Button>
                )}
                {!inRecycled && canUpdate && (
                  <Button size="small" type="text" icon={<EditOutlined />} data-testid="case-edit"
                    aria-label={"编辑" + r.name} onClick={() => openEdit(r)} />
                )}
                {!inRecycled && canDelete && (
                  <Popconfirm title="把这个用例放入回收站？" okText="回收" cancelText="取消" okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(r)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={"回收" + r.name} />
                  </Popconfirm>
                )}
                {inRecycled && canUpdate && (
                  <Button size="small" type="text" icon={<UndoOutlined />} data-testid="case-restore"
                    aria-label={"恢复" + r.name} onClick={() => void restoreCase(r)}>恢复</Button>
                )}
                {inRecycled && canDelete && (
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} data-testid="case-purge"
                    aria-label={"彻底删除" + r.name}
                    onClick={() => { setPurge(r); setPurgeName(""); }}>彻底删除</Button>
                )}
              </Space>
            ) },
        ]}
      />
      {result && (
        <div data-testid="case-debug-panel">
          <DebugPanel result={result} subject={resultSubject} />
        </div>
      )}
      {/* 960 = 浮层五档：920 不在档上，内嵌 RequestEditor 也吃宽度。 */}
      <Modal open={editing !== null} width={960} centered destroyOnHidden
        title={editing === "new" ? "新建用例 · 继承自「" + def.name + "」"
               : "编辑用例" + (editing ? " · " + editing.name : "")}
        okText={editing === "new" ? "创建" : "保存"} cancelText="取消" confirmLoading={saving}
        onCancel={() => setEditing(null)} onOk={() => void save()}>
        {/* rc-dialog 不透传未知 props，testid 只能挂在 body 包裹层上 */}
        <div data-testid="case-modal">
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Alert type="info" showIcon data-testid="case-hint"
            message={touched.length
              ? "已覆盖：" + touched.map((k) => KEY_LABEL[k]).join("、") + "（其余继承接口）"
              : "完全继承接口「" + def.name + "」的请求对象"}
            description={touched.length
              ? "改动只存这几项，接口改了其余自动跟着变；点下面的「恢复继承」把某一项交还给接口。"
              : "下面的值是接口当前请求；改动哪一项，执行时就用哪一项覆盖。"} />
          <Space wrap>
            <Input data-testid="case-name" style={{ width: 300 }} maxLength={200} value={name}
              placeholder="用例名，如「已支付订单」" onChange={(e) => setName(e.target.value)} />
            <Select style={{ width: 100 }} value={prio} options={PRIORITIES.map((p) => ({ value: p, label: p }))}
              onChange={setPrio} />
            <Select data-testid="case-dataset" allowClear style={{ width: 260 }} value={dsId ?? undefined}
              placeholder="数据集（执行时取首行做变量）"
              notFoundContent={dsDenied ? "没有数据集读取权限"
                : dsFailed ? "数据集没取到（不是项目里没有）" : "没有匹配的数据集"}
              options={datasets.map((d) => ({ value: d.id, label: d.name + "（" + d.row_count + " 行）" }))}
              onChange={(v) => setDsId(v ?? null)} />
          </Space>
          {touched.length > 0 && (
            <Space wrap size={8}>
              <Typography.Text type="secondary">恢复继承：</Typography.Text>
              {touched.map((k) => (
                <Button key={k} size="small" data-testid={"case-unset-" + k}
                  onClick={() => reinherit(k)}>恢复 {KEY_LABEL[k]}</Button>
              ))}
            </Space>
          )}
          <RequestEditor value={draft} onChange={editDraft} testIdPrefix="case"
            assertLabel="追加断言" assertHint={"这些断言排在接口 " + inherited.length + " 条断言之后一起判定"} />
        </Space>
        </div>
      </Modal>
      {/* 彻底删除（§11.4.18）：不可逆，手输用例名；服务端同样硬校验，不靠前端拦 */}
      <Modal open={purge !== null} onCancel={() => setPurge(null)} destroyOnHidden width={560} centered
        title="彻底删除用例？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "case-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}>
        <Typography.Paragraph>
          用例 <Typography.Text code>{purge?.name}</Typography.Text> 将被物理删除，
          <Typography.Text strong>无法恢复</Typography.Text>；接口本身与运行记录不受影响。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入用例名以确认。
        </Typography.Paragraph>
        <Input data-testid="case-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>

      {/* 回收被场景引用 409（D86）：点名引用者与命中步骤；明细可见才给 force 第二步 */}
      <ScenarioRefsBlockModal
        subject={blocked?.case.name ?? ""}
        details={blocked?.details ?? null}
        testid="case-scenario-block"
        busy={blocking}
        maySeeRefs={can(perms, "scenario:read")}
        blurb="回收不会删除用例，放进回收站后引用它的场景步骤会当场解析失败（restore 后原样回来）；也可先在场景里改引用。"
        onCancel={() => setBlocked(null)}
        onForce={() => void forceRemove()}
      />
    </div>
  );
}
