// 功能用例评论卡（D197）：两层嵌套；仅创建人可编辑/删除。
import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Input, Modal, Space, Typography, message } from "antd";
import { functionalApi, type CaseComment } from "../api/functional";
import { fmtTime } from "../shared/timefmt";

function Node({ c, projectId, meId, canWrite, onReply, onChanged }: {
  c: CaseComment;
  projectId: string;
  meId: string;
  canWrite: boolean;
  onReply: (c: CaseComment) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.content);
  const mine = c.created_by === meId;
  async function save(): Promise<void> {
    if (!text.trim()) { message.warning("评论不能为空"); return; }
    try {
      await functionalApi.updateComment(projectId, c.id, text.trim());
      setEditing(false); onChanged();
    } catch { /* toast */ }
  }
  async function remove(): Promise<void> {
    try {
      await functionalApi.deleteComment(projectId, c.id);
      message.success("评论已删除");
      onChanged();
    } catch { /* toast */ }
  }
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--tp-border-color, #eee)" }}>
      <Space size={8} wrap>
        <Typography.Text strong>{c.created_by_name ?? c.created_by}</Typography.Text>
        {c.parent_id && c.reply_user_name && (
          <Typography.Text type="secondary" className="tp-text-sm">回复 @{c.reply_user_name}</Typography.Text>
        )}
        <Typography.Text type="secondary" className="tp-text-sm">{fmtTime(c.created_at) ?? "—"}</Typography.Text>
      </Space>
      {editing ? (
        <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 6 }}>
          <Input.TextArea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <Space>
            <Button size="small" type="primary" onClick={() => void save()}>保存</Button>
            <Button size="small" onClick={() => { setEditing(false); setText(c.content); }}>取消</Button>
          </Space>
        </Space>
      ) : (
        <>
          <Typography.Paragraph style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>{c.content}</Typography.Paragraph>
          <Space size={4}>
            {canWrite && !c.parent_id && (
              <Button size="small" type="link" onClick={() => onReply(c)}>回复</Button>
            )}
            {mine && canWrite && (
              <>
                <Button size="small" type="link" onClick={() => setEditing(true)}>编辑</Button>
                <Button size="small" type="link" danger onClick={() => {
                  Modal.confirm({
                    centered: true, title: "删除这条评论？",
                    content: c.children.length ? "它的回复会一并删除。" : "删除后无法恢复。",
                    okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
                    onOk: () => void remove(),
                  });
                }}>删除</Button>
              </>
            )}
          </Space>
        </>
      )}
      {c.children.length > 0 && (
        <div style={{ marginLeft: 24, marginTop: 4 }}>
          {c.children.map((child) => (
            <Node key={child.id} c={child} projectId={projectId} meId={meId} canWrite={canWrite}
              onReply={onReply} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CaseComments({ projectId, caseId, meId, canWrite }: {
  projectId: string;
  caseId: string;
  meId: string;
  canWrite: boolean;
}) {
  const [items, setItems] = useState<CaseComment[]>([]);
  const [total, setTotal] = useState(0);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<CaseComment | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await functionalApi.comments(projectId, caseId);
      setItems(r.items); setTotal(r.total);
    } catch { setItems([]); setTotal(0); }
  }, [projectId, caseId]);
  useEffect(() => { void load(); }, [load]);

  async function submit(): Promise<void> {
    if (!text.trim()) { message.warning("评论不能为空"); return; }
    setBusy(true);
    try {
      await functionalApi.addComment(projectId, caseId, text.trim(), replyTo?.id ?? null);
      setText(""); setReplyTo(null);
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  return (
    <div data-testid="case-comments">
      <Typography.Title level={5} style={{ marginTop: 0 }}>评论（{total}）</Typography.Title>
      {replyTo && (
        <Typography.Text type="secondary" className="tp-text-sm">
          正在回复 @{replyTo.created_by_name ?? replyTo.created_by}
          <Button size="small" type="link" onClick={() => setReplyTo(null)}>取消</Button>
        </Typography.Text>
      )}
      {items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论" /> : (
        <div>{items.map((c) => (
          <Node key={c.id} c={c} projectId={projectId} meId={meId} canWrite={canWrite}
            onReply={setReplyTo} onChanged={() => void load()} />
        ))}</div>
      )}
      {canWrite && (
        <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 12 }}>
          <Input.TextArea rows={3} value={text} placeholder={replyTo ? "回复" : "写评论"}
            onChange={(e) => setText(e.target.value)} />
          <Button type="primary" loading={busy} onClick={() => void submit()}>发表评论</Button>
        </Space>
      )}
    </div>
  );
}
