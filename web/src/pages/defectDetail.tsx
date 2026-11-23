// 缺陷详情（D191）：基本信息编辑 + 评论 + 关联用例 + 关注。
//
// 三个后端口径写在页面上：
// ① 状态下拉只列**当前状态允许的去向**（models.DEFECT_TRANSITIONS 的前端镜像）；真正的门禁
//    在后端（非法转移 409）。列表页的编辑弹窗不画状态——状态是详情页的事，避免两处各说一套。
// ② 评论只做两层：对顶层评论「回复」，回复下不再挂回复（后端 422 同尺）。
// ③ 关联用例的对象被删后**保留关联行并标缺失**（后端 case_exists=false），不悄悄消失。
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Divider, Empty, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography, message,
} from "antd";
import { ArrowLeftOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import { tpv } from "../theme";
import ProjectGate from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { projectMetaApi, type TemplateDetail } from "../api/projectMeta";
import CustomFieldForm from "../ui/CustomFields";
import Attachments from "../ui/Attachments";
import {
  CASE_TYPE_LABELS, defectApi, defectFlowApi, flowAllowed, flowLabel, isDefectFlow, statusMeta,
  type DefectCaseOption, type DefectComment, type DefectFlow, type DefectLink, type DefectRow,
} from "../api/defect";
import { fmtTime } from "../shared/timefmt";

type MemberRow = { user_id: string; account: string | null; name: string | null };

function CommentNode({ c, canComment, meId, onReply, onChanged }: {
  c: DefectComment;
  canComment: boolean;
  meId: string;
  onReply: (c: DefectComment) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.content);
  const mine = c.created_by === meId;
  async function save(): Promise<void> {
    if (!text.trim()) { message.warning("评论不能为空"); return; }
    try {
      await defectApi.updateComment(c.defect_id, c.id, text.trim());
      setEditing(false);
      onChanged();
    } catch { /* client 已 toast */ }
  }
  async function remove(): Promise<void> {
    try {
      await defectApi.deleteComment(c.defect_id, c.id);
      message.success("评论已删除");
      onChanged();
    } catch { /* client 已 toast */ }
  }
  return (
    <div data-testid="defect-comment" style={{ padding: "8px 0", borderBottom: "1px solid " + tpv.bg.layout }}>
      <Space size={8} wrap>
        <Typography.Text strong data-testid="defect-comment-author">{c.created_by_name ?? c.created_by}</Typography.Text>
        {c.parent_id && c.reply_user_name && (
          <Typography.Text type="secondary" className="tp-text-sm">回复 @{c.reply_user_name}</Typography.Text>
        )}
        <Typography.Text type="secondary" className="tp-text-sm">
          {fmtTime(c.created_at) ?? "—"}
        </Typography.Text>
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
          <Typography.Paragraph style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
            {c.content}
          </Typography.Paragraph>
          <Space size={4}>
            {canComment && !c.parent_id && (
              <Button size="small" type="link" onClick={() => onReply(c)}>回复</Button>
            )}
            {mine && canComment && (
              <>
                <Button size="small" type="link" onClick={() => setEditing(true)}>编辑</Button>
                <Button size="small" type="link" danger
                  onClick={() => {
                    Modal.confirm({
                      centered: true, title: "删除这条评论？",
                      content: c.children.length ? "它的回复会一并删除。" : "删除后无法恢复。",
                      okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
                      onOk: () => void remove(),
                    });
                  }}>
                  删除
                </Button>
              </>
            )}
          </Space>
        </>
      )}
      {c.children.length > 0 && (
        <div style={{ marginLeft: 24, marginTop: 4 }}>
          {c.children.map((child) => (
            <CommentNode key={child.id} c={child} canComment={canComment} meId={meId}
              onReply={onReply} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpdate = can(perms, "defect:defect:update");
  const canComment = can(perms, "defect:defect:comment");
  const canLink = can(perms, "defect:link:update");

  const [row, setRow] = useState<DefectRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [comments, setComments] = useState<DefectComment[]>([]);
  const [links, setLinks] = useState<DefectLink[]>([]);
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("P2");
  const [handle, setHandle] = useState<string | null>(null);
  const [status, setStatus] = useState("new");
  const [tags, setTags] = useState<string[]>([]);
  // D267：项目状态图（拉不到就按内置常量渲染去向下拉；保存时后端仍会校验）。
  const [flow, setFlow] = useState<DefectFlow | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [commentText, setCommentText] = useState("");
  const [replyTo, setReplyTo] = useState<DefectComment | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkType, setLinkType] = useState("scenario");
  const [linkKeyword, setLinkKeyword] = useState("");
  const [options, setOptions] = useState<DefectCaseOption[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [linkBusy, setLinkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [d, cs, ls, ms] = await Promise.all([
        defectApi.get(pid, id),
        defectApi.comments(pid, id),
        defectApi.links(pid, id),
        get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members", { silent: true })
          .catch(() => ({ items: [] as MemberRow[] })),
      ]);
      setRow(d);
      setComments(cs.items);
      setLinks(ls.items);
      setMembers(ms.items);
      setCustom(d.custom_fields ?? {});
      const t = await projectMetaApi.template(pid, d.template_id).catch(() => null);
      setTpl(t);
      setTitle(d.title);
      setDescription(d.description ?? "");
      setPriority(d.priority);
      setHandle(d.handle_user_id);
      setStatus(d.status);
      setTags(d.tags);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "缺陷详情加载失败");
    } finally { setLoading(false); }
  }, [pid, id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const f = await defectFlowApi.get(pid);
        if (alive) setFlow(isDefectFlow(f) ? f : null);
      } catch {
        if (alive) setFlow(null);
      }
    })();
    return () => { alive = false; };
  }, [pid]);

  async function save(): Promise<void> {
    if (!row) return;
    if (!title.trim()) { message.warning("标题必填"); return; }
    setSaving(true);
    setSaveErr(null);
    try {
      const out = await defectApi.update(row.id, {
        project_id: pid, title: title.trim(), description, description_set: true,
        priority, handle_user_id: handle, handle_user_set: true, status, tags,
        ...(tpl ? { custom_fields: custom } : {}),
      });
      setRow(out);
      setStatus(out.status);
      message.success("已保存");
    } catch (e) {
      if (e instanceof ApiErr) setSaveErr(e.message);
    } finally { setSaving(false); }
  }

  async function toggleFollow(): Promise<void> {
    if (!row) return;
    try {
      const out = row.followed
        ? await defectApi.unfollow(pid, row.id)
        : await defectApi.follow(pid, row.id);
      setRow({ ...row, followed: out.following, follower_count: out.follower_count });
    } catch { /* client 已 toast */ }
  }

  async function submitComment(): Promise<void> {
    if (!row) return;
    if (!commentText.trim()) { message.warning("评论不能为空"); return; }
    setCommentBusy(true);
    try {
      await defectApi.addComment(pid, row.id, commentText.trim(), replyTo?.id ?? null);
      setCommentText(""); setReplyTo(null);
      const cs = await defectApi.comments(pid, row.id);
      setComments(cs.items);
      setRow({ ...row, comment_count: row.comment_count + 1 });
    } catch { /* client 已 toast */ }
    finally { setCommentBusy(false); }
  }

  // type 显式入参：打开弹窗时 setLinkType 与本次请求发生在同一批事件里，读 state 会拿到
  // 上一次的旧值——「上次选了 UI 用例、这次重开显示场景」却请求了 UI 候选就是两套真相。
  async function searchOptions(kw?: string, type: string = linkType): Promise<void> {
    if (!row) return;
    try {
      const r = await defectApi.candidates(pid, row.id, type, kw || undefined, 1, 50);
      setOptions(r.items);
    } catch { setOptions([]); }
  }

  async function submitLinks(): Promise<void> {
    if (!row || picked.length === 0) return;
    setLinkBusy(true);
    try {
      const out = await defectApi.addLinks(pid, row.id, linkType, picked);
      message.success("已关联 " + out.created + " 条" + (out.skipped ? "（跳过 " + out.skipped + " 条重复）" : ""));
      setLinkOpen(false); setPicked([]); setLinkKeyword("");
      const ls = await defectApi.links(pid, row.id);
      setLinks(ls.items);
      setRow({ ...row, link_count: ls.total });
    } catch { /* client 已 toast */ }
    finally { setLinkBusy(false); }
  }

  async function removeLink(l: DefectLink): Promise<void> {
    if (!row) return;
    try {
      await defectApi.removeLink(pid, row.id, l.id);
      const ls = await defectApi.links(pid, row.id);
      setLinks(ls.items);
      setRow({ ...row, link_count: ls.total });
      message.success("已取消关联");
    } catch { /* client 已 toast */ }
  }

  if (loading) return <Spin style={{ display: "block", margin: "20vh auto" }} />;
  if (err || !row) {
    return (
      <Alert type="error" showIcon data-testid="defect-detail-load-error"
        message="缺陷详情没取到" description={err ?? "缺陷不存在或已被删除"} />
    );
  }

  const statusChoices = flowAllowed(flow, row.status);
  return (
    <div data-testid="page-defect-detail" className="tp-fill-stack">
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav("/defects")}>返回列表</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        {canUpdate && (
          <Button data-testid="defect-detail-follow"
            icon={<StarOutlined />}
            type={row.followed ? "primary" : "default"}
            onClick={() => void toggleFollow()}>
            {row.followed ? "已关注" : "关注"}（{row.follower_count}）
          </Button>
        )}
        <Typography.Text type="secondary" className="tp-text-sm">
          创建于 {fmtTime(row.created_at) ?? "—"} · 更新于 {fmtTime(row.updated_at) ?? "—"}
        </Typography.Text>
      </Space>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }} data-testid="defect-detail-title">
          {row.title}
        </Typography.Title>
        <Space size={12} wrap>
          <Tag color={statusMeta(row.status).color}>{flowLabel(flow, row.status)}</Tag>
          <Tag color="default">{row.priority}</Tag>
          {row.tags.map((t) => <Tag key={t}>{t}</Tag>)}
        </Space>
        <Divider style={{ margin: "12px 0" }} />
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <Typography.Text strong>标题</Typography.Text>
            <Input data-testid="defect-detail-title-input" maxLength={255} value={title}
              disabled={!canUpdate} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>描述（纯文本）</Typography.Text>
            <Input.TextArea data-testid="defect-detail-description" rows={4} value={description}
              disabled={!canUpdate} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Space size={16} wrap>
            <div>
              <Typography.Text strong>状态</Typography.Text>
              <Select data-testid="defect-detail-status" style={{ width: 140 }} value={status}
                disabled={!canUpdate}
                onChange={(v) => setStatus(String(v))}
                options={statusChoices.map((v) => ({ value: v, label: flowLabel(flow, v) }))} />
              {statusChoices.length <= 1 && (
                <Typography.Text type="secondary" className="tp-text-sm">（终态，无可转移去向）</Typography.Text>
              )}
            </div>
            <div>
              <Typography.Text strong>优先级</Typography.Text>
              <Select style={{ width: 100 }} value={priority} disabled={!canUpdate}
                onChange={(v) => setPriority(String(v))}
                options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))} />
            </div>
            <div>
              <Typography.Text strong>处理人</Typography.Text>
              <Select style={{ width: 180 }} allowClear value={handle ?? undefined}
                disabled={!canUpdate} placeholder="未指派"
                onChange={(v) => setHandle(v ?? null)}
                options={members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id }))} />
            </div>
          </Space>
          <div>
            <Typography.Text strong>标签</Typography.Text>
            <Select mode="tags" style={{ width: "100%" }} value={tags} disabled={!canUpdate}
              maxCount={20} tokenSeparators={[",", "，"]} onChange={setTags} />
          </div>
          {saveErr && <Alert type="error" showIcon data-testid="defect-detail-save-error" message={saveErr} />}
          {canUpdate && (
            <div>
              <Button type="primary" data-testid="defect-detail-save" loading={saving}
                onClick={() => void save()}>
                保存
              </Button>
            </div>
          )}
        </Space>
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }} data-testid="defect-custom-section">
          自定义字段{tpl ? "（模板：" + tpl.name + "）" : ""}
        </Typography.Title>
        {tpl ? (
          <CustomFieldForm fields={tpl.fields} values={custom} onChange={setCustom}
            members={members} disabled={!canUpdate} />
        ) : (
          <Typography.Text type="secondary" className="tp-text-sm">
            模板字段没取到；保存时不会提交自定义字段
          </Typography.Text>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Attachments projectId={pid} targetType="bug" targetId={row.id}
          canWrite={can(perms, "file:attachment:create")}
          canDelete={can(perms, "file:attachment:delete")} />
      </div>

      <div className="tp-card" style={{ padding: 16, marginBottom: 12 }}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>关联用例（{links.length}）</Typography.Title>
          {canLink && (
            <Button size="small" data-testid="defect-link-add"
              onClick={() => { setLinkOpen(true); setPicked([]); setLinkType("scenario"); setLinkKeyword("");
                void searchOptions(undefined, "scenario"); }}>
              关联用例
            </Button>
          )}
        </Space>
        {links.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未关联用例" /> : (
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            {links.map((l) => (
              <Space key={l.id} size={8} wrap data-testid="defect-link-row">
                <Tag>{CASE_TYPE_LABELS[l.case_type] ?? l.case_type}</Tag>
                {l.case_exists
                  ? <Typography.Text>{l.case_name ?? l.case_id}</Typography.Text>
                  : (
                    <Tooltip title="对象已被删除；关联行保留以如实记录当时挂过什么">
                      <Typography.Text type="secondary">对象已不存在（{l.case_id.slice(0, 8)}）</Typography.Text>
                    </Tooltip>
                  )}
                <Typography.Text type="secondary" className="tp-text-sm">
                  {fmtTime(l.created_at, { seconds: false }) ?? "—"}
                </Typography.Text>
                {canLink && (
                  <Button size="small" type="link" danger data-testid="defect-link-remove"
                    onClick={() => void removeLink(l)}>
                    取消关联
                  </Button>
                )}
              </Space>
            ))}
          </Space>
        )}
      </div>

      <div className="tp-card" style={{ padding: 16 }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>评论（{row.comment_count}）</Typography.Title>
        {replyTo && (
          <Typography.Text type="secondary" className="tp-text-sm" data-testid="defect-reply-to">
            正在回复 @{replyTo.created_by_name ?? replyTo.created_by}
            <Button size="small" type="link" onClick={() => setReplyTo(null)}>取消</Button>
          </Typography.Text>
        )}
        {comments.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论" /> : (
          <div data-testid="defect-comment-list">
            {comments.map((c) => (
              <CommentNode key={c.id} c={c} canComment={canComment} meId={user?.id ?? ""}
                onReply={setReplyTo} onChanged={() => void load()} />
            ))}
          </div>
        )}
        {canComment && (
          <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 12 }}>
            <Input.TextArea data-testid="defect-comment-input" rows={3} value={commentText}
              placeholder={replyTo ? "回复 @" + (replyTo.created_by_name ?? replyTo.created_by) : "写评论"}
              onChange={(e) => setCommentText(e.target.value)} />
            <Button type="primary" data-testid="defect-comment-submit" loading={commentBusy}
              onClick={() => void submitComment()}>
              发表评论
            </Button>
          </Space>
        )}
      </div>

      <Modal centered open={linkOpen} onCancel={() => setLinkOpen(false)} width={640}
        title="关联用例" okText={"关联" + (picked.length ? "（" + picked.length + "）" : "")}
        cancelText="取消" okButtonProps={{ loading: linkBusy, disabled: picked.length === 0 }}
        onOk={() => void submitLinks()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space wrap>
            <Select data-testid="defect-link-type" value={linkType} style={{ width: 140 }}
              onChange={(v) => { setLinkType(String(v)); setPicked([]); void searchOptions(undefined, String(v)); }}
              options={Object.entries(CASE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
            <Input.Search placeholder="按名称搜索" allowClear style={{ width: 240 }}
              value={linkKeyword} onChange={(e) => setLinkKeyword(e.target.value)}
              onSearch={(v) => void searchOptions(v)} />
          </Space>
          {options.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可关联的用例（已关联的不会重复出现）" />
          ) : (
            <Select mode="multiple" style={{ width: "100%" }} value={picked} onChange={setPicked}
              placeholder="选择要关联的用例" optionFilterProp="label"
              options={options.map((o) => ({ value: o.id, label: o.name }))} />
          )}
        </Space>
      </Modal>
    </div>
  );
}

export default function DefectDetailPage() {
  const { id } = useParams();
  const { project } = useAuth();
  return (
    <ProjectGate>
      {project && id ? <Detail id={id} /> : null}
    </ProjectGate>
  );
}
