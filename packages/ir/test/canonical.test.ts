/**
 * `canonicalScenario` —— IR 内容指纹的**规范投影**。
 *
 * 这个函数存在的意义是"同一份语义必须得到同一个串"，所以这里的测试全是**成对的**：
 * 每条都断言"A 与 B 相同"或"A 与 B 不同"。单值断言（"输出是个字符串"）在这里没有意义 ——
 * 任何实现都能满足它。判据是**区分能力**与**稳定性**这一对互相拉扯的性质：
 * 太稳定（改断言也不变）等于没指纹，太敏感（改缩进就变）等于每次保存都产生新版本。
 *
 * 反过来讲：这里每条"应当相同"的测试，都在防一个具体事故 ——
 * 键顺序敏感 → 有人格式化一下 JSON，CI 说"IR 变了"而 diff 里什么都没改；
 * frozen 参与哈希 → 点一下"冻结"按钮凭空多出版本 2，且版本 1 的证据全部指向查不到的哈希。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalScenario, defineScenario, parseScenario,
  type Scenario, type ScenarioDraft, type StepDraft,
} from '../src/index.js';

const step = (over: Record<string, unknown> = {}): StepDraft =>
  ({ id: 'a', kind: 'assert', against: '$n', expr: '$n == 1', ...over }) as StepDraft;

const scn = (over: Partial<ScenarioDraft> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.canon', name: 'canon test',
    env: { environmentRef: 'unit' }, body: [step()], ...over,
  } as ScenarioDraft);

const raw = (body: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1', id: 'scn.canon', name: 'canon test',
  env: { environmentRef: 'unit' }, body, ...extra,
});

/**
 * 解析并取出场景，不合法就把 errors 打进断言消息。
 *
 * 不用 `assert.ok(r.ok)` 再访问 `r.scenario`：`assert.ok(r.ok)` **不收窄类型**
 * （`ok: boolean` 不是判别式），于是 `r.scenario` 还是 `Scenario | undefined`，
 * 而 `--test` 走 tsx 不做类型检查 —— 少写一个 `!` 也照跑。
 * 更要紧的是错误信息：不合法时"两个都必须是合法的"这种消息什么也没说，
 * 这里直接把 zod 的路径喷出来。
 */
function mustParse(input: unknown): Scenario {
  const r = parseScenario(input);
  assert.ok(r.ok && r.scenario, `夹具不合法：${r.errors.map((e) => `${e.path} → ${e.message}`).join('；')}`);
  return r.scenario;
}

/** set 步骤的 assign。Step 是 union，取具体 kind 的字段要过一道（测试夹具，刻意不抽象成通用工具） */
const assignOf = (s: Scenario): Record<string, unknown> =>
  (s.body[0] as unknown as { assign: Record<string, unknown> }).assign;

test('对象键顺序不影响指纹（格式化 JSON 不该产生新版本）', () => {
  const a = mustParse(raw([{ id: 'a', kind: 'assert', against: '$n', expr: '$n == 1' }]));
  const b = mustParse(raw([{ expr: '$n == 1', against: '$n', kind: 'assert', id: 'a' }]));
  assert.equal(canonicalScenario(a), canonicalScenario(b));
});

test('record 字段的键顺序也不影响指纹（这条才是"排序"那行的真判据）', () => {
  // 上一条**测不到排序那行代码**：zod parse 出来的对象，键顺序等于 schema 字段声明顺序，
  // 两种书写方式 parse 完就已经一样了（探针确认：都是 kind,id,onError,tags,against,…）。
  // 所以"把 .sort() 删掉"时上一条照样绿 —— 一个看着在测排序、实际在测 zod 的测试。
  // 真正保留插入顺序的是 **record 字段**（set.assign / http.query / args 这类
  // z.record(string, …)）：parse 原样保留书写顺序，只有这里的排序是有效的。
  const one = mustParse(raw([{ id: 'a', kind: 'set', assign: { zz: 1, aa: 2 } }]));
  const two = mustParse(raw([{ id: 'a', kind: 'set', assign: { aa: 2, zz: 1 } }]));
  // 前提：parse 之后键顺序确实不同（否则这条又变成在比两个相同的对象）
  assert.notEqual(JSON.stringify(Object.keys(assignOf(one))), JSON.stringify(Object.keys(assignOf(two))),
    '前提破了：record 字段的键顺序被 parse 归一了，那这条测试和排序那行代码都该删');
  assert.equal(canonicalScenario(one), canonicalScenario(two),
    'assign 的键顺序进了指纹：用户在表单里删掉一个字段再加回来，就"产生了一个新版本"');
});

test('步骤顺序影响指纹（顺序换了就是另一条用例）', () => {
  const one = mustParse(raw([
    { id: 'a', kind: 'set', assign: { n: 1 } },
    { id: 'b', kind: 'assert', against: '$n', expr: '$n == 1' },
  ]));
  const two = mustParse(raw([
    { id: 'b', kind: 'assert', against: '$n', expr: '$n == 1' },
    { id: 'a', kind: 'set', assign: { n: 1 } },
  ]));
  assert.notEqual(canonicalScenario(one), canonicalScenario(two),
    '数组顺序被排掉了 —— 那等于"把两个步骤对调"不算改动，CI 会继续跑一个没人审过的版本');
});

test('改断言一定改指纹（指纹的区分能力底线）', () => {
  assert.notEqual(
    canonicalScenario(scn({ body: [step({ expr: '$n == 1' })] })),
    canonicalScenario(scn({ body: [step({ expr: '$n == 2' })] })),
  );
  // 断言的**元数据**也算内容：gatePolicy 从 report-only 改成 blocking 的含义是
  // "这条开始卡合并了"，比改个表达式更需要被指纹抓住。
  // gatePolicy 在 assertLlm 上（assert 没这个字段 —— StepSchema 是 strict 的，写错位置直接拒）
  const llm = (gatePolicy: string): Scenario =>
    scn({
      body: [{
        id: 'a', kind: 'assertLlm', question: '订单金额是否与响应一致',
        evidenceFrom: '$.a', gatePolicy,
      } as unknown as StepDraft],
    });
  assert.notEqual(canonicalScenario(llm('blocking')), canonicalScenario(llm('report-only')));
});

test('frozen 不参与指纹：冻结是生命周期动作，不改内容', () => {
  const open = scn({ frozen: false });
  const shut = scn({ frozen: true });
  assert.equal(canonicalScenario(open), canonicalScenario(shut),
    'frozen 进了哈希：点一下"冻结"会给同一条用例造出第二个 irSha，'
    + '按 irSha 去重的版本表会凭空多一版，而冻结前跑出的证据指向一个查不到的哈希');
  // 前提：frozen 本身确实能不同。不加这条，上面的 equal 可能在比两个相同的场景
  assert.notEqual(open.frozen, shut.frozen);
});

test('显式 undefined 与根本不写这个键，是同一份 IR', () => {
  // 这条不是洁癖：JSON 里没有 undefined，但**内存里有** ——
  // 编辑器表单"清空一个可选字段"通常就是塞 undefined。
  // 若它参与序列化，用户在表单里点一下清空再点回来就换了一版。
  //
  // 诚实说明它的强度：JSON.stringify 本来就会丢掉值为 undefined 的键，
  // 所以"删掉 stable() 里那句 undefined 判断"是**等价变异**（测不出差别）。
  // 这条测试钉的是**行为**（两种写法同指纹）而不是那一行代码 —— 行为是契约，
  // 实现细节允许换（比如日后改成先剔除默认值，那时这行就变成真的判据）。
  const withUndef = mustParse(raw([step()], { description: undefined }));
  const without = mustParse(raw([step()]));
  assert.equal(canonicalScenario(withUndef), canonicalScenario(without));
});

test('但显式 null 与根本不写这个键**不同**', () => {
  // null 是"我就是要传空"，undefined 是"我没说"。把两者视为相同，
  // 会让"把某字段改成 null"不改变指纹 —— 而那正是最该触发新版本的一类改动。
  // 写在 gen.with 上：正规字段（description 等）是 strict 可选字段，塞 null 会被 schema 拒，
  // 只有逃生舱允许 null 存活到序列化阶段
  const withNull = mustParse(raw([{ id: 'a', kind: 'set', assign: { x: { gen: 'int', with: { min: null } } } }]));
  const absentKey = mustParse(raw([{ id: 'a', kind: 'set', assign: { x: { gen: 'int', with: {} } } }]));
  assert.notEqual(canonicalScenario(withNull), canonicalScenario(absentKey));
});

test('逃生舱里的 NaN / Infinity 与 null 互不碰撞（JSON.stringify 会把它们都写成 null）', () => {
  // 数字字段本身过不了 zod（number/int 拒非有限值，下面那条测试钉着），
  // 但 `gen.with` 是 z.record(string, unknown) —— unknown 接受一切，
  // 而 JSON.stringify(NaN) 与 JSON.stringify(Infinity) 都产出 `null`。
  // 不特殊编码的话 `{gen:'int',with:{min:NaN}}` 与 `{gen:'int',with:{min:null}}`
  // 会算出同一个 irSha，版本表认为它们是同一版。
  const gen = (min: unknown): Scenario =>
    mustParse(raw([{ id: 'a', kind: 'set', assign: { x: { gen: 'int', with: { min } } } }]));
  const nan = gen(NaN);
  const nul = gen(null);
  const inf = gen(Infinity);
  assert.notEqual(canonicalScenario(nan), canonicalScenario(nul), 'NaN 与 null 撞车');
  assert.notEqual(canonicalScenario(nan), canonicalScenario(inf), 'NaN 与 Infinity 撞车');
  assert.notEqual(canonicalScenario(nul), canonicalScenario(inf), 'null 与 Infinity 撞车');
});

test('非有限数进不了正规数字字段（上面那条的前提，前提破了要在更早的地方红）', () => {
  const body = (timeoutMs: unknown): Record<string, unknown> =>
    raw([{ id: 'a', kind: 'assert', against: '$n', expr: '$n == 1', timeoutMs }]);
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.equal(parseScenario(body(v)).ok, false,
      `zod 竟然放过了 timeoutMs=${String(v)}，那上面那条 NaN 测试的意义要重估`);
  }
});

test('同一个场景算两次得到同一个串；JSON 往返副本也一样', () => {
  const s = scn({ tags: ['x'], inputs: [{ name: 'q', type: 'string', required: true }] });
  assert.equal(canonicalScenario(s), canonicalScenario(s), '函数自身不该有状态');
  assert.equal(canonicalScenario(mustParse(JSON.parse(JSON.stringify(s)))), canonicalScenario(s),
    '指纹不能依赖对象身份或序列化通道：写盘再读回就"产生新版本"是不可接受的');
});

test('输出是合法 JSON 文本（下游要能把它当数据存，不是当二进制）', () => {
  const c = canonicalScenario(scn());
  assert.doesNotThrow(() => JSON.parse(c));
  assert.ok(c.startsWith('{"'), `不像对象：${c.slice(0, 40)}`);
});
