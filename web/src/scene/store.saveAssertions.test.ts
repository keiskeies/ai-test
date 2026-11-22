// 公共断言的「保存 → GET 原样」形状契约（门禁⑦ e2e 撞出来的病灶，钉在这里让它跑不完就红）。
//
// 病根：断言编辑器切类型会显式清出 `code: null` / `timeout_ms: null`（PropsPanel 的
// D75/D77「载荷键归零」），而行形状本身是 Partial<Assertion>。api_case 侧有
// `model_dump(exclude_none=True)` 兜住（api_test/case_services.py:48），场景侧是
// list[dict] 原样落 JSON —— 同一条断言在两张表里长得不一样，e2e 里那句
// `expect(ca.body.common_assertions).toEqual([{type,path,expected}])` 就多出来两个 null。
//
// 这里钉两件事：① 请求体里的行不许带 null 占位键（发得干净）；
// ② 保存成功后脏点必须熄灭（服务端回显与本地草稿是同一个字符串——
//   只修请求体不修这里，用户会遇到「存过了还亮着未保存」）。
// node 环境：只 import store（纯 zustand 模块），不碰 React/DOM。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pruneNull, selectDirty, useSceneStore } from "./store";
import { sceneApi } from "../api/scene";

type ScenarioOut = Awaited<ReturnType<typeof sceneApi.update>>;

const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
} as unknown as ScenarioOut;

beforeEach(() => {
  useSceneStore.setState({
    readOnly: false, scenario: SCEN, projectId: "p1", nodes: [], layout: {}, baselineNodes: "[]",
    envId: null, baselineEnvId: null, variables: {}, baselineVariables: "{}",
    failFast: true, baselineFailFast: true, maxRuntimeMs: null, baselineMaxRuntimeMs: null,
    commonAssertions: [], baselineCommonAssertions: "[]", serverIssues: [], conflict: null,
    refused: false, saving: false,
  });
  vi.restoreAllMocks();
});

describe("pruneNull：null 占位键不入库，false 关闭位必须留着", () => {
  it("丢掉 null / undefined 载荷键，其余逐字保留", () => {
    expect(pruneNull({
      type: "json_path_equals", path: "$.status", expected: "ok",
      timeout_ms: null, code: null,
    })).toEqual({ type: "json_path_equals", path: "$.status", expected: "ok" });
  });

  it("enabled:false 不许被当成空值丢掉——那等于把用户关掉的断言重新打开", () => {
    expect(pruneNull({ type: "status_code", expected: 200, enabled: false }))
      .toEqual({ type: "status_code", expected: 200, enabled: false });
  });
});

describe("save() 的公共断言请求体", () => {
  it("切过类型的行只带真正填过的键，type 为空的草稿位不进库", async () => {
    useSceneStore.setState({
      commonAssertions: [
        // 用户先选了「脚本断言」填了正文，又切回 JSON 路径相等：载荷键被编辑器清成 null/undefined
        { type: "json_path_equals", path: "$.status", expected: "ok", timeout_ms: null, code: undefined },
        { type: "" },
        // 停用位 + 响应时间阈值：这条的键都有值，必须整条原样过去
        { type: "response_time_lt", expected: 800, timeout_ms: null, enabled: false },
      ],
    });
    const seen: unknown[] = [];
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => {
      seen.push(body);
      return { ...SCEN, version: 4, common_assertions: body.common_assertions ?? [] };
    });

    await useSceneStore.getState().save();

    const body = seen[0] as { common_assertions: Record<string, unknown>[]; common_assertions_set: boolean };
    expect(body.common_assertions_set, "缺声明位 = 后端压根不改这一列").toBe(true);
    expect(body.common_assertions).toEqual([
      { type: "json_path_equals", path: "$.status", expected: "ok" },
      { type: "response_time_lt", expected: 800, enabled: false },
    ]);
  });

  it("保存后不再亮未保存：服务端回显与本地草稿是同一个形状", async () => {
    useSceneStore.setState({
      commonAssertions: [{ type: "status_code", expected: 200, path: null, code: null }],
    });
    expect(selectDirty(useSceneStore.getState())).toBe(true);
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => ({
      ...SCEN, version: 4, common_assertions: body.common_assertions ?? [],
    }));

    await useSceneStore.getState().save();

    const s = useSceneStore.getState();
    expect(s.baselineCommonAssertions).toBe('[{"type":"status_code","expected":200}]');
    expect(selectDirty(s)).toBe(false);
  });

  it("脏判据按入库形状判：带 null 占位的草稿与等价干净草稿给出同一个答案", () => {
    // 库里存过 D77/D78 之前那批未剪枝的行（或编辑器刚清过载荷），基线是剪过的形状。
    // 若脏判据直接 JSON.stringify 草稿，用户一进编辑页就看到「未保存」——那是逼他
    // 存一份根本没改过的东西，也是把「后端存的形状」当成「用户改了」来汇报。
    const baseline = '[{"type":"status_code","expected":200}]';
    const clean = { commonAssertions: [{ type: "status_code", expected: 200 }],
                    baselineCommonAssertions: baseline };
    const withNulls = { commonAssertions: [{ type: "status_code", expected: 200,
                                             path: null, code: null, timeout_ms: undefined }],
                        baselineCommonAssertions: baseline };
    useSceneStore.setState(clean);
    expect(selectDirty(useSceneStore.getState())).toBe(false);
    useSceneStore.setState(withNulls);
    expect(selectDirty(useSceneStore.getState())).toBe(false);
    // 正对照：真的改了预期值必须亮脏，否则上面那条绿只是「脏判据整个失效」的副产品
    useSceneStore.setState({
      commonAssertions: [{ type: "status_code", expected: 500, path: null }],
      baselineCommonAssertions: baseline,
    });
    expect(selectDirty(useSceneStore.getState())).toBe(true);
  });
});
