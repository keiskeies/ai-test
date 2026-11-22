// T16 探针挂载点：独立入口（无 auth 导航、不在产品路由内）。
// 用途：e2e 验证 CodeEditor 离线可用 + Playwright 可定位（e2e/editor.spec.mjs），
// 以及 T16 的 ElementPicker / CommandParams（?mount=ui-params，e2e/uiCase.spec.mjs）——
// 两者的靶页共用 /probe.html，按 query 分流；夹具只在 build:e2e 出货（vite.config.ts）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ProbePage from "./probe/ProbePage";
import UiParamsProbe from "./probe/UiParamsProbe";

const mount = new URLSearchParams(location.search).get("mount");
const Page = mount === "ui-params" ? UiParamsProbe : ProbePage;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
