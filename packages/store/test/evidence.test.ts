/**
 * M6 判据：**一次失败 run 产出可独立打开的 `evidence.zip`**。
 *
 * "可独立打开"这四个字是这个文件存在的全部理由。
 * 自己写的 zip 自己读，永远能读通 —— 写错了也会错得一样，测试全绿而包打不开。
 * 所以判据走两头：
 *  1. **系统 `unzip -t` / `unzip -o`**（macOS 自带的 Info-ZIP）验包并解包，
 *     解出来的成员逐字节等于写入内容。这是"外部工具认"，不是"我认"。
 *  2. 密钥搜不到：把真 JWT/AKIA/Bearer 喂进 run，再从**解开的字节**里搜。
 *     这条通常没人写，而 evidence 包恰恰是**给多人下载的东西** ——
 *     密钥进包 = 进每个有 CI 读权限的人的磁盘。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  EVIDENCE_FILES, EVIDENCE_MEMBERS, deterministicClock, parseTraceJsonl, redactForDisk, runScenario,
  toJUnitXml, toTraceJsonl, type AdapterRegistry, type RunReport,
} from '@atest/engine';
import type { Scenario, StepDraft } from '@atest/ir';
import { b, scen, stubHttp } from './helpers.js';
import { DiskArtifactStore } from '../src/artifacts.js';
import { buildEvidencePackage, isEvidenceMember, readRunMember, writeEvidenceMembers, writeEvidencePackage, readEvidenceMember } from '../src/evidence.js';
import { irShaOf } from '../src/ir-hash.js';
import { buildZip, dosStamp, readZipEntries } from '../src/zip.js';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

async function freshStore(): Promise<DiskArtifactStore> {
  return new DiskArtifactStore({ dir: await mkdtemp(join(tmpdir(), 'atest-ev-')) });
}

/** 一次真失败 run（跑真引擎，不用手搓 RunReport：手搓的会漏掉真实 events 的形状）
 *
 * **证据必须由这次 run 自己产出**（走 http 步骤的自动落盘），不能在跑完之后
 * 直接 `store.save(...)` 塞进存储。理由：包里的证据来自「结果里声明的 artifactIds +
 * 落盘事件」，而不是「存储里恰好有哪些按 stepId 索引的东西」——
 * 后者会把**别的场景/别的 run 写的**证据按同名 stepId 捞进本包（串档），
 * 而按 stepId 反查恰好遮蔽了"adapter 落了盘却忘了把 id 带进结果"这个漏。
 * 手塞的 fixture 测的是那套旧机制，所以一并改掉。
 */
async function failingRun(
  store: DiskArtifactStore,
  opts: { responseBody?: string } = {},
): Promise<{ scenario: Scenario; report: RunReport }> {
  const body = opts.responseBody ?? '{"id":1,"note":"order created"}';
  const steps = [
    { ...b('hit'), kind: 'http', request: { method: 'GET', url: 'https://api.test/orders' }, saveAs: 'res' },
    { ...b('v'), kind: 'set', assign: { n: 1, token: 'secret:tok1' } },
    { ...b('ok'), kind: 'assert', against: '$n', expr: '$n == 1' },
    { ...b('bad'), kind: 'assert', against: '$n', expr: '$n > 99' },
  ] as StepDraft[];
  const scenario = scen(steps);
  const report = await runScenario({
    scenario,
    // `satisfies AdapterRegistry` + helpers 里的 stubHttp 顶掉原先那个 `as never`：
    // cast 让端口加必选方法时这里编译照过、运行时才炸，而本文件的失败读起来
    // 像"证据包里少了东西"（本轮 HttpExec 加 composeUrl 就是这个现象）。
    adapters: {
      artifactStore: store,
      http: stubHttp(async () => ({
        status: 200, headers: {}, body: JSON.parse(body), bodyText: body, bytes: body.length, truncated: false, durationMs: 3,
      })),
    } satisfies AdapterRegistry,
    clock: deterministicClock(42),
    env: { baseUrl: 'https://api.test' },
  });
  return { scenario, report };
}

/** 这次 run 真正落盘的那些证据 id（不读 store.all()：那包含本进程写过的一切） */
function producedIds(report: RunReport): string[] {
  return report.results.flatMap((r) => r.artifactIds);
}

/** 用系统的 unzip 解包，返回 成员名 -> 文本。解压失败直接抛（那就是判据不成立） */
function unzipMembers(bytes: Uint8Array): Map<string, Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'atest-unzip-'));
  const zip = join(dir, 'evidence.zip');
  writeFileSync(zip, bytes);
  execFileSync('unzip', ['-t', zip], { stdio: 'pipe' }); // 先 -t：CRC/结构必须合法
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'pipe' });
  const out = new Map<string, Buffer>();
  for (const name of listFiles(dir)) {
    if (name.endsWith('.zip')) continue;
    out.set(name, readFileSync(join(dir, name)));
  }
  return out;
}

/** 递归列出相对路径（unzip 会保留目录结构） */
function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, r)).isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

test('失败 run 产出的包能被系统 unzip 验过并解开，成员逐字节一致', async () => {
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });

  const members = unzipMembers(pkg.bytes);
  // 四个固定成员必须都在
  for (const f of [EVIDENCE_FILES.trace, EVIDENCE_FILES.junit, EVIDENCE_FILES.manifest, EVIDENCE_FILES.summary]) {
    assert.ok(members.has(f), `包里缺 ${f}（实际：${[...members.keys()].join(', ')}）`);
  }
  // 逐字节比对：解出来的内容 == 我们生成的内容。
  // 只验"存在"是不够的 —— 截断、错位、CRC 通过但内容平移，都能通过"存在"这一关。
  assert.equal(members.get(EVIDENCE_FILES.trace)!.toString('utf8'), toTraceJsonl(report.events));
  assert.equal(members.get(EVIDENCE_FILES.junit)!.toString('utf8'), toJUnitXml(report));
  // 证据原件也在，且内容寻址：文件名就是它的 sha256
  const art = [...members.keys()].find((k) => k.startsWith(`${EVIDENCE_FILES.artifactsDir}/`));
  assert.ok(art, 'artifacts/ 下应该有证据原件');
  assert.equal(art!.split('/')[1]!.length, 64, '成员名应是 sha256');
  assert.match(members.get(art!)!.toString('utf8'), /order created/);
  // 成员名 == 这次 run 声明的那个 id（不是"存储里恰好有的一条"）
  assert.equal(art!.split('/')[1], producedIds(report)[0],
    '包里的证据必须是本次 run 产出的那一条；按 stepId 反查存储会把别的 run/别的场景的证据也捞进来');
});

test('envFingerprint：**没给就不写这一栏**，给了就整份进清单', async () => {
  /*
   * 判据的重点在"没给就不写"这一半。
   * 写一个空对象会被下游读成"这次运行没有环境差异"，
   * 而真相是"根本没记环境" —— 两个结论指向完全不同的下一步动作。
   * （这与 artifact.bytes 的处理同一条纪律：宁可不写，也不写一个看起来合法的值。）
   */
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);

  const bare = JSON.parse(unzipMembers((await buildEvidencePackage({ scenario, report, store })).bytes)
    .get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  assert.ok(!('envFingerprint' in bare), '没传指纹时清单里不该出现这一栏（空对象会被读成"无环境差异"）');

  const fp = { environmentRef: 'staging', envRevision: 3, runnerVersion: '0.0.0', platform: 'darwin', viewport: '1280x720', clockMode: 'live' as const };
  const withFp = JSON.parse(unzipMembers((await buildEvidencePackage({ scenario, report, store, envFingerprint: fp })).bytes)
    .get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  assert.deepEqual(withFp.envFingerprint, fp, '指纹要逐字段进清单 —— 它是排查"两次 run 差在哪"的唯一依据');
});

test('证据包里的 junit.xml 独立可解析（不是只有我能解析）', async () => {
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  const xml = unzipMembers(pkg.bytes).get(EVIDENCE_FILES.junit)!.toString('utf8');
  const script = `
import json, sys, xml.etree.ElementTree as ET
s = ET.fromstring(open(sys.argv[1], encoding='utf-8').read())
print(json.dumps({'tests': int(s.get('tests')), 'failures': int(s.get('failures'))}))
`;
  const f = join(mkdtempSync(join(tmpdir(), 'atest-ju-')), 'j.xml');
  await writeFile(f, xml, 'utf8');
  const parsed = JSON.parse(execFileSync('python3', ['-c', script, f], { encoding: 'utf8' }));
  assert.equal(parsed.tests, report.results.filter((r) => r.kind !== 'sequence').length);
  assert.ok(parsed.failures >= 1, 'bad 那步该是 failure');
});

test('喂进真密钥：解开的包里搜不到它（evidence 是给多人下载的）', async () => {
  const store = await freshStore();
  // 三种入口都覆盖：作为**真响应体证据**（走引擎的自动落盘，不是手塞进存储）、
  // 作为结构化数据、作为**字段名很无辜**的结构化数据
  const { scenario, report } = await failingRun(store, {
    responseBody: `{"data":"${JWT}","ak":"AKIAIOSFODNN7EXAMPLE"}`,
  });
  assert.ok(producedIds(report).length >= 1, '前提：这次 run 确实把带密钥的响应体落了盘，否则这条什么都没测');
  const pkg = await buildEvidencePackage({ scenario, report, store });

  const members = unzipMembers(pkg.bytes);
  const all = [...members.values()].map((b) => b.toString('utf8')).join('\n');
  // 整段 token 不能出现
  assert.ok(!all.includes(JWT), 'JWT 原样进了证据包');
  assert.ok(!all.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key 原样进了证据包');
  // 但**痕迹要留下**：变成 "eyJ" 前缀被剪掉也算泄露（能拼回去），
  // 而完全无痕迹会让人以为"这次运行没有 token"
  assert.match(all, /JWT/, '应留下"这里原本是 JWT"的线索');
});

test('原始证据（keepRawKinds）逐字节不改，且清单里能看出它没被改过', async () => {
  const store = new DiskArtifactStore({ dir: await mkdtemp(join(tmpdir(), 'atest-raw-')), keepRawKinds: ['resp.raw'] });
  const body = `{"sig":"${JWT}","x":1}`;
  await store.save('resp.raw', body, 'ok');
  const rec = store.all()[0]!;
  const loaded = await store.load(rec.id);
  assert.equal(new TextDecoder().decode(loaded!.bytes), body, '白名单里的 kind 必须一字节不动 —— 动一个字符，签名问题就永远查不出来');
  assert.equal(rec.redacted, false);
});

test('默认（不在白名单）的文本证据做值形态脱敏', async () => {
  const store = await freshStore();
  await store.save('resp', `{"token":"${JWT}"}`, 'ok');
  const rec = store.all()[0]!;
  assert.equal(rec.redacted, true);
  const text = new TextDecoder().decode((await store.load(rec.id))!.bytes);
  assert.ok(!text.includes(JWT));
});

test('manifest 记录 frozen 与 provenance —— CI 要靠它拒绝执行（M7）', async () => {
  const store = await freshStore();
  // manifest.artifacts 来自「本次 run 声明的 artifactIds」，而 failingRun 里那条 http 步骤
  // 会自动把响应体落盘，所以这里不再手塞证据（手塞的那条属于存储、不属于这次 run，
  // 新规则下它不该进包 —— 详见 failingRun 的注释）。
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store, provenance: { versionId: 'v7' } });
  const m = JSON.parse(unzipMembers(pkg.bytes).get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  assert.equal(m.scenario.frozen, false, 'frozen 必须原样带出：它决定这份证据能不能当门禁依据');
  assert.equal(m.scenario.versionId, 'v7');
  // irSha 由存储层自己算，不接受入参 —— 所以"证据里必有一版 IR 的指纹"是无条件性质
  assert.match(m.scenario.irSha, /^[0-9a-f]{64}$/, 'irSha 必须是全长 sha256');
  assert.equal(m.scenario.irSha, irShaOf(scenario), '清单里的指纹必须等于直接对场景算的值');
  assert.equal(m.redaction.keyRules, 'applied', '脱敏策略要写进包里，否则"证据没被动过"无法证明');
  assert.ok(Array.isArray(m.artifacts) && m.artifacts.length >= 1);
});

test('versionId 缺着就整栏不写；空串是"有值"要留着', async () => {
  /*
   * 这一对断言钉的是**同一个判据的两端**：`!== undefined`，不是 `!versionId`。
   * 用 falsy 判断的话，空串会被静默说成"调用方没说版本" —— 而空串是**合法的有值**
   * （与 `bytes` 取不到时宁可不写也不写 0 同一条立场：0 和空串都是合法值）。
   * "缺"与"空"在排查时指向相反的下一步（查平台没传 vs 查调用方为什么传了空），
   * 合并成一种就是把两种故障压成一条日志。
   *
   * ⚠ 只写注释不写测试是不够的：立场一旦只活在注释里，下一个人把它改成 `!versionId`
   *    不会有任何东西变红（本轮我在 evidence.ts 里就是这么写的，写完整才回来补这条）。
   */
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);

  const absent = JSON.parse(unzipMembers((await buildEvidencePackage({ scenario, report, store })).bytes)
    .get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  assert.ok(!('versionId' in absent.scenario),
    `没给版本时这一栏该整栏消失，实际 ${JSON.stringify(absent.scenario.versionId)}`);

  const empty = JSON.parse(unzipMembers((await buildEvidencePackage({ scenario, report, store, provenance: { versionId: '' } })).bytes)
    .get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  assert.ok('versionId' in empty.scenario, '空串是合法的有值，键要在');
  assert.equal(empty.scenario.versionId, '', '而且值不许被改写');
});

test('irSha 无条件产出：provenance 整个缺失时也有（M7 溯源的最小必要件）', async () => {
  const store = await freshStore();
  const { scenario, report } = await failingRun(store); // scen() 不带 provenance
  const pkg = await buildEvidencePackage({ scenario, report, store });
  const m = JSON.parse(unzipMembers(pkg.bytes).get(EVIDENCE_FILES.manifest)!.toString('utf8'));
  // 这不是"多个字段好看"：--ci 缺 provenance 会拒绝执行，而**放行**的那些 run
  // 必须能回答"出自哪一版 IR"。要是这里跟着 provenance 一起缺，
  // 门禁就退化成"有 provenance 的才谈溯源"，而最需要溯源的恰恰是手写没署名的场景。
  assert.match(m.scenario.irSha, /^[0-9a-f]{64}$/);
  // 稳定性与敏感性的**成对**判据（canonical.test.ts 里有完整的六条，这里只钉"接进了证据链"这一环）：
  // 序列化通道往返不能换版，改一个断言必须换版。
  // 只测前者会放过常量函数（它最稳定），所以两条不可拆。
  assert.equal(irShaOf(JSON.parse(JSON.stringify(scenario)) as Scenario), irShaOf(scenario),
    'JSON 往返换了版：写盘再读回就"产生新版本"，而 IR 一个字没改');
  // 与 failingRun 的场景**只差一个字符**（$n > 99 → $n > 98）。
  // 差得越多这条断言越弱：那样即便哈希只看了步骤 id 也能过
  const other = scen([
    { ...b('v'), kind: 'set', assign: { n: 1, token: 'secret:tok1' } },
    { ...b('ok'), kind: 'assert', against: '$n', expr: '$n == 1' },
    { ...b('bad'), kind: 'assert', against: '$n', expr: '$n > 98' },
  ] as StepDraft[]);
  assert.notEqual(irShaOf(scenario), irShaOf(other),
    '改断言不换版：版本表会把两条不同用例当同一版，审校队列里改过的用例显示成"未改动"');
});

test('irSha 对"同一份 IR 的两种书写"给同一个值（规范化真被接进来了）', () => {
  // ir/test/canonical.test.ts 测的是投影本身，但那边**测不到 irShaOf 有没有真的调用它** ——
  // 把 irShaOf 换成 JSON.stringify(scenario)，canonical 的测试一条都不会红
  // （它测的是 canonicalScenario，不是 irShaOf）。
  // 手写两个键顺序相反的对象（不 parse，所以没有任何东西替我归一键顺序），
  // 判据是"两个指纹相等"：直接 stringify 的实现会给出两个不同的值。
  const body = [{ id: 'a', kind: 'assert', against: '$n', expr: '$n == 1' }];
  const base = { schemaVersion: '1', id: 'scn.hash', name: 'n', env: { environmentRef: 'unit' }, body };
  // tags 放前面 vs 放后面 => 键**插入顺序**不同（不经过 parse，zod 不会替我归一）
  const one = { ...base, tags: ['a'] } as unknown as Scenario;
  const reordered = { tags: ['a'], ...base } as unknown as Scenario;
  assert.notEqual(JSON.stringify(one), JSON.stringify(reordered), '前提：两者的序列化确实不同，否则什么都没比');
  assert.equal(irShaOf(one), irShaOf(reordered),
    '键顺序换了就换指纹：规范化没生效（或压根没被调用），格式化一下 JSON 就"产生新版本"');
});

test('磁盘上已不存在的证据 -> 记进 missing，而不是静默少一个成员', async () => {
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const id = producedIds(report)[0]!;
  assert.ok(id, '前提：这次 run 确实落了盘，否则"取不到"这一条压根没被测到');
  // 手工把文件删掉，模拟"证据被清理任务收了"/磁盘故障
  rmSync(join(store.rootDir, 'sha', id.slice(0, 2), id), { force: true });
  const pkg = await buildEvidencePackage({ scenario, report, store });
  // 断的是"这一条在 missing 里"。原先写的是 `missing.length >= 0` —— 恒真，
  // 一个从不填 missing 的实现也能过，而这条测试的名字恰恰是"不能静默少一个成员"。
  assert.ok(pkg.missing.includes(id), `缺的正是被删掉的 ${id}，实际 missing=${JSON.stringify(pkg.missing)}`);
  // manifest 里这条还在（run 当时确实产出了它），而包里没有：missing 是唯一的解释
  assert.ok(pkg.manifest.artifacts.some((a) => a.id === id));
  const zipNames = new Set(readZipEntries(pkg.bytes).map((e) => e.name));
  assert.ok(![...zipNames].some((n) => n.includes(id)), '包里确实没有它（否则 missing 与内容自相矛盾）');
});

test('写盘：文件名带 runId 与状态，返回 sha256 供 CI 打进日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-write-'));
  const pkg = await buildEvidencePackage({
    scenario: scen([{ ...b('n'), kind: 'noop' }]), report: stubReport(), store: await freshStore(),
  });
  const w = await writeEvidencePackage(dir, 'run_abc/../../etc/passwd', 'fail', pkg.bytes);
  assert.ok(!w.path.includes('etc/passwd'), 'runId 里的路径穿越必须被清洗：它可能来自 API 请求字段');
  assert.match(w.path, /evidence\..*\.fail\.zip$/);
  assert.equal(w.sha256.length, 64);
  assert.equal(await readdir(dir).then((x) => x.length), 1);
});

/** 最小可用的 RunReport（只为写盘这条路，不跑引擎） */
function stubReport(): RunReport {
  return {
    runId: 'run_x', status: 'pass', startedAt: 1_700_000_000_000, durMs: 10, results: [], events: [],
    outputs: {}, costUsd: 0, tally: { pass: 0, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 }, summary: 'pass',
  };
}

test('readEvidenceMember 读回成员，找不到时报错并列出实际成员', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-read-'));
  const pkg = await buildEvidencePackage({ scenario: scen([{ ...b('n'), kind: 'noop' }]), report: stubReport(), store: await freshStore() });
  const w = await writeEvidencePackage(dir, 'r1', 'pass', pkg.bytes);
  assert.match(await readEvidenceMember(w.path, EVIDENCE_FILES.summary), /run_x/);
  await assert.rejects(() => readEvidenceMember(w.path, 'nope.txt'), /现有成员/);
});

// ── zip 层自身 ────────────────────────────────────────────────────────────

/**
 * zip：中文名与空格名。**判据换过，因为原来那条断言不可能通过。**
 *
 * 原来断言"系统 unzip 解出来名字不乱码"。实测（本机 macOS，LANG=zh_CN.UTF-8，
 * 换 LC_ALL=en_US.UTF-8 也一样）：
 *   checkdir error: cannot create .../artifacts/<乱码>  Illegal byte sequence
 *   unable to process ...   → 退出码 2，一个文件都解不出来
 * 而 `unzip -t` 是 OK 的 —— 所以**包是合法的**（CRC、结构、UTF-8 flag 0x0800 全对，
 * 下面第一条断言就在验 flag），坏在 Info-ZIP 把成员名喂给 mkdir 之前的那一步。
 * 这是 unzip 6.0（2010 年的代码，Apple 未维护）在 macOS 上的已知毛病：
 * 它按非 UTF-8 的 locale 解释裸字节名字，得到非法字节序列后直接拒绝建目录。
 * 换句话说：**如果中文成员名是我们自己造的，而团队的解包路径是 unzip，
 * 那 evidence.zip 里只要有一个中文 stepId，整个包在 CI 里就解不出来**
 * （不是解错，是解不出）。这条比测试本身重要，所以记在 docs/04 §M6。
 *
 * 因此判据分三层，各验一件事：
 *  1. 我们写的字节是对的（UTF-8 flag 置位、名字是合法 UTF-8、读回原样）
 *  2. **macOS 原生解压器 ditto（= 访达双击那条路）完整还原中文名** ——
 *     "人能打开"这条由它背书，它是中文用户的实际路径
 *  3. 真成员名**不含非 ASCII**：生产路径上 id 是 sha256 hex、其余四个成员名是常量，
 *     所以 unzip 这条路今天是通的；用断言把这个前提钉住，
 *     将来有人把 stepId 放进成员名就会红，而不是等到 CI 解包失败才发现
 */
test('zip：中文名 —— 字节正确 + macOS 原生解压器完整还原；成员名刻意保持 ASCII', () => {
  const enc = new TextEncoder();
  const cnName = 'artifacts/步骤 一/响应 体.json';
  const bytes = buildZip([{ name: cnName, data: enc.encode('{"a":1}') }], Date.UTC(2026, 0, 1));

  // 1) 字节层：UTF-8 flag(bit11) 必须置位。不置时连 ditto 也只能猜编码，
  //    而 Windows 资源管理器会按 CP437 显示成长串乱码
  const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true);
  assert.ok((flags & 0x800) !== 0, `flags=${'0x' + flags.toString(16)} 未置 bit11（UTF-8 文件名标志）`);
  const back = readZipEntries(bytes);
  assert.equal(back[0]!.name, cnName, '名字应逐字节是 UTF-8 编码、能原样读回');
  assert.equal(new TextDecoder().decode(back[0]!.data), '{"a":1}');

  // 2) macOS 原生解压器（不是我们自己写的读侧）
  const dir = mkdtempSync(join(tmpdir(), 'atest-ditto-'));
  const zp = join(dir, 'e.zip');
  writeFileSync(zp, bytes);
  const out = join(dir, 'x');
  mkdirSync(out);
  execFileSync('ditto', ['-x', '-k', zp, out], { stdio: 'pipe' });
  assert.deepEqual(listFiles(out), [cnName], `ditto 解出的名字：${listFiles(out).join(' | ')}`);
  assert.equal(readFileSync(join(out, cnName), 'utf8'), '{"a":1}');

  // 3) 反向保险：真实包里的成员名必须全 ASCII（否则上面那个 unzip 毛病会命中）。
  //    成员名 = 四个常量 + artifacts/<sha256>，没有一个来自人写的 stepId
  const real = buildZip(
    [{ name: EVIDENCE_FILES.manifest, data: enc.encode('{}') }, { name: `${EVIDENCE_FILES.artifactsDir}/a1b2c3`, data: enc.encode('x') }],
    Date.UTC(2026, 0, 1),
  );
  for (const m of readZipEntries(real)) {
    assert.ok(/^[\x20-\x7e]+$/.test(m.name), `成员名含非 ASCII，CI 的 unzip 会解不出整个包：${m.name}`);
  }
});

test('zip：真实 evidence 包（全 ASCII 成员名）在系统 unzip 下验包+解包全通过', async () => {
  // 与上一条配对：上一条说明"中文成员名 unzip 解不出"，这一条说明"我们实际产出的包
  // 走 unzip 是好的"。两条都留着，才看得出边界在哪。
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  const members = unzipMembers(pkg.bytes); // unzip -t + unzip -o，任一失败即抛
  assert.ok(members.has(EVIDENCE_FILES.manifest));
});

test('zip：空文件与零成员包都合法', () => {
  const enc = new TextEncoder();
  const withEmpty = buildZip([{ name: 'empty.txt', data: new Uint8Array(0) }]);
  execFileSync('unzip', ['-t', writeTmp(withEmpty)], { stdio: 'pipe' });
  assert.equal(readZipEntries(withEmpty)[0]!.data.byteLength, 0);
  // 零成员：unzip 对空包的行为是"没有东西可测"，但结构必须合法（不抛）
  const emptyPkg = buildZip([]);
  // 零成员包：结构合法即可。unzip 对空包返回"没有东西可测"的**非零**退出码，
  // 那是它的正常行为，不是我们的包坏了 —— 所以这里只验"不报格式错"。
  let code = 0;
  try { execFileSync('unzip', ['-t', writeTmp(emptyPkg)], { stdio: 'pipe' }); }
  catch (e) { code = (e as { status?: number }).status ?? -1; }
  assert.ok(code === 0 || code === 1, `unzip 报了非预期错误码 ${code}`);
});

function writeTmp(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'atest-z-'));
  const p = join(dir, 'x.zip');
  execFileSync('sh', ['-c', `cat > "${p}"`], { input: Buffer.from(bytes) });
  return p;
}

test('zip：拒绝 zip slip（成员名带 .. 会让 unzip 写到包外去）', () => {
  for (const bad of ['../evil.txt', '/etc/passwd', 'a/../../b', 'C:\\Windows\\x']) {
    assert.throws(() => buildZip([{ name: bad, data: new Uint8Array(1) }]), /zip slip|相对路径|反斜杠/, bad);
  }
});

test('zip：成员 CRC 不匹配时报错（读侧不校验就是假的完整性）', () => {
  const enc = new TextEncoder();
  const bytes = buildZip([{ name: 'a.txt', data: enc.encode('hello') }]);
  // 改动数据区一个字节（本地头 30 字节 + 名字 5 字节之后就是数据）
  bytes[35] = bytes[35] === 0x68 ? 0x69 : 0x68;
  assert.throws(() => readZipEntries(bytes), /CRC 不匹配/);
});

test('zip：同样内容产出同样字节（证据包本身要能被哈希寻址）', () => {
  const enc = new TextEncoder();
  const mk = () => buildZip([
    { name: 'b.json', data: enc.encode('{"b":2}'), mtimeMs: 1_700_000_000_000 },
    { name: 'a.json', data: enc.encode('{"a":1}'), mtimeMs: 1_700_000_000_000 },
  ], 1_700_000_000_000);
  assert.deepEqual([...mk()], [...mk()]);
  // 顺序不同 -> 字节不同。所以组装侧把顺序写死是有意义的
  const swapped = buildZip([
    { name: 'a.json', data: enc.encode('{"a":1}'), mtimeMs: 1_700_000_000_000 },
    { name: 'b.json', data: enc.encode('{"b":2}'), mtimeMs: 1_700_000_000_000 },
  ], 1_700_000_000_000);
  assert.notDeepEqual([...mk()], [...swapped]);
});

test('dosStamp：1980 年前的时间钳到可表示范围（不产出畸形包）', () => {
  const { date } = dosStamp(new Date('1970-01-01T00:00:00Z').getTime());
  const year = ((date >> 9) & 0x7f) + 1980;
  assert.ok(year >= 1980, `年份算出来是 ${year}，zip 无法表示`);
});

test('存储：内容寻址 —— 同内容只存一份，不同内容必然不同 id', async () => {
  const store = await freshStore();
  const a = await store.save('resp', '{"a":1}', 's1');
  const b = await store.save('resp', '{"a":1}', 's2');
  const c = await store.save('resp', '{"a":2}', 's2');
  assert.equal(a, b, '同内容同 id，这是内容寻址的定义');
  assert.notEqual(a, c);
  // 磁盘上真的只有一份：内容寻址的"只存一份"必须能在**文件系统**上验，
  // 只看返回 id 相同是不够的 —— 存两遍也返回同样的 id。
  //
  // 注意要**跨所有分片**数：id 前两位决定分片目录，a 与 c 大概率落在不同目录里。
  // 早先这里写的是"在 a 的分片目录里同时能找到 a 和 c"，那是我对分片布局的想象，
  // 不是实现 —— 文件不存在的那个断言红了才发现。
  const shards = await readdir(join(store.rootDir, 'sha'));
  const files: string[] = [];
  for (const d of shards) files.push(...(await readdir(join(store.rootDir, 'sha', d))).map((f) => `${d}/${f}`));
  assert.equal(new Set(files).size, files.length, '磁盘上出现了重复文件');
  assert.equal(files.length, 2, `磁盘上应有 2 个文件（a/b 同内容共享一个），实际 ${files.length}：${files.join(', ')}`);
  assert.ok(files.some((f) => f.endsWith(a)) && files.some((f) => f.endsWith(c)), '两个不同内容各自成文件');
});

test('存储：load 会校验 sha，被人改过的文件不会被当成有效证据', async () => {
  const store = await freshStore();
  const id = await store.save('resp', 'original', 's1');
  await writeFile(join(store.rootDir, 'sha', id.slice(0, 2), id), 'TAMPERED!!');
  await assert.rejects(() => store.load(id), /已被改动或损坏/);
});

test('存储：非 hex 的 id 直接拒（它是文件路径的一部分，不过滤就是路径穿越）', async () => {
  const store = await freshStore();
  for (const bad of ['../../etc/passwd', 'z'.repeat(64), '', 'A'.repeat(64)]) {
    assert.equal(await store.load(bad), undefined, bad);
    assert.equal(await store.exists(bad), false, bad);
  }
});

test('存储：超大证据拒收而不是截断（截断就是伪造证据）', async () => {
  const store = new DiskArtifactStore({ dir: await mkdtemp(join(tmpdir(), 'atest-big-')), maxBytesPerArtifact: 16 });
  await assert.rejects(() => store.save('resp', 'x'.repeat(100), 's1'), /超过单成员上限/);
});

test('存储：找不到返回 undefined 而不是抛（"证据被清理了"是合法状态）', async () => {
  const store = await freshStore();
  assert.equal(await store.load('a'.repeat(64)), undefined);
});

test('同内容存两次只产一条记录（内容寻址去重，重试很常见）', async () => {
  // 原先这条测的是 recordsOf(['s1'])。recordsOf 已删 —— 按 stepId 反查正是
  // "跨场景同名步骤互相染色"的机制本身（步骤 id 只在自己的场景里唯一），
  // 而它**今天能在单场景测试里给出完全正确的答案**，所以留着比删掉更危险。
  // 这里保留的才是真正要守的性质：id 由内容决定，同内容必然同 id。
  const store = await freshStore();
  const a = await store.save('resp', 'same', 's1');
  const b = await store.save('resp', 'same', 's1'); // 重试：同一步骤同内容
  assert.equal(a, b, '同内容不同次必须同 id（否则重试会在磁盘上留两份"证据"）');
  const c = await store.save('screenshot', 'other', 's2');
  assert.notEqual(a, c);
  assert.equal(new Set(store.all().map((r) => r.id)).size, 2, '存储里确实只有两份');
});

// ── trace.jsonl 与脱敏 ────────────────────────────────────────────────────

test('trace.jsonl 每行一个事件，能被逐行读回；最后一行截断可识别', async () => {
  const store = await freshStore();
  const { report } = await failingRun(store);
  const jsonl = toTraceJsonl(report.events);
  assert.equal(jsonl.endsWith('\n'), true);
  const back = parseTraceJsonl(jsonl);
  assert.equal(back.events.length, report.events.length);
  assert.equal(back.invalidLines, 0);
  assert.equal(back.truncatedTail, false);

  // 进程写在半行上被打断：这是 trace 存在的意义（crash 后仍可分析），必须能读回前缀
  const cut = jsonl.slice(0, jsonl.length - 5);
  const partial = parseTraceJsonl(cut);
  assert.equal(partial.truncatedTail, true, '截断必须被显式报出来，否则人会拿少了尾巴的 trace 推断"最后一步没跑"');
  assert.equal(partial.events.length, report.events.length - 1);
});

test('脱敏：字段名命中 -> 整值替换，但长度保留（是排查线索且不泄露内容）', () => {
  const out = JSON.stringify(redactForDisk({ password: 'hunter2supersecret', amount: 3 }));
  assert.ok(!out.includes('hunter2supersecret'));
  assert.match(out, /18 字符/);
  assert.equal((redactForDisk({ amount: 3 }) as { amount: number }).amount, 3, '无辜字段一个字节都不该动');
});

test('脱敏：字段名无辜但值是密钥 -> 照样拦住（只按字段名会漏）', () => {
  const out = JSON.stringify(redactForDisk({ data: JWT, info: `Bearer ${'a'.repeat(40)}` }));
  assert.ok(!out.includes(JWT), '后端把 token 放在 data 字段里极常见');
  assert.ok(!out.includes('a'.repeat(40)));
  assert.match(out, /JWT|Bearer/);
});

test('脱敏：同一份模式在多个字段上都生效（模块级 /g 正则的 lastIndex 陷阱）', () => {
  // 带 /g 的共享正则在 .replace 时会推进 lastIndex：
  // 第二个字段就从中间开始扫 —— 于是"有时脱敏有时不脱敏"，且与字段顺序有关。
  const two = redactForDisk({ a: `t=${JWT}`, b: `t=${JWT}` });
  const s = JSON.stringify(two);
  assert.ok(!s.includes(JWT), s);
  const one = JSON.stringify(redactForDisk({ b: `t=${JWT}` }));
  assert.ok(!one.includes(JWT), '单字段版本也必须拦住（顺序依赖就体现在这里）');
});

test('脱敏：深结构与超长数组有上限（报告生成失败会连累整次运行的证据）', () => {
  let deep: Record<string, unknown> = { v: 'leaf' };
  for (let i = 0; i < 30; i++) deep = { n: deep };
  const s = JSON.stringify(redactForDisk(deep));
  assert.match(s, /已截断/);
  assert.ok(s.length < 5000, `深结构没被限住（${s.length} 字节）`);
  const arr = redactForDisk({ list: Array.from({ length: 500 }, (_, i) => i) }) as { list: unknown[] };
  assert.equal(arr.list.length, 50);
});

test('脱敏：循环引用不会炸（一个 self-ref 就能让整份 trace 变成 TypeError）', () => {
  const o: Record<string, unknown> = { name: 'x' };
  o.self = o;
  assert.doesNotThrow(() => JSON.stringify(redactForDisk(o)));
});

test('被中断的 run：文件名换成 aborted，而 manifest.status **照实留 pass**', async () => {
  /*
   * 这一对断言看起来自相矛盾，而**矛盾本身就是这次修复的内容**：
   *  - status 说"已完成步骤全过"（那是真的，不能改，改了就是伪装成某一步坏了）；
   *  - 文件名说"这份证据出自一次没跑完的 run"（下载别人看不到别的，只看得到这个名字）。
   *
   * 改动前实测是 `evidence.cut1.pass.zip`。那是同一个假绿的第三个消费者
   * （前两个是 summary.txt 首行与 manifest.status），而 CLI 的 e2e 只测得到
   * "传了 true 之后叫什么"，**测不到"没传 true 时不许改状态词"** ——
   * 那是本层的参数语义，所以在本层钉。
   */
  const dir = await mkdtemp(join(tmpdir(), 'atest-abort-'));
  const store = await freshStore();
  const report: RunReport = { ...stubReport(), aborted: { kind: 'timeout', reason: '运行超时（1000ms）' } };
  const pkg = await buildEvidencePackage({ scenario: scen([{ ...b('n'), kind: 'noop' }]), report, store });

  const cut = await writeEvidencePackage(dir, 'r9', 'pass', pkg.bytes, true);
  assert.match(cut.path, /evidence\.r9\.aborted\.zip$/, `被砍断的包不该叫 pass：${cut.path}`);
  // 对照组：没中断时**不许**动状态词（否则 fail 的包也会被抓成 aborted）
  const plain = await writeEvidencePackage(dir, 'r8', 'fail', pkg.bytes);
  assert.match(plain.path, /evidence\.r8\.fail\.zip$/, plain.path);

  const manifest = JSON.parse(new TextDecoder().decode(
    readZipEntries(pkg.bytes).find((e) => e.name === 'manifest.json')!.data,
  ));
  assert.equal(manifest.status, 'pass', 'status 保持已完成步骤的结论（设计，不是遗漏）');
  assert.equal(manifest.aborted.kind, 'timeout', '机器读的是 manifest，中断必须在这一栏里');
  // **没中断时这个键要压根不在**（不是 null / 空对象），与 RunReport.aborted 同一纪律
  const clean = await buildEvidencePackage({ scenario: scen([{ ...b('n'), kind: 'noop' }]), report: stubReport(), store });
  const cleanManifest = JSON.parse(new TextDecoder().decode(
    readZipEntries(clean.bytes).find((e) => e.name === 'manifest.json')!.data,
  ));
  assert.ok(!('aborted' in cleanManifest), `正常包不该带这一栏：${JSON.stringify(cleanManifest.aborted)}`);
  // summary.txt 首行也要说出来（那是唯一一份**只有文字**的产物）
  const summary = new TextDecoder().decode(
    readZipEntries(pkg.bytes).find((e) => e.name === 'summary.txt')!.data,
  );
  assert.match(summary.split('\n')[0]!, /被中断/, summary);
});

// ── run 目录里那几份散装副本，与"从包里读"这条路 ──────────────────────────

/**
 * **手写死的五名**，不从 `EVIDENCE_MEMBERS` 取。
 *
 * 写侧 `writeEvidenceMembers` 的筛子就是 `Set(EVIDENCE_MEMBERS)`，
 * 拿同一个名单去断"它把名单里的都写了"是**用派生验派生**：
 * 名单少一名时两边一起缩，测试永远绿 —— 而那恰好是本次缺陷的形状
 * （少写 manifest.json / summary.txt）。与本文件下面
 * `evidence 缺参数…` 那条写下的是同一条判据。
 */
const LOOSE = ['trace.jsonl', 'junit.xml', 'manifest.json', 'summary.txt', 'report.html'];

/*
 * 这一族测试的存在理由是一次**实测到的 404**，而不是"顺便补个覆盖"。
 *
 * 改前的磁盘布局：run 目录里只有 trace.jsonl / junit.xml / report.html / evidence.*.zip。
 * 而三处消费者读的都是**没写出来的那两样**：
 *   - report.html 正文里是相对链接 ./manifest.json 与 ./summary.txt（点开 404）；
 *   - 服务端的证据白名单五名全放行，多出的两名一直 404；
 *   - GET /api/runs 读 <runId>/manifest.json 来列运行记录 ——
 *     读不到就 continue，于是**运行记录列表一条都列不出**。
 * 三个包的单测当时**各自全绿**：html 测"我写出了这个链接"，
 * server 测"白名单允许这个名字"，cli 测"包里确实有 manifest.json"。
 * 没有一条测"这三件事在同一块磁盘上同时成立"。所以下面的断言全部围绕
 * **磁盘上到底有什么**，而不是"函数返回了什么"。
 */

test('writeEvidenceMembers：五个文档成员全都落盘，artifacts/ 一个都不落', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-loose-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });

  // 夹具自检：这条要断的是"**没有**散装 artifacts"，
  // 而如果这次 run 压根没产证据，它会因为"确实一个都没有"而恒绿。
  const artifactEntries = pkg.entries.filter((e) => e.name.startsWith(`${EVIDENCE_FILES.artifactsDir}/`));
  assert.ok(artifactEntries.length >= 1, '夹具没产出证据，下面那条"不写 artifacts"的断言将没有鉴别力');

  const written = await writeEvidenceMembers(dir, pkg.entries);
  const onDisk = await readdir(dir);
  for (const name of LOOSE) {
    assert.ok(onDisk.includes(name), `${name} 该在 run 目录里（报告里的相对链接与运行记录列表都要读它）：${onDisk.join(', ')}`);
  }
  assert.deepEqual(written.slice().sort(), LOOSE.slice().sort(), '返回值要说清写了哪些，且只写了这些');
  // 反向：EVIDENCE_MEMBERS 与 LOOSE 必须此刻仍相等。两边都是判据的一部分，
  // 而上面那批断言用的是 LOOSE —— 有人在 schema 侧加/删一名时，这条会来对账。
  assert.deepEqual([...EVIDENCE_MEMBERS].sort(), LOOSE.slice().sort(),
    'EVIDENCE_MEMBERS 与本文件那份手写名单对不上：加/删成员要同时改这里（这是有意的两道）');
  for (const a of artifactEntries) {
    assert.ok(!onDisk.includes(a.name), `${a.name} 不该散装再写一份（体积翻倍 + 多一份未脱敏副本）`);
    assert.ok(!onDisk.includes('artifacts'), 'artifacts 目录本身也不该被建出来');
  }
});

test('散装副本与包内成员逐字节相同（只有一个产出者，不是"再渲染一遍"）', async () => {
  /*
   * 这条钉的是这次改动的**机制**而不是结果。改前 CLI 自己调
   * toTraceJsonl/toJUnitXml/toHtmlReport 各算一遍，store 组包时又算一遍；
   * junit 那组参数逐字抄了两遍，所以值恰好相同 —— 于是没有任何测试能看出
   * 它是两份，删掉任一份都不会有东西变红，而参数一改就只改一处。
   * 现在副本直接来自 buildEvidencePackage 交出的 entries，所以"相同"是结构性的，
   * 而这条测试的作用是让"有人把它改回第二次渲染"这件事必须显式地撞墙。
   */
  const dir = await mkdtemp(join(tmpdir(), 'atest-same-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  await writeEvidenceMembers(dir, pkg.entries);
  const inZip = new Map(readZipEntries(pkg.bytes).map((e) => [e.name, Buffer.from(e.data)]));
  for (const name of LOOSE) {
    const loose = readFileSync(join(dir, name));
    const zipped = inZip.get(name);
    assert.ok(zipped, `包里该有 ${name}`);
    assert.equal(loose.equals(zipped), true, `${name} 的散装副本与包内成员必须逐字节相同`);
  }
});

test('readRunMember：散装的优先；artifacts/<sha> 只在包里，也读得出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-readrun-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  await writeEvidenceMembers(dir, pkg.entries);
  await writeEvidencePackage(dir, 'run_x', 'fail', pkg.bytes, Boolean(report.aborted));

  const manifest = await readRunMember(dir, EVIDENCE_FILES.manifest);
  assert.ok(manifest, 'manifest 读不出就等于"这次 run 不存在"');
  assert.match(new TextDecoder().decode(manifest), /"runId"/);

  const artifact = pkg.entries.find((e) => e.name.startsWith(`${EVIDENCE_FILES.artifactsDir}/`))!;
  const fromZip = await readRunMember(dir, artifact.name);
  assert.ok(fromZip, `${artifact.name} 只在包里，readRunMember 必须进包取（report.html 里那个链接靠它）`);
  assert.equal(Buffer.from(fromZip).equals(Buffer.from(artifact.data)), true, '从包里取出的字节必须与写入时相同');
});

test('readRunMember：老布局的 run 目录（散装一样没有、只有 zip）照样读得出全部成员', async () => {
  /*
   * 修的是写侧，但**盘上已经躺着老布局的 run**。那些 run 该照样出现在
   * 运行记录列表里、报告里那个链接该照样点得开，而不是"看起来没跑过"。
   * 这一条就是拿"只有 zip"这个形状喂进去的。
   */
  const dir = await mkdtemp(join(tmpdir(), 'atest-old-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  const w = await writeEvidencePackage(dir, 'run_old', 'fail', pkg.bytes);
  assert.deepEqual(await readdir(dir), [w.path.split('/').pop()], '夹具：目录里只有 zip');

  for (const name of LOOSE) {
    assert.ok(await readRunMember(dir, name), `${name} 只能从包里取，而它必须取得到`);
  }
});

test('readRunMember：白名单外的名字一个都不给，坏包不拖垮整次读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-guard-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  await writeEvidenceMembers(dir, pkg.entries);

  // 这些名字**在磁盘上真实存在**（或被写成存在），判据必须是名单而不是"文件在不在"
  writeFileSync(join(dir, 'env.json'), '{"token":"leak"}');
  writeFileSync(join(dir, 'evidence.run_x.fail.zip'), pkg.bytes);
  for (const bad of ['env.json', 'evidence.run_x.fail.zip', 'artifacts/not-hex', 'artifacts/' + '0'.repeat(63), '../manifest.json', 'sub/manifest.json', '']) {
    assert.equal(await readRunMember(dir, bad), undefined, `${JSON.stringify(bad)} 不该被读出`);
    assert.equal(isEvidenceMember(bad), false, `isEvidenceMember 对 ${JSON.stringify(bad)} 该说否`);
  }
  for (const ok of [...LOOSE, `artifacts/${'a'.repeat(64)}`]) {
    assert.equal(isEvidenceMember(ok), true, `${ok} 该被认作成员`);
  }

  // 坏包：读不出来的那个 zip 不许让整次读取失败，也不许假装读到了。
  // 用**CRC 改坏**的包而不是"随便一堆字节"：实测 `readZipEntries(垃圾)` **不抛**
  // （它按本地头签名循环，第一个 4 字节就对不上，于是当"零个成员"正常返回），
  // 所以垃圾文件走的是"扫过、没找到"那条路，压根进不了 catch —— 上一版这条就是这么假绿的。
  const broken = await mkdtemp(join(tmpdir(), 'atest-broken-'));
  const badPkg = await corruptCrc((await buildEvidencePackage({ scenario, report, store: await freshStore() })).bytes);
  writeFileSync(join(broken, 'evidence.r.bad.zip'), badPkg);
  assert.equal(await readRunMember(broken, EVIDENCE_FILES.manifest), undefined);
});

/**
 * 把一个真包改成**读的时候一定抛**的形状：改首成员本地头里的 CRC 字段（偏移 14）。
 *
 * 必须有这个函数而不是随手 `bytes[0] ^= 0xff`：`readZipEntries` 对不认识的包
 * 是"零成员返回"而不是抛，只有签名正确、CRC 不符的包才走到 `throw`。
 * 而这条判据（"坏包要被 catch 住"）**只有抛了才算被测到** —— 本文件上一版的
 * "坏包"夹具喂的是垃圾字节，于是不管实现写 `continue` 还是 `return`，它都绿。
 * 所以下面这条 assert 是**夹具自检**，不是锦上添花：它红了说明整条测试在测空气。
 */
async function corruptCrc(bytes: Uint8Array): Promise<Uint8Array> {
  const bad = new Uint8Array(bytes);
  // 偏移 14 是本地文件头里的 CRC-32 字段。先量长度：包比这还短说明夹具拿错了东西，
  // 那时继续改下去，改坏的是**别的字节**，测试会以一种和判据无关的方式红。
  if (bad.byteLength < 31) throw new Error(`夹具：包太小（${bad.byteLength} 字节），不像 buildEvidencePackage 的产物`);
  // 走 DataView 而不是 `bad[14] ^= 0xff`：后者在 noUncheckedIndexedAccess 下
  // 是 `number | undefined`，编译不过 —— 与其 cast 掉，不如用它本来就有的类型。
  const view = new DataView(bad.buffer, bad.byteOffset, bad.byteLength);
  view.setUint8(14, view.getUint8(14) ^ 0xff);
  assert.throws(() => readZipEntries(bad), /CRC/, '夹具：这份"坏包"必须真的让读取抛，否则测不到 catch 那一支');
  return bad;
}

test('坏包排在前面时，后面那个好包仍然要读得出（坏一个不等于全死）', async () => {
  /*
   * 上一条只喂了"一个坏包"，于是 `catch { continue }` 与 `catch { return undefined }`
   * **给出同一个答案** —— 变异驱动实测把那句换成 return 之后全仓零红（本轮实测，
   * 变异集 tooling/mutate/evidence-layout.json 的 R3）。"坏包不拖垮整次读取"这句
   * 判据压根没被钉住：它要的**不是**"坏了要说 undefined"，而是"坏了要换下一个"。
   *
   * 形状是实测过的：同一 runId 重跑两次会并排躺着两个包，而其中一个可能被人
   * 拖去一半就断了（下载截断 / 磁盘清理写坏 / 手工编辑过）。
   * 名字刻意让坏的那个**排在前面**（`aaa` < `zzz`，读取按 sort 后的次序遍历）——
   * 反过来的话好包先命中，`return` 与 `continue` 又等价了。
   * 并用 readdir 断言这个次序真的成立：夹具铺错方向，这条就又是一条假绿的测试。
   */
  const dir = await mkdtemp(join(tmpdir(), 'atest-mixed-'));
  const store = await freshStore();
  const { scenario, report } = await failingRun(store);
  const pkg = await buildEvidencePackage({ scenario, report, store });
  writeFileSync(join(dir, 'evidence.aaa.bad.zip'), await corruptCrc(pkg.bytes));
  writeFileSync(join(dir, 'evidence.zzz.fail.zip'), pkg.bytes);
  assert.deepEqual(await readdir(dir), ['evidence.aaa.bad.zip', 'evidence.zzz.fail.zip'],
    '夹具：坏包必须排在好包**前面**，否则测不到 continue 那一支');

  for (const name of LOOSE) {
    assert.ok(await readRunMember(dir, name), `${name} 只能从后面那个好包里取，而它必须取得到`);
  }
});
