#!/usr/bin/env node
/**
 * 变异测试 harness（docs/08 §3 里那条"每条关键断言都要能在实现被改坏时变红"）。
 *
 * 为什么要有这个文件而不是每次手改代码试一遍：这个仓在变异检查上反复踩同一类坑，
 * 共同点全是**"看起来跑了、实际结论是假的"**。全部七条在 docs/14 §4.5 有明细，
 * 这里只列**代码里必须有对应机制**的那几条：
 *
 *  1. `execFileSync` 在子进程非零退出时**丢掉 stdout** ——
 *     于是"测试变红了"这件事本身看不见了，一次真的抓到被记成"无法判定"。
 *     这里统一 `stdio: 'pipe'` 且**不管退出码都取 stdout**。
 *  2. 跨包改 `src` 而不重建，`dist` 还是旧的 ——
 *     被改坏的那份代码压根没被执行，一次真的抓到被记成"未被抓到"（最坏的一种：
 *     它会让人给一条其实没被守住的断言补上"已验证"的标记）。
 *     这里在变异前强制 `npm run build`，并且**只有 build 成功才继续**；
 *     跨包与否由 `mustBuild()` 判，不接受 spec 手填 `build:false`。
 *  3. 锚点里的中文变成 mojibake 时匹配不到，脚本静默"跳过" ——
 *     而**跳过绝不能被读成"未被抓到"**，两种结论意思相反。
 *     这里锚点匹配不到就直接报 `ANCHOR_NOT_FOUND`，并且与"未被抓到"分开统计。
 *  4. 还原了 src 却把**变异过的 dist** 留在机器上 —— 现在每条重建过的 case 还原后再建一次。
 *  5. **同一份工作树里跑两个驱动**：两份驱动改同一份 src/dist，红绿都还是真的红绿，
 *     只是不再回答各自想问的问题（而且污染能**制造 caught**，比制造 survived 更坏）。
 *     这条的教训记过两次、都靠人记住，**第三次还是同一个会话里我自己犯的**，
 *     所以现在由单实例锁挡（见 `decideLock`）。
 *  6. **"还原"这件事以前是相信 finally 的，现在是核对的** —— 每条 case 还原后比对内容指纹，
 *     不一致判 `RESIDUE` 并中止（未跑的条目进表标 `NOT_RUN`）。
 *  7. 上一轮死在中途时，本轮读到的 `original` **本身就是变异版**，于是第 6 条那道核对
 *     永远通过、每轮都自认为干净。开跑前的 `detectResidue()` 就是为这种状态准备的**独立信号**。
 *
 * 用法：
 *   node tooling/mutate.mjs <spec.json> [--force]
 * spec: { "cases": [ { "file", "anchor", "replace", "build"?, "test"?, "expect": "caught|equivalent" } ] }
 *
 * 退出码：0 全部符合预期 / 1 有不符合预期的（含"没跑成"）/ 2 压根没开跑
 * （缺参数、spec 解析失败、锁被占、开跑前发现残留）。**2 不是结论**，别补记成任何一种判定。
 *
 * expect=equivalent 的条目期望**不被抓到**（改了行为等价的代码，测试当然还是绿的）。
 * 它们被列出来是为了让"这个变异为什么没红"这件事有个明确记录，
 * 而不是等到下一个人重新怀疑一遍。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
/**
 * 单实例锁。放仓库里而不是系统临时目录：出事时人能直接 cat 看到现场。
 *
 * `ATEST_MUTATE_LOCK_FILE` 是给 tooling/test/mutate.lock.test.mjs 换到临时路径用的 ——
 * 那些测试要**真的起两个驱动进程**，共用仓库里这把锁的话，测试自己会互相拦，
 * 而且中途崩溃会把一把假锁留在人家工作树里。
 * **别在 CI 里设它**：设了等于这一轮的并发保护不存在（两个驱动会同时改同一份 src）。
 */
const LOCK = process.env.ATEST_MUTATE_LOCK_FILE
  ? resolve(ROOT, process.env.ATEST_MUTATE_LOCK_FILE)
  : resolve(ROOT, 'tooling/.mutate.lock.json');

const isPidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};

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
 * 单实例锁的判据。**抽成纯函数是为了能被测试** —— 真实实现要碰进程表与文件系统，
 * 而"该不该拒绝启动"这个判断本身不该依赖本机当时有哪些 pid。
 *
 * 为什么这条要写在代码里而不是写在注释里：本仓关于"两个 mutate 同时跑"的教训
 * 记过两次，两次都靠人记住，**第三次还是我自己在同一个会话里犯的** ——
 * 我把一份 spec 放后台跑，等得久了又在前景跑同一份，于是同一份 spec 两次给出
 * 12/2 与 14/0 两个结论（docs/14 §6 记的就是它）。靠纪律挡不住的失效，
 * 只能用"它跑不起来"来挡。
 *
 * 两个驱动同时跑会串，不是因为抢 CPU，是因为它们**改同一份 src 与同一份 dist**：
 * A 施加变异 1、build、正在跑测试时，B 把 src 换成变异 2 并重建 ——
 * A 那份测试读到的代码与 A 记录的变异无关。它的红绿都还是真的红绿，
 * 只是**不再回答 A 想问的那个问题**，所以这种污染不会以报错的形式出现。
 * 更坏的方向是**制造 caught**：A 看到红就记"这条断言已验证"，而让它红的可能是 B 的改动
 * —— 文档里于是多了一条永远不会失效的"已验证"。
 *
 * 锁记两样东西：
 *  - pid：进程还在就是有人在跑。不能"锁文件存在就拒绝"—— Ctrl-C / SIGKILL 之后
 *    锁不会自己消失（第 4 条历史教训的同一个形状：靠 finally 收尾的东西在 SIGKILL
 *    下都不作数），那样一次 Ctrl-C 就把这套工具永久锁死了。
 *  - inFlight（当时正施加哪条变异）：**残留检测**。进程死了而 inFlight 还挂着，
 *    说明它死在"src 已被改坏"的状态里，磁盘上现在可能就是变异版代码，
 *    而"npm test 全绿"在这种状态下毫无意义。这种必须要求显式 --force，
 *    不能当作"上次没收尾"顺手接管 —— 顺手接管的下一个结论就是在变异版代码上跑的。
 *
 * @param existing 锁文件里那条记录（不存在时传 null）
 * @param isAlive  (pid) => 进程是否存活（注入同上）
 * @param selfPid  当前进程 pid（同 pid 视为自己）
 * @returns {{ok:boolean, stale?:boolean, reason?:string}}  stale = 上次死在 case 中途
 */
export function decideLock({ existing, isAlive, selfPid }) {
  if (!existing) return { ok: true };
  const pid = Number(existing.pid);
  // 读不出 pid（旧残留 / 人手写过 / JSON 坏了）：**放行并覆盖**。
  // 选放行而不选拦住，与"锁过期"同一理由：一把永远解不开的锁会让这套工具直接不可用，
  // 而不可用的工具不会被人当回事，最后大家回到"手改代码试一遍" —— 那正是本文件要取代的做法。
  if (!Number.isFinite(pid) || pid <= 0) return { ok: true };
  if (pid === selfPid) return { ok: true };
  if (isAlive(pid)) {
    return {
      ok: false,
      reason: `另一个变异驱动正在跑（pid ${pid}${existing.inFlight ? `，正施加：${existing.inFlight}` : ''}）。`
        + '它会与本进程改同一份 src/dist，两边的红绿都不再回答各自想问的问题。',
    };
  }
  if (existing.inFlight) {
    return {
      ok: false, stale: true,
      reason: `上一个驱动（pid ${pid}）已退出，但退出时**正施加着变异**：${existing.inFlight}。\n`
        + '  磁盘上的 src 可能仍是变异版，而"npm test 全绿"在这种状态下毫无意义。\n'
        + '  先按锁里记的文件还原（git diff 看得出来），确认干净后再加 --force 重跑。',
    };
  }
  // 比 inFlight 更强的一个信号：上一轮**跑完了**，但收尾核对发现磁盘上仍有变异版，
  // 于是它故意不删锁（见 releaseLock）。这种状态里"死在中途"那套话不适用 ——
  // 进程是正常退出的，可疑的不是它的死法，而是它留下的现场。所以要单独一条，
  // 而不是复用上面那条：说"上一个驱动已退出但正施加着变异"会把人引去查进程，
  // 而该做的是 git status。
  if (Array.isArray(existing.residue) && existing.residue.length) {
    return {
      ok: false, stale: true,
      reason: `上一个驱动留下的**残留清单还在锁里**：${existing.residue.join('、')}。\n`
        + '  那是上一轮收尾核对判出的"还原没还原干净"，锁没删就是为了把这件事留在现场。\n'
        + '  先 git status 看清并还原这些文件、npm run build；\n'
        + '  确认干净后**删掉锁文件**（那句确认是你的，工具替你确认不了），或加 --force 直接跑。',
    };
  }
  // 进程没了、也没在施加变异 = 收尾完成但锁没删（信号打断在两条 case 之间）：接管
  return { ok: true };
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
 * @param residue     还原核对失败（磁盘上留着变异版）。为真时**不给任何结论**
 */
export function classify({ hits, buildFailed = false, testRed = false, expected = 'caught', residue = false }) {
  // 还原没还原成功这件事**优先于其它一切判读**：磁盘上的代码此刻是未知的，
  // 这一条（以及后面所有条）的红绿都不回答任何问题。放在 hits 之前是有意的 ——
  // 连"锚点匹配不到"都不该是这种状态下给出的信息，那会把人的注意力引去修锚点，
  // 而真正要看的是"src 里还留着一份变异版"。
  if (residue) return { verdict: 'RESIDUE', ok: false, conclusive: false };
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

/** 内容指纹。用于"还原后确认磁盘真的回到原样"，见 runDriver 里的残留检查 */
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** 文件不存在时的统一表示（有些 spec 会指向待新建的文件） */
const shaOf = (p) => (existsSync(p) ? sha(readFileSync(p, 'utf8')) : '<absent>');

/** 跑一轮变异。spec 由调用方解析并做过现场核对 —— 这里只管跑与判读 */
function runDriver(spec) {
  const results = [];
  /** 每个被碰过的文件 -> **本轮开始时**的内容指纹。收尾时拿它做全量核对 */
  const baseline = new Map();
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
    // 记下动手之前的样子，收尾时核对"真的还原了没有"（见下面 finally 之后的残留检查）。
    // 注意这条只回答"**本轮**有没有还原干净"；"这台机器上现在干不干净"是另一个问题，
    // 由开头那道 git 闸门回答 —— 两个都要，缺一个就各漏一半。
    if (!baseline.has(path)) baseline.set(path, sha(original));

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

    // **先记"正在施加哪条"再动手改 src**。顺序很重要：反过来写的话，
    // 驱动恰好死在这两行之间时锁里是干净的，残留就查不出来了 —— 而那段窗口
    // 正是"src 已经是变异版"的窗口。
    markInFlight(`${c.file} :: ${label}`);
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

    // **验证还原，而不是相信 finally**。
    // 这个区别是实打实付过代价的：docs/14 §6 第 3 条那份"同一份 spec 跑出 12/2 与 14/0"，
    // 我当时先怀疑 tsc 增量缓存、又怀疑 mtime，两次都靠猜 —— 猜错的方向是让下一轮读到变异版，
    // 而"下一轮读到变异版"这件事**只有内容比对能发现**。finally 写了不等于写成功了
    // （磁盘满、编辑器/格式化工具恰好在中间写过一次、git 钩子、另一个进程），
    // 而这一次跑完 src 看起来"是原来的样子"这种事没人会去复核。
    const nowSha = shaOf(path);
    if (nowSha !== baseline.get(path)) {
      results.push({
        label, expected,
        ...classify({ hits, expected, residue: true }),
        note: `还原后内容与动手前**不一致**（期望 ${baseline.get(path)}，实际 ${nowSha}）。`
          + 'src 里现在留着一份变异版：本条结论作废，**后面所有条也一并作废**，已停止。',
      });
      // 后面没跑的条目**也要进表**。不这么做的话，一份 14 条的集子在第 3 条炸掉后表上只有 3 行，
      // 而"3 行、跑完了"与"14 条、跑了 3 条"在扫一眼时长得一样 ——
      // 正是本文件存在要消灭的那类误读。它们计进"没跑成"，因此退出码必然非零。
      const idx = spec.cases.indexOf(c);
      for (const rest of spec.cases.slice(idx + 1)) {
        results.push({
          label: rest.label ?? `${rest.file} :: ${(rest.anchor ?? '').slice(0, 40)}`,
          expected: rest.expect ?? 'caught',
          verdict: 'NOT_RUN', ok: false, conclusive: false,
          note: '前面的变异还原失败，本轮已中止 —— 这条**根本没跑**，别记成任何一种判定',
        });
      }
      console.error(`\n✗ ${label}：还原核对失败，src 仍是变异版。已中止剩余变异。`);
      console.error('  立刻 `git diff` 确认现场，必要时 `git checkout -- <文件>` 还原后再重跑。');
      break;
    }

    // 到这儿才叫"这条 case 还原干净"（src 已核对，dist 在上面的 finally 里重建过），
    // 清掉 in-flight 标记 —— 于是"锁还在但没有 in-flight"才唯一地表示
    // "死在两条 case 之间"，那种状态下 src 是干净的，可以直接接管。
    // （核对失败时**故意不清**：那是"死前正留着变异"的同一种危险状态，锁要说实话。）
    markInFlight(null);
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

  // 收尾**全量**核对，放在表格**之后**（先前放在之前，结果就是"报了残留、但没人看到那轮跑了什么"）。
  // 每条 case 后已经各自核对过了，这里看着像重复，但它管两种单条核对看不见的情形：
  //  (1) 上面 break 出去时"现在磁盘到底干净没有"要单独说清 —— 否则人只知道"有一条失败"，
  //      不知道现场要不要救；
  //  (2) 核对**之后**又被改动的东西：编辑器格式化、git 钩子、后台挂着的 tsc -w，
  //      或者我自己在前景手改了一处。只有"最后再全量比一次"能看见这一类。
  const stillDirty = [...baseline.entries()].filter(([p, h]) => shaOf(p) !== h);
  if (stillDirty.length) {
    console.error(`\n✗✗ 收尾核对：${stillDirty.length} 个文件与本轮开始时不一致`);
    for (const [p, h] of stillDirty) console.error(`   ${relative(ROOT, p)}（期望 ${h}，实际 ${shaOf(p)}）`);
    console.error('   这些文件里现在留着变异版代码。此刻这台机器上跑出来的任何测试结果都不可信：');
    console.error('   先 `git checkout -- <文件>` 还原并 npm run build，再谈本轮的结论。');
    // 不看 bad 而直接给 1：现场不干净时**任何**汇总数字都没有意义，
    // 而"表格里有 ✓ 就退出 0"会让 CI 在残留状态下报绿 —— 那是这里最不能出现的组合。
    // 同时把残留清单交回调用方，让锁**保留**这条记录（见 releaseLock）。
    return { code: 1, dirty: stillDirty.map(([p]) => relative(ROOT, p)) };
  }
  return { code: bad ? 1 : 0 };
}

/**
 * 开跑前找"**上一轮留下的变异正躺在磁盘上**"的证据。判定抽成纯函数是为了能测：
 * 这里误报与漏报都贵 —— 误报会让人养成 --force 的习惯（那等于这道闸门不存在），
 * 漏报则让整轮结论建立在变异版代码上而**看起来一切正常**。
 *
 * 为什么需要它，而不是只做每条 case 后的还原核对：
 * 每条核对是"还原成我读到的那份 original"，而上一轮死在施加变异的中途时，
 * 本轮 `readFileSync` 读进来的 `original` **本身就已经是变异版** ——
 * 于是核对永远通过、每一轮都自认为干净，全部结论却是在变异版代码上跑出来的。
 * 这种状态里 src 看着"就是原来的样子"，没有任何一处会报错，必须换一个**独立信号**来判。
 *
 * 两个信号，强度不同：
 *  - **certain**：磁盘内容 == "把这条变异施加到已提交版本上"的逐字节结果。
 *    这是残留的完整指纹，别的东西长不出来。
 *  - **suspect**：`replace` 文本在文件里而 `anchor` 不见了。这个形态有两种来源 ——
 *    残留，**或者**这条变异后来变成了真实代码（spec 过期）。所以它一样拦下来，
 *    但提示语必须把两种可能都写出来（写成"这只能是残留"是我第一版的错）：
 *    后者要修的是 spec，不是还原。
 *
 * 刻意**不用**"文件与 git HEAD 不一致"当拦截条件（我也先写过这一版，写错）：
 * "我正在改这段代码，所以要给新写的测试跑一轮变异"是**最常见**的正当用法，
 * 一道把这种也拦住的闸门每天要被绕三五次，绕熟了连真该拦的也一并 --force 掉。
 * 对"与 HEAD 不一致"只打印一句提示，让"结论建立在未提交改动之上"这件事可见即可。
 *
 * @param committed 该文件在 git 里的已提交内容；取不到时传 undefined（跳过 certain 判定）
 * @returns 'certain' | 'suspect' | null
 */
export function detectResidue({ current, committed, anchor, replace }) {
  // replace === anchor 的条目是一条**空变异**：施加它什么都不改，
  // 于是"current == 施加后的已提交版本"对任何干净文件都成立。它不能当残留的证据。
  // （这种条目本身是 spec 写错了 —— 一条永远"未被抓到"的条目，该删；但那是 spec 的事，
  //  不在这里报，避免把两件事混进同一个信号里。）
  if (anchor === replace) return null;
  // `includes(anchor)` 这个前提同样不是装饰：锚点在已提交版本里根本不存在时（spec 过期），
  // `split().join()` 是**恒等变换**，于是"current === 施加后的已提交版本"对一份
  // 原封未动的干净文件也成立 —— 指纹会到处命中，每次运行都报残留，闸门立刻失效。
  if (committed !== undefined && committed.includes(anchor) && current === committed.split(anchor).join(replace)) {
    return 'certain';
  }
  if (current.includes(replace) && !current.includes(anchor)) return 'suspect';
  return null;
}

/** 把 detectResidue 的判定落到真实文件与 git 上，并把话说给人听。 */
function preflightResidue(spec) {
  const certain = [];
  const suspect = [];
  const vsHead = [];
  for (const c of spec.cases ?? []) {
    if (!c.file || c.anchor === undefined || c.replace === undefined) continue;
    const p = resolve(ROOT, c.file);
    if (!existsSync(p)) continue;
    const cur = readFileSync(p, 'utf8');
    const label = `${c.file} —— ${c.label ?? c.anchor.slice(0, 40)}`;
    const head = committedOf(c.file);
    const kind = detectResidue({ current: cur, committed: head, anchor: c.anchor, replace: c.replace });
    if (kind === 'certain') certain.push(label);
    if (kind === 'suspect') suspect.push(label);
    if (head !== undefined && sha(cur) !== sha(head)) vsHead.push(c.file);
  }
  if (vsHead.length) {
    // 措辞刻意留出"也可能就是下面那几处残留"：残留文件本来就同时满足"与 HEAD 不同"，
    // 一句"你有未提交的改动"会让人以为是自己忘了提交，然后去翻自己的 diff ——
    // 而真相是上一轮没还原。两种情况要分开说，不然第一条会把人带偏。
    console.log(`· 提示：本轮要碰的文件有 ${new Set(vsHead).size} 个与 git 已提交内容不同 —— `
      + '要么是你正在改的代码（那本轮结论只对"这些改动之上的行为"成立，改动还原后不自动迁移），'
      + '要么就是下面列出的残留本身。');
  }
  if (!certain.length && !suspect.length) return true;
  console.error('✗ 开跑前核对：磁盘上像是**留着没还原的变异**。');
  for (const l of certain) console.error(`   [确凿] ${l}（文件逐字节等于"已提交版本 + 这条变异"）`);
  for (const l of new Set(suspect)) if (!certain.includes(l)) console.error(`   [可疑] ${l}（替换文本在、原锚点没了）`);
  console.error('  要么先 `git checkout -- <文件>` 再 npm run build 然后重跑；');
  console.error('  要么这条变异其实已经是真实代码 —— 那是 **spec 过期**，去改锚点或删掉这条，别让它留在集里；');
  console.error('  两者都不是、你确认现场没问题：加 --force。');
  return false;
}

/** git 里这个文件的已提交内容；取不到（未跟踪 / 无 git / 无仓库）时返回 undefined，不参与比较 */
function committedOf(file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return undefined;
  }
}

/** 读锁。JSON 坏了当成"有锁但读不出 pid"，交给 decideLock 按陈旧处理。 */
function readLock() {
  if (!existsSync(LOCK)) return null;
  try { return JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return { pid: Number.NaN }; }
}

function writeLock(extra) {
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...extra }));
}

/** 占锁。true = 可以开跑。拒绝时**保留锁**（覆盖掉别人的锁等于把并发问题藏起来）。 */
function acquireLock(forceOverride) {
  const d = decideLock({ existing: readLock(), isAlive: isPidAlive, selfPid: process.pid });
  if (d.ok || forceOverride) {
    if (!d.ok) console.error(`⚠ 已用 --force 忽略锁：${d.reason}`);
    writeLock();
    return true;
  }
  console.error(`✗ ${d.reason}`);
  if (d.stale) console.error('  确认现场已还原后，可加 --force 覆盖。');
  return false;
}

/** 记"正在施加哪条变异"。传 null = 当前没有在施加。锁不是我的时不动它。 */
function markInFlight(label) {
  const cur = readLock();
  if (!cur || Number(cur.pid) !== process.pid) return;
  if (label === null) { writeLock(); return; }
  writeLock({ inFlight: label });
}

/**
 * 收尾。dirtyFiles 非空 = **本轮跑完时磁盘上仍有变异版**。
 *
 * 这种情况下**不删锁**，而是把残留清单留在锁里。理由不是"留个纪念"：
 * 删掉锁就等于销毁证据 —— 下一次运行只剩"磁盘指纹"这一条线索（preflightResidue 能兜住），
 * 而锁里那句 inFlight 会跟着一起消失，人看不到"是哪一条、什么时候留下的"。
 * 与 decideLock 里"死在施加变异中途"那条是同一个原则：**锁要说实话，哪怕说难听话**。
 */
function releaseLock(dirtyFiles = []) {
  const cur = readLock();
  // 只动自己的锁：--force 之后两边都在跑时，后结束的那个不该把前者的锁删掉
  if (!cur || Number(cur.pid) !== process.pid) return;
  if (dirtyFiles.length) {
    writeLock({ residue: dirtyFiles, inFlight: undefined });
    console.error(`· 锁已保留（tooling/.mutate.lock.json），里面记着残留文件清单。`
      + '还原现场后删掉它，或直接 npm run build 前先看一眼 git status。');
    return;
  }
  try { rmSync(LOCK); } catch { /* 已没了就算 */ }
}

if (invokedDirectly) {
  // 位置参数与开关分开取。原来直接读 argv[2]，加了开关之后再这么读就会把
  // `--force` 当成 spec 文件名去打开 —— 那会得到一个 JSON parse 错误，
  // 而错误信息里根本不会提到开关，看的人会去检查自己的 json。
  const argv = process.argv.slice(2);
  const forceOverride = argv.includes('--force');
  const specPath = argv.find((a) => !a.startsWith('--'));
  if (!specPath) {
    console.error('用法：node tooling/mutate.mjs <spec.json> [--force]');
    process.exit(2);
  }
  if (!acquireLock(forceOverride)) process.exit(2);
  // spec 在开跑**之前**解析并核对现场。放在 runDriver 里不行：那时候已经太晚，
  // 而解析失败也要能走 releaseLock —— 否则一次 JSON 打错字就在仓库里留下一把别人的锁，
  // 下一个人会看到"另一个驱动正在跑"去找一个压根不存在的进程。
  let code;
  let dirtyFiles = [];
  try {
    const spec = JSON.parse(readFileSync(resolve(ROOT, specPath), 'utf8'));
    // **顺序**：先拿锁再做现场核对。反过来写的话，核对失败退出时锁没被占，
    // 而核对通过到真正开跑之间有一段无人看守的窗口，那段窗口里第二个驱动能挤进来。
    if (!preflightResidue(spec) && !forceOverride) code = 2;
    else {
      const out = runDriver(spec);
      code = out.code;
      dirtyFiles = out.dirty ?? [];
    }
  } catch (e) {
    console.error(`✗ ${specPath}：${e && e.message ? e.message : e}`);
    code = 2;
  }
  // **不能写成 try { process.exit(runDriver(...)) } finally { releaseLock() }**：
  // process.exit() 是就地终止进程，不做 JS 层的展开，finally 根本不会执行 ——
  // 那样锁只在异常路径下被清，正常跑完反而永远留着（我第一次就是这么写的）。
  releaseLock(dirtyFiles);
  process.exit(code);
}
