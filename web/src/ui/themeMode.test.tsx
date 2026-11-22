// 主题模式的三个契约：默认跟随系统、显式选择覆盖系统、系统切换只在「跟随」时生效。
//
// 为什么值得单独测：这三条各自对应一种「用户以为坏了」的现场——
// ① 没选过却固定浅色 → 系统深色的用户在暗房里被白屏照一次；
// ② 选过深色又被系统浅色盖回去 → 设置像不生效；
// ③ 选了显式主题后系统切换还来改 → 页面自己变色。
// 另外，index.html 里的首帧脚本与这里的 resolveInitialMode 是**两份实现**（首帧必须早于
// 模块加载），一致性没有自动门禁，只能靠这条测试把 resolveInitialMode 的口径钉清楚，
// 改动时人肉对齐（首帧脚本里那行注释也写明了互相指认）。
//
// 文件用 .tsx 后缀：vitest.config.ts 的 environmentMatchGlobs 只把 *.test.tsx 放进 jsdom，
// 而本测试要 localStorage 与 document。不为此改全局配置（那会让所有纯函数测试白白变慢）。
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 每个用例重置模块与 DOM，模拟「刚打开网页」。 */
async function fresh(pref: string | null, systemDark: boolean) {
  vi.resetModules();
  localStorage.clear();
  if (pref) localStorage.setItem("tp_theme", pref);
  document.documentElement.removeAttribute("data-theme");
  const listeners: Array<() => void> = [];
  const mq = {
    matches: systemDark,
    addEventListener: (_: string, cb: () => void) => listeners.push(cb),
    removeEventListener: () => undefined,
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mq));
  const mod = await import("../ui/themeMode");
  return { mod, mq, listeners };
}

describe("主题模式", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("没选过 → 跟随系统", async () => {
    const { mod } = await fresh(null, true);
    expect(mod.resolveInitialMode()).toBe("dark");
    const { mod: m2 } = await fresh(null, false);
    expect(m2.resolveInitialMode()).toBe("light");
  });

  it("显式选择覆盖系统偏好", async () => {
    const { mod } = await fresh("light", true);
    expect(mod.resolveInitialMode()).toBe("light");
    const { mod: m2 } = await fresh("dark", false);
    expect(m2.resolveInitialMode()).toBe("dark");
  });

  it("initTheme 把模式落到 <html data-theme>，并在跟随系统时响应切换", async () => {
    const { mod, mq, listeners } = await fresh(null, false);
    mod.initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    // 系统翻成深色 → 跟随
    mq.matches = true;
    listeners.forEach((cb) => cb());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("显式主题下系统切换不生效（避免用户设置被系统悄悄改掉）", async () => {
    const { mod, mq, listeners } = await fresh("light", false);
    mod.initTheme();
    mq.matches = true;
    listeners.forEach((cb) => cb());
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setPref('system') 会清掉存储键（回到「没选过」而不是存一个字面量）", async () => {
    const { mod } = await fresh("dark", false);
    mod.useTheme.getState().setPref("system");
    expect(localStorage.getItem("tp_theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});