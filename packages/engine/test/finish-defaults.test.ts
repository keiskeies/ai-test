/**
 * **`StepResultSchema` 声明必填的那些键，运行时必须真的在。**
 *
 * ## 起因（本轮实测）
 *
 * `interpreter.ts` 的 `finish()` 原来把默认值写在 `...extra` **前面**：
 *
 * ```ts
 * { retry: 0, healed: false, nonReplayable: false, artifactIds: [], keyContext: {}, ...extra }
 * ```
 *
 * 而 dispatch 那条调用点传的是 `keyContext: outcome.keyContext` ——
 * `StepOutcome.keyContext` 是可选的，没做断言的步骤它就是 `undefined`。
 * **对象展开不认识"这个键在 schema 里必填"**：显式的 `undefined` 把默认值吃掉。
 * `Partial<StepResult>` 让这一行编译通过，而 `StepResult` 的类型说那个键必有。
 *
 * 实测（set / sequence / noop 三种步骤，**每一行**都命中）：
 *
 * ```
 * healed / nonReplayable / keyContext 三键在内存里是 undefined
 * retry / costUsd / artifactIds 侥幸没中 —— 只因为那两个调用点恰好写了 `?? 0`
 *   和条件展开。是运气，不是设计。
 * ```
 *
 * 两个方向的后果各有一条测试在下面：
 *  - **内存侧**：`r.keyContext.truncated` 编得过、跑必炸。本轮 html.ts 那条新判据
 *    就是这么炸的，**炸在引擎自己产出的 report 上**，不是测试夹具缺字段 ——
 *    所以"少一个 `?.`"这种解释是错的，错的是这里的默认值。
 *  - **磁盘侧**：`JSON.stringify` 整个丢掉值为 undefined 的键，于是证据包里落的是一份
 *    **缺 strict schema 必填键**的 StepResult。`parseStepResults` 读回来时靠 `.default()`
 *    补齐，所以"写出去不合格式"这件事只有自己那条读回路径看得见 —— 而那条路径是绿的。
 *
 * ## 判据为什么从 schema 派生
 *
 * 本文件不写死一份键清单。手写那份就漏过一格：加字段的人不会顺手想起这里，
 * 症状是"某个新键悄悄是 undefined 而没人报错"（docs/08 §3 那一族的"下半截没人接"）。
 * 现在 required 列表从 `StepResultSchema` 现取，**加一个必填键而 finish() 不兜底，
 * 这个文件立刻变红**。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';
import { StepResultSchema } from '@atest/ir';
import { run, scen, b, type StepDraft } from './helpers.js';
import { parseStepResults } from '../src/index.js';

/** 磁盘格式的必填键（与 .strict() 那份 schema 同源，不手抄） */
const REQUIRED = (z.toJSONSchema(StepResultSchema, { io: 'output' }) as { required?: string[] }).required ?? [];

/** 覆盖到 dispatch 那条调用点（set 走的是"有 outcome、无 keyContext"那一支） */
const shapes: Array<[string, StepDraft[]]> = [
  ['叶子 set（走 dispatch，keyContext 在 outcome 上是 undefined）', [{ ...b('st'), kind: 'set', assign: { n: 1 } } as StepDraft]],
  ['容器 sequence + 体内叶子', [{ ...b('seq1'), kind: 'sequence', steps: [{ ...b('inner'), kind: 'set', assign: { m: 2 } } as StepDraft] } as StepDraft]],
  ['noop', [{ ...b('np'), kind: 'noop' } as StepDraft]],
  ['截断的 forEach（这一支是**真带** keyContext 的，用来证明修法没把有值的形状洗成空对象）', [
    { ...b('v'), kind: 'set', assign: { list: [1, 2, 3, 4, 5] } } as StepDraft,
    { ...b('fe'), kind: 'forEach', items: '$list', as: 'x', maxIterations: 2,
      steps: [{ ...b('body'), kind: 'noop' } as StepDraft] } as StepDraft,
  ]],
];

describe('schema 必填 => 运行时真在（内存侧）', () => {
  test('每种形状的每一行，必填键都不是 undefined', async () => {
    assert.ok(REQUIRED.length >= 8, `从 schema 取到的 required 只有 ${REQUIRED.length} 个键，这个判据本身可能已经空转：${REQUIRED.join(',')}`);
    for (const [name, body] of shapes) {
      const r = await run(scen(body));
      assert.ok(r.results.length > 0, `${name} 一个结果都没有 —— 那下面所有断言都会空转通过`);
      for (const row of r.results) {
        const missing = REQUIRED.filter((k) => (row as unknown as Record<string, unknown>)[k] === undefined);
        assert.deepEqual(missing, [], `${name} / 步骤 ${row.stepId}：schema 必填却是 undefined 的键 = ${missing.join(',') || '无'}`);
      }
    }
  });

  test('有值的 keyContext 不被默认值洗掉（反方向）', async () => {
    /*
     * 只测"不再是 undefined"不够：把 keyContext 一律写成 `{}` 也能让上一条全绿，
     * 而那是把断言的失败上下文全丢了。所以这里要一行**真带内容**的。
     */
    const r = await run(scen(shapes[3]![1]));
    const row = r.results.find((x) => x.stepId === 'fe')!;
    assert.ok(Object.keys(row.keyContext).length > 0, `dispatch 带回来的 keyContext 被洗成空对象了：${JSON.stringify(row.keyContext)}`);
  });
});

describe('schema 必填 => 磁盘上也真在（写出去就合格式）', () => {
  test('一行结果 JSON 往返后**不需要**靠 default 补键', async () => {
    /*
     * 这是那条"只有自己写的那条读回路径看得见"的正面堵法。
     * 判据刻意不是"parse 不报错"（parse 靠 .default() 一定不报错），
     * 而是**序列化之后的字节里有这些键** —— 缺键的产物对下游 jq / 看板是
     * "这个字段不存在"，与"这个字段是 false"不是一回事。
     */
    for (const [name, body] of shapes) {
      const r = await run(scen(body));
      for (const row of r.results) {
        const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
        const missing = REQUIRED.filter((k) => !(k in wire) || wire[k] === undefined);
        assert.deepEqual(missing, [], `${name} / ${row.stepId}：落盘字节里缺必填键 ${missing.join(',')}（parse 读回时靠 default 补齐，所以读回路径看不见这件事）`);
      }
    }
  });

  test('往返后**在磁盘形态下**逐字段相等（默认值不是"读回来才像对的"）', async () => {
    /*
     * 两边都先过一遍 JSON 再比。第一次这里写的是直接 `deepEqual(back, r.results)`，
     * 它红了，而红得**没有道理**：内存里的行带着 `cause: undefined`、
     * `confidence: undefined` 这类**可选**键（显式写了这个键、值是 undefined），
     * `JSON.stringify` 把它们整个丢掉，于是 parse 回来的对象里没有它们。
     * 那不是缺陷（schema 上这些键可选），而我的断言把"内存对象的键集合"
     * 当成了判据 —— 判据应该落在**磁盘形态**上，因为下游看到的只有那个形态。
     */
    for (const [name, body] of shapes) {
      const r = await run(scen(body));
      const back = parseStepResults(JSON.parse(JSON.stringify(r.results)));
      assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(r.results)),
        `${name}：磁盘形态往返后不一致 => 内存那份本来就不合磁盘格式`);
    }
  });
});
