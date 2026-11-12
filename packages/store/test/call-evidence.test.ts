/**
 * `call` 子场景产的证据必须进 `evidence.zip`。
 *
 * 修之前的事实（实测）：子里 http 步骤的响应体**正常落盘**了，但包里只有父侧那一条，
 * 而 `missing` 是 0 —— 排查的人看到"缺 0 个"，最自然的结论是"平台没存这个东西"。
 * `missing` 存在的唯一理由就是"别让少一件东西看起来像什么都没少"，
 * 而这条路径恰好绕开它：旧实现按 stepId 反查存储，父侧结果里没有子的步骤，
 * 于是连"本该有"这个前提都不成立，missing 无从填起。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EVIDENCE_FILES, deterministicClock, runScenario, type AdapterRegistry, type EvidenceManifest, type HttpExec, type RunReport } from '@atest/engine';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { readZipEntries } from '../src/zip.js';
import { DiskArtifactStore } from '../src/artifacts.js';
import { buildEvidencePackage } from '../src/evidence.js';
import { stubHttp } from './helpers.js';

const sub = (id: string, body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id, name: `子 ${id}`, tags: [],
    env: { environmentRef: 'unit' }, frozen: true, provenance: { origin: 'human' }, body,
  } as unknown as ScenarioDraft) as Scenario;

const parent = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.parent', name: '父', tags: [],
    env: { environmentRef: 'unit' }, frozen: true, provenance: { origin: 'human' }, body,
  } as unknown as ScenarioDraft) as Scenario;

const base = (id: string, url = `http://x/${id}`) => ({ id, kind: 'http', request: { method: 'GET', url } });

async function freshStore(): Promise<DiskArtifactStore> {
  return new DiskArtifactStore({ dir: await mkdtemp(join(tmpdir(), 'atest-call-ev-')) });
}

/** 响应体带 URL：内容寻址下同内容同 id，不区分就没法验"两份不同的证据" */
/*
 * http 夹具直接用 helpers 里的 `stubHttp`（它返回的就是 HttpExec，不是 `as never`，
 * 所以接口加必选方法时这里必须编译不过）。本文件那几条测的是证据归属与落盘，
 * 压根不看 URL 长什么样。
 *
 * ⚠ 原先这里另抄了一份内联的 composeUrl（外加一份 resolveOperation），
 * 与 helpers 那份只差"扫不扫占位符" —— 那正是本仓在删的东西：两份桩会各自漂移，
 * 而漂移的表现是"某一份的 missing 分支永远走不到，测试却全绿"。
 * 而本文件的 urlTemplate 是 `http://x/<id>` 这种完整地址，没有占位符可扫，
 * 所以换成真扫占位符的那一份不改变任何断言的含义。
 */
const fakeHttp = stubHttp;
const http = () => fakeHttp(async (req) => {
  const bodyText = `{"url":"${req.url}"}`;
  return { status: 200, headers: {}, body: { url: req.url }, bodyText, bytes: bodyText.length, truncated: false, durationMs: 2 };
});

/**
 * 返回值带 scenario：清单里的 irSha 声明的是"这份证据出自哪一版 IR"，
 * 组装时必须传**真跑的那一份**。传另一份场景（哪怕只差一个步骤）
 * 会让包里的指纹指向一个没跑过的 IR —— 而它看起来完全正常。
 */
async function runWith(store: DiskArtifactStore, childBody: StepDraft[], parentBody: StepDraft[]) {
  const child = sub('sub.login', childBody);
  const scn = parent(parentBody);
  const report = await runScenario({
    scenario: scn,
    adapters: { http: http(), artifactStore: store, callScenario: async () => child },
    clock: deterministicClock(7),
  });
  return { scn, report };
}

test('子场景落的响应体进包，且清单里带得上场景坐标', async () => {
  const store = await freshStore();
  const { scn, report } = await runWith(store, [base('ca1') as StepDraft], [base('c1') as StepDraft, { id: 'k1', kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]);
  const pkg = await buildEvidencePackage({ scenario: scn, report, store });

  const names = new Set(readZipEntries(pkg.bytes).map((e) => e.name));
  const members = [...names].filter((n) => n.startsWith(`${EVIDENCE_FILES.artifactsDir}/`));
  assert.equal(members.length, 2, `父 1 条 + 子 1 条都该在包里。实际：${members.length} 条`);
  assert.equal(pkg.missing.length, 0);

  const stepIds = pkg.manifest.artifacts.map((a) => a.stepId);
  assert.ok(stepIds.includes('c1'), `父侧步骤该在清单里，实际 ${stepIds.join(',')}`);
  // 子侧带场景 id：跨场景之后"哪个步骤"不再是唯一坐标
  assert.ok(stepIds.includes('sub.login/ca1'), `子侧步骤该带场景坐标，实际 ${stepIds.join(',')}`);
});

test('嵌套两层的 call：孙场景的证据也在（扁平合并真被用上了）', async () => {
  const store = await freshStore();
  const leaf = sub('sub.leaf', [base('la1') as StepDraft]);
  const mid = sub('sub.mid', [{ id: 'm1', kind: 'call', scenarioRef: 'sub.leaf@1' } as StepDraft]);
  const parentScene = parent([{ id: 'k1', kind: 'call', scenarioRef: 'sub.mid@1' } as StepDraft]);
  const report = await runScenario({
    scenario: parentScene,
    adapters: { http: http(), artifactStore: store, callScenario: async (ref: string) => (ref.startsWith('sub.mid') ? mid : leaf) },
    clock: deterministicClock(7),
  });
  const pkg = await buildEvidencePackage({ scenario: parentScene, report, store });
  const stepIds = pkg.manifest.artifacts.map((a) => a.stepId).join(',');
  assert.ok(stepIds.includes('sub.leaf/la1'), `A→B→C 而响应体在 C 时也要能拿到。实际：${stepIds || '空'}`);
});

test('跨场景同名步骤：证据不互相染色（旧实现按 stepId 反查会把子的记到父名下）', async () => {
  const store = await freshStore();
  // 父和子都有一步叫 c1（步骤 id 只在自己的场景里唯一，这合法）
  const { scn, report } = await runWith(
    store,
    [base('c1', 'http://x/child') as StepDraft],
    [base('c1', 'http://x/parent') as StepDraft, { id: 'k1', kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft],
  );
  assert.equal(new Set([...report.results, ...report.childRuns![0]!.results].flatMap((r) => r.artifactIds)).size, 2,
    '前提：两边确实各产了一份**不同内容**的证据（同 URL 同响应体会被内容寻址去重成一条，那就测不到归属）');
  const pkg = await buildEvidencePackage({ scenario: scn, report, store });
  const rows = pkg.manifest.artifacts;
  assert.equal(rows.length, 2, '两份不同响应体 = 两条清单记录');
  assert.equal(new Set(rows.map((r) => r.id)).size, 2, 'id 必须不同（内容不同）');
  // 关键：各自归属清楚。旧实现 recordsOf(['c1']) 一次捞出两条，
  // 于是包里的"这一步的证据"变成两条，其中一条根本不属于这一步
  assert.deepEqual(rows.map((r) => r.stepId).sort(), ['c1', 'sub.login/c1']);
});

test('声明过但磁盘取不到的证据：同时在清单与 missing 里（不把"取不到"改写成"没产过"）', async () => {
  const store = await freshStore();
  const { scn, report } = await runWith(store, [base('ca1') as StepDraft], [base('c1') as StepDraft, { id: 'k1', kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]);
  const id = report.results[0]!.artifactIds[0]!;
  assert.ok(id, '前提：这一步确实落了盘');
  const { rmSync } = await import('node:fs');
  rmSync(join(store.rootDir, 'sha', id.slice(0, 2), id), { force: true });

  const pkg = await buildEvidencePackage({ scenario: scn, report, store });
  assert.deepEqual(pkg.missing, [id]);
  // **包里**也要写。只走 CLI 的 stderr 不够：evidence.zip 是给**别人下载**的东西，
  // 下载的人没看到 CI 那行"注意：有 N 个证据取不到"，他只会看到 artifacts 里少一条，
  // 最自然的结论是"平台没存" —— 与上一段那条"取不到 ≠ 没产过"是同一条理由的两半
  const inZip = JSON.parse(new TextDecoder().decode(readZipEntries(pkg.bytes).find((e) => e.name === EVIDENCE_FILES.manifest)!.data)).missing;
  assert.deepEqual(inZip, [id], 'missing 必须落进 manifest.json，不能只在函数返回值里');
  // 清单里那条**还在**（run 当时确实产出了它），只是装不进包
  const row = pkg.manifest.artifacts.find((a) => a.id === id);
  assert.ok(row, '清单里必须还看得到它，否则"取不到"被静默改写成"这次没产证据"');
  assert.ok(row!.kind && row!.kind !== 'unknown', `kind 要从落盘事件里带回来，实际 ${row!.kind}`);
  // 而包里的成员确实没有它（否则 missing 与内容自相矛盾）
  assert.ok(!readZipEntries(pkg.bytes).some((e) => e.name.includes(id)));
});

test('adapter 落了盘却忘了把 id 带进结果时，兜底仍然收进包里并标"未归属"', async () => {
  const store = await freshStore();
  const { scn, report } = await runWith(store, [base('ca1') as StepDraft], [base('c1') as StepDraft, { id: 'k1', kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]);
  // 伪造一个"落过盘但结果里没声明"的形态：把 artifactIds 抹掉，只留 artifact.saved 事件
  const parentArts = report.results.flatMap((r) => r.artifactIds);
  assert.ok(parentArts.length >= 1, '前提：父侧确实声明过至少一份证据');
  const stripped = { ...report, results: report.results.map((r) => ({ ...r, artifactIds: [] })) } as RunReport;
  const pkg = await buildEvidencePackage({ scenario: scn, report: stripped, store });
  const rows = pkg.manifest.artifacts;
  assert.equal(rows.length, 2,
    '父侧那份被抹掉 id 之后**仍要在包里**（兜底走 artifact.saved 事件）。按 stepId 反查存储"顺手"能盖住这个漏，'
    + '同时也会把别的场景/别的 run 的同名步骤捞进来 —— 那是用一个错误遮蔽另一个错误');
  const orphan = rows.find((r) => (r.stepId ?? '').startsWith('未归属'));
  assert.ok(orphan, `该看出是"落盘了但没人带 id"，实际归属：${rows.map((r) => r.stepId).join(',')}`);
  assert.equal(orphan!.id, parentArts[0], '兜底收的正是被抹掉那一条');
  assert.match(orphan!.stepId ?? '', /^未归属:c1$/, '要指得出是哪一步落的，否则人只能从头读 trace');
});

/* ── EvidenceManifest.children（§6.1：子场景结果结构化回流）──────────────── */

/**
 * 这组测试钉的是"机器消费者不必 grep 文本"。
 * 修之前，"这次 run 跑了哪几个子场景、各自几个 pass/fail"只存在于
 * JUnit 那条 failure 的**正文文本**与 report.html 的人读段落里；
 * 服务端 run 表/看板要拿它只能去解析散文。
 */

/*
 * 解包后的 manifest **直接 cast 成引擎导出的那个类型**，不在测试里重抄一份形状。
 * 我第一版手抄了 `{ failing?: { stepId: string } }`，于是给 failing 加 inScenario/status
 * 之后这条测试的三个字段访问全是类型错误 —— 而 `npm test` 照样绿（它用 --import tsx，
 * 不做类型检查），只有 typecheck:test 抓到。手抄的契约一定会漂，
 * 这与"手抄一份成员清单会漏掉 report.html"是同一件事，只是发生在测试侧。
 */
const manifestOf = (bytes: Uint8Array): EvidenceManifest =>
  JSON.parse(new TextDecoder().decode(readZipEntries(bytes).find((e) => e.name === EVIDENCE_FILES.manifest)!.data)) as EvidenceManifest;

test('manifest.children：每个跑过的子场景一条，带自己的 tally 与调用坐标', async () => {
  const store = await freshStore();
  const { scn, report } = await runWith(store,
    // ca2 是**另一个 http**，不是我第一版写的 set：那版把 base('ca2') 展开进来
    // 又留着 request 键，schema 当场拒（报错现在会点名 request —— 上一轮 humanize 的成果）。
    // 这里要的是"子场景有两个叶子步骤"，用两个 http 最简单且不引入无关形状
    [base('ca1') as StepDraft, base('ca2') as StepDraft],
    [base('c1') as StepDraft, { id: 'k1', kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]);
  const pkg = await buildEvidencePackage({ scenario: scn, report, store });
  // 判据从**包里的 JSON**取，不从 pkg.manifest 取：后者是内存对象，
  // 字段没进序列化路径（比如被 redactForDisk 意外吃掉）时只有前者会红
  const kids = manifestOf(pkg.bytes).children;
  assert.ok(Array.isArray(kids), 'children 必须落进 manifest.json');
  assert.equal(kids!.length, 1, `一个 call 一条。实际 ${kids!.length}`);
  const k = kids![0]!;
  assert.equal(k.ref, 'sub.login@1', 'ref 原样带出（@version 今天被忽略是已知缺口，见 §5；先如实记）');
  assert.equal(k.scenario.id, 'sub.login');
  assert.equal(k.calledById, 'scn.parent', 'calledById 是**发起方**的场景 id，不是自己的');
  assert.equal(k.callStepId, 'k1');
  // tally 来自**子场景自己的 run**：子场景里 2 个叶子都 pass
  assert.equal(k.tally.pass, 2, `子的 tally 不该掺父的步骤，也不该掺孙的。实际 ${JSON.stringify(k.tally)}`);
  assert.equal(k.status, 'pass');
  // irSha 与 store 现算的一致（同 IR 同 sha 是 M7 的地基；写死值会变成"改 IR 顺手改测试"）
  const { irShaOf } = await import('../src/ir-hash.js');
  assert.equal(k.scenario.irSha, irShaOf(report.childRuns![0]!.scenario),
    '子的 irSha 必须是**跑过的那份 IR** 的指纹');
});

test('children 覆盖任意深度，且每层的 tally 只数自己（孙的步骤不进子的分母）', async () => {
  const store = await freshStore();
  const leaf = sub('sub.leaf', [base('la1') as StepDraft]);
  const mid = sub('sub.mid', [
    { ...base('m0'), id: 'm0' } as StepDraft,
    { id: 'm1', kind: 'call', scenarioRef: 'sub.leaf@1' } as StepDraft,
  ]);
  const parentScene = parent([{ id: 'k1', kind: 'call', scenarioRef: 'sub.mid@1' } as StepDraft]);
  const report = await runScenario({
    scenario: parentScene,
    adapters: { http: http(), artifactStore: store, callScenario: async (ref: string) => (ref.startsWith('sub.mid') ? mid : leaf) },
    clock: deterministicClock(7),
  });
  const kids = manifestOf((await buildEvidencePackage({ scenario: parentScene, report, store })).bytes).children;
  assert.equal(kids!.length, 2, '扁平：子与孙都在');
  const byId = new Map(kids!.map((c) => [c.scenario.id, c]));
  /*
   * 每层只数**自己 results 里那些步骤**。mid 的 tally.pass 是 2 而不是 1：
   * 它自己那一步 http（m0）**加上它自己那个 call 步骤**（m1）——
   * tally 是"这一步跑成什么"的桶，call 在 tally 里就是一个步骤
   * （与父侧 tally 把 k1 数成 1 同一口径；门禁**另有**一套按 CONTAINER_KINDS
   * 剔容器的算法，那是"几条业务结论"的问题，不是这个桶的问题）。
   * 我第一版在这里断 1，理由写的是"m1 是容器由被调方带结论" ——
   * 那是把门禁的剔容器口径错接到了 tally 上，测出来的是我以为的语义。
   *
   * 真正能证伪"父的口径覆盖子的实况"的判据是**成员**：
   * 孙的那一步（la1）绝不能出现在子的 results 里。
   */
  const midRun = report.childRuns!.find((c) => c.scenario.id === 'sub.mid')!;
  assert.deepEqual(midRun.results.map((r) => r.stepId).sort(), ['m0', 'm1'],
    '子的 results 只能有它自己的步骤；掺进 la1 就是扁平合并写错了地方');
  assert.equal(byId.get('sub.mid')!.tally.pass, midRun.results.length,
    '清单里的 tally 必须与那份 results 对齐（两者来自同一个子 run，不该分叉）');
  assert.equal(byId.get('sub.leaf')!.tally.pass, 1, 'leaf 只数自己那一步');
  assert.equal(byId.get('sub.leaf')!.calledById, 'sub.mid', '孙要能回答"谁叫起了我"');
});

test('children 与 JUnit 正文给出**同一个**坏步骤（同源判据，不许两处各算一遍）', async () => {
  const store = await freshStore();
  const leaf = sub('sub.leaf', [
    base('la1') as StepDraft,
    { id: 'la', kind: 'assert', against: '$.step.la1', status: 418 } as StepDraft, // 实际 200 => fail
  ]);
  const mid = sub('sub.mid', [{ id: 'k1', kind: 'call', scenarioRef: 'sub.leaf@1' } as StepDraft]);
  const parentScene = parent([{ id: 'k1', kind: 'call', scenarioRef: 'sub.mid@1' } as StepDraft]);
  const report = await runScenario({
    scenario: parentScene,
    adapters: { http: http(), artifactStore: store, callScenario: async (ref: string) => (ref.startsWith('sub.mid') ? mid : leaf) },
    clock: deterministicClock(7),
  });
  const pkg = await buildEvidencePackage({ scenario: parentScene, report, store });
  const kids = manifestOf(pkg.bytes).children!;
  /*
   * 两条都该指向**同一个根因** sub.leaf/la —— 这正是"同源"的全部含义：
   * 我从最外层钻与从中间层钻，落点必须是同一个，
   * 否则"页面指的坏步骤"与"清单指的坏步骤"会不一致，而没人能判断哪个是真的。
   *
   * 我第一版在这里断的是"mid 报它自己那个 call(k1)"，理由写得也很顺
   * （"中层该报中层，深层的事由深层那条自己说"）。但那与 EvidenceChild.failing
   * 的**文档**（"往下钻到最深的那一层，与 JUnit 正文同一算法"）互相矛盾 ——
   * 也就是说我当时正准备让实现和文档各说一套。真正的信息缺口不是"少了一层"，
   * 而是"坐标里没写这一步属于哪个场景"，那由 inScenario 补，不是靠少钻一层来暗示。
   */
  const withBad = kids.filter((c) => c.failing);
  assert.equal(withBad.length, 2, `mid 与 leaf 的子树里都有坏步骤：${JSON.stringify(kids.map((c) => [c.scenario.id, c.failing]))}`);
  for (const c of withBad) {
    assert.equal(c.failing!.stepId, 'la', `${c.scenario.id} 那条要指到真坏那一步`);
    assert.equal(c.failing!.inScenario, 'sub.leaf', '并说清那一步**属于哪个场景**');
    assert.equal(c.failing!.status, 'fail');
  }
  // 与 JUnit 正文逐字对齐（同一个答案的两种写法，不是两个算法）
  const { toJUnitXml } = await import('@atest/engine');
  const junit = toJUnitXml(report);
  const m = junit.match(/根因在子场景步骤：([^\s=]+)=/);
  assert.ok(m, `JUnit 正文里该有根因行：\n${junit}`);
  assert.equal(`${withBad[0]!.failing!.inScenario}/${withBad[0]!.failing!.stepId}`, m![1],
    '清单与 JUnit 必须给出同一个坐标');
  // 同名 call 的作用域回归：mid 的**记录本身**仍指它自己那一次调用
  const midBad = withBad.find((c) => c.scenario.id === 'sub.mid')!;
  assert.equal(midBad.callStepId, 'k1');
  assert.equal(midBad.calledById, 'scn.parent');
});

test('childRuns 没记（undefined）=> 不写 children 一栏；记了但为空 => 写 []', async () => {
  const store = await freshStore();
  const { scn, report } = await runWith(store, [base('ca1') as StepDraft], [base('c1') as StepDraft]);
  assert.equal(report.childRuns, undefined, '前提：这个场景没跑 call，引擎刻意不给空数组');
  // 情形一：这份报告压根没记子运行 => 整栏缺席
  const bare = manifestOf((await buildEvidencePackage({ scenario: scn, report, store })).bytes);
  assert.ok(!('children' in bare), `"没记"与"记了且没跑"必须是两种包内容。实际键集：${Object.keys(bare).join(',')}`);
  // 情形二：记了、确实一个 call 都没跑 => children: []（门禁/看板据此区分数据缺失与真没跑）
  const recorded = manifestOf((await buildEvidencePackage({ scenario: scn, report: { ...report, childRuns: [] }, store })).bytes);
  assert.deepEqual(recorded.children, [], '记了就该有这一栏，哪怕是空数组');
});
