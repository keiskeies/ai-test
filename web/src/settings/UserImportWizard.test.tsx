// D40 用户批量导入向导（§11.4.22）状态机测试——形状对齐 ImportWizard.test.tsx（1E T4 同款）。
// 钉四件事：
// ① 打开只在第①步（第②③步控件不在 DOM）；
// ② 粘贴→解析→第②步：后端回执的 新增/冲突 计数与逐行处置上屏，格式问题（带行号）不静默；
// ③ 排除勾选联动计数；初始密码 <8 位不发请求（后端同样强校验，双保险）；
// ④ 第③步回执「成 n 跳 n 失败 n」+ 逐条行号原因 + 勾选的排除如实变成 commit 的 skip 策略、
//    「导入为平台管理员」勾选真的随请求带出去（假门禁令：控件后端必须真认）。
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import UserImportWizard from "./UserImportWizard";
import type { UserImportCommitOut, UserImportPreviewOut } from "../api/userImport";

// 4 行：3 新增（行 2/3/4）+ 1 冲突（行 5）；格式问题 2 条（带行号）
const PREVIEW: UserImportPreviewOut = {
  new_count: 3, conflict_count: 1,
  items: [
    { line: 2, account: "alice", name: "爱丽丝", email: "a@x.com", exists: false },
    { line: 3, account: "bob", name: "鲍勃", email: null, exists: false },
    { line: 4, account: "carol", name: "卡罗尔", email: "c@x.com", exists: false },
    { line: 5, account: "admin", name: "已在的人", email: null, exists: true },
  ],
  errors: ["第 6 行：账号「b@d」不合法——只能字母数字与 _ . -，长度 2~64，该行已跳过（不会被导入）",
    "第 7 行：缺姓名，该行已跳过（不会被导入）"],
};

const RECEIPT: UserImportCommitOut = {
  ok: true, created: 2, skipped: 2, failed: 1,
  failures: [{ line: 9, account: "zed", reason: "账号「zed」已存在（库内或本批更早行），该行已跳过" }],
  skipped_detail: [
    { line: 5, account: "admin", reason: "账号已存在，跳过并保留现有用户" },
    { line: 4, account: "carol", reason: "已勾选本次不导入（未改动任何数据）" },
  ],
};

interface MockState { previewBody?: unknown; commitBody?: unknown }

function mockBackend(state: MockState) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/system/users/import-preview") && method === "POST") {
      state.previewBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => PREVIEW } as unknown as Response;
    }
    if (url.includes("/system/users/import-commit") && method === "POST") {
      state.commitBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => RECEIPT } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

function renderWizard(onImported = vi.fn()) {
  render(<UserImportWizard open onClose={() => undefined} onImported={onImported} />);
  return onImported;
}

async function toStep2() {
  fireEvent.change(screen.getByTestId("uiw-text"), { target: { value: "账号,姓名\nalice,爱丽丝\n" } });
  fireEvent.click(screen.getByTestId("uiw-parse"));
  await waitFor(() => expect(screen.getByTestId("uiw-counts")).not.toBeNull());
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("用户批量导入向导状态机", () => {
  it("打开只在第①步：粘贴框在，第②③步控件不在 DOM", () => {
    renderWizard();
    expect(screen.getByTestId("uiw-modal")).not.toBeNull();
    expect(screen.getByTestId("uiw-text")).not.toBeNull();
    expect(screen.queryByTestId("uiw-counts")).toBeNull();
    expect(screen.queryByTestId("uiw-receipt")).toBeNull();
  });

  it("粘贴→解析：后端计数上屏、冲突行恒跳过、格式问题带行号回显、原文随请求带过去", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2();
    // 计数以回执为账：可建 3 · 不建 1（冲突缺省跳过）
    expect(screen.getByTestId("uiw-counts").textContent)
      .toContain("可建 3 · 不建 1（冲突 1 · 手动排除 0）");
    // 冲突行（第 5 行）没有勾选框，只有「账号已存在 → 跳过」的实话
    expect(screen.getByTestId("uiw-conflict-5").textContent).toContain("账号已存在");
    expect(screen.queryByTestId("uiw-skip-5")).toBeNull();
    // 新增行才有「本次不导入」勾选
    expect(screen.getByTestId("uiw-skip-2")).not.toBeNull();
    // 解析期格式问题（带行号的人话）在第②步可见，不静默
    expect(screen.getByTestId("uiw-errors").textContent).toContain("第 6 行");
    expect(screen.getByTestId("uiw-errors").textContent).toContain("b@d");
    // 请求体 = 粘贴原文（字段映射/解析全在后端）
    expect(String(JSON.stringify(state.previewBody))).toContain("爱丽丝");
  });

  it("排除勾选联动计数；初始密码 <8 位不发 commit；补齐后勾选真变 skip、管理员勾选真随请求带出", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    await toStep2();
    fireEvent.click(screen.getByTestId("uiw-skip-4"));
    await waitFor(() =>
      expect(screen.getByTestId("uiw-counts").textContent).toContain("可建 2 · 不建 2（冲突 1 · 手动排除 1）"));
    // 密码没填够 → 不发请求（后端 422 的镜像防线）
    fireEvent.click(screen.getByTestId("uiw-commit"));
    expect(state.commitBody).toBeUndefined();
    fireEvent.change(screen.getByTestId("uiw-password"), { target: { value: "Import@123" } });
    fireEvent.click(screen.getByTestId("uiw-admin"));
    fireEvent.click(screen.getByTestId("uiw-commit"));
    await waitFor(() => expect(state.commitBody).toBeDefined());
    const body = state.commitBody as {
      initial_password: string; is_system_admin: boolean;
      items: Array<{ line: number; strategy: string }>;
    };
    expect(body.initial_password).toBe("Import@123");
    expect(body.is_system_admin).toBe(true); // 「导入为平台管理员」不是假门
    const byLine = Object.fromEntries(body.items.map((i) => [i.line, i.strategy]));
    expect(byLine["5"]).toBe("skip"); // 冲突恒 skip
    expect(byLine["4"]).toBe("skip"); // 勾了排除 = skip
    expect(byLine["2"]).toBe("create");
  });

  it("第③步回执：成 n 跳 n 失败 n + 逐条行号原因 + 报告下载可用；回调刷列表", async () => {
    const state: MockState = {};
    mockBackend(state);
    const onImported = renderWizard();
    await toStep2();
    fireEvent.change(screen.getByTestId("uiw-password"), { target: { value: "Import@123" } });
    fireEvent.click(screen.getByTestId("uiw-commit"));
    const receipt = await screen.findByTestId("uiw-receipt");
    expect(receipt.textContent).toContain("成功 2 · 跳过 2 · 失败 1");
    // 部分成功的账逐条可追溯：失败与跳过各带行号与人话原因
    const report = screen.getByTestId("uiw-report");
    expect(report.textContent).toContain("第 9 行 zed");
    expect(report.textContent).toContain("第 5 行 admin：账号已存在");
    expect(report.textContent).toContain("第 4 行 carol：已勾选本次不导入");
    expect(onImported).toHaveBeenCalled();
    expect((screen.getByTestId("uiw-download") as HTMLButtonElement).disabled).toBe(false);
  });
});

// §11.4.22 选文件入口（还 T4 同款欠账）：FileTextPicker 真读 CSV 灌进 uiw-text，
// 后续解析/预览/提交流水原样复用；上限对齐后端 UserImportPreviewIn.text 的 2_000_000。
describe("用户导入选文件入口", () => {
  function pickFile(file: File) {
    fireEvent.change(screen.getByTestId("uiw-file-input"), { target: { files: [file] } });
  }

  it("选 CSV：覆盖已粘文本并进入 preview 请求体；覆盖行为写在按钮旁边", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    expect(screen.getByTestId("uiw-file-hint").textContent)
      .toContain("选文件会覆盖当前文本框内容（上限 2000000 字符，与后端一致）");
    fireEvent.change(screen.getByTestId("uiw-text"), { target: { value: "旧文本" } });
    pickFile(new File(["账号,姓名\nalice,爱丽丝\n"], "users.csv", { type: "text/csv" }));
    await waitFor(() =>
      expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).toContain("爱丽丝"));
    expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).not.toContain("旧文本");
    fireEvent.click(screen.getByTestId("uiw-parse"));
    await waitFor(() => expect(state.previewBody).toBeDefined());
    expect(String(JSON.stringify(state.previewBody))).toContain("爱丽丝");
  });

  it("超过后端 2_000_000 字符上限：明确提示拒读，文本框一行没动", async () => {
    const state: MockState = {};
    mockBackend(state);
    renderWizard();
    fireEvent.change(screen.getByTestId("uiw-text"), { target: { value: "别弄丢我" } });
    pickFile(new File(["a".repeat(2_000_001)], "huge.csv", { type: "text/csv" }));
    await waitFor(() => expect(document.body.textContent).toContain("超过后端上限 2000000"));
    expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).toBe("别弄丢我");
  });

  it("空文件：一句人话提示，不静默灌空", async () => {
    renderWizard();
    pickFile(new File([""], "empty.csv", { type: "text/csv" }));
    await waitFor(() => expect(document.body.textContent).toContain("是空文件"));
    expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).toBe("");
  });
});

// §页脚三态（第五套差集还账，UserImportWizard.tsx:92-102）：footer 严格按 step 派生——
// 第①步只有「解析」、第②步「上一步 + 导入」、第③步「下载 + 关闭」，各步其余钮必须不在 DOM；
// 「上一步」只回退、绝不关窗（handler 接错线 = 一点上一步整个弹窗就关了）；
// 「关闭」= onClose 恰好一次 + 内部状态真 reset：重开必须落回第①步空表源页，
// 而不是停在陈旧的第③步回执（handler 里 reset() 被摘掉 = 第二次打开看到上一次的回执）。
describe("向导页脚随步态派生", () => {
  function renderWizardWithClose() {
    const onClose = vi.fn();
    render(<UserImportWizard open onClose={onClose} onImported={vi.fn()} />);
    return { onClose };
  }
  /** open 由父组件持有的挂具：uiw-close → onClose → 关窗；[harness-open] 重开。 */
  function ReopenHarness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button data-testid="harness-open" onClick={() => setOpen(true)}>重新打开</button>
        <UserImportWizard
          open={open}
          onClose={() => { onClose(); setOpen(false); }}
          onImported={() => undefined}
        />
      </>
    );
  }
  /** 一路推到第③步（回执上屏）。 */
  async function toStep3() {
    await toStep2();
    fireEvent.change(screen.getByTestId("uiw-password"), { target: { value: "Import@123" } });
    fireEvent.click(screen.getByTestId("uiw-commit"));
    await screen.findByTestId("uiw-receipt");
  }

  it("第①步页脚只有「解析」：uiw-parse 在，uiw-close 与 uiw-back 都不在 DOM（页脚确由 step 派生，不是常驻）", () => {
    renderWizard();
    expect(screen.getByTestId("uiw-parse")).not.toBeNull();
    expect(screen.queryByTestId("uiw-close")).toBeNull();
    expect(screen.queryByTestId("uiw-back")).toBeNull();
    expect(screen.queryByTestId("uiw-commit")).toBeNull();
    expect(screen.queryByTestId("uiw-download")).toBeNull();
  });

  it("第②步页脚「上一步 + 导入」：uiw-back/uiw-commit 在，uiw-close/uiw-parse/uiw-download 都不在", async () => {
    mockBackend({});
    renderWizard();
    await toStep2();
    expect(screen.getByTestId("uiw-back")).not.toBeNull();
    expect(screen.getByTestId("uiw-commit")).not.toBeNull();
    expect(screen.queryByTestId("uiw-close")).toBeNull();
    expect(screen.queryByTestId("uiw-parse")).toBeNull();
    expect(screen.queryByTestId("uiw-download")).toBeNull();
  });

  it("第③步页脚「下载错误报告 + 关闭」：uiw-download/uiw-close 在，uiw-back/uiw-commit/uiw-parse 都不在", async () => {
    mockBackend({});
    renderWizard();
    await toStep3();
    expect(screen.getByTestId("uiw-close")).not.toBeNull();
    expect(screen.getByTestId("uiw-download")).not.toBeNull();
    expect(screen.queryByTestId("uiw-back")).toBeNull();
    expect(screen.queryByTestId("uiw-commit")).toBeNull();
    expect(screen.queryByTestId("uiw-parse")).toBeNull();
  });

  it("点「上一步」(uiw-back)：回第①步解析页脚、粘贴原文还在，且绝不触发 onClose（handler 接线错位=弹窗被误关）", async () => {
    mockBackend({});
    const { onClose } = renderWizardWithClose();
    await toStep2();
    fireEvent.click(screen.getByTestId("uiw-back"));
    // 页脚回到第①步那一档
    expect(screen.getByTestId("uiw-parse")).not.toBeNull();
    expect(screen.queryByTestId("uiw-back")).toBeNull();
    expect(screen.queryByTestId("uiw-commit")).toBeNull();
    // 第②步主体随步卸载，源文（含预览期不显示的原文）原样保住——回退不是 reset
    expect(screen.queryByTestId("uiw-counts")).toBeNull();
    expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).toContain("爱丽丝");
    // 上一步不是关闭：父组件的 onClose 一次都不许动
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点「关闭」(uiw-close)：onClose 恰好一次 + 状态真 reset——重开落回第①步源页，不是陈旧第③步回执", async () => {
    mockBackend({});
    const onClose = vi.fn();
    render(<ReopenHarness onClose={onClose} />);
    await toStep3();
    fireEvent.click(screen.getByTestId("uiw-close"));
    // 一次点击 = 父组件恰好收到一次 onClose（多叫一次 = 双触发）
    expect(onClose).toHaveBeenCalledTimes(1);
    // onClose 里父组件已置 open=false；重开 → 必须是一张全新的第①步源页
    fireEvent.click(screen.getByTestId("harness-open"));
    expect(screen.getByTestId("uiw-parse")).not.toBeNull();
    expect(screen.queryByTestId("uiw-close")).toBeNull();
    expect(screen.queryByTestId("uiw-back")).toBeNull();
    // reset() 被摘掉的 mutant：重开仍停在第③步——回执与旧粘贴原文都会在这里现形
    expect(screen.queryByTestId("uiw-receipt")).toBeNull();
    expect((screen.getByTestId("uiw-text") as HTMLTextAreaElement).value).toBe("");
  });
});
