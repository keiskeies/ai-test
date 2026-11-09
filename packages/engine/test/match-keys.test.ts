/**
 * `Match` 的 schema 键 ⇄ `evalMatch` 实际消费的键，**必须一一对应**。
 *
 * 这条测试的由来是 `unordered: true`：schema 收、`evalMatch` 从不读。
 * 后果不是"少个功能"那么轻 —— 写了它的人以为自己拿到了无序比较，
 * 实际拿到的是逐元素 each（本来就与顺序无关）或一个都不比的 exact，
 * 于是**用例随机判失败**，而校验全程点头说这写法合法。
 * 排查时人的第一反应是"我的业务数据有问题"，不会怀疑平台。
 *
 * 放在 engine 包而不是 ir 包，是因为这条论断的两端在这里才都够得着：
 * ir 不能 import node:fs 去读 engine 的源码（依赖方向禁止），
 * 而在 engine 侧读自己的源码 + import `@atest/ir` 的导出，两个方向都合法。
 *
 * 两边都是**自动取得**的，没有手抄清单：
 * 左边 `MATCH_KEYS` 来自 schema 本体，右边从 evalMatch 源码里扫 `m.xxx`。
 * 手抄一份清单的测试只会验证"两份清单抄得一样"，而那正是原来出问题的地方。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { MATCH_KEYS } from '@atest/ir';

/** 取出 evalMatch 的函数体（到下一个行首 `}` 为止），避免把别处的 `m.` 也算进来 */
function evalMatchBody(): string {
  const src = readFileSync(join(import.meta.dirname, '../src/assertions.ts'), 'utf8');
  const start = src.indexOf('export function evalMatch');
  assert.ok(start >= 0, '找不到 evalMatch。它被改名或搬走时这条测试必须响，而不是静默通过');
  const rest = src.slice(start);
  const end = rest.indexOf('\n}', 1);
  assert.ok(end > 0, 'evalMatch 函数体定位失败');
  return rest.slice(0, end);
}

/** evalMatch 里读过的 Match 键名 */
function readKeys(): string[] {
  const body = evalMatchBody();
  const out = new Set<string>();
  // 只认 `m.foo` / `m?.foo` 这种属性读取；`m.each &&` 之类会重复命中，用 Set 收敛
  for (const m of body.matchAll(/\bm\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.add(m[1]!);
  return [...out].sort();
}

test('Match schema 的每个键都被 evalMatch 读过（不存在"写了不生效"的键）', () => {
  const read = readKeys();
  assert.ok(read.length >= 15, `只扫出 ${read.length} 个键，扫描逻辑大概失效了 —— 空对空也算"一致"，那比没有测试更糟`);
  const unread = MATCH_KEYS.filter((k) => !read.includes(k));
  assert.deepEqual(unread, [], [
    '这些 Match 键在 schema 里合法，但引擎一行都没读：',
    ...unread.map((k) => `  - ${k}`),
    '要么在 evalMatch 里实现它，要么从 Match 与 MatchSchema 里删掉它。',
    '留着是最坏的选择：用户以为自己配置了某个行为，而那个行为不存在。',
  ].join('\n'));
});

test('evalMatch 读的每个键都在 schema 里（不读 IR 里不存在的东西）', () => {
  const ghost = readKeys().filter((k) => !MATCH_KEYS.includes(k));
  assert.deepEqual(ghost, [], `evalMatch 读了这些键，但 Match schema 里没有定义：${ghost.join(', ')}`);
});

test('扫描器确实能看见 unordered 那类回归（自证测试有效）', () => {
  // 这条是给上面两条测试做的**变异验证**，写死在仓库里而不是靠我手动跑一次：
  // 谁将来把 `unordered` 加回 schema，这里立刻红，而不是等到线上有人误判失败。
  const withUnordered = [...MATCH_KEYS, 'unordered'].sort();
  const unread = withUnordered.filter((k) => !readKeys().includes(k));
  assert.deepEqual(unread, ['unordered'], '扫描失效了：加个没人读的键本该被抓出来');
});
