/**
 * `dead-iface-fields.mjs` —— 幽灵 interface 字段守卫的测试。
 *
 * 一道报"没有死字段"的绿**本身不可信**（扫描器抽不到任何东西时不会报错，
 * 它只会报告干净 —— `unread-fields.mjs` 文件头同一条教训）。所以这个文件的主产品是
 * **这条线有牙**的证据：
 *  ① 把本轮删掉的那个真死字段加回仓库 ⇒ 必须红，且**只**报它一个；
 *  ② 自检下限：扫不到足够多字段时那句"✓"不许算通过；
 *  ③ 抽取器在四种 interface 写法上都收得到字段（单行、泛型、extends、多行）；
 *  ④ 掩码：注释与字符串里的同名词不许救活一个死字段；
 *  ⑤ 宽松判据的假阳性率在**当前仓库上现场算**（不抄写死的读数）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { maskNonCode } from '../unread-fields.mjs';
import { countCodeMentions, extractInterfaceFields, listSourceFiles, maskTexts, report, scan } from '../dead-iface-fields.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

/** 造一份小语料，返回 scan 内部那两个判据函数要的三件套 */
function corpus(files) {
  const texts = maskTexts(new Map(files.map((f) => [f, readFileSync(f, 'utf8')])));
  return { files, texts };
}
/** 在 a.ts 里找一个字段的声明位置（start/end 指向它自己那段 interface body） */
function declOf(a, name) {
  const texts = readFileSync(a, 'utf8');
  const rec = extractInterfaceFields(a, texts).find((r) => r.field === name);
  assert.ok(rec, `语料里没抽到字段 ${name} —— 抽取器漂了，这些断言全都在测别的东西`);
  return { file: a, start: rec.start, end: rec.end };
}

describe('抽取器：四种 interface 写法都要收得到字段', () => {
  /*
   * 每一条对应一个**真实漏报过**的形状，不是我设想的：
   * 单行那一格是本轮 `.scratch` 探针量出来的 —— `interface B { deep: number }`
   * 整段抽不出字段，因为字段正则从前只认"行首的 name:"，而 `deep` 前面是 `{`。
   * 修法分两步（都各自是必要的一半）：切片从 `{` 那一格开始 + 前置断言认 `{`。
   */
  const cases = [
    ['多行', 'export interface A {\n  plain: string;\n}', 'A.plain'],
    ['单行', 'interface B { deep: number }', 'B.deep'],
    ['泛型', 'interface G<T> {\n  v: T;\n}', 'G.v'],
    ['extends', 'interface E extends F {\n  a: number;\n}', 'E.a'],
    ['readonly 前缀', 'interface R {\n  readonly ro: string;\n}', 'R.ro'],
  ];
  for (const [name, src, want] of cases) {
    test(`${name} 写法的字段收得上来`, () => {
      const got = extractInterfaceFields('t.ts', src).map((f) => `${f.iface}.${f.field}`);
      assert.ok(got.includes(want), `只收到 ${JSON.stringify(got)}，少了 ${want}`);
    });
  }

  test('内层对象的键**不算**外层字段（否则每个内联类型都造假字段）', () => {
    const got = extractInterfaceFields('t.ts', 'export interface A {\n  nested: { x: string };\n}').map((f) => f.field);
    assert.deepEqual(got, ['nested'], `内层那个 x 被当成 A 的字段了：${got.join(', ')}`);
  });

  test('方法别名不算字段（`close(): Promise<void>` 那种）', () => {
    const got = extractInterfaceFields('t.ts', 'export interface S {\n  close(): Promise<void>;\n}').map((f) => f.field);
    assert.deepEqual(got, [], `方法名被当字段收了：${got.join(', ')} —— 那"零提及"判据会拿它报假阴`);
  });

  test('注释里的 interface 例子不产字段（docs 里的代码块不该被扫成契约）', () => {
    const got = extractInterfaceFields('t.ts', '/**\n * 例：\n * interface Ghost { unused: string }\n */\nexport const x = 1;\n');
    assert.deepEqual(got, [], `注释里的示例被当成真字段：${got.map((g) => g.field).join(', ')}`);
  });
});

describe('提及计数：什么算"有人碰"', () => {
  test('成员访问 / 解构 / 建对象 / spread 都算碰（词法上看得见的那些）', () => {
    const dir = join(tmpdir(), `dif-hits-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const a = join(dir, 'a.ts'), b = join(dir, 'b.ts');
    writeFileSync(a, 'export interface Opts { member: string; destructed: string; built: string; dead: string; }\n');
    writeFileSync(b, "const { destructed } = {};\nconst v = { built: '' };\nv.member;\n");
    const { files, texts } = corpus([a, b]);
    for (const n of ['member', 'destructed', 'built']) {
      assert.ok(countCodeMentions(n, files, texts, declOf(a, n)) >= 1, `${n} 该被算成有人碰`);
    }
    assert.equal(countCodeMentions('dead', files, texts, declOf(a, 'dead')), 0, 'dead 该是 0');
  });

  test('注释与字符串里的同名词**不算**碰（否则散文能救活死字段）', () => {
    const dir = join(tmpdir(), `dif-mask-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const a = join(dir, 'a.ts'), b = join(dir, 'b.ts');
    writeFileSync(a, 'export interface Opts { ghost: string; }\n');
    writeFileSync(b, "// 将来 ghost 可以接上\nconst s = 'ghost';\nconst t = `ghost ${1}`;\n");
    const { files, texts } = corpus([a, b]);
    assert.equal(countCodeMentions('ghost', files, texts, declOf(a, 'ghost')), 0,
      '注释或字符串里的 ghost 被当成了读它');
    // 反面向：掩码本身有效（同一份 b.ts 里放一处真代码，必须算命中）
    writeFileSync(b, "// ghost 只是提一下\no.ghost;\n");
    const again = corpus([a, b]);
    assert.ok(countCodeMentions('ghost', again.files, again.texts, declOf(a, 'ghost')) >= 1,
      '掩码把真代码也抹了 —— 那守卫会把有人读的字段报成死的');
  });

  test('只挖掉**自己那一段** body：别处同名 interface 的声明照数', () => {
    const dir = join(tmpdir(), `dif-dupe-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const a = join(dir, 'a.ts');
    writeFileSync(a, 'export interface Opts { v: string; }\ninterface Other { v: number }\nconst o: Other = { v: 1 };\n');
    const { files, texts } = corpus([a]);
    const n = countCodeMentions('v', files, texts, declOf(a, 'v'));
    assert.ok(n >= 1, '别的 interface body 里对同名字段的使用被一起挖掉了 —— 会把有人碰的报成死的');
  });
});

describe('在本仓库上（这条是那道守卫的"有牙"证据）', () => {
  test('自检下限：扫到的字段数不许小到让"✓"空转出来', () => {
    const r = scan(ROOT);
    assert.ok(r.fields.length >= 200, `只扫到 ${r.fields.length} 个字段，"零死字段"不可信`);
    // 空转的那一侧也要能红：把上限拿掉的话，抽不到东西时 report 该判失败
    const empty = report({ files: 0, fields: [], dead: [], inconclusive: [] });
    assert.equal(empty.failed, true, '扫到 0 个字段时 report 还判通过 = 抽取器整个坏掉也没人知道');
  });

  test('真仓库现在是干净的，且本轮删掉那两个不许悄悄长回来', () => {
    /*
     * ⚠ **这一条不改任何被跟踪的文件**。它从前写的是"把 `ServeOptions.onOutput`
     * 加回 `packages/server/src/index.ts`、跑 scan、再还原" —— 那个写法我已经
     * 被它咬过一次：一次跑到中途被中断的运把变异留在了文件里，
     * 靠 `grep` 才发现（还原靠的是 finally，而**进程被杀时 finally 不跑**）。
     * 本仓改被跟踪文件是有专门机器的（`tooling/mutate.mjs`：单实例锁 + 开跑前查残留），
     * 一条测试不该绕过它去碰同一格。"有牙"那一半改由下面那条在临时目录里证。
     */
    const r = scan(ROOT);
    assert.deepEqual(r.dead, [], `现在就有死字段：${r.dead.map((d) => d.key).join(', ')}`);
    // 本轮删掉的两个，点名钉住（长回来时上面那条会红，这条额外说出是哪一个）
    for (const gone of ['ServeOptions.onOutput', 'AxNode.backendDOMNodeId']) {
      assert.ok(!r.fields.some((f) => `${f.iface}.${f.field}` === gone), `${gone} 又回来了`);
    }
  });

  test('有牙：临时仓库里放一个死字段 => 报得出且只有它一个（不碰真仓库）', () => {
    /*
     * 造一份最小仓库布局（`packages/<pkg>/src/*.ts`），scan(root) 本来就吃 root 参数。
     * 里面放三种字段各一个：死的、只有 1 次提及的（判不出那一档）、有 3 次提及的。
     * 只有第一个该进 dead —— 这同时是"能红"与"不放宽到误报"两侧的证据。
     */
    const dir = join(tmpdir(), `dif-repo-${process.pid}`);
    const src = join(dir, 'packages', 'demo', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.ts'),
      'export interface Opts {\n  ghost: string;\n  thin: string;\n  thick: string;\n}\n');
    writeFileSync(join(src, 'b.ts'),
      "import type { Opts } from './a.js';\nconst o = {} as Opts;\no.thin;\no.thick; o.thick; o.thick;\n");
    try {
      const r = scan(dir);
      assert.ok(r.fields.length >= 3, `临时仓库里只扫到 ${r.fields.length} 个字段，夹具没生效`);
      assert.deepEqual(r.dead.map((d) => d.key), ['Opts.ghost'],
        `该报且只报 ghost，实际：${r.dead.map((d) => d.key).join(', ') || '（无）'}`);
      assert.equal(report(r).failed, true, '有死字段时 report 必须判失败');
      // 判不出那一档：thin（1 次）在里面，thick（3 次）不在
      assert.ok(r.inconclusive.some((d) => d.key === 'Opts.thin'), '1 次提及的该进"判不出"，让人看得见盲区');
      assert.ok(!r.inconclusive.some((d) => d.key === 'Opts.thick'), '3 次提及的还在报，那一档就太吵了');
      // 干净的那一侧：把 ghost 用上去之后，同一个 root 就该判通过
      writeFileSync(join(src, 'b.ts'),
        "const o = {} as import('./a.js').Opts;\no.ghost;\no.thin; o.thin; o.thick; o.thick; o.thick;\n");
      // 夹具只有 3 个字段，用默认下限（真实仓库那一档）必然报"扫描不可信" ——
      // 那是**对的**，所以这里降下限，只问"还有没有死字段"
      const clean = report(scan(dir), { minFields: 1 });
      assert.equal(clean.failed, false, `字段接上之后还判失败：${clean.lines.join(' / ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('宽松判据现场算：它点名的数量远大于严格判据，这就是"只做最严一档"的理由', () => {
    /*
     * 这一条是"为什么这道守卫只做最严那一档"的**活证据**，读数每次现算 ——
     * 抄一份"上次跑出来 26 个"的话，仓库一长它就变成带"实测"字样的假话
     * （本仓对这个的名字是「错误会说谎」）。
     *
     * ⚠ 这一条**从前写的是另一个断言**，而那句是错的：我写的是
     * 「被宽松判据点名的字段，严格判据都不该说死」，读起来像个不变式，
     * 其实是我把"宽松判据会误报"错写成"宽松判据点名的都不是真死的"。
     * 它**当场被 `AxNode.backendDOMNodeId` 否掉**（两条判据都说它死，而它确实死 ——
     * 那是本轮删掉的第二个字段）。真死的字段被两条判据同时点名是完全正常的，
     * 两条判据之间没有谁包含谁。所以这里只断言**量级关系**：
     * 宽松判据的命中数远大于严格判据 —— 用它当红线的话，绝大多数报警是误报，
     * 而误报的守卫比没守卫更坏（它教会大家无视这条线）。
     */
    const files = listSourceFiles(ROOT);
    const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    const masked = maskTexts(texts);
    const all = [];
    for (const f of files) {
      for (const rec of extractInterfaceFields(f, texts.get(f))) { rec.abs = f; all.push(rec); }
    }
    const srcMasked = new Map([...masked].filter(([f]) => f.includes('/src/')));
    const loose = all.filter((rec) => {
      const re = new RegExp(`\\.${rec.field}\\b`);
      return ![...srcMasked.values()].some((t) => re.test(t));
    });
    const strictDead = all.filter((rec) =>
      countCodeMentions(rec.field, files, masked, { file: rec.abs, start: rec.start, end: rec.end }) === 0);
    assert.ok(loose.length >= 10,
      `宽松判据只点出 ${loose.length} 个 —— 与"它会大量误报"这个前提矛盾，去重查文件头那段论证`);
    assert.ok(loose.length >= strictDead.length * 5,
      `宽松 ${loose.length} / 严格 ${strictDead.length} —— 两者量级接近的话，"只做最严一档"的取舍要重新论证`);
  });

  test('入口判据：被 import 时不跑 main（否则测试一 import 就 process.exit）', async () => {
    // 上面所有测试都在 import 之后活着跑到这里，本身就说明没退出；
    // 这一条把"为什么它必须不退出"钉住：入口判据与 unread-fields.mjs 不一致时，
    // 要么工具不跑，要么一被 import 就把测试进程杀掉。
    const src = readFileSync(join(ROOT, 'tooling/dead-iface-fields.mjs'), 'utf8');
    assert.match(src, /fileURLToPath\(import\.meta\.url\)\s*===\s*resolve\(process\.argv\[1\]\)/,
      '入口判据与 unread-fields.mjs 不是同一个写法');
    assert.equal(typeof scan, 'function');
  });
});
