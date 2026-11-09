/**
 * VarSpace 的单元级测试。
 *
 * 在这之前 VarSpace **没有自己的测试文件**，只被解释器间接覆盖 ——
 * 而它是整套变量语义的载体（作用域帧、遮蔽、退帧销毁、分支隔离）。
 * 间接覆盖的代价现在就出现了：`writeLog` 与 `knows` 两个公开成员
 * 在解释器层面**根本没有出口可以观察**，于是"fork 时漏搬写入历史"这种改动
 * 全套测试一个都不会红（变异检查实测如此），而 vars.ts 的注释里还写着
 * 漏搬会让 UI 的「谁改了这个值」缺一半记录 —— 一句没有任何测试背书的话。
 * 所以这一批直接在 VarSpace 上调，不经解释器。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VarSpace } from '../src/index.js';

describe('写入历史（UI 的「谁改了这个值」）', () => {
  /*
   * 这条是 forkBranch 里"writes 各记一份、adoptFrom 搬回主表"这套搬运的**唯一**理由。
   * 没有它，把那两行搬运删掉照样全绿，而注释里那句"UI 会缺一半记录"就是编的。
   */
  test('分支里的写入并进主历史（否则并发用例的溯源缺一半）', () => {
    const v = new VarSpace();
    v.set('a', 1);
    const branch = v.forkBranch('k0');
    branch.set('b', 2);
    branch.set('a', 3);
    v.adoptFrom(branch);
    const names = v.writeLog.map((w) => w.name);
    assert.ok(names.includes('a'), 'parallel 之前的那次写要在');
    assert.ok(names.includes('b'), '分支里那次写也要在 —— 漏搬的话这里少一条');
    // 搬完要清空：否则同一条被并两次，UI 上会出现两条一模一样的记录
    assert.equal(branch.writeLog.length, 0, '分支的历史应当已搬空');
  });

  test('主实例的 writeLog 不会被 fork 出去的一份污染', () => {
    const v = new VarSpace();
    const b1 = v.forkBranch('k0');
    const b2 = v.forkBranch('k1');
    b1.set('x', 1);
    b2.set('y', 2);
    assert.equal(v.writeLog.length, 0, '两支还没合并，主历史不该有东西');
    assert.equal(b1.writeLog.length, 1);
    assert.equal(b2.writeLog.length, 1, '两支各记各的（共享一个数组的话这里会是 2/2）');
  });
});

describe('knows / has 的分工', () => {
  test('has 只看帧，knows 还看 inputs 与 env', () => {
    const v = new VarSpace({ inputs: { fromInput: 1 }, env: { fromEnv: 2 } });
    v.set('fromFrame', 3);
    assert.equal(v.has('fromFrame'), true);
    assert.equal(v.has('fromInput'), false, 'has 不该看见 inputs');
    assert.equal(v.knows('fromInput'), true);
    assert.equal(v.knows('fromEnv'), true);
    assert.equal(v.knows('ghost'), false);
  });

  /*
   * 这两个方法**必须不一样**，且各自被不同的调用点用：
   *  - resolveRef 用 knows（"这个引用到底有没有定义"要看输入与环境）
   *  - adoptFrom 用 has（并行要和顺序同语义，见 vars.ts 的注释）
   * 有人"顺手统一成一个"的话，要么并发丢写、要么 $env.x 报未定义。
   * 这条测试就是让"统一成一个"这件事必须显式改两处判据。
   */
  test('引用 env 变量算已定义（resolveRef 走 knows）', () => {
    const v = new VarSpace({ env: { baseUrl: 'https://t' } });
    const r = v.resolveRef('$.baseUrl');
    assert.equal(r.found, true, 'env 变量在引用侧必须算已定义');
    assert.equal(r.value, 'https://t');
  });
});

describe('forkBranch 的帧继承', () => {
  test('分支继承已有帧（写在 forEach 里的 parallel 看得到迭代项）', () => {
    const v = new VarSpace();
    const depth = v.pushIteration('item', 7, 'idx', 0);
    const branch = v.forkBranch('k0');
    assert.equal(branch.lookup('item'), 7, '裁成只带 global 的话这里读不到迭代项');
    // 分支只在自己的帧里写：外层那一帧不能被它改到
    branch.set('fresh', 'x');
    assert.equal(v.lookup('fresh'), undefined, '分支里新声明的名字在合并前不该被外层看见');
    /*
     * **不**断言"外层 popTo 之后分支里那份应失效"。
     * 我原先写了这条，跑出来是错的：分支复制的是**帧数组**，帧对象按引用带走，
     * 外层 popTo 只改外层自己的数组，碰不到分支那份。
     * 这不是漏洞 —— 解释器里 parallel 一定 await 完所有分支才继续，
     * "外层在分支还在跑时弹帧"这个时序压根不存在，所以我那条断言是在凭空发明需求。
     * 记在这儿是因为：一条**永远不会被触发**的断言比没有断言更糟，
     * 它会让下一个人以为这个时序被考虑过并处理过了。
     */
  });

  test('分支自己的 popTo 伤不到外层帧', () => {
    const v = new VarSpace();
    v.pushIteration('item', 7, undefined, 0);
    const branch = v.forkBranch('k0');
    const inner = branch.pushIteration('innerItem', 1, undefined, 0);
    branch.popTo(inner); // 只回退自己那一层
    assert.equal(branch.lookup('innerItem'), undefined);
    assert.equal(branch.lookup('item'), 7, '把外层压的迭代帧一起弹掉就是原缺陷那个形态');
    assert.equal(v.lookup('item'), 7, '外层自己的栈完全不该动');
  });

  test('根实例永不被自己当成待合并对象', () => {
    const v = new VarSpace();
    v.set('a', 1);
    assert.equal(v.hasLocalWrites(), false, '根实例有变量不等于有"待合并的分支写入"');
  });
});
