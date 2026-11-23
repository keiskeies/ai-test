// 附件卡（D195）：缺陷/用例共用。上传走 /files/blobs（只建内容）再链接；
// 下载走鉴权字节流（<a href> 带不了 Authorization，必须 fetch → Blob）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Space, Tag, Typography, message } from "antd";
import { PlusOutlined } from "./icons";
import { fileApi, fmtSize, type Attachment } from "../api/filelib";
import { ApiErr } from "../api/client";
import { fmtTime } from "../shared/timefmt";

export default function Attachments({ projectId, targetType, targetId, canWrite, canDelete }: {
  projectId: string;
  targetType: "bug" | "functional_case";
  targetId: string;
  canWrite: boolean;
  canDelete?: boolean;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fileApi.attachments(projectId, targetType, targetId);
      setItems(r.items);
    } catch (e) {
      setItems([]);
      setError(e instanceof ApiErr ? e.message : "附件加载失败");
    } finally { setLoading(false); }
  }, [projectId, targetType, targetId]);
  useEffect(() => { void load(); }, [load]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const blob = await fileApi.uploadBlob(projectId, file);
      await fileApi.linkAttachments(projectId, targetType, targetId, [blob.id]);
      message.success("附件已上传");
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "上传失败");
    } finally { setBusy(false); }
  }

  async function download(a: Attachment): Promise<void> {
    try {
      await fileApi.download(projectId, a.blob);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "下载失败");
    }
  }

  return (
    <div data-testid="attachments">
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Text strong>附件（{items.length}）</Typography.Text>
        {canWrite && (
          <Button size="small" icon={<PlusOutlined />} loading={busy} data-testid="attachment-upload"
            onClick={() => inputRef.current?.click()}>
            上传附件
          </Button>
        )}
        <input ref={inputRef} type="file" data-testid="attachment-input" style={{ display: "none" }} onChange={(e) => void onPick(e)} />
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有附件" />
      ) : (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {items.map((a) => (
            <Space key={a.id} size={8} wrap data-testid="attachment-row">
              <Tag>{a.blob.mime.split("/").pop() || "file"}</Tag>
              <Typography.Text>{a.display_name ?? a.blob.original_name}</Typography.Text>
              <Typography.Text type="secondary" className="tp-text-sm">{fmtSize(a.blob.size)}</Typography.Text>
              <Typography.Text type="secondary" className="tp-text-sm">
                {a.created_by_name ?? "—"} · {fmtTime(a.created_at, { seconds: false }) ?? "—"}
              </Typography.Text>
              <Button size="small" onClick={() => void download(a)}>下载</Button>
              {(canDelete ?? canWrite) && (
                <Button size="small" danger data-testid="attachment-delete"
                  onClick={async () => {
                    try {
                      await fileApi.unlinkAttachment(projectId, a.id);
                      message.success("附件已移除");
                      await load();
                    } catch { /* toast */ }
                  }}>
                  移除
                </Button>
              )}
            </Space>
          ))}
        </Space>
      )}
      {loading && <Typography.Text type="secondary" className="tp-text-sm">加载中…</Typography.Text>}
    </div>
  );
}
