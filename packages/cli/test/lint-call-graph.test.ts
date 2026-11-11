/**
 * `atest lint` / `run --strict` 的**调用图**这一档。
 *
 * ## 为什么要单开一个文件，而不是往 e2e.test.ts 里加两条
 *
 * `cmdLint` 在加这个文件之前**一条行为测试都没有** —— 全仓只有两处提到 lint 命令：
 * `args.test.ts` 验 `lint -` 能被解析，`e2e.test.ts` 遍历命令名把 `--help` 打一遍。
 * 也就是说这两处验的都是"这条命令存在"，没有一处验"它报什么"。
 * 这正好解释了缺口为什么能活这么久：**`ctx` 那个对象从写下来就没被填过第二回**，
 * 而没有任何一条测试会因为它空着而变红。本文件钉的就是"填了没有、填了之后报什么"。
 *
 * ## 判据为什么是"跑真的命令 + 真的临时项目"
 *
 * 这一档的缺陷全在**装配**上（谁去解析 ref、图交给谁、报告怎么说），
 * 引擎侧那条规则本身早就有单测（`engine/test/lint.test.ts`）。
 * 所以这里一律走 `main([...])`，用真文件系统：桩件能桩掉"解析器被调了"，
 * 桩不掉"解析器被调的时候参数是从哪儿来的"。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../src/main.js';
import { EXIT } from '../src/exit.js';
import { buildScenarioGraph, makeCallResolver, DEFAULT_MAX_CALL_NODES } from '../src/commands.js';
import type { Io } from '../src/commands.js';
import { findConfig } from '../src/paths.js';
import type { ScenarioGraphGapCause } from '@atest/engine';
import { defineScenario, type Scenario } from '@atest/ir';

/** 一个临时项目：atest.json 指向 ir/，里面按传入的 (id → 它 call 谁) 摆文件 */
async function project(files: Record<string, { calls: string[]; maxCostUsd?: number }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-callgraph-'));
  await writeFile(join(dir, 'atest.json'), JSON.stringify({ irDir: join(dir, 'ir'), root: dir }), 'utf8');
  // ir/ 目录要真的建出来：irDir 指向它，而 findByScenarioId 会 readdir 它
  await mkdir(join(dir, 'ir'), { recursive: true });
  for (const [id, spec] of Object.entries(files)) {
    const body: unknown[] = [
      { id: 's1', kind: 'set', assign: { v: 1 } },
      ...spec.calls.map((c, i) => ({ id: `c${i + 1}`, kind: 'call', scenarioRef: c })),
      { id: 'a1', kind: 'assert', against: '$v', jsonPath: { $: { eq: 1 } } },
    ];
    const scen: Record<string, unknown> = {
      schemaVersion: '1', id, name: `${id} 的夹具`, frozen: true,
      env: { environmentRef: 'unit' }, body,
    };
    if (spec.maxCostUsd !== undefined) {
      scen.config = { timeoutMs: 600_000, maxCostUsd: spec.maxCostUsd, retries: { count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network', 'timeout'] }, concurrencySafe: true, dirty: false };
    }
    await writeFile(join(dir, 'ir', `${id.split('.').pop()}.json`), `${JSON.stringify(scen, null, 1)}\n`, 'utf8');
  }
  return dir;
}

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [];
  const e: string[] = [];
  const io = { out: (s: string) => o.push(s), err: (s: string) => e.push(s), cwd, env: {} } as Io;
  const code = await main(argv, io);
  return { code, out: o.join('\n'), err: e.join('\n') };
}

test('真环 A↔B：lint 报 DEPENDENCY_CYCLE 并且**退出码非 0**', async () => {
  /*
   * 本轮接这条线之前实测的形状（同一份夹具）：
   *   scn.a：✓ 通过（0 个警告）      退出码 0
   * 与一个**无环**场景的输出逐字相同。规则、判据、图消费者全都在，
   * 只是没人把图递给 lint —— 所以"没报"既可能是"没环"也可能是"没看"。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.b@1'] }, 'scn.b': { calls: ['scn.a@1'] } });
  const r = await cli(['lint', 'scn.a'], dir);
  assert.match(r.out, /DEPENDENCY_CYCLE/, `真环该被点名：\n${r.out}`);
  assert.match(r.out, /scn\.a → scn\.b → scn\.a/, `链条要说得出怎么绕回来的：\n${r.out}`);
  assert.equal(r.code, EXIT.INVALID, '环是 error 级，lint 的退出码必须是 3（不是 0）');
});

test('无环（a→leaf）在**同样的装配路径**下仍然通过', async () => {
  /*
   * 上面那条的正向对照。没有它，"lint 到处报环"这种坏法也能过关
   * —— 而那个坏法更糟：人会连真环一起不信。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.leaf@1'] }, 'scn.leaf': { calls: [] } });
  const r = await cli(['lint', 'scn.a'], dir);
  assert.ok(!r.out.includes('DEPENDENCY_CYCLE'), `无环不该报环：\n${r.out}`);
  assert.ok(!r.out.includes('CALL_GRAPH_INCOMPLETE'), `图完整时不该报缺口：\n${r.out}`);
  assert.equal(r.code, EXIT.OK);
});

test('子场景解析不到时报"图不完整"（warning），**不许**安静地通过', async () => {
  /*
   * 缺口本身是这一格最要紧的东西：图缺一条边时，"没有环"是一个**超出证据的结论**，
   * 而裸 Record 的接口压根没法表达"我没看全"，于是报告上的「✓ 通过」会被读成"查过了"。
   *
   * 三个断言各钉一件事：说出来、别拦执行（warning）、**并且别只说"通过"就完事**。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.ghost@1'] } });
  const r = await cli(['lint', 'scn.a'], dir);
  assert.match(r.out, /CALL_GRAPH_INCOMPLETE/, `解析不到的 ref 该说出来：\n${r.out}`);
  assert.match(r.out, /scn\.ghost@1/, '要点名是哪个 ref 解析不到');
  assert.match(r.out, /判不出/, '要说清"从这里往后的环判不出"，不能只说"图不全"');
  assert.equal(r.code, EXIT.OK, '不拦执行：解析不到有正当原因（部分 checkout / 子场景在别的仓）');
  // **反向对照**：那句"通过"不许是唯一的一行 —— 缺口必须与结论同时在场
  assert.match(r.out, /✓ 通过/, '仍然算通过（这条钉的是"缺口可见"，不是"缺口拦执行"）');
  assert.ok(r.out.indexOf('CALL_GRAPH_INCOMPLETE') < r.out.indexOf('✓ 通过'),
    '缺口要出现在结论**之前**：先说"通过"再说"其实没看全"，读的人只记得住前者');
});

test('子文件**在而那份 IR 读不出**时，话说成"文件在而 IR 读不出"，不是"解析不到"', async () => {
  /*
   * 这一条是本轮的**起因**，也是它唯一的证法：必须走真文件系统 + 真命令。
   * 改前实测（同一个夹具）：
   *   ! [CALL_GRAPH_INCOMPLETE]：调用图不完整：1 个 call 目标**解析不到**（例如 scn.bad@1…）
   * 那句话字面没错，而它是**错归因**：人于是去查 scn.bad 存不存在、拼没拼错，
   * 而真相是那个文件一直在、里面那份 IR 不合法。更要紧的是
   * **环可能正藏在那个读不出来的文件里**，而报告让人以为去看文件名就够了。
   *
   * 断言的两面都要有：说了"读不出"，**并且**不许再说"找不到"。
   * 只断第一面的话，实现退化成"永远说读不出"也能过关 ——
   * 那比原来更坏，因为原来至少有一半是对的。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.bad@1'] } });
  // 文件名与 id 对得上（`bad.json` 里 id 是 `scn.bad`，resolveScenarioPath 按文件名就能命中），
  // 所以"找不到文件"这条解释**在这份夹具里是可证的假**
  await writeFile(join(dir, 'ir', 'scn.bad.json'), JSON.stringify({
    schemaVersion: '1', id: 'scn.bad', name: '坏掉的子场景', env: { environmentRef: 'unit' },
    body: [{ id: 's', kind: 'notARealKind' }],
  }), 'utf8');
  const r = await cli(['lint', 'scn.a'], dir);
  assert.match(r.out, /CALL_GRAPH_INCOMPLETE/, `子 IR 读不出也要说出来：\n${r.out}`);
  assert.match(r.out, /读不出/, '要说清是"文件在而 IR 读不出"');
  assert.ok(!r.out.includes('找不到'), `文件明明在，不许说"找不到"：\n${r.out}`);
  assert.match(r.out, /scn\.bad\.json/, 'detail 要带上是哪个文件（否则"读不出"没有下文）');
  // 修法也得跟着分岔：给"文件在"的人一个"把子场景放进 irDir"，他会去搬文件或改 ref
  assert.match(r.out, /内容/, '修法要指明修的是文件**内容**');
  assert.ok(!r.out.includes('irDir'), `不许给"文件在"的人一个搬文件的动作：\n${r.out}`);
  assert.equal(r.code, EXIT.OK, '仍然是 warning：入口场景这条 lint 不该被子场景拖成 error');
});

test('两种缺口同时在场时**一种一句**，且 message 说了的原因在修法里必须有', async () => {
  /*
   * 端到端的那一面（引擎侧只测措辞函数，测不到"原因真的从解析器走到了 lint"）。
   * 这里刻意让两种原因同时出现：合成一句"有 N 处没展开"的话，
   * 三种修法混在一起，读的人一种也做不了。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.ghost@1', 'scn.bad@1'] } });
  await writeFile(join(dir, 'ir', 'scn.bad.json'), '{ "body": [', 'utf8');
  const r = await cli(['lint', 'scn.a'], dir);
  const line = r.out.split('\n').find((l) => l.includes('CALL_GRAPH_INCOMPLETE')) ?? '';
  assert.match(line, /读不出/, '有 IR 不合法的那种');
  assert.match(line, /找不到/, '有文件不存在的那种');
  // 两句话各自带自己的数量词，所以"1 处"该出现两次（合成一句就只有一次）
  assert.equal(line.split('1 处').length - 1, 2, `两种原因该各一句、各带计数：\n${line}`);
  const fix = r.out.split('\n').find((l) => l.includes('修法')) ?? '';
  assert.match(fix, /内容/);
  assert.match(fix, /irDir/);
});

test('@version 不参与解析，所以 A@1→B@1→A@2 也算环（与运行时的判据同一个口径）', async () => {
  /*
   * `interpreter.ts` 里那段运行时环检测的注释写着"判据按场景 id 而不是 ref：
   * A@1 → B@1 → A@2 也是环"。**静态闸必须与它同口径**，否则静态那一关形同虚设，
   * 而这条链的整个价值就是"一个请求都不发就知道 IR 坏了"。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.b@1'] }, 'scn.b': { calls: ['scn.a@2'] } });
  const r = await cli(['lint', 'scn.a'], dir);
  assert.match(r.out, /DEPENDENCY_CYCLE/, `换个 @version 不该绕过静态闸：\n${r.out}`);
});

test('call 自己只报 SELF_REFERENCING_CALL 一条', async () => {
  const dir = await project({ 'scn.a': { calls: ['scn.a@1'] } });
  const r = await cli(['lint', 'scn.a'], dir);
  assert.equal(r.out.split('SELF_REFERENCING_CALL').length - 1, 1, `该报一条：\n${r.out}`);
  assert.ok(!r.out.includes('DEPENDENCY_CYCLE'), `自环不该再报第二条（同一条 IR 的一个坏被报成两处）：\n${r.out}`);
});

test('--strict 也走图：**一个请求都不发**就拒绝执行环场景', async () => {
  /*
   * `--strict` 是 CI 会用的那一档，而它从前调的是 `lintScenario(scenario)`
   * —— 第二个参数压根不传。本轮接上之前，这件事在测试里不可见（没一条测试跑这条分支）。
   *
   * 断言里最要紧的一句是"证据目录压根没建"：那才是"一个请求都没发"的物证。
   * 只看退出码 3 不够 —— 跑完再报 lint 错误也会是 3（虽然顺序不对），
   * 而这条分支存在的理由就是**顺序**。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.b@1'] }, 'scn.b': { calls: ['scn.a@1'] } });
  const r = await cli(['run', 'scn.a', '--env-var', 'baseUrl=http://127.0.0.1:1', '--strict'], dir);
  assert.equal(r.code, EXIT.INVALID, `--strict 该拦住：\n${r.err}`);
  assert.match(r.err, /DEPENDENCY_CYCLE/, '拦下来的理由要点名是哪条规则：\n' + r.err);
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(dir);
  assert.ok(!names.includes('evidence'), `lint 拦下时不该产生任何证据（一个请求都不能发）。实际目录里有：${names.join(', ')}`);
});

test('无环场景在 --strict 下照跑（这条闸不许把合法用例一起拦了）', async () => {
  /*
   * 上面那条的反面。少了它，"凡 --strict 一律拒绝"这种坏法能过整组测试，
   * 而那种坏法的代价是 CI 里没人再用 --strict。
   */
  const dir = await project({ 'scn.a': { calls: ['scn.leaf@1'] }, 'scn.leaf': { calls: [] } });
  const r = await cli(['run', 'scn.a', '--env-var', 'baseUrl=http://127.0.0.1:1', '--strict'], dir);
  assert.ok(!/--strict：lint 有/.test(r.err), `不该被 lint 拦住：\n${r.err}`);
});

// ── buildScenarioGraph 本体 ──────────────────────────────────────────────

const leaf = (id: string): Scenario => defineScenario({
  schemaVersion: '1', id, name: id, env: { environmentRef: 'unit' },
  body: [{ id: 's', kind: 'set', assign: { v: 1 } } as never],
} as never);

const calls = (id: string, refs: string[]): Scenario => defineScenario({
  schemaVersion: '1', id, name: id, env: { environmentRef: 'unit' },
  body: [{ id: 's', kind: 'set', assign: { v: 1 } } as never,
    ...refs.map((r, i) => ({ id: `c${i}`, kind: 'call', scenarioRef: r } as never))],
} as never);

test('buildScenarioGraph 只走**可达闭包**，不扫全仓（这条推翻了"要先扫整棵树"那个前提）', async () => {
  /*
   * docs/14 §5 原先登记的是"填它要先把整棵调用图从文件系统扫出来"，
   * 而环检测要的根本不是全仓所有的边，是**从入口能走到的那些边**。
   * 这条钉的就是"没被走到的场景压根没被解析"：用解析调用次数当证据，
   * 而不是看图的内容 —— 图里当然不含 unreachable，但"没读它"这件事只有计数器说得出。
   */
  const asked: string[] = [];
  const g = await buildScenarioGraph(calls('scn.entry', ['scn.mid@1']), async (ref) => {
    asked.push(ref);
    if (ref.startsWith('scn.mid')) return calls('scn.mid', []);
    return leaf('scn.unreachable');
  });
  assert.deepEqual(Object.keys(g.edges).sort(), ['scn.entry', 'scn.mid']);
  assert.deepEqual(asked, ['scn.mid@1'], `只该解析可达的那一个：${asked.join(', ')}`);
  assert.ok(!('scn.unreachable' in g.edges));
});

test('解析不到的 ref：边**照记**（IR 上确实写了），缺口另记一条', async () => {
  /*
   * 两种选择都想过。"解析失败就不记边"会让图**悄悄变小**，
   * 而悄悄变小的图正是这个函数要防的东西；记了边又让 edges 混进"我查到的"与"作者写的"两种语义 ——
   * 所以 edges 始终是"作者写了什么"的忠实投影，可读性缺口只在 gaps 里。
   */
  const g = await buildScenarioGraph(calls('scn.a', ['scn.ghost@2']), async () => undefined);
  assert.deepEqual(g.edges['scn.a'], ['scn.ghost'], `边要按 id 记下来：${JSON.stringify(g.edges)}`);
  assert.deepEqual(g.gaps, [{ from: 'scn.a', ref: 'scn.ghost@2' }]);
});

test('环不会让遍历转圈；触到节点上限时**报截断**而不是静默', async () => {
  /*
   * 上限存在的理由写在那个常量旁边：无上限的遍历在"解析过就不再解析"这道护栏
   * 被改松的那天会变成**永远不返回的 lint**。这里用 maxNodes=2 走一条真链，
   * 验的是"到了上限就停 + 停下来要说话"，不是"上限是 200"这个数。
   */
  const g = await buildScenarioGraph(calls('scn.a', ['scn.b@1']), async (ref) =>
    calls(ref.startsWith('scn.b') ? 'scn.b' : 'scn.c', ['scn.next@1']), { maxNodes: 2 });
  assert.ok((g.truncated ?? 0) >= 1, `触上限要记下来：${JSON.stringify(g)}`);

  // 环 + 默认上限：必须停得住（这条会**挂住**如果去重那一行被删）
  const cyc = await buildScenarioGraph(calls('scn.a', ['scn.b@1']), async (ref) =>
    ref.includes('b') ? calls('scn.b', ['scn.a@1']) : calls('scn.a', ['scn.b@1']));
  assert.ok(!cyc.truncated, `两个节点不该触默认上限 ${DEFAULT_MAX_CALL_NODES}`);
  assert.deepEqual(cyc.edges['scn.a'], ['scn.b']);
});

test('同一个坏 ref 被 call 两次时，两个缺口各自带上**自己的**原因（原因表按 ref 键）', async () => {
  /*
   * 这条钉的是"为什么是一张小表而不是一个『最后一次失败』的回调"。
   * 解析器**按 ref 缓存**：同一个坏 ref 第二次问到时命中缓存，压根不再解析，
   * 所以"记最后一次"的做法在这里会让第二个缺口挂上**别的 ref 的原因** ——
   * 那是凭空捏造的归因，比没有原因更坏（本轮整轮的起因就是一句错归因）。
   *
   * 夹具刻意**交替**排两种 ref（坏-好-坏）：如果实现记的是"最后一次失败的那个原因"，
   * 第三个缺口就会挂上第二个 ref 的原因 —— 顺序一换就换归因，这叫顺序敏感。
   * 而且这里**不用**真 resolver（走文件系统的话，缓存与原因由不得测试掌控），
   * 只借用它的"未命中才解析"这一件事：真缓存才是"onGap 只响一次"的成因，
   * 桩掉解析本身、留下缓存这条路径。
   */
  const gapLog = new Map<string, ScenarioGraphGapCause>();
  const g = await buildScenarioGraph(
    calls('scn.a', ['scn.bad@1', 'scn.ghost@1', 'scn.bad@1']),
    async (ref) => {
      // 模拟解析器的两种失败：**只有第一次问到某个 ref 时才记原因**
      // （真解析器的缓存就是这个行为：第二次命中缓存，回调压根不再触发）
      if (!gapLog.has(ref)) gapLog.set(ref, { reason: ref.includes('bad') ? 'invalid-ir' : 'not-found', detail: '假装读不出' });
      return undefined;
    },
    { gapReasonOf: (ref) => gapLog.get(ref) },
  );
  assert.equal(g.gaps?.length, 3, `三条 call 三个缺口（重复的 ref 也是独立的一条边）：${JSON.stringify(g.gaps)}`);
  assert.deepEqual(g.gaps?.map((x) => x.reason), ['invalid-ir', 'not-found', 'invalid-ir'],
    '每个缺口挂的是**自己那个 ref** 的原因');
});

test('makeCallResolver 自己：不传 gapLog 时行为与改动前**逐字相同**，传了才记原因', async () => {
  /*
   * `run` 那条路径**不传** gapLog（它不需要静态归因，运行时会自己报 env-unavailable
   * 并带上是哪一步）。所以这里要有正反两面：传了要记对，没传什么都不动。
   * 少了后一面，"为了记原因顺手改返回值形状"这种坏法没人挡 ——
   * 那个返回值是**引擎端口**（`Scenario | undefined`），改它等于改引擎契约。
   */
  const dir = await project({ 'scn.a': { calls: [] } });
  // 只摆那一个坏文件：文件名就是 `scn.bad.json`，resolveScenarioPath 按文件名第一跳就命中它，
  // 所以"这个文件不存在"这条解释在这份夹具里是**可证的假**
  await writeFile(join(dir, 'ir', 'scn.bad.json'), '{ "body": [', 'utf8'); // 文件在而 JSON 坏
  const cfg = await findConfig(dir);

  const logged = new Map<string, ScenarioGraphGapCause>();
  const r1 = makeCallResolver({ cfg, cwd: dir, gapLog: logged });
  assert.ok(await r1('scn.a@1'), '合法的子场景照常解析出来');
  assert.equal(await r1('scn.bad@1'), undefined, '读不出的还是 undefined（端口形状不许动）');
  assert.equal(await r1('scn.nope@1'), undefined);
  assert.equal(logged.has('scn.a@1'), false, '解析成功不该记缺口');
  assert.equal(logged.get('scn.bad@1')?.reason, 'invalid-ir');
  const badDetail = logged.get('scn.bad@1')?.detail;
  // 首行结尾那个冒号是"下面还有清单"的记号，而清单被我们丢了 —— 留着它，
  // 这句话就以一个等下文的记号结尾而后面什么都没有
  assert.ok(typeof badDetail === 'string' && badDetail.length > 0, 'IR 读不出必须带一句 detail');
  assert.ok(!/[:：]\s*$/.test(badDetail), `detail 不许以冒号结尾：${badDetail}`);
  assert.match(badDetail, /JSON|场景 IR/, 'detail 要说得出是读不出在哪个环节（JSON 语法 / schema）');
  /*
   * **只许一行**。这条钉的是"detail 只取首行"那个决定本身。
   * 少了它，"顺手把整段 zod 清单搬进 detail"是**测试全绿**的改动 ——
   * 而那句话会经 lint 输出进 CI 日志。校验失败最常见的对象是登录请求，
   * 清单里逐字写着失败字段的路径与值形态，那等于把实际值往磁盘上写
   * （同一族约束：ajv 那处刻意不输出 `er.data`、`HARDCODED_SECRET` 只打印长度）。
   * 完整清单作者要看时看得到：`atest lint <那个文件>` 会打全 12 条。
   */
  assert.ok(!badDetail.includes('\n'), `detail 只许一行（多行 = 整段校验清单进 CI 日志）：${JSON.stringify(badDetail)}`);
  assert.equal(logged.get('scn.nope@1')?.reason, 'not-found');
  assert.equal(logged.get('scn.nope@1')?.detail, undefined, '"找不到"没有 detail 可给（没读到任何文件）');

  const silent = makeCallResolver({ cfg, cwd: dir });
  assert.equal(await silent('scn.bad@1'), undefined, '不传 gapLog 时返回值一模一样');
});

test('ref 里的 id 与那份 IR 的**内部 id 不一致**时，两个键都挂出边（否则图悄悄断在这里）', async () => {
  /*
   * 这不是假想：`resolveScenarioPath` 先按**文件名**试 `<id>.json`，
   * 而 paths.ts 自己写着"文件名与 id 不一致是常态：改名后 id 常留旧的"。
   * 只按内部 id 挂边的话，图里有一条指向 `scn.short` 的边而那一格是空的，
   * 遍历到那里当叶子收工 —— 经由那条边才看得见的环全部漏报，
   * **而 gaps 里没有它**（解析成功了），所以"图不完整"也不会报。
   * 那是最坏的一种：静默、完整、错。
   */
  const g = await buildScenarioGraph(calls('scn.a', ['scn.short@1']), async () => calls('scn.very.long.internal.id', ['scn.a@1']));
  assert.deepEqual(g.edges['scn.short'], ['scn.a'], 'ref 那个键要挂着同样的出边');
  assert.deepEqual(g.edges['scn.very.long.internal.id'], ['scn.a'], '内部 id 那个键也要有');
  assert.ok(!g.gaps, '解析成功了，不该报缺口');
});
