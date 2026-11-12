/**
 * 覆盖增量预览（`atest gen` 那一栏）。
 *
 * 这一格的存在本身就是一条缺陷的收尾：`coverageDelta` 有函数、有测试、
 * **生产侧零调用**（docs/08 §3(e)「有生产者、没有载体」），而 docs/00 §6.1
 * 把它写成"抑制过度生成的唯一有效手段"。写这份测试的过程中它又被用错两次，
 * 两次都是"数字对而含义错"，所以这里的用例**全部围绕含义**而不是围绕算术：
 *
 *  1. **单位是组合不是调用。** 一个 boundary 场景里有六条同组合调用（六个边界值），
 *     逐条喂进 `coverageDelta` 会得到五个"批内重复"，我照着那个读数写过
 *     "一个场景留一条就够"—— 真按它做就只剩一个边界值，策略当场作废。
 *     下面「一个场景六条同组合调用」那条钉这个。
 *  2. **"已有"只能来自磁盘。** 第一版把批内重复当成已有，于是磁盘上一个文件都没有
 *     的第一次 gen 同时印出五条「· 已有：createOrder / boundary」和"扫了 0 个 json"。
 *     下面「目录空时一个"已有"都不许出现」那条钉这个（那条注释里还记着
 *     我把两次运行并成一次、把一句真话当成谎话登记过一次）。
 *
 * 判据全部走**真文件系统**（临时目录里写真 IR），不 mock：
 * 这一栏最容易错的就是"读盘这件事本身"（目录不存在、坏文件、非 IR 文件混在里面），
 * mock 掉文件系统等于把这些失效模式全部取消。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

import { bodyCombinations, coveragePreview, existingCombinations, type ExistingCoverage } from '../src/coverage.js';

/** 一条 openapiCall 的**最小合法** IR；strategy/operationId 按用例给 */
function scn(o: {
  id: string;
  calls: Array<{ operationId: string; strategy?: string }>;
  setupCalls?: Array<{ operationId: string; strategy?: string }>;
}): Scenario {
  // StepDraft 是 Record<string, unknown>，所以这里只能整体断言一次；
  // 真正的形状校验在 defineScenario 里跑（那才是"夹具本身合法"的判据）
  const step = (c: { operationId: string; strategy?: string }, i: number): StepDraft => ({
    id: `c${i}`, kind: 'openapiCall', name: `步 ${i}`,
    docRef: 'shop', operationId: c.operationId, ...(c.strategy ? { strategy: c.strategy } : {}),
  });
  return defineScenario({
    schemaVersion: '1', id: o.id, name: o.id, description: '夹具',
    tags: ['test'], mode: 'script', frozen: false, env: { environmentRef: 'default' },
    ...(o.setupCalls?.length ? { setup: o.setupCalls.map(step) } : {}),
    body: o.calls.map(step),
  } as ScenarioDraft);
}

async function tmpIr(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atest-cov-'));
}

/** 渲染那一栏并拼成一整块文本，方便断言与"红的时候能看见全文" */
function previewText(generated: readonly Scenario[], cov: Awaited<ReturnType<typeof existingCombinations>> | ExistingCoverage, dir: string): string {
  const lines = coveragePreview(generated, cov, dir);
  if (!lines) throw new Error('这一栏整段没印出来（coveragePreview 返回 null）');
  return lines.join('\n');
}

async function writeScn(dir: string, s: Scenario, file = `${s.id}.json`): Promise<void> {
  await writeFile(join(dir, file), `${JSON.stringify(s, null, 2)}\n`, 'utf8');
}

test('bodyCombinations：只数 openapiCall 且两个字段齐的', () => {
  const s = scn({
    id: 'scn.full',
    calls: [
      { operationId: 'a', strategy: 'boundary' },
      { operationId: 'b' },                       // 没填 strategy
      { operationId: '', strategy: 'happyPath' },  // operationId 空
    ],
  });
  // 第三条**不该**被算成"空 operationId 的 happyPath 组合"：那会让所有漏填的用例
  // 在同一个键上互相盖掉，从而把一个真没测过的组合报成已有
  assert.deepEqual(bodyCombinations(s), [{ operationId: 'a', strategy: 'boundary' }]);
});

test('bodyCombinations：只看 body，setup / teardown 里的调用不算主题', async () => {
  const s = scn({
    id: 'scn.setup',
    calls: [{ operationId: 'subject', strategy: 'boundary' }],
    setupCalls: [{ operationId: 'login', strategy: 'happyPath' }],
  });
  assert.deepEqual(bodyCombinations(s), [{ operationId: 'subject', strategy: 'boundary' }]);

  // 这条断言判的是**代价方向**：login/happyPath 只在 setup 里出现过时，
  // 它必须仍被报成"新增"。反过来（算成已有）会把一条从没当主题测过的组合劝掉，
  // 而那是这一栏设计上唯一会造成伤害的方向
  const dir = await tmpIr();
  await writeScn(dir, s);
  const cov = await existingCombinations(dir);
  assert.deepEqual(cov.keys, [{ operationId: 'subject', strategy: 'boundary' }]);
  const text = previewText([scn({ id: 'x', calls: [{ operationId: 'login', strategy: 'happyPath' }] })], cov, dir);
  assert.ok(text.includes('新增：login/happyPath'), text);
});

test('一个场景六条同组合调用 = 一个组合、零批内重复（判据单位）', async () => {
  const dir = await tmpIr();
  const same = Array.from({ length: 6 }, () => ({ operationId: 'createOrder', strategy: 'boundary' }));
  const gen = scn({ id: 'scn.gen', calls: same });

  const text = previewText([gen], { keys: [], scanned: 0, notIr: 0, broken: 0 }, dir);
  assert.ok(text.includes('6 次调用覆盖 1 个组合'), text);
  assert.ok(text.includes('其中 1 个是磁盘上还没有的'), text);
  // 这一条是本轮那个错的正面拦截：**不许**出现"这批内部重复"这种说法。
  // 六条同组合调用是一个场景的六个边界值，是设计如此，不是重复
  assert.ok(!text.includes('内部重复'), `六条同组合调用不该被报成批内重复：\n${text}`);
  assert.ok(!text.includes('留一条就够'), `不该给出"删掉其余边界值"这种建议：\n${text}`);
});

test('目录空时一个"已有"都不许出现（第一版在这里撒过谎）', async () => {
  /*
   * 实测到的改前输出（磁盘上零文件的第一次 gen）是这两行**同时**印出来的：
   *   · 已有：createOrder / boundary            ← 一共五条这样的
   *   （已有组合来自 …：扫了 0 个 json，其中 0 个不是 IR）
   * 上一行的意思是"这五个组合磁盘上已经有了"，下一行说磁盘上一个 json 都没有。
   * 真相是那五条是**同一批里的调用互相算成重复**（boundary 一个场景六条调用），
   * 而"批内重复"与"磁盘上已有"是两回事，第一版把它们印成了同一回事。
   *
   * ⚠ 我曾在登记里把这句写成「已有的 6 个都在磁盘上」与"扫了 0 个 json"同屏 ——
   * **那是把两次运行并成一次了**：那句原话出自**磁盘上已有一个文件**的那次 gen，
   * 在那里它并不矛盾（只是把"6 次引用"说成"6 个已有"，是另一个轻一些的错）。
   * 记不准实测输出比记错更难查，所以这里只留逐字抄下来的那份。
   */
  const dir = await tmpIr();
  const cov = await existingCombinations(dir);
  assert.deepEqual(cov, { keys: [], scanned: 0, notIr: 0, broken: 0 });
  const text = previewText([scn({ id: 'scn.a', calls: [{ operationId: 'a', strategy: 'boundary' }] })], cov, dir);
  assert.ok(text.includes('扫了 0 个 json'), text);
  assert.ok(text.includes('1 个是磁盘上还没有的'), text);
  // 判据回到不变量本身：**磁盘上没有时，一个"已有"都不许出现**
  assert.ok(!text.includes('已有：'), `磁盘上一个文件都没有，却报出了"已有"：\n${text}`);
  assert.ok(!text.includes('一个都没新增'), `没有已有用例时不得劝人"别生成"：\n${text}`);
});

test('磁盘上真有的组合 → 0 新增并给出建议（那一栏唯一的正当产出）', async () => {
  const dir = await tmpIr();
  await writeScn(dir, scn({ id: 'scn.exists', calls: [{ operationId: 'a', strategy: 'boundary' }] }));
  const cov = await existingCombinations(dir);
  const text = previewText([scn({ id: 'scn.new', calls: [{ operationId: 'a', strategy: 'boundary' }] })], cov, dir);
  assert.ok(text.includes('其中 0 个是磁盘上还没有的'), text);
  assert.ok(text.includes('建议合并或别生成'), text);
  assert.ok(text.includes('已有：a/boundary'), text);
});

test('一批里两个组合、磁盘上有一个 → 新增只数差集', async () => {
  const dir = await tmpIr();
  await writeScn(dir, scn({ id: 'scn.has1', calls: [{ operationId: 'a', strategy: 'boundary' }] }));
  const cov = await existingCombinations(dir);
  const text = previewText(
    [scn({ id: 'scn.g', calls: [{ operationId: 'a', strategy: 'boundary' }, { operationId: 'b', strategy: 'boundary' }] })],
    cov, dir,
  );
  assert.ok(text.includes('覆盖 2 个组合，其中 1 个是磁盘上还没有的'), text);
  assert.ok(text.includes('已有：a/boundary'), text);
  assert.ok(text.includes('新增：b/boundary'), text);
  assert.ok(!text.includes('新增：a/boundary'), text);
});

test('两侧共用一套键编码：operationId 带 | 时不得把两个组合算成一个', async () => {
  const dir = await tmpIr();
  await writeScn(dir, scn({ id: 'scn.pipe', calls: [{ operationId: 'a|b', strategy: 'boundary' }] }));
  const cov = await existingCombinations(dir);
  // 生成的那一批是 (a, boundary)。它与磁盘上的 (a|b, boundary) 是两个组合，
  // 但**用 `|` 拼接这两个键会撞**吗？不会 —— 真正的撞法是
  // `(a, "b|boundary")` vs `(a|b, "boundary")`，而**这一侧今天造不出来**：
  // strategy 在 IR 里是闭合 enum（载体：packages/ir/test/strategy-enum.test.ts），
  // 13 个合法值里没有一个含 `|`。所以这个测试判的是"两侧编码一致 + operationId
  // 里的 | 无害"，**不是**"撞键缺陷今天可达"。那半句写在 coverageDelta 函数头，
  // 它判的是函数契约（参数是 string，不受 IR enum 保护），与这条调用链无关
  const text = previewText([scn({ id: 'scn.g', calls: [{ operationId: 'a', strategy: 'boundary' }] })], cov, dir);
  assert.ok(text.includes('其中 1 个是磁盘上还没有的'), `两个不同组合被算成一个：\n${text}`);
  assert.ok(text.includes('新增：a/boundary'), text);
  assert.ok(!text.includes('已有：a/boundary'), text);
});

test('看着像 IR 而校验不过的文件要数出来并警告（否则把已有的报成新增）', async () => {
  const dir = await tmpIr();
  /*
   * 有 id + body 所以"看着像 IR"，而内容过不了 schema。
   * ⚠ 这份夹具**改过一次**：先前是"步骤少一个 name"，而 IR 里步骤的 name 是
   * optional（`StepBase.name`）—— 那份夹具其实是**合法 IR**，走不到 broken 那一格。
   * 现在缺 docRef（openapiCall 必填），实测确实不合法。
   * 记在这里是因为这类"夹具不是它声称的形状"的红，比断言写错更难查：
   * 数字对不上时人会先去怀疑判据。
   */
  await writeFile(join(dir, 'broken.json'), JSON.stringify({
    schemaVersion: '1', id: 'scn.broken', name: 'b', description: 'd', tags: ['t'], mode: 'script',
    frozen: false, env: { environmentRef: 'default' },
    body: [{ id: 'c0', kind: 'openapiCall', operationId: 'a', strategy: 'boundary' }],
  }), 'utf8');
  const cov = await existingCombinations(dir);
  assert.equal(cov.broken, 1);
  assert.equal(cov.scanned, 1);
  assert.deepEqual(cov.keys, []);
  const text = previewText([scn({ id: 'scn.g', calls: [{ operationId: 'a', strategy: 'boundary' }] })], cov, dir);
  // 这个文件的覆盖是真存在而读不出来 —— 不警告的话读者会信"0 个已有"
  assert.ok(text.includes('1 个文件看着像 IR 而校验不过'), text);
  assert.ok(text.includes('没算进已有'), text);
});

test('不是 IR 的 json 不算坏文件（evidence 里的 run.json 不该让人去修）', async () => {
  const dir = await tmpIr();
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify({ runId: 'r1', status: 'passed' }), 'utf8');
  await writeFile(join(dir, 'notjson.jsonc'), '{ 这不是 JSON', 'utf8');
  await writeFile(join(dir, 'sub', 'deep.json'), JSON.stringify({
    schemaVersion: '1', id: 'scn.deep', name: 'd', description: 'd', tags: ['t'], mode: 'script',
    frozen: false, env: { environmentRef: 'default' },
    body: [{ id: 'c0', kind: 'openapiCall', name: 'n', docRef: 'shop', operationId: 'z', strategy: 'happyPath' }],
  }), 'utf8');
  await writeFile(join(dir, 'ignore.txt'), 'not scanned at all', 'utf8');
  const cov = await existingCombinations(dir);
  assert.equal(cov.scanned, 3, '递归扫到 3 个 .json/.jsonc，.txt 不算');
  assert.equal(cov.broken, 0, 'run.json 与语法错的 jsonc 都不该报"坏 IR"');
  assert.equal(cov.notIr, 2);
  // 子目录要走到：只扫顶层的话"已有"会系统性偏小，于是永远报"有新增"
  assert.deepEqual(cov.keys, [{ operationId: 'z', strategy: 'happyPath' }]);
});

test('目录不存在 → 空覆盖而不是抛错（gen 首次运行的常态）', async () => {
  const cov = await existingCombinations(join(await tmpIr(), 'nope'));
  assert.deepEqual(cov, { keys: [], scanned: 0, notIr: 0, broken: 0 });
});

test('一批里一个组合都没有 → 这一栏整段不印（不制造"0 新增"的假警报）', async () => {
  const dir = await tmpIr();
  // 用一条 set 步而不是空 body：IR 要求 body 至少一步，空 body 那份夹具压根不合法。
  // 判据不变 —— 批里一个 openapiCall 都没有时，**不许**得出"覆盖没新增"这个结论
  // （那会把"这批不测接口"读成"这批没价值"）
  const noCall = defineScenario({
    schemaVersion: '1', id: 'scn.nocall', name: 'n', description: 'd', tags: ['test'],
    mode: 'script', frozen: false, env: { environmentRef: 'default' },
    body: [{ id: 's1', kind: 'set', assign: { a: 'x' } }],
  } as ScenarioDraft);
  const printed = coveragePreview([noCall], { keys: [], scanned: 0, notIr: 0, broken: 0 }, dir);
  assert.equal(printed, null, '没有 openapiCall 的批次不该得出"覆盖没新增"这个结论');
});
