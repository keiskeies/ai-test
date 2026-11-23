// Pilot 候选只读预览页（1F T4，§9.7 :601 / D33 假设 b）。
// 形状照抄 reportDetail 的只读画布（只读 = store.readOnly + <Canvas>，编辑口子由 store 关死），
// 数据不走后端：payload 经 sessionStorage（键 = run_id + plan_index）从候选卡带过来，
// 刷新可重进；查询串只挂键名，graph 大 URL 也不炸。
// D264 起 [保存为场景] 接真（POST /scenarios）：归属项目随 payload 带过来（新 Tab 读不到
// bench 的本地选择），权限按该项目的 scenario:create 判定；缺位/拿不到项目位就不渲染写钮。
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Space, Typography } from "antd";
import Canvas from "../scene/Canvas";
import { useSceneStore } from "../scene/store";
import { readPreviewEntry } from "../agent/cards/previewLink";
import SavePlanAction from "../shared/SavePlanAction";
import { savePlanAsScenario } from "../shared/planSave";
import { get } from "../api/client";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";

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
  const authProject = useAuth((s) => s.project);
  const authUser = useAuth((s) => s.user);

  // 落库归属 = 候选方案真正所属的项目（bench 的选择随 payload 带过来）。与当前选中的项目
  // 一致时直接用它的 my_perms；不一致就单拉一次项目拿生效位（新 Tab 也可能是从别处打开的）。
  const targetProjectId = entry.kind === "ok" ? entry.projectId : null;
  const [fetchedProject, setFetchedProject] = useState<ProjectOut | null>(null);
  const matchedProject = targetProjectId && authProject?.id === targetProjectId ? authProject : null;
  const permProject = matchedProject ?? fetchedProject;

  useEffect(() => {
    setFetchedProject(null);
    if (!targetProjectId || authProject?.id === targetProjectId) return;
    let alive = true;
    // 拉不到（403/404/断网）就保持 null → 不画保存钮：宁缺，不写错项目
    get<ProjectOut>("/projects/" + encodeURIComponent(targetProjectId), { silent: true })
      .then((p) => { if (alive) setFetchedProject(p); })
      .catch(() => { if (alive) setFetchedProject(null); });
    return () => { alive = false; };
  }, [targetProjectId, authProject]);

  const canSave = !!targetProjectId
    && can(patternsForProject(permProject, authUser?.is_system_admin), "scenario:create");
  // 保存成功 → 横幅翻面：页面上不许一边写「尚未保存」一边摆着「已保存」
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

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
        <Typography.Text strong className="tp-text-md">
          {saved ? "已保存为正式场景" : "Pilot 候选预览（未落库）"}
        </Typography.Text>
        <Typography.Text type="secondary" className="tp-text-sm">
          {saved
            ? `方案「${entry.planName}」已保存为场景「${saved.name}」，本页仍是只读预览。`
            : `方案「${entry.planName}」是 Pilot 给出的候选，尚未保存为场景，仅在此只读预览。`}
        </Typography.Text>
        <Space style={{ marginLeft: "auto" }}>
          {/* D264：保存接真（复用 POST /scenarios，保存前剥掉卡片专用的 ref_name）。
              没有项目归属 / 项目位里没有 scenario:create → onSave 缺省，组件直接不渲染。 */}
          <SavePlanAction
            planName={entry.planName}
            size="middle"
            onSaved={(out) => setSaved(out)}
            onSave={canSave && targetProjectId
              ? (name) => savePlanAsScenario(targetProjectId, name, entry.graph)
              : undefined}
          />
        </Space>
      </div>
      {/* 420 不在阶梯上；432 = 16×27，比取 424 更贴「画布最小可用高」的量级 */}
      <div data-testid="preview-canvas" style={{ flex: 1, minHeight: 432 }}>
        {/* 只读由 store 说了算：loadCardGraph 已置 readOnly:true，Canvas 按它关死拖拽/右键/编辑
            （与 reportDetail 同款——readOnly 走 store 不走 props，这是既有只读画布的成型形状）。 */}
        <Canvas />
      </div>
    </div>
  );
}
