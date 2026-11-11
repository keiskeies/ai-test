/**
 * 一条等待**问的是哪一世界**，以及这件事在装配侧可不可见。
 *
 * ## 这份文件存在的理由：一类"装配侧根本看不见"的端需求
 *
 * `needsWeb` **就是** `targetSources(steps,'web').length > 0`（不是并列的第二判据，
 * `cli/src/wiring.ts` 里明写着这点，因为两个判据一分叉，报错就会去指责无辜的步骤）。
 * 而 `targetSources` 走的是逐步判据 `targetsOfStep`，`STEP_TARGET.wait` 是 `'any'`
 * —— 于是**整条场景只有一个界面等待**时，那份需求在装配侧完全隐形。改前实测
 * （`.scratch/probe-wait-world-target.mts` 与 `.scratch/probe-response-wait-invisible.mts`，
 * 表里那几行逐个量过，`adapters` 传空对象走真 `runScenario`；两个探针还各带了几个"不许报"的对照形状，
 * 那些不在表里（表只记"改前是什么"）：
 *
 * | 条件 | 改前 `needsWeb` | 改前真跑出来 |
 * |---|---|---|
 * | `uiPredicate{world:'web'}` | false | `NoConditionAdapter` + **env-unavailable** |
 * | `template{world:'web'}` | false | 同上 |
 * | `uiIdle{world:'web'}` | false | 同上 |
 * | `response` | false | `NoNetworkObserver` + **env-unavailable** |
 * | `newPage` | false | `NoNewPageObserver` + **env-unavailable** |
 *
 * 那三条报错的**内容**是好的（`NoConditionAdapter` 甚至专门写了"这是平台没接线，
 * 不是条件没满足，也不是超时"）—— 问题在它们**出现的时机与去处**：
 * 装配期那句 `设 ATEST_BROWSER_BIN=<路径>` 是**下一步动作**，而 `env-unavailable`
 * 进了退出码，流水线会照 `CI_HINT` **重试一次**（wiring.ts 原话：配置缺失重试一万次
 * 也不会好）。这正是 `needsWeb` 当初存在的理由，而等待条件那一族漏在它外面。
 *
 * ## 三个决定各自独立，所以各有一组钉子
 *
 *  1. 界面三兄弟**写了 `world`** ⇒ 只报那一档（与 `resolveWaitWorld` 判据 1 同一条）；
 *  2. **没写 `world`** ⇒ **什么都不报**。这一条最需要解释，也最先是写错的，
 *     见下面那个 describe —— 它记的是"宽松判据撑到装配侧会把纯安卓场景挡在门外"；
 *  3. `response` / `newPage` ⇒ 报 web，理由**不是** schema 而是**接线事实**
 *     （`adapters.network` / `adapters.newPage` 在 wiring 里只挂在 web 分支下）。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  LEASE_REQUIRED, STEP_KINDS, STEP_TARGET, WaitConditionSchema, deriveNeedsDevice, deriveTargets,
  hasUndeclaredUiWorld, waitWorldDemand, WAIT_BROWSER_ONLY_CONDITIONS, WAIT_UI_CONDITIONS, type Step,
} from '../src/index.js';

const LOC = { intent: 'x', primary: { by: 'css', value: 'a' } };
const ALL_KINDS = STEP_KINDS as readonly Step['kind'][];

/** 一条只含 wait 的步骤（过 schema，所以条件形状写错会当场炸而不是静默不判） */
const waitStep = (condition: unknown): Step => {
  const s = {
    id: 'w', kind: 'wait', condition, timeoutMs: 500,
    onTimeout: 'fail', continueOnError: false, onError: 'fail', tags: [],
  };
  // 过一遍 StepSchema 需要完整的 wait 步；这里用宽松构造 + 只喂 waitWorldDemand，
  // 因为这一族判据**只看 condition 的结构**，而结构由下面那几个真实条件字面量给出。
  return s as unknown as Step;
};
const worldsOf = (condition: unknown): string[] => waitWorldDemand(waitStep(condition)).sort();
const stepsOf = (...conds: unknown[]): Step[] => conds.map((c) => waitStep(c));

describe('界面三兄弟：写了 world 就只报那一档', () => {
  for (const type of ['uiPredicate', 'template', 'uiIdle']) {
    test(`${type} 写了 world 就是那一档，另一档不算`, () => {
      assert.deepEqual(worldsOf({ type, target: LOC, world: 'web' }), ['web'], `${type}:web`);
      assert.deepEqual(worldsOf({ type, target: LOC, world: 'mobile' }), ['mobile'], `${type}:mobile`);
    });
  }

  test('三兄弟都在那份手抄名单里（漏一个 => 装配侧对那种条件继续隐形）', () => {
    // 名单导出而不是让测试去正则扫源码：扫源码那条路本仓已有（src-text.ts），
    // 但那张表要核对的是"schema 里有哪些字段"，这一张要核对的是"这个类型谁提供数据"，
    // 后者在 schema 里**压根没有**，所以只能是一份显式名单 + 一条对照守卫。
    assert.deepEqual([...WAIT_UI_CONDITIONS].sort(), ['template', 'uiIdle', 'uiPredicate']);
    assert.deepEqual([...WAIT_BROWSER_ONLY_CONDITIONS].sort(), ['newPage', 'response']);
  });
});

describe('没写 world 的界面条件：不算任何硬需求（本轮第一版就错在这一格）', () => {
  for (const type of ['uiPredicate', 'template', 'uiIdle']) {
    test(`${type} 没写 world => 两档都不报`, () => {
      /*
       * **本轮第一版报的是两个都算**，理由看着很正：运行期规则 2 说
       * "两档都在场而作者没写 ⇒ 抛 AmbiguousWaitWorld，不许猜"，
       * 而装配侧此刻不知道会有哪些 adapter，所以"不猜"像是该翻成"两个都备好"。
       *
       * 实测否掉了它（`.scratch/probe-undeclared-world-assembly.mts`）。
       * 一份 `device{android}` + `tap` + 一条没写 world 的 `uiPredicate` 的**纯安卓**场景：
       *  - 改前：`needsWeb` false，没装 Chrome 的机器上照跑（运行期规则 3：只有一档在场就用它）；
       *  - 第一版：`needsWeb` **true** ⇒ 装配期直接「设 ATEST_BROWSER_BIN=…」把它挡掉。
       * 也就是说这个"更保守"的判据把一份**今天跑得好好的**用例变成跑不了。
       *
       * 而且备了浏览器**反而制造失败**：两档都在场正是运行期抛歧义的那个条件。
       * "两个都备好"于是把一份本来正常的场景变成一条 error —— 一次为了防错归因的
       * 改动自己造出了那条错。
       *
       * 所以这里的语义是**硬需求**：只有"没有这一档就百分百跑不成"的才算。
       * "作者没说清问哪一档"是真问题，但它由 lint 那条 `WAIT_WORLD_UNDECLARED` 说
       * （只在两档都会在场时报，那才是运行期真会抛的形状），
       * 而不是由一个装配判据顺手代替 —— 那是本仓那一族"一个函数答两个问题"。
       */
      assert.deepEqual(worldsOf({ type, target: LOC }), [],
        `${type} 没写 world：任一档都能服务它，所以哪一档都不是硬需求`);
    });
  }

  test('但"没说清"这件事不许静默 —— 由 hasUndeclaredUiWorld 交给 lint', () => {
    /*
     * 上面那一格把"没写"从**装配判据**里拿掉了，如果不配这一格，
     * 本轮就是"为了修一个误报，把一条真提示一起删了"。两个函数分开的原因写在
     * waits.ts 里：一个答"哪一档是硬需求"（没写 => 没有），
     * 一个答"作者有没有说清"（没写 => 没说清）。
     */
    for (const type of ['uiPredicate', 'template', 'uiIdle']) {
      assert.equal(hasUndeclaredUiWorld(waitStep({ type, target: LOC })), true, type);
      assert.equal(hasUndeclaredUiWorld(waitStep({ type, target: LOC, world: 'web' })), false, `${type} 写了就不该报`);
      assert.equal(hasUndeclaredUiWorld(waitStep({ type, target: LOC, world: 'mobile' })), false);
    }
    // 非界面条件、非 wait 步骤、以及没有 condition 的书写形态都不报
    assert.equal(hasUndeclaredUiWorld(waitStep({ type: 'expr', expr: '1 == 1' })), false);
    assert.equal(hasUndeclaredUiWorld({ kind: 'tap', condition: { type: 'uiPredicate' } } as unknown as Step), false);
    assert.equal(hasUndeclaredUiWorld({ kind: 'wait' } as unknown as Step), false);
  });

  test('两个判据的答案在"没写 world"这一格**必须不同**（合成一个就是一个在说谎）', () => {
    /*
     * 这一条守的是本轮想明白的那件结构性事实，所以它不属于上面任何一格。
     * 若有人"顺手合并"这两个函数（它们看起来都在读同一棵树），
     * 无论保留哪一半，另一半的读者都会拿到假答案：
     *  - 只留硬需求 => lint 永远不报，作者永远不知道该写 world；
     *  - 只留"没说清就算两个" => 纯安卓场景在装配期要 Chrome（本轮第一版）。
     */
    const c = { type: 'uiPredicate', target: LOC };
    assert.deepEqual(waitWorldDemand(waitStep(c)), [], '装配侧：没有硬需求');
    assert.equal(hasUndeclaredUiWorld(waitStep(c)), true, 'lint 侧：作者没说清');
  });
});

describe('只有浏览器能观测的那一族：需求来自接线事实，不来自 schema', () => {
  for (const type of ['response', 'newPage']) {
    test(`${type} 算 web，而且它压根没有 world 可写`, () => {
      /*
       * 判据是**接线**：`wiring.ts` 里 `adapters.network` 与 `adapters.newPage`
       * 只在 `createWebAdapter` 成功之后才赋值（两处都挂在 web 分支里），
       * 而 `NoNewPageObserver` 自己的原话是"新窗口只有浏览器看得见"。
       *
       * 顺带把"它没有 world"也断一下：这不是顺手。作者若能给 `response` 写
       * `world:'mobile'`，那一档今天**没有任何东西**能提供请求观测数据，
       * 报了 mobile 只会让装配去申请一台机器然后照样抛 NoNetworkObserver。
       * schema 上 `.strict()` 会直接拒掉那个写法，所以这里问的是"这个字段不存在"
       * 这件事有没有人守着 —— 它有：下面那条从 schema 现取的守卫。
       */
      assert.deepEqual(worldsOf({ type, urlPattern: '/api/x' }), ['web']);
      const shape = (WaitConditionSchema as unknown as { options: Array<{ def?: { shape?: Record<string, unknown> } }> })
        .options.map((o) => o.def?.shape).find((sh) => (sh?.type as { value?: string } | undefined)?.value === type);
      assert.ok(shape, `schema 里找不到 ${type} 这个条件类型`);
      assert.equal(shape.world, undefined, `${type} 不该有 world 字段（那一档没有观测口）`);
    });
  }
});

describe('不问界面的条件不许报任何世界（误报的代价是白起一个浏览器）', () => {
  test('expr / httpStatus / dbRow 什么都不是报', () => {
    /*
     * 反方向也要钉，因为多报的代价是**实际的**：`needsWeb` 为真就会去
     * `createWebAdapter`（起 Chrome 1~2s、几百 MB），而"没装 Chrome 的机器上
     * 纯 API 用例必须照跑"是那条按需装配的第三条理由。
     * 把 `dbRow` 也算成 web 是很容易顺手做的事（它确实"要一个 adapter"），
     * 而它要的是 **db** adapter，那个今天由环境配置决定、不由这里管。
     */
    assert.deepEqual(worldsOf({ type: 'expr', expr: '1 == 1' }), []);
    assert.deepEqual(worldsOf({ type: 'httpStatus', ref: '$.h', in: [200] }), []);
    assert.deepEqual(worldsOf({ type: 'dbRow', sql: 'SELECT 1' }), [],
      'dbRow 要的是 db adapter；把它算成 web 会白起一个浏览器');
  });

  test('不是 wait 的步骤，本函数一律交空（它是 wait 的专用判据，不是通用遍历）', () => {
    assert.deepEqual(waitWorldDemand({ kind: 'tap', condition: { type: 'uiPredicate', world: 'web' } } as unknown as Step), [],
      'kind 不是 wait 就不该看 condition —— 否则"随便哪一步带个 condition 键"就能改端集合');
    assert.deepEqual(waitWorldDemand({ kind: 'wait' } as unknown as Step), [],
      '没有 condition 键（书写形态里可能没有）也不许抛');
    assert.deepEqual(waitWorldDemand({ kind: 'wait', condition: null } as unknown as Step), []);
  });
});

describe('嵌套谓词树：allOf / anyOf / noneOf 里的都要算', () => {
  test('一棵树里两个世界都问 => 两个都报', () => {
    const w = worldsOf({ allOf: [
      { type: 'uiPredicate', target: LOC, world: 'web' },
      { type: 'uiPredicate', target: LOC, world: 'mobile' },
    ] });
    assert.deepEqual(w, ['mobile', 'web'], '混合等待问了两个世界，两个都是需求');
  });

  test('noneOf 里的子条件也算（"等这个不发生"仍然要去问那一档）', () => {
    // 这一格是最容易被"只走 allOf"漏掉的一支。iterConditions 三种复合键都走，
    // 而"漏一种"的表现是**静默少报一个需求** —— 正是本文件开头那张表的症状。
    for (const key of ['allOf', 'anyOf', 'noneOf']) {
      assert.deepEqual(worldsOf({ [key]: [{ type: 'uiPredicate', target: LOC, world: 'web' }] }), ['web'],
        `${key} 里的子条件也要参与`);
    }
  });

  test('嵌套两层（allOf 里套 anyOf）也要走到', () => {
    assert.deepEqual(worldsOf({ allOf: [
      { type: 'expr', expr: '1 == 1' },
      { anyOf: [{ type: 'newPage' }, { type: 'uiPredicate', target: LOC, world: 'mobile' }] },
    ] }), ['mobile', 'web']);
  });

  test('重复条件不重复计（返回集合而不是列表）', () => {
    assert.deepEqual(worldsOf({ allOf: [
      { type: 'uiPredicate', target: LOC, world: 'web' },
      { type: 'uiPredicate', target: LOC, world: 'web' },
    ] }), ['web']);
  });
});

describe('接到两个读者身上：端集合（哪一端）与要不要设备（另一问）', () => {
  test('wait{world:\'web\'} 进端集合，wait{world:\'mobile\'} 不进（它说不出哪一端）', () => {
    /*
     * 这一对是本轮那个"两个问法分开"的**第三次应用**：
     * 一个问 mobile 的等待**确实要一台机器**，而它说不出要 android / ios / harmony
     * 里的哪一个（那是运行期从租约读的）。所以：
     *  - `deriveTargets` 只取 web 那一半；
     *  - `deriveNeedsDevice` 取 mobile 那一半。
     * 两个读数必须**分别**成立。只断前者会让"把 mobile 也塞进端集合"这种改动能过，
     * 而那正是本轮从 `targetsOfStep` 里删掉的坏法（替步骤猜一个平台）。
     */
    assert.deepEqual(deriveTargets(stepsOf({ type: 'uiPredicate', target: LOC, world: 'web' })), ['web']);
    assert.deepEqual(deriveTargets(stepsOf({ type: 'uiPredicate', target: LOC, world: 'mobile' })), [],
      'mobile 不是一个端；报进端集合就是替作者猜平台');
    assert.equal(deriveNeedsDevice(stepsOf({ type: 'uiPredicate', target: LOC, world: 'mobile' })), true,
      '而"要不要设备"这一问必须答对：它百分百要一台');
    assert.equal(deriveNeedsDevice(stepsOf({ type: 'uiPredicate', target: LOC, world: 'web' })), false,
      '等浏览器不等于要设备（那是另一格）');
  });

  test('没写 world 的界面等待：两个读者都不该被它拉动', () => {
    /*
     * 与上面那格的读数一致（本轮第一版在这里也会红，因为它把两个读者都拉动了）。
     * 反向钉子：写了 world 的两个读者各自动一次，"没写"两个都不动。
     */
    const undeclared = stepsOf({ type: 'uiIdle' });
    assert.deepEqual(deriveTargets(undeclared), [], '不拉动端集合');
    assert.equal(deriveNeedsDevice(undeclared), false, '也不拉动"要不要设备"');
    const declared = stepsOf({ type: 'uiIdle', world: 'mobile' });
    assert.deepEqual(deriveTargets(declared), []);
    assert.equal(deriveNeedsDevice(declared), true, '写了 mobile 就只拉动后者');
  });

  test('纯 expr 等待两边都不报（不许把 wait 整个当成"总要什么"）', () => {
    const one = stepsOf({ type: 'expr', expr: '1 == 1' });
    assert.deepEqual(deriveTargets(one), []);
    assert.equal(deriveNeedsDevice(one), false);
  });

  test('等待用的租约需求与 LEASE_REQUIRED 的关系：wait 不在名单里，而这不是漏', () => {
    /*
     * `wait{world:'mobile'}` 要设备，但**不该自己要租约** —— 它跑在别的步骤
     * 挣来的那台上（与 `watcher` 同一档，那一档今天正是 `['device','watcher']`）。
     * 这里把关系写死：如果哪天有人给 wait 加上租约要求，
     * `deriveNeedsDevice` 仍是超集（超集方向才允许当前置过滤），而下面这条会先红，
     * 逼那次改动来看一眼"静态闸与运行事实"是否还一致。
     */
    assert.equal(LEASE_REQUIRED.includes('wait' as never), false,
      'wait 今天不要租约（它借用别的步骤那台）');
    const mobileKinds = ALL_KINDS.filter((k) => STEP_TARGET[k] === 'mobile');
    assert.deepEqual(mobileKinds.filter((k) => !LEASE_REQUIRED.includes(k)).sort(), ['device', 'watcher'],
      '要设备但不要租约那一档变了 —— 来看 wait 该不该进去');
  });
});

describe('守卫：schema 里每一种等待条件都必须被显式判过（新增一种不许隐形）', () => {
  /*
   * 这一条是本文件里唯一"防未来"的守卫，也是那两张手抄表**不会烂**的唯一理由。
   *
   * 为什么需要它：`UI_CONDITIONS` / `BROWSER_ONLY_CONDITIONS` 是手抄的，
   * 因为"这个类型的数据由谁提供"不在 schema 里（`uiPredicate` 与 `response`
   * 在 union 里长得一模一样）。手抄表的本仓老毛病是"新增一项而没人回来登记"，
   * 而这里的漏登记**恰好就是本轮那个缺陷的形状**：装配侧看不见一个新需求。
   * 所以这条守卫不是"完整性姿态"，它是那个缺陷的**预防针**。
   *
   * 第三种成员（不问界面那一组）写在这里而不是写在 src 里，是有意的：
   * 它在 src 里没有任何读者（src 的判据是"在两张名单里吗"，不在就返回空），
   * 写进 src 会变成一份"看起来被使用而其实没有"的死表 —— 本仓为这类东西记过账。
   * 放在测试里它的角色就说清了：**这是一条断言的期望集合**。
   */
  const NOT_ASKING = ['expr', 'httpStatus', 'dbRow'] as const;
  const typesFromSchema = ((WaitConditionSchema as unknown as {
    options: Array<{ def?: { shape?: { type?: { value?: string } } } }>;
  }).options)
    .map((o) => o.def?.shape?.type?.value)
    .filter((x): x is string => typeof x === 'string')
    .sort();

  test('从 schema 取出的类型清单非空（取空会让下面每条恒绿）', () => {
    // 与 wait-expr-fields.test.ts 同一条扫空自检：union 换成 z.lazy 之类
    // 会让 `.options` 变 undefined，那时下面那句深比对会在两个空数组之间成立。
    assert.ok(typesFromSchema.length >= 8, `只取出 ${typesFromSchema.length} 个条件类型，先怀疑取法`);
  });

  test('union 里每种条件，要么在两张名单之一，要么在"不问界面"那一组（两个方向都断）', () => {
    const known = [...WAIT_UI_CONDITIONS, ...WAIT_BROWSER_ONLY_CONDITIONS, ...NOT_ASKING].sort();
    assert.deepEqual(typesFromSchema, known,
      `等待条件类型与本文件的三组名单对不上。\n  schema：${JSON.stringify(typesFromSchema)}\n  名单：  ${JSON.stringify(known)}\n`
      + '  新增一种界面条件而没登记 => 它在装配侧**隐形**（needsWeb 看不见它 => 不建浏览器 => 运行期 env-unavailable），\n'
      + '  那正是本文件开头那张表记的缺陷形状。请把它加进 waits.ts 对应的名单，并补一条上面的测试。');
  });

  test('三组名单互不重叠（同一种条件被两条判据各判一次，就会报两个世界）', () => {
    const all = [...WAIT_UI_CONDITIONS, ...WAIT_BROWSER_ONLY_CONDITIONS, ...NOT_ASKING];
    assert.equal(new Set(all).size, all.length, `名单里有重复项：${JSON.stringify(all)}`);
  });
});
