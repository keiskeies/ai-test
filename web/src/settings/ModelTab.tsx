// 模型配置（§11.4.23 卡片墙，1E T8）：能力 ✓/✗/? 徽标 + 探测延迟 + [连通性测试]
// 逐能力展开 + [设为默认]；向量模型隐藏思考/视觉位、显示 embed_dimensions 与 [维度探测]。
// unknown ≠ ✗ 是后端的假阴性红线在前端的延续：probe_result.capabilities 里 null =
// 「没测出来」，必须渲染成与 ✗ 视觉可区分的 ? （探测失败 ≠ 不支持）。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Col, Input, InputNumber, Modal, Row, Select, Space, Switch, Tag, Tooltip, Typography } from "antd";
import { ApiErr, get, patch, post } from "../api/client";
import { modelUsageApi } from "../api/modelUsage";
import type { ModelUsageOut } from "../api/modelUsage";
import { tp } from "../theme";
import StateView from "../ui/StateView";

export interface ModelCfg {
  id: string;
  name: string;
  model_type: "CHAT" | "EMBEDDING";
  protocol: string;
  base_url: string;
  model_name: string;
  api_key_masked: string;
  context_window: number;
  max_output: number;
  supports_thinking: boolean;
  thinking_levels: string[] | null;
  supports_vision: boolean;
  supports_tools: boolean;
  temperature_default: number | null;
  enabled: boolean;
  is_default: boolean;
  embed_dimensions: number | null;
  thinking_default: string | null;
  probe_result: Record<string, unknown> | null;
}

export type CapTri = boolean | null; // null = unknown（没测出来，不是不支持）

/** 能力三态（纯函数，vitest 直钉）：最近一次探测记了账（capabilities 有键）就以它为准——
 * null 渲染成 ?；没记账回落列值（人工勾选也是信息，不是 unknown）。向量模型不显示思考/视觉。 */
export function capTri(cfg: ModelCfg, cap: "tools" | "thinking" | "vision"): CapTri {
  if (cfg.model_type === "EMBEDDING" && cap !== "tools") return null; // 调用方负责隐藏，这里兜底
  const pr = cfg.probe_result as { capabilities?: Record<string, unknown> } | null;
  const c = pr?.capabilities;
  if (c && cap in c) {
    const v = c[cap];
    return typeof v === "boolean" ? v : null;
  }
  return Boolean(cfg[cap === "tools" ? "supports_tools" : cap === "thinking" ? "supports_thinking" : "supports_vision"]);
}

function CapBadge({ cfg, cap }: { cfg: ModelCfg; cap: "tools" | "thinking" | "vision" }) {
  const tri = capTri(cfg, cap);
  const label = cap === "tools" ? "工具" : cap === "thinking" ? "思考" : "视觉";
  if (tri === null) {
    return (
      <Tooltip title="未探明：探测含糊/超时/没跑过——「没测出来」不等于「不支持」">
        <Tag color="default" data-testid={"model-cap-" + cap} data-state="unknown">?{label}</Tag>
      </Tooltip>
    );
  }
  return tri ? (
    <Tag color="green" data-testid={"model-cap-" + cap} data-state="yes">✓{label}</Tag>
  ) : (
    <Tag color="red" data-testid={"model-cap-" + cap} data-state="no">✗{label}</Tag>
  );
}

interface FormState {
  name: string;
  base_url: string;
  model_name: string;
  api_key: string;
  context_window: number;
  max_output: number;
  temperature_default: number | null;
  enabled: boolean;
  supports_tools: boolean;
  supports_thinking: boolean;
  thinking_levels: string[];
  supports_vision: boolean;
}

function toForm(c: ModelCfg): FormState {
  return {
    name: c.name, base_url: c.base_url, model_name: c.model_name, api_key: "",
    context_window: c.context_window, max_output: c.max_output,
    temperature_default: c.temperature_default, enabled: c.enabled,
    supports_tools: c.supports_tools, supports_thinking: c.supports_thinking,
    thinking_levels: c.thinking_levels ?? [], supports_vision: c.supports_vision,
  };
}

export default function ModelTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<ModelCfg[]>([]);
  const [failed, setFailed] = useState(false);
  // 括号里那句「仅平台管理员可读」过去挂在每一次失败上。但这个 Tab 只对
  // 「isSysAdmin && model:cfg:read」渲染（pages/settings.tsx:46），而平台级请求给系统
  // 管理员的是 {"*"}（core/service.py:213）——正常管理员根本撞不到 403，只有前端还留着
  // 管理员身份、后端已经把权限收走那种窗口才会 403。所以按状态码分句，别把网络/服务故
  // 障说成权限。
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelCfg | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // D39 §6.8「用量 N 会话」：取不到就整列缺省（卡片画「—」），不拿 0 冒充已统计。
  const [usage, setUsage] = useState<ModelUsageOut | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await get<{ items: ModelCfg[] }>("/model-cfgs?size=200", { silent: true });
      setItems(r.items);
      setFailed(false);
      setDenied(false);
    } catch (e) {
      setFailed(true);
      setDenied(e instanceof ApiErr && e.status === 403);
    }
    // 用量是旁路读数：平台级端点（全池共享），失败只让「用量」位退化，不影响卡片墙本体
    try {
      setUsage(await modelUsageApi.stats());
    } catch { setUsage(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const probeOne = useCallback(async (id: string): Promise<void> => {
    setBusy(id);
    setExpanded(id);
    try {
      await post("/model-cfgs/" + id + "/probe", {});
    } finally {
      setBusy(null);
      await load(); // 徽标必须跟着落库结果重画，不拿回显自嗨
    }
  }, [load]);

  const setDefault = useCallback(async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await patch("/model-cfgs/" + id, { cfg_id: id, is_default: true });
      await load();
    } finally { setBusy(null); }
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    if (!editing || !form) return;
    setBusy(editing.id);
    try {
      const body: Record<string, unknown> = {
        cfg_id: editing.id, name: form.name, base_url: form.base_url, model_name: form.model_name,
        context_window: form.context_window, max_output: form.max_output,
        temperature_default: form.temperature_default, enabled: form.enabled,
        supports_tools: form.supports_tools, supports_thinking: form.supports_thinking,
        thinking_levels: form.supports_thinking ? form.thinking_levels : null,
        supports_vision: form.supports_vision,
      };
      if (form.api_key) body.api_key = form.api_key; // 留空=保留旧值（§4.8），不发送该键
      await patch("/model-cfgs/" + editing.id, body);
      setEditing(null);
      await load();
    } finally { setBusy(null); }
  }, [editing, form, load]);

  const renderCard = (c: ModelCfg) => {
    const isEmbed = c.model_type === "EMBEDDING";
    const pr = c.probe_result as { ok?: boolean; latency_ms?: number; error?: string | null;
      dimensions?: number | null } | null;
    const exp = expanded === c.id;
    // §11.4.23「用量 N 会话」：只认 /model-usage 的真实回执计数（usage_sessions）——
    // 用量没取到（请求失败）画「—」；取到了但 0 条回执也画「—」（0 的含义就是
    // 「一条都没统计到」，写「0 会话」是把「没数据」冒充成「已统计」）。
    const usageRow = usage ? modelUsageApi.byModel(usage, c.id) : undefined;
    const usageSessions = usageRow?.usage_sessions ?? null;
    return (
      <Card key={c.id} size="small" data-testid="model-card" data-model-id={c.id}
        title={<Space size={6}>
          <span>{c.name}</span>
          {c.is_default && <Tag color="gold" data-testid="model-default-star">默认★</Tag>}
          {!c.enabled && <Tag data-testid="model-disabled-tag">停用</Tag>}
        </Space>}
        extra={<Typography.Text type="secondary" className="tp-text-sm">{isEmbed ? "向量" : c.protocol === "OPENAI_COMPAT" ? "OAI兼容" : c.protocol}</Typography.Text>}>
          <Typography.Paragraph type="secondary" className="tp-mono tp-text-sm" style={{ marginBottom: 8 }}>
            {c.base_url} · {c.model_name}
          </Typography.Paragraph>
          <Space size={4} wrap style={{ marginBottom: 8 }}>
            <CapBadge cfg={c} cap="tools" />
            {/* 向量模型隐藏思考/视觉位（§11.4.23：类型=向量模型时思考/视觉不显示） */}
            {!isEmbed && <CapBadge cfg={c} cap="thinking" />}
            {!isEmbed && <CapBadge cfg={c} cap="vision" />}
            {!isEmbed && c.supports_thinking && c.thinking_default && (
              <Tag color="blue" data-testid="model-thinking-default">默认思考档 {c.thinking_default}</Tag>
            )}
            {isEmbed && (
              <Tag color={c.embed_dimensions ? "cyan" : "default"} data-testid="model-embed-dims">
                维度 {c.embed_dimensions ?? "未探"}
              </Tag>
            )}
          </Space>
          <div style={{ marginBottom: 8 }}>
            {pr ? (
              <Typography.Text data-testid="model-probe-line" className="tp-text-sm">
                {/* 老绿红（#389e0d / #cf1322）不在 Token 表里，改引功能色：
                    成功的语义色 tp.func.success、失败 tp.func.error。 */}
                探测{pr.ok ? <span style={{ color: tp.func.success }}>●OK</span> : <span style={{ color: tp.func.error }}>●失败</span>}
                {" "}{pr.latency_ms ?? 0}ms
                {pr.error ? " · " + pr.error : ""}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" data-testid="model-probe-line" className="tp-text-sm">未探测</Typography.Text>
            )}
            {" "}
            <Typography.Text type="secondary" data-testid="model-usage-line" className="tp-text-sm">
              用量 {usageSessions != null && usageSessions > 0 ? usageSessions + " 会话" : "—"}
            </Typography.Text>
          </div>
          <Space size={4} wrap>
            <Button size="small" data-testid="model-probe-btn" loading={busy === c.id}
              onClick={() => void probeOne(c.id)}>{isEmbed ? "维度探测" : "连通性测试"}</Button>
            {canManage && !c.is_default && (
              <Button size="small" data-testid="model-set-default" loading={busy === c.id}
                onClick={() => void setDefault(c.id)}>设为默认</Button>
            )}
            {canManage && (
              <Button size="small" type="link" data-testid="model-edit-btn"
                onClick={() => { setEditing(c); setForm(toForm(c)); }}>编辑</Button>
            )}
          </Space>
          {exp && (
            <div data-testid="model-probe-expanded" style={{ marginTop: 8 }}>
              {isEmbed ? (
                <Typography.Text className="tp-text-sm">
                  embed("ping") 维度：{(pr?.dimensions ?? c.embed_dimensions) ?? "未测出（坏响应不猜维度）"}
                </Typography.Text>
              ) : (
                <Space size={4} wrap>
                  {(["tools", "thinking", "vision"] as const).map((cap) => (
                    <CapBadge key={cap} cfg={c} cap={cap} />
                  ))}
                </Space>
              )}
            </div>
          )}
      </Card>
    );
  };

  return (
    <div data-testid="tab-model" className="tp-fill-tab">
      {failed && <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message={denied
          ? "模型列表没取到：这个账号现在没有 model:cfg:read（界面还留着管理员工号，后端权限已被收走）"
          : "模型列表没取到：请求没成功或后端没应答，与权限无关——重试或看后端日志"}
        data-testid="model-load-failed" />}
      {/* 容器断点卡片墙（xl={8} 在 2560 视口下容器封顶 1552 仍只切 3 列各 ~507，大屏空转）。
          --tp-wall-min=300：1200 视口下 944 容器出 3 列各 304（≥ 旧实测 292 的「勉强够」），
          1552 封顶容器出 4 列各 376——auto-fill 下 5 列要 5×300+64>1552，最多 4 列封顶。 */}
      <div className="tp-wall" style={{ "--tp-wall-min": "300px" } as React.CSSProperties}>
        {items.map(renderCard)}
      </div>
      {!failed && items.length === 0 && (
        <StateView title="还没有登记模型（出厂种子经 .env 注入网关地址后自动出现）" />
      )}
      {/* D39 §6.8 按用户/按会话用量：数据就是上面 load() 取回的那份 /model-usage 响应，
          不另发请求也不造按钮——两个表只是把 users/sessions 两组行摆出来。
          tokens null（网关没回 usage）逐行画「—」，聚合行同理。 */}
      {usage && (usage.sessions.length > 0 || usage.users.length > 0) && (
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} lg={12}>
            <Card size="small" title="按用户用量（tokens 只认 usage 回执）" data-testid="model-usage-users">
              {usage.users.map((u) => (
                <div key={u.user_id} className="tp-text-sm">
                  <Typography.Text strong>{u.user_name}</Typography.Text>
                  {" · 会话 " + u.sessions + " · 轮次 " + u.turns
                    + " · tokens " + (u.total_tokens == null ? "—" : String(u.total_tokens))}
                </div>
              ))}
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="按会话用量" data-testid="model-usage-sessions">
              {usage.sessions.map((s) => (
                <div key={s.session_id} className="tp-text-sm">
                  {/* 旧的 maxWidth: 160 魔数删掉：antd 单行 ellipsis 自带 max-width:100%，
                      截断点跟着列宽走——与 .tp-wall「尺寸由容器决定」同一原则。 */}
                  <Typography.Text ellipsis>{s.title}</Typography.Text>
                  {" · " + s.user_name + " · 轮次 " + s.turns
                    + " · tokens " + (s.total_tokens == null ? "—" : String(s.total_tokens))
                    + (s.model_name ? " · " + s.model_name : "")}
                </div>
              ))}
            </Card>
          </Col>
        </Row>
      )}
      {editing && form && (
        <Modal centered open data-testid="model-edit-modal" title={"编辑 · " + editing.name} width={640}
          confirmLoading={busy === editing.id} okText="保存"
          onOk={() => void save()} onCancel={() => setEditing(null)}>
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Input data-testid="model-f-name" addonBefore="名称" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input data-testid="model-f-base" addonBefore="base_url" value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
            <Input data-testid="model-f-model" addonBefore="模型名" value={form.model_name}
              onChange={(e) => setForm({ ...form, model_name: e.target.value })} />
            <Input.Password data-testid="model-f-key" addonBefore="API Key"
              placeholder={"现值 " + (editing.api_key_masked || "（无）") + " · 留空保留，重置请填新值"}
              value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
            <Space wrap>
              <InputNumber data-testid="model-f-ctx" addonBefore="上下文" min={1024} value={form.context_window}
                onChange={(v) => setForm({ ...form, context_window: Number(v) })} />
              <InputNumber data-testid="model-f-out" addonBefore="最大输出" min={1} value={form.max_output}
                onChange={(v) => setForm({ ...form, max_output: Number(v) })} />
              <InputNumber data-testid="model-f-temp" addonBefore="温度" min={0} max={2} step={0.1}
                value={form.temperature_default}
                onChange={(v) => setForm({ ...form, temperature_default: v === null ? null : Number(v) })} />
            </Space>
            <Space wrap size={12}>
              {/* 向量模型隐藏思考/视觉勾选（§11.4.23 同款口径） */}
              <span>工具 <Switch data-testid="model-f-tools" checked={form.supports_tools}
                onChange={(v) => setForm({ ...form, supports_tools: v })} /></span>
              {editing.model_type !== "EMBEDDING" && <>
                <span>思考 <Switch data-testid="model-f-thinking" checked={form.supports_thinking}
                  onChange={(v) => setForm({ ...form, supports_thinking: v })} /></span>
                <Select mode="multiple" allowClear data-testid="model-f-levels" style={{ minWidth: 180 }}
                  placeholder="档位（含 medium 才有默认档）" disabled={!form.supports_thinking}
                  value={form.thinking_levels}
                  onChange={(v) => setForm({ ...form, thinking_levels: v })}
                  options={["low", "medium", "high"].map((v) => ({ value: v, label: v }))} />
                <span>视觉 <Switch data-testid="model-f-vision" checked={form.supports_vision}
                  onChange={(v) => setForm({ ...form, supports_vision: v })} /></span>
              </>}
              <span>启用 <Switch data-testid="model-f-enabled" checked={form.enabled}
                onChange={(v) => setForm({ ...form, enabled: v })} /></span>
            </Space>
          </Space>
        </Modal>
      )}
    </div>
  );
}
