/**
 * OpenAPI 解析测试（M2 主体）。fixture 见 ./fixtures.ts，是照 docs/05 §1
 * 「真实世界的 spec 有多脏」那张表逐条埋出来的。
 *
 * 判据顺序：①脏数据不导致整体失败 ②security 继承语义正确 ③参数合并正确
 * ④别名单独在 alias.test.ts 覆盖，这里只验证它接上了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi } from '../src/openapi/parse.js';
import { dereference, isCycleNode } from '../src/openapi/refs.js';
import { dirtySpec, commonYaml } from './fixtures.js';

/** schema 是 Record<string, unknown>，逐层点下去会撞到 unknown，统一在这里收窄一次 */
const propsOf = (schema: Record<string, unknown> | undefined): Record<string, unknown> =>
  ((schema?.properties ?? {}) as Record<string, unknown>);

const parsed = parseOpenApi(dirtySpec);
const op = (id: string) => {
  const o = parsed.byId.get(id);
  assert.ok(o, `operation "${id}" 没解析出来。已有的：${[...parsed.byId.keys()].join(', ')}；issues：${JSON.stringify(parsed.issues)}`);
  return o;
};

describe('整体可用性：脏 spec 必须**基本能用**', () => {
  test('大部分 operation 解析成功，坏的那条只让自己失败', () => {
    // 「导入失败」= 用户面对空平台；「1 条跳过」= 用户能立刻开工。这是质的差别。
    assert.ok(parsed.byId.has('health'), '一条坏 operation 不该拖垮整份文档');
    assert.ok(parsed.byId.has('listUsers'));
    assert.ok(parsed.byId.has('createOrder'));
    assert.ok(parsed.issues.some((i) => i.code === 'REF_UNRESOLVED'), '坏的 $ref 必须被报出来');
  });

  test('空 operation（get: {}）不被收成一条 operation', () => {
    // 收进来会得到"存在但啥都没有"的接口，然后为它生成一堆垃圾用例
    assert.equal(parsed.byId.has('getEmpty'), false);
    assert.ok(!parsed.operations.some((o) => o.path === '/empty'));
  });

  test('缺 operationId 的走确定性别名，并标记 generated', () => {
    const o = op('getOrdersId');
    assert.equal(o.aliasGenerated, true);
    assert.equal(o.method, 'GET');
  });
  test('作者手写的 operationId 不算 generated', () => {
    assert.equal(op('listUsers').aliasGenerated, false);
  });

  test('operationId 是**原样透传的自由字符串**，不做字符集限制', () => {
    /*
     * 这条不是"顺手测一下怪名字"。`engine/lint.ts` 的 `coverageDelta` 从前用
     * `${operationId}|${strategy}` 拼键去重，而它成立的前提就是"operationId 里没有 `|`"。
     * 那个前提**在这里被否掉**：spec 作者写什么我们收什么，解析器不清洗。
     * 于是 `(a|b, boundary)` 与 `(a, b|boundary)` 会拼成同一个键，
     * 一条真新增的用例被算成重复 —— 而那一栏的用途正是"增量为 0 就劝人别生成"。
     * 所以那边现在成对编码；这条钉住**为什么不能反过来靠"operationId 里没有分隔符"**。
     */
    const weird = parseOpenApi({
      openapi: '3.0.0', info: { title: 't', version: '1' },
      paths: { '/x': { get: { operationId: 'we|ird|id', responses: { '200': { description: 'ok' } } } } },
    });
    assert.deepEqual(weird.operations.map((o) => o.operationId), ['we|ird|id'], '解析器清洗了 operationId —— 那 lint 那边的键编码可以放宽，这条要跟着改');
    assert.deepEqual(weird.issues.filter((i) => i.level === 'error'), [], '带 | 的 operationId 被报成 error，与"原样透传"矛盾');
  });

  test('servers[0].url 只作为**建议值**返回，不参与任何解析结果', () => {
    // docs/05 §1：spec 的 servers 几乎总是错的；URL 必须来自环境配置
    assert.equal(parsed.suggestedBaseUrl, 'https://spec-says-this-is-wrong.example.com/v1');
    assert.ok(!JSON.stringify(parsed.operations).includes('spec-says-this-is-wrong'), 'operation 里绝不能带上 spec 的 servers');
  });

  test('securitySchemes 被收集（鉴权层要用）', () => {
    assert.deepEqual(Object.keys(parsed.securitySchemes).sort(), ['apiKeyQuery', 'bearerAuth']);
  });

  test('Swagger 2.0 明确拒绝，而不是硬解成半份文档', () => {
    const r = parseOpenApi({ swagger: '2.0', paths: {} });
    assert.equal(r.operations.length, 0);
    assert.match(r.issues[0]!.message, /Swagger 2\.0 暂不支持/);
  });

  test('根本不是文档时报错而不是返回空表', () => {
    const r = parseOpenApi({ hello: 'world' });
    assert.match(r.issues[0]!.message, /不是 OpenAPI/);
  });

  test('传 null / 数组 / 字符串都不抛异常（前端会拿用户粘贴的任意文本喂它）', () => {
    for (const bad of [null, undefined, 42, [], 'text']) {
      const r = parseOpenApi(bad);
      assert.equal(r.operations.length, 0);
      assert.ok(r.issues.length >= 1);
    }
  });
});

describe('security 继承（docs/05 §1 第 6 行：解析错=一堆 401 假用例）', () => {
  test('没写 security 的继承 spec 级', () => {
    assert.deepEqual(op('listUsers').security, [{ bearerAuth: [] }]);
  });
  test('`security: []` 是**显式公开**，不继承 spec 级', () => {
    const o = op('health');
    assert.deepEqual(o.security, [], '空数组被当成"没写"就会给公开接口生成一堆带 token 的用例');
  });
  test('operation 级覆盖 spec 级', () => {
    assert.deepEqual(op('login').security, [{ apiKeyQuery: [] }]);
  });
});

describe('参数合并与补全', () => {
  test('path 模板里的参数没写定义 -> 自动补成 required 的 string', () => {
    const o = op('getOrdersId');
    const id = o.params.find((p) => p.name === 'id');
    assert.ok(id, '缺 definitions 也必须能发请求');
    assert.equal(id.in, 'path');
    assert.equal(id.required, true, 'path 参数按规范必选，与 spec 写没写 required 无关');
  });
  test('$ref 参数被解开', () => {
    const page = op('getOrdersId').params.find((p) => p.name === 'page');
    assert.deepEqual(page?.schema, { type: 'integer', default: 1 });
  });
  test('operation 级同名同 in **覆盖** path 级，而不是追加成两条', () => {
    const o = op('listUsers');
    const qs = o.params.filter((p) => p.name === 'q');
    assert.equal(qs.length, 1, `同名参数出现 ${qs.length} 次会生成两条冲突的 query`);
    assert.deepEqual(qs[0]!.schema, { type: 'array', items: { type: 'string' } });
    assert.equal(qs[0]!.style, 'pipeDelimited');
    assert.equal(qs[0]!.explode, false);
  });
  test('path 级独有的参数保留', () => {
    assert.ok(op('listUsers').params.some((p) => p.name === 'page'));
  });
  test('参数级 example 从 examples（复数）映射里取 value', () => {
    // 早先写成在映射本身找 .value，永远 undefined
    const withEx = parseOpenApi({
      openapi: '3.0.0',
      paths: { '/x': { get: { operationId: 'x', parameters: [{ name: 'a', in: 'query', examples: { d: { value: 'V' } }, schema: { type: 'string' } }], responses: {} } } },
    });
    assert.equal(withEx.byId.get('x')!.params[0]!.example, 'V');
  });
});

describe('请求体', () => {
  test('application/json 的 schema 被解引用，required 字段暴露出来', () => {
    const o = op('createOrder');
    assert.deepEqual(propsOf(o.requestBodySchema).id, { type: 'string' });
    assert.equal(o.requestBodyRequired, true);
    assert.deepEqual(o.requiredBodyFields, ['id', 'amount'], 'requiredMissing 策略要逐个删这些字段');
  });
  test('响应侧多 example：取第一个并**记下 warn**（挑哪个是语义决定，平台不替用户挑）', () => {
    const r = parseOpenApi({
      openapi: '3.0.0',
      paths: { '/m': { get: { operationId: 'm', responses: { '200': { description: 'ok', content: {
        'application/json': { examples: { a: { value: 1 }, b: { value: 2 } } } } } } } } },
    });
    assert.equal(r.byId.get('m')!.examples['200'], 1, '该取第一个条目');
    const w = r.issues.find((i) => /example/.test(i.message));
    assert.ok(w, '多 example 必须留痕，否则用户以为 mock 会返回全部样例');
    assert.equal(w!.level, 'warn');
    assert.match(w!.message, /只取第一个 "a"/);
  });
  test('响应 example 按状态码取到', () => {
    assert.deepEqual(op('getOrdersId').examples['200'], { id: 'A1', amount: 5 });
  });
  test('非 JSON 请求体记 warn 说明为什么没做校验（静默跳过比报错更坏）', () => {
    const o = op('uploadAvatar');
    assert.equal(o.requestBodySchema, undefined);
    assert.ok(parsed.issues.some((i) => i.level === 'warn' && /multipart/.test(i.message)));
  });
});

describe('响应与 deprecated', () => {
  test('响应 schema 解引用，状态码为键', () => {
    const o = op('getOrdersId');
    assert.deepEqual(propsOf(o.responses['404']?.schema).code, { type: 'integer' });
    assert.equal(o.responses['204']?.schema, undefined);
  });
  test('deprecated 保留在表里但打标记（默认不生成用例，UI 折叠显示）', () => {
    assert.equal(op('removeOrder').deprecated, true);
    assert.equal(op('listUsers').deprecated, false);
  });
});

describe('循环 schema', () => {
  test('Order.items[].parent 处插环标记，解析不栈溢出', () => {
    const o = op('createOrder');
    const items = propsOf(o.requestBodySchema).items as { items?: { properties?: Record<string, unknown> } };
    const parent = items?.items?.properties?.parent;
    // 用 isCycleNode 而不是 `'x-cycle' in parent`：parent 是 unknown，
    // TS 不允许对可能为原始值的类型用 in（而且 isCycleNode 才是这个标记的正式判据）
    assert.ok(isCycleNode(parent), `期望环标记，实得 ${JSON.stringify(parent)}`);
    assert.equal(parent['x-cycle'], '#/components/schemas/Order');
  });
});

describe('外部 $ref', () => {
  test('提供了 externals 就能解外部 ref', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/p': { get: { operationId: 'p', parameters: [{ name: 'page', in: 'query', schema: { $ref: './common.yaml#/Pagination' } }], responses: {} } } },
    };
    const externals = new Map<string, unknown>([['./common.yaml', commonYaml]]);
    // parseOpenApi 目前不接 externals（它内部构造 SpecDoc），外部文档要由调用方注入。
    // 这里先用底层 dereference 验通路；服务端导入路径接上后这条要改成走 parseOpenApi。
    const r = dereference({ $ref: './common.yaml#/Pagination' }, { root: spec }, { externals });
    assert.deepEqual(r.value, commonYaml.Pagination);
  });
});

describe('别名冲突是**唯一**允许阻断解析的失败', () => {
  test('冲突时返回 error issue 而不是抛异常（CLI 要能打印可读报错）', () => {
    const r = parseOpenApi({ openapi: '3.0.0', paths: { '/a': { get: { operationId: 'dup', responses: {} } }, '/b': { get: { operationId: 'dup', responses: {} } } } });
    assert.equal(r.operations.length, 0);
    assert.match(r.issues[0]!.message, /operation_alias/);
  });
  test('给了覆盖表就能解开', () => {
    const r = parseOpenApi(
      { openapi: '3.0.0', paths: { '/a': { get: { operationId: 'dup', responses: {} } }, '/b': { get: { operationId: 'dup', responses: {} } } } },
      { aliasOverrides: { 'GET /b': 'bOp' } },
    );
    assert.deepEqual([...r.byId.keys()].sort(), ['bOp', 'dup']);
  });
});
