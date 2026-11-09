/**
 * 拿**仓库里真实存在的每一份变异集**回归 detectResidue 的误报面。
 *
 * 为什么值得单独立一个文件：detectResidue 的误报与漏报代价不对称，而误报的代价
 * 不是"多报一次"，是**人学会无脑 --force**（那道闸门从此形同虚设）。
 * 我写它时自己踩出两个误报（锚点不在 HEAD 时 split/join 是恒等变换、空变异），
 * 两个都是"每一次运行都会误拦"那种 —— 靠手写 fixture 想不到，是靠真 spec 撞出来的。
 * 所以这里把真 spec 全量过一遍：以后任何人加一条形状奇怪的变异，这条会当场拦住。
 *
 * **不读工作区的源文件**，一律用 git 里的已提交内容当"干净现场"。两个理由：
 *  1. 工作区**正在被变异驱动改**的时候跑测试，读到的就是变异版 —— 那条测试会红，
 *     而它报的是"有残留"，把一次正常的并发说成现场污染，指错方向；
 *  2. 结论应当与"我这台机器此刻脏不脏"无关，否则它就不是回归测试而是环境探测器。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { detectResidue } from '../mutate.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SPEC_DIR = join(ROOT, 'tooling/mutate');

/** git 不可用时整组跳过，而不是让它变成一条"在没 git 的机器上必红"的测试 */
function committedOf(file, cache) {
  if (cache.has(file)) return cache.get(file);
  let v;
  try {
    v = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    v = undefined;
  }
  cache.set(file, v);
  return v;
}

function allSpecs() {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => ({ name: f, spec: JSON.parse(readFileSync(join(SPEC_DIR, f), 'utf8')) }));
}

describe('真变异集在干净现场下都不许被判成残留', () => {
  const specs = allSpecs();
  const cache = new Map();

  test('目录里得有东西，否则这组测试是空的（空测试组最容易骗过自己）', () => {
    assert.ok(specs.length >= 3, `只扫到 ${specs.length} 份 spec：路径或后缀名大概变了`);
    for (const { name, spec } of specs) {
      assert.ok(Array.isArray(spec.cases) && spec.cases.length > 0, `${name} 里没有 cases，那它为什么还在？`);
    }
  });

  for (const { name, spec } of specs) {
    test(`${name}：每条变异在"已提交内容"上都不触发残留判定`, () => {
      for (const c of spec.cases ?? []) {
        if (!c.file || c.anchor === undefined || c.replace === undefined) continue;
        const head = committedOf(c.file, cache);
        if (head === undefined) continue; // 未跟踪的文件（比如本轮新加的）无从判起
        // 干净现场 = 磁盘内容与已提交内容相同。此时 detectResidue 必须闭嘴。
        const kind = detectResidue({ current: head, committed: head, anchor: c.anchor, replace: c.replace });
        assert.equal(
          kind, null,
          `${c.label ?? c.anchor.slice(0, 40)}：干净现场被判成 ${kind}。`
          + '要么是这条 spec 的形状会让闸门每次误拦（该改 spec 或改判据），'
          + '要么是它已经过期（锚点在 HEAD 里不存在了，去改锚点或删条目）',
        );
      }
    });
  }

  test('锚点必须在已提交内容里出现，否则那条变异其实根本没在测东西', () => {
    // 这是顺带查出来的一件事，与残留无关但同源：锚点在 HEAD 里找不到时，
    // `split().join()` 是恒等变换 —— 施加"变异"等于没施加，
    // 于是这条永远"未被抓到"，白占一个"已验证"名额。
    const missing = [];
    for (const { name, spec } of specs) {
      for (const c of spec.cases ?? []) {
        if (!c.file || c.anchor === undefined) continue;
        const head = committedOf(c.file, cache);
        if (head === undefined) continue;
        if (!head.includes(c.anchor)) missing.push(`${name} :: ${c.label ?? c.anchor.slice(0, 40)}`);
        if (c.anchor === c.replace) missing.push(`${name} :: ${c.label ?? '(无 label)'}（anchor 与 replace 相同 = 空变异）`);
      }
    }
    assert.deepEqual(missing, [], '上面这些条目的"变异"落不到代码上，跑了等于没跑');
  });
});
