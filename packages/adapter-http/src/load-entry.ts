/**
 * 编译产物（生成的那份 k6 脚本）**唯一**能拿到的运行时入口。
 *
 * ## 为什么这个文件存在（而不是在预lude 里重写一遍取值/拼 URL/断言）
 *
 * 编译出去的那段脚本跑在另一个 JS 运行时里，最省事的做法是照着语义"再写一遍"
 * `{expr}` 怎么求值、query 数组怎么序列化、断言怎么判。那正是本仓反复付出代价的那一族：
 * `interpreter.ts` 里 `composeUrl` 那一大段注释记的就是同一件事的第三次发生 ——
 * 引擎手搓一份 URL 序列化、mock 内联手抄一份、真正照 spec 实现的那份零调用，
 * 结果是「发出去的值不是用例里写的那个值而用例照绿」（数组被压成一个 JSON 文本，
 * 后端回 200，全绿）。所以这里**不重写**，而是把引擎与 adapter-http 里那**同一份**
 * 实现打进来：
 *
 *   walkSyncK6     整棵计划的调度（语义全在里面：求值、拼 URL、鉴权、断言、控制流）
 *   newLoadState   与功能回归同一个 VarSpace（inputs 的 default 兜底、步骤导出）
 *   secretFromEnv  按 ref 从环境取真值（名字规矩在 @atest/ir 的 secrets.ts，全仓同一份）
 *
 * ## 导出表**只有三个**，而这是刻意的
 * 生成脚本的 import 句是 `import { walkSyncK6, newLoadState, secretFromEnv }`。
 * `test/load-k6.test.ts` 拿着那句去真模块问"你有这几个导出吗"，少一个当场红
 * （那条测试不需要 k6、也不需要打包）。**多加**导出同样有人管 —— 多余的导出会进
 * `tooling/dead-exports.mjs` 的视野：本文件除了打包脚本没有任何 import 方，
 * 于是它每一个没人 import 的导出都是"看起来接好了而其实没人调"的那种形状。
 * 所以想要第四个符号，先让生成脚本真的用它。
 *
 * 反过来说：语义函数（resolveValue/composeUrl/evalStructAssert/queryOne/compileExpr）
 * 不在这个表里，是因为 walkSyncK6 **内部**就在调它们 —— bundle 会带上它们，
 * 只是不对外暴露。少了它们 walkSyncK6 求不出值，而那种缺法在打包时就坏了。
 *
 * ## 打出来的 bundle 有多大、为什么可以接受
 * 压缩后约 5×10⁵ 字节，大头是 zod（`@atest/ir` 的 schema 跟着 `isValueForm` 一起进来）。
 * k6 里 VU 数远大于 1 时这段只解析一次每 VU 一份，代价在**启动**而不在**每次迭代**，
 * 而压测读的是稳态分位数。真嫌大可以只 `--emit builtin`（内置后端直接 import 源模块，
 * 压根不打 bundle）。砍 bundle 的另一条路是把 `isValueForm` 那几条判据
 * 搬到一个不 import zod 的叶子模块，那是 IR 侧的重构，不在本轮范围。
 *
 * ⚠ 本文件不被运行时 import —— 用的是 `dist/${PRELUDE_FILE}`，
 * 由 `tooling/build-k6-prelude.mjs` 用 esbuild 打包本文件生成。忘了重打的后果由
 * `tooling/test/k6-prelude.test.mjs` 拦住（它**先读 dist、再不打盘地现打一份**比字节 ——
 * 那个 `write:false` 是这条判据不恒绿的前提，见打包脚本里同一段话）。
 * 只有 `test/load-k6.test.ts` 与那条 tooling 测试 import 本文件，问它导出了什么。
 *
 * 顺带一句：`export { x } from './m.js'` 这种**再导出**本身就是类型检查过的引用 ——
 * 改名字或删掉 walkSyncK6，这里当场编译不过。所以"符号对不对"不需要额外的
 * `void` 引用去钉，那一行只会让人以为它在防什么。
 */
export { newLoadState, walkSyncK6 } from './load/runtime.js';
export { secretFromEnv } from '@atest/ir';
