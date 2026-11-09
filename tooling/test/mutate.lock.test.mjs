/**
 * 变异驱动的**入口路径**集成测试：真的起子进程，验锁的几种现场各给出什么退出码。
 *
 * 与 tooling/test/mutate.test.mjs 的分工：那边测 decideLock 这个**纯函数**的判定，
 * 这边测"驱动真的照这个判定行动"。两件事都可能单独成立 —— 纯函数判对了而调用点没接上，
 * 正是本仓反复栽的那个缺陷类的测试版（「schema 有字段、执行侧没人读」的镜像）。
 *
 * **这些测试不施加任何真变异**：spec 里的锚点故意匹配不到，于是每条都走
 * ANCHOR_NOT_FOUND 直接 continue，一个源文件都不碰。理由直白 ——
 * 在人家正在用的工作树里改 src 来测"别并发改 src"，本身就是我在防的那件事。
 * 真施加变异的那几条路径（RESIDUE / 收尾核对 / 锁保留）本轮用手工冒烟验过，
 * 过程与结论记在 docs/08 的 (f)。
 *
 * 锁路径通过 ATEST_MUTATE_LOCK_FILE 换到临时目录：否则测试会跟真驱动抢同一把锁，
 * 而且中途崩掉会在别人工作树里留下一把假锁。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const DRIVER = join(ROOT, 'tooling/mutate.mjs');
const DIR = mkdtempSync(join(tmpdir(), 'atest-lock-'));
const LOCK = join(DIR, 'lock.json');

after(() => rmSync(DIR, { recursive: true, force: true }));

/**
 * 一条锚点匹配不到的 spec：走完整个流程但不碰任何文件。
 * 注意它退出码是 1（ANCHOR_NOT_FOUND 无结论 -> 非零），这是**正确**的，
 * 所以下面判"跑起来了没有"一律看输出里有没有汇总行，而不是看码。
 */
function specFile(name) {
  const p = join(DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify({
    cases: [{
      label: name,
      file: 'tooling/mutate.mjs',
      anchor: '这段文字不会出现在任何源文件里 ZZX',
      replace: '改成什么都无所谓 ZZY',
      testFile: 'tooling/test/mutate.test.mjs',
    }],
  }));
  return p;
}

/**
 * 起一个真驱动。**用 spawnSync 而不是 execFileSync**：后者在子进程非零退出时
 * 丢掉 stdout，而"看到驱动说了什么"正是本文件要测的东西（那也是 mutate.mjs 记的第一条教训）。
 */
function run(spec, { args = [], useLockEnv = true } = {}) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DRIVER, spec, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: useLockEnv ? { ...process.env, ATEST_MUTATE_LOCK_FILE: LOCK } : process.env,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const writeLock = (obj) => writeFileSync(LOCK, JSON.stringify(obj));
const readLockRaw = () => (existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null);
const RAN = /抓到 .*\/.*未抓到/;

describe('驱动入口：锁的每种现场都要给出正确的动作', () => {
  test('没有锁 -> 跑完整轮，结束时锁必须被删掉', () => {
    rmSync(LOCK, { force: true });
    const r = run(specFile('idle'));
    assert.match(r.out, RAN, '没有汇总行就是压根没跑');
    assert.equal(readLockRaw(), null, '正常跑完还留着锁，下一次就会被自己拦住');
  });

  test('锁被一个**活着的**进程占着 -> 退出 2、不跑、不许覆盖别人的锁', () => {
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeLock({ pid: holder.pid, startedAt: new Date().toISOString() });
      const r = run(specFile('busy'));
      assert.equal(r.code, 2);
      assert.match(r.out, /正在跑/);
      assert.doesNotMatch(r.out, RAN, '被拦住时**根本没跑**，不该出现汇总行');
      assert.equal(readLockRaw().pid, holder.pid, '覆盖掉别人的锁等于把并发问题藏起来');
    } finally {
      holder.kill('SIGKILL');
    }
  });

  test('pid 已死但锁里记着"当时正施加变异" -> 退出 2；--force 才放行', () => {
    writeLock({ pid: 999997, startedAt: 'x', inFlight: 'tooling/mutate.mjs :: 某条' });
    const r = run(specFile('stale'));
    assert.equal(r.code, 2);
    assert.match(r.out, /正施加着变异/);
    assert.equal(readLockRaw().inFlight, 'tooling/mutate.mjs :: 某条', '拒绝时锁必须原样留着');

    const f = run(specFile('stale'), { args: ['--force'] });
    assert.match(f.out, /--force/);
    assert.match(f.out, RAN, '--force 之后要真的跑起来，否则这个开关形同虚设');
  });

  test('锁里留着**残留清单** -> 退出 2，且提示说的是"还原"而不是"驱动还在跑"', () => {
    writeLock({ pid: 999996, startedAt: 'x', residue: ['packages/engine/src/resolve.ts'] });
    const r = run(specFile('residue'));
    assert.equal(r.code, 2);
    assert.match(r.out, /resolve\.ts/, '提示里必须带着要还原哪个文件');
    assert.match(r.out, /git status/);
    assert.doesNotMatch(r.out, /正在跑/, '上一轮是**正常退出**的；说"还在跑"会让人去查一个不存在的进程');
  });

  test('spec 的 JSON 写坏 -> 退出 2，且**不留锁**', () => {
    // 查的是释放路径的覆盖面：一次打错逗号就在仓库里留下一把锁的话，
    // 下一个人会去找一个压根不存在的驱动进程
    rmSync(LOCK, { force: true });
    const bad = join(DIR, 'bad.json');
    writeFileSync(bad, '{ "cases": [ }');
    assert.equal(run(bad).code, 2);
    assert.equal(readLockRaw(), null, '解析失败也必须走 releaseLock');
  });

  test('锁文件不是合法 JSON -> 放行并覆盖，而不是永久锁死', () => {
    writeFileSync(LOCK, '这不是JSON');
    assert.match(run(specFile('corrupt')).out, RAN, '一把解不开的锁会让人直接放弃这个工具');
  });

  test('没设 ATEST_MUTATE_LOCK_FILE 时用的是仓库里那把锁（注入开关不是摆设）', () => {
    // 这条只断言"临时锁没被动过" —— 不断言跑没跑起来。
    // 因为不设环境变量时驱动读的是**工作树里真实那把锁**，如果此刻真有一个驱动在跑，
    // 它会正确地拒绝；在这里断言"必须跑起来"就等于写下一个"与并发保护本身互斥"的测试，
    // 那正是本文件存在的理由的反面。
    writeLock({ pid: 999995, startedAt: 'x' });
    const r = run(specFile('envcheck'), { useLockEnv: false });
    assert.equal(readLockRaw().pid, 999995, '临时锁必须原地不动：环境变量没设时它不该被读');
    assert.ok([0, 1, 2].includes(r.code), `退出码该是 0/1/2 之一，实际 ${r.code}`);
    // 这里**故意不去删**工作树里那把锁。它会走到两种结局：没有别的驱动时这一跑自己就把它释放了；
    // 有别的驱动时它被拒、而那把锁属于正在跑的驱动 —— 删掉它就是我们自己在销毁现场，
    // 恰好是这条锁存在的理由。
  });
});
