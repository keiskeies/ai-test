// UI 用例详情页 = 命令列表编辑器（T17，§11.4.12；1D T9 起列表骨架换成共用件
// shared/StepListEditor——「UI 用例 / ADB 用例共用一个组件」是蓝图原话，骨架只留一份）。
// 路由级懒加载：本页静态引 antd Dropdown/编辑器全套，chunk 不随首屏出货（app.tsx 的既有规矩）。
// 数据流：草稿（steps + 元信息）在本页 state；所有列表变更走 commands.ts 的纯 reducer；
// 保存走 PATCH（steps_set=true）。**调试语义的落地差异（计划 vs 现实，必须说出口）**：
// 蓝图要「跑屏幕那份草稿」（1B §5.5），但后端 UiCaseDebugIn 只有 {project_id, case_id}
// ——没有 ScenarioDebugIn 那样的 graph 入参，调试跑的是库里已保存的序列（backend 文件
// 本窗口不碰）。前端把这个语义如实兑现：调试时若有未保存修改，先保存再跑，
// 并在面板与 toast 写明「本次发起前已代为保存」。绝不静默代存，也不演「跑了没存的东西」。
// 复制/粘贴是**页内命令剪贴板**（§11.4.12 的「剪贴板: [粘贴(2)]」），不是 navigator.clipboard。
// 行「启用勾选」不做：执行核没有 per-command disable 语义（ui_core 不读这类字段），
// 画一个勾了不生效的勾选框就是假控件（§13 纪律 1），差异记录上报。
// 只读成员（无 ui:case:update）：保存/调试/新建/行操作**一个都不渲染**（隐藏不是禁用）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Input, Select, Space, Spin, Tooltip, Typography, message } from "antd";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import PermEmpty from "../components/PermEmpty";
import EnvSelect from "../api/EnvPanel";
import { uiApi } from "../api/ui";
import CommandParams from "../ui/CommandParams";
import UiDebugPanel from "../ui/UiDebugPanel";
import StepListEditor, { type StepDescriptor, type StepIssue } from "../shared/StepListEditor";
import {
  LABELS, INSERTABLE_UI, newCommand, summary, validateCommands, type UiCommand,
} from "../ui/commands";
import type { UiDebugResult } from "../ui/debugRows";

const PRIO_OPTIONS = ["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }));

function Editor({ caseId }: { caseId: string | "new" }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpdate = can(perms, "ui:case:update");
  const canDebug = can(perms, "ui:case:debug");

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
  const [envId, setEnvId] = useState<string | null>(null);
  const [steps, setSteps] = useState<UiCommand[]>([]);
  const [savedJson, setSavedJson] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [saveIssues, setSaveIssues] = useState<StepIssue[] | null>(null);
  const [saving, setSaving] = useState(false);

  // 调试（同步等结果：UiDebugOut 一把给全，无 SSE）
  const [dbgOpen, setDbgOpen] = useState(false);
  const [dbgRunning, setDbgRunning] = useState(false);
  const [dbgResult, setDbgResult] = useState<UiDebugResult | null>(null);
  const [dbgError, setDbgError] = useState<string | null>(null);
  const [dbgNote, setDbgNote] = useState<string | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);

  const dirty = useMemo(
    () => savedJson !== JSON.stringify({ name, priority, envId, steps }),
    [savedJson, name, priority, envId, steps],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (isNew) {
      setSavedJson(JSON.stringify({ name: "", priority: "P2", envId: null, steps: [] }));
      return;
    }
    setLoading(true); setMissing(false); setLoadFailed(false); setForbidden(null);
    void (async () => {
      try {
        const c = await uiApi.getCase(pid, caseId);
        setName(c.name); setPriority(c.priority); setEnvId(c.env_id ?? null);
        setSteps((c.steps ?? []) as UiCommand[]);
        setSavedJson(JSON.stringify({ name: c.name, priority: c.priority, envId: c.env_id ?? null,
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

  // 元素名表：行摘要显示名而不是 id（§11.4.12）；选择器新选/新建的即时回填走 onElementNames
  useEffect(() => {
    void (async () => {
      try {
        const r = await uiApi.listElements({ project_id: pid, size: 200 });
        const m: Record<string, string> = {};
        for (const e of r.items) m[e.id] = e.name;
        setNames(m);
      } catch { /* 名字回落成「元素 <id>」，summary 已处理 */ }
    })();
  }, [pid]);

  // 共用件的差异全部走这张 descriptor（§11.4.12）：UI 侧的词表、id 前缀 u、
  // 参数面板 = CommandParams（元素选择器分支是 UI 专属，ADB 侧换一套控件 kinds）。
  const descriptor = useMemo<StepDescriptor<UiCommand>>(() => ({
    labels: LABELS,
    insertable: INSERTABLE_UI,
    defaultAppendType: "open",
    makeRow: newCommand,
    idPrefix: "u",
    summary: (s) => summary(s, names),
    validate: validateCommands,
    renderParams: (s, { testIdPrefix, onChange }) => (
      <CommandParams cmd={s} testIdPrefix={testIdPrefix}
        onChange={onChange}
        onElementNames={(n, id) => setNames((m) => ({ ...m, [id]: n }))} />
    ),
  }), [names]);

  /** 保存草稿；成功返回真（并处理 new→详情路由切换），失败把 422 details.issues 摆出来。 */
  const persist = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setSaveIssues(null);
    try {
      if (isNew) {
        if (!name.trim()) { message.warning("用例名必填"); setSaving(false); return false; }
        const c = await uiApi.createCase({
          project_id: pid, name: name.trim(), priority, enabled: true,
          steps: steps as unknown as Record<string, unknown>[], env_id: envId,
          module_id: null, project_public: true,
        });
        setSavedJson(JSON.stringify({ name: name.trim(), priority, envId, steps }));
        message.success("用例已创建");
        nav("/ui/cases/" + c.id, { replace: true });
        return true;
      }
      const c = await uiApi.updateCase(caseId, {
        project_id: pid, name: name.trim(), priority, steps: steps as unknown as Record<string, unknown>[],
        steps_set: true, env_id: envId, env_set: true, module_set: false,
      });
      setSavedJson(JSON.stringify({ name: c.name, priority: c.priority, envId: c.env_id ?? null,
        steps: c.steps ?? [] }));
      message.success("已保存");
      return true;
    } catch (e) {
      if (e instanceof ApiErr && Array.isArray((e.details as { issues?: unknown })?.issues)) {
        setSaveIssues((e.details as { issues: StepIssue[] }).issues);
      } // 其余错误 client 已 toast；保存失败就是没保存，dirty 保持
      return false;
    } finally { setSaving(false); }
  }, [isNew, pid, name, priority, envId, steps, caseId, nav]);

  /** 调试（见文件头：有未保存修改先代存草稿，并在界面上说出口）。 */
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
    let note = "调试跑的是已保存的命令序列。";
    if (dirtyRef.current) {
      const ok = await persist();
      if (!ok) return;
      note += "本次发起前已代为保存屏幕上的修改（已保存的命令序列）。";
    } else {
      note += "草稿与库一致，未做任何改动。";
    }
    setDbgOpen(true); setDbgRunning(true); setDbgResult(null); setDbgError(null);
    setDbgNote(note); setDebugBusy(true);
    try {
      const r = await uiApi.debugCase(pid, caseId);
      setDbgResult(r);
    } catch (e) {
      setDbgError(e instanceof ApiErr ? e.message : "调试发起失败");
    } finally {
      setDbgRunning(false); setDebugBusy(false);
    }
  }, [isNew, name, persist, pid, caseId]);

  if (loading) return <Spin style={{ display: "block", margin: "12vh auto" }} />;
  if (forbidden) {
    // D38：403 = 权限空页（含直接敲 URL 与列表点进来两条路）
    return <PermEmpty error={forbidden} projectName={project?.name ?? ""} context="查看该 UI 用例" />;
  }
  if (missing) {
    return (
      <Alert type="warning" showIcon data-testid="ui-case-detail-missing"
        message="用例加载失败"
        description="后端回「不存在」：这条 UI 用例已被回收或从未存在——以上方刚才的错误提示为准。" />
    );
  }
  if (loadFailed) {
    return (
      <Alert type="warning" showIcon data-testid="ui-case-detail-failed"
        message="用例加载失败"
        description="这条用例没取到（后端没回「不存在」，也还没到没权限那步）——与用例本身无关，重试或看后端日志。" />
    );
  }

  return (
    // 满高写法与 adbCaseDetail 统一：.tp-fill 从 metrics 反解遮挡（旧写法是各页抄一份视口减法）
    <div className="tp-fill tp-fill--head">
      <Space wrap size={8} style={{ marginBottom: 8 }} data-testid="ui-case-meta">
        <Input data-testid="case-name" style={{ width: 256 }} maxLength={200} value={name}
          disabled={!canUpdate} placeholder="用例名（项目内唯一）" onChange={(e) => setName(e.target.value)} />
        <Select data-testid="case-priority" style={{ width: 96 }} value={priority}
          disabled={!canUpdate} options={PRIO_OPTIONS} onChange={setPriority} />
        {canUpdate ? (
          <EnvSelect projectId={pid} value={envId} onChange={setEnvId}
            canManage={can(perms, "env:config:update")} canCreate={can(perms, "env:config:create")}
            headersApply={false} />
        ) : (
          <Typography.Text type="secondary" className="tp-text-sm">环境只读</Typography.Text>
        )}
        <span style={{ flex: 1 }} />
        {canUpdate && (
          <Button type="primary" data-testid="ui-case-save" loading={saving} onClick={() => void persist()}>
            保存{dirty ? "（有未保存修改）" : ""}
          </Button>
        )}
        {canDebug && (
          <Tooltip title={isNew ? "新建用例需先保存入库，再点调试" : "用真浏览器跑一遍（调试跑默认不在报告中心——那边右上角开「含调试」就能看到）"}>
            <Button data-testid="ui-case-debug" loading={debugBusy} onClick={() => void debug()}>调试</Button>
          </Tooltip>
        )}
      </Space>

      <StepListEditor descriptor={descriptor} steps={steps} onChange={setSteps}
        canUpdate={canUpdate} saveIssues={saveIssues} dirty={dirty} />

      {dbgOpen && (
        <UiDebugPanel projectId={pid} result={dbgResult} running={dbgRunning}
          error={dbgError} note={dbgNote} onClose={() => setDbgOpen(false)} />
      )}
    </div>
  );
}

export default function UiCaseDetailPage() {
  const { project } = useAuth();
  const { id } = useParams();
  return (
    // 父级链路（page 容器 → ProjectGate 片段）带 true minHeight:0，让子级 flex:1 有高度可用
    <div data-testid="page-ui-case-detail" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PageHead title="UI 用例详情" crumbs={["UI 测试", "UI 用例"]}
        desc="按顺序执行命令；保存写回 steps_set，调试跑的是已保存的序列（有未保存修改会先代存并说明）。" />
      <ProjectGate>{project ? <Editor caseId={id ?? "new"} /> : null}</ProjectGate>
    </div>
  );
}
