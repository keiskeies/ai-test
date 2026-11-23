// 场景变更历史抽屉（D262）：打开时按需拉一页，最新在前，「加载更多」按 cursor 续取。
// 后端只回摘要（variables 键名 / step_graph 步骤数），所以这里也绝不拼出原文——
// 历史是追责面，不是敏感值的第二份拷贝。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, List, Space, Spin, Tag, Typography } from "antd";
import { sceneApi, type ScenarioRevisionRow } from "../api/scene";
import { fmtTime } from "../shared/timefmt";

/** 后端 changed[].field 的展示名；未知字段原样露 key（不吞事实，也不假装认识它）。 */
const FIELD_LABELS: Record<string, string> = {
  name: "名称",
  priority: "优先级",
  module_id: "模块",
  fail_fast: "失败即停",
  max_runtime_ms: "执行超时",
  env_id: "环境",
  project_public: "公开范围",
  step_graph: "步骤",
  variables: "变量",
  common_assertions: "公共断言",
};

function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (field === "step_graph" && typeof v === "object") {
    return String((v as { step_count?: number }).step_count ?? 0) + " 步";
  }
  if (field === "variables" && typeof v === "object") {
    const keys = (v as { keys?: string[] }).keys ?? [];
    return keys.length ? keys.join("、") : "（无）";
  }
  if (field === "common_assertions" && typeof v === "object") {
    return String((v as { count?: number }).count ?? 0) + " 条";
  }
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}

export interface RevisionDrawerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  scenarioId: string;
}

export default function RevisionDrawer({ open, onClose, projectId, scenarioId }: RevisionDrawerProps) {
  const [rows, setRows] = useState<ScenarioRevisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await sceneApi.revisions(projectId, scenarioId,
        next ? { cursor: next } : undefined);
      // 翻页是追加，首屏是替换：重开抽屉不能把上一次场景的历史残留进来。
      setRows((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "变更历史没取到");
    } finally {
      setLoading(false);
    }
  }, [projectId, scenarioId]);

  useEffect(() => {
    if (!open) return;
    setRows([]);
    setCursor(null);
    void load();
  }, [open, load]);

  return (
    <Drawer data-testid="scene-revisions-drawer" title="变更历史" width={460}
      open={open} onClose={onClose} destroyOnHidden>
      {error ? (
        <Alert type="error" showIcon data-testid="scene-revisions-failed"
          message="变更历史没取到" description={error}
          action={<Button size="small" data-testid="scene-revisions-retry"
            onClick={() => void load(cursor ?? undefined)}>重试</Button>} />
      ) : loading && rows.length === 0 ? (
        <Spin data-testid="scene-revisions-loading" style={{ display: "block", margin: "20vh auto" }} />
      ) : rows.length === 0 ? (
        <Empty data-testid="scene-revisions-empty" description="还没有变更记录——场景创建后没有保存过修改" />
      ) : (
        <>
          <List data-testid="scene-revisions-list" size="small" split
            dataSource={rows}
            renderItem={(r) => (
              <List.Item data-testid="scene-revision-row" key={r.id}>
                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                  <Space size={8} wrap>
                    <Tag color="blue">v{r.version}</Tag>
                    <Typography.Text strong>{r.actor_name ?? "未知用户"}</Typography.Text>
                    <Typography.Text type="secondary" className="tp-text-sm">
                      {fmtTime(r.created_at) ?? "—"}
                    </Typography.Text>
                  </Space>
                  {r.changed.length === 0 ? (
                    <Typography.Text type="secondary" className="tp-text-sm">
                      本次保存只推进了版本，没有字段变化
                    </Typography.Text>
                  ) : (
                    <div>
                      {r.changed.map((c) => (
                        <div key={c.field} className="tp-text-sm">
                          <Typography.Text strong>{FIELD_LABELS[c.field] ?? c.field}</Typography.Text>
                          {": "}
                          <Typography.Text delete>{fmtValue(c.field, c.before)}</Typography.Text>
                          {" → "}
                          <Typography.Text>{fmtValue(c.field, c.after)}</Typography.Text>
                        </div>
                      ))}
                    </div>
                  )}
                </Space>
              </List.Item>
            )} />
          {cursor && (
            <Button block type="link" data-testid="scene-revisions-more" disabled={loading}
              style={{ marginTop: 8 }} onClick={() => void load(cursor)}>
              {loading ? "加载中…" : "加载更早的记录"}
            </Button>
          )}
        </>
      )}
    </Drawer>
  );
}
