import path from "node:path";
import { defineConfig } from "@playwright/test";
// e2e 库的连接串：进程环境 → backend/.env 派生 → 响亮报错（口径见 e2e/dbEnv.mjs 文件头）
import { E2E_DB_URL, E2E_REDIS_URL } from "./e2e/dbEnv.mjs";

const BACKEND = "http://127.0.0.1:8321";
const FRONT = "http://127.0.0.1:5173";
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
// Windows 开发用 venv 绝对路径；CI(Linux) 设 TP_PYTHON=python（setup-python 已装依赖）
const PY = process.env.TP_PYTHON ?? path.join(ROOT, "backend", ".venv", "Scripts", "python.exe");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  // dist/ 必须是带夹具页的构建（e2e/globalSetup.mjs 说人话报错，而不是让 editor.spec 超时）
  globalSetup: "./e2e/globalSetup.mjs",
  use: {
    baseURL: FRONT,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      // 先跟到 head 再起服务：e2e 库落后一版就是满屏 500，排查成本极高
      command: `"${PY}" -m alembic upgrade head && "${PY}" -m uvicorn app.server:app --port 8321`,
      cwd: path.join(ROOT, "backend"),
      env: {
        TP_ENV: "e2e",
        TP_DB_URL: E2E_DB_URL,
        TP_REDIS_URL: E2E_REDIS_URL,
        TP_SECRET_KEY: "e2e-secret-key-0123456789abcdef0123456789",
        TP_BOOTSTRAP_ACCOUNT: "admin",
        TP_BOOTSTRAP_PASSWORD: "E2e@Pass123",
        TP_MODEL_SEED_BASE_URL: "fake://basic_two_tools",
        TP_MODEL_SEED_NAME: "fake-basic",
        // e2e 后端没有 Celery worker：不设这个的话 exec_mode 默认 celery，任何执行场景的
        // e2e 都会 503 executor_unavailable。inline 跑的是同一份引擎（R42）；「真走 worker」
        // 由 backend/scripts/verify_worker.py 单独证明，e2e 只断言产品行为（计划 T9 裁定）。
        TP_EXEC_MODE: "inline",
        // 1D T10 假 adb 的 opt-in 直通：env 对象会整体替换 process.env，所以假设备通路
        // 必须显式转接（不设 = 形状与之前完全一致，mixedScene ① 的「无设备如实红」照常跑；
        // 设了 = mixedScene ②③ 的全绿通路与 demo 手册 §3 手持路径同源）。
        // 生成这对路径的命令见 docs/superpowers/plans/README-1d-demo.md §门禁不依赖 emulator。
        ...(process.env.TP_ADB_PATH ? { TP_ADB_PATH: process.env.TP_ADB_PATH } : {}),
        ...(process.env.FAKE_ADB_STATE ? { FAKE_ADB_STATE: process.env.FAKE_ADB_STATE } : {}),
      },
      url: BACKEND + "/api/v1/healthz",
      timeout: 120_000,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // 靶场：真 HTTP 目标（e2e 的调试请求真的打到它，不用假传输）
      command: `"${PY}" scripts/target_app.py`,
      cwd: path.join(ROOT, "backend"),
      url: "http://127.0.0.1:9999/healthz",
      timeout: 120_000,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npx vite preview --host 127.0.0.1 --port 5173 --strictPort",
      cwd: HERE,
      env: { TP_BACKEND: BACKEND },
      url: FRONT,
      timeout: 120_000,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
