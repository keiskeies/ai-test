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
     * 所以那边现在成对编码；这条钉住**为什么不能反过来靠"operationId 里没有分隔符"**。
     *
     * ⚠ 但别把这条读成"那个键缺陷今天可达"。撞键还要 **strategy 那一侧也含 `|`**，
     * 而 strategy 是 IR 的闭合 enum、合法值一个都不含 `|`
     * （载体：`ir/test/strategy-enum.test.ts`）。这边只是**必要条件**。
     * 上一轮我把这条当成充分条件登记过，准确的措辞写在被测函数头上。
     */
    const weird = parseOpenApi({
      openapi: '3.0.0', info: { title: 't', version: '1' },
      paths: { '/x': { get: { operationId: 'we|ird|id', responses: { '200': { description: 'ok' } } } } },
    });
    assert.deepEqual(weird.operations.map((o) => o.operationId), ['we|ird|id'], '解析器清洗了 operationId —— 那 lint 那边的键编码可以放宽，这条要跟着改');
    assert.deepEqual(weird.issues.filter((i) => i.level === 'error'), [], '带 | 的 operationId 被报成 error，与"原样透传"矛盾');

    // NUL 同样原样收下。它**单独撑起这条测试的存在理由**：
    // 有人想把键分隔符从 `|` 换成 `\u0000`（"那个字符总不会有吧"），
    // 而这里证明会有 —— NUL 在 JSON 字符串里本来就合法，解析器不拦。
    // 所以"换个更少见的分隔符"不是一种修法，判据写在
    // `engine/test/coverage-delta.test.ts` 那条"换一个分隔符（NUL）不算修好"。
    const nul = String.fromCharCode(0);
    const withNul = parseOpenApi({
      openapi: '3.0.0', info: { title: 't', version: '1' },
      paths: { '/y': { get: { operationId: `a${nul}b`, responses: { '200': { description: 'ok' } } } } },
    });
    assert.deepEqual(withNul.operations.map((o) => o.operationId), [`a${nul}b`], '解析器把 NUL 洗掉了 —— 那"分隔符不许依赖字符不出现"那条判据的依据就变了');
    assert.deepEqual(withNul.issues.filter((i) => i.level === 'error'), [], '带 NUL 的 operationId 被报成 error，与"原样透传"矛盾');
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

  /*
   * 下面这一组测的是 **parseOpenApi 会不会把解不出来的 ref 记成 issue**。
   *
   * 改前的形状：`parseOpenApi` 里那个 `docRef` 闭包是纯透传，"记不记 issue"由**每个
   * 调用点自己决定**，而五个调用点里只有一个记得记（参数合并那一处的
   * `allIssues.push(...d.issues.filter(...))`）。
   *
   * **哪几位在漏是量出来的**：`git worktree` 拉 HEAD，四个位置各喂一个坏 `$ref`，
   * 数 `parseOpenApi` 返回的 issues —— 请求体本身 0 条、请求体的 json schema 0 条、
   * 某个响应码的 schema 0 条，只有**参数的 schema 那一位是 1 条**（它本来就没漏）。
   * 所以前三条是"补上当时真的在漏的那一位"，第四条是**回归守卫**：
   * 修完之后同一位子树被走过两次（`docRef(p)` 与 `docRef(p.schema)`），
   * 那条断言 `恰好 1 条`而不是 2 条，钉的是"改成函数记账之后别把没漏的这处改成重复报"。
   *
   * 为什么必须逐位各写一条：漏的方式恰恰是**逐位**发生的，而
   * "随便哪个位置都会记"式的写法修好任意一位就绿了，另外两位照旧漏 ——
   * 那正是本仓记过的「形状对了不等于走到位」。
   */
  const wrap = (op: Record<string, unknown>) => ({
    openapi: '3.0.0', info: { title: 't', version: '1' },
    paths: { '/z': { post: { operationId: 'z', responses: { '200': { description: 'ok' } }, ...op } } },
  });
  const EXT = { $ref: './common.yaml#/Thing' };

  for (const [name, spec, 位, 改前] of [
    ['请求体的 schema 位', wrap({ requestBody: { content: { 'application/json': { schema: EXT } } } }), 'application/json/schema', '这一位改前在丢'],
    ['整个 requestBody 位', wrap({ requestBody: EXT }), undefined, '这一位改前在丢'],
    ['响应体的 schema 位', wrap({ responses: { '200': { description: 'ok', content: { 'application/json': { schema: EXT } } } } }), 'responses[200]/content/application/json/schema', '这一位改前在丢'],
    ['参数的 schema 位', wrap({ parameters: [{ name: 'q', in: 'query', schema: EXT }] }), 'schema', '这一位改前就记着，此条是防重复报的回归守卫'],
  ] as const) {
    test(`${name}上解不出来的 ref 记成 1 条 error issue（${改前}）`, () => {
      const r = parseOpenApi(spec);
      const hits = r.issues.filter((i) => i.code === 'REF_EXTERNAL_MISSING');
      assert.equal(hits.length, 1, `应恰好记 1 条，实得 ${hits.length}：${JSON.stringify(r.issues)}`);
      assert.equal(hits[0]!.level, 'error', '这类问题会让那一处的契约校验变成空操作，不能降成 warn');
      if (位) assert.ok(hits[0]!.at.endsWith(位), `位置要指到出问题的那一处，实得 ${hits[0]!.at}`);
    });
  }

  test('好的 spec 一条 issue 都不该有（防"改成无条件记一条"这种假修法）', () => {
    const r = parseOpenApi(wrap({
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
      parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
    }));
    assert.deepEqual(r.issues, [], `干净的 spec 上不该冒出 issue：${JSON.stringify(r.issues)}`);
  });

  test('解不出来的 ref **不会**让那条 operation 消失（错误消息不许说谎）', () => {
    /*
     * refs.ts 里那条 error 的原文结尾曾是「该 operation 将被跳过，其余接口照常可用」。
     * 实测是假的：三种位置各喂一个坏 ref，`operations.length` 都是 1、那条照旧在，
     * 变的只有它身上那一处 schema（`undefined` 被调用点的 `asObj` 收成 `{}`）。
     * 一句说错后果的错误比没有错误更坏：人会去数接口列表少了几条，
     * 而真实症状是"这条接口的体校验悄悄变成空操作、用例全绿"。
     * 所以这一条钉的是**消息与实际行为一致**，而不是消息的措辞。
     */
    const r = parseOpenApi(wrap({ requestBody: { content: { 'application/json': { schema: EXT } } } }));
    assert.equal(r.operations.length, 1, 'operation 不该被跳过');
    assert.equal(r.byId.has('z'), true);
    assert.match(r.issues[0]!.message, /按"没有 schema"处理|没有 schema/, `消息要说清真实后果：${r.issues[0]!.message}`);
    assert.doesNotMatch(r.issues[0]!.message, /将被跳过/, '这句话是假的，别写回去');
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
