/**
 * 测试夹具。四个测试文件共用，避免「同一个造场景的函数抄四遍后各自漂移」。
 *
 * 这里刻意只做一件事：**把 zod 默认值填掉的噪音从测试正文里拿掉**，
 * 让每条断言读起来就是它要验证的行为本身。
 */
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry, type HttpExec, type RunReport } from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

export type { StepDraft } from '@atest/ir';

/** 步骤基字段。id 必填且运行内唯一（$.step.<id> 引用靠它） */
export const b = (id: string): { id: string } => ({ id });

/** 造一个合法场景。IR 不合法直接让测试失败 —— 而不是把坏 IR 喂进引擎得出无意义的结论 */
export function scen(body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario {
  return defineScenario({
    schemaVersion: '1', id: 'scn.test', name: 'test scenario',
    env: { environmentRef: 'unit' }, body, ...extra,
  } as ScenarioDraft);
}

export interface RunOverrides {
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  adapters?: AdapterRegistry;
  secretResolver?: (ref: string) => string;
  signal?: { aborted: boolean };
  maxCostUsd?: number;
  seed?: number;
}

/** 一律用冻结时钟：测试里的时间与随机数必须是可复现的 */
export async function run(s: Scenario, over: RunOverrides = {}): Promise<RunReport> {
  return runScenario({
    scenario: s,
    inputs: over.inputs, env: over.env, secretResolver: over.secretResolver,
    adapters: over.adapters ?? {}, clock: deterministicClock(over.seed ?? 42),
    signal: over.signal, maxCostUsd: over.maxCostUsd,
  });
}

/** 取某步骤结果。取不到就直接失败并列出实际有哪些 —— 否则 assert.equal(undefined,...) 很难读 */
export function res(r: RunReport, id: string): RunReport['results'][number] {
  const x = r.results.find((y) => y.stepId === id);
  assert.ok(x, `没有步骤 "${id}" 的结果（实际：${r.results.map((y) => y.stepId).join(', ') || '无'}）`);
  return x!;
}

/** 一个 GET 请求步骤的最小写法 */
export const getStep = (id: string, url = 'http://x/y'): StepDraft => ({ ...b(id), kind: 'http', request: { method: 'GET', url } });

/**
 * `HttpExec.composeUrl` 的测试替身。**占位符扫描照真做，序列化不做。**
 *
 * ## 为什么不是 `async () => ({ path: tpl, missing: [], unknown: [] })`
 *
 * 那三个字段里 `missing` / `unknown` **有消费者** —— 引擎 openapiCall 分支那两个
 * `case-stale` 错误分支就靠它们驱动。恒返回空数组的话，那两个分支在这一层
 * **永远走不到**，而全仓测试照样全绿：这正是 docs/08 §3(e)「有生产者、没有载体」
 * 的反面 —— 载体有了、判的人有了，而**供数的人一个都没有**。
 * 所以占位符那部分是真算的（与 `adapter-http` 的 `fillPath` 同一判据：
 * `\{([^}/]+)\}`，两边都对得上 `style.test.ts` 里那几条）。
 *
 * ## 这条桩**故意不管**什么，以及那笔账记在哪
 *
 * 值的序列化（数组展开成重复键、`|` 分隔、`+` 编码）这里**一个都不做**，
 * 原样交回 `String(v)`。也就是说：**engine 层的测试证明不了序列化是对的**，
 * 它只证明引擎把参数交下去了、把 missing/unknown 判对了。
 * 序列化那半的载体是 `adapter-http/test/engine-e2e.test.ts`（真 adapter + 真 mock，
 * 断言 mock 收到的 query），那两条**改前是红的**。别把这里当那道证据。
 */
export function stubComposeUrl(): HttpExec['composeUrl'] {
  return async ({ urlTemplate, pathParams, queryParams }) => {
    /*
     * 手写 query 段与路径那半段**分开处理**，这不是照抄实现的冗余：
     * `composeUrl` 里"`{}` 只可能出现在路径里"那条假设本轮被证伪了
     * （`url: '/u?tag={t}'` 合法，而改前它把字面量 `{t}` 发出去且步骤判 pass）。
     * 桩如果继续"整段一起填"，就会比生产**更宽松** —— 引擎里凡是写出这种形状的夹具
     * 会在桩这儿判过、在真 adapter 那儿报错，而那正是本文件开头要避免的那类失真。
     */
    const qAt = urlTemplate.indexOf('?');
    const pathPart = qAt < 0 ? urlTemplate : urlTemplate.slice(0, qAt);
    const inlineQuery = qAt < 0 ? '' : urlTemplate.slice(qAt + 1);
    const given = pathParams ?? {};
    const missing = [...pathPart.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!)
      .filter((k) => given[k] === undefined || given[k] === null);
    // 手写 query 段里的占位符**一律算没填**（生产侧也不让它由 pathParams / query 同名豁免）
    missing.push(...new Set([...inlineQuery.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!)));
    // known 只扫 path 那半段（与 compose.ts 同）：pathParams 只填路径占位符
    const known = new Set([...pathPart.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!));
    const unknown = Object.keys(given).filter((k) => !known.has(k));
    // 占位符替身：只填路径那半段，值不序列化（见上面那段"这笔账记在哪"）
    let path = pathPart.replace(/\{([^}/]+)\}/g, (_m, k: string) => (given[k] === undefined ? `{${k}}` : String(given[k])));
    if (inlineQuery) path += `?${inlineQuery}`;
    const qEntries = Object.entries(queryParams ?? {}).filter(([, v]) => v !== undefined && v !== null);
    if (qEntries.length) {
      const qs = qEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      path += `${path.includes('?') ? '&' : '?'}${qs}`;
    }
    return { path, missing, unknown };
  };
}

/**
 * 一个**形状完整**的 http 夹具：只给 send，其余必选端口由这里补齐。
 *
 * ## 为什么要有它（而不是每个文件自己写 `{ send, composeUrl, resolveOperation }`）
 *
 * `HttpExec` 的必选方法在长（本轮加了 `composeUrl`）。各文件手搓夹具的代价本轮实测过：
 * 那些写了 `as never` / `as unknown as AdapterRegistry` 的夹具**编译照过、运行时才炸**，
 * 而打印出来的失败写的是各自被测的行为（"重试本身要真的发生"、"证据链接 404"），
 * 一个接线错误伪装成七八种行为缺陷。把补齐动作收在一处之后，
 * 端口再加方法时只改这一行，而且**改的是有类型检查的那一行**。
 *
 * ## 三个端口各自的诚实程度（**别把这里当序列化的证据**）
 *
 *  - `send`：调用方给的，本函数不碰。
 *  - `composeUrl`：见上面 `stubComposeUrl` 那段 —— 扫占位符是真做，值不序列化。
 *  - `resolveOperation`：**回声式**替身。它把 ref 里给的 method/path 原样带出，
 *    `operationId` 缺省时现算一个别名（形状与 `parse.ts` 的别名算法一致）。
 *    ⚠ 因此**凡是要证明"引擎有没有把某个字段交下来"的测试，不许用这个默认值** ——
 *    回声会把"用了解析结果"与"直接用步骤值"算成同一个字符串，变异当场活下来
 *    （`identity.test.ts` 第一轮就是这么活的，那文件因此自备一份两向夹具）。
 *    这里保留它只是因为那些测试确实不碰 openapiCall，而必选项必须给得起。
 */
export function stubHttp(send: HttpExec['send'], over: Partial<HttpExec> = {}): HttpExec {
  return {
    send,
    composeUrl: stubComposeUrl(),
    resolveOperation: async (ref) => ({
      operationId: ref.operationId ?? `alias__${(ref.method ?? 'GET').toLowerCase()}_${(ref.path ?? 'o').replace(/\W+/g, '_')}`,
      method: ref.method ?? 'GET',
      // 相对模板（与真实 parse.ts 一致：urlTemplate === path，baseUrl 由环境提供）
      urlTemplate: ref.path ?? '/o',
      requiredBodyFields: [],
      deprecated: false,
    }),
    ...over,
  };
}

/**
 * 合法定位器的最小写法。
 *
 * `{ intent: '登录按钮' }` 看着够用，但 schema 明确要求 primary / fallbacks /
 * compiledTo 至少之一 —— 「只有意图」的定位器运行时什么也定不到，
 * 拒绝它是对的。测试要测别的规则，就别被这条挡住，所以给个能过的最小体。
 */
export const loc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: '登录按钮',
  primary: { by: 'testid', value: 'login-btn' },
  ...over,
});

/** testid 定位（最便宜的一级，用于不需要定位细节的用例） */
export const tapStep = (id: string, over: Record<string, unknown> = {}): StepDraft => ({
  ...b(id), kind: 'tap', target: loc(over),
});
