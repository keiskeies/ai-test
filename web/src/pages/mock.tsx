// API Mock 管理（D201）：Mock 服务 + 规则 + 公开地址 + 规则试匹配。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import { mockApi, type MockRule, type MockService } from "../api/mock";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"];

// D241：列设置面板（key 与 rules 表的 key 逐字一致；ops 是操作钮，不可隐藏）。
const MOCK_RULE_COL_CHOICES: ColumnChoice[] = [
  { key: "prio", label: "顺序" },
  { key: "name", label: "名称" },
  { key: "m", label: "匹配" },
  { key: "resp", label: "响应" },
  { key: "enabled", label: "启用" },
];

const MATCH_LABEL: Record<string, string> = { exact: "精确", prefix: "前缀", regex: "正则" };

// 高级搜索的候选值：方法与匹配方式复用页面同一份词表（不另抄一份）。
const MOCK_RULE_FILTER_OPTIONS: Record<string, Option[]> = {
  method: METHODS.map((m) => ({ value: m, label: m })),
  match_type: Object.entries(MATCH_LABEL).map(([value, label]) => ({ value, label })),
};

function ServiceModal({ open, projectId, editing, onClose, onSaved }: {
  open: boolean; projectId: string; editing: MockService | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ""); setDescription(editing?.description ?? "");
  }, [open, editing]);
  return (
    <Modal open={open} onCancel={onClose} centered width={520}
      title={editing ? "编辑 Mock 服务" : "新建 Mock 服务"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "mock-service-save" }} onOk={async () => {
        if (!name.trim()) { message.warning("名称必填"); return; }
        setBusy(true);
        try {
          if (editing) await mockApi.updateService(editing.id, { project_id: projectId, name: name.trim(), description });
          else await mockApi.createService({ project_id: projectId, name: name.trim(), description });
          message.success("已保存"); onSaved(); onClose();
        } catch (e) { message.error(e instanceof ApiErr ? e.message : "保存失败"); }
        finally { setBusy(false); }
      }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Input data-testid="mock-service-name" placeholder="服务名" value={name} onChange={(e) => setName(e.target.value)} />
        <Input.TextArea rows={2} placeholder="说明" value={description}
          onChange={(e) => setDescription(e.target.value)} />
      </Space>
    </Modal>
  );
}

function RuleModal({ open, projectId, serviceId, editing, onClose, onSaved }: {
  open: boolean; projectId: string; serviceId: string; editing: MockRule | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [matchType, setMatchType] = useState<"exact" | "prefix" | "regex">("exact");
  const [status, setStatus] = useState(200);
  const [headers, setHeaders] = useState("{}");
  const [body, setBody] = useState("");
  const [delay, setDelay] = useState(0);
  const [priority, setPriority] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ""); setMethod(editing?.method ?? "GET");
    setPath(editing?.path ?? "/"); setMatchType(editing?.match_type ?? "exact");
    setStatus(editing?.status_code ?? 200);
    setHeaders(JSON.stringify(editing?.headers ?? {}, null, 2));
    setBody(editing?.body ?? ""); setDelay(editing?.delay_ms ?? 0);
    setPriority(editing?.priority ?? 0); setEnabled(editing?.enabled ?? true);
    setErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim() || !path.trim()) { message.warning("名称与路径必填"); return; }
    let hdr: Record<string, string>;
    try { hdr = headers.trim() ? JSON.parse(headers) as Record<string, string> : {}; }
    catch { message.warning("响应头必须是合法 JSON 对象"); return; }
    setBusy(true); setErr(null);
    const payload = {
      project_id: projectId, service_id: serviceId, name: name.trim(),
      method, path: path.trim(), match_type: matchType, status_code: status,
      headers: hdr, body, delay_ms: delay, priority, enabled,
    };
    try {
      if (editing) await mockApi.updateRule(editing.id, projectId, payload);
      else await mockApi.createRule(payload);
      message.success("已保存"); onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={720}
      title={editing ? "编辑 Mock 规则" : "新建 Mock 规则"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "mock-rule-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Space size={10} wrap>
          <Input data-testid="mock-rule-name" placeholder="规则名" value={name} style={{ width: 220 }} onChange={(e) => setName(e.target.value)} />
          <Select value={method} style={{ width: 100 }} onChange={setMethod}
            options={METHODS.map((m) => ({ value: m, label: m }))} />
          <Select value={matchType} style={{ width: 110 }} onChange={(v) => setMatchType(v as typeof matchType)}
            options={[{ value: "exact", label: "精确" }, { value: "prefix", label: "前缀" },
              { value: "regex", label: "正则" }]} />
          <Switch checked={enabled} onChange={setEnabled} />
        </Space>
        <Input placeholder="路径（精确/前缀以 / 开头；正则任意）" value={path}
          onChange={(e) => setPath(e.target.value)} />
        <Space size={10} wrap>
          <div><Typography.Text strong>状态码</Typography.Text>
            <Input type="number" value={status} style={{ width: 100 }}
              onChange={(e) => setStatus(Number(e.target.value))} /></div>
          <div><Typography.Text strong>延迟 ms</Typography.Text>
            <Input type="number" value={delay} style={{ width: 100 }}
              onChange={(e) => setDelay(Number(e.target.value))} /></div>
          <div><Typography.Text strong>优先级</Typography.Text>
            <Input type="number" value={priority} style={{ width: 100 }}
              onChange={(e) => setPriority(Number(e.target.value))} /></div>
        </Space>
        <div>
          <Typography.Text strong>响应头（JSON 对象）</Typography.Text>
          <Input.TextArea rows={3} value={headers} style={{ fontFamily: "monospace" }}
            onChange={(e) => setHeaders(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>响应体</Typography.Text>
          <Input.TextArea rows={6} value={body} style={{ fontFamily: "monospace" }}
            onChange={(e) => setBody(e.target.value)} />
        </div>
        {err && <Alert type="error" showIcon message={err} />}
      </Space>
    </Modal>
  );
}

function MockWorkbench() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canEdit = can(perms, "mock:mock:create") && can(perms, "mock:mock:update");
  const canDelete = can(perms, "mock:mock:delete");

  const [services, setServices] = useState<MockService[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rules, setRules] = useState<MockRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [svcModal, setSvcModal] = useState<{ editing: MockService | null } | null>(null);
  const [ruleModal, setRuleModal] = useState<{ editing: MockRule | null } | null>(null);
  const [testMethod, setTestMethod] = useState("GET");
  const [testPath, setTestPath] = useState("/");
  const [testResult, setTestResult] = useState<string | null>(null);
  // D241：规则表的高级搜索条件组 + 列设置（三件套铺到 Mock 规则列表）。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("mock_rule", MOCK_RULE_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await mockApi.services(pid);
      setServices(r.items);
      const sid = selected && r.items.some((s) => s.id === selected) ? selected : r.items[0]?.id ?? null;
      setSelected(sid);
      // 空条件不拼 filter（与其余列表页同一把尺）；条件在服务作用域内由后端 WHERE 筛。
      setRules(sid
        ? (await mockApi.rules(pid, sid,
            isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter))).items
        : []);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "Mock 加载失败");
    } finally { setLoading(false); }
  }, [pid, selected, advFilter]);
  useEffect(() => { void load(); }, [load]);

  const current = services.find((s) => s.id === selected) ?? null;
  const mockUrl = current ? window.location.origin + current.mock_base : "";

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Mock 服务</Typography.Title>
          {canEdit && <Button size="small" icon={<PlusOutlined />} data-testid="mock-service-new"
            onClick={() => setSvcModal({ editing: null })}>新建服务</Button>}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </Space>
        {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
        <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={services}
          locale={{ emptyText: "还没有 Mock 服务" }}
          onRow={(r) => ({ onClick: () => setSelected(r.id) })}
          rowClassName={(r) => r.id === selected ? "ant-table-row-selected" : ""}
          columns={[
            { title: "名称", dataIndex: "name" },
            { title: "规则数", dataIndex: "rule_count", width: 80 },
            { title: "启停", dataIndex: "enabled", width: 80, render: (v: boolean) => v
              ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
            { title: "公开地址", key: "url", render: (_, r) => (
              <Space size={6}>
                <Typography.Text code className="tp-text-sm">{r.mock_base}</Typography.Text>
                <Button size="small" onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(window.location.origin + r.mock_base);
                  message.success("已复制");
                }}>复制</Button>
              </Space>) },
            { title: "", key: "ops", width: 180, render: (_, r) => (
              <Space size={4} onClick={(e) => e.stopPropagation()}>
                {canEdit && <Button size="small" onClick={() => setSvcModal({ editing: r })}>编辑</Button>}
                {canEdit && <Switch size="small" checked={r.enabled} onChange={async (checked) => {
                  await mockApi.updateService(r.id, { project_id: pid, enabled: checked });
                  await load();
                }} />}
                {canDelete && <Button size="small" danger onClick={async () => {
                  await mockApi.deleteService(pid, r.id);
                  message.success("已删除");
                  await load();
                }}>删除</Button>}
              </Space>) },
          ]} />
      </div>

      {current && (
        <div style={{ flex: 1, minWidth: 0, marginTop: 12 }}>
          <Typography.Title level={5} style={{ margin: "0 0 8px" }}>规则 · {current.name}</Typography.Title>
          <ListToolbar projectId={pid} viewType="mock_rule"
            filter={advFilter} onFilterChange={setAdvFilter}
            allColumns={MOCK_RULE_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
            valueOptions={MOCK_RULE_FILTER_OPTIONS}
            canSaveView={can(perms, "search:view:create")}
            canDeleteView={can(perms, "search:view:delete")}
            extra={canEdit ? (
              <Button size="small" icon={<PlusOutlined />} data-testid="mock-rule-new"
                onClick={() => setRuleModal({ editing: null })}>新建规则</Button>
            ) : undefined} />
          <Table rowKey="id" size="small" pagination={false} dataSource={rules}
            locale={{ emptyText: isFilterEmpty(advFilter) ? "还没有规则" : "没有符合筛选条件的规则" }}
            columns={applyColumnPrefs([
              { title: "顺序", key: "prio", width: 70,
                render: (_: unknown, r: MockRule) => r.priority },
              { title: "名称", dataIndex: "name" },
              { title: "匹配", key: "m", render: (_: unknown, r: MockRule) => (
                <Space size={6}><Tag>{r.method}</Tag><Tag>{MATCH_LABEL[r.match_type]}</Tag>
                  <Typography.Text code>{r.path}</Typography.Text></Space>) },
              { title: "响应", key: "resp", width: 160, render: (_: unknown, r: MockRule) => (
                <Space size={6}><Tag>{r.status_code}</Tag>{r.delay_ms > 0 && <Tag>{r.delay_ms}ms</Tag>}</Space>) },
              { title: "启用", dataIndex: "enabled", width: 80, render: (v: boolean) => v
                ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
              { title: "", key: "ops", width: 140, render: (_: unknown, r: MockRule) => canEdit && (
                <Space size={4}>
                  <Button size="small" onClick={() => setRuleModal({ editing: r })}>编辑</Button>
                  {canDelete && <Button size="small" danger onClick={async () => {
                    await mockApi.deleteRule(pid, r.id);
                    message.success("已删除");
                    await load();
                  }}>删除</Button>}
                </Space>) },
            ], colPref)} />
          <div className="tp-card" style={{ padding: 12, marginTop: 12 }}>
            <Space wrap>
              <Typography.Text strong>试匹配</Typography.Text>
              <Select value={testMethod} style={{ width: 100 }} onChange={setTestMethod}
                options={METHODS.map((m) => ({ value: m, label: m }))} />
              <Input value={testPath} style={{ width: 260 }} onChange={(e) => setTestPath(e.target.value)} />
              <Button onClick={async () => {
                try {
                  const r = await mockApi.testRule(pid, current.id, testMethod, testPath);
                  setTestResult(r.matched
                    ? "命中规则：" + (r.rule?.name ?? "") + " → " + r.rule?.status_code
                    : "没有命中任何规则（公开入口会回 404）");
                } catch (e) { setTestResult(e instanceof ApiErr ? e.message : "测试失败"); }
              }}>测试</Button>
              {testResult && <Typography.Text type="secondary">{testResult}</Typography.Text>}
            </Space>
            <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ margin: "8px 0 0" }}>
              公开地址：<Typography.Text code>{mockUrl}</Typography.Text>（外部调用不鉴权；服务停用即 404）
            </Typography.Paragraph>
          </div>
        </div>
      )}

      <ServiceModal open={svcModal !== null} projectId={pid} editing={svcModal?.editing ?? null}
        onClose={() => setSvcModal(null)} onSaved={() => void load()} />
      <RuleModal open={ruleModal !== null} projectId={pid} serviceId={selected ?? ""}
        editing={ruleModal?.editing ?? null}
        onClose={() => setRuleModal(null)} onSaved={() => void load()} />
    </div>
  );
}

export default function MockPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-mock" className="tp-fill-stack">
      <PageHead title="API Mock" desc="Mock 服务与规则；公开入口 `/mock/{serviceId}/...` 不鉴权。" />
      <ProjectGate>{project ? <MockWorkbench /> : null}</ProjectGate>
    </div>
  );
}
