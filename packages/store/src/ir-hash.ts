/**
 * IR 内容指纹（M7：证据溯源的最小必要件）。
 *
 * 单独一个模块而不是塞进 evidence.ts 或 artifacts.ts，因为它有**两个消费者**：
 * 证据清单的 `scenario.irSha`（现在）与 P1 版本表的去重键（`ScenarioVersionMeta.irSha`）。
 * 两个消费者必须算出同一个值 —— 版本表按 irSha 判断"这次提交的内容是不是新版本"，
 * 证据包按 irSha 回答"这份证据出自哪一版"，两边不一致的话，
 * 拿着证据去版本表里查会查不到，而 M7 要的"可溯源"就只剩一个好看的字段。
 *
 * 为什么哈希在 store 而规范化在 ir：
 * `node:crypto` 在这里可用（本层职责就是磁盘），在 ir/engine 里是禁的
 * （那条约束换来的是"引擎能进浏览器/Worker"）。所以 ir 出 `canonicalScenario()`
 * —— 纯字符串，浏览器里的编辑器也算得出来 —— 本层只补最后一跳。
 *
 * 算法只有两个自由度，改任一条都会让**历史 irSha 集体失效**：
 *  1. 输入固定是 `canonicalScenario()` 的输出；
 *  2. 完整 64 位十六进制，**不截断**。别抄 `specHashOf` 的 16 位做法 ——
 *     那个只给人眼比对"文档变没变"，irSha 是主键与溯源依据，
 *     截断省不下什么（数据库列宽不是瓶颈），却会切断日后与 git blob id 对齐的可能。
 */
import { canonicalScenario, type Scenario } from '@atest/ir';
import { sha256Hex } from './artifacts.js';

const enc = new TextEncoder();

/** 场景的 IR 指纹。同一份 IR 语义（换文件、换键顺序、换缩进）必然得到同一个值 */
export function irShaOf(scenario: Scenario): string {
  return sha256Hex(enc.encode(canonicalScenario(scenario)));
}
