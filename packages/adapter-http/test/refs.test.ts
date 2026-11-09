/**
 * `$ref` 解析测试（docs/05 §1「$ref 跨文件 + 循环引用」）。
 *
 * 关注点排序：①环不栈溢出 ②坏一条不整体失败 ③外部文档真的被用上。
 * 第三条是本文件里唯一一条「回归测试」性质的：早先 preloadExternals 建的 cache
 * 没有任何人读取，预载是纯装饰 —— 那种 bug 单靠看代码看不出来，只能断言结果。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dereference, collectRefs, pointer, isCycleNode, preloadExternals } from '../src/openapi/refs.js';

const doc = (root: Record<string, unknown>) => ({ root });

describe('pointer', () => {
  test('基本查找与 ~0/~1 转义', () => {
    const d = { a: { b: { c: 1 } }, 'x/y': 2, 'm~n': 3 };
    assert.equal(pointer(d, '/a/b/c'), 1);
    assert.equal(pointer(d, '/x~1y'), 2);
    assert.equal(pointer(d, '/m~0n'), 3);
    assert.equal(pointer(d, '/a/b/missing'), undefined);
    // 缺失与「值是 undefined/null」不能混为一谈：缺失要报 REF_UNRESOLVED
    assert.equal(pointer({ a: null }, '/a'), null);
  });

  test('穿过数组下标', () => {
    assert.equal(pointer({ list: [{ id: 7 }] }, '/list/0/id'), 7);
  });
});

describe('dereference', () => {
  test('链式 ref 一路解到底', () => {
    const d = doc({ a: { $ref: '#/b' }, b: { $ref: '#/c' }, c: { type: 'string' } });
    assert.deepEqual(dereference({ $ref: '#/a' }, d).value, { type: 'string' });
  });

  test('自引用环 -> x-cycle 标记，而不是 RangeError', () => {
    const d = doc({ Node: { type: 'object', properties: { child: { $ref: '#/Node' } } } });
    const r = dereference({ $ref: '#/Node' }, d);
    assert.equal(r.issues.length, 0, `环不该报 issue：${JSON.stringify(r.issues)}`);
    const child = (r.value as { properties: { child: unknown } }).properties.child;
    assert.ok(isCycleNode(child), `环该被标成 x-cycle，实得 ${JSON.stringify(child)}`);
    assert.equal(child['x-cycle'], '#/Node');
  });

  test('互引用环（A->B->A）也能终止', () => {
    const d = doc({ A: { properties: { b: { $ref: '#/B' } } }, B: { properties: { a: { $ref: '#/A' } } } });
    const r = dereference({ $ref: '#/A' }, d);
    const a = r.value as { properties: { b: { properties: { a: unknown } } } };
    assert.ok(isCycleNode(a.properties.b.properties.a));
  });

  test('通过数组的环（children: array<Node>）—— 真实 spec 里最常见的那种', () => {
    const d = doc({ Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/Node' } } } } });
    const r = dereference({ $ref: '#/Node' }, d);
    const items = (r.value as { properties: { children: { items: unknown } } }).properties.children.items;
    assert.ok(isCycleNode(items));
  });

  test('无环但极深的 spec 被截断并上报，而不是卡死', () => {
    // 层层 allOf 展开后是指数级的，环检测管不了，所以要深度上限
    const deep: Record<string, unknown> = { type: 'object' };
    let cur = deep;
    for (let i = 0; i < 40; i++) {
      const nxt: Record<string, unknown> = { type: 'object' };
      (cur as { properties: Record<string, unknown> }).properties = { n: nxt };
      cur = nxt;
    }
    const r = dereference(deep, doc(deep), { maxDepth: 6 });
    assert.ok(r.issues.some((i) => /嵌套超过/.test(i.message)), '超深必须上报，否则用户只看到 schema 莫名缺一块');
    // 而且截断处要留下标记节点，让数据生成器知道"这里别再往下造了"
    assert.ok(JSON.stringify(r.value).includes('maxDepth'), '截断必须留下可识别的标记');
  });

  test('ref 指不到位置 -> error issue，且**不抛异常**（其余 operation 要能继续解析）', () => {
    const r = dereference({ properties: { a: { $ref: '#/nope' } } }, doc({}));
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0]!.code, 'REF_UNRESOLVED');
    assert.equal(r.issues[0]!.level, 'error');
    // 报错必须带位置，否则 3000 行的 spec 里没人能找到是哪条
    assert.match(r.issues[0]!.at, /\/properties\/a/);
  });

  test('$ref 旁的 description 被保留（3.0 语义上该忽略，但丢掉它=丢掉最有用的语义线索）', () => {
    const d = doc({ User: { type: 'object', properties: { id: { type: 'string' } } } });
    const r = dereference({ $ref: '#/User', description: '登录用户' }, d);
    assert.equal((r.value as { description?: string }).description, '登录用户');
    assert.ok(r.issues.some((i) => /3\.0/.test(i.message)), '保留兄弟键是对 3.0 语义的偏离，必须留痕');
  });

  test('兄弟键不覆盖被引用处已有的值', () => {
    const d = doc({ U: { type: 'object', description: '原始说明' } });
    const r = dereference({ $ref: '#/U', description: '覆盖尝试' }, d);
    assert.equal((r.value as { description: string }).description, '原始说明');
  });
});

describe('外部文档 $ref', () => {
  const common = { Error: { type: 'object', properties: { code: { type: 'integer' } } } };

  test('同步解析器能解外部 ref', () => {
    const d = { root: { x: { $ref: './common.yaml#/Error' } }, resolveExternal: (uri: string) => (uri === './common.yaml' ? common : undefined) };
    const r = dereference({ $ref: './common.yaml#/Error' }, d);
    assert.deepEqual(r.value, common.Error);
    assert.equal(r.issues.length, 0);
  });

  test('外部文档缺失 -> error issue 并跳过，不影响同批其它 ref', () => {
    const d = { root: {}, resolveExternal: () => undefined };
    const r = dereference({ properties: { bad: { $ref: './gone.yaml#/X' }, good: { type: 'string' } } }, d);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0]!.code, 'REF_EXTERNAL_MISSING');
    assert.deepEqual((r.value as { properties: Record<string, unknown> }).properties.good, { type: 'string' });
  });

  test('preloadExternals 的结果**真的**被 dereference 用上（不是预载了没人读）', () => {
    // 这条是回归测试：早先 dereference 内部自己 new 了一个空 cache，
    // 于是 preload 纯属白干，每次解析都退回「外部文档不存在」。
    const { cache } = { cache: new Map<string, unknown>([['./common.yaml', common]]) };
    const r = dereference({ $ref: './common.yaml#/Error' }, { root: {} }, { externals: cache });
    assert.deepEqual(r.value, common.Error, '传了 externals 却解不出来，说明 cache 没接上');
    assert.equal(r.issues.length, 0);
  });

  test('preloadExternals 单个失败只记 issue，其余照常入 cache', async () => {
    const { cache, issues } = await preloadExternals(
      { root: { a: { $ref: './ok.yaml#/X' }, b: { $ref: './boom.yaml#/Y' } } },
      async (uri) => { if (uri.includes('boom')) throw new Error('404'); return common; },
    );
    assert.equal(cache.size, 1);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /404/);
  });

  test('内部 ref 不会被当成外部去预载', async () => {
    const { cache, issues } = await preloadExternals({ root: { a: { $ref: '#/X' } } }, async () => { throw new Error('不该被调用'); });
    assert.equal(cache.size, 0);
    assert.equal(issues.length, 0);
  });

  test('同一个外部文档只拉一次', async () => {
    let calls = 0;
    await preloadExternals({ root: { a: { $ref: './c.yaml#/X' }, b: { $ref: './c.yaml#/Y' } } }, async () => { calls++; return common; });
    assert.equal(calls, 1);
  });
});

describe('collectRefs', () => {
  test('穿透数组与嵌套，收集去重', () => {
    const refs = collectRefs({ a: { $ref: '#/A' }, list: [{ $ref: '#/B' }, { c: { $ref: '#/A' } }] });
    assert.deepEqual([...refs].sort(), ['#/A', '#/B']);
  });
});
