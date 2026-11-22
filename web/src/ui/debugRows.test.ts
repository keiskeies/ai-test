// debugRows.ts 的纯函数单测（T17）：后端 UiDebugOut 行形状的换算件。
// 断言行透传是 R108 的复用契约：DebugPanel 读的就是 {type,passed,expected,actual,error,path}，
// 这里改写或丢键都会让断言卡静默变成「期望 null」。
import { describe, expect, it } from "vitest";
import { artifactName, assertionRows, cmdRows, orderKeysByHints, shotsByCommand, shotsByStep, stepTreeHints, stepTreeLabel } from "./debugRows";

describe("artifactName", () => {
  it("ref 的目录前缀剥掉，取回文件名", () => {
    expect(artifactName("8f2c/shot-1.png")).toBe("shot-1.png");
  });
  it("没有斜杠就原样返回", () => {
    expect(artifactName("shot-1.png")).toBe("shot-1.png");
  });
});

describe("shotsByStep", () => {
  const arts = [
    { kind: "SCREENSHOT", step_key: "u3", ref: "r/shot-a.png", bytes: 10, reason: "命令失败自动截图" },
    { kind: "DOM", step_key: "u3", ref: "r/dom-a.html", bytes: 20, reason: "命令失败自动 DOM 快照" },
    { kind: "SCREENSHOT", step_key: "u3", ref: "r/shot-b.png", bytes: 30, reason: "整案终态截图" },
    { kind: "SCREENSHOT", step_key: "u1", ref: "r/shot-c.png", bytes: 5, reason: "screenshot 命令" },
  ];
  it("按命令 id 归组、只收 SCREENSHOT、保持顺序", () => {
    const m = shotsByStep(arts);
    expect(Object.keys(m).sort()).toEqual(["u1", "u3"]);
    expect(m.u3.map((s) => s.name)).toEqual(["shot-a.png", "shot-b.png"]);
    expect(m.u3[0].reason).toBe("命令失败自动截图");
  });
  it("对畸形输入不抛：ref 非串/缺键的行跳过", () => {
    const m = shotsByStep([
      { kind: "SCREENSHOT", step_key: "u1", ref: "", bytes: 0 },
      { kind: "SCREENSHOT", ref: "r/x.png", bytes: 0 },
    ] as never);
    expect(m["?"][0].name).toBe("x.png"); // step_key 缺失归到 "?"，不静默丢证据
    expect(m.u1).toBeUndefined();
  });
});

describe("shotsByCommand（T19：报告侧制品摘要按命令 id 归位）", () => {
  it("独立运行形状：step_key 就是命令 id，无 command 键 → 原样归位", () => {
    const m = shotsByCommand([
      { kind: "SCREENSHOT", step_key: "u3", ref: "r/a.png", bytes: 1, reason: "命令失败自动截图" },
      { kind: "DOM", step_key: "u3", ref: "r/b.html", bytes: 1 },
    ]);
    expect(Object.keys(m)).toEqual(["u3"]);
    expect(m.u3[0].reason).toBe("命令失败自动截图");
  });
  it("场景内形状：step_key 是画布步骤 key，command 键才是命令 id → 按 command 归位", () => {
    const m = shotsByCommand([
      { kind: "SCREENSHOT", step_key: "uin", command: "u3", ref: "r/a.png", bytes: 1 },
      { kind: "SCREENSHOT", step_key: "uin", ref: "r/no-cmd.png", bytes: 1 }, // 缺 command → 回落 step_key，不丢
    ]);
    expect(m.u3[0].name).toBe("a.png");
    expect(m.uin[0].name).toBe("no-cmd.png");
  });
  it("空/畸形不抛：ref 非串跳过，缺 step_key 归 '?'", () => {
    expect(shotsByCommand([])).toEqual({});
    const m = shotsByCommand([
      null as never,
      { kind: "SCREENSHOT", command: "u2" } as never, // ref 非串 → 跳过
      { kind: "SCREENSHOT", ref: "r/x.png", bytes: 0, command: "" } as never, // command 空串 → 回落 step_key 缺失 = "?"
    ]);
    expect(m["?"][0].name).toBe("x.png");
    expect(Object.keys(m)).toEqual(["?"]);
  });
});

describe("assertionRows", () => {
  it("R108 行形状原样透传，跨命令保序", () => {
    const rows = assertionRows([
      { id: "u1", assertions: [{ type: "assert_text", passed: true, expected: "A", actual: "A", error: null, path: "#t" }] },
      { id: "u2", assertions: [] },
      { id: "u3", assertions: [{ type: "assert_text", passed: false, expected: "B", actual: "C", error: null, path: "css:#t" }] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ type: "assert_text", passed: false, expected: "B", actual: "C", error: null, path: "css:#t" });
  });
  it("assertions 缺失/非数组都不抛", () => {
    expect(assertionRows([{ id: "u1" }, null as never, { id: "u2", assertions: "nope" }])).toEqual([]);
  });
});

describe("cmdRows", () => {
  it("正常行逐键给渲染面", () => {
    const rows = cmdRows([{ id: "u1", type: "open", status: "pass", message: "打开 x", elapsed_ms: 12, assertions: [] }]);
    expect(rows[0]).toEqual({ id: "u1", type: "open", status: "pass", message: "打开 x", elapsed_ms: 12, assertions: 0 });
  });
  it("缺 id 的畸形行也给出行（?N），status 缺失按 error（宁可说没跑成）", () => {
    const rows = cmdRows([{}, { id: "", type: "x" }] as never);
    expect(rows[0].id).toBe("?1");
    expect(rows[0].status).toBe("error");
    expect(rows[1].id).toBe("?2");
  });
});

describe("stepTreeLabel（报告左树行标题：UI 命令行不许顶著用例名）", () => {
  const uiRow = (over: Record<string, unknown> = {}) => ({
    step_key: "u1", kind: "open", subject_name: "演示：登录工作台", parent_step_key: "case", ...over,
  });
  it("父节点是 ui_case 的行 → 命令 id + 中文命令名", () => {
    expect(stepTreeLabel(uiRow(), "ui_case")).toBe("u1 · 打开");
    expect(stepTreeLabel(uiRow({ step_key: "d5", kind: "assert_text" }), "ui_case")).toBe("d5 · 断言文本");
  });
  it("kind 不在命令表里（老数据/新命令）退回 kind，不显示空串也不显示用例名", () => {
    expect(stepTreeLabel(uiRow({ kind: "brand_new" }), "ui_case")).toBe("u1 · brand_new");
  });
  // adb 命令行同形（父节点 kind=adb_case），且**必须查 adb 那张表**：
  // 两边都有 assert_text（同词「断言文本」），拿它当样本会让「两支共用一张表」的错活下来，
  // 所以各挑一个只在自己表里有译名的 kind——UI 表没有 swipe，adb 表没有 open。
  it("父节点是 adb_case 的行 → 查 adb 命令表（swipe=滑动），不串到 UI 表", () => {
    const adbRow = { step_key: "d3", kind: "swipe", subject_name: "登录案", parent_step_key: "case" };
    expect(stepTreeLabel(adbRow, "adb_case")).toBe("d3 · 滑动");
    expect(stepTreeLabel({ ...adbRow, kind: "click_by_text" }, "adb_case")).toBe("d3 · 按文本点击");
    // adb 的 kind 不在 adb 表里：退回 kind 原文（不借 UI 表的译名，也不显示用例名）
    expect(stepTreeLabel({ ...adbRow, kind: "open" }, "adb_case")).toBe("d3 · open");
  });
  it("UI 侧仍查 UI 表：open=打开（adb 表没这个 kind，串表就露馅）", () => {
    expect(stepTreeLabel(uiRow({ kind: "open" }), "ui_case")).toBe("u1 · 打开");
  });
  it("非 UI 命令行照旧用 subject_name（api_case / 循环 / 数据集步一字不改）", () => {
    expect(stepTreeLabel(uiRow({ kind: "api_case", parent_step_key: null }), null))
      .toBe("演示：登录工作台");
    expect(stepTreeLabel(uiRow({ kind: "loop", subject_name: "轮询查单" }), "root")).toBe("轮询查单");
  });
  it("subject_name 为空时退回 step_key，绝不空行", () => {
    expect(stepTreeLabel(uiRow({ subject_name: null, kind: "sleep", parent_step_key: null }), null))
      .toBe("u1");
  });
  it("subject_name 空但图上有节点名 → 用图上的名字（混合场景实测：只有数据集步带名字）", () => {
    // 真跑一条混合场景量出来的：login/tok/fin/n1 的 subject_name 全是 null，
    // 而 summary_graph 每个节点都有 name——画布显示的就是它，树此前只显 u-key。
    const bare = { step_key: "tok", kind: "extract", subject_name: null, parent_step_key: null };
    expect(stepTreeLabel(bare, null, "提取 token")).toBe("提取 token");
    // 图上也没名字（老报告/图上无此 key）才落到 step_key
    expect(stepTreeLabel(bare, null, null)).toBe("tok");
    expect(stepTreeLabel(bare, null)).toBe("tok");
  });
  it("UI 命令行不吃法外的名字：命令行的名字来自 kind，不来自图上那个用例名", () => {
    expect(stepTreeLabel(uiRow(), "ui_case", "演示：登录工作台")).toBe("u1 · 打开");
  });
});

describe("stepTreeHints + orderKeysByHints（左树按执行顺序读，名字取自报告自己的快照）", () => {
  // 混合场景真跑出来的 summary_graph 骨架（api_case + 循环 + 嵌套 + ui_case）
  const graph = {
    version: 1,
    nodes: [
      { key: "login", kind: "api_case", name: "登录获取令牌", children: [] },
      { key: "tok", kind: "extract", name: "提取 token", children: [] },
      { key: "poll", kind: "loop", name: "轮询查单", children: [
        { key: "poll.q", kind: "api_case", name: "查询订单", children: [] },
        { key: "poll.st", kind: "extract", name: "记录订单状态", children: [] },
      ] },
      { key: "fin", kind: "assert", name: "终局断言：已到 PAID", children: [] },
      { key: "n1", kind: "ui_case", name: "演示：登录工作台", children: [] },
    ],
  };
  it("前序遍历编号 = 执行顺序（父子同趟，兄弟按图上原序）", () => {
    const h = stepTreeHints(graph);
    expect(Object.keys(h).map((k) => [k, h[k].order])).toEqual([
      ["login", 0], ["tok", 1], ["poll", 2], ["poll.q", 3], ["poll.st", 4], ["fin", 5], ["n1", 6],
    ]);
    expect(h.n1.name).toBe("演示：登录工作台");
  });
  it("字母序的后端返回序 → 按 hints 排回执行顺序（这是本次修的现场）", () => {
    // report_services.py:248 的 order_by(step_key) 就是这个字母序
    expect(orderKeysByHints(["fin", "login", "n1", "poll", "tok"], stepTreeHints(graph)))
      .toEqual(["login", "tok", "poll", "fin", "n1"]);
  });
  it("图里没有的 key 保持原序、排在有号的后面（独立 UI 运行的命令行不该被打乱）", () => {
    const h = stepTreeHints({ nodes: [{ key: "case", name: "用例", children: [] }] });
    expect(orderKeysByHints(["d3", "d1", "case", "d2"], h)).toEqual(["case", "d3", "d1", "d2"]);
  });
  it("同级之内排序，不跨层搬家（子步仍跟着父步走）", () => {
    const h = stepTreeHints(graph);
    // 顶层 keys 与子层 keys 各自排，嵌套由 StepTree 的递归负责
    expect(orderKeysByHints(["poll.st", "poll.q"], h)).toEqual(["poll.q", "poll.st"]);
  });
  it("名字为空串/非串都给 null，不硬造空标题", () => {
    const h = stepTreeHints({ nodes: [
      { key: "a", name: "" }, { key: "b", name: 42 }, { key: "" , name: "空 key 不进表" },
      null, "非对象", { noKey: true },
    ] });
    expect(h.a).toEqual({ order: 0, name: null });
    expect(h.b).toEqual({ order: 1, name: null });
    expect(Object.keys(h)).toEqual(["a", "b"]);
  });
  it("畸形输入退回空表：null / 非对象 / nodes 不是数组 / 图整个缺失", () => {
    for (const bad of [null, undefined, {}, "nope", { nodes: "x" }, []]) {
      expect(stepTreeHints(bad)).toEqual({});
    }
    // 没 hints 时排序是恒等的（老报告不因为这次改动换序）
    expect(orderKeysByHints(["d3", "d1"], {})).toEqual(["d3", "d1"]);
  });
  it("children 缺失/畸形不抛，父步照样进表", () => {
    const h = stepTreeHints({ nodes: [{ key: "p", name: "父", children: "坏" }, { key: "q", name: "无子" }] });
    expect(Object.keys(h)).toEqual(["p", "q"]);
  });
});
