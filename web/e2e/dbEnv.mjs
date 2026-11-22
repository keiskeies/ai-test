/**
 * e2e 库连接串的唯一来源：**进程环境 → `backend/.env` 派生 → 响亮报错**。
 *
 * 为什么要有这个文件：`playwright.config.ts` 与 4 个 spec 加 `scripts/gen-api.mjs`，
 * 六处各抄了一份 `mysql+asyncmy://root:<真口令>@<内网机>:3306/testpilot_e2e` 的字面量。
 * `.env` 一直是 gitignore 的、`.env.example` 一直写 `CHANGE_ME` —— 规矩本来就有，
 * 只有这些默认值没执行它。口径与 `backend/app/shared/localenv.py` 一致（那边是 Python 侧，
 * 两边都是「env 优先 → .env → 报错」，**不给一个看着能连的假默认值**）。
 *
 * 为什么用 `process.loadEnvFile` 而不是引 `dotenv`：web 侧「前端零新依赖」是既有纪律
 * （见 `helpers.mjs` 里那句「走 python+pymysql 子进程：web 包不带 MySQL 驱动」），
 * 而这个 API 是 Node 内置的（20.12+ / CI 用 22，`web/package.json` 的 engines 口径）。
 * 它的优先级也正好是要的：**已导出的变量不被 .env 覆盖**（实测，非推测）。
 *
 * 为什么 e2e 串是从 `TP_DB_URL` **换库名**派生、而不是新设一个变量：
 * 这正是那六处字面量当年的行为（同一台机器、同一个实例，只是 schema 叫 `testpilot_e2e`）。
 * 想指到别处仍然可以显式导出 `TP_E2E_DB_URL`，它优先。
 */
import path from "node:path";

const BACKEND_DIR = path.resolve(import.meta.dirname, "..", "..", "backend");
const ENV_PATH = path.join(BACKEND_DIR, ".env");

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // 没有 backend/.env（CI 就是走进程环境注入）。不算错，交给下面的报错去区分「真没配」。
}

/** `.env.example` 教的占位值：照抄没改 = 没配，和没配同等对待（否则会拿 CHANGE_ME 去连库）。 */
const PLACEHOLDERS = new Set(["", "CHANGE_ME", "CHANGE_ME_random_32b"]);

function configured(key) {
  const v = process.env[key];
  return v !== undefined && !PLACEHOLDERS.has(v.trim()) ? v : undefined;
}

/**
 * 换掉连接串里的 schema 段。**不用 `new URL()`**：它会把含 `/` 的口令解析成 host:port
 * （实测 `root:p@ss/w:ord@h` → hostname `ss`），而 `backend/scripts/check_migration_down.py:64`
 * 早就为同源的一个坑写过「不能用 str(urlsplit(...))」。
 *
 * 也不写 `indexOf("/", indexOf("//")+2)`：那还是从**左边**找斜杠，口令里带 `/` 时
 * 会把 schema 换进口令中间（实测 `root:p@ss/w:ord@h:3306/testpilot` → `root:p@ss/testpilot_e2e`，
 * host 整个丢了，且因为结果仍以 `mysql+asyncmy://` 开头，连类型检查都不报错 ——
 * 这是写完上一版当场实测出来的，不是防虚构的假想敌）。
 * 所以先定权限段的**右端**（query 之前最后一个 `@`），只从它右边开始找路径斜杠。
 */
function withSchema(url, schema) {
  const schemeEnd = url.indexOf("//") + 2;
  if (schemeEnd <= 2) throw new Error(`TP_DB_URL 长得不像连接串（没有 // 权限段）：${mask(url)}`);
  const query = url.indexOf("?", schemeEnd);
  const authorityEnd = query < 0 ? url.length : query;
  const at = url.lastIndexOf("@", authorityEnd);
  const from = url.indexOf("/", at < 0 ? schemeEnd : at + 1);
  if (from < 0 || from >= authorityEnd) {
    throw new Error(`TP_DB_URL 缺库名段，换不了 schema：${mask(url)}`);
  }
  return query < 0 ? url.slice(0, from) + "/" + schema : url.slice(0, from) + "/" + schema + url.slice(query);
}

/** 报错里要带上是哪一个串，但值可能是口令 ⇒ 口令段先打码再进消息（这行会进 CI 日志）。 */
function mask(url) {
  return url.replace(/:[^:@/]*@/, ":***@");
}

/** 报错只印键名与去处，**永不印值** —— 值可能是口令，而这行会进 CI 日志。 */
function missing(keys) {
  return new Error(
    `e2e 需要 ${keys.join(" 或 ")}，两处都没有：① 写进 ${ENV_PATH}（照仓库根 .env.example）；` +
      `② 或导出 $env:${keys[0]} / export ${keys[0]}=...。` +
      "代码里不留默认值是**有意的**——历史上那些默认值把真口令写进了公开仓库。",
  );
}

const base = configured("TP_E2E_DB_URL") ?? (() => {
  const parent = configured("TP_DB_URL");
  return parent === undefined ? undefined : withSchema(parent, "testpilot_e2e");
})();
if (base === undefined) throw missing(["TP_E2E_DB_URL", "TP_DB_URL"]);
export const E2E_DB_URL = base;

const redis = configured("TP_E2E_REDIS_URL") ?? configured("TP_REDIS_URL");
if (redis === undefined) throw missing(["TP_E2E_REDIS_URL", "TP_REDIS_URL"]);
export const E2E_REDIS_URL = redis;
