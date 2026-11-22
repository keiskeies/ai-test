// 属性面板（§11.4.9 右栏 360）：Tabs 配置/断言/高级（label 上置）。
// 一切编辑经 store（graphOps 不可变更新）；本文件只做表单转换。
// 没选中步骤时显示**场景级面板**（T20，§11.5.6）：基本信息 | 场景变量 | 失败策略 |
// 执行超时 | 定时绑定（1E 已交付，真入口）| 公共断言 | 引用提示。变量/策略/超时都是
// 草稿态——改了置 dirty、保存才落库，与画布编辑同一口径。
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Empty, Input, InputNumber, Segmented, Select, Space, Spin, Switch, Tabs,
  Typography, message,
} from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from "../ui/icons";
import { useNavigate } from "react-router-dom";
import { ASSERT_TYPES } from "../api/req";
import type { SceneAssertion } from "../api/req";
import { findByKey, walk } from "./graphOps";
import { ELSE_COND, kindMeta, labelOf, LOOP_MODES, type StepNode } from "./stepTypes";
import { useSceneStore, type ListFailure } from "./store";
import { listTasks, rebindTask } from "../api/schedule";
import { adbApi } from "../api/adb";
import DeviceSelect, { type DeviceOption } from "../adb/DeviceSelect";
import { ApiErr } from "../api/client";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import type { components } from "../api/schema";

type TaskOut = components["schemas"]["TaskOut"];

// CodeEditor 静态引着 monaco（4.5MB chunk）：懒加载，选到脚本/JSON 字段才拉。
const CodeEditor = lazy(() => import("../components/CodeEditor"));
const editorFallback = <Spin style={{ display: "block", padding: 24 }} />;

interface Branch { cond?: string; children?: StepNode[] }

function branchesOf(n: StepNode): Branch[] {
  const b = n.config?.branches;
  return Array.isArray(b) ? (b as Branch[]) : [];
}

/** 执行超时默认口径 30min（计划 T20；后端 max_runtime_default_ms 同量级）。 */
const DEFAULT_MAX_RUNTIME_MS = 1_800_000;

/**
 * 定时绑定区（1E 已交付：backend/app/modules/schedule/service.py 服务面 + 定时任务页）。
 * 真数据真写入，两件事都通到后端：
 * ① 展示：GET /schedule-tasks 列项目内定时任务，前端按 subject_id === 当前场景过滤
 *    （后端列表没有 subject_id 参数，这一刀只能在前端切——但切的是真列表不是编的；
 *    size=200 单页封顶，超过 200 条的极端项目这里只对照第一页，深翻页归定时任务页）。
 * ② 改绑：PATCH /schedule-tasks/{id} 单传 subject_id——后端逐字段 `is not None` 落值
 *    （service.py schedule_task_update），把「已存在但绑着别的场景」的定时改绑到本场景
 *    是后端白纸黑字支持的语义。**不在这里新建**：新建要过 cron 校验 + 渠道选择整套表单，
 *    唯一实现点在 pages/schedules.tsx 的抽屉（预览 next-5、422 原话回显），这里不抄第二份，
 *    按钮跳 /schedules 是真跳转。
 * 权限位与后端同尺：列表跟 schedule:task:read 走，改绑跟 schedule:task:update 走。
 */
function CronBindSection() {
  const scenarioId = useSceneStore((s) => s.scenarioId);
  const projectId = useSceneStore((s) => s.projectId);
  const { project, user } = useAuth();
  const nav = useNavigate();
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayRead = can(perms, "schedule:task:read");
  const mayUpdate = can(perms, "schedule:task:update");

  const [tasks, setTasks] = useState<TaskOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 只取了第一页（size=200）。有游标就没看全，此时「没有」只是「前 200 条里没有」。
  const [partial, setPartial] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoadError(null);
    try {
      const page = await listTasks({ project_id: projectId, size: 200 });
      setTasks(page.items);
      setPartial(page.next_cursor != null);
    } catch (e) {
      setTasks(null);
      setLoadError(e instanceof ApiErr ? e.message : "定时任务列表加载失败");
    }
  }, [projectId]);
  useEffect(() => { if (mayRead) void reload(); }, [mayRead, reload]);

  async function rebind(taskId: string): Promise<void> {
    setBusy(true);
    try {
      const out = await rebindTask(taskId, { project_id: projectId, subject_id: scenarioId });
      message.success(`「${out.name}」已改绑到本场景`);
      setPick(null);
      await reload();
    } catch (e) {
      if (e instanceof ApiErr) message.error(e.message);
    } finally { setBusy(false); }
  }

  const bound = (tasks ?? []).filter((t) => t.subject_id === scenarioId);
  const others = (tasks ?? []).filter((t) => t.subject_id !== scenarioId);

  return (
    <div data-testid="scene-cron-bind" style={{ margin: "6px 0 12px" }}>
      {!mayRead ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="cron-bind-noperm">
          当前项目没有 schedule:task:read 权限，看不到这个场景的定时绑定。
        </Typography.Text>
      ) : loadError ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="cron-bind-error">
          定时任务加载失败：{loadError}
        </Typography.Text>
      ) : tasks === null ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>定时任务加载中…</Typography.Text>
      ) : (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {bound.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="cron-bind-empty">
              {partial ? "前 200 条定时任务里没有跑这个场景的。" : "还没有定时任务跑这个场景。"}
            </Typography.Text>
          ) : bound.map((t) => (
            <div key={t.id} data-testid={"cron-bind-task-" + t.id} style={{ fontSize: 12 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>{t.name}</Typography.Text>
              <Typography.Text code style={{ fontSize: 12, marginLeft: 6 }}>{t.cron}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                {t.enabled === 1 ? "启用中" : "已停用"}
              </Typography.Text>
            </div>
          ))}
          <Button size="small" data-testid="cron-bind-goto" onClick={() => nav("/schedules")}>
            去定时任务页新建/编辑
          </Button>
          {mayUpdate && others.length > 0 && (
            <Space size={4} wrap>
              <Select showSearch optionFilterProp="label" size="small" style={{ width: 180 }}
                data-testid="cron-bind-rebind-select" value={pick} placeholder="选一个已有定时任务"
                options={others.map((t) => ({ value: t.id, label: t.name + "（" + t.cron + "）" }))}
                onChange={(v) => setPick(v)} />
              <Button size="small" data-testid="cron-bind-rebind" loading={busy}
                disabled={!pick} onClick={() => pick && void rebind(pick)}>
                改绑到本场景
              </Button>
            </Space>
          )}
          {mayUpdate && others.length === 0 && bound.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {partial
                ? "前 200 条定时任务里没有可改绑的——去定时任务页看看后面的页或新建一个。"
                : "项目里还没有别的定时任务可改绑——先去定时任务页建一个。"}
            </Typography.Text>
          )}
        </Space>
      )}
    </div>
  );
}

/** 加变量的 key：行数派生在删过行之后必撞现存 key（撞了就是 no-op 或覆盖别人的值），顺移到第一个空位。 */
function freeVarKey(cur: Record<string, string>): string {
  const keys = Object.keys(cur);
  let n = keys.length + 1;
  while (keys.includes("var" + n)) n += 1;
  return "var" + n;
}

/** 用例下拉的空占位分三种真事：没权限看 / 这次没取到 / 项目真没有。
 *  合成一句「还没有用例」把前两种说成第三种——让人去新建一条本来就存在的用例。 */
function refPlaceholder(failed: ListFailure, noun: string, ok: string): string {
  if (failed === "denied") return "无权限看" + noun;
  if (failed === "error") return noun + "没取到";
  return ok;
}

/** 画布 adb 步骤的「指定设备」（1g/D168：与 ADB 用例详情页共用 DeviceSelect）。
 *  候选由本宿主拉（adbCaseDetail :117-126 同款：拉不到就空列表，不假装有设备）；
 *  serial 只给登记过的设备——执行链只认清单内 serial（DeviceSelect.tsx 头注）。 */
function AdbDeviceField(props: { nodeKey: string; value: string; readOnly: boolean }) {
  const projectId = useSceneStore((s) => s.projectId);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await adbApi.listDevices({ project_id: projectId, size: 200 });
        if (alive) setDevices(r.items.map((d) => ({
          serial: d.serial, name: d.name, online: d.last_state?.online === true,
        })));
      } catch { /* 空下拉 + DeviceSelect 空态，client 已 toast */ }
    })();
    return () => { alive = false; };
  }, [projectId]);
  return (
    <DeviceSelect testId="prop-adb-device-serial" devices={devices} disabled={props.readOnly}
      value={props.value || null}
      onChange={(serial) => useSceneStore.getState().updateConfig(props.nodeKey, { device_serial: serial })} />
  );
}

/** 场景级面板（未选中步骤时的右栏）。 */
function ScenarioPanel() {
  const scenario = useSceneStore((s) => s.scenario);
  const nodes = useSceneStore((s) => s.nodes);
  const variables = useSceneStore((s) => s.variables);
  const setVariables = useSceneStore((s) => s.setVariables);
  const failFast = useSceneStore((s) => s.failFast);
  const setFailFast = useSceneStore((s) => s.setFailFast);
  const maxRuntimeMs = useSceneStore((s) => s.maxRuntimeMs);
  const setMaxRuntimeMs = useSceneStore((s) => s.setMaxRuntimeMs);
  const commonAssertions = useSceneStore((s) => s.commonAssertions);
  const setCommonAssertions = useSceneStore((s) => s.setCommonAssertions);
  const cases = useSceneStore((s) => s.cases);
  const readOnly = useSceneStore((s) => s.readOnly); // D146：场景级草稿也是写，只读全禁

  const varRows = Object.entries(variables);
  const writeVar = (i: number, nextKey: string, nextVal: string) => {
    const entries = Object.entries(useSceneStore.getState().variables);
    entries[i] = [nextKey, nextVal];
    // 编辑途中的空 key 保留在草稿里（清掉会让正在敲的那一行原地消失、焦点丢失）；
    // 保存时 saveBody 把空 key 行滤掉，空名变量不进库。同名 key 由 fromEntries 后者覆盖。
    setVariables(Object.fromEntries(entries));
  };
  const removeVar = (i: number) => {
    const entries = Object.entries(useSceneStore.getState().variables);
    entries.splice(i, 1);
    setVariables(Object.fromEntries(entries));
  };

  // 引用提示：场景引用了哪些接口用例（api_case 步骤的 ref；场景间无引用是 R52 的 1B 事实）
  const refCaseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [n] of walk(nodes)) if (n.kind === "api_case" && n.ref) ids.add(n.ref);
    return ids;
  }, [nodes]);

  return (
    <div data-testid="scene-props-scenario" style={{ height: "100%", overflow: "auto", padding: 12 }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没选中步骤：这里是场景级设置"
        style={{ margin: "0 0 8px" }} />
      <Typography.Text strong style={{ fontSize: 13 }}>基本信息</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "4px 0 12px" }}>
        {scenario?.name}（v{scenario?.version}，{scenario?.priority}）
      </Typography.Paragraph>

      <Typography.Text strong style={{ fontSize: 13 }}>场景变量</Typography.Text>
      <div data-testid="scene-var-table" style={{ margin: "6px 0 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {varRows.map(([k, v], i) => (
          <Space key={i} data-testid={"var-row-" + i} style={{ display: "flex" }}>
            <Input data-testid={"var-key-" + i} size="small" style={{ width: 120 }} placeholder="变量名"
              disabled={readOnly} value={k} onChange={(e) => writeVar(i, e.target.value, v)} />
            <Input data-testid={"var-val-" + i} size="small" style={{ width: 150 }} placeholder="值"
              disabled={readOnly} value={v} onChange={(e) => writeVar(i, k, e.target.value)} />
            {!readOnly && (
            <Button size="small" type="text" danger icon={<DeleteOutlined />}
              data-testid={"var-del-" + i} onClick={() => removeVar(i)} />
            )}
          </Space>
        ))}
        {!readOnly && (
        <Button size="small" icon={<PlusOutlined />} data-testid="var-add"
          onClick={() => {
            // 追加在末尾：Record 键序=插入序，前插会让现有变量行整体挪位
            setVariables({ ...useSceneStore.getState().variables, [freeVarKey(useSceneStore.getState().variables)]: "" });
          }}>
          加变量
        </Button>
        )}
      </div>

      <Typography.Text strong style={{ fontSize: 13 }}>失败策略</Typography.Text>
      <div style={{ margin: "6px 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <Switch data-testid="scene-fail-continue" checked={!failFast} disabled={readOnly}
          onChange={(v) => setFailFast(!v)} />
        <Typography.Text style={{ fontSize: 12 }}>
          {failFast ? "遇错停止（后续步骤 skip）" : "忽略继续（失败行不阻断后续）"}
        </Typography.Text>
      </div>

      <Typography.Text strong style={{ fontSize: 13 }}>执行超时（ms）</Typography.Text>
      <div style={{ margin: "6px 0 12px" }}>
        <Input data-testid="scene-max-runtime" size="small" style={{ width: 160 }} disabled={readOnly}
          placeholder={String(DEFAULT_MAX_RUNTIME_MS)}
          value={maxRuntimeMs === null ? "" : String(maxRuntimeMs)}
          onChange={(e) => {
            const t = e.target.value.trim();
            setMaxRuntimeMs(t === "" ? null : Math.max(1000, Number(t) || 0));
          }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          默认 {DEFAULT_MAX_RUNTIME_MS / 60000} 分钟
        </Typography.Text>
      </div>

      <Typography.Text strong style={{ fontSize: 13 }}>公共断言</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "4px 0 6px" }}>
        对每一个发出请求的步骤逐条求值；任一步不过，整次运行判「断言失败」。
      </Typography.Paragraph>
      <div data-testid="scene-common-assertions" style={{ margin: "0 0 12px" }}>
        <AssertionListEditor
          items={commonAssertions}
          prefix="scene-cassert"
          addLabel="加公共断言"
          emptyHint="未启用公共断言——各步骤只按自己的断言判定。"
          ro={readOnly}
          onChange={(xs) => setCommonAssertions(xs)}
        />
      </div>

      <Typography.Text strong style={{ fontSize: 13 }}>定时绑定</Typography.Text>
      <CronBindSection />

      <Typography.Text strong style={{ fontSize: 13 }}>引用提示</Typography.Text>
      <div data-testid="scene-refs-hint" style={{ margin: "6px 0 12px" }}>
        {refCaseIds.size === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这个场景没有引用任何接口用例。
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 12 }}>
            引用 {refCaseIds.size} 个接口用例：
            {[...refCaseIds].map((id) => cases.find((c) => c.id === id)?.name ?? id.slice(0, 8)).join("、")}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

export default function PropsPanel() {
  const nodes = useSceneStore((s) => s.nodes);
  const selectedKey = useSceneStore((s) => s.selectedKey);
  const renameKey = useSceneStore((s) => s.renameKey);
  const updateConfig = useSceneStore((s) => s.updateConfig);
  const removeKey = useSceneStore((s) => s.removeKey);
  const toggleDisableKey = useSceneStore((s) => s.toggleDisableKey);
  const cases = useSceneStore((s) => s.cases);
  const uiCases = useSceneStore((s) => s.uiCases);
  const adbCases = useSceneStore((s) => s.adbCases);
  const assetsFailed = useSceneStore((s) => s.assetsFailed);
  const readOnly = useSceneStore((s) => s.readOnly); // D146：步骤配置/名称/key/禁用/删除全是写

  const found = selectedKey ? findByKey(nodes, selectedKey) : null;
  const node = found ? found[0] : null;

  // 名称受控但要「提交式」写 undo：本地草稿 + Enter/blur 落库，逐键不进 undo 栈。
  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => { setNameDraft(node?.name ?? ""); }, [selectedKey, node?.name]);

  if (!node) {
    return <ScenarioPanel />;
  }

  const meta = kindMeta(node.kind);
  const commitName = () => {
    if (nameDraft.trim() && nameDraft.trim() !== (node.name ?? "")) renameKey(node.key, nameDraft);
  };

  const configTab = (() => {
    switch (node.kind) {
      case "api_case":
        return (
          <Labeled label="引用用例">
            <Select data-testid="prop-ref" style={{ width: "100%" }} showSearch optionFilterProp="label" disabled={readOnly}
              value={node.ref || undefined}
              placeholder={refPlaceholder(assetsFailed.cases, "接口用例", cases.length ? "选择 API 用例" : "还没有用例")}
              options={cases.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => useSceneStore.getState().patchNode(node.key, (n) => ({ ...n, ref: v }))}
            />
          </Labeled>
        );
      case "adb_case": {
        // 1D：设备策略（§11.4.12「任一空闲 / 指定设备」）。这两个键真生效：保存期由
        // graphOps.requiredConfig 与后端 graph._required_config 同尺校验，执行期经
        // h_adb_case → adb_case_engine_run 覆盖用例自己的默认设备（R145）。
        // 占用语义两条分支不同（D136，debug_services.py:382-384/:401-404）：指定设备
        // 抢不到锁才 FIFO 排队（device_queued 真位次，§8.7）；任一空闲每轮抢占失败即
        // 退队重轮询，不排队、没有位次。位次载荷没有任何界面渲染（D136 复核），
        // 面板与下方文案都绝不显示编造的排队位次或预计时长。
        const policy = node.config?.device_policy === "specified" ? "specified" : "any_idle";
        return (
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Labeled label="引用用例">
              <Select data-testid="prop-ref" style={{ width: "100%" }} showSearch optionFilterProp="label" disabled={readOnly}
                value={node.ref || undefined}
                placeholder={refPlaceholder(assetsFailed.adbCases, "ADB 用例", adbCases.length ? "选择 ADB 用例" : "还没有用例")}
                options={adbCases.map((c) => ({ value: c.id, label: c.name }))}
                onChange={(v) => useSceneStore.getState().patchNode(node.key, (n) => ({ ...n, ref: v }))}
              />
            </Labeled>
            <Labeled label="设备策略（§11.4.12）">
              <Segmented data-testid="prop-adb-device-policy" disabled={readOnly}
                options={[{ value: "any_idle", label: "任一空闲设备" }, { value: "specified", label: "指定设备" }]}
                value={policy}
                onChange={(v) => updateConfig(node.key, {
                  device_policy: String(v),
                  // 切回「任一空闲」把 serial 一并清空，不留半套配置
                  ...(String(v) === "any_idle" ? { device_serial: "" } : {}),
                })} />
            </Labeled>
            {policy === "specified" && (
              <Labeled label="指定设备（serial；占用时后台执行排队，调试不排队）">
                <AdbDeviceField nodeKey={node.key} readOnly={readOnly}
                  value={String(node.config?.device_serial ?? "")} />
              </Labeled>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="prop-adb-queue-note">
              {/* D136：占用语义按策略分叉，绝不无条件承诺排队/位次——
                  任一空闲真实现是轮询等待（不排队、无位次可看）。 */}
              {policy === "specified"
                ? "设备占用时：后台执行对这台设备按 FIFO 排队（真实位次记在运行事件里——当前界面未渲染）；调试不排队，占用当场报错。"
                : "设备占用时：自动换空闲设备；全部占用时后台执行轮询等待——该策略不排队，也就没有位次。"}
              预计时长没有估算公式，界面不编数字（D17）。
            </Typography.Text>
          </Space>
        );
      }
      case "ui_case":
        // R111：UI 步骤的 config 口径 = 只要 ref（后端 graph.py _required_config 无
        // ui_case 分支）；面板复用 api_case 的「用例下拉」形态，候选来自 /ui-cases。
        return (
          <Labeled label="引用用例">
            <Select data-testid="prop-ref" style={{ width: "100%" }} showSearch optionFilterProp="label" disabled={readOnly}
              value={node.ref || undefined}
              placeholder={refPlaceholder(assetsFailed.uiCases, "UI 用例", uiCases.length ? "选择 UI 用例" : "还没有用例")}
              options={uiCases.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => useSceneStore.getState().patchNode(node.key, (n) => ({ ...n, ref: v }))}
            />
          </Labeled>
        );
      case "sleep":
        return (
          <Labeled label="等待毫秒（ms）">
            <InputNumber data-testid="prop-ms" min={1} style={{ width: "100%" }} disabled={readOnly}
              value={typeof node.config?.ms === "number" ? (node.config.ms as number) : null}
              onChange={(v) => typeof v === "number" && updateConfig(node.key, { ms: v })} />
          </Labeled>
        );
      case "loop":
        return (
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Labeled label="循环模式">
              <Segmented data-testid="prop-loop-mode" disabled={readOnly} options={LOOP_MODES.map((m) => ({
                value: m, label: m === "count" ? "固定次数" : "while 条件",
              }))}
                value={String(node.config?.mode ?? "count") === "while" ? "while" : "count"}
                onChange={(v) => updateConfig(node.key, { mode: String(v) })} />
            </Labeled>
            <Labeled label="最大轮数 max_iter（硬上限，防死循环）">
              <InputNumber data-testid="prop-max-iter" min={1} style={{ width: "100%" }} disabled={readOnly}
                value={typeof node.config?.max_iter === "number" ? (node.config.max_iter as number) : null}
                onChange={(v) => typeof v === "number" && updateConfig(node.key, { max_iter: v })} />
            </Labeled>
            {(String(node.config?.mode ?? "count") === "while") && (
              <Labeled label="条件表达式（沙箱求值，真值继续循环）">
                <Input data-testid="prop-cond" disabled={readOnly} value={String(node.config?.cond ?? "")}
                  placeholder="ctx.vars.get('state') == 'Pending'"
                  onChange={(e) => updateConfig(node.key, { cond: e.target.value })} />
              </Labeled>
            )}
          </Space>
        );
      case "foreach":
        return (
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Labeled label="列表变量 list_var">
              <Input data-testid="prop-list-var" disabled={readOnly} value={String(node.config?.list_var ?? "")}
                onChange={(e) => updateConfig(node.key, { list_var: e.target.value })} />
            </Labeled>
            <Labeled label="行变量 item_var">
              <Input data-testid="prop-item-var" disabled={readOnly} value={String(node.config?.item_var ?? "")}
                onChange={(e) => updateConfig(node.key, { item_var: e.target.value })} />
            </Labeled>
          </Space>
        );
      case "if":
        return <BranchEditor node={node} />;
      case "script":
        return (
          <Labeled label="脚本（受限沙箱，§8.5）">
            <Suspense fallback={editorFallback}>
              <CodeEditor language="javascript" height={220} readOnly={readOnly}
                value={String(node.config?.code ?? "")}
                onChange={(v) => updateConfig(node.key, { code: v })} />
            </Suspense>
          </Labeled>
        );
      case "http_direct":
        return (
          <Labeled label="URL">
            <Input data-testid="prop-url" disabled={readOnly} value={String(node.config?.url ?? "")}
              placeholder="https://…"
              onChange={(e) => updateConfig(node.key, { url: e.target.value })} />
          </Labeled>
        );
      case "break":
      case "continue":
        return (
          <Alert type="info" showIcon
            message={labelOf(node.kind) + " 只能待在 loop / foreach 内部"}
            description="拖到循环外会立刻出红角标，保存会被拒绝——这是执行语义，不是渲染问题。" />
        );
      case "extract":
        return <ExtractEditor node={node} />;
      case "assert":
        return <AssertEditor node={node} />;
      case "set_var":
        return (
          <Labeled label="变量（JSON 对象）">
            <JsonBox text={JSON.stringify(node.config?.vars ?? {}, null, 2)} ro={readOnly}
              onCommit={(obj) => updateConfig(node.key, { vars: obj })} />
          </Labeled>
        );
      case "group":
        return (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            分组是串行容器：子节点按顺序执行。并发分组（parallel）是二期。
          </Typography.Text>
        );
      default:
        return null;
    }
  })();

  const tabs = [
    { key: "config", label: "配置", children: (
      <Space direction="vertical" style={{ width: "100%" }} size={10}>
        <Labeled label="名称">
          <Input data-testid="prop-name" value={nameDraft} maxLength={200} disabled={readOnly}
            onChange={(e) => setNameDraft(e.target.value)}
            onPressEnter={commitName} onBlur={commitName} />
        </Labeled>
        {configTab}
      </Space>
    ) },
  ];
  if (node.kind === "api_case") {
    tabs.push({ key: "assert", label: "断言", children: (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        API 用例步骤的断言跟着用例走（接口管理里编辑）；要对整条场景收尾断言，
        加一个独立的「断言」步骤。
      </Typography.Text>
    ) });
  }
  if (node.kind === "ui_case" || node.kind === "adb_case") {
    // 诚实说明（计划 T18/T9）：UI/ADB 用例的断言长在用例自己的命令里（assert_text /
    // assert 步型等，在各自用例详情页编辑），不在场景这一步上——所以这里不放假断言编辑器。
    const where = node.kind === "ui_case" ? "UI 用例" : "ADB 用例";
    tabs.push({ key: "assert", label: "断言", children: (
      <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="prop-ui-assert-note">
        {where}步骤的断言跟着用例走（在 {where} 的命令里编辑，如「断言文本」）；
        要对整条场景收尾断言，加一个独立的「断言」步骤。
      </Typography.Text>
    ) });
  }
  // http_direct 的断言引擎侧一直都判（handlers._build_request 把 config.assertions
  // 原样交给 run_api，test_engine_handlers 两条专测钉着），缺的只是这个页签——
  // 没页签就等于「这一步永远不许有断言」，而 500 也算通过，那是假绿（1A §5.3 同源口径）。
  if (node.kind === "http_direct") {
    tabs.push({ key: "assert", label: "断言", children: (
      <Space direction="vertical" style={{ width: "100%" }} size={6}>
        <AssertionListEditor
          items={(Array.isArray(node.config?.assertions) ? node.config.assertions : []) as Asrt[]}
          prefix="prop-direct-assert" addLabel="加断言"
          emptyHint="无断言：这一步只要请求发得出去就算通过——目标系统回 500 也是绿的。至少加一条状态码断言。"
          ro={readOnly}
          onChange={(xs) => updateConfig(node.key, { assertions: xs })} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          与场景公共断言同一套控件、同一份求值（shared/assertions.py）；报告里这一步的
          断言行会同时含「自己的」与带「场景级」标的。
        </Typography.Text>
      </Space>
    ) });
  }
  tabs.push({ key: "adv", label: "高级", children: (
    <Space direction="vertical" style={{ width: "100%" }} size={10}>
      <Labeled label="步骤 key（报告的步骤主键，改名会影响历史对照）">
        <KeyEditor node={node} />
      </Labeled>
      <Labeled label="禁用（跳过执行，不删除）">
        <Switch data-testid="prop-disable" checked={!!node.disable} disabled={readOnly}
          onChange={() => toggleDisableKey(node.key)} />
      </Labeled>
      {!readOnly && (
      <Button danger icon={<DeleteOutlined />} onClick={() => removeKey(node.key)}>
        删除这个步骤
      </Button>
      )}
    </Space>
  ) });

  return (
    <div data-testid="scene-props" style={{ height: "100%", overflow: "auto" }}>
      <div style={{ padding: "10px 12px 0", display: "flex", alignItems: "center", gap: 8 }}>
        <span data-testid="prop-kind" style={{
          background: meta.color, color: "#fff", borderRadius: 4, padding: "1px 8px", fontSize: 12,
        }}>{meta.label}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{node.key}</Typography.Text>
      </div>
      <Tabs items={tabs} size="small" tabBarStyle={{ paddingLeft: 12, marginBottom: 0 }} />
    </div>
  );
}

function Labeled(props: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--tp-text-2)", marginBottom: 4 }}>{props.label}</div>
      {props.children}
    </div>
  );
}

function KeyEditor({ node }: { node: StepNode }) {
  const readOnly = useSceneStore((s) => s.readOnly);
  const [draft, setDraft] = useState(node.key);
  useEffect(() => { setDraft(node.key); }, [node.key]);
  return (
    <Input data-testid="prop-key" value={draft} disabled={readOnly} onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = draft.trim();
        if (v && v !== node.key) {
          // key 改动牵动 layout/issue 索引；重复 key 交给预检报 dup_key（红角标即时可见）
          useSceneStore.getState().patchNode(node.key, (n) => ({ ...n, key: v }));
        }
      }} />
  );
}

function BranchEditor({ node }: { node: StepNode }) {
  const updateConfig = useSceneStore((s) => s.updateConfig);
  const readOnly = useSceneStore((s) => s.readOnly);
  const branches = branchesOf(node);
  const write = (nb: Branch[]) => updateConfig(node.key, { branches: nb });
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      {branches.map((b, i) => (
        <div key={i} data-testid={"prop-branch-" + i} style={{
          border: "1px solid var(--tp-border)", borderRadius: 6, padding: 8, display: "flex", gap: 6, alignItems: "center",
        }}>
          <Segmented data-testid={"prop-branch-type-" + i} disabled={readOnly}
            options={[{ value: "cond", label: "条件" }, { value: "else", label: "否则" }]}
            value={b.cond === ELSE_COND ? "else" : "cond"}
            onChange={(v) => {
              const nb = branches.slice();
              nb[i] = { ...nb[i], cond: v === "else" ? ELSE_COND : (nb[i].cond === ELSE_COND ? "" : nb[i].cond) };
              write(nb);
            }} />
          {b.cond !== ELSE_COND && (
            <Input data-testid={"prop-branch-cond-" + i} placeholder="ctx.vars['code'] == '0'" disabled={readOnly}
              value={b.cond ?? ""}
              onChange={(e) => { const nb = branches.slice(); nb[i] = { ...nb[i], cond: e.target.value }; write(nb); }} />
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {b.children?.length ?? 0} 步
          </Typography.Text>
          {branches.length > 1 && !readOnly && (
            <Button size="small" danger type="text" icon={<DeleteOutlined />}
              data-testid={"prop-branch-del-" + i}
              onClick={() => write(branches.filter((_, x) => x !== i))} />
          )}
        </div>
      ))}
      {!readOnly && (
      <Button size="small" icon={<PlusOutlined />} data-testid="prop-branch-add"
        onClick={() => write([...branches, { cond: "", children: [] }])}>
        加条件分支
      </Button>
      )}
      {!readOnly && !branches.some((b) => b.cond === ELSE_COND) && (
        <Button size="small" data-testid="prop-branch-else"
          onClick={() => write([...branches, { cond: ELSE_COND, children: [] }])}>
          加否则(else)
        </Button>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        分支按顺序求值，「否则」兜底；未命中分支的子步骤在执行期标 skip。
      </Typography.Text>
    </Space>
  );
}

interface Rule { var?: string; from?: string; expr?: string }
function ExtractEditor({ node }: { node: StepNode }) {
  const updateConfig = useSceneStore((s) => s.updateConfig);
  const readOnly = useSceneStore((s) => s.readOnly);
  const rules = (Array.isArray(node.config?.rules) ? node.config.rules : []) as Rule[];
  const write = (rs: Rule[]) => updateConfig(node.key, { rules: rs });
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={6}>
      {rules.map((r, i) => (
        <Space key={i} data-testid={"prop-rule-" + i}>
          <Input placeholder="变量名" value={r.var ?? ""} style={{ width: 110 }} disabled={readOnly}
            onChange={(e) => { const rs = rules.slice(); rs[i] = { ...rs[i], var: e.target.value }; write(rs); }} />
          <Input placeholder="JSONPath，如 $.data.id" value={r.expr ?? ""} style={{ width: 160 }} disabled={readOnly}
            onChange={(e) => { const rs = rules.slice(); rs[i] = { ...rs[i], expr: e.target.value }; write(rs); }} />
          {!readOnly && (
          <Button size="small" danger type="text" icon={<DeleteOutlined />}
            onClick={() => write(rules.filter((_, x) => x !== i))} />
          )}
        </Space>
      ))}
      {!readOnly && (
      <Button size="small" icon={<PlusOutlined />} data-testid="prop-rule-add"
        onClick={() => write([...rules, { var: "", from: "last_response", expr: "" }])}>
        加提取规则
      </Button>
      )}
    </Space>
  );
}

// 断言行形状唯一实现点是 api/req.ts 的 Assertion（后端 shared/assertions.py 的 evaluate
// 吃同一套字典）。这里曾经自己抄过一份行形状 + 一份类型表——同形状的三处手工同步必长歪：
// 上一轮给类型表加「脚本断言」时，本文件的行形状没有 code，用户选了却无处填正文。
type Asrt = SceneAssertion;
// 断言类型表唯一实现点在 api/req.ts 的 ASSERT_TYPES（与后端 schemas.py 的 ASSERTION_TYPES
// 由 assertionTypes.contract.test.ts 钉死同源）。这里曾自己抄过一份五类表——
// 三处手工同步必长歪，现改为 import，重复消灭在源头。

/**
 * 断言行编辑（步骤断言与场景公共断言**共用**这一套，R85：两套会长歪）。
 * 受控组件：items 在外层状态里（步骤=config.assertions，场景=store.commonAssertions）。
 * prefix 给行 testid 加前缀（prop-assert / scene-cassert），两套互不撞。
 * export 给组件测试（PropsPanel.assert.test.tsx）：整板渲染要拖 store/auth/router/定时接口，
 * 断言行这套控件的形状值得单独钉，不借整板的光。
 */
export function AssertionListEditor({ items, onChange, prefix, addLabel, emptyHint, ro = false }: {
  items: Asrt[];
  onChange: (xs: Asrt[]) => void;
  prefix: string;
  addLabel: string;
  emptyHint?: string;
  /** D146：只读透传（步骤断言与场景公共断言共用这一套，门也只写一份）。 */
  ro?: boolean;
}) {
  const write = (xs: Asrt[]) => onChange(xs);
  const setAt = (i: number, p: Partial<Asrt>) => {
    const xs = items.slice();
    xs[i] = { ...xs[i], ...p };
    write(xs);
  };
  // D78 排序：上移/下移改数组顺序；后端 evaluate 按数组顺序求值，顺序即语义（不引拖拽库）
  const move = (i: number, j: number) => {
    if (j < 0 || j >= items.length) return;
    const xs = items.slice();
    const t = xs[i];
    xs[i] = xs[j];
    xs[j] = t;
    write(xs);
  };
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={6}>
      {items.length === 0 && emptyHint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid={prefix + "-empty"}>
          {emptyHint}
        </Typography.Text>
      )}
      {items.map((a, i) => (
        <Space key={i} data-testid={prefix + "-" + i} wrap>
          <Select value={a.type} style={{ width: 140 }} options={ASSERT_TYPES} disabled={ro}
            // 切类型 = 换语义：上一类型的载荷键归零，否则旧 code 会跟着 status_code 存进
            // 断言数组，执行人看得见却永不执行（与 RequestEditor 的 D75 同一口径）。
            // enabled 是行级属性不是类型载荷，切类型不动它。
            onChange={(v) => setAt(i, { type: v, path: undefined, expected: undefined, timeout_ms: null, code: null })} />
          {(a.type === "json_path_equals" || a.type === "regex") && (
            <Input data-testid={prefix + "-path-" + i} disabled={ro}
              placeholder={a.type === "regex" ? "JSONPath（可选）" : "$.status"} value={String(a.path ?? "")} style={{ width: 120 }}
              onChange={(e) => setAt(i, { path: e.target.value })} />
          )}
          {a.type === "script" ? (
            // 表里给了「脚本断言」就得给输入框：沙箱读的是 code 正文（shared/assertions.py
            // 的 script 分支），缺它后端回「script 断言缺少 code 正文」——没有输入框的
            // 选项就是让用户选一个永远填不上的类型。
            // R49/D174：升级 CodeEditor（本文件已有懒加载 CodeEditor，script 步骤同款）。
            // testid 落外层 div：CodeEditor 不转发 testid，现有测试经 wrapper 定位不变。
            <div data-testid={prefix + "-code-" + i} style={{ width: 420 }}>
              <Suspense fallback={editorFallback}>
                <CodeEditor height={120} language="python" readOnly={ro}
                  value={a.code ?? ""} onChange={(v) => setAt(i, { code: v })} />
              </Suspense>
            </div>
          ) : (
            <Input placeholder={a.type === "regex" ? "正则，如 ^tk$" : "预期值"} value={String(a.expected ?? "")} style={{ width: 120 }} disabled={ro}
              onChange={(e) => setAt(i, { expected: e.target.value })} />
          )}
          {(a.type === "response_time_lt" || a.type === "script") && (
            <InputNumber data-testid={prefix + "-timeout-" + i} style={{ width: 120 }} min={1} disabled={ro}
              placeholder="毫秒" value={a.timeout_ms ?? null} addonAfter="ms"
              onChange={(v) => setAt(i, { timeout_ms: v == null ? null : Number(v) })} />
          )}
          {/* D78 启用开关：缺省=启用；关掉的行后端不执行、不产结果行（shared/assertions.py） */}
          <Switch size="small" data-testid={prefix + "-enabled-" + i} checked={a.enabled !== false} disabled={ro}
            checkedChildren="启用" unCheckedChildren="停用" onChange={(v) => setAt(i, { enabled: v })} />
          <Button size="small" type="text" icon={<ArrowUpOutlined />} data-testid={prefix + "-up-" + i}
            aria-label={"上移断言" + i} disabled={i === 0 || ro} onClick={() => move(i, i - 1)} />
          <Button size="small" type="text" icon={<ArrowDownOutlined />} data-testid={prefix + "-down-" + i}
            aria-label={"下移断言" + i} disabled={i === items.length - 1 || ro} onClick={() => move(i, i + 1)} />
          {!ro && (
          <Button size="small" danger type="text" icon={<DeleteOutlined />}
            data-testid={prefix + "-del-" + i}
            onClick={() => write(items.filter((_, x) => x !== i))} />
          )}
        </Space>
      ))}
      {!ro && (
      <Button size="small" icon={<PlusOutlined />} data-testid={prefix + "-add"}
        onClick={() => write([...items, { type: "status_code", expected: 200 }])}>
        {addLabel}
      </Button>
      )}
    </Space>
  );
}

function AssertEditor({ node }: { node: StepNode }) {
  const updateConfig = useSceneStore((s) => s.updateConfig);
  const readOnly = useSceneStore((s) => s.readOnly);
  const items = (Array.isArray(node.config?.assertions) ? node.config.assertions : []) as Asrt[];
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={6}>
      <AssertionListEditor items={items} prefix="prop-assert" addLabel="加断言" ro={readOnly}
        onChange={(xs) => updateConfig(node.key, { assertions: xs })} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        脚本断言走沙箱（T5 已开放）；类型表与请求编辑器同源（api/req.ts ASSERT_TYPES）。
      </Typography.Text>
    </Space>
  );
}

function JsonBox({ text, onCommit, ro = false }: { text: string; onCommit: (obj: Record<string, unknown>) => void; ro?: boolean }) {
  const [draft, setDraft] = useState(text);
  useEffect(() => { setDraft(text); }, [text]);
  const [bad, setBad] = useState(false);
  return (
    <div>
      <Suspense fallback={editorFallback}>
        <CodeEditor language="json" height={160} value={draft} onChange={setDraft} readOnly={ro} />
      </Suspense>
      {!ro && (
      <Button size="small" style={{ marginTop: 6 }} onClick={() => {
        try { onCommit(JSON.parse(draft) as Record<string, unknown>); setBad(false); }
        catch { setBad(true); }
      }}>应用 JSON</Button>
      )}
      {bad && <Typography.Text type="danger" style={{ fontSize: 12 }}>JSON 解析失败，先改对再应用</Typography.Text>}
    </div>
  );
}
