/**
 * `src-text.ts` 那个"剥注释"辅助自己的测试。
 *
 * 它服务于两条"扫源码文本核对 schema"的测试（`expr-fields.test.ts`、
 * `wait-expr-fields.test.ts`），而那些测试的**全部效力**来自"扫到的就是代码"。
 * 所以这个辅助坏掉的时候，坏法是**让那两条测试静默恒通过** —— 本仓最贵的那一类。
 * 于是它自己要有钉子，而不是"看着简单就不测"。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { stripComments } from './src-text.js';

const SRC_DIR = join(import.meta.dirname, '../src');

test('块注释与行注释都剥得掉，而代码留着', () => {
  const sample = [
    '/** 假想字段 `{type: z.literal(\'x\'), exprEq: ExprSchema}` 只是举例 */',
    "export const A = z.object({ kind: z.literal('a'), expr: ExprSchema }).strict(); // 行尾注释里的 ExprSchema 不算",
    'export const B = 1;',
  ].join('\n');
  const out = stripComments(sample);
  assert.ok(!out.includes('exprEq'), '块注释没剥掉：散文里的假想字段会被当成真字段');
  assert.ok(!/ExprSchema\s*$/.test(out.split('\n')[1]!.replace(/^\s+/, '')), '行尾注释没剥掉');
  assert.match(out, /kind: z\.literal\('a'\)/, '代码被剥掉了：扫描会恒通过，比误报更坏');
  assert.match(out, /expr: ExprSchema/, '真字段被剥掉了');
});

test('`://` 不会被当成行注释（URL 出现在代码里时不能连后面半行一起吃掉）', () => {
  const out = stripComments("const u = 'https://x.test/a'; const keep = ExprSchema;");
  assert.match(out, /keep = ExprSchema/, 'URL 之后的代码被吃掉了：辅助需要换成真正的 tokenizer');
});

/*
 * 上面那条只测了"写法"。真正的前提是**本仓 IR 源码里今天没有含 // 的字符串字面量**
 * （`stripComments` 不做字符串识别，见那个文件里写的理由）。
 * 这条测的就是那个前提本身 —— 它红的那天，要做的是把辅助换成 tokenizer，
 * **不是**把另外两条测试放宽。
 */
test('前提仍然成立：IR 源码里没有一个字符串字面量含 `//`', () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 8, `只看到 ${files.length} 个 IR 源文件，这条扫描本身不可信`);
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(SRC_DIR, f), 'utf8');
    // 先剥掉注释再看剩下的 //，剩下的就只可能来自字符串（或正则字面量，本仓 IR 里没有）
    const noComment = stripComments(text);
    for (const line of noComment.split('\n')) {
      if (line.includes('//')) hits.push(`${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, [], '出现了含 // 的非注释文本：stripComments 会把这一行后半段吃掉，'
    + '而"扫源码核对 schema"那两条测试会因此静默漏扫。修法是把辅助换成 tokenizer。');
});
