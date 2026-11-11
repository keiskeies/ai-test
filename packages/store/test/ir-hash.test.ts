/**
 * `irSha` 的**稳定性前提**守卫。
 *
 * ## 为什么这个文件存在的理由是"一条注释里的一句话"
 *
 * `ir-hash.ts` 的注释写着：改哈希算法会让**历史 irSha 集体失效**。本轮改
 * `deriveTargets` 的 mobile 那一支时（那是哈希的**输入**，不是算法本身，但后果同形：
 * 同一份 IR 换个 sha），登记给的理由正是这句，并要求"那是一次迁移，不是修复"。
 * 本轮把它量了一遍，量到的结论是：**sha 确实会变，但今天没有任何东西会因为它变而坏掉**
 * —— 没有落盘的历史值可比、没有比较两个 sha 的代码、没有按它去重的版本表。
 * 完整四个读数记在 `ir/test/target-sources.test.ts` 里那条 iOS 场景测试的注释上。
 *
 * ## 所以这份文件守的不是"哈希稳不稳"，是**那句理由今天还成不成立**
 *
 * 登记里的前提会烂，而它烂的方式很安静：代码往前走（版本表落地、有人把证据提交进仓库），
 * 注释却还写着"没有历史可漂"，于是下一个人照着它做一次"不需要迁移"的改动，
 * 就真的漂了。**这正是 docs/08 §3 那一族**：一个事实有字段、有测试、却没有会红的载体。
 *
 * ⚠ 下面几条**红了不是故障**，是"这个前提今天不再成立"。每条的失败信息里写着该做什么。
 * 尤其不要为了把它修绿而放宽判据 —— 那等于把守卫改成它自己防的那种东西。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { irShaOf } from '../src/ir-hash.js';
import { canonicalScenario, defineScenario, type Scenario, type ScenarioDraft } from '@atest/ir';

/** 仓库根（本文件在 packages/store/test/ 下） */
const ROOT = join(import.meta.dirname, '../../..');

/*
 * 判据取"**一个真的 sha 值**"，不取"提到过 irSha 这个词"。
 *
 * 这不是收严风格问题，是本轮实测出来的假阳性：第一版 needle 就是 `"irSha"`，
 * 结果它命中了 `packages/ir/test/target-sources.test.ts` —— 那个文件里根本没有 sha，
 * 只有一句**讲着这件事的注释**（「含 `"irSha"` 键的文件」）。
 * 一个会把"讨论这个字段的文档"报成"落盘了这个字段的值"的守卫，
 * 第一次运行就红，而红得没道理 —— 那种守卫三天后会被放宽成恒通过。
 * 所以判据必须要求**值本身**：`"irSha"` 后跟一个 64 位十六进制串。
 * （`irShaOf` 的输出就是 64 位完整十六进制，见下面那条长度测试，两边同一个口径。）
 */
const SHA_VALUE_RE = /"irSha"\s*:\s*"([0-9a-f]{64}|[0-9a-f]{8,})"/;

/** 被 git 跟踪的文件里，有多少个的**内容**里含某个 sha 形状的值。 */
const trackedFilesWithShaValue = (root = ROOT): string[] => trackedFilesMatching(SHA_VALUE_RE, root);

const trackedFilesMatching = (re: RegExp, root = ROOT): string[] => {
  const out = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const hits: string[] = [];
  for (const f of out) {
    let body: string;
    try {
      body = readFileSync(join(root, f), 'utf8');
    } catch {
      continue; // 已删除但索引里还有（本轮遇到过一次：换分支后的残留条目）
    }
    if (re.test(body)) hits.push(f);
  }
  return hits;
};

describe('irSha 稳定性前提：今天没有"历史"可漂（红了 = 前提变了，不是坏了）', () => {
  test('护栏的护栏：这个扫描**能**扫出含 irSha 的文件（否则"0 个"什么都不是说）', () => {
    /*
     * 这一条是整份文件里最重要的一条，而它测的不是被测代码，是**这份文件自己**。
     *
     * 下面那条断言"仓库里没有落盘的 irSha 值"。如果扫描本身是坏的 —— git 报错被吞掉、
     * 路径拼错、 needle 写成 `"irsha"` —— 它会以完全相同的方式通过，
     * 而它通过后给出的结论恰好是那份"不需要迁移"的论证的唯一支柱。
     * **恒通过的护栏比没有护栏更糟**（它让人以为数过了），本仓为这句话写过三处注释，
     * 本轮第一次给自己写的这份也补上：现场造一个真含 irSha 的文件、真提交进一个临时 git 仓，
     * 扫出来必须命中。
     */
    const dir = mkdtempSync(join(tmpdir(), 'irsha-scan-'));
    try {
      const git = (a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      // 一份**真**证据清单的形状：irSha 是 64 位十六进制，不是随手写的字符串
      const manifest = { scenario: { id: 'scn.x', irSha: irShaOf(defineScenario({
        schemaVersion: '1', id: 'scn.x', name: 'x', env: { environmentRef: 'unit' },
        body: [{ id: 'a', kind: 'noop' }],
      } as ScenarioDraft)) } };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      /*
       * 反面对照：**写在磁盘上而没进索引**的文件不该被算进来。
       * 这一半不是凑数 —— 它就是"证据包不在这份统计里"的**机制**：
       * `evidence/` 在 .gitignore 里，所以那些真躺在磁盘上的 manifest 天然不进
       * `git ls-files`，于是"没有落盘而可比的历史值"这句话成立的方式是
       * "**没人把它们纳管**"，而不是"它们不存在"。
       * 顺带纠正本轮我自己写错的一件事：第一版这里注释写的是"没 add 的文件在
       * ls-files 之外"，而判据写成先 add 再比 —— 实测 `git ls-files` 列的是**索引**，
       * `add` 之后（不必 commit）就已经能扫到 —— 所以我那个"反面对照"第一跑就是红的，
       * 而不是静默无效。现在的顺序是：先不 add（扫不到）→ 再 add（扫得到），两个方向各钉一次。
       */
      assert.deepEqual(trackedFilesWithShaValue(dir), [],
        '未进索引的磁盘文件不该被算进来（那会让下面那条变成"永远扫得到"）—— 这正是 evidence/ 目录不被计入的机制');
      git(['add', 'manifest.json']);
      const hit = trackedFilesWithShaValue(dir);
      assert.deepEqual(hit, ['manifest.json'],
        `扫描本身失效了：现场造了一份含 irSha 的已提交文件而它没被扫到。`
        + '下面那条"仓库里没有落盘 irSha"于是变成恒通过 —— 先去修这个扫描');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('仓库里没有任何**落盘而可比**的 irSha 值（没有历史值，就谈不上"漂移"）', () => {
    /*
     * 判据是"被 git 跟踪 且 内容含 `"irSha"` 这个键"。两个限定都必要：
     *  - **被跟踪**：证据包写在 `.gitignore` 的 `evidence/` 里。那些文件今天躺在磁盘上、
     *    明天被删掉，拿它们当"历史"是自欺；反过来也正因此，本轮那次改动
     *    对它们的影响是"新写的证据用新算法"，而不是"旧证据作废"。
     *  - **键**而不是词：`irShaOf(` 这种源码里的函数名要排除，否则这条恒红，
     *    而恒红的守卫三天后就被放宽了。
     */
    const hits = trackedFilesWithShaValue();
    assert.deepEqual(hits, [],
      `这些被跟踪的文件里出现了落盘的 irSha 值：${hits.join('、')}。\n`
      + '  这意味着"历史 irSha"第一次**真的存在**：任何改动 `canonicalScenario` 输入的东西\n'
      + '  （包括 `deriveTargets` 的 mobile 那一支）从此会让同一份 IR 对不上历史值，\n'
      + '  那就是登记里说的那次真迁移 —— 要配套：一份旧→新 sha 的映射，或一次重算。\n'
      + '  做完再来把这条放宽。**别只放宽判据**：那等于把"没有历史"这句前提重新变成假的。');
  });

  test('没有任何代码比较两个 irSha（有比较者，"漂移"才会真的咬人）', () => {
    /*
     * "sha 变了"与"sha 变了所以坏"之间隔着一个**比较者**。本轮 grep 过全仓源码：
     * irSha 只被**写进**清单（`evidence.ts`）与文档，没有任何一处 `===`/`!==` 拿它判过事。
     * 这条把那句 grep 变成一个会红的东西。
     *
     * 判据写法要说清：扫 `irSha` 附近有没有比较运算符，而不是"整个文件里有没有 ==="
     * （后者会在任何一句 `if (x === 1)` 上红，那属于把守卫写得不能活）。
     */
    const srcFiles = execFileSync('git', ['-C', ROOT, 'ls-files', '*/src/*.ts'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    assert.ok(srcFiles.length > 20, `只扫到 ${srcFiles.length} 个源码文件：路径模式变了，这条会恒通过`);
    const comparing: string[] = [];
    for (const f of srcFiles) {
      let body: string;
      try {
        body = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      for (const m of body.matchAll(/irSha[A-Za-z0-9_]*\s*[=!]==?|[=!]==?\s*irSha/g)) {
        const line = body.slice(0, m.index).split('\n').length;
        // 注释里的比较不算（文档会说"两个 irSha 相等才有用"，那是叙述不是代码）
        const lineText = body.split('\n')[line - 1] ?? '';
        if (/^\s*(\*|\/\/)/.test(lineText)) continue;
        comparing.push(`${f}:${line}`);
      }
    }
    assert.deepEqual(comparing, [],
      `这些地方在**比较** irSha：${comparing.join('、')}。\n`
      + '  从此"同一份 IR 算出两个 sha"会有实际后果（比较不通过 = 溯源断链 / 版本表里凭空多个版本）。\n'
      + '  改动 `canonicalScenario` 的输入之前，先给这些比较者想好迁移路径。');
  });

  test('P1 版本表尚未实现（它是那个真正"按 irSha 去重"的消费者，落地那天本条该红）', () => {
    /*
     * `ir-hash.ts` 的注释说 irSha 有**两个**消费者：证据清单（今天有）与
     * "P1 版本表的去重键"（今天没有）。那句话是本轮那次改动能成立的关键一半 ——
     * 有去重表在，"同一份内容两个 sha"就是凭空多出版本；没有，它只是历史读数的口径不同。
     * 所以这一格钉的是"那张表还不存在"。
     *
     * 判据取**建表语句**而不是表名：表可能叫 scenario_version / versions / ir_versions，
     * 而 `CREATE TABLE` 无论叫什么都会出现。反过来源码里提到 `ScenarioVersionMeta`
     * 这个 **IR 类型**是合法的（它在 ir 里定义着），不能当"表实现了"的证据 ——
     * 本轮差点用那个词做判据，那样这条现在就会红，而红得毫无道理。
     */
    const srcFiles = execFileSync('git', ['-C', ROOT, 'ls-files', '*/src/*.ts'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const ddl: string[] = [];
    for (const f of srcFiles) {
      try {
        if (/CREATE\s+TABLE/i.test(readFileSync(join(ROOT, f), 'utf8'))) ddl.push(f);
      } catch {
        /* 忽略读不到的 */
      }
    }
    assert.deepEqual(ddl, [],
      `出现了建表语句：${ddl.join('、')}。\n`
      + '  如果那张表按 irSha 去重或主键是它，那么"改 deriveTargets 不产生迁移"这条前提**作废**：\n'
      + '  请重新量一次（做法见 .scratch/probe-irsha-migration.mts 那四步），\n'
      + '  然后把 `ir/test/target-sources.test.ts` 里那条 iOS 场景测试的注释与 docs/14 §5 那一格一起改掉。');
  });
});

describe('irSha 本身的稳定性（哈希算法那两条自由度，与本轮改动无关但顺手钉住）', () => {
  /*
   * 一份最小可用的合法场景。**必须走 defineScenario**：`canonicalScenario` 规则 0 写着
   * 入参必须是 parseScenario/defineScenario 出来的 Scenario，而它**自己不校验** ——
   * 我第一版直接喂了个字面量对象，那条注释就挂在被测函数头上，而我还是犯了。
   * 走 defineScenario 还有个实际好处：默认值在 parse 期就补好了，
   * 于是"键顺序不影响 sha"测的是真磁盘形状，不是一个 schema 根本不会产出的形状。
   */
  const scen = (extra: Record<string, unknown> = {}): Scenario =>
    defineScenario({
      schemaVersion: '1', id: 'scn.h', name: 'h', frozen: false,
      env: { environmentRef: 'unit' }, body: [{ id: 'a', kind: 'noop' }], ...extra,
    } as ScenarioDraft);

  test('键顺序不影响 sha（重排文件不该产生新版本号）', () => {
    const a = irShaOf(scen());
    const reordered = Object.fromEntries(Object.entries(scen() as Record<string, unknown>).reverse()) as Scenario;
    assert.equal(irShaOf(reordered), a, '键顺序进了哈希 => 换编辑器保存一次就凭空一个版本');
  });

  test('frozen 不进哈希（它是生命周期状态，不是内容）', () => {
    assert.equal(irShaOf(scen({ frozen: true })), irShaOf(scen({ frozen: false })),
      'frozen 进了哈希 => "冻结"这个动作给同一条用例造出第二个 irSha，而版本表按它去重');
  });

  test('输出是完整 64 位十六进制，不截断', () => {
    const sha = irShaOf(scen());
    assert.match(sha, /^[0-9a-f]{64}$/, `${sha}：截断过的 sha 无法与 git blob id 对齐，也撑不起主键`);
  });

  test('canonicalScenario 的输入变了，sha 必变（哈希没被某个字段短路）', () => {
    // 这一条看着平凡，它守的是"哈希真的读了内容"：第一版若写成 sha256(scenario.id)，
    // 上面三条**全都过**（键顺序、frozen、长度都对），而内容改了整个仓库无感。
    const base = canonicalScenario(scen());
    const other = canonicalScenario(scen({ body: [{ id: 'a', kind: 'noop' }, { id: 'b', kind: 'noop' }] }));
    assert.notEqual(base, other, '多了一个步骤而规范串没变 => 哈希没读到 body');
    // 第二组比的是**步骤数**：注意别拿 `body:[一个步骤]` 去比 `scen()` ——
    // scen() 自己就含一个 noop 步骤，那等于自己跟自己比，**这条会恒通过**。
    // 本轮第一次写就是这么错的（它当场红了才暴露，这条断言的价值就在此）。
    assert.notEqual(
      irShaOf(scen({ body: [{ id: 'a', kind: 'noop' }, { id: 'b', kind: 'noop' }] })),
      irShaOf(scen()),
      '步骤数变了而 sha 没变');
    // 再来一个"只有数组顺序不同"的：数组顺序**全是**语义（规则 1），所以必须不同
    assert.notEqual(
      irShaOf(scen({ body: [{ id: 'b', kind: 'noop' }, { id: 'a', kind: 'noop' }] })),
      irShaOf(scen({ body: [{ id: 'a', kind: 'noop' }, { id: 'b', kind: 'noop' }] })),
      '把两个步骤对调而 sha 相同 => 数组顺序被当成无序，那会把步骤顺序从哈希里抹掉');
  });
});
