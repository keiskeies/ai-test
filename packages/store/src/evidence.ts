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
 * artifacts/<id>   内容寻址的证据原件（文件名 = sha256）
 * ```
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVIDENCE_FILES, toJUnitXml, toTraceJsonl, manifestJson, summaryText,
  type EvidenceManifest, type JUnitOptions,
} from '@atest/engine';
import type { RunReport } from '@atest/engine';
import type { Scenario } from '@atest/ir';
import { buildZip, readZipEntries, type ZipEntry } from './zip.js';
import { DiskArtifactStore } from './artifacts.js';

export interface BuildEvidenceOptions {
  scenario: Scenario;
  report: RunReport;
  store: DiskArtifactStore;
  /** 场景版本 id 与 IR 哈希。缺 provenance 时 CI 要拒绝执行（M7），这里如实记缺失而不是编一个 */
  provenance?: { versionId?: string; irSha?: string };
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

  const stepIds = report.results.map((r) => r.stepId);
  const records = store.recordsOf(stepIds);
  const missing: string[] = [];

  const members: ZipEntry[] = [];
  for (const r of records) {
    const loaded = await store.load(r.id);
    if (!loaded) { missing.push(r.id); continue; }
    members.push({ name: `${EVIDENCE_FILES.artifactsDir}/${r.id}`, data: loaded.bytes, mtimeMs: report.startedAt });
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
      irSha: o.provenance?.irSha,
    },
    tally: report.tally,
    costUsd: report.costUsd,
    artifacts: records.map((r) => ({ id: r.id, kind: r.kind, stepId: r.stepId, bytes: r.bytes, sha256: r.sha256 })),
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

  const entries: ZipEntry[] = [
    // 顺序固定：让同样内容产出同样字节（zip 里成员顺序会影响整体哈希，
    // 而证据包本身也要能被哈希寻址）
    { name: EVIDENCE_FILES.manifest, data: enc.encode(manifestJson(manifest)), mtimeMs: report.startedAt },
    { name: EVIDENCE_FILES.summary, data: enc.encode(summary), mtimeMs: report.startedAt },
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
