// 环境下拉 + 环境与全局配置管理（§7.5 分层变量）。
// 变量优先级：请求内写死 > 环境 vars > 项目全局配置；这里把两层都摊开，避免用户猜哪层生效。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, Col, Empty, Input, InputNumber, List, Modal, Row, Select, Space, Tabs, Tag,
  Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, PlusOutlined, SettingOutlined } from "../ui/icons";
import { del, get, patch, post, ApiErr } from "./client";
import PermEmpty from "../components/PermEmpty";
import { useAuth } from "../auth/store";
import { PairTable } from "./RequestEditor";
import type { Pair } from "./req";
import type { EnvRow, Page } from "./api";

type Rows = Pair[];
const toRows = (ps: unknown): Rows => (Array.isArray(ps) ? (ps as Pair[]).map((p) => [p[0] ?? "", p[1] ?? ""]) : []);
const toPairs = (rs: Rows): Pair[] => rs.filter((p) => p[0].trim() !== "").map((p) => [p[0].trim(), p[1]]);
const sortEnvs = (xs: EnvRow[]) => [...xs].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

interface DraftEnv {
  id: string | null;
  name: string;
  position: number;
  vars: Rows;
  headers: Rows;
  timeout_ms: number | null;
}

/** 删环境被 409 in_use 拦下时的 details（env/services.py 的 _env_refs，逐域各带一把权限尺）。
 *  键是表名（scenario / ui_case / schedule_task）——与后端 _ENV_REF_DOMAINS 同源，
 *  后端加域时这里跟着加，缺席的域一律按「不可见」处理而不是当 0（宁可少说不少说）。
 *
 *  三个数各说一件事，渲染时不许合并（后端 EnvRef 的同一把尺）：
 *  count = own + foreign；items 只从 own 取，最多 REF_DETAIL_CAP 条。
 *  own/foreign/details_truncated 是必填的：后端与本页同一次改动落地，缺席就是契约破了，
 *  要让它编译不过，而不是靠 `??` 悄悄演成 0（演成 0 = 「其他项目没有引用」这句假话）。 */
interface EnvDomainRef {
  label: string;
  count: number;
  own: number;
  foreign: number;
  items: { id: string; name: string }[];
  details_hidden: boolean;
  details_truncated: boolean;
}
interface EnvInUseDetails {
  env_id: string;
  count: number;
  scenario?: EnvDomainRef;
  ui_case?: EnvDomainRef;
  schedule_task?: EnvDomainRef;
}
const ENV_REF_KEYS = ["scenario", "ui_case", "schedule_task"] as const;
/** 每域「看明细要哪把权限」——只用来把后端给的 details_hidden 说成人话，
 *  不用来重新决定给不给看（给不给由后端按调用者自己的权限算，那才是权威）。 */
const ENV_REF_PERM: Record<(typeof ENV_REF_KEYS)[number], string> = {
  scenario: "scenario:read", ui_case: "ui:case:read", schedule_task: "schedule:read",
};

const blankEnv = (position: number): DraftEnv => ({
  id: null, name: "", position, vars: [["", ""]], headers: [["", ""]], timeout_ms: null,
});
const draftFrom = (e: EnvRow): DraftEnv => ({
  id: e.id,
  name: e.name,
  position: e.position,
  vars: (() => { const v = toRows((e.config ?? {}).vars); return v.length ? v : [["", ""]]; })(),
  headers: (() => { const v = toRows((e.config ?? {}).headers); return v.length ? v : [["", ""]]; })(),
  timeout_ms: typeof (e.config ?? {}).timeout_ms === "number" ? ((e.config ?? {}).timeout_ms as number) : null,
});

// WHY 按宿主分裂这句承诺：UI 环境桥只保留 vars/env_name（ui_test/debug_services.py:139-140），
// EnvResolveOut.headers 在中转处即被丢弃（env/schemas.py:58-60），ui_core.py 全文零 header
// 概念——「公共请求头来自这里」在 UI 用例页（uiCaseDetail.tsx:207）是零效果的假话。
export default function EnvSelect({ projectId, value, onChange, canManage, canCreate, headersApply = true, width = 236 }: {
  projectId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  canManage: boolean;
  canCreate: boolean;
  headersApply?: boolean;
  /** 组合控件总宽（select + 管理钮）。列表页工具栏空间紧时传小一点。 */
  width?: number;
}) {
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // 环境取失败：placeholder 与管理窗内提示都要改口——失败不是「还没有环境」，是第三种状态
  const [envsFailed, setEnvsFailed] = useState(false);

  const load = useCallback(async (): Promise<EnvRow[]> => {
    setLoading(true);
    try {
      const r = await get<Page<EnvRow>>("/envs?project_id=" + encodeURIComponent(projectId) + "&size=200",
        { silent: true });
      const items = sortEnvs(r.items);
      setEnvs(items);
      setEnvsFailed(false);
      return items;
    } catch {
      setEnvs([]);
      setEnvsFailed(true);
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 默认选中第一个环境：项目里配好环境后开箱即用，不用每次手选
  useEffect(() => {
    void (async () => {
      const items = await load();
      if (value === null && items.length) onChange(items[0].id);
      if (value && !items.some((e) => e.id === value)) onChange(items.length ? items[0].id : null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <>
      <Tooltip title={headersApply
        ? "调试时使用的环境：变量与公共请求头来自这里"
        : "UI 运行只取这里的变量：UI 执行核没有请求头概念，公共请求头不会注入"}>
        <Space.Compact block style={{ width }}>
          <Select
            data-testid="env-select" style={{ flex: 1 }} value={value ?? undefined} loading={loading}
            placeholder={envsFailed ? "环境没取到，重进本页可重试"
              : envs.length ? "环境" : "还没有环境"}
            options={envs.map((e) => ({ value: e.id, label: e.name }))}
            onChange={(v) => onChange(v)}
          />
          <Tooltip title="管理环境与变量">
            <Button data-testid="env-manage" icon={<SettingOutlined />} onClick={() => setOpen(true)} />
          </Tooltip>
        </Space.Compact>
      </Tooltip>
      {envsFailed && (
        <Typography.Text type="danger" data-testid="env-select-failed">
          环境列表没取到，这句「没有环境」不作数——切项目重进，或在管理窗里新建/保存都会重新拉。
        </Typography.Text>
      )}
      <EnvManager
        open={open} onClose={() => setOpen(false)} projectId={projectId}
        envs={envs} failed={envsFailed} onReload={load} canManage={canManage} canCreate={canCreate}
        selected={value} onSelect={onChange}
      />
    </>
  );
}

function EnvManager({ open, onClose, projectId, envs, failed, onReload, canManage, canCreate, selected, onSelect }: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  envs: EnvRow[];
  // 取数失败要下传到管理窗：同一份 envs=[] 在列表侧喊「还没有环境」就是假话
  failed: boolean;
  onReload: () => Promise<EnvRow[]>;
  canManage: boolean;
  canCreate: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [tab, setTab] = useState("env");

  // D139：被引用的环境删不掉（409 in_use），这里要把「谁在引用」摊开点名。
  const [inUse, setInUse] = useState<{ name: string; details: EnvInUseDetails } | null>(null);

  const [draft, setDraft] = useState<DraftEnv | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) { setDraft(null); return; }
    const cur = envs.find((e) => e.id === selected) ?? envs[0];
    setDraft(cur ? draftFrom(cur) : envs.length ? null : blankEnv(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { message.warning("环境名必填"); return; }
    setSaving(true);
    try {
      const config: Record<string, unknown> = { vars: toPairs(draft.vars), headers: toPairs(draft.headers) };
      if (draft.timeout_ms && draft.timeout_ms > 0) config.timeout_ms = draft.timeout_ms;
      if (draft.id) {
        await patch<EnvRow>("/envs/" + draft.id, { project_id: projectId, name, position: draft.position, config });
        message.success("环境已保存");
      } else {
        const out = await post<EnvRow>("/envs", { project_id: projectId, name, position: draft.position, config });
        onSelect(out.id);
        message.success("环境已创建并选中");
      }
      await onReload();
    } catch { /* toast */ } finally { setSaving(false); }
  }

  function remove(e: EnvRow) {
    Modal.confirm({
      title: "删除环境？",
      // 旧文案写「引用它的环境选择会失效……需重新选择环境才能继续运行」——那是删成功之后
      // 的形状，而 D139 起被引用的环境根本删不掉（409 in_use）。文案不许承诺一个系统
      // 已经不会发生的行为（第十道差集：文案承诺 → 兑现）。
      content: `「${e.name}」的变量与请求头会一并删除，不可恢复。被场景 / UI 用例 / 定时任务引用时删不掉，届时会列出是谁在引用。`,
      okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => {
        try {
          await del("/envs/" + e.id, { project_id: projectId });
          message.success("已删除");
          const items = await onReload();
          if (selected === e.id) onSelect(items.length ? items[0].id : null);
          if (draft?.id === e.id) setDraft(null);
        } catch (err) {
          // 拦截不是失败：409 的 details 里有逐域引用清单，咽进 catch 就等于把答案丢了
          // （此前只有一条通用 toast，用户只能一条条场景里翻）。
          if (err instanceof ApiErr && err.code === "in_use") {
            setInUse({ name: e.name, details: err.details as EnvInUseDetails });
          } // 其余错误 toast 已弹
        }
      },
    });
  }

  return (
    <>
    <Modal open={open} onCancel={onClose} width={920} destroyOnHidden title="环境与全局配置"
      footer={<Button type="primary" data-testid="env-close" onClick={onClose}>完成</Button>}
    >
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: "env", label: "环境", children: (
          <Row gutter={16}>
            <Col span={8}>
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <List size="small" bordered
                  dataSource={envs}
                  locale={{ emptyText: failed ? (
                    <Typography.Text type="danger" data-testid="env-manager-failed">
                      环境列表没取到，这里不能当「没有环境」——新建或保存环境会重新拉。
                    </Typography.Text>
                  ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有环境" /> }}
                  renderItem={(e) => (
                    <List.Item
                      data-testid="env-item"
                      style={{
                        cursor: "pointer",
                        background: draft?.id === e.id || (!draft && e.id === selected) ? "var(--tp-bg-selected)" : undefined,
                        paddingLeft: 8,
                      }}
                      onClick={() => setDraft(draftFrom(e))}
                      actions={canManage ? [
                        <Tooltip key="d" title="删除环境">
                          <Button size="small" type="text" danger icon={<DeleteOutlined />}
                            data-testid="env-delete" aria-label={"删除环境-" + e.name}
                            onClick={(ev) => { ev.stopPropagation(); remove(e); }} />
                        </Tooltip>,
                      ] : []}
                    >
                      <Space>
                        <Typography.Text>{e.name}</Typography.Text>
                        {e.id === selected && <Tag color="blue">当前</Tag>}
                      </Space>
                    </List.Item>
                  )}
                />
                {canCreate && (
                  <Button block icon={<PlusOutlined />} data-testid="env-new"
                    onClick={() => setDraft(blankEnv(envs.length ? Math.max(...envs.map((x) => x.position)) + 1 : 0))}>
                    新建环境
                  </Button>
                )}
              </Space>
            </Col>
            <Col span={16}>
              {!draft ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧环境进行编辑" />
              ) : (
                <Space direction="vertical" style={{ width: "100%" }} size={10}>
                  <Space wrap>
                    <Input data-testid="env-name" style={{ width: 220 }} maxLength={200}
                      placeholder="环境名，如 测试环境" value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    <Tooltip title="序号小的排在前面，默认选中最小的那个">
                      <InputNumber data-testid="env-position" min={0} max={999} style={{ width: 110 }}
                        addonBefore="#" value={draft.position}
                        onChange={(v) => setDraft({ ...draft, position: Number(v ?? 0) })} />
                    </Tooltip>
                    {/* WHY：后端仅在请求不带 timeout_ms 键时套用这里的值（api_test/services.py:426 explicit_timeout 门槛），编辑器保存的请求总带该键，故实际只作用于编辑器外创建的请求 */}
                    <Tooltip title="仅对未自带超时的请求生效；本编辑器保存的请求总自带超时，这里实际作用于编辑器外（如 Agent）创建的请求">
                      <InputNumber data-testid="env-timeout" min={0} max={120000} step={500} style={{ width: 170 }}
                        addonBefore="超时" addonAfter="ms" value={draft.timeout_ms}
                        onChange={(v) => setDraft({ ...draft, timeout_ms: v == null ? null : Number(v) })} />
                    </Tooltip>
                    {(canCreate || canManage) && (
                      <Button type="primary" data-testid="env-save" loading={saving} onClick={() => void save()}>
                        保存环境
                      </Button>
                    )}
                  </Space>
                  <Tabs size="small" items={[
                    { key: "vars", label: `变量（${toPairs(draft.vars).length}）`, children: (
                      <PairTable idPrefix="env-var" rows={draft.vars} onChange={(v) => setDraft({ ...draft, vars: v })}
                        ro={false} kPh="变量名，如 base_url" vPh="值，如 http://127.0.0.1:9999" />
                    ) },
                    { key: "headers", label: `公共请求头（${toPairs(draft.headers).length}）`, children: (
                      <PairTable idPrefix="env-header" rows={draft.headers} onChange={(v) => setDraft({ ...draft, headers: v })}
                        ro={false} kPh="Header 名，如 Authorization" vPh="值，可写 Bearer ${token}" />
                    ) },
                  ]} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    在 URL、参数、请求头、断言里用 `${"{"}变量名{"}"}` 引用；同名时这里覆盖全局配置。
                  </Typography.Text>
                </Space>
              )}
            </Col>
          </Row>
        ) },
        { key: "global", label: "项目全局配置", children: <GlobalConfig projectId={projectId} canManage={canManage} /> },
      ]} />
    </Modal>
    {/* D139：删除被引用拦下时点名「是谁在引用」。三个数各说各的，一句只担一件事：
         own→列名字，foreign→只报条数（跨项目的名字在这屏够不着，点了只会让人在本项目里找它），
         details_hidden→缺哪把权限；details_truncated→被上限截了几条。 */}
    {inUse && (
      <Modal open title="删除被拦截：该环境正被引用" width={600} okText="知道了"
        cancelButtonProps={{ style: { display: "none" } }}
        okButtonProps={{ "data-testid": "env-inuse-close" }}
        onOk={() => setInUse(null)} onCancel={() => setInUse(null)}>
        <div data-testid="env-inuse">
          <Typography.Paragraph>
            「{inUse.name}」被 <Typography.Text strong>{inUse.details.count}</Typography.Text> 处引用，先解绑再删。
          </Typography.Paragraph>
          {ENV_REF_KEYS.map((k) => {
            const d = inUse.details[k];
            if (!d) return null;
            // 只认后端的 details_hidden——它是请求当时按调用者真实权限算的。
            // 这里刻意不学 notifyChannels.tsx:492 再 `|| !matchPerm(本地 perms)`：本地
            // project.my_perms 可能还没拉到（patternsForProject 回 []），那样会给一个
            // **有权限**的人看「需要 xxx 权限」——正是后端 test_..._cross_project_reference
            // 刚钉死不许出现的那句假话。权限判断的权威在后端，前端只负责把 true 说成人话。
            return (
              <div key={k} data-testid={"env-inuse-" + k} style={{ marginBottom: 10 }}>
                <Typography.Text strong>{d.label}</Typography.Text>
                <Typography.Text>：{d.count} 条</Typography.Text>
                {d.details_hidden ? (
                  // 空的原因说成「缺权限」——这一格是真的（后端按调用者权限咽掉了明细）
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                    明细需要 {ENV_REF_PERM[k]} 权限，当前不可见。
                  </Typography.Paragraph>
                ) : (
                  <>
                    {d.own > 0 && (
                      <ul style={{ margin: 0, paddingLeft: 20 }}>
                        {d.items.map((it) => <li key={it.id} data-testid="env-inuse-item">{it.name}</li>)}
                      </ul>
                    )}
                    {d.details_truncated && (
                      <Typography.Paragraph type="secondary" data-testid="env-inuse-truncated"
                        style={{ marginBottom: 0, fontSize: 12 }}>
                        仅列前 {d.items.length} 条，另有 {d.own - d.items.length} 条本项目内的引用未列出。
                      </Typography.Paragraph>
                    )}
                    {/* foreign 与权限无关：有权限也拿不到名字，所以这句绝不能写成「无权限查看」
                        （那会让人去申请一个申请了也没用的权限）。 */}
                    {d.foreign > 0 && (
                      <Typography.Paragraph type="secondary" data-testid="env-inuse-foreign"
                        style={{ marginBottom: 0, fontSize: 12 }}>
                        另有 {d.foreign} 条在其它项目，不在此列出；它们同样拦住这次删除，请到对应项目解绑。
                      </Typography.Paragraph>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Modal>
    )}
    </>
  );
}

export function GlobalConfig({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { project } = useAuth();
  const [scopes, setScopes] = useState<Record<string, unknown>>({ VAR: [], HEADER: [], ASSERT: [], EXTRACT: [] });
  const [vars, setVars] = useState<Rows>([["", ""]]);
  const [headers, setHeaders] = useState<Rows>([["", ""]]);
  const [saving, setSaving] = useState<"VAR" | "HEADER" | null>(null);
  // D38 权限空页（Tab 内被拒路径）：这个 Tab 的数据门是 env:config:read，403 时给落地页
  const [forbidden, setForbidden] = useState<ApiErr | null>(null);
  // 保存是**覆盖式**的（POST 整段替换该作用域，见 env/services.py:131 的描述），所以「服务器现在
  // 有什么」是保存的前提知识：GET 失败时表格画的是空行，那时点保存就等于把项目里已有的全局变量
  // 整段写成空。拿不到就不许保存——这不是措辞问题，是这条腿会真删数据。
  const [scopesState, setScopesState] = useState<"loading" | "ok" | "failed">("loading");
  // 手上有没有一份「确实读到过」的现状。保存成功后的重拉如果失败，屏上那份就是刚发出去的那份，
  // 覆盖式保存的前提仍然成立——这时喊「没取到」反而是句假话，还会把刚存完的钮收走。
  const haveSnapshot = useRef(false);
  // 取数在途期间用户有没有动过表格。保存期间 PairTable 仍可编辑（ro 只跟 canManage 走），
  // 而保存后的重拉会无条件 setVars/setHeaders——那会把人在等待里敲的半行吃掉。和「拿故障演
  // 空数据」是同一族的方向反例：那次是屏上说的比手上少，这次是屏上盖掉的比收到的多。
  const editGen = useRef(0);

  const load = useCallback(async () => {
    // 只在「手上还没有现状」时才降级：保存成功后会再 load() 一次，那次不该把已经显示的
    // 条数和钮一起收回空态（那等于每次保存后都闪一次「没取到」）。
    const myEdit = editGen.current;
    setScopesState((s) => (s === "ok" ? "ok" : "loading"));
    try {
      const r = await get<{ scopes: Record<string, unknown> }>(
        "/envs/global-config?project_id=" + encodeURIComponent(projectId), { silent: true });
      setScopes(r.scopes);
      // 现状/计数照收，但两张表只在没人动过时才回灌：在途窗口里人敲的那半行不是旧数据，
      // 「保存会整段覆盖」的前提是他看得见自己要发出去的东西。
      if (myEdit === editGen.current) {
        const v = toRows(r.scopes.VAR); setVars(v.length ? v : [["", ""]]);
        const h = toRows(r.scopes.HEADER); setHeaders(h.length ? h : [["", ""]]);
      }
      setForbidden(null);
      haveSnapshot.current = true;
      setScopesState("ok");
    } catch (e) { /* toast */
      if (haveSnapshot.current) setScopesState("ok");
      else setScopesState("failed");
      if (e instanceof ApiErr && e.status === 403) setForbidden(e);
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  if (forbidden) {
    return <PermEmpty error={forbidden} projectName={project?.name ?? ""} context="查看项目全局配置" />;
  }

  async function saveScope(scope: "VAR" | "HEADER", rows: Rows) {
    setSaving(scope);
    try {
      await post("/envs/global-config", { project_id: projectId, scope_type: scope, items: toPairs(rows) });
      message.success(scope === "VAR" ? "全局变量已保存" : "全局请求头已保存");
      await load();
    } catch { /* toast */ } finally { setSaving(null); }
  }

  const assertCount = toRows(scopes.ASSERT).length + toRows(scopes.EXTRACT).length;
  // 没读到现状时不报条数：「全局变量（0）」在读失败的那一格同样是句假话。
  const cnt = (n: number) => (scopesState === "ok" ? `（${n}）` : "");
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={10}>
      {scopesState === "failed" && (
        // 空表 + 覆盖式保存 = 一次点击就能把已有配置写没，所以这里要占满注意力：
        // 说清「是没取到、不是没有」，并给出不用整页刷新的出路（本页切 Tab 不会重拉）。
        <Alert type="error" showIcon data-testid="global-config-failed"
          message="全局配置没取到（不是项目里没有配置）"
          description="保存会整段覆盖服务器上的同名作用域，所以没读到现状前保存钮是禁用的——这不是网络通了就自动恢复，得重拉一次。"
          action={<Button size="small" data-testid="global-config-retry" onClick={() => void load()}>重试</Button>} />
      )}
      <Alert type="info" showIcon data-testid="global-hint"
        message="全局配置对所有环境生效；环境里同名变量会覆盖这里。"
        description={`典型用法：base_url 这类跨环境不变的值放这里，环境里只写差异项。` +
          (assertCount ? ` 已保存 ${assertCount} 条全局断言/提取配置（存而未用：尚未接入执行链路）。` : "")}
      />
      <Tabs size="small" items={[
        { key: "VAR", label: `全局变量${cnt(toPairs(vars).length)}`, children: (
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <PairTable idPrefix="gvar" rows={vars} onChange={(v) => { editGen.current += 1; setVars(v); }} ro={!canManage} kPh="变量名，如 base_url" vPh="值" />
            {canManage && (
              <Button type="primary" data-testid="global-save-var" loading={saving === "VAR"} disabled={scopesState !== "ok"}
                onClick={() => void saveScope("VAR", vars)}>保存全局变量</Button>
            )}
          </Space>
        ) },
        { key: "HEADER", label: `全局请求头${cnt(toPairs(headers).length)}`, children: (
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <PairTable idPrefix="ghdr" rows={headers} onChange={(v) => { editGen.current += 1; setHeaders(v); }} ro={!canManage} kPh="Header 名" vPh="值" />
            {canManage && (
              <Button type="primary" data-testid="global-save-header" loading={saving === "HEADER"} disabled={scopesState !== "ok"}
                onClick={() => void saveScope("HEADER", headers)}>保存全局请求头</Button>
            )}
          </Space>
        ) },
      ]} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        引用写法：`${"{"}base_url{"}"}` —— 缺失变量时调试会直接报错并指出变量名，不会静默发半个 URL。
      </Typography.Text>
    </Space>
  );
}
