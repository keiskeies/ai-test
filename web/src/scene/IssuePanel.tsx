// 底部问题面板（§11.4.9「校验错=节点角标+底部问题面板定位」）。
// 数据 = validateLocal ∪ 后端 live issues（同 store.mergeIssues 的并集口径）；
// 点击「定位」= 选中该节点（画布红角标与属性面板同时跟上）。
import { useMemo } from "react";
import { Alert, Badge, Button, Table, Typography } from "antd";
import type { Issue } from "./graphOps";
import { mergeIssues, useSceneStore } from "./store";

export default function IssuePanel() {
  const nodes = useSceneStore((s) => s.nodes);
  const serverIssues = useSceneStore((s) => s.serverIssues);
  const refused = useSceneStore((s) => s.refused);
  const select = useSceneStore((s) => s.select);
  const issues = useMemo(() => mergeIssues(nodes, serverIssues), [nodes, serverIssues]);

  return (
    <div data-testid="scene-issue-panel" style={{ maxHeight: 160, overflow: "auto", background: "#fff", borderTop: "1px solid var(--tp-split)" }}>
      {refused && (
        <div data-testid="save-refused" style={{ padding: "6px 12px" }}>
          <Alert type="error" showIcon
            message="保存被拒绝：先解决下面的问题（本地预检与后端同口径，后端仍是最终真相）" />
        </div>
      )}
      {issues.length === 0 ? (
        <Typography.Text type="secondary" data-testid="issue-empty"
          style={{ padding: "6px 12px", display: "block", fontSize: 12 }}>
          没有校验问题。break/continue 出循环、缺必填配置等会在这里列出来。
        </Typography.Text>
      ) : (
        <Table<Issue> size="small" rowKey={(r) => r.node_key + "|" + r.code + "|" + r.message}
          dataSource={issues} pagination={false} showHeader={false}
          columns={[
            { key: "sev", width: 32, render: () => <Badge status="error" /> },
            { key: "msg", render: (_, r) => (
              <span data-testid={"issue-row-" + r.code} style={{ fontSize: 12 }}>
                <Typography.Text code style={{ fontSize: 11 }}>{r.node_key || "(无 key)"}</Typography.Text>{" "}
                {r.message}
              </span>) },
            { key: "go", width: 72, render: (_, r) => (
              <Button size="small" type="link" disabled={!r.node_key}
                onClick={() => select(r.node_key)}>定位</Button>) },
          ]}
        />
      )}
    </div>
  );
}
