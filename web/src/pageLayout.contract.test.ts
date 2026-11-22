// 列表页「外壳」的源码契约。同 fillHeight.contract.test.ts：jsdom 没有布局引擎，
// 外壳少一层 class、工具条没钉住、页码块重复——测试全绿而用户看到的还是
// 「1 行表 + 半屏空白」。这一轮批量改造（11 个列表页）真的暴露了两类静默错：
// 同排行开标签漏 `>`（JSX 语法错，只有 tsc 抓得到）与旧页码行没删净（页码渲染两遍，
// tsc 与既有断言都不报错）。所以把「每页恰好一个页码行」这类不变量钉在源码文本上。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGES = join(dirname(fileURLToPath(import.meta.url)), "pages");
const src = (name: string): string => {
  try {
    return readFileSync(join(PAGES, name), "utf8");
  } catch {
    throw new Error("读不到 " + name + "（版式契约不能跳过）");
  }
};

/** 主从页：左右各一张吃满列高的面板卡，筛选条/表/页码三段都住进右卡卡体。 */
const MASTER_DETAIL: Array<[string, string]> = [
  ["api.tsx", "page-api"],
  ["scenes.tsx", "page-scene"],
  ["uiElements.tsx", "page-ui-elements"],
];

/** 单表页：表卡自己就是正文，工具条用裸的 flex:0 0 auto 块钉在卡外。 */
const SINGLE_TABLE: Array<[string, string]> = [
  ["uiCases.tsx", "page-ui-cases"],
  ["adbCases.tsx", "page-adb-cases"],
  ["plans.tsx", "page-plans"],
  ["schedules.tsx", "page-schedules"],
  ["notifyChannels.tsx", "page-notify-channels"],
  ["reports.tsx", "page-reports"],
  ["runs.tsx", "page-runs"],
  ["adbDevices.tsx", "page-adb-devices"],
];

const ALL = [...MASTER_DETAIL, ...SINGLE_TABLE];

const GRID_ROW = 'gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)"';

/** 表卡卡底脚注的容器：.tp-cardfoot（脚注+页码同排）或 .tp-cardfoot--center（只有页码）。 */
const CARD_FOOT = 'className="tp-cardfoot"';
const CARD_FOOT_CENTER = 'className="tp-cardfoot--center"';

/**
 * 页码所在那一格的开标签。
 * 口径变更（业主点名「页面下面的小字」）：脚注与页码曾是表卡的**兄弟节点**，画在页面底色上——
 * 卡有边有角，它没有，读起来像掉在卡外的批注。现在它们走 AdminTable 的 cardFooter
 * （= antd Table 的 footer），DOM 落在 .ant-table 里、天然继承卡底色与圆角裁切。
 * 于是这一轮不再断言「页面级行容器带 flex/padding」，改断言「页码住在卡内脚注格里」。
 */
function pagerRowOpener(s: string): string {
  const lines = s.split("\n");
  const i = lines.findIndex((l) => l.includes("<ListPager"));
  expect(i, "找不到 ListPager：这一页的页码块整块没了").toBeGreaterThan(-1);
  for (let j = i - 1; j >= 0; j -= 1) {
    const l = lines[j];
    if (l.includes(CARD_FOOT) || l.includes(CARD_FOOT_CENTER)) return l;
  }
  throw new Error("ListPager 上面找不到卡内脚注容器（脚注又掉回卡外了）");
}

describe("列表页外壳：满高、单行页头、页码只画一次", () => {
  it.each(ALL)("%s 的页壳齐了（stack 容器 + 满高正文 + desc 折进页头）", (file, testId) => {
    const s = src(file);
    expect(s, "页根没挂 .tp-fill-stack：正文拿不到视口高度").toContain(
      'data-testid="' + testId + '" className="tp-fill-stack"');
    expect(s, "页头 desc 没折进标题行：页头多占一行，正文就少一行").toContain(" descHover");
  });

  it.each(MASTER_DETAIL)("%s 的两栏是同一种容器（等高的面板卡）", (file) => {
    const s = src(file);
    expect(s, "工作台根缺 .tp-fill：.tp-fill-stack > .tp-fill 的 grow 不生效").toContain('className="tp-fill"');
    expect(s, "侧栏列宽不足 288：树节点会折行").toContain('flex="288px" className="tp-fill-side"');
    expect(s, "两栏不同 class：底边对不齐（被点名的版式缺陷）").toContain(
      'className="tp-fill-body tp-fill-side"');
    expect(s, "面板里的表还带自己的边框：一个面板两层框").toContain('className="tp-inpanel"');
    expect(s, "筛选条没钉在卡体顶部：会跟表抢剩余高度").toContain(
      '<div style={{ padding: "12px 12px 0", flex: "0 0 auto" }}>');
  });

  it.each(SINGLE_TABLE)("%s 的工具条钉在卡外（表才吃剩余高度）", (file) => {
    expect(src(file), "表格卡之外的内容没钉住：会跟表抢剩余高度").toContain(
      '<div style={{ flex: "0 0 auto" }}>');
  });

  it("表格外的包装层必须也是 flex，否则满高链在包装层断掉", () => {
    // plans / schedules 的表包在 <div data-testid="*-table"> 里。包装层是 display:block
    // 时 .tp-tablecard{flex:1 1 auto} 完全失效，卡停在内容高 = 表下方又空一片。
    for (const testId of ["plans-table", "schedules-table"]) {
      const file = testId === "plans-table" ? "plans.tsx" : "schedules.tsx";
      expect(src(file), testId + " 包装层缺 .tp-fill-body").toContain(
        'data-testid="' + testId + '" className="tp-fill-body"');
    }
  });

  it("每页恰好一个页码行，且不再用页面级 margin 垫高", () => {
    for (const [file] of ALL) {
      const s = src(file);
      expect((s.match(/<ListPager/g) ?? []).length,
        file + " 的页码块应为 1（重复块 = 页码画两遍，没有测试会红）").toBe(1);
      expect(s, file + " 还在用旧的「居中 + marginTop: 12」页码行").not.toContain(
        'justifyContent: "center", marginTop: 12');
      // 被点名的缺陷本体：脚注/页码曾是表卡的兄弟节点，画在页面底色上。
      expect(s, file + " 的页码又回到页面级 padding 行（小字掉在卡外）").not.toContain(
        'padding: "12px 0 0"');
    }
  });

  it("页码住在卡内脚注格里（不在页面底色上）", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    // antd Table 的 footer 默认带 tableFooterBg（汇总行灰底），会把卡内劈成两种底色。
    expect(css, "卡内脚注缺样式：footer 会顶着 antd 的灰底画在卡里")
      .toContain(".tp-tablecard .ant-table-wrapper .ant-table-footer {");
    expect(css, "卡内脚注没压掉 antd 灰底").toContain("background: transparent;");
    for (const [file] of SINGLE_TABLE) {
      const s = src(file);
      expect(pagerRowOpener(s), file + " 的页码没住进卡内脚注格（被点名的版式缺陷）")
        .toContain("tp-cardfoot");
    }
    // 只有表卡家族能走 cardFooter；设备墙没有 AdminTable，改为自垫同壳卡底条。
    expect(src("adbDevices.tsx"), "设备墙的卡底条没穿表卡同一套外壳")
      .toContain('className="tp-card tp-cardfoot-strip"');
    // 首屏未到货时脚注为空、ListPager 也不渲染：整条要跟着撤掉，否则页面底部闪一条空卡底条。
    expect(src("adbDevices.tsx"), "设备墙的卡底条没有空态闸：首屏会闪一条空壳")
      .toContain("(loadError !== null || shownRecycled || total !== null) && (");
    expect(css, ".tp-cardfoot-strip 缺定义：卡底条会没有内边距").toContain(".tp-cardfoot-strip {");
  });

  it("脚注与页码同排：脚注在左格、页码恒居中", () => {
    for (const [file] of ALL) {
      const s = src(file);
      // 主从页的脚注在面板卡体内（不是 AdminTable 卡底），三列 grid 留在页内，口径不变。
      const inCard = s.includes(CARD_FOOT) || s.includes(CARD_FOOT_CENTER);
      if (!inCard) {
        const opener = (() => {
          const lines = s.split("\n");
          const i = lines.findIndex((l) => l.includes(GRID_ROW));
          expect(i, file + " 既没有卡内脚注格，也没有三列同排行").toBeGreaterThan(-1);
          return lines[i].trimEnd().endsWith("}}>") ? lines[i] : lines[i] + lines[i + 1];
        })();
        expect(opener, file + " 的同排行不是三列 grid").toContain(GRID_ROW);
        expect(opener, file + " 的同排行开标签没闭合（缺 `>`，JSX 会把脚注当属性吃）").toContain("}}>");
      }
      const lines = s.split("\n");
      const i = lines.findIndex((l) => l.includes("<ListPager"));
      const grid = lines.findIndex((l) => l.includes(GRID_ROW));
      const foot = lines.findIndex((l) => l.includes(CARD_FOOT) || l.includes(CARD_FOOT_CENTER));
      const head = grid >= 0 && grid < i ? grid : foot;
      expect(head, file + " 找不到脚注格起点").toBeGreaterThan(-1);
      const j = lines.findIndex((l, k) => k > head && l.trim() === "<ListPager");
      const between = lines.slice(head + 1, j).join("\n");
      if (between.includes("<Typography.Text")) {
        expect(between, file + " 的脚注没排在页码之前（左格）").toContain("<Typography.Text");
        const cls = between.match(/<Typography\.Text[^>]*className="([^"]*)"/)?.[1] ?? "";
        const ok = inCard ? cls.includes("tp-cardfoot-note") : between.includes("minWidth: 0");
        expect(ok, file + " 的脚注格没放开 min-width：长文案会把页码挤走").toBe(true);
      }
    }
  });
});

describe("无页码的两页（数据集 / 系统设置）：同样要填满视口", () => {
  // 这两页进不了上面的两组：pagerRowOpener 假定每页都有 <ListPager>，而它们没有页码行。
  it("页根齐了（stack 容器 + desc 折进页头）", () => {
    for (const testId of ["page-datasets", "page-settings"]) {
      const file = testId === "page-datasets" ? "datasets.tsx" : "settings.tsx";
      const s = src(file);
      expect(s, file + " 页根没挂 .tp-fill-stack").toContain(
        'data-testid="' + testId + '" className="tp-fill-stack"');
      expect(s, file + " 页头 desc 没折进标题行").toContain(" descHover");
    }
  });

  it("数据集的左右两栏是同一种容器（等高的面板卡）", () => {
    const s = src("datasets.tsx");
    expect(s, "分栏 Row 没吃满高度：卡片只会停在内容高，右侧留一大片空白")
      .toContain('style={{ flex: "1 1 auto", minHeight: 0 }}');
    expect(s, "两栏不同 class：底边对不齐（被点名的版式缺陷）")
      .toContain('className="tp-fill-body tp-fill-side"');
    expect(s, "列表还在用裸表：面板里没有卡壳，边框与右卡不成一套")
      .toContain('className="tp-inpanel"');
    expect(s, "工具条没钉在卡体顶部：会跟表抢剩余高度")
      .toContain('<div style={{ padding: "12px 12px 0", flex: "0 0 auto" }}>');
  });

  it("设置页正文必须同时挂 .tp-fill：只写 .tp-fill-body 会被 stack 拍回内容高", () => {
    // styles.css 的 .tp-fill-stack > *{flex:0 0 auto} 与 .tp-fill-body 同特异性且在后面，
    // 只挂 .tp-fill-body 的正文会停在内容高（实测 tabs 276 vs 应有 739），整页下方空一片。
    expect(src("settings.tsx"), "settings-body 缺 .tp-fill：正文卡在内容高")
      .toContain('data-testid="settings-body" className="tp-fill tp-fill-body"');
  });

  it("Tabs 的满高链三层都得到 flex，五个 Tab 根都挂 .tp-fill-tab", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    // content-holder 与 -active 面板缺任一层，链就断在 display:block 上（antd 默认）。
    for (const sel of [
      ".tp-fill-body .ant-tabs {",
      ".tp-fill-body .ant-tabs-content-holder {",
      ".tp-fill-body .ant-tabs-content-holder .ant-tabs-tabpane-active {",
    ]) {
      expect(css, "Tabs 满高链缺规则：" + sel).toContain(sel);
    }
    // 只给 -active 定高：若给所有 tabpane 定高，特异性与 antd 的
    // .ant-tabs-tabpane-hidden{display:none} 打平，未选中面板会跟着露出来。
    expect(css, "规则不该打在非 -active 的 tabpane 上").not.toContain(
      ".ant-tabs-content-holder .ant-tabs-tabpane {");
    for (const name of ["MembersTab", "UsersTab", "AuditTab", "ModelTab", "RolesTab"]) {
      const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "settings", name + ".tsx"), "utf8");
      expect(s, name + " 根缺 .tp-fill-tab：Tab 内容拿不到面板高度").toContain('className="tp-fill-tab"');
    }
  });
});

describe("卡体内的脚注（详情页）：与列表页同一排", () => {
  // 详情页的表住在 Card 里，卡底脚注没有「跳到页面底色上」的病，
  // 但曾是「居中页码一行 + 脚注另起一行」：卡体里多花一行，两句话拉成两段。
  // 现在与列表页共用 .tp-cardfoot（脚注左格、页码居中）。
  const DETAIL = ["planDetail.tsx", "planReportDetail.tsx"];
  it("详情页卡体不再用「居中页码 + 脚注另起一行」", () => {
    for (const file of DETAIL) {
      const s = src(file);
      expect(s, file + " 还在用旧的两行排法（卡体多浪费一行）")
        .not.toContain('justifyContent: "center", marginTop: 8');
      expect(s, file + " 的脚注没接进卡内脚注格").toContain(CARD_FOOT);
      expect((s.match(/<ListPager/g) ?? []).length, file + " 页码块数不对")
        .toBeGreaterThan(0);
      expect(s, file + " 脚注缺 min-width：长文案会把页码挤走")
        .toContain("tp-cardfoot-note");
    }
  });
});

describe("版式改造不许动诚实口径", () => {
  it("脚注里的失败声明仍然逐字在场", () => {
    const honest: Array<[string, string]> = [
      ["uiCases.tsx", '{loadError ? "本次列表加载失败，本行计数不作数" : ""}'],
      ["adbCases.tsx", '{loadError ? "本次列表加载失败，本行计数不作数" : ""}'],
      ["scenes.tsx", '{loadError ? "本次列表加载失败，本行计数不作数" : ""}'],
      ["api.tsx", '{loadError ? "本次列表加载失败，本行计数不作数" : ""}'],
      ["adbDevices.tsx", '"本次设备列表加载失败，本行计数不作数"'],
      ["adbCases.tsx", "「任一空闲」= 执行时锁第一台未被占用（未回收且启用）的设备，心跳离线不剔除它"],
      ["notifyChannels.tsx", "渠道是平台级配置（全项目共用，无项目归属）；密钥列显示的是后端打码回显，前端不加工。"],
      ["workbench.tsx", "统计未加载（本次请求失败）——以上「-」表示没取到，不是 0"],
      ["plans.tsx", "（空计划「全部通过」是空真，列表端点压根没给这个数，这里就不编）。"],
      ["uiCases.tsx", "「最近结果」只记正式执行（调试是过程，不回写结论）"],
    ];
    for (const [file, sentence] of honest) {
      expect(src(file), file + " 丢了这句真话：" + sentence).toContain(sentence);
    }
  });
});
