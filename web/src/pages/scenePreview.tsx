// Pilot 候选只读预览页（1F T4，§9.7 :601 / D33 假设 b）。
// 形状照抄 reportDetail 的只读画布（只读 = store.readOnly + <Canvas>，编辑口子由 store 关死），
// 数据不走后端：payload 经 sessionStorage（键 = run_id + plan_index）从候选卡带过来，
// 刷新可重进；查询串只挂键名，graph 大 URL 也不炸。
// 一期边界（§4 :206 draft 表二期、§13 :1604 create_scenario 二期）：
// [保存为正式场景] 恒 disabled + Tooltip「二期开放」——能点但后端不认就是假门。
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, Space, Tooltip, Typography } from "antd";
import Canvas from "../scene/Canvas";
import { useSceneStore } from "../scene/store";
import { readPreviewEntry } from "../agent/cards/previewLink";

/** 三种坏键形状 → 三个人话文案（不白屏、不抛、不装渲染）。 */
function EmptyState({ kind }: { kind: "missing" | "corrupt" | "bad_graph" }) {
  const copy = kind === "missing"
    ? { title: "预览内容不存在", desc: "链接可能已过期（关闭过标签页或清理过浏览器会话数据就会失效），请回到 Pilot 试验台重新点「画布预览」。" }
    : kind === "corrupt"
      ? { title: "预览内容读不出来", desc: "暂存的数据格式不对（可能被其他程序改写过），请回到 Pilot 试验台重新点「画布预览」。" }
      : { title: "预览内容不是可画的场景图", desc: "暂存的数据缺少步骤节点（§7.4 的 nodes 结构），无法在画布上铺开，请回到 Pilot 试验台重新点「画布预览」。" };
  return (
    <div data-testid="preview-empty" style={{ padding: 24 }}>
      <Alert type="warning" showIcon message={copy.title} description={copy.desc} />
    </div>
  );
}

export default function ScenePreviewPage() {
  const [sp] = useSearchParams();
  const key = sp.get("k");
  // 读一次定终身：sessionStorage 里的键在页面生命周期内不会自己变好，
  // 解析失败也不抛（readPreviewEntry 全兜底），坏形状直接渲染空态。
  const entry = useMemo(() => readPreviewEntry(key), [key]);
  const loadCardGraph = useSceneStore((s) => s.loadCardGraph);

  useEffect(() => {
    if (entry.kind === "ok") loadCardGraph(entry.graph);
  }, [entry, loadCardGraph]);

  if (entry.kind !== "ok") {
    return (
      <div data-testid="page-scene-preview">
        <EmptyState kind={entry.kind} />
      </div>
    );
  }

  return (
    <div data-testid="page-scene-preview" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      {/* 顶部说明条：说清「没落库」这件事，预览 ≠ 已有场景 */}
      <div data-testid="preview-banner" style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        padding: "8px 12px", background: "var(--tp-bg-layout)", border: "1px solid var(--tp-split)", borderRadius: 8,
      }}>
        <Typography.Text strong style={{ fontSize: 13 }}>Pilot 候选预览（未落库）</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          方案「{entry.planName}」是 Pilot 给出的候选，尚未保存为场景，仅在此只读预览。
        </Typography.Text>
        <Space style={{ marginLeft: "auto" }}>
          {/* 一期口子不开：§4 :206（scenario_draft 二期）+ §13 :1604（create_scenario 转正二期）。
              span 包一层：disabled 按钮不触发 hover 事件，antd 的 Tooltip 要靠外层拿事件。 */}
          <Tooltip title="二期开放">
            <span style={{ display: "inline-block" }}>
              <Button type="primary" data-testid="preview-save" disabled>保存为正式场景</Button>
            </span>
          </Tooltip>
        </Space>
      </div>
      <div data-testid="preview-canvas" style={{ flex: 1, minHeight: 420 }}>
        {/* 只读由 store 说了算：loadCardGraph 已置 readOnly:true，Canvas 按它关死拖拽/右键/编辑
            （与 reportDetail 同款——readOnly 走 store 不走 props，这是既有只读画布的成型形状）。 */}
        <Canvas />
      </div>
    </div>
  );
}
