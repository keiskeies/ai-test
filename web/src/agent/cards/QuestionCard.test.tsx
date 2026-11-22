// ask_user 卡：点选项 → onUserMessage 收到含选项文本的回写（R149/D32 不挂起）。
// 与 ScenarioPlansCard.test 同纪律：走 renderCard 协议分派，不直连组件。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "./index";
import { renderCard } from "./registry";
import type { CardPayload } from "./types";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// T2 形状：ask_user → {ui:"card", card:{kind:"generic", form:"question", ...}}
const PAYLOAD = {
  kind: "generic",
  form: "question",
  question: "要覆盖哪个环境的登录？",
  options: ["演示环境", "测试环境", "自定义"],
} as unknown as CardPayload;

beforeEach(cleanup);

describe("QuestionCard", () => {
  it("问题与选项全部渲染", () => {
    render(<div>{renderCard(PAYLOAD, { onUserMessage: () => undefined, busy: false })}</div>);
    expect(screen.getByTestId("question-card")).toBeTruthy();
    expect(screen.getByText(/要覆盖哪个环境的登录？/)).toBeTruthy();
    expect(screen.getAllByTestId("question-option")).toHaveLength(3);
  });

  it("点选项 → 回写含选项文本的用户消息", () => {
    const onUserMessage = vi.fn();
    render(<div>{renderCard(PAYLOAD, { onUserMessage, busy: false })}</div>);
    fireEvent.click(screen.getAllByTestId("question-option")[1]);
    expect(onUserMessage).toHaveBeenCalledTimes(1);
    expect(onUserMessage.mock.calls[0][0]).toContain("测试环境");
  });

  it("运行中：选项 disabled + 「等本轮结束」", () => {
    render(<div>{renderCard(PAYLOAD, { onUserMessage: () => undefined, busy: true })}</div>);
    for (const b of screen.getAllByTestId("question-option")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText("等本轮结束")).toBeTruthy();
  });
});
