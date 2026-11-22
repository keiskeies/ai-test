// 1C T12（R109）：Ctrl+K 落点映射的纯函数半边——从 CommandPalette.tsx 抽出来。
// 为什么抽：vitest 是 node 环境（无 jsdom），组件渲染测不了，而 goto() 正是
// 「返回 null = Enter 没反应且不报错」的静默失效形状（§13 纪律 1）——它必须由
// 纯测试钉住，而不是指望 e2e 恰好路过。CommandPalette 渲染半边仍住在组件里。
import type { SearchAssetItem } from "../api/search";

export type Kind = "definition" | "case" | "scenario" | "ui_element" | "ui_case" | "adb_case"
  | "schedule" | "notify_channel" | "nav_device";

/** 各组全集（顺序与 CommandPalette 的 GROUPS 一致）；paletteNav.test.ts 逐个钉落点。
 * nav_device 不是搜索 kind——它是本地导航项（设备页没有可搜的后端 kind，D19 也不造），
 * Enter 永远跳设备页。其余成员与后端 SearchAssetsIn.kind 的 pattern 同一集合
 * （1C 五类 → 1D adb_case → 1E schedule/notify_channel，R109 四处同改）。 */
export const PALETTE_KINDS: readonly Kind[] =
  ["definition", "case", "scenario", "ui_element", "ui_case", "adb_case",
    "schedule", "notify_channel", "nav_device"];

export function gotoPalette(kind: Kind, item: SearchAssetItem): string | null {
  // Enter 直达：定义/用例都落接口页详情抽屉（用例带出所属定义并开用例页签，
  // §11.4.19 的「直达详情」对用例的合理落点——用例没有独立页面）；场景进编辑器。
  // 1C T12：元素 → 元素库并用 ?q=<id> 高亮定位（元素库是列表页，没有独立详情）；
  // UI 用例 → 它自己的详情页（比接口用例的落点直接——它有独立页面，R109）。
  // 落点路由在 T13 注册（ui/elements、ui/cases/:id）；goto 映射先行、由纯测试钉住，
  // 就是为了路由注册那天不会出现「搜得到但点不动」。
  // 1D：ADB 用例 → 自己的详情页（与 ui_case 同形，路由已注册）；设备 → 卡片墙。
  // 1E T9（R109）：定时任务 → 定时任务页、渠道 → 通知渠道页。当时两页不读 ?q=<id>，
  // 落点只写到页——不编页面不认的查询串。现在两页都照元素库（uiElements.tsx）的形状
  // 实现了 ?q=<id> 高亮（schedules.tsx / notifyChannels.tsx 消费 searchParams，各有
  // pickDeepLinkHit 纯函数钉测），所以补上 id 让落点直达并标出那一条。
  if (kind === "definition") return "#/api?def=" + item.id;
  if (kind === "case") return "#/api?def=" + (item.definition_id ?? "") + "&tab=case";
  if (kind === "scenario") return "#/scene/" + item.id;
  if (kind === "ui_element") return "#/ui/elements?q=" + item.id;
  if (kind === "ui_case") return "#/ui/cases/" + item.id;
  if (kind === "adb_case") return "#/adb/cases/" + item.id;
  if (kind === "schedule") return "#/schedules?q=" + item.id;
  if (kind === "notify_channel") return "#/notify/channels?q=" + item.id;
  if (kind === "nav_device") return "#/adb/devices";
  // 到达这里 = Kind 联合类型加了成员而忘了加分支——编译期就会在这里报错（never 检查）；
  // 运行时兜底返回 null 而不是瞎跳（null 在组件侧 = 该项 Enter 无动作，纯测试会点名它）。
  return null;
}
