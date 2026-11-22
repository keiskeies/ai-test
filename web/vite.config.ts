import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// e2e/开发统一走 5173；/api 代理到本机后端（TP_E2E 后端 8001，本地 dev 8000）
const backend = process.env.TP_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // 依赖预构建缓存不放进 node_modules：本机杀软会锁 .vite/deps_temp* 的写入
  // （README 记过这个环境问题），放到项目内 .tmp 下由 .gitignore 忽略。
  cacheDir: ".tmp/vite-cache",
  build: {
    // §11.7 支持浏览器=Chromium 最新两大版本：产物不再降级转译（也绕开本机 AV 锁 esbuild 临时文件的问题）
    target: "esnext",
    minify: "terser",
    rollupOptions: {
      input: {
        main: "index.html",
        // T16 的编辑器回归夹具页（e2e/editor.spec.mjs 的靶）。**只在 e2e 构建里出现**：
        // 它是 probe.html + src/probe.tsx 挂起来的一个能敲字的 Monaco，不进产品导航，
        // 但作为构建入口就会被 vite 拷进 dist/，于是生产包多一个 URL 可达的调试页
        // （计划 Task 16 Step 4 原文是「删探针路由」，这里改成按 mode 开——夹具要留着当
        // 长期回归，但不该跟着生产出货）。e2e 用 pnpm build:e2e，CI 亦然。
        ...(mode === "e2e" ? { probe: "probe.html" } : {}),
      },
      output: {
        // monaco 单独成 chunk：T20/T22 调试抽屉按需加载，不随首屏 index 出货
        manualChunks: (id) => (id.includes("node_modules/monaco-editor") ? "monaco" : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
  preview: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
}));
