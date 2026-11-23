// antd ConfigProvider 主题工厂（浅/深各一套；同形由类型钉住）。
//
// 为什么是函数而不是两份常量：antd 的 token 名与我们的 tp.* 不是一一对应（它有
// colorBgElevated / colorFillSecondary 这些我们没造的语义），映射逻辑写两遍就会
// 出现「深色下某处还是浅色」。工厂里只写一次映射，取 tokensFor(mode) 供值。
//
// 这里刻意**不**用 antd 的 darkAlgorithm：算法会自己推导一整套色，结果是我们的
// 青竹绿与卡片层次被它改写，而设计文档 §11.6 的口径是「深色只换映射不改名」。
// 全量显式映射的代价是组件 token 要手写，收益是深浅两套每一处都可解释。
import { createElement, useEffect, useMemo, type ReactNode } from "react";
import { App as AntApp, ConfigProvider, type ThemeConfig } from "antd";
import { metrics, tokensFor } from "../theme";
import type { ThemeMode } from "./themeMode";

/**
 * 把当前主题灌进 antd 的「全局槽」——静态方法的唯一供色处。
 *
 * 为什么必须有这一步：`Modal.confirm`（13 处）与 `message.*`（159 处，含 `api/client.ts`
 * 的统一报错）不在 React 树里渲染，它们把弹窗挂进自己 `document.createDocumentFragment()`
 * 现造的一棵 `<ConfigProvider>`，theme 只认 `globalConfig()` 那份（config-provider/index.js:136，
 * confirm.js:95/101、message/index.js:76/85 同一个槽）。树根的 provider 只管树内，所以
 * 2026-11-22 前深色主题下确认框照旧渲染 antd 默认浅色，实测「元素放入回收站？」两个按钮
 * 前景==底色、对比度 1:1（字看不见）。
 *
 * `holderRender` 补的是同一件事的另一半：静态方法也需要一个 `<App>` 当 holder 容器，
 * 缺了它 antd 自己在 dev 里就 warnContext（message/index.js:199），且弹层拿不到
 * App 上下文的组件默认值。
 */
export function syncGlobalTheme(theme: ThemeConfig): void {
  ConfigProvider.config({ theme, holderRender: (children: ReactNode) => createElement(AntApp, null, children) });
}

/**
 * App 的主题接线：一份 ThemeConfig 同时喂树内（返回给 `<ConfigProvider theme>`）
 * 与树外（灌全局槽）。放在一起是因为这两处**必须同源**——分头取色就是
 * 「页面是深色、弹框是浅色」。theme 用 useMemo 稳定，切换主题才会重灌一次。
 */
export function useAntdTheme(mode: ThemeMode): ThemeConfig {
  const theme = useMemo(() => antdThemeFor(mode), [mode]);
  useEffect(() => {
    syncGlobalTheme(theme);
  }, [theme]);
  return theme;
}

/** 把 hex 折成同相半透明：只换 α 不改色值，改 tp.func 不必回头改这里。 */
function tint(base: string, a: number): string {
  const n = parseInt(base.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 把 hex 折成半透明填充：antd 的中性填充族本来是 rgba(colorTextBase, α)，这里只换相不换 α。 */
function alphaFills(base: string): Record<string, string> {
  // α 沿用 antd 默认档（.15/.06/.04/.02）——深浅只换相、不改强度，两套的手感才一致。
  return {
    colorFill: tint(base, 0.15),
    colorFillContent: tint(base, 0.15),
    colorFillContentHover: tint(base, 0.25),
    colorBgTextActive: tint(base, 0.15),
  };
}

/**
 * 深色语义底一族：antd 的 *Bg/*Border 由 func 色的**浅色色板**反推（colorErrorBg
 * = #FFF3F0、colorWarningBg = #FFFBE6、colorErrorBorder = #FFF2F0），深色下近白正文
 * 压浅粉底 1.11:1，而 danger 图标的悬停底正是它——2026-11-22 全站 CSSOM
 * 扫描出 7 处 ant-btn-color-dangerous 悬停底 = rgb(255,242,240)，本仓库有 8 处这种按钮。
 * α 沿用浅色那套的层级（底 .14 = tp.func.*Bg 既有口径，悬停/按下递增，描边最实）。
 * 「浅色下是对的」这句先前写在这里，同日已作废：浅色同样要接管，见 semanticLight。
 */
function semanticDark(prefix: string, base: string): Record<string, string> {
  return {
    [`${prefix}Bg`]: tint(base, 0.14),
    [`${prefix}BgHover`]: tint(base, 0.2),
    [`${prefix}BgActive`]: tint(base, 0.26),
    [`${prefix}BgFilledHover`]: tint(base, 0.2),
    [`${prefix}Border`]: tint(base, 0.42),
    [`${prefix}BorderHover`]: tint(base, 0.6),
  };
}

/**
 * 浅色语义底一族。理由与深色同源但要单独写：**浅色也不是对的**。
 * antd 的 *Bg/*Border 由 colorXxx 的色板 index 0/1/2 反推，那套是为 antd 自己的
 * 亮色基色（#FF4D4F/#FAAD14/#52C41A）调的；本仓库的 func 色按 WCAG 加深过
 * （#B03A33/#9A6404/#1D7257），同一个 index 0 推出来就是灰泥色：
 * 2026-11-22 实测 colorWarningBg=#d9d4c3、colorSuccessBg=#a8b3ad、colorErrorBg=#f0e4e1
 * ——既不是 §11.6 认可的浅底（#FDF4E3/#EAF6F1/#FBEBEA），也带着绿相/灰相的脏感。
 * 代价分两块，都量过：Alert 的图标（alert/style 只把 colorXxx 用在 icon 上，
 * 正文是 colorText）压 warning 脏底 **3.37:1**，换 §11.6 浅底是 4.58；
 * 正文本身没坏（colorText 压脏底 10.04、压认可浅底 13.64），别把这条读成「字看不见」。
 * 底用 tp.func.*Bg，悬停/按下用同相 α 递增，α 上限按「危险文本按钮悬停时字仍 ≥4.5」
 * 反解（error 文字在 .14 底上是 5.55）。描边给实色 α：脏底自带的边只有 1.48。
 */
function semanticLight(prefix: string, base: string, pale: string): Record<string, string> {
  return {
    [`${prefix}Bg`]: pale,
    [`${prefix}BgHover`]: tint(base, 0.1),
    [`${prefix}BgActive`]: tint(base, 0.14),
    [`${prefix}BgFilledHover`]: tint(base, 0.1),
    [`${prefix}Border`]: tint(base, 0.25),
    [`${prefix}BorderHover`]: tint(base, 0.35),
  };
}

export function antdThemeFor(mode: ThemeMode): ThemeConfig {
  const t = tokensFor(mode);
  const dark = mode === "dark";
  return {
    token: {
      colorPrimary: dark ? t.primary[400] : t.primary[600],
      colorInfo: t.func.processing,
      colorSuccess: t.func.success,
      colorWarning: t.func.warning,
      // 链接走品牌色：antd 默认 colorLink = colorInfo（蓝图里是 processing 蓝），
      // 浅底上 3.35:1 不达标；改为主色 600（5.4:1）/ 深色 300。
      // 悬停/按下必须**沿对比度方向**走，不能沿梯度序号走：浅色底上越浅越糊
      // （旧值 hover=primary[500] 在选中底 2.82:1），深色底上越深越糊
      // （primary 梯度深色反向后 [200] 是底相绿，旧值 hover/active=primary[200] = 1.78:1，
      // 链接一悬停就消失）。梯度两套各自反向，所以「更强调」在两套里都取 700——
      // 浅色 175A45（8.12:1）、深色 8ADBB9（10.57:1）；按下再收一档。
      colorLink: dark ? t.primary[300] : t.primary[600],
      colorLinkHover: t.primary[700],
      colorLinkActive: dark ? t.primary[400] : t.primary[800],
      // info 蓝在这里是**前景**角色（Modal 确认图标、message/notification 的 info 图标、
      // Badge、Result），不是 func.processing 那个「运行中」身份色——后者被 styles.css
      // 的呼吸光环与 drift 测试钉死，不能为了对比度挪动。取 tag.blue.fg（同相深一档，
      // 六面最差 4.77）：默认 antd 由 processing 推的 infoText=#4c86e8 只有 3.22。
      colorInfoText: t.tag.blue.fg,
      // 悬停态字色整族钉死。不钉就往浅走：errorTextHover=#bd5e55（选中底 3.87）、
      // warningTextHover=#a6791f（3.53）、infoTextHover=#78aaf5（2.14）——浅底上一悬停就糊。
      // 画在 8 处 type="text" + 3 处 type="link" 主色按钮、5 处 Typography type="danger"
      // 与 antd 的 outlined/danger 按钮上；*Hover（非 Text）同源，它兼任实心按钮的按下底，
      // 越深白字越清楚（errorHover 白字 6.89），两个用途同方向。
      // success 的悬停就是主色梯度 700（浅 7.33 / 深 10.57），两套都不必另取值。
      colorPrimaryTextHover: t.primary[700],
      colorSuccessTextHover: t.primary[700],
      colorSuccessHover: t.primary[700],
      colorPrimaryHover: dark ? t.primary[300] : t.primary[700],
      colorErrorHover: t.func.errorHover,
      colorErrorTextHover: t.func.errorHover,
      colorWarningHover: t.func.warningHover,
      colorWarningTextHover: t.func.warningHover,
      colorInfoHover: t.func.infoHover,
      colorInfoTextHover: t.func.infoHover,
      // 错误红以 tp.func.error 为单一真相（浅色 #B03A33 白底 5.2:1 / 深色 #F08B84）。
      // 曾在浅色另抄 #C0483F——两处红迟早分叉，改回只从 token 取。
      colorError: t.func.error,
      colorText: t.text[1],
      // 标题/描述/占位符是三个独立 token；只设 colorText 不够——PageHeader 标题、
      // Typography secondary、输入占位都各吃各的，默认值在深色下会留下黑字。
      colorTextHeading: t.text[1],
      colorTextSecondary: t.text[2],
      colorTextTertiary: t.text[3],
      colorTextDescription: t.text[2],
      colorTextPlaceholder: t.text[3],
      colorTextQuaternary: t.text[4],
      // 禁用态文字用 text[3] 而不是 text[4]：侧栏「未开放（计划二期）」那类说明承载的是
      // 诚实口径，读不到等于没写。text[4] 实测白底 1.94:1、深底 2.84:1，两套都不达标；
      // text[3] 是 5.05 / 5.90。禁用感由整行的 opacity 与光标给（shell.tsx 走 antd disabled），不靠把字调淡。
      colorTextDisabled: t.text[3],
      colorBorder: t.border,
      colorBorderSecondary: t.split,
      colorBgLayout: t.bg.layout,
      colorBgContainer: t.bg.container,
      colorBgElevated: t.bg.elevated,
      colorFillSecondary: t.bg.hover,
      colorFillTertiary: t.bg.hover,
      colorFillQuaternary: t.bg.layout,
      // 主色浅底必须自己给：antd 从 colorPrimary 反推 colorPrimaryBg，不用 darkAlgorithm
      // （见文件头）它就按浅色色板推，于是两套都错——深色推出浅米绿压在近白正文上只有
      // 1.05:1（2026-11-22 实测：元素库模块树选中行整块发亮、字看不见）；浅色推出灰绿，
      // 与 bg.selected 这个设计选中底根本不同色相。它画在 Tree/Table 选中行、Dropdown
      // 选中项与 primary filled 按钮上，不是深色专属毛病。取 bg.selected 而不是 primary[50]：
      // 选中底是「底色语义」，设计文档把它单列在 bg 组、两套各自定值；primary 组是色相标尺。
      colorPrimaryBg: t.bg.selected,
      // colorPrimaryBgHover / colorPrimaryBorder 由主色梯度 index 2/3/4 直接取（genColorMapToken），
      // 梯度不反向就会推出近白色：2026-11-22 实测深色 colorPrimaryBgHover=#d8e6df，而
      // controlItemBgActiveHover（选中行上的 hover）就等于它——鼠标一移到选中行立刻变浅底、字看不见。
      // 同一族还画在 DatePicker 面板、Upload dragger 与 Slider 轨道上。
      colorPrimaryBgHover: t.primary[100],
      colorPrimaryBorder: t.primary[200],
      colorPrimaryBorderHover: t.primary[300],
      // 中性填充来自 colorTextBase（恒 #000，不用 darkAlgorithm 就不会翻相）：rgba(0,0,0,.15)
      // 压深底等于「更黑」，Empty 插图描边、Table 列头分隔、watermark 全成黑洞。
      // 拿 text[3]（两套里都是中弱前景）当 alpha 基底，相才跟 tp 一致。
      ...alphaFills(t.text[3]),
      // 语义底/描边整族接管：两套都得给，只是理由不同（浅色见 semanticLight、深色见 semanticDark）。
      // 底取 tp.func.*Bg——§11.6 已经 sanction 过的那份浅底，不是 antd 反推的灰泥色。
      ...(dark
        ? {
            ...semanticDark("colorError", t.func.error),
            ...semanticDark("colorSuccess", t.func.success),
            ...semanticDark("colorWarning", t.func.warning),
            ...semanticDark("colorInfo", t.func.processing),
          }
        : {
            ...semanticLight("colorError", t.func.error, t.func.errorBg),
            ...semanticLight("colorSuccess", t.func.success, t.func.successBg),
            ...semanticLight("colorWarning", t.func.warning, t.func.warningBg),
            ...semanticLight("colorInfo", t.func.processing, t.func.processingBg),
          }),
      // 派生链的根：colorBgBase/colorTextBase 在浅色主题下就是默认值，写死等于在浅色重复一遍
      // 已有口径（手抄棘轮会计数），所以只在深色覆盖。colorBgBase 是原生滚动条与表单控件底的源头，
      // 深色留 #fff 会让滚动条在深面板上留一条白带。
      ...(dark
        ? {
            colorBgBase: t.bg.container,
            colorTextBase: t.text[1],
            // 实心（variant="solid" / 未来 primary）按钮的底：默认按 colorTextBase 推 = 纯黑，
            // 且 antd 用「底够不够亮」决定字色（isBright→#000），深底就给白字 → 黑底黑字。
            // 直接钉成主色 + 深字，与下面 Button.primaryColor 同一套口径。
            colorBgSolid: t.primary[400],
            colorBgSolidHover: t.primary[300],
            colorBgSolidActive: t.primary[500],
            colorBgSpotlight: t.bg.elevated,
            // 语义底/描边一族在上面的两套分支里已经给过了，这里不重复。
            // 按下态字色同样由浅色梯度反推（#3A8C72 / #C96865 / #6184CF 在深底
            // 3.75 / 4.09 / 4.13），深色要往亮走；浅色方向相反，见上面注释。
            // primary/success 这一组是实心按钮的**底**，往沉里走是对的；
            // 字色不行——字色的纪律见下面 TextXxxActive。
            colorPrimaryActive: t.primary[500],
            colorErrorActive: t.func.errorActive,
            colorInfoActive: t.func.infoActive,
            colorWarningActive: t.func.warningActive,
            colorSuccessActive: t.primary[500],
            // TextXxxActive 不从 *Active 派生，而是从 colorXxx 的**浅色梯度** index 6 反推
            // （#3A8C72/#C96865/#6184CF），所以钉了上一组仍然漏这一组——按下态字色真正
            // 画在 Typography.Link / Text type=danger 上，必须跟着一起翻向。
            // 字色引 func.*Hover 而不是上面那组 func.*Active：深色是「越按越亮」，而
            // func.*Active（#E07A73/#D9A63E/#6E97EE）是**实心按钮的底**，实测当字用比基色还暗
            // （选中底 5.21/6.86/5.30，基色 6.32/8.01/6.39）——照抄等于按下比常态还糊。
            // 绿族同一条纪律：primary[500]（#3FBF95 选中底 6.59）比 success 常态
            // #5BC49C 的 7.11 更低，所以按下与悬停同取梯度 700（9.35）——
            // antd 自己也是 hover/active 同字色，靠底色变化表意。
            colorPrimaryTextActive: t.primary[700],
            colorErrorTextActive: t.func.errorHover,
            colorInfoTextActive: t.func.infoHover,
            colorWarningTextActive: t.func.warningHover,
            colorSuccessTextActive: t.primary[700],
          }
        : {}),
      colorSplit: t.split,
      colorBgMask: t.mask,
      boxShadow: t.shadow.s2,
      boxShadowSecondary: t.shadow.s3,
      borderRadius: t.radius.md,
      borderRadiusLG: t.radius.lg,
      borderRadiusSM: t.radius.sm,
      fontSize: t.fontSize.base,
      fontFamily: t.font,
      controlHeight: metrics.controlH,
      wireframe: false,
      // 圆角体系与蓝图 §11.6.6 一致：控件 6 / 卡片 8 / 浮层 10（10 由 Popover 组件 token 给）
    },
    components: {
      Layout: {
        headerBg: t.bg.container,
        bodyBg: t.bg.layout,
        siderBg: t.bg.container,
        headerHeight: metrics.topbarH,
        headerPadding: "0 16px",
      },
      Menu: {
        itemHeight: 36,
        itemSelectedBg: t.bg.selected,
        itemSelectedColor: dark ? t.primary[300] : t.primary[600],
        itemHoverBg: t.bg.hover,
        itemBorderRadius: t.radius.md,
        subMenuItemBg: "transparent",
        groupTitleColor: t.text[2],
        groupTitleFontSize: t.fontSize.sm,
        itemMarginInline: 8,
        iconSize: 16,
      },
      Card: {
        borderRadiusLG: t.radius.lg,
        paddingLG: 20,
        headerFontSize: t.fontSize.base,
        headerHeight: 48,
        colorBorderSecondary: t.border,
      },
      Table: {
        headerBg: t.bg.tableHead,
        headerColor: t.text[2],
        rowHoverBg: t.bg.hover,
        borderColor: t.split,
        headerSplitColor: t.split,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        headerBorderRadius: t.radius.lg,
      },
      Tabs: {
        itemSelectedColor: dark ? t.primary[300] : t.primary[600],
        inkBarColor: dark ? t.primary[400] : t.primary[600],
        titleFontSize: t.fontSize.base,
        horizontalItemGutter: 24,
      },
      Button: {
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        fontWeight: 500,
        // 深色下 colorPrimary 是提亮过的 400（#52B391）：白字对比只有 2.56:1。
        // 主按钮文字改用深色（#08201A，≈6.4:1），浅色主题保持白字。
        ...(dark ? { primaryColor: "#08201A" } : {}),
        // 实心 danger（Popconfirm 的「回收/删除」确定键，全站 20+ 处 okButtonProps.danger）
        // 的字色：antd 固定给 colorTextLightSolid=白，而深色下底是提亮红 #F08B84 → 白字 2.41。
        // 浅色底 #B03A33 白字 6.0 是对的，所以两套都由 token 给值而不是分支写死。
        dangerColor: t.func.onDanger,
      },
      Input: { activeShadow: `0 0 0 3px ${dark ? "rgba(82,179,145,.18)" : "rgba(43,164,125,.12)"}` },
      Select: { optionSelectedBg: t.bg.selected },
      Tooltip: { colorBgSpotlight: dark ? "#2A333A" : "rgba(31,40,51,.92)", borderRadius: t.radius.md },
      Popover: { borderRadiusLG: t.radius.xl },
      Dropdown: { borderRadiusLG: t.radius.lg },
      Drawer: { paddingLG: metrics.pagePad },
      Modal: { borderRadiusLG: t.radius.xxl, paddingContentHorizontalLG: 24 },
      Pagination: { itemActiveBg: t.bg.selected },
      Tag: { defaultBg: t.tag.default.bg, defaultColor: t.tag.default.fg },
      Segmented: { itemSelectedBg: t.bg.container, trackBg: t.bg.layout },
      Descriptions: { labelBg: t.bg.layout },
      Alert: {
        borderRadiusLG: t.radius.lg,
        // 深色必须接管 Alert 的四套语义底：antd 默认底是浅粉/浅蓝（#FFF3F0/#E6F4FF），
        // 我们深色正文是近白——近白字压浅粉底实测 1.11:1。底/描边直接复用同相 tag 组，
        // 文字仍是 colorText（近白），图标吃 func 色（对深底 ≥6:1）。
        ...(dark ? {
          colorErrorBg: t.tag.volcano.bg, colorErrorBorder: t.tag.volcano.bd,
          colorSuccessBg: t.tag.green.bg, colorSuccessBorder: t.tag.green.bd,
          colorWarningBg: t.tag.gold.bg, colorWarningBorder: t.tag.gold.bd,
          colorInfoBg: t.tag.blue.bg, colorInfoBorder: t.tag.blue.bd,
        } : {}),
      },
    },
  };
}
