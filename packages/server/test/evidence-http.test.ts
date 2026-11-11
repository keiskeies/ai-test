/**
 * 证据那条路**端到端**：起真服务端，跑真引擎产出真证据包，然后用 HTTP 把
 * report.html 里会出现的每一类链接都点一遍。
 *
 * ## 为什么单独开这个文件（而 files.test.ts 已经存在）
 *
 * `files.test.ts` 测的是 `resolveEvidence()` 这个**函数**："这个名字允许被读吗"。
 * 它全绿，而同一段时间里浏览器上**每一个证据链接都是 404**、
 * **运行记录列表一条都列不出**。原因不是它写得不好，是它测的不是这一格：
 * 白名单放行 ≠ 磁盘上有那个文件 ≠ 路由真去读了它。
 * 这三段之间断掉的有两处，各自都在别的包里：
 *  1. 写侧只往 run 目录落 trace/junit/report/zip，**manifest 与 summary 只在包里**
 *     —— 于是报告里那两个相对链接指向不存在的文件，`/api/runs` 恒空；
 *  2. `artifacts/<sha>` 本来就该只在包里（散装的体积与脱敏代价），
 *     而路由只 `readFile` —— 那个链接**永远**点不开。
 * 两侧的测试当时都绿，因为**没有一条测试同时看过这两侧**。
 * 所以这里断的是"点得开"，用的是**真跑一次产出的字节**，不是手搓的 fixture。
 *
 * ## 夹具为什么走真引擎
 *
 * 手搓一个 run 目录（写几个 json）能过这个文件里所有正向断言，
 * 但它测不到"写侧真的写出这些名字"—— 而**那正是本次缺陷本体**。
 * 所以这里用 `buildEvidencePackage` + `writeEvidenceMembers` + `writeEvidencePackage`
 * 那一套生产代码铺盘，与 `atest run` 走的是同一条写路径。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deterministicClock, runScenario, type RunReport } from '@atest/engine';
import { defineScenario, type Scenario, type StepDraft } from '@atest/ir';
import {
  DiskArtifactStore, buildEvidencePackage, writeEvidenceMembers, writeEvidencePackage,
} from '@atest/store';

import { startServer, type RunningServer } from '../src/index.js';

const RUN_ID = 'run_http1';

async function oneRun(): Promise<{ dir: string; evidenceDir: string; runDir: string; artifactId: string; report: RunReport }> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-srv-ev-'));
  const evidenceDir = join(dir, 'evidence');
  const runDir = join(evidenceDir, RUN_ID);
  await mkdir(evidenceDir, { recursive: true });
  // 与 CLI 同构：内容寻址存储住在 <evidenceDir>/artifacts
  const store = new DiskArtifactStore({ dir: join(evidenceDir, 'artifacts') });

  const bodyText = '{"id":7,"note":"hello from the mock"}';
  // 走 defineScenario（zod 解析 + 补 default）而不是手搓对象再 `as never`：
  // 手搓的那份缺了 schema 补出来的默认值，runScenario 会炸在别处，
  // 而"夹具炸在无关的地方"是这段代码最费人的失败模式。
  const scenario: Scenario = defineScenario({
    schemaVersion: '1', id: 'scn.http', name: 'http e2e', env: { environmentRef: 'unit' },
    targets: ['api'],
    body: [
      { id: 'hit', kind: 'http', request: { method: 'GET', url: 'https://api.test/orders' }, saveAs: 'res' },
      { id: 'ok', kind: 'assert', against: '$res', status: 200 },
    ] as StepDraft[],
  } as never);
  const report = await runScenario({
    scenario,
    adapters: {
      artifactStore: store,
      http: {
        async send() {
          return { status: 200, headers: {}, body: JSON.parse(bodyText), bodyText, bytes: bodyText.length, truncated: false, durationMs: 3 };
        },
      },
    } as never,
    clock: deterministicClock(42),
    env: { baseUrl: 'https://api.test' },
    // runId 由引擎算（`run_<时钟的 36 进制>`），但**目录名是调用方给的** ——
    // 不给的话这里会出现"目录叫 run_http1、manifest 里写着别的"，
    // 那不是被测行为，是夹具自己在编一个现实中不存在的形状。
    runId: RUN_ID,
  });

  const pkg = await buildEvidencePackage({ scenario, report, store });
  // 与 `atest run` 完全同样的两步：散装文档成员 + 包
  await writeEvidenceMembers(runDir, pkg.entries);
  await writeEvidencePackage(runDir, RUN_ID, report.status, pkg.bytes, Boolean(report.aborted));

  const artifactId = report.results.flatMap((r) => r.artifactIds)[0] ?? '';
  // 夹具自检：没有证据的话，下面"artifacts 那条链接点得开"会因为压根没断言而假绿
  assert.match(artifactId, /^[0-9a-f]{64}$/, `夹具该产出一件内容寻址证据，实际 "${artifactId}"`);
  return { dir, evidenceDir, runDir, artifactId, report };
}

async function serve(o: { dir: string }): Promise<{ srv: RunningServer; get: (p: string) => Promise<{ status: number; body: Buffer }> }> {
  const srv = await startServer({ cwd: o.dir, port: 0 });
  return {
    srv,
    get: async (p: string) => {
      const res = await fetch(`${srv.url}${p}`);
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

test('GET /api/runs 列得出刚跑完的那次 run（改前恒空列表）', async () => {
  const f = await oneRun();
  const { srv, get } = await serve({ dir: f.dir });
  try {
    const res = await get('/api/runs');
    assert.equal(res.status, 200);
    const items = (JSON.parse(res.body.toString('utf8')) as { items: Array<{ dir: string; manifest?: { runId?: string } }> }).items;
    assert.equal(items.length, 1, `应列出那一次 run，实际 ${JSON.stringify(items.map((i) => i.dir))}`);
    assert.equal(items[0]!.dir, RUN_ID);
    assert.equal(items[0]!.manifest?.runId, RUN_ID, 'manifest 要真读出来了，不是占位');
  } finally { await srv.close(); }
});

test('report.html 里每一个相对链接，浏览器都真点得开', async () => {
  /*
   * 这条是本文件的正题。做法是**从报告里把链接抠出来再逐个 GET**，
   * 而不是我照着记忆列五个名字 —— 后者测的是"我以为报告里链了什么"，
   * 而报告是引擎产的，它会变（report.html 加成员那一次就是这么漏掉提示的）。
   */
  const f = await oneRun();
  const { srv, get } = await serve({ dir: f.dir });
  try {
    const html = readFileSync(join(f.runDir, 'report.html'), 'utf8');
    const hrefs = [...html.matchAll(/href="\.\/([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(hrefs.length >= 3, `夹具：报告里该有相对链接，实际 ${hrefs.join(', ') || '无'}`);
    const broken: string[] = [];
    for (const h of new Set(hrefs)) {
      const res = await get(`/evidence/${RUN_ID}/${h}`);
      if (res.status !== 200) broken.push(`${h} -> ${res.status}`);
    }
    assert.deepEqual(broken, [], `报告里这些链接点不开：${broken.join('、')}`);
  } finally { await srv.close(); }
});

test('artifacts/<sha> 只在包里，也点得开（散装刻意不写）', async () => {
  const f = await oneRun();
  const { srv, get } = await serve({ dir: f.dir });
  try {
    assert.equal(existsSync(join(f.runDir, 'artifacts', f.artifactId)), false,
      '前提：散装那份**不该**存在（体积翻倍 + 多一份未脱敏副本）');
    const res = await get(`/evidence/${RUN_ID}/artifacts/${f.artifactId}`);
    assert.equal(res.status, 200, '只在包里的成员必须由包里读出来，否则报告里那个证据链接是死的');
    assert.match(res.body.toString('utf8'), /hello from the mock/, '取出的必须是那份响应体本身');
  } finally { await srv.close(); }
});

test('读侧的白名单在 HTTP 这一层同样生效：包外文件一个都不给', async () => {
  /*
   * 正向能力（从包里读）是新加的，而它顺带把"读磁盘文件"换成了"读磁盘 + 读包"。
   * 换读法最容易被顺手放宽，所以这里**照着放宽的方向打**：
   *  ① 成员名之外但**确实躺在 run 目录里**的文件（env.json）；
   *  ② 包本身（`evidence.*.zip` —— 里面有全部响应体，而下载该走别的机制）；
   *  ③ 跨 run / 跨出证据目录的写法。
   * 断言写成"状态码不是 200"而不是"等于 404"以外的任何形状，
   * 因为 404 本身就是判据（403 会说"这里有东西但不给你"，而"哪格有东西"是信息）。
   */
  const f = await oneRun();
  await writeFile(join(f.runDir, 'env.json'), '{"token":"should-never-leave"}');
  await writeFile(join(f.evidenceDir, 'other.json'), '{}');
  const { srv, get } = await serve({ dir: f.dir });
  try {
    const zipName = `evidence.${RUN_ID}.${f.report.status}.zip`;
    const cases = [
      `/evidence/${RUN_ID}/env.json`,
      `/evidence/${RUN_ID}/${zipName}`,
      `/evidence/${RUN_ID}/artifacts/../env.json`,
      `/evidence/${RUN_ID}/../other.json`,
      `/evidence/${RUN_ID}/..`,
      `/evidence/..%2Fother.json/report.html`,
      `/evidence/${RUN_ID}/artifacts/${'0'.repeat(63)}`,
      `/evidence/${RUN_ID}/artifacts/${'0'.repeat(64)}`,   // 形状对但那次 run 没产过它
    ];
    for (const p of cases) {
      const res = await get(p);
      assert.notEqual(res.status, 200, `${p} 不该被读到（内容：${res.body.subarray(0, 40).toString('utf8')}）`);
    }
  } finally { await srv.close(); }
});

test('坏包不炸服务：manifest 解不开时标 broken，而不是让列表整格消失或 500', async () => {
  const f = await oneRun();
  // 把散装 manifest 换成非法 JSON —— 它比包先被读到，所以这条测的是"读到但解不开"。
  // 刻意**不**让 readRunMember 在"字节读出来了但解不开"时回落到包：
  // 它是个**字节**读取器，懂 JSON 就越界了（那需要一个"解析并校验"的层）。
  // 原件仍然完好地躺在包里，取法是 `atest evidence show <zip> manifest.json`。
  await writeFile(join(f.runDir, 'manifest.json'), '{这不是 JSON');
  const { srv, get } = await serve({ dir: f.dir });
  try {
    const res = await get('/api/runs');
    assert.equal(res.status, 200, '一条坏证据不该把整个列表变成 500');
    const items = (JSON.parse(res.body.toString('utf8')) as { items: Array<{ broken?: boolean }> }).items;
    assert.equal(items.length, 1, `坏 manifest 也要占一行，实际 ${JSON.stringify(items)}`);
    assert.equal(items[0]!.broken, true, '"存在但读不出"必须说得出读不出');
  } finally { await srv.close(); }
});
