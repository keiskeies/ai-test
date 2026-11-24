// §14 硬条款「序列化/反序列化必测往返」在 auth 上的落点 + Auth 页签行为钉。
// 手法同 ImportWizard.test.tsx：jsdom + testId 定位；antd Select 用 mouseDown 展开。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// R49/D174：Body/脚本断言字段换懒加载 CodeEditor（monaco）。桩成 textarea 的写法与
// scene/PropsPanel.test.tsx:51、adb/StepParams.test.tsx:10 同源，这里多转发 readOnly→disabled，
// 让「只读不可改」那条断言仍打在桩上（monaco 本体渲染归 e2e/editor.spec.mjs）。
vi.mock("../components/CodeEditor", () => ({
  default: (props: { value?: string; onChange?: (v: string) => void; readOnly?: boolean }) => (
    <textarea data-testid="code-editor-stub" value={props.value ?? ""} disabled={props.readOnly}
      onChange={(e) => props.onChange?.(e.target.value)} />
  ),
}));

import RequestEditor, { fromDraft, toDraft } from "./RequestEditor";
import { cleanRequest } from "./req";
import type { Pair, RequestObject } from "./req";
import { useState } from "react";

describe("toDraft / fromDraft auth 往返（§14）", () => {
  it("basic：存 → 载 → 存 逐字一致，凭据不丢", () => {
    const r: RequestObject = { method: "GET", url: "/x",
      auth: { type: "basic", config: { username: "u", password: "p" } } };
    const d = toDraft(r);
    expect(d.auth).toEqual({ type: "basic", username: "u", password: "p", token: "" });
    expect(fromDraft(d).auth).toEqual({ type: "basic", config: { username: "u", password: "p" } });
  });

  it("bearer：token 原样往返", () => {
    const r: RequestObject = { method: "POST", url: "/y",
      auth: { type: "bearer", config: { token: "tk-1" } } };
    expect(fromDraft(toDraft(r)).auth).toEqual({ type: "bearer", config: { token: "tk-1" } });
  });

  it("缺省与 none：无 auth 键的历史数据 → 显式 {type:none}，再往返仍一致", () => {
    const legacy: RequestObject = { method: "GET", url: "/z" };
    const once = fromDraft(toDraft(legacy));
    expect(once.auth).toEqual({ type: "none" });
    expect(fromDraft(toDraft(once)).auth).toEqual({ type: "none" });
  });

  it("cleanRequest 保留 auth：调试请求体不会把认证洗掉", () => {
    const c = cleanRequest({ method: "GET", url: "/a",
      auth: { type: "bearer", config: { token: "t" } } });
    expect(c.auth).toEqual({ type: "bearer", config: { token: "t" } });
  });
});

function openAuthSelect(): void {
  const sel = screen.getByTestId("req-auth-type").closest(".ant-select")!
    .querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
}

/** 断言行的类型下拉展开：antd Select 靠 mousedown 在 selector 上触发。 */
function openAssertTypeSelect(i: number): void {
  const sel = screen.getByTestId("req-assert-type-" + i).closest(".ant-select")!
    .querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
}

function clickAssertTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: /^断言/ }));
}

/** R49/D174：字段 testid 现在包在外层 div 上，真正的编辑面是里面的 CodeEditor（桩）。
 *  从字段 wrapper 内部取编辑器——若哪天字段退回裸 TextArea（内层编辑器消失），
 *  这里 byTestId 找不到编辑器，测试必红，升级不会被静默回退。 */
async function editorIn(fieldTestId: string): Promise<HTMLElement> {
  const wrapper = screen.getByTestId(fieldTestId);
  return within(wrapper).findByTestId("code-editor-stub");
}

/** 在展开的下拉里按 label 点选项，返回选项节点供 disabled 断言。
 *  按 option 节点的 textContent 找：曾经 hint 分支会把 label 包进 Tooltip，
 *  两种 DOM 形状下本定位都要命中；现在只剩裸 label 一种形状，定位不改也能跑。 */
function pickAssertType(i: number, label: string): HTMLElement {
  openAssertTypeSelect(i);
  const opts = Array.from(document.querySelectorAll(".ant-select-item-option")) as HTMLElement[];
  const opt = opts.find((o) => (o.textContent ?? "").includes(label))!;
  fireEvent.click(opt);
  return opt;
}

/** 受控包装：真实页面（api.tsx/CaseList.tsx）都是 state 驱动，编辑器自己不改值。 */
function Harness({ initial, onChange, prefix }: {
  initial: RequestObject | null; onChange?: (v: unknown) => void; prefix?: string;
}) {
  const [d, setD] = useState(toDraft(initial));
  return <RequestEditor value={d} testIdPrefix={prefix}
    onChange={(nd) => { setD(nd); onChange?.(nd); }} />;
}

describe("Auth 页签交互", () => {
  beforeEach(() => cleanup());

  it("缺省 none：只有类型选择，没有凭据输入框", () => {
    render(<Harness initial={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "Auth" }));
    expect(screen.getByTestId("req-auth-type")).not.toBeNull();
    expect(screen.queryByTestId("req-auth-username")).toBeNull();
    expect(screen.queryByTestId("req-auth-token")).toBeNull();
  });

  it("选 basic：出现用户名 + 密码框；改值经 onChange 落进 value.auth", () => {
    const seen: unknown[] = [];
    render(<Harness initial={null} onChange={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Auth" }));
    openAuthSelect();
    fireEvent.click(screen.getByText("basic", { selector: ".ant-select-item-option-content" }));
    fireEvent.change(screen.getByTestId("req-auth-username"), { target: { value: "u" } });
    fireEvent.change(screen.getByTestId("req-auth-password"), { target: { value: "p" } });
    const last = seen.at(-1) as { auth: { type: string; username: string; password: string } };
    expect(last.auth).toMatchObject({ type: "basic", username: "u", password: "p" });
  });

  it("bearer token 是密码框：DOM 里不以明文 type=text 渲染", () => {
    render(<Harness initial={{ method: "GET", url: "/x",
      auth: { type: "bearer", config: { token: "tk" } } }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Auth(bearer)" }));
    const el = screen.getByTestId("req-auth-token") as HTMLInputElement;
    // antd Input.Password 默认密文（type=password），且当前值确实进了受控输入
    expect(el.type).toBe("password");
    expect(el.value).toBe("tk");
  });

  it("testId 前缀隔离：两个编辑器并存时定位互不串（调试/用例共用同一组件）", () => {
    render(<div>
      <Harness initial={null} prefix="def" />
      <Harness initial={null} prefix="case" />
    </div>);
    // antd Tabs 懒渲染面板：各自点开 Auth 页签再断言
    for (const t of screen.getAllByRole("tab", { name: "Auth" })) fireEvent.click(t);
    expect(screen.getByTestId("def-auth-type")).not.toBeNull();
    expect(screen.getByTestId("case-auth-type")).not.toBeNull();
  });
});

describe("脚本断言（执行核 1B 起真求值，UI 不许再挂假门）", () => {
  beforeEach(() => cleanup());

  it("「脚本断言」选项存在、未置灰、可点选", () => {
    render(<Harness initial={null} />);
    clickAssertTab();
    fireEvent.click(screen.getByTestId("req-assert-add"));
    const opt = pickAssertType(0, "脚本断言");
    expect(opt.className).not.toContain("ant-select-item-option-disabled");
    // 点选真的生效：切到 script 后代码输入框出现
    expect(screen.getByTestId("req-assert-code-0")).not.toBeNull();
  });

  it("选中 script 出现代码输入框；敲进去的正文经 onChange 落进 assertions[0].code", async () => {
    const seen: unknown[] = [];
    render(<Harness initial={null} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    fireEvent.click(screen.getByTestId("req-assert-add"));
    pickAssertType(0, "脚本断言");
    fireEvent.change(await editorIn("req-assert-code-0"), { target: { value: "assert ctx.last_response" } });
    const last = seen.at(-1) as { assertions: { type: string; code: string }[] };
    expect(last.assertions[0]).toMatchObject({ type: "script", code: "assert ctx.last_response" });
  });

  it("script 行的毫秒框绑 timeout_ms：单条脚本沙箱时限（§8.5）", () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x",
      assertions: [{ type: "script", code: "assert 1" }] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    // antd InputNumber 的 data-* 落点是版本实现细节：拿到的节点可能是 wrapper，自己就是 input 时直接用
    const node = screen.getByTestId("req-assert-timeout-0");
    const input = node.tagName === "INPUT" ? node : node.querySelector("input")!;
    fireEvent.change(input, { target: { value: "3000" } });
    const last = seen.at(-1) as { assertions: { timeout_ms: number }[] };
    expect(last.assertions[0].timeout_ms).toBe(3000);
  });

  it("script→status_code 切换：残留 code 归零，不随保存流向后端", () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x",
      assertions: [{ type: "script", code: "assert 1", timeout_ms: 3000 }] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    pickAssertType(0, "状态码");
    const last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0]).toMatchObject({ type: "status_code" });
    expect(last.assertions[0].code).toBeNull();
    expect(last.assertions[0].timeout_ms).toBeNull();
    expect(screen.queryByTestId("req-assert-code-0")).toBeNull();
  });

  it("status_code→script 切换：expected 归零（脚本判定不看 expected）", () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x",
      assertions: [{ type: "status_code", expected: 200 }] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    pickAssertType(0, "脚本断言");
    const last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0]).toMatchObject({ type: "script" });
    expect(last.assertions[0].expected).toBeNull();
  });

  it("code 进请求对象往返：toDraft→fromDraft 不洗掉脚本正文", () => {
    const r: RequestObject = { method: "POST", url: "/s",
      assertions: [{ type: "script", code: "assert ctx.vars['ok']", timeout_ms: 4000 }] };
    expect(fromDraft(toDraft(r)).assertions?.[0]).toMatchObject({ type: "script", code: "assert ctx.vars['ok']", timeout_ms: 4000 });
  });

  it("readOnly（详情/回放）：脚本文正文原样可读，不是空输入框", async () => {
    render(<RequestEditor readOnly value={toDraft({ method: "GET", url: "/x",
      assertions: [{ type: "script", code: "assert ctx.last_response['status'] == 200" }] })} />);
    clickAssertTab();
    const el = await editorIn("req-assert-code-0") as HTMLTextAreaElement;
    expect(el.value).toBe("assert ctx.last_response['status'] == 200");
    expect(el.disabled).toBe(true); // readOnly 透传到 CodeEditor（R49 升级后的门）
  });
});

describe("Body 页签（R49/D174：正文输入 = CodeEditor）", () => {
  beforeEach(() => cleanup());

  it("type=none 不给出正文编辑器；切 json 后出现 CodeEditor 且初值原样渲染", async () => {
    render(<Harness initial={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "Body" }));
    expect(screen.queryByTestId("req-body-content")).toBeNull();
    const sel = screen.getByTestId("req-body-type").closest(".ant-select")!
      .querySelector(".ant-select-selector")!;
    fireEvent.mouseDown(sel);
    fireEvent.click(screen.getByText("json", { selector: ".ant-select-item-option-content" }));
    expect(screen.getByTestId("req-body-content")).not.toBeNull();
    const ed = await editorIn("req-body-content") as HTMLTextAreaElement;
    expect(ed.value).toBe("");
  });

  it("已有正文进编辑器（初始值渲染）；编辑经 onChange 落进 value.body.content", async () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "POST", url: "/x",
      body: { type: "json", content: "{\"a\": 1}" } }} onChange={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Body" }));
    const ed = await editorIn("req-body-content") as HTMLTextAreaElement;
    expect(ed.value).toBe("{\"a\": 1}");
    fireEvent.change(ed, { target: { value: "{\"a\": 2}" } });
    const last = seen.at(-1) as { body: { type: string; content: string } };
    expect(last.body).toMatchObject({ type: "json", content: "{\"a\": 2}" });
  });

  it("readOnly：正文只读渲染进 CodeEditor（disabled 透传），不是空输入框", async () => {
    render(<RequestEditor readOnly value={toDraft({ method: "POST", url: "/x",
      body: { type: "text", content: "k=v&x=1" } })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Body" }));
    const ed = await editorIn("req-body-content") as HTMLTextAreaElement;
    expect(ed.value).toBe("k=v&x=1");
    expect(ed.disabled).toBe(true);
  });
});

describe("文案兑现：页签计数只算将执行的行；断言时限留空必须是 null", () => {
  beforeEach(() => cleanup());

  it("页签计数只算启用行：一条停用时报「断言(1 · 停用 1)」，不谎称 2 条参与执行", () => {
    // 后端 shared/assertions.py evaluate 只跳 enabled is False 且不产结果行：
    // 页签写总数就是虚报——同屏的开关 tooltip 明说停用行「报告里也不出现」。
    render(<Harness initial={{ method: "GET", url: "/x", assertions: [
      { type: "status_code", expected: 200 },
      { type: "body_contains", expected: "a", enabled: false },
    ] }} />);
    const tab = screen.getByRole("tab", { name: "断言(1 · 停用 1)" });
    expect(tab.textContent).not.toContain("断言(2)");
  });

  it("清空毫秒框：emit timeout_ms:null（留空可达），不再落 0 的假阈值", () => {
    // 0 对 response_time_lt 是恒假阈值（elapsed_ms < 0）、对 script 是回落到没要的默认。
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x",
      assertions: [{ type: "script", code: "assert 1", timeout_ms: 3000 }] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    const node = screen.getByTestId("req-assert-timeout-0");
    const input = node.tagName === "INPUT" ? node : node.querySelector("input")!;
    fireEvent.change(input, { target: { value: "" } });
    const last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0].timeout_ms).toBeNull();
  });
});

describe("正则断言 + 启用开关 + 排序（D78）", () => {
  beforeEach(() => cleanup());

  it("选「正则」：期望框挂正则占位，另有可选 JSONPath 框，两者经 onChange 落值", () => {
    const seen: unknown[] = [];
    render(<Harness initial={null} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    fireEvent.click(screen.getByTestId("req-assert-add"));
    pickAssertType(0, "正则");
    fireEvent.change(screen.getByTestId("req-assert-expected-0"), { target: { value: "^tk$" } });
    fireEvent.change(screen.getByTestId("req-assert-path-0"), { target: { value: "$.data.token" } });
    const last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0]).toMatchObject({ type: "regex", expected: "^tk$", path: "$.data.token" });
  });

  it("启用开关：缺省显示启用；关掉落 enabled:false，再开落 true", () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x",
      assertions: [{ type: "status_code", expected: 200 }] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    const sw = screen.getByTestId("req-assert-enabled-0").closest(".ant-switch")!;
    expect(sw.className).toContain("ant-switch-checked"); // 无 enabled 键 = 启用（老数据语义）
    fireEvent.click(sw);
    let last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0].enabled).toBe(false);
    fireEvent.click(sw);
    last = seen.at(-1) as { assertions: Record<string, unknown>[] };
    expect(last.assertions[0].enabled).toBe(true);
  });

  it("enabled:false 进请求对象往返：toDraft→fromDraft 不洗掉停用标记", () => {
    const r: RequestObject = { method: "GET", url: "/x",
      assertions: [{ type: "body_contains", expected: "a", enabled: false }] };
    expect(fromDraft(toDraft(r)).assertions?.[0]).toMatchObject({ type: "body_contains", enabled: false });
  });

  it("上移/下移改数组顺序；首行上移、末行下移禁得住（不越界）", () => {
    const seen: unknown[] = [];
    render(<Harness initial={{ method: "GET", url: "/x", assertions: [
      { type: "status_code", expected: 200 },
      { type: "body_contains", expected: "a" },
      { type: "response_time_lt", timeout_ms: 100 },
    ] }} onChange={(v) => seen.push(v)} />);
    clickAssertTab();
    expect((screen.getByTestId("req-assert-up-0").closest("button") ?? screen.getByTestId("req-assert-up-0") as HTMLButtonElement).disabled).toBe(true);
    const down = (screen.getByTestId("req-assert-down-2").closest("button") ?? screen.getByTestId("req-assert-down-2") as HTMLButtonElement);
    expect(down.disabled).toBe(true);
    // 第 2 行（body_contains）上移 → 排到 status_code 前
    const up1 = (screen.getByTestId("req-assert-up-1").closest("button") ?? screen.getByTestId("req-assert-up-1") as HTMLButtonElement);
    fireEvent.click(up1);
    const last = seen.at(-1) as { assertions: { type: string }[] };
    expect(last.assertions.map((a) => a.type)).toEqual(["body_contains", "status_code", "response_time_lt"]);
  });
});

// ── D288：接口参数的「必填 / 描述」（四元键值对）──
// 后端 Pair 允许 ["名","值","1|0","描述"]；执行层只读前两位。前端必须做到：
// ① 四元载入后两列有值；② 改任何一位都不丢另外两位；③ 没填过元信息的行仍写两元，
// 旧数据/OpenAPI 导入/用例覆盖层的形状不变。
describe("D288 参数必填/描述", () => {
  beforeEach(() => cleanup());

  it("四元参数回显；取消必填后描述不丢", () => {
    render(<Harness initial={{ method: "GET", url: "/x",
      params: [["page", "1", "1", "页码，从 1 开始"]] as Pair[] }} />);
    const box = screen.getByTestId("req-param-required-0") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect((screen.getByTestId("req-param-desc-0") as HTMLInputElement).value)
      .toBe("页码，从 1 开始");
    fireEvent.click(box);
    expect((screen.getByTestId("req-param-required-0") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("req-param-desc-0") as HTMLInputElement).value)
      .toBe("页码，从 1 开始");
  });

  it("新增行写四元；保存形状只对填过元信息的行升四元", () => {
    let last: unknown;
    render(<Harness initial={null} onChange={(v) => { last = v; }} />);
    fireEvent.click(screen.getByTestId("req-param-add"));
    expect((last as { params: string[][] }).params[0]).toEqual(["", "", "0", ""]);

    // 填了必填/描述 → 四元；没填 → 两元（旧数据/导入不变）
    expect(cleanRequest({ method: "GET", url: "/x",
      params: [["page", "1", "1", "页码"]] as Pair[] }).params)
      .toEqual([["page", "1", "1", "页码"]]);
    expect(cleanRequest({ method: "GET", url: "/x",
      params: [["q", "hi", "0", "关键字"]] as Pair[] }).params)
      .toEqual([["q", "hi", "0", "关键字"]]);
    expect(cleanRequest({ method: "GET", url: "/x",
      params: [["size", "20"]] as Pair[] }).params).toEqual([["size", "20"]]);
  });
});
