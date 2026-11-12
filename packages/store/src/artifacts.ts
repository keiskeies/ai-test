/**
 * M6：内容寻址的证据存储（docs/01 §6：本地磁盘内容寻址 + DB 只存索引/哈希）。
 *
 * **为什么不塞 MySQL**：一个失败 run 的证据是响应体 + 截图 + hierarchy + LLM 原文，
 * 轻松几 MB。塞进 InnoDB 之后，"查这个场景最近 20 次运行"这种查询要和
 * 几百 MB 的 BLOB 抢 buffer pool，而删除旧证据（必然要做）会变成大事务。
 *
 * **为什么不第一天就上 S3**：本地盘 + 内容寻址今天就能跑，
 * 而上对象存储要处理的事（分片、生命周期、内网出口、成本）与测试平台的核心价值无关。
 * 内容寻址的布局让迁移变成"换个目录 + 拷文件"，反过来说就不成立。
 *
 * 文件名 = 内容的 sha256。三条好处都跟"排查"直接有关：
 *  - 同内容只存一份（一个套件里 200 个用例打同一个接口，页面画像是一样的）
 *  - 证据**不可能被就地篡改**而不被发现：路径本身就带着内容的哈希
 *  - 两个 run 产出相同证据时不必存两份，也不必比较
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '@atest/engine';
import { redactArtifactText } from '@atest/engine';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface DiskStoreOptions {
  /** 证据根目录。相对路径按 process.cwd() 解析 —— 由调用方给绝对路径，别指望这里推断 */
  dir: string;
  /**
   * 这些 kind 的文本证据**原文入库、不改一个字节**。
   *
   * 理由：调试签名不一致、编码错乱、gzip 边界这类问题，
   * 只要证据被动过一个字符就永远查不出来。
   * 代价是这些文件里可能有密钥 —— 所以这是个**显式白名单**，
   * 默认空，也就是"默认脱敏"，要原文必须在这里点名。
   */
  keepRawKinds?: string[];
  /** 单成员上限。超出即拒收并说明怎么办，而不是写半个文件进磁盘（docs/05 §4） */
  maxBytesPerArtifact?: number;
}

export interface StoredArtifact {
  id: string;
  kind: string;
  stepId: string;
  bytes: number;
  sha256: string;
  /** 内容是否做过值形态脱敏。清单里必须带，否则"证据没被动过"这句话无法证明 */
  redacted: boolean;
}

export class DiskArtifactStore implements ArtifactStore {
  private readonly dir: string;
  private readonly keepRaw: Set<string>;
  private readonly maxBytes: number;
  /** 本次进程写过哪些。evidence 包组装时按 runId 取，不靠扫目录（扫目录会把别人的 run 扫进来） */
  private readonly written = new Map<string, StoredArtifact>();

  constructor(opts: DiskStoreOptions) {
    if (!opts.dir) throw new Error('DiskArtifactStore 需要显式的 dir（绝对路径）。留空会让证据落到 CWD，而 CI 的 CWD 是随机的');
    this.dir = opts.dir;
    this.keepRaw = new Set(opts.keepRawKinds ?? []);
    this.maxBytes = opts.maxBytesPerArtifact ?? 32 * 1024 * 1024;
  }

  /** 内容寻址路径：sha/ab/sha256hex。分片是为了单目录别放几万个文件（ext4 没问题，但 ls/备份会痛） */
  private pathFor(sha: string): string {
    return join(this.dir, 'sha', sha.slice(0, 2), sha);
  }

  async save(kind: string, data: Uint8Array | string, stepId: string): Promise<string> {
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    if (raw.byteLength > this.maxBytes) {
      // **拒收而不是截断**。截断一个 artifact 是伪造证据：
      // 人会拿一份被剪掉尾巴的响应体去推断"后端没返回这个字段"。
      throw new RangeError(`证据 ${kind} 有 ${raw.byteLength} 字节，超过单成员上限 ${this.maxBytes}。请让 adapter 侧先按 docs/05 §4 截断响应体（并在 trace 里标 truncated），不要在存储层偷偷剪`);
    }
    const keepRaw = this.keepRaw.has(kind);
    // 文本证据走值形态脱敏（JWT/AKIA/sk-/私钥/Bearer）。字段名规则在原始体上无从判断，
    // 也不该判断 —— 把证据改坏之后没人能复现当时发生了什么。
    const bytes = !keepRaw && typeof data === 'string' ? enc.encode(redactArtifactText(data)) : raw;
    const sha = sha256Hex(bytes);
    const path = this.pathFor(sha);
    try {
      await mkdir(join(this.dir, 'sha', sha.slice(0, 2)), { recursive: true });
      // 只在不存在时写：内容寻址下同 sha 必然同内容，重复写是纯浪费。
      // 竞态下两个 run 同时写同一 sha 也安全（写的是同样的字节）。
      await writeFile(path, bytes, { flag: 'wx' }).catch(async (e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      });
    } catch (e) {
      throw new Error(`证据落盘失败（${path}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const rec: StoredArtifact = { id: sha, kind, stepId, bytes: bytes.byteLength, sha256: sha, redacted: !keepRaw && typeof data === 'string' };
    this.written.set(sha, rec);
    return sha;
  }

  async load(id: string): Promise<{ kind: string; bytes: Uint8Array; sha256: string } | undefined> {
    // id 必须是纯 hex：它是**文件路径的一部分**，不过滤就是路径穿越
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    try {
      const bytes = await readFile(this.pathFor(id));
      // 读时校验：磁盘位腐烂、备份恢复不完整、被人手改过，都在这暴露。
      // **不校验就等于宣称"内容寻址保证了一致性"** —— 那是假的保证。
      if (sha256Hex(bytes) !== id) throw new Error(`内容与其 sha256 不符：证据 ${id} 已被改动或损坏`);
      const meta = this.written.get(id);
      return { kind: meta?.kind ?? 'unknown', bytes, sha256: id };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  /**
   * 本次进程写过的全部证据。
   *
   * **没有 recordsOf(stepIds)** —— 它本轮被删，因为它是刚修掉那个缺陷的**机制本身**：
   * 步骤 id 只在自己的场景里唯一，父和子都叫 `c1` 完全合法，于是
   * "按 stepId 反查我写过哪些证据"会把子的响应体记到父那一步名下（实测多捞一条）。
   * 这个索引还是**进程级**的：同一进程连跑两个场景时互相捞到对方的东西。
   *
   * 正确的取法一直是**声明式的**：`StepResult.artifactIds` 由引擎在落盘那一刻填，
   * 天然带对场景归属。留着一个"方便的反查"，下一个人赶时间时一定会去用它 ——
   * 与 `docs/14` §4.7「永不到达的分支不要留」是同一条判据，只是这里到达得了，
   * 所以更危险：它今天能在单场景测试里给出完全正确的答案。
   */
  all(): StoredArtifact[] {
    return [...this.written.values()];
  }

  /** 目录里是否真有这个文件。给"M6 判据：证据能独立打开"用 */
  async exists(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(id)) return false;
    try { return (await stat(this.pathFor(id))).isFile(); } catch { return false; }
  }

  get rootDir(): string { return this.dir; }
}
