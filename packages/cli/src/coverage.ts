/**
 * 覆盖增量预览的**供数侧**：把"已有用例覆盖了哪些 `operationId × strategy` 组合"
 * 从磁盘上的 IR 文件里读出来，交给引擎那边的 `coverageDelta` 算增量。
 *
 * 为什么这一格住在 CLI 而不是引擎：判据是"磁盘上有哪些文件"，那是文件系统的事，
 * 而 `@atest/engine` **禁止 import 任何 node 内置模块**（tooling/lint-layers.mjs 强制）。
 * 引擎那边留的是纯函数 —— 它拿到两份组合清单就能算，谁来供数它不知道也不需要知道。
 *
 * ⚠ **这一格曾经没有调用方**（函数、测试都有，生产侧零调用），
 * 那是 docs/08 §3(e)「有生产者、没有载体」那一类：一栏"设计上的唯一手段"
 * 挂在文档里而没人算它，读文档的人会以为生成器劝得动过度生成。
 * 调用方是 `cmdGen`，判据与开关写在它里面。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { coverageDelta, type CoverageKey } from '@atest/engine';
import { parseScenario, walk, type Scenario } from '@atest/ir';

import { stripJsonComments } from './wiring.js';

/** 供数结果。`scanned` / `notIr` / `broken` 三个数**都要印出来**，理由见 coveragePreview 末尾 */
export interface ExistingCoverage {
  keys: CoverageKey[];
  /** 扫过的 `.json`/`.jsonc` 文件数（含被跳过的） */
  scanned: number;
  /** 明显不是 IR 的文件数（没有 `id` + `body` 那样的形状） */
  notIr: number;
  /** 看着像 IR 而**校验不过**的文件数 —— 它们的覆盖是真的但读不出来 */
  broken: number;
}

/**
 * 递归读一个目录里所有 IR 文件的**已有组合**。
 *
 * 判据：**只看能读出来的**。读不出来的文件不报错、不中断 —— 这一栏的用途是
 * "少生成一点"，为一个坏文件把整次生成打断是错的比例（`atest lint` 才是报错的地方）。
 * 但**必须数出来并印出去**：静默跳过会让"已有"偏小而把已有的组合报成新增，
 * 那正好是这个功能设计上唯一会造成伤害的方向（把一条有用的用例劝掉）。
 *
 * "看着像 IR"的判据是 JSON 里有字符串 `id` 和数组 `body`。
 * 不用"能不能 parseScenario"来分：那样 evidence 目录里的 `run.json` 这类
 * 根本不是用例的文件会被算成"坏 IR"，而报出来的数字会让人去修一个不存在的问题。
 * 代价是反过来那种 —— 有人把 `body` 写成 `steps`，这里既不算覆盖也不报坏，
 * 那个方向只会**多报新增**（顶多多生成一条），比少报新增轻。
 */
export async function existingCombinations(dir: string): Promise<ExistingCoverage> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true }) as string[];
  } catch {
    // 目录不存在 = 还没有任何用例。这是 gen 最常见的首次运行状态，不是错误
    return { keys: [], scanned: 0, notIr: 0, broken: 0 };
  }
  const keys: CoverageKey[] = [];
  let scanned = 0;
  let notIr = 0;
  let broken = 0;
  for (const name of names) {
    if (!/\.jsonc?$/.test(name)) continue;
    scanned++;
    let raw: unknown;
    try {
      raw = JSON.parse(stripJsonComments(await readFile(join(dir, name), 'utf8')));
    } catch {
      // 语法错或读不到（坏符号链接、权限）。它没有 id/body 可依，只能算"不像 IR"
      notIr++;
      continue;
    }
    const looksIr = typeof (raw as { id?: unknown })?.id === 'string'
      && Array.isArray((raw as { body?: unknown })?.body);
    if (!looksIr) { notIr++; continue; }
    const r = parseScenario(raw);
    if (!r.ok || !r.scenario) { broken++; continue; }
    keys.push(...bodyCombinations(r.scenario));
  }
  return { keys, scanned, notIr, broken };
}

/**
 * 一个场景**测**了哪些组合 —— 只走 `body`，不走 `setup` / `teardown`。
 *
 * 这条判据是本文件唯一一处会让人争议的写法，所以把两边代价都写下来：
 * 前置与清理里的调用是为了把系统摆成可测的样子，不是这条用例的主题。
 * 把它们算进"已有覆盖"，一条测 `createOrder/boundary` 的用例会因为它的 setup 里
 * 有个 `login/happyPath` 就顺带把 `login/happyPath` 记成已有，
 * 于是预览报"0 新增，建议别生成" —— 而那个组合其实从没被人当主题测过。
 * **少报一次新增正好会把一条有用的用例劝掉**（`coverageDelta` 函数头同一条），
 * 而多报一次新增只是多生成一条，所以这里选多报的那一侧。
 *
 * `body` 用 `walk` 而不是只扫顶层：循环体 / switch 分支里的调用同样是主题
 * （`statefulSequence` 那类策略就是这么生成的）。
 *
 * ⚠ **两个字段齐了才算**：`strategy` 在 IR 里是 optional，
 * 手写用例常常不填，于是它对"已有"没有贡献 —— 后果是已有组合偏小而多报新增，
 * 是上面那个可容忍的方向。真要让它闭嘴就把 `strategy` 变成必填，
 * 但那会让所有手写用例立刻不合法，不是这一栏该付的代价。
 */
export function bodyCombinations(scenario: Scenario): CoverageKey[] {
  const out: CoverageKey[] = [];
  walk(scenario.body, (s) => {
    const st = s as unknown as { kind?: string; operationId?: unknown; strategy?: unknown };
    if (st.kind !== 'openapiCall') return;
    // **空串按"没有"处理**，与缺字段同一档。这条是测试逼出来的：IR 里
    // `operationId` 是 `z.string().optional()` 而**没有 min(1)**，所以 `""` 是合法 IR，
    // 只判 `typeof === 'string'` 会把它算成键 `""/happyPath`。
    // 危害方向：所有漏填 operationId 的用例在**同一个假键上互相盖掉**，
    // 于是预览会说"这个组合已有" —— 而它对应不到任何一个真实 operation。
    // 少报一次新增正是这一栏唯一会造成伤害的方向（把有用的用例劝掉）。
    // 为什么不在 IR 那边加 min(1)：operationId 本来就是 optional
    // （可以用 method+path 定位），收紧它会打回现有手写用例 —— 那是另一笔代价。
    if (typeof st.operationId !== 'string' || !st.operationId) return;
    if (typeof st.strategy !== 'string' || !st.strategy) return;
    out.push({ operationId: st.operationId, strategy: st.strategy });
  });
  return out;
}

/**
 * 算并渲染这一栏。**引擎那个 `coverageDelta` 只在这里被调用**（生产侧唯一调用方），
 * 收在一个函数里是为了让"两侧共用同一个判据"这件事没法被拆开：
 * 如果 commands.ts 自己算新增的那一侧、这里算已有的那一侧，
 * 两边对"什么算一个组合"的假设就会分叉，而那种分叉的读数永远看着挺正常
 * （docs/08 §3「每个消费者都各自正确，而它们对同一件事的假设互不相容」）。
 *
 * ⚠ **喂给 `coverageDelta` 之前两侧都按组合去重**，这是本轮改的第二处判据，
 * 而它推翻了我自己第一版的输出：
 * 一开始我把每条调用当一个元素喂进去，于是 boundary 那种
 * "一个场景里六条同组合调用"（六个边界值，同一组合 —— 这是**设计如此**，
 * 每个边界值都该打一次）被算成五个"批内重复"，我照着那个数字印了一句
 * 「一个场景留一条就够」。那句话是错的建议：真按它做就只剩一个边界值，
 * 而 boundary 策略的意义恰好是其余五个。**计数没错，判据错了** ——
 * 这个函数的单位是"组合"，把"调用"喂进去制造了一个不存在的问题，
 * 然后我花力气解释它。去重之后 `duplicates` 只剩"磁盘上已有"那一类，
 * 于是这一栏里每个词都对应得上处置动作。
 *
 * ⚠ **只提示、不裁剪。** 一句话说明为什么：这一栏要是真把"0 新增"的那批从
 * 待写清单里抹掉，一次读盘读漏（目录名写错、下面那格 `broken`）就会变成
 * **静默少生成**，而那正是 docs/00 §6.1 列的四个失效模式之一。
 * 数字报错的代价是多打几行字，用例被抹掉的代价没人能从输出里看出来。
 *
 * 返回值走 `err` 而不是 `out`：`out` 是"将写入哪些文件"那份清单，
 * 有人拿它做 `| grep` 或 `| wc -l`（gen 的既有测试就是这么数文件的）。
 * 提示混进清单会污染那个用法 —— 跳过清单从一开始就打在 stderr，同一个理由。
 */
export function coveragePreview(
  generated: readonly Scenario[],
  cov: ExistingCoverage,
  dir: string,
): string[] | null {
  const freshKeys = distinct(generated.flatMap(bodyCombinations));
  if (!freshKeys.length) return null;
  const calls = generated.flatMap(bodyCombinations).length;
  const delta = coverageDelta(freshKeys, distinct(cov.keys));
  const onDisk = new Set(delta.duplicates.map((k) => JSON.stringify([k.operationId, k.strategy])));
  const freshOnly = freshKeys.filter((k) => !onDisk.has(JSON.stringify([k.operationId, k.strategy])));
  const lines: string[] = [];
  lines.push('');
  // 两个口径都要给：调用次数与组合数。第一版只给了一个数还写成"6 个生成物"，
  // 而那是调用次数 —— 读的人会以为要写 6 个文件，实际只写 1 个
  lines.push(`覆盖增量：这批 ${calls} 次调用覆盖 ${freshKeys.length} 个组合，其中 ${delta.newCombinations} 个是磁盘上还没有的。`);
  if (delta.newCombinations === 0) {
    lines.push('  → 一个都没新增。建议合并或别生成 —— 覆盖增量预览是抑制过度生成的唯一有效手段（docs/00 §6.1）。');
  }
  for (const d of delta.duplicates.slice(0, 6)) {
    lines.push(`  · 已有：${d.operationId}/${d.strategy}`);
  }
  if (delta.duplicates.length > 6) lines.push(`  …另有 ${delta.duplicates.length - 6} 个已有组合`);
  for (const f of freshOnly.slice(0, 6)) {
    lines.push(`  + 新增：${f.operationId}/${f.strategy}`);
  }
  if (freshOnly.length > 6) lines.push(`  …另有 ${freshOnly.length - 6} 个新增组合`);
  // "已有"是从哪算的一定要带。不带的话，目录写错与"确实没有已有用例"
  // 在输出里长得一模一样，而后者才会得出"0 新增"
  lines.push(`  （已有组合来自 ${dir}：扫了 ${cov.scanned} 个 json，其中 ${cov.notIr} 个不是 IR）`);
  if (cov.broken) {
    lines.push(`  ⚠ ${cov.broken} 个文件看着像 IR 而校验不过，它们的覆盖**没算进已有** —— 先跑 atest lint 修好，否则这里会把已有的报成新增。`);
  }
  return lines;
}

/** 同一组合被多条调用命中时只算一个（这一栏的单位是组合，不是调用 —— 理由见 coveragePreview） */
function distinct(keys: CoverageKey[]): CoverageKey[] {
  const seen = new Set<string>();
  const out: CoverageKey[] = [];
  for (const k of keys) {
    const s = covKey(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

/**
 * 组合的键。**必须与引擎 `coverageDelta` 里那个 `keyOf` 逐字一致** ——
 * 那边换成别的编码方式而这里没跟着换，两边就各自算出"看着对而互不相容"的集合
 * （拼接那个版本对内容里的 `|` 敏感，判据写在 coverageDelta 函数头）。
 */
function covKey(k: CoverageKey): string {
  return JSON.stringify([k.operationId, k.strategy]);
}
