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
export { startMockServer, sampleFromSchema, buildUrlFor, type MockServer, type MockOptions } from './mock/mock.js';
