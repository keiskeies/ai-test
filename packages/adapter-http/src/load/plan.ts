/**
 * IR -> 压测计划（docs/09 §4.2 那句 `IR (子集) ──▶ 编译器`）。
 *
 * ## 为什么中间隔一层**数据**，而不是直接生成 k6 文本
 *
 * 直接生成文本最短，但它只有一个读者：k6。而本机装不上 k6（`dl.google.com` 通、
 * `github.com` 超时，实测过），于是这条路上每一句"编译出来的脚本是对的"
 * 都没人验得住 —— 那是本仓最不接受的一种交付。
 *
 * 所以这里把"这条用例在压测里该做什么"算成一份**与后端无关的 JSON 计划**，
 * 两个后端各自消费同一份数据：
 *
 *   renderK6Script()  -> k6 文本（docs/09 指定的那个出口，接分布式与指标体系）
 *   runLoadPlan()     -> 内置后端，用真 fetch 打（本机、CI、离线都能跑）
 *
 * ⚠ **两个后端不许各自再解释一遍 IR。** 分叉的表现不是报错，是
 * "同一条用例在 k6 里 500 rps、在内置后端里 120 rps，而两边的报告长得一样"。
 * 载体是 `adapter-http/test/load-parity.test.ts`：同一条 IR 走两个后端，
 * 逐个比**实际发出去的请求**（method / 完整 URL / 头 / 体），一个字节不同就红。
 *
 * ## 为什么这一步不 import node 内置模块
 *
 * 本文件与 emit-k6.ts 都是**纯函数**（IR 进、字符串/JSON 出）。这样编辑器里
 * "我这条用例能不能压、编译出来长什么样"能在浏览器里当场给出，
 * 不必起 Node、不必装 k6 —— 与 `packages/engine` 同一条理由（docs/01 §8.2）。
 * 只有 `press.ts`（真发请求那一侧）碰 node。
 *
 * ## 值不在这里求值
 *
 * 计划里的 headers/query/body **保持 IR 的值形态**（`{expr}` / `{gen}` / `{path}` 原样带着）。
 * 求值发生在跑的那一刻、由两个后端各调**同一份** `resolveValue`（`engine/src/resolve.ts`）。
 * 在这里求值会坏两件事：`{gen:'uuid'}` 每 VU 每迭代都该是新值（编译期只有一个），
 * 而 `{path:'$.steps.x.body'}` 依赖上一次迭代的结果。
 */
import type { Scenario, Step } from '@atest/ir';
import { LOAD_STEP_SUPPORT, waitNeedsExternalAdapter } from '@atest/ir';

/** operation 的定位结果。字段是 composeUrl 与鉴权层**实际要用**的那几个，不多带。 */
export interface LoadOperation {
  method: string;
  /** 含 `{param}` 的模板，不含 baseUrl */
  urlTemplate: string;
  /** 参数序列化规则。composeUrl 靠它决定 `style`/`explode`，缺了就退成规范默认值 */
  params: Array<{ name: string; in: 'path' | 'query'; style?: string; explode?: boolean }>;
  operationId?: string;
  deprecated?: boolean;
  /** 请求体 required 字段（校验在跑的那一侧做，这里只是带出去备用） */
  requiredBodyFields?: string[];
}

/** 编译期查 spec 的那根线。查不到就返回 undefined（计划里退成"没有 operation"）。 */
export interface LoadDocLookup {
  operation(ref: { docRef: string; operationId?: string; method?: string; path?: string }): Promise<LoadOperation | undefined>;
}

/** 计划里的一个节点。判别键统一叫 `op`，两个后端 switch 同一个键集。 */
export type LoadNode =
  | {
      op: 'press';
      id: string;
      /** 请求方法。openapiCall 的 method 来自 operation，http 的来自 IR */
      method: string;
      /** 未拼 baseUrl 的模板（含 `{param}`）；纯 http 步骤就是 IR 里那个 url */
      urlTemplate: string;
      /** 值保持 IR 形态，跑的时候才求值（见文件头） */
      pathParams: Record<string, unknown>;
      queryParams: Record<string, unknown>;
      /** 头的值**已经要成字符串**了吗？不，仍留值形态 —— strMap 也在跑的那侧调 */
      headers: Record<string, unknown>;
      body?: unknown;
      formData: Record<string, unknown>;
      /** 有 operation 才带：composeUrl 要它查 style/explode，鉴权层要它查 securityScheme */
      operation?: LoadOperation;
      auth?: { ref?: string; identity?: string; docRef?: string; operationId?: string; method?: string; path?: string };
      /** 请求侧 schema 校验的目标；负向策略时为 null（那一刻**故意**发不合法的请求） */
      validate?: { docRef: string; operationId?: string } | null;
      timeoutMs: number;
      maxBytes: number;
      followRedirects: boolean;
      /** 响应导出（`$.steps.<id>.resp` 那套），与解释器导出的形状一致 */
      saveAs?: string;
    }
  | { op: 'group'; id: string; steps: LoadNode[] }
  | { op: 'set'; id: string; assign: Array<[string, unknown]> }
  | { op: 'extract'; id: string; from: string; rules: Array<{ var: string; path: string; mode: string; group?: number; required: boolean }> }
  | { op: 'assert'; id: string; payload: Record<string, unknown> }
  | { op: 'if'; id: string; condition: string; then: LoadNode[]; else: LoadNode[] }
  | { op: 'switch'; id: string; value: string; cases: Array<{ is: unknown; steps: LoadNode[] }>; default: LoadNode[] }
  | { op: 'forEach'; id: string; items: string; as: string; indexAs?: string; maxIterations: number; steps: LoadNode[] }
  | { op: 'repeat'; id: string; times: number; steps: LoadNode[] }
  | { op: 'sleep'; id: string; ms: number }
  /** wait 编译成"判一次"。降级这件事由静态闸（LOAD_STEP_DEGRADED）说，不在这里重复 */
  | { op: 'waitOnce'; id: string; condition: unknown; onTimeout: 'fail' | 'continue' | 'error' }
  | { op: 'log'; id: string; level: string; message: string }
  | { op: 'fail'; id: string; reason: string }
  | { op: 'noop'; id: string }
  /** 守卫包一层：任何节点都可能带 `when`，条件不成立记 skipped（与解释器同语义） */
  | { op: 'when'; id: string; condition: string; inner: LoadNode };

export interface LoadPlan {
  scenarioId: string;
  /** 一次迭代（一个 VU 的一轮）要跑的节点 */
  nodes: LoadNode[];
  /** setup/teardown：只在 VU 启动/结束时各跑一次，**不计入分位数** */
  setup: LoadNode[];
  teardown: LoadNode[];
  /**
   * 场景自己声明的 `inputs`（带 default 的那份），原样带出来。
   *
   * **必须带**：VarSpace 靠它把 `inputs[].default` 兜进运行输入。
   * 少了它的表现是"IR 里写了 default，压测里报 `引用未定义（变量：$q）`，
   * 而同一条用例功能回归能跑过"—— 同一份 IR 两种行为，正是 docs/00 §6.6
   * 里 GUI↔CLI 那类分裂的形状（`applyInputDefaults` 那段注释记过同一条）。
   */
  inputDefs: readonly unknown[];
  /** 计划里请求总数是否不可静态确定（有 forEach/while 之类）。报告要如实说 */
  readonly dynamicIterations: boolean;
  /** 计划里最慢可能的静态节点数（一个数量级提示，不是精确成本） */
  readonly staticOps: number;
}

export class LoadCompileError extends Error {
  constructor(message: string, public readonly stepId: string, public readonly kind: string) {
    super(message);
    this.name = 'LoadCompileError';
  }
}

/** 负向策略：故意发不合法的请求，所以**不能**在发送前用 spec 拦下来。与解释器同一份名单。 */
const NEGATIVE_STRATEGIES = new Set(['requiredMissing', 'typeViolation', 'negativeFuzz', 'boundary']);

export async function compileLoadPlan(scenario: Scenario, lookup: LoadDocLookup): Promise<LoadPlan> {
  if (!scenario.load) {
    throw new LoadCompileError(
      '这条场景没有 load 块，不能压。压测的形状（VU 数、时长、思考时间）是用例的一部分而不是命令行参数：'
        + '命令行传参撑不起性能门禁 —— 基线要能回答"这次和上次是同一个压法吗"，'
        + '而那个答案就是 load.vus / load.durationMs（改它等于换压法，见 LoadFingerprint）',
      scenario.id, 'scenario',
    );
  }
  const dynamic = { items: false };
  const build = (steps: Step[]): Promise<LoadNode[]> => compileList(steps, lookup, dynamic);
  // 只编译一遍。从前这里为算 staticOps 又把 body 编了一遍 —— 那不只是慢：
  // `lookup.operation` 是有副作用的（读 spec 文件），而 dynamic.items 会被加两次，
  // 于是"迭代数不可静态确定"这个结论依赖编译次数。
  const nodes = await build(scenario.body);
  return {
    scenarioId: scenario.id,
    nodes,
    inputDefs: scenario.inputs,
    setup: await build(scenario.setup),
    teardown: await build(scenario.teardown),
    dynamicIterations: dynamic.items,
    staticOps: countNodes(nodes),
  };
}

/**
 * 静态节点数（含嵌套）。刻意**不乘**迭代次数 —— 与 `PrecompiledPlan.ops` 同一条取舍：
 * 它的用途是"每迭代成本"，乘了反而不对（总成本另有来源：实测的请求数）。
 */
function countNodes(nodes: readonly LoadNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    switch (node.op) {
      case 'if': n += countNodes(node.then) + countNodes(node.else); break;
      case 'switch': n += node.cases.reduce((a, c) => a + countNodes(c.steps), 0) + countNodes(node.default); break;
      case 'forEach':
      case 'repeat':
      case 'group': n += countNodes(node.steps); break;
      // when 自己是一条（上面 n++ 记的），inner 是另一条，整棵算进去
      case 'when': n += countNodes([node.inner]); break;
      default: break;
    }
  }
  return n;
}

async function compileOne(s: Step, lookup: LoadDocLookup, dynamic: { items: boolean }): Promise<LoadNode> {
  const support = LOAD_STEP_SUPPORT[s.kind];
  if (support.support === 'refuse') {
    // 静态闸已经会报这句（LOAD_STEP_UNSUPPORTED）。这里再判一次**不是重复**：
    // `atest run` 不带 --strict 时 lint 不拦，而编译器是"会不会发出一个错请求"的
    // 最后一道。与解释器里 files[] 那条同一个理由（宁可这一步不跑）。
    throw new LoadCompileError(`${s.kind} 步骤不能进压测：${support.why}`, s.id, s.kind);
  }
  if ((s.retry?.count ?? 0) > 0) {
    throw new LoadCompileError(
      `${s.id} 写了 retry.count=${s.retry?.count}。压测形态**完全不重试**：重试会把一次故障算成两次负载，吞吐与错误率曲线就不真了`,
      s.id, s.kind,
    );
  }

  switch (s.kind) {
    case 'http': {
      if (s.request.files.length > 0) {
        throw new LoadCompileError(
          `http 请求带 ${s.request.files.length} 个文件，multipart 尚未实现 —— 压测不会发一个少附件的请求（那会产生一条"附件没上传而用例绿了"的曲线）`,
          s.id, s.kind,
        );
      }
      return {
        op: 'press', id: s.id, method: s.request.method, urlTemplate: s.request.url,
        pathParams: {}, queryParams: s.request.query, headers: s.request.headers,
        body: s.request.body, formData: s.request.formData,
        operation: undefined,
        auth: s.auth || s.identity ? { ref: s.auth, identity: s.identity } : undefined,
        validate: null,
        timeoutMs: s.timeoutMs ?? 30_000, maxBytes: s.maxResponseBytes, followRedirects: s.followRedirects,
        ...(s.saveAs ? { saveAs: s.saveAs } : {}),
      };
    }
    case 'openapiCall': {
      const op = await lookup.operation({ docRef: s.docRef, operationId: s.operationId, method: s.method, path: s.path });
      if (!op) {
        throw new LoadCompileError(
          `在文档 ${s.docRef} 里定位不到这个 operation（operationId=${s.operationId ?? '-'} method=${s.method ?? '-'} path=${s.path ?? '-'}）。`
            + '压测**不许**退化成"按 IR 里写的方法打一个猜的地址"：那会打出一个不是这条用例的请求，而曲线照画',
          s.id, s.kind,
        );
      }
      return {
        op: 'press', id: s.id, method: op.method, urlTemplate: op.urlTemplate,
        pathParams: s.pathParams, queryParams: s.queryParams, headers: s.headers,
        body: s.body, formData: {},
        operation: op,
        // 三个定位字段**优先取解析后的值**，与解释器同一条理由：
        // 交下来 undefined 等于让鉴权层定位不到 securityScheme，
        // 于是"按 spec 自动加鉴权"对这类用例整个失效，而失效方式是"没加头"。
        auth: { identity: s.identity, docRef: s.docRef, operationId: op.operationId ?? s.operationId, method: op.method, path: op.urlTemplate },
        validate: s.validateRequest && !NEGATIVE_STRATEGIES.has(s.strategy ?? '') ? { docRef: s.docRef, operationId: op.operationId } : null,
        timeoutMs: s.timeoutMs ?? 30_000, maxBytes: 10_000_000, followRedirects: false,
        ...(s.saveAs ? { saveAs: s.saveAs } : {}),
      };
    }
    case 'set':
      return { op: 'set', id: s.id, assign: Object.entries(s.assign) };
    case 'sequence':
      // 最常见的容器（一条 happyPath 用例基本都是 sequence 包着几个请求）。
      // 编译成一组节点，不产额外结论 —— 解释器对容器自己那一条的记账在跑的那侧做。
      return { op: 'group', id: s.id, steps: await compileList(s.steps, lookup, dynamic) };
    case 'extract':
      return { op: 'extract', id: s.id, from: s.from, rules: s.rules.map((r) => ({ var: r.var, path: r.path, mode: r.mode, ...(r.group !== undefined ? { group: r.group } : {}), required: r.required })) };
    case 'assert': {
      const { id: _id, kind: _k, name: _n, when: _w, onError: _e, tags: _t, note: _no, timeoutMs: _to, retry: _r, ...payload } = s;
      return { op: 'assert', id: s.id, payload: payload as unknown as Record<string, unknown> };
    }
    case 'if':
      return { op: 'if', id: s.id, condition: s.condition, then: await compileList(s.then, lookup, dynamic), else: await compileList(s.else, lookup, dynamic) };
    case 'switch':
      return {
        op: 'switch', id: s.id, value: s.value,
        cases: await Promise.all(s.cases.map(async (c) => ({ is: c.is, steps: await compileList(c.steps, lookup, dynamic) }))),
        default: await compileList(s.default, lookup, dynamic),
      };
    case 'forEach':
      dynamic.items = true;
      return { op: 'forEach', id: s.id, items: s.items, as: s.as, ...(s.indexAs ? { indexAs: s.indexAs } : {}), maxIterations: s.maxIterations, steps: await compileList(s.steps, lookup, dynamic) };
    case 'repeat':
      return { op: 'repeat', id: s.id, times: s.times, steps: await compileList(s.steps, lookup, dynamic) };
    case 'sleep':
      return { op: 'sleep', id: s.id, ms: s.ms };
    case 'wait':
      return { op: 'waitOnce', id: s.id, condition: waitConditionForLoad(s), onTimeout: s.onTimeout };
    case 'log':
      return { op: 'log', id: s.id, level: s.level, message: s.message };
    case 'fail':
      return { op: 'fail', id: s.id, reason: s.reason };
    case 'noop':
      return { op: 'noop', id: s.id };
    default: {
      // 到不了这儿 —— 表里 refuse 的 kind 在函数开头就抛了。
      //
      // ⚠ **这里拿不到 `never`，而这件事本身要记下来。** 本来想写 `const t: never = s`
      // 让"加了 kind 忘了加分支"变成编译错误，但 TS **没法把 `LOAD_STEP_SUPPORT[s.kind]`
      // 与 `s.kind` 关联起来做收窄**（判别键的值经过了一次查表），所以 call / web / mobile
      // 那一堆 kind 在类型上仍然活到这儿，`never` 直接编译不过（实测）。
      // 于是"表说 flow 而这里没写 case"这一类**编译期抓不到**，抓它的是
      // `test/load-plan.test.ts` 里那条**遍历整张表**的测试：
      // 表里每一个 press/flow/once 的 kind 都要能编出一个节点，缺一个就红。
      const t = s as Step;
      throw new LoadCompileError(
        `压测编译器没处理这种步骤（判据表说它是 "${LOAD_STEP_SUPPORT[t.kind].support}"，而代码里没有对应分支）：kind=${t.kind}`,
        t.id, t.kind,
      );
    }
  }
}

/**
 * wait 的谓词能不能在压测形态里判。判据表在 ir 的 LOAD_WAIT_SUPPORT，
 * 静态闸问的是同一张表（两处各写一份就会漂移，理由见 LOAD_STEP_SUPPORT 那段）。
 *
 * 这里**再判一次不是重复**：`atest run` 不带 `--strict` 时 lint 不拦，
 * 而编译器是"会不会把一条判不了的等待演化成恒假"的最后一道。
 * 恒假的两种下场都坏：`onTimeout:'fail'` 整场失败（还能发现），
 * `'continue'` 则是**静默当成没等**，压测照跑照出曲线。
 */
function waitConditionForLoad(s: Step): unknown {
  const cond = (s as { condition?: unknown }).condition;
  const need = waitNeedsExternalAdapter(cond);
  if (need) {
    throw new LoadCompileError(
      `这条 wait 的条件在压测形态判不了（谓词类型 ${need}）。把这类等待挪到压测之前的准备场景里，`
        + '被压的那条只留 wait{expr} 或干脆不等（数据提前预置）',
      s.id, s.kind,
    );
  }
  return cond;
}

async function compileList(steps: Step[], lookup: LoadDocLookup, dynamic: { items: boolean }): Promise<LoadNode[]> {
  const out: LoadNode[] = [];
  for (const s of steps) {
    const node = await compileOne(s, lookup, dynamic);
    out.push(s.when ? { op: 'when', id: s.id, condition: s.when, inner: node } : node);
  }
  return out;
}
