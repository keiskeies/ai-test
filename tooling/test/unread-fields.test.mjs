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
  maskNonCode, extractFields, classify, makeLineOf, mentionedTokens, scan, report, loadBaseline,
} from '../unread-fields.mjs';

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

test('mentionedTokens 把字符串里的词也算进来（脱敏规则表那类按名查表的代码）', () => {
  const t = mentionedTokens(`const RULES = ['password', 'api_key'];\nx.foo;`);
  assert.ok(t.has('password'));
  assert.ok(t.has('foo'));
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
});

describe('对真实仓库', () => {
  const res = scan();

  test('字段数有下限（第一版栽过的地方：抽不到任何东西时它报的是"干净"）', () => {
    assert.ok(res.fields.length > 300, `只抽出 ${res.fields.length} 个字段 —— 抽取环节坏了，别看后面的结论`);
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
