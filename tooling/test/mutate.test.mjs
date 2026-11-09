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

import { classify, mustBuild } from '../mutate.mjs';

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

  test('期望"不被抓到"的等价变异：绿了才算符合预期，红了要标出来', async () => {
    // 等价变异（行为不变的改写）期望 survived。它**红了**说明测试其实在钉实现细节
    // —— 那是另一种问题，必须可见，否则"等价变异"会被误当成"又抓到一个"
    assert.equal(classify({ hits: 1, testRed: false, expected: 'equivalent' }).ok, true);
    assert.equal(classify({ hits: 1, testRed: true, expected: 'equivalent' }).ok, false);
    // 两种情况的 verdict 仍是事实本身，不被期望改写：报告要能看出实际发生了什么
    assert.equal(classify({ hits: 1, testRed: true, expected: 'equivalent' }).verdict, 'caught');
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

describe('classify：判读只依赖传入的事实', () => {
  test('hits=1 且未给可选参数时按"期望抓到、测试绿"处理', async () => {
    // 默认值要是反的（默认 testRed=true 或默认期望 equivalent），
    // 整套历史结论都会反过来，而这种错在调用点上完全看不出来
    const r = classify({ hits: 1 });
    assert.equal(r.verdict, 'survived');
    assert.equal(r.ok, false, '默认期望是 caught，所以测试绿 = 不符合预期');
    assert.equal(r.conclusive, true);
  });
});
