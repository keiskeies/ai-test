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
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVIDENCE_FILES, EVIDENCE_MEMBERS, toJUnitXml, toTraceJsonl, manifestJson, summaryText, toHtmlReport,
  evidenceChildrenOf, type EvidenceManifest, type JUnitOptions,
} from '@atest/engine';
import type { RunReport } from '@atest/engine';
import type { EnvFingerprint, Scenario } from '@atest/ir';
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
  /** 执行环境指纹（见 EvidenceManifest.envFingerprint 那条注释）。缺省不写这一栏 */
  envFingerprint?: EnvFingerprint;
}

export interface EvidencePackage {
  bytes: Uint8Array;
  manifest: EvidenceManifest;
  /** 组装时被跳过的证据（存储里已经不存在了）。**必须带出来**：
   *  静默少一个 artifact，人会以为那次运行压根没产证据 */
  missing: string[];
  /**
   * 包里的全部成员（含 `artifacts/`）。带出来的唯一用途是
   * `writeEvidenceMembers()` —— 让 run 目录里那几份**散装副本与包内字节同源**。
   *
   * 为什么要有散装副本、又为什么要同源：`report.html` 的正文里写着
   * 「原件在包内 artifacts/ 下（本页不内嵌）」，而它的链接是**相对路径**
   * （`./manifest.json`、`./summary.txt`）。这份 html 是散装写在 run 目录里的，
   * 于是"双击打开 report.html 就能点到 manifest/summary"是它对读者做的承诺；
   * 服务端那一侧同样按 `EVIDENCE_MEMBERS` 准备了一份白名单，
   * 而 `GET /api/runs` 读的是 `manifest.json`。
   * **三个消费者加一份注释都在说这个布局，只有写侧不这么写** ——
   * 改前实测 run 目录里只有 trace / junit / report / zip 四样，
   * 于是报告里两个链接是坏的、运行记录列表是空的（列不出任何一次 run），
   * 而每一侧的单测都绿：html 测"我写出了这个链接"，server 测"白名单允许这个名字"，
   * cli 测"包里确实有 manifest.json"，**没人测这三件事在同一块磁盘上成立**。
   *
   * 所以副本不许由调用方**再渲染一遍**：改前 CLI 自己调
   * `toTraceJsonl/toJUnitXml/toHtmlReport` 各算一遍，store 组包时又算一遍。
   * junit 那一遍的参数**逐字抄了两遍**（CLI 传给 `buildEvidencePackage` 一份、
   * 自己写盘又传一份），今天值相同 —— 所以没有任何测试能看出它是两份，
   * 而删掉其中一份也不会让任何东西变红。参数一抄，改的人迟早只改一处，
   * 那时"包里的 junit"与"目录里的 junit"就分叉了，而分叉的方向是
   * "CI 读的那份"和"人点开的这份"给的 classname/suiteName 不一样。
   * 现在只有**一个**产出者：这里算出来的 `entries`。
   */
  entries: ZipEntry[];
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
    // 被中断要**原样进清单**。`status` 在这种 run 里仍然是 pass（那是已完成步骤的
    // 结论），而机器读的是 manifest.status —— 少这一栏，库里就是一条 pass 记录。
    ...(report.aborted ? { aborted: report.aborted } : {}),
    startedAt: new Date(report.startedAt).toISOString(),
    durMs: report.durMs,
    scenario: {
      id: scenario.id,
      name: scenario.name,
      /**
       * **没给就不写这个键**，而不是写一个 `undefined` 进去。
       * 与下面 envFingerprint 那条同一个立场，而这里多一层理由：
       * 改动前 `redactForDisk` 会把 undefined 变成字符串 `"undefined"`，
       * 于是"调用方没说版本"在磁盘上长得像"有个版本叫 undefined"。
       * redact 那一头本轮修了，但**这里也照自己的规矩写** —— 两件事各挡一半：
       * redact 修的是"所有走它的产物"（trace / keyContext / JUnit context 都受益），
       * 这里守的是"这一栏的语义不许依赖上游实现正确"。
       *
       * 判据是 `!== undefined` 而不是 `!versionId`：空串是**合法的有值**
       * （与 store 那边 `bytes` 取不到时宁可不写也不写 0 同一条立场 —— 0 和空串都是合法值），
       * 用 falsy 判断会把"版本就叫空串"悄悄说成"没说版本"。
       * 判据在 `packages/cli/test/e2e.test.ts` 的 --version-id 那条（不传时断的是**键不存在**）。
       */
      ...(o.provenance?.versionId !== undefined ? { versionId: o.provenance.versionId } : {}),
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
    /*
     * 环境指纹。**只在调用方给了的时候写**。
     *
     * ⚠ 这句话从前写的是"写一个 undefined 字段与不写，在 JSON 里等价" ——
     * 那句**对裸 `JSON.stringify` 成立、对本文件产出的 manifest 不成立**：
     * manifest 出去前要过 `redactForDisk`（在 `manifestJson` 里），而改动前那一趟把
     * `undefined` 变成字符串 `"undefined"`，于是"没记"在磁盘上变成了"记了一个值"。
     * 本轮在 `redact.ts` 那一头修掉了（判据：脱敏这趟不许改变"有没有"，
     * 见 `packages/engine/test/redact.test.ts`），**但这里的写法照旧保留** ——
     * 不靠上游的语义正确来保住"缺与记了"的区分，是这个区分能活着的前提。
     * 空对象更是另一回事：那会被读成"这次运行没有环境差异"，与"没记环境"是两个结论。
     */
    ...(o.envFingerprint ? { envFingerprint: o.envFingerprint } : {}),
    /*
     * 子场景（call 链）。这一栏的存在理由是"包是给连不上数据库的人看的"：
     * 以前"跑了哪几个子场景、各自几个 pass/fail"只在 JUnit 的 failure **正文文本**
     * 和 report.html 的人读段落里，机器消费者只能 grep 文本。
     *
     * `evidenceChildrenOf` 返回 undefined 时**整栏不写**（不是写 []）：
     * undefined = "这份报告压根没记子运行"，[] = "记了、确实没跑 call"，
     * 门禁与看板对这两件事的动作不同（gate.ts 的 declaresButUnmeasured 就靠它）。
     */
    ...(() => {
      const kids = evidenceChildrenOf(report, irShaOf);
      return kids ? { children: kids } : {};
    })(),
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

  return { bytes: buildZip(entries, report.startedAt), manifest, missing, entries };
}

/**
 * 写盘。文件名带 runId 与状态。
 *
 * 返回值里带 sha256：CI 会把它打进日志。这样"我下载的那份是不是构建产出的那份"
 * 有据可对，而不是靠"应该没被中间环节动过"。
 *
 * **`interrupted` 会把文件名里的状态换成 `aborted`**（本轮加）。
 * 不做的后果是 `evidence.ab1.pass.zip` —— 一个被砍断的 run 在磁盘上、在
 * 文件管理器里、在"把它拖进聊天窗口发给同事"这个动作里都写着 pass。
 * 这是同一个假绿在**第三个消费者**上的形状（前两个是 summary.txt 首行与 manifest.status，
 * 三处读的都是 `report.status`，而它按设计不该变：见 `RunReport.aborted`）。
 *
 * 参数是布尔而不是"让调用方直接传想要的状态串"：那样"这次算不算被中断"这件事
 * 就有两个判法（调用方判一次、写盘再判一次），而迟早只改其中一处。
 * 文件名里的 `aborted` 与清单里的 `aborted` 栏说的是同一件事，
 * 而 `status` 那一栏**照实保留 pass**（见 EvidenceManifest.aborted）。
 */
export async function writeEvidencePackage(
  dir: string, runId: string, status: string, bytes: Uint8Array, interrupted = false,
): Promise<{ path: string; sha256: string }> {
  await mkdir(dir, { recursive: true });
  // runId 会进文件名，而它可能来自外部（API 触发时是请求里的字段）：
  // 不清洗就是一个路径穿越写文件
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'run';
  const path = join(dir, `evidence.${safe}.${interrupted ? 'aborted' : status}.zip`);
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

/**
 * 把包里的**文档成员**散装再写一份到 run 目录。
 *
 * ## 为什么"包里有"不够
 *
 * 三个消费者读的都是磁盘上那一份，不是 zip 里的那一份：
 *  - `report.html` 正文里是**相对链接** `./manifest.json`、`./summary.txt`，
 *    而这份 html 本身就是散装写在 run 目录里的（双击能开是它的判据）；
 *  - 服务端的证据白名单按 `EVIDENCE_MEMBERS` 整份准备（`server/src/files.ts`），
 *    多出来的那两名一直 404；
 *  - `GET /api/runs` 读 `<runId>/manifest.json` 来列运行记录。
 *
 * 改前这三处**同时是坏的**：报告里两个链接点开是 404、运行记录列表**一条都列不出**
 * （`listRuns` 找不到 manifest 就 `continue`，于是"存在但读不出"表现成"不存在"）。
 * 而三个包的单测各自都绿 —— html 测"我写出了这个链接"，server 测"白名单允许这个名字"，
 * cli 测"包里确实有 manifest.json"，没有一条测"这三件事在同一块磁盘上同时成立"。
 *
 * ## 为什么**只**写文档成员，`artifacts/` 不写
 *
 * 不是省事，是两条具体的代价：
 *  1. **体积**。文档成员是 KB 级（本仓一次典型 run 五份合计约 11KB），
 *     而 artifact 是响应体/截图/hierarchy，单件上限 32MB。
 *     再写一份等于把证据盘的占用**翻倍**，而翻倍买不到任何新能力
 *     （包里有原件，`GET /evidence/<runId>/artifacts/<sha>` 直接从包里取）。
 *  2. **多一份未脱敏副本**。落盘的散装文件不在 zip 里，不在"下载给别人"这个动作里，
 *     但**在备份与磁盘清理的视野里**。多复制一份就多一处要考虑"谁读得到它"的地方，
 *     而这一格要的能力是"报告里那个链接点得开"，散装文档成员就够了。
 *
 * 所以判据是成员名**在 `EVIDENCE_MEMBERS` 里**，不是"不含斜杠"——
 * 后者今天恰好等价，但加一个带目录的文档成员就会悄悄写出去。
 * 直接 `mkdir(recursive:true)` 也是同一个立场：不许依赖"顺序上恰好没有"。
 *
 * 名字直接取 `entry.name`。它已经过 `validateName`（写侧拦过 zip slip），
 * 而这里再走一次同一道判据不是重复防御 —— 这个函数的入参是 `ZipEntry[]`，
 * 调用方可以凭空构造一份，而"往 dir 外面写文件"是它唯一能做的坏事。
 */
export async function writeEvidenceMembers(dir: string, entries: readonly ZipEntry[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const docs = new Set<string>(EVIDENCE_MEMBERS);
  const written: string[] = [];
  for (const e of entries) {
    if (!docs.has(e.name)) continue;
    await writeFile(join(dir, e.name), e.data);
    written.push(e.name);
  }
  return written;
}

/** 包内 `artifacts/` 下那一名成员的形状。与 manifest.artifacts[].sha256 同源：内容寻址 id */
const ARTIFACT_MEMBER = /^[0-9a-f]{64}$/;

/**
 * 这个成员名允许被读吗。**从 `EVIDENCE_MEMBERS` 派生，不另抄一份名单**：
 * 抄的那份在本轮加 `report.html` 时就漏过一格（症状是"人不知道能 show 它"，
 * 不报错也不变红）。artifacts 那一支单独判，因为它不是固定名而是内容寻址 id。
 */
export function isEvidenceMember(name: string): boolean {
  if ((EVIDENCE_MEMBERS as readonly string[]).includes(name)) return true;
  const prefix = `${EVIDENCE_FILES.artifactsDir}/`;
  return name.startsWith(prefix) && ARTIFACT_MEMBER.test(name.slice(prefix.length));
}

/**
 * 读一次 run 的某个成员：**先查 run 目录里那份散装的，没有再进证据包**。
 *
 * ## 为什么需要"再进包里"这一支
 *
 * `report.html` 正文里的链接是**相对路径**，而 `artifacts/<sha>` 那一类
 * **刻意不写散装副本**（见 `writeEvidenceMembers`：体积翻倍 + 多一份未脱敏副本）。
 * 于是"报告里那个链接点不开"是写侧的**有意选择**与读侧的"只认磁盘文件"两件事
 * 撞出来的结果 —— 两边各自都合理，合起来是个 404，而两侧的测试都绿。
 * 这里就是那个合起来的地方。
 *
 * 另一个更常见的入口是**老布局的 run**：本轮之前写侧只落四样，
 * manifest/summary 只在包里。那些历史 run 该照样出现在运行记录里，
 * 而不是"看起来没跑过"。
 *
 * ## 两份都在时**散装那份赢**，以及为什么这不是"信了错的那份"
 *
 * 散装副本与包内成员**同源**（都来自 `buildEvidencePackage` 那一次 `entries`），
 * 所以正常情况下两份字节相同，先查哪个都对。不一致只可能是有人**手改过散装那份**。
 *
 * 那时仍然给散装那份，理由不是省事（给包内那份要多解一次包，反而更贵），
 * 而是**同一个目录下必须只有一个答案**：`report.html` 是散装躺在 run 目录里的，
 * 人双击打开它、点 `./manifest.json`，浏览器读的就是磁盘那份散装文件。
 * 服务端如果绕开它去给包内那份，就会出现"双击看到 A、页面里看到 B"——
 * 那种分裂正是本仓这一路在修的东西，不该在读侧再造一个。
 *
 * 至于"手改过的那份还能不能信"：这不是一次读取该回答的问题。
 * 原件的可验证性在包那一边（`unzip -t`、整体 sha256、`atest evidence show`）。
 * `artifacts/<sha>` 那一类还多一层：文件名就是内容哈希，改一个字节连名字都对不上。
 * 文档成员是**固定名**（`manifest.json` 等），本身不带基准 —— 所以"验真"这件事
 * 从头到尾都归包，不归这次读取。
 * 换句话说：**这里给的是"这个目录此刻是什么"，包给的是"那次 run 原本是什么"**，
 * 两个问题各有一个明确的载体，就不需要谁去覆盖谁。
 *
 * 判据因此也**不写成**"散装那份哈希不符就回落到包"：文档成员不带哈希，
 * 要验就得在这里重算一遍 sha 并另存一份基准 —— 为了一个手改磁盘的场景，
 * 引入一个"基准存在哪、谁更新它"的新问题。真要防篡改，用的是包。
 *
 * ## 多个 zip 时为什么"取第一个命中的"是安全的
 *
 * 同一个 run 目录里可能有第二个包：`--run-id` 指定同一个名字重跑一次，
 * 第一次红第二次绿，于是 `evidence.r.fail.zip` 与 `evidence.r.pass.zip` 并排躺着。
 * 挑哪个都不影响字节 —— 成员名是**内容哈希**，同名成员在两个包里必然逐字节相同。
 * 内容寻址把"该信哪个包"这个问题消解掉了，所以这里不需要"最新的那个赢"这种规则。
 *
 * ## 不缓存
 *
 * 每次请求读一遍包（本地磁盘、KB～MB 级）。不在进程里缓存解压结果：
 * 缓存的是**未脱敏的真响应体**，而这是个常驻进程。为了省一次本地读
 * 把证据留在内存里直到进程退出，这笔交易对本仓的纪律来说是反的。
 *
 * 包坏了 / CRC 不符 / 一个包都没有 → `undefined`（读不出，不是"没有"，
 * 但调用方只需要 404；服务端那一侧刻意不发 403，理由在它自己文件里）。
 */
export async function readRunMember(runDir: string, name: string): Promise<Uint8Array | undefined> {
  if (!isEvidenceMember(name)) return undefined;
  try {
    return new Uint8Array(await readFile(join(runDir, name)));
  } catch { /* 散装那份不存在（artifacts/ 那一类就是这样），继续进包里找 */ }
  let names: string[];
  try { names = await readdir(runDir); } catch { return undefined; }
  for (const z of names.filter((n) => n.startsWith('evidence.') && n.endsWith('.zip')).sort()) {
    try {
      const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, z))));
      const hit = entries.find((e) => e.name === name);
      if (hit) return hit.data;
    } catch { continue; }   // 这个包读不出/坏了：换下一个，而不是把整次读取判死
  }
  return undefined;
}

export type { ZipEntry };
