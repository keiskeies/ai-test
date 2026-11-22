// 前端 lint（蓝图 §14「CI: … + 前端 lint/test/build 全绿才合主干」欠的那一项）。
//
// 为什么现在才加：1A–1C 的 CI 跑的是 ruff / lint-imports / pytest / e2e，`pnpm build`
// 里那半步 `tsc -b` 只查类型，**没有任何一道门禁看过代码风格与危险写法**。
// 加它的收益不是好看：recommended 那套会钉住 `no-var`、空 catch 块、真正没用到的
// 变量与参数、`==` 的隐式转换这类 tsc 看不见的事；`react-hooks/exhaustive-deps`
// 管 useEffect/useMemo 依赖数组漏项（`src/api/EnvPanel.tsx`、`CodeEditor.tsx` 里
// 那三处 `eslint-disable-next-line react-hooks/exhaustive-deps` 此前** mute 的是一道
// 根本不存在的规则**——1A–1C 没有前端 lint，那三行注释一直在骗读代码的人）。
//
// 口径是**克制**的，不是越严越好：
// - `no-explicit-any` 关掉。本仓的边界层（`@service` 动态路由、执行器 ctx、ECharts
//   option）本来就带 any，硬拧成 unknown 只会逼人写 `as unknown as X` 把信息藏得更深；
//   mypy 侧同理（见 backend/pyproject 的宽松段）。这条留给后续按模块逐步收紧。
// - `no-unused-vars` 开成 warn 且 `argsIgnorePattern: "^_"`：允许 `_dump` 这类
//   刻意占位（后端 ruff 同规则），但真忘了用要看得见。
// - 生成的 `src/api/schema.d.ts` 与 e2e 产物不进 lint：那是 openapi-typescript 的
//   输出，我们不该也不能改它（改了下次 `pnpm gen:api` 就没了）。
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      ".tmp/**", // pnpm/gen-api 的临时目录（已在 .gitignore），里面是探针脚本，不是源码
      "src/api/schema.d.ts", // openapi-typescript 生成，下次 gen:api 会覆盖
      "vite.config.ts", // 只有几行构建配置，且 e2e 档位靠它，不折腾
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: {
      // warn 不是打折：这条规则对「故意窄化依赖」的写法天然多报（本项目有三处就是这么写的），
      // 直接 error 会把门禁变成噪音墙，反而没人看。它的价值在于**新写的漏项能被看见**。
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error", // 这条必须 error：条件里调 hook 是实打实的错
      "no-explicit-any": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: ["warn", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
      // 空 catch 一律不许（吞错就是静默降级，§13 纪律 1 的同一条口径）
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // 测试与 e2e 里 console / 非空断言是正当工具（断言失败要看得见她长什么样）
    files: ["**/*.test.{ts,tsx}", "e2e/**/*.{ts,mjs,js}", "src/probe/**/*.{ts,tsx}", "scripts/**/*.{mjs,js}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
  {
    // e2e 的 .spec.mjs 两头都要：文件本体跑在 Node（playwright runner），
    // page.evaluate 的回调体跑在浏览器里（window/document/MouseEvent/DataTransfer）。
    // 只给 node 会让每个 evaluate 里的 DOM 引用报 no-undef——那是配置缺全局，不是代码错。
    files: ["scripts/**/*.{mjs,js}", "e2e/**/*.{mjs,js}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
