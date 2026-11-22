// 计划列表卡两件事：①§11.4.33 四种状态点的渲染形状；②「同名工具最新结果覆盖」——
// 这是 update_plan_item 的地形（多事件流上画一份活文档），归 fold.ts 的合流层，事件流在此钉死。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PlanListCard from "./PlanListCard";
import { foldPlanListCards, isPlanListResult } from "./fold";
import type { PlanItem } from "./types";
import type { AgentEvent } from "../sse";

// 本仓 vitest 未开 globals → RTL 的自动 afterEach(cleanup) 没挂上（Canvas.test 同款
// 手动口径）。下面新用例一个文件里多次 render，必须先清场再断言。
afterEach(cleanup);

function toolResult(card: Record<string, unknown>, seq: number): AgentEvent {
  return {
    seq, ts: null, type: "TOOL_RESULT",
    payload: { tool_name: "update_plan_item", ok: true, ui: "card", content: { card } },
  };
}

const planCard = (items: unknown[], seqNote = "") => ({
  kind: "generic", form: "plan_list", title: "生成履约回归场景" + seqNote, items,
});

describe("PlanListCard 渲染（§11.4.33）", () => {
  it("四种状态各按各的：done 绿勾无删除线，skipped 灰划掉", () => {
    render(
      <PlanListCard
        title="生成履约回归场景"
        items={[
          { id: 1, text: "盘点履约相关资产", state: "done" },
          { id: 2, text: "生成 2 个候选场景", state: "doing" },
          { id: 3, text: "等待用户抉择与修改", state: "pending" },
          { id: 4, text: "冒烟执行一次", state: "skipped" },
        ]}
      />,
    );
    expect(screen.getByTestId("plan-item-done").textContent).toContain("盘点履约相关资产");
    expect(screen.getByTestId("plan-item-doing").textContent).toContain("生成 2 个候选场景");
    expect(screen.getByTestId("plan-item-pending").textContent).toContain("等待用户抉择与修改");
    const skipped = screen.getByTestId("plan-item-skipped");
    expect(skipped.textContent).toContain("冒烟执行一次");
    expect(skipped.innerHTML).toContain("line-through"); // skipped 灰划
    expect(screen.getByTestId("plan-item-done").innerHTML).not.toContain("line-through");
    expect(screen.getByTestId("plan-list-card").textContent).toContain("2/4"); // done+skipped 记完成
  });
});

describe("同名工具最新结果覆盖（update_plan_item 原地更新口径）", () => {
  it("多条 plan_list TOOL_RESULT 只留最新一份；其它事件顺序不动", () => {
    const events: AgentEvent[] = [
      toolResult(planCard([{ id: 1, text: "盘点资产", state: "doing" }]), 1),
      { seq: 2, ts: null, type: "TEXT", payload: { text: "继续" } },
      toolResult(planCard([{ id: 1, text: "盘点资产", state: "done" }, { id: 2, text: "生成候选", state: "doing" }]), 3),
      { seq: 4, ts: null, type: "TEXT", payload: { text: "又一句" } },
      toolResult(planCard([{ id: 1, text: "盘点资产", state: "done" }, { id: 2, text: "生成候选", state: "done" }]), 5),
    ];
    const folded = foldPlanListCards(events);
    expect(folded.map((e) => e.seq)).toEqual([2, 4, 5]); // 只剩 seq=5 那份计划
    render(<PlanListCard items={[{ id: 1, text: "盘点资产", state: "done" }, { id: 2, text: "生成候选", state: "done" }]} />);
    expect(screen.getByText("生成候选")).toBeTruthy(); // 界面上画的就是最新一份
  });

  it("ok=false 的失败结果不参与覆盖（坏数据不顶掉好计划）；非卡片事件不误伤", () => {
    const bad: AgentEvent = {
      seq: 7, ts: null, type: "TOOL_RESULT",
      payload: { tool_name: "update_plan_item", ok: false, ui: "card", content: { card: planCard([]) } },
    };
    const good = toolResult(planCard([{ id: 1, text: "盘点资产", state: "done" }]), 8);
    expect(isPlanListResult(bad)).toBe(false);
    expect(foldPlanListCards([bad, good]).map((e) => e.seq)).toEqual([7, 8]);
    // 最新一条是坏的那份时，好的保留（坏的不参与「最新」争夺）
    expect(foldPlanListCards([good, bad]).map((e) => e.seq)).toEqual([8, 7]);
  });
});

describe("plan-items 列表本体（plan-items testid 的责任）", () => {
  const UL = () => screen.getByTestId("plan-items");

  it("条数与文本顺序逐一对齐 payload：多条目场景 li 序列=items 序列，状态映射到 plan-item-<state> 与图标/删除线", () => {
    // 提到变量上就要自己标类型：字面量的 state 会宽化成 string，接不住 PlanItemState。
    const items: PlanItem[] = [
      { id: "a", text: "第一步", state: "done" },
      { id: "b", text: "第二步", state: "skipped" },
      { id: "c", text: "第三步", state: "doing" },
      { id: "d", text: "第四步", state: "pending" },
      { id: "e", text: "第五步", state: "pending" },
    ];
    render(<PlanListCard title="五步计划" items={items} />);
    const lis = Array.from(UL().querySelectorAll("li"));
    expect(lis).toHaveLength(items.length);
    // 顺序：文本 span 序列必须与 payload 逐字同序（key 用 id，不许乱序/吞项）
    expect(lis.map((li) => li.querySelectorAll("span")[1].textContent)).toEqual(items.map((it) => it.text));
    // 状态映射：testid 后缀 = state，图标/删除线按 STATE_META（skipped 是唯一划线态）
    expect(lis.map((li) => li.getAttribute("data-testid")))
      .toEqual(["plan-item-done", "plan-item-skipped", "plan-item-doing", "plan-item-pending", "plan-item-pending"]);
    expect(lis[1].innerHTML).toContain("line-through");
    expect(lis[0].innerHTML).not.toContain("line-through");
    expect(lis[2].innerHTML).not.toContain("line-through");
    // 状态图标本体（○/▶/✓）：done=✓、doing=▶、pending/skipped=○
    expect(lis[0].querySelector("span")!.textContent).toBe("✓");
    expect(lis[2].querySelector("span")!.textContent).toBe("▶");
    expect(lis[3].querySelector("span")!.textContent).toBe("○");
    // 计数条：done+skipped 记完成（5 条里 2 条）
    expect(screen.getByTestId("plan-list-card").textContent).toContain("2/5");
  });

  it("空 items：plan-items 仍渲染但零条目，计数 0/0（无 items 的 undefined 也不炸）", () => {
    const { unmount } = render(<PlanListCard items={[]} />);
    expect(UL()).toBeTruthy();
    expect(UL().querySelectorAll("li")).toHaveLength(0);
    expect(screen.getByTestId("plan-list-card").textContent).toContain("0/0");
    unmount();
    // 非数组防御：items 缺失/坏形状按空列表画
    render(<PlanListCard items={undefined as never} />);
    expect(UL().querySelectorAll("li")).toHaveLength(0);
  });

  it("单条目：一条 li、计数 0/1，doing 态不划线", () => {
    render(<PlanListCard items={[{ id: 1, text: "唯一一步", state: "doing" }]} />);
    const lis = Array.from(UL().querySelectorAll("li"));
    expect(lis).toHaveLength(1);
    expect(lis[0].getAttribute("data-testid")).toBe("plan-item-doing");
    expect(lis[0].textContent).toBe("▶唯一一步");
    expect(lis[0].innerHTML).not.toContain("line-through");
    expect(screen.getByTestId("plan-list-card").textContent).toContain("0/1");
  });

  it("未知 state 回落 pending 画法；缺 id 用下标兜底 key（两条缺 id 不互相吞）", () => {
    render(
      <PlanListCard
        items={[
          { text: "没有 id 的甲", state: "doing" },
          { text: "没有 id 的乙", state: "pending" },
          { id: 9, text: "野生状态", state: "blocked" },
        ] as never}
      />,
    );
    const lis = Array.from(UL().querySelectorAll("li"));
    expect(lis).toHaveLength(3); // React key 冲突会吞条目/报 duplicate key，这里数得齐即没吞
    expect(lis[2].getAttribute("data-testid")).toBe("plan-item-blocked"); // testid 跟 payload state 原样走
    expect(lis[2].querySelector("span")!.textContent).toBe("○"); // 但画法回落 STATE_META.pending
    expect(lis[2].innerHTML).not.toContain("line-through");
  });
});
