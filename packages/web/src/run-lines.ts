/**
 * 运行记录列表里**每一行的读法**：这一行是什么 run、该链到哪些文件。
 *
 * ## 为什么又是"把句子从 app.ts 挪出来"这一招
 * 与 `check-lines.ts` 的文件头同一条理由，而且这里更严重：
 * `browserTest` 在没装 Chrome 的机器上是 `test.skip`，node:test 对整文件跳过给
 * **退出码 0**。于是"压测那一行到底画成什么样"这件事，取决于某台机器的
 * `~/Applications` 里躺着什么 —— 那种守卫不算守卫。
 * 拆出来之后：**判据在这一格（node 测），接线在浏览器测**（真的画出了那个标签）。
 *
 * ## 这一格里真正的一条判据：`kind` 这个字段**有没有人消费**
 *
 * 写侧（`packages/cli/src/commands.ts` 的 `writeLoadProducts`）给压测的清单写了
 * `kind: 'load'`，理由那一格写着"让它与功能 run 区分开"。而页面**从来不读它** ——
 * 于是每个压测 run 那一行都挂着一个 `report` 链接，点进去 404，
 * 服务端给的是干巴巴的 "not found"，读的人以为"证据丢了"，
 * 真相是"这一场压根没有 report.html"（压测一条响应体都不落，没有东西可摆进报告）。
 *
 * 这正是 docs/08 §3 登记的那一族：**有载体、没有生产者**的反向版 ——
 * 有生产者、没有消费者。字段带着一个它承诺过的行为（"区分开"），
 * 而那份承诺从没被执行过一次。所以这里的修法不是"顺手加个标签好看一点"，
 * 是**把那份承诺兑现**：标签 + 不再链一个不存在的文件 + 说明为什么。
 *
 * ⚠ 这一格**不许出现任何"结论"**（这一场过没过、能不能当基线）。
 * 那些判断在 CLI 与 ir 里，已经有测试；在这里 `if` 一下就是第二份真相，
 * 而前端那一份没有测试。这一格只回答"这一行该画什么、该链到哪"。
 */

/** 一次 run 在列表里那一行的读法。全部是**字符串与布尔**，页面负责画 */
export interface RunRow {
  /** 是不是压测的 run（写侧的 `manifest.kind === 'load'`） */
  isLoad: boolean;
  /** 场景那一格后面要挂的标签。顺序即显示顺序 */
  tags: string[];
  /**
   * 有没有 `report.html` 可链。
   *
   * **判据是 `kind`，不是"磁盘上有没有那个文件"**：前端拿不到目录清单，
   * 而 `kind` 正是写侧在写下这份产物的那一刻给出的答案 —— 同一处判断不留第二个答案。
   */
  hasReport: boolean;
  /** 没有 report 时那句**原因**。有 report 时是空串（页面上不该多一行废话） */
  reportWhy: string;
}

/**
 * 压测清单上那个 `kind` 的值。**名单只在这一处**：写侧写它、这一格读它。
 *
 * 为什么不在这里 import 写侧那个常量：`packages/web` 不许依赖 `packages/cli`
 * （`tooling/lint-layers.mjs`），所以这一格只能自己写。为防它漂，
 * `packages/cli/test/load.test.ts` 里有一条**从磁盘上的 manifest 反推**的断言
 * （它读真产物、断 `kind === 'load'`），两边各钉一次，漂的那一次会当场红。
 */
export const LOAD_RUN_KIND = 'load';

/** 没有 report 时屏幕上那句话。**必须自己说清"为什么没有"**，见文件头那条 404 的来路 */
export const LOAD_NO_REPORT_HINT = '无 report（压测不存响应体）';

export function runRow(m: Record<string, unknown>): RunRow {
  const sc = (m.scenario ?? {}) as Record<string, unknown>;
  const isLoad = m.kind === LOAD_RUN_KIND;
  const tags: string[] = [];
  /*
   * 压测的标签排在"未冻结"**前面**。顺序不是审美：那一格里
   * 「压测」回答的是"这一行为什么没有 report"（读者第一个问题），
   * 「未冻结」回答的是"这次能不能当 CI 依据"（第二个问题）。
   * 反过来排会让人以为没有 report 是因为没冻结 —— 两者毫无关系。
   */
  if (isLoad) tags.push('压测');
  // `frozen === false` 而不是 `!sc.frozen`：字段缺省时后者为真，
  // 而"清单里没写 frozen"与"作者声明了未冻结"是两件事，后者才是要报警的那件
  if (sc.frozen === false) tags.push('未冻结');
  return {
    isLoad,
    tags,
    hasReport: !isLoad,
    reportWhy: isLoad ? LOAD_NO_REPORT_HINT : '',
  };
}
