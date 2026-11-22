// 导入向导（§11.4.6，1E T4）状态机测试——计划门禁自证要求的「三步流转 / 策略切换计数联动」。
// 手法同 adbCases.test.tsx：fetch 全 mock 到 client 的 fetch 层，按 testid 断言。
// 钉五件事：
// ① 打开只在第①步：第②③步的控件不在 DOM；
// ② 贴样本 → 解析 → 第②步预览出现「新增/冲突」计数与逐条策略；
// ③ 策略切换计数联动：勾/去勾某条冲突，覆盖/跳过计数当场 ±1（这是 D26 口径的活账）；
// ④ 第③步回执「成功n·失败n」+ 失败逐条原因可见（iw-report）；
// ⑤ D26 钉：「新版本」策略在向导的任何一步都不出现（一期只有 跳过/覆盖）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ImportWizard from "./ImportWizard";
import type { CommitOut, PreviewOut } from "./ImportWizard";

// petstore_openapi3.json 的同形小样本（内联）：向导只把它原样 POST 给 preview，
// 计数以 mock 回执为准，但样本必须是真的能解析的 OpenAPI3 形状，不演空壳。
const PETSTORE_SAMPLE = JSON.stringify({
  openapi: "3.0.1",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets": { get: { operationId: "listPets", summary: "列出宠物", responses: { "200": { description: "ok" } } } },
    "/pets/{petId}": { get: { operationId: "getPet", summary: "查询宠物", responses: { "200": { description: "ok" } } } },
  },
});

function previewItem(name: string, method: string, path: string, exists: boolean, i: number): PreviewOut["items"][number] {
  return {
    name, method, path, request: {}, source_ref: "#/paths/" + path,
    exists, definition_id: exists ? "d" + i : null,
  };
}

// 3 新增 + 2 冲突（index 3、4）：计数联动的和式 3/2 全押在这份夹具上
const PREVIEW: PreviewOut = {
  new_count: 3, conflict_count: 2,
  items: [
    previewItem("列出宠物", "GET", "/pets", false, 0),
    previewItem("创建宠物", "POST", "/pets", false, 1),
    previewItem("上传照片", "POST", "/pets/{petId}/photos", false, 2),
    previewItem("查询宠物", "GET", "/pets/{petId}", true, 3),
    previewItem("删除宠物", "DELETE", "/pets/{petId}", true, 4),
  ],
  errors: ["https://evil.example.com 外链引用已截断（1 处）"],
};

const RECEIPT: CommitOut = {
  ok: true, created: 3, updated: 1, skipped: 1, failed: 1,
  failures: [{ name: "删除宠物", reason: "响应 204 无体断言缺失" }],
};

interface MockState { previewBody?: unknown; commitBody?: unknown }

function mockBackend(state: MockState) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api-import-preview") && method === "POST") {
      state.previewBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => PREVIEW } as unknown as Response;
    }
    if (url.includes("/api-import-commit") && method === "POST") {
      state.commitBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => RECEIPT } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

/** 走到第②步：选 Swagger2 源 + 粘样本 + 点解析。 */
async function toStep2(_state: MockState) {
  const radios = screen.getAllByRole("radio");
  fireEvent.click(radios[1]); // Swagger2
  fireEvent.change(screen.getByTestId("iw-text"), { target: { value: PETSTORE_SAMPLE } });
  fireEvent.click(screen.getByTestId("iw-parse"));
  await waitFor(() => expect(screen.getByTestId("iw-counts")).not.toBeNull());
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWizard(onImported = vi.fn()) {
  render(<ImportWizard projectId="p1" open onClose={() => undefined} onImported={onImported} />);
  return onImported;
}

describe("导入向导状态机", () => {
  it("打开只在第①步：来源控件在，第②③步控件不在 DOM", () => {
    renderWizard();
    expect(screen.getByTestId("import-wizard")).not.toBeNull();
    expect(screen.getByTestId("iw-source")).not.toBeNull();
    expect(screen.getByTestId("iw-text")).not.toBeNull();
    expect(screen.getByTestId("iw-parse")).not.toBeNull();
    // 第②步（预览）与第③步（结果）的控件一个都不许提前出现
    expect(screen.queryByTestId("iw-counts")).toBeNull();
    expect(screen.queryByTestId("iw-commit")).toBeNull();
    expect(screen.queryByTestId("iw-receipt")).toBeNull();
  });

  it("文本与 URL 二选一是真的：两处都填时当场拦下，不发请求、不进第②步", async () => {
    // 为什么钉这条：后端 import_services.py:69 是 `text if text is not None else fetch(url)`，
    // 静默优先文本。少了这道拦，业主填了 URL 却解析了文本框里的旧内容，还得不到任何提示。
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    fireEvent.change(screen.getByTestId("iw-text"), { target: { value: PETSTORE_SAMPLE } });
    fireEvent.change(screen.getByTestId("iw-url"), { target: { value: "https://x/petstore.json" } });
    fireEvent.click(screen.getByTestId("iw-parse"));
    await waitFor(() => expect(document.body.textContent).toContain("二选一"));
    expect(state.previewBody).toBeUndefined();
    expect(screen.queryByTestId("iw-counts")).toBeNull();
    // 清空其中一个后照常走通：拦的是「两个都要」，不是把 URL 路堵死
    fireEvent.change(screen.getByTestId("iw-text"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("iw-parse"));
    await waitFor(() => expect(state.previewBody).toBeDefined());
    expect(state.previewBody).toMatchObject({ url: "https://x/petstore.json" });
    expect(JSON.stringify(state.previewBody)).not.toContain("text");
  });

  it("粘样本解析进第②步：新增/冲突计数上屏，只有冲突行有跳过勾选，源随请求带过去", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    // 计数以回执为账：新增 3 · 覆盖 2（冲突缺省=覆盖）· 跳过 0
    expect(screen.getByTestId("iw-counts").textContent).toBe("新增 3 · 覆盖 2 · 跳过 0");
    // 只有 2 条冲突行有跳过勾选；新增行画「无 → 新增」
    expect(screen.queryByTestId("iw-skip-0")).toBeNull();
    expect(screen.getByTestId("iw-skip-3")).not.toBeNull();
    expect(screen.getByTestId("iw-skip-4")).not.toBeNull();
    expect(screen.getByTestId("import-wizard").textContent).toContain("无 → 新增");
    // 解析告警（preview.errors）第②步可见
    expect(screen.getByTestId("iw-errors").textContent).toContain("外链引用已截断");
    // 告警标题不许说「这些条目没进列表」：importers 的 errors 多数是**字段级**截断
    // （$ref 展开只一层），条目本身照样进列表——这份 mock 就是证据：1 条告警配 5 条条目、
    // 计数「新增 3」。写成「没进列表」等于当着用户的面把落库数字说反（§13 纪律 1）。
    expect(screen.getByTestId("iw-errors").textContent).not.toContain("没进列表");
    // 请求体三要素：项目 + 手动选的源 + 原文
    expect(state.previewBody).toMatchObject({ project_id: "p1", source: "swagger2" });
    expect(String(JSON.stringify(state.previewBody))).toContain("Petstore");
  });

  it("解析告警标题如实描述列表内容：字段级忽略不冒充「字段截断」", async () => {
    // importers 的真实告警是字段被忽略/降级（外部 $ref「该字段已忽略」、$ref 嵌套超一层、
    // formdata 文件字段丢弃、raw JSON 降级 text…），条目照样进待导入列表；
    // 真截断（name[:200]）反倒一条告警都不产——标题不许反着说。
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    const text = screen.getByTestId("iw-errors").textContent ?? "";
    expect(text).toContain("解析告警 1 条（字段被忽略/降级，或整条丢弃，逐条见明细）");
    expect(text).not.toContain("字段截断");
  });

  it("第②步如实交代回收站占名：与回收站重名的「新增」提交会被拒并整批回滚", async () => {
    // preview 的存在性键排除 recycled 行（import_services.py:113），但 commit 门槛的
    // name_taken 含回收站行（:115），任一失败整批回滚（:138-143）——「新增」不是包过的。
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    const note = screen.getByTestId("iw-recycle-note").textContent ?? "";
    expect(note).toContain("回收站");
    expect(note).toContain("整批回滚");
  });

  it("策略切换计数联动：勾跳过→覆盖-1跳过+1，去勾→当场还原", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    // 勾上第 4 行的跳过：覆盖 2→1、跳过 0→1（新增恒 3，skip 只属于冲突条目）
    fireEvent.click(screen.getByTestId("iw-skip-4"));
    await waitFor(() =>
      expect(screen.getByTestId("iw-counts").textContent).toBe("新增 3 · 覆盖 1 · 跳过 1"));
    // 去勾（= 切回覆盖）：当场回到 2/0——联动必须是活账不是快照
    fireEvent.click(screen.getByTestId("iw-skip-4"));
    await waitFor(() =>
      expect(screen.getByTestId("iw-counts").textContent).toBe("新增 3 · 覆盖 2 · 跳过 0"));
    // 全跳过/全覆盖两个批操作同样驱动计数
    fireEvent.click(screen.getByTestId("iw-skip-all"));
    await waitFor(() =>
      expect(screen.getByTestId("iw-counts").textContent).toBe("新增 3 · 覆盖 0 · 跳过 2"));
    fireEvent.click(screen.getByTestId("iw-overwrite-all"));
    await waitFor(() =>
      expect(screen.getByTestId("iw-counts").textContent).toBe("新增 3 · 覆盖 2 · 跳过 0"));
  });

  it("D26 钉：第②步任何地方不出现「新版本」策略；勾选的跳过如实变成 commit 的 skip 策略", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    // 一期只有 跳过/覆盖：向导里任何一步、任何角落都不许出现「新版本」字样
    expect(document.body.textContent).not.toContain("新版本");
    fireEvent.click(screen.getByTestId("iw-skip-3"));
    await waitFor(() =>
      expect(screen.getByTestId("iw-counts").textContent).toContain("跳过 1"));
    expect(document.body.textContent).not.toContain("新版本");
    fireEvent.click(screen.getByTestId("iw-commit"));
    await waitFor(() => expect(screen.getByTestId("iw-receipt")).not.toBeNull());
    // 勾掉的冲突 → strategy=skip；其余冲突与新条目 → overwrite
    const items = (state.commitBody as { items: Array<{ name: string; strategy: string }> }).items;
    expect(items.find((x) => x.name === "查询宠物")?.strategy).toBe("skip");
    expect(items.find((x) => x.name === "删除宠物")?.strategy).toBe("overwrite");
    expect(items.find((x) => x.name === "列出宠物")?.strategy).toBe("overwrite");
  });

  it("第③步回执：成功n·失败n + 明细逐条可见；完成后回调刷列表；关闭不再谈新版本", async () => {
    const state: MockState = {};
    mockBackend(state);
    const onImported = renderWizard();
    await toStep2(state);
    fireEvent.click(screen.getByTestId("iw-commit"));
    const receipt = await screen.findByTestId("iw-receipt");
    // 回执口径：成功 = created+updated = 4，失败 1（跳过的不算失败）
    expect(receipt.textContent).toContain("成功 4 · 失败 1");
    expect(receipt.textContent).toContain("新增 3");
    expect(receipt.textContent).toContain("覆盖 1");
    expect(receipt.textContent).toContain("跳过 1");
    // 失败逐条原因可见（不做只报个数的糊账）
    expect(screen.getByTestId("iw-report").textContent).toContain("删除宠物：响应 204 无体断言缺失");
    // 完成即回调（外层 api.tsx 靠它刷列表）
    expect(onImported).toHaveBeenCalled();
    // 第③步收尾控件：下载错误报告可点（有明细）、关闭在
    expect((screen.getByTestId("iw-download") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("iw-close")).not.toBeNull();
    // 第③步同样不许漏出「新版本」
    expect(document.body.textContent).not.toContain("新版本");
  });

  it("第②步可回第①步改来源，回来计数清空重走流程", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2(state);
    fireEvent.click(screen.getByTestId("iw-back"));
    await waitFor(() => expect(screen.queryByTestId("iw-counts")).toBeNull());
    expect(screen.getByTestId("iw-parse")).not.toBeNull();
    // 文本没丢（回退不是重置）：直接再解析即可
    expect((screen.getByTestId("iw-text") as HTMLTextAreaElement).value).toContain("Petstore");
    fireEvent.click(screen.getByTestId("iw-parse"));
    await waitFor(() => expect(screen.getByTestId("iw-counts")).not.toBeNull());
  });
});

// §11.4.6 [拖拽文件] 落成点选：真读文件灌进 text state，解析/预览流水原样复用。
// 钉三件事：①选文件后文本框真被灌进内容、且能一路走到 preview 请求体（不是假控件）；
// ②覆盖行为说在明面上（hint），且确实覆盖；③空文件/图片一句人话提示，文本框一行不动。
describe("选文件入口（FileTextPicker）", () => {
  function pickFile(file: File) {
    fireEvent.change(screen.getByTestId("iw-file-input"), { target: { files: [file] } });
  }

  it("选 .json 文件：文本框被灌进内容（覆盖已粘文本），解析请求体带的就是文件内容", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    // 覆盖行为写在明面上：按钮旁就是这句说明
    expect(screen.getByTestId("iw-file-hint").textContent).toContain("选文件会覆盖当前文本框内容");
    // 先粘一份，再选文件——说好的覆盖就得真覆盖
    fireEvent.change(screen.getByTestId("iw-text"), { target: { value: "旧文本" } });
    pickFile(new File([PETSTORE_SAMPLE], "petstore.json", { type: "application/json" }));
    await waitFor(() =>
      expect((screen.getByTestId("iw-text") as HTMLTextAreaElement).value).toContain("Petstore"));
    expect((screen.getByTestId("iw-text") as HTMLTextAreaElement).value).not.toContain("旧文本");
    // 灌进去的就是流水的输入：点解析 → preview 请求体带文件原文
    fireEvent.click(screen.getByTestId("iw-parse"));
    await waitFor(() => expect(state.previewBody).toBeDefined());
    expect(String(JSON.stringify(state.previewBody))).toContain("Petstore");
  });

  it("空文件：一句人话提示，文本框一行没动", async () => {
    renderWizard();
    fireEvent.change(screen.getByTestId("iw-text"), { target: { value: "别弄丢我" } });
    pickFile(new File([""], "empty.json", { type: "application/json" }));
    await waitFor(() => expect(document.body.textContent).toContain("是空文件"));
    expect((screen.getByTestId("iw-text") as HTMLTextAreaElement).value).toBe("别弄丢我");
  });

  it("图片文件：提示「不是文本文件」，文本框一行没动，不崩", async () => {
    renderWizard();
    pickFile(new File(["\u0089PNG\u0000\u001a\n"], "截图.png", { type: "image/png" }));
    await waitFor(() => expect(document.body.textContent).toContain("不是文本文件"));
    expect((screen.getByTestId("iw-text") as HTMLTextAreaElement).value).toBe("");
  });
});
