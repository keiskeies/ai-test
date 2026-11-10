/**
 * 定位阶梯的**纯函数**测试（不需要浏览器）。
 *
 * 为什么这一层值得单独测：translate 出错的表现不是报错，而是**在真浏览器上稳稳命中
 * 另一个元素**（然后用例绿）。真浏览器端到端跑绿证明的是"有个元素被命中"，
 * 证明不了"命中的是哪一个" —— 所以"翻出来的查询长什么样"必须在纯函数这一层钉住，
 * 而"这个查询在真页面里命中谁"由 ui-locator.test.ts 的夹具补一遍。
 * 两边都留，因为它们的失效方式不同：纯函数漂了会翻出错的查询，
 * 浏览器侧漂了（XPath 引擎行为与规范不一致）只有夹具能抓到。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BadLocator, LADDER_GRADUATABLE, UnsupportedLocator, WEB_LOCATOR_BY,
  confidenceOf, cssAttrValue, ladder, rungOf, translate, xpathStr, type Located,
} from '../src/locator.js';
import type { LocatorRule } from '@atest/ir';

const rule = (r: Partial<LocatorRule> & { by: LocatorRule['by'] }): LocatorRule =>
  ({ nameMatch: 'exact', scope: 'page', ...r }) as LocatorRule;

/** 取查询串。两种策略分开断言，混成 string 会让"该出 css 却出了 xpath"看不出来 */
const sel = (r: Parameters<typeof translate>[0], attr?: string): string => translate(r, attr).selector;
const strat = (r: Parameters<typeof translate>[0]): Located['strategy'] => translate(r).strategy;

test('testid → CSS 属性选择器；属性名可配（推动被测前端加 testid，成本降一个数量级）', () => {
  assert.equal(strat(rule({ by: 'testid', value: 'submit' })), 'css');
  assert.equal(sel(rule({ by: 'testid', value: 'submit' })), '[data-testid="submit"]');
  assert.equal(sel(rule({ by: 'testid', value: 'submit' }), 'data-qa'), '[data-qa="submit"]');
  // 属性名本身也是拼进选择器的，所以它也要受词法约束
  assert.throws(() => sel(rule({ by: 'testid', value: 'x' }), 'data-qa]" onclick="alert(1)'),
    BadLocator, '非法属性名必须当场拒掉，不能拼出多一个属性的选择器');
});

test('值里的引号被转义 —— 不转义就能改写查询本身', () => {
  // 不转义时这个值会闭合属性值并追加一个属性选择器，命中的集合由值决定
  assert.equal(sel(rule({ by: 'testid', value: 'a"] [onclick' })), '[data-testid="a\\"] [onclick"]');
  assert.equal(cssAttrValue('a"b\\c'), '"a\\"b\\\\c"');
  // XPath 1.0 没有转义，含单引号只能拆 concat
  assert.equal(xpathStr("提交"), "'提交'");
  assert.equal(xpathStr("it's"), `concat('it',"'",'s')`);
  // 反向判据：拆完之后值里**不再有**裸的 `'` 能闭合字符串
  const broken = xpathStr("a' or 1=1 or 'b");
  assert.ok(broken.startsWith('concat('), `含引号必须走 concat：${broken}`);
  assert.match(sel(rule({ by: 'text', value: "a' or 1=1 or 'b" })), /concat\(/);
});

test('text / textContains 只命中文本叶子（否则祖先与 body 都会命中）', () => {
  const t = sel(rule({ by: 'text', value: '合计' }));
  assert.equal(strat(rule({ by: 'text', value: '合计' })), 'xpath');
  assert.match(t, /normalize-space\(\)='合计'/);
  /*
   * 叶子谓词。这条子句我**写反过一次**，是真浏览器测出来的：
   * 原本写的 `not(normalize-space(text())!='')` 读作"直接文本为空"，
   * 于是 `<button>提交订单</button>` **0 命中**而 `<body>` 反而命中。
   * 正确形态是"没有任何带文本的后代"。这里同时钉**正向形态**与**旧错误形态不再出现**
   * —— 只断新形态的话，谁把它改回去而顺手改掉正则，这条就跟着一起改了。
   */
  assert.match(t, /not\(\.\/\/\*\[normalize-space\(\)!=''\]\)/, '必须限定文本叶子');
  assert.doesNotMatch(t, /not\(normalize-space\(text\(\)\)!=''\)/, '旧的反向写法（text() 判空）不得回来');
  assert.match(sel(rule({ by: 'textContains', value: '合计' })), /contains\(normalize-space\(\),'合计'\)/);
  // textContains 也要带叶子谓词，否则每个祖先都命中 => 严格模式下全部拒掉
  assert.match(sel(rule({ by: 'textContains', value: '合计' })), /not\(\.\/\/\*\[normalize-space\(\)!=''\]\)/);
});

test('role+name 缺 role 或缺 name 都要报错（不能退化成"任意带 aria-label 的元素"）', () => {
  assert.throws(() => translate(rule({ by: 'role+name', name: '提交' })), BadLocator);
  assert.throws(() => translate(rule({ by: 'role+name', role: 'button' })), BadLocator);
  assert.throws(() => translate(rule({ by: 'role+name', role: 'button" x', name: 'y' })), BadLocator, '角色名要过词法检查');
  const s = sel(rule({ by: 'role+name', role: 'button', name: '提交订单' }));
  assert.match(s, /@role='button'/);
  // exact 走 normalize-space：属性值里的多余空白是人手写的常态，
  // 按字面相等判会 miss（miss 至少是失败，静默降级到 css 才糟）
  assert.match(s, /normalize-space\(@aria-label\)='提交订单'/);
});

test('nameMatch 各形态都翻成谓词；regex 交宿主侧过滤（XPath 1.0 没有正则）', () => {
  const m = (nameMatch: LocatorRule['nameMatch']): string => sel(rule({ by: 'role+name', role: 'link', name: 'x y', nameMatch }));
  assert.match(m('contains'), /contains\(@aria-label,'x y'\)/);
  assert.match(m('starts'), /starts-with\(@aria-label,'x y'\)/);
  assert.match(m('ends'), /substring\(@aria-label,.*\+1\)='x y'/);
  // regex 这一级谓词恒真，由 ui.ts 在宿主侧按 RegExp 筛。
  // **别把它读成"regex 不生效"**：生效的地方在 JS 侧，这里只是 XPath 表达不了
  assert.match(m('regex'), /\[true\(\)\]/);
});

test('label 定位覆盖前端在用的四种关联方式', () => {
  const s = sel(rule({ by: 'label', value: '手机号' }));
  // 1) <label for> 2) <label> 包裹 3) aria-label 4) aria-labelledby
  assert.match(s, /@id=\/\/label\[normalize-space\(\)='手机号'\]\/@for/, 'for 关联（节点集比较）');
  assert.match(s, /self::input/, '包裹式 label 要限定到控件，不能命中整块表单的第一个子元素');
  assert.match(s, /@aria-label/);
  assert.match(s, /@aria-labelledby/);
  // 四路是并集：任何一路命中都算命中，所以必须有 `|`
  assert.equal((s.match(/ \| /g) ?? []).length, 3, `四路并集应有 3 个联合符：${s}`);
});

test('nth 明确不实现：抛错而不是给一个索引差一就点错行的实现', () => {
  assert.throws(() => translate(rule({ by: 'nth', value: 'div', index: 0 })), UnsupportedLocator);
  try { translate(rule({ by: 'nth', value: 'div', index: 0 })); } catch (e) {
    const m = (e as Error).message;
    // 报错要说清"为什么不做"，否则下一个人会当成随手漏实现补一个错的回来
    assert.match(m, /未实现/);
    assert.match(m, /docs\/06/, `要点回设计文档：${m}`);
  }
});

test('不认识的 by 一律 UnsupportedLocator，并列出支持的那些（不静默退回 css）', () => {
  // 其他端的与需要模型参与的，都在这里
  for (const by of ['id', 'resource-id', 'content-desc', 'name', 'predicate', 'classChain', 'key', 'class',
    'anchor', 'compiled-selector', 'template'] as LocatorRule['by'][]) {
    assert.throws(() => translate(rule({ by, value: 'x' })), UnsupportedLocator, `${by} 应明确报不支持`);
  }
  try { translate(rule({ by: 'anchor', value: 'x' })); } catch (e) {
    // 报错要把支持的那些列出来，否则人只会照着报错里的字符串再试一次猜
    for (const by of WEB_LOCATOR_BY) assert.ok((e as Error).message.includes(by), `报错里应列出 ${by}：${(e as Error).message}`);
  }
});

test('阶梯 = primary + fallbacks，且不去重（rung 要对得上 IR 里的位置）', () => {
  const a = rule({ by: 'testid', value: 'a' });
  const b = rule({ by: 'css', value: '#b' });
  assert.deepEqual(ladder(a, [b, a]).length, 3, '重复规则去重会让 rung 与 IR 位置错位');
  assert.deepEqual(ladder(undefined, [b]), [b]);
  assert.deepEqual(ladder(undefined, []), []);
});

test('阶梯级别与置信度单调：越贵的定位法置信度越低，且毕业判定与门限同源', () => {
  const bys = [...WEB_LOCATOR_BY].sort((x, y) => rungOf(x) - rungOf(y));
  assert.deepEqual(bys, ['testid', 'role+name', 'label', 'placeholder', 'text', 'textContains', 'css', 'xpath']);
  for (let i = 1; i < bys.length; i++) {
    assert.ok(confidenceOf(bys[i]!) <= confidenceOf(bys[i - 1]!),
      `${bys[i]} 比 ${bys[i - 1]} 更贵却置信度更高 —— 阶梯排序失去意义`);
  }
  // **同源判据**：导出的毕业表必须等于"CONF 与默认门限 0.85 比出来的结果"。
  // 这条防的是有人改了 CONF 却忘了毕业含义会变（engine 那边 confidence<gate => healed，
  // 改一个展示值顺手把 css 变成"已毕业"，未审校的定位器就从红灯里静默消失了）
  for (const by of WEB_LOCATOR_BY) {
    assert.equal(LADDER_GRADUATABLE[by], confidenceOf(by) >= 0.85,
      `${by} 的毕业判定与置信度不一致（改 CONF 要同时想清楚门限那边）`);
  }
  // 边界：engine 用 `<`，所以恰好等于门限算毕业。**text 正落在这条线上** ——
  // 它是我唯一一处"置信度 == 默认门限"的级别，改 CONF 或改 schema 默认门限都会碰到它
  assert.equal(confidenceOf('text'), 0.85);
  assert.equal(LADDER_GRADUATABLE.text, true);
  // 反向：textContains 低半档、明确不毕业。这条断言存在是因为**我第一版把它标错了**，
  // 上面那个同源循环当场抓到（0.8 >= 0.85 为假，表里却写着 true）。
  // 记下来免得被当成笔误改回去：模糊文本匹配会命中提示语而非控件，且 i18n 下一律漂。
  assert.equal(confidenceOf('textContains'), 0.8);
  assert.equal(LADDER_GRADUATABLE.textContains, false);
  // 认不出的 by 兜到最低一档，而不是给个 1（给 1 等于"未知定位法直接毕业"）
  assert.equal(rungOf('unknown'), 9);
  assert.ok(confidenceOf('unknown') < 0.85);
});
