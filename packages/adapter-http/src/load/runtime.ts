/**
 * 压测那两条路**共用**的语义核心，以及两个"走一遍计划"的调度器。
 *
 * ## 为什么这里有两个调度器，而这不是"写了两份"
 *
 * k6 的 VU 代码跑在 goja 里，**不支持 async/await**（Promise 在那儿不会 resolve），
 * 而内置后端要用 `fetch`，必须是 async。同一个循环没法既是同步又是异步。
 *
 * 所以拆开的是**调度**（`walkSyncK6` / `walkAsyncBuiltin` 两个函数，紧挨着写在一起），
 * 而所有**语义**都只有一个函数：
 *   buildLoadRequest   值求值 + 按 spec 拼 URL + 鉴权头 + 请求体/表单
 *   applyLoadResponse  导出 `$.steps.<id>.resp`、判这一步过没过
 *   decideCondition    `if` / `when` / `waitOnce` 的布尔判定
 *   itemsOf            `forEach` 的条目
 * 两个调度器除了 await 的位置不同，调的是同一批函数 —— 这与解释器/预编译形态
 * 那条老规矩一致（`executor.ts` 头上：「语义共用靠"调同一个函数"，不靠两份写得很像的代码」）。
 *
 * ## 同步那个调度器**在本机可测**，这是本文件存在的第二理由
 * `walkSyncK6` 是普通的同步 JS，它的 http 是**注入**的。于是测试可以在 Node 里
 * 拿一个记录用的假 http 跑它，再拿真 fetch 跑 `walkAsyncBuiltin`，
 * 把两边**实际发出的请求**逐字段比 —— 两个调度器一有分叉就红。
 * 这条性质是 `test/load-parity.test.ts`，它不需要 k6。
 *
 * ## 不在这儿做的事
 * 计时、VU 编排、分位数聚合、落盘 —— 那些是 `press.ts` 与 CLI 的活。
 * 本文件里**没有** setTimeout / fetch / fs，所以它能整份打进 k6 的预lude（见 load-entry.ts）。
 */
import type { Clock } from '@atest/engine';
import { VarSpace, compileExpr, evalStructAssert, joinBaseUrl, queryOne, resolveValue, strMap, truthy, valueMap } from '@atest/engine';
import { composeUrl } from '../openapi/compose.js';
import type { LoadNode, LoadPlan } from './plan.js';

/** 发出去的那个请求。字段与 `HttpExec.send` 对齐，但值是**已经求完的** */
export interface BuiltRequest {
  stepId: string;
  method: string;
  /** 已含 baseUrl 与 query 的完整地址 */
  url: string;
  headers: Record<string, string>;
  /** JSON 体的**文本**（undefined = 没有体） */
  body?: string;
  /** 表单体（与 body 互斥；两边都有在编译期就该被拦住） */
  form?: Record<string, string>;
  timeoutMs: number;
  /**
   * 响应体上限。**必须带出来**：它是 IR 的 maxResponseBytes 编进计划的那一维，
   * 而"字段在计划里而两个后端都不读"就是 docs/08 §3(f) 那一格（有载体、没有生产者）——
   * 症状是压一整晚后施压侧 OOM，而报告看起来像"压测自己崩了"。
   */
  maxBytes: number;
  followRedirects: boolean;
}

/** 回来的那个响应。刻意只留判据要用的四样，两个后端都能填 */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** 端到端耗时，由**调用方**测（本文件不计时，因为两边的计时原语不同） */
  ms: number;
  /** 传输层失败（连不上/超时/被重置）。没有响应时也要报一条观测，否则错误率会漏计 */
  transportError?: string;
  /**
   * 响应体被 maxBytes 截断过。
   *
   * **它不改失败判定**（截断是施压侧的限制，不是后端的错），但它解释了接下来必然发生的
   * 那件事：`applyLoadResponse` 里 `JSON.parse` 会失败、导出 `body: undefined`，
   * 于是引用 `$.step.x.body.*` 的断言没过并计入错误率。没有这个标记时，报告上那句
   * "错误率 40%"的下一句会是"后端返回结构变了"，而真相是"响应太大，压测形态没读完"。
   */
  truncated?: boolean;
}

/** 一次迭代的可变状态。每个 VU 每轮一份。 */
export interface LoadState {
  vars: VarSpace;
  /** 这一轮有没有失败（断言没过 / 状态码不对 / 传输失败） */
  failed: boolean;
  /**
   * 每一步的最后一句结论，供报告与排查用（**不是**分位数，那是聚合侧的活）。
   *
   * `fromRequest` 标的是"这句就是某个请求的失败本身"（状态码不对 / 传输层炸了），
   * 而不是"某个请求失败之后连带没过的东西"。压测后端按**观测**给每个请求记一次账，
   * 再遍历 notes 补上非请求类的失败（断言没过、extract 取不到、wait 判不了）。
   * 没有这个标记的话，一个 404 会被记**两次**同样的 `HTTP 404`，
   * 于是错误率旁边那个"（N 次）"是实际失败请求数的两倍 —— 而排查时
   * "偶发 2 个"与"普遍 4 个"读出来是两个完全不同的结论。
   * 为什么不用字符串匹配 `HTTP \d+` 去重：那是把判据架在**文案**上，
   * 改一次措辞就悄悄恢复双计（与 unread-fields 那侧"不许拿散文当判据"同一条）。
   */
  notes: Array<{ stepId: string; ok: boolean; why?: string; fromRequest?: boolean }>;
}

/** 注入给语义核心的那几样。鉴权在两侧走的是同一个 `applyAuth`（由调用方给） */
export interface LoadDeps {
  clock: Clock;
  baseUrl: string;
  /**
   * 把鉴权意图变成真的头。**内置后端传 adapter-http 的那个 `applyAuth`**，
   * k6 侧传一个从 `__ENV.ATEST_SECRET_*` 读的版本。
   * 密钥真值只在这一个回调里出现过，不落任何生成物（见 emit-k6 的文件头）。
   */
  auth(req: BuiltRequest, node: Extract<LoadNode, { op: 'press' }>): Promise<void> | void;
  /** 请求体是否符合 spec。返回不符合的原因；不注入就当没开这个检查 */
  validate?(node: Extract<LoadNode, { op: 'press' }>, body: unknown): Promise<string[] | undefined> | string[] | undefined;
  /** 环境指纹里那一维：spec 是否可信（决定响应侧校验做不做，与解释器同一个开关） */
  specAuthoritative?: boolean;
}

/**
 * 一次迭代的状态。`inputDefs` 与 `resolveDefault` 这一对**照抄 `FastState`**
 * （executor.ts 里预编译形态那一份），为的是同一条性质：
 * IR 里 `inputs:[{name:'q', default:'DEF'}]` 在功能回归、预编译、压测三条路上
 * 都得出 DEF。少传 inputDefs 的表现是压测报 `引用未定义（变量：$q）`
 * 而功能回归能跑过 —— 同一份 IR 两种行为。
 */
export function newLoadState(
  inputs: Record<string, unknown>, env: Record<string, unknown>, inputDefs: readonly unknown[], clock: Clock,
): LoadState {
  return {
    // 与解释器同一个 VarSpace。inputs 的 default 兜底、步骤导出、循环变量销毁
    // 全是它的行为 —— 自己写一个 Map 就是本仓那一族缺陷的标准起点。
    vars: new VarSpace({
      inputs, env, inputDefs: inputDefs as never[],
      resolveDefault: (def, vars) => resolveValue(def.default, { vars, clock }),
    }),
    failed: false,
    notes: [],
  };
}

/**
 * 一个 press 节点 -> 一个真请求。**两个后端唯一的请求构造出口。**
 *
 * ## 为什么这里是一个同步核 + 两个薄壳，而不是一个 async 函数
 *
 * 写这份代码的第一版只有异步的 `buildLoadRequest`，同步调度器用一个 `takeSync()`
 * 去"取它的同步结果"。**那一版在 k6 那条路上一个请求都发不出去**：`async` 函数
 * **总是**返回微任务里 resolve 的 Promise，所以"它是不是已经同步跑完了"这个判据
 * **恒为假** —— 每一个 press 节点都抛那句"鉴权必须是同步实现"，包括鉴权回调
 * 明确是同步的（`emit-k6.ts` 里那个就是）情况。
 * 改前实测的是一条最普通的 GET：`walkSyncK6` 抛错、`sent` 是空数组；
 * 改后由 `test/load-parity.test.ts` 开头那条非空自检钉着（同步侧一个请求都不发就红），
 * `test/load-k6.test.ts` 再从**生成的脚本真跑一遍**那一侧钉一次。
 * 那句守卫防的东西是真的（异步鉴权在 goja 里确实永远不 resolve），
 * 但它挂错了位置：它防的是**回调返回 Promise**，而它实际拦的是"构造函数是 async"。
 *
 * 所以现在的形状是：**同步的核**（求值 + 拼 URL + 组体）+ 两个只在"怎么处置回调
 * 返回值"上不同的薄壳。异步鉴权在 k6 那条路上仍然抛，而抛的条件回到了它本来该管的
 * 那一格：**回调真的返回了 Promise**。
 *
 * ## 这里做的事与解释器里 `http` / `openapiCall` 那两段**逐项对应**
 * valueMap 求值 query/pathParams（保形，数组还是数组）、strMap 求 headers（头的值只能是字符串）、
 * composeUrl 按 spec 的 style/explode 序列化、missing/unknown 占位符**报错不发**、
 * body 与 formData 互斥。缺任何一项都会变成"发出去的值不是用例里写的那个值而用例照绿" ——
 * 那一族在 `interpreter.ts` 的 composeUrl 注释里记了三次。
 */
function prepareLoadRequest(node: Extract<LoadNode, { op: 'press' }>, st: LoadState, deps: LoadDeps): { req: BuiltRequest; bodyVal: unknown } {
  const scope = { vars: st.vars, clock: deps.clock };
  const resolve = (v: unknown): unknown => resolveValue(v, scope);
  const pathParams = valueMap(node.pathParams, resolve);
  const queryParams = valueMap(node.queryParams, resolve);
  const headers = strMap(node.headers, resolve);
  // composeUrl 要的是 OperationSpec 形状的 params；计划里带的是它实际读的那几个字段
  const composed = composeUrl(node.urlTemplate, node.operation as never, { pathParams, queryParams });
  if (composed.missing.length || composed.unknown.length) {
    // 与解释器同一句话的两个半：**同一个笔误的两面**，只报一半会让人改了还是坏的
    const parts: string[] = [];
    if (composed.missing.length) parts.push(`URL 里还有未填的参数：${composed.missing.map((m) => `{${m}}`).join('、')}`);
    if (composed.unknown.length) parts.push(`pathParams 里的 ${composed.unknown.map((k) => `"${k}"`).join('、')} 不在 ${node.urlTemplate} 的占位符里`);
    throw new LoadPressError(`${node.id}: ${parts.join('；')}`, node.id);
  }
  const bodyVal = node.body === undefined ? undefined : resolve(node.body);
  const form = Object.keys(node.formData).length ? strMap(node.formData, resolve) : undefined;
  const req: BuiltRequest = {
    stepId: node.id,
    method: node.method,
    url: joinBaseUrl(deps.baseUrl, composed.path),
    headers,
    ...(bodyVal === undefined ? {} : { body: typeof bodyVal === 'string' ? bodyVal : JSON.stringify(bodyVal) }),
    ...(form ? { form } : {}),
    timeoutMs: node.timeoutMs,
    maxBytes: node.maxBytes,
    followRedirects: node.followRedirects,
  };
  return { req, bodyVal };
}

/** 校验没过就抛。话术只在这一处（两个薄壳共用，否则两边的同一件事会说成两句话） */
function throwOnViolations(node: Extract<LoadNode, { op: 'press' }>, violations: readonly string[] | undefined): void {
  if (violations?.length) throw new LoadPressError(`${node.id}: 请求体不符合 spec（发送前拦截）：${violations.join('; ')}`, node.id);
}

/**
 * **同步**构造（k6 那条路）。回调返回 Promise 就抛 —— 坏法必须是"这一轮没打请求"，
 * 而不是"发了一个没鉴权/没校验的请求"（后者会打出一条看起来像权限配置坏了的曲线）。
 */
function buildLoadRequestSync(node: Extract<LoadNode, { op: 'press' }>, st: LoadState, deps: LoadDeps): BuiltRequest {
  const { req, bodyVal } = prepareLoadRequest(node, st, deps);
  // 请求侧校验：开了才做，而**负向策略在编译期已经把 validate 置 null**
  // （那一刻故意发不合法的请求去看后端拒不拒绝，一律拦等于作废最有价值的一类用例）
  if (node.validate && deps.validate) {
    const out = deps.validate(node, bodyVal);
    if (isThenable(out)) throw asyncOnly(node.id, '请求校验');
    throwOnViolations(node, out);
  }
  if (isThenable(deps.auth(req, node))) throw asyncOnly(node.id, '鉴权');
  return req;
}

/** **异步**构造（内置后端）。与同步版只差"回调返回值要不要 await"这一件事。 */
export async function buildLoadRequest(node: Extract<LoadNode, { op: 'press' }>, st: LoadState, deps: LoadDeps): Promise<BuiltRequest> {
  const { req, bodyVal } = prepareLoadRequest(node, st, deps);
  if (node.validate && deps.validate) throwOnViolations(node, await deps.validate(node, bodyVal));
  await deps.auth(req, node);
  return req;
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

function asyncOnly(stepId: string, what: string): LoadPressError {
  return new LoadPressError(
    `${stepId}: k6 那条路的${what}必须是**同步**实现（返回 Promise 的话在 goja 里永远不会 resolve）。`
      + '内置后端没有这个限制 —— 要异步鉴权（oauth2 取 token）请用内置后端',
    stepId,
  );
}

/** 发出去失败了（传输层）。**也要导出一份响应**，否则下一步引用 `$.steps.x.resp` 会报"变量不存在"而不是"上一步传输失败" */
export function applyLoadFailure(node: LoadNode, res: RawResponse, st: LoadState): void {
  st.failed = true;
  st.notes.push({ stepId: node.id, ok: false, why: res.transportError ?? `HTTP ${res.status}`, fromRequest: true });
  if (node.op === 'press') {
    st.vars.exportStep(node.id, {
      resp: { status: res.status, body: undefined, bodyText: res.bodyText, headers: res.headers, durationMs: res.ms },
      status: res.status, body: undefined,
    });
  }
}

/**
 * 响应回来了：导出 + 判这一步过没过。
 *
 * "过没过"的判据与功能形态**不同**这一点要写白：功能形态里 5xx 通常是 error（环境问题），
 * 压测形态里它是**被测系统的错误率本身**，判 failed 并计入错误率。
 * 反过来若把 5xx 当"环境问题"跳过，压测就永远测不出过载下的错误率 —— 那是这条曲线最没用的版本。
 */
export function applyLoadResponse(node: Extract<LoadNode, { op: 'press' }>, res: RawResponse, st: LoadState, deps: LoadDeps): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText) as unknown;
  } catch {
    parsed = undefined;
  }
  st.vars.exportStep(node.id, {
    resp: { status: res.status, body: parsed, bodyText: res.bodyText, headers: res.headers, durationMs: res.ms },
    status: res.status,
    body: parsed,
  });
  if (node.saveAs) st.vars.set(node.saveAs, parsed);
  // 截断要留一句**在这里**的话。不留的话下游断言没过时报的是"引用不到 body.token"，
  // 而真相是"响应超过 maxBytes，压测形态只读了前 N 字节" —— 前者会让人去查后端，
  // 后者只需要把上限调大（与功能形态的 truncated 同一个理由）
  if (res.truncated) {
    st.notes.push({ stepId: node.id, ok: res.status >= 200 && res.status < 400, why: `响应超过 ${node.maxBytes} 字节被截断，body 可能取不全（要判正文就调大 maxResponseBytes）` });
  }
  const ok = res.status >= 200 && res.status < 400;
  if (!ok) {
    st.failed = true;
    st.notes.push({ stepId: node.id, ok: false, why: `HTTP ${res.status}`, fromRequest: true });
  }
  void deps;
}

/** `if` / `when` / `waitOnce` 的布尔判定。**两侧同一个函数** */
export function decideCondition(expr: string, st: LoadState, deps: LoadDeps): boolean {
  return truthy(compileExpr(expr).eval({ root: st.vars.asExprRoot(), vars: st.vars.visible(), now: deps.clock.now }));
}

/**
 * 条件树里谓词的判定（waitOnce 用）。其余要外部能力的谓词在编译期已被拒。
 *
 * ## 三种复合键，而**判不了**是一个独立的第三值
 * 返回值是三态而不是布尔：`true` / `false` / `undefined`（判不了）。
 * 只返回布尔的话，noneOf 就没法正确算 —— `noneOf[X]` 在 X 判不了时该是什么？
 *  - 当 `true`（"X 不成立"）→ 一条判不了的等待变成**条件成立、继续跑**，
 *    这是这一族最贵的那种静默通过；
 *  - 当 `false` → 触发 onTimeout，至少有人看得见。
 * 但把"X 不成立"与"X 判不了"合成同一个 `false` 再取反，两个方向就同时错了：
 * `{noneOf:[{type:'expr',expr:'0'}]}`（子条件明确不成立）本该是 `true`，
 * 被合成 false 之后就成了假红。所以这里分开三态，让顶层那一句
 * （`decidePredicate(...)` 的调用方 `waitOnce` 分支）**只在真的判不了时**才当假。
 *
 * 复合键的名字来自 waits.ts 的 WaitPredicateSchema：allOf / anyOf / noneOf。
 * 本函数从前写的是 `not`，而那一支在 schema 里不存在（实测被 safeParse 拒），
 * 于是整棵 noneOf 树落到兜底、恒判 false —— 见 ir/src/load.ts 里同一条记录。
 */
export function decidePredicate(cond: unknown, st: LoadState, deps: LoadDeps): boolean | undefined {
  const o = (cond ?? {}) as Record<string, unknown>;
  if (o.type === 'expr' && typeof o.expr === 'string') return decideCondition(o.expr, st, deps);
  if (o.type === 'httpStatus') {
    const ref = st.vars.resolveRef(String(o.ref ?? ''));
    const status = Number((ref.value as { status?: unknown } | undefined)?.status ?? NaN);
    // 引用不到 / 状态码不是数字 => **判不了**，而不是"不在名单里"。
    // 后者的下场是 onTimeout，而"上一步没跑"与"上一步回了别的码"是两件事
    if (!ref.found || Number.isNaN(status)) return undefined;
    return Array.isArray(o.in) && o.in.some((x) => Number(x) === status);
  }
  if (Array.isArray(o.allOf)) {
    const kids = o.allOf.map((k) => decidePredicate(k, st, deps));
    // 有一个明确不成立就是 false（短路，不必等其余）；有判不了的而没人明确 false => 判不了
    if (kids.some((k) => k === false)) return false;
    return kids.some((k) => k === undefined) ? undefined : true;
  }
  if (Array.isArray(o.anyOf)) {
    const kids = o.anyOf.map((k) => decidePredicate(k, st, deps));
    if (kids.some((k) => k === true)) return true;
    return kids.some((k) => k === undefined) ? undefined : false;
  }
  if (Array.isArray(o.noneOf)) {
    const kids = o.noneOf.map((k) => decidePredicate(k, st, deps));
    if (kids.some((k) => k === true)) return false;
    // 没有一条成立：全都明确 false 才是 true；有判不了的那一条就整体判不了
    return kids.some((k) => k === undefined) ? undefined : true;
  }
  // 认不出的形状：**判不了**（交回顶层当假并触发 onTimeout），
  // 而不是"条件成立、继续跑" —— 后者会把一条判不了的等待变成静默通过
  return undefined;
}

/**
 * `waitOnce` 那一格的完整处置。**两个调度器调这同一个函数** ——
 * 它俩本来各自内联写着同样的四行（抛 / 判 failed 并停 / 继续），
 * 而"两份写得很像的代码"正是本文件头上点名要消灭的形状：
 * 语义共用靠调同一个函数，不靠相似。
 *
 * 返回值 = "还要不要往下走"（false = 这一轮结束）。
 */
export function applyWaitOnce(node: Extract<LoadNode, { op: 'waitOnce' }>, st: LoadState, deps: LoadDeps): boolean {
  const verdict = decidePredicate(node.condition, st, deps);
  if (verdict === true) return true;
  // 三种 onTimeout 与功能形态同名，而**语义不同**这一条要写白：
  // 功能形态这里是"轮询到超时"，压测形态是"一次判过没过"（docs/04 那张刻意的不一致表）。
  // 判不了（verdict undefined）与判过是假走同一条路：两者都该有人看见，
  // 而"静默当成没等"是这一族最贵的下场。区别进消息里，不另开一条分支。
  const why = verdict === undefined
    ? `${node.id}: wait 的条件在压测形态判不了（谓词形状不认识或引用不到值），而压测不轮询`
    : `${node.id}: wait 条件一次判过没过（压测形态不轮询）`;
  if (node.onTimeout === 'error') throw new LoadPressError(why, node.id);
  if (node.onTimeout === 'fail') {
    st.failed = true;
    st.notes.push({ stepId: node.id, ok: false, why });
    return false;
  }
  // 'continue'：**这里必须留一句 note**。静默继续是最难查的一种降级 ——
  // 报告里只有一个"这条用例跑过了"，而那条等待其实什么都没等。
  st.notes.push({ stepId: node.id, ok: true, why: `${why}；onTimeout=continue，本步按没等处理` });
  return true;
}

/** `forEach` 的条目。undefined 与"空数组"要分开：前者是用例写坏了（拼错变量名） */
export function itemsOf(expr: string, st: LoadState, deps: LoadDeps): unknown[] {
  const v = compileExpr(expr).eval({ root: st.vars.asExprRoot(), vars: st.vars.visible(), now: deps.clock.now });
  if (v === undefined) throw new LoadPressError(`forEach 的 items 求值为 undefined：这个变量不存在（拼写？还没 set/extract？）`, expr);
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

/** 一个非 press 节点的本地动作。返回"是否继续往下走"（false = 这一轮结束） */
function runLeaf(node: LoadNode, st: LoadState, deps: LoadDeps): boolean {
  switch (node.op) {
    case 'set':
      for (const [k, v] of node.assign) st.vars.setDeep(k, resolveValue(v, { vars: st.vars, clock: deps.clock }));
      return true;
    case 'extract': {
      const src = st.vars.resolveRef(node.from);
      for (const r of node.rules) {
        if (r.mode !== 'jsonpath') {
          // regex/header 在压测里**故意不支持**：它们要原始响应文本，而压测形态不存响应体
          throw new LoadPressError(`${node.id}: extract 的 ${r.mode} 模式在压测形态不支持（只支持 jsonpath）`, node.id);
        }
        const hit = src.found ? queryJson(src.value, r.path) : undefined;
        if (hit === undefined && r.required) {
          st.failed = true;
          st.notes.push({ stepId: node.id, ok: false, why: `extract 取不到 ${r.path}（源 ${node.from} ${src.found ? '存在' : '不存在'}）` });
        }
        st.vars.set(r.var, hit);
      }
      return true;
    }
    case 'assert': {
      const r = evalStructAssert(node.payload as never, {
        vars: st.vars,
        resolveValue: (v: unknown) => resolveValue(v, { vars: st.vars, clock: deps.clock }),
        adapters: {}, clock: deps.clock, addCost: () => {}, emit: () => {},
        ctx: {
          target: 'api', runId: 'load', env: {}, secret: () => '', clock: deps.clock,
          emit: () => {}, capabilities: () => undefined,
          // 压测不产证据。抛而不是返回 ''：返回空串会让调用方以为存成功了
          saveArtifact: async () => { throw new Error('压测形态不产证据（热路径跳过落盘）'); },
        },
      });
      if (r.status !== 'pass') {
        st.failed = true;
        st.notes.push({ stepId: node.id, ok: false, why: r.summary });
      }
      return true;
    }
    case 'fail':
      st.failed = true;
      st.notes.push({ stepId: node.id, ok: false, why: node.reason });
      return false;
    case 'log':
    case 'noop':
      // log 在压测里**不打印**：1000 VU × 每轮一行的 stdout 会把日志刷成不可读，
      // 而"刷不动日志"的下一个动作是有人把日志关掉 —— 那时真信息也没了。
      return true;
    default: {
      // **抛，而不是 return true。** 到这儿意味着这个 op 两个调度器都没有分支、
      // 也不是本地叶子，于是它会**被静默跳过**。
      //
      // 为什么这一格要紧（而它此前是 `return true`）：两个调度器的 default 都调本函数，
      // 所以"给 LoadNode 加一个 op 而忘了在两个调度器里加分支"在下发后的表现是
      // **两边都跳过它** —— 不发请求、不记结论、不抛错，于是
      // `load-parity.test.ts` 逐字段比发出的请求时**两边一致**、全绿，
      // 而用例里那一步在压测里根本不存在（负载比用例描述的轻，曲线照画）。
      // 这是 docs/08 §3(a)「有载体、没有生产者」在这一层唯一的入口，也是
      // **两个后端一起错**这种 parity 测试结构上抓不到的那种错。
      // 现在它会以一句点名 op 的错终止这一轮，而 `load-plan.test.ts` 里那条
      // **从编译产物里现取 op 清单**的测试会当场红（不是从一份手抄的 op 名单取 ——
      // 那份名单本身就是这一族缺陷的下一个入口）。
      const t = node as LoadNode;
      throw new LoadPressError(
        `压测运行时没有处理这个节点：op=${t.op}（两个调度器与本地叶子都没分支）。`
        + '加一个 op 就必须同时加 walkSyncK6 与 walkAsyncBuiltin 的分支 —— '
        + '只加一个的下一站是"两个后端对同一份计划做出不同的事"',
        t.id,
      );
    }
  }
}

/**
 * **同步**调度器（给 k6）。
 *
 * `send` 是同步的：k6 的 `http.request` 就是同步的。内置后端不用这个函数。
 */
export function walkSyncK6(
  nodes: readonly LoadNode[],
  st: LoadState,
  deps: LoadDeps,
  send: (req: BuiltRequest) => RawResponse,
  aborted?: () => boolean,
): void {
  for (const node of nodes) {
    if (aborted?.()) return;
    if (node.op === 'when') {
      if (!decideCondition(node.condition, st, deps)) { st.vars.exportStep(node.inner.id, { skipped: true }); continue; }
      walkSyncK6([node.inner], st, deps, send, aborted);
      continue;
    }
    switch (node.op) {
      case 'if':
        walkSyncK6(decideCondition(node.condition, st, deps) ? node.then : node.else, st, deps, send, aborted);
        continue;
      case 'switch': {
        const v = compileExpr(node.value).eval({ root: st.vars.asExprRoot(), vars: st.vars.visible(), now: deps.clock.now });
        const hit = node.cases.find((c) => looseEq(c.is, v));
        walkSyncK6(hit ? hit.steps : node.default, st, deps, send, aborted);
        continue;
      }
      case 'forEach': {
        const items = itemsOf(node.items, st, deps);
        const cap = Math.min(items.length, node.maxIterations);
        if (cap < items.length) st.notes.push({ stepId: node.id, ok: true, why: `forEach 撞上限 ${node.maxIterations}，只跑前 ${cap} 条` });
        for (let i = 0; i < cap; i++) {
          st.vars.pushLoop({ [node.as]: items[i], ...(node.indexAs ? { [node.indexAs]: i } : {}) }, node.id);
          walkSyncK6(node.steps, st, deps, send, aborted);
          st.vars.pop();
        }
        continue;
      }
      case 'repeat':
        for (let i = 0; i < node.times; i++) walkSyncK6(node.steps, st, deps, send, aborted);
        continue;
      case 'group':
        walkSyncK6(node.steps, st, deps, send, aborted);
        continue;
      case 'waitOnce':
        // 处置全在 applyWaitOnce 里（两个调度器调同一个函数，见那里的注释）
        if (!applyWaitOnce(node, st, deps)) return;
        continue;
      case 'sleep':
        // 同步调度器里 sleep 是**阻塞这个 VU**，而那正是 k6 的 sleep() 的语义
        // （goja 里 sleep 就是同步的）。用例 body 中间的 sleep 必须真的等，
        // 否则"两个请求之间的 5 秒间隔"这种步骤会被演化成 0 间隔，
        // 测出来的负载形态比真实形态更凶。
        deps.clock.sleep(node.ms);
        continue;
      case 'press': {
        // 同步构造（见 buildLoadRequestSync 的注释）。异步鉴权/校验在这里抛，
        // 而不是发一个没鉴权或没校验的请求。
        const req = buildLoadRequestSync(node, st, deps);
        const res = send(req);
        if (res.transportError) applyLoadFailure(node, res, st);
        else applyLoadResponse(node, res, st, deps);
        continue;
      }
      default:
        if (!runLeaf(node, st, deps)) return;
    }
  }
}

/**
 * **异步**调度器（内置后端）。与上面那个逐条对得上，只差 await。
 * 两者**必须一起改**，而这条由 `test/load-parity.test.ts` 逼着（不是靠注释）。
 */
export async function walkAsyncBuiltin(
  nodes: readonly LoadNode[],
  st: LoadState,
  deps: LoadDeps,
  send: (req: BuiltRequest) => Promise<RawResponse>,
  aborted?: () => boolean,
): Promise<void> {
  for (const node of nodes) {
    if (aborted?.()) return;
    if (node.op === 'when') {
      if (!decideCondition(node.condition, st, deps)) { st.vars.exportStep(node.inner.id, { skipped: true }); continue; }
      await walkAsyncBuiltin([node.inner], st, deps, send, aborted);
      continue;
    }
    switch (node.op) {
      case 'if':
        await walkAsyncBuiltin(decideCondition(node.condition, st, deps) ? node.then : node.else, st, deps, send, aborted);
        continue;
      case 'switch': {
        const v = compileExpr(node.value).eval({ root: st.vars.asExprRoot(), vars: st.vars.visible(), now: deps.clock.now });
        const hit = node.cases.find((c) => looseEq(c.is, v));
        await walkAsyncBuiltin(hit ? hit.steps : node.default, st, deps, send, aborted);
        continue;
      }
      case 'forEach': {
        const items = itemsOf(node.items, st, deps);
        const cap = Math.min(items.length, node.maxIterations);
        if (cap < items.length) st.notes.push({ stepId: node.id, ok: true, why: `forEach 撞上限 ${node.maxIterations}，只跑前 ${cap} 条` });
        for (let i = 0; i < cap; i++) {
          st.vars.pushLoop({ [node.as]: items[i], ...(node.indexAs ? { [node.indexAs]: i } : {}) }, node.id);
          await walkAsyncBuiltin(node.steps, st, deps, send, aborted);
          st.vars.pop();
        }
        continue;
      }
      case 'repeat':
        for (let i = 0; i < node.times; i++) await walkAsyncBuiltin(node.steps, st, deps, send, aborted);
        continue;
      case 'group':
        await walkAsyncBuiltin(node.steps, st, deps, send, aborted);
        continue;
      case 'waitOnce':
        // 处置全在 applyWaitOnce 里（两个调度器调同一个函数，见那里的注释）
        if (!applyWaitOnce(node, st, deps)) return;
        continue;
      case 'sleep':
        await deps.clock.sleep(node.ms);
        continue;
      case 'press': {
        const req = await buildLoadRequest(node, st, deps);
        const res = await send(req);
        if (res.transportError) applyLoadFailure(node, res, st);
        else applyLoadResponse(node, res, st, deps);
        continue;
      }
      default:
        if (!runLeaf(node, st, deps)) return;
    }
  }
}

export class LoadPressError extends Error {
  constructor(message: string, public readonly stepId: string) {
    super(message);
    this.name = 'LoadPressError';
  }
}

/** 与 `resolve.ts` 的 looseEq 同语义。不 import 是因为那个函数没导出（导它会多一个 testOnly 导出） */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 极简 jsonpath 取第一个值。只用 engine 的 queryOne 那条路，免得第二份实现 */
function queryJson(value: unknown, path: string): unknown {
  return queryOne(value, path.startsWith('$') ? path : `$.${path}`);
}

export type { LoadPlan };
