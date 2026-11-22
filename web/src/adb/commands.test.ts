// 1D T3：ADB 步骤列表内核（纯 TS）单测。Vitest 点名于 §5.3 / §14。
// validateSteps 与后端 test_adb_commands.py 是同一套规则的两个实现：下面的 it() 名
// 逐条对齐后端 test_* 函数名，SUMMARY_CASES/坏值表与后端逐字同串——这张用例表是两份
// 实现不漂移的唯一防线（R100/R101 孪生对同款）。
import { describe, expect, it } from "vitest";
import {
  CFG_SCHEMA,
  LABELS,
  OPTIONAL_ALLOWED,
  STEP_TYPES,
  duplicateAt,
  insertAfter,
  move,
  newStep,
  nextId,
  removeAt,
  summary,
  updateAt,
  validateSteps,
  type AdbStep,
} from "./commands";

// 每个 kind 一个合法样例值（与后端 SAMPLE 逐字同）。
const SAMPLE: Record<string, unknown> = {
  text: "v", ms: 1000, ms0: 0, coord: 10, int: 3, bool: true,
  var: "out1", pkg: "com.example.app", addr: "192.168.1.20:5555",
  url: "https://example.com",
};

function sample(kind: string): unknown {
  if (kind.startsWith("enum:")) return kind.slice(5).split("|")[0];
  return SAMPLE[kind];
}

/** 该 type 的完整合法 config（必填+可选全填；后端同名 full_config 的镜像）。 */
function fullConfig(t: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [spec, kind] of Object.entries(CFG_SCHEMA[t] ?? {}))
    out[spec.startsWith("!") ? spec.slice(1) : spec] = sample(kind);
  return out;
}

let idSeq = 0;

/** 一条最小可保存步骤；id 自增——写死 a1 会让任何多步序列白白多出一条 dup_id。 */
function step(t: string, extra: Partial<AdbStep> = {}): AdbStep {
  return { id: "a" + (++idSeq), type: t, device: "auto", config: fullConfig(t),
    pre_wait_ms: 0, optional: false, ...extra };
}

/** 把一条 type=t 的步骤放进「可保存」的最小序列（录屏两步天生不能单独存在，§6.4）。 */
function one(t: string, extra: Partial<AdbStep> = {}): AdbStep[] {
  const s = step(t, extra);
  if (t === "screen_record_start") return [s, step("screen_record_stop")];
  if (t === "screen_record_stop") return [step("screen_record_start"), s];
  return [s];
}

/** §7.3 示例逐字誊写（与后端 doc_example 同构）。 */
function docExample(): AdbStep[] {
  return [{ id: "a1", type: "click_by_text", device: "auto",
    config: { text: "登录", timeout_ms: 8000 }, pre_wait_ms: 0, optional: false }];
}

function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code).sort();
}

// 每种参数种类的坏值（与后端 BAD_BY_KIND 同一批字面值）
const BAD_BY_KIND: Record<string, unknown[]> = {
  text: ["", "   ", 42, true, [], {}],
  ms: [0, -1, 1.5, "1000", true],
  ms0: [-1, 1.5, "0"],
  coord: [-1, 1.5, "10"],
  int: [0, -1, 1.5, "3"],
  bool: ["true", 0, 1, ""],
  var: ["", "1a", "a-b", "a b", "中文", 42],
  pkg: ["", "com", "com.", "1com.x", "com..x", "com.example.app!"],
  addr: ["", "1.2.3.4", "1.2.3.4:", ":5555", "1.2.3.4:abc", "1.2.3.4:99999"],
  url: ["", "example.com", "ftp://x", "://x"],
};

// —— 协议对齐试金石（it 名 = 后端 test_* 名）——

describe("协议对齐（与后端 test_adb_commands.py 逐条同名）", () => {
  it("doc_example_is_valid", () => {
    expect(validateSteps(docExample())).toEqual([]);
  });

  it("step_types_verbatim_from_blueprint", () => {
    expect(STEP_TYPES).toEqual([
      "connect", "shell", "install", "uninstall", "start_app", "kill_app",
      "click_xy", "long_click", "swipe", "input_text",
      "click_by_text", "click_by_xpath",
      "assert_text", "assert_element", "assert_toast",
      "screenshot", "screen_record_start", "screen_record_stop",
      "sleep", "file_push", "file_pull", "assert_file",
      "back", "home", "open_url", "extract_ui_text",
    ]);
    expect(STEP_TYPES.length).toBe(26);
  });

  it("schema_covers_every_type_exactly_once", () => {
    expect(Object.keys(CFG_SCHEMA).sort()).toEqual([...STEP_TYPES].sort());
    const empty = STEP_TYPES.filter((t) => Object.keys(CFG_SCHEMA[t]).length === 0);
    expect(empty).toEqual(["back", "home"]);
    expect(Object.keys(LABELS).sort()).toEqual([...STEP_TYPES].sort());
  });

  it("every_type_minimal_legal", () => {
    for (const t of STEP_TYPES) expect(validateSteps(one(t))).toEqual([]);
  });

  it("missing_required_config_named_per_key", () => {
    for (const [t, schema] of Object.entries(CFG_SCHEMA)) {
      for (const spec of Object.keys(schema)) {
        if (!spec.startsWith("!")) continue;
        const key = spec.slice(1);
        const cfg = fullConfig(t);
        delete cfg[key];
        const issues = validateSteps(one(t, { config: cfg }));
        expect(codes(issues), t + "/" + key).toEqual(["missing_config"]);
        expect(issues[0].message).toContain(key);
      }
    }
  });

  it("optional_config_keys_may_be_absent", () => {
    for (const [t, schema] of Object.entries(CFG_SCHEMA)) {
      const cfg: Record<string, unknown> = {};
      for (const [spec, kind] of Object.entries(schema))
        if (spec.startsWith("!")) cfg[spec.slice(1)] = sample(kind);
      expect(validateSteps(one(t, { config: cfg })), t).toEqual([]);
    }
  });

  it("bad_config_values_are_bad_config", () => {
    for (const [t, schema] of Object.entries(CFG_SCHEMA)) {
      for (const [spec, kind] of Object.entries(schema)) {
        const key = spec.startsWith("!") ? spec.slice(1) : spec;
        const bads = kind.startsWith("enum:") ? ["nope"] : BAD_BY_KIND[kind] ?? [];
        for (const bad of bads) {
          const cfg = fullConfig(t);
          cfg[key] = bad;
          const out = validateSteps(one(t, { config: cfg }));
          expect(codes(out), t + "/" + key + "=" + JSON.stringify(bad)).toEqual(["bad_config"]);
        }
      }
    }
  });

  it("extract_ui_text_selector_pair", () => {
    // by/value 都是**可选项**（§7.3）：整对缺位=整屏提取，合法；只给一半=说不清从哪提取。
    expect(validateSteps(one("extract_ui_text", { config: { save_var: "t" } }))).toEqual([]);
    // 「一半」指键缺席/null（不是空串——空串先撞 text/enum 的 bad_config，另一条路径）。
    expect(codes(validateSteps(one("extract_ui_text",
      { config: { save_var: "t", by: "text" } }))))
      .toEqual(["bad_selector_pair"]);
    expect(codes(validateSteps(one("extract_ui_text",
      { config: { save_var: "t", value: "登录" } }))))
      .toEqual(["bad_selector_pair"]);
    expect(validateSteps(one("extract_ui_text",
      { config: { save_var: "t", by: "text", value: "登录" } }))).toEqual([]);
  });

  it("device_field", () => {
    expect(validateSteps(one("shell", { device: "192.168.1.20:5555" }))).toEqual([]);
    expect(validateSteps(one("shell", { device: null }))).toEqual([]);
    for (const bad of ["", "   ", 42, true, []])
      expect(codes(validateSteps(one("shell", { device: bad as unknown as string }))),
        String(bad)).toEqual(["bad_device"]);
  });

  it("pre_wait_field", () => {
    expect(validateSteps(one("shell", { pre_wait_ms: 0 }))).toEqual([]);
    expect(validateSteps(one("shell", { pre_wait_ms: null }))).toEqual([]);
    for (const bad of [-1, 1.5, "100", true])
      expect(codes(validateSteps(one("shell", { pre_wait_ms: bad as unknown as number }))),
        String(bad)).toEqual(["bad_pre_wait"]);
  });

  it("optional_field_and_semantics", () => {
    expect(validateSteps(one("assert_text", { optional: true }))).toEqual([]);
    expect(validateSteps(one("screenshot", { optional: true }))).toEqual([]);
    expect(codes(validateSteps(one("assert_text",
      { optional: "yes" as unknown as boolean })))).toEqual(["bad_optional"]);
    for (const t of [...STEP_TYPES].filter((x) => !OPTIONAL_ALLOWED.includes(x as never)).sort())
      expect(codes(validateSteps(one(t, { optional: true }))), t).toEqual(["optional_on_action"]);
  });

  it("optional_allowed_is_assert_extract_and_screenshot_only", () => {
    expect([...OPTIONAL_ALLOWED].sort()).toEqual(["assert_element", "assert_file",
      "assert_text", "assert_toast", "extract_ui_text", "screenshot"]);
  });

  it("empty_steps_blocked", () => {
    const issues = validateSteps([]);
    expect(codes(issues)).toEqual(["empty_steps"]);
    expect(issues[0].message).toContain("假绿");
  });

  it("unknown_type", () => {
    for (const bad of ["kafka_send", "", 3, null]) {
      const issues = validateSteps(one("back", { type: bad as unknown as string }));
      expect(codes(issues), String(bad)).toEqual(["unknown_type"]);
    }
    expect(validateSteps(one("back", { type: "kafka_send" }))[0].message)
      .toContain("kafka_send");
  });

  it("garbage_inputs_return_issues_not_exceptions", () => {
    const garbage: unknown[] = [null, "", "abc", 42, {}, { steps: "x" }, [[]],
      [[{ id: "a1", type: "back" }]], ["x"], [null], [{}],
      [{ id: "a1", type: 3 }], [1, 2],
      [{ id: "a1", type: "shell", config: "ls" }],
      [{ id: "a1", type: "shell", config: ["ls"] }]];
    for (const g of garbage) {
      const out = validateSteps(g);
      expect(Array.isArray(out), JSON.stringify(g)).toBe(true);
      expect(out.length, JSON.stringify(g)).toBeGreaterThan(0);
      for (const i of out) {
        expect(Object.keys(i).sort()).toEqual(["code", "index", "message"]);
        expect(Number.isInteger(i.index)).toBe(true);
      }
    }
  });

  it("validate_does_not_mutate_input", () => {
    const steps = [...docExample(), step("screen_record_start"), step("screen_record_stop")];
    const before = JSON.stringify(steps);
    validateSteps(steps);
    expect(JSON.stringify(steps)).toBe(before);
  });
});

// —— 录屏起止包裹（§6.4，序列级）——

describe("录屏起止包裹", () => {
  it("recording_pair_legal_wrapping", () => {
    const seq = [step("screen_record_start"), step("shell", { config: { cmd: "ls" } }),
      step("screen_record_stop")];
    expect(validateSteps(seq)).toEqual([]);
    const seq2 = [...seq, step("screen_record_start"), step("screen_record_stop")];
    expect(validateSteps(seq2)).toEqual([]);
  });

  it("recording_stop_without_start", () => {
    const issues = validateSteps([step("screen_record_stop")]);
    expect(codes(issues)).toEqual(["record_unpaired"]);
    expect(issues[0].index).toBe(0);
  });

  it("recording_start_without_stop", () => {
    const issues = validateSteps([step("screen_record_start"), step("shell")]);
    expect(codes(issues)).toEqual(["record_unpaired"]);
    expect(issues[0].index).toBe(0);
  });

  it("recording_nested_start", () => {
    const issues = validateSteps([step("screen_record_start"), step("screen_record_start")]);
    expect(codes(issues)).toEqual(["record_unpaired", "record_unpaired"]);
    // 两条都钉在第 2 行（唯一需要动手的行），第 1 段未闭合写在消息文本里——与后端同规。
    expect(new Set(issues.map((i) => i.index))).toEqual(new Set([1]));
    const text = issues.map((i) => i.message).join("");
    expect(text).toContain("第 1 行");
    expect(text).toContain("第 2 行");
  });

  it("recording_pairs_ignore_malformed_steps", () => {
    // 换行会踩 ASI：`as unknown` 行尾即语句终点，续行的 `as AdbStep[]` 被当成语句开头（esbuild 实测）。
    const seq = [step("screen_record_start"), null,
      step("screen_record_stop")] as unknown as AdbStep[];
    expect(codes(validateSteps(seq))).toEqual(["bad_step"]);
  });
});

// —— id 规则（R102）——

describe("id 规则", () => {
  it("dup_id_points_at_second_row", () => {
    const a = step("back", { id: "a1" });
    const issues = validateSteps([a, step("back", { id: "a1" })]);
    expect(codes(issues)).toEqual(["dup_id"]);
    expect(issues[0].index).toBe(1);
  });

  it("bad_id_shapes", () => {
    for (const bad of ["", "a b", "中文", "a1.", "u".repeat(41), 123, null])
      expect(codes(validateSteps([step("back", { id: bad as unknown as string })])),
        String(bad)).toEqual(["bad_id"]);
  });

  it("next_id_is_max_plus_one", () => {
    expect(nextId([])).toBe("a1");
    expect(nextId(["a1", "a3"])).toBe("a4");
    // 非 aN 形态的 id 不参与计数（max 口径只认 aN）
    expect(nextId([step("back", { id: "a2" }), step("back", { id: "b1" })])).toBe("a3");
    expect(nextId(["a9", "a10"])).toBe("a11"); // 按数值不是字典序
  });
});

// —— 列表操作（不可变 + config 深拷贝）——

describe("列表操作", () => {
  const base: AdbStep[] = [step("back"), step("home"), step("shell")];

  it("operations_return_new_arrays", () => {
    const snapshot = JSON.stringify(base);
    insertAfter(base, 0, step("back")); removeAt(base, 1); move(base, 0, 2);
    updateAt(base, 0, { optional: true }); duplicateAt(base, 0);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("insert_after_clamps", () => {
    expect(insertAfter(base, 1, step("back")).length).toBe(4);
    expect(insertAfter(base, 99, step("back")).length).toBe(4);
    expect(insertAfter(base, -5, step("back"))[0].type).toBe("back");
  });

  it("out_of_range_is_noop_not_crash", () => {
    expect(removeAt(base, 9)).toEqual(base);
    expect(removeAt(base, -1)).toEqual(base);
    expect(move(base, 9, 0)).toEqual(base);
    expect(duplicateAt(base, 9)[1]).toBeNull();
    expect(updateAt(base, 9, { optional: true })).toEqual(base);
  });

  it("duplicate_gets_fresh_id_after_source", () => {
    const [out, copy] = duplicateAt(base, 0);
    expect(copy!.id).not.toBe(base[0].id);
    expect(out[1].id).toBe(copy!.id);
    expect(out.length).toBe(4);
  });

  it("duplicate_deep_copies_config", () => {
    const [out] = duplicateAt(base, 2);
    (out[1].config as Record<string, unknown>).cmd = "changed";
    expect((base[2].config as Record<string, unknown>).cmd).toBe("v");
  });

  it("update_merges_config_one_level", () => {
    const out = updateAt(base, 2, { config: { cmd: "ls" } });
    expect(out[2].config).toEqual({ cmd: "ls" });
    expect(out[2].type).toBe("shell");
  });

  it("new_step_shapes_config_by_schema", () => {
    const s = newStep("click_by_text");
    // text 类给空串（用户看得见「没填」），数字/var 类不给占位——给了就等于填过，required 哑火
    expect(s.config).toEqual({ text: "" });
    expect(s.device).toBe("auto");
    expect(newStep("install").config).toEqual({ path: "", reinstall: false });
    expect(newStep("back").config).toEqual({});
    expect("ms" in (newStep("sleep").config ?? {})).toBe(false);
    expect("x" in (newStep("click_xy").config ?? {})).toBe(false);
    expect("save_var" in (newStep("screenshot").config ?? {})).toBe(false);
    // enum 类给空串：下拉的「未选」态，不是词表首个值（替用户预选是悄悄改值）
    expect(newStep("assert_element").config).toEqual({ by: "", value: "" });
  });
});

// —— summary：与后端 SUMMARY_CASES 逐字同串（两份实现的防漂锚点）——

const SUMMARY_CASES: [unknown, string][] = [
  [{ id: "a1", type: "click_by_text", config: { text: "登录" } }, "按文本点击 登录"],
  [{ id: "a1", type: "click_by_text", config: {} }, "按文本点击 （未填）"],
  [{ id: "a1", type: "shell", config: { cmd: "dumpsys battery" } },
    "Shell 命令 dumpsys battery"],
  [{ id: "a1", type: "shell", config: {} }, "Shell 命令 （未填命令）"],
  [{ id: "a1", type: "click_xy", config: { x: 100, y: 200 } }, "坐标点击 (100,200)"],
  [{ id: "a1", type: "click_xy", config: {} }, "坐标点击 （未填坐标）"],
  [{ id: "a1", type: "start_app", config: { package: "com.demo.app" } },
    "启动应用 com.demo.app"],
  [{ id: "a1", type: "sleep", config: { ms: 3000 } }, "等待时间 3000 ms"],
  [{ id: "a1", type: "screenshot", config: { save_var: "shot" } }, "截图 → $shot"],
  [{ id: "a1", type: "screenshot", config: {} }, "截图"],
  [{ id: "a1", type: "screen_record_start", config: { max_s: 60 } }, "开始录屏 ≤60s"],
  [{ id: "a1", type: "assert_element", config: { by: "resource_id", value: "btn" } },
    "断言控件 btn [resource_id]"],
  [{ id: "a1", type: "file_pull", config: { remote: "/sdcard/a.txt" } },
    "拉取文件 /sdcard/a.txt"],
  [{ id: "a1", type: "assert_file", config: { remote: "/sdcard/a.txt", contains: "ok" } },
    "断言文件 /sdcard/a.txt 含「ok」"],
  [{ id: "a1", type: "extract_ui_text", config: { save_var: "t" } }, "提取界面文本 → $t"],
  [{ id: "a1", type: "back" }, "返回键"],
  [{ id: "a1", type: "dance" }, "dance"],
];

describe("summary（与后端 SUMMARY_CASES 逐字同串）", () => {
  it("summarize_table", () => {
    for (const [stp, expectStr] of SUMMARY_CASES) expect(summary(stp)).toBe(expectStr);
  });

  it("summarize_survives_garbage", () => {
    for (const bad of [null, "abc", 42, [], {}, { type: 3 }, { type: "shell", config: 42 }])
      expect(typeof summary(bad)).toBe("string");
  });
});
