/**
 * `STEP_KINDS_THAT_EXPORT` 与解释器**不能分叉**（缺陷类 (e)：有生产者、没有载体）。
 *
 * ## 这一族缺陷为什么在这里最贵
 *
 * 这份清单决定静态闸对 `$.step.<id>.*` 的全部判定。它和解释器分叉的方向不对称：
 *  - 清单**少了**一种（本次的 `set` 就是）：合法 IR 被 `--strict` 拒之门外，
 *    作者的出路是关掉 --strict —— 整条闸在 CI 里静默消失；
 *  - 清单**多了**一种：假引用过了静态闸，到运行时炸成 error(cause=case-stale)。
 *
 * 两个方向的症状都是"闸说的话不可信"，而 docs/08 §3 给这类缺陷开过的方子只有一个：
 * **让两份清单在测试里对撞**，而不是在注释里互相引用。
 *
 * ## 对撞的方式
 *
 * 从 `interpreter.ts` 源码里把 `exportStep(` 的调用点抠出来，按所属 `case` 分支归位，
 * 与导出的清单比集合。用源码而不是用"跑遍所有步骤类型看谁导出"，理由：
 * 跑的话要构造每种 kind 都能执行到 exportStep 那一行的夹具（db/adapter/子场景
 * 全都要装桩），夹具本身会成为第二份需要维护的"哪些 kind 能跑"的清单 —— 恰好是
 * 这条测试要防的形状。源码扫描读的是**唯一的那份真相**（switch 本身），
 * 判据与被检物之间没有第三份手抄。
 *
 * 解析器只认两种形态（写在这个文件里，形态一改解析就抛，不会静默漏）：
 * `case 'x': … vars.exportStep(`（assert 家族那种共享 case 行），
 * 与 `case 'x': {` 开块后块内的裸 `exportStep(`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEP_KINDS_THAT_EXPORT } from '../src/lint.js';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const INTERPRETER = join(ROOT, 'packages/engine/src/interpreter.ts');

/**
 * 从解释器源码推出"哪些 kind 会 exportStep"。
 * 返回值的每一项都必须能归到一个 `case '<kind>'`，否则抛 ——
 * 静默归不进来说明解释器改了写法（比如抽成函数），那时这条测试要**响**，
 * 因为写法一改，本测试与清单的对撞就名存实亡了。
 */
function kindsExportingInSource(): Set<string> {
  const lines = readFileSync(INTERPRETER, 'utf8').split('\n');
  const out = new Set<string>();
  // 当前所在的 case 标签集合。`case 'a': case 'b': {` 这种共享一行要全收
  // （assert 家族就是这么写的），所以下面用 matchAll 而不是只取第一个。
  let currentCase: string[] = [];
  for (const line of lines) {
    // 一行里可能连着好几个 case 标签（`case 'assert': case 'assertPage': {`），全收
    if (/^\s*case '/.test(line)) currentCase = [...line.matchAll(/case '([\w]+)'/g)].map((m) => m[1]!);
    if (!/\bvars\.exportStep\(/.test(line)) continue;
    if (currentCase.length === 0) {
      throw new Error(`interpreter.ts 里有一处 exportStep 不在任何 case 分支里：${line.trim()}\n`
        + '  —— 本测试的解析器不认识这种写法，请更新解析器（**不要**改清单凑数）');
    }
    for (const k of currentCase) out.add(k);
  }
  if (out.size === 0) throw new Error('一个 exportStep 调用点都没扫出来 —— 解析器或解释器结构变了，这条测试现在什么都没判');
  return out;
}

test('STEP_KINDS_THAT_EXPORT 与解释器里 exportStep 的调用点**一字不差**', () => {
  const fromSource = kindsExportingInSource();
  const fromList = new Set<string>(STEP_KINDS_THAT_EXPORT);
  const missing = [...fromSource].filter((k) => !fromList.has(k));
  const extra = [...fromList].filter((k) => !fromSource.has(k));
  const msgs: string[] = [];
  if (missing.length) {
    msgs.push(`解释器会导出、清单却没登记：${missing.join(', ')}`
      + '\n  后果：引用这类步骤输出的**合法 IR** 被 --strict 拒（就是 set 那次）。'
      + '\n  修法：把缺的 kind 加进 lint.ts 的 STEP_KINDS_THAT_EXPORT，并想清楚按名检查那格填不填名字集合。');
  }
  if (extra.length) {
    msgs.push(`清单登记了、解释器却不导出：${extra.join(', ')}`
      + '\n  后果：假引用过了静态闸，运行时炸成 error(cause=case-stale)。'
      + '\n  修法：删掉多的 kind；若是解释器把 exportStep 挪走了，同步两边的注释。');
  }
  assert.deepEqual(msgs, [], msgs.join('\n\n'));
});

test('清单里每个 kind 都真实存在于 IR 的步骤类型里（防拼错的 kind 静默失效）', async () => {
  // `satisfies readonly Step['kind'][]` 在**编译期**就管住了这件事，
  // 但那是类型层的。这里在运行层再判一次的理由只有一条：
  // tsc -b 是增量构建，而这份测试是行为层的证据（也是 typecheck 被跳过时的兜底）。
  const irText = readFileSync(join(ROOT, 'packages/ir/src/steps.ts'), 'utf8');
  const kinds = new Set([...irText.matchAll(/z\.literal\('([\w]+)'\)/g)].map((m) => m[1]!));
  for (const k of STEP_KINDS_THAT_EXPORT) {
    assert.ok(kinds.has(k), `清单里的 "${k}" 在 steps.ts 里不是任何步骤的 kind —— 它永远不会命中，等于清单里躺了个幽灵`);
  }
});
