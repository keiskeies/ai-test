/**
 * 变异 harness 自己的判读逻辑（tooling/mutate.mjs 的 classify）。
 *
 * 为什么一个"开发期工具"需要测试：它现在产出的是**本仓的结论** ——
 * "这条断言在实现被改坏时会变红"。它判错的方式与它要防的 bug 一样坏：
 * 一条其实没被守住的断言被标成"已验证"，而下一个人不会再去怀疑它。
 * 这与 lint-layers 承担的是同一种风险（那个文件的文件头记着同样的理由）。
 *
 * 下面每一条都对应一条**已经真实发生过的**教训，不是设想出来的边界。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classify, crashIn, decideLock, detectResidue, mustBuild, noTestsIn, summaryLine } from '../mutate.mjs';

describe('classify：三种"没跑成"都不许被当成结论', () => {
  test('锚点匹配不到 -> ANCHOR_NOT_FOUND，且**不是**"未被抓到"', async () => {
    // 实际踩过的形态：spec 里的中文锚点变成 mojibake，split 出来命中 0 次，
    // 脚本静默跳过，而人把"跳过"读成"这条断言没被验证到" —— 意思正好相反
    const r = classify({ hits: 0, testRed: false });
    assert.equal(r.verdict, 'ANCHOR_NOT_FOUND');
    assert.equal(r.conclusive, false, '没跑成就不该给出"抓到/未抓到"的任何一种结论');
    assert.equal(r.ok, false, '它必须让整体退出码非零，否则 CI 里的这份报告会一直"看着像跑过了"');
  });

  test('锚点命中多次 -> ANCHOR_AMBIGUOUS（会改到不该改的地方）', async () => {
    const r = classify({ hits: 3, testRed: true });
    assert.equal(r.verdict, 'ANCHOR_AMBIGUOUS');
    assert.equal(r.conclusive, false);
    // 即使测试变红了也不算抓到：改的可能不是被测那一处，
    // 红可能来自编译、来自另一个用例、来自任何别的地方
  });

  test('编译不过 -> BUILD_BROKEN，既不算抓到也不算漏掉', async () => {
    // 记成 caught 会**高估**测试质量（测试根本没运行）；
    // 记成 survived 会让人去补一条本来就多余的测试。两个方向都得挡住
    const r = classify({ hits: 1, buildFailed: true, testRed: false });
    assert.equal(r.verdict, 'BUILD_BROKEN');
    assert.equal(r.conclusive, false);
  });

  test('测试变红 = 抓到；测试仍绿 = 未抓到', async () => {
    assert.equal(classify({ hits: 1, testRed: true }).verdict, 'caught');
    assert.equal(classify({ hits: 1, testRed: false }).verdict, 'survived');
  });

  test('测试一条都没跑 -> NO_TESTS_RAN，不许被读成"未抓到"', async () => {
    /*
     * 触发这个的是**真浏览器测试**：`adapter-web/test/browser.ts` 在找不到 Chrome 时
     * 把每条都变成 `test.skip`，node:test 给的是 `pass 0 / fail 0 / 退出码 0`。
     * 于是 testRed=false，旧判据会记下**「这条断言挡不住」**——
     * 而真相是一条测试都没执行。
     *
     * 这是"看起来跑了、结论其实是假的"那一族的**第四个入口**
     * （锚点没命中 / 编译不过 / 还原没干净 / **压根没跑测试**），
     * 也是四个里最阴的：前三个都在输出里留下显式痕迹，这四个留下的是"全绿"。
     */
    const r = classify({ hits: 1, testRed: false, noTestsRan: true });
    assert.equal(r.verdict, 'NO_TESTS_RAN');
    assert.equal(r.conclusive, false, '进"没跑成"那一档，不进"未抓到"');
    assert.equal(r.ok, false, '也不能算"符合预期"——它连预期都没被检验');
    // 而**正常跑完全绿**时不能误判（否则一次真的抓到会被降级成没结论）
    assert.equal(classify({ hits: 1, testRed: false, noTestsRan: false }).verdict, 'survived');
  });

  test('noTestsIn 只认 pass 0 + fail 0；解析不到就不动原判读', async () => {
    // 全跳过（真浏览器测试在本机没 Chrome 时的真实输出）
    assert.equal(noTestsIn('# tests 7\n# pass 0\n# fail 0\n# skipped 7\n'), true);
    // 正常跑过：不能报"没跑"
    assert.equal(noTestsIn('# tests 7\n# pass 7\n# fail 0\n'), false);
    // **测试文件自身炸了**（import 失败）也是 fail 1，不是"没跑" ——
    // 实测过 node:test 对这种形态给 `# tests 1 / # pass 0 / # fail 1`
    assert.equal(noTestsIn('# tests 1\n# pass 0\n# fail 1\n'), false,
      'import 失败是"跑失败了"，不是"没跑"。判成没跑会把一次真的防护降级成没结论');
    // 换了 reporter / 输出被截断 => 承认判不出，**不动**原判读
    assert.equal(noTestsIn('整体通过，无失败'), false);
    assert.equal(noTestsIn('# pass 3'), false, '只有 pass 行时不动（宁可漏报这个形态）');
  });

  test('期望"不被抓到"的等价变异：绿了才算符合预期，红了要标出来', async () => {
    // 等价变异（行为不变的改写）期望 survived。它**红了**说明测试其实在钉实现细节
    // —— 那是另一种问题，必须可见，否则"等价变异"会被误当成"又抓到一个"
    assert.equal(classify({ hits: 1, testRed: false, expected: 'equivalent' }).ok, true);
    assert.equal(classify({ hits: 1, testRed: true, expected: 'equivalent' }).ok, false);
    // 两种情况的 verdict 仍是事实本身，不被期望改写：报告要能看出实际发生了什么
    assert.equal(classify({ hits: 1, testRed: true, expected: 'equivalent' }).verdict, 'caught');
  });
});

/*
 * crashIn：把"红得没有意义"这件事说出来。
 *
 * 夹具一律照抄**真实 TAP 输出**（本轮那份崩溃日志的形状：每个失败块里有
 * `failureType` / `error` / `code` / `name` 那几行，汇总行是 `# fail 14`），
 * 不自己编形状 —— 这一档的判断完全建立在"哪一行存在"上，夹具写错一个缩进
 * 就等于在测一个不存在的格式（本仓那条"照记忆写 fixture"的老教训）。
 */
describe('crashIn：全是 ReferenceError 的红要提示，混合与纯断言不提示', () => {
  const block = (name, extra = '') => [
    '    not ok 1 - 某个测试标题',
    '      ---',
    '      duration_ms: 33.5',
    "      failureType: 'testCodeFailure'",
    "      error: 'x is not defined'",
    "      code: 'ERR_TEST_FAILURE'",
    `      name: '${name}'`,
    '      stack: |-',
    // 栈里那行**不带行号**：ref-lint 会把 `文件:行` 读成一条会烂掉的引用，
    // 而 crashIn 压根不读 stack —— 它只数 `name:` 那一行与 `# fail N`
    '        lintScenario (/repo/packages/engine/src/lint.ts)',
    extra,
    '      ...',
  ].join('\n');
  const sum = (n) => `# tests 15\n# pass ${15 - n}\n# fail ${n}\n# cancelled 0\n`;

  test('每条红都是 ReferenceError -> crashed（本轮 S2 第一版的真实形状）', () => {
    const out = block('ReferenceError').repeat(14) + sum(14);
    const r = crashIn(out);
    assert.equal(r.crashed, true, '14 条红、14 个 ReferenceError = 被测代码整个崩了，不是判据被抓到');
    assert.equal(r.fails, 14, '条数要说得出：那句提示靠它说"N 条红全是 ReferenceError"');
  });

  test('纯断言红 -> 不提示（否则每条正常变异都带着 ⚠，警告就废了）', () => {
    assert.deepEqual(crashIn(block('AssertionError') + sum(1)), { crashed: false, fails: 1 });
  });

  test('混合形态 -> 不提示。有的红在断言、有的在 ReferenceError，多半是变异真改了行为', () => {
    const out = block('AssertionError') + block('ReferenceError') + sum(2);
    assert.equal(crashIn(out).crashed, false);
  });

  test('全绿 -> 不提示（fails 0 时后面那套计数根本不该参与）', () => {
    assert.deepEqual(crashIn('# tests 15\n# pass 15\n# fail 0\n'), { crashed: false, fails: 0 });
  });

  test('解析不到汇总行 -> 不提示，沿用原判读（与 noTestsIn 同一个"宁可漏报"的方向）', () => {
    assert.deepEqual(crashIn(block('ReferenceError')), { crashed: false, fails: 0 });
    assert.deepEqual(crashIn('整体通过，无失败'), { crashed: false, fails: 0 });
  });

  test('针只扎 name 那一行：测试标题或断言消息里出现 ReferenceError 三个字不算', () => {
    /*
     * 这一条是防"守卫自己漏报/误报"里那个反方向：如果按裸词计数，
     * 一条**断言消息**里写着"应当抛 ReferenceError"的正常红会被判成崩溃，
     * 于是每次真抓到都带着 ⚠ —— 与本文件那条"针扎中文的守卫会把文档当数据"同族。
     */
    const prose = ['    not ok 1 - 坏引用应当抛 ReferenceError',
      "      error: '这里不该出现 ReferenceError 字样'",
      "      name: 'AssertionError'",
      '      ...'].join('\n');
    assert.deepEqual(crashIn(prose + sum(1)), { crashed: false, fails: 1 });
  });

  test('缩进不同（子测试更深一层）也要认', () => {
    const deep = block('ReferenceError').replace(/^    not ok/gm, '        not ok')
      .replace(/^      ---/gm, '        ---').replace(/^      (\w)/gm, '        $1');
    assert.equal(crashIn(deep + sum(1)).crashed, true, 'TAP 的缩进随嵌套深度变，针不能只认一层');
  });

  test('守卫自己也要被验一次：把"每条红都是 ReferenceError"这个判据的方向钉住', () => {
    // 20 条红而只有 19 个 ReferenceError => 至少一条是别的错，不该报
    assert.equal(crashIn(block('ReferenceError').repeat(19) + block('AssertionError') + sum(20)).crashed, false);
    // 恰好相等 => 报（>= 而不是 ===，因为 TAP 的 name 行可能比 fail 少见的场景更少）
    assert.equal(crashIn(block('ReferenceError').repeat(20) + sum(20)).crashed, true);
  });
});

describe('summaryLine：等价对照组不混进「抓到 / 未抓到」', () => {
  /*
   * 这一档是本轮**看着真输出**发现的，不是设想：跑 call-reflux.json 时表上
   * `✓ survived 等价变异：先并孙子层再记自己`（符合预期、退出码 0），
   * 而汇总行写的是「抓到 4 / 未抓到 1 / 没跑成 0」。那个"未抓到 1"就是它 ——
   * 与"真有一条断言挡不住"长得一模一样，而两个数要求的下一步动作相反
   * （前者要去补测试，后者什么都不该做）。
   * 反方向同样错：等价变异红了要是计进「抓到」，汇总就把"有防护力"报给
   * 一件根本没问过防护力的事。
   */
  const row = (verdict, over = {}) => ({ verdict, ok: true, conclusive: true, expected: 'caught', ...over });

  test('等价变异活下来 = 不进「未抓到」，单独计一条', () => {
    const l = summaryLine([
      row('caught'), row('caught'),
      row('survived', { expected: 'equivalent' }),
    ]);
    assert.equal(l, '抓到 2 / 未抓到 0 / 等价 1/1 / 没跑成 0（共 3）', l);
    assert.doesNotMatch(l, /未抓到 [1-9]/, `等价对照组被算进"未抓到"了：${l}`);
  });

  test('真漏掉的那条仍然在「未抓到」里（新分档不许把它一起抹掉）', () => {
    const l = summaryLine([row('caught'), row('survived'), row('survived', { expected: 'equivalent' })]);
    assert.match(l, /未抓到 1/, l);
    assert.match(l, /等价 1\/1/, l);
  });

  test('等价变异红了：不计进「抓到」，而这一档自己标红', () => {
    const l = summaryLine([row('caught'), row('caught', { expected: 'equivalent', ok: false })]);
    assert.equal(l.includes('抓到 1 '), true, `钉实现细节那条被算成防护力了：${l}`);
    assert.match(l, /等价 0\/1/, l);
    assert.match(l, /钉实现细节/, l);
  });

  test('没有等价条目时不出现这一档（不把每份输出都变长）', () => {
    assert.doesNotMatch(summaryLine([row('caught')]), /等价/);
  });

  test('没跑成的条数照旧单独计，且总数含所有条目', () => {
    const l = summaryLine([row('caught'), row('ANCHOR_NOT_FOUND', { ok: false, conclusive: false })]);
    assert.match(l, /抓到 1 /, l);
    assert.match(l, /没跑成 1/, l);
    assert.match(l, /共 2/, l);
  });
});

describe('mustBuild：跨包变异必须重建，且不交给 spec 手填', () => {
  test('测试与实现同包 -> 不必重建（tsx 直接吃 ../src）', async () => {
    assert.equal(mustBuild({ file: 'packages/engine/src/interpreter.ts', testFile: 'packages/engine/test/identity.test.ts' }), false);
    assert.equal(mustBuild({ file: 'packages/cli/src/authcheck.ts', testFile: 'packages/cli/test/authcheck.test.ts' }), false);
  });

  test('跨包 -> 必须重建：测试 import 的是对方的 **dist**', async () => {
    // 这条规则**是这次写 harness 当天踩出来的**：改坏 adapter 的 src、跑 cli 的测试，
    // 全绿，报告说"未被抓到"，真相是"改的那份压根没被执行" ——
    // cli/test 里的 `import '@atest/adapter-http'` 走 package exports，即 dist
    assert.equal(mustBuild({ file: 'packages/adapter-http/src/auth/credentials.ts', testFile: 'packages/cli/test/authcheck.test.ts' }), true);
    assert.equal(mustBuild({ file: 'packages/ir/src/scenario.ts', testFile: 'packages/engine/test/identity.test.ts' }), true);
  });

  test('认不出包名时保守地建（少建一次只多跑几分钟，误判会产出假结论）', async () => {
    assert.equal(mustBuild({ file: 'scratch/x.ts', testFile: 'packages/cli/test/a.test.ts' }), true);
    assert.equal(mustBuild({ file: 'packages/cli/src/a.ts' }), true);
    assert.equal(mustBuild({}), true);
  });
});

describe('decideLock：同一份工作树里不许有两个驱动', () => {
  // 这条规则存在的原因是**我自己在同一个会话里犯了第三次**：一份 spec 放后台跑，
  // 等得久了又在前景跑同一份，于是同一份 spec 给出 12/2 与 14/0 两个结论。
  // 前两次都只写进注释靠人记住，都没记住 —— 所以改成"它跑不起来"。
  const dead = () => false;
  const alive = () => true;

  test('没有锁文件 -> 直接放行', () => {
    assert.deepEqual(decideLock({ existing: null, isAlive: alive, selfPid: 1 }), { ok: true });
  });

  test('别人的进程还活着 -> 拒绝。这是唯一真正的并发', () => {
    const d = decideLock({ existing: { pid: 4242 }, isAlive: alive, selfPid: 1 });
    assert.equal(d.ok, false);
    assert.match(d.reason, /4242/);
    assert.equal(d.stale, undefined, '还在跑的进程不叫"陈旧"，两者的处置动作不一样');
  });

  test(' pid 已不在、且没在施加变异 -> 接管（收尾完成只是锁没删）', () => {
    assert.deepEqual(decideLock({ existing: { pid: 4242 }, isAlive: dead, selfPid: 1 }), { ok: true });
  });

  test('pid 已不在但**死在施加变异的中途** -> 拦住并要求 --force（src 可能还是变异版）', () => {
    const d = decideLock({ existing: { pid: 4242, inFlight: 'packages/cli/src/gate.ts :: 某条' }, isAlive: dead, selfPid: 1 });
    assert.equal(d.ok, false, '这种状态最危险：src 是变异版而 npm test 会全绿');
    assert.equal(d.stale, true, '要标成 stale，好让提示语说清"先还原再 --force"');
    assert.match(d.reason, /变异版|还原/);
  });

  test('锁内容读不出 pid（手写过 / JSON 坏了 / 旧版残留）-> 放行并覆盖', () => {
    // 宁可放行也不做一把永远解不开的锁：不可用的工具不会被人当回事，
    // 最后大家回到"手改代码试一遍"，那正是本文件存在要取代的做法。
    for (const existing of [{ pid: 'abc' }, { pid: -1 }, { pid: Number.NaN }, {}]) {
      assert.equal(decideLock({ existing, isAlive: alive, selfPid: 1 }).ok, true, JSON.stringify(existing));
    }
  });

  test('同 pid 视为自己，不自锁', () => {
    assert.deepEqual(decideLock({ existing: { pid: 7, inFlight: 'x' }, isAlive: alive, selfPid: 7 }), { ok: true });
  });

  test('pid 已不在但锁里留着**残留清单** -> 拦住（与"死在中途"是两种说法）', () => {
    // 上一轮是**正常退出**的，只是收尾核对发现磁盘不干净，于是故意不删锁。
    // 这里要的不是"它死得可疑"那句提示 —— 那种措辞会让人去查进程，
    // 而该做的是 git status。所以单列一条，并断言提示里出现文件本身。
    const d = decideLock({ existing: { pid: 4242, residue: ['packages/engine/src/resolve.ts'] }, isAlive: dead, selfPid: 1 });
    assert.equal(d.ok, false);
    assert.equal(d.stale, true, '与"死在中途"同一档处置：都要显式 --force');
    assert.match(d.reason, /resolve\.ts/, '提示里必须带着要还原哪个文件');
    assert.match(d.reason, /git status/);
  });

  test('残留清单是空数组 -> 接管（空清单不构成危险状态）', () => {
    assert.deepEqual(
      decideLock({ existing: { pid: 4242, residue: [] }, isAlive: dead, selfPid: 1 }),
      { ok: true });
  });

  test('存活判断只走注入的 isAlive —— 测的不能是本机进程表', () => {
    // 断言 decideLock 不碰真实进程：用一个**必然存在**的 pid（自己）配一个恒假的
    // isAlive，如果它偷偷调了 process.kill，这里就会给出"拒绝"而不是"接管"。
    const d = decideLock({ existing: { pid: process.pid }, isAlive: () => false, selfPid: process.pid + 1 });
    assert.equal(d.ok, true);
  });
});

describe('classify：residue 优先于一切判读', () => {
  test('还原核对失败 -> RESIDUE，且**排在锚点判定之前**', async () => {
    // 顺序不是审美问题。残留状态下磁盘里是什么代码都不知道，
    // 此时先报"锚点匹配不到"会把人的注意力引去修 spec，
    // 而真正要看的是"src 里还躺着一份变异版"。所以 residue 必须最先返回。
    const r = classify({ hits: 0, residue: true });
    assert.equal(r.verdict, 'RESIDUE');
    assert.equal(r.conclusive, false);
    assert.equal(r.ok, false);
    // 三个方向都不能被 residue 覆盖成"有结论"
    assert.equal(classify({ hits: 1, testRed: true, residue: true }).verdict, 'RESIDUE', '红也不算抓到');
    assert.equal(classify({ hits: 1, buildFailed: true, residue: true }).verdict, 'RESIDUE');
    assert.equal(classify({ hits: 2, residue: true }).verdict, 'RESIDUE');
  });
});

describe('detectResidue：残留要认得出，正当用法更不许误报', () => {
  // 这道闸门两边的错都贵，而且**方向不对称**：
  //  漏报 -> 整轮结论建立在变异版代码上而看着一切正常（正是它要防的那件事）；
  //  误报 -> 人开始无脑 --force，于是连真该拦的那次也一起放过去了，闸门等于不存在。
  // 所以下面"不许报"的每一条与"要报"的每一条同等重要。
  const anchor = 'if (v === undefined) {';
  const replace = 'if (false && v === undefined) {';
  const clean = 'function f(v) {\n  if (v === undefined) { return []; }\n}\n';
  const mutated = clean.replace(anchor, replace);

  test('磁盘 == 已提交版本 + 这条变异 -> certain（残留的完整指纹）', () => {
    assert.equal(detectResidue({ current: mutated, committed: clean, anchor, replace }), 'certain');
  });

  test('文件与已提交版本无关地干净 -> null。改动本身不是残留的证据', () => {
    // **这一条是整组里最要紧的**：在"我正在改这段代码"的分支上跑变异是最常见的正当用法。
    // 我第一版就是拿"与 HEAD 不一致"当拦截条件，写错了 —— 那种闸门每天被绕好几次，
    // 绕熟了连真正的残留也一并 --force 掉。这里钉的就是"不许退回那一版"。
    const myOwnWork = 'function f(v) {\n  if (v == null) { return []; } // 我刚改的\n}\n';
    assert.equal(detectResidue({ current: myOwnWork, committed: clean, anchor, replace }), null);
  });

  test('已提交内容取不到（未跟踪 / 无 git）-> 不作 certain，也不因此报错', () => {
    // 判不出来就放行，与 decideLock 那条"读不出 pid 就放行"同一个取舍：
    // 一把经常解不开的锁 / 一道经常误拦的闸门，最后都会被人绕过而失效
    assert.equal(detectResidue({ current: mutated, committed: undefined, anchor, replace }), 'suspect');
  });

  test('替换文本在、原锚点没了 -> suspect（残留或 spec 过期，两种都得让人看见）', () => {
    // 真实来源有两种，这里**不假装能区分**：另一种情形在下一条
    assert.equal(detectResidue({ current: mutated, committed: '完全不同的东西\n', anchor, replace }), 'suspect');
  });

  test('spec 过期（那条变异后来成了真实代码）也报 suspect —— 但含义是"去改 spec"', () => {
    // 这条不是误报：条目本身已经失效了（锚点在当前代码里根本不存在），
    // 让它静静留在集里更糟 —— 下一个人跑出来一个 ANCHOR_NOT_FOUND，还得从头怀疑一遍。
    const nowRealCode = mutated; // 有人把这条改法合进了主干
    assert.equal(detectResidue({ current: nowRealCode, committed: nowRealCode, anchor, replace }), 'suspect');
  });

  test('锚点不在已提交版本里时，"逐字节相等"不算残留 —— 那是恒等变换', () => {
    // 我写完 certain 之后自己找出来的洞：spec 过期时锚点在已提交版本里找不到，
    // 而 `split().join()` 找不到匹配时是**恒等变换**，于是
    // `current === 施加后的已提交版本` 对一份谁都没碰过的文件也成立。
    // 不补这个前提的话，只要集里有一条过期条目，每次运行都报残留 ——
    // 一个每次都误报的闸门活不过第二天。
    const obsolete = '已经没有人记得这条锚点从哪来的了\n';
    assert.equal(detectResidue({ current: obsolete, committed: obsolete, anchor, replace }), null);
  });

  test('replace 把 anchor 整段包在里面时，干净文件不许自炸', () => {
    // 很常见的一种变异：锚点只截了条件表达式，替换文本却是"整条 if 头"，
    // 于是 **干净文件里本来就含有 replace**。判据若写成"文件里有 replace 就算残留"，
    // 这类条目每一轮都会把自己拦下，然后人学会 --force —— 这就是误报的真实代价。
    const inner = 'v === undefined';
    const wrap = 'if (v === undefined) { return []; }';
    assert.ok(clean.includes(wrap), '前提：干净文件里确实同时含有 anchor 与 replace');
    assert.equal(detectResidue({ current: clean, committed: clean, anchor: inner, replace: wrap }), null);
  });

  test('anchor 与 replace 完全相同（无变化的条目）-> null，不自触发', () => {
    assert.equal(detectResidue({ current: clean, committed: clean, anchor, replace: anchor }), null);
  });
});

describe('classify：默认值', () => {
  test('hits=1 且未给可选参数时按"期望抓到、测试绿"处理', async () => {
    // 默认值要是反的（默认 testRed=true 或默认期望 equivalent），
    // 整套历史结论都会反过来，而这种错在调用点上完全看不出来
    const r = classify({ hits: 1 });
    assert.equal(r.verdict, 'survived');
    assert.equal(r.ok, false, '默认期望是 caught，所以测试绿 = 不符合预期');
    assert.equal(r.conclusive, true);
  });
});
