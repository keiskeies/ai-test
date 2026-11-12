/**
 * store 包测试夹具。
 *
 * 这里**不 import engine 的 helpers**，而是走 engine 的公开导出（b/scen 由 index 导出？见下）——
 * engine 的 test/helpers.ts 不在 package exports 里，`@atest/engine/test-helpers` 会解析失败。
 * 所以这里自带一份最小版本；两份都极薄（填 zod 默认值 + 冻结时钟），
 * 漂移风险可忽略，而为了能 import 去给 engine 加一个"测试专用导出面"
 * 会诱导别人往生产 exports 里塞测试代码。
 */
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock, runScenario, type AdapterRegistry, type HttpExec, type RunReport } from '@atest/engine';

export type { StepDraft } from '@atest/ir';

export const b = (id: string): { id: string } => ({ id });

/**
 * `HttpExec.composeUrl` 的桩。**占位符扫描照真做，值的序列化不做。**
 *
 * 与 `engine/test/helpers.ts` 里那份是同一份逻辑抄两遍 —— 这个"抄两遍"是**明知故犯**，
 * 理由写在本文件开头那段（engine 的 `exports` 只暴露 `dist/index.js`，
 * 为了一个夹具去开测试导出面，等于把引擎的测试内部形状变成对外契约）。
 *
 * 为什么不能写成 `async ({ urlTemplate }) => ({ path: urlTemplate, missing: [], unknown: [] })`：
 * `missing` / `unknown` 在引擎那两个 `case-stale` 分支里有消费者，恒空数组会让它们
 * 在本包的载体里**永远走不到**（docs/08 §3(e) 那一格：载体有了、供数的人一个都没有）。
 * 本包那三个 http 夹具的 urlTemplate 是 `/x` 或完整 URL，确实没有占位符可扫，
 * 但判据要**真算**才会在将来有人写出带占位符的夹具时继续成立。
 *
 * 序列化（数组展开、`|` 分隔、`+` 编码）这里刻意不做 —— 本包测的是证据落盘，
 * 那是序列化，判错也不会被本包看见。序列化的载体在
 * `adapter-http/test/engine-e2e.test.ts`（真 adapter + 真 mock，两条改前是红的）。
 */
export const stubComposeUrl = (): HttpExec['composeUrl'] => async ({ urlTemplate, pathParams, queryParams }) => {
  /*
   * 路径那半段与手写的 query 段**分开算**，与 `engine/test/helpers.ts` 里那份同步：
   * 手写 query 段里的 `{}` **一律算没填**，因为 `composeUrl` 现在就是这么判的
   * （改前它把字面量 `{t}` 原样发出去而步骤判 pass）。桩比生产宽松的话，
   * 引擎侧写出这种形状的夹具会"在桩这儿过、在真 adapter 那儿炸"。
   */
  const qAt = urlTemplate.indexOf('?');
  const pathPart = qAt < 0 ? urlTemplate : urlTemplate.slice(0, qAt);
  const inlineQuery = qAt < 0 ? '' : urlTemplate.slice(qAt + 1);
  const given = pathParams ?? {};
  const missing = [...pathPart.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!)
    .filter((k) => given[k] === undefined || given[k] === null);
  missing.push(...new Set([...inlineQuery.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!)));
  // known 只扫 path 那半段（与 compose.ts 同）：pathParams 只填路径占位符
    const known = new Set([...pathPart.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  let path = pathPart.replace(/\{([^}/]+)\}/g, (_m, k: string) => (given[k] === undefined ? `{${k}}` : String(given[k])));
  if (inlineQuery) path += `?${inlineQuery}`;
  const q = Object.entries(queryParams ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (q.length) path += `${path.includes('?') ? '&' : '?'}${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
  return { path, missing, unknown };
};

export function scen(body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario {
  return defineScenario({
    schemaVersion: '1', id: 'scn.store', name: 'store test scenario',
    env: { environmentRef: 'unit' }, body, ...extra,
  } as ScenarioDraft);
}

export async function run(s: Scenario, over: { adapters?: AdapterRegistry } = {}): Promise<RunReport> {
  return runScenario({
    scenario: s, adapters: over.adapters ?? {}, clock: deterministicClock(42),
    env: { baseUrl: 'https://api.test' },
  });
}

/**
 * 形状完整的 http 夹具：调用方只给 send，另外两个必选端口由这里补齐。
 *
 * 与 `engine/test/helpers.ts` 里那份同构（抄两遍这件事的理由见本文件开头）。
 * 收在一处治的是本轮实测到的那个失败模式：`HttpExec` 加必选方法后，
 * 各文件手搓 + `as never` 的夹具**编译照过、运行时才炸**，
 * 而打印出来的失败写的是各自被测的行为（"证据包里少了东西"），
 * 一个接线错误伪装成被测缺陷。端口再加方法时只改这一行，改的是有类型检查的那一行。
 */
export function stubHttp(send: HttpExec['send'], over: Partial<HttpExec> = {}): HttpExec {
  return {
    send,
    composeUrl: stubComposeUrl(),
    // 回声式替身：本包没有任何测试看 openapiCall 的解析结果，所以它只需要
    // **形状对**。（"引擎有没有把某字段交下来"那类判据在 engine 的 identity.test.ts，
    // 那里刻意不用回声，理由写在那个大文件头上。）
    resolveOperation: async (ref) => ({
      method: ref.method ?? 'GET',
      urlTemplate: ref.path ?? '/x',
      requiredBodyFields: [],
      deprecated: false,
    }),
    ...over,
  };
}
