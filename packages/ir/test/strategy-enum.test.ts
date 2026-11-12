/**
 * `openapiCall.strategy` 是**闭合 enum**，而且这条断言在别处被人当前提用着，
 * 所以它得有自己的载体。
 *
 * 为什么单独一条：`engine/src/lint.ts` 的 `coverageDelta` 那条键编码缺陷
 * （两个组合被拼成同一个键）能不能**经今天的生产路径抵达**，
 * 全部押在这一个事实上 —— 拼接键 `${operationId}|${strategy}` 只有在
 * **strategy 里出现 `|`** 时才可能撞（strategy 不含 `|` 时，整串的最后一个 `|`
 * 位置唯一，反解唯一，所以不可能撞）。实测两份对照写在
 * `docs/08` 登记那一格里，这里只钉 IR 这一半：
 * **今天没有任何合法 strategy 含 `|`**。
 *
 * ⚠ 这一条变红的那天（有人往 enum 里加了含 `|` 的值，或把 strategy 放宽成
 * 自由字符串），`coverageDelta` 那边就从"函数契约上的隐患"变成"生产可达"。
 * 那边用的是 `JSON.stringify` 成对编码，所以放宽 enum **不会**立刻让它出错 ——
 * 但那边函数头上"今天不可达"那句话会当场作废，要去改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CALL_STRATEGIES, parseScenario, type ScenarioDraft } from '../src/index.js';

const BASE = {
  schemaVersion: '1', id: 'scn.strategy', name: 'n', description: 'd', tags: ['t'],
  mode: 'script', frozen: false, env: { environmentRef: 'default' },
} as unknown as ScenarioDraft;

function withStrategy(strategy: unknown) {
  return parseScenario({
    ...BASE,
    body: [{ id: 'c', kind: 'openapiCall', name: 'x', docRef: 'shop', operationId: 'op', strategy }],
  });
}

test('strategy 是闭合 enum：不在名单里的值当场不合法', () => {
  for (const bad of ['happypath', 'BOUNDARY', 'boundary ', '', 'b|boundary', 'a|b']) {
    const r = withStrategy(bad);
    assert.equal(r.ok, false, `strategy="${bad}" 竟然通过了 —— enum 被放宽了`);
    assert.ok(
      r.errors.some((e) => e.path.includes('strategy')),
      `报错没指到 strategy：${r.errors.map((e) => e.path).join(', ')}`,
    );
  }
});

test('strategy 合法值一个都不含 `|`（coverageDelta 那条键缺陷今天不可达的前提）', () => {
  // 判据是**枚举全部合法值逐个看**，不是"我读了 schema 里没有 |"——
  // enum 加了新值这条会自动跟着变，不会烂掉
  assert.ok(CALL_STRATEGIES.length >= 10, `名单看起来是空的：${CALL_STRATEGIES.length} 个`);
  assert.deepEqual(
    CALL_STRATEGIES.filter((v) => v.includes('|')),
    [],
    '有 strategy 合法值含 `|` —— 引擎那边 coverageDelta 的键撞缺陷变成生产可达，去改它函数头',
  );
  // 逐个真喂一遍：确认"合法"走的是 schema 而不是名单本身（名单与 schema 分叉也要红）
  for (const v of CALL_STRATEGIES) assert.equal(withStrategy(v).ok, true, `${v} 应当合法却被打回`);
});