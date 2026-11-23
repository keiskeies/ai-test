// Skills（§11.4.25）：目录同步 + 列表 + 启停 + 查看全文（Markdown）。
// 治理位 skill:manage 仅系统管理员。文件是真相源，页面上的「同步」才把差异搬进库；
// 解析失败逐文件报告，且绝不动库里同名行（报错≠删除）。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, Drawer, Popconfirm, Space, Table, Tag, Typography, message,
} from "antd";
import ReactMarkdown from "react-markdown";
import { ImportOutlined, ReloadOutlined } from "../ui/icons";
import { get, post } from "../api/client";
import { fmtTime } from "../shared/timefmt";

interface Skill {
  id: string;
  name: string;
  description: string;
  source: string;
  allowed_tools: string[];
  enabled: boolean;
  synced_at: string | null;
}

interface SkillDetail extends Skill {
  body: string;
}

interface SyncReport {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  errors: { file: string; error: string }[];
  scanned_dir: string;
}

export default function SkillTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const out = await get<{ items: Skill[] }>("/skills");
      setItems(out.items);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function sync(): Promise<void> {
    setBusy("sync");
    try {
      const out = await post<SyncReport>("/skills/sync", {});
      setReport(out);
      const parts = [`新增 ${out.added.length}`, `变更 ${out.updated.length}`, `移除 ${out.removed.length}`];
      if (out.errors.length) message.warning("同步完成，但有 " + out.errors.length + " 个文件解析失败");
      else message.success("同步完成：" + parts.join(" · "));
      await load();
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  async function toggle(s: Skill, enabled: boolean): Promise<void> {
    setBusy("tg:" + s.id);
    try {
      await post("/skills/" + s.id + "/toggle", { enabled });
      await load();
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  async function open(s: Skill): Promise<void> {
    setBusy("get:" + s.id);
    try {
      setDetail(await get<SkillDetail>("/skills/" + s.id));
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  const columns = [
    {
      title: "名称", dataIndex: "name", key: "name",
      render: (v: string, s: Skill) => (
        <div>
          <Space size={6}>
            <Typography.Text strong>{v}</Typography.Text>
            <Tag>{s.source === "builtin" ? "目录" : s.source}</Tag>
          </Space>
          <div className="tp-text-sm" style={{ color: "var(--tp-color-text-secondary, #8c8c8c)", maxWidth: 560 }}>
            {s.description}
          </div>
        </div>
      ),
    },
    {
      title: "allowed-tools", dataIndex: "allowed_tools", key: "tools", width: 260,
      render: (v: string[]) => v.length
        ? <Space size={4} wrap>{v.map((t) => <Tag key={t} data-testid="skill-tool">{t}</Tag>)}</Space>
        : <Typography.Text type="secondary">不限</Typography.Text>,
    },
    {
      title: "状态", dataIndex: "enabled", key: "enabled", width: 90,
      render: (v: boolean) => <Badge data-testid="skill-state" data-state={v ? "on" : "off"}
        status={v ? "success" : "default"} text={v ? "启用" : "停用"} />,
    },
    {
      title: "最近同步", dataIndex: "synced_at", key: "synced", width: 170,
      render: (v: string | null) => <span className="tp-text-sm">{fmtTime(v) ?? "—"}</span>,
    },
    {
      title: "操作", key: "ops", width: 200,
      render: (_: unknown, s: Skill) => (
        <Space size={4}>
          <Button size="small" data-testid={"skill-view-" + s.id} loading={busy === "get:" + s.id}
            onClick={() => void open(s)}>查看</Button>
          <Popconfirm title={s.enabled ? "停用后不再进入系统提示，Agent 也读不到；确定？" : "重新启用这个 Skill？"}
            okText="确定" cancelText="取消" disabled={!canManage}
            onConfirm={() => void toggle(s, !s.enabled)}>
            <Button size="small" danger={s.enabled} data-testid={"skill-toggle-" + s.id}
              loading={busy === "tg:" + s.id} disabled={!canManage}>
              {s.enabled ? "停用" : "启用"}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap>
        <Button type="primary" icon={<ImportOutlined />} data-testid="skill-sync" loading={busy === "sync"}
          disabled={!canManage} onClick={() => void sync()}>同步 skills 目录</Button>
        <Button icon={<ReloadOutlined />} data-testid="skill-reload" onClick={() => void load()}>刷新</Button>
        <Typography.Text type="secondary" className="tp-text-sm">
          扫描 backend/skills/&lt;name&gt;/SKILL.md：系统提示只带清单，正文由 Agent 按需 read_skill 读取。
        </Typography.Text>
      </Space>
      {report ? (
        <Alert type={report.errors.length ? "warning" : "success"} showIcon data-testid="skill-sync-report"
          closable onClose={() => setReport(null)}
          message={`同步报告：新增 ${report.added.length} · 变更 ${report.updated.length} · 移除 ${report.removed.length} · 未变 ${report.unchanged}`}
          description={(
            <div className="tp-text-sm">
              <div data-testid="skill-sync-dir">目录：{report.scanned_dir}</div>
              {report.added.length ? <div>新增：{report.added.join("、")}</div> : null}
              {report.updated.length ? <div>变更：{report.updated.join("、")}</div> : null}
              {report.removed.length ? <div>移除：{report.removed.join("、")}</div> : null}
              {report.errors.map((e) => (
                <div key={e.file} data-testid="skill-sync-error" style={{ color: "var(--tp-color-error, #cf1322)" }}>
                  {e.file}：{e.error}
                </div>
              ))}
            </div>
          )} />
      ) : null}
      {failed ? (
        <Alert type="error" showIcon data-testid="skill-load-failed"
          message="没取到 Skills 列表" description="可能是网络/服务故障，稍后重试；本页仅系统管理员可读。" />
      ) : (
        <Table<Skill> rowKey="id" size="small" loading={loading} data-testid="skill-table"
          columns={columns} dataSource={items} pagination={false}
          locale={{ emptyText: "还没有 Skill。把 SKILL.md 放进 backend/skills/<name>/ 后点「同步 skills 目录」。" }} />
      )}

      <Drawer open={detail !== null} width={760} title={"Skill · " + (detail?.name ?? "")}
        data-testid="skill-drawer" onClose={() => setDetail(null)} destroyOnHidden>
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text type="secondary">{detail.description}</Typography.Text>
            <Space size={6} wrap>
              <Typography.Text className="tp-text-sm">allowed-tools：</Typography.Text>
              {detail.allowed_tools.length
                ? detail.allowed_tools.map((t) => <Tag key={t}>{t}</Tag>)
                : <Tag>不限</Tag>}
            </Space>
            <div data-testid="skill-body" className="tp-skill-md">
              <ReactMarkdown>{detail.body}</ReactMarkdown>
            </div>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
