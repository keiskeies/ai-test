/**
 * `composeUrl` 的**直接**单测。
 *
 * ## 为什么在已有 e2e（engine-e2e.test.ts）与 mock 测试之后再开一份
 *
 * 这两份都在测"组合那一层"，而它们看的是**发出去之后的字节**：
 * mock 收到 `/users?tag=a%20b&page=3` 能证明三段接对了，却不能证明
 * `missing` / `unknown` 这两个**数组**算对了 —— 引擎只拿它们决定报不报错，
 * 报错文案里带上名字，于是"少算一个名字"在 e2e 上的表现是
 * **一条更含糊的错**，而不是红。本轮补的那格（手写 query 段里的 `{t}`）正是这个形状：
 * 改前那一步是 **pass**，e2e 里没有任何一条断言会因为"少扫了 query 段"而红。
 *
 * 所以这里断的是**返回值本身**（`missing` / `unknown` 的具体名字），
 * 而不是它换来的一句人话。序列化（style/explode 那六格）不在这里 ——
 * 那是 `style.test.ts` 逐格照抄规范表钉的，重抄一遍只会多出第二个可以漂移的真相。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { composeUrl } from '../src/openapi/compose.js';
import { parseOpenApi } from '../src/openapi/parse.js';
import { dirtySpec } from './fixtures.js';

const doc = parseOpenApi(dirtySpec);

describe('三段拼接（有无手写 query × 有无参数表 query）', () => {
  /*
   * 四格全钉。这一格值得逐格钉是因为"压成一个表达式"的诱惑很实在：
   * 接错的时候产出的是 `?a=1?b=2` 或 `?a=1&?b=2`，而后端把第二个 `?` 之后
   * 整段当成**一个键** —— 请求照发、多半照 200，只有断点才能看出来。
   */
  const op = doc.byId.get('health')!;
  test('都没有：只有路径', () => {
    assert.equal(composeUrl('/public/health', op, {}).path, '/public/health');
  });
  test('只有参数表：buildQuery 自带 ?', () => {
    assert.equal(composeUrl('/public/health', op, { queryParams: { page: 2 } }).path, '/public/health?page=2');
  });
  test('只有手写那段：保留 ? 与原字节', () => {
    assert.equal(composeUrl('/public/health?x=1', op, {}).path, '/public/health?x=1');
  });
  test('两个都有：用 & 接，且手写的在前', () => {
    assert.equal(composeUrl('/public/health?x=1', op, { queryParams: { page: 2 } }).path, '/public/health?x=1&page=2');
  });
  test('手写的字节不被重编码（%20 不会变成 %2520）', () => {
    // 作者手写的就是他要的字节。这一条守的是"我们不去重编码别人写的东西"，
    // 与上面那几条不同向：那几条管接法，这条管**不该动的别动**。
    assert.equal(composeUrl('/a?tag=a%20b%7Cc', op, {}).path, '/a?tag=a%20b%7Cc');
  });
});

describe('missing / unknown 这两个数组', () => {
  /*
   * 它们是**判据**而不是文案：引擎拿它们决定 case-stale。
   * 在 e2e 那一层，算错一个名字只会让报错少一个名字，所以这一格必须在这一层钉。
   */
  const op = doc.byId.get('getOrdersId')!;
  test('路径占位符没填 -> missing 里有它，且模板原样留在 path 里', () => {
    const r = composeUrl(op.path, op, {});
    assert.deepEqual(r.missing, ['id']);
    assert.equal(r.path, '/orders/{id}', '没填时**保留** {id} 交回调用方报错，不静默删掉也不填空串');
  });
  test('填上了就两边都不出现', () => {
    const r = composeUrl(op.path, op, { pathParams: { id: 'A1' } });
    assert.deepEqual({ missing: r.missing, unknown: r.unknown }, { missing: [], unknown: [] });
  });
  test('null 也算没填（发 `?x=null` 与"作者写了 null"是两件事）', () => {
    assert.deepEqual(composeUrl(op.path, op, { pathParams: { id: null } }).missing, ['id']);
  });
  test('名字不在模板占位符里 -> unknown', () => {
    assert.deepEqual(composeUrl(op.path, op, { pathParams: { userID: '1' } }).unknown, ['userID']);
  });
  test('missing 与 unknown 能同时非空（同一个笔误的两面，引擎那条合并断言靠这个）', () => {
    const r = composeUrl('/orders/{id}', op, { pathParams: { userID: '1' } });
    assert.deepEqual(r.missing, ['id']);
    assert.deepEqual(r.unknown, ['userID']);
  });
  test('重复的占位符名只报一次（`/{id}/x/{id}` 不算两个）', () => {
    assert.deepEqual(composeUrl('/a/{id}/b/{id}', op, {}).missing, ['id']);
  });

  /*
   * ⚠ 下面这三条是本轮**补出来的缺陷**的载体。改前的实现只扫 path 那半段
   * （`fillPath` 只吃 pathPart），于是 `url: '/a?tag={t}'` 里的 `{t}`
   * 一路发到线上而**步骤判 pass**（实测：发出去的是 `/orders?tag={t}`，mock 回 200）。
   * 一条"少扫一段"的改动在 e2e 上不会红 —— 它只是让一条用例绿着测别的东西。
   */
  test('手写 query 段里的占位符也进 missing', () => {
    const r = composeUrl('/users?tag={t}', undefined, {});
    assert.deepEqual(r.missing, ['t']);
  });
  test('两段都有占位符时都要报（路径那段不能被 query 那段盖掉）', () => {
    const r = composeUrl('/orders/{id}?tag={t}', op, {});
    assert.deepEqual([...r.missing].sort(), ['id', 't']);
  });
  test('手写段的占位符不因 query 里给了同名而豁免（否则字面量与真值各发一份）', () => {
    // 手写那段是原样保留的，填不进去：真发出去会是 `?tag={t}&t=V`。
    // 这一条守的是"别有人回来加那个同名豁免"。
    const r = composeUrl('/users?tag={t}', undefined, { queryParams: { t: 'V' } });
    assert.deepEqual(r.missing, ['t']);
  });
  test('known 只扫路径那半段：给错位置的 pathParams 仍然报 unknown', () => {
    /*
     * `pathParams: {t}` 配 `url: '/u?tag={t}'`：名字对上了，但 pathParams 只填**路径**
     * 占位符，所以那个 `t` 确实没填任何东西。扫整段模板会把它算成认识的名字，
     * 于是只剩 missing 那句"pathParams 里没给这些"—— 而**作者明明给了**，
     * 只是给错了位置。方向是"报错话说反"，而报错话说反会让人照着错的方向改。
     */
    const r = composeUrl('/u?tag={t}', undefined, { pathParams: { t: 'V' } });
    assert.deepEqual(r.missing, ['t']);
    assert.deepEqual(r.unknown, ['t']);
  });
});

describe('style 按参数位置查（path 与 query 的默认值不同）', () => {
  /*
   * 这一格是"传了 op 但查错 in"的载体。fixture 里 `/users` 在 path 级声明了
   * `q`（`in: query`，string），`listUsers` 又用同名同 in 覆盖成 array + pipeDelimited
   * —— 所以只有"同名同 in 才算同一个参数"这条判据对的时候，才拿得到 pipeDelimited。
   * 查错 in（比如只按名字找）会拿到 path 级那份 string 声明，序列化就退回标量形式。
   */
  test('query 参数查 operation 声明的那个（pipeDelimited -> a|b）', () => {
    assert.equal(composeUrl('/users', doc.byId.get('listUsers')!, { queryParams: { q: ['a', 'b'] } }).path, '/users?q=a|b');
  });
  test('没有 operation 时走规范默认值（form + explode -> 重复键），而不是随便一种', () => {
    // 纯 http 步骤永远不带 op。"没查到"不等于"没规则"：默认值本身是 OAS 规定的。
    assert.equal(composeUrl('/u', undefined, { queryParams: { ids: [1, 2] } }).path, '/u?ids=1&ids=2');
  });
  test('没有 operation 时路径参数仍按 simple 编码（斜杠不编会多出一段路径）', () => {
    assert.equal(composeUrl('/orders/{id}', undefined, { pathParams: { id: 'a/b' } }).path, '/orders/a%2Fb');
  });
});
