// 功能用例前后置关系卡（D197）：前置/后置列表 + 添加/删除。
import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Modal, Select, Space, Tag, Typography, message } from "antd";
import { PlusOutlined } from "./icons";
import { functionalApi, type CaseRelationItem, type CaseRelations, type CaseRow } from "../api/functional";
import { ApiErr } from "../api/client";

export default function CaseRelations({ projectId, caseId, canEdit }: {
  projectId: string;
  caseId: string;
  canEdit: boolean;
}) {
  const [rel, setRel] = useState<CaseRelations>({ predecessors: [], successors: [] });
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"predecessor" | "successor">("predecessor");
  const [target, setTarget] = useState<string | undefined>();
  const [candidates, setCandidates] = useState<CaseRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRel(await functionalApi.relations(projectId, caseId)); }
    catch { setRel({ predecessors: [], successors: [] }); }
  }, [projectId, caseId]);
  useEffect(() => { void load(); }, [load]);

  async function openAdd(): Promise<void> {
    setOpen(true); setTarget(undefined); setErr(null);
    try {
      const r = await functionalApi.listCases({ project_id: projectId, current: 1, size: 200 });
      setCandidates(r.items.filter((c) => !c.recycled && c.id !== caseId));
    } catch { setCandidates([]); }
  }

  async function submit(): Promise<void> {
    if (!target) return;
    setBusy(true); setErr(null);
    try {
      await functionalApi.addRelation(projectId, caseId, target, type);
      message.success("关系已添加");
      setOpen(false); await load();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  async function remove(r: CaseRelationItem): Promise<void> {
    try {
      await functionalApi.deleteRelation(projectId, r.relation_id);
      message.success("关系已删除");
      await load();
    } catch { /* toast */ }
  }

  const group = (items: CaseRelationItem[], label: string, kind: "predecessor" | "successor") => (
    <Space size={6} wrap>
      <Typography.Text strong>{label}</Typography.Text>
      {items.length === 0 ? <Typography.Text type="secondary" className="tp-text-sm">无</Typography.Text>
        : items.map((x) => (
          <Tag key={x.relation_id} closable={canEdit}
            onClose={(e) => { e.preventDefault(); void remove(x); }}>
            {x.case.num} {x.case.name}
          </Tag>
        ))}
      {canEdit && items.length === 0 && (
        <Button size="small" type="link" icon={<PlusOutlined />}
          onClick={() => { setType(kind); void openAdd(); }}>
          添加
        </Button>
      )}
    </Space>
  );

  return (
    <div data-testid="case-relations">
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>前后置用例</Typography.Title>
        {canEdit && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => void openAdd()}>添加关系</Button>
        )}
      </Space>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {group(rel.predecessors, "前置", "predecessor")}
        {group(rel.successors, "后置", "successor")}
        {rel.predecessors.length === 0 && rel.successors.length === 0 && !canEdit && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有前后置关系" />
        )}
      </Space>

      <Modal open={open} onCancel={() => setOpen(false)} centered width={560}
        title="添加前后置关系" okText="添加" cancelText="取消"
        okButtonProps={{ loading: busy, disabled: !target }} onOk={() => void submit()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Select value={type} style={{ width: 160 }} onChange={(v) => setType(v as "predecessor" | "successor")}
            options={[{ value: "predecessor", label: "前置（它先跑）" },
              { value: "successor", label: "后置（它后跑）" }]} />
          <Select showSearch optionFilterProp="label" style={{ width: "100%" }} value={target}
            onChange={setTarget} placeholder="选择用例"
            options={candidates.map((c) => ({ value: c.id, label: c.num + " " + c.name }))} />
          {err && <Typography.Text type="danger">{err}</Typography.Text>}
        </Space>
      </Modal>
    </div>
  );
}
