/**
 * `atest gen` —— 从 OpenAPI 文档**确定性地**生成场景 IR（docs/05 §3 的策略体系）。
 *
 * 先说清这块的边界，因为这里最容易高估自己：
 *
 * **这是模板展开，不是 AI。** docs/05 §3 第 3 条自己写着 authMatrix 的
 * "bug 密度最高，且完全不依赖 AI 智能度 —— 纯粹的模板展开"。
 * 本文件实现的就是那张表里**只靠 spec 就能决定**的六种策略。
 * 三种**故意不做**的：
 *  - `statefulSequence`：要资源依赖图（create→get→delete）。95% 的 spec 不写 `links`，
 *    从 path 猜依赖是个需要人确认的推断问题，猜错的用例比没有用例更坏
 *    （它绿的时候你以為测过了）。P1 随人工确认依赖图一起做。
 *  - `contract`：要真实响应（跑出来的），生成期没有。它是执行期的一条车道，不是模板。
 *  - `authMatrix`：要 ≥2 个已配置身份 + "他人资源 id"从哪来。**没做不等于能做**，
 *    所以这里显式跳过并在 --strategies all 的说明里写明。
 *
 * 三个硬约束（每条都有理由，改之前先读）：
 *  1. **输出不含时间戳**。同一份 spec 再生成一次必须产出**字节完全相同**的文件，
 *     否则 git diff 每次都是一片红，"定义可 diff"这个卖点当场作废。
 *     ProvenanceSchema 里有 generatedAt 而这里刻意不填，用 specHash 代替。
 *  2. **生成的场景 frozen=false**。frozen 的语义是"人已确认可进 CI"（docs/02 §1），
 *     机器没有资格自己盖章。
 *  3. **首轮策略不进门禁**（docs/05 §3 要点 1）：requiredMissing/typeViolation/negativeFuzz
 *     第一轮必然一片红（后端不做参数校验是常态），一片红的第一天 = 用户关掉整个门禁。
 *     所以它们带 tag `triage`，由 run 侧降级为"待确认清单"（见 run.ts 的 gateOf）。
 *     StepSchema/ScenarioSchema 都是 strict()，塞不进自定义布尔，
 *     所以这个标记走 tags —— tags 是 IR 的正式字段，UI 上也看得见。
 */
import { createHash } from 'node:crypto';

import type { OperationSpec, ParsedDoc } from '@atest/adapter-http';
import { sampleFromSchema } from '@atest/adapter-http';
import type { ParamDef, ScenarioDraft, StepDraft } from '@atest/ir';

/** 策略本体与首轮处置。文案直接对齐 docs/05 §3 的表，改表要同步这里 */
export interface StrategySpec {
  id: string;
  /** 首轮是否进门禁。false = 打 triage 标签，只列清单不计通过率 */
  gating: boolean;
  /** 失败含义（写进 IR 的 note，让接手的人知道这条在测什么） */
  meaning: string;
  /** 为什么需要人工/运行期信息，因而本命令不生成 */
  notGenerated?: string;
}

export const STRATEGIES: readonly StrategySpec[] = [
  { id: 'happyPath', gating: true, meaning: '合法请求应返回 2xx 且响应结构符合文档' },
  { id: 'requiredMissing', gating: false, meaning: '缺必填字段必须被拒绝（4xx）。返回 2xx/500 都是后端缺参数校验' },
  { id: 'typeViolation', gating: false, meaning: '类型不对的字段必须被拒绝（4xx）。静默接受是反序列化层缺陷' },
  { id: 'boundary', gating: true, meaning: 'min/max 边界内应通过、边界外应被拒绝。off-by-one 在这里最容易出现' },
  { id: 'enumExhaustive', gating: true, meaning: 'enum 每个值都要能用。某个值 500 说明分支没实现' },
  { id: 'notFound', gating: true, meaning: '不存在的资源 id 应 404，而不是 500 或 200 空对象' },
  { id: 'negativeFuzz', gating: false, meaning: '语义垃圾值应 4xx 且不得 500。误报率高，永不进门禁（docs/05 §3）' },
  {
    id: 'statefulSequence', gating: true, meaning: '按资源依赖串链路（create→get→update→delete），bug 密度最高',
    notGenerated: '需要资源依赖图。spec 基本不写 links，从 path 猜依赖的推断质量不够用，需人工确认（docs/05 §3 要点 2）',
  },
  {
    id: 'contract', gating: false, meaning: '真实响应 vs 文档 schema。独立车道 + 需要 specAuthoritative',
    notGenerated: '需要真实响应体，属于执行期车道而不是生成期模板',
  },
  {
    id: 'authMatrix', gating: true, meaning: '无 token / 越权访问他人资源，期望 401/403 且不泄露数据。严重度最高',
    notGenerated: '需要至少两个已配置身份与"他人资源 id"的来源（docs/05 §2 的 identity 层尚未实现）',
  },
  {
    id: 'idempotency', gating: false, meaning: '同一写请求重发两次应一致或 409',
    notGenerated: '要先确定幂等键来源，且"重复一次"是否安全取决于接口是否有副作用 —— 需要人确认',
  },
  { id: 'perfSmoke', gating: false, meaning: 'happyPath 重复 N 次看 p95', notGenerated: '属于 M0.6 的压测形态（独立执行器），不在这里造循环场景' },
] as const;

export const GENERATED_STRATEGY_IDS: readonly string[] = STRATEGIES.filter((s) => !s.notGenerated).map((s) => s.id);

export function strategyOf(id: string): StrategySpec | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

export interface GenOptions {
  /** 只生成这些 operation（operationId 精确匹配） */
  only?: string[];
  /** 跳过这些 operation */
  skip?: string[];
  /** 策略 id 列表；含 'all' 时展开为可生成的全部 */
  strategies: string[];
  /** 环境名（写进 scenario.env.environmentRef） */
  envRef: string;
  /** 写进 IR 的 docRef，必须与 run 时 --doc 的名字一致 */
  docRef: string;
  /** id 前缀，避免多份 spec 生成出同名场景 */
  idPrefix?: string;
  /** 只生成 happyPath（`--happy-only`） */
  happyOnly?: boolean;
  /** 把 path 参数提升为 `$input.<这个名字>`，让 CI 能不改文件就换 id */
  pathParamVar?: string;
}

export interface GeneratedScenario {
  /** 文件名（不含目录）。稳定：同一 operation 同一策略永远是这个名字 */
  file: string;
  draft: ScenarioDraft;
  operationId: string;
  strategy: string;
}

export interface GenResult {
  scenarios: GeneratedScenario[];
  /** 为什么这条没生成。**必须渲染出来**：静默少生成 = 覆盖看着是 100% 而实际缺一半 */
  skipped: Array<{ operationId: string; strategy: string; reason: string }>;
  /** 全局告警（spec 自身的问题、策略不适用的原因） */
  warnings: string[];
  specHash: string;
}

/** spec 内容指纹。同一份 spec 生成两次结果应当一致，这个哈希就是判据 */
export function specHashOf(doc: ParsedDoc, raw?: unknown): string {
  // 用 operations 的稳定投影而不是 JSON.stringify(raw)：raw 里 $ref 顺序、
  // description 里的空白都不影响生成结果，把它们算进去会让 specHash 无谓地漂移
  const proj = doc.operations
    .slice()
    .sort((a, b) => a.operationId.localeCompare(b.operationId))
    .map((o) => ({
      id: o.operationId, method: o.method, path: o.path,
      params: o.params.map((p) => [p.name, p.in, p.required, JSON.stringify(p.schema)]),
      body: o.requestBodySchema ? JSON.stringify(o.requestBodySchema) : null,
      required: o.requiredBodyFields.slice().sort(),
      responses: Object.keys(o.responses).sort(),
    }));
  void raw;
  return createHash('sha256').update(JSON.stringify(proj)).digest('hex').slice(0, 16);
}

export function generateScenarios(doc: ParsedDoc, o: GenOptions): GenResult {
  const warnings: string[] = [];
  const scenarios: GeneratedScenario[] = [];
  const skipped: GenResult['skipped'] = [];

  const want = new Set<string>();
  // --strategies all 时，**没做的策略也要说明白**。
  // 早先 all 只展开 GENERATED_STRATEGY_IDS 而绝不提另外那六种为什么没有：
  // 用户以为"all = 覆盖全了"，实际 authMatrix（越权，docs/05 说它 bug 密度最高）
  // 压根没生成，而输出里一个字的提示都没有。显式点名某个未实现策略会 warning，
  // 用 all 却静默 —— 同一件事两条路径，这正是要避免的不对称。
  let expandAll = false;
  for (const s of o.strategies) if (s === 'all') expandAll = true;
  if (expandAll) {
    for (const st of STRATEGIES) if (st.notGenerated) warnings.push(`策略 ${st.id} 未生成（--strategies all 也不含它）：${st.notGenerated}`);
  }
  for (const s of o.strategies) {
    if (s === 'all') { for (const id of GENERATED_STRATEGY_IDS) want.add(id); continue; }
    const spec = strategyOf(s);
    if (!spec) { warnings.push(`没有这个策略：${s}（可用：${STRATEGIES.map((x) => x.id).join(', ')}）`); continue; }
    if (spec.notGenerated) { warnings.push(`策略 ${s} 本次不生成：${spec.notGenerated}`); continue; }
    want.add(s);
  }
  if (o.happyOnly) { for (const id of [...want]) if (id !== 'happyPath') want.delete(id); }
  const only = o.only?.length ? new Set(o.only) : undefined;
  const skip = o.skip?.length ? new Set(o.skip) : undefined;
  const hash = specHashOf(doc);
  const prefix = o.idPrefix ? `${o.idPrefix}_` : '';

  // 顺序固定：operationId 字典序 + 策略表顺序。
  // 遍历 doc.operations 的原生顺序会让"后端重新排了一下 spec"变成一次全量 diff
  for (const op of doc.operations.slice().sort((a, b) => a.operationId.localeCompare(b.operationId))) {
    if (only && !only.has(op.operationId)) continue;
    if (skip?.has(op.operationId)) { skipped.push({ operationId: op.operationId, strategy: '*', reason: '--skip 指定' }); continue; }
    for (const st of STRATEGIES) {
      if (!want.has(st.id)) continue;
      const made = buildScenario(op, st.id, { docRef: o.docRef, envRef: o.envRef, hash, prefix, gating: st.gating, meaning: st.meaning, pathParamVar: o.pathParamVar });
      if (!made.ok) { skipped.push({ operationId: op.operationId, strategy: st.id, reason: made.reason }); continue; }
      if (made.note) warnings.push(made.note);
      scenarios.push({
        file: `${prefix}${safeFile(op.operationId)}.${st.id}.json`,
        draft: made.draft, operationId: op.operationId, strategy: st.id,
      });
    }
  }
  if (!scenarios.length) warnings.push('没有生成任何场景。检查 --only/--strategies 是否命中，以及 spec 里有没有可解析的 operation');
  return { scenarios, skipped, warnings, specHash: hash };
}

type BuildResult = { ok: true; draft: ScenarioDraft; note?: string } | { ok: false; reason: string };

function buildScenario(
  op: OperationSpec, strategy: string,
  meta: { docRef: string; envRef: string; hash: string; prefix: string; gating: boolean; meaning: string; pathParamVar?: string },
): BuildResult {
  const call = (over: Record<string, unknown>): StepDraft => ({
    id: 'call', kind: 'openapiCall', name: `${op.method} ${op.path}`,
    docRef: meta.docRef, operationId: op.operationId, ...over,
  });
  const callSteps: StepDraft[] = [];
  const assertSteps: StepDraft[] = [];

  const built = buildSteps(op, strategy, call, callSteps, assertSteps);
  if (!built.ok) return built;

  // ParamDef[] 而不是 ScenarioDraft['inputs']：后者索引出来是 unknown（ScenarioDraft 是
  // Record<string, unknown>），拿到 unknown 后只能到处断言，等于把校验推给运行期
  const inputs: ParamDef[] = [];
  let promotionNote: string | undefined;
  if (meta.pathParamVar) {
    const prom = promotePathParam(callSteps, op, meta.pathParamVar);
    // 提升失败**只降级不报错**：`--path-param-var orderId` 对
    // `POST /orders`（无 path 参数）天然不适用，为它把整次生成打断是错的比例。
    // 但也不能静默 —— 调用方要知道"我要求的注入没发生"，所以带在 note 里回传。
    if (!prom.ok) promotionNote = `--path-param-var 对 ${op.operationId}/${strategy} 没生效：${prom.reason}`;
    if (prom.ok) {
      // 刻意不填 default：引擎不读它（见 promotePathParam 的注释）。
      // 声明在这里的作用只有两个 —— UI 表单知道有这么个输入、lint 的 INPUT_UNUSED 能查它。
      inputs.push({
        name: meta.pathParamVar, type: 'string', required: true,
        description: `path 参数 ${prom.promoted!.join('、')} 由运行时提供（IR 里写作 $${meta.pathParamVar}）。CI 用 --input ${meta.pathParamVar}=<id> 或 --env-var ${meta.pathParamVar}=<id> 传。不传会得到"引用未定义"，那是有意的：拿生成期的样例 id 去打真实环境只会得到一个假的 404`,
      });
    }
  }

  const tags = ['generated', strategy, meta.hash, ...(meta.gating ? [] : ['triage'])];
  const draft: ScenarioDraft = {
    schemaVersion: '1',
    id: `${meta.prefix}${safeId(op.operationId)}.${strategy}`,
    name: `${op.method} ${op.path} · ${strategy}`,
    description: [
      `由 atest gen 从 OpenAPI 生成（策略 ${strategy}）。`,
      `这条在测什么：${meta.meaning}`,
      '注意：断言刻意保持宽松（只断状态码与字段存在），因为从一份 spec 精确推断响应取值就是过拟合（docs/00 §6.3）。',
    ].join(' '),
    tags,
    mode: 'script',
    // 生成物一律未冻结。人已确认才手动改 true（然后才能进 CI）
    frozen: false,
    env: { environmentRef: meta.envRef },
    inputs,
    body: [...callSteps, ...assertSteps],
    config: { dirty: isMutating(op.method) || undefined },
    provenance: {
      // origin 的合法值是 human|agent|imported|distilled。生成物来自 spec 导入，
      // 归 imported —— 它不是 agent（没有模型参与），也不是 human
      origin: 'imported',
      specHash: meta.hash,
      sourceSystem: 'doc',
    },
  };
  // 空 config 会被 zod 补默认值，这里只在需要时给，避免每个文件都带一串默认字段
  if (draft.config && Object.keys(draft.config).length === 0) delete draft.config;
  return { ok: true, draft, note: promotionNote };
}

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
}

/** 各策略的步骤构造。返回 {ok:false} 表示这条不适用于该 operation（会进跳过清单） */
function buildSteps(
  op: OperationSpec, strategy: string,
  call: (over: Record<string, unknown>) => StepDraft,
  callSteps: StepDraft[], assertSteps: StepDraft[],
): { ok: true } | { ok: false; reason: string } {
  const happyBody = (): Record<string, unknown> | undefined => {
    const s = op.requestBodySchema;
    if (!s) return undefined;
    const v = sampleFromSchema(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const happyParams = (): { pathParams: Record<string, unknown>; queryParams: Record<string, unknown> } => {
    const pathParams: Record<string, unknown> = {};
    const queryParams: Record<string, unknown> = {};
    for (const p of op.params) {
      // **只接受标量**。sampleFromSchema 对"没写 type 的 schema"返回 `{}`
      // （那是它自己的刻意设计：让响应断言不至于全 undefined），
      // 直接塞进 path 参数就会发出 `/orders/[object Object]` ——
      // 用例打的是一个根本不存在的 URL，而它可能一直是绿的。
      // path 参数留 undefined 也不行：URL 里会出现字面量 "{id}"。
      const v = sampleFromSchema(p.schema);
      const val = isScalar(v) ? v : PLACEHOLDER(p);
      if (p.in === 'path') pathParams[p.name] = val;
      else if (p.in === 'query') queryParams[p.name] = val;
      // header/cookie 交给鉴权层（尚未实现），这里不猜
    }
    return { pathParams, queryParams };
  };

  const pushAssert = (id: string, payload: Record<string, unknown>, note: string): void => {
    assertSteps.push({ id, kind: 'assert', name: `校验 ${id}`, against: '$.step.call.resp', note, ...payload } as StepDraft);
  };
  const statusCodes = successCodes(op);

  switch (strategy) {
    case 'happyPath': {
      const { pathParams, queryParams } = happyParams();
      callSteps.push(call({ pathParams, queryParams, body: happyBody(), strategy }));
      // 回退要**写在 note 里**。后端返回 202/206 时这条会误红，
      // 而报错只说"状态码不符"，没人能想到根因是 spec 没声明成功码
      pushAssert('status', { status: statusCodes }, declared2xx(op).length
        ? `期望 2xx。spec 声明的成功码是 ${statusCodes.join('/')}`
        : `spec 未声明 2xx 状态码，这里回退到 [200,201,204]：后端返回 202/206 时会误红，请修 spec`);
      pushAssert('shape', { jsonPath: responseShape(op) }, '响应结构断言：只断必填字段存在（宽松默认，见文件头）');
      return { ok: true };
    }

    case 'requiredMissing': {
      const fields = op.requiredBodyFields;
      if (!fields.length) return { ok: false, reason: '请求体没有 required 字段，这条策略对它没有意义' };
      // 一个 operation 一个场景，里面**逐个删一个字段**发一次请求。
      // 为什么不用 forEach：字段名要能出现在断言报错里（"删了 amount 却返回 200"），
      // forEach 的循环变量进不了断言的期望值，报错就会退化成"第 2 项失败"
      const base = happyBody() ?? {};
      for (const field of fields) {
        const id = `missing_${safeId(field)}`;
        const body = { ...base };
        delete body[field];
        callSteps.push(call({ id, pathParams: happyParams().pathParams, body, strategy }));
        assertSteps.push({
          id: `a_${id}`, kind: 'assert', name: `缺 ${field} 应被拒绝`, against: `$.step.${id}.resp`,
          // 4xx 用 status 区间表达不了，所以走表达式：`>= 400 && < 500`。
          // 不接受 500 —— 后端把缺字段变成 NPE 是另一类缺陷，不该被"反正是错误"放过
          expr: '$ >= 400 && $ < 500', note: `删掉必填字段 ${field} 后必须 4xx。返回 2xx = 没做校验；返回 500 = 崩在没防护的地方`,
        } as StepDraft);
      }
      return { ok: true };
    }

    case 'typeViolation': {
      const cases = typeViolationCases(op);
      if (!cases.length) return { ok: false, reason: '请求体没有可变形类型的字段（schema 无 properties）' };
      const base = happyBody() ?? {};
      for (const c of cases) {
        const id = `bad_${safeId(c.field)}_${c.kindOf}`;
        callSteps.push(call({ id, pathParams: happyParams().pathParams, body: { ...base, [c.field]: c.value }, strategy }));
        assertSteps.push({
          id: `a_${id}`, kind: 'assert', name: `${c.field} 传 ${c.kindOf} 应被拒绝`, against: `$.step.${id}.resp`,
          expr: '$ >= 400 && $ < 500', note: `${c.field} 声明是 ${c.kindOf}（合法类型 ${c.expected}）。静默接受说明反序列化层在猜类型`,
        } as StepDraft);
      }
      return { ok: true };
    }

    case 'boundary': {
      const cases = boundaryCases(op);
      if (!cases.length) return { ok: false, reason: '没有声明 min/max/minLength/maxLength/minimum/maximum 的字段' };
      const base = happyBody() ?? {};
      for (const c of cases) {
        const id = `bnd_${safeId(c.field)}_${c.side}`;
        callSteps.push(call({ id, pathParams: happyParams().pathParams, body: { ...base, [c.field]: c.value }, strategy }));
        assertSteps.push({
          id: `a_${id}`, kind: 'assert', name: `${c.field}=${c.describe}`, against: `$.step.${id}.resp`,
          expr: c.expectInside ? '$ >= 200 && $ < 300' : '$ >= 400 && $ < 500',
          note: c.expectInside ? '边界内的值必须被接受（这里红 = 校验范围写窄了）' : '边界外的值必须被拒绝（这里绿而它接受了 = 校验 off-by-one）',
        } as StepDraft);
      }
      return { ok: true };
    }

    case 'enumExhaustive': {
      const target = enumTarget(op);
      if (!target) return { ok: false, reason: '请求体与参数里都没有 enum 字段' };
      for (const [i, v] of target.values.entries()) {
        const id = `enum_${i}`;
        const body = target.where === 'body' ? { ...(happyBody() ?? {}), [target.field]: v } : happyBody();
        const extra: Record<string, unknown> = { body, strategy };
        if (target.where === 'query') extra.queryParams = { ...happyParams().queryParams, [target.field]: v };
        if (target.where === 'path') extra.pathParams = { ...happyParams().pathParams, [target.field]: v };
        callSteps.push(call({ id, ...extra }));
        assertSteps.push({
          id: `a_${id}`, kind: 'assert', name: `enum ${String(v)} 应可用`, against: `$.step.${id}.resp`,
          status: statusCodes, note: `枚举值 ${String(v)}。500/400 说明这个分支没实现或文档多写了值`,
        } as StepDraft);
      }
      return { ok: true };
    }

    case 'notFound': {
      const p = op.params.find((x) => x.in === 'path');
      if (!p) return { ok: false, reason: '这个接口没有 path 参数，造不出"不存在的 id"' };
      callSteps.push(call({
        pathParams: { ...happyParams().pathParams, [p.name]: NOT_FOUND_ID },
        queryParams: happyParams().queryParams, body: happyBody(), strategy,
      }));
      pushAssert('status', { status: 404 }, `拿一个必定不存在的 id（${NOT_FOUND_ID}）请求，期望 404。500 是错误处理缺陷，200 空对象更糟：前端会以为资源存在但为空`);
      return { ok: true };
    }

    case 'negativeFuzz': {
      const base = happyBody() ?? {};
      if (!op.requestBodySchema) return { ok: false, reason: '没有 JSON 请求体，fuzz 无处可放' };
      for (const [i, v] of FUZZ_VALUES.entries()) {
        const id = `fz_${i}`;
        callSteps.push(call({ id, pathParams: happyParams().pathParams, body: { ...base, fuzz: v }, strategy }));
        // fuzz **只断"不得 5xx"**：它允许 4xx 也允许 2xx（未声明字段被忽略是合规行为）。
        // 断"必须 4xx"会让负向 fuzz 变成误报制造机，然后整个策略被人关掉
        assertSteps.push({
          id: `a_${id}`, kind: 'assert', name: `fuzz #${i} 不得 5xx`, against: `$.step.${id}.resp`,
          expr: '$ < 500', note: `垃圾值 ${JSON.stringify(v).slice(0, 40)}。只要求不 5xx（独立车道，永不进门禁）`,
        } as StepDraft);
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: `策略 ${strategy} 没有生成器实现` };
  }
}

function declared2xx(op: OperationSpec): number[] {
  return Object.keys(op.responses).filter((k) => /^2\d\d$/.test(k)).map(Number).sort((a, b) => a - b);
}

/** spec 声明的成功码。没声明就退回 [200, 201, 204]。永不退回"任意 2xx 之外都算失败" */
function successCodes(op: OperationSpec): number[] {
  const codes = declared2xx(op);
  return codes.length ? codes : [200, 201, 204];
}

/**
 * 响应结构断言：只断"必填字段存在"。
 *
 * 为什么不用 spec 的 example 做 exact 断言：example 是文档作者手写的常量，
 * 后端返回真数据库里的值，两者必然不同 —— 用例于是永远红。
 * 为什么不逐字段 exact：docs/00 §6.3 的过拟合（时间戳/ID/顺序/浮点）。
 * 所以这里断的是**结构与存在性**；真要精确比对的场景由人在 IR 里加 exact，
 * 而那会在 diff 里显形。
 */
function responseShape(op: OperationSpec): Record<string, unknown> {
  const code = Object.keys(op.responses).find((k) => /^2\d\d$/.test(k));
  const schema = code ? op.responses[code]?.schema : undefined;
  const out: Record<string, unknown> = {};
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) {
    // 没有响应 schema 就**什么都不断**，而不是断一个"至少是个对象"。
    // 后者恒真，会让这条断言的存在给人"结构测过了"的错觉
    return out;
  }
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required: string[] }).required)
    : Object.keys(props);
  for (const k of required) {
    if (!(k in props)) continue;
    out[`$.${k}`] = { notNull: true };
  }
  return out;
}

const NOT_FOUND_ID = 'atest-not-found-00000000';

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** path 参数取不到样例值时的占位。刻意可辨识：真出问题时一眼看出是生成器没造出值 */
function PLACEHOLDER(p: { name: string; schema: Record<string, unknown> }): string | number {
  const t = (p.schema as { type?: unknown }).type;
  if (t === 'integer' || t === 'number') return 1;
  return `atest_${p.name}`;
}

/**
 * 把某个 path 参数提升为「从运行输入取」，让 CI 不改用例文件就能换真实 id。
 *
 * 引用形态用**裸变量名** `$orderId`，不是 `$input.orderId`：
 * 实测 `$input.orderId` 报「引用未定义」—— IR 里没有 `input` 这个根
 * （inputs 在变量空间里铺到顶层，`$orderId` 与 `$.run.inputs.orderId` 才是合法写法）。
 * 选裸名而不是 `$.run.inputs.orderId`：短，而且它能同时从 env 解析
 * （作用域链是 inputs → env），于是 `--input orderId=X` 与 `--env-var orderId=X` 都能覆盖，
 * CI 少记一个开关。
 *
 * **不写 inputs[].default。** ParamDefSchema 有 default 字段，而引擎**从不读它**
 * （VarSpace 只吃 runScenario 传进来的 opts.inputs）—— 写了就是"看着有兜底、
 * 实际没有"，CI 忘传时会得到一个让人困惑的行为差异而不是清晰报错。
 * 这属于本仓反复出现的「schema 有字段、执行侧没人读」那一类（docs/08 §3 有清单），
 * 生成器不去踩它。没传 input 时得到的是「引用未定义（变量：$orderId）」，
 * 那句话本身就是可行动的报错。
 *
 * 只在**该参数确实出现在 URL 模板里**时提升，否则保留字面量 ——
 * 提升一个不存在的占位符会让引擎报"pathParams 里的 x 不在占位符里"，
 * 而那条报错指向 IR 写法，真相却是生成器选错了参数。
 */
function promotePathParam(steps: StepDraft[], op: OperationSpec, varName: string): { ok: boolean; reason?: string; promoted?: string[] } {
  if (!/^[A-Za-z_][\w.]*$/.test(varName) || varName.includes('.')) {
    return { ok: false, reason: `--path-param-var 的名字 "${varName}" 不是合法变量名（字母/下划线开头，后续可含数字下划线；不能含点号，点号会被当成路径分隔）` };
  }
  const promoted: string[] = [];
  for (const step of steps) {
    const pp = step.pathParams;
    if (!pp || typeof pp !== 'object' || Array.isArray(pp)) continue;
    for (const [param, value] of Object.entries(pp as Record<string, unknown>)) {
      if (!isScalar(value)) continue;
      if (!op.urlTemplate.includes(`{${param}}`)) continue; // 这个步骤没用到它
      // **notFound 的那个字面量不许提升。** 它的全部价值就是"这个 id 一定不存在"；
      // 换成 $orderId 后 CI 传进来的是真 id，用例期望 404 而拿到 200 ——
      // 一个由开关制造出来的假失败，而且报错会指向"后端 404 处理有问题"
      if (value === NOT_FOUND_ID) continue;
      (pp as Record<string, unknown>)[param] = `$${varName}`;
      promoted.push(param);
    }
  }
  if (!promoted.length) return { ok: false, reason: `${op.operationId} 的 URL 模板里没有可提升的 path 参数（模板：${op.urlTemplate}）` };
  return { ok: true, promoted: [...new Set(promoted)] };
}

/**
 * 垃圾值。挑的都是**真出过事故**的形状，不是随机字符
 * （随机字符测不出编码/注入/边界问题，只会得到"后端拒了"这种无信息结论）。
 * 注意这里只断"不得 5xx"，不断"必须 4xx" —— 见 buildSteps 里 negativeFuzz 的注释。
 */
const FUZZ_VALUES: readonly unknown[] = [
  "1' OR '1'='1",
  '../../../../etc/passwd',
  '<script>alert(1)</script>',
  '😀'.repeat(500),          // 超长 + 非 BMP：utf8 字节数与字符数不等
  '\u200c\u200cnormal\u200c',  // 零宽字符包裹：肉眼看不出，字符串比较会失败
  '-9223372036854775809',     // 超出 int64：反序列化成 long 的后端会炸
  '\u0000NUL',
];

interface TypeCase { field: string; kindOf: string; value: unknown; expected: string }

/** 每个 string 字段试 数字/null/数组，每个 number 字段试 字符串/null */
function typeViolationCases(op: OperationSpec): TypeCase[] {
  const props = (op.requestBodySchema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  if (!props) return [];
  const out: TypeCase[] = [];
  for (const [name, s] of Object.entries(props)) {
    const t = Array.isArray(s?.type) ? s.type[0] : s?.type;
    if (t === 'string') {
      out.push({ field: name, kindOf: 'number', value: 1, expected: 'string' });
      out.push({ field: name, kindOf: 'null', value: null, expected: 'string' });
      out.push({ field: name, kindOf: 'array', value: [], expected: 'string' });
    } else if (t === 'integer' || t === 'number') {
      out.push({ field: name, kindOf: 'string', value: 'not-a-number', expected: String(t) });
      out.push({ field: name, kindOf: 'null', value: null, expected: String(t) });
    }
    // object/array 字段的类型变形留给 P1：变形值需要按子 schema 造，瞎造出来
    // 的 400 可能是因为**别的**字段不对，而不是这次变形生效了（假绿的反面：假红）
  }
  return out;
}

interface BoundaryCase { field: string; side: string; value: unknown; describe: string; expectInside: boolean }

/** 每个数值/字符串约束产一对：边界内一格（应通过）+ 边界外一格（应拒绝） */
function boundaryCases(op: OperationSpec): BoundaryCase[] {
  const props = (op.requestBodySchema as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
  if (!props) return [];
  const out: BoundaryCase[] = [];
  for (const [name, s] of Object.entries(props)) {
    const numeric = s.type === 'integer' || s.type === 'number';
    if (numeric) {
      const lo = num(s.minimum ?? s.min);
      const hi = num(s.maximum ?? s.max);
      if (lo !== undefined) {
        out.push({ field: name, side: 'in_low', value: lo, describe: `${name}=${lo}（下界内）`, expectInside: true });
        out.push({ field: name, side: 'out_low', value: lo - 1, describe: `${name}=${lo - 1}（下界外）`, expectInside: false });
      }
      if (hi !== undefined) {
        out.push({ field: name, side: 'in_high', value: hi, describe: `${name}=${hi}（上界内）`, expectInside: true });
        out.push({ field: name, side: 'out_high', value: hi + 1, describe: `${name}=${hi + 1}（上界外）`, expectInside: false });
      }
      continue;
    }
    if (s.type === 'string') {
      const minLen = num(s.minLength);
      const maxLen = num(s.maxLength);
      if (minLen !== undefined) {
        out.push({ field: name, side: 'in_len', value: 'a'.repeat(minLen), describe: `${name} 长度 ${minLen}（下界内）`, expectInside: true });
        if (minLen > 0) out.push({ field: name, side: 'out_len', value: 'a'.repeat(minLen - 1), describe: `${name} 长度 ${minLen - 1}（下界外）`, expectInside: false });
      }
      if (maxLen !== undefined) {
        out.push({ field: name, side: 'in_max', value: 'a'.repeat(maxLen), describe: `${name} 长度 ${maxLen}（上界内）`, expectInside: true });
        out.push({ field: name, side: 'out_max', value: 'a'.repeat(maxLen + 1), describe: `${name} 长度 ${maxLen + 1}（上界外）`, expectInside: false });
      }
    }
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 枚举目标：请求体里第一个 enum 字段，退到 query/path 参数。找不到就不生成 */
function enumTarget(op: OperationSpec): { field: string; values: unknown[]; where: 'body' | 'query' | 'path' } | undefined {
  const props = (op.requestBodySchema as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties;
  for (const [name, s] of Object.entries(props ?? {})) {
    if (Array.isArray(s?.enum) && s.enum.length) return { field: name, values: s.enum, where: 'body' };
  }
  for (const p of op.params) {
    const en = (p.schema as { enum?: unknown[] }).enum;
    if (Array.isArray(en) && en.length && (p.in === 'query' || p.in === 'path')) return { field: p.name, values: en, where: p.in };
  }
  return undefined;
}

/** 步骤/场景 id 的合法字符是 [A-Za-z0-9_-]（StepSchema 上有 regex 约束） */
function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'x';
}

function safeFile(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'x';
}

/** 稳定序列化：键序按字典序。**这决定了"再生成一次是否字节相同”** */
export function renderScenarioJson(draft: ScenarioDraft): string {
  return `${JSON.stringify(sortKeys(draft), null, 2)}\n`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      // undefined 值不写出去：JSON.stringify 会丢，但先丢掉能让 diff 更干净
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}
