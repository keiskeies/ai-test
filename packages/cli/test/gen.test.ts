/**
 * 生成器测试（`atest gen`）。
 *
 * 三条判据，全部来自"生成物要能进 git 并且第一天不气跑用户"：
 *  1. **确定性**：同一份 spec 生成两次，字节完全相同。
 *     做不到这一点，"定义可 git diff"这个卖点当场作废（每次生成都一片红）。
 *  2. **生成物必须是合法 IR**：用 defineScenario 真解析一遍。
 *     生成出不合法的 IR 会让用户第一次跑就满屏红，而锅看起来在他那边。
 *  3. **不撒谎**：首轮策略必须带 triage、生成物必须 frozen=false、
 *     跳过的组合必须出现在清单里。这三条都是"看起来覆盖了其实没有"的形态。
 *
 * 断言写在**解析后的 IR** 上而不是 JSON 字符串上，
 * 除了确定性那一条（那条判的就是字节）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineScenario, type Scenario } from '@atest/ir';
import { parseOpenApi, type ParsedDoc } from '@atest/adapter-http';

import { generateScenarios, renderScenarioJson, specHashOf, STRATEGIES, GENERATED_STRATEGY_IDS, strategyOf } from '../src/gen.js';

/** 一份**刻意小但形状齐全**的 spec：path 参数、required 体、enum、边界、2xx 声明 */
const SPEC = {
  openapi: '3.0.0',
  info: { title: 'shop', version: '1' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        responses: { '201': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'number' } } } } } } },
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sku', 'qty'],
                properties: {
                  sku: { type: 'string', minLength: 2, maxLength: 8 },
                  qty: { type: 'integer', minimum: 1, maximum: 99 },
                  channel: { type: 'string', enum: ['web', 'app', 'mp'] },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
      },
      get: { operationId: 'listOrders', responses: { '200': { description: 'ok' } }, parameters: [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }] },
    },
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        responses: { '200': { description: 'ok' }, '404': { description: 'nf' } },
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/health': {
      // **没有 type 的 schema**。这是 sampleFromSchema 返回 {} 的那个已知形态，
      // 之前会被原样塞进 URL 变成 /orders/[object Object]
      get: { operationId: 'health', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { properties: { ok: { type: 'boolean' } } } } } } } },
    },
  },
};

function doc(): ParsedDoc { return parseOpenApi(SPEC); }

function gen(over: Partial<Parameters<typeof generateScenarios>[1]> = {}) {
  return generateScenarios(doc(), { strategies: ['all'], envRef: 'unit', docRef: 'shop', ...over });
}

/** 每个生成都必须是合法 IR。返回解析后的场景 */
function valid(r: ReturnType<typeof gen>): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  for (const s of r.scenarios) out.set(`${s.operationId}/${s.strategy}`, defineScenario(s.draft));
  return out;
}

test('确定性：同一份 spec 两次生成的每个文件字节完全相同（含键序）', () => {
  const a = gen(); const b = gen();
  assert.equal(a.scenarios.length, b.scenarios.length);
  assert.deepEqual(a.scenarios.map((x) => x.file), b.scenarios.map((x) => x.file), '文件清单与顺序都必须稳定');
  for (const [i, s] of a.scenarios.entries()) {
    assert.equal(renderScenarioJson(s.draft), renderScenarioJson(b.scenarios[i]!.draft), `${s.file} 两次生成不一致`);
  }
});

test('输出里没有生成时间戳：generatedAt 一律不填，用 specHash 代替', () => {
  // ProvenanceSchema 有 generatedAt 而这里刻意不用：填了它，
  // "重新生成"必然产生 diff，而 diff 里看不出内容有没有变
  const text = gen().scenarios.map((s) => renderScenarioJson(s.draft)).join('\n');
  assert.doesNotMatch(text, /generatedAt/);
  assert.doesNotMatch(text, /"createdAt"|"updatedAt"/);
});

test('specHash 只随**影响生成的内容**变化：改 description 不该让所有用例的 hash 漂移', () => {
  const h1 = specHashOf(doc());
  const mutated = JSON.parse(JSON.stringify(SPEC));
  mutated.paths['/health'].get.description = '换了个说明文字';
  assert.equal(specHashOf(parseOpenApi(mutated)), h1, 'description 不进哈希');
  mutated.paths['/health'].get.parameters = [{ name: 'x', in: 'query', required: false, schema: { type: 'string' } }];
  assert.notEqual(specHashOf(parseOpenApi(mutated)), h1, '参数变了哈希必须变');
});

test('每个生成物都过 defineScenario（生成出不合法 IR 是生成器的缺陷）', () => {
  const r = gen();
  assert.ok(r.scenarios.length >= 10, `生成得太少：${r.scenarios.length}`);
  const parsed = valid(r);
  assert.equal(parsed.size, r.scenarios.length);
  for (const [k, s] of parsed) {
    assert.equal(s.schemaVersion, '1', k);
    assert.ok(s.body.length >= 1, `${k} 没有步骤`);
    // id 唯一（StepSchema 不管全局唯一，撞了运行期才炸，所以在这里挡）
    const ids = s.body.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${k} 步骤 id 重复`);
  }
});

test('生成物一律 frozen=false：机器没有资格给自己盖"可进 CI"的章', () => {
  for (const s of gen().scenarios) {
    assert.equal(s.draft.frozen, false, `${s.file} 不该是 frozen`);
    const prov = s.draft.provenance as { origin?: string } | undefined;
    assert.equal(prov?.origin, 'imported', '生成物来自 spec 导入。origin 的合法值里没有 generated，硬造一个会让 schema 拒绝');
  }
});

test('首轮非门禁的策略带 tag triage，门禁策略不带（docs/05 §3 要点 1）', () => {
  const byStrategy = new Map<string, Scenario>();
  for (const [k, v] of valid(gen())) {
    const st = k.split('/')[1]!;
    if (!byStrategy.has(st)) byStrategy.set(st, v);
  }
  for (const st of STRATEGIES) {
    const s = byStrategy.get(st.id);
    if (!s) continue; // 本 spec 没造出这个策略
    if (st.gating) assert.ok(!s.tags.includes('triage'), `${st.id} 是门禁策略，不该带 triage`);
    else assert.ok(s.tags.includes('triage'), `${st.id} 首轮必须带 triage，否则第一天就一片红`);
  }
});

test('specHash 进了 tags：这样"哪批用例出自哪版 spec"在 IR 里可见', () => {
  const r = gen();
  for (const s of r.scenarios) assert.ok((s.draft.tags as string[]).includes(r.specHash), s.file);
});

test('跳过的组合必须出现在清单里并给出理由（静默少生成 = 覆盖率是错觉）', () => {
  // /health 没有 path 参数也没有体：notFound / requiredMissing 对它无意义
  const r = gen();
  const reasons = r.skipped.filter((x) => x.operationId === 'health');
  assert.ok(reasons.length >= 2, `health 该有跳过记录，实际：${JSON.stringify(r.skipped)}`);
  for (const x of reasons) {
    assert.ok(x.reason && x.reason.length > 4, `${x.operationId}/${x.strategy} 的跳过没写理由`);
    assert.notEqual(x.strategy, '', '要能看出是哪个策略跳的');
  }
});

test('不可生成的策略在 --strategies all 下不进产物，但要给 warning（不做 ≠ 没有）', () => {
  const r = generateScenarios(doc(), { strategies: ['all'], envRef: 'u', docRef: 'shop' });
  for (const st of STRATEGIES.filter((x) => x.notGenerated)) {
    assert.ok(!GENERATED_STRATEGY_IDS.includes(st.id), `${st.id} 标了 notGenerated 却进了可生成清单`);
    assert.ok(r.warnings.some((w) => w.includes(st.id)), `${st.id} 没在 warning 里说明为什么没做`);
    assert.ok(st.notGenerated!.length > 8, `${st.id} 缺"为什么不做"的理由`);
  }
  assert.ok(!r.scenarios.some((s) => s.strategy === 'authMatrix'), 'authMatrix 需要两个身份，编不出就别编');
});

test('requiredMissing：逐个删必填字段，且**每个字段的报错里带得出字段名**', () => {
  const s = valid(gen({ strategies: ['requiredMissing'] })).get('createOrder/requiredMissing')!;
  // 为什么不用 forEach：循环变量进不了断言的期望值，报错会退化成"第 2 项失败"
  assert.ok(!s.body.some((x) => x.kind === 'forEach'), '不该用 forEach，否则报错指不出是哪个字段');
  const calls = s.body.filter((x) => x.kind === 'openapiCall');
  assert.equal(calls.length, 2, 'createOrder 有 sku/qty 两个必填，应各发一次');
  for (const c of calls) {
    const body = (c as { body?: Record<string, unknown> }).body!;
    assert.ok(!('sku' in body) || !('qty' in body), '每次只该少一个字段');
  }
  // 断言必须是 4xx 区间，**不能接受 500**：后端把缺字段变成 NPE 是另一类缺陷
  const asserts = s.body.filter((x) => x.kind === 'assert') as Array<{ expr?: string }>;
  for (const a of asserts) assert.match(a.expr ?? '', />= 400 && \$ < 500/, `断言形状不对：${a.expr}`);
});

test('typeViolation 与 boundary 只在 schema 有对应信息时生成，否则进跳过清单', () => {
  const r = generateScenarios(doc(), { strategies: ['typeViolation', 'boundary'], envRef: 'u', docRef: 'shop' });
  const files = r.scenarios.map((x) => x.file);
  assert.ok(files.some((f) => f.includes('boundary')), 'createOrder 有 minLength/minimum，boundary 该有产物');
  assert.ok(r.skipped.some((x) => x.operationId === 'health' && x.strategy === 'boundary'));
  const s = valid(generateScenarios(doc(), { strategies: ['boundary'], envRef: 'u', docRef: 'shop' })).get('createOrder/boundary')!;
  // 边界内应 2xx、边界外应 4xx：两侧都要有，只生成一侧等于没测 off-by-one
  const exprs = (s.body.filter((x) => x.kind === 'assert') as Array<{ expr?: string }>).map((x) => x.expr);
  assert.ok(exprs.some((e) => /200 && \$ < 300/.test(e ?? '')), '缺"边界内应通过"那一侧');
  assert.ok(exprs.some((e) => /400 && \$ < 500/.test(e ?? '')), '缺"边界外应拒绝"那一侧');
});

test('notFound 用的是**必定不存在**的字面量 id，而不是样例值', () => {
  const s = valid(gen({ strategies: ['notFound'] })).get('getOrder/notFound')!;
  const call = s.body.find((x) => x.kind === 'openapiCall') as { pathParams?: Record<string, unknown> };
  const id = String(call.pathParams!.id);
  assert.match(id, /not-found/, `id 要一眼看出是造的：${id}`);
  const a = s.body.find((x) => x.kind === 'assert') as { status?: number };
  assert.equal(a.status, 404, '期望必须是 404，不能是"任意 4xx"（200 空对象是最坏的那种错）');
});

test('--path-param-var 提升后引用形态是 $name（IR 原生可解析），且**不动 notFound 那个假 id**', () => {
  const r = gen({ strategies: ['happyPath', 'notFound'], pathParamVar: 'orderId' });
  const parsed = valid(r);
  const happy = parsed.get('getOrder/happyPath')!;
  const call = happy.body.find((x) => x.kind === 'openapiCall') as { pathParams?: Record<string, unknown> };
  assert.equal(call.pathParams!.id, '$orderId', '没提升 = 开关白给');
  // $name 必须在变量空间里查得到（传 inputs 时）。实测 $input.x 是"引用未定义"，
  // 所以这里断言的不是"能解析成字符串"，而是"能真跑通"——见下面 run 那条
  assert.ok((happy.inputs ?? []).some((i) => i.name === 'orderId' && i.required === true), 'input 没声明，UI 表单与 lint 都看不见它');
  // default 刻意不填（引擎不读它）。填了就是"看着有兜底、实际没有"
  const def = (happy.inputs ?? []).find((i) => i.name === 'orderId');
  assert.equal(def?.default, undefined, '不许写 default：引擎从不读它（见 gen.ts 注释）');

  const nf = parsed.get('getOrder/notFound')!;
  const nfCall = nf.body.find((x) => x.kind === 'openapiCall') as { pathParams?: Record<string, unknown> };
  assert.match(String(nfCall.pathParams!.id), /not-found/, '提升会把"必定不存在"变成"可能真存在"，制造一个假的 404 失败');
});

test('没有 type 的 schema 不会把 [object Object] 塞进 URL（发往一个根本不存在的地址）', () => {
  // 无 type 时 sampleFromSchema 返回 {}。之前它直接进 pathParams，
  // 于是 encodeURIComponent({}) → %5Bobject%20Object%5D，用例打的是一个不存在的 URL
  const weird = parseOpenApi({
    openapi: '3.0.0', info: { title: 'w', version: '1' },
    paths: { '/x/{key}': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } }, parameters: [{ name: 'key', in: 'path', required: true, schema: {} }] } } },
  });
  const s = defineScenario(generateScenarios(weird, { strategies: ['happyPath'], envRef: 'u', docRef: 'w' }).scenarios[0]!.draft);
  const call = s.body.find((x) => x.kind === 'openapiCall') as { pathParams?: Record<string, unknown> };
  const v = String(call.pathParams!.key);
  assert.ok(!/object Object|\[object/.test(v), `path 参数是个对象字面量：${v}`);
  assert.ok(v.length > 0 && v.length < 40, `path 参数不像个标量：${v}`);
});

test('spec 写了参数级 example 就用它（两种写法都认），非标量才退回按 schema 造', () => {
  /*
   * `ParamSpec.example` 由 parse.ts 的 `pickExample` 认真解出来，字段注释写着
   * 「mock 与 happyPath 优先生成用」，而**全仓没有一处读它** —— `sampleParams`
   * 当时只看 `p.schema`，于是那句注释在它写下的整个时间里都是假的：
   * 作者照文档写了 `example: 'ORD-9'`，用例打出来的却是 `atest_id`。
   * 危害不是崩，是"我在 spec 里写的这个值在平台上没有任何效果"，
   * 而用户只能回头怀疑自己的 spec 没被认出来（docs/08 §3「schema 有字段、执行侧没人读」）。
   *
   * ⚠ 刻意走 generateScenarios 而不是直接调 `sampleParams`：那条判据的内容是
   * "**生成出来的用例**用了这个值"，直接调函数就把它降级成对一个内部函数的形状断言，
   * 而把 example 接进生成链路这件事本身才是被守的东西。
   */
  const one = (params: unknown[]) => {
    const doc = parseOpenApi({
      openapi: '3.0.0', info: { title: 'w', version: '1' },
      paths: { '/x/{key}': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } }, parameters: params as never } } },
    });
    const s = defineScenario(generateScenarios(doc, { strategies: ['happyPath'], envRef: 'u', docRef: 'w' }).scenarios[0]!.draft);
    const call = s.body.find((x) => x.kind === 'openapiCall') as { pathParams?: Record<string, unknown> };
    return String(call.pathParams!.key);
  };
  const base = { name: 'key', in: 'path', required: true, schema: { type: 'string' } };
  assert.equal(one([{ ...base, example: 'ORD-9' }]), 'ORD-9', '参数级 `example: <值>` 这一种写法没被认出来');
  // OAS3 的第二种写法。parse.ts 注释里记过它自己的同款历史缺陷（在映射本身上找 value），
  // 所以这一格不能只测第一种 —— 那恰好是当初写错的那一半以外的另一半
  assert.equal(one([{ ...base, examples: { first: { value: 'ORD-7' } } }]), 'ORD-7', '`examples: {名: {value}}` 这一种写法没被认出来');
  // 参数级 example 写成对象是合法的（复杂 schema 的文档示例），但它进不了 URL
  const obj = one([{ name: 'key', in: 'path', required: true, schema: { type: 'string' }, example: { a: 1 } }]);
  assert.ok(!/object Object/.test(obj), `对象型 example 直接被塞进路径了：${obj}`);
  assert.equal(obj, 'sample', '对象型 example 要**退回按 schema 造**（有可用值时别扔去用占位符）');
});

test('happyPath 的断言宽松：不断具体取值（从一份 spec 精确推断响应值就是过拟合）', () => {
  const s = valid(gen({ strategies: ['happyPath'] })).get('createOrder/happyPath')!;
  assert.doesNotMatch(JSON.stringify(s.body), /"exact"/, '生成物里出现 exact 说明在写死字面值');
  // 按步骤 id 取结构断言，而不是 JSON.stringify 里搜 'jsonPath' ——
  // zod 给每个 assert 都补了 jsonPath:{}，字符串匹配会先命中 status 那条，
  // 于是循环遍历的是空对象，下面那句 deepEqual 一次都没跑过（测试是空的却绿）
  const shape = s.body.find((x) => x.id === 'shape') as { jsonPath?: Record<string, unknown> };
  const clauses = Object.entries(shape.jsonPath ?? {});
  assert.ok(clauses.length >= 1, 'createOrder 的 201 声明了 required:[id,total]，结构断言不该是空的');
  for (const [path, clause] of clauses) {
    assert.deepEqual(clause, { notNull: true }, `${path} 只该断"存在"，不断具体值/类型`);
  }
});

test('响应没有 schema 时 happyPath 不产出结构断言（恒真的断言比没有断言更坏）', () => {
  const s = valid(gen({ strategies: ['happyPath'] })).get('listOrders/happyPath')!;
  // 判据是"有没有**实际约束**的 jsonPath"，不是字符串里出没出现 jsonPath ——
  // zod 给每个 assert 都补了 jsonPath:{}（空），字符串匹配会把状态码那条也算进来
  const shape = s.body.filter((x) => x.kind === 'assert'
    && Object.keys((x as { jsonPath?: object }).jsonPath ?? {}).length > 0);
  assert.equal(shape.length, 0, `listOrders 的 200 没有 schema，不该凭空造结构断言：${JSON.stringify(shape)}`);
  // 但状态码断言必须在 —— 否则这条用例什么都不检查
  assert.ok(s.body.some((x) => x.kind === 'assert' && JSON.stringify(x).includes('status')));
});

test('状态码取 spec 声明的成功码，没声明才回退，且回退要在描述里说明', () => {
  const s = valid(gen({ strategies: ['happyPath'] })).get('createOrder/happyPath')!;
  const a = s.body.find((x) => x.kind === 'assert' && JSON.stringify(x).includes('status')) as { status?: number[] };
  assert.deepEqual(a.status, [201], 'spec 声明了 201，就该只接受 201');
});

test('enumExhaustive：枚举每个值一条，且值放在**声明它的那个位置**', () => {
  const s = valid(gen({ strategies: ['enumExhaustive'] })).get('createOrder/enumExhaustive')!;
  const calls = s.body.filter((x) => x.kind === 'openapiCall') as Array<{ body?: Record<string, unknown> }>;
  assert.equal(calls.length, 3, 'channel 有 web/app/mp 三个值，该各发一次（只测第一个 = 另两个分支从没跑过）');
  const values = calls.map((c) => c.body!.channel);
  assert.deepEqual(values, ['web', 'app', 'mp'], '枚举值必须**按声明顺序逐个**出现，不能全靠样例值');
  // 其余必填字段仍在：少发一个 required 字段会让 400 看起来像"枚举值不支持"
  for (const c of calls) assert.ok('sku' in c.body! && 'qty' in c.body!, '除枚举字段外的必填字段不能被丢掉');
  // 没有枚举的 operation 必须进跳过清单，而不是产出一条"遍历空集合"的空场景
  const r = gen({ strategies: ['enumExhaustive'] });
  assert.ok(r.skipped.some((x) => x.operationId === 'health' && x.strategy === 'enumExhaustive'));
});

test('spec 没声明 2xx 时回退到 [200,201,204]，并把回退说出来（回退会造成误红）', () => {
  // health 的 200 有 schema 但**没有别的成功码**；造一份完全没写 2xx 的 spec 更狠
  const noCodes = parseOpenApi({
    openapi: '3.0.0', info: { title: 'n', version: '1' },
    paths: { '/p': { get: { operationId: 'ping', responses: { default: { description: 'x' } } } } },
  });
  const r = generateScenarios(noCodes, { strategies: ['happyPath'], envRef: 'u', docRef: 'n' });
  const s = defineScenario(r.scenarios[0]!.draft);
  const a = s.body.find((x) => x.id === 'status') as { status?: number[] };
  assert.deepEqual(a.status, [200, 201, 204], '没声明成功码时要有一个明确回退，而不是不接受任何状态码');
  // 回退必须可见：后端返回 202/206 时会误红，而报错只会说"状态码不符"，
  // 没人想到根因是 spec 没写成功码
  assert.match(JSON.stringify(s.body), /回退|未声明/, '生成物里要说明这个成功码是猜的');
});

test('--path-param-var 对没有 path 参数的 operation 不生效时，必须在 warnings 里说明（静默=开关白给）', () => {
  const r = gen({ strategies: ['happyPath'], pathParamVar: 'orderId' });
  // health/listOrders/createOrder 都没有 path 参数，提升对它们天然不适用。
  // 不适用不该打断整次生成（比例不对），但**也不能不说** ——
  // 用户传了这个开关就该知道它对哪些 operation 没起作用
  const notes = r.warnings.filter((w) => w.includes('--path-param-var'));
  assert.ok(notes.length >= 3, `该有 3 条"没生效"的说明，实际：${JSON.stringify(r.warnings)}`);
  for (const n of notes) assert.match(n, /没生效/);
  // 而有 path 参数的那个必须真的生效（不能只报不做事后反过来）
  const getOrder = r.scenarios.find((x) => x.operationId === 'getOrder');
  assert.ok(getOrder, 'getOrder 该被生成');
  assert.match(JSON.stringify(getOrder.draft.body), /\$orderId/);
});

test('--only / --skip 收窄范围（大 spec 上全量生成不可用时靠它）', () => {
  const only = gen({ strategies: ['happyPath'], only: ['getOrder'] });
  assert.ok(only.scenarios.length >= 1);
  assert.ok(only.scenarios.every((x) => x.operationId === 'getOrder'));
  const skipped = gen({ strategies: ['happyPath'], skip: ['getOrder'] });
  assert.ok(!skipped.scenarios.some((x) => x.operationId === 'getOrder'));
});

test('operationId 排序稳定：spec 换个顺序，生成的文件清单不变', () => {
  const shuffled = JSON.parse(JSON.stringify(SPEC));
  const paths = shuffled.paths as Record<string, unknown>;
  shuffled.paths = { '/health': paths['/health'], '/orders/{id}': paths['/orders/{id}'], '/orders': paths['/orders'] };
  const a = generateScenarios(parseOpenApi(SPEC), { strategies: ['all'], envRef: 'u', docRef: 'shop' });
  const b = generateScenarios(parseOpenApi(shuffled), { strategies: ['all'], envRef: 'u', docRef: 'shop' });
  assert.deepEqual(a.scenarios.map((x) => x.file).sort(), b.scenarios.map((x) => x.file).sort(),
    'spec 里 operation 的书写顺序不该影响生成结果');
});

test('策略表本身自洽：每条都有"在测什么"，可生成的都有实现', () => {
  for (const st of STRATEGIES) {
    assert.ok(st.meaning.length > 10, `${st.id} 的"失败含义"缺失或太短`);
    assert.equal(strategyOf(st.id), st);
  }
  const ids = STRATEGIES.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  // 六条可生成，对齐 docs/05 §3 里"只靠 spec 就能决定"的那些
  assert.deepEqual([...GENERATED_STRATEGY_IDS].sort(),
    ['boundary', 'enumExhaustive', 'happyPath', 'negativeFuzz', 'notFound', 'requiredMissing', 'typeViolation'].sort());
});

test('negativeFuzz 只断"不得 5xx"（断"必须 4xx"会让它变成误报制造机，然后整条策略被关掉）', () => {
  const s = valid(gen({ strategies: ['negativeFuzz'] })).get('createOrder/negativeFuzz')!;
  const exprs = (s.body.filter((x) => x.kind === 'assert') as Array<{ expr?: string }>).map((x) => x.expr ?? '');
  assert.ok(exprs.length >= 5);
  for (const e of exprs) {
    assert.match(e, /< 500/);
    assert.doesNotMatch(e, /400/, 'fuzz 不该要求 4xx：未声明字段被忽略是合规行为');
  }
});

test('写操作场景标 config.dirty（无 teardown 的脏数据是环境越来越糟的根源）', () => {
  const v = valid(gen({ strategies: ['happyPath'] }));
  assert.equal((v.get('createOrder/happyPath')!.config as { dirty?: boolean }).dirty, true, 'POST 该标 dirty');
  assert.ok(!((v.get('getOrder/happyPath')!.config as { dirty?: boolean })?.dirty), 'GET 不该标 dirty');
});
