/**
 * 扫描跑完后要落的第一份测试（本轮先草在 .scratch/，因为测试文件在 `npm test`
 * 的 glob 里，而变异扫描正逐条 spec 跑 `npm test` —— 现在加进去等于给还没跑的
 * spec 塞进它们没预期的用例，红绿就不再回答那份 spec 想问的问题）。
 *
 * 钉的是 `docs/15` §3.3 末尾那张探针表。四条**一条都不能省**，理由写在各自注释里。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintScenario, toReport } from '../src/index.js';
import { b, scen, tapStep, type StepDraft } from './helpers.js';

const dev = (id: string): StepDraft => ({ ...b(id), kind: 'device', target: 'android' } as StepDraft);
const assertion = (): StepDraft =>
  ({ ...b('a1'), kind: 'assert', against: '$.run', jsonPath: { '$.x': { notNull: true } } }) as StepDraft;

const codes = (body: StepDraft[], extra: object = {}) =>
  lintScenario(scen(body as never[], extra as never)).map((i) => i.code);

describe('RESOURCE_LEASE_MISSING 的遍历范围（docs/15 §3.3 探针 A/A′/B/C）', () => {
  test('A0 **对照**：device 与 tap 都在 body → 不报', () => {
    // 没有这条，下面三句"不报/报"全都不成立：夹具错了也能得到同样的输出。
    const c = codes([dev('d'), tapStep('t'), assertion()]);
    assert.ok(!c.includes('RESOURCE_LEASE_MISSING'));
  });

  test('A device 在 setup、tap 在 body → **不报**（现状是误报，且会拦 CI）', () => {
    const items = lintScenario(scen([tapStep('t'), assertion()] as never, { setup: [dev('d')] } as never));
    const hit = items.find((i) => i.code === 'RESOURCE_LEASE_MISSING');
    assert.ok(!hit, `setup 里的租约对 body 有效（运行时实测：tap=pass），报它就是假阳性：${hit?.message}`);
    // 这一句才是"为什么要修"的分量：error 级 → atest lint 退 3 / run --strict 拒绝执行
    assert.ok(toReport(items).ok, '这条场景真能跑通，lint 必须放行');
  });

  test('C tap 在 setup 而租约在 body 之后 → **要报**（现状是漏报）', () => {
    // setup 先于 body 跑，所以 setup 里那个 tap 那一刻**真的**没有租约。
    // 而 targets 含 android（body 里有 device），排除了"targets 只看 body"那一半原因，
    // 所以这条红了只能是因为遍历没走 setup —— 这才是干净的判据。
    const c = codes([dev('d'), tapStep('t2'), assertion()], { setup: [tapStep('t1')] });
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'));
  });

  test('B tap **只**在 setup（body 里没有任何移动端步骤）→ 要报', () => {
    // 这条钉的是修法的一半：前置条件从 `scenario.targets.some(...)` 换成
    // `deriveTargets([...三层]).some(...)`。只修 walk 不修这里的话，A 与 C 照过
    // （它们的 body 里有 device，targets 因此含 android，那个 .some() 本来就成立），
    // **只有这条会红** —— 它就是"这条修法不是冗余"的证据。
    const c = codes([assertion()], { setup: [tapStep('t1')] });
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'),
      'body 里没有移动端步骤 ⇒ scenario.targets 是空的，但 setup 里那个 tap 确实需要租约');
  });

  test('反向：全场无租约、tap 在 body → 仍然要报（别把闸修成永不响）', () => {
    const c = codes([tapStep('t'), assertion()]);
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'));
  });
});
