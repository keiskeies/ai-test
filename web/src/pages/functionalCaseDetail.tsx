// 功能用例详情（D193）：基本信息 + 模块 + 模板动态字段。
// 模板在创建后固定（与 MS 的模板选择器只在新建时出现一致）；模块可移动。
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Input, Select, Space, Spin, Tag, Typography, message,
} from "antd";
import { ArrowLeftOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import ProjectGate from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { functionalApi, type CaseDetail, type FunctionalModuleNode } from "../api/functional";
import { projectMetaApi, type TemplateDetail } from "../api/projectMeta";
import { reviewApi, REVIEW_STATUS_META, RESULT_META, type CaseReviewLink } from "../api/review";
import CustomFieldForm from "../ui/CustomFields";
import Attachments from "../ui/Attachments";
import CaseComments from "../ui/CaseComments";
import CaseRelations from "../ui/CaseRelations";
import { fmtTime } from "../shared/timefmt";
import { flattenModules } from "./functionalCases";

const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };
type MemberRow = { user_id: string; account: string | null; name: string | null };

function Detail({ id }: { id: string }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpdate = can(perms, "functional:case:update");
  const canComment = can(perms, "functional:case:comment");

  const [row, setRow] = useState<CaseDetail | null>(null);
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [tree, setTree] = useState<FunctionalModuleNode[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [reviews, setReviews] = useState<CaseReviewLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [priority, setPriority] = useState("P2");
  const [description, setDescription] = useState("");
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, t, ms] = await Promise.all([
        functionalApi.getCase(pid, id),
        functionalApi.tree(pid),
        get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members", { silent: true })
          .catch(() => ({ items: [] as MemberRow[] })),
      ]);
      setMembers(ms.items);
      const rs = await reviewApi.caseReviews(pid, id).catch(() => ({ items: [] as CaseReviewLink[] }));
      setReviews(rs.items);
      setRow(c);
      setTree(t.tree);
      setName(c.name);
      setPriority(c.priority);
      setDescription(c.description ?? "");
      setModuleId(c.module_id);
      setOwnerId(c.owner_id);
      setTags(c.tags ?? []);
      setCustom(c.custom_fields ?? {});
      const d = await projectMetaApi.template(pid, c.template_id).catch(() => null);
      setTpl(d);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "用例详情加载失败");
    } finally { setLoading(false); }
  }, [pid, id]);
  useEffect(() => { void load(); }, [load]);

  async function save(): Promise<void> {
    if (!row) return;
    if (!name.trim()) { message.warning("用例名称必填"); return; }
    setSaving(true);
    setSaveErr(null);
    try {
      const out = await functionalApi.updateCase(row.id, {
        project_id: pid, name: name.trim(), priority, description, description_set: true,
        owner_id: ownerId, owner_set: true,
        tags,
        module_id: moduleId, module_set: true,
        ...(tpl ? { custom_fields: custom } : {}),
      });
      setRow({ ...row, ...out });
      setCustom(out.custom_fields ?? {});
      message.success("已保存");
    } catch (e) {
      if (e instanceof ApiErr) setSaveErr(e.message);
    } finally { setSaving(false); }
  }

  /** D234：关注/取关（回执两问现查，直接覆盖本页）。 */
  async function toggleFollow(): Promise<void> {
    if (!row) return;
    setFollowBusy(true);
    try {
      const out = row.followed
        ? await functionalApi.unfollowCase(pid, row.id)
        : await functionalApi.followCase(pid, row.id);
      setRow({ ...row, followed: out.following, follower_count: out.follower_count });
    } catch { /* toast */ } finally { setFollowBusy(false); }
  }

  if (loading) return <Spin style={{ display: "block", margin: "20vh auto" }} />;
  if (err || !row) {
    return <Alert type="error" showIcon data-testid="fc-detail-load-error"
      message="用例详情没取到" description={err ?? "用例不存在或已删除"} />;
  }

  return (
    <div data-testid="page-functional-case-detail" className="tp-fill-stack">
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav("/functional/cases")}>返回列表</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        {canUpdate && (
          <Button data-testid="fc-detail-follow" data-followed={row.followed ? "1" : "0"}
            loading={followBusy} onClick={() => void toggleFollow()}
            icon={<StarOutlined
              style={row.followed ? { color: "#faad14" } : { color: "#bfbfbf" }} />}>
            {row.followed ? "已关注" : "关注"}
          </Button>
        )}
        {typeof row.follower_count === "number" && (
          <Typography.Text type="secondary" className="tp-text-sm"
            data-testid="fc-detail-follower-count">
            {row.follower_count} 人关注
          </Typography.Text>
        )}
        <Typography.Text type="secondary" className="tp-text-sm">
          编号 {row.num} · 创建于 {fmtTime(row.created_at) ?? "—"} · 更新于 {fmtTime(row.updated_at) ?? "—"}
        </Typography.Text>
      </Space>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }} data-testid="fc-detail-title">{row.name}</Typography.Title>
        <Space size={8} wrap>
          <Tag color={PRIO_COLOR[row.priority] ?? "default"}>{row.priority}</Tag>
          <Tag>{tpl?.name ?? "模板未取到"}</Tag>
          {row.recycled && <Tag color="red">回收站</Tag>}
        </Space>
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>名称</Typography.Text>
          <Input maxLength={255} value={name} disabled={!canUpdate} onChange={(e) => setName(e.target.value)} />
        </div>
        <Space size={16} wrap style={{ marginTop: 12 }}>
          <div>
            <Typography.Text strong>优先级</Typography.Text>
            <Select style={{ width: 100 }} value={priority} disabled={!canUpdate}
              onChange={setPriority}
              options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))} />
          </div>
          <div>
            <Typography.Text strong>模块</Typography.Text>
            <Select style={{ width: 220 }} allowClear value={moduleId ?? undefined}
              disabled={!canUpdate} placeholder="未分类"
              onChange={(v) => setModuleId(v ?? null)} options={flattenModules(tree)} />
          </div>
          <div>
            <Typography.Text strong>责任人</Typography.Text>
            <Select data-testid="fc-detail-owner" style={{ width: 180 }} allowClear
              value={ownerId ?? undefined} disabled={!canUpdate} placeholder="未指派"
              onChange={(v) => setOwnerId(v ?? null)}
              options={members.map((m) => ({
                value: m.user_id, label: m.name ?? m.account ?? m.user_id,
              }))} />
          </div>
          <div>
            <Typography.Text strong>标签</Typography.Text>
            <Select mode="tags" data-testid="fc-detail-tags" style={{ width: 220 }}
              value={tags} disabled={!canUpdate} placeholder="回车或逗号分隔"
              tokenSeparators={[",", "，"]} onChange={(v: string[]) => setTags(v)} />
          </div>
        </Space>
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>描述</Typography.Text>
          <Input.TextArea rows={4} value={description} disabled={!canUpdate}
            onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>所在评审（{reviews.length}）</Typography.Title>
        {reviews.length === 0 ? (
          <Typography.Text type="secondary" className="tp-text-sm">尚未加入任何评审</Typography.Text>
        ) : (
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            {reviews.map((r) => {
              const sm = REVIEW_STATUS_META[r.status] ?? { label: r.status, color: "default" };
              const rm = RESULT_META[r.result] ?? { label: r.result, color: "default" };
              return (
                <Space key={r.review_id} size={8} wrap>
                  <Typography.Link onClick={() => nav("/reviews/" + r.review_id)}>
                    {r.review_name}
                  </Typography.Link>
                  <Tag color={sm.color}>{sm.label}</Tag>
                  <Tag color={rm.color}>{rm.label}</Tag>
                  {r.re_review && <Tag color="warning">重审</Tag>}
                  <Typography.Text type="secondary" className="tp-text-sm">
                    通过率 {r.pass_rate}%（{r.case_count} 条）
                  </Typography.Text>
                </Space>
              );
            })}
          </Space>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>自定义字段</Typography.Title>
        {tpl ? (
          <CustomFieldForm fields={tpl.fields} values={custom} onChange={setCustom}
            members={members} disabled={!canUpdate} />
        ) : (
          <Typography.Text type="secondary" className="tp-text-sm">模板字段没取到；保存时不会提交自定义字段</Typography.Text>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Attachments projectId={pid} targetType="functional_case" targetId={row.id}
          canWrite={can(perms, "file:attachment:create")}
          canDelete={can(perms, "file:attachment:delete")} />
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <CaseRelations projectId={pid} caseId={row.id} canEdit={canUpdate} />
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <CaseComments projectId={pid} caseId={row.id} meId={user?.id ?? ""} canWrite={canComment} />
      </div>

      {saveErr && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={saveErr} />}
      {canUpdate && (
        <Button type="primary" data-testid="fc-detail-save" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      )}
    </div>
  );
}

export default function FunctionalCaseDetailPage() {
  const { id } = useParams();
  const { project } = useAuth();
  return <ProjectGate>{project && id ? <Detail id={id} /> : null}</ProjectGate>;
}
