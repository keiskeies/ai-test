// 「负责人」列的名字解析（UI 用例列表与 1B 场景列表共用；元素库没有这一列）。
// 为什么要有这个文件而不是各页各写一遍 `members[id] ?? id`：兜底那一路是
// **真的会走到**的——系统管理员（`*`）不是项目成员，他在某个项目里新建资产时
// owner_id 就是他，成员表里查不到，于是那一列渲染成 36 位 uuid（1C 真走查量出来的：
// 种子用 bootstrap admin 建演示 UI 用例，UI 用例列表的「负责人」整列是 uuid）。
// uuid 不是给人读的，也说不清这是谁。
// 后端有名字的地方（报告中心的 created_by_name）走的是 join，那是另一条路；
// 列表这一侧只拿得到项目成员表，所以「查不到」必须说人话。
//
// 关键是**别把三种「查不到」混成一种**：还没拿到成员表（加载中）、成员表拉挂了、
// 拿到了但确实没这个人——三句话不一样，混了就会在加载途中把真成员冤枉成
// 「非项目成员」（那比 uuid 更糟）。

export type MemberLookup =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; names: Record<string, string> };

export const MEMBERS_LOADING: MemberLookup = { state: "loading" };
export const MEMBERS_FAILED: MemberLookup = { state: "failed" };
export const membersReady = (names: Record<string, string>): MemberLookup => ({ state: "ready", names });

/**
 * ownerId → 展示文字。四种情形各说各的话：没填负责人 / 拿到了名字 /
 * 名字来源不可用（加载中或拉挂了就别下结论）/ 成员表里确实没有这个人。
 */
export function ownerLabel(ownerId: string | null | undefined, lookup: MemberLookup): string {
  if (!ownerId) return "—";                    // 真的没填负责人（种子的演示场景就是这种）
  if (lookup.state === "loading") return "…";  // 成员表在路上：宁可一个点，也不误判人
  if (lookup.state === "failed") return "名字未取到 " + ownerId.slice(0, 8); // 拉挂了：如实说，并给短 id 供追查
  const named = lookup.names[ownerId];
  if (named) return named;
  // 查不到名字 ≠ 没人负责。说的是「这个人不在本项目成员表里」。
  return "非项目成员 " + ownerId.slice(0, 8);
}
