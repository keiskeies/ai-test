/**
 * `scenarioRef` 的切分：`scenarioIdOfRef` 与本轮新增的 `scenarioVersionOfRef`。
 *
 * ## 为什么这两个函数值得一个自己的测试文件
 * 它们是"**一个 ref 到底指哪份 IR**"这条判据的唯一支点，而这个支点在**两个地方**
 * 要成立（运行时 callStack 判环、静态闸的调用图）。`scenarioIdOfRef` 自己的注释
 * 写着"为什么要占一个导出函数而不让调用方各写一遍 `ref.split('@')[0]`"——
 * 而**它自己就被抄了一份**，抄在 `cli/src/commands.ts` 的解析器里，
 * 由本文件最后那条扫源码的测试抓出来（不是设计时想到的，是写完扫描才看见的）。
 *
 * `scenarioVersionOfRef` 多一层责任：它决定"**作者有没有提出版本这个要求**"。
 * 判宽了会在笔误上吼，判窄了就把静默留在原地 —— 而**终结静默正是它存在的全部理由**，
 * 所以那两条边界（`@v3` 要算、`@` 不算）各占一条测试。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { scenarioIdOfRef, scenarioVersionOfRef } from '../src/index.js';
import { assertScannerWorks, stripComments } from './src-text.js';

test('id 与 version 各归各位', () => {
  assert.equal(scenarioIdOfRef('sub.login@9'), 'sub.login');
  assert.equal(scenarioVersionOfRef('sub.login@9'), '9');
  assert.equal(scenarioIdOfRef('sub.login'), 'sub.login');
  assert.equal(scenarioVersionOfRef('sub.login'), undefined);
});

test('非数字版本也算"提出了要求"（判窄了就把静默留在原地）', () => {
  /*
   * `@v3` / `@draft` 同样表达"我要那个版本"。**第一版我写成 `/^\\d+$/`**，
   * 于是 `sub.login@v3` 一声不响 —— 那正好是这一条要终结的那件事，
   * 而且是以最难发现的方式：写数字的人被告知了，写字母的人没有。
   * 提醒的措辞本来就没断言版本长什么样（它只说"这一句没生效"），所以判宽不引入假话。
   */
  for (const ref of ['sub.login@v3', 'sub.login@draft', 'sub.login@0', 'sub.login@007']) {
    assert.notEqual(scenarioVersionOfRef(ref), undefined, `${ref} 该被当成提出了版本要求`);
  }
});

test('`id@`（写了 @ 而后面什么都没有）不算提出了要求', () => {
  /*
   * 与上一条不矛盾：`@v3` 是"要一个我说不出长什么样的版本"，
   * `@` 是**后面什么都没有** —— 那一刻没有东西被忽略，因为没有任何版本被指定。
   * 对它吼一声就是把笔误当需求，而一条会在笔误上吼的提醒，收到的反应是"把这行删掉"，
   * 于是连真正的缺口信号也没了（本仓给"噪音会让人开始跳过提示"立过规矩）。
   */
  assert.equal(scenarioVersionOfRef('sub.login@'), undefined);
});

test('id 里带多个 @ 时两个函数按**同一个** @ 切', () => {
  /*
   * `split('@')[0]` 与 `indexOf('@')` 在 `a@b@c` 上都给 `a`，
   * 但**只有两者都用"第一个 @"时**，"切出的 id + 切出的 version"才指回同一次引用。
   * 这条钉的是两个函数**互相一致**，而不是各自看起来对：
   * 判环读 id、提醒读 version，两者说的必须是同一个 ref。
   */
  assert.equal(scenarioIdOfRef('a@b@c'), 'a');
  assert.equal(scenarioVersionOfRef('a@b@c'), 'b@c');
});

/* ── 下面两条扫源码，判据与写法见文件头 ─────────────────────────────────── */

/**
 * 全仓 `src` 下的 .ts 源码（不含 dist：那里必然有编译产物撞名）。
 * 扫到 cli/engine 而不是只扫 ir，是**必须的**：本轮抓出来那份重复实现就在 cli。
 */
function allSources(): Array<{ file: string; text: string }> {
  const root = join(import.meta.dirname, '..', '..');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
      const p = join(dir, n);
      // 只扫 **src**（生产代码）。测试里 `assert.ok(!msg.includes('@'))` 那种
      // 是在检查输出里不许出现 @，不是切 ref；把它算成重复实现是假阳性。
      // 真正的重复实现一定住在 src 里 —— 本轮抓出来那份就在 cli/src。
      if (n.endsWith('.ts') && !n.endsWith('.d.ts') && p.includes('/src/')) {
        out.push({ file: p, text: readFileSync(p, 'utf8') });
      }
      else if (!n.includes('.')) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 判据本体的文件名（扫描时跳过它自己） */
const HOME = 'src/scenario.ts';

test('扫描本身能用（拿两个已知调用点当哨兵）', () => {
  /*
   * 这条不是凑数，是 `src-text.ts` 那个文件的存在理由在这里的复用：
   * **剥注释剥多了、或文件清单压根是空的，下面那条扫描会"扫到零处重复"而通过** ——
   * 于是扫描器自己坏掉的样子与"判据成立"一模一样。
   * 所以先断言它**扫得到已知存在的东西**。
   */
  const files = allSources();
  assert.ok(files.length > 20, `只读到 ${files.length} 个源码文件，路径大概拼错了（扫描器恒过的形状）`);
  const strip = files.map((f) => stripComments(f.text)).join('\n');
  assertScannerWorks(strip, [/export function scenarioIdOfRef/, /return ref\.split\('@'\)\[0\]!/]);
});

test('scenarioRef 的切分全仓只许有一处（不许有人再写一遍 split / includes("@"）', () => {
  /*
   * 「两处各一份，迟早只更新其中一处」是本仓记账最多的一族，而 ref 的切分恰好是
   * **改了语义没人会红**的那种：有人写了第三份 `ref.split('@')[0]` 而忘了 version，
   * 编译器不会说话。所以这一问得有个可执行的答法。
   *
   * **本轮的实际收获**：这条测试第一次跑就红了，报出
   * `cli/src/commands.ts` 里那句手写的 `ref.split('@')[0]!` ——
   * 而 `scenarioIdOfRef` 的注释明写着别这么抄。抄的那份今天行为相同，
   * 版本语义落地那天只改 IR 那一处，这里就会安静地继续按 id 找。
   */
  const offenders: string[] = [];
  for (const { file, text } of allSources()) {
    if (file.endsWith(HOME)) continue;
    const code = stripComments(text); // 注释里举的例子不算（src-text.ts 记过一次假阳性）
    code.split('\n').forEach((line, i) => {
      // 只盯**针对 ref 的**手工切分：`split('@')` 出现在别处（切标签、切邮箱）
      // 与本判据无关，所以要求同一行里出现 ref/Ref。放宽到整文件会假阳性一片。
      if (!/[rR]ef/.test(line)) return;
      if (/split\('@'\)|includes\('@'\)|indexOf\('@'\)/.test(line)) {
        offenders.push(`${file.replace(join(import.meta.dirname, '..', '..') + '/', '')}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `scenarioRef 的切分只许走 scenarioIdOfRef / scenarioVersionOfRef：\n${offenders.join('\n')}`);
});

test('两个函数都真的有调用点（有生产者，不是写完放在那儿）', () => {
  /*
   * 本仓最贵的一格是"**登记了载体而没人用**"。如果扫描那条只证明"判据存在"，
   * 而没有任何运行路径调 `scenarioVersionOfRef`，那 `@9` 照旧静默，
   * 而**上一条测试还会为这份静默作证**（它只查有没有重复切法）。
   * 所以"只有一处切法"之外还要"这一处真的有人走"。
   */
  const files = allSources();
  for (const name of ['scenarioIdOfRef', 'scenarioVersionOfRef']) {
    const callers = files.filter(({ file, text }) =>
      !file.endsWith(HOME) && new RegExp(`\\b${name}\\(`).test(stripComments(text)));
    assert.ok(callers.length >= 1, `${name} 在 IR 之外没有任何调用点 —— 那就是"有判据、没接线"`);
  }
});
