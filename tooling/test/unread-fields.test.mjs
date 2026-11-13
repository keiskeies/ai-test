/**
 * unread-fields 扫描器自己的测试。
 *
 * 为什么必须有一批：这个工具产出的是一个**结论**（"这个字段有人管"）。
 * 它写坏一次，之后所有基于那句结论的判断都是空的，而且**坏掉的方式是报告干净**。
 * 本仓已经实测过一次这个形态：掩码函数漏了"把代码字符复制回去"，整份文件被抹平，
 * 扫出 0 个字段，输出一句"全部有豁免"然后 exit 0 —— 没有任何一层会报错。
 * 所以这里既有单元级的形状测试，也有一条钉住真实仓库的下限断言。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskNonCode, extractFields, classify, makeLineOf, scan, report, loadBaseline, collectTokens,
} from '../unread-fields.mjs';

/**
 * 哪些角色算"这个字段真的被读了"。**测试里写死字面量而不用工具导出的那份**：
 * 用导出的那份的话，把 STRONG_ROLES 改成空集合，测试会跟着一起变松、照样全绿 ——
 * 那条测试就只是在复读实现，而不是在守行为。
 */
const STRONG = new Set(['member', 'binding']);

describe('掩码', () => {
  test('注释与字符串被抹掉，代码留着，长度与换行数一个不变', () => {
    const src = `const a = 1; // z.object({ gone: 1 })\nconst b = 'z.object({ x })';\nconst c = 2;`;
    const m = maskNonCode(src);
    assert.equal(m.length, src.length, '长度必须一致，否则下标全部错位');
    assert.equal(m.split('\n').length, src.split('\n').length, '换行数必须一致，否则行号全错');
    assert.ok(!m.includes('z.object'), '注释里的 z.object 必须抹掉，否则会被当成一个 schema');
    assert.ok(m.includes('const a = 1'), '代码不能被动 —— 第一版就是这里写错，整份文件被抹平');
    assert.ok(m.includes('const c = 2'));
  });

  test('正则字面量里的花括号不会打乱配对', () => {
    const src = `const re = /a{2,3}/;\nconst o = z.object({ a: 1 });`;
    const m = maskNonCode(src);
    assert.ok(m.includes('z.object'), '代码留着');
    assert.ok(!m.includes('{2,3}'), '正则里的量词必须抹掉');
    const fields = extractFields('x.ts', src);
    assert.deepEqual(fields.map((f) => f.key), ['a'], `量词的花括号把对象边界配错就会抽错字段：${JSON.stringify(fields.map((f) => f.key))}`);
  });

  test('除号不会被误认成正则', () => {
    const src = `const half = total / 2;\nconst o = z.object({ keep: 1 });`;
    assert.deepEqual(extractFields('x.ts', src).map((f) => f.key), ['keep']);
  });
});

describe('抽字段', () => {
  test('只取深度 0 的键，嵌套对象归到包着它的具名 schema', () => {
    const src = `const OuterSchema = z.object({\n  a: z.string(),\n  inner: z.object({ deep: 1 }),\n  b: 2,\n});`;
    const fields = extractFields('x.ts', src);
    assert.deepEqual(fields.map((f) => f.key), ['a', 'inner', 'b', 'deep']);
    // 内层的 owner 是"最近一个 const 名"，也就是 Outer —— 归错到 (匿名) 的话，
    // baseline 里的 id 会对不上，豁免就永远匹配不到（表现为"加了豁免还是报未读"）
    assert.ok(fields.every((f) => f.schema === 'OuterSchema'), fields.map((f) => f.schema).join(','));
  });

  test('可选键与链式调用都认', () => {
    const src = `const S = z\n  .object({ opt: z.string().optional(), req: z.int() })\n  .strict();`;
    assert.deepEqual(extractFields('x.ts', src).map((f) => f.key), ['opt', 'req']);
  });

  test('花括号配不上时整个跳过，而不是在错误范围里抽键', () => {
    // 配不上对多半是文件本身有问题或掩码判错了。这时候**抽出什么都比抽出错的强**：
    // 错的字段名会进 baseline、会被人当成真字段去查。
    const fields = extractFields('x.ts', `const S = z.object({ a: 1,`);
    assert.deepEqual(fields, []);
  });

  test('行号指向键名真正所在的位置', () => {
    const src = `// 这里提到过 gone 一次\nconst S = z.object({\n  gone: 1,\n});`;
    const f = extractFields('x.ts', src)[0];
    assert.equal(f.line, 3, `行号指到注释上去了（第 ${f.line} 行）—— 按图索骥打开文件会看到无关内容`);
  });
});

test('makeLineOf 与朴素的 slice+split 等价', () => {
  const text = 'a\nbb\n\nccc\nd';
  const lineOf = makeLineOf(text);
  for (let i = 0; i < text.length; i++) {
    assert.equal(lineOf(i), text.slice(0, i).split('\n').length, `下标 ${i}`);
  }
});

// 原先这条测的是 mentionedTokens，那个函数已被 collectTokens 取代
// （两份取词逻辑留一份就够了，见 collectTokens 的注释）。行为本身仍然要守：
// 字符串里的词必须查得到，否则"按字段名查表"的代码（脱敏规则表那种）会全被判成未读。
test('collectTokens 把字符串里的词也算进来（脱敏规则表那类按名查表的代码）', () => {
  const toks = new Set(collectTokens(`const RULES = ['password', 'api_key'];\nx.foo;`).map((t) => t.token));
  assert.ok(toks.has('password'), '字符串里的词要能查到');
  assert.ok(toks.has('api_key'));
  assert.ok(toks.has('foo'), '代码里的标识符更要能查到');
});

test('注释里的引号词**不算**命中（这条曾经把 4 条真·未读字段永久遮住）', () => {
  // 判据两侧都要测到，否则会一边漏：
  //  - 字符串里的词**算**（上一条）：脱敏规则表那种按名查表是真消费者
  //  - 注释里的引号词**不算**（本条）：注释是给人读的，不是代码
  // 漏第二侧的实测代价（改之前就在这个仓里）：157 个 token 只活在注释的引号里，
  // 其中 5 个是 IR 字段名，于是 OperationSchema.amount / ScenarioVersionMetaSchema.ver /
  // LocatorRuleSchema.role / DeviceRequirementSchema.requires 这四条**一行执行代码都没读过**
  // 的字段被算成"碰过"，从 unread 掉进 inconclusive 而躲过门禁。
  // 本工具存在的目的正是抓"schema 有字段、执行侧没人读"，结果它自己被这一类糊住了。
  const src = [
    '// 这里的 viewport 只出现在注释的引号里：\'viewport\'',
    '/* 块注释里也一样：\'healed\' */',
    'const unrelated = 1;',
  ].join('\n');
  const toks = collectTokens(src);
  assert.ok(!toks.some((t) => t.token === 'viewport'), '行注释里的引号词不该算命中');
  assert.ok(!toks.some((t) => t.token === 'healed'), '块注释里的引号词不该算命中');
  assert.ok(toks.some((t) => t.token === 'unrelated'), '代码里的标识符照常算');
  // 反向守：不能为了堵注释把字符串也一起堵掉（那会让脱敏规则表那类真消费者变成误报，
  // 而误报的修法通常是"给规则表加个例外"，那就把真防线谈掉了）
  const both = collectTokens(`// 说明：'viewport'\nconst RULES = ['password'];`);
  assert.ok(both.some((t) => t.token === 'password' && t.viaString), '字符串里的词必须仍然算');
  assert.ok(!both.some((t) => t.token === 'viewport'), '同一份文本里注释的那个不算');
});

test('字符串里的 `//` 不会被当成注释起点（url 字面量后面还有代码时不能吞掉）', () => {
  // maskCommentsOnly 必须**走过**字符串而不是在字符串内部找注释。
  // 写成"先按注释抹、再取字符串词"的话，下面这行的 `//x'; …` 会被当行注释抹掉，
  // 于是 password 消失 —— 那是一条**看起来更安全**的错法（抹得越多越"干净"），
  // 所以专门留一条：它的症状是漏证据，而漏证据在这个工具里意味着门禁闭嘴。
  const toks = collectTokens(`const u = 'http://example.com/a';\nconst RULES = ['password'];`);
  assert.ok(toks.some((t) => t.token === 'password'), 'url 字符串之后的字符串词不该被吞掉');
});

describe('豁免对账', () => {
  const fields = [
    { file: 'a.ts', schema: 'S', key: 'gone', id: 'a.ts#S.gone' },
    { file: 'a.ts', schema: 'S', key: 'used', id: 'a.ts#S.used' },
  ];
  const unread = [fields[0]];

  test('未读且没豁免 → 门失败', () => {
    assert.deepEqual(classify(fields, unread, { fields: [] }).newUnread.map((f) => f.id), ['a.ts#S.gone']);
  });
  test('未读但有豁免 → 通过', () => {
    const c = classify(fields, unread, { fields: [{ id: 'a.ts#S.gone', reason: 'P1 没开工' }] });
    assert.deepEqual(c.newUnread, []);
    assert.equal(c.ok.length, 1);
  });
  test('字段已经有人读了、豁免还挂着 → 报"已过期"', () => {
    const c = classify(fields, [], { fields: [{ id: 'a.ts#S.gone', reason: 'x' }] });
    assert.deepEqual(c.staleExempt.map((f) => f.id), ['a.ts#S.gone']);
    assert.deepEqual(c.dangling, []);
  });
  test('字段只是"判不出"（裸词命中）→ **不算过期**，豁免继续生效', () => {
    // 这条是实测补的，起因是真的差点把两条还在用的豁免删掉：
    // 写 packages/engine/src/html.ts 时，模板里的 `<meta name="viewport">`
    // 给 EnvFingerprintSchema.viewport 造了一处**裸词**命中，于是它从 unread
    // 挪进 inconclusive。原先的判据是 `!unread.some(id)`，把"扫描器看不出"
    // 当成"有人读了"，于是报"豁免已过期，删掉它"。
    // 删掉的后果是**把闸拆了**：那条字段仍然没人读（消费者是服务端的 run 表），
    // 一旦裸词命中消失（那次重构把 CSS 挪走）它就落回 unread，
    // 而那时人看到的报错是"新增未读字段"，不会想到是自己刚删的豁免。
    // 判据与文件头第 2 条同一条纪律：宁可承认判不出，也不让"碰过"冒充"读过"。
    const c = classify(fields, [], { fields: [{ id: 'a.ts#S.gone', reason: 'x' }] },
      { inconclusive: [{ id: 'a.ts#S.gone', key: 'gone' }] });
    assert.deepEqual(c.staleExempt, [], '判不出不等于被读了，不能催人删豁免');
    assert.deepEqual(c.newUnread, []);
    assert.deepEqual(c.dangling, []);
    assert.deepEqual(c.exemptInconclusive.map((f) => f.id), ['a.ts#S.gone'], '但也要说出来，别让它静默消失在 ok 之外');
  });
  test('豁免的字段既不在 unread 也不在 inconclusive → 仍然报过期（新参数不能变成免死金牌）', () => {
    // 反向守：加了 buckets 参数之后，如果实现写成"只要传了 inconclusive 就不报过期"，
    // 那 staleExempt 就整条失效了 —— 而失效方向和上面那条误报相反，同样坏。
    const c = classify(fields, [], { fields: [{ id: 'a.ts#S.gone', reason: 'x' }] },
      { inconclusive: [{ id: 'a.ts#S.used', key: 'used' }] });
    assert.deepEqual(c.staleExempt.map((f) => f.id), ['a.ts#S.gone']);
    assert.deepEqual(c.exemptInconclusive, []);
  });
  test('豁免指向已经不存在的字段 → 报"悬空"', () => {
    const c = classify(fields, [], { fields: [{ id: 'a.ts#S.ghost', reason: 'x' }] });
    assert.deepEqual(c.dangling.map((f) => f.id), ['a.ts#S.ghost']);
  });
  test('改名后旧 id 不能靠"另一个字段还在"蒙过去', () => {
    // 上一版的判据是"这个 id 不在 fields 里才算悬空"，但它前面套了一个
    // (匿名) 名字替换，等于给"字段被改名/挪了 schema"开了一条静默通道。
    const c = classify(fields, unread, { fields: [{ id: 'a.ts#Other.gone', reason: 'x' }] });
    assert.deepEqual(c.newUnread.map((f) => f.id), ['a.ts#S.gone'], '字段还在但 schema 改名了，豁免不该继续生效');
    assert.deepEqual(c.dangling.map((f) => f.id), ['a.ts#Other.gone']);
  });
});

describe('输出', () => {
  const fakeRes = (unread) => ({ fields: [{ file: 'a', schema: 'S', key: 'k', line: 1, id: 'a#S.k' }], unread, hits: new Map(), readers: new Map() });

  test('报告干净时明确说一句"全部有豁免"，而不是一行都不输出', () => {
    // 空输出与"通过"在 CI 日志里长得一样，而这里两者意思相反
    const r = report(fakeRes([]), { fields: [] });
    assert.ok(r.lines.some((l) => l.startsWith('✓')), r.lines.join('\n'));
    assert.equal(r.failed, false);
  });
  test('有新未读时判为失败', () => {
    const r = report(fakeRes([{ file: 'a', schema: 'S', key: 'k', line: 1, id: 'a#S.k' }]), { fields: [] });
    assert.equal(r.failed, true);
    assert.ok(r.lines.join('\n').includes('新增未读字段'));
  });

  test('有判不出的字段却没登记上限 → 失败（省略上限曾等于"永远不超标"）', () => {
    const withInc = (n) => ({
      fields: Array.from({ length: n }, (_, i) => ({ file: 'a', schema: 'S', key: `k${i}`, line: 1, id: `a#S.k${i}` })),
      unread: [], inconclusive: Array.from({ length: n }, (_, i) => ({ file: 'a', schema: 'S', key: `k${i}`, id: `a#S.k${i}` })),
      hits: new Map(), readers: new Map(),
    });
    assert.equal(report(withInc(3), { fields: [] }).failed, true, '没登记上限必须失败，否则这条检查白加');
    assert.equal(report(withInc(3), { fields: [], inconclusiveCeiling: 3 }).failed, false);
    assert.equal(report(withInc(4), { fields: [], inconclusiveCeiling: 3 }).failed, true, '超过上限要报');
  });
});

/**
 * 证据分级。这批测试存在的理由是一个具体的假结论：
 * 字段名 `as` 在消费者代码里有 200+ 处裸词命中（`x as Type` 的 TS 断言），
 * 用裸词判"读过"会把**真没人读**的 `table.as` 算成"读过"，扫描器对它永久失明。
 */
/**
 * 证据分级。这批测试存在的理由是一个具体的假结论：
 * 字段名 `as` 在消费者代码里有 200+ 处裸词命中（`x as Type` 的 TS 断言），
 * 用裸词判"读过"会把**真没人读**的 `table.as` 算成"读过"，扫描器对它永久失明。
 *
 * 一律调 collectTokens —— **不在测试里重抄一遍取词逻辑**。
 * 第一版就是重抄的（自己写了个 scanIn 跑同样的正则），那等于测了一份没人走的代码：
 * 真正跑的 scan() 怎么坏都是绿的，正是本仓那个缺陷类的测试侧镜像。
 */
describe('证据分级', () => {
  /** 取某个 token 在源码里的最强角色 */
  const role = (src, token) => {
    const hits = collectTokens(src).filter((t) => t.token === token);
    if (!hits.length) return undefined;
    return hits.some((h) => STRONG.has(h.role)) ? 'strong' : 'bare';
  };

  test('裸词命中算弱证据（TS 的 `x as Type` 会造出一堆假命中）', () => {
    assert.equal(role('const y = (z as Foo).bar;', 'as'), 'bare');
  });

  test('.as 成员访问算强证据', () => {
    assert.equal(role('return s.as;', 'as'), 'strong');
    assert.equal(role('return s?.as;', 'as'), 'strong', '可选链同样是成员访问');
  });

  /*
   * 下面两条是本轮加的，起因是**具体的**：写压测那条路时，`press.ts` 里
   * `{ runnerCount: 1, connections: o.vus }` 与 `plan.ts` 里 `scenarioId: scenario.id`
   * 让 6 条**仍然没人读**的字段被判成"读过"，它们身上的 P7 豁免被报成"已过期、删掉吧"。
   * 照做就等于自己拆闸（下一次落回未读时报的是"新增未读字段"，没人知道自己删过什么）。
   * 本工具防的缺陷类是"有载体、没有生产者" —— 把**生产者**当**消费者**，
   * 等于让那一族缺陷自己给自己作证。
   */
  test('对象字面量的键**不算**读过（往键上放值是生产，不是消费）', () => {
    assert.equal(role('return { maxIterations: 3 };', 'maxIterations'), 'bare');
    // 嵌套一层也是写
    assert.equal(role('fp = { load: { vus: 10 } };', 'vus'), 'bare');
    // 带类型标注的形参名同理：`f(vus: number)` 里那个 vus 是"我要收这个值"，不是"我读了 IR 那个字段"
    // （press.ts 的旧入参名 runnerSpec 就是被这一格判成"指纹字段有人读了"的）
    assert.equal(role('export function g(runnerSpec: string) { return 1; }', 'runnerSpec'), 'bare');
    // **已知的反面**：简写解构 / 简写形参 `{ vus }` 与简写对象字面量 `{ vus }`
    // （ shorthand 时它是"往外读"）在词法上同形，所以简写一律算强证据。
    // 这就是为什么 press.ts 那处要把入参改名成 runnerSpecLabel 并写成
    // `runnerSpec: runnerSpecLabel` —— 留着 `{ runnerSpec }` 那种简写，这一格仍然认不出。
    assert.equal(role('function g({ vus }) { return 1; }', 'vus'), 'strong', '简写形参算强证据（这一格的边界，写在这是为了别以为已经分干净了）');
  });

  test('简写解构仍算读过（改名解构不再算，见下一条 —— 那是这一格改过头的代价）', () => {
    assert.equal(role('const { maxIterations } = s;', 'maxIterations'), 'strong', '简写解构');
    assert.equal(role('for (const { stepId } of list) void stepId;', 'stepId'), 'strong');
    // 改名解构 `const { timeoutMs: t } = s` 里 timeoutMs 后面跟的是 `:`，
    // 与 `{ timeoutMs: 3 }` **在词法上完全同形** —— 分不出就只能两个都不算强证据。
    // 选"都不算"而不是"都算"的理由见 roleOf 里那段：把生产者当消费者的代价
    // （把还需要的豁免报成过期）比少认一个读者的代价大。
    assert.equal(role('const { timeoutMs: t } = s;', 'timeoutMs'), 'bare');
  });

  test('数组下标不算证据（掩码后 `[x]` 只可能是 arr[i]，读的是下标变量）', () => {
    // 早先算强证据时，实测把 path/key/id/name 这些"恰好被拿来当索引"的名字判成读过
    assert.equal(role('return arr[path];', 'path'), 'bare');
  });

  test('字符串里的词只算弱证据（脱敏规则表里有 password 不等于读了 password 字段）', () => {
    const hits = collectTokens("const RULES = ['password'];");
    assert.ok(hits.some((h) => h.token === 'password' && h.viaString === true), '字符串里的词要能查到');
    assert.ok(hits.filter((h) => h.token === 'password').every((h) => h.role === 'bare'));
  });

  test('行号对得上（错行号比没行号更坏：按图索骥打开文件看到的是另一回事）', () => {
    const hits = collectTokens('const a = 1;\nconst b = s.pollMs;\n');
    const hit = hits.find((h) => h.token === 'pollMs');
    assert.equal(hit?.line, 2);
  });
});

describe('对真实仓库', () => {
  const res = scan();

  test('字段数有下限（第一版栽过的地方：抽不到任何东西时它报的是"干净"）', () => {
    assert.ok(res.fields.length > 300, `只抽出 ${res.fields.length} 个字段 —— 抽取环节坏了，别看后面的结论`);
  });

  test('table.as 与 dataSource.as 落在"判不出"而不是"读过"（这次修掉的缺陷）', () => {
    // 分级之前它们被判成"211 处读过"，扫描器对一条真缺陷永久失明
    for (const id of ['packages/ir/src/steps.ts#TableStepSchema.as', 'packages/ir/src/steps.ts#DataSourceStepSchema.as']) {
      const isRead = !res.unread.some((f) => f.id === id) && !res.inconclusive.some((f) => f.id === id);
      assert.ok(!isRead, `${id} 不该被判成"读过"：那 200+ 处命中全是 x as Type 这种断言`);
    }
  });

  test('判不出的占比要能被看见（它一旦变成 0 或暴涨，说明分级坏了）', () => {
    const pct = res.inconclusive.length / res.fields.length;
    assert.ok(pct > 0.1 && pct < 0.8, `判不出占 ${Math.round(pct * 100)}% —— 分级可能坏了`);
  });

  test('每个 schema 文件都真的抽到了东西（单文件抽风式失败会被总数掩盖）', () => {
    const perFile = new Map();
    for (const f of res.fields) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);
    assert.ok(perFile.size >= 8, `只覆盖到 ${perFile.size} 个 schema 文件`);
    for (const [file, n] of perFile) assert.ok(n > 0, `${file} 一个字段都没抽到`);
  });

  test('消费者目录真的有文件被读进来（目录名写错会让结论整个失真）', () => {
    assert.ok(res.readers.size > 500, `只收集到 ${res.readers.size} 个标识符，消费者目录可能配错了`);
  });

  test('真实 baseline 与扫描结果对得上（这条挂了就说明有字段悄悄断了线，或豁免该清了）', () => {
    const r = report(res, loadBaseline());
    assert.equal(r.failed, false, r.lines.join('\n'));
  });

  test('parallel.maxConcurrency 那条历史缺陷：扫描器**抓不到**，这是记录在案的能力边界', () => {
    // 它当时"被解释器读过了"（读来做 slice 的下标），只是用法是丢弃分支。
    // 把这条写成测试，是为了让下一个人别把这份报告读成"字段都用对了"：
    // 用得对不对只有测试与变异检查能答（parallel.json 那 14 例才是抓它的东西）。
    const hit = res.hits.get('packages/ir/src/steps.ts#ParallelStepSchema.maxConcurrency');
    assert.ok(hit, '它确实有读者');
    assert.ok(hit.some((h) => h.file.endsWith('engine/src/interpreter.ts')));
  });
});
