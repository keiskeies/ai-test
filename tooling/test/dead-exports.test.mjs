/**
 * `dead-exports.mjs` —— "没人调的导出函数"守卫的测试。
 *
 * ## 主产品是"这条线有牙"，不是"当前报零"
 *
 * 一道报"没有死导出"的绿**本身不可信**：抽取器抽不到任何东西时它不会报错，
 * 它只会报告干净（`unread-fields.mjs` 与 `dead-iface-fields.mjs` 文件头同一条教训，
 * 那道 interface 守卫为此专门留了自检下限，这里沿用）。
 * 所以下面分成两组：
 *  - **有牙**：往临时语料里塞一个真死的导出函数 ⇒ 必须红且只报它一个；
 *    抽取器整个失效时那句"✓"不许算通过。
 *  - **判据的四个方向**：每一个都对应本轮**真的踩到过**的一种错法，
 *    不是我设想的反例（见每条上面的出处）。
 *
 * ## 为什么这些用例全在临时目录里跑，而不在真仓库上跑
 *
 * 判据是"全仓引用计数"，往真仓库里加一个死函数会让**别的**用例跟着变；
 * 而临时语料里每一个方向都能单独给，红的時候能直接看出是哪一条判据动过。
 * 真仓库上只跑两条"夹具有效性"式的断言（文件末尾那组）：
 * 已知活的函数不许被报出来，以及本轮刚接线的 `coverageDelta` 不许再落在 testOnly 里。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { codeMask, report, scan } from '../dead-exports.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * 造一份小语料并扫它。`scan` 只走 `packages/` 与 `tooling/` 两个根，
 * 所以临时目录里也得摆出这两个目录 —— 这是它的公开契约的一部分，
 * 用它而不是把 scan 拆成可注入的形式，是为了让测试走的就是 CI 走的那条路。
 */
function scanCorpus(files) {
  const dir = join(tmpdir(), `atest-deadexp-${Math.random().toString(36).slice(2)}`);
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, src, 'utf8');
    }
    return scan(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 只报名字，方便断言"只报它一个" */
const names = (list) => list.map((d) => d.name).sort();

describe('有牙：这条线真的会红', () => {
  test('一个真死的导出函数 ⇒ 红，且只报它一个', () => {
    const res = scanCorpus({
      'packages/a/src/live.ts': `export function usedEverywhere(): number {\n  return 1;\n}\n`,
      'packages/a/src/caller.ts': `import { usedEverywhere } from './live.js';\nexport const v = usedEverywhere();\n`,
      'packages/a/src/dead.ts': `export function nobodyCallsMe(): number {\n  return 2;\n}\n`,
    });
    assert.deepEqual(names(res.unused), ['nobodyCallsMe'], `应当只报那个真死的：${JSON.stringify(res.unused)}`);
    // 活的这个**不能**因为"它的调用方只有一处"被牵连报出来
    assert.deepEqual(names(res.testOnly), []);
  });

  test('自检下限：抽取器什么都没抽到时，那句"✓"不许算通过', () => {
    // 空语料（真实的"抽取器整个失效"长相）+ report 的下限
    const res = scanCorpus({ 'packages/a/src/x.ts': 'export const notAFunction = 1;\n' });
    assert.equal(res.decls, 0, '夹具：这份语料里确实一个导出函数都没抽到');
    const code = report(res, { minDecls: 50 });
    assert.equal(code, 1, '抽不到声明时必须非零退出，否则"干净"是假的');
  });

  test('report 在真有死导出时也非零（下限通过而内容红 —— 两个失败方向都要拦）', () => {
    const code = report({ unused: [{ name: 'f', file: 'p.ts', line: 1 }], testOnly: [], files: 1, decls: 999 }, { minDecls: 1 });
    assert.equal(code, 1);
  });

  test('testOnly 那一档只印不拦（它逼不出"删还是接"这个决定）', () => {
    const code = report({ unused: [], testOnly: [{ name: 'g', file: 'p.ts', line: 1 }], files: 1, decls: 999 }, { minDecls: 1, quiet: true });
    assert.equal(code, 0, '只有测试在调不该让 CI 变红，理由写在 report 注释里');
  });
});

describe('抽取器：六种导出写法都要收得到', () => {
  const cases = [
    ['function', 'export function f1(): number { return 1; }'],
    ['async function', 'export async function f2(): Promise<number> { return 1; }'],
    ['generator', 'export function* f3() { yield 1; }'],
    ['class', 'export class F4 { m() { return 1; } }'],
    ['箭头函数常量', 'export const f5 = (a: number): number => a;'],
    ['async 箭头常量', 'export const f6 = async (a: number): Promise<number> => a;'],
    /** 带类型标注的 const：`export const f: (a: number) => number = (a) => a;`
     *  这一格专门盯"标注里有个 `=>` 就把声明看漏"那种正则写法 */
    ['标注在等号左边的箭头', 'export const f7: (a: number) => number = (a) => a;'],
  ];
  for (const [name, src] of cases) {
    test(`${name} 的导出收得上来（且收的是对的名字）`, () => {
      const nm = (src.match(/(?:function\*?|class|const)\s+([A-Za-z0-9_$]+)/) ?? [])[1];
      assert.ok(nm, `夹具里的 ${name} 连名字都提不出来，这条断言没在测任何东西`);
      const res = scanCorpus({ 'packages/a/src/m.ts': `${src}\n` });
      assert.deepEqual(names(res.unused), [nm], `${name} 没被抽成导出，或抽错了名字`);
    });
  }

  test('注释里的 export function 不算声明', () => {
    const res = scanCorpus({ 'packages/a/src/doc.ts': '/** 用法：`export function fakeInDocs() {}` */\nexport const real = 1;\n' });
    assert.equal(res.decls, 0, '注释里那句不是声明，抽出来就会多一个"没人调的导出"');
  });
});

describe('判据的四个方向：每一条都对应本轮真踩过的一次错', () => {
  test('① 只 import 而不调用 ⇒ 仍然算死（这是本守卫要抓的形状本身）', () => {
    const res = scanCorpus({
      'packages/a/src/def.ts': `export function importedButNeverCalled(): number {\n  return 1;\n}\n`,
      'packages/a/src/uses.ts': `import { importedButNeverCalled } from './def.js';\nexport const v = 1;\n`,
    });
    assert.deepEqual(names(res.unused), ['importedButNeverCalled'], 'import 是"我准备用"，不是"我用了"');
  });

  test('② 只被 barrel 转发 ⇒ 仍然算死（转发不等于调用）', () => {
    const res = scanCorpus({
      'packages/a/src/def.ts': `export function onlyReexported(): number {\n  return 1;\n}\n`,
      'packages/a/src/index.ts': `export { onlyReexported } from './def.js';\n`,
      'packages/a/src/index2.ts': `export {\n  onlyReexported,\n} from './def.js';\n`,
    });
    assert.deepEqual(names(res.unused), ['onlyReexported'], '单行与多行转发都不该救活它');
  });

  test('③ 只在模板字符串 ${…} 里被调用 ⇒ 必须算活（base64Utf8 那个假阳性）', () => {
    /*
     * 这一条是本守卫自己的第一个假阳性，也是最贵的那种：
     * 报出来的**名字和文件都对**，只有"没人用"那半句是假的，照着删就删掉一行活代码。
     * 载体：`adapter-http/src/auth/apply.ts` 的
     * `headers.authorization = \`Basic ${base64Utf8(v)}\``，
     * 而 `maskNonCode` 把整个模板连 `${...}` 一起遮成空格。
     */
    const res = scanCorpus({
      'packages/a/src/tpl.ts': [
        'export function calledOnlyInTemplate(s: string): string {',
        '  return s;',
        '}',
        'export function host(s: string): string {',
        "  return `Bearer ${calledOnlyInTemplate(s)}`;",
        '}',
        'export const h = host;',
      ].join('\n'),
    });
    assert.deepEqual(names(res.unused), [], '模板插值里的调用是真调用，不许报死');
  });

  test('③b 但注释里写的 ${…} 不许救活它', () => {
    const res = scanCorpus({
      'packages/a/src/cmt.ts': [
        'export function deadDespiteComment(): string {',
        '  return "";',
        '}',
        '// 用法示例：`${deadDespiteComment()}`',
        'export const z = 1;',
      ].join('\n'),
    });
    assert.deepEqual(names(res.unused), ['deadDespiteComment'], '注释里的示例不是使用');
  });

  test('④ 字符串正文里的同名词不许救活它（报错文案里到处写着函数名本身）', () => {
    const res = scanCorpus({
      'packages/a/src/str.ts': [
        'export function namedInMessageOnly(): void {',
        '  throw new Error("namedInMessageOnly 需要配置");',
        '}',
      ].join('\n'),
    });
    assert.deepEqual(names(res.unused), ['namedInMessageOnly'], '字符串正文不是引用');
  });

  test('⑤ 自递归的活函数不许被当成死（"总数减 1"那种算法会栽在这）', () => {
    const res = scanCorpus({
      'packages/a/src/rec.ts': [
        'export function fact(n: number): number {',
        '  return n <= 1 ? 1 : n * fact(n - 1);',
        '}',
      ].join('\n'),
    });
    // 自递归只证明"名字在本文件出现过第二次"，而本文件内的自用**不算对外有人用**，
    // 所以它落进的是 unused 还是活着，取决于判据怎么选 —— 这里钉的是当前判据：
    // 文件内自引用算"有人用"（否则一个纯内部递归工具会被报成死导出，那是误报）
    assert.deepEqual(names(res.unused), [], '自递归函数是活的');
  });

  test('⑥ 本文件内自用（未从外部调用）⇒ 算活，不进任何一档', () => {
    /*
     * `entry` 这里**故意不导出**。第一版我把它写成 `export function entry()`，
     * 于是守卫报了它 —— 而那是**对的**：它确实一个调用方都没有。
     * 记下来是因为这条用例判的是"helperInternal 只在本文件被用，算不算没人用"，
     * 夹具里多一个真死的导出会把红的含义搅浑（分不清是判据错了还是夹具错了）。
     */
    const res = scanCorpus({
      'packages/a/src/self.ts': [
        'export function helperInternal(): number {',
        '  return 1;',
        '}',
        'function entry(): number {',
        '  return helperInternal();',
        '}',
        'export const out = entry;',
      ].join('\n'),
    });
    assert.deepEqual(names(res.unused), []);
    assert.deepEqual(names(res.testOnly), [], '对外契约开大了不是缺陷，别报成缺口');
  });

  test('⑦ 文件末尾那句 export { a, b } 不算"本文件用了一下"', () => {
    // `engine/src/dryrun.ts` 真有这一句。不抹的话每个被转发的函数白拿一次 selfUse
    const res = scanCorpus({
      'packages/a/src/reexport.ts': [
        'export function forwardedOut(): number {',
        '  return 1;',
        '}',
        'export { forwardedOut };',
      ].join('\n'),
    });
    assert.deepEqual(names(res.unused), ['forwardedOut'], '本地 export {} 是转发，不是使用');
  });
});

describe('testOnly 那一档的边界', () => {
  test('只有测试在调 ⇒ 进 testOnly 而不是 unused', () => {
    const res = scanCorpus({
      'packages/a/src/def.ts': `export function testedOnly(): number {\n  return 1;\n}\n`,
      'packages/a/test/def.test.ts': `import { testedOnly } from '../src/def.js';\nif (testedOnly() !== 1) throw new Error('x');\n`,
    });
    assert.deepEqual(names(res.unused), []);
    assert.deepEqual(names(res.testOnly), ['testedOnly']);
  });

  test('test/ 目录自己导出的夹具不算缺口（它的生产侧就是测试）', () => {
    const res = scanCorpus({
      'packages/a/test/helpers.ts': `export function fixtureHelper(): number {\n  return 1;\n}\n`,
      'packages/a/test/one.test.ts': `import { fixtureHelper } from './helpers.js';\nif (fixtureHelper() !== 1) throw new Error('x');\n`,
    });
    assert.deepEqual(names(res.unused), []);
    assert.deepEqual(names(res.testOnly), [], '要求测试夹具上生产是判据用错了地方');
  });

  test('生产侧有一处调用就两档都不进（哪怕只有一处）', () => {
    const res = scanCorpus({
      'packages/a/src/def.ts': `export function thinlyUsed(): number {\n  return 1;\n}\n`,
      'packages/a/src/one.ts': `import { thinlyUsed } from './def.js';\nexport const v = thinlyUsed();\n`,
    });
    assert.deepEqual(names(res.unused), []);
    assert.deepEqual(names(res.testOnly), []);
  });
});

describe('codeMask：模板插值还原这件事本身', () => {
  test('字面文本遮、插值还、注释里的插值不还', () => {
    const src = [
      'const a = `Bearer ${realCall(x)}`;',
      '// 例：`FakeInComment()`',
      'const b = "inString";',
    ].join('\n');
    const m = codeMask(src);
    assert.ok(m.includes('realCall'), '插值里的名字要还在');
    assert.ok(!m.includes('FakeInComment'), '注释里的不许还');
    assert.ok(!m.includes('inString'), '字符串正文要继续遮着');
    assert.equal(m.length, src.length, '必须保长度，否则行号与列号会漂');
  });

  test('嵌套插值不许把后面的代码吃掉', () => {
    const src = 'const a = `x${ obj?.f( y ) ?? `inner${deep(v)}` }y`;\nexport function afterMe() {}\n';
    const m = codeMask(src);
    assert.ok(m.includes('afterMe'), '插值还原不许越界吃掉后续代码');
    assert.ok(m.includes('deep'), '嵌套那一层的插值也要还原（内层是内层的表达式）');
    assert.equal(m.length, src.length);
  });
});

describe('真仓库上的夹具有效性（只问"已知活的别被报死"）', () => {
  const res = scan(ROOT);

  test('扫描器本身收得到东西（不是靠"报零"蒙对）', () => {
    assert.ok(res.decls > 200, `只抽到 ${res.decls} 个导出声明 —— 抽取器大概漂了`);
    assert.ok(res.files > 150, `只走到 ${res.files} 个文件 —— 扫描范围缩了`);
  });

  test('几个必然活的导出不许出现在任一档里', () => {
    const reported = new Set([...res.unused, ...res.testOnly].map((d) => d.name));
    // 这几个的调用点都在生产代码里，且**至少有一处写在模板字符串或转发之外**，
    // 所以它们是判据的正面样本：判据任何一侧塌掉，这里就会红
    for (const live of ['parseScenario', 'walk', 'lintScenario', 'coverageDelta', 'maskNonCode']) {
      assert.ok(!reported.has(live), `${live} 明明有生产调用方却被报了出来`);
    }
  });

  test('coverageDelta 不再落在 testOnly 里（本轮刚给它接上 cmdGen）', () => {
    /*
     * 这一条是本轮那件事的收尾凭据：它挂着"函数有、测试有、生产侧零调用"
     * 两三轮，而**字段级的守卫永远看不见那个形状** —— 这道守卫就是为它建的。
     * 所以守卫交付的判据不是"能报出东西"，是"那一格现在是空的"。
     */
    assert.ok(!res.testOnly.some((d) => d.name === 'coverageDelta'),
      'coverageDelta 又变回只有测试在调了 —— cmdGen 那条调用路径断了');
  });

  test('当前 unused 那一档是空的（有牙测试证明这不是因为抽取器空转）', () => {
    assert.deepEqual(res.unused.map((d) => `${d.name} (${d.file})`), [],
      '有新出现的"三处零引用"导出：删掉它，或接上并留一条断言');
  });
});
