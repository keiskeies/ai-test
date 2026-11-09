#!/usr/bin/env node
/**
 * 变异测试 harness（docs/08 §3 里那条"每条关键断言都要能在实现被改坏时变红"）。
 *
 * 为什么要有这个文件而不是每次手改代码试一遍：这个仓在变异检查上**踩过三次同一类坑**，
 * 而且三次都是"看起来跑了、实际结论是假的"：
 *
 *  1. `execFileSync` 在子进程非零退出时**丢掉 stdout** ——
 *     于是"测试变红了"这件事本身看不见了，一次真的抓到被记成"无法判定"。
 *     这里统一 `stdio: 'pipe'` 且**不管退出码都取 stdout**。
 *  2. 跨包改 `src` 而不重建，`dist` 还是旧的 ——
 *     被改坏的那份代码压根没被执行，一次真的抓到被记成"未被抓到"（最坏的一种：
 *     它会让人给一条其实没被守住的断言补上"已验证"的标记）。
 *     这里在变异前强制 `npm run build`，并且**只有 build 成功才继续**。
 *  3. 锚点里的中文变成 mojibake 时匹配不到，脚本静默"跳过" ——
 *     而**跳过绝不能被读成"未被抓到"**，两种结论意思相反。
 *     这里锚点匹配不到就直接报 `ANCHOR_NOT_FOUND`，并且与"未被抓到"分开统计。
 *
 * 用法：
 *   node tooling/mutate.mjs <spec.json>
 * spec: { "cases": [ { "file", "anchor", "replace", "build"?, "test"?, "expect": "caught|equivalent" } ] }
 *
 * expect=equivalent 的条目期望**不被抓到**（改了行为等价的代码，测试当然还是绿的）。
 * 它们被列出来是为了让"这个变异为什么没红"这件事有个明确记录，
 * 而不是等到下一个人重新怀疑一遍。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * 只在**被直接执行**时跑驱动。
 *
 * 这一句不是风格问题：本文件同时 export classify()，而 tooling/test/mutate.test.mjs
 * 要 import 它。驱动写在模块顶层的话，"跑一个单元测试"会顺带跑完整套变异
 * （几分钟、改文件、还可能因为缺 argv 直接 process.exit(2) 把测试进程带走）。
 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);

/** 跑一条测试。返回 { red, out }。red = 测试变红（这是"抓到了"） */
function runTest(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 });
    return { red: false, out };
  } catch (e) {
    // **关键**：非零退出也要把 stdout 取回来。execFileSync 默认把它丢了，
    // 于是"变红了但红在哪"看不见，只能记成无法判定（本仓踩过）
    return { red: true, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

/**
 * 跨包变异**必须**重建 —— 这一条由代码判定，不接受 spec 里写 `build:false` 关掉。
 *
 * 为什么不能让人手填：`build:false` 是一个"我确认测试直接 import 这份 src"的口头声明，
 * 而本仓刚刚（写这份 harness 的同一天）就被它坑了一次 ——
 * `packages/cli/test/*` import `@atest/adapter-http` 走的是 package `exports`，
 * 也就是 **dist**。手填 build:false 之后，改坏 adapter 的 src、跑 cli 的测试，
 * 全绿，报告说"未被抓到"，而真相是"改的那份压根没被执行"。
 * 这正是三条历史教训里的第 2 条，而它这次是**被一个显式声明触发的**，不是忘了。
 *
 * 所以规则改成机器判的：测试文件与被改文件不同包 -> 一定要 build。
 * 同包时 build 是可选优化（tsx 直接吃 src，省几分钟），可由 spec 关掉。
 */
export function mustBuild({ file, testFile }) {
  const pkgOf = (p) => {
    const m = /^(?:\.\/)?(packages|tooling)\/([^/]+)/.exec(p ?? '');
    return m ? `${m[1]}/${m[2]}` : undefined;
  };
  const a = pkgOf(file);
  const b = pkgOf(testFile);
  // 认不出包名时**保守地建**：少建一次多跑几分钟，误判成"不用建"会产出假结论
  if (!a || !b) return true;
  return a !== b;
}

/**
 * 一次变异的全部判读逻辑。**抽出来是为了能被测试**：
 * 这个 harness 现在产出的是本仓的**结论**（某条断言"已验证能挡住实现被改坏"），
 * 它自己判错的方式与它要防的 bug 一样坏 —— 一条其实没被守住的断言会被标成"已验证"，
 * 而下一个人不会再去怀疑它。所以这里三条历史教训各有一条断言守着（见 tooling/test/mutate.test.mjs）。
 *
 * @param hits   锚点命中次数
 * @param buildFailed 变异后编译是否失败
 * @param testRed     变异后测试是否变红
 * @param expected    'caught' | 'equivalent'
 */
export function classify({ hits, buildFailed = false, testRed = false, expected = 'caught' }) {
  // 教训 3：锚点匹配不到**绝不能**被读成"未被抓到"。两种结论意思相反：
  // 一个是"这条断言挡不住"，一个是"这次什么都没测"
  if (hits === 0) return { verdict: 'ANCHOR_NOT_FOUND', ok: false, conclusive: false };
  // 命中多次而没显式声明 all，会改到别处去，结论同样不成立
  if (hits > 1) return { verdict: 'ANCHOR_AMBIGUOUS', ok: false, conclusive: false };
  // 教训 2（的一部分）：编译不过时测试根本没运行。这**算一种防护**但不是"测试抓到了"，
  // 记成 caught 会高估测试质量，记成 survived 会去补一条本来就多余的测试
  if (buildFailed) return { verdict: 'BUILD_BROKEN', ok: false, conclusive: false };
  const verdict = testRed ? 'caught' : 'survived';
  return { verdict, ok: (expected === 'caught') === testRed, conclusive: true };
}

/** 从测试输出里抓第一条失败。只用于打印，不参与判定 */
function firstFail(out) {
  const m = /(^|\n)\s*(not ok [^\n]+|✗[^\n]+)/.exec(out);
  return (m ? m[0] : '').trim().slice(0, 160);
}

/** 两条互不相干的说明合成一行。空的那条不占位 */
function joinNote(a, b) {
  return [a, b].filter(Boolean).join(' | ');
}

function runDriver(specPath) {
  const spec = JSON.parse(readFileSync(resolve(ROOT, specPath), 'utf8'));
  const results = [];
  // 教训 4（写 harness 当天踩的，比前三条更隐蔽）：**变异过的 dist 会留在机器上**。
  // 每个 case 的 finally 只还原 src，而跨包用例是在"src 已改坏"的状态下跑的 build，
  // 于是跑完 src 干净、dist 还是变异版。后果分两级：
  //  1. **本次运行内**就脏：下一个"同包不用重建"的 case 读的是这份变异 dist，
  //     它的结论与它自己要测的代码无关；
  //  2. 跑完之后：人在终端接着 npm test，绿的红的都与磁盘上的代码无关。
  // 现场表现：一条标了 equivalent 的变异"意外被抓到"，追进去发现是被**上一条**串了。
  // 所以每个重建过的 case 在还原 src 之后**必须再重建一次**（一次 run 两次 build，
  // 这是正确性的代价 —— 省掉它的后果是之后所有结论都与磁盘代码无关）
  for (const c of spec.cases) {
    const path = resolve(ROOT, c.file);
    const original = readFileSync(path, 'utf8');
    const label = c.label ?? `${c.file} :: ${c.anchor.slice(0, 40)}`;

    // 锚点必须**唯一命中**。命中 0 次 = 锚点过期（多半是中文变成了 mojibake，
    // 或者代码被重构走了）；命中多次 = 会改到不该改的地方。两种都不能当结论。
    // 判读一律交给 classify() —— 驱动与判读分不开的话，
    // tooling/test/mutate.test.mjs 测的就是一份没人走的死代码，而结论是这里给的
    const rawHits = original.split(c.anchor).length - 1;
    const hits = c.all && rawHits > 0 ? 1 : rawHits;
    const expected = c.expect ?? 'caught';
    if (hits !== 1) {
      const v = classify({ hits, expected });
      results.push({
        label, ...v, expected,
        note: hits === 0
          ? '锚点匹配不到。这个变异**根本没执行过**，别记成"未被抓到"'
          : `锚点命中 ${hits} 次。加上下文让它唯一，或显式给 all:true`,
      });
      continue;
    }

    writeFileSync(path, original.split(c.anchor).join(c.replace));
    let v;
    let note = '';
    // 跨包与否**由代码判**，spec 里的 build:false 只能省掉同包的这一次重建。
    // 见 mustBuild 的注释：这条规则曾经靠手填，然后当天就产出了一次假结论
    const forced = mustBuild({ file: c.file, testFile: c.testFile });
    const wantsBuild = c.build ?? spec.build !== false;
    const needsBuild = forced || wantsBuild;
    // 强制重建这件事**追加**而不是占住 note 变量：下面抓到失败原因时要覆盖的是
    // "为什么红"，两条信息各说一件事，合成一条就会丢一条
    const forcedNote = forced && !wantsBuild ? 'spec 写了 build:false，但这是跨包变异 -> 已强制重建' : '';
    let built = false;
    let buildFailed = false;
    try {
      if (needsBuild) {
        const b = runTest('npm', ['run', 'build']);
        built = true;
        if (b.red) {
          buildFailed = true;
          v = classify({ hits, buildFailed: true, expected });
          note = `改坏后编译不过。这本身也算一种防护，但不代表测试能抓到：${firstFail(b.out)}`;
        }
      }
      if (!buildFailed) {
        const t = c.test ?? ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--test', c.testFile];
        const r = runTest('node', t);
        v = classify({ hits, testRed: r.red, expected });
        if (r.red) note = firstFail(r.out);
      }
    } finally {
      // 还原 src **并且**把 dist 也恢复成干净版 —— 只还原 src 会留下变异的 dist，
      // 而下一个不重建的 case 读的就是它（教训 4，见 runDriver 头部）
      writeFileSync(path, original);
      if (built) {
        const clean = runTest('npm', ['run', 'build']);
        if (clean.red) {
          console.error(`⚠ ${label}：还原 src 后重建失败。dist 可能仍是变异版，`
            + '后续结论不可信 —— 手动 npm run build 确认成功后再重跑这一批。');
          process.exitCode = 1;
        }
      }
    }

    results.push({ label, ...v, expected, note: joinNote(forcedNote, note) });
  }

  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  let bad = 0;
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    if (!r.ok) bad++;
    console.log(`${mark} ${pad(r.verdict, 16)} ${r.label}`);
    if (r.note) console.log(`    ${r.note}`);
  }
  const caught = results.filter((r) => r.verdict === 'caught').length;
  const survived = results.filter((r) => r.verdict === 'survived').length;
  // 三类"没跑成"合并计数并**单独打印**：它们都没有结论，
  // 混进上面两个数里，要么高估覆盖率、要么误导人去补一条本来就多余的测试
  const inconclusive = results.filter((r) => !r.conclusive).length;
  console.log(`\n抓到 ${caught} / 未抓到 ${survived} / 没跑成 ${inconclusive}（共 ${results.length}）`);
  console.log('注意：「没跑成」里的每一条都**还没有结论** —— 修锚点重跑，别补记成任何一种判定。');
  return bad ? 1 : 0;
}

if (invokedDirectly) {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('用法：node tooling/mutate.mjs <spec.json>');
    process.exit(2);
  }
  process.exit(runDriver(specPath));
}
