// 1C T15：UI 命令列表内核（纯 TS）单测。Vitest 点名于 §5.3 / §14。
// validateCommands 与后端 test_ui_commands.py 是同一套规则的两个实现：下面的
// it() 名逐条对齐后端 test_* 函数名——这张用例表是两份实现不漂移的唯一防线。
import { describe, expect, it } from "vitest";
import {
  BLOCKED_1C,
  COMMAND_TYPES,
  ELEMENT_TYPES,
  duplicateAt,
  insertAfter,
  move,
  newCommand,
  nextId,
  removeAt,
  summary,
  updateAt,
  validateCommands,
  type UiCommand,
} from "./commands";

// §7.2 需要定位器的 12 种 / 不需要的 7 种 / 必须有值的 6 种（与后端测试同名常量）
const LOCATOR_REQUIRED = [
  "click", "dblclick", "input", "clear", "select", "hover",
  "wait_element", "wait_text", "assert_text", "assert_element",
  "get_text", "get_attr",
];
const NO_LOCATOR = ["open", "sleep", "screenshot", "js", "assert_title", "key", "scroll"];
const INPUT_REQUIRED = ["input", "key", "select", "js", "assert_text", "assert_title"];

/** 一条最小可保存命令（后端同名 step() 的镜像）。 */
function step(t: string, extra: Partial<UiCommand> = {}): UiCommand {
  const s: UiCommand = {
    id: "u1", type: t, element_id: null, inline_locator: null,
    input: null, timeout_ms: null, save_var: null, optional: false,
  };
  if (LOCATOR_REQUIRED.includes(t)) s.element_id = "e1";
  if (INPUT_REQUIRED.includes(t)) s.input = "v";
  return { ...s, ...extra };
}

/** §7.2 示例逐字誊写（与后端 doc_example 同构）。 */
function docExample(): UiCommand[] {
  return [{ id: "u1", type: "click", element_id: "e-login-btn", inline_locator: null,
    input: null, timeout_ms: 10000, save_var: null, optional: false }];
}

function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code).sort();
}

// —— 协议对齐试金石（case 名 = 后端 test_* 名）——

describe("协议对齐（与后端 test_ui_commands.py 逐条同名）", () => {
  it("doc_example_is_valid", () => {
    expect(validateCommands(docExample())).toEqual([]);
  });

  it("command_types_verbatim_from_blueprint", () => {
    expect(COMMAND_TYPES).toEqual([
      "open", "click", "dblclick", "input", "clear", "select", "hover", "key", "scroll",
      "wait_element", "wait_text", "sleep", "assert_text", "assert_element", "assert_title",
      "get_text", "get_attr", "screenshot", "js",
      "upload", "download", "switch_frame", "switch_window", "dialog_accept",
    ]);
    expect(COMMAND_TYPES.length).toBe(24);
  });

  it("blocked_1c_five_types", () => {
    expect(BLOCKED_1C).toEqual({ upload: "1C+", download: "1C+", switch_frame: "1C+",
      switch_window: "1C+", dialog_accept: "1C+" });
    for (const t of Object.keys(BLOCKED_1C)) {
      const issues = validateCommands([step(t)]);
      expect(codes(issues), t).toEqual(["command_not_available"]);
      expect(issues[0].message).toContain(t);
      expect(issues[0].message).toContain("1C+"); // 要告诉用户什么时候能用
    }
  });

  it("element_types_is_five_per_R100", () => {
    expect(ELEMENT_TYPES).toEqual(["id", "css", "xpath", "text", "name"]);
  });

  it("every_type_minimal_legal", () => {
    for (const t of COMMAND_TYPES) {
      const expectCodes = t in BLOCKED_1C ? ["command_not_available"] : [];
      expect(codes(validateCommands([step(t)])), t).toEqual(expectCodes);
    }
  });

  it("locator_xor_one_is_enough", () => {
    for (const t of LOCATOR_REQUIRED) {
      expect(validateCommands([step(t, { element_id: "e1", inline_locator: null })]), t).toEqual([]);
      expect(validateCommands([step(t, {
        element_id: null, inline_locator: { type: "css", value: "#btn" },
      })]), t).toEqual([]);
    }
  });

  it("both_locators_rejected", () => {
    for (const t of LOCATOR_REQUIRED) {
      const issues = validateCommands([step(t, {
        element_id: "e1", inline_locator: { type: "css", value: "#b" },
      })]);
      expect(codes(issues), t).toEqual(["both_locators"]);
      expect(issues[0].message).toContain("二选一");
    }
  });

  it("missing_element_ref_for_locator_types", () => {
    expect(LOCATOR_REQUIRED.length).toBe(12);
    for (const t of LOCATOR_REQUIRED) {
      const issues = validateCommands([step(t, { element_id: null })]);
      expect(codes(issues), t).toEqual(["missing_element_ref"]);
    }
  });

  it("no_locator_types_ok_without_any", () => {
    for (const t of NO_LOCATOR) {
      expect(validateCommands([step(t, { element_id: null })]), t).toEqual([]);
    }
  });

  it("bad_locator_shapes", () => {
    const bads: unknown[] = [
      { type: "css" }, { value: "#b" }, { type: "jquery", value: "#b" },
      { type: "CSS", value: "#b" }, { type: "css", value: "" },
      { type: 3, value: "#b" }, "css=#b", ["css", "#b"], 42,
    ];
    for (const bad of bads) {
      const issues = validateCommands([step("click", { element_id: null, inline_locator: bad as never })]);
      expect(codes(issues), JSON.stringify(bad)).toEqual(["bad_locator"]);
    }
  });

  it("bad_timeout_values", () => {
    for (const bad of [0, -1, "10", 1.5, true]) {
      const issues = validateCommands([step("click", { timeout_ms: bad as never })]);
      expect(codes(issues), String(bad)).toEqual(["bad_timeout"]);
    }
    expect(validateCommands([step("click", { timeout_ms: 10000 })])).toEqual([]);
    expect(validateCommands([step("click", { timeout_ms: null })])).toEqual([]); // null=默认超时
  });

  it("dup_id_points_at_second_row", () => {
    const issues = validateCommands([
      step("screenshot", { id: "u1" }), step("screenshot", { id: "u1" }),
    ]);
    expect(codes(issues)).toEqual(["dup_id"]);
    expect(issues[0].index).toBe(1);
  });

  it("bad_id_shapes", () => {
    for (const bad of ["", "a b", "中文", "u1.", "u".repeat(41), 123, null]) {
      const issues = validateCommands([step("screenshot", { id: bad as never })]);
      expect(codes(issues), String(bad)).toEqual(["bad_id"]);
    }
  });

  it("bad_save_var", () => {
    for (const bad of ["a b", "1a", "a-b", "中文", ""]) {
      const issues = validateCommands([step("get_text", { save_var: bad })]);
      expect(codes(issues), bad).toEqual(["bad_save_var"]);
    }
    expect(validateCommands([step("get_text", { save_var: "user_name" })])).toEqual([]);
    expect(validateCommands([step("get_text", { save_var: null })])).toEqual([]);
  });

  it("empty_steps_blocked", () => {
    const issues = validateCommands([]);
    expect(codes(issues)).toEqual(["empty_steps"]);
    expect(issues[0].message).toContain("假绿"); // 说清为什么空数组不能存
  });

  it("missing_input_types", () => {
    expect(INPUT_REQUIRED.length).toBe(6);
    for (const t of INPUT_REQUIRED) {
      for (const bad of [null, "", 42]) {
        const issues = validateCommands([step(t, { input: bad as never })]);
        expect(codes(issues), t + String(bad)).toEqual(["missing_input"]);
      }
    }
  });

  it("optional_is_not_input", () => {
    expect(validateCommands([step("click", { optional: true })])).toEqual([]);
  });

  it("unknown_type", () => {
    for (const bad of ["kafka_send", "", 3, null]) {
      const issues = validateCommands([step("screenshot", { type: bad as never })]);
      expect(codes(issues), String(bad)).toEqual(["unknown_type"]);
    }
    expect(validateCommands([step("screenshot", { type: "kafka_send" })])[0].message)
      .toContain("kafka_send");
  });

  it("garbage_inputs_return_issues_not_exceptions", () => {
    const garbage: unknown[] = [
      null, "", "abc", 42, {}, { steps: "x" }, [[]], [[{ id: "u1", type: "screenshot" }]],
      ["x"], [null], [{}], [{ id: "u1", type: 3 }], [1, 2],
    ];
    for (const g of garbage) {
      const out = validateCommands(g);
      expect(Array.isArray(out), JSON.stringify(g)).toBe(true);
      expect(out.length, JSON.stringify(g)).toBeGreaterThan(0); // 垃圾必须产 issue
      for (const i of out) {
        expect(Object.keys(i).sort()).toEqual(["code", "index", "message"]);
        expect(Number.isInteger(i.index)).toBe(true);
      }
    }
  });
});

// —— summary：与后端 SUMMARY_CASES 逐字同串（两份实现的防漂锚点）——

const SUMMARY_CASES: [UiCommand, string][] = [
  [{ id: "u1", type: "click", element_id: "e1" }, "点击 登录按钮"],
  [{ id: "u1", type: "click", element_id: "e9" }, "点击 元素 e9"],
  [{ id: "u1", type: "click", inline_locator: { type: "css", value: "#submit" } }, "点击 css:#submit"],
  [{ id: "u1", type: "open", input: "https://x/login" }, "打开 https://x/login"],
  [{ id: "u1", type: "input", element_id: "e1", input: "admin" }, "输入 admin → 登录按钮"],
  [{ id: "u1", type: "sleep", input: "3000" }, "等待时间 3000 ms"],
  [{ id: "u1", type: "assert_title", input: "工作台" }, "断言标题 工作台"],
  [{ id: "u1", type: "js", input: "1+1" }, "执行JS 1+1"],
  [{ id: "u1", type: "screenshot" }, "截图"],
  [{ id: "u1", type: "dance" }, "dance"],
];

describe("summarize（§11.4.12 行摘要，前端真相）", () => {
  it("SUMMARY_CASES 与后端逐字一致", () => {
    const names: Record<string, string> = { e1: "登录按钮" };
    for (const [cmd, want] of SUMMARY_CASES) {
      expect(summary(cmd, names), JSON.stringify(cmd)).toBe(want);
    }
  });

  it("summarize_survives_garbage", () => {
    for (const bad of [null, "abc", 42, [], {}, { type: 3 }]) {
      expect(typeof summary(bad as never, {})).toBe("string");
    }
  });
});

// —— 列表操作：全部纯函数 + 不可变（graphOps 同款纪律）——

function list3(): UiCommand[] {
  return [
    step("open", { id: "u1", input: "http://x" }),
    step("click", { id: "u2", element_id: "e1" }),
    step("screenshot", { id: "u3" }),
  ];
}

describe("列表操作不可变", () => {
  it("每个操作后原数组逐字不变", () => {
    const src = list3();
    const before = JSON.stringify(src);
    insertAfter(src, 0, newCommand("hover"));
    removeAt(src, 1);
    move(src, 0, 2);
    duplicateAt(src, 1);
    updateAt(src, 0, { input: "changed" });
    expect(JSON.stringify(src)).toBe(before);
  });

  it("insertAfter 插到指定行之后，越界下标裁到合法范围", () => {
    const c = { id: "u9", type: "hover", element_id: "e1" };
    expect(insertAfter(list3(), 0, c).map((x) => x.id)).toEqual(["u1", "u9", "u2", "u3"]);
    expect(insertAfter(list3(), list3().length, c).map((x) => x.id)).toEqual(["u1", "u2", "u3", "u9"]);
    expect(insertAfter(list3(), -5, c).map((x) => x.id)).toEqual(["u9", "u1", "u2", "u3"]);
  });

  it("removeAt 越界返回等值新数组", () => {
    expect(removeAt(list3(), 9).map((x) => x.id)).toEqual(["u1", "u2", "u3"]);
    expect(removeAt(list3(), 1).map((x) => x.id)).toEqual(["u1", "u3"]);
  });

  it("move 重排；move 到自身位置 = 无变化", () => {
    expect(move(list3(), 0, 2).map((x) => x.id)).toEqual(["u2", "u3", "u1"]);
    expect(move(list3(), 2, 0).map((x) => x.id)).toEqual(["u3", "u1", "u2"]);
    expect(move(list3(), 1, 1)).toEqual(list3());
    expect(move(list3(), 1, 99).map((x) => x.id)).toEqual(["u1", "u3", "u2"]);
    expect(move(list3(), 9, 0)).toEqual(list3());
  });

  it("duplicateAt 返回 [新列表, 新命令]，新命令有新 id 且插在原位之后", () => {
    const src = list3();
    const [out, copy] = duplicateAt(src, 1);
    expect(copy).not.toBeNull();
    if (!copy) return;
    expect(copy.id).not.toBe("u2");
    expect(copy.type).toBe("click");
    expect(copy.element_id).toBe("e1");
    expect(out.map((x) => x.id)).toEqual(["u1", "u2", copy.id, "u3"]);
    expect(validateCommands(out)).toEqual([]);
  });

  it("duplicateAt 越界不改列表", () => {
    const src = list3();
    const [out, copy] = duplicateAt(src, 9);
    expect(out).toEqual(src);
    expect(copy).toBeNull();
  });

  it("updateAt 合并且不改嵌套原件", () => {
    const src = list3();
    const out = updateAt(src, 1, { inline_locator: { type: "css", value: "#a" }, element_id: null });
    expect(out[1].inline_locator).toEqual({ type: "css", value: "#a" });
    expect(src[1].inline_locator).toBeNull();
    expect(updateAt(src, 9, { type: "js" })).toEqual(src);
  });
});

describe("newCommand / nextId", () => {
  it("newCommand 产出可保存的底稿（需要定位器的类型带占位说明由 UI 补）", () => {
    const c = newCommand("click");
    expect(c.type).toBe("click");
    expect(c.optional).toBe(false);
    expect(c.id).toBe(""); // id 由调用方用 nextId 分配，保证唯一
    expect(summary(c, {})).toContain("点击");
  });

  it("nextId 空列表给 u1，已用递增", () => {
    expect(nextId([])).toBe("u1");
    expect(nextId(list3())).toBe("u4");
  });

  it("nextId 不复用已删除的 id", () => {
    const after = removeAt(list3(), 1); // u1,u3 —— u2 被删
    expect(nextId(after)).toBe("u4");
    expect(after.map((x) => x.id)).not.toContain(nextId(after));
  });

  it("nextId 对非 uN 风格 id 退回第一个空位", () => {
    const odd: UiCommand[] = [{ id: "foo", type: "screenshot" }, { id: "bar", type: "screenshot" }];
    expect(nextId(odd)).toBe("u1");
    const taken: UiCommand[] = [{ id: "u1", type: "screenshot" }, { id: "foo", type: "screenshot" }];
    expect(nextId(taken)).toBe("u2");
  });
});
