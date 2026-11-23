// 公开分享页（D202）：/share/:token，不登录、不挂 ProjectGate。
// 后端只回最小快照载荷；这里逐字渲染，不补齐任何后端没给的数据。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Input, Space, Spin, Table, Tag, Typography } from "antd";
import { useParams } from "react-router-dom";
import { ApiErr } from "../api/client";
import { shareApi, type SharePayload } from "../api/share";
import { LINK_RESULTS, STATUSES, SUBJECT_TYPES, vocabMeta } from "../shared/runVocab";
import { fmtTime } from "../shared/timefmt";

type Fail = { kind: "gone" | "expired" | "other"; message: string };

function ReportBody({ report }: { report: Record<string, unknown> }) {
  const stats = (report.stats ?? {}) as Record<string, number | undefined>;
  const st = vocabMeta(STATUSES, String(report.status ?? ""));
  const subj = SUBJECT_TYPES[String(report.subject_type ?? "")];
  return (
    <>
      <Space wrap size={6}>
        <Typography.Text strong data-testid="share-report-name">{String(report.subject_name ?? "")}</Typography.Text>
        <Tag color={subj?.color ?? "default"}>{subj?.label ?? String(report.subject_type ?? "")}</Tag>
        <Tag color={st.color} data-testid="share-report-status">{st.label}</Tag>
      </Space>
      {typeof report.error === "string" && report.error !== "" && (
        <Alert type="error" showIcon style={{ marginTop: 8 }} message="运行结论" description={report.error} />
      )}
      <Descriptions size="small" column={{ xs: 1, md: 3 }} colon={false} style={{ marginTop: 12 }}
        items={[
          { key: "total", label: "步骤", children: String(stats.total ?? "—") },
          { key: "pass", label: "通过", children: String(stats.pass ?? "—") },
          { key: "fail", label: "失败", children: String(stats.fail ?? "—") },
          { key: "skip", label: "跳过", children: String(stats.skip ?? "—") },
          { key: "error", label: "错误", children: String(stats.error ?? "—") },
          { key: "ms", label: "耗时", children: report.elapsed_ms == null ? "—" : report.elapsed_ms + " ms" },
          { key: "st", label: "开始", children: fmtTime(report.started_at as string | null) ?? "—" },
          { key: "fi", label: "结束", children: fmtTime(report.finished_at as string | null) ?? "—" },
        ]} />
      <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        这是分享创建者选择公开的一份运行报告快照。截图/制品等原始字节不在分享范围内。
      </Typography.Paragraph>
    </>
  );
}

function PlanReportBody({ report }: { report: Record<string, unknown> }) {
  const items = (report.items ?? []) as Array<Record<string, unknown>>;
  return (
    <>
      <Typography.Text strong data-testid="share-plan-report-name">{String(report.name ?? "")}</Typography.Text>
      <Descriptions size="small" column={{ xs: 2, md: 3 }} colon={false} style={{ marginTop: 12 }}
        items={[
          { key: "total", label: "关联总数", children: String(report.total ?? "—") },
          { key: "executed", label: "已执行", children: String(report.executed ?? "—") },
          { key: "executing", label: "执行中", children: String(report.executing ?? "—") },
          { key: "passed", label: "通过", children: String(report.passed ?? "—") },
          { key: "failed", label: "未通过", children: String(report.failed ?? "—") },
          { key: "created", label: "生成时间", children: fmtTime(report.created_at as string | null) ?? "—" },
        ]} />
      <Table size="small" style={{ marginTop: 12 }} pagination={false}
        rowKey={(r) => String(r.subject_id) + ":" + String(r.subject_type)}
        dataSource={items}
        locale={{ emptyText: "这份报告生成时计划没有关联对象" }}
        columns={[
          { title: "对象", key: "s", render: (_, r) => (
            <Space size={4}>
              <Tag>{SUBJECT_TYPES[String(r.subject_type)]?.label ?? String(r.subject_type)}</Tag>
              <span className="tp-text-sm">{String(r.subject_name ?? "")}</span>
            </Space>) },
          { title: "结论", key: "r", width: 110, render: (_, r) => {
            const m = vocabMeta(LINK_RESULTS, String(r.result ?? ""));
            return r.executing ? <Tag color="processing">执行中</Tag> : <Tag color={m.color}>{m.label}</Tag>;
          } },
        ]} />
    </>
  );
}

function ApiDocBody({ definition }: { definition: Record<string, unknown> }) {
  const req = definition.request as { method?: string; path?: string } | undefined;
  return (
    <>
      <Space wrap size={6}>
        <Typography.Text strong data-testid="share-api-name">{String(definition.name ?? "")}</Typography.Text>
        <Tag color="blue">{String(req?.method ?? "—")}</Tag>
        <Typography.Text code>{String(req?.path ?? "—")}</Typography.Text>
        <Tag>{String(definition.status ?? "")}</Tag>
      </Space>
      <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginTop: 12 }}>
        版本 {String(definition.version ?? "—")}
      </Typography.Paragraph>
      <pre className="tp-text-sm tp-mono" style={{ margin: 0, background: "var(--tp-bg-layout)",
        padding: 12, borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 480, overflow: "auto" }}>
        {JSON.stringify(definition.request ?? {}, null, 2)}
      </pre>
    </>
  );
}

export default function ShareViewPage() {
  const { token } = useParams();
  const [data, setData] = useState<SharePayload | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  const load = useCallback(async (pwd?: string) => {
    if (!token) return;
    setBusy(true);
    try {
      setData(await shareApi.publicGet(token, pwd));
      setFail(null); setNeedPassword(false); setWrong(false);
    } catch (e) {
      setData(null);
      if (e instanceof ApiErr && e.status === 401 && e.code === "password_required") {
        setNeedPassword(true);
        setWrong(!!pwd);
      } else if (e instanceof ApiErr && e.status === 410) {
        setFail({ kind: "expired", message: e.message });
      } else if (e instanceof ApiErr && e.status === 404) {
        setFail({ kind: "gone", message: e.message });
      } else {
        setFail({ kind: "other", message: e instanceof ApiErr ? e.message : "分享读取失败" });
      }
    } finally { setBusy(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const report = data?.report as Record<string, unknown> | undefined;
  const definition = data?.definition as Record<string, unknown> | undefined;

  return (
    <div data-testid="page-share" style={{ minHeight: "100vh", background: "var(--tp-bg-layout)",
      padding: "48px 16px", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <Card style={{ width: "min(960px, 100%)" }} title={
        <Space>
          <Typography.Text strong>TestPilot 分享</Typography.Text>
          {data?.title && <Typography.Text type="secondary" className="tp-text-sm">{data.title}</Typography.Text>}
        </Space>}>
        {fail && (
          <Alert type="error" showIcon data-testid="share-fail"
            message={fail.kind === "expired" ? "分享已过期" : fail.kind === "gone" ? "分享不存在或已失效" : "分享读取失败"}
            description={fail.message} />
        )}
        {needPassword && !data && (
          <Space direction="vertical" size={12} style={{ width: "100%" }} data-testid="share-password-gate">
            <Typography.Text>该分享需要访问密码。</Typography.Text>
            <Space.Compact style={{ width: "100%" }}>
              <Input.Password placeholder="访问密码" value={password} status={wrong ? "error" : undefined}
                data-testid="share-password" onChange={(e) => setPassword(e.target.value)}
                onPressEnter={() => void load(password)} />
              <Button type="primary" loading={busy} data-testid="share-password-submit"
                onClick={() => void load(password)}>查看</Button>
            </Space.Compact>
            {wrong && <Typography.Text type="danger" className="tp-text-sm">密码不对，再试一次。</Typography.Text>}
          </Space>
        )}
        {!data && !fail && !needPassword && (
          <Spin style={{ display: "block", margin: "10vh auto" }} data-testid="share-loading" />
        )}
        {data && report && data.type === "report" && <ReportBody report={report} />}
        {data && report && data.type === "plan_report" && <PlanReportBody report={report} />}
        {data && definition && <ApiDocBody definition={definition} />}
      </Card>
    </div>
  );
}
