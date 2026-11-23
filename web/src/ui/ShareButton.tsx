// 分享按钮（D202）：创建/列出/吊销公开链接，复制完整 URL。
import { useCallback, useState } from "react";
import { Button, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { shareApi, shareUrl, type ShareLink } from "../api/share";
import { ApiErr } from "../api/client";

export default function ShareButton({ projectId, targetType, targetId, title }: {
  projectId: string;
  targetType: "report" | "plan_report" | "api_doc";
  targetId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [password, setPassword] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setLinks((await shareApi.list(projectId, targetType, targetId)).items); }
    catch { setLinks([]); }
  }, [projectId, targetType, targetId]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const out = await shareApi.create({
        project_id: projectId, target_type: targetType, target_id: targetId, title,
        password: password || undefined,
        expires_at: expires ? new Date(expires).toISOString() : null,
      });
      setPassword(""); setExpires("");
      const url = shareUrl(out.token);
      void navigator.clipboard?.writeText(url);
      message.success("分享链接已创建并复制：" + url);
      await load();
    } catch (e) {
      message.error(e instanceof ApiErr ? e.message : "创建失败");
    } finally { setBusy(false); }
  }

  return (
    <>
      <Button size="small" data-testid="share-open" onClick={() => { setOpen(true); void load(); }}>
        分享
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} centered width={720}
        title={"分享：" + title} footer={null}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space wrap>
            <Input placeholder="访问密码（可选）" value={password} style={{ width: 200 }}
              onChange={(e) => setPassword(e.target.value)} />
            <Input type="datetime-local" value={expires} style={{ width: 220 }}
              onChange={(e) => setExpires(e.target.value)} />
            <Button type="primary" loading={busy} data-testid="share-create" onClick={() => void create()}>
              创建链接
            </Button>
          </Space>
          <Table rowKey="id" size="small" pagination={false} dataSource={links}
            locale={{ emptyText: "还没有分享链接" }}
            columns={[
              { title: "链接", key: "url", render: (_, r) => (
                <Typography.Text code className="tp-text-sm" copyable={{ text: shareUrl(r.token) }}>
                  {r.share_path}
                </Typography.Text>) },
              { title: "密码", dataIndex: "has_password", width: 70, render: (v: boolean) => v ? <Tag>有</Tag> : "—" },
              { title: "过期", key: "exp", width: 150, render: (_, r) => r.expires_at ?? "永不过期" },
              { title: "访问", dataIndex: "view_count", width: 70 },
              { title: "状态", key: "st", width: 80, render: (_, r) => r.revoked_at
                ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag> },
              { title: "", key: "ops", width: 80, render: (_, r) => !r.revoked_at && (
                <Button size="small" danger onClick={async () => {
                  await shareApi.revoke(projectId, r.id);
                  message.success("已吊销");
                  await load();
                }}>吊销</Button>) },
            ]} />
        </Space>
      </Modal>
    </>
  );
}
