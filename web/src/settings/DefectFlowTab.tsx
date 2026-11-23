// D267：项目级缺陷状态流转配置（设置页 Tab）。
// D271：同一组件复用到组织级模板（传 orgId 而不是 projectId）——模板不复制到项目，
// 改模板只对「未自定义状态流」的项目生效（优先级 项目 > 组织 > 内置默认，与后端一致）。
//
// 后端两份表为空 = 使用上一层图；本页保存即落一份**整份快照**，重置即删行回落。
// 三条口径与后端一致，写在这里防「界面先松口」：
// ① 状态 key 是缺陷行的外键（按 key 存 status）——已存在项的 key **不可改**，只能改显示名；
// ② 恰好一个起始态：开关打开时把其余项自动关掉（服务端仍会校验，非法 422 原样上屏）；
// ③ 删状态/重置前先看引用：还有缺陷挂在被删的状态上 → 后端 409 status_in_use，本页不吞。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Input, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import { ApiErr } from "../api/client";
import {
  defectFlowApi, defectOrgFlowApi, isDefectFlow, isOrgDefectFlow,
  type DefectFlowView,
} from "../api/defect";

type Draft = {
  /** 稳定行 id（key 可改，id 不变）：转移边按 id 连，保存时才映射成 key。 */
  id: string;
  key: string;
  name: string;
  is_start: boolean;
  is_end: boolean;
  isNew: boolean;
};

let seq = 0;
function newId(): string { seq += 1; return "s" + seq; }

function toDrafts(flow: DefectFlowView): Draft[] {
  return flow.statuses.map((s) => ({
    id: newId(), key: s.key, name: s.name, is_start: s.is_start, is_end: s.is_end, isNew: false,
  }));
}

function toEdges(flow: DefectFlowView, drafts: Draft[]): Record<string, string[]> {
  const byKey = new Map(drafts.map((d) => [d.key, d.id]));
  const out: Record<string, string[]> = {};
  for (const e of flow.transitions) {
    const f = byKey.get(e.from_key);
    const t = byKey.get(e.to_key);
    if (!f || !t) continue;
    (out[f] ??= []).push(t);
  }
  return out;
}

export default function DefectFlowTab({ projectId, orgId }: {
  projectId?: string;
  orgId?: string;
}) {
  const orgMode = Boolean(orgId);
  const [flow, setFlow] = useState<DefectFlowView | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [edges, setEdges] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = useCallback((f: DefectFlowView) => {
    const ds = toDrafts(f);
    setFlow(f);
    setDrafts(ds);
    setEdges(toEdges(f, ds));
    setErr(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (orgId) {
        const f = await defectOrgFlowApi.get(orgId);
        if (!isOrgDefectFlow(f)) throw new Error("bad flow");
        apply(f);
      } else if (projectId) {
        const f = await defectFlowApi.get(projectId);
        if (!isDefectFlow(f)) throw new Error("bad flow");
        apply(f);
      }
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "状态图加载失败");
    } finally { setLoading(false); }
  }, [projectId, orgId, apply]);

  useEffect(() => { void load(); }, [load]);

  function patch(id: string, next: Partial<Draft>): void {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...next } : d)));
  }

  function setStart(id: string): void {
    // 恰好一个起始态：打开一个就把其余关掉（关掉当前起始态也会被服务端拒绝，这里不空转）。
    setDrafts((ds) => ds.map((d) => ({ ...d, is_start: d.id === id })));
  }

  function addRow(): void {
    const id = newId();
    setDrafts((ds) => [...ds, { id, key: "", name: "", is_start: false, is_end: false, isNew: true }]);
  }

  function removeRow(id: string): void {
    setDrafts((ds) => ds.filter((d) => d.id !== id));
    setEdges((es) => {
      const next: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(es)) {
        if (k === id) continue;
        const kept = v.filter((t) => t !== id);
        if (kept.length) next[k] = kept;
      }
      return next;
    });
  }

  async function save(): Promise<void> {
    if (drafts.some((d) => !d.key.trim() || !d.name.trim())) {
      message.warning("每个状态都要有 key 与名称");
      return;
    }
    if (drafts.filter((d) => d.is_start).length !== 1) {
      message.warning("必须恰好有一个起始状态");
      return;
    }
    const idToKey = new Map(drafts.map((d) => [d.id, d.key.trim()]));
    const transitions: { from_key: string; to_key: string }[] = [];
    for (const [fid, targets] of Object.entries(edges)) {
      for (const tid of targets) {
        const from = idToKey.get(fid);
        const to = idToKey.get(tid);
        if (from && to && from !== to) transitions.push({ from_key: from, to_key: to });
      }
    }
    setBusy(true);
    try {
      const payloadStatuses = drafts.map((d) => ({
        key: d.key.trim(), name: d.name.trim(), is_start: d.is_start, is_end: d.is_end,
      }));
      const out = orgId
        ? await defectOrgFlowApi.save(orgId, payloadStatuses, transitions)
        : await defectFlowApi.save(projectId!, payloadStatuses, transitions);
      apply(out);
      message.success(orgMode ? "组织状态流模板已保存" : "状态流转已保存");
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "保存失败");
    } finally { setBusy(false); }
  }

  async function reset(): Promise<void> {
    setBusy(true);
    try {
      const out = orgId
        ? await defectOrgFlowApi.reset(orgId)
        : await defectFlowApi.reset(projectId!);
      apply(out);
      message.success(orgMode ? "已删除组织模板，继承项目回落内置默认" : "已恢复内置默认状态图");
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "重置失败");
    } finally { setBusy(false); }
  }

  const targets = (id: string) => drafts.filter((d) => d.id !== id);

  return (
    <div data-testid="defect-flow-tab">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Space wrap>
          <Typography.Text strong>{orgMode ? "组织缺陷状态流模板" : "缺陷状态流转"}</Typography.Text>
          {flow && (flow.customized
            ? <Tag color="processing" data-testid="defect-flow-customized">自定义</Tag>
            : <Tag data-testid="defect-flow-default">
              {flow.source === "org" ? "继承组织模板" : "内置默认"}
            </Tag>)}
          <Typography.Text type="secondary" className="tp-text-sm">
            {orgMode
              ? "模板不复制到项目：只影响「未自定义状态流」的项目；删状态前会检查所有继承项目的缺陷。"
              : "保存后立即对新建/改状态生效；删状态与重置都会先检查是否还有缺陷在用。"}
          </Typography.Text>
        </Space>
        {err && <Alert type="error" showIcon data-testid="defect-flow-error" message={err} />}
        <Table<Draft>
          size="small" rowKey="id" loading={loading} pagination={false}
          dataSource={drafts}
          locale={{ emptyText: "还没有状态" }}
          columns={[
            {
              title: "key", dataIndex: "key", width: 170, render: (_, d) => (
                <Input data-testid={"defect-flow-key-" + d.id} value={d.key} maxLength={32}
                  disabled={!d.isNew} placeholder="小写 slug"
                  onChange={(e) => patch(d.id, { key: e.target.value })} />
              ),
            },
            {
              title: "名称", dataIndex: "name", width: 170, render: (_, d) => (
                <Input data-testid={"defect-flow-name-" + d.id} value={d.name} maxLength={32}
                  placeholder="状态名"
                  onChange={(e) => patch(d.id, { name: e.target.value })} />
              ),
            },
            {
              title: "起始", dataIndex: "is_start", width: 76, render: (_, d) => (
                <Switch size="small" checked={d.is_start} data-testid={"defect-flow-start-" + d.id}
                  onChange={() => setStart(d.id)} />
              ),
            },
            {
              title: "终态", dataIndex: "is_end", width: 76, render: (_, d) => (
                <Switch size="small" checked={d.is_end} data-testid={"defect-flow-end-" + d.id}
                  onChange={(v) => patch(d.id, { is_end: v })} />
              ),
            },
            {
              title: "可流转到", render: (_, d) => (
                <Select mode="multiple" style={{ minWidth: 220 }} value={edges[d.id] ?? []} allowClear
                  placeholder="不配边 = 到此为止"
                  data-testid={"defect-flow-to-" + d.id}
                  options={targets(d.id).map((t) => ({
                    value: t.id, label: (t.key || "（未命名）") + " / " + (t.name || "—"),
                  }))}
                  onChange={(v: string[]) => setEdges((es) => ({ ...es, [d.id]: v }))} />
              ),
            },
            {
              title: "操作", width: 90, render: (_, d) => (
                <Popconfirm title="删掉这个状态？" description="还有缺陷在用时后端会拒绝。"
                  okText="删除" cancelText="取消" onConfirm={() => removeRow(d.id)}>
                  <Button danger size="small" data-testid={"defect-flow-remove-" + d.id}>删除</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={addRow} data-testid="defect-flow-add">添加状态</Button>
          <Button type="primary" loading={busy} onClick={() => void save()} data-testid="defect-flow-save">
            保存
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          <Popconfirm title={orgMode ? "删除组织状态流模板？" : "恢复内置默认状态图？"}
            description={orgMode
              ? "继承它的项目会回落内置默认；仍有缺陷挂着自定义状态时后端会拒绝。"
              : "自定义状态与转移边会整份清空。"}
            okText={orgMode ? "确认删除" : "确认恢复"} cancelText="取消" onConfirm={() => void reset()}>
            <Button danger loading={busy} data-testid="defect-flow-reset">
              {orgMode ? "删除模板" : "恢复默认"}
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </div>
  );
}
