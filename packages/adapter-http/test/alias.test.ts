/**
 * 确定性别名的测试（docs/05 §1「定时炸弹」那条）。
 *
 * 这类代码的危险不在「算错」—— 算错看得见。危险在**换了个输入顺序就算出别的 id**，
 * 于是重新导入 spec 后所有已有场景静默指向别的接口。所以这里的重点不是
 * 「别名好不好看」，而是**同稳定性**：任何不该影响 id 的因素变了，id 必须不动。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor, normalizePath, resolveAliases, AliasConflictError, type RawOp } from '../src/openapi/alias.js';

describe('normalizePath', () => {
  test('普通路径逐段首字母大写', () => {
    assert.equal(normalizePath('/orders'), 'Orders');
    assert.equal(normalizePath('/user-orders/items'), 'UserOrdersItems');
    assert.equal(normalizePath('/v2/user_profiles'), 'V2UserProfiles');
  });

  test('参数段归一成 Id，且**与参数名无关**（改名不作废用例）', () => {
    assert.equal(normalizePath('/orders/{id}'), 'OrdersId');
    assert.equal(normalizePath('/orders/{orderNo}'), 'OrdersId');
    assert.equal(normalizePath('/orders/{orderId}/items/{itemId}'), 'OrdersIdItemsId');
    // 这一条是整个归一化的理由：后端把路径参数改名，已生成用例的 id 不能动
    assert.equal(normalizePath('/orders/{id}'), normalizePath('/orders/{orderNo}'));
  });

  test('前导/重复斜杠不产生段', () => {
    assert.equal(normalizePath('/orders'), normalizePath('//orders//'));
  });

  test('根路径归一成空串（由 aliasFor 兜成 Root）', () => {
    assert.equal(normalizePath('/'), '');
    assert.equal(aliasFor('GET', '/'), 'getRoot');
  });

  test('段内混排的参数被抠掉，周围文字保留', () => {
    assert.equal(normalizePath('/v{ver}/users'), 'VUsers');
  });
});

describe('aliasFor', () => {
  test('形状：method 小写开头 + path 词首大写', () => {
    // 参数一律归一成 Id（参数改名不作废用例），所以是 UsersIdPosts 而不是 UsersUserIdPosts
    assert.equal(aliasFor('GET', '/users/{userId}/posts'), 'getUsersIdPosts');
    assert.equal(aliasFor('POST', '/orders'), 'postOrders');
    assert.equal(aliasFor('DELETE', '/admin/users/{id}'), 'deleteAdminUsersId');
  });

  test('method 大小写不敏感（spec 里写 get/GET 都有）', () => {
    assert.equal(aliasFor('get', '/orders'), aliasFor('GET', '/orders'));
  });

  test('纯函数：重复调用同结果（不读时间/环境）', () => {
    const a = aliasFor('GET', '/x/{y}');
    for (let i = 0; i < 50; i++) assert.equal(aliasFor('GET', '/x/{y}'), a);
  });
});

const ops = (...p: [string, string][]): RawOp[] => p.map(([method, path]) => ({ method, path }));

/** 取抛出的错误对象。`assert.throws` 的返回值是 **undefined**，
 *  直接 `as AliasConflictError` 会拿到 undefined 再在下一行炸成 TypeError ——
 *  那样测试是"失败"的，但失败原因和真实缺陷毫无关系，调试起来极费劲。 */
function capture<T extends Error>(fn: () => unknown, ctor: new (...a: never[]) => T): T {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ctor, `抛的是 ${e instanceof Error ? e.constructor.name : String(e)}，不是 ${ctor.name}：${e}`);
    return e;
  }
  assert.fail(`本该抛 ${ctor.name}，结果没抛`);
}

describe('resolveAliases', () => {
  test('缺 operationId 时用确定性别名，并标记 generated', () => {
    const r = resolveAliases(ops(['GET', '/users']));
    assert.equal(r[0]!.operationId, 'getUsers');
    assert.equal(r[0]!.aliasGenerated, true);
  });

  test('spec 自带 operationId 优先，且不算 generated', () => {
    const r = resolveAliases([{ method: 'GET', path: '/users', operationId: 'listUsers' }]);
    assert.equal(r[0]!.operationId, 'listUsers');
    assert.equal(r[0]!.aliasGenerated, false);
  });

  test('人工覆盖表优先级最高（压过 spec 自带的 id）', () => {
    const r = resolveAliases([{ method: 'GET', path: '/users', operationId: 'listUsers' }], { 'GET /users': 'myCustom' });
    assert.equal(r[0]!.operationId, 'myCustom');
    assert.equal(r[0]!.aliasGenerated, false);
  });

  test('覆盖表的键是 METHOD + 原始 path（带 {param}），不是归一化后的', () => {
    const r = resolveAliases(ops(['GET', '/users/{id}']), { 'GET /users/{id}': 'whois' });
    assert.equal(r[0]!.operationId, 'whois');
  });

  test('method 大小写与 path 归一化不影响覆盖表命中（键统一大写 method + 原样 path）', () => {
    const r = resolveAliases([{ method: 'get', path: '/users' }], { 'GET /users': 'whois' });
    assert.equal(r[0]!.operationId, 'whois');
  });

  // ── 下面三条是本文件真正要防的东西 ────────────────────────────────

  test('稳定性：输入顺序完全打乱，产出的 id 集合与顺序都不变', () => {
    const base = ops(
      ['GET', '/users'], ['POST', '/users'], ['GET', '/users/{id}'],
      ['DELETE', '/users/{id}'], ['GET', '/orders'], ['PATCH', '/orders/{id}/ship'],
      ['GET', '/reports/daily'], ['POST', '/auth/login'],
    );
    const forward = resolveAliases(base);
    for (let seed = 1; seed <= 20; seed++) {
      // 用确定性洗牌而不是 Math.random，否则这个测试自己就成了不可回放的东西
      const shuffled = [...base];
      let s = seed;
      for (let i = shuffled.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) >>> 0;
        const j = s % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const got = resolveAliases(shuffled);
      assert.deepEqual(
        got.map((o) => `${o.method} ${o.path} -> ${o.operationId}`),
        forward.map((o) => `${o.method} ${o.path} -> ${o.operationId}`),
        `第 ${seed} 次洗牌后别名变了 —— 重新导入 spec 会让已有场景指向错误接口`,
      );
    }
  });

  test('稳定性：tag 改名不影响别名（docs/05 公式里的 tag 被故意剔除）', () => {
    const before = resolveAliases([{ method: 'GET', path: '/orders', tags: ['订单'] }]);
    const after = resolveAliases([{ method: 'GET', path: '/orders', tags: ['订单管理-改名了'] }]);
    assert.equal(before[0]!.operationId, after[0]!.operationId);
  });

  test('稳定性：spec 重新导入、只增删别的接口，已有接口别名不动', () => {
    const a = resolveAliases(ops(['GET', '/users/{id}']));
    const b = resolveAliases(ops(['GET', '/users/{id}'], ['POST', '/anything'], ['GET', '/zzz']));
    assert.equal(a[0]!.operationId, 'getUsersId');
    assert.equal(b.find((o) => o.path === '/users/{id}')!.operationId, 'getUsersId');
  });

  // ── 冲突必须**响亮失败** ─────────────────────────────────────────

  test('同 method+path 出现两次（跨文件合并）时报错，而不是加后缀', () => {
    const err = capture(() => resolveAliases(ops(['GET', '/a'], ['GET', '/a'])), AliasConflictError);
    assert.match(err.message, /不会自动加后缀/);
    // 报错必须给出出口：键形如什么、往哪张表写
    assert.match(err.message, /operation_alias/);
    assert.match(err.message, /"GET \/a"/);
    assert.deepEqual(err.ops, ['GET /a', 'GET /a']);
  });

  test('碰撞时把**两个键都列出来**，否则用户不知道该改哪一个', () => {
    const err = capture(() => resolveAliases(ops(['GET', '/userOrders'], ['GET', '/user/orders'])), AliasConflictError);
    assert.deepEqual(err.ops, ['GET /user/orders', 'GET /userOrders']);
    assert.equal(err.alias, 'getUserOrders');
  });

  test('spec 作者手写的重复 operationId 同样报错（这是文档说的"高"频情况）', () => {
    assert.throws(
      () => resolveAliases([{ method: 'GET', path: '/a', operationId: 'dup' }, { method: 'GET', path: '/b', operationId: 'dup' }]),
      /operationId "dup" 被 2 个 operation 同时使用/,
    );
  });

  test('覆盖表修好一个冲突后，报错消失且另一个仍用原名', () => {
    const fixed = resolveAliases(ops(['GET', '/userOrders'], ['GET', '/user/orders']), { 'GET /user/orders': 'getUserOrdersFlat' });
    assert.deepEqual(
      fixed.map((o) => o.operationId).sort(),
      ['getUserOrders', 'getUserOrdersFlat'],
    );
  });

  test('同 path 不同 method 不冲突（手写 operationId 重复才是问题）', () => {
    const r = resolveAliases(ops(['GET', '/orders/{id}'], ['DELETE', '/orders/{id}']));
    assert.deepEqual(r.map((o) => o.operationId), ['deleteOrdersId', 'getOrdersId']);
  });
});
