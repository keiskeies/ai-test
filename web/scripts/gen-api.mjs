// 从运行中的后端生成 API 类型：自起后端 → 拉 openapi.json → 写 src/api/schema.d.ts → 关后端。
// 用法：node scripts/gen-api.mjs（需要 MySQL/Redis 可达；与 Playwright e2e 同库 testpilot_e2e）
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
// e2e 库的连接串与 playwright 同一份解析（gen-api 与 e2e 同库 testpilot_e2e）
import { E2E_DB_URL, E2E_REDIS_URL } from "../e2e/dbEnv.mjs";

const PY = process.env.TP_PY ?? "D:/item/ai-test/backend/.venv/Scripts/python.exe";
const PORT = process.env.TP_PORT ?? "8321";
const BASE = "http://127.0.0.1:" + PORT;

const backend = spawn(PY, ["-m", "uvicorn", "app.server:app", "--port", PORT], {
  cwd: "D:/item/ai-test/backend",
  env: {
    ...process.env,
    TP_ENV: "e2e",
    TP_DB_URL: E2E_DB_URL,
    TP_REDIS_URL: E2E_REDIS_URL,
    TP_SECRET_KEY: "e2e-secret-key-0123456789abcdef0123456789",
    TP_BOOTSTRAP_ACCOUNT: "admin",
    TP_BOOTSTRAP_PASSWORD: "E2e@Pass123",
    TP_MODEL_SEED_BASE_URL: "fake://basic_two_tools",
    TP_MODEL_SEED_NAME: "fake-basic",
  },
  stdio: "ignore",
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/v1/healthz");
      if (r.ok) return;
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("backend not ready on " + BASE);
}

try {
  await waitReady();
  const res = await fetch(BASE + "/api/v1/openapi.json");
  if (!res.ok) throw new Error("openapi fetch failed: " + res.status);
  const doc = await res.json();
  const ast = await openapiTS(doc);
  const header =
    "/**\n * 由 scripts/gen-api.mjs 自动生成（openapi-typescript）。\n * 请勿手改；后端接口变更后运行 pnpm gen:api 重新生成。\n */\n";
  writeFileSync(new URL("../src/api/schema.d.ts", import.meta.url), header + astToString(ast));
  console.log("generated src/api/schema.d.ts");
} finally {
  backend.kill();
}
