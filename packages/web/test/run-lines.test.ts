/**
 * 运行记录列表那一行的**读法**（纯判据，不在浏览器里测）。
 *
 * ## 为什么这一条值得单独一个文件，而且不能只靠浏览器测
 * 它管的是三件容易悄悄画错、而**错了不报错**的事：
 *  1. 压测那一行链一个不存在的 `report.html`（404，读的人以为证据丢了）；
 *  2. 压测那一行的标签顺序让人把"没有 report"读成"因为没冻结"（两者无关）；
 *  3. `frozen` 字段**缺省**时报警（那是"清单没写"，不是"作者说未冻结"）。
 *
 * 三条的共同点：画错的那一格**不会抛**，只会显得正常。而浏览器测试在没装
 * Chrome 的机器上整文件 skip 且退出码 0（`browser-harness.ts`），
 * 所以判据必须在 node 这一侧有一份能真跑的。
 *
 * ## 数据来源：**磁盘上真实产出的 manifest**，不是我手抄的形状
 * 下面的 fixture 与 `packages/cli/src/commands.ts` 的 `writeLoadProducts` 对齐，
 * 而那条对齐由 cli 侧的 `load.test.ts` 钉住（它读真产物、断 `kind === 'load'`）。
 * 这里刻意不 import 那个函数（`packages/web` 不许依赖 `packages/cli`，
 * `tooling/lint-layers.mjs`），所以两边各钉一次 —— 漂的那一次会有一边当场红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOAD_NO_REPORT_HINT, LOAD_RUN_KIND, runRow } from '../src/run-lines.js';

/** 功能 run 的清单（最窄的那一份：只带这一格会读的字段） */
const functional = { kind: undefined, status: 'pass', scenario: { id: 'scn.a', frozen: true } };
/** 压测 run 的清单。写侧给的就是这个形状 */
const load = { kind: LOAD_RUN_KIND, status: 'pass', scenario: { id: 'scn.load', frozen: false } };

test('压测那一行**不链 report**，并且把"为什么没有"说出来', () => {
  const r = runRow(load);
  assert.equal(r.isLoad, true);
  assert.equal(r.hasReport, false, '压测那一行还在链 report.html —— 点进去是 404，而真相是这一场没有这一份');
  // 空串与"没有那一格"不是一回事：有 report 的行不该多出一句解释
  assert.equal(r.reportWhy, LOAD_NO_REPORT_HINT);
  // 原因里必须带"为什么"，只写"无 report"会让人去查"是不是清理任务收走了"
  assert.match(r.reportWhy, /响应体/, `那句原因没说到点上：${r.reportWhy}`);

  const f = runRow(functional);
  assert.equal(f.hasReport, true, '功能 run 的 report 链接丢了 —— 那是排障主路径（docs/12 §4.2）');
  assert.equal(f.reportWhy, '', `功能那一行多出一句解释：${f.reportWhy}`);
});

test('标签：压测在前、未冻结在后，顺序就是读者的问题顺序', () => {
  assert.deepEqual(runRow(load).tags, ['压测', '未冻结'],
    '顺序反了会让人以为"没有 report 是因为没冻结"（两件事无关）');
  // 只有压测、冻结状态正常 => 只有一个标签
  assert.deepEqual(runRow({ ...load, scenario: { id: 'x', frozen: true } }).tags, ['压测']);
  // 只有未冻结
  assert.deepEqual(runRow({ ...functional, scenario: { id: 'x', frozen: false } }).tags, ['未冻结']);
  assert.deepEqual(runRow(functional).tags, []);
});

test('`frozen` **缺省**不报"未冻结"：缺字段与作者声明未冻结是两件事', () => {
  /*
   * 写成 `!sc.frozen` 也能让上面那几条全绿，而它在这一格是错的：
   * 老布局的清单、以及任何**没写这个字段**的清单，都会被打上"未冻结"，
   * 于是列表里一半的行凭空多出一个假标签 —— 假报警的结局与漏报一样，
   * 都是人学会忽略那一格。
   */
  assert.deepEqual(runRow({ kind: undefined, status: 'pass', scenario: { id: 'x' } }).tags, [],
    '缺省 frozen 被报成"未冻结"了');
  assert.deepEqual(runRow({ kind: undefined, status: 'pass' }).tags, [],
    '连 scenario 都没有时不该抛、也不该报未冻结');
});

test('`kind` 认不出来的一切值都当功能 run 画（宁多给一个 report 链接，不少给）', () => {
  /*
   * 这一条钉的是**默认方向**。清单是落盘 JSON，`kind` 可以是任意字符串，
   * 而且历史上有大量**根本没有这一格**的功能 run。
   * 未知 kind 当功能 run 画的代价是"多一个可能 404 的链接"，
   * 当压测画的代价是"把一份本来存在的报告藏起来" —— 后者更坏：
   * 人不会去点一个不存在的链接，但会因为看不到报告而放弃排查。
   * （写侧那条纪律是另一个方向：kind 只由 writeLoadProducts 写，见它的文件头。）
   */
  for (const kind of [undefined, '', 'Load', 'load-run', 'web', 0, {}]) {
    assert.equal(runRow({ ...functional, kind }).hasReport, true, `kind=${JSON.stringify(kind)} 被当成了压测`);
  }
  // 反过来：写侧那个值**必须**认，否则上面那一整套等于没接
  assert.equal(runRow({ ...functional, kind: 'load' }).hasReport, false);
  assert.equal(LOAD_RUN_KIND, 'load', 'kind 的值改了而写侧没改 —— 页面会回到"每行都链 report"');
});
