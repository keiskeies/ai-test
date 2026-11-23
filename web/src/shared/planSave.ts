// 候选方案 → 正式场景（D264）。
// Pilot 给出的 graph 是 §7.4 通用结构，但 meta 工具为了「人话步骤」会给节点补 ref_name；
// 场景图是执行契约，不该把只服务渲染的字段也落库——保存前统一剥掉。
import { sceneApi } from "../api/scene";

/** 深拷贝并递归删掉节点的 ref_name（不动调用方手里的 payload）。 */
export function withoutRefNames(graph: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(graph ?? {})) as Record<string, unknown>;
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      delete n.ref_name;
      walk(n.children);
    }
  };
  walk(clone.nodes);
  return clone;
}

/** 走既有 POST /scenarios：重名 409、图不合法 422、缺 scenario:create 403 都由后端原话回。 */
export async function savePlanAsScenario(
  projectId: string, name: string, graph: unknown,
): Promise<{ id: string; name: string }> {
  // 后面四个是后端 ScenarioCreateIn 的缺省值（priority=P2 / 空变量 / fail_fast /
  // project_public）；schema.d.ts 把它们标成必填，显式带上等价于走服务端缺省。
  const s = await sceneApi.create({
    project_id: projectId, name, step_graph: withoutRefNames(graph),
    priority: "P2", variables: {}, fail_fast: true, project_public: true,
  });
  return { id: s.id, name: s.name };
}
