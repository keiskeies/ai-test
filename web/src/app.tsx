import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { ConfigProvider, App as AntApp, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { Navigate, RouterProvider, createHashRouter } from "react-router-dom";
import "antd/dist/reset.css";
import "./styles.css";
import { antdThemeFor } from "./ui/antdTheme";
import { initTheme, useTheme } from "./ui/themeMode";
import { getToken } from "./api/client";
import { useAuth } from "./auth/store";
import LoginPage from "./pages/login";
import Workbench from "./pages/workbench";
import Bench from "./pages/bench";
import ApiPage from "./pages/api";
import DatasetsPage from "./pages/datasets";
import RunsPage from "./pages/runs";
import ScenesPage from "./pages/scenes";
import ReportsPage from "./pages/reports";
import PlansPage from "./pages/plans";
import SettingsPage from "./pages/settings";
import UiElementsPage from "./pages/uiElements";
import UiCasesPage from "./pages/uiCases";
import AdbDevicesPage from "./pages/adbDevices";
import AdbCasesPage from "./pages/adbCases";
import NotifyChannelsPage from "./pages/notifyChannels";
import SchedulesPage from "./pages/schedules";
import Shell from "./layout/shell";

// 画布页路由级懒加载：它静态引着 monaco/xyflow/elk（monaco chunk 4.5MB），
// 直挂进 Routes 会让每个页面的首屏都背着它（vite.config 的 manualChunks 注释
// 写明 monaco「不随首屏 index 出货」）。报告详情同族（只读画布 + CodeEditor）。
// UI 用例详情同族：T17 起它静态引 Monaco（命令编辑器），骨架期也必须 lazy，
// 免得 T17 接线那天才发现首屏悄悄胖了 4.5MB。
const SceneEditorPage = lazy(() => import("./scene/SceneEditor"));
const ReportDetailPage = lazy(() => import("./pages/reportDetail"));
// D183 步 6b：计划详情（/plans/:id）懒载，形状逐字对齐下方 reports/:id 的 Suspense+Spin。
// 路由是它的前提：在文件末尾那条 `{path:"*"}` catch-all 下点不存在的 /plans/:id 不会 404，
// 而是静默弹回工作台（丢筛选丢页码）——plans.tsx 名称列与 ⑬ 测试都等这条路由才翻。
const PlanDetailPage = lazy(() => import("./pages/planDetail"));
// D183 步 6c：计划报告详情（/plan-reports/:id）懒载，形状逐字对齐上方 plans/:id 的 Suspense+Spin。
// 路由落地同批把 planDetail.tsx 报告名列翻成真链接（catch-all 那把锁随路由消失——6a ⑬/6b ⑨ 同款纪律）。
const PlanReportDetailPage = lazy(() => import("./pages/planReportDetail"));
// 候选只读预览同族（1F T4）：静态引着 Canvas（@xyflow），必须懒载，别进主 chunk。
const ScenePreviewPage = lazy(() => import("./pages/scenePreview"));
const UiCaseDetailPage = lazy(() => import("./pages/uiCaseDetail"));
// ADB 用例详情同族：步骤编辑器引 StepListEditor/参数表单，与 UI 详情同口径走懒载。
const AdbCaseDetailPage = lazy(() => import("./pages/adbCaseDetail"));

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready, bootstrap } = useAuth();
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  if (!ready) return <Spin style={{ display: "block", margin: "20vh auto" }} />;
  if (!user && getToken()) return <Spin style={{ display: "block", margin: "20vh auto" }} />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// 路由表：createHashRouter（data router）——useBlocker 只在 data router 可用，
// 场景编辑器的「未保存离开拦截」依赖它；URL 形态（#/xxx）与 HashRouter 完全一致。
const router = createHashRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Workbench /> },
      { path: "bench", element: <Bench /> },
      { path: "api", element: <ApiPage /> },
      { path: "datasets", element: <DatasetsPage /> },
      { path: "runs", element: <RunsPage /> },
      // D183 步 6a：测试计划列表（任务中心）。只引 antd，无重依赖，静态挂载（同 runs/reports）。
      { path: "plans", element: <PlansPage /> },
      // D183 步 6b：计划详情。懒载 + Suspense/Spin 逐字对齐 reports/:id。
      { path: "plans/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <PlanDetailPage />
        </Suspense>
      ) },
      // D183 步 6c：计划报告详情。懒载 + Suspense/Spin 逐字对齐 plans/:id。
      { path: "plan-reports/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <PlanReportDetailPage />
        </Suspense>
      ) },
      { path: "scene", element: <ScenesPage /> },
      { path: "scene/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <SceneEditorPage />
        </Suspense>
      ) },
      { path: "reports", element: <ReportsPage /> },
      { path: "reports/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <ReportDetailPage />
        </Suspense>
      ) },
      // 1F T4：Pilot 候选卡只读预览（D33 独立路由；payload 走 sessionStorage，查询串只带键名）。
      { path: "scene-preview", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <ScenePreviewPage />
        </Suspense>
      ) },
      { path: "settings", element: <SettingsPage /> },
      { path: "ui/elements", element: <UiElementsPage /> },
      { path: "ui/cases", element: <UiCasesPage /> },
      { path: "ui/cases/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <UiCaseDetailPage />
        </Suspense>
      ) },
      // 1D T9：设备卡片墙 + ADB 用例（列表静态、详情懒载，同 UI 用例的拆法）。
      { path: "adb/devices", element: <AdbDevicesPage /> },
      { path: "adb/cases", element: <AdbCasesPage /> },
      { path: "adb/cases/:id", element: (
        <Suspense fallback={<Spin style={{ display: "block", margin: "20vh auto" }} />}>
          <AdbCaseDetailPage />
        </Suspense>
      ) },
      // 1E 补记：通知渠道管理（§11.4.26，后端 1efaf08 已落地）。渠道是平台级配置，不挂项目前缀。
      { path: "notify/channels", element: <NotifyChannelsPage /> },
      // 1E 补记：定时任务页（§11.4.17，后端 schedule 服务面同期落地）。
      { path: "schedules", element: <SchedulesPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  // 主题：首帧由 index.html 内联脚本先落 data-theme，挂载后 store 再同步一次并监听系统切换。
  // token 按当前 mode 现算——深浅各一套映射，不走 antd 的算法推导。
  const mode = useTheme((s) => s.mode);
  useEffect(() => initTheme(), []);
  return (
    <ConfigProvider theme={antdThemeFor(mode)} locale={zhCN}>
      <AntApp>
        <RouterProvider router={router} />
      </AntApp>
    </ConfigProvider>
  );
}
