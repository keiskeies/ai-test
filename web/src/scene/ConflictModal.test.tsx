// ConflictModal（Review Focus 5，§11.4.9 乐观锁冲突差异弹窗）的组件测试。此前覆盖零：
// 它的 6 个 data-testid 只被 web/e2e/sceneCanvas.spec.mjs 的双页对撞摸过（真 409 全链路、
// 慢，且只断言「弹窗出现/消失 + toContainText」），vitest 侧一条都没有。这里钉的是
// e2e 给不出的窄口径（全程真实 store，不 spy store 动作，断言点完之后的可见世界）：
//   ① conflict=null 时整个组件不渲染——连 .ant-modal 外壳都不存在，不只是内容为空；
//   ② 警示条把 serverVersion 逐字插进「服务器版本 v7…」；两栏 <pre> 钉全文
//      （textContent 逐字相等 + 多行还在 + 互不含对方特征串）——将来谁加 slice/
//      省略号/截断，先在这里红，而不是等用户对着半截 JSON 猜；
//   ③ [用服务器] 走真实 takeServer：树/环境/变量/失败策略/超时整套回退到服务器快照、
//      baseline 对齐（dirty 熄灭）、scenario.version 跟进服务器版本、conflict 清空、
//      零网络（纯本地回退）——不是「弹窗没了」了事；
//   ④ [用我的] 的知情覆盖契约：真 forceSaveWithVersion 一路打到 sceneApi.update 的
//      请求体 version 必须 = conflict.serverVersion(7)，不是本地 scenario.version(3)；
//      钮本身 danger+primary（破坏性动作不许长得像默认钮，另两钮不是 primary 作对照）；
//      saving=true 时钮挂 loading；后端再拒时 conflict 不清、弹窗不关、不抛错，
//      **且组件自身在弹窗内按因交代「覆盖没有生效」**（见 ⑦）；
//   ⑤ [复制我的到剪贴板]：writeText 收到 mine 全文（逐字）后弹窗关、谁也不动；
//      writeText 拒绝（无权限）时 store.copyMine 吞异常照常关窗、不炸
//      （store.ts:784-789 的故意口径，这里给它上锁）；
//   ⑥ 点 X = 暂时不裁决：conflict 清空，但 nodes/baseline/version/envId 逐字不动，
//      dirty 事实留着（再保存会再撞 409 再弹），也不是复制（writeText 零调用）；
//   ⑦ [用我的] 被拒的交代（H3）：422 validation_error / 真 ApiErr(403) / 其余（500 与非
//      ApiErr 兜底）三因各一句「没有生效」人话进 conflict-override-failed——三因各腿
//      各钉 store catch 的一个分因分支；「权限」句只许出现在真 403，未知因不许说没权限；
//      再点一次先清旧因（在途请求面前不许挂着上一轮的因）；成功无失败句（负对照）；
//      再撞 409 走 conflict 刷新（服务器新内容顶上来、不出错误句——裁决路径不设静态墙）。
// jsdom 垫片收在本文件内（Canvas.test.tsx 头注释同款理由：仓库刻意不建共享 setup）：
//   matchMedia——antd 响应式断点用，jsdom 没实现；
//   navigator.clipboard——jsdom 不实现剪贴板，copyMine 要 writeText，桩同时用来钉
//     「写进去的到底是哪份内容」。
// 【不证明】：rc-dialog 动画时长/遮罩点击（maskClosable 没开）、真实剪贴板权限弹窗、
// 双浏览器页真 409 对撞全链路（e2e/sceneCanvas.spec.mjs 的地盘）、Modal 的 a11y 焦点圈。
// 【FINDING（已修，H3）】旧版按现状钉「失败 = 弹窗保持打开、**组件自身**零反馈」，不给
// 「有反馈」背书——那正是缺陷本身：全局 toast 会响（见下段更正）但一闪就没，红钮在失败
// 之后原地不动，等于弹窗继续说「还没按」。现在 forceSaveWithVersion 的 catch 把被拒的因
// 记进 overrideFailed（validation/denied/error；再撞 409 按 save() 的故意走 conflict
// 刷新，不进这个槽），弹窗按因渲染错误句，且下一轮尝试开始/takeServer/clearConflict 清槽。
// 腿在 ⑦；「权限」句与三因的对应由 store 的分因分支 + 组件的 FAILED_COPY 两处各钉一次。
// 【对本文件上一版 FINDING 措辞的更正】它原来写「零 message」，**那句是错的，错在测试
// 自己的桩**：本文件把 `sceneApi.update` 整段 mock 掉了，而默认 toast 在更下一层
// （`api/client.ts:99` `if (!opts.silent) message.error(...)`），`sceneApi.update`
// 走 `patch` 且**没传 silent**（`api/scene.ts:90`）——所以真跑一次的话用户**会**看到一条
// 客户端兜底红条。「弹窗原地不动」是真的，「什么都不显示」不是。教训：**在 API 边界打桩
// 会把该层的副作用一起抹掉**，据此断言「没有提示」等于在测自己的桩。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";

// —— jsdom 垫片（理由见文件头，Canvas.test.tsx 同款）——
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ConflictModal from "./ConflictModal";
import type { ConflictState } from "./store";
import { selectDirty, useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";
import { sceneApi } from "../api/scene";
import { ApiErr } from "../api/client";

// scenario 手写镜像同 store.saveAssertions.test.ts：只给组件链路上用得上的字段。
type ScenarioOut = Awaited<ReturnType<typeof sceneApi.update>>;
const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
} as unknown as ScenarioOut;

/** 冲突现场：我的（未保存）与服务器各一棵树，pretty JSON 全文进 <pre>。 */
const MINE_NODES: StepNode[] = [{ key: "n1", kind: "sleep", name: "我的等待", config: { ms: 100 } }];
const SERVER_NODES: StepNode[] = [{ key: "n1", kind: "sleep", name: "服务器的等待", config: { ms: 300 } }];
const MINE = JSON.stringify({ version: 1, nodes: MINE_NODES, layout: {} }, null, 2);
const SERVER = JSON.stringify({ version: 1, nodes: SERVER_NODES, layout: {} }, null, 2);

function conflictState(): ConflictState {
  return {
    mine: MINE, server: SERVER, serverVersion: 7,
    serverNodes: SERVER_NODES, serverLayout: {},
    serverEnvId: "e9",
    serverVariables: { v: "from-server" },
    serverFailFast: false,
    serverMaxRuntimeMs: 9000,
    serverCommonAssertions: [],
  };
}

/** 灌 store：nodes 刻意偏离 baseline（dirty=true——冲突现场本来就是「有未保存改动」）。 */
function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    loading: false, scenario: SCEN, projectId: "p1", scenarioId: "s1",
    nodes: MINE_NODES, baselineNodes: "[]",
    layout: {}, envId: null, baselineEnvId: null,
    variables: {}, baselineVariables: "{}",
    failFast: true, baselineFailFast: true,
    maxRuntimeMs: null, baselineMaxRuntimeMs: null,
    commonAssertions: [], baselineCommonAssertions: "[]",
    serverIssues: [], conflict: null, overrideFailed: null, refused: false, saving: false,
    collapsed: [], selectedKey: null, selectedKeys: [],
    revision: 0, readOnly: false,
    ...over,
  } as never);
}

function renderModal(over: Record<string, unknown> = {}): void {
  seed(over);
  // motion:false 同 Canvas/ListMode：rc-motion 的 leave 动画在 jsdom 里不完成
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ConflictModal />
    </ConfigProvider>,
  );
}

const writeText = vi.fn();

beforeEach(() => {
  // 剪贴板桩：jsdom 不实现 navigator.clipboard（Canvas.test 同款「垫片留在本文件」口径）
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  global.fetch = vi.fn(async () => {
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ConflictModal（Review Focus 5，真 store + 真 store 动作）", () => {
  it("conflict=null：整个组件不渲染（Modal 外壳都不存在，且零网络）", async () => {
    renderModal();
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
    expect(document.querySelector(".ant-modal")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("警示条逐字插 serverVersion；两栏 <pre> 逐字全文（多行、不截断、不串栏）", async () => {
    renderModal({ conflict: conflictState() });
    await screen.findByTestId("scene-conflict-modal");
    expect(document.querySelector(".ant-alert-message")!.textContent)
      .toBe("服务器版本 v7（你的编辑基于更早的版本）。默认不覆盖他人。");
    const mine = screen.getByTestId("conflict-mine");
    const server = screen.getByTestId("conflict-server");
    // 全文逐字相等（不是 toContain）：谁将来加截断/省略号，这里先红
    expect(mine.textContent, "conflict-mine 栏必须是 conflict.mine 全文（不许截断）").toBe(MINE);
    expect(server.textContent, "conflict-server 栏必须是 conflict.server 全文（不许截断）").toBe(SERVER);
    expect(mine.textContent!.split("\n").length).toBeGreaterThan(3); // 多行全文确实在
    // 并排两栏不许互换内容
    expect(mine.textContent).not.toContain("服务器的等待");
    expect(server.textContent).not.toContain("我的等待");
  });

  it("[用服务器]：真实 takeServer 整套回退到服务器快照，baseline 对齐 dirty 熄灭，零网络", async () => {
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-server"));
    const s = useSceneStore.getState();
    expect(s.nodes).toEqual(SERVER_NODES);
    expect(s.baselineNodes).toBe(JSON.stringify(SERVER_NODES));
    expect(selectDirty(s)).toBe(false); // 丢弃我的改动后不该再亮「未保存」
    expect(s.envId).toBe("e9");
    expect(s.baselineEnvId).toBe("e9");
    expect(s.variables).toEqual({ v: "from-server" });
    expect(s.failFast).toBe(false);
    expect(s.maxRuntimeMs).toBe(9000);
    expect(s.scenario!.version).toBe(7); // 版本事实随服务器走
    expect(s.conflict).toBeNull();
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled(); // 纯本地回退，不发请求
  });

  it("[用我的]：请求体 version=服务器版本 7（不是本地 3）；钮 danger+primary；saving 挂 loading", async () => {
    const seenBodies: { version: number }[] = [];
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => {
      seenBodies.push(body as unknown as { version: number });
      return { ...SCEN, version: 8 } as never;
    });
    renderModal({ conflict: conflictState() });
    const mineBtn = await screen.findByTestId("conflict-use-mine");
    // 破坏性动作的视觉契约：红（danger）+ 主按钮（primary）；另两钮不是 primary 作对照
    expect(mineBtn.className).toContain("ant-btn-dangerous");
    expect(mineBtn.className).toContain("ant-btn-primary");
    expect(screen.getByTestId("conflict-use-server").className).not.toContain("ant-btn-primary");
    expect(screen.getByTestId("conflict-copy").className).not.toContain("ant-btn-primary");

    fireEvent.click(mineBtn);
    await waitFor(() => expect(useSceneStore.getState().conflict).toBeNull());
    // 知情覆盖的确切数字：带服务器版本 7 强推，而不是本地 scenario.version=3
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0].version).toBe(7);
    const s = useSceneStore.getState();
    expect(s.scenario!.version).toBe(8); // 服务器回显接管版本
    expect(s.baselineNodes).toBe(JSON.stringify(s.nodes));
    expect(selectDirty(s)).toBe(false); // 覆盖成功 = 我的改动成了新基线
    expect(s.saving).toBe(false);
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();

    // 失败腿（普通异常）：后端再拒 → conflict 不清、弹窗不关、不抛错（按现状钉死）。
    // 失败句的分因专属断言归 ⑦——这里不重复挂，保 ⑦「一因一腿一生产位」的可归因性。
    cleanup();
    vi.spyOn(sceneApi, "update").mockRejectedValue(new Error("update broke"));
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-mine"));
    await waitFor(() => expect(useSceneStore.getState().saving).toBe(false));
    expect(useSceneStore.getState().conflict).not.toBeNull();
    expect(screen.queryByTestId("scene-conflict-modal")).not.toBeNull();
    expect(useSceneStore.getState().nodes).toEqual(MINE_NODES); // 我的改动原样保留

    // loading 态：saving=true 时「用我的」挂转圈（三钮里只许它挂——它才是异步的那个）
    cleanup();
    renderModal({ conflict: conflictState(), saving: true });
    await screen.findByTestId("scene-conflict-modal");
    expect(screen.getByTestId("conflict-use-mine").querySelector(".anticon-loading")).not.toBeNull();
    expect(screen.getByTestId("conflict-use-server").querySelector(".anticon-loading")).toBeNull();
  });

  it("[复制我的到剪贴板]：writeText 收到 mine 全文（逐字）后关窗，谁也不动", async () => {
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-copy"));
    await waitFor(() => expect(useSceneStore.getState().conflict).toBeNull());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(MINE); // 复制的是「我的」全文，不是 server
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
    const s = useSceneStore.getState();
    expect(s.nodes).toEqual(MINE_NODES); // 谁也不动：树还是我的
    expect(s.scenario!.version).toBe(3); // 版本号也没被悄悄提前
  });

  it("无剪贴板权限（writeText 拒绝）：copyMine 吞异常照常关窗，不炸不遗留", async () => {
    writeText.mockRejectedValue(new Error("NotAllowedError"));
    const unhandled: unknown[] = [];
    const onRej = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    window.addEventListener("unhandledrejection", onRej);
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-copy"));
    // 拒绝被 store.copyMine 的 catch 吞掉（store.ts:784-789）：弹窗照常关
    await waitFor(() => expect(useSceneStore.getState().conflict).toBeNull());
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
    await waitFor(() => expect(unhandled).toEqual([])); // 没有漏出全局的拒绝
    window.removeEventListener("unhandledrejection", onRej);
  });

  it("点 X = 暂时不裁决：conflict 清空，但树/baseline/version/envId 逐字不动、dirty 还在", async () => {
    renderModal({ conflict: conflictState() });
    await screen.findByTestId("scene-conflict-modal");
    const nodesSnap = JSON.stringify(useSceneStore.getState().nodes);
    fireEvent.click(document.querySelector(".ant-modal-close") as HTMLElement);
    const s = useSceneStore.getState();
    expect(s.conflict).toBeNull();
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
    // 「不裁决」不许偷 discard 用户改动：树与 baseline 原样，dirty 事实留着（再保存再撞 409）
    expect(JSON.stringify(s.nodes)).toBe(nodesSnap);
    expect(s.baselineNodes).toBe("[]");
    expect(selectDirty(s)).toBe(true);
    expect(s.scenario!.version).toBe(3); // 版本不被提前同步（下一次保存还得裁决）
    expect(s.envId).toBe(null); // 服务器口径一项都不许渗进来
    expect(writeText).not.toHaveBeenCalled(); // X 也不是复制
  });

  // —— ⑦ [用我的] 被拒的交代（H3）：一因一句，各钉 store catch 的一个分因分支 +
  //    FAILED_COPY 的对应句；「权限」二字只许出现在真 403 那句里 ——
  it("[用我的] 被 422 校验拒：句说「校验拒了这份图」，conflict 原样，不许提权限", async () => {
    vi.spyOn(sceneApi, "update").mockRejectedValue(
      new ApiErr("validation_error", "图不合法", 422, { issues: [] }),
    );
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-mine"));
    await waitFor(() => expect(useSceneStore.getState().saving).toBe(false));
    expect(useSceneStore.getState().overrideFailed).toBe("validation");
    const fail = screen.getByTestId("conflict-override-failed");
    expect(fail.className).toContain("ant-alert-error"); // 错误句不许长得像顶部警示条
    expect(fail.textContent).toContain("没有生效");
    expect(fail.textContent).toContain("校验拒了");
    expect(fail.textContent).not.toContain("权限"); // 422 被拒 ≠ 没权限
    expect(useSceneStore.getState().conflict).not.toBeNull();
    expect(screen.queryByTestId("scene-conflict-modal")).not.toBeNull();
  });

  it("[用我的] 被真 403 拒：唯一一句权限话（403 逐字在场），conflict 原样", async () => {
    vi.spyOn(sceneApi, "update").mockRejectedValue(new ApiErr("forbidden", "无权限", 403));
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-mine"));
    await waitFor(() => expect(useSceneStore.getState().saving).toBe(false));
    expect(useSceneStore.getState().overrideFailed).toBe("denied");
    const fail = screen.getByTestId("conflict-override-failed");
    expect(fail.textContent).toContain("没有生效");
    expect(fail.textContent).toContain("权限");
    expect(fail.textContent).toContain("403");
    expect(useSceneStore.getState().conflict).not.toBeNull();
  });

  it("[用我的] 被 500 拒：只说「请求本身没成功」，把未知因说成没权限在这里就红", async () => {
    vi.spyOn(sceneApi, "update").mockRejectedValue(new ApiErr("internal_error", "500 炸了", 500));
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-mine"));
    await waitFor(() => expect(useSceneStore.getState().saving).toBe(false));
    expect(useSceneStore.getState().overrideFailed).toBe("error");
    const fail = screen.getByTestId("conflict-override-failed");
    expect(fail.textContent).toContain("没有生效");
    expect(fail.textContent).toContain("请求本身没成功");
    expect(fail.textContent).not.toContain("权限"); // 5xx 不许被说成权限问题
    expect(fail.textContent).not.toContain("校验"); // 也不许被说成图不合法
  });

  it("[用我的] 再撞 409：走 conflict 刷新（服务器新内容顶上来），不落静态错误句", async () => {
    vi.spyOn(sceneApi, "update").mockRejectedValue(new ApiErr("conflict", "又冲突了", 409));
    vi.spyOn(sceneApi, "get").mockResolvedValue({
      ...SCEN, version: 12,
      step_graph: { version: 1, nodes: [{ key: "n9", kind: "sleep", name: "服务器的二次改动", config: { ms: 500 } }] },
    } as never);
    renderModal({ conflict: conflictState() });
    fireEvent.click(await screen.findByTestId("conflict-use-mine"));
    await waitFor(() => expect(useSceneStore.getState().saving).toBe(false));
    expect(screen.queryByTestId("conflict-override-failed")).toBeNull(); // 裁决路径不设静态墙
    expect(useSceneStore.getState().overrideFailed).toBeNull();
    const s = useSceneStore.getState();
    expect(s.conflict).not.toBeNull();
    expect(s.conflict!.serverVersion).toBe(12); // 拿到的就是最新服务器版本，可再裁一次
    expect(screen.getByTestId("conflict-server").textContent).toContain("服务器的二次改动");
    expect(s.scenario!.version).toBe(3); // 版本号仍不背后同步（save() 的故意，同款约束）
  });

  it("再点一次先撤旧因（在途请求面前不许挂上一轮的因）；覆盖成功后无任何失败句（负对照）", async () => {
    // 旧因直接灌进槽（不走 catch 分因——那些分支各有专属腿）；桩一律成功：
    // 这条腿钉的只有 forceSaveWithVersion 开头那个 set 里的 overrideFailed 清零。
    vi.spyOn(sceneApi, "update").mockResolvedValue({ ...SCEN, version: 8 } as never);
    renderModal({ conflict: conflictState(), overrideFailed: "error" });
    expect(screen.getByTestId("conflict-override-failed")).not.toBeNull();
    // click 同步进入 forceSaveWithVersion 首个 set()（await 前全同步）：新尝试一出门，
    // 上一轮的因必须当场撤下——不许挂着一句旧原因对着正在飞的请求。
    fireEvent.click(screen.getByTestId("conflict-use-mine"));
    expect(useSceneStore.getState().overrideFailed).toBeNull();
    expect(screen.queryByTestId("conflict-override-failed")).toBeNull();
    await waitFor(() => expect(useSceneStore.getState().conflict).toBeNull());
    expect(screen.queryByTestId("conflict-override-failed")).toBeNull(); // 成功不演失败
    expect(screen.queryByTestId("scene-conflict-modal")).toBeNull();
  });

  it("[用服务器] 清 overrideFailed：失败句不许活到下一个冲突现场", () => {
    renderModal({ conflict: conflictState(), overrideFailed: "error" });
    expect(screen.getByTestId("conflict-override-failed")).not.toBeNull();
    fireEvent.click(screen.getByTestId("conflict-use-server"));
    expect(useSceneStore.getState().overrideFailed).toBeNull();
  });

  it("点 X 清 overrideFailed：同 takeServer，槽与 conflict 同生共死", () => {
    renderModal({ conflict: conflictState(), overrideFailed: "validation" });
    expect(screen.getByTestId("conflict-override-failed")).not.toBeNull();
    fireEvent.click(document.querySelector(".ant-modal-close") as HTMLElement);
    expect(useSceneStore.getState().overrideFailed).toBeNull();
  });

  it("新一轮 save() 开场就清 overrideFailed：refused 同款每次尝试重置", async () => {
    vi.spyOn(sceneApi, "update").mockReturnValue(new Promise(() => {})); // 挂住：只看开场那一 set
    seed({ conflict: conflictState(), overrideFailed: "denied" });
    void useSceneStore.getState().save(); // validateLocal 通过后的首个 set 是同步的
    expect(useSceneStore.getState().overrideFailed).toBeNull();
  });
});
