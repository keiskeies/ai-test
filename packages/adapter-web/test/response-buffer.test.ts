/**
 * 响应缓冲的两条不变量。**这个文件是本轮"证明测得到"那一步的核心产物。**
 *
 * ## 为什么不用真浏览器测这些
 *
 * 因为**测不到**。淘汰只在第 5001 条响应到来时发生，而一次 navigate 只有几条响应，
 * 跑到那个数要起一千次导航。我做变异检查时确认过这件事不是推测：
 *  把 `splice(0, len-cap)`（丢最旧）改成 `pop()`（丢最新）——六条真浏览器测试**全绿**；
 *  把 `idx: ++seq` 改成 `idx: rows.length + 1`（下标跟着数组走）——**同样全绿**。
 *
 * 全绿不代表没问题，只代表**那段逻辑在浏览器层面没有可被观察的路径**。
 * 而这两条恰好是缓冲唯一真正难的地方：破任何一条，症状都是
 * "引擎把旧响应当成本次动作触发的"（假绿）或"最新那条永远看不到"（假红 + flake）。
 * 所以逻辑单独成模块、在这里判。**能不起浏览器判的东西就不要起浏览器判**，
 * 否则就会像刚才那样，得到一份"看起来覆盖了其实没覆盖"的测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESPONSE_CAP, ResponseBuffer } from '../src/response-buffer.js';

test('下标从 1 起、单调、且与数组长度无关', () => {
  const b = new ResponseBuffer(3);
  assert.equal(b.push('/a', 200), 1);
  assert.equal(b.push('/b', 201), 2);
  assert.equal(b.push('/c', 500), 3);
  // 第 4 条触发淘汰。淘汰**之后**的下标是这里要判的东西，前三条只是铺垫
  assert.equal(b.push('/d', 200), 4, '淘汰发生后下标必须继续往前走。回到 3 或 1 = 下标跟着数组长度走，'
    + '引擎会把旧响应当成本次动作触发的（假绿）');
  assert.deepEqual(b.since(0).map((r) => r.url), ['/b', '/c', '/d'], '容量 3 => 丢最旧的那一条');
});

test('since 严格大于：等于游标的那条不回首', () => {
  const b = new ResponseBuffer();
  b.push('/a', 200); b.push('/b', 200);
  assert.deepEqual(b.since(1).map((r) => r.url), ['/b'],
    '游标是"已经消费到的那一条"，所以等号不取。取等号的话上一步消费过的响应会被下一步再算命中');
  assert.deepEqual(b.since(2), [], '取完之后再问应当是空的');
});

test('淘汰留下的空洞：since 只给还留着的，且不报错', () => {
  /*
   * 这条是**新增 `idx` 字段的全部理由**（引擎侧 responses.ts 的 poll）。
   * 淘汰后流里有洞：1 已被丢掉，2、3、4 还在。
   * 如果引擎按"这次拿到几条"推进游标，它会以为只前进了 3 步而实际到了 4，
   * 落后的那一步会在下一次拉取时**被再报一次**。
   * 这里钉住的是 adapter 侧的形态：**宁可留空洞，也不重排下标**。
   */
  const b = new ResponseBuffer(3);
  for (const u of ['/1', '/2', '/3', '/4']) b.push(u, 200);
  const kept = b.since(0);
  assert.deepEqual(kept.map((r) => r.idx), [2, 3, 4], '下标必须带空洞（1 被淘汰了）。连续 = 被重排过 = 假绿');
  assert.deepEqual(b.since(2).map((r) => r.url), ['/3', '/4']);
  assert.deepEqual(b.since(1).map((r) => r.url), ['/2', '/3', '/4'], '从空洞里问也要给出还在的那些');
});

test('上限生效：不无限增长，且始终保留最新的一批', () => {
  const b = new ResponseBuffer(2);
  for (let i = 0; i < 100; i++) b.push(`/x${i}`, 200);
  const kept = b.since(0);
  assert.equal(kept.length, 2, '超上限必须淘汰，否则一个长 run 会把内存吃光');
  assert.deepEqual(kept.map((r) => r.url), ['/x98', '/x99'],
    '留下的必须是**最新**两条。留下最旧的那两条意味着刚发生的响应读不到 —— 等待必然超时（假红）');
  // 100 次 push 之后头是 100（下标从 1 起），所以 since(100) 才是"末尾"
  assert.deepEqual(b.since(100), [], '游标在末尾时应当为空');
  assert.deepEqual(b.since(99).map((r) => r.url), ['/x99'], '游标=倒数第二条时只给最后一条');
});

test('不注入容量时按 RESPONSE_CAP 淘汰（默认值真的在生效，不是形参摆设）', () => {
  /*
   * 这条**刻意不断言 5000 这个数**。我第一版在这里写了 `assert.equal(RESPONSE_CAP, 5_000)`，
   * 看着像"守住默认值"，实际是个改动探测器：将来把容量调成 4000 或 8000（内存压力、
   * 或 P2.5 定价格表时顺手调）会得到一条红的测试，而那条红里**没有任何信息** ——
   * 具体数值本身没有可观测的性质（要观测就得推 5001 条，那条测试只会让人删掉它）。
   * 真正要守的是"**不注入时确实有个上限在管**"，那就断这个。
   * 数值为什么是 5000 写在 response-buffer.ts 的注释里，那里才是它该待的地方。
   */
  const b = new ResponseBuffer();
  for (let i = 0; i < RESPONSE_CAP + 5; i++) b.push(`/x${i}`, 200);
  assert.equal(b.since(0).length, RESPONSE_CAP, '不注入容量时也必须有上限（否则长 run 把内存吃光）');
  assert.deepEqual(b.since(0).map((r) => r.url).slice(-1), [`/x${RESPONSE_CAP + 4}`],
    '默认容量下留下的也得是最新那条');
});

test('容量非法时立刻炸，而不是悄悄退化成 0 或 Infinity', () => {
  /*
   * 0 会退化成"什么都不留"（所有等待恒超时，看起来是被测产品没发请求），
   * Infinity 会退化成"无上限涨"（长 run OOM）。两者都比报错难查一个数量级，
   * 所以构造函数直接拒绝，把问题留在改代码的那一刻。
   */
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new ResponseBuffer(bad), />=1 的整数/, `容量 ${bad} 应当被拒`);
  }
});
