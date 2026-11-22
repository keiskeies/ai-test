// ADB 用例详情页 = §7.3 步骤编辑器 + 调试面板（1D T9，§11.4.12/§11.5.5）。
// uiCaseDetail.tsx 的近亲孪生：列表骨架走共用件 shared/StepListEditor（「共用一个组件」
// 是蓝图原话），参数面板 adb/StepParams（CFG_SCHEMA 生成控件，shell→懒载 Monaco）。
// 路由级懒加载：本页经 StepParams 静态链到懒载 Monaco——与 uiCaseDetail 同族规矩
// （app.tsx：monaco chunk 不随首屏出货）。
// 调试语义与 UI 孪生同规（后端 AdbCaseDebugIn 只有 {project_id, case_id}，跑库里已保存
// 的序列）：有未保存修改时调试先代存草稿，并在面板与 toast 说出口，绝不静默代存。
// ADB 侧的三处独有语义（都在界面上说清，不藏）：
// ① 设备策略 = default_device：serial（指定设备）或 null（任一空闲，执行时锁一台）。
//    存期不校验存在性（设备还没登记是正常顺序，§4.5 与 env 同款），跑的时候才解析。
// ② 调试 vs 执行（D17 的两副面孔）：调试绝不排队——人在等一句答复；「执行」走 enqueue
//    （后台 run），**只有指定设备**抢不到锁才 FIFO 排队，任一空闲是每轮抢占失败即退队
//    重轮询，不入队也没有位次（D136，debug_services.py:382-384/:401-404）。
//    排队位次只认后端的真实读数（device_queued 事件），本页一个估算数字都不出现；
//    位次载荷只进运行事件/场景步 detail，全仓没有任何界面渲染它——文案必须照实说
//    「记在运行事件里，当前界面未展示」，不许假称「在运行记录里看」（D136）。
// ③ 场景引用 Tab：adb_case 已是可拖上画布的 kind（T8），删除保护归后端，这里给只读
//    事实——被哪些场景引用、命中哪些步骤 key。
// 只读成员（无 adb:case:update）：保存/调试/执行/新建/行操作一个都不渲染（隐藏不是禁用）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Input, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message,
} from "antd";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import PermEmpty from "../components/PermEmpty";
import { adbApi } from "../api/adb";
import { adbCaseApi, type AdbCaseReferencesOut } from "../api/adbCase";
import StepListEditor, { type StepDescriptor, type StepIssue } from "../shared/StepListEditor";
import StepParams from "../adb/StepParams";
import DeviceSelect from "../adb/DeviceSelect";
import AdbDebugPanel from "../adb/AdbDebugPanel";
import {
  LABELS, INSERTABLE_ADB, newStep, summary, validateSteps, type AdbStep,
} from "../adb/commands";
import type { AdbDebugResult } from "../api/adbCase";

const PRIO_OPTIONS = ["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }));

/** 设备策略的两态：null = 任一空闲；serial = 指定设备（default_device 的线上传输形状）。 */
type DevPolicy = "any" | "pinned";

function Editor({ caseId }: { caseId: string | "new" }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpdate = can(perms, "adb:case:update");
  // 调试与执行共用 adb:case:run 位（后端 debug/run 两个端点都 require 它）
  const canRun = can(perms, "adb:case:run");

  const isNew = caseId === "new";
  const [loading, setLoading] = useState(!isNew);
  // 404/410（不存在/已回收）与「其它失败」分开记：403 另有 PermEmpty 兜（见下面的
  // forbidden 分支），把三种原因并成一句「不存在、已被回收，或没有读取权限」，
  // 等于每次后端故障都替用户下一次「你没权限」的结论。
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // D38 权限空页：详情被 403 拒时落地页讲清楚（而不是裸 Alert），位名只认后端原话
  const [forbidden, setForbidden] = useState<ApiErr | null>(null);
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("P2");
  const [steps, setSteps] = useState<AdbStep[]>([]);
  // 设备策略草稿：policy + 指定时的 serial（两段式：切到「指定设备」但还没选，
  // 与「任一空闲」在线上不可分辨都是 default_device=null——靠 policy 草稿位区分）
  const [policy, setPolicy] = useState<DevPolicy>("any");
  const [deviceSerial, setDeviceSerial] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ serial: string; name: string; online: boolean }[]>([]);
  const [savedJson, setSavedJson] = useState("");
  const [saveIssues, setSaveIssues] = useState<StepIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [refs, setRefs] = useState<AdbCaseReferencesOut | null>(null);

  // 调试（同步等结果：AdbDebugOut 一把给全，无 SSE）
  const [dbgOpen, setDbgOpen] = useState(false);
  const [dbgRunning, setDbgRunning] = useState(false);
  const [dbgResult, setDbgResult] = useState<AdbDebugResult | null>(null);
  const [dbgError, setDbgError] = useState<string | null>(null);
  const [dbgNote, setDbgNote] = useState<string | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  const dirty = useMemo(
    () => savedJson !== JSON.stringify({ name, priority, policy, deviceSerial, steps }),
    [savedJson, name, priority, policy, deviceSerial, steps],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (isNew) {
      setSavedJson(JSON.stringify({ name: "", priority: "P2", policy: "any", deviceSerial: null, steps: [] }));
      return;
    }
    setLoading(true); setMissing(false); setLoadFailed(false); setForbidden(null);
    void (async () => {
      try {
        const c = await adbCaseApi.getCase(pid, caseId);
        setName(c.name); setPriority(c.priority);
        setPolicy(c.default_device ? "pinned" : "any");
        setDeviceSerial(c.default_device);
        setSteps((c.steps ?? []) as AdbStep[]);
        setSavedJson(JSON.stringify({ name: c.name, priority: c.priority,
          policy: c.default_device ? "pinned" : "any", deviceSerial: c.default_device,
          steps: c.steps ?? [] }));
      } catch (e) {
        // toast 已在 client 里弹；这里补一个页面级真相，不让内容区空白
        // 只有 404/410 才敢讲「不存在/已被回收」；其余失败就是没取到，别替它下结论。
        if (e instanceof ApiErr && (e.status === 404 || e.status === 410)) setMissing(true);
        else setLoadFailed(true);
        if (e instanceof ApiErr && e.status === 403) setForbidden(e);
      } finally { setLoading(false); }
    })();
  }, [pid, caseId, isNew]);

  // 设备候选（迷你卡片语义按 §11.5.5 收窄成下拉：offline 也列出——存期不校验存在性，
  // 但「离线」如实标出来；拉不到就空列表 + 空态，不假装有设备）
  useEffect(() => {
    void (async () => {
      try {
        const r = await adbApi.listDevices({ project_id: pid, size: 200 });
        setDevices(r.items.map((d) => ({
          serial: d.serial, name: d.name, online: d.last_state?.online === true,
        })));
      } catch { /* 空下拉 + 「还没有设备」空态，client 已 toast */ }
    })();
  }, [pid]);

  // 场景引用（详情面板的只读事实；拉不到不装「没有引用」，显示重试入口）
  const [refsError, setRefsError] = useState(false);
  const loadRefs = useCallback(async () => {
    if (isNew) return;
    setRefsError(false);
    try { setRefs(await adbCaseApi.references(pid, caseId)); }
    catch { setRefsError(true); }
  }, [pid, caseId, isNew]);
  useEffect(() => { void loadRefs(); }, [loadRefs]);

  // 共用件的差异全部走这张 descriptor（§11.4.12）：ADB 侧的词表、id 前缀 a、
  // 参数面板 = StepParams（CFG_SCHEMA 生成控件；无元素库，ElementPicker 分支天然缺席）。
  const descriptor = useMemo<StepDescriptor<AdbStep>>(() => ({
    labels: LABELS,
    insertable: INSERTABLE_ADB,
    defaultAppendType: "connect",
    makeRow: newStep,
    idPrefix: "a",
    summary,
    validate: validateSteps,
    renderParams: (s, { testIdPrefix, onChange }) => (
      <StepParams step={s} testIdPrefix={testIdPrefix} onChange={onChange} />
    ),
  }), []);

  /** 保存草稿；成功返回真（并处理 new→详情路由切换），失败把 422 details.issues 摆出来。 */
  const persist = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setSaveIssues(null);
    const dev = policy === "pinned" ? deviceSerial : null;
    try {
      if (isNew) {
        if (!name.trim()) { message.warning("用例名必填"); setSaving(false); return false; }
        const c = await adbCaseApi.createCase({
          project_id: pid, name: name.trim(), priority, enabled: true,
          steps: steps as unknown as Record<string, unknown>[],
          default_device: dev, project_public: true,
        });
        setSavedJson(JSON.stringify({ name: name.trim(), priority, policy, deviceSerial: dev, steps }));
        message.success("用例已创建");
        nav("/adb/cases/" + c.id, { replace: true });
        return true;
      }
      const c = await adbCaseApi.updateCase(caseId, {
        project_id: pid, name: name.trim(), priority,
        steps: steps as unknown as Record<string, unknown>[], steps_set: true,
        default_device: dev, default_device_set: true,
      });
      setSavedJson(JSON.stringify({ name: c.name, priority: c.priority,
        policy: c.default_device ? "pinned" : "any", deviceSerial: c.default_device,
        steps: c.steps ?? [] }));
      message.success("已保存");
      return true;
    } catch (e) {
      if (e instanceof ApiErr && Array.isArray((e.details as { issues?: unknown })?.issues)) {
        setSaveIssues((e.details as { issues: StepIssue[] }).issues);
      } // 其余错误 client 已 toast；保存失败就是没保存，dirty 保持
      return false;
    } finally { setSaving(false); }
  }, [isNew, pid, name, priority, deviceSerial, policy, steps, caseId, nav]);

  /** 调试（见文件头：有未保存修改先代存草稿，并在界面上说出口；占用 422 原话直出）。 */
  const debug = useCallback(async () => {
    if (isNew) {
      // 新建还没入库：没有 case 行可 debug，先把用例建出来——这步必须让用户知道
      if (!name.trim()) { message.warning("用例名必填"); return; }
      const okNew = await persist();
      if (!okNew) return;
      // persist 走 replace 导航，本组件会按新 id 重新挂载；这里直接返回，
      // 用户在新页面再点一次调试（不追导航后的异步，避免对旧 caseId 发起）
      message.info("用例已创建，再点一次「调试」即可运行");
      return;
    }
    let note = "调试跑的是已保存的步骤序列（必选空闲设备，占用当场拒绝、绝不排队）。";
    if (dirtyRef.current) {
      const ok = await persist();
      if (!ok) return;
      note += "本次发起前已代为保存屏幕上的修改（已保存的步骤序列）。";
    } else {
      note += "草稿与库一致，未做任何改动。";
    }
    setDbgOpen(true); setDbgRunning(true); setDbgResult(null); setDbgError(null);
    setDbgNote(note); setDebugBusy(true);
    try {
      const r = await adbCaseApi.debugCase(pid, caseId);
      setDbgResult(r);
    } catch (e) {
      setDbgError(e instanceof ApiErr ? e.message : "调试发起失败");
    } finally {
      setDbgRunning(false); setDebugBusy(false);
    }
  }, [isNew, name, persist, pid, caseId]);

  /** 执行（enqueue 投 worker）：立即返回 queued 的 run_id。排队语义按策略分叉（D136）：
   *  指定设备抢不到锁才 FIFO 排队；任一空闲全部占用时轮询等待，不排队也没有位次。
   *  位次载荷（device_queued）全仓没有任何界面渲染它，文案只说它记在运行事件里。 */
  const enqueueRun = useCallback(async () => {
    if (isNew) { message.warning("用例需先保存入库才能执行"); return; }
    setEnqueuing(true);
    try {
      const r = await adbCaseApi.runCase(pid, caseId);
      message.success(policy === "pinned"
        ? "已投执行队列（run " + r.run_id.slice(0, 8) + "）——指定设备占用时会按 FIFO 排队；真实位次记在运行事件里（当前界面未展示）"
        : "已投执行队列（run " + r.run_id.slice(0, 8) + "）——设备占用时会自动挑空闲设备；全部占用时轮询等待，不排队");
      nav("/runs?run=" + r.run_id);
    } catch { /* 503 broker 不可达等：client 已 toast 原话 */ }
    finally { setEnqueuing(false); }
  }, [isNew, pid, caseId, nav, policy]);

  if (loading) return <Spin style={{ display: "block", margin: "12vh auto" }} />;
  if (forbidden) {
    // D38：403 = 权限空页（含直接敲 URL 与列表点进来两条路）
    return <PermEmpty error={forbidden} projectName={project?.name ?? ""} context="查看该 ADB 用例" />;
  }
  if (missing) {
    return (
      <Alert type="warning" showIcon data-testid="adb-case-detail-missing"
        message="用例加载失败"
        description="后端回「不存在」：这条 ADB 用例已被回收或从未存在——以上方刚才的错误提示为准。" />
    );
  }
  if (loadFailed) {
    return (
      <Alert type="warning" showIcon data-testid="adb-case-detail-failed"
        message="用例加载失败"
        description="这条用例没取到（后端没回「不存在」，也还没到没权限那步）——与用例本身无关，重试或看后端日志。" />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 120px)" }}>
      <Space wrap size={8} style={{ marginBottom: 10 }} data-testid="adb-case-meta">
        <Input data-testid="case-name" style={{ width: 240 }} maxLength={200} value={name}
          disabled={!canUpdate} placeholder="用例名（项目内唯一）" onChange={(e) => setName(e.target.value)} />
        <Select data-testid="case-priority" style={{ width: 96 }} value={priority}
          disabled={!canUpdate} options={PRIO_OPTIONS} onChange={setPriority} />
        {/* 设备策略（§11.5.5 原话：指定设备 / 任一空闲）。存期不校验设备存在性——
            「先存草稿、设备还没登记」是正常顺序，跑的时候才解析并如实报错。 */}
        <Segmented data-testid="case-device-policy" disabled={!canUpdate}
          options={[{ value: "any", label: "任一空闲设备" }, { value: "pinned", label: "指定设备" }]}
          value={policy}
          onChange={(v) => {
            const p = v as DevPolicy;
            setPolicy(p);
            if (p === "any") setDeviceSerial(null);
            else if (deviceSerial === null && devices.length > 0) setDeviceSerial(devices[0].serial);
          }} />
        {policy === "pinned" && (
          <DeviceSelect devices={devices} value={deviceSerial} disabled={!canUpdate}
            onChange={setDeviceSerial} />
        )}
        {policy === "pinned" && deviceSerial !== null
          && !devices.some((d) => d.serial === deviceSerial) && (
          <Tooltip title="库里存的 serial 在当前设备清单里没有——能存（存期不校验），但执行时会如实报「默认设备不在可用设备里」">
            <Tag color="orange" data-testid="adb-case-device-unbound">设备未登记</Tag>
          </Tooltip>
        )}
        <span style={{ flex: 1 }} />
        {canUpdate && (
          <Button type="primary" data-testid="adb-case-save" loading={saving} onClick={() => void persist()}>
            保存{dirty ? "（有未保存修改）" : ""}
          </Button>
        )}
        {canRun && (
          <Tooltip title={isNew ? "新建用例需先保存入库，再点调试"
            : "空闲设备真跑一遍，同步等结果（调试跑默认不在报告中心——那边右上角开「含调试」就能看到；设备占用时不排队）"}>
            <Button data-testid="adb-case-debug" loading={debugBusy} onClick={() => void debug()}>调试</Button>
          </Tooltip>
        )}
        {canRun && (
          <Tooltip title={policy === "pinned"
            ? "正式执行（投后台 run；这台设备占用会 FIFO 排队，位次记在运行事件里——当前界面未展示）"
            : "正式执行（投后台 run；任一空闲不排队：占用时自动换空闲设备，全忙则轮询等待）"}>
            <Button data-testid="adb-case-run" loading={enqueuing} onClick={() => void enqueueRun()}>执行</Button>
          </Tooltip>
        )}
      </Space>

      <StepListEditor descriptor={descriptor} steps={steps} onChange={setSteps}
        canUpdate={canUpdate} saveIssues={saveIssues} dirty={dirty} />

      {/* 场景引用（只读事实；adb_case 上画布后「这条用例被谁用了」必须看得见） */}
      {!isNew && (
        <div style={{ marginTop: 10 }} data-testid="adb-case-refs">
          <Typography.Text strong style={{ fontSize: 12 }}>场景引用</Typography.Text>
          {refsError ? (
            <Space size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>引用清单没拉到</Typography.Text>
              <Button size="small" type="link" onClick={() => void loadRefs()}>重试</Button>
            </Space>
          ) : refs === null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}> 加载中…</Typography.Text>
          ) : refs.items.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {refs.details_hidden ? "被场景引用中（你没有场景读取权限，明细隐瞒）" : "还没有场景引用这条用例"}
            </Typography.Text>
          ) : (
            <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {refs.items.map((it) => (
                <li key={it.scenario_id} data-testid="adb-case-ref">
                  <Typography.Link href={"#/scene/" + it.scenario_id}>{it.scenario_name}</Typography.Link>
                  {it.step_keys.length > 0 && (
                    <Typography.Text type="secondary">（步骤 {it.step_keys.join("、")}）</Typography.Text>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dbgOpen && (
        <AdbDebugPanel projectId={pid} result={dbgResult} running={dbgRunning}
          error={dbgError} note={dbgNote} onClose={() => setDbgOpen(false)} />
      )}
    </div>
  );
}

export default function AdbCaseDetailPage() {
  const { project } = useAuth();
  const { id } = useParams();
  return (
    <div data-testid="page-adb-case-detail">
      <PageHead title="ADB 用例详情" />
      <ProjectGate>{project ? <Editor caseId={id ?? "new"} /> : null}</ProjectGate>
    </div>
  );
}
