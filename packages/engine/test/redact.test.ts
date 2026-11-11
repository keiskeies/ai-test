/**
 * `redactForDisk` 的**第四道判据**：脱敏这趟不许改变"有没有"。
 *
 * 三条老判据（字段名 / 值形态 / 深度上限）管的是"别让不该看的被看见"，
 * 这一条管的是另一件事：**磁盘上的东西必须是那份对象的 JSON 编码**。
 * 判据不是"我觉得应该怎样"，而是**与裸 `JSON.stringify` 逐一对齐** ——
 * 因为磁盘最终由它写，而消费者（服务端 run 表、看板、`jq`、下游脚本）按它的语义读。
 * 所以这套测试的写法是"同一份输入，两条路，必须同一个 JSON 形状"，
 * 而不是把我期望的输出抄在断言里（抄一遍就等于把当时的实现供起来）。
 *
 * 起因是实测（`.scratch/probe-redact-undefined.mts`，永久落点就是本文件）：
 * 改动前 `undefined` 与 function/symbol 一起走 `String(v)`，于是
 * `trace.jsonl` 里躺着 `"status":"undefined"`、`"durMs":"undefined"`。
 * 两处后果，**第二处是量出来才想到的**：
 *  1. 拿 `durMs` 做聚合的脚本得到字符串拼接，不报错、静默算错；
 *     `--version-id` 不传时 `manifest.scenario.versionId` 是字符串 `"undefined"`，
 *     而 `evidence.ts` 里那句"写一个 undefined 字段与不写，在 JSON 里等价"
 *     对裸 stringify 成立、对**经过这一趟**的 manifest 不成立。
 *  2. 被测响应体里**真有一个值是字符串 `"undefined"` 的字段**（JS 后端把
 *     `String(undefined)` 塞进字段是常见病灶），与"这个字段压根没有"**在磁盘上同形**。
 *     而"上游没返回"与"上游返回了 'undefined'"恰恰是排查时唯一有用的区分。
 *
 * ⚠ 这套测试很容易写成恒过：`assert.notEqual(x, 'undefined')` 那种写法
 * 在实现把字段整个删掉时也过、在实现写成 `"null"` 时也过 —— 它只排除了一种错法。
 * 所以主判据是"与裸 stringify 相同"，逐条列形状只是给人看的补充。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactForDisk, SECRET_PLACEHOLDER } from '../src/index.js';

/** 两条路的 JSON 形状必须一致。裸 stringify 对顶层 undefined 返回 undefined（不是字符串） */
const sameAsPlainJson = (input: unknown, hint: string): void => {
  const bare = JSON.stringify(input);
  const through = JSON.stringify(redactForDisk(input));
  assert.equal(through, bare, `${hint}\n  裸 stringify: ${bare}\n  经过脱敏:   ${through}`);
};

test('undefined / function / symbol 与裸 JSON.stringify 同语义（对象丢键、数组记 null）', () => {
  sameAsPlainJson({ a: 1, versionId: undefined, b: 2 }, '对象里一个没值的可选字段');
  sameAsPlainJson(undefined, '顶层就是 undefined');
  sameAsPlainJson([1, undefined, 3], '数组里的洞');
  sameAsPlainJson({ outer: { inner: undefined } }, '嵌套深处的 undefined');
  sameAsPlainJson({ fn: () => 1, sym: Symbol('s') }, 'JSON 带不走的那两类');

  // 补充形状（给人看的，主判据是上面那组）：确认不是"整个对象被搞坏"造成的假一致
  assert.deepEqual(redactForDisk({ a: 1, versionId: undefined, b: 2 }), { a: 1, b: 2 },
    '对象里那个键该整个丢掉');
  assert.deepEqual(redactForDisk([1, undefined, 3]), [1, null, 3],
    '数组里该记 null 而不是删元素 —— **长度是信息**，缩长度会把 3 项列表说成 2 项');

  /*
   * 内部那个"没值"的记号**不许漏到公开签名外面**。
   * 上面那些断言全都看不住它：JSON.stringify 对 symbol 的处理恰好与 undefined
   * 一模一样（对象里丢键、数组里记 null），所以把出口那一步删掉，
   * 这一组断言**照样全绿** —— 而漏出去的记号在真正的调用点上是会**抛**的：
   * `${symbol}` 直接 TypeError，于是"字段缺失"从"报告里多一个字符串"升级成"报告生成崩掉"。
   * 插值那一行就是把这个"会抛"变成会红的断言（report.ts / html.ts 里到处是模板串）。
   */
  assert.equal(redactForDisk(undefined), undefined, '顶层没值：公开的要是 undefined，不是内部记号');
  assert.equal(`${redactForDisk(undefined)}`, 'undefined', '插值要正常出词，不许抛 TypeError');
  assert.equal(`${(redactForDisk({ a: undefined }) as { a?: unknown }).a}`, 'undefined',
    '对象里没值的那个键取出来插值也一样');
});

test('合法值不许被顺手删掉：null、空串、0、false 都要原样在', () => {
  // 这一条与上一条是**一对**。只做上一条的实现会把 undefined 与 null 一起删掉，
  // 而 null 是"明确没有"、空串是"明确的空"，都是**有值**（与 store 那边
  // `bytes` 取不到时宁可不写也不写 0 同一族立场：0 和空串都是合法值）。
  const o = { a: null, b: '', c: 0, d: false };
  sameAsPlainJson(o, '四个合法值');
  assert.deepEqual(redactForDisk(o), o, '四个都要原样保留');
});

test('"响应体里真有一个值是字符串 undefined 的字段"与"这个字段没有"在磁盘上必须区分得开', () => {
  // 这条是量出来才加上的，也是这次改动**最值钱**的一条：
  // 改动前两者在磁盘上同形，而排查这类问题唯一有用的信息就是这两种的差别。
  const missing = { id: 'o_1', coupon: undefined };
  const literal = { id: 'o_1', coupon: 'undefined' };
  const a = redactForDisk(missing) as Record<string, unknown>;
  const b = redactForDisk(literal) as Record<string, unknown>;
  assert.ok(!('coupon' in a), '没返回的字段：键该在磁盘上消失');
  assert.equal(b.coupon, 'undefined', '真返回了字符串 "undefined"：原样保留，不许被当成缺失');
  assert.notDeepEqual(a, b, '两种故障不许在证据里长成同一个对象');
});

test('密钥字段没填时不写这一栏，而不是写出一条"已脱敏"的痕迹', () => {
  /*
   * 顺序判据：SECRET_KEY_RE 那一支原本**在递归之前**，所以
   * `{ token: undefined }` 会打出 `«secret:未暴露»` —— 那是**凭空造出一条密钥痕迹**：
   * 读包的人会去查"这个 token 哪来的、是不是泄露了"，而真相是这里从来没值。
   * 改法是"没值先跳过，再谈脱敏"。这条测试钉的就是这个先后。
   *
   * 三条要同时成立，少一条都拦不住错的实现：
   *  - 没填 -> 整栏消失（不是 placeholder、不是 `已脱敏(0 字符)`）；
   *  - 填了 -> 照旧脱敏，且**长度留着**（那是另一条老判据，别被这次改动顺手删了）；
   *  - 值是 null -> 仍在（"显式的空"与"没填"是两种事实，下一步动作不同）。
   */
  assert.deepEqual(redactForDisk({ token: undefined }), {}, '没填的密钥字段不该留下任何痕迹');
  const filled = redactForDisk({ token: 'abc12345' }) as Record<string, unknown>;
  assert.equal(filled.token, '«字段 token 已脱敏(8 字符)»', '填了的照旧脱敏并保留长度');
  const nulled = redactForDisk({ token: null }) as Record<string, unknown>;
  assert.equal(nulled.token, SECRET_PLACEHOLDER, '显式 null 是"有值且是空"，与没填不同');
});

test('bigint 仍转字符串：它是"一个存在的值换写法"，与"把没有写成有"不是一族', () => {
  // 裸 JSON.stringify 遇到 bigint 是**抛错**，所以这一格刻意不对齐裸 stringify：
  // 照抄会让一份带 bigint 的响应体弄崩整次运行的报告（报告生成失败连累整场证据）。
  const r = redactForDisk({ n: BigInt('9007199254740993') }) as { n: unknown };
  assert.equal(r.n, '9007199254740993', '存在的值仍要留在磁盘上，只是换个 JSON 能写的形式');
  assert.throws(() => JSON.stringify({ n: BigInt(1) }), '前提要成立：裸 stringify 对 bigint 是抛错，不是丢弃');
});

test('值形态与字段名两条老判据不被这次改动弄坏（成对：新判据不许挤掉旧判据）', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  // 字段名**不**命中（data），只靠值形态规则 —— 这正是"只按字段名不够"的那条老理由
  const r = redactForDisk({ data: `Bearer ${JWT}` }) as Record<string, string>;
  assert.match(r.data!, /已脱敏/);
  assert.doesNotMatch(r.data!, /eyJhbGci/, 'JWT 值不许原样落盘');
  // 嵌套里也要照旧生效：新增的"跳过没值"分支不能把递归短路
  const deep = redactForDisk({ outer: { missing: undefined, password: 'hunter2' } }) as
    { outer: Record<string, string> };
  assert.ok(!('missing' in deep.outer), '嵌套里没值的还是丢掉');
  assert.equal(deep.outer.password, '«字段 password 已脱敏(7 字符)»', '嵌套里的密钥照旧脱敏');
});
