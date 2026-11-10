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

import { EVIDENCE_FILES, deterministicClock, runScenario, type AdapterRegistry, type HttpExec, type RunReport } from '@atest/engine';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { readZipEntries } from '../src/zip.js';
import { DiskArtifactStore } from '../src/artifacts.js';
import { buildEvidencePackage } from '../src/evidence.js';

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
/**
 * http 夹具**写成 HttpExec 而不是 `as never`**（与 parallel.test.ts 同一条理由）：
 * 接口加必选方法时这里必须编译不过，否则夹具会一直"少一个方法也能跑"。
 * resolveOperation 本文件用不到，但它是必选项，所以老实返回形状正确的空解析结果。
 */
function fakeHttp(send: HttpExec['send']): HttpExec {
  return {
    send,
    resolveOperation: async (ref) => ({
      method: ref.method ?? 'GET', urlTemplate: ref.path ?? '/x', requiredBodyFields: [], deprecated: false,
    }),
  };
}
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
