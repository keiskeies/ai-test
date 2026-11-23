// 个人中心（D198）：资料/偏好、我的资产、最近项目、API Key。
// 个人面不按项目角色门控；API Key 明文只在创建时显示一次。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Input, Modal, Select, Space, Statistic, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined } from "../ui/icons";
import { useAuth } from "../auth/store";
import { ApiErr } from "../api/client";
import {
  ASSET_LABELS, ROLE_LABELS, personalApi,
  type ApiKey, type Profile, type RecentProject,
} from "../api/personal";
import PageHead from "../ui/PageHead";
import { fmtTime } from "../shared/timefmt";

export default function MePage() {
  const { user, refreshProject } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [theme, setTheme] = useState<string>("system");
  const [language, setLanguage] = useState("zh-CN");
  const [assets, setAssets] = useState<Record<string, number>>({});
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [keyOpen, setKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyExpires, setKeyExpires] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a, r, k] = await Promise.all([
        personalApi.profile(), personalApi.myAssets(),
        personalApi.recentProjects(), personalApi.keys(),
      ]);
      setProfile(p); setName(p.name); setEmail(p.email ?? "");
      const prefs = p.prefs as { theme?: string; language?: string };
      setTheme(prefs.theme ?? "system"); setLanguage(prefs.language ?? "zh-CN");
      setAssets(a.counts); setProjects(r.items); setKeys(k.items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "个人中心加载失败");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveProfile(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      const p = await personalApi.updateProfile({
        name: name.trim() || undefined, email: email.trim(),
        prefs: { theme, language },
      });
      setProfile(p);
      message.success("资料已保存");
      void refreshProject();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  async function createKey(): Promise<void> {
    if (!keyName.trim()) { message.warning("Key 名称必填"); return; }
    setKeyBusy(true);
    try {
      const out = await personalApi.createKey({
        name: keyName.trim(),
        expires_at: keyExpires ? new Date(keyExpires).toISOString() : null,
      });
      setCreatedKey(out.key);
      setKeyOpen(false); setKeyName(""); setKeyExpires("");
      await load();
    } catch (e) {
      message.error(e instanceof ApiErr ? e.message : "签发失败");
    } finally { setKeyBusy(false); }
  }

  return (
    <div data-testid="page-me" className="tp-fill-stack">
      <PageHead title="个人中心" desc="自己的资料、偏好、资产与 API Key；个人面不按项目角色门控。" />
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>资料与偏好</Typography.Title>
        <Space direction="vertical" size={10} style={{ width: "100%", maxWidth: 520 }}>
          <div>
            <Typography.Text strong>账号</Typography.Text>
            <Input value={profile?.account ?? user?.account ?? ""} disabled />
          </div>
          <div>
            <Typography.Text strong>名称</Typography.Text>
            <Input data-testid="me-name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>邮箱</Typography.Text>
            <Input data-testid="me-email" maxLength={255} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Space size={16} wrap>
            <div>
              <Typography.Text strong>主题</Typography.Text>
              <Select style={{ width: 140 }} value={theme} onChange={setTheme}
                options={[{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" }]} />
            </div>
            <div>
              <Typography.Text strong>语言</Typography.Text>
              <Select style={{ width: 140 }} value={language} onChange={setLanguage}
                options={[{ value: "zh-CN", label: "简体中文" }, { value: "en-US", label: "English" }]} />
            </div>
          </Space>
          <Button type="primary" loading={busy} onClick={() => void saveProfile()}>保存资料</Button>
        </Space>
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>我的资产</Typography.Title>
        <Space size={28} wrap>
          {Object.entries(ASSET_LABELS).map(([k, label]) => (
            <Statistic key={k} title={label} value={assets[k] ?? 0} />
          ))}
        </Space>
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>最近项目</Typography.Title>
        {projects.length === 0 ? <Typography.Text type="secondary">还没有加入项目</Typography.Text> : (
          <Space direction="vertical" size={4}>
            {projects.map((p) => (
              <Space key={p.id} size={8}>
                <Typography.Text>{p.name}</Typography.Text>
                <Tag>{ROLE_LABELS[p.role_code] ?? p.role_code}</Tag>
                <Typography.Text type="secondary" className="tp-text-sm">
                  {fmtTime(p.updated_at, { seconds: false }) ?? "—"}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16 }}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>API Key</Typography.Title>
          <Button size="small" icon={<PlusOutlined />} data-testid="me-key-new"
            onClick={() => setKeyOpen(true)}>签发 Key</Button>
        </Space>
        <Table rowKey="id" size="small" pagination={false} dataSource={keys}
          locale={{ emptyText: "还没有 API Key" }}
          columns={[
            { title: "名称", dataIndex: "name" },
            { title: "前缀", dataIndex: "prefix", width: 150, render: (v: string) => <Typography.Text code>{v}…</Typography.Text> },
            { title: "创建时间", key: "c", width: 150, render: (_, k) => fmtTime(k.created_at) ?? "—" },
            { title: "最近使用", key: "u", width: 150, render: (_, k) => fmtTime(k.last_used_at) ?? "—" },
            { title: "过期", key: "e", width: 150, render: (_, k) => fmtTime(k.expires_at) ?? "永不过期" },
            { title: "状态", key: "s", width: 90, render: (_, k) => k.revoked_at
              ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag> },
            { title: "", key: "ops", width: 90, render: (_, k) => (
              !k.revoked_at && (
                <Button size="small" danger data-testid="me-key-revoke" onClick={async () => {
                  await personalApi.revokeKey(k.id); message.success("已吊销");
                  await load();
                }}>吊销</Button>
              )) },
          ]} />
      </div>

      <Modal open={keyOpen} onCancel={() => setKeyOpen(false)} centered width={520}
        title="签发 API Key" okText="签发" cancelText="取消"
        okButtonProps={{ loading: keyBusy, "data-testid": "me-key-ok" }} onOk={() => void createKey()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Input placeholder="名称（如 CI）" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <Input type="datetime-local" value={keyExpires} onChange={(e) => setKeyExpires(e.target.value)} />
          <Typography.Text type="secondary" className="tp-text-sm">不填过期时间 = 永不过期；明文只在签发后显示一次。</Typography.Text>
        </Space>
      </Modal>

      <Modal open={createdKey !== null} onCancel={() => setCreatedKey(null)} centered width={620}
        title="API Key 已签发（只显示这一次）" footer={(
          <Button onClick={() => { void navigator.clipboard?.writeText(createdKey ?? ""); message.success("已复制"); }}>
            复制
          </Button>
        )}>
        <Typography.Paragraph type="warning">关闭后无法再次查看明文；丢失请吊销重签。</Typography.Paragraph>
        <Typography.Paragraph code copyable={{ text: createdKey ?? "" }} data-testid="me-key-plain">
          {createdKey}
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
