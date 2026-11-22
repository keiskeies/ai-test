// 卡片渲染注册表（§9.7 :607：卡片协议是通用件——审批卡/报告摘要卡/设备状态卡日后
// 注册自己的 kind 即复用；**分派只走协议键，绝不按 tool_name 硬编码**）。
import type { ReactNode } from "react";
import type { CardPayload } from "./types";
import { cardRegistryKey } from "./types";

export type CardRenderer = (payload: CardPayload, ctx: CardContext) => ReactNode;

/** 卡片与页面的唯一接缝：操作回写一条用户消息（R149/D32）。
 *  cards/ 目录不认识 fetch/axios——协议组件与页面解耦，页面注入实现。 */
export interface CardContext {
  onUserMessage: (text: string) => void;
  /** 运行中（status==="运行中"）：按钮 disabled + 「等本轮结束」，不排队不吞点击。 */
  busy: boolean;
}

const registry = new Map<string, CardRenderer>();

/** 注册渲染器。key = kind（如 "scenario_plans"）或 generic 的二级键 "generic:<form>"。
 *  同名重复注册允许覆盖：热替换/测试注入用，语义是「后注册的说了算」。 */
export function registerCard(key: string, renderer: CardRenderer): void {
  registry.set(key, renderer);
}

export function hasCard(key: string): boolean {
  return registry.has(key);
}

/** 分派：generic 走 "generic:<form>" 二级键，form 未注册时回落裸 kind，再未注册回 null
 *  （调用方负责「暂不支持的卡片类型」人话兜底——未知形状不装渲染）。 */
export function renderCard(payload: CardPayload, ctx: CardContext): ReactNode {
  const key = cardRegistryKey(payload);
  const r = registry.get(key) ?? (key.includes(":") ? registry.get(payload.kind) : undefined);
  return r ? r(payload, ctx) : null;
}

/** 测试用：清空注册表，保证用例互不串扰。 */
export function clearCardRegistry(): void {
  registry.clear();
}
