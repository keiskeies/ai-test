// §7.2 UI 命令协议的前端内核（1C T15）：类型常量 + 列表 reducer + 本地校验 + 行摘要。
// 纯模块：不含 React/DOM import，全部操作返回新数组不原地改（graphOps.ts 同款纪律）。
// 后端 app/modules/ui_test/commands.py 是最终真相；validateCommands 只服务「保存前
// 即时反馈」。两份实现的防漂锚点是 commands.test.ts 与 test_ui_commands.py 的同名用例表。
import {
  duplicateRowAt, insertAfterRow, moveRow, nextRowId, removeRowAt, updateRowAt,
} from "../shared/stepList";

/** §7.2 命令对象（steps JSON 数组元素，line 389-391）。 */
export interface UiCommand {
  id: string;
  type: string;
  element_id?: string | null;
  inline_locator?: { type: string; value: string } | null;
  input?: string | null;
  timeout_ms?: number | null;
  save_var?: string | null;
  optional?: boolean;
  [key: string]: unknown;
}

// 24 种 type 逐字取自蓝图 §7.2 line 393 的枚举串，顺序即原文顺序（与后端 COMMAND_TYPES 同）。
export const COMMAND_TYPES = [
  "open", "click", "dblclick", "input", "clear", "select", "hover", "key", "scroll",
  "wait_element", "wait_text", "sleep", "assert_text", "assert_element", "assert_title",
  "get_text", "get_attr", "screenshot", "js",
  "upload", "download", "switch_frame", "switch_window", "dialog_accept",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** R101：5 种 1C 不开放（下拉可见但 disabled；保存必被后端拒，本地预检同口径）。 */
export const BLOCKED_1C: Record<string, string> = {
  upload: "1C+", download: "1C+", switch_frame: "1C+", switch_window: "1C+", dialog_accept: "1C+",
};

/** R100/D2：§4.4 表 5 种 vs §6.3「六类型」是蓝图自相矛盾，一期按表做 5 个。 */
export const ELEMENT_TYPES = ["id", "css", "xpath", "text", "name"] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/** 需要定位器的 12 种（24 − 5 blocked − 7 个页面级命令，与后端 LOCATOR_REQUIRED 同）。 */
export const LOCATOR_REQUIRED = [
  "click", "dblclick", "input", "clear", "select", "hover",
  "wait_element", "wait_text", "assert_text", "assert_element",
  "get_text", "get_attr",
] as const;
/** 「必须有值」6 种（与后端 INPUT_REQUIRED 同）。 */
export const INPUT_REQUIRED = ["input", "key", "select", "js", "assert_text", "assert_title"] as const;

const MAX_ID_LENGTH = 40; // 同后端：id 写进 run_step_result.step_key（R102）
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SAVE_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// §6.3 括号里的中文命令名（§11.4.12 行摘要用，与后端 _LABELS 同表）。
// T16 起导出：CommandParams 的下拉选项名必须与摘要同一张表，两处各写一份迟早漂。
export const LABELS: Record<string, string> = {
  open: "打开", click: "点击", dblclick: "双击", input: "输入", clear: "清除",
  select: "选择", hover: "悬停", key: "按键", scroll: "滚动",
  wait_element: "等待元素", wait_text: "等待文本", sleep: "等待时间",
  assert_text: "断言文本", assert_element: "断言元素", assert_title: "断言标题",
  get_text: "获取文本", get_attr: "获取属性", screenshot: "截图", js: "执行JS",
  upload: "上传", download: "下载", switch_frame: "切frame",
  switch_window: "切窗口", dialog_accept: "处理弹窗",
};

/** 可插入清单（§11.4.12 的「+ 添加命令」下拉）：被拦的 5 种不进——插进去就是一条
 *  存不了的命令。已在的老数据坏了由 CommandParams 的 disabled 下拉 + 保存期 422 兜住。
 *  位置注意：必须在 LABELS 之后——这是模块加载期求值的表达式，写前面是 TDZ 崩溃。 */
export const INSERTABLE_UI: readonly string[] = Object.keys(LABELS).filter((t) => !BLOCKED_1C[t]);

// —— 列表操作（1D T9 起委托 shared/stepList 内核：与 adb/commands.ts 共用一份实现；
//  下标非法一律返回等值新数组，绝不抛。签名不变——孪生测试与页面 import 一行不改。）——

/** 新建一条命令底稿：id 留空由调用方用 nextId 分配；需要 input 的类型给空串占位。 */
export function newCommand(type: string): UiCommand {
  const cmd: UiCommand = {
    id: "", type, element_id: null, inline_locator: null,
    input: null, timeout_ms: null, save_var: null, optional: false,
  };
  if ((INPUT_REQUIRED as readonly string[]).includes(type)) cmd.input = "";
  return cmd;
}

/** 在 index 之后插入 cmd；index 越界裁到 [0, len]（插到末尾/开头仍是有义操作）。 */
export function insertAfter(list: UiCommand[], index: number, cmd: UiCommand): UiCommand[] {
  return insertAfterRow(list, index, { ...cmd });
}

/** 删除 index 位；越界返回等值新数组。 */
export function removeAt(list: UiCommand[], index: number): UiCommand[] {
  return removeRowAt(list, index);
}

/** 同层重排：把 from 移到 toIndex（0-based，语义同 graphOps.reorder：先删后插）。 */
export function move(list: UiCommand[], from: number, toIndex: number): UiCommand[] {
  return moveRow(list, from, toIndex);
}

/** 复制 index 位：换新 id（nextId 口径，不复用已删 id）、插回原位之后。返回 [列表, 新命令]。 */
export function duplicateAt(list: UiCommand[], index: number): [UiCommand[], UiCommand | null] {
  return duplicateRowAt(list, index, "u");
}

/** 合并更新 index 位（浅合并；patch 里给了 inline_locator 就整块换掉）。 */
export function updateAt(list: UiCommand[], index: number, patch: Partial<UiCommand>): UiCommand[] {
  return updateRowAt(list, index, patch);
}

/**
 * 生成下一个命令 id："u" + (已有 uN 的最大 N + 1)，空列表给 "u1"。
 * 刻意取 max+1 而不是最小空位：删除 u2 后新命令拿 u4，**永不复用已删 id**——历史
 * run_step_result.step_key 指向的命令行必须永远唯一（R102/R103 的重跑与追溯前提）。
 */
export function nextId(existing: Iterable<UiCommand | string>): string {
  return nextRowId("u", existing);
}

// —— 本地预检（与后端 validate_commands 同源规则；后端是最终真相）——

export interface UiIssue {
  index: number;
  code: string;
  message: string;
}

function isPlainInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

function nonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

function locatorProblem(loc: unknown): string | null {
  if (!loc || typeof loc !== "object" || Array.isArray(loc))
    return "inline_locator 必须是 {type, value} 对象，实际是 " + (Array.isArray(loc) ? "array" : typeof loc);
  const l = loc as { type?: unknown; value?: unknown };
  if (!(ELEMENT_TYPES as readonly string[]).includes(l.type as string))
    return "inline_locator.type " + JSON.stringify(l.type ?? "(未填)")
      + " 不是定位器类型；一期支持（R100/D2，§4.4 表 5 种）：" + ELEMENT_TYPES.join(" / ");
  if (!nonEmptyStr(l.value))
    return "inline_locator.value 不能为空：定位器类型后面得真的写出表达式";
  return null;
}

/** 本地预检：对命令数组做保存前检查。只产 issue、绝不抛异常、不改入参。 */
export function validateCommands(steps: unknown): UiIssue[] {
  const issues: UiIssue[] = [];
  const push = (index: number, code: string, message: string): void => {
    issues.push({ index, code, message });
  };
  if (!Array.isArray(steps)) {
    push(-1, "bad_step",
      "UI 命令序列必须是 JSON 数组（§7.2 steps），实际是 " + (steps === null ? "null" : typeof steps));
    return issues;
  }
  if (steps.length === 0) {
    push(-1, "empty_steps",
      "命令序列不能为空：空用例跑起来「零步全绿」是假绿，保存期就拦（§7.2/§13 纪律 1）");
    return issues;
  }
  const seen = new Set<string>();
  steps.forEach((raw: unknown, i: number) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      push(i, "bad_step", "命令必须是 JSON 对象（§7.2），实际是 " + (Array.isArray(raw) ? "array" : typeof raw));
      return;
    }
    const step = raw as Record<string, unknown>;

    const sid = step.id;
    const idOk = typeof sid === "string" && ID_RE.test(sid);
    if (!idOk) {
      push(i, "bad_id", "命令 id " + JSON.stringify(sid ?? "") + " 不合法：只允许字母数字下划线短横线，长 1-"
        + MAX_ID_LENGTH + "（id 会写进 run_step_result.step_key，R102）");
    } else if (seen.has(sid)) {
      push(i, "dup_id", "命令 id " + JSON.stringify(sid) + " 重复；同一用例内必须唯一"
        + "（步骤明细以 id 为行键，R102）");
    } else {
      seen.add(sid);
    }

    const t = step.type;
    if (typeof t !== "string" || !(COMMAND_TYPES as readonly string[]).includes(t)) {
      push(i, "unknown_type", "未知命令类型 " + JSON.stringify(t ?? "") + "；§7.2 全集共 "
        + COMMAND_TYPES.length + " 种：" + COMMAND_TYPES.join("|"));
      return;
    }
    if (BLOCKED_1C[t]) {
      push(i, "command_not_available", t + " 命令要到 " + BLOCKED_1C[t] + " 批次才开放（R101："
        + "文件选择/下载监听/frame 与窗口句柄/原生弹窗各需独立机制，半做等于做假），现在保存会被拒绝");
      return;
    }

    if ((LOCATOR_REQUIRED as readonly string[]).includes(t)) {
      const eid = step.element_id;
      const loc = step.inline_locator;
      if (eid != null && loc != null) {
        push(i, "both_locators", "element_id 与 inline_locator 二选一（§7.2 line 393）："
          + "两个都给了，运行时不知道听谁的");
      } else if (eid == null && loc == null) {
        push(i, "missing_element_ref", t + " 需要定位目标：选一个元素库元素，"
          + "或用 inline_locator 就地定位");
      } else if (eid == null) {
        const prob = locatorProblem(loc);
        if (prob) push(i, "bad_locator", prob);
      }
    }

    const tm = step.timeout_ms;
    if (tm != null && !(isPlainInt(tm) && (tm as number) > 0)) {
      push(i, "bad_timeout", "timeout_ms 给了就必须是正整数毫秒（§7.2 示例 10000），实际是 "
        + JSON.stringify(tm));
    }

    const sv = step.save_var;
    if (sv != null && !(typeof sv === "string" && SAVE_VAR_RE.test(sv))) {
      push(i, "bad_save_var", "save_var " + JSON.stringify(sv) + " 不是合法变量名："
        + "只能是字母/数字/下划线，且不能以数字开头（get_text/get_attr/js 的结果要存进变量）");
    }

    if ((INPUT_REQUIRED as readonly string[]).includes(t) && !nonEmptyStr(step.input)) {
      push(i, "missing_input", t + " 必须有 input：" + ({
        input: "要知道往元素里填什么",
        key: "要知道按哪个键（如 Enter）",
        select: "要选哪个选项值",
        js: "要执行什么脚本",
        assert_text: "要断言什么文本",
        assert_title: "要断言什么标题",
      } as Record<string, string>)[t]);
    }
  });
  return issues;
}

// —— 行摘要（§11.4.12；前端的唯一真相，后端 summarize 是孪生）——

function short(x: unknown): string {
  return typeof x === "string" ? x : String(x);
}

function elementRef(step: Record<string, unknown>, names: Record<string, string>): string {
  const eid = step.element_id;
  if (typeof eid === "string" && eid !== "") {
    const name = names?.[eid];
    return typeof name === "string" && name !== "" ? name : "元素 " + eid;
  }
  const loc = step.inline_locator;
  if (loc && typeof loc === "object") {
    const l = loc as { type?: unknown; value?: unknown };
    return (typeof l.type === "string" ? l.type : "?") + ":" + (typeof l.value === "string" ? l.value : "?");
  }
  return "";
}

/** 「命令名 + 关键参数摘要」。对任何输入都返回字符串，绝不抛。 */
export function summary(cmd: unknown, elementNames: Record<string, string>): string {
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd))
    return "命令（" + (Array.isArray(cmd) ? "array" : cmd === null ? "null" : typeof cmd) + "）";
  const step = cmd as Record<string, unknown>;
  const t = step.type;
  if (typeof t !== "string" || t === "") return "命令（未填类型）";
  const label = LABELS[t] ?? t;
  const hasLocator = step.element_id != null || step.inline_locator != null;
  if ((LOCATOR_REQUIRED as readonly string[]).includes(t) && !hasLocator)
    return label + " （未指定元素）";
  const obj = elementRef(step, elementNames);
  if (t === "input") return label + " " + short(step.input) + (obj ? " → " + obj : "");
  if (t === "sleep") return label + (step.input != null ? " " + short(step.input) + " ms" : " （未填）");
  if (["open", "assert_title", "assert_text", "wait_text", "key", "js", "select"].includes(t))
    return label + (step.input != null ? " " + short(step.input) : " （未填）");
  if (t === "wait_element") return label + " " + (obj || "（未指定元素）");
  if (t === "get_text" || t === "get_attr") {
    const sv = step.save_var;
    return label + " " + (obj || "（未指定元素）")
      + (typeof sv === "string" && sv !== "" ? " → $" + sv : "");
  }
  if (t === "scroll") return label + (step.input != null ? " " + short(step.input) : "");
  return label + (obj ? " " + obj : "");
}
