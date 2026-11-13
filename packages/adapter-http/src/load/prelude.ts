/**
 * 预lude 的**唯一**名称与符号表出处。
 *
 * ## 为什么单独一个文件
 *
 * 生成的 k6 脚本从 `./atest-load-prelude.mjs` import 若干符号，而那个文件是
 * `tooling/build-k6-prelude.mjs` 打 `src/load-entry.ts` 得到的。
 * 三个地方（脚本里的 import 句、entry 的导出表、打包脚本）只要有一处名字对不上，
 * 坏法是 **k6 起不来**，而本机没有 k6 —— 于是这个错要等到用户那边才响。
 *
 * 所以：
 *  - 文件名只在这里定义（emitter 与打包脚本都读它）；
 *  - `test/load-k6.test.ts` 拿着**生成的脚本**里的 import 列表，
 *    逐个去 `../load-entry.js`（真模块、被 tsc 检查）问"你有这个导出吗"。
 *    少了任何一个当场红 —— 这一条不需要 k6，也不需要打包。
 */

/** 打进 k6 脚本同目录的那个运行时文件名 */
export const PRELUDE_FILE = 'atest-load-prelude.mjs';
