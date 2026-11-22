// §11.5.2 近 7 天通过率趋势（ECharts）。
//
// 依赖策略：蓝图 §5.2 批准的是 **ECharts 5**（package.json 钉 ^5.6.0），这里走
// `echarts/core` 按需注册（Line + Grid + Tooltip + CanvasRenderer），不引全量包。
// 实测同一次 `pnpm build` 的两种写法（同一台机器、同一棵工作树，只换 echarts 的引入方式：
// 按需要 `use([...])`，全量入口自带注册、`use` 反而类型不通）：
//   按需  workbenchTrend-*.js 458.33 kB / gzip 152.28 kB
//   全量  workbenchTrend-*.js 1023.43 kB / gzip 332.59 kB   （≈ 2.2 倍）
// 但**别把它读成「省了首屏 1MB」**：本组件在 workbench.tsx 里是 `lazy()` 进来的，
// 两种写法下入口 main-*.js 都是 **1421.82 kB / gzip 437.13 kB**——全量 echarts
// 一个字节都没进首屏（两次的 main 哈希不同：入口按名字引用懒加载分片，分片文件名变了它
// 就得变；尺寸一致才是「echarts 没进入口」的证据）。按需注册真正省的是「进了工作台才付的那份」：
// 省一半以上，且未来加图时不用回头动依赖。顺带一条量出来的事实：`import * as echarts from "echarts"`
// 配 `echarts.use([LineChart, ...])` 是**类型错误**（全量入口与子路径是两套声明，
// `use` 的形参类型互不兼容），所以想换全量得连注册写法一起换，不是改一行 import。
//
// 颜色全部取 theme.ts 的 Token（§11.6 主题唯一真相），不用 ECharts 默认色板：
// 折线与数据点用 primary[500]——§11.6.5 `:1496` 括注「通过率折线恒用 #2BA47D」是明写字面量，
// 而 §11.6.1 又规定 600 只给实底按钮与小字、500 才作图形大元素（此处曾长期是 600）。
// 渐变面积仍走 primary[50]→透明（面积是底，不是数据本身），网格线 split，文字 text[3]。
// 空窗口（全无运行 / 全 null 通过率）**不画空图**：调用方画 Empty，这里只保证
// 拿到数据时 null 断点不连线（connectNulls=false——「缺一天」不能画成「连过去的直线」）。
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { tokensFor } from "../theme";
import { useTheme } from "../ui/themeMode";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface TrendPoint {
  date: string; // YYYY-MM-DD（Asia/Shanghai 日历日，后端已分桶）
  runs: number;
  pass_rate: number | null; // null = 当日无有效分母（画断点，不是 0%）
}

export default function WorkbenchTrend({ points }: { points: TrendPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // ECharts 把颜色画进 canvas，**不认 CSS 变量**——必须给具体值。按当前主题取一套，
  // 并把 mode 放进依赖：切换主题时旧图要重画，否则深浅两套里有一半的图还停在旧色。
  const mode = useTheme((s) => s.mode);
  const tp = tokensFor(mode);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const chart = echarts.init(el);
    chart.setOption({
      grid: { left: 44, right: 16, top: 28, bottom: 24 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (v: unknown, idx?: number) => {
          if (v !== null && v !== undefined) return `${v}%`;
          // WHY：ECharts 只把值递给 valueFormatter，而 pass_rate=null 有两个原因（后端
          // DailyPoint：当日无运行 / 分母为 0），只有点自己的 runs 分得清——按 dataIndex
          // 回到 points 取；取不到点时说「无有效分母」（两种 null 下都成立）。
          const p = idx === undefined ? undefined : points[idx];
          return p && p.runs === 0 ? "无运行" : "无有效分母";
        },
      },
      xAxis: {
        type: "category",
        data: points.map((p) => p.date.slice(5)), // MM-DD，轴上放不进完整日期
        axisLine: { lineStyle: { color: tp.split } },
        axisTick: { show: false },
        axisLabel: { color: tp.text[3] },
      },
      yAxis: {
        type: "value", min: 0, max: 100,
        axisLabel: { color: tp.text[3], formatter: "{value}%" },
        splitLine: { lineStyle: { color: tp.split } },
      },
      series: [{
        type: "line", smooth: true, connectNulls: false,
        data: points.map((p) => (p.pass_rate === null ? null : +(p.pass_rate * 100).toFixed(1))),
        lineStyle: { color: tp.primary[500], width: 2 },
        itemStyle: { color: tp.primary[500] },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: tp.primary[50] },
            { offset: 1, color: "rgba(234,246,241,0)" },
          ]),
        },
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [points, tp]);

  return <div ref={ref} data-testid="wb-trend-chart" style={{ height: 240, width: "100%" }} />;
}
