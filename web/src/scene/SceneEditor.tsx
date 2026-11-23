// 场景编辑器（T19，§11.4.9/§11.7.3 三栏工作台）：
// 顶栏（返回/名称/模式/环境/撤销/保存⌘S/调试/执行/取消）+ 左资产树 240 + 画布 flex +
// 右属性面板 360 + 底部问题面板 + 底部运行抽屉。zustand store 是 graph 的单一真相。
// 诚实条款：调试跑未保存草稿（scenario_debug）；执行跑库里已保存的图——有未保存
// 修改先保存，保存不成就停下（不拿草稿演执行，T21）。列表模式（T20）与画布共用同一 store。
import { useEffect, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Modal, Select, Space, Spin, Tooltip, Typography, message,
} from "antd";
import {
  ArrowLeftOutlined, BugOutlined, HistoryOutlined, RedoOutlined, SaveOutlined, StopOutlined,
  UndoOutlined,
} from "../ui/icons";
import ProjectGate from "../layout/ProjectGate";
import PermEmpty from "../components/PermEmpty";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import AssetTree from "./AssetTree";
import Canvas from "./Canvas";
import ConflictModal from "./ConflictModal";
import DebugDrawer, { startRun } from "./DebugDrawer";
import { sceneApi } from "../api/scene";
import IssuePanel from "./IssuePanel";
import ListMode from "./ListMode";
import PropsPanel from "./PropsPanel";
import RevisionDrawer from "./RevisionDrawer";
import { canRedo, canUndo } from "./graphOps";
import { selectDirty, useSceneStore, type ListFailure } from "./store";

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest("input, textarea, select, .monaco-editor, [contenteditable='true']");
}

/** 环境下拉的空占位分三种真事：缺权限（稳定结论）、没取到（故障）、项目真没有（事实）。
 *  合成一句「还没有环境」会把前两种说成第三种——让人去环境页新建一个本来就有的环境。 */
function envPlaceholder(failed: ListFailure, count: number): string {
  if (failed === "denied") return "无权限看环境";
  if (failed === "error") return "环境没取到";
  return count ? "环境" : "还没有环境";
}

function Editor() {
  const { id } = useParams();
  const nav = useNavigate();
  const { project, user } = useAuth();
  const pid = project!.id;
  // D146（§11.5.1 隐藏派，镜像 uiCaseDetail 的 canUpdate 手法）：READONLY 持 scenario:read
  // 能进编辑器（D47），所以入口不藏——进来后由 store.readOnly 关死写把手。
  const canUpdate = can(patternsForProject(project, user?.is_system_admin), "scenario:update");
  const readOnly = useSceneStore((s) => s.readOnly);
  const graphRejected = useSceneStore((s) => s.graphRejected);
  const loading = useSceneStore((s) => s.loading);
  const scenario = useSceneStore((s) => s.scenario);
  const loadFailure = useSceneStore((s) => s.loadFailure);
  const load = useSceneStore((s) => s.load);
  const dirty = useSceneStore(selectDirty);
  const undo = useSceneStore((s) => s.undo);
  const mode = useSceneStore((s) => s.mode);
  const setMode = useSceneStore((s) => s.setMode);
  const envs = useSceneStore((s) => s.envs);
  const envsFailed = useSceneStore((s) => s.assetsFailed.envs);
  // D152：环境清单也可能 >200 条——下拉底部给「加载更多」，游标空（取全了）钮消失。
  const envHasMore = useSceneStore((s) => s.assetsHasMore.envs);
  const envLoadingMore = useSceneStore((s) => s.assetsLoadingMore.envs);
  const loadMoreAssets = useSceneStore((s) => s.loadMoreAssets);
  const envId = useSceneStore((s) => s.envId);
  const setEnvId = useSceneStore((s) => s.setEnvId);
  const doUndo = useSceneStore((s) => s.doUndo);
  const doRedo = useSceneStore((s) => s.doRedo);
  const runPhase = useSceneStore((s) => s.run.phase);
  const cancelRequested = useSceneStore((s) => s.run.cancelRequested);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // D262：变更历史是只读面（scenario:read 即可），所以入口留在只读组之外。
  const [historyOpen, setHistoryOpen] = useState(false);

  // 取消（T21）：run_cancel 在步骤边界生效；409 already_finished（已终态）如实展示。
  const cancelRun = async () => {
    const s = useSceneStore.getState();
    if (!s.run.runId) return;
    s.markCancelRequested();
    try {
      await sceneApi.cancelRun(s.run.runId, { project_id: s.projectId });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "取消请求没有送达");
    }
  };

  // 这里不再补 toast：client.ts 已经把后端原话弹过一次，再叠一句「可能已被回收或删除」
  // 等于对着 500 也下一次「这条场景没了」的结论（同 adbCaseDetail.tsx:106 的口径）。
  // 页面级真相在下面 loadFailure 分支里说，且 load() 现在自己吞掉 reject，不再外抛。
  useEffect(() => {
    if (id) void load(pid, id, !canUpdate);
  }, [pid, id, load, canUpdate]);

  // 未保存离开拦截：data router 的 useBlocker（app.tsx 用 createHashRouter 挂路由）。
  // 早先用「hashchange 拨回去」的做法输给 react-router 自己的 hash 监听（它先注册、
  // 先把页面卸载了），useBlocker 是唯一既拦 <Link>/nav() 也拦浏览器后退的正解。
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { setLeaveOpen(blocker.state === "blocked"); }, [blocker.state]);

  // 关标签页/刷新：浏览器级确认（内容浏览器自绘，非应用弹窗）
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (selectDirty(useSceneStore.getState())) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // 快捷键：⌘S 保存 / ⌘Z 撤销 / ⌘⇧Z、⌘Y 重做。输入控件与 Monaco 里的按键不劫持。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly) return; // D146：只读没有保存/撤销/重做，快捷键与钮同一道门
      if (!(e.ctrlKey || e.metaKey) || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); void useSceneStore.getState().save(); }
      else if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); doRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo, doRedo, readOnly]);

  // 本体没取到：以前这里是 `if (loading || !scenario) return <Spin/>`，而 store 的 load()
  // 在本体 reject 时永远走不到 loading:false —— 404（已回收）与 403（没读权限）都是一句
  // 一闪而过的 toast 加一个永久转圈，没有任何出口。三种原因分开说，口径同 adbCaseDetail。
  if (loadFailure) {
    if (loadFailure.kind === "denied") {
      return (
        <PermEmpty error={loadFailure.err} projectName={project?.name ?? ""}
          context="查看该场景">
          <div style={{ marginTop: 12 }}>
            <Button data-testid="scene-load-back" onClick={() => nav("/scene")}>返回场景列表</Button>
          </div>
        </PermEmpty>
      );
    }
    return (
      <Alert type="warning" showIcon data-testid="scene-load-failed"
        message={loadFailure.kind === "missing" ? "场景加载失败" : "场景没取到"}
        description={loadFailure.kind === "missing"
          ? "后端回「不存在」：这条场景已被回收或从未存在——以上方刚才的错误提示为准。"
          : "这条场景没取到（后端没回「不存在」，也还没到没权限那步）——与场景本身无关，重试或看后端日志。"}
        action={
          <Space direction="vertical">
            <Button size="small" data-testid="scene-load-retry"
              onClick={() => { if (id) void load(pid, id, !canUpdate); }}>重试</Button>
            <Button size="small" data-testid="scene-load-back" onClick={() => nav("/scene")}>返回场景列表</Button>
          </Space>
        } />
    );
  }

  if (loading || !scenario) {
    return <Spin style={{ display: "block", margin: "20vh auto" }} data-testid="scene-editor-loading" />;
  }

  return (
    // .tp-fill 的扣减（topbar 56 + pagepad 24×2）与原 calc(100vh−104px) 同值，改用 token 体系；
    // min-height 覆写回 560：画布 + 右栏 + 底部面板的最低可用高度比通用 480 更高
    <div data-testid="page-scene-editor" className="tp-fill" style={{ minHeight: 560 }}>
      {readOnly && (
        <Alert type="info" showIcon data-testid="scene-readonly-banner" style={{ marginBottom: 8 }}
          message="当前项目没有 scenario:update 权限，本场景为只读——可查看画布与配置，不能编辑、保存或执行。" />
      )}
      {/* D147：库里被滤掉的畸形步骤必须可观察——画布不是全量，save() 已早退拦下。
          与 D146 只读横幅是两道独立的门，可并存。 */}
      {graphRejected.length > 0 && (
        <Alert type="warning" showIcon data-testid="scene-graph-rejected" style={{ marginBottom: 8 }}
          message={graphRejected.length + " 个步骤形状不合规，未载入画布；保存已被拦下——直接保存会把它们写没，先修复图再保存。"} />
      )}
      <Space style={{ marginBottom: 8 }} wrap>
        <Button data-testid="scene-back" icon={<ArrowLeftOutlined />}
          onClick={() => nav("/scene")}>返回</Button>
        <Typography.Text strong className="tp-text-lg">{scenario.name}</Typography.Text>
        <Typography.Text className="tp-text-sm" type="secondary">v{scenario.version}</Typography.Text>
        {dirty && <span data-testid="scene-dirty-dot" title="有未保存修改" style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--tp-func-warning)",
        }} />}
        <Space size={0} style={{ border: "1px solid var(--tp-border)", borderRadius: 6, overflow: "hidden" }}>
          <Button data-testid="scene-mode-canvas" size="small"
            type={mode === "canvas" ? "primary" : "text"}
            onClick={() => setMode("canvas")}>画布</Button>
          <Button data-testid="scene-mode-list" size="small"
            type={mode === "list" ? "primary" : "text"}
            onClick={() => setMode("list")}>列表</Button>
        </Space>
        <Button data-testid="scene-history" icon={<HistoryOutlined />}
          title="查看谁在什么时候改了什么（只读）"
          onClick={() => setHistoryOpen(true)}>变更历史</Button>
        <Select data-testid="scene-env" allowClear style={{ minWidth: 140 }} disabled={readOnly}
          placeholder={envPlaceholder(envsFailed, envs.length)}
          value={envId ?? undefined}
          options={envs.map((e) => ({ value: e.id, label: e.name }))}
          dropdownRender={(menu) => (<>
            {menu}
            {/* D152：菜单底部的追加入口；onMouseDown 挡默认行为，点钮不关下拉。
                只读时 Select 本体禁用（D146 既有门），下拉打不开是 antd 的事，不另造。 */}
            {envHasMore && (
              <Button size="small" type="link" data-testid="env-more" disabled={envLoadingMore}
                style={{ width: "100%" }} onMouseDown={(e) => e.preventDefault()}
                onClick={() => void loadMoreAssets("envs")}>加载更多</Button>
            )}
          </>)}
          onChange={(v) => setEnvId(v ?? null)} />
        {/* D146：写钮整组隐藏（§11.5.1 隐藏不是禁用）；取消钮留在外面——它只跟 runPhase 走 */}
        {!readOnly && (<>
        <Tooltip title="撤销（Ctrl+Z）">
          <Button data-testid="scene-undo" icon={<UndoOutlined />} disabled={!canUndo(undo)}
            onClick={doUndo} />
        </Tooltip>
        <Tooltip title="重做（Ctrl+Shift+Z）">
          <Button data-testid="scene-redo" icon={<RedoOutlined />} disabled={!canRedo(undo)}
            onClick={doRedo} />
        </Tooltip>
        <Button type="primary" data-testid="scene-save" icon={<SaveOutlined />}
          onClick={() => void useSceneStore.getState().save()}>
          保存 (Ctrl+S)
        </Button>
        {/* 调试：跑当前未保存草稿（T20，scenario_debug）。例外要说破：公共断言取的是**保存行**
            （后端 405647b 在 enqueue 时快照，`ScenarioDebugIn` 没这个字段），所以改了断言没
            保存就点调试，判的是老断言——界面若只说「跑草稿」就是半句假话。 */}
        <Button data-testid="scene-debug" icon={<BugOutlined />}
          title="调试当前未保存草稿（不保存也能跑）；公共断言按已保存的判，改了断言要先保存"
          onClick={() => void startRun("debug")}>调试</Button>
        {/* 执行：跑库里已保存的场景（T21）；有未保存修改先保存，保存不成不跑草稿 */}
        <Button data-testid="scene-run"
          title={dirty ? "执行跑已保存的场景：先保存（Ctrl+S）" : "执行已保存的场景（进度见运行抽屉）"}
          disabled={runPhase === "running" || runPhase === "starting"}
          onClick={() => void startRun("manual")}>执行</Button>
        </>)}
        {runPhase === "running" && (
          <Button data-testid="scene-cancel-run" icon={<StopOutlined />} danger
            title="取消执行（在步骤边界生效，不强杀进行中的请求）"
            disabled={cancelRequested}
            onClick={() => void cancelRun()}>
            {cancelRequested ? "取消中…" : "取消"}
          </Button>
        )}
      </Space>
      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ width: 240, flex: "0 0 240px", background: "var(--tp-bg-container)", border: "1px solid var(--tp-split)", borderRadius: 8, overflow: "hidden" }}>
          <AssetTree />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--tp-split)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            {mode === "canvas"
              ? <Canvas />
              : <ListMode />}
          </div>
          <IssuePanel />
        </div>
        <div style={{ width: 360, flex: "0 0 360px", background: "var(--tp-bg-container)", border: "1px solid var(--tp-split)", borderRadius: 8, overflow: "hidden" }}>
          <PropsPanel />
        </div>
      </div>
      <DebugDrawer />
      <ConflictModal />
      <RevisionDrawer open={historyOpen} onClose={() => setHistoryOpen(false)}
        projectId={pid} scenarioId={scenario.id} />
      <Modal centered open={leaveOpen} data-testid="leave-guard-modal" title="有未保存的修改"
        okText="放弃修改并离开" okButtonProps={{ danger: true, "data-testid": "leave-go" }}
        cancelText="留下继续编辑" cancelButtonProps={{ "data-testid": "leave-stay" }}
        onOk={() => blocker.state === "blocked" && blocker.proceed()}
        onCancel={() => blocker.state === "blocked" && blocker.reset()}>
        <Alert type="warning" showIcon message="现在离开会丢掉未保存的画布改动（Ctrl+S 可保存）。" />
      </Modal>
    </div>
  );
}

/** 列表模式只读预览已由 T20 的 ListMode（可拖拽/勾选/剪贴板）替换，见 ListMode.tsx。 */
export default function SceneEditorPage() {
  const { project } = useAuth();
  return (
    <div>
      <ProjectGate>{project ? <Editor /> : null}</ProjectGate>
    </div>
  );
}
