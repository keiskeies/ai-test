/**
 * 三档密度的 token **真的参数化**了吗（docs/13 §7 U7）。
 *
 * ## 这条测试钉的是一个具体的、会发生的事故
 *
 * 「三档密度」这个功能的实现方式有两种，外观完全一样：
 *  1. 每一档改一组 CSS 变量，组件全部读变量；
 *  2. 写第一档时顺手把 px 写进组件，切档时再给那几个组件补 `@media`/覆盖规则。
 *
 * 第 2 种在**演示当天**看不出问题（演示者只切自己那档），
 * 而 docs/13 U7 那句「事后补 = 全站刷样式」说的就是它的代价。
 * 区别只有一处可机器判定：**组件区里有没有写死的 px**。
 * 所以这里不测"切档后看起来对不对"（那要截图对比，成本另一个量级），
 * 只测"切档在机制上能不能生效" —— 后者便宜且红得准。
 *
 * ## 判据为什么这么切
 *
 * 按**选择器**分区：token 区（`[data-density=…]` / `[data-theme=…]` / `:root`）
 * 里出现 px 是**正确**的，那一区就是该写原始值的地方；
 * 组件区（其余所有规则）里出现任何长度字面量都是违例 ——
 * 因为那一区的每一个尺寸都必须能随档位变。
 *
 * `1px` 边框**单独放行**：分隔线不随密度变，而且 0.5px/1.5px 在小字号下发虚。
 * 这是显式承认的例外，写在下面的 ALLOWED_PX 里，而不是"看到就当没看见"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CSS } from '../src/styles.js';
import { STEP_STATUS } from '@atest/ir';

/** token 区的选择器特征：只有这几处允许出现原始值 */
const TOKEN_BLOCK = /^\s*(?:\[data-(?:density|theme)=|:root\b)/;

/** 组件区里允许出现的字面量长度（见上面 `1px` 那条理由） */
const ALLOWED_PX = new Set(['1px']);

/** 把 CSS 切成「选择器 + 它自己的声明体」，够判这一条，不做完整解析器 */
function blocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    out.push({ selector: (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] ?? '' });
  }
  return out;
}

/** 整份 CSS 切一次，两个 describe 共用（切块本身不是被测行为，没必要重复） */
const bs = blocks(CSS);

describe('三档密度参数化（docs/13 §7 U7）', () => {
  test('三档都在，且每档都给了全套间距/字号/控件高度 token', () => {
    const density = bs.filter((b) => /\[data-density=|:root,/.test(b.selector));
    const tiers = ['compact', 'standard', 'relaxed'];
    for (const t of tiers) {
      const hit = density.find((b) => b.selector.includes(`"${t}"`) || (t === 'compact' && b.selector.includes(':root')));
      assert.ok(hit, `第 1 层里找不到密度档 ${t}`);
      // 后五个不在 docs/13 §1 那张原表里，但它们是"切档只切一半"的那处缺口：
      // 顶栏高、侧栏宽、正文限宽、行色条宽、浮层阴影。写死在组件里 = 宽松档下
      // 控件变高而顶栏/正文不变，那是比"没做三档"更难看的结果。
      for (const need of ['--control-h', '--row-h', '--space-1', '--space-6', '--font-1', '--font-4', '--radius',
        '--topbar-h', '--nav-w', '--content-max', '--modal-max', '--stripe-w', '--shadow-modal']) {
        assert.ok((hit.body ?? '').includes(need), `档位 ${t} 缺 token ${need}`);
      }
    }
  });

  test('三档之间确实有差异（相同 = 切档无效，而外观上看不出来）', () => {
    const bodyOf = (t: string): string => bs.find((b) => b.selector.includes(`[data-density="${t}"]`))?.body ?? '';
    const c = bodyOf('compact');
    const s = bodyOf('standard');
    const r = bodyOf('relaxed');
    assert.ok(c && s && r, '三档里有一档整块缺失');
    assert.notEqual(c, s, 'compact 与 standard 的 token 一模一样');
    assert.notEqual(s, r, 'standard 与 relaxed 的 token 一模一样');
    // 具体到控件高度：这是"切档能看见"的那一格
    const h = (b: string): string => /--control-h:\s*([^;]+)/.exec(b)?.[1] ?? '';
    assert.deepEqual([h(c), h(s), h(r)], ['28px', '32px', '36px'], 'docs/13 §1 那张表的控件高度是 28/32/36');
  });

  test('组件区不出现写死的尺寸（除了 1px 分隔线）', () => {
    const offenders: string[] = [];
    for (const b of bs) {
      if (TOKEN_BLOCK.test(b.selector)) continue;
      // 只查长度字面量。数字型属性（z-index、opacity、flex、line-height）本来就不该跟密度走
      for (const m of b.body.matchAll(/:\s*([^;{}]*?\b\d+(?:\.\d+)?px[^;{}]*)/g)) {
        const px = (m[1] ?? '').match(/\d+(?:\.\d+)?px/g) ?? [];
        const bad = px.filter((p) => !ALLOWED_PX.has(p));
        if (bad.length) offenders.push(`${b.selector} { ${m[1]?.trim()} }  ← ${bad.join(', ')}`);
      }
    }
    assert.deepEqual(offenders, [], `这些声明把尺寸写死了，切档时它们不会跟着变：\n    ${offenders.join('\n    ')}`);
  });

  test('组件区不出现 hex 颜色（暗色模式补不完的那条成因，docs/13 §1）', () => {
    const offenders: string[] = [];
    for (const b of bs) {
      if (TOKEN_BLOCK.test(b.selector)) continue;
      if (/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.test(b.body)) offenders.push(b.selector);
    }
    assert.deepEqual(offenders, [], '组件区出现了字面色值，应改读语义 token：\n    ' + offenders.join('\n    '));
  });
});

describe('六态徽章的三重编码（docs/13 §2）', () => {
  test('每个 IR 状态都各自有颜色规则与底色，一个都不落', () => {
    for (const s of STEP_STATUS) {
      const rule = bs.find((b) => b.selector.includes(`.badge[data-s="${s}"]`));
      assert.ok(rule, `.badge[data-s="${s}"]` + ' 没有颜色规则：那一态会渲染成无色徽章');
      assert.ok(rule.body.includes('var(--st-'), `徽章 ${s} 的颜色不是 token`);
      assert.ok(rule.body.includes('-bg'), `徽章 ${s} 只有前景色没有底色`);
    }
  });

  test('healed 不复用 pass 的颜色（自愈当通过是最不能出现的误读，docs/00 §5.6）', () => {
    const of = (s: string): string => bs.find((b) => b.selector.includes(`.badge[data-s="${s}"]`))?.body ?? '';
    assert.notEqual(of('healed'), of('pass'), 'healed 与 pass 同一套配色 = 表格上分不出自愈');
    assert.match(of('healed'), /--st-healed\b/);
  });

  test('色之外的两重编码在 CSS 里成立：徽章有图标位、失败行有色条', () => {
    // 图标位与文字都由 app.ts 从状态本身生成；CSS 这一侧要保证它们**有地方显示**
    assert.match(CSS, /\.badge\s+\.bi\b/, '没有 .badge .bi：图标位会塌成没间距的一团');
    for (const s of ['fail', 'error', 'healed'] as const) {
      assert.ok(bs.some((b) => b.selector.includes(`tr[data-s="${s}"] td:first-child`) && b.body.includes('box-shadow')),
        `行 ${s} 没有左侧色条：整行扫过时只能靠颜色区分`);
    }
  });
});
