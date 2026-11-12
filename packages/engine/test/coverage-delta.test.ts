/**
 * `coverageDelta` —— "这批生成的用例新增了哪些 `operationId × strategy` 组合"。
 *
 * ## 为什么给一个零生产调用方的函数写测试
 *
 * 它今天**没人调**（函数头上那句说的就是这件事），所以这些是"实现落地前先把判据钉住"，
 * 不是回归守卫 —— 两种测试的价值不同，说清比让下一个人以为这里已经接通了强。
 *
 * 值得花这一格的理由在失效方向上：docs/00 §6.1 把覆盖增量预览列成抑制过度生成的
 * **唯一有效手段**，而它的产物只有一个数 `newCombinations`；docs/02 §5 给的用法是
 * "增量为 0 就提示合并/别生成"。**少报一次的代价不是数字不准，是一条本来有用的用例
 * 被劝掉**。所以下面每一条都对着"少报"或"多报"之一，而不是追求函数行覆盖。
 *
 * ## 本轮真修的一处
 *
 * 键从前是 `${operationId}|${strategy}` 拼出来的。拼串不是注入面（它只进 `Set`），
 * 但它让**两个不同组合算成同一个**：`(a|b, boundary)` 与 `(a, b|boundary)`
 * 改前拼出同一个键，于是一条真新增被算成重复。
 * 而 `operationId` 里可以有 `|` **不是假设** —— 它从 swagger 文档原样透传，
 * 载体是 `adapter-http/test/parse.test.ts` 里那条
 * 「operationId 是**原样透传的自由字符串**，不做字符集限制」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { coverageDelta, type CoverageKey } from '../src/index.js';

const k = (operationId: string, strategy: string): CoverageKey => ({ operationId, strategy });

describe('coverageDelta：新增组合数是它唯一的产品', () => {
  test('基本计数：三生成一新增；duplicates 里**两类混在一起**（这是刻意的，见注释）', () => {
    /*
     * `duplicates` 装的是"这条没带来新组合"，它**混了两类**：
     *  ① 已被 existing 覆盖（`happyPath`）—— 处置是"这条别生成了，早有了"；
     *  ② 批内自己重复（第二条 `boundary`）—— 处置是"这批里留一条就够"。
     * 两类的人话不同、处置也不同，而今天这个形状**分不出来**。
     * 本轮**没有**拆成两个字段：它零调用方，等真有那个界面时再按界面要的样子拆，
     * 比现在凭猜加一栏好（本仓那条"未实现的对外契约"就是这个代价）。
     * 但这一条把"两类都在里面"钉住 —— 将来拆分时它会红，逼下一个人看清现状。
     */
    const r = coverageDelta([k('a', 'happyPath'), k('a', 'boundary'), k('a', 'boundary')], [k('a', 'happyPath')]);
    assert.equal(r.newCombinations, 1, '已有 happyPath，只该新增 boundary');
    assert.deepEqual(r.duplicates, [k('a', 'happyPath'), k('a', 'boundary')], '两类各一条，都在 duplicates 里');
    assert.equal(r.total, 3, 'total 是**生成出来的条数**，不是去重后的组合数');
  });

  test('批内重复与"已被既有覆盖"两类的条数都能对上（拆字段时这条给出基线）', () => {
    const gen = [k('a', 'happyPath'), k('a', 'boundary'), k('a', 'boundary'), k('b', 'boundary')];
    const r = coverageDelta(gen, [k('a', 'happyPath')]);
    assert.equal(r.newCombinations, 2, 'boundary 与 b/boundary 是新增');
    assert.equal(r.duplicates.length, 2, '既有覆盖 1 条 + 批内重复 1 条');
    assert.equal(r.newCombinations + r.duplicates.length, r.total, '新增 + 不新增 = 总数（对不上的话就是有一条既没算新增也没算重复）');
  });

  test('generated 批内自己重复也算重复（不是只跟 existing 比）', () => {
    const r = coverageDelta([k('a', 'boundary'), k('a', 'boundary')], []);
    assert.equal(r.newCombinations, 1, '一批里两份同组合只新增 1 个');
    assert.equal(r.duplicates.length, 1);
  });

  test('⚠ operationId 带 `|` 时，两个不同组合不许算成同一个（改前会被报成 0 新增）', () => {
    const r = coverageDelta([k('a|b', 'boundary')], [k('a', 'b|boundary')]);
    assert.equal(r.newCombinations, 1, '两个不同组合被拼成同一个键了（键编码退回分隔符拼接）');
    assert.deepEqual(r.duplicates, [], '同上：这一栏不该把它当重复');
  });

  test('对照：真的重复还得报重复（修碰撞不许把判据放宽成"键永不相等"）', () => {
    /*
     * 修碰撞最省事的做法是让键永不撞（用对象引用、加随机后缀……），
     * 那会把**所有**东西都算成新增、`newCombinations` 恒等于 total。
     * 那比改前更坏：过度生成的信号从此恒亮，等于没有信号 —— 整栏作废。
     */
    const r = coverageDelta([k('a', 'boundary'), k('a', 'boundary')], [k('a', 'boundary')]);
    assert.equal(r.newCombinations, 0);
    assert.equal(r.duplicates.length, 2, '已有 1 条 + 批内 1 条，两个方向都要落在 duplicates 里');
  });

  test('两个空边界都不炸，且不出现负数', () => {
    assert.deepEqual(coverageDelta([], []), { newCombinations: 0, duplicates: [], total: 0 });
    const r = coverageDelta([], [k('a', 'boundary')]);
    assert.equal(r.newCombinations, 0, '没生成任何东西时新增是 0，不是 -1');
    assert.equal(r.total, 0);
  });

  test('existing 的顺序不进判据（它将来来自存储查询，顺序本来就不稳定）', () => {
    const gen = [k('a', 'boundary'), k('b', 'notFound')];
    const one = coverageDelta(gen, [k('a', 'happyPath'), k('b', 'notFound')]);
    const two = coverageDelta(gen, [k('b', 'notFound'), k('a', 'happyPath')]);
    assert.deepEqual(one, two);
    assert.equal(one.newCombinations, 1, '夹具失效：两个顺序里结果都变了，这条就没在比顺序');
  });
});
