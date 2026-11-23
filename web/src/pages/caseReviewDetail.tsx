// 评审详情（D194）：通过率/状态 + 用例表 + 单条/批量结论 + 评审人 + 历史 + 重审。
// 状态/通过率只从后端读（读时聚合），页面不重算。
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Input, Modal, Progress, Select, Space, Spin, Table, Tag, Typography, message,
} from "antd";
import { ArrowLeftOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { functionalApi, type CaseRow } from "../api/functional";
import {
  ACTION_LABEL, RESULT_META, REVIEW_STATUS_META, reviewApi,
  type ReviewCaseRow, type ReviewResultRow, type ReviewRow,
} from "../api/review";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";

type MemberRow = { user_id: string; account: string | null; name: string | null };
type Action = "suggestion" | "pass" | "fail";

function SubmitModal({ open, title, busy, onClose, onSubmit }: {
  open: boolean;
  title: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (action: Action, comment: string) => Promise<void>;
}) {
  const [action, setAction] = useState<Action>("pass");
  const [comment, setComment] = useState("");
  useEffect(() => { if (open) { setAction("pass"); setComment(""); } }, [open]);
  return (
    <Modal open={open} onCancel={onClose} centered width={520} title={title}
      okText="提交" cancelText="取消" okButtonProps={{ loading: busy, "data-testid": "review-submit-ok" }}
      onOk={() => {
        if (action === "fail" && !comment.trim()) { message.warning("不通过必须填写意见"); return; }
        void onSubmit(action, comment.trim());
      }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Select data-testid="review-submit-action" value={action} style={{ width: 160 }}
          onChange={(v) => setAction(v as Action)}
          options={[
            { value: "pass", label: "通过" },
            { value: "fail", label: "不通过" },
            { value: "suggestion", label: "建议（不结论）" },
          ]} />
        <Input.TextArea data-testid="review-submit-comment" rows={4} value={comment}
          placeholder={action === "fail" ? "不通过必须填写意见" : "评审意见（可选）"}
          onChange={(e) => setComment(e.target.value)} />
      </Space>
    </Modal>
  );
}

function Detail({ id }: { id: string }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpdate = can(perms, "review:review:update");
  const canSubmit = can(perms, "review:result:create");

  const [review, setReview] = useState<ReviewRow | null>(null);
  const [rows, setRows] = useState<ReviewCaseRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [resultFilter, setResultFilter] = useState<string | undefined>();
  const [todoOnly, setTodoOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const [submitTarget, setSubmitTarget] = useState<ReviewCaseRow | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [assocOpen, setAssocOpen] = useState(false);
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [history, setHistory] = useState<{ caseId: string; name: string; rows: ReviewResultRow[] } | null>(null);
  const [candidates, setCandidates] = useState<CaseRow[]>([]);
  const [assocIds, setAssocIds] = useState<string[]>([]);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [reviewerMode, setReviewerMode] = useState<"replace" | "append">("replace");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [r, cs] = await Promise.all([reviewApi.get(pid, id), reviewApi.cases({
        project_id: pid, review_id: id, result: resultFilter,
        todo_only: todoOnly || undefined, current, size: pageSize,
      })]);
      setReview(r); setRows(cs.items); setTotal(cs.total);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "评审详情加载失败");
    } finally { setLoading(false); }
  }, [pid, id, resultFilter, todoOnly, current, pageSize]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members",
          { silent: true });
        setMembers(r.items);
      } catch { setMembers([]); }
    })();
  }, [pid]);

  async function submitOne(target: ReviewCaseRow, action: Action, comment: string): Promise<void> {
    setBusy(true);
    try {
      await reviewApi.submit(pid, id, target.case_id, action, comment || undefined);
      message.success("结论已提交");
      setSubmitTarget(null);
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  async function submitBatch(action: Action, comment: string): Promise<void> {
    setBusy(true);
    try {
      const out = await reviewApi.batchSubmit(pid, id, selected, action, comment || undefined);
      message.success("已提交 " + out.affected + " 条" + (out.skipped.length ? "，跳过 " + out.skipped.length + " 条" : ""));
      setBatchOpen(false); setSelected([]);
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  async function reReview(row: ReviewCaseRow): Promise<void> {
    try {
      await reviewApi.reReview(pid, id, row.case_id);
      message.success("已重新提审");
      await load();
    } catch { /* toast */ }
  }

  async function removeRow(row: ReviewCaseRow): Promise<void> {
    Modal.confirm({
      centered: true, title: "从评审移除「" + (row.case_name ?? row.case_id) + "」？",
      content: "该用例在此评审里的结论历史会一起删除。",
      okText: "移除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        await reviewApi.disassociate(pid, id, row.case_id);
        message.success("已移除");
        await load();
      },
    });
  }

  async function openHistory(row: ReviewCaseRow): Promise<void> {
    try {
      const r = await reviewApi.history(pid, id, row.case_id);
      setHistory({ caseId: row.case_id, name: row.case_name ?? row.case_id, rows: r.items });
    } catch { /* toast */ }
  }

  async function openAssoc(): Promise<void> {
    setAssocIds([]);
    setAssocOpen(true);
    try {
      const r = await functionalApi.listCases({ project_id: pid, current: 1, size: 200 });
      setCandidates(r.items.filter((c) => !c.recycled));
    } catch { setCandidates([]); }
  }

  async function submitAssoc(): Promise<void> {
    if (assocIds.length === 0) return;
    setBusy(true);
    try {
      const out = await reviewApi.associate(pid, id, assocIds);
      message.success("已关联 " + out.created + " 条" + (out.skipped ? "，跳过 " + out.skipped + " 条" : ""));
      setAssocOpen(false); await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  async function submitReviewers(): Promise<void> {
    if (selected.length === 0 || reviewerIds.length === 0) return;
    setBusy(true);
    try {
      await reviewApi.setReviewers(pid, id, selected, reviewerIds, reviewerMode);
      message.success("评审人已更新");
      setReviewerOpen(false); await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  if (loading && !review) return <Spin style={{ display: "block", margin: "20vh auto" }} />;
  if (err || !review) {
    return <Alert type="error" showIcon data-testid="review-detail-load-error"
      message="评审详情没取到" description={err ?? "评审不存在"} />;
  }
  const sm = REVIEW_STATUS_META[review.status] ?? { label: review.status, color: "default" };

  return (
    <div data-testid="page-case-review-detail" className="tp-fill-stack">
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav("/reviews")}>返回列表</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
      </Space>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Space align="center" size={12} wrap>
          <Typography.Title level={4} style={{ margin: 0 }} data-testid="review-detail-title">{review.name}</Typography.Title>
          <Tag color={sm.color}>{sm.label}</Tag>
          <Tag>{review.pass_rule === "multiple" ? "多人通过" : "单人通过"}</Tag>
          <Typography.Text type="secondary" className="tp-text-sm">
            编号 {review.num} · 创建人 {review.created_by_name ?? "—"} · 更新于 {fmtTime(review.updated_at) ?? "—"}
          </Typography.Text>
        </Space>
        <Space size={24} style={{ marginTop: 12 }} wrap>
          <Progress type="line" percent={review.pass_rate} style={{ width: 260 }}
            status={review.status === "completed" && review.pass_count < review.case_count ? "exception" : "normal"} />
          <Typography.Text>通过 {review.pass_count} / 共 {review.case_count} 条</Typography.Text>
          <Typography.Text type="secondary">已出结论 {review.resolved_count} 条</Typography.Text>
          <Typography.Text type="secondary">评审人 {review.reviewer_count} 人</Typography.Text>
        </Space>
        {review.description && (
          <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>{review.description}</Typography.Paragraph>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16 }}>
        <Space style={{ marginBottom: 10 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>评审用例（{review.case_count}）</Typography.Title>
          {canUpdate && (
            <Button size="small" data-testid="review-assoc" onClick={() => void openAssoc()}>关联用例</Button>
          )}
          {canSubmit && selected.length > 0 && (
            <Button size="small" type="primary" data-testid="review-batch-submit"
              onClick={() => setBatchOpen(true)}>批量评审（{selected.length}）</Button>
          )}
          {canUpdate && selected.length > 0 && (
            <>
              <Button size="small" data-testid="review-batch-reviewers"
                onClick={() => { setReviewerIds([]); setReviewerMode("replace"); setReviewerOpen(true); }}>
                批量改评审人
              </Button>
              <Button size="small" data-testid="review-batch-rereview"
                onClick={async () => {
                  try {
                    await reviewApi.batchReReview(pid, id, selected);
                    message.success("已重新提审");
                    setSelected([]); await load();
                  } catch { /* toast */ }
                }}>
                批量重审
              </Button>
            </>
          )}
          <Select allowClear placeholder="结论筛选" style={{ width: 120 }} value={resultFilter}
            options={Object.entries(RESULT_META).map(([value, m]) => ({ value, label: m.label }))}
            onChange={(v) => { setResultFilter(v); setCurrent(1); }} />
          <Select allowClear placeholder="只看我的待办" style={{ width: 140 }}
            value={todoOnly ? "todo" : undefined}
            options={[{ value: "todo", label: "我的待办" }]}
            onChange={(v) => { setTodoOnly(v === "todo"); setCurrent(1); }} />
        </Space>
        <Table<ReviewCaseRow> rowKey="case_id" loading={loading} dataSource={rows} pagination={false}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(String)),
          }}
          locale={{ emptyText: "评审里还没有用例" }}
          columns={[
            { title: "用例", key: "name", render: (_, r) => (
              r.case_exists ? (
                <Typography.Link onClick={() => nav("/functional/cases/" + r.case_id)}>
                  {r.case_name ?? r.case_id}
                </Typography.Link>
              ) : <Typography.Text type="secondary">对象已不存在（{r.case_id.slice(0, 8)}）</Typography.Text>
            ) },
            { title: "评审人", key: "reviewers", width: 200, render: (_, r) => (
              r.reviewers.length ? r.reviewers.map((x) => <Tag key={x.user_id}>{x.name ?? x.user_id}</Tag>)
                : <Typography.Text type="secondary">未分派</Typography.Text>) },
            { title: "结论", dataIndex: "result", width: 110, render: (v: string, r) => {
              const m = RESULT_META[v] ?? { label: v, color: "default" };
              return (
                <Space size={4}>
                  <Tag color={m.color}>{m.label}</Tag>
                  {r.re_review && <Tag color="warning">重审</Tag>}
                </Space>
              );
            } },
            { title: "更新时间", key: "upd", width: 140, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 250, render: (_, r) => (
              <Space size={4} wrap>
                {canSubmit && (r.reviewers.length === 0 || user?.is_system_admin
                  || r.reviewers.some((x) => x.user_id === user?.id)) && (
                  <Button size="small" data-testid="review-case-submit"
                    onClick={() => setSubmitTarget(r)}>评审</Button>
                )}
                <Button size="small" data-testid="review-case-history" onClick={() => void openHistory(r)}>历史</Button>
                {canUpdate && (
                  <>
                    <Button size="small" onClick={() => void reReview(r)}>重审</Button>
                    <Button size="small" danger onClick={() => void removeRow(r)}>移除</Button>
                  </>
                )}
              </Space>
            ) },
          ]}
          footer={() => (
            <div className="tp-cardfoot">
              <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
                结论由分派评审人或系统管理员提交；不通过必须填意见
              </Typography.Text>
              <ListPager current={current} pageSize={pageSize} total={total}
                onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
            </div>
          )}
        />
      </div>

      <SubmitModal open={submitTarget !== null}
        title={"评审：" + (submitTarget?.case_name ?? "")}
        busy={busy} onClose={() => setSubmitTarget(null)}
        onSubmit={(action, comment) => submitOne(submitTarget!, action, comment)} />
      <SubmitModal open={batchOpen} title={"批量评审 " + selected.length + " 条用例"}
        busy={busy} onClose={() => setBatchOpen(false)}
        onSubmit={(action, comment) => submitBatch(action, comment)} />

      <Modal open={assocOpen} onCancel={() => setAssocOpen(false)} centered width={640}
        title="关联用例" okText={"关联" + (assocIds.length ? "（" + assocIds.length + "）" : "")}
        cancelText="取消" okButtonProps={{ loading: busy, disabled: assocIds.length === 0 }}
        onOk={() => void submitAssoc()}>
        <Select mode="multiple" style={{ width: "100%" }} value={assocIds} onChange={setAssocIds}
          optionFilterProp="label" placeholder="选择要加入评审的用例"
          options={candidates.map((c) => ({ value: c.id, label: c.num + " " + c.name }))} />
        <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginTop: 8 }}>
          未指定评审人时沿用本评审已有评审人；重复关联会跳过。
        </Typography.Paragraph>
      </Modal>

      <Modal open={reviewerOpen} onCancel={() => setReviewerOpen(false)} centered width={560}
        title={"改评审人（已选 " + selected.length + " 条用例）"}
        okText="应用" cancelText="取消" okButtonProps={{ loading: busy, disabled: reviewerIds.length === 0 }}
        onOk={() => void submitReviewers()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Select value={reviewerMode} style={{ width: 160 }} onChange={(v) => setReviewerMode(v as "replace" | "append")}
            options={[{ value: "replace", label: "整体替换" }, { value: "append", label: "追加" }]} />
          <Select mode="multiple" style={{ width: "100%" }} value={reviewerIds} onChange={setReviewerIds}
            optionFilterProp="label" placeholder="选择评审人"
            options={members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id }))} />
        </Space>
      </Modal>

      <Modal open={history !== null} onCancel={() => setHistory(null)} centered width={680}
        title={"结论历史：" + (history?.name ?? "")} footer={null}>
        <Table rowKey="id" size="small" pagination={false} dataSource={history?.rows ?? []}
          columns={[
            { title: "评审人", key: "u", render: (_, x) => x.user_name ?? x.user_id },
            { title: "动作", dataIndex: "action", width: 100, render: (v: string) => ACTION_LABEL[v] ?? v },
            { title: "意见", dataIndex: "comment", render: (v: string | null) => v ?? "—" },
            { title: "有效", dataIndex: "active", width: 70, render: (v: boolean) => v ? <Tag color="green">有效</Tag> : <Tag>作废</Tag> },
            { title: "时间", key: "t", width: 150, render: (_, x) => fmtTime(x.created_at) ?? "—" },
          ]} />
      </Modal>
    </div>
  );
}

export default function CaseReviewDetailPage() {
  const { id } = useParams();
  const { project } = useAuth();
  return <ProjectGate>{project && id ? <Detail id={id} /> : null}</ProjectGate>;
}
