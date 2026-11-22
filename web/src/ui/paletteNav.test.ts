// 1C T12（R109）：Ctrl+K 落点映射的纯函数测试（vitest，node 环境——不碰组件）。
//
// 为什么值得单独钉：goto() 返回 null = Enter 没反应且**不报错**，正是 §13 纪律 1
// 要拦的「搜得到但点不动」。组件渲染在 node 环境测不了（无 jsdom，见 vitest.config
// 头注），所以把映射抽成纯函数，在这里把「每组 kind 全有落点、且落点形态正确」钉死。
import { describe, expect, it } from "vitest";
import { gotoPalette, PALETTE_KINDS, type Kind } from "./paletteNav";
import type { SearchAssetItem } from "../api/search";

const item = (over: Partial<SearchAssetItem>): SearchAssetItem => ({
  id: "ID1", name: "n", ...over,
});

describe("gotoPalette：每组 kind 都必须有落点（返回 null = Enter 静默失灵）", () => {
  it("PALETTE_KINDS = 后端搜索 kind 的七员 + 本地导航 nav_device（1E T9 扩 schedule/notify_channel）", () => {
    // 搜索 kind 与 backend SearchAssetsIn.kind 的 pattern 同一集合（R109 四处同改）；
    // nav_device 不是搜索 kind，是设备页的本地导航项（R109 的「设备」组——没有可搜
    // kind，不编一个）。
    expect([...PALETTE_KINDS].sort()).toEqual([
      "adb_case", "case", "definition", "nav_device", "notify_channel", "scenario",
      "schedule", "ui_case", "ui_element",
    ]);
  });

  it("每个 kind 都返回非 null 的 hash 路由（漏一个分支这里就红）", () => {
    for (const kind of PALETTE_KINDS) {
      const to = gotoPalette(kind, item({}));
      expect(to, kind + " 落点不许是 null——Enter 会没反应且不报错").toStrictEqual(expect.any(String));
      expect(to).toMatch(/^#\//);
    }
  });

  it("既有三路落点逐字不变（1B 口径不许被扩组改动）", () => {
    expect(gotoPalette("definition", item({ id: "d9" }))).toBe("#/api?def=d9");
    expect(gotoPalette("case", item({ definition_id: "d9" }))).toBe("#/api?def=d9&tab=case");
    // definition_id 缺失（定义已删）：保持既有形态（空 def 参数），不新增兜底文案
    expect(gotoPalette("case", item({}))).toBe("#/api?def=&tab=case");
    expect(gotoPalette("scenario", item({ id: "s3" }))).toBe("#/scene/s3");
  });

  it("1C 新两路：元素 → 元素库带 ?q=<id> 高亮；UI 用例 → 独立详情页", () => {
    expect(gotoPalette("ui_element", item({ id: "e7" }))).toBe("#/ui/elements?q=e7");
    expect(gotoPalette("ui_case", item({ id: "u7" }))).toBe("#/ui/cases/u7");
  });

  it("1D 新两路：ADB 用例 → 独立详情页；设备 → 卡片墙（本地导航）", () => {
    expect(gotoPalette("adb_case", item({ id: "k7" }))).toBe("#/adb/cases/k7");
    expect(gotoPalette("nav_device", item({}))).toBe("#/adb/devices");
  });

  it("1E T9 新两路（高亮补全后）：定时任务 → 定时任务页带 ?q=<id>；渠道 → 通知渠道页带 ?q=<id>", () => {
    // 两页都实现并消费了 ?q=<id> 高亮（schedules.tsx / notifyChannels.tsx 里的
    // searchParams + pickDeepLinkHit，形状同元素库）——落点带 id 直达并标出那一条。
    expect(gotoPalette("schedule", item({ id: "t7" }))).toBe("#/schedules?q=t7");
    expect(gotoPalette("notify_channel", item({ id: "c7" }))).toBe("#/notify/channels?q=c7");
  });

  it("落点里不许出现没有路由的野路径（前缀必须落在已注册/已规划的九族里）", () => {
    const allowed = ["#/api?", "#/api/", "#/scene/", "#/ui/elements?", "#/ui/cases/",
      "#/adb/cases/", "#/adb/devices", "#/schedules", "#/notify/channels"];
    for (const kind of PALETTE_KINDS) {
      const to = gotoPalette(kind, item({ definition_id: "d" })) as string;
      expect(allowed.some((p) => to.startsWith(p)), to).toBe(true);
    }
  });

  it("TS 侧的 never 兜底：未知 kind 运行时返回 null（不瞎跳）", () => {
    // 编译期 Kind 联合类型挡住漏加的新成员；这条钉的是运行时兜底形状
    expect(gotoPalette("not_a_kind" as Kind, item({}))).toBeNull();
  });
});
