/**
 * style × explode 序列化测试。
 *
 * 断言值**逐格照抄 OAS 3.0 规范的 style 示例表**（id=3 / role=admin, firstName=Alex 那两组）。
 * 这种纯映射代码自己跟自己约定没有意义：如果实现和测试都按同一份误解写，
 * 测试全绿而发出去的请求全是错的 —— 而"错"的表现形式是后端把缺参数当默认值处理，
 * 用例照样 200 照样绿。只有外部权威表能发现它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { styleParam, buildQuery, fillPath, defaultStyle, DEFAULT_EXPLODE, StyleError, type ParamStyle } from '../src/openapi/style.js';

/** 规范表里 query 那几行的期望是"查询串片段"，这里统一从 pairs/raw 还原成它。 */
function q(name: string, value: unknown, style: ParamStyle, explode: boolean): string {
  return buildQuery([{ name, value, style, explode }]).slice(1);
}
/** path 那几行的期望是"路径片段"（含前导 /）。 */
function p(name: string, value: unknown, style: ParamStyle, explode: boolean): string {
  const { url, missing } = fillPath(`/x/{id}`, new Map<string, unknown>([[name, value]]), () => ({ style, explode }));
  assert.deepEqual(missing, []);
  return url.slice(2); // 去掉 /x
}

describe('规范默认值', () => {
  test('style 默认随位置：query/cookie=form，path/header=simple', () => {
    assert.equal(defaultStyle('query'), 'form');
    assert.equal(defaultStyle('cookie'), 'form');
    assert.equal(defaultStyle('path'), 'simple');
    assert.equal(defaultStyle('header'), 'simple');
  });

  test('explode 默认 **true**（这条最容易记反）', () => {
    assert.equal(DEFAULT_EXPLODE, true);
    // 记成 false 的话，数组查询参数会静默变成逗号形式
    assert.equal(q('id', [3, 4, 5], 'form', undefined as unknown as boolean), 'id=3&id=4&id=5');
  });
});

describe('query：style=form（规范表 5.1）', () => {
  test('array + explode=true -> id=3&id=4&id=5', () => {
    assert.equal(q('id', [3, 4, 5], 'form', true), 'id=3&id=4&id=5');
  });
  test('array + explode=false -> id=3,4,5', () => {
    assert.equal(q('id', [3, 4, 5], 'form', false), 'id=3,4,5');
  });
  test('object + explode=true -> 拆成独立键，且顺序按对象键序', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'form', true), 'role=admin&firstName=Alex&age=42');
  });
  test('object + explode=false -> id=role,admin,firstName,Alex,age,42', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'form', false), 'id=role,admin,firstName,Alex,age,42');
  });
  test('标量 -> id=5', () => {
    assert.equal(q('id', 5, 'form', true), 'id=5');
  });
});

describe('query：spaceDelimited / pipeDelimited（规范表 5.3/5.4）', () => {
  test('space + explode=false -> id=3%204%205（是 %20 不是 +）', () => {
    // URLSearchParams 会把空格编成 '+'，而规范要求 %20。
    // 这是本文件唯一"不能用标准库一把梭"的地方。
    assert.equal(q('id', [3, 4, 5], 'spaceDelimited', false), 'id=3%204%205');
    assert.ok(!q('id', [3, 4, 5], 'spaceDelimited', false).includes('+'));
  });
  test('pipe + explode=false -> id=3|4|5', () => {
    assert.equal(q('id', [3, 4, 5], 'pipeDelimited', false), 'id=3|4|5');
  });
  test('space/pipe + explode=true -> 退化成重复键', () => {
    assert.equal(q('id', [3, 4, 5], 'spaceDelimited', true), 'id=3&id=4&id=5');
    assert.equal(q('id', [3, 4, 5], 'pipeDelimited', true), 'id=3&id=4&id=5');
  });
  test('space/pipe 用在对象上报错，不猜一种形式', () => {
    assert.throws(() => q('id', { a: 1 }, 'pipeDelimited', false), StyleError);
  });
});

describe('query：style=deepObject（规范表 5.5）', () => {
  test('object + explode=true -> id[role]=admin&id[firstName]=Alex', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'deepObject', true), 'id[role]=admin&id[firstName]=Alex&id[age]=42');
  });
  test('deepObject 只适用对象，数组报错', () => {
    assert.throws(() => q('id', [1, 2], 'deepObject', true), /deepObject 只适用于对象/);
  });
});

describe('path：simple / label / matrix（规范表 6.x）', () => {
  const obj = { role: 'admin', firstName: 'Alex', age: 42 };
  test('simple：数组两种 explode 同结果 3,4,5', () => {
    assert.equal(p('id', [3, 4, 5], 'simple', true), '/3,4,5');
    assert.equal(p('id', [3, 4, 5], 'simple', false), '/3,4,5');
  });
  // 注意 explode 在 simple+object 下**确实改变结果**：true 保留 `k=v`，false 只留值
  test('simple：object explode=true -> /role=admin,firstName=Alex,age=42', () => {
    assert.equal(p('id', obj, 'simple', true), '/role=admin,firstName=Alex,age=42');
  });
  test('simple：object explode=false -> /role,admin,firstName,Alex,age,42', () => {
    assert.equal(p('id', obj, 'simple', false), '/role,admin,firstName,Alex,age,42');
  });
  test('label：array -> /.3.4.5；object explode=true -> /.role=admin.firstName=Alex.age=42', () => {
    assert.equal(p('id', [3, 4, 5], 'label', true), '/.3.4.5');
    assert.equal(p('id', obj, 'label', true), '/.role=admin.firstName=Alex.age=42');
    assert.equal(p('id', obj, 'label', false), '/.role,admin,firstName,Alex,age,42');
  });
  test('matrix：array explode=true -> /;id=3;id=4;id=5；false -> /;id=3,4,5', () => {
    assert.equal(p('id', [3, 4, 5], 'matrix', true), '/;id=3;id=4;id=5');
    assert.equal(p('id', [3, 4, 5], 'matrix', false), '/;id=3,4,5');
  });
  test('matrix：object explode=true -> /;role=admin;firstName=Alex；false -> /;id=role,admin,...', () => {
    assert.equal(p('id', obj, 'matrix', true), '/;role=admin;firstName=Alex;age=42');
    assert.equal(p('id', obj, 'matrix', false), '/;id=role,admin,firstName,Alex,age,42');
  });
});

describe('编码边界', () => {
  test('查询值里的特殊字符被逐值编码（不是先拼串再整体编）', () => {
    assert.equal(buildQuery([{ name: 'q', value: 'a&b=c' }]).slice(1), 'q=a%26b%3Dc');
    assert.equal(buildQuery([{ name: 'q', value: '中文 名' }]).slice(1), 'q=%E4%B8%AD%E6%96%87%20%E5%90%8D');
  });
  test('path 值里的 / 被编码，不会凭空多一段路径', () => {
    const { url } = fillPath('/f/{name}', new Map([['name', 'a/b']]));
    assert.equal(url, '/f/a%2Fb');
  });
  test('path 值里的中文被编码', () => {
    assert.equal(fillPath('/u/{n}', new Map([['n', '张三']])).url, '/u/%E5%BC%A0%E4%B8%89');
  });
  test('值里有 = 时，查询串的键仍可正确还原', () => {
    const qs = buildQuery([{ name: 'k', value: 'a=b' }]).slice(1);
    assert.equal([...new URLSearchParams(qs)].length, 1);
    assert.equal(new URLSearchParams(qs).get('k'), 'a=b');
  });
});

describe('fillPath 的失败模式', () => {
  test('缺参数：保留 {id} 并列出缺失名（静默留下 {id} 会得到一个查不出原因的 404）', () => {
    const r = fillPath('/o/{id}/x/{x}', new Map([['id', 1]]));
    assert.equal(r.url, '/o/1/x/{x}');
    assert.deepEqual(r.missing, ['x']);
  });
  test('null 值也算缺失（发 `?x=` 与不发这个参数语义不同）', () => {
    assert.deepEqual(fillPath('/o/{id}', new Map([['id', null]])).missing, ['id']);
  });
  test('多个参数、重复占位（同一参数出现两次）都填上', () => {
    const r = fillPath('/u/{id}/x/{id}', new Map([['id', 7]]));
    assert.equal(r.url, '/u/7/x/7');
    assert.deepEqual(r.missing, []);
  });
  test('无占位符的模板原样返回，且不产生 ?', () => {
    assert.equal(fillPath('/health', new Map()).url, '/health');
    assert.equal(buildQuery([]), '');
  });
});

describe('确定性', () => {
  test('同一输入两次序列化字节完全一致（mock 匹配与 trace diff 依赖它）', () => {
    const items = [
      { name: 'a', value: [1, 2, 3] },
      { name: 'b', value: { x: 1, y: 2 } },
      { name: 'c', value: 'z' },
    ];
    const one = buildQuery(items);
    for (let i = 0; i < 10; i++) assert.equal(buildQuery(items), one);
  });
});
