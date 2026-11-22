// 整板 PropsPanel（默认导出）的组件测试。此前的覆盖边只有 PropsPanel.assert.test.tsx
// 引的共用子控件 AssertionListEditor（具名导出），整板 56 个 data-testid 背后的
// **步骤级表单逻辑**在单测/e2e 两层都是零（e2e/sceneList.spec.mjs 只摸场景级 shell）。
// 这里真的挂载默认导出，钉的是「表单 ↔ store」这条双向边：
//   ① 每种 step kind 渲染各自的配置字段（kind 全集表驱动，prop-kind 徽标对 labelOf）；
//   ② 编辑落 store：断言 useSceneStore.getState() 的事后树/草稿态，不看回调影子——
//      sleep ms、loop count/while 分叉（cond 只在 while 出现）、adb 设备策略三段
//      （specified→serial、切回 any_idle 清空 serial 不留半套）、api/ui 用例下拉写 ref、
//      名称提交式 renameKey（逐键不写、blur 落库、空名不提交）、高级页签 disable/key 改名、
//      set_var 应用 JSON、script 懒编辑器 code 落 config.code；
//   ③ 权限门双向钉（真 patternsForProject + can，跑 project.my_perms 夹具，不 mock can）：
//      *:read → 定时绑定可读不可改（rebind 选择器/按钮缺席）；* → 在场且可点；
//      无 schedule:task:read → cron-bind-noperm 且 listTasks 零调用；
//   ④ 断言列表的面板级接线（子控件行为已有 assert.test.tsx，这里只钉切片）：
//      http_direct 页签进出的是 node.config.assertions，场景面板进出的是 store.commonAssertions，
//      api_case/ui_case 页签只给诚实说明不给编辑器。
//   ⑤ 场景变量「加变量」的 key 分配：删过行后必须顺移到第一个空位 varN——既不撞现存 key
//      （旧「行数+1」实现撞键 = no-op 或覆盖他行值），也不动现存行的顺序与值。
// ── mock 了什么、因此没证明什么（bench.test.tsx 同款口径）────────────────────
// * ../components/CodeEditor → textarea 桩：懒加载/Suspense 边界、value/onChange 接线是真的，
//   但 monaco 本体的渲染、worker 接线、真编辑器键盘行为不在本文件的证明范围（归 e2e T16 夹具页）。
// * ../api/schedule（listTasks/rebindTask）→ 函数桩：钉的是面板「传什么参、何时调几次」，
//   HTTP URL/body 组装在 api/schedule.ts 自己的契约面，这里没碰网络也就没证明它。
// * useAuth / auth/perms / useSceneStore 全部真实：权限结论、store 写入结论对本文件负责。
// * 没证明的还有一层：保存请求体（saveBody 归 store.saveAssertions.test.ts）、
//   画布/列表与面板的联动、后端 graph 校验同尺。加变量的 varN 命名同样只证到 store 草稿态，
//   后端对变量名的口径（如果有）不经本文件。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import { MemoryRouter } from "react-router-dom";

// antd 响应式观察器（jsdom 没有 matchMedia，每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
// rc-tabs/rc-select 的尺寸观察：jsdom 无 ResizeObserver，空壳即可（不断言几何）
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

// monaco 懒 chunk → textarea 桩（见文件头「没证明什么」）。
vi.mock("../components/CodeEditor", () => ({
  default: (props: { value?: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="code-editor-stub" value={props.value ?? ""}
      onChange={(e) => props.onChange?.(e.target.value)} />
  ),
}));

// 定时接口函数桩：每次测试重置返回，调用参数/次数就是断言对象。
const schedule = vi.hoisted(() => ({
  listTasks: vi.fn(async () => ({ items: [] as unknown[], next_cursor: null })),
  rebindTask: vi.fn(async (id: string) => ({ id })),
}));
vi.mock("../api/schedule", () => ({ listTasks: schedule.listTasks, rebindTask: schedule.rebindTask }));

// 设备清单桩（1g/D168：adb_case 步骤的「指定设备」从裸 Input 换成共用 DeviceSelect 后，
// 候选来自 adbApi.listDevices）。默认空列表＝「还没有设备」空态；设备下拉那条用例自己灌 fixture。
const adb = vi.hoisted(() => ({ listDevices: vi.fn(async () => ({ items: [] as unknown[], next_cursor: null })) }));
vi.mock("../api/adb", () => ({ adbApi: adb }));

import PropsPanel from "./PropsPanel";
import { findByKey } from "./graphOps";
import { kindMeta, labelOf, type Kind, type StepNode } from "./stepTypes";
import { useSceneStore } from "./store";
import { useAuth } from "../auth/store";
import { ApiErr } from "../api/client";
import type { CaseRow } from "../api/api";
import type { components } from "../api/schema";

type TaskOut = components["schemas"]["TaskOut"];

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const USER = { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" };
/** 权限走真 patternsForProject：非系统管理员 + my_perms 夹具（服务端下发优先的正式路径）。 */
function auth(perms: string[]): void {
  useAuth.setState({
    user: USER,
    project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "MEMBER", my_perms: perms },
    ready: true,
  });
}

function caseRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "c1", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P0",
    request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
    effective_request: null, ...over,
  };
}

function task(over: Partial<TaskOut> = {}): TaskOut {
  return {
    id: "t1", project_id: "p1", name: "夜间回归", subject_type: "scenario",
    subject_id: "s1", cron: "0 2 * * *", enabled: 1, consecutive_failures: 0, ...over,
  } as TaskOut;
}

function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    loading: false, projectId: "p1", scenarioId: "s1",
    nodes: [], layout: {}, baselineNodes: "[]", selectedKey: null, selectedKeys: [],
    collapsed: [], serverIssues: [], cases: [], uiCases: [], adbCases: [],
    clipboard: null, readOnly: false,
    variables: {}, baselineVariables: "{}", failFast: true, baselineFailFast: true,
    maxRuntimeMs: null, baselineMaxRuntimeMs: null,
    commonAssertions: [], baselineCommonAssertions: "[]",
    ...over,
  } as never);
}

function renderPanel(): void {
  render(
    <MemoryRouter>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <PropsPanel />
      </ConfigProvider>
    </MemoryRouter>,
  );
}
/** 种一棵只含 node 的树并选中它。 */
function mountStep(node: StepNode, over: Record<string, unknown> = {}): void {
  seed({ nodes: [node], selectedKey: node.key, ...over });
  renderPanel();
}

function nodeOf(key: string, nodes = useSceneStore.getState().nodes): StepNode {
  const found = findByKey(nodes, key);
  if (!found) throw new Error("store 里找不到节点 " + key);
  return found[0];
}

// ── 交互小工具（版本实现细节按现网 antd5 落点）──────────────────────────────

function clickTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}
/** Segmented 的选项是真 radio：点未选中的那个 input 才发 change（CommandParams.test 同款）。 */
function clickSegment(testid: string, label: string): void {
  const root = screen.getByTestId(testid);
  const item = Array.from(root.querySelectorAll(".ant-segmented-item"))
    .find((el) => el.textContent === label)!;
  fireEvent.click(item.querySelector("input")!);
}
/** rc-select：testid 在外层 wrapper，selector 在内；浮层只认非 -hidden 的那份（bench.test 同款）。 */
function selectSelector(testid: string): HTMLElement {
  const el = screen.getByTestId(testid);
  return (el.querySelector(".ant-select-selector") ?? el) as HTMLElement;
}
async function pickOption(testid: string, label: string): Promise<void> {
  fireEvent.mouseDown(selectSelector(testid));
  await waitFor(() => {
    const opt = visibleOptions().find((o) => (o.textContent ?? "").includes(label));
    expect(opt, "下拉里没有 " + label).toBeTruthy();
  });
  fireEvent.click(visibleOptions().find((o) => (o.textContent ?? "").includes(label))!);
}
function visibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")) as HTMLElement[];
}
/** InputNumber 的 testid 落点是版本细节：可能就是 input，也可能挂 wrapper。 */
function numInput(testid: string): HTMLInputElement {
  const n = screen.getByTestId(testid);
  return (n.tagName === "INPUT" ? n : n.querySelector("input")) as HTMLInputElement;
}

beforeEach(() => {
  cleanup();
  schedule.listTasks.mockReset();
  schedule.listTasks.mockResolvedValue({ items: [], next_cursor: null } as never);
  schedule.rebindTask.mockReset();
  schedule.rebindTask.mockImplementation(async (id: string) => ({ id } as never));
  adb.listDevices.mockReset();
  adb.listDevices.mockResolvedValue({ items: [], next_cursor: null } as never);
  auth(["*"]);
});

afterEach(() => {
  cleanup();
  message.destroy();
});

// ── ① kind → 字段渲染（kindMeta/labelOf 全集）───────────────────────────────

describe("整板 PropsPanel（默认导出挂载）", () => {
  it("未选中步骤 = 场景级面板兜底（基本信息/变量/策略/超时/公共断言/定时/引用提示都在场）", () => {
    seed({
      scenario: { id: "s1", name: "下单回归", version: 3, priority: "P0" } as never,
      nodes: [{ key: "n1", kind: "api_case", name: "引用一步", ref: "c9" }],
      cases: [caseRow({ id: "c9", name: "创建订单接口" })],
    });
    renderPanel();
    expect(screen.getByTestId("scene-props-scenario")).toBeTruthy();
    expect(screen.queryByTestId("scene-props")).toBeNull(); // 步骤面板不出现
    expect(document.body.textContent).toContain("下单回归（v3，P0）");
    expect(screen.getByTestId("scene-var-table")).toBeTruthy();
    expect(screen.getByTestId("scene-fail-continue")).toBeTruthy();
    expect(screen.getByTestId("scene-max-runtime")).toBeTruthy();
    expect(screen.getByTestId("scene-common-assertions")).toBeTruthy();
    expect(screen.getByTestId("scene-cron-bind")).toBeTruthy();
    // 引用提示走真 walk：api_case 的 ref 被数到并解析用例名
    expect(screen.getByTestId("scene-refs-hint").textContent).toContain("1 个接口用例：创建订单接口");
  });

  it("kind 全集各配各的表单字段，prop-kind 徽标对 labelOf（表驱动 15 种）", async () => {
    const rows: Array<{ kind: Kind; ids: string[]; text?: string; absent?: string[] }> = [
      { kind: "api_case", ids: ["prop-ref"] },
      { kind: "ui_case", ids: ["prop-ref"] },
      { kind: "adb_case", ids: ["prop-ref", "prop-adb-device-policy", "prop-adb-queue-note"], absent: ["prop-adb-device-serial"] },
      { kind: "http_direct", ids: ["prop-url"] },
      { kind: "sleep", ids: ["prop-ms"] },
      { kind: "loop", ids: ["prop-loop-mode", "prop-max-iter"], absent: ["prop-cond"] }, // count 态无 cond
      { kind: "if", ids: ["prop-branch-0", "prop-branch-type-0", "prop-branch-add"] },
      { kind: "foreach", ids: ["prop-list-var", "prop-item-var"] },
      { kind: "break", ids: [], text: "跳出循环 只能待在 loop / foreach 内部" },
      { kind: "continue", ids: [], text: "继续下一轮 只能待在 loop / foreach 内部" },
      { kind: "script", ids: ["code-editor-stub"] }, // 懒加载桩
      { kind: "extract", ids: ["prop-rule-0", "prop-rule-add"] },
      { kind: "assert", ids: ["prop-assert-0", "prop-assert-add"] },
      { kind: "set_var", ids: ["code-editor-stub"] },
      { kind: "group", ids: [], text: "分组是串行容器" },
    ];
    for (const r of rows) {
      cleanup();
      const node: StepNode = {
        key: "k-" + r.kind, kind: r.kind, name: labelOf(r.kind),
        config: kindMeta(r.kind).defaultConfig(),
      };
      mountStep(node);
      expect(screen.getByTestId("prop-kind").textContent, "prop-kind 徽标 ≠ labelOf").toBe(labelOf(r.kind));
      for (const id of r.ids) {
        // script/set_var 走 Suspense：桩到位才算渲染完成
        await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy(), { timeout: 3000 });
      }
      if (r.text) await waitFor(() => expect(document.body.textContent).toContain(r.text!));
      for (const id of r.absent ?? []) expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  // ── ② 编辑写穿 store（断言 getState() 事后态）───────────────────────────────

  it("sleep：ms 写进 config.ms；清空（null）不写——store 里还是原值", () => {
    mountStep({ key: "s1", kind: "sleep", name: "等待", config: { ms: 1000 } });
    fireEvent.change(numInput("prop-ms"), { target: { value: "2500" } });
    expect(nodeOf("s1").config?.ms).toBe(2500);
    fireEvent.change(numInput("prop-ms"), { target: { value: "" } });
    expect(nodeOf("s1").config?.ms).toBe(2500); // onChange(null) 被 typeof 守卫拦下
  });

  it("loop：count/while 分叉——cond 字段只在 while 出现；mode/max_iter/cond 都落 config", () => {
    mountStep({ key: "lp", kind: "loop", name: "循环", config: { mode: "count", cond: "", max_iter: 3 }, children: [] });
    expect(screen.queryByTestId("prop-cond")).toBeNull();
    fireEvent.change(numInput("prop-max-iter"), { target: { value: "7" } });
    expect(nodeOf("lp").config?.max_iter).toBe(7);
    clickSegment("prop-loop-mode", "while 条件");
    expect(nodeOf("lp").config?.mode).toBe("while");
    fireEvent.change(screen.getByTestId("prop-cond"), { target: { value: "ctx.vars.get('state') == 'P'" } });
    expect(nodeOf("lp").config?.cond).toBe("ctx.vars.get('state') == 'P'");
  });

  // 1g/D168：serial 从裸 Input 换成共用 DeviceSelect（与 ADB 用例详情页同一只控件）。
  // 原「fireEvent.change 敲自由文本」不再存在——执行链只认登记过的 serial
  // （backend debug_services.py:146/:198-204，DeviceSelect.tsx 头注），腿改成「点开下拉选一台」。
  it("adb 设备策略三段：specified 才出 serial；选登记设备落 config；切回 any_idle 把 serial 清空", async () => {
    adb.listDevices.mockResolvedValue({ items: [
      { id: "d1", name: "中台平板", serial: "192.168.1.10:5555", last_state: { online: true } },
      { id: "d2", name: "小米13", serial: "10.0.0.9:5555", last_state: { online: false } },
    ], next_cursor: null } as never);
    mountStep({
      key: "ad", kind: "adb_case", name: "装包", ref: "",
      config: { device_policy: "any_idle" },
    }, { adbCases: [caseRow({ id: "a1", name: "ADB 冒烟" })] as never });
    clickSegment("prop-adb-device-policy", "指定设备");
    expect(nodeOf("ad").config?.device_policy).toBe("specified");
    await waitFor(() => expect(adb.listDevices).toHaveBeenCalled());
    await pickOption("prop-adb-device-serial", "中台平板");
    expect(nodeOf("ad").config?.device_serial).toBe("192.168.1.10:5555");
    // 离线设备如实标出来（共用件的 · 离线后缀在画布侧同样生效）
    fireEvent.mouseDown(selectSelector("prop-adb-device-serial"));
    await waitFor(() => expect(visibleOptions()
      .some((o) => (o.textContent ?? "").includes("小米13（10.0.0.9:5555 · 离线）"))).toBe(true));
    // 切回任一空闲：不留半套配置（源码注释的口径，serial 必须归零）
    clickSegment("prop-adb-device-policy", "任一空闲设备");
    expect(nodeOf("ad").config?.device_policy).toBe("any_idle");
    expect(nodeOf("ad").config?.device_serial).toBe("");
  });

  it("画布设备下拉的诚实空态：候选没取到前不假装有设备（空列表 = 「项目里还没有设备」）", async () => {
    // 默认桩 listDevices → 空 items（adbCaseDetail 同款：拉不到/没有都落空列表空态）
    mountStep({ key: "ad", kind: "adb_case", name: "装包", ref: "",
      config: { device_policy: "specified", device_serial: "" } });
    await waitFor(() => expect(adb.listDevices).toHaveBeenCalled());
    const ph = screen.getByTestId("prop-adb-device-serial")
      .querySelector(".ant-select-selection-placeholder")!;
    expect(ph.textContent).toBe("项目里还没有设备");
  });

  // D136：占用提示按本步策略分叉钉死。旧文案对两种策略统一承诺「后台执行按 FIFO
  // 排队（运行记录里看真实位次）」——任一空闲的真实语义是轮询等待、不入队也没有位次
  // （debug_services.py:401-404），而位次载荷没有任何界面渲染（全仓 grep device_queued
  // 只到 detail/事件层）。变异靶：把 note 改回无条件单句（任一条红）· 任一空闲腿重新
  // 出现 FIFO/位次承诺（红）· specified 腿改口「不排队」（红）。
  it("adb 占用提示分策略：specified 才承诺 FIFO 且位次「记在运行事件·界面未渲染」；any_idle 明说轮询不排队", () => {
    mountStep({ key: "ad", kind: "adb_case", name: "装包", ref: "",
      config: { device_policy: "specified", device_serial: "" } });
    const note = () => screen.getByTestId("prop-adb-queue-note").textContent ?? "";
    expect(note()).toContain("对这台设备按 FIFO 排队");
    expect(note()).toContain("真实位次记在运行事件里——当前界面未渲染");
    // 「运行记录里看」是 D136 杀掉的假承诺：全仓没有界面渲染 device_queued
    expect(note()).not.toContain("运行记录里看");
    // 切到任一空闲：同一处 note 必须整体换血——不排队就没有位次可说
    clickSegment("prop-adb-device-policy", "任一空闲设备");
    expect(nodeOf("ad").config?.device_policy).toBe("any_idle");
    expect(note()).toContain("自动换空闲设备");
    expect(note()).toContain("轮询等待");
    expect(note()).toContain("不排队，也就没有位次");
    expect(note()).not.toContain("FIFO");
    expect(note()).not.toContain("运行记录里看");
    // D17 的「不编预计时长」半边在两条分支都保留
    expect(note()).toContain("预计时长没有估算公式");
  });

  it("api_case 下拉选择写 node.ref；断言页签只给诚实说明，不给假断言编辑器", async () => {
    mountStep({ key: "ap", kind: "api_case", name: "下单", ref: "" }, { cases: [caseRow()] });
    await pickOption("prop-ref", "已支付订单");
    expect(nodeOf("ap").ref).toBe("c1");
    expect(screen.getByTestId("prop-ref").textContent).toContain("已支付订单");
    clickTab("断言");
    expect(document.body.textContent).toContain("断言跟着用例走");
    // 面板级切片负例：这里绝不允许长出断言编辑器
    expect(document.querySelector('[data-testid="prop-direct-assert-add"]')).toBeNull();
    expect(document.querySelector('[data-testid="prop-assert-add"]')).toBeNull();
  });

  // refPlaceholder 的 denied / error 两支此前零断言（只钉过 ok 分支的「选择/还没有」）。
  // 摘掉那两行，占位会退回 ok 分支：对着 403 喊「还没有用例」，让人去新建一条本来就有的。
  it("引用用例下拉的占位分三种真事：没权限看 / 这次没取到 / 项目真没有（三个用例域各自独立）", () => {
    const ph = () => (screen.getByTestId("prop-ref").querySelector(".ant-select-selection-placeholder") as HTMLElement)
      .textContent;
    const failed = (over: Record<string, string>) => ({
      cases: null, uiCases: null, adbCases: null, envs: null, ...over,
    });
    mountStep({ key: "ap", kind: "api_case", name: "下单", ref: "" },
      { assetsFailed: failed({ cases: "denied" }) });
    expect(ph()).toBe("无权限看接口用例");
    cleanup();
    mountStep({ key: "ap", kind: "api_case", name: "下单", ref: "" },
      { assetsFailed: failed({ cases: "error" }), cases: [caseRow()] as never });
    expect(ph()).toBe("接口用例没取到"); // 有候选行也盖不住失败：不能说「选择 API 用例」
    cleanup();
    mountStep({ key: "ui", kind: "ui_case", name: "登录", ref: "" },
      { assetsFailed: failed({ uiCases: "error" }) });
    expect(ph()).toBe("UI 用例没取到");
    cleanup();
    mountStep({ key: "ad", kind: "adb_case", name: "装包", ref: "", config: {} },
      { assetsFailed: failed({ adbCases: "denied" }) });
    expect(ph()).toBe("无权限看ADB 用例");
    cleanup();
    // 记账干净时回到正常话术，且「有没有」跟各域自己的行数走
    mountStep({ key: "ui", kind: "ui_case", name: "登录", ref: "" },
      { assetsFailed: failed({}) });
    expect(ph()).toBe("还没有用例");
  });

  it("ui_case 断言页签：诚实说明带用例类型（UI 用例），编辑器同样不出现", () => {
    mountStep({ key: "ui", kind: "ui_case", name: "登录", ref: "" });
    clickTab("断言");
    expect(screen.getByTestId("prop-ui-assert-note").textContent).toContain("UI 用例步骤的断言跟着用例走");
    expect(document.querySelector('[data-testid^="prop-direct-assert"]')).toBeNull();
  });

  it("名称提交式落库：逐键不进 store，blur 才 renameKey；空名/未改名不提交", () => {
    mountStep({ key: "nm", kind: "sleep", name: "原名", config: { ms: 1 } });
    const input = screen.getByTestId("prop-name");
    fireEvent.change(input, { target: { value: "改过的名" } });
    expect(nodeOf("nm").name).toBe("原名"); // 逐键不写（undo 栈口径）
    fireEvent.blur(input);
    expect(nodeOf("nm").name).toBe("改过的名");
    fireEvent.change(screen.getByTestId("prop-name"), { target: { value: "   " } });
    fireEvent.blur(screen.getByTestId("prop-name"));
    expect(nodeOf("nm").name).toBe("改过的名"); // trim 后空 → 不提交
  });

  it("高级页签：disable 开关翻转 store.disable；key 改名走 patchNode（旧 key 查无、新 key 在）", () => {
    mountStep({ key: "adv", kind: "sleep", name: "一步", config: { ms: 1 } });
    clickTab("高级");
    fireEvent.click(screen.getByTestId("prop-disable"));
    expect(nodeOf("adv").disable).toBe(true);
    const keyInput = screen.getByTestId("prop-key");
    fireEvent.change(keyInput, { target: { value: "adv2" } });
    fireEvent.blur(keyInput);
    expect(useSceneStore.getState().nodes && findByKey(useSceneStore.getState().nodes, "adv")).toBeNull();
    expect(nodeOf("adv2").key).toBe("adv2");
  });

  it("懒编辑接线：script 的 textarea 桩写 config.code；set_var 应用 JSON 落 vars，坏 JSON 报错不落库", async () => {
    cleanup();
    mountStep({ key: "sc", kind: "script", name: "脚本", config: { code: "" } });
    fireEvent.change(await screen.findByTestId("code-editor-stub"), { target: { value: "x = 1" } });
    expect(nodeOf("sc").config?.code).toBe("x = 1");
    cleanup();
    mountStep({ key: "sv", kind: "set_var", name: "变量", config: { vars: { a: 1 } } });
    const box = await screen.findByTestId("code-editor-stub");
    expect((box as HTMLTextAreaElement).value).toContain('"a": 1'); // 初值来自 config.vars
    fireEvent.change(box, { target: { value: "{坏 JSON" } });
    fireEvent.click(screen.getByText("应用 JSON"));
    expect(document.body.textContent).toContain("JSON 解析失败");
    expect(nodeOf("sv").config?.vars).toEqual({ a: 1 }); // 坏 JSON 不落库
    fireEvent.change(screen.getByTestId("code-editor-stub"), { target: { value: '{"b": 2}' } });
    fireEvent.click(screen.getByText("应用 JSON"));
    expect(nodeOf("sv").config?.vars).toEqual({ b: 2 });
  });

  // ── ④ 断言列表的面板级接线（切片进出正确，子控件行为归 assert.test.tsx）────

  it("http_direct 断言页签：渲染的是 node.config.assertions 现有行，加一条写回 config.assertions", () => {
    mountStep({
      key: "hd", kind: "http_direct", name: "直连",
      config: { method: "GET", url: "/x", assertions: [{ type: "regex", expected: "^tk$" }] },
    });
    clickTab("断言");
    expect(screen.getByTestId("prop-direct-assert-0")).toBeTruthy(); // 现有切片接进来了
    fireEvent.click(screen.getByTestId("prop-direct-assert-add"));
    const asrt = nodeOf("hd").config?.assertions as Array<Record<string, unknown>>;
    expect(asrt).toHaveLength(2);
    expect(asrt[0]).toEqual({ type: "regex", expected: "^tk$" }); // 原行原样保住
    expect(asrt[1]).toEqual({ type: "status_code", expected: 200 }); // 新增行是子控件的新增语义
  });

  it("场景面板公共断言：进出的是 store.commonAssertions（不是某步的 config）", () => {
    seed({ commonAssertions: [{ type: "regex", expected: "x" }] as never });
    renderPanel();
    expect(screen.getByTestId("scene-cassert-0")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scene-cassert-add"));
    expect(useSceneStore.getState().commonAssertions).toEqual([
      { type: "regex", expected: "x" },
      { type: "status_code", expected: 200 },
    ]);
  });

  it("场景级草稿写 store：变量行改值、失败策略开关、超时下限钳 1000、清空成 null", () => {
    seed({ variables: { token: "abc" }, failFast: false });
    renderPanel();
    fireEvent.change(screen.getByTestId("var-val-0"), { target: { value: "abc!" } });
    expect(useSceneStore.getState().variables).toEqual({ token: "abc!" });
    fireEvent.click(screen.getByTestId("var-add"));
    // 新增键是 "var" + (行数+1)：现有 1 行 → var2（不是 var1）
    expect(useSceneStore.getState().variables.var2).toBe("");
    // checked = !failFast：seed false → 已勾；点掉 → setFailFast(true)
    fireEvent.click(screen.getByTestId("scene-fail-continue"));
    expect(useSceneStore.getState().failFast).toBe(true);
    fireEvent.change(screen.getByTestId("scene-max-runtime"), { target: { value: "500" } });
    expect(useSceneStore.getState().maxRuntimeMs).toBe(1000); // Math.max(1000, ·)
    fireEvent.change(screen.getByTestId("scene-max-runtime"), { target: { value: "" } });
    expect(useSceneStore.getState().maxRuntimeMs).toBeNull();
  });

  // ── ⑤ 加变量的 key 分配（旧「行数+1」规则删过行必撞键，这里钉死）─────────────

  it("加变量（普通情形）：空变量表点一下 → 追加 var1 空行", () => {
    seed({ variables: {} });
    renderPanel();
    fireEvent.click(screen.getByTestId("var-add"));
    expect(Object.entries(useSceneStore.getState().variables)).toEqual([["var1", ""]]);
    expect(screen.getByTestId("var-row-0")).toBeTruthy();
    expect((screen.getByTestId("var-key-0") as HTMLInputElement).value).toBe("var1");
  });

  it("加变量（删过 0 行后）：行数派生键会撞现存 key 变 no-op/覆盖——必须顺移且不动幸存行", () => {
    // 复现路径：{var1,var2} → 删掉 var1，剩 1 行 {var2:"two"}
    seed({ variables: { var1: "one", var2: "two" } });
    renderPanel();
    fireEvent.click(screen.getByTestId("var-del-0"));
    expect(Object.keys(useSceneStore.getState().variables)).toEqual(["var2"]);
    fireEvent.click(screen.getByTestId("var-add"));
    const v = useSceneStore.getState().variables;
    // 旧实现算出 "var" + (1+1) = var2，spread 撞键 → var2 的值被覆盖成 ""、行数纹丝不动
    expect(v.var2, "幸存行的值被覆盖").toBe("two");
    // 新实现从 len+1 起顺移到第一个空位（var2 占着 → var3）；行序 = 插入序，追加在末尾
    expect(Object.entries(v)).toEqual([["var2", "two"], ["var3", ""]]);
  });

  it("加变量连点两次：每次键都不同，绝不塌回同一条空行", () => {
    // 种「删过 row0 之后」的现场：2 行 {var2,var3}，朴素规则两次都算 var3 → 全程 no-op
    seed({ variables: { var2: "two", var3: "" } });
    renderPanel();
    fireEvent.click(screen.getByTestId("var-add"));
    fireEvent.click(screen.getByTestId("var-add"));
    const v = useSceneStore.getState().variables;
    expect(Object.entries(v)).toEqual([["var2", "two"], ["var3", ""], ["var4", ""], ["var5", ""]]);
    expect(new Set(Object.keys(v)).size, "两次点击产生的键撞了").toBe(4);
    // 原有两行原封不动
    expect(v.var2).toBe("two");
    expect(v.var3).toBe("");
  });

  // ── ③ 权限门双向（真 patternsForProject/can，驱动 my_perms 夹具）────────────

  it("只读模式（my_perms=*:read）：定时绑定可读不可改——rebind 选择器与按钮都不提供", async () => {
    auth(["*:read", "-system:*"]);
    schedule.listTasks.mockResolvedValue({ items: [task(), task({ id: "t2", name: "别人的定时", subject_id: "s9" })], next_cursor: null } as never);
    seed(); // selectedKey=null → 场景面板 → CronBindSection
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("cron-bind-task-t1")).toBeTruthy());
    expect(schedule.listTasks).toHaveBeenCalledTimes(1); // 可读：列一次
    expect(screen.queryByTestId("cron-bind-rebind-select")).toBeNull();
    expect(screen.queryByTestId("cron-bind-rebind")).toBeNull(); // 可写控件：一个都不许出现
    fireEvent.click(screen.getByTestId("cron-bind-goto")); // 只读下仍给跳转出口（不 mock 的 router 不炸）
  });

  it("可写模式（my_perms=*）：rebind 在场、未选禁用；选定后 rebindTask(「t2」, {project_id, subject_id}) 且成功后重拉", async () => {
    auth(["*"]);
    schedule.listTasks.mockResolvedValue({ items: [task(), task({ id: "t2", name: "别人的定时", subject_id: "s9" })], next_cursor: null } as never);
    schedule.rebindTask.mockImplementation(async (id: string) => ({ ...task({ id }), name: "别人的定时" } as never));
    seed();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("cron-bind-rebind")).toBeTruthy());
    expect((screen.getByTestId("cron-bind-rebind") as HTMLButtonElement).disabled).toBe(true);
    await pickOption("cron-bind-rebind-select", "别人的定时");
    fireEvent.click(screen.getByTestId("cron-bind-rebind"));
    await waitFor(() => expect(schedule.rebindTask).toHaveBeenCalledTimes(1));
    expect(schedule.rebindTask).toHaveBeenCalledWith("t2", { project_id: "p1", subject_id: "s1" });
    await waitFor(() => expect(schedule.listTasks).toHaveBeenCalledTimes(2)); // 成功 → reload
  });

  it("无 schedule:task:read（my_perms=[api:def:read]）：给 cron-bind-noperm 说明，listTasks 零调用", () => {
    auth(["api:def:read"]);
    seed();
    renderPanel();
    expect(screen.getByTestId("cron-bind-noperm")).toBeTruthy();
    expect(screen.queryByTestId("cron-bind-rebind")).toBeNull();
    expect(schedule.listTasks).not.toHaveBeenCalled();
  });

  it("定时列表加载失败：cron-bind-error 逐字带出 ApiErr.message（服务端原话插值，且与 noperm/empty 互斥）", async () => {
    // 权限够读（否则先撞 noperm 腿）；listTasks 抛带独特文案的 ApiErr。
    // PropsPanel.tsx:103 是 `定时任务加载失败：{loadError}`——文案硬编码在前端的话这里必红。
    auth(["*"]);
    schedule.listTasks.mockImplementation(async () => {
      throw new ApiErr("boom_5xx", "调度服务连接被重置 CRONXZ-9527", 503);
    });
    seed();
    renderPanel();
    const err = await screen.findByTestId("cron-bind-error");
    expect(err.textContent).toBe("定时任务加载失败：调度服务连接被重置 CRONXZ-9527");
    // 分支互斥（PropsPanel.tsx:97-106 的 ternary 链）：错误腿在场时
    // noperm / empty / 加载中 / 绑定列表 / 改绑控件都不许同时出现
    expect(screen.queryByTestId("cron-bind-noperm")).toBeNull();
    expect(screen.queryByTestId("cron-bind-empty")).toBeNull();
    expect(document.body.textContent).not.toContain("定时任务加载中…");
    expect(document.querySelector('[data-testid^="cron-bind-task-"]')).toBeNull();
    expect(screen.queryByTestId("cron-bind-goto")).toBeNull();
  });

  it("加载成功但一条都没绑（对照腿）：cron-bind-empty 在场且 cron-bind-error 缺席", async () => {
    auth(["schedule:task:read"]);
    schedule.listTasks.mockResolvedValue({ items: [task({ subject_id: "s9" })], next_cursor: null } as never);
    seed();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("cron-bind-empty")).toBeTruthy());
    expect(screen.queryByTestId("cron-bind-error")).toBeNull();
    expect(screen.queryByTestId("cron-bind-noperm")).toBeNull();
  });

  // partial（next_cursor 非空 = 只看了前 200 条）以前零断言：摘掉 `partial ?` 的一侧，
  // 界面会对着一份没看全的清单把「没有」讲成全称结论——用户据此断定场景没绑定时，
  // 其实绑定就在第 201 条之后。两处文案（跑本场景的 / 可改绑的）都分叉，各自钉住。
  it("有游标（只取了前 200 条）：两处「没有」都降级成「前 200 条里没有」；无游标才说全称", async () => {
    auth(["*"]);
    seed();
    schedule.listTasks.mockResolvedValue({ items: [], next_cursor: "c200" } as never);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("cron-bind-empty").textContent)
      .toBe("前 200 条定时任务里没有跑这个场景的。"));
    expect(document.body.textContent)
      .toContain("前 200 条定时任务里没有可改绑的——去定时任务页看看后面的页或新建一个。");
    expect(document.body.textContent).not.toContain("项目里还没有别的定时任务可改绑");
    cleanup();
    schedule.listTasks.mockResolvedValue({ items: [], next_cursor: null } as never);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("cron-bind-empty").textContent)
      .toBe("还没有定时任务跑这个场景。"));
    expect(document.body.textContent)
      .toContain("项目里还没有别的定时任务可改绑——先去定时任务页建一个。");
  });

  it("if 分支编辑：加分支/切否则/删分支都写 config.branches", () => {
    mountStep({ key: "if1", kind: "if", name: "判断", config: { branches: [{ cond: "$.a == 1", children: [] }] } });
    expect(screen.getByTestId("prop-branch-cond-0")).toBeTruthy(); // 条件分支给条件框
    fireEvent.change(screen.getByTestId("prop-branch-cond-0"), { target: { value: "$.a == 2" } });
    expect((nodeOf("if1").config?.branches as Array<{ cond: string }>)[0].cond).toBe("$.a == 2");
    fireEvent.click(screen.getByTestId("prop-branch-else")); // 无 else 才给钮
    let bs = nodeOf("if1").config?.branches as Array<{ cond: string }>;
    expect(bs).toHaveLength(2);
    expect(bs[1].cond).toBe("else");
    expect(screen.queryByTestId("prop-branch-cond-1")).toBeNull(); // else 分支不给条件框
    fireEvent.click(screen.getByTestId("prop-branch-del-1"));
    bs = nodeOf("if1").config?.branches as Array<{ cond: string }>;
    expect(bs).toHaveLength(1);
  });

  // D146：只读消费 store.readOnly——输入 disabled、写钮隐藏（§11.5.1 隐藏派）。
  // 两条腿各带正对照（防「对谁都只读」镜像假绿）；dirty 的源头全禁 ⇒ 离开拦截不会误锁。
  it("D146 只读·步骤级：名称/配置输入 disabled，高级页签删除钮隐藏、禁用开关与 key 框 disabled", () => {
    const sleep: StepNode = { key: "s1", kind: "sleep", name: "等待", config: { ms: 100 } };
    mountStep(sleep, { readOnly: true });
    expect((screen.getByTestId("prop-name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("prop-ms") as HTMLInputElement).disabled).toBe(true);
    clickTab("高级");
    expect((screen.getByTestId("prop-disable") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("prop-key") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("删除这个步骤")).toBeNull();
    cleanup(); mountStep(sleep);
    expect((screen.getByTestId("prop-name") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("prop-ms") as HTMLInputElement).disabled).toBe(false);
    clickTab("高级");
    expect((screen.getByTestId("prop-disable") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("删除这个步骤")).toBeTruthy();
  });

  it("D146 只读·场景级：变量输入 disabled、加/删变量隐藏、策略开关/超时 disabled、公共断言加/删隐藏且启用开关 disabled", () => {
    const draft = { variables: { var1: "x" }, commonAssertions: [{ type: "status_code", expected: 200 }] };
    seed({ readOnly: true, ...draft }); renderPanel();
    expect((screen.getByTestId("var-key-0") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("var-val-0") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("var-add")).toBeNull();
    expect(screen.queryByTestId("var-del-0")).toBeNull();
    expect((screen.getByTestId("scene-fail-continue") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("scene-max-runtime") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("scene-cassert-add")).toBeNull();
    expect(screen.queryByTestId("scene-cassert-del-0")).toBeNull();
    expect((screen.getByTestId("scene-cassert-enabled-0") as HTMLButtonElement).disabled).toBe(true);
    cleanup(); seed(draft); renderPanel();
    expect((screen.getByTestId("var-key-0") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId("var-add")).toBeTruthy();
    expect(screen.getByTestId("var-del-0")).toBeTruthy();
    expect((screen.getByTestId("scene-fail-continue") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("scene-cassert-add")).toBeTruthy();
    expect(screen.getByTestId("scene-cassert-del-0")).toBeTruthy();
  });
});
