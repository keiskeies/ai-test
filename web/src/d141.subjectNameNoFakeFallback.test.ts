// D141 哨兵：subject_name 的「（…已删除）」假兜底不许回流。
//
// 病因（台账 D141，第四十五轮结案）：`run_record.subject_name` 是 **NOT NULL 快照列**
// （backend/app/modules/execution/models.py:22，注释逐字「对象删除后仍可读」，迁移 0009
// 起从未放宽；报告级两个 Out 也钉成 str（`class ReportListItemOut` = report_services.py:52、
// `class ReportGetOut` = :84，各自点名，不靠「A/B 对 52/84」的位置默契 —— 那种写法一漂就串位）。可 RunOut 曾把它声明成 `str | None`，前端因此必须兜——而兜出的那句在语义上是
// 假的：**名字为空从来不代表对象被删**（对象删了名字恰恰还在，这就是快照列的全部意义）。
// reportDetail 那处更硬：契约是 str，类型上就进不了那个分支，是纯粹的死码。
//
// 裁的是契约侧（收紧成 str + 删兜底），不是把句子改得更准——因为那一格根本不可达，
// 任何句子都是对不存在状态的描述。可达的「查不到」另有其人：run 详情整体取不到时
// adbDevices 的 runFailed / runs 的抽屉不开，那些分支各自有测试。
//
// 本哨兵只扫**非测试源码**（*.ts / *.tsx，排除 *.test.*）：
// - 测试允许出现这两句——反向断言（.not.toContain）与本页自己的用例都要引用旧句作证词；
// - 源码注释也不豁免：注释里写「旧兜底（场景已删除）」会让 grep 分不清「还在用」与
//   「在讲历史」，所以本轮把四处说明性注释统一改成「…已删除」，把字面量留给断言。
// 尺与 emoji 红线（emoji.redline.test.ts）同族：静态扫源码文本，不碰网络不碰 DOM。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRow } from "./api/api";

/** 编译期钉（D3 那条轴）：RunRow["subject_name"] 必须是 string。
 *  删掉兜底后「前端接口回退成可空」在运行时**测不出来**（没有任何行为分支还依赖它），
 *  tsc 对 render 形参又是双变的——只有类型层这一钉会让它红在门禁 ④。
 *  放宽成 string | null ⇒ 这里 false 不能赋给 true ⇒ tsc 直接红。 */
const _subjectNameMustBeString: RunRow["subject_name"] extends string ? true : false = true;
void _subjectNameMustBeString;

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = ["（对象已删除）", "（场景已删除）"] as const;

/** 递归收 src/ 下的非测试源文件。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { out.push(...sources(p)); continue; }
    if (!/\.(ts|tsx)$/.test(ent.name) || /\.test\.(ts|tsx)$/.test(ent.name)) continue;
    out.push(p);
  }
  return out;
}

describe("D141 哨兵：「（对象已删除）」/「（场景已删除）」不许出现在非测试源码", () => {
  it("src 下所有 .ts/.tsx（测试除外）零命中", () => {
    const hits: string[] = [];
    for (const f of sources(SRC)) {
      const lines = readFileSync(f, "utf-8").split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const phrase of FORBIDDEN) {
          if (line.includes(phrase)) hits.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    // 命中即说明有人重新给不可达的分支续命：先回去读 execution/models.py:22 那句注释，
    // 再判「这真的是可达的查不到」还是「又一次把快照列当可空列」。
    expect(hits).toEqual([]);
  });

  it("快照列的语义反证钉死：后端 RunOut.subject_name 是必填 str", async () => {
    // 哨兵的另一半：句子删了，契约也得真是 str——否则前端删兜底只是把崩溃点挪进渲染。
    // 读后端源码而不是跑服务：便宜、确定性，且 test_execution_core.py 那族已在行为侧跑过。
    const be = join(SRC, "..", "backend", "app", "modules", "execution", "services.py");
    // \r 归一：仓里后端源文件是 CRLF（core.autocrlf），断言行尾字节是给自己埋雷
    const src = readFileSync(be, "utf-8").replace(/\r/g, "");
    const runOut = src.slice(src.indexOf("class RunOut(BaseModel):"));
    const body = runOut.slice(0, runOut.indexOf("\nclass "));
    expect(body).toMatch(/^ {4}subject_name: str$/m);
    expect(body).not.toMatch(/subject_name: str \| None/);
  });
});
