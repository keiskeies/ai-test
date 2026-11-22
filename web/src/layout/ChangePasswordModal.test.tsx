// ChangePasswordModal（D105 自助改密弹窗）的组件侧单测。此前 vitest 侧只有 shell.test.tsx
// 经头像菜单入口顺带渲染过它，**没有任何测试 import 这个文件**——audit-test-debt.mjs 轴②
// 的正命中（有 `export default`、没人把默认导出接走）。本文件把弹窗自己的四条契约钉死，
// 网络边界收在 ../api/client 的 post 上（vi.mock），不碰真 fetch：
//   ① 校验拦在网络上游：空表 / 新密码 7 位 / 确认位不一致 → POST 一条都不发，红字贴在
//      字段旁。min:8 是后端 PasswordChangeIn.new_password min_length=8（schemas.py:63）的
//      镜像，边界逐字钉 7 与 8 两侧——前端规则只能是后端规则的镜像，不许自创；
//   ② validateFields 的 reject 必须在 ChangePasswordModal.tsx:25-29 就地吞掉：漏出去就是
//      unhandled rejection（f9de141 之前仓库里就是那个坏版本）。这里用 process 监听**收集**
//      并断言为空，不是拿监听器把 rejection 藏起来让测试变绿；
//   ③ 成功：POST /auth/password，body 恰好 {old_password,new_password}（确认位不许漏进
//      载荷）→ message.success「密码已修改」→ 字段清空 → onClose 被调；
//   ④ 失败（post reject）：onClose **不**被调、三个字段保持用户输入原样——文件头第 37-38 行
//      写明的策略（旧密打错就地重填，不必重开弹窗），不是 bug，别顺手「修」掉。
// 【不证明什么】
//   · 失败时的 toast 不归本组件：那是 client.ts 的默认 message.error 吃后端中文信封，
//     本文件把 post 整个 mock 掉（reject 的是我给的 Error），所以**不**断言失败 toast；
//     那条链（403 bad_credentials → 「旧密码不正确」上屏、code 不上屏）由 fetch 桩路径的
//     api/client.test.ts 与 shell.test.tsx:149-163 钉。
//   · 「确认后弹窗真的从 DOM 消失」要父组件把 open 翻回 false——本文件的父组件刻意不翻
//     （否则 destroyOnHidden 立刻卸载内容，resetFields 的空字段就没得读了），
//     真关窗那条由 shell.test.tsx:146 钉。
//   · 真 HTTP 语义（Authorization 头、401→refresh、信封解析）都在 client.ts 里，与本题无关。
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// API client 在模块边界换桩：成功/失败由每个用例逐次给（mockRejectedValueOnce 之类），
// 所以不必搓 fetch 的 Response 信封，也不必 setToken。
const api = vi.hoisted(() => ({ post: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })) }));
vi.mock("../api/client", () => ({ post: api.post }));

import ChangePasswordModal from "./ChangePasswordModal";

/** 父组件只记录 onClose、**不**把 open 翻回 false：弹窗留在 DOM 里才读得到 resetFields
 *  之后的字段值（真关窗那条归 shell.test.tsx，见文件头）。motion:false 同 shell.test.tsx:40-45：
 *  rc-motion 的 leave 动画在 jsdom 里不完成，destroyOnHidden 的节点会永远赖在 DOM。 */
function renderModal() {
  const onClose = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ChangePasswordModal open onClose={onClose} />
    </ConfigProvider>,
  );
  return onClose;
}

async function fill(oldPw: string, newPw: string, confirm: string): Promise<void> {
  fireEvent.change(screen.getByTestId("pwd-field-old"), { target: { value: oldPw } });
  fireEvent.change(screen.getByTestId("pwd-field-new"), { target: { value: newPw } });
  fireEvent.change(screen.getByTestId("pwd-field-confirm"), { target: { value: confirm } });
}

function fieldValue(testid: string): string {
  return (screen.getByTestId(testid) as HTMLInputElement).value;
}

async function clickOk(): Promise<void> {
  fireEvent.click(await screen.findByTestId("pwd-change-ok", {}, { timeout: 2000 }));
}

/** success toast 走 spy 而不是读 .ant-message 的 DOM：antd 静态 message 挂在自建
 *  document fragment 上，跨用例残留（上一条用例的「密码已修改」会漂进下一条的 not.toContain，
 *  message.destroy 也清不干净）。spy 钉的是「这条用例里组件调没调 success」，正是我们要的口径。 */
let successSpy: MockInstance<typeof message.success>;

/** 钉「校验不过就地返回」：把漏出的 rejection **收集**起来断言为空。
 *  监听 process 而不是 window：vitest 的 node 运行时里未处理 rejection 落在 process 上，
 *  且 vitest 自带的监听器只看「有没有别的监听器」（>1 就不上报）——自己加一个既是收集，
 *  也是把自己摆在默认报错路径之外，好让下面那句 throw 说出人话。 */
async function expectNoUnhandledRejection(fn: () => Promise<void> | void): Promise<void> {
  const seen: unknown[] = [];
  const collect = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", collect);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 0)); // 给 rejection 到达 process 的时间
  } finally {
    process.off("unhandledRejection", collect);
  }
  if (seen.length > 0) {
    throw new Error("validateFields 的 reject 没在 submit 里就地吞掉，漏成了未处理 rejection："
      + seen.map((e) => String(e)).join("; "));
  }
}

beforeEach(() => {
  cleanup();
  message.destroy();
  successSpy = vi.spyOn(message, "success");
  api.post.mockReset();
  api.post.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("① 校验拦在网络上游（一条 POST 都不许发）", () => {
  it("空表点[确认修改]：三条字段级红字，post 零调用，且不漏 unhandled rejection", async () => {
    const onClose = renderModal();
    await screen.findByTestId("pwd-change-modal");
    await expectNoUnhandledRejection(async () => {
      await clickOk();
    });
    expect(await screen.findByText("请输入旧密码", {}, { timeout: 2000 })).not.toBeNull();
    expect(await screen.findByText("至少 8 位", {}, { timeout: 2000 })).not.toBeNull();
    expect(await screen.findByText("请再次输入新密码", {}, { timeout: 2000 })).not.toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // 红字留在原地改，窗不许关
  });

  it("新密码 7 位 → 「至少 8 位」且 post 零调用（后端 min_length=8 的下边界）", async () => {
    const onClose = renderModal();
    await screen.findByTestId("pwd-change-modal");
    await fill("OldPass@9", "Abc1234", "Abc1234"); // 7 位
    await expectNoUnhandledRejection(async () => {
      await clickOk();
    });
    expect(await screen.findByText("至少 8 位", {}, { timeout: 2000 })).not.toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("新密码刚好 8 位 → 校验放行，POST 真的发出去（边界另一侧，谁把 min 改成 9 这条先红）", async () => {
    renderModal();
    await screen.findByTestId("pwd-change-modal");
    await fill("OldPass@9", "Abc12345", "Abc12345"); // 8 位
    await clickOk();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(screen.queryByText("至少 8 位")).toBeNull();
  });

  it("两次新密码不一致 → 「两次输入的新密码不一致」，post 零调用，弹窗不关", async () => {
    const onClose = renderModal();
    await screen.findByTestId("pwd-change-modal");
    await fill("OldPass@9", "FreshPass@9", "FreshPass@0");
    await expectNoUnhandledRejection(async () => {
      await clickOk();
    });
    expect(await screen.findByText("两次输入的新密码不一致", {}, { timeout: 2000 })).not.toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("③ 成功路径", () => {
  it("POST /auth/password 的 body 恰好 {old_password,new_password}（确认位不上送）→ toast + 字段清空 + onClose", async () => {
    const onClose = renderModal();
    await screen.findByTestId("pwd-change-modal");
    await fill("OldPass@9", "FreshPass@9", "FreshPass@9");
    await clickOk();

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // 逐字对照后端 PasswordChangeIn：路径 + 载荷两件套，多余的 confirm 混进来就红
    expect(api.post).toHaveBeenCalledWith("/auth/password", {
      old_password: "OldPass@9", new_password: "FreshPass@9",
    });
    expect(Object.keys(api.post.mock.calls[0][1] as Record<string, unknown>).sort())
      .toEqual(["new_password", "old_password"]);

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("密码已修改"), { timeout: 2000 });
    // resetFields 真的跑过：三个字段回到空（不许把旧明文留在弹窗里等下次打开）
    expect(fieldValue("pwd-field-old")).toBe("");
    expect(fieldValue("pwd-field-new")).toBe("");
    expect(fieldValue("pwd-field-confirm")).toBe("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("④ 失败路径（文件头写明的「不关窗可重试」，不是 bug）", () => {
  it("post reject → onClose 不被调、三个字段保持用户输入原样、不报假成功", async () => {
    api.post.mockRejectedValueOnce(new Error("旧密码不正确"));
    const onClose = renderModal();
    await screen.findByTestId("pwd-change-modal");
    await fill("WrongPass@9", "FreshPass@9", "FreshPass@9");
    await expectNoUnhandledRejection(async () => {
      await clickOk(); // reject 由组件的 catch 接住，不该漏到 process
    });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onClose).not.toHaveBeenCalled();
    expect(fieldValue("pwd-field-old")).toBe("WrongPass@9");
    expect(fieldValue("pwd-field-new")).toBe("FreshPass@9");
    expect(fieldValue("pwd-field-confirm")).toBe("FreshPass@9");
    expect(successSpy).not.toHaveBeenCalled(); // 失败不许报成功

    // 就地重试：字段没被清，再点一次就带着同一份输入再发
    await clickOk();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(api.post.mock.calls[1][1]).toEqual({ old_password: "WrongPass@9", new_password: "FreshPass@9" });
  });
});
