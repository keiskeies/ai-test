// 调试面板的断言徽标只钉一件事：它报的是「真校验了几条」。
// D78 给了逐条启用开关后，「一条都没校验」和「全过了」在 result.passed 这个布尔上
// 长得一模一样（后端 all([]) === true），所以这里刻意用 passed:true + assertions:[]
// 的形状来钉——这是停用全部断言时后端真实回的形状，不是臆造。
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import DebugPanel from "./DebugPanel";
import type { DebugResult } from "./DebugPanel";

const base = {
  run_id: "r1", ok: true, status: 200, headers: {}, body_text: "{}", truncated: false,
  body_size: 2, elapsed_ms: 12, error: null, env_name: "本地",
} as const;

const res = (x: Partial<DebugResult>): DebugResult => ({ ...base, assertions: [], ...x } as DebugResult);

beforeEach(() => cleanup());

describe("DebugPanel 断言徽标（D78 后不能把「没校验」演成「全过」）", () => {
  it("零结果行 + passed:true → 「未校验」，绝不出现绿色「断言全过」", () => {
    render(<DebugPanel result={res({ passed: true, assertions: [] })} />);
    expect(screen.getByTestId("debug-assert-none").textContent).toContain("未校验");
    expect(screen.queryByText("断言全过（1 条）")).toBeNull();
    expect(screen.queryByText(/断言全过/), "零条断言不许报全过").toBeNull();
    // 默认 assertionsKnown=true：调试页的零行是「真没跑断言」，不许溜进档案面的分支
    //（变异靶：DebugPanel 的 assertionsKnown 默认值翻 false，这一句红）。
    expect(screen.queryByTestId("debug-assert-unknown")).toBeNull();
  });

  it("档案面（assertionsKnown=false）零行 → 「断言明细在步骤里」，不再断言「未校验/没执行任何断言」", async () => {
    // 运行记录抽屉的场景/UI/ADB 运行：断言行按设计不落 run 记录（只在步骤明细里），
    // 零行 = 面板没拿到行，不是「没执行断言」。同一条 Tooltip 话术两边不许共用。
    render(<DebugPanel result={res({ passed: false, assertions: [] })} assertionsKnown={false} />);
    expect(screen.getByTestId("debug-assert-unknown").textContent).toContain("断言明细在步骤里");
    expect(screen.queryByTestId("debug-assert-none")).toBeNull();
    expect(screen.queryByText(/断言全过/)).toBeNull();
    // Tooltip 要 hover 才挂（api.test.tsx:677 手法）：这句假话的残留只能在这里测得到
    fireEvent.mouseEnter(screen.getByTestId("debug-assert-unknown"));
    expect(await screen.findByText("这条运行记录不携带断言结果行：场景/UI/ADB 运行的逐条断言落在各步骤明细里（报告详情右栏可看）。这里既不说「校验了几条」，也不说「没执行任何断言」。")).not.toBeNull();
  });

  it("有结果行且全过 → 仍是绿色「断言全过」（e2e 与演示手册按这四个字认）", () => {
    render(<DebugPanel result={res({
      passed: true,
      assertions: [{ type: "status_code", expected: 200, passed: true }],
    })} />);
    expect(screen.getByTestId("debug-assert-pass").textContent).toBe("断言全过");
    expect(screen.queryByTestId("debug-assert-none")).toBeNull();
  });

  it("有失败行 → 「有断言失败」；请求本身失败时不评断言", () => {
    const { unmount } = render(<DebugPanel result={res({
      passed: false,
      assertions: [{ type: "body_contains", expected: "tk", passed: false }],
    })} />);
    expect(screen.getByTestId("debug-assert-fail").textContent).toContain("有断言失败");
    unmount();
    render(<DebugPanel result={res({ ok: false, passed: false, status: null, error: "连接超时" })} />);
    expect(screen.queryByTestId("debug-assert-none"), "请求都没成功，谈不上校验没校验").toBeNull();
    expect(screen.queryByTestId("debug-assert-pass")).toBeNull();
  });

  // 断言卡的 path / error 两个**可选**渲染分支（DebugPanel.tsx:140 / :147）。
  // 为什么只在 API 域钉：`shared/assertions.py:44-50 _row` 只在 `a["path"]` 非空时才挂 path 键，
  // 且 `:62/:66/:79/:84/:88/:99/:105` 会把「响应不是合法 JSON」「路径不存在: x」「正则写法不合法：…」
  // 这类人话当 error 传进来——**这两键在 API 域生产可达**。
  // 反过来 ADB/UI 核六处 + 三处 `_row` 的 error 实参全是 None（`adb_core.py:441/452/462/477/550/557`、
  // `ui_core.py:495/511/522`），所以那两个域的 fixture **不许**造 error，造了就是钉假形状。
  it("API 断言行带 path/error → 路径代码块与错误原话都上屏（一个都不静默吞）", () => {
    render(<DebugPanel result={res({
      passed: false,
      assertions: [{
        type: "json_path_equals", path: "$.data.token", passed: false,
        expected: "ok", actual: null, error: "路径不存在: $.data.token",
      }],
    })} />);
    const card = screen.getByTestId("assertion-card");
    expect(card.textContent).toContain("json_path_equals");
    expect(card.textContent).toContain("路径不存在: $.data.token"); // :147 error 分支
    const code = card.querySelector("code");
    expect(code).not.toBeNull(); // :140 的 path 走的是 <Typography.Text code>
    expect(code?.textContent).toBe("$.data.token");
    expect(card.textContent).toContain('期望 "ok"');
    expect(card.textContent).toContain("实际 null"); // actual 键在且为 null → 仍画（"actual" in a）
  });

  it("断言行不带 path 键 → 不画空 code；不带 error 键 → 不画空红字（可选键不是必填）", () => {
    // passed:true 是刻意选的：passed:false 时「实际」那段本身就是 danger 色
    // （DebugPanel.tsx:143 的 `type={a.passed ? "secondary" : "danger"}`），
    // danger 计数就分不清是「实际」还是多出来的 error 空段了。
    const { unmount } = render(<DebugPanel result={res({
      passed: true,
      assertions: [{ type: "status_code", passed: true, expected: 200, actual: 200 }],
    })} />);
    const card = screen.getByTestId("assertion-card");
    expect(card.querySelector("code")).toBeNull();
    // error 缺席时那段的守卫是 `typeof a.error === "string" && a.error`。**不能只断 textContent
    // 不含 undefined/null**：`{undefined}` 摘掉守卫后照样渲染成空，变异存活过一次（M5）。
    // 所以钉的是**那个红字节点本身**——守卫在，一个 danger 文案节点都不该存在。
    expect(card.querySelectorAll(".ant-typography-danger")).toHaveLength(0);
    // 这个 class 选择器不能是**恒零断言**，否则上面那句等于没断。所以紧接着换个 passed:false
    // 的形状自证它能数到东西——那时「实际」段本身就是 danger 色（DebugPanel.tsx:143
    // 的 `type={a.passed ? "secondary" : "danger"}`），选择器必须数得出 > 0。
    unmount();
    render(<DebugPanel result={res({
      passed: false,
      assertions: [{ type: "status_code", passed: false, expected: 200, actual: 500 }],
    })} />);
    const danger = screen.getByTestId("assertion-card"); // unmount 后旧的 card 是脱离文档的节点，必须重新取
    expect(danger.querySelectorAll(".ant-typography-danger").length).toBeGreaterThan(0);
    expect(danger.textContent).toContain('期望 200');
    expect(danger.textContent).toContain("实际 500");
  });

  // 响应体截断标注（DebugPanel.tsx:156 的 `result.truncated ? "（已截断）" : ""`）。
  // 后端 execution/core.py:17 `MAX_BODY_CHARS = 1_000_000`，同文件 `truncated = len(text) > MAX_BODY_CHARS`
  //（现 109）超量才置 truncated，
  // 所以「响应体」三个字在真机上是**两种**文案。此前全仓 4 处 fixture 一律 false
  //（本文件 :12、.pilot.test.tsx:21、api.test.tsx:767、debugPilot.test.ts:16），
  // 「（已截断）」在门禁⑥里从没画过——把它摘掉不会有任何测试变红，
  // 而用户看到的是一段尾部被静默切掉的 JSON 却标着完整的「响应体」。
  it("truncated=true → 折叠标题写「响应体（已截断）」；false 时只有「响应体」", () => {
    const { unmount } = render(<DebugPanel result={res({
      truncated: true, body_size: 1_200_000,
      body_text: '{"a":"' + "x".repeat(64) + '"}',
    })} />);
    expect(screen.getByText("响应体（已截断）")).not.toBeNull();
    expect(screen.queryByText("响应体")).toBeNull(); // 不许两个标题同时在屏上
    unmount();
    render(<DebugPanel result={res({ body_text: '{"a":1}' })} />);
    expect(screen.getByText("响应体").textContent).toBe("响应体");
  });

  it("actual 键整个缺席 → 「实际」整段不渲染（判据是 in，不是 ?? null）", () => {
    render(<DebugPanel result={res({
      passed: false,
      assertions: [{ type: "json_path_equals", path: "$.a", passed: false, expected: 1,
        error: "响应不是合法 JSON，无法按 jsonpath 断言" }],
    })} />);
    const card = screen.getByTestId("assertion-card");
    expect(card.textContent).not.toContain("实际"); // 没测出来就不谎称测出来了
    expect(card.textContent).toContain("响应不是合法 JSON，无法按 jsonpath 断言");
    expect(card.querySelector("code")?.textContent).toBe("$.a");
  });
});
