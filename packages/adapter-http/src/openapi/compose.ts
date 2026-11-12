/**
 * 把「operation + 参数表」组成一个真正要发出去的 URL —— **全仓唯一一份 URL 组成逻辑**。
 *
 * ## 为什么要有这个文件（以及为什么它在 adapter-http 而不是别处）
 *
 * 改动前的形状是**三份各自演化的序列化实现**：
 *  1. `engine/interpreter.ts` 的 openapiCall 分支：`urlTemplate.replace('{k}', encodeURIComponent(v))`
 *     外加一个用 `URLSearchParams` 拼 query 的 `buildUrl`；
 *  2. `mock/mock.ts` 的 `buildUrlFor`：把 `styleParam` 的两段结果**内联手抄**了一遍；
 *  3. 本层 `openapi/style.ts` 的 `fillPath` / `buildQuery`：真正照 OAS 规范表实现的那份，
 *     而**生产侧一个调用者都没有**（只有测试在调）。
 *
 * 三份的实测分叉（改前的两个 mock 侧形状各跑一遍、与改后逐字节对比，不是推测）：
 *  - **数组查询参数**：引擎发出 `?ids=%5B1%2C2%2C3%5D`（整个 JSON 数组当一个值），
 *    规范侧发出 `?ids=1&ids=2&ids=3`。**IR 里写数组是合法的**
 *    （`queryParams: record(string, Value)`，而 `Value` 含数组），所以这不是理论形状。
 *  - **路径段**：`buildUrlFor` 那一份**根本不编码** —— 同一个 `{id}` 给 `a/b`，
 *    它发出 `/orders/a/b`（凭空多出一段路径，那是另一个接口），给 `张三` 原样发出。
 *    另两份编码（引擎用 `encodeURIComponent`，本层用 `enc`）。
 *  - **查询段**：同一份内联代码改用 `encodeURIComponent`，于是**规范里该留字面量的
 *    分隔符被编掉** —— `form` + `explode=false` 的数组它发 `ids=3%2C4%2C5`，
 *    而规范表那一格是 `ids=3,4,5`。`style.ts` 的 `enc` 注释写的正是这一类
 *    （"编掉之后后端收到一个名叫 id、值为 `3,4,5` 的单参数，行为完全不同却同样 200"）。
 *    一份实现同时犯"该编的不编"和"不该编的编了"两个**相反方向**的错 ——
 *    这不是笔误，是"内联抄一遍"必然丢掉的上下文：抄的人只抄了调用式，没抄编码表为什么长这样。
 *  - **元素含结构字符**：`pipeDelimited` 给 `['a&b','c']`，改前那份发
 *    `?q=a&b|c`，服务端解成 `{q:'a', 'b|c':''}` —— 一个参数劈成两个，第二个键是垃圾。
 *  - **`+`**：查询串里 `+` 会被任何 form 解析器读成空格，改前三份里两份编、一份不编，
 *    而**不编的那一份正是规范侧的 `buildQuery`**（当时 `encQ` 少这一条），
 *    连"照规范实现的那份"也在错 —— 这是本轮把它收成一处的直接理由。
 *
 * 「客户端与 mock 共用同一套序列化规则」这句话当时写在一份**只喂 mock 自己那一侧**
 * 的测试标题上，而它描述的正是没发生的那件事。
 *
 * ## 为什么组成必须发生在 adapter 层（而不是抽个纯模块给引擎用）
 *
 * 一个参数的序列化**由 spec 决定**（`style` / `explode` 来自 operation 的参数表），
 * 而"spec 内容不许进引擎"是 `engine/adapters.ts` 里 `HttpExec.auth` 那段写明的边界
 * （原话：spec 内容进引擎等于把网关语义带进引擎），分层守卫也把 adapter-http
 * 列为"别人不许依赖"。所以引擎只能把**已求值的参数表**交下来，由本层查 spec 组成 URL。
 *
 * 这同时解掉上面第 1 条分叉的根因：`strMap`（引擎那张"IR 值 → 字符串"的表）
 * 的 `JSON.stringify` 是为 **SQL 的 JSON 列**设计的（`IN` 那类），
 * 把它同时用于 HTTP query 就是把 SQL 的值形态当成 HTTP 的值形态。
 * 交**原始值**下来之后，那条 `null → 不落键` 的规则仍然留着（它两边都对），
 * 而 `数组 → JSON 文本` 不再泄漏到 URL 上。
 */
import { buildQuery, fillPath, type ParamStyle } from './style.js';
import type { OperationSpec } from './parse.js';

/**
 * 一个参数在 spec 里的声明（拿不到就是"作者手写的一个值"，走规范默认 style）。
 *
 * `in` 是参数而不是判据：path 与 query 的**默认 style 不同**（simple vs form，
 * 见 `style.ts` 的 `defaultStyle`），所以查表必须带位置 —— 同名同 in 才是同一个参数
 * （fixture 里 `/users` 的 `q` 就是 path 级 string 被 operation 级 array 覆盖那一格）。
 * ⚠ `p.style` 是**裸 string**（parse.ts 只验"是不是字符串"），而 `styleParam` 会对
 * 未知值抛 StyleError —— 那是**故意让它炸**：spec 写错 style 时宁可这一步 error，
 * 也不要猜一种序列化（猜出来的请求与后端期望差多少没人知道）。
 */
function declaredStyle(op: OperationSpec | undefined, name: string, inPos: 'path' | 'query'): { style?: ParamStyle; explode?: boolean } {
  const p = op?.params.find((x) => x.name === name && x.in === inPos);
  return { style: p?.style as ParamStyle | undefined, explode: p?.explode };
}

export interface ComposedUrl {
  /** 只有 path + query，不含 baseUrl（拼接由调用方那侧做，baseUrl 是环境的事） */
  path: string;
  /** path 模板里声明了、但参数表里没给的占位符名 */
  missing: string[];
  /** 参数表里给了、而模板里没那个占位符的名字（拼错的 pathParams） */
  unknown: string[];
}

/**
 * 按 spec 组成 URL。
 *
 * `op` 可以是 undefined：那是"这个请求在 spec 里定位不到"（纯 `http` 步骤从来不带
 * operation，`openapiCall` 也可能只写了 method+path 而 spec 里没有）。
 * 此时**参数仍要按规范默认值序列化**（query=form+explode、path=simple），
 * 而不是退回某一整套旧行为 —— 默认值本身是规范规定的，不是我们发明的。
 *
 * ⚠ 这里**不报错也不静默填**缺的占位符：`missing` / `unknown` 交回调用方，
 * 因为"该报什么错、报成哪个 cause"是引擎的判断（用例写坏了 → case-stale），
 * 而本层不认识步骤。少这一层交接的话，`{id}` 会被原样发出去换来一个查不出原因的 404。
 *
 * 返回同步值，而端口 `HttpExec.composeUrl` 是 async 的 —— 适配层 `asHttpExec`
 * 的 `async composeUrl(...)` 天然满足"同步实现塞进 async 签名"（async 函数返回
 * Promise，同步值照样能 resolve）。这一半同步是实现细节，不在端口上承诺。
 */
export function composeUrl(
  template: string,
  op: OperationSpec | undefined,
  args: { pathParams?: Record<string, unknown>; queryParams?: Record<string, unknown> },
): ComposedUrl {
  /*
   * **模板自己可能已经带了一段 query**（纯 `http` 步骤写 `url: '/a?x=1'` 是合法的，
   * 改前那个 `buildUrl` 靠 `base.includes('?') ? '&' : '?'` 处理这件事）。
   * 不在这里拆开的话，参数表里的 query 会拼出第二个 `?`，
   * 而后端把 `?` 之后的整段当**一个键**读 —— 一个安静的错请求。
   * 拆出来的那段原样保留（作者手写的就是他要的字节，我们不重排也不重编码），
   * 新的参数接在它后面。
   */
  const qAt = template.indexOf('?');
  const pathPart = qAt < 0 ? template : template.slice(0, qAt);
  const inlineQuery = qAt < 0 ? '' : template.slice(qAt + 1);

  const { url: path, missing } = fillPath(
    pathPart,
    new Map(Object.entries(args.pathParams ?? {})),
    (name) => declaredStyle(op, name, 'path'),
  );
  const items = Object.entries(args.queryParams ?? {}).map(([name, value]) => ({ name, value, ...declaredStyle(op, name, 'query') }));
  const query = buildQuery(items);

  /*
   * 占位符要扫**整段模板**，不能只扫 path 那半段 —— "占位符只可能出现在路径里"
   * 这个假设不成立：`url: '/users?tag={t}'` 是合法的 IR 写法，而手写 query 段
   * 走的是上面那条"作者写的字节原样保留"，于是 `{t}` **一路发到线上**。
   *
   * 改前的实测结论值得原样记下来，因为它不是 error 也不是 fail，是 **pass**：
   * 那条用例发出去的是 `/orders?tag={t}`，mock 回 200，步骤判过。
   * 这是 docs/08 §3 里"最贵的一种绿"的又一例 —— 请求发出去了、状态码对了、
   * 结构也对，而它测的是**字面量 `{t}` 的查询**。判据与旁边那条一样：
   * **占位符不许出现在真实请求里**（发出去要么换一个查不出原因的 404，
   * 要么更糟 —— 换一个安静的 200）。
   *
   * ⚠ 手写 query 段里的占位符**刻意不由 pathParams 填，也不因 query 里给了同名而豁免**：
   * `pathParams` 在 spec 里是 `in: path` 那一批，拿它去填查询串等于平台自己发明一种
   * 参数位置；而 `query: {t:'V'}` 配 `url: '…?tag={t}'` 时，手写那段是原样保留的，
   * 填进去只会得到 `?tag={t}&t=V` —— **字面量与真值各发一份**，比不填更糟。
   * 所以这些名字**一律进 missing** 交回调用方报错：手写占位符在这条路上没有填法，
   * 要么改用 `query` 而 url 里别写 `{}`，要么改用 openapiCall。
   */
  const missingInline = [...new Set([...inlineQuery.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!))];

  /*
   * 已给了而模板里没有的 path 参数：要报（静默忽略 = "参数没生效而请求照样 200"）。
   * 判据是"模板里到底有哪些占位符"，与 missing 反着算不成（填上的那些两边都不出现）。
   *
   * ⚠ `known` 刻意只扫 **path 那半段**（改成扫整段模板看着更"全面"，实际会把话说明白
   * 的反方向）：`pathParams` 只能填路径占位符，所以 `pathParams: {t}` 配
   * `url: '/u?tag={t}'` 时那个 `t` **确实没填任何东西** —— 报"不在占位符里"是对的，
   * 而扫整段会把它算成认识的名字，于是只剩 missing 那句
   * "pathParams 里没给这些"，而**作者明明给了**，只是给错了位置。
   */
  const known = new Set<string>();
  for (const m of pathPart.matchAll(/\{([^}/]+)\}/g)) known.add(m[1]!);
  const unknown = Object.keys(args.pathParams ?? {}).filter((k) => !known.has(k));

  /*
   * 三段拼成一个查询串尾巴。写成显式三分支而不是嵌套三元：
   * 这里四种组合（有无手写 query × 有无参数表 query）里，"两个都有"必须用 `&` 接、
   * "只有手写那段"要保留 `?`、"只有参数表"由 buildQuery 自带 `?` ——
   * 压成一个表达式很容易把"都有"接成 `?a=1?b=2`，而后端把第二个 `?` 之后
   * 整段当成一个键，于是又是一个安静的错请求。
   */
  let tail = '';
  if (inlineQuery && query) tail = `?${inlineQuery}&${query.slice(1)}`;
  else if (inlineQuery) tail = `?${inlineQuery}`;
  else tail = query;
  /*
   * `missing` 在这里去重：`fillPath` 是**按出现次数**记的 —— 实测 `/a/{id}/b/{id}`
   * 交回来的是 `['id','id']`。而这个数组是拿去拼报错用的，两个一样的名字
   * 读起来像"有两个不同的东西没填"，人会去找第二个占位符而它不存在。
   * 不在 `fillPath` 里改：它那边"缺在第几处"也许是将来的信息，
   * 而**这一层**要的是"缺哪些名字"这一个集合 —— 判据不同就各自算，别互相迁就。
   */
  return { path: path + tail, missing: [...new Set([...missing, ...missingInline])], unknown };
}
