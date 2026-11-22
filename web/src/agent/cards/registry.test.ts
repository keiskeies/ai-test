// 注册表契约：注册/分派（含 generic 的 form 二级键）/未知 kind 兜底返回 null。
// 这里不 import 内置渲染器——注册表本身的契约与具体卡片无关。
import { describe, expect, it, beforeEach } from "vitest";
import { registerCard, renderCard, clearCardRegistry, hasCard } from "./registry";
import { cardRegistryKey, isCardPayload, CARD_KINDS } from "./types";
import type { CardPayload } from "./types";
import type { CardContext } from "./registry";

const ctx: CardContext = { onUserMessage: () => undefined, busy: false };

beforeEach(() => clearCardRegistry());

describe("registerCard / renderCard 分派", () => {
  it("按 kind 注册并按 kind 分派", () => {
    registerCard("scenario_plans", (p) => "rendered:" + p.kind);
    expect(renderCard({ kind: "scenario_plans" } as CardPayload, ctx)).toBe("rendered:scenario_plans");
  });

  it("generic 走 kind:form 二级键；form 未注册回落裸 kind；都未注册回 null", () => {
    registerCard("generic:question", () => "q");
    registerCard("generic", () => "generic-fallback");
    expect(renderCard({ kind: "generic", form: "question" } as CardPayload, ctx)).toBe("q");
    expect(renderCard({ kind: "generic", form: "nope" } as CardPayload, ctx)).toBe("generic-fallback");
    clearCardRegistry();
    expect(renderCard({ kind: "generic", form: "question" } as CardPayload, ctx)).toBeNull();
  });

  it("未知 kind（未注册）返回 null——兜底人话归渲染层，注册表不装渲染", () => {
    expect(renderCard({ kind: "report_summary" } as CardPayload, ctx)).toBeNull();
    expect(hasCard("report_summary")).toBe(false);
  });

  it("后注册覆盖先注册（热替换语义）", () => {
    registerCard("device_status", () => "old");
    registerCard("device_status", () => "new");
    expect(renderCard({ kind: "device_status" } as CardPayload, ctx)).toBe("new");
  });
});

describe("协议常量与窄化", () => {
  it("kind 值域与 §12.2 :1570 逐字对齐（与后端 CARD_KINDS 单测同尺）", () => {
    expect([...CARD_KINDS].sort()).toEqual(["device_status", "generic", "report_summary", "scenario_plans"]);
  });

  it("cardRegistryKey：generic 带 form 走二级键，其余走裸 kind", () => {
    expect(cardRegistryKey({ kind: "generic", form: "question" })).toBe("generic:question");
    expect(cardRegistryKey({ kind: "generic" })).toBe("generic");
    expect(cardRegistryKey({ kind: "scenario_plans" })).toBe("scenario_plans");
  });

  it("isCardPayload 拒未知 kind / 非对象", () => {
    expect(isCardPayload({ kind: "scenario_plans" })).toBe(true);
    expect(isCardPayload({ kind: "hacker" })).toBe(false);
    expect(isCardPayload(null)).toBe(false);
    expect(isCardPayload("card")).toBe(false);
  });
});
