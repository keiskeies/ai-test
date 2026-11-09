/**
 * schema 校验测试。重点是**三类误判**，它们各自对应一种"用例永远绿/永远红"的事故：
 *  - nullable 没翻译 -> 合法请求被判非法（一片红，然后团队关掉门禁）
 *  - format 判失败   -> 文档与实现的小出入刷成 bug（同上）
 *  - schema 编译失败静默返回 ok -> 该报的不报（最坏：假绿）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileValidator, validateAgainstSchema, isValid } from '../src/openapi/validate.js';

const v = (schema: Record<string, unknown>) => compileValidator(schema);

describe('基本判定', () => {
  test('合法对象通过', () => {
    const r = v({ type: 'object', required: ['id'], properties: { id: { type: 'string' }, n: { type: 'integer' } } })({ id: 'a', n: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });
  test('缺必填字段：hard 违例，且**指名缺了哪个**', () => {
    const r = v({ type: 'object', required: ['id', 'amount'], properties: { id: { type: 'string' } } })({ id: 'a' });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]!.keyword, 'required');
    assert.match(r.violations[0]!.message, /amount/);
  });
  test('类型不符 + 路径定位到嵌套位置', () => {
    const r = v({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } } } })
      ({ items: [{ sku: 'ok' }, { sku: 5 }] });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]!.path, '$.items[1].sku', '报错必须指得出是哪个元素的哪个字段');
  });
  test('枚举报错列出允许值（生成的用例要能自动改对）', () => {
    const r = v({ type: 'string', enum: ['new', 'paid'] })('xxx');
    assert.match(r.violations[0]!.message, /允许值 \["new","paid"\]/);
  });
  test('空 schema 什么都放过（缺 schema 的 operation 不该全红）', () => {
    assert.equal(v({})({ anything: 1 }).ok, true);
    assert.equal(v(undefined as unknown as Record<string, unknown>)?.({ a: 1 }).ok ?? true, true);
  });
});

describe('OAS3 方言翻译（docs/05 §1）', () => {
  test('nullable: true 允许 null —— 不翻译的话合法请求会被判非法', () => {
    const s = { type: 'object', properties: { note: { type: 'string', nullable: true } } };
    assert.equal(v(s)({ note: null }).ok, true, 'nullable 没被翻译成 type 联合，合法请求被误杀');
    assert.equal(v(s)({ note: 5 }).ok, false, '翻译过头了：非 null 的值也该管');
  });
  test('nullable 作用在已是数组的 type 上不重复加 null', () => {
    const r = v({ type: 'object', properties: { x: { type: ['string', 'null'], nullable: true } } })({ x: null });
    assert.equal(r.ok, true);
  });
  test('OAS 专有键被摘掉，不让 ajv 因未知关键字整体报错', () => {
    const s = { type: 'object', discriminator: { propertyName: 'k' }, example: { k: 'a' }, properties: { k: { type: 'string' } }, required: ['k'] };
    const val = v(s);
    assert.deepEqual(val.schemaIssues, [], `OAS 专有键导致编译失败：${val.schemaIssues}`);
    assert.equal(val({ k: 'a' }).ok, true);
  });
  test('环 schema（x-cycle）以下不再校验，而不是栈溢出', () => {
    const s = { type: 'object', properties: { child: { 'x-cycle': '#/Node' } } };
    const val = v(s);
    assert.equal(val({ child: { whatever: [1, 2, 3] } }).ok, true);
    assert.deepEqual(val.schemaIssues, []);
  });
});

describe('format 只算契约发现（docs/05 §1 最后一行）', () => {
  test('format 不符是 contract 级，不使整体失败', () => {
    const r = v({ type: 'string', format: 'date-time' })('2024/01/01 00:00');
    assert.equal(r.ok, true, 'format 判失败会把"文档与实现不一致"刷成真 bug，团队会关掉门禁');
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.severity, 'contract');
    assert.equal(r.violations[0]!.keyword, 'format');
  });
  test('isValid 只看 hard 违例', () => {
    assert.equal(isValid(v({ type: 'string', format: 'email' })('nope')), true);
    assert.equal(isValid(v({ type: 'string' })(5)), false);
  });
  test('结构违例不会被 format 的宽松带过去', () => {
    const r = v({ type: 'object', required: ['a'], properties: { a: { type: 'string', format: 'email' } } })({});
    assert.equal(r.ok, false);
    assert.equal(r.violations[0]!.severity, 'hard');
  });
});

describe('schema 自身有问题时必须**响亮失败**', () => {
  test('无法编译的 schema 记进 schemaIssues（不能静默返回 ok）', () => {
    const val = v({ type: 'object', properties: { a: { type: 'not-a-real-type' } } });
    assert.ok(val.schemaIssues.length > 0, '编译失败被吞掉 = 这个校验器永远绿灯，比没校验更危险');
  });
  test('校验器抛异常时报 hard 违例而不是放行', () => {
    // $data 指向不存在的字段会让 ajv 在运行时抛
    const val = v({ type: 'object', properties: { a: { const: { $data: '99/nope' } } } });
    const r = val({ a: 1 });
    // 要么编译期就记 issue，要么运行期报违例 —— 总之不能"看着通过"
    assert.ok(val.schemaIssues.length > 0 || r.violations.some((x) => x.keyword === 'validatorError'), JSON.stringify(r));
  });
});

describe('响应侧契约校验（contract 策略）', () => {
  test('缺字段只出 contract 级，整体不失败', () => {
    const r = validateAgainstSchema({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { other: 1 });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.severity, 'contract');
    assert.equal(r.ok, false, 'contract 违例仍然要能被 contract 车道捞出来');
  });
  test('没有 schema（spec 没写响应体）时不算任何违例', () => {
    assert.deepEqual(validateAgainstSchema(undefined, { whatever: true }), { ok: true, violations: [] });
    assert.deepEqual(validateAgainstSchema({}, { whatever: true }), { ok: true, violations: [] });
  });
  test('oneOf 响应：匹配任一分支即通过（docs/05 §1：否则必 flaky）', () => {
    const s = { oneOf: [{ type: 'object', required: ['cat'], properties: { cat: { type: 'string' } } }, { type: 'object', required: ['dog'], properties: { dog: { type: 'string' } } }] };
    assert.equal(validateAgainstSchema(s, { dog: 'x' }).violations.length, 0);
    assert.equal(validateAgainstSchema(s, { fish: 'x' }).violations.length > 0, true);
  });
});

describe('脱敏：违例信息里不得出现实际值', () => {
  test('校验失败的敏感对象，其值不出现在任何报错字段里', () => {
    const r = v({ type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 99 } } })({ password: 'Sup3r-Secret-Value' });
    assert.equal(r.ok, false);
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes('Sup3r-Secret-Value'), `报错信息里泄露了实际值：${blob}`);
  });
});
