/**
 * @atest/adapter-http —— HTTP 侧的全部副作用（docs/04 M2）。
 *
 * 分包边界的硬约束（由 tooling/lint-layers.mjs 强制）：
 *  - **只有这一层**允许碰 node 内置模块与网络。engine 一行 node 代码都不能有，
 *    否则"引擎在浏览器里跑只读校验"（docs/01 §8.2）当场失效。
 *  - 反向依赖禁止：本包不得认识 store/llm/server/web/cli。
 *
 * 对 engine 只暴露一个东西：`asHttpExec`（实现 engine 的 HttpExec 端口）。
 * 其余导出是给 CLI/服务端在**建 adapter 时**用的，不是给引擎用的。
 */

// —— OpenAPI ——
export {
  parseOpenApi,
  type ParsedDoc,
  type OperationSpec,
  type ParamSpec,
  type ParseOptions,
} from './openapi/parse.js';
export {
  resolveAliases,
  aliasFor,
  normalizePath,
  AliasConflictError,
  type RawOp,
  type AliasedOp,
} from './openapi/alias.js';
export {
  dereference,
  collectRefs,
  preloadExternals,
  pointer,
  isCycleNode,
  type RefIssue,
  type SpecDoc,
  type ExternalResolver,
} from './openapi/refs.js';
export {
  styleParam,
  buildQuery,
  fillPath,
  defaultStyle,
  DEFAULT_EXPLODE,
  StyleError,
  type ParamIn,
  type ParamStyle,
  type Serialized,
} from './openapi/style.js';
/*
 * URL 组成那一层也对外。导出它的理由不是"顺手统一一下"：
 * **`composeUrl` 需要 operation 才能查 style/explode**，而调用方十有八九没有
 * operation（纯 `http` 步骤不带 spec 坐标）。那些调用方要的是"按规范默认值组成"
 * 这一半，而它只有传 `op: undefined` 才拿得到 —— 没有别的公开入口能拿到。
 * 不导出的话，下一个需要组成 URL 的人只能再抄一份内联 replace（本轮删掉的正是这种副本）。
 */
export { composeUrl, type ComposedUrl } from './openapi/compose.js';
export {
  compileValidator,
  validateAgainstSchema,
  isValid,
  type Violation,
  type ValidationResult,
  type Validator,
  type ValidatorOptions,
} from './openapi/validate.js';

// —— HTTP ——
export { HttpClient, asHttpExec, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, type SendRequest, type SendResult, type HttpClientOptions } from './http/client.js';
export {
  CookieJar, parseSetCookie, setCookiesOf, domainMatches, pathMatches, defaultPath, expiryOf, normalizeDomain,
  type StoredCookie, type CookieAttr, type CookieJarOptions,
} from './http/cookies.js';
export { parseJsonKeepBigInt, quoteBigInts, stringifyBody, BIG_INT_DIGITS } from './http/bigint.js';

// —— 鉴权（docs/05 §2）——
export {
  normalizeSecuritySchemes, parseSecurityRequirements, chooseSchemeGroup,
  type AuthScheme, type SecurityRequirement, type SchemeChoice, type SchemeParseResult, type UnsupportedScheme,
} from './auth/scheme.js';
export { CredentialTable, type CredentialBinding, type DocCredentials, type AuthConfigRaw, type CredentialResolution } from './auth/credentials.js';
export { applyAuth, scrubSecrets, base64Utf8, MissingCredentialError, type AppliedAuth, type ApplyInput } from './auth/apply.js';
export { TokenSource, TokenError, cacheKey, type TokenSourceOptions, type TokenCacheEntry } from './auth/token.js';
export { AuthResolver, type AuthResolverOptions, type AuthPlan } from './auth/interceptor.js';
export { AuthHook, AuthRequiredError, type AuthHookOptions, type AuthApplyInput, type OpAuthNeed } from './auth/hook.js';

// —— Mock ——
export { startMockServer, sampleFromSchema, type MockServer, type MockOptions } from './mock/mock.js';

/*
 * —— 压测那条路（docs/09 §4.2）——
 *
 * 这四个是**唯一的出口**：`packages/cli` 是仓里唯一被允许把 engine 与 adapter 拼起来的包，
 * 而它只能经包名 import（相对路径跨包会被 lint-layers 拦）。
 * 之前它们只在 `src/index.ts` 里缺席、被测试用相对路径直接抓 —— 于是
 * "CLI 能不能接上"这件事本身没法成立，四个导出全是 dead export。
 *
 * 只导**这层之外用得上的**：`walkSyncK6` / `walkAsyncBuiltin` / `newLoadState` 这些
 * 是两个后端的内部调度，导出去等于邀请第三个人写第三个后端而绕开
 * `LOAD_STEP_SUPPORT` 那张表（判据只该有一处）。
 */
export {
  compileLoadPlan, LoadCompileError, type LoadPlan, type LoadNode, type LoadDocLookup, type LoadOperation,
} from './load/plan.js';
export {
  press, measuredLoad, requestFailed, LoadPressFailure,
  type PressOptions, type PressResult,
} from './load/press.js';
export { renderK6Script, type EmitOptions } from './load/emit-k6.js';
export { PRELUDE_FILE } from './load/prelude.js';
