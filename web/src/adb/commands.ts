// §7.3 ADB 步骤协议的前端内核（1D T3）：类型常量 + 参数表 + 列表操作 + 本地校验 + 行摘要。
// 纯模块：不含 React/DOM import，全部操作返回新数组不原地改（ui/commands.ts 同款纪律）。
// 后端 app/modules/adb_test/commands.py 是最终真相；validateSteps 只服务「保存前即时
// 反馈」。两份实现的防漂锚点：commands.test.ts 与 test_adb_commands.py 的同名用例表。
//
// 与 UI 孪生的形状差异只有一处、且是蓝图给的：ADB 的参数收在 `config` 对象里
// （§7.3 step 对象），UI 的摊平在命令顶层（§7.2）。所以这里没有 LOCATOR_REQUIRED/
// INPUT_REQUIRED 两张手工名单，取而代之的是一张**声明式参数表 CFG_SCHEMA**——
// 「参数表单随类型切换」（§11.4.12/§11.5.5）与「保存期校验」共用同一张表，
// 表改一处，表单/校验/摘要同时跟上，不存在两份手工名单互相追平的机会。
import {
  duplicateRowAt, insertAfterRow, moveRow, nextRowId, removeRowAt, updateRowAt,
} from "../shared/stepList";

/** §7.3 步骤对象（steps JSON 数组元素）。device 是 per-step 设备覆盖："auto" 或设备 id。 */
export interface AdbStep {
  id: string;
  type: string;
  device?: string | null;
  config?: Record<string, unknown> | null;
  pre_wait_ms?: number | null;
  optional?: boolean;
  [key: string]: unknown;
}

// 26 种 type 逐字取自蓝图 §7.3 line 403 的枚举串，顺序即原文顺序（与后端 STEP_TYPES 同）。
export const STEP_TYPES = [
  "connect", "shell", "install", "uninstall", "start_app", "kill_app",
  "click_xy", "long_click", "swipe", "input_text",
  "click_by_text", "click_by_xpath",
  "assert_text", "assert_element", "assert_toast",
  "screenshot", "screen_record_start", "screen_record_stop",
  "sleep", "file_push", "file_pull", "assert_file",
  "back", "home", "open_url", "extract_ui_text",
] as const;
export type AdbStepType = (typeof STEP_TYPES)[number];

// 中文标签（§11.4.12 行摘要 + 下拉选项名同一张表，与后端 _LABELS 同）。
export const LABELS: Record<string, string> = {
  connect: "连接设备", shell: "Shell 命令", install: "安装 APK",
  uninstall: "卸载应用", start_app: "启动应用", kill_app: "杀掉应用",
  click_xy: "坐标点击", long_click: "长按", swipe: "滑动",
  input_text: "输入文本", click_by_text: "按文本点击", click_by_xpath: "按XPath点击",
  assert_text: "断言文本", assert_element: "断言控件", assert_toast: "断言Toast",
  screenshot: "截图", screen_record_start: "开始录屏", screen_record_stop: "结束录屏",
  sleep: "等待时间", file_push: "推送文件", file_pull: "拉取文件",
  assert_file: "断言文件", back: "返回键", home: "Home 键",
  open_url: "打开链接", extract_ui_text: "提取界面文本",
};

/**
 * 声明式参数表（与后端 CFG_SCHEMA 逐键同）：`!` 前缀 = 必填。
 * kind → 控件映射（T9 的参数表单按这个渲染）：
 *   text→单行/Monaco(shell 用 Monaco，§11.4.12 原话) | ms|ms0|int→数字 |
 *   coord→数字 | bool→开关 | var→变量名输入 | pkg|addr|url→单行带格式提示 |
 *   enum:a|b→下拉
 */
export const CFG_SCHEMA: Record<string, Record<string, string>> = {
  connect: { "!addr": "addr" },
  shell: { "!cmd": "text" },
  install: { "!path": "text", reinstall: "bool" },
  uninstall: { "!package": "pkg" },
  start_app: { "!package": "pkg", activity: "text" },
  kill_app: { "!package": "pkg" },
  click_xy: { "!x": "coord", "!y": "coord" },
  long_click: { "!x": "coord", "!y": "coord" },
  swipe: { "!x1": "coord", "!y1": "coord", "!x2": "coord", "!y2": "coord",
           duration_ms: "ms" },
  input_text: { "!text": "text" },
  click_by_text: { "!text": "text", timeout_ms: "ms" },
  click_by_xpath: { "!xpath": "text", timeout_ms: "ms" },
  assert_text: { "!text": "text", timeout_ms: "ms", mode: "enum:contains|equals" },
  assert_element: { "!by": "enum:text|xpath|resource_id", "!value": "text", timeout_ms: "ms" },
  assert_toast: { "!text": "text", timeout_ms: "ms" },
  screenshot: { save_var: "var" },
  screen_record_start: { max_s: "int" },
  screen_record_stop: { save_var: "var" },
  sleep: { "!ms": "ms" },
  file_push: { "!local": "text", "!remote": "text" },
  file_pull: { "!remote": "text", local: "text" },
  assert_file: { "!remote": "text", contains: "text" },
  back: {},
  home: {},
  open_url: { "!url": "url" },
  extract_ui_text: { "!save_var": "var", by: "enum:text|xpath|resource_id", value: "text" },
};

/** 允许 optional=true 的类型（失败不阻断只对断言/提取成立，与后端 OPTIONAL_ALLOWED 同）。 */
export const OPTIONAL_ALLOWED = [
  "assert_text", "assert_element", "assert_toast", "assert_file",
  "extract_ui_text", "screenshot",
] as const;

/** 可插入清单：26 种全开（ADB 侧没有「本批次不开放」的类型——assert_toast 的抓取
 *  可行性是执行期问题，保存期不装懂也不装拦，取证 ⑪/D21 记在执行核）。 */
export const INSERTABLE_ADB: readonly string[] = STEP_TYPES;

const MAX_ID_LENGTH = 40; // 同后端：id 写进 run_step_result.step_key（R102）
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const ADDR_RE = /^[A-Za-z0-9._-]+:\d{1,5}$/;
const URL_RE = /^https?:\/\/\S+$/;

// —— 列表操作（1D T9 起委托 shared/stepList 内核，与 ui/commands.ts 共用一份实现；
//  id 前缀是 "a"：§7.3 示例就叫 a1。config 是嵌套对象，复制/更新都要深一层——
//  浅拷贝会让副本改参数写穿原件，这在 UI 侧不存在（它的字段全是标量）。）——

/** 深一层拷贝行：config 脱离原引用（复制/粘贴走它）。 */
function cloneRow(src: AdbStep): AdbStep {
  return { ...src, config: { ...(src.config ?? {}) } };
}

/** 某类型的空壳 config：新步骤与「切类型重置」共用（切类型带着旧 config 装新命令
 *  就是拿脏值装合法）。text/enum 给空串（下拉的「未选」态），bool 给 false；
 *  数字类与 var/格式类**不给 0/空串占位**——给了就等于用户填过，required 校验会哑火。 */
export function emptyConfig(type: string): Record<string, unknown> {
  const schema = CFG_SCHEMA[type] ?? {};
  const config: Record<string, unknown> = {};
  for (const spec of Object.keys(schema)) {
    const key = spec.startsWith("!") ? spec.slice(1) : spec;
    const kind = schema[spec];
    if (kind === "bool") config[key] = false;
    else if (kind === "text" || kind.startsWith("enum:")) config[key] = "";
  }
  return config;
}

/** 新建一条步骤底稿：config 按参数表给空壳（必填键留缺，保存前由校验点名）。 */
export function newStep(type: string): AdbStep {
  return { id: "", type, device: "auto", config: emptyConfig(type),
    pre_wait_ms: 0, optional: false };
}

/** 在 index 之后插入 step；index 越界裁到 [0, len]。 */
export function insertAfter(list: AdbStep[], index: number, step: AdbStep): AdbStep[] {
  return insertAfterRow(list, index, cloneRow(step));
}

/** 删除 index 位；越界返回等值新数组。 */
export function removeAt(list: AdbStep[], index: number): AdbStep[] {
  return removeRowAt(list, index);
}

/** 同层重排：把 from 移到 toIndex（先删后插，语义同 ui/commands.move）。 */
export function move(list: AdbStep[], from: number, toIndex: number): AdbStep[] {
  return moveRow(list, from, toIndex);
}

/** 复制 index 位：换新 id（max+1 口径，不复用已删 id）、插回原位之后。 */
export function duplicateAt(list: AdbStep[], index: number): [AdbStep[], AdbStep | null] {
  return duplicateRowAt(list, index, "a", cloneRow);
}

/** 合并更新 index 位；config 深一层合并（参数表单每改一个键 patch 一个键）。 */
export function updateAt(list: AdbStep[], index: number, patch: Partial<AdbStep>): AdbStep[] {
  return updateRowAt(list, index, patch, (prev, p) => {
    const merged = { ...prev, ...p };
    if (p.config !== undefined && p.config !== null)
      merged.config = { ...(prev.config ?? {}), ...p.config };
    return merged;
  });
}

/**
 * 下一个步骤 id："a" + max(已有 aN)+1，空列表给 "a1"（§7.3 示例的 id 就叫 a1）。
 * max+1 而非最小空位：永不复用已删 id——历史 run_step_result.step_key 必须永远唯一
 * （R102/R103 的重跑与追溯前提，ui/commands.nextId 同一理由）。
 */
export function nextId(existing: Iterable<AdbStep | string>): string {
  return nextRowId("a", existing);
}

// —— 本地预检（与后端 validate_steps 同源规则；后端是最终真相）——

export interface AdbIssue {
  index: number;
  code: string;
  message: string;
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}
function nonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

function checkKind(key: string, val: unknown, kind: string): string | null {
  const bad = (why: string): string => key + " " + why + "，实际是 " + JSON.stringify(val ?? null);
  switch (kind) {
    case "text": return nonEmptyStr(val) ? null : key + " 必须是非空字符串";
    case "ms": return isInt(val) && (val as number) > 0 ? null : bad("必须是正整数毫秒");
    case "ms0": return isInt(val) && (val as number) >= 0 ? null : bad("必须是正整数毫秒（0=立即）");
    case "coord": return isInt(val) && (val as number) >= 0 ? null : bad("必须是非负整数坐标");
    case "int": return isInt(val) && (val as number) > 0 ? null : bad("必须是正整数");
    case "bool": return typeof val === "boolean" ? null : bad("必须是 true/false");
    case "var": return nonEmptyStr(val) && VAR_RE.test(val) ? null
      : key + " " + JSON.stringify(val ?? null) + " 不是合法变量名：只能是字母/数字/下划线，且不能以数字开头（结果要存进执行变量）";
    case "pkg": return nonEmptyStr(val) && PKG_RE.test(val) ? null
      : key + " " + JSON.stringify(val ?? null) + " 不是合法包名（如 com.example.app）";
    case "addr": {
      if (!(nonEmptyStr(val) && ADDR_RE.test(val)))
        return key + " " + JSON.stringify(val ?? null) + " 不是 ip:port（§6.4 WiFi 地址，如 192.168.1.20:5555）";
      // 与后端孪生同规：形状对但端口 >65535 的设备永远连不上，保存期就说不通
      if (Number(val.slice(val.lastIndexOf(":") + 1)) > 65535)
        return key + " " + JSON.stringify(val) + " 的端口超过 65535，不可能是 adb 端口";
      return null;
    }
    case "url": return nonEmptyStr(val) && URL_RE.test((val as string).trim()) ? null
      : key + " " + JSON.stringify(val ?? null) + " 不是 http(s) 链接";
    default:
      if (kind.startsWith("enum:")) {
        const allowed = kind.slice(5).split("|");
        return allowed.includes(val as string) ? null
          : key + " " + JSON.stringify(val ?? null) + " 不是可选值之一：" + allowed.join(" / ");
      }
      return "内部错误：未知校验种类 " + JSON.stringify(kind);
  }
}

function validateConfig(i: number, t: string, config: unknown,
                        push: (index: number, code: string, message: string) => void): void {
  const schema = CFG_SCHEMA[t] ?? {};
  if (config == null) return; // 缺 config 按空配置处理：必填键在下面自然被点名
  if (typeof config !== "object" || Array.isArray(config)) {
    push(i, "bad_config", t + " 的 config 必须是 JSON 对象（§7.3），实际是 "
      + (Array.isArray(config) ? "array" : typeof config));
    return;
  }
  const cfg = config as Record<string, unknown>;
  for (const [spec, kind] of Object.entries(schema)) {
    const required = spec.startsWith("!");
    const key = required ? spec.slice(1) : spec;
    if (!(key in cfg) || cfg[key] == null) {
      if (required)
        push(i, "missing_config", t + " 缺少必填参数 " + key
          + "（§11.4.12 展开行的参数表单就是按这张表生成的，§7.3）");
      continue;
    }
    const prob = checkKind(key, cfg[key], kind);
    if (prob) push(i, "bad_config", t + "：" + prob);
  }
  if (t === "extract_ui_text") {
    const by = cfg.by, value = cfg.value;
    if ((by == null) !== (value == null))
      push(i, "bad_selector_pair", "extract_ui_text 的 by 与 value 必须成对：只给一半等于没说清从哪提取");
  }
}

function validateRecordingPairs(steps: unknown[],
                                push: (index: number, code: string, message: string) => void): void {
  let openStart = -1;
  steps.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const t = (raw as Record<string, unknown>).type;
    if (t === "screen_record_start") {
      if (openStart >= 0)
        push(i, "record_unpaired", "第 " + (openStart + 1) + " 行的「开始录屏」还没结束就又开了一段"
          + "（§6.4 录屏是起止包裹，一段没结束不能开下一段）");
      openStart = i;
    } else if (t === "screen_record_stop") {
      if (openStart < 0)
        push(i, "record_unpaired", "「结束录屏」前面没有未结束的「开始录屏」（§6.4 起止包裹）："
          + "没有 start 的 stop 执行时会对着空气收尾");
      else openStart = -1;
    }
  });
  if (openStart >= 0)
    push(openStart, "record_unpaired", "第 " + (openStart + 1) + " 行的「开始录屏」没有配对的"
      + "「结束录屏」（录屏文件不会 finalize，整段录制作废，§6.4）");
}

/** 本地预检：只产 issue、绝不抛异常、不改入参。 */
export function validateSteps(steps: unknown): AdbIssue[] {
  const issues: AdbIssue[] = [];
  const push = (index: number, code: string, message: string): void => {
    issues.push({ index, code, message });
  };
  if (!Array.isArray(steps)) {
    push(-1, "bad_step", "ADB 步骤序列必须是 JSON 数组（§7.3），实际是 "
      + (steps === null ? "null" : typeof steps));
    return issues;
  }
  if (steps.length === 0) {
    push(-1, "empty_steps", "步骤序列不能为空：空用例跑起来「零步全绿」是假绿，保存期就拦（§7.3/§13 纪律 1）");
    return issues;
  }
  const seen = new Set<string>();
  steps.forEach((raw: unknown, i: number) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      push(i, "bad_step", "步骤必须是 JSON 对象（§7.3），实际是 " + (Array.isArray(raw) ? "array" : typeof raw));
      return;
    }
    const step = raw as Record<string, unknown>;

    const sid = step.id;
    const idOk = typeof sid === "string" && ID_RE.test(sid);
    if (!idOk) {
      push(i, "bad_id", "步骤 id " + JSON.stringify(sid ?? "") + " 不合法：只允许字母数字下划线短横线，长 1-"
        + MAX_ID_LENGTH + "（id 会写进 run_step_result.step_key，R102）");
    } else if (seen.has(sid)) {
      push(i, "dup_id", "步骤 id " + JSON.stringify(sid) + " 重复；同一用例内必须唯一（R102）");
    } else {
      seen.add(sid);
    }

    const t = step.type;
    if (typeof t !== "string" || !(STEP_TYPES as readonly string[]).includes(t)) {
      push(i, "unknown_type", "未知步骤类型 " + JSON.stringify(t ?? "") + "；§7.3 全集共 "
        + STEP_TYPES.length + " 种：" + STEP_TYPES.join("|"));
      return;
    }

    validateConfig(i, t, step.config, push);

    const dev = step.device;
    if (dev != null && !nonEmptyStr(dev))
      push(i, "bad_device", "步骤的 device 给「auto」或设备 id 字符串（§7.3 的按步设备覆盖；"
        + "id 是否存在在执行期核），实际是 " + JSON.stringify(dev));
    const pw = step.pre_wait_ms;
    if (pw != null && !(isInt(pw) && (pw as number) >= 0))
      push(i, "bad_pre_wait", "pre_wait_ms 给了就必须是非负整数毫秒（§7.3），实际是 " + JSON.stringify(pw));
    const opt = step.optional;
    if (opt != null && typeof opt !== "boolean")
      push(i, "bad_optional", "optional 给了就必须是 true/false（§7.3 失败不阻断），实际是 "
        + JSON.stringify(opt));
    if (opt === true && !(OPTIONAL_ALLOWED as readonly string[]).includes(t))
      push(i, "optional_on_action", t + " 不是断言/提取类步骤，不允许 optional=true"
        + "（操作类步骤失败不继续是语义错误：点了没点上，后面全是对着空气操作）");
  });
  validateRecordingPairs(steps, push);
  return issues;
}

// —— 行摘要（§11.4.12；前端的唯一真相，后端 summarize 是孪生）——

function short(x: unknown): string {
  if (typeof x === "string") return x.length <= 60 ? x : JSON.stringify(x);
  return JSON.stringify(x ?? null);
}

/** 「步骤名 + 一个最能代表这步在干什么的参数」。对任何输入都返回字符串，绝不抛。 */
export function summary(step: unknown): string {
  if (!step || typeof step !== "object" || Array.isArray(step))
    return "步骤（" + (Array.isArray(step) ? "array" : step === null ? "null" : typeof step) + "）";
  const s = step as Record<string, unknown>;
  const t = s.type;
  if (typeof t !== "string" || t === "") return "步骤（未填类型）";
  const label = LABELS[t] ?? t;
  const cfg = (s.config && typeof s.config === "object" && !Array.isArray(s.config))
    ? s.config as Record<string, unknown> : {};
  const val = (k: string): string | null => (nonEmptyStr(cfg[k]) ? (cfg[k] as string) : null);

  if (t === "shell") return label + " " + (val("cmd") ? short(val("cmd")) : "（未填命令）");
  const oneKey: Record<string, string> = {
    click_by_text: "text", click_by_xpath: "xpath", assert_text: "text",
    assert_toast: "text", input_text: "text", open_url: "url", connect: "addr",
  };
  if (oneKey[t]) return label + " " + (val(oneKey[t]) ? short(val(oneKey[t])) : "（未填）");
  if (["uninstall", "start_app", "kill_app"].includes(t))
    return label + " " + (val("package") ? short(val("package")) : "（未填包名）");
  if (t === "click_xy" || t === "long_click") {
    const x = cfg.x, y = cfg.y;
    return label + (isInt(x) && isInt(y) ? " (" + x + "," + y + ")" : " （未填坐标）");
  }
  if (t === "swipe") {
    const pts = [cfg.x1, cfg.y1, cfg.x2, cfg.y2];
    return label + (pts.every((p) => isInt(p)) ? " →" : " （未填坐标）");
  }
  if (t === "sleep") return label + (isInt(cfg.ms) ? " " + cfg.ms + " ms" : " （未填）");
  if (["file_push", "file_pull", "assert_file"].includes(t)) {
    const head = label + " " + (val("remote") ? short(val("remote")) : "（未填设备路径）");
    return t === "assert_file" && val("contains") ? head + " 含「" + short(val("contains")) + "」" : head;
  }
  if (t === "assert_element")
    return label + " " + (val("value") ? short(val("value")) : "（未填）")
      + (val("by") ? " [" + val("by") + "]" : "");
  if (t === "screenshot" || t === "screen_record_stop") {
    const sv = val("save_var");
    return label + (sv ? " → $" + sv : "");
  }
  if (t === "screen_record_start") return label + (isInt(cfg.max_s) ? " ≤" + cfg.max_s + "s" : "");
  if (t === "extract_ui_text") {
    const sv = val("save_var");
    return label + (sv ? " → $" + sv : " （未填变量）");
  }
  return label;
}
