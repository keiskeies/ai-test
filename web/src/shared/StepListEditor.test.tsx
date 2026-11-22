// §11.4.12「UI 用例 / ADB 用例共用一个组件」共用件骨架（shared/StepListEditor.tsx，1D T9）的
// 组件级钉。stepList.ts 的内核语义已由 stepList.test.ts 钉死、两家 commands.ts 的委托由各自
// 孪生表钉死——这里只补**只有本件能钉**的那一段：骨架有没有把内核接到正确的把手上、
// descriptor 注入的差异（词表/前缀/草稿/可添加类型/校验/参数面板）有没有真的被 honour。
// testid 是 e2e/uiCase.spec.mjs 钉下的重构契约（cmd-toolbar/cmd-add/cmd-search/cmd-paste/
// cmd-dirty/cmd-row/cmd-more-N/cmd-add-end/case-save-issues/case-local-issues），照用不改名。
// 本件是纯受控组件（steps 从 props 来、onChange 出去），所以用例都挂在 Harness 上——
// 一个 useState 把 onChange 喂回 steps，和 pages/uiCaseDetail.tsx:225 的 setSteps 同构。
// descriptor 不造玩具表：词表/草稿/校验直接 import 真实的 ui|adb commands 模块，
// 与 pages/uiCaseDetail.tsx:106-119、pages/adbCaseDetail.tsx:134-145 逐字段同构（仅面板换桩）。
// 钉十一条契约：
// ① 工具条「+ 添加命令」/「在末尾添加命令」= insertRow(steps.length-1)：追加末尾、
//    id 按 descriptor.idPrefix 走 max+1（R102）、草稿逐字来自 descriptor.makeRow、新行自动
//    展开（:75 setExpanded）、参数面板 testIdPrefix=cmdp-N；可选项集合 = insertable（被拦的
//    5 种不进，§13 纪律 1，走 searchText 过滤取证——选项是虚拟列表，DOM 里没有全量）；
//    空列表时 cmd-add-end 不出现（:249 filtered>0）且 cmd-add 仍能在头部落第一条；
// ② 行菜单「在这一行后插入…」子菜单 = insertRow(i)：插在**本行后**（工具条给不了的位置）；
// ③ 「复制（duplicate）」= duplicateRowAt(steps,i,prefix,cloneRow)：副本换新 id 插本行后、
//    descriptor.cloneRow 钩子真的在链上、toast「已复制为 <新id>」、源数组不原地改；
// ④ 拖拽 = moveRow：落在后面行 = 前移（:199 的 i-1 校正）、落在前面行 = 后移、落回自己 = 零回调；
// ⑤ 「删除该行」= removeRowAt(i) 且收起展开态；参数面板 onChange = updateRowAt(i, 整行)；
// ⑥ id 前缀与词表来自 descriptor（UI "u" / ADB "a"，§7.2/§7.3 示例字面）：同一个 cmd-add-end
//    喂 ADB descriptor 必须出 aN + connect 空壳；词表画 ADB 的「Shell 命令」，UI 词「点击」
//    不在下拉里——前缀/词表若被写死这条先红；
// ⑦ 本地预检（case-local-issues，warning）按 index 点名行：「第 N 行」与行内 cmd-row-issue
//    落在同一行；index=-1（整案级 empty_steps）画「第 - 行」且不给任何行挂徽标；超过 6 条
//    只列 6 条 + 「……共 N 条」（:169 slice）；
// ⑧ 422 issues（case-save-issues，error）与本地预检分块：saveIssues 非空时本地块**整体让位**
//    （:164 `!saveIssues &&`，两条红线同屏分不清哪条是服务端说的）；saveIssues=[] 视作无；
// ⑨ 搜索只滤可见行、零回调、行号仍是原始序号；筛选态 draggable=false（:113 过滤后行序
//    不代表真实顺序）；dirty 是纯 props 回显，组件自己不算 dirty；
// ⑩ 页内剪贴板：粘贴 = 插入不替换（行数只增、前缀原样）；粘贴件换新 id（:82 注释）；
//    入板的是快照（入板后的列表变更不回写剪贴板）；空板时钮 disabled 且工具条钮不在 DOM；
// ⑪ canUpdate=false（无 ui:case:update）：cmd-add/cmd-add-end/cmd-more-N/cmd-paste 一个都不
//    渲染（§11.5.1 藏把手而非置灰），行不可拖不可展开，但 cmd-search 与行内容照常读得到。
// 两处「钉现状不修」的骨架缺陷（详见 describe 内注释，报 FINDINGS F1/F2）：
// F1 行菜单项的 click 沿 React portal 回冒到行 onClick，行内动作（插入/删除）后的
//    setExpanded 会被行 toggle 覆盖——行菜单插入后展开的是**锚行**（cmdp-i）而非新行；
// F2 saveIssues=[]（truthy 空数组）时 :164 `!saveIssues` 把本地预检块也压掉，两块都不出。
//    两家页面今天只喂 null|非空数组够不到，但这是改 422 复位方式时的静默哑火位。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import StepListEditor, { type StepDescriptor, type StepIssue, type StepLike } from "./StepListEditor";
import {
  INSERTABLE_UI, LABELS as UI_LABELS, newCommand, summary as uiSummary,
  validateCommands, type UiCommand,
} from "../ui/commands";
import {
  INSERTABLE_ADB, LABELS as ADB_LABELS, newStep, summary as adbSummary,
  validateSteps, type AdbStep,
} from "../adb/commands";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补，同 UsersTab.test.tsx:19）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

/** 参数面板桩：只钉骨架传下来的 testIdPrefix 与 onChange 接线（真实面板 CommandParams /
 *  StepParams 各有自己的测试；这里是 descriptor 的注入位）。 */
function stubParams<T extends StepLike>(tag: string) {
  return (row: T, { testIdPrefix, onChange }:
    { testIdPrefix: string; onChange: (next: T) => void }): ReactNode => (
    <div data-testid={testIdPrefix + "-panel"}>
      <button data-testid={testIdPrefix + "-set"}
        onClick={() => onChange({ ...row, input: tag } as unknown as T)}>set</button>
    </div>
  );
}

/** 与 pages/uiCaseDetail.tsx:106-119 同构（仅 renderParams 换桩）。 */
function uiDescriptor(over: Partial<StepDescriptor<UiCommand>> = {}): StepDescriptor<UiCommand> {
  return {
    labels: UI_LABELS,
    insertable: INSERTABLE_UI,
    defaultAppendType: "open",
    makeRow: newCommand,
    idPrefix: "u",
    summary: (s) => uiSummary(s, {}),
    validate: validateCommands,
    renderParams: stubParams<UiCommand>("X"),
    ...over,
  };
}

/** 与 pages/adbCaseDetail.tsx:134-145 同构（仅 renderParams 换桩）。 */
function adbDescriptor(): StepDescriptor<AdbStep> {
  return {
    labels: ADB_LABELS,
    insertable: INSERTABLE_ADB,
    defaultAppendType: "connect",
    makeRow: newStep,
    idPrefix: "a",
    summary: adbSummary,
    validate: validateSteps,
    renderParams: stubParams<AdbStep>("Y"),
  };
}

/** 与 e2e/uiCase.spec.mjs 的 seedLoginCase 同源的合法登录链（u1..u4）：
 *  经真实 validateCommands 零 issue——预检类用例的「阴性对照」靠它成立。 */
function uiFixture(): UiCommand[] {
  return [
    { id: "u1", type: "open", input: "http://x/ui/login" },
    { id: "u2", type: "click", inline_locator: { type: "css", value: "#account" } },
    { id: "u3", type: "click", inline_locator: { type: "css", value: "#submit" } },
    { id: "u4", type: "assert_text", inline_locator: { type: "css", value: "#title" },
      input: "订单工作台" },
  ];
}

/** u2 去掉定位器 → validateCommands 恰好在第 1 位（画出来的「第 2 行」）产 missing_element_ref。 */
function uiFixtureBroken(): UiCommand[] {
  const rows = uiFixture();
  delete rows[1].inline_locator;
  return rows;
}

interface EditorProps<T extends StepLike> {
  descriptor: StepDescriptor<T>;
  initial: T[];
  onChange?: (next: T[]) => void;
  canUpdate?: boolean;
  saveIssues?: StepIssue[] | null;
  dirty?: boolean;
  /** 外部（编辑器之外）改当前列表的把手——⑩ 的「剪贴板是快照」要能在复制之后
   *  改屏幕上的行，受控组件得有个合法的改法。 */
  mutate?: (prev: T[]) => T[];
}

/** 受控 harness：onChange 喂回 useState —— uiCaseDetail.tsx:225 `onChange={setSteps}` 同构。
 *  不这么包，任何变更后 steps 不变，展开/徽标/行数都断言不了。 */
function Harness<T extends StepLike>(props: EditorProps<T>) {
  const [steps, setSteps] = useState<T[]>(props.initial);
  return (
    <>
      <StepListEditor descriptor={props.descriptor} steps={steps} dirty={props.dirty ?? false}
        canUpdate={props.canUpdate ?? true} saveIssues={props.saveIssues}
        onChange={(next) => { setSteps(next); props.onChange?.(next); }} />
      {props.mutate && (
        <button data-testid="harness-apply" onClick={() => setSteps((prev) => props.mutate!(prev))}>
          外部变更
        </button>
      )}
    </>
  );
}

function editorEl<T extends StepLike>(over: EditorProps<T>): ReactNode {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <Harness {...over} />
    </ConfigProvider>
  );
}

function renderEditor<T extends StepLike>(over: EditorProps<T>): RenderResult {
  return render(<>{editorEl(over)}</>);
}

type Spy = ReturnType<typeof vi.fn>;
const lastRows = <T,>(spy: Spy): T[] =>
  spy.mock.calls[spy.mock.calls.length - 1][0] as unknown as T[];
const rowIds = (nodes: HTMLElement[]) => nodes.map((n) => n.getAttribute("data-id"));
const allRows = () => screen.getAllByTestId("cmd-row") as HTMLElement[];
const rowAt = (i: number): HTMLElement => allRows()[i];

/** antd 浮层 portal 进 body；motion:false 下已关浮层不卸载 → 一律只认非 -hidden 的那份
 *  （MembersTab.test.tsx:161 同款）。Select 选项是虚拟列表，别指望 DOM 里有全量。 */
const visibleSelectTexts = () => Array.from(document.querySelectorAll(
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option"))
  .map((o) => (o.textContent ?? "").trim());
/** 行菜单项 + 子菜单标题（子菜单 popup 是独立 portal，项也是 .ant-dropdown-menu-item）。 */
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>(
  ".ant-dropdown-menu-item, .ant-dropdown-menu-submenu-title"))
  .filter((el) => el.closest(".ant-dropdown-hidden") === null);
const menuItemWith = (text: string): HTMLElement => {
  const el = menuItems().find((n) => (n.textContent ?? "").includes(text));
  if (!el) throw new Error("菜单里没有「" + text + "」，现有：" + menuItems().map((n) => n.textContent).join("/"));
  return el;
};

/** antd Select 靠 mousedown 展开（MembersTab.test.tsx:157 同款），cmd-add 的 testid 在
 *  .ant-select 外层（同 member-candidate 的先例），搜索输入框从它内部 query。 */
function openAddSelect(): void {
  fireEvent.mouseDown(screen.getByTestId("cmd-add").querySelector(".ant-select-selector")!);
}
function typeAddSearch(q: string): void {
  fireEvent.change(screen.getByTestId("cmd-add").querySelector("input")!, { target: { value: q } });
}
async function clickSelectOption(label: string): Promise<void> {
  await waitFor(() => {
    expect(visibleSelectTexts()).toEqual([label]);
  }, { timeout: 3000 });
  const opt = Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option"))
    .find((o) => (o.textContent ?? "").trim() === label)!;
  fireEvent.click(opt);
}

async function openRowMenu(i: number): Promise<void> {
  fireEvent.click(screen.getByTestId("cmd-more-" + i));
  await waitFor(() => {
    expect(menuItems().some((el) => (el.textContent ?? "").includes("删除该行"))).toBe(true);
  }, { timeout: 3000 });
}

/** hover 打开「在这一行后插入…」子菜单再点目标类型。rc-menu 的 onMouseEnter 需要原生
 *  mouseover 衍生（fireEvent.mouseEnter 只发 mouseenter，React 不认），所以三件套齐上；
 *  子菜单 mouseEnterDelay ~0.1s，超时给足。 */
async function hoverInsertSubmenuClick(typeLabel: string): Promise<void> {
  const parent = menuItemWith("在这一行后插入");
  fireEvent.pointerOver(parent);
  fireEvent.mouseOver(parent);
  fireEvent.mouseEnter(parent);
  await waitFor(() => {
    expect(menuItems().some((el) => (el.textContent ?? "").trim() === typeLabel)).toBe(true);
  }, { timeout: 4000 });
  fireEvent.click(menuItemWith(typeLabel));
}

const fakeDt = () => ({ effectAllowed: "", setData: () => {}, getData: () => "" });

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

beforeEach(() => {
  cleanup();
  message.destroy();
});

afterEach(() => cleanup());

describe("① 工具条添加：insertRow 接到 cmd-add / cmd-add-end", () => {
  it("cmd-add 选「断言文本」→ 追加末尾、id=u5（descriptor 前缀 max+1）、草稿=newCommand 逐字、新行自动展开 cmdp-4；可选项=insertable（被拦 5 种搜不到）；合法草稿零预检", async () => {
    // 阴性对照先行：这条 4 步链经真实 validateCommands 必须零 issue（⑦ 的「不凭空冒块」靠它）
    expect(validateCommands(uiFixture())).toEqual([]);
    const rows = uiFixture();
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, onChange });
    expect(screen.queryByTestId("case-local-issues")).toBeNull();

    openAddSelect();
    // 虚拟列表不给全量，用 searchText 取证「集合 = insertable」：被拦的上传压根不在表里
    typeAddSearch("上传");
    await waitFor(() => expect(visibleSelectTexts()).toEqual([]));
    typeAddSearch("断言文本");
    await clickSelectOption("断言文本"); // 唯一命中：assert_text 的 searchText「断言文本 assert_text」

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    // 草稿形状逐字 = descriptor.makeRow("assert_text")，只被骨架填上 id
    expect(out[4]).toEqual({ ...newCommand("assert_text"), id: "u5" });
    // insertRow 的 setExpanded(after+1)：新行自动展开，面板 testIdPrefix=cmdp-4（e2e 钉点）
    expect(screen.getByTestId("cmdp-4-panel")).not.toBeNull();
    // 回调出去的是新数组；入参数组一根手指都没碰
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("空列表：cmd-add-end 不出现（:249 filtered>0），cmd-add 仍把第一条落在头部（insertAfterRow 裁端点）→ u1", async () => {
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: [], onChange });
    expect(screen.queryByTestId("cmd-add-end")).toBeNull();
    expect(screen.getByText(/还没有命令/)).not.toBeNull();
    openAddSelect();
    typeAddSearch("断言文本");
    await clickSelectOption("断言文本");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastRows<UiCommand>(onChange).map((r) => r.id)).toEqual(["u1"]); // 空列表 → u1
  });
});

describe("② 行菜单插入：insertRow 接在「在这一行后插入…」子菜单", () => {
  it("第 2 行的子菜单点「断言文本」→ 插在 u2 之后（u1,u2,u5,u3,u4）、id=u5；钉当前行为：展开态落在锚行 cmdp-1 而非新行 cmdp-2（FINDINGS F1：rc-menu 浮层是 React portal，菜单项 click 顺 React 树回冒到行 onClick，setExpanded(after+1) 被更晚执行的行内 toggle 覆盖）；子菜单同样不含被拦类型", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, onChange });
    await openRowMenu(1);
    await hoverInsertSubmenuClick("断言文本");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u5", "u3", "u4"]);
    expect(out[2].type).toBe("assert_text");
    // 数组语义（插在 i 后）是契约；展开位是 F1 现状：toggle(锚行 i=1) 排在 setExpanded(2) 之后赢批处理
    expect(screen.getByTestId("cmdp-1-panel")).not.toBeNull();
    expect(screen.queryByTestId("cmdp-2-panel")).toBeNull();
  });

  it("子菜单项集合 = descriptor.insertable：「滚动」在、「上传」不在（R101 被拦类型连行内入口也不给）", async () => {
    const rows = uiFixture();
    renderEditor({ descriptor: uiDescriptor(), initial: rows });
    await openRowMenu(0);
    const parent = menuItemWith("在这一行后插入");
    fireEvent.pointerOver(parent);
    fireEvent.mouseOver(parent);
    fireEvent.mouseEnter(parent);
    await waitFor(() => {
      expect(menuItems().some((el) => (el.textContent ?? "").trim() === "滚动")).toBe(true);
    }, { timeout: 4000 });
    expect(menuItems().some((el) => (el.textContent ?? "").trim() === "上传")).toBe(false);
  });
});

describe("③ 行菜单复制（duplicate）", () => {
  it("第 2 行「复制（duplicate）」→ 副本换新 id 插本行后（u1,u2,u5,u3,u4）、descriptor.cloneRow 在链上、toast「已复制为 u5」、源数组不原地改", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    const cloneRow = vi.fn((s: UiCommand) => ({ ...s, _cloned: true }));
    renderEditor({ descriptor: uiDescriptor({ cloneRow }), initial: rows, onChange });
    await openRowMenu(1);
    fireEvent.click(menuItemWith("复制（duplicate）"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u5", "u3", "u4"]);
    expect(out[2]._cloned).toBe(true); // cloneRow 没接进 duplicateRowAt 的话这里红
    expect(cloneRow).toHaveBeenCalledTimes(1);
    expect(out[1]).toBe(rows[1]); // 其余条目保持原引用（copy-on-write，不是深克隆整表）
    expect(rows).toHaveLength(4); // 源数组不原地改
    await waitFor(() => expect(toastText()).toContain("已复制为 u5"));
  });

  it("descriptor 不给 cloneRow（两家页面现状）：骨架回落 stepList 的浅拷贝默认，副本除 id 外与源行等值", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, onChange });
    await openRowMenu(0);
    fireEvent.click(menuItemWith("复制（duplicate）"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<UiCommand>(onChange);
    expect(out[1]).toEqual({ ...rows[0], id: "u5" });
  });
});

describe("④ 拖拽重排：moveRow 接在 HTML5 drop 上", () => {
  it("拖末行落到前面 → 前移（:199 toIndex=i-1 的先删后插校正）；再拖回来落到后面 → 后移（不减 1）；落回自己 = 零回调", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, onChange });

    // 前移：from=3(u4) 落到 index=1(u2)，from>i → moveRow(3, 1)
    fireEvent.dragStart(rowAt(3), { dataTransfer: fakeDt() });
    fireEvent.dragOver(rowAt(1), { dataTransfer: fakeDt() });
    fireEvent.drop(rowAt(1), { dataTransfer: fakeDt() });
    fireEvent.dragEnd(rowAt(3), { dataTransfer: fakeDt() });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastRows<UiCommand>(onChange).map((r) => r.id)).toEqual(["u1", "u4", "u2", "u3"]);

    // 后移：现在屏幕 [u1,u4,u2,u3]；from=1(u4) 落到 index=3(u3)——注意 :199 的不对称：
    // from<i 时 toIndex=i-1（落在目标行**之前**），from>i 时 toIndex=i（也落在目标行之前，
    // 因为先删后插把目标挤后了一位）。两段都按 e2e/uiCase.spec.mjs:261 的落位钉当前行为。
    onChange.mockClear();
    fireEvent.dragStart(rowAt(1), { dataTransfer: fakeDt() });
    fireEvent.dragOver(rowAt(3), { dataTransfer: fakeDt() });
    fireEvent.drop(rowAt(3), { dataTransfer: fakeDt() });
    fireEvent.dragEnd(rowAt(1), { dataTransfer: fakeDt() });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastRows<UiCommand>(onChange).map((r) => r.id)).toEqual(["u1", "u2", "u4", "u3"]);

    // 再拖回最前：from=2(u4) 落到 index=0，from>i → toIndex=i=0 → 顶到头部
    onChange.mockClear();
    fireEvent.dragStart(rowAt(2), { dataTransfer: fakeDt() });
    fireEvent.dragOver(rowAt(0), { dataTransfer: fakeDt() });
    fireEvent.drop(rowAt(0), { dataTransfer: fakeDt() });
    fireEvent.dragEnd(rowAt(2), { dataTransfer: fakeDt() });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastRows<UiCommand>(onChange).map((r) => r.id)).toEqual(["u4", "u1", "u2", "u3"]);

    // 落回自己：:196 的 dragFrom===i 守卫——不许产生「没动也 dirty」的回调
    onChange.mockClear();
    fireEvent.dragStart(rowAt(0), { dataTransfer: fakeDt() });
    fireEvent.drop(rowAt(0), { dataTransfer: fakeDt() });
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).not.toHaveBeenCalled();
    expect(rowIds(allRows())).toEqual(["u4", "u1", "u2", "u3"]);
  });
});

describe("⑤ 删除与参数面板更新", () => {
  it("「删除该行」→ onChange 恰为 removeRowAt(i) 且收起展开态；面板按钮 → onChange 恰为 updateRowAt(i, 整行)", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, onChange });
    // 行点击 toggle 展开（:203）
    fireEvent.click(rowAt(1));
    expect(screen.getByTestId("cmdp-1-panel")).not.toBeNull();

    await openRowMenu(1);
    fireEvent.click(menuItemWith("删除该行"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastRows<UiCommand>(onChange).map((r) => r.id)).toEqual(["u1", "u3", "u4"]);
    expect(screen.queryByTestId("cmdp-1-panel")).toBeNull(); // setExpanded(null) 收起

    // 参数面板的 onChange：骨架把 renderParams 给的整行 updateRowAt 到第 i 位
    onChange.mockClear();
    fireEvent.click(rowAt(0));
    fireEvent.click(await screen.findByTestId("cmdp-0-set"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<UiCommand>(onChange);
    expect(out[0].id).toBe("u1");
    expect(out[0].input).toBe("X"); // 桩写入的整行落在第 0 位
    expect(out[1].id).toBe("u3"); // 上一段删过 u2，屏幕现在是 u1,u3,u4——其它行原样透传
    expect(rows[0].input).toBe("http://x/ui/login"); // 原件不动
  });
});

describe("⑥ 行 id 前缀与词表来自 descriptor（§11.4.12 两家差异注入）", () => {
  it("同一个 cmd-add-end 喂 ADB descriptor → 出 a3 + connect 的 newStep 空壳；行画 ADB 词「Shell 命令」；下拉里「Shell 命令」有、「点击」（UI 词）没有", async () => {
    const steps: AdbStep[] = [{ id: "a2", type: "shell", config: { cmd: "hello" } }];
    const onChange = vi.fn();
    renderEditor({ descriptor: adbDescriptor(), initial: steps, onChange });
    // 词表注入：ADB 的 shell 画「Shell 命令」（ADB_LABELS）——UI 词表里没有 shell，回落也不会是这个
    expect(rowAt(0).textContent).toContain("Shell 命令");

    fireEvent.click(screen.getByTestId("cmd-add-end")); // defaultAppendType="connect"
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const out = lastRows<AdbStep>(onChange);
    // 前缀写死成 u 的话这里必红：a2 → a3，草稿 = newStep("connect")（config 空壳、device auto）
    expect(out.map((r) => r.id)).toEqual(["a2", "a3"]);
    expect(out[1]).toEqual({ ...newStep("connect"), id: "a3" });

    openAddSelect();
    typeAddSearch("Shell");
    await waitFor(() => expect(visibleSelectTexts()).toEqual(["Shell 命令"])); // ADB 词表 + 26 全开
    typeAddSearch("点击");
    await waitFor(() => expect(visibleSelectTexts().length).toBeGreaterThan(0));
    // UI 的词「点击」不在 ADB 下拉里（ADB 带点击字样的是坐标点击/按文本点击…，没有裸「点击」）
    expect(visibleSelectTexts().some((t) => t === "点击")).toBe(false);
  });
});

describe("⑦ 本地预检（case-local-issues）按 index 点名行", () => {
  it("u2 缺定位器 → case-local-issues 写「第 2 行 missing_element_ref」，行内 cmd-row-issue 恰好落在 data-id=u2 那一行，case-save-issues 不出现", () => {
    // 前提自证：恰好一条 issue、恰好 index=1
    const issues = validateCommands(uiFixtureBroken());
    expect(issues.map((x) => [x.index, x.code])).toEqual([[1, "missing_element_ref"]]);
    renderEditor({ descriptor: uiDescriptor(), initial: uiFixtureBroken() });

    const local = screen.getByTestId("case-local-issues");
    expect(local.textContent).toContain("本地预检发现 1 个问题");
    expect(local.textContent).toContain("第 2 行"); // it.index + 1（:170）
    expect(local.textContent).toContain("missing_element_ref");
    expect(screen.queryByTestId("case-save-issues")).toBeNull();
    // 「indexed against the right row」：徽标只属于 u2，其它三行干净
    const flagged = allRows().filter((n) => n.querySelector("[data-testid='cmd-row-issue']") !== null);
    expect(rowIds(flagged)).toEqual(["u2"]);
    expect(flagged[0].querySelector("[data-testid='cmd-row-issue']")!.textContent)
      .toBe("missing_element_ref");
  });

  it("整案级 issue（index=-1 的 empty_steps）画「第 - 行」且不给任何行挂徽标；7 条时只列 6 条 + 「……共 7 条」（:169/:173 slice）", () => {
    renderEditor({ descriptor: uiDescriptor(), initial: [] });
    const local = screen.getByTestId("case-local-issues");
    expect(local.textContent).toContain("第 - 行"); // index<0 → "-"（:170）
    expect(local.textContent).toContain("empty_steps");
    expect(screen.queryAllByTestId("cmd-row-issue")).toHaveLength(0);
    cleanup();

    // 7 行 key 缺 input → 7 条同行级 issue：描述只画 6 条，第 7 条并进「……共 7 条」
    const seven: UiCommand[] = Array.from({ length: 7 }, (_, i) => ({ id: "u" + (i + 1), type: "key" }));
    expect(validateCommands(seven)).toHaveLength(7);
    renderEditor({ descriptor: uiDescriptor(), initial: seven });
    const box = screen.getByTestId("case-local-issues");
    expect(box.textContent).toContain("……共 7 条");
    expect(screen.getAllByTestId("cmd-row-issue")).toHaveLength(7); // 行内徽标不受 slice 限制
    // 徽标数钉不住 :169 的 slice(0,6)：整个删掉它上面两条照样绿（变异取证存活位）。
    // 摘要本体 = case-local-issues 内 ul 的 <li>（该 Alert 里没有别的 li，天然不数行徽标）；
    // 溢出条「……共 N 条」自身也是 <li>，滤掉后正文必须恰 6 条——slice 没了就是 7。
    const summaryLis = Array.from(box.querySelectorAll("li"))
      .filter((li) => !(li.textContent ?? "").includes("……共"));
    expect(summaryLis).toHaveLength(6);
  });
});

describe("⑧ 422 issues（case-save-issues）与本地预检分块且互斥", () => {
  it("saveIssues 非空 → 只出 case-save-issues（「库里没动」文案 + 逐条 code）、本地块让位；null → 本地块回来；钉当前行为：saveIssues=[] 两块都不出（FINDINGS F2：[] truthy，:164 `!saveIssues` 把空数组当「422 在场」）", () => {
    const over: EditorProps<UiCommand> = {
      descriptor: uiDescriptor(), initial: uiFixtureBroken(),
      saveIssues: [{ index: 3, code: "empty_steps", message: "零步全绿是假绿" }],
    };
    const view = renderEditor(over);
    const save = screen.getByTestId("case-save-issues");
    expect(save.textContent).toContain("保存被拒绝：共 1 个命令问题（库里没动）");
    expect(save.textContent).toContain("empty_steps");
    // :164 的 `!saveIssues &&`：422 在场时预检块不许同屏（分不清哪条是服务端说的）
    expect(screen.queryByTestId("case-local-issues")).toBeNull();
    expect(screen.getAllByTestId("case-save-issue")).toHaveLength(1);

    // null（页面初始态/保存成功后的复位）：422 块收掉，本地块回来
    view.rerender(<>{editorEl({ ...over, saveIssues: null })}</>);
    expect(screen.queryByTestId("case-save-issues")).toBeNull();
    expect(screen.getByTestId("case-local-issues")).not.toBeNull();

    // 现状钉：[] 长度 0 → 422 块不出（:151 length>0），但 [] truthy → 本地块也不出。
    // 今天两家页面只会给 null|非空数组（uiCaseDetail.tsx:53 初始 null、422 才 set），够不到这条；
    // 一旦有人把 422 复位改成 setSaveIssues([])，所有本地预检会静默消失——故在此钉死现状。
    view.rerender(<>{editorEl({ ...over, saveIssues: [] })}</>);
    expect(screen.queryByTestId("case-save-issues")).toBeNull();
    expect(screen.queryByTestId("case-local-issues")).toBeNull();
  });
});

describe("⑨ 搜索过滤 + dirty 回显", () => {
  it("搜「断言」只留 u4 且行号仍画原始序号 4；按 type 原文（click）也命中 u2,u3；全程零 onChange；筛选态 draggable=false，清空恢复；dirty 只是 props 回显", () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    const over: EditorProps<UiCommand> = { descriptor: uiDescriptor(), initial: rows, onChange };
    const view = renderEditor(over);
    expect(screen.getByTestId("cmd-dirty").textContent).toBe("与库一致");

    fireEvent.change(screen.getByTestId("cmd-search"), { target: { value: "断言" } });
    const visible = allRows();
    expect(rowIds(visible)).toEqual(["u4"]); // 只滤可见，底层顺序没被重排
    expect(visible[0].textContent).toMatch(/^4/); // 画的是原始行号 i+1，不是过滤后序号 1
    expect(visible[0].getAttribute("draggable")).toBe("false"); // :113 筛选态禁拖
    expect(screen.getByTestId("cmd-dirty").textContent).toBe("与库一致"); // 搜索不产生 dirty

    // 按 type 原文命中（:67 的 s.type 分支）
    fireEvent.change(screen.getByTestId("cmd-search"), { target: { value: "click" } });
    expect(rowIds(allRows())).toEqual(["u2", "u3"]);
    expect(allRows().map((n) => n.textContent?.[0])).toEqual(["2", "3"]);

    fireEvent.change(screen.getByTestId("cmd-search"), { target: { value: "" } });
    expect(rowIds(allRows())).toEqual(["u1", "u2", "u3", "u4"]);
    expect(rowAt(0).getAttribute("draggable")).toBe("true");
    expect(onChange).not.toHaveBeenCalled(); // 搜索是纯本地态，绝不触底

    // dirty 是纯 props：同样的 steps 重渲染不改指示，prop 翻才翻（组件自己不算 dirty）
    view.rerender(<>{editorEl(over)}</>);
    expect(screen.getByTestId("cmd-dirty").textContent).toBe("与库一致");
    view.rerender(<>{editorEl({ ...over, dirty: true })}</>);
    expect(screen.getByTestId("cmd-dirty").textContent).toBe("有未保存修改");
  });
});

describe("⑩ 页内剪贴板：粘贴是插入不是替换", () => {
  it("空板：菜单粘贴 disabled 且工具条钮不在 DOM；复制→工具条粘贴到末尾（u5，不替换）；再粘贴取的是入板快照（不是当前行现值）；两件时行菜单粘贴在 u2 后插 u6,u7，前缀原样、id 不复用", async () => {
    const rows = uiFixture();
    const onChange = vi.fn();
    const over: EditorProps<UiCommand> = {
      descriptor: uiDescriptor(), initial: rows, onChange,
      mutate: (prev) => prev.map((r, i) => (i === 0 ? { ...r, input: "外部改过了" } : r)),
    };
    renderEditor(over);

    // 空板：工具条钮压根不渲染（:133 clipboard.length>0），行菜单粘贴 disabled 且写明原因
    expect(screen.queryByTestId("cmd-paste")).toBeNull();
    await openRowMenu(0);
    const disabledPaste = menuItemWith("粘贴到后面（剪贴板为空）");
    expect(disabledPaste.className).toContain("ant-dropdown-menu-item-disabled");
    fireEvent.click(disabledPaste);
    await new Promise((r) => setTimeout(r, 30));
    expect(onChange).not.toHaveBeenCalled();

    // 复制 u1（入板的是快照）→ 工具条出现「粘贴(1)」
    onChange.mockClear();
    fireEvent.click(menuItemWith("复制到剪贴板"));
    const paste = await screen.findByTestId("cmd-paste");
    expect(paste.textContent).toContain("粘贴(1)");
    fireEvent.click(paste); // 工具条粘贴 = 末尾（:136 steps.length-1）
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    let out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4", "u5"]); // 插入不替换：只增
    expect(out[4].type).toBe("open");
    expect(out[4].input).toBe("http://x/ui/login");

    // 编辑器之外改掉 u1 的 input，再点粘贴：出去的必须还是入板时的旧值（:100 快照语义）
    fireEvent.click(screen.getByTestId("harness-apply"));
    expect(rowAt(0).textContent).toContain("外部改过了");
    onChange.mockClear();
    fireEvent.click(screen.getByTestId("cmd-paste"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]); // 新 id 不复用
    expect(out[5].input).toBe("http://x/ui/login"); // 不是「外部改过了」——剪贴板是快照

    // 第二件：复制当前末行（u5），板上有 2 件 → 行 1 菜单「粘贴到后面（2）」插在 u2 后
    onChange.mockClear();
    await openRowMenu(4);
    expect(menuItemWith("粘贴到后面").textContent).toContain("粘贴到后面（1）");
    fireEvent.click(menuItemWith("复制到剪贴板"));
    const paste2 = await screen.findByTestId("cmd-paste");
    await waitFor(() => expect(paste2.textContent).toContain("粘贴(2)"));
    await openRowMenu(1);
    fireEvent.click(menuItemWith("粘贴到后面（2）"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    out = lastRows<UiCommand>(onChange);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u7", "u8", "u3", "u4", "u5", "u6"]);
    expect(new Set(out.map((r) => r.id)).size).toBe(8); // 同一用例内 id 不许复用
    expect(out[2].type).toBe("open");
    expect(out[3].type).toBe("open");
  });
});

describe("⑪ 只读面（canUpdate=false，§11.5.1 藏把手而非置灰）", () => {
  it("cmd-add / cmd-add-end / cmd-more-N / cmd-paste 一个都不渲染；行不可拖、点击不展开；cmd-search 与行内容照常读得到", () => {
    const rows = uiFixture();
    renderEditor({ descriptor: uiDescriptor(), initial: rows, canUpdate: false });
    expect(screen.queryByTestId("cmd-add")).toBeNull();
    expect(screen.queryByTestId("cmd-add-end")).toBeNull();
    expect(screen.queryAllByTestId(/^cmd-more-/)).toHaveLength(0);
    expect(screen.queryByTestId("cmd-paste")).toBeNull();
    // 读权限没被顺手拿走：4 行、词表、摘要都在
    expect(rowIds(allRows())).toEqual(["u1", "u2", "u3", "u4"]);
    expect(rowAt(0).textContent).toContain("打开 http://x/ui/login");
    expect(rowAt(0).getAttribute("draggable")).toBe("false");
    fireEvent.click(rowAt(0)); // :203 的 canUpdate 守卫：点了也不展开
    expect(screen.queryByTestId(/^cmdp-/)).toBeNull();
    expect(screen.getByTestId("cmd-search")).not.toBeNull();
    expect(screen.getByTestId("cmd-dirty").textContent).toBe("与库一致");
  });
});
