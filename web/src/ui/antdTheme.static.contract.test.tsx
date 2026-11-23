// 静态弹窗（Modal.confirm / message.*）的主题接线测试。
//
// 为什么单独立一条：这条 bug 前面所有闸门全绿——tsc 过、1921 条测试过、build 过，
// 而深色主题下确认框两个按钮实测前景==底色（1:1，字完全看不见）。原因是静态方法不在
// React 树里：它把弹窗挂进自己 `document.createDocumentFragment()` 现造的一棵
// `<ConfigProvider>`，供色只认 `globalConfig()` 那份（antd config-provider/index.js:136；
// confirm.js:95/101 与 message/index.js:76/85 读同一个槽），树根的 ConfigProvider 管不到它。
// jsdom 没有样式引擎，量不出「浅底浅字」，所以这里钉接线——但钉的是**真槽里的值**，
// 不是「有没有调某个函数」：后者证明不了值真落进去了。
//
// 深链 import 必须写 `lib`：vitest 把 `antd` 解析到 CJS 入口，`es` 那条会另起一个模块实例，
// 于是写的是一套模块级变量、读的是另一套——这条会稳定红（不会假绿），但红得莫名其妙。
import { App as AntApp } from "antd";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { globalConfig } from "antd/lib/config-provider/index.js";
import { antdThemeFor, syncGlobalTheme, useAntdTheme } from "./antdTheme";
import type { ThemeMode } from "./themeMode";

describe("静态弹窗的主题接线", () => {
  it("syncGlobalTheme 把主题真落进 antd 的全局槽，holder 包的是 <App>", () => {
    const dark = antdThemeFor("dark");
    syncGlobalTheme(dark);
    // 同一份引用：深浅两套 token 名相同、值不同，传错一套只会表现为「深色没生效」。
    expect(globalConfig().getTheme()).toBe(dark);
    // holderRender 缺了 antd 自己在 dev 就 warnContext（message/index.js:199），弹层也拿不到 App 上下文。
    const holderRender = globalConfig().holderRender as (n: React.ReactNode) => React.ReactElement;
    const child = <i />;
    const wrapped = holderRender(child);
    expect(wrapped.type, "holderRender 没包 <App>").toBe(AntApp);
    expect(wrapped.props.children, "holderRender 把子节点弄丢了").toBe(child);
  });

  it("useAntdTheme：挂载即接线，切主题即重灌（漏 effect 依赖就是这里坏）", () => {
    // 只渲染这个 hook 而不 mount <App>：路由 loader 在 jsdom 里会因 AbortSignal 非原生而抛
    // undici 类型错（vitest 记 unhandled rejection → 整文件 exit 1），接线本身与路由无关。
    syncGlobalTheme(antdThemeFor("dark")); // 先弄脏，否则「变成浅色」可能只是初始态。
    const initial: { mode: ThemeMode } = { mode: "dark" };
    const { rerender } = renderHook(({ mode }) => useAntdTheme(mode), { initialProps: initial });
    const lit = globalConfig().getTheme();
    rerender({ mode: "light" });
    expect(globalConfig().getTheme(), "切换主题后全局槽没跟着换：弹窗停在旧色").not.toBe(lit);
    expect(globalConfig().getTheme()).toEqual(antdThemeFor("light"));
  });

  it("树内与树外同源（useAntdTheme 的返回值就是灌进全局槽的那一份）", () => {
    const { result } = renderHook(() => useAntdTheme("dark"));
    expect(result.current, "返回给 <ConfigProvider theme> 的配置与灌给静态方法的不是同一份").toBe(globalConfig().getTheme());
  });
});
