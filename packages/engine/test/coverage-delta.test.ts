/**
 * `coverageDelta` —— "这批生成的用例新增了哪些 `operationId × strategy` 组合"。
 *
 * ## 这份测试写过两次，两次的前提不同
 *
 * 第一版写的时候它**零生产调用方**，那些用例是"实现落地前先把判据钉住"。
 * 现在它有一个调用方：`packages/cli/src/coverage.ts` 的 `coveragePreview`
 * （`atest gen` 的覆盖增量那一栏）。所以这些用例从"钉判据"升成了真回归守卫，
 * 而**落地这一轮撞出来的两处都不是算术错**：
 *  1. 单位错位（把调用当组合）→ 见 `cli/test/coverage-preview.test.ts`；
 *  2. 上面那句"改前那个键缺陷今天可达"是**错的** → 见下面那条撞键用例的注释。
 * 两件事都不是这个文件能抓到的 —— 它们错在**调用方怎么用这个函数**，
 * 而不是函数算错了。这正好是"零调用方的代码，判据没人核对过"的具体样子：
 * 函数自己绿了三轮，而它的判据被我误读了一次。
 *
 * 值得花这一格的理由在失效方向上：docs/00 §6.1 把覆盖增量预览列成抑制过度生成的
 * **唯一有效手段**，而它的产物只有一个数 `newCombinations`；docs/02 §5 给的用法是
 * "增量为 0 就提示合并/别生成"。**少报一次的代价不是数字不准，是一条本来有用的用例
 * 被劝掉**。所以下面每一条都对着"少报"或"多报"之一，而不是追求函数行覆盖。
 *
 * ## 改过的那处键编码（以及它到底防的是谁）
 *
 * 键从前是 `${operationId}|${strategy}` 拼出来的。拼串不是注入面（它只进 `Set`），
 * 但它让**两个不同组合算成同一个**：`(a, "b|boundary")` 与 `(a|b, "boundary")`
 * 改前拼出同一个键，于是一条真新增被算成重复。
 *
 * ⚠ 但**这一撞今天经生产路径抵达不了**：撞键要 strategy 含 `|`，而 IR 把 strategy
 * 锁成闭合 enum（13 个合法值没有一个含 `|`）。第一版这里写的是
 * "operationId 可以带 `|` 不是假设（载体：adapter-http 那条字符集测试）"，
 * 于是读起来像个线上缺陷 —— 那半句是真的，可它是**必要条件不是充分条件**，
 * 我当时没检查 strategy 那一侧能不能含 `|` 就登记了。
 * 准确的措辞与被推翻的过程写在被测函数头上（`engine/src/lint.ts`）。
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

  test('分隔符撞键：(a, "b|boundary") 与 (a|b, "boundary") 不许算成同一个（改前会报 0 新增）', () => {
    /*
     * ⚠ **这一条构造的是函数契约上的输入，不是今天生产路径上出现的输入。**
     * 撞键要 strategy 里含 `|`，而 IR 把 strategy 锁成闭合 enum、
     * 13 个合法值没有一个含 `|`（载体：`ir/test/strategy-enum.test.ts`）。
     * 所以这条**不是**"线上缺陷的回归守卫"，是"参数是裸 string，谁都能这样调"的守卫。
     * 上一轮我把 operationId 可以带 `|`（真，载体在 adapter-http）当成
     * "这一撞今天可达"的证据登记过 —— 那是把必要条件当充分条件，
     * 准确的现状写在被测函数头上。
     */
    const r = coverageDelta([k('a|b', 'boundary')], [k('a', 'b|boundary')]);
    assert.equal(r.newCombinations, 1, '两个不同组合被拼成同一个键了（键编码退回分隔符拼接）');
    assert.deepEqual(r.duplicates, [], '同上：这一栏不该把它当重复');
  });

  test('换一个分隔符（NUL）不算修好：编码不能依赖"某个字符不出现"', () => {
    /*
     * 这条存在的理由是**它推翻了我自己上一轮登记的一条 expect=equivalent**。
     * 上一轮我给"换成 `\\u0000` 分隔符"那个变异写的是"等价、不红是对的"，
     * 理由写的是"`\\u0000` 不会出现在 operationId / strategy 里" ——
     * **那句没验，而且是假的**：实测把 operationId 写成 `a\\u0000b` 喂 parseOpenApi，
     * 解析器**原样收下、零 issue**（NUL 在 JSON 字符串里本来就合法）。
     * 所以换分隔符只是换了一个**更少见**的字符，缺陷一类没变。
     *
     * 判据因此不是"这个分隔符今天撞不上"，而是**编码方式不许依赖任何单个字符的不出现**。
     * 这一点上 `|`、`\\u0000` 与 JSON.stringify **不是同一种东西**：前两者依赖假设，
     * 后者不依赖。上面那条 `|` 的用例与这一条一起把这件事钉住 ——
     * 少任何一条，另一种"看起来修好了"的改法就活得下来。
     *
     * ⚠ 与上面那条同样是**函数契约层面**的构造：strategy 含 NUL 经 IR 造不出来
     * （闭合 enum）。区别在于 operationId 含 NUL **今天真的能经 swagger 抵达**，
     * 所以这一条离生产路径比 `|` 那条近一格 —— 只差 strategy 那一侧。
     */
    const NUL = String.fromCharCode(0);
    const r = coverageDelta([k(`a${NUL}b`, 'boundary')], [k('a', `b${NUL}boundary`)]);
    assert.equal(r.newCombinations, 1, '两个不同组合被拼成同一个键了（换成 NUL 分隔符同样会这样）');
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
