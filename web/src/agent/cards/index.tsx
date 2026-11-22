// 卡片协议入口：注册内置渲染器 + 统一导出。bench.tsx（或任何宿主页面）import 本模块
// 即完成注册副作用。审批卡/报告摘要卡/设备状态卡后续注册各自 kind 即复用（§9.7 :607）。
import ScenarioPlansCard from "./ScenarioPlansCard";
import QuestionCard from "./QuestionCard";
import PlanListCard from "./PlanListCard";
import OpenPageCard from "./OpenPageCard";
import { registerCard } from "./registry";
import type { CardContext, CardRenderer } from "./registry";
import type { QuestionPayload, OpenPagePayload, PlanListPayload, ScenarioPlansPayload } from "./types";

const renderScenarioPlans: CardRenderer = (p, ctx) => <ScenarioPlansCard payload={p as ScenarioPlansPayload} ctx={ctx} />;
const renderQuestion: CardRenderer = (p, ctx) => <QuestionCard payload={p as QuestionPayload} ctx={ctx} />;
const renderPlanList: CardRenderer = (p) => <PlanListCard items={(p as PlanListPayload).items ?? []} title={(p as PlanListPayload).title} />;
const renderOpenPage: CardRenderer = (p, ctx) => <OpenPageCard payload={p as OpenPagePayload} ctx={ctx} />;

registerCard("scenario_plans", renderScenarioPlans);
registerCard("generic:question", renderQuestion);
registerCard("generic:plan_list", renderPlanList);
registerCard("generic:open_page", renderOpenPage);

export type { CardContext, CardRenderer };
export { registerCard, renderCard, hasCard, clearCardRegistry } from "./registry";
export { isCardPayload, cardRegistryKey, CARD_KINDS } from "./types";
export type { CardPayload, CardKind } from "./types";
