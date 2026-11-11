/**
 * 界面类等待条件上的 `world` 字段（`uiPredicate` / `template` / `uiIdle`）。
 *
 * ## 这个文件存在的唯一理由，是它下面那组"不写就该逐字节不变"
 * 加一个字段有两种加法，而只有一种是修 bug：
 *  - `.optional()` ⇒ 不写这个字段的场景，规范串（`canonicalScenario` 的输出，
 *    也就是 `irSha` 的原料）**逐字节不变**；
 *  - `.default('web')` ⇒ zod 把默认值**物化**进规范串，于是**每一个已冻结场景**
 *    的 `irSha` 都变 —— 版本表会认为历史用例是"另一版"，而那一版跑出的证据
 *    指向一个查不到的哈希。那不是一次修复，是一次**磁盘格式迁移**。
 *
 * 这一字之差本仓已经量过一次（`waits.ts` 里 `dbRow.vars` 那段注释写着结论）。
 * 这里把它钉成测试而不是继续靠注释，是因为注释会在下一个人"顺手加个默认值"时失效，
 * 而那种改动的症状**不在改的那天出现** —— 它出现在有人比对两次历史运行的时候。
 *
 * ## 另一组：为什么"两个世界都合法"要逐个条件各测一遍
 * `world` 挂在**条件**上而不是**步骤**上，这是有意的：一棵 `allOf` 里
 * "页面上有 toast **且** app 里那个弹窗出现"是混合场景的合法写法。
 * 挂步骤上就表达不了这件事，而引擎那侧的判据（哪个条件问哪一世界）按条件走。
 * 所以三个条件各自要有一条"收 web、收 mobile、拒别的值"——
 * 只在 `uiPredicate` 上测一遍的话，另外两支**收不收这个字段**是未知的，
 * 而"收而不被引擎读"与"schema 直接拒"是两种完全不同的坏法。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalScenario, defineScenario, parseScenario,
  WaitConditionSchema, WaitPredicateSchema, WAIT_WORLD,
  type ScenarioDraft, type Scenario, type StepDraft,
} from '../src/index.js';

const locSpec = { intent: '登录按钮', primary: { by: 'testid', value: 'login-btn' } };

/** 三种界面条件各自的最小合法写法（不带 world） */
const CONDITIONS: Record<string, Record<string, unknown>> = {
  uiPredicate: { type: 'uiPredicate', state: 'visible', target: locSpec },
  template: { type: 'template', expect: 'hit', minConfidence: 0.8, target: locSpec },
  uiIdle: { type: 'uiIdle', quietMs: 400 },
};

const waitStep = (condition: Record<string, unknown>, id = 'w'): StepDraft =>
  ({ id, kind: 'wait', condition, timeoutMs: 1_000, pollMs: 100 }) as StepDraft;

const scnOf = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.world', name: 'world 夹具',
    env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);

/** 解析条件并返回它**自己**那份规范串（键序稳定），或直接带 errors 失败 */
function parseCond(o: Record<string, unknown>): Record<string, unknown> {
  const r = WaitConditionSchema.safeParse(o);
  /*
   * 消息要**惰性**取。写成 `assert.ok(r.success, JSON.stringify(r.error.issues))`
   * 会在**成功**的那一侧就抛 `Cannot read properties of undefined` ——
   * 函数实参在 assert 运行之前就求值完了，而成功时 `r.error` 是 undefined。
   * 本仓那条"assert.ok 不收窄类型"的纪律（helpers.ts 里记过）是同一个坑的邻座：
   * **断言函数不会替你安排求值顺序**。
   */
  if (!r.success) assert.fail(`条件不合法：${JSON.stringify(r.error.issues)}`);
  return r.data as Record<string, unknown>;
}

for (const [type, base] of Object.entries(CONDITIONS)) {
  test(`${type}：world 收 web / 收 mobile，**收哪个都原样留住**`, () => {
    /*
     * "原样留住"这一句不是凑数：如果 schema 写成 `z.enum([...]).transform(...)`
     * 或某个中间层把 `mobile` 归一成 `'device'`，引擎那侧按 `'mobile'` 找槽位就会
     * 找不到，而**症状是"没有 device adapter"**——一个说法错误的报错。
     * 所以这里断的是解析**输出**里那个值，不是解析没抛。
     */
    for (const w of WAIT_WORLD) {
      assert.equal(parseCond({ ...base, world: w }).world, w, `${type} 的 ${w} 没留住`);
    }
    assert.deepEqual(WAIT_WORLD, ['web', 'mobile'], '词表本身（引擎那侧的 WaitWorld 要跟它逐字一致）');
  });

  test(`${type}：不写 world 时这个键**压根不存在**，而不是 undefined`, () => {
    /*
     * `!('world' in parsed)` 而不是 `parsed.world === undefined`。
     * 后者对 `{ world: undefined }` 也成立，而那个形状正是会物化进规范串的那一种：
     * zod 的 `.optional()` 在**输入里有这个键**时会把 `undefined` 写进输出，
     * `stable()` 丢 `undefined` 所以指纹侥幸不变 —— 但那扇"侥幸"的门不该被测试放过，
     * 因为下一句 `Object.keys()` 或 `{...cond}` 就把它带进别的地方了。
     */
    const parsed = parseCond(base);
    assert.ok(!('world' in parsed), `${type} 不写 world 时不该有这个键：${JSON.stringify(Object.keys(parsed))}`);
  });

  test(`${type}：world 写错值要**当场被 schema 拒**，不许溜到运行时`, () => {
    /*
     * 三种错值各挡一种"看着像能过"的写法：
     *  - `'browser'` / `'android'`：近义词与**运行时那一维**。`android` 尤其要拒：
     *    它出现在 `ExecTarget` 里，人会以为这里也能写。写了就等于把用例
     *    钉死在一台设备上（同一份 IR 要在三种平台上跑），而那一维的细分
     *    是运行时从租约读的，作者写不出来。
     *  - `'WEB'`：大小写。`z.enum` 是精确匹配，拒它是对的（静默 lower 会让
     *    同一份 IR 有两种写法而 lint 查不出）。
     */
    for (const bad of ['browser', 'android', 'WEB', 'any', '']) {
      const r = WaitConditionSchema.safeParse({ ...base, world: bad });
      assert.equal(r.success, false, `${type} 的 world="${bad}" 竟然过了`);
    }
  });
}

/**
 * 规范串里**有没有 `world` 这个键**（结构化判断，不是子串搜索）。
 *
 * 第一版写的是 `!canonical.includes('world')` —— 它红了，而红的是我的断言不是代码：
 * 夹具场景**自己的名字**叫「world 夹具」，那个词以 `name` 的值出现在串里。
 * 子串搜索问的从来不是"有没有这个键"，而是"这几个字母有没有出现过"，
 * 而这两件事在真实数据上迟早会分开（本仓那条"给摘要文本编程"的纪律是同一件事的另一面：
 * **对着一段序列化文本做字符串匹配，迟早匹配到它没在说的那个东西**）。
 * 所以这里解析回对象、递归找键名。
 */
function hasWorldKey(canonical: string): boolean {
  const seen = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(seen);
    if (v && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === 'world' || seen(x));
    }
    return false;
  };
  return seen(JSON.parse(canonical));
}

test('不写 world 的场景，规范串**逐字节不变**（这条决定"是修复还是迁移"）', () => {
  /*
   * 这是整个字段的设计里**唯一不可挽回**的那一处。
   * 判据不是"两个场景的哈希相等"（那只说明稳定，两种实现都满足），
   * 而是"**带 world 与不带 world 的两个场景，哈希必须不同**"与
   * "**不写 world 的场景，规范串里不许出现 world 这个词**"这一对：
   *  - 后半句挡 `.default(...)`（默认值会被物化 ⇒ 串里出现 world ⇒ 所有历史 irSha 变）；
   *  - 前半句挡"字段被静默丢掉"（写了等于没写，那这个字段是**假功能**：
   *    schema 收、人写了、引擎不读 —— docs/08 §3 缺陷类 (a) 的标准形状）。
   */
  const without = canonicalScenario(scnOf([waitStep(CONDITIONS.uiPredicate!)]));
  assert.ok(!hasWorldKey(without), `不写 world 时规范串里出现了 world 这个**键**，说明字段被物化了：\n${without}`);

  for (const [type, base] of Object.entries(CONDITIONS)) {
    const bare = canonicalScenario(scnOf([waitStep(base)]));
    const withWeb = canonicalScenario(scnOf([waitStep({ ...base, world: 'web' })]));
    const withMobile = canonicalScenario(scnOf([waitStep({ ...base, world: 'mobile' })]));
    assert.notEqual(withWeb, bare, `${type}：写了 world="web" 与没写，规范串**相同** ⇒ 这个字段被丢了（假功能）`);
    assert.notEqual(withMobile, withWeb, `${type}：web 与 mobile 规范串相同 ⇒ 值没被区分`);
    assert.match(withWeb, /"world":"web"/, `${type}：规范串里要看得出那个值`);
  }
});

test('world 挂在**条件**上而不是步骤上：一棵 allOf 里两个世界各自声明', () => {
  /*
   * 混合场景的合法写法，也是这个字段**为什么长在这个位置**的唯一证法。
   * 挂步骤上（`wait.world`）表达不了这一条，而那时"这一条等待问了两个世界"
   * 在 IR 里根本无法写出来 —— 引擎侧就只能猜或者报错。
   *
   * 走的是 `WaitPredicateSchema`（谓词树）而不是 `WaitConditionSchema`（叶子）：
   * 组合子是前者的事，后者是判别联合、压根不收 `allOf`。
   * 第一版这里直接喂给条件 schema，它**报"不合法"**而我以为是我的字段没加上 ——
   * 一次把两件事混在一起的失败，红的是测试自己的形状。
   */
  const r = WaitPredicateSchema.safeParse({
    allOf: [
      { ...CONDITIONS.uiPredicate, world: 'web' },
      { ...CONDITIONS.uiIdle, world: 'mobile' },
    ],
  });
  if (!r.success) assert.fail(`谓词树不合法：${JSON.stringify(r.error.issues)}`);
  const kids = (r.data as { allOf: Array<Record<string, unknown>> }).allOf;
  assert.equal(kids.length, 2);
  assert.equal(kids[0]!.world, 'web');
  assert.equal(kids[1]!.world, 'mobile');
});

test('`.strict()` 仍然生效：写错字段名不许静默通过（世界字段没开一个"宽松"的口子）', () => {
  /*
   * 加字段最容易连带弄坏的是 `.strict()`：有人为了"兼容旧数据"把它去掉，
   * 于是 `worle` 这种拼错的条件名一路到运行时、被当成没写 world。
   * 这一条与 IR 里其它地方那条"严格 schema 不许在逃生舱之外松口"同一条纪律。
   */
  for (const base of Object.values(CONDITIONS)) {
    assert.equal(WaitConditionSchema.safeParse({ ...base, wrorld: 'web' }).success, false);
  }
});

test('端到端：带 world 的场景能被 parseScenario 完整读回（磁盘格式两侧一致）', () => {
  /*
   * 只测 schema 的话，漏了 `index.ts` 的导出、或某处把条件重新窄化成
   * 一个没有 world 的局部类型，都是**测试全绿而磁盘上那个字段读不回来**。
   * 所以这里走真 parse：写一份带 world 的 JSON 文本，读回来再断值。
   */
  const text = JSON.stringify({
    schemaVersion: '1', id: 'scn.world', name: 'world 夹具', frozen: true,
    env: { environmentRef: 'unit' },
    body: [waitStep({ ...CONDITIONS.uiPredicate, world: 'mobile' })],
  });
  const r = parseScenario(JSON.parse(text));
  // `assert.ok(r.ok)` **不收窄类型**（canonical.test.ts 里已经记过一次，这次是自己撞上）：
  // 写成 `r.ok` 再访问 `r.scenario` 的话，npm test 照样绿（tsx 不做类型检查），
  // 红的是 typecheck:test —— 那道闸存在的意义就在这儿。
  assert.ok(r.ok && r.scenario, `场景不合法：${JSON.stringify(r.errors)}`);
  const body = r.scenario.body as unknown as Array<{ condition: { world?: string } }>;
  assert.equal(body[0]!.condition.world, 'mobile', 'world 要能从磁盘读回来');
});
