/**
 * M6 判据的实现：一次失败 run 产出**可独立打开**的 `evidence.zip`。
 *
 * "可独立打开"是判据里最容易被糊弄过去半句 ——
 * 自己写自己读永远能读通。所以这里的验证走两头（见 test/evidence.test.ts）：
 *  1. 系统 `unzip -t` 与 `unzip -o` 能过，解出来的成员**逐字节**等于写入内容
 *  2. 包里没有密钥（把真密钥喂进去，再从解开的字节里搜它）
 *
 * 包结构（固定，写死在 engine 的 EVIDENCE_FILES 里）：
 * ```
 * trace.jsonl      追加式事件流。进程被 OOM 干掉后唯一还能看的东西
 * junit.xml        CI 门禁读它
 * manifest.json    机器可读清单：证据、指纹、脱敏策略、版本
 * summary.txt      给人看的。CI 日志与 PR 评论直接贴这段
 * report.html      给人排障的那一屏（零脚本、零外部请求，双击能开）
 * artifacts/<id>   内容寻址的证据原件（文件名 = sha256）
 * ```
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVIDENCE_FILES, toJUnitXml, toTraceJsonl, manifestJson, summaryText, toHtmlReport,
  type EvidenceManifest, type JUnitOptions,
} from '@atest/engine';
import type { RunReport } from '@atest/engine';
import type { Scenario } from '@atest/ir';
import { buildZip, readZipEntries, type ZipEntry } from './zip.js';
import type { DiskArtifactStore } from './artifacts.js';
import { irShaOf } from './ir-hash.js';

export interface BuildEvidenceOptions {
  scenario: Scenario;
  report: RunReport;
  store: DiskArtifactStore;
  /**
   * 场景版本 id（P1 版本表的主键）。**`irSha` 不在这里给，由本函数自己算** ——
   * 如果它是个入参，就一定会有某个调用方忘传（然后证据里躺着 undefined），
   * 而这正是本仓反复出现的"字段有、没人填"缺陷类。存储层拿着 scenario，
   * 就自己负责把它算出来，让"证据里必有一版 IR 的指纹"成为无条件性质。
   */
  provenance?: { versionId?: string };
  engineVersion?: string;
  irVersion?: string;
  junit?: JUnitOptions;
}

export interface EvidencePackage {
  bytes: Uint8Array;
  manifest: EvidenceManifest;
  /** 组装时被跳过的证据（存储里已经不存在了）。**必须带出来**：
   *  静默少一个 artifact，人会以为那次运行压根没产证据 */
  missing: string[];
}

/**
 * 组装 evidence.zip。
 *
 * 一个设计选择：**证据从存储读回，不从内存里的 RunReport 猜**。
 * 理由是"包里有的"和"磁盘上有的"必须是同一份东西。
 * 从内存写会出这种事：证据写盘失败但内存里还在，于是包里有内容而磁盘上没有，
 * 三天后按 manifest 去取，取不到 —— 而 manifest 上写着它有。
 * 读回顺便还免费拿到一次 sha256 校验（store.load 里做）。
 */
export async function buildEvidencePackage(o: BuildEvidenceOptions): Promise<EvidencePackage> {
  const { scenario, report, store } = o;
  const enc = new TextEncoder();

  /**
   * 本次 run 产出的证据 id：**从结果里声明的 artifactIds 取，不按 stepId 反查存储**。
   *
   * 原先是 `store.recordsOf(report.results.map(r => r.stepId))`，两个实测后果：
   *  1. **子场景的证据静默消失**。call 步骤自己那份 results 不含子场景的步骤，
   *     于是子里 http 步骤落的响应体既不在 `artifacts/` 里、也不在 `missing` 里 ——
   *     排查的人看到"缺 0 个"，而磁盘上明明有两条。missing 存在的唯一理由就是
   *     "别让少一件东西看起来像什么都没少"，这条路径恰好绕开它。
   *  2. **跨场景的 stepId 串档**。步骤 id 只在自己的场景里唯一（父和子都叫 `c1`
   *     完全合法，实测父步骤的 artifactIds 里躺着 `004851`，而 `recordsOf(['c1'])`
   *     捞出 `004851,3134a2` —— 第二条是子的）。反查会**多报**：把别人的响应体
   *     写进这一步名下，比少报更难发现，因为包里的东西看着都在。
   *
   * 所以改成"谁产出的证据，谁自己带着 id"：artifactIds 是 StepResult 上的字段，
   * 由引擎在落盘那一刻填，天然带对了场景归属。
   * （存储侧那个 `recordsOf(stepIds)` 与它的 stepId 索引已一并删除 —— 它就是这个缺陷的机制，
   * 而且是**进程级**的：同一进程连跑两个场景还会互相捞到对方的东西。理由写在 artifacts.ts 的 all() 上。）
   *
   * 顺序按结果出现次序，id 去重（重试/循环会重复存同一内容，内容寻址下同 id）。
   * 归属取**声明这个 id 的那一步**（同样是为了不串档）；子场景那一步带上场景 id，
   * 因为"哪个步骤"在跨场景之后不再是唯一坐标。
   */
  const wanted = new Map<string, string>();
  const push = (id: string, owner: string): void => { if (!wanted.has(id)) wanted.set(id, owner); };
  for (const r of report.results) for (const id of r.artifactIds) push(id, r.stepId);
  // 子场景的结果只进**证据枚举**，不进 tally / JUnit 计数 / 门禁结论：
  // 一次子场景失败在父侧由 call 步骤带上来（gate.ts 同处有对应注释），
  // "什么算一条用例"这个问题全仓只允许有一个答案。
  // 归属这里带上场景 id，因为"哪个步骤"在跨场景之后不再是唯一坐标。
  for (const c of report.childRuns ?? []) {
    for (const r of c.results) for (const id of r.artifactIds) push(id, `${c.scenario.id}/${r.stepId}`);
  }
  /*
   * **兜底：落过盘但没被任何一步声明的证据**。
   *
   * `ctx.saveArtifact(kind, data, stepId)` 是 adapter 自己调的（adb 截图、UI hierarchy
   * 都从这里走），它**返回 id 而不强制 adapter 把 id 放进 StepResult.artifactIds** ——
   * 忘了放的那个 adapter 不会报错，只会让证据从包里消失。而按 stepId 反查存储
   * 正好"顺手"盖住这个漏（连同一个更坏的串档问题），所以那套做法不能留：
   * 用一个错误的机制去遮蔽另一个错误，两个都修不掉。
   *
   * 这里用**已经存在的事实**兜底：每次落盘都发过一条 artifact.saved 事件
   * （interpreter.ts 的 ctxBase.saveArtifact），事件里的 id 是存储给的真 id。
   * 于是"没声明"不再等于"没有"，而是进包并带 `未归属` 前缀 —— 让人一眼看出
   * 是哪个 adapter 忘了带 id，而不是让人以为那次运行没产证据。
   */
  for (const e of report.events) {
    if (e.kind !== 'artifact.saved') continue;
    const id = (e.data as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || wanted.has(id)) continue;
    push(id, `未归属:${e.stepId ?? '?'}`);
  }

  /**
   * 落盘事件里的元数据（id -> kind/字节）。唯一用途：**文件已经取不到时，
   * 清单里仍然要说得出"这是什么、多大"**。
   * 取不到就不写这两项（字段可选），而不是填 'unknown'/0 ——
   * 0 字节是合法值，会被读成"响应体是空的"，而真相是"文件被清理任务收走了"。
   */
  const meta = new Map<string, { kind: string; bytes: number }>();
  for (const e of report.events) {
    if (e.kind !== 'artifact.saved') continue;
    const d = e.data as { id?: unknown; kind?: unknown; bytes?: unknown } | undefined;
    if (typeof d?.id !== 'string' || typeof d.kind !== 'string') continue;
    if (!meta.has(d.id)) meta.set(d.id, { kind: d.kind, bytes: typeof d.bytes === 'number' ? d.bytes : 0 });
  }

  const missing: string[] = [];
  const declared: EvidenceManifest['artifacts'] = [];
  const members: ZipEntry[] = [];
  for (const [id, owner] of wanted) {
    // 声明过的一律进清单（"这次 run 产出了什么"），装不下的同时进 missing。
    // 二分法不能塌成一份：少了它就等于把"取不到"改写成"没产过"。
    const known = meta.get(id);
    const loaded = await store.load(id);
    if (!loaded) {
      missing.push(id);
      declared.push({ id, kind: known?.kind ?? 'unknown', stepId: owner, ...(known ? { bytes: known.bytes } : {}), sha256: id });
      continue;
    }
    declared.push({ id, kind: loaded.kind, stepId: owner, bytes: loaded.bytes.byteLength, sha256: id });
    members.push({ name: `${EVIDENCE_FILES.artifactsDir}/${id}`, data: loaded.bytes, mtimeMs: report.startedAt });
  }

  const manifest: EvidenceManifest = {
    runId: report.runId,
    status: report.status,
    startedAt: new Date(report.startedAt).toISOString(),
    durMs: report.durMs,
    scenario: {
      id: scenario.id,
      name: scenario.name,
      versionId: o.provenance?.versionId,
      // frozen 原样带出。true/false 之差决定了"这份证据能不能当 CI 门禁依据"，
      // 所以它必须在包里，而不是只在调用方的内存里
      frozen: scenario.frozen,
      // IR 内容指纹。回答的是"这份证据出自哪一版 IR"—— M7 判据里
      // "provenance 缺失就拒绝执行"要能落地，前提是这个值**每次都能算出来且可回溯**。
      // 取 canonicalScenario 而不是原始文件字节：文件里的注释、键顺序、
      // zod 补出来的默认值都不属于 IR 语义，跟着它们算会让人改个缩进就"换了一版"。
      irSha: irShaOf(scenario),
    },
    tally: report.tally,
    costUsd: report.costUsd,
    // 顺序 = 步骤出现次序。**含取不到的那几条**（它们同时进 missing），
    // 所以"清单里有、包里没"是声明与实装的差，不是"没产过"
    artifacts: declared,
    missing,
    // 把策略写进包：拿到包的人要能回答"响应体被改过吗、按什么规则改的"。
    // 没这段，evidence 不能当事故复盘的依据。
    redaction: {
      keyRules: 'applied',
      valueRules: 'applied',
      rawArtifacts: 'unmodified',
      note: '结构化数据（trace/manifest/JUnit）按字段名 + 值形态双规则脱敏；artifacts/ 下的原始体只替换值形态命中的密钥段（JWT/AKIA/sk-/私钥/Bearer），字段名规则不适用于无结构的原始体。keepRawKinds 白名单里的 kind 完全不改。',
    },
    versions: { engine: o.engineVersion ?? '0.0.0', ir: o.irVersion ?? '0.0.0' },
  };

  const junit = toJUnitXml(report, o.junit);
  const trace = toTraceJsonl(report.events);
  const summary = summaryText(report, manifest);
  // 给人看的那一份。参数从 manifest 取而不是从 o 取：manifest 是"这次 run 的对外契约"，
  // 让报告标题与清单里的 frozen/id 从同一个对象出来，就不会出现
  // "清单说未冻结、页面上写着已冻结"这种两处各信一份的分裂
  const html = toHtmlReport(report, {
    suiteId: manifest.scenario.id, scenarioName: manifest.scenario.name,
    frozen: manifest.scenario.frozen, summary: report.summary,
  });

  const entries: ZipEntry[] = [
    // 顺序固定：让同样内容产出同样字节（zip 里成员顺序会影响整体哈希，
    // 而证据包本身也要能被哈希寻址）
    { name: EVIDENCE_FILES.manifest, data: enc.encode(manifestJson(manifest)), mtimeMs: report.startedAt },
    { name: EVIDENCE_FILES.summary, data: enc.encode(summary), mtimeMs: report.startedAt },
    { name: EVIDENCE_FILES.html, data: enc.encode(html), mtimeMs: report.startedAt },
    { name: EVIDENCE_FILES.trace, data: enc.encode(trace), mtimeMs: report.startedAt },
    { name: EVIDENCE_FILES.junit, data: enc.encode(junit), mtimeMs: report.startedAt },
    ...members,
  ];

  return { bytes: buildZip(entries, report.startedAt), manifest, missing };
}

/**
 * 写盘。文件名带 runId 与状态。
 *
 * 返回值里带 sha256：CI 会把它打进日志。这样"我下载的那份是不是构建产出的那份"
 * 有据可对，而不是靠"应该没被中间环节动过"。
 */
export async function writeEvidencePackage(
  dir: string, runId: string, status: string, bytes: Uint8Array,
): Promise<{ path: string; sha256: string }> {
  await mkdir(dir, { recursive: true });
  // runId 会进文件名，而它可能来自外部（API 触发时是请求里的字段）：
  // 不清洗就是一个路径穿越写文件
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'run';
  const path = join(dir, `evidence.${safe}.${status}.zip`);
  await writeFile(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 读一个已存在的证据包里的某个成员（CLI 的 `atest evidence show` 用） */
export async function readEvidenceMember(path: string, name: string): Promise<string> {
  const buf = await readFile(path);
  const entries = readZipEntries(new Uint8Array(buf));
  const found = entries.find((e) => e.name === name);
  // 找不到时把**实际成员列出来**：只说"没有"的话，人先去怀疑包坏了，
  // 而真相通常是成员名记错了
  if (!found) throw new Error(`${path} 里没有 ${name}（现有成员：${entries.map((e) => e.name).join(', ') || '空'}）`);
  return new TextDecoder().decode(found.data);
}

export type { ZipEntry };
