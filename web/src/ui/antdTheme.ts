// antd ConfigProvider 主题工厂（浅/深各一套；同形由类型钉住）。
//
// 为什么是函数而不是两份常量：antd 的 token 名与我们的 tp.* 不是一一对应（它有
// colorBgElevated / colorFillSecondary 这些我们没造的语义），映射逻辑写两遍就会
// 出现「深色下某处还是浅色」。工厂里只写一次映射，取 tokensFor(mode) 供值。
//
// 这里刻意**不**用 antd 的 darkAlgorithm：算法会自己推导一整套色，结果是我们的
// 青竹绿与卡片层次被它改写，而设计文档 §11.6 的口径是「深色只换映射不改名」。
// 全量显式映射的代价是组件 token 要手写，收益是深浅两套每一处都可解释。
import type { ThemeConfig } from "antd";
import { metrics, tokensFor } from "../theme";
import type { ThemeMode } from "./themeMode";

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
      colorLink: dark ? t.primary[300] : t.primary[600],
      colorLinkHover: dark ? t.primary[200] : t.primary[500],
      colorLinkActive: dark ? t.primary[200] : t.primary[700],
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
      colorBorder: t.border,
      colorBorderSecondary: t.split,
      colorBgLayout: t.bg.layout,
      colorBgContainer: t.bg.container,
      colorBgElevated: t.bg.elevated,
      colorFillSecondary: t.bg.hover,
      colorFillTertiary: t.bg.hover,
      colorFillQuaternary: t.bg.layout,
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