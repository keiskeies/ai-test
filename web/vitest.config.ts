// §5.3/§14: 纯函数单测走 Vitest。scene/ 下的纯模块（stepTypes/graphOps）与 shared/ 下的
// 换算件（timefmt/runVocab、T14 的 moduleTree）都不含 React/DOM，默认 node 环境即可跑，
// 不需要 jsdom。include 只收这些纯模块单测，不扫 build/。
// 1E 工作台加了 .test.tsx（组件测试）：只有 *.test.tsx 走 jsdom（environmentMatchGlobs），
// 纯模块单测维持 node 环境不变——jsdom 全局开会让所有既有纯测试白白变慢。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // include 曾经是**逐目录逐后缀点名**的白名单，这个形状踩过三次假绿（1C 建 map 时预警、
    // 1D T3 的 src/adb/ 应验、1D T9 的 `.test.ts` 不匹配 `.test.tsx` 又应验一次）：
    // 新目录或新后缀没被点名时，测试文件躺在那里不跑，门禁照样报「全绿」。
    // 现在改成收 src 全集——白名单要挡的从来不是 src 里的东西，而是构建产物，
    // 而产物在 web/dist、不在 web/src，所以全集与「不扫 build/」不冲突。
    // 加目录、加后缀都不必再回来改这里：漏测试的结构性前提被拿掉了。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
    // 超时从 vitest 默认的 5000ms 抬到 20000ms。这个 5000 从来不是本项目**选过**的数：
    // 全仓零处 per-test 超时、这里也没写 testTimeout，于是一百来个 jsdom 组件测试一直骑在
    // 库默认值上——那个默认是给纯函数单测定的，不是给「渲染一张 20 行 AntD 表 + 模块树、
    // 每次换页把整棵树重渲染一遍」定的。
    // 逼出这条的是全量套件里两条**同病**的红（都不是断言失败，是撞墙）：
    //   api.test.tsx「点第 2 页恰好一条」  5642 / 5908 / 5649ms → 稳定超时
    //   CommandPalette「逐行点选的 (行→落点) 绑定」4665ms → 余量 335ms，这次侥幸过
    // 分段计时定位到钱花在哪（不是下拉、不是那 300ms 静置）：三个等 fetch 往返的 waitFor
    // 各吃 1.3~1.5s（点第 2 页 1200→2550、点第 3 页 2559→4053、换档位 4251→5524），
    // 例体合计 5525ms —— 换页重渲染真实 jsdom 成本，**不是测试写坏了**。
    // 为什么不各改各的：那 300ms 静置是 D127 绊线要的真钟摆、fake timers 与 antd 是已知的
    // 坑；而「把例体砍快」会砍掉测试证明的东西（20 行、total=137 七页正是前提）。
    // 一条同病两处的病，配一个全局数，注释留在此地。
    // 这不是把闸门拧松：断言一条没动，超时不是断言、是**卡死探测器**——真死循环照样红，
    // 只是从 5s 报变成 20s 报（全套本就 ~110s，换得值）。20000 = 最差实测 5.9s 的三倍余量。
    testTimeout: 20000,
  },
});
