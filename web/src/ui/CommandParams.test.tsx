// §11.4.12 展开区参数表单（CommandParams，1C T16）的组件级钉点。此前它只有 e2e
// （uiCase.spec.mjs / adbCase.spec.mjs）从 probe 页钉「看得见、点得动」，回传值的
// 形状——null 还是空串、键在不在——零 jsdom 断言，正是「删掉一行压平逻辑照样全绿」的
// 面。命令对象在 schemas.py:213 只是 list[dict[str, Any]]（没有逐字段模型），真正的
// 字段契约是 validate_commands（commands.py:149）+ 执行核真读（execution/ui_core.py），
// 本表逐字段对后端：
// ① 参数化 testid 解析（宿主 StepListEditor.tsx:241 传 cmdp-N，缺省 cmdp 只活在 probe；
//    e2e uiCase.spec.mjs:200 起钉的就是 cmdp-0-*，这里镜像真实宿主而不是玩具前缀）；
// ② 回传 payload 逐字段 = UiCommand 全集，未知扩展键原样携带，编辑全程零请求；
// ③ sleep 数字回传字符串（ui_core.py:415-420 int(str(text))）、timeout_ms 截正整数
//    （ui_core.py:475-477 只认正整数）、save_var 清空给 null 不给 ""
//    （commands.py:217-220 ""过不了 _SAVE_VAR_RE，null 才是「没存变量」）；
// ④ 切类型压平（LOCATOR/INPUT_REQUIRED 词表 commands.py:40-46 同表）；
// ⑤ 定位器互斥做实：both_locators（commands.py:197-203）在 UI 里不可达；
// ⑥ 控件按 type 精确给 + R101 blocked 项 disabled；readOnly 全线 disabled；
// ⑦ 权限门（无 ui:element:create 隐藏不是禁用）+ 无项目上下文零请求。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import CommandParams from "./CommandParams";
import { newCommand, type UiCommand } from "./commands";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

// 形状 = UiElementOut（backend/app/modules/ui_test/schemas.py `class UiElementOut` = 178-197），只多不缺
const EL = { id: "e1", project_id: "p1", module_id: null, name: "登录按钮",
  locator_type: "css", locator: "#login-btn", comment: null, owner_id: null,
  project_public: true, status: "normal", updated_by: null, updated_by_name: null,
  created_at: null, updated_at: null };

interface Call { url: string; method: string; body?: string }

/** 只 mock ElementPicker 唯一会打的 GET /ui-elements；其它端点一律炸出来——
 *  本组件是受控件，任何多余请求（尤其 POST/PATCH 落库）都算越界，宁可红。 */
function mockElements(items: unknown[] = []): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (method === "GET" && url.startsWith("/api/v1/ui-elements?")) {
      return { ok: true, status: 200, json: async () => ({ items, next_cursor: null }) } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

/** testIdPrefix 缺省即组件默认 "cmdp"（probe 专用）；宿主测试显式传 cmdp-N。 */
function renderParams(cmd: UiCommand, over: {
  readOnly?: boolean; testIdPrefix?: string;
  onElementNames?: (name: string, id: string) => void;
} = {}) {
  const onChange = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CommandParams cmd={cmd} onChange={onChange} onElementNames={over.onElementNames}
        readOnly={over.readOnly} testIdPrefix={over.testIdPrefix} />
    </ConfigProvider>,
  );
  return onChange as ReturnType<typeof vi.fn>;
}

/** 类型下拉走搜索定位（24 项虚拟列表：不在视口的选项不在 DOM，e2e ⑤ 同款取证）。 */
async function pickType(prefix: string, label: string): Promise<void> {
  const sel = screen.getByTestId(prefix + "-type");
  const wrap = sel.closest(".ant-select")!;
  fireEvent.mouseDown(wrap.querySelector(".ant-select-selector")!);
  fireEvent.change(wrap.querySelector("input")!, { target: { value: label } });
  fireEvent.click(await screen.findByText(label, { selector: ".ant-select-item-option-content" }));
}

/** Segmented 的选项是真 radio：点未选中的那个 input 才会发 change。 */
function clickSegment(prefix: string, label: string): void {
  const root = screen.getByTestId(prefix + "-locator-mode");
  const hit = (Array.from(root.querySelectorAll(".ant-segmented-item")) as HTMLElement[])
    .find((el) => el.textContent === label)!;
  fireEvent.click(hit.querySelector("input")!);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "usr1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
  mockElements([]);
});

afterEach(() => cleanup());

describe("① 参数化 testid 的解析（宿主前缀 cmdp-N）", () => {
  it("宿主前缀 cmdp-3 全解析、裸 cmdp-* 一个都不在；缺省回落 cmdp；ElementPicker 不吃前缀", () => {
    // 宿主真值：StepListEditor.tsx:241 `testIdPrefix: "cmdp-" + i`（e2e 钉 cmdp-0-input）
    renderParams({ ...newCommand("click"), id: "u7" }, { testIdPrefix: "cmdp-3" });
    expect(screen.getByTestId("cmdp-3-id").textContent).toBe("u7");
    expect(screen.getByTestId("cmdp-3-type")).not.toBeNull();
    expect(screen.getByTestId("cmdp-3-locator-mode")).not.toBeNull();
    expect(screen.getByTestId("cmdp-3-timeout")).not.toBeNull();
    expect(screen.getByTestId("cmdp-3-optional")).not.toBeNull();
    // click 是定位器命令但没有 input 控件——多给一个 input 就是执行核读不到的假控件
    expect(screen.queryByTestId("cmdp-3-input")).toBeNull();
    // 前缀必须真的生效：换宿主行号后旧 id 不许还挂在 DOM 上
    expect(screen.queryByTestId("cmdp-type")).toBeNull();
    expect(screen.queryByTestId("cmdp-id")).toBeNull();
    // ElementPicker 不接 testIdPrefix（CommandParams.tsx:90 没传 testIdBase）——
    // 多行同时展开时 el-pick-* 会重号，现状如此，e2e 也按无前缀钉，这里如实钉住（见 FINDINGS）
    expect(screen.getByTestId("el-pick-select")).not.toBeNull();
    cleanup();
    // 缺省 "cmdp" 只有 probe.html 用得到；未分配 id 的行要有人话占位
    renderParams(newCommand("click"));
    expect(screen.getByTestId("cmdp-id").textContent).toBe("（未分配 id）");
    expect(screen.queryByTestId("cmdp-3-id")).toBeNull();
  });
});

describe("② 回传 payload 的形状（受控件：改即回传，全程不落库）", () => {
  it("open 编辑 input / 拨 optional：回传 = 原命令逐字段 + 改动位，扩展键原样携带，fetch 一条不发", () => {
    const calls = mockElements();
    const cmd: UiCommand = { id: "u1", type: "open", element_id: null, inline_locator: null,
      input: "", timeout_ms: null, save_var: null, optional: false, custom_ext: "保留我" };
    const onChange = renderParams(cmd);
    fireEvent.change(screen.getByTestId("cmdp-input"), { target: { value: "${base_url}/login" } });
    // 一次 change 恰好一次回传：偷偷合并/漏发都红（patch = {...cmd, ...p} 的对端契约）
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ ...cmd, input: "${base_url}/login" });
    // UiCommand 的 [key: string]: unknown 扩展位必须原样穿过 patch——
    // steps 是自由 JSON（schemas.py:213 list[dict]），表单不认识的后端字段不许被吃掉
    expect(onChange.mock.calls[0][0].custom_ext).toBe("保留我");
    fireEvent.click(screen.getByTestId("cmdp-optional"));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual({ ...cmd, optional: true });
    expect(calls).toHaveLength(0); // 本组件没有任何写请求：持久化是宿主 T17 的事
  });

  it("optional 从 true 拨回 false：回传 payload 的 optional 确实是 false（单向用例钉不死恒 true）", () => {
    // CommandParams.tsx:179 是 onChange={(v) => patch({ optional: v })}——若被改成
    // () => patch({ optional: true })（恒 true），上面那条 false→true 用例的输出恰好
    // 与变异体一致、照样绿；readOnly 那条（⑦）只查 ant-switch-disabled 类名也不看 payload。
    // 只有从 true 出发拨灭并断言回传 optional:false，反向腿才真的被钉住
    const cmd: UiCommand = { id: "u2", type: "click", element_id: "el1", inline_locator: null,
      input: null, timeout_ms: null, save_var: null, optional: true };
    const onChange = renderParams(cmd);
    fireEvent.click(screen.getByTestId("cmdp-optional"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ ...cmd, optional: false });
  });
});

describe("③ 数字与变量字段：null / 字符串 / 截断，差一个形态执行核就报错", () => {
  it("sleep：500 如实回显、改成 800 回传字符串 \"800\"、清空回 null（键在、值是 null，不是 \"\"）", () => {
    const cmd: UiCommand = { ...newCommand("sleep"), id: "u3", input: "500" };
    const onChange = renderParams(cmd);
    const box = screen.getByTestId("cmdp-input") as HTMLInputElement;
    expect(box.closest(".ant-input-number")).not.toBeNull(); // sleep 是数字框不是文本框
    expect(box.value).toBe("500"); // ui_core.py:415-420 int(str(text))：字符串数字照常执行
    fireEvent.change(box, { target: { value: "800" } });
    fireEvent.blur(box); // change+blur 是 antd InputNumber 的提交时机（StepParams.test 同款）
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.input).toBe("800"); // 字符串而非数字：newCommand 的 input 口径就是 string
    fireEvent.change(screen.getByTestId("cmdp-input"), { target: { value: "" } });
    fireEvent.blur(screen.getByTestId("cmdp-input"));
    next = onChange.mock.calls.at(-1)![0];
    expect("input" in next).toBe(true);
    expect(next.input).toBeNull(); // 「没填」= null；ui_core 拿 None 报人话错，拿 "" 是另一条路
    // input:""（新建底稿态）回显成空框而不是 0——Number("")===0 的坑
    cleanup();
    renderParams({ ...newCommand("sleep"), id: "u3", input: "" });
    expect((screen.getByTestId("cmdp-input") as HTMLInputElement).value).toBe("");
  });

  it("timeout_ms：1234.5 截断成 1234（ui_core 只认 int）、清空 null 而不是删键", () => {
    const cmd: UiCommand = { ...newCommand("click"), id: "u4", element_id: "el1", timeout_ms: 2000 };
    const onChange = renderParams(cmd);
    const box = screen.getByTestId("cmdp-timeout") as HTMLInputElement;
    expect(box.value).toBe("2000");
    fireEvent.change(box, { target: { value: "1234.5" } });
    fireEvent.blur(box);
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.timeout_ms).toBe(1234); // commands.py:212-215 bad_timeout / ui_core.py:475-477 都只认正整数
    fireEvent.change(screen.getByTestId("cmdp-timeout"), { target: { value: "" } });
    fireEvent.blur(screen.getByTestId("cmdp-timeout"));
    next = onChange.mock.calls.at(-1)![0];
    expect(next).toEqual({ ...cmd, timeout_ms: null });
    expect("timeout_ms" in next).toBe(true); // 键必须在：删键与显式「用默认」是两件事
  });

  it("save_var：清空回传 null 而不是 \"\"（\"\" 过不了后端 _SAVE_VAR_RE，是 bad_save_var 不是「没存」）", () => {
    const cmd: UiCommand = { id: "u6", type: "get_text", element_id: "el1", inline_locator: null,
      input: null, timeout_ms: null, save_var: "v", optional: false };
    const onChange = renderParams(cmd);
    const sv = screen.getByTestId("cmdp-save-var") as HTMLInputElement;
    expect(sv.value).toBe("v");
    fireEvent.change(sv, { target: { value: "" } });
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.save_var).toBeNull(); // commands.py:217-220：非 null 值必须匹配变量名正则，"" 必炸
    expect("save_var" in next).toBe(true);
    expect(next).toEqual({ ...cmd, save_var: null });
    fireEvent.change(screen.getByTestId("cmdp-save-var"), { target: { value: "amt" } });
    next = onChange.mock.calls.at(-1)![0];
    expect(next.save_var).toBe("amt");
  });
});

describe("④ 切类型 = 换一套字段（词表与后端 commands.py:40-46 同表）", () => {
  it("click 脏值切 open/key/sleep 三张对照表：定位器一律压 null，input 按 INPUT_REQUIRED 给 \"\" / 保留", async () => {
    const base: UiCommand = { id: "u9", type: "click", element_id: "el1", inline_locator: null,
      input: null, timeout_ms: 500, save_var: "x", optional: true, custom_ext: "k" };
    // click → open：定位器清空；open 不在 INPUT_REQUIRED 也不是 sleep/scroll → input=null
    const onChange = renderParams(base);
    await pickType("cmdp", "打开");
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ ...base, type: "open",
      element_id: null, inline_locator: null, input: null });
    // click → key：key 非定位器（键是对当前焦点按，不碰元素）；input 非字符串 → "" 占位
    // （newCommand 同款「必填给空串」约定，给 null 会让必填框显示不出未填态）
    cleanup();
    const onChange2 = renderParams(base);
    await pickType("cmdp", "按键");
    expect(onChange2.mock.calls.at(-1)![0]).toEqual({ ...base, type: "key",
      element_id: null, inline_locator: null, input: "" });
    // click → sleep：sleep 的 input 就是毫秒数，字符串原样保留（ui_core.py:415 读 str）
    cleanup();
    const onChange3 = renderParams({ ...base, input: "900" });
    await pickType("cmdp", "等待时间");
    expect(onChange3.mock.calls.at(-1)![0]).toEqual({ ...base, type: "sleep", input: "900",
      element_id: null, inline_locator: null });
  });

  it("切进 LOCATOR_REQUIRED 类型：element_id 必须原样带过去（存量三条只钉了「清位」半边）", async () => {
    // CommandParams.tsx:65 的三元有两支：上面 click→open/key/sleep 的目标类型没有一个
    // 在 LOCATOR_REQUIRED 里，走的全是「清成 null」支——把整支换成常量 null 照样全绿。
    // 这里从非定位器类型（open 是页面级）带着 element_id 切进 click，才第一次驱动
    // 「保留」支；断言走 onChange 回传的 payload，不是看控件在不在
    const base: UiCommand = { id: "u10", type: "open", element_id: "el8", inline_locator: null,
      input: null, timeout_ms: null, save_var: null, optional: false };
    const onChange = renderParams(base);
    await pickType("cmdp", "点击");
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.element_id).toBe("el8"); // 「恒 null」变异体在这一行死
    expect(next).toEqual({ ...base, type: "click" });
    // 镜像方向（定位器 → 非定位器压 null）已被上面三条各自的 element_id:null 钉住，不重复
  });

  it("切进 INPUT_REQUIRED：已有字符串 input 原样保留；input 缺键的命令切过去给 \"\" 不给 undefined", async () => {
    // CommandParams.tsx:67 的 needsInput 支 = 「字符串原样保留」+「非字符串给 "" 占位」。
    // 存量 3 次切换里 base.input 要么 null（open/key）要么走 sleep 那条独立腿，
    // 「已填的值活下来」从没被驱动——needsInput ? "" 的变异体因此存活
    const base: UiCommand = { id: "u11", type: "open", element_id: null, inline_locator: null,
      input: "回归文本", timeout_ms: null, save_var: null, optional: false };
    const onChange = renderParams(base);
    await pickType("cmdp", "输入");
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.type).toBe("input");
    expect(next.input).toBe("回归文本"); // 填好的值不许在换类型时被抹成 ""
    expect(next).toEqual({ ...base, type: "input" });
    // 推论：老数据连 input 键都没有（undefined）也要落 ""——null→"" 已由 click→key 钉，
    // 这里补 undefined 半边：给 undefined 的话必填框的未填态就显示不出来
    cleanup();
    const onChange2 = renderParams({ id: "u12", type: "open", element_id: null,
      inline_locator: null, timeout_ms: null, save_var: null, optional: false });
    await pickType("cmdp", "按键");
    const next2 = onChange2.mock.calls.at(-1)![0];
    expect("input" in next2).toBe(true); // 键必须在
    expect(next2.input).toBe(""); // 且是 "" 不是 undefined
  });
});

describe("⑤ 定位器互斥做实（后端 both_locators 只是老数据防线，commands.py:197-203）", () => {
  it("lib→inline 清元素给默认 {css,\"\"}；inline→lib 清 inline_locator；脏数据下写 inline 也顺手清 element_id", () => {
    const cmd: UiCommand = { id: "u5", type: "click", element_id: "el1", inline_locator: null,
      input: null, timeout_ms: null, save_var: null, optional: false };
    const onChange = renderParams(cmd);
    const root = screen.getByTestId("cmdp-locator-mode");
    expect(Array.from(root.querySelectorAll(".ant-segmented-item")).map((i) => i.textContent))
      .toEqual(["元素库", "就地定位"]);
    expect(screen.getByTestId("el-pick-select")).not.toBeNull(); // 无 inline → 落元素库侧
    clickSegment("cmdp", "就地定位");
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ ...cmd, element_id: null,
      inline_locator: { type: "css", value: "" } }); // 默认形态，不是 undefined 也不是缺键

    // inline 态（老数据）如实显示：Segmented 选中项就是就地定位，且不挂 ElementPicker
    const inline: UiCommand = { ...cmd, element_id: null, inline_locator: { type: "xpath", value: "//b" } };
    cleanup();
    const onChange2 = renderParams(inline);
    expect(screen.queryByTestId("el-pick-select")).toBeNull();
    expect(screen.getByTestId("cmdp-locator-mode")
      .querySelector(".ant-segmented-item-selected")!.textContent).toBe("就地定位");
    clickSegment("cmdp", "元素库");
    expect(onChange2.mock.calls.at(-1)![0]).toEqual({ ...inline, element_id: null, inline_locator: null });

    // 脏数据（两个都给，mode 按 inline 显示）下写表达式：patch 同步钉回 element_id:null，
    // 表单给不出 both_locators——这就是 Segmented 存在的理由
    cleanup();
    const onChange3 = renderParams({ ...inline, element_id: "el9" });
    fireEvent.change(screen.getByTestId("cmdp-inline-value"), { target: { value: "#x" } });
    const next = onChange3.mock.calls.at(-1)![0];
    expect(next.element_id).toBeNull();
    expect(next.inline_locator).toEqual({ type: "xpath", value: "#x" });
  });
});

describe("⑥ 控件按 type 精确给（写了执行核也不读的控件就是假控件）", () => {
  it("screenshot 零控件、save-var 只 get_text/get_attr/js、js 走 TextArea、R101 blocked 项 disabled", async () => {
    renderParams({ ...newCommand("screenshot"), id: "u1" });
    expect(screen.queryByTestId("cmdp-input")).toBeNull(); // 截图没有参数位
    expect(document.body.textContent).toContain("制品"); // 但要说明制品去哪了
    cleanup();
    renderParams({ ...newCommand("assert_element"), id: "u2" });
    expect(screen.queryByTestId("cmdp-save-var")).toBeNull(); // 断言没有结果可存
    cleanup();
    renderParams({ ...newCommand("get_text"), id: "u3" });
    expect(screen.getByTestId("cmdp-save-var")).not.toBeNull();
    cleanup();
    renderParams({ ...newCommand("js"), id: "u4" });
    expect(screen.getByTestId("cmdp-input").tagName).toBe("TEXTAREA"); // 整段表达式，不是单行框
    cleanup();
    // BLOCKED_1C 5 种：看得见但选不了，且原因写在 label 里（「选得到存不了」是计划红线）
    renderParams({ ...newCommand("click"), id: "u5" });
    const sel = screen.getByTestId("cmdp-type");
    const wrap = sel.closest(".ant-select")!;
    fireEvent.mouseDown(wrap.querySelector(".ant-select-selector")!);
    fireEvent.change(wrap.querySelector("input")!, { target: { value: "上传" } });
    // 注：disabled 项的 label 是 Tooltip 包 span，文本不在 option-content 直子上，
    // 所以按 span 全文匹配再 closest 回 option 查 disabled 类
    const opt = await screen.findByText(/上传（要到 1C\+ 批次才开放）/);
    expect(opt.closest(".ant-select-item-option")!.className).toContain("ant-select-item-option-disabled");
  });
});

describe("⑦ readOnly（宿主透传的只读态）", () => {
  it("类型/分段器/inline 双框/超时/存变量/失败继续 全部 disabled，但值如实显示", () => {
    const cmd: UiCommand = { id: "u5", type: "click", element_id: null,
      inline_locator: { type: "xpath", value: "//a" }, input: null, timeout_ms: 2000,
      save_var: null, optional: true };
    renderParams(cmd, { readOnly: true });
    expect((screen.getByTestId("cmdp-inline-value") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("cmdp-inline-value") as HTMLInputElement).value).toBe("//a");
    expect(screen.getByTestId("cmdp-inline-type").closest(".ant-select")!.className)
      .toContain("ant-select-disabled");
    expect(screen.getByTestId("cmdp-locator-mode").className).toContain("ant-segmented-disabled");
    expect(screen.getByTestId("cmdp-type").closest(".ant-select")!.className)
      .toContain("ant-select-disabled");
    const tm = screen.getByTestId("cmdp-timeout") as HTMLInputElement;
    expect(tm.disabled).toBe(true);
    expect(tm.value).toBe("2000"); // 只读不是抹掉值
    expect((screen.getByTestId("cmdp-optional") as HTMLElement).className).toContain("ant-switch-disabled");
    cleanup();
    renderParams({ ...newCommand("js"), id: "u6", input: "1+1", save_var: "v" }, { readOnly: true });
    expect((screen.getByTestId("cmdp-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("cmdp-save-var") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("⑧ 权限门与请求面（ElementPicker 随 CommandParams 挂载）", () => {
  it("无项目上下文：选择器 disabled 且零请求；有项目只拉一页 GET /api/v1/ui-elements", async () => {
    useAuth.setState({ project: null });
    const calls = mockElements();
    renderParams(newCommand("click"));
    expect(screen.getByTestId("el-pick-select").closest(".ant-select")!.className)
      .toContain("ant-select-disabled"); // 「等待项目上下文…」，不是给个能点的空框
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0); // pid 缺失的早退必须真的不发请求
    cleanup();
    useAuth.setState({ project: PROJECT });
    const calls2 = mockElements();
    renderParams(newCommand("click"));
    await waitFor(() => expect(calls2).toHaveLength(1));
    // /api/v1 前缀来自 client.ts:77；qs 顺序 project_id,size 来自 uiApi.listElements
    expect(calls2[0].url).toBe("/api/v1/ui-elements?project_id=p1&size=200");
    expect(calls2[0].method).toBe("GET");
  });

  it("无 ui:element:create：[就地新建] 不在 DOM（隐藏不是禁用），选择器本身仍可用；有权限才出把手", () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockElements([EL]);
    renderParams(newCommand("click"));
    expect(screen.getByTestId("el-pick-select")).not.toBeNull(); // 选人不受影响
    expect(screen.queryByTestId("el-pick-new-toggle")).toBeNull();
    expect(screen.queryByTestId("el-pick-new-form")).toBeNull();
    cleanup();
    useAuth.setState({ project: PROJECT }); // my_perms ["*"]
    renderParams(newCommand("click"));
    expect(screen.getByTestId("el-pick-new-toggle")).not.toBeNull();
  });

  it("选元素 → patch 逐字段 {element_id, inline_locator:null} + onElementNames(名, id) 一次不多", async () => {
    const calls = mockElements([EL]);
    const onNames = vi.fn();
    const onChange = renderParams(newCommand("click"), { onElementNames: onNames });
    await waitFor(() => expect(
      calls.some((c) => c.url === "/api/v1/ui-elements?project_id=p1&size=200"),
    ).toBe(true));
    const sel = screen.getByTestId("el-pick-select");
    fireEvent.mouseDown(sel.closest(".ant-select")!.querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText(/#login-btn/));
    // 宿主靠这一回调把显示名并进行摘要表（§11.4.12），参数序是 (name, id)
    expect(onNames).toHaveBeenCalledTimes(1);
    expect(onNames).toHaveBeenCalledWith("登录按钮", "e1");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0])
      .toEqual({ ...newCommand("click"), element_id: "e1", inline_locator: null });
  });
});
