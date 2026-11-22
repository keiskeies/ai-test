// 浅/深主题开关的唯一状态源。
//
// 三件要求决定了形状：
// ① **持久化**：刷新后不该弹回浅色（localStorage，键 tp_theme）。偏好按浏览器记，
//    不按用户记——主题是设备/环境口径（白天在投影上讲、晚上在暗房间调试），
//    与账号权限无关，存服务端只会让两台机器互相改。
// ② **首帧不闪**：index.html 里的内联脚本在 React 挂载前先把 data-theme 写到 <html>，
//    CSS var 从第一帧就是对的。本文件只负责把同一个判断再算一遍（SSR 无、但测试与
//    probe 页会直接 import），两处口径靠 themeMode.ts 的 resolveInitialMode 收口。
// ③ **跟随系统是第三种值**，不是一个默认拷贝：用户没选过时跟 prefers-color-scheme 走，
//    选过就是显式覆盖。把「系统」折叠成一次性的 light/dark 快照，系统切换时页面不跟，
//    用户以为坏了。
import { create } from "zustand";

export type ThemeMode = "light" | "dark";
export type ThemePref = ThemeMode | "system";

const KEY = "tp_theme";

export function resolveInitialMode(): ThemeMode {
  const pref = readPref();
  if (pref !== "system") return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 存储里的偏好：只认 light/dark，其余（含读不了）一律 system。 */
export function readPref(): ThemePref {
  try {
    const pref = localStorage.getItem(KEY);
    if (pref === "light" || pref === "dark") return pref;
  } catch { /* 隐私模式读不了 localStorage：按系统走，不毁页面 */ }
  return "system";
}

interface ThemeState {
  pref: ThemePref;
  mode: ThemeMode;
  setPref: (p: ThemePref) => void;
}

/** 把生效模式写到 <html data-theme>：CSS 侧只认这一个属性，不再各自判断。 */
function apply(mode: ThemeMode): void {
  try {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  } catch { /* 非 DOM 环境（单测 node 环境）：无副作用可做 */ }
}

export const useTheme = create<ThemeState>((set) => ({
  pref: readPref(),
  mode: resolveInitialMode(),
  setPref: (p) => {
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch { /* 写不进就只在本次会话生效，不弹错 */ }
    const mode = p === "system" ? resolveInitialMode() : p;
    apply(mode);
    set({ pref: p, mode });
  },
}));

/** 启动时同步一次（App 挂载调用）：把 store 的模式落到 <html>，并挂系统主题监听。 */
export function initTheme(): () => void {
  apply(useTheme.getState().mode);
  if (!window.matchMedia) return () => undefined;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (useTheme.getState().pref !== "system") return;
    const mode = mq.matches ? "dark" : "light";
    apply(mode);
    useTheme.setState({ mode });
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}