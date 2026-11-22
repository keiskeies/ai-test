# 1F Agent 元工具层 + 候选场景卡片（一期 DoD 第四条）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development 或 executing-plans 逐任务实现，checkbox 跟踪。
> 实现前若与本文件冲突，**先改本文件再改代码**，冲突不可静默吞掉（1A–1E 同规）。
> 蓝图验收底线原文：`docs/2026-11-13-ai-test-platform-design.md:1599`
> 「**1F(1~2 周,与 1E 并行)** Agent 只读预览:ReAct 循环 + 逐步事件流 + 全部读工具 + PLAN 模式 + 候选场景卡片(payload 自包含,保存按钮提示"二期开放")。」
> 一期 DoD（`:1601`）：「对 Agent 说"创建一个 XX 测试"能出候选卡片」；§1.5 判据第 1 条（`:51`）。

**Goal:** 1F 批次——**Agent 元工具层**（§6.2 工具层清单 `:540` 点名「**元工具(手写,非 service)**」的七件：`get_project_outline` / `search_test_assets` / `search_tools` / `propose_plan` / `update_plan_item` / `propose_scenario_plans` / `ask_user` + `suggest_open_page`，实测全仓零实现，见取证 ②）与 **`ui="card"` 卡片协议**（§12.2 `:1570`：`tool_result.payload.ui ∈ {null,"card","approval","diff"}`，`card.payload.kind ∈ {scenario_plans, report_summary, device_status, generic}`；§9.7 `:607`：这是通用件，后续审批卡/报告摘要卡/设备状态卡都走它）——以及本批次的硬验收：**对 Agent 说「创建一个 XX 测试」，3 轮对话内给出 ≥2 个基于项目真实资产的候选场景卡片，选定后进画布只读预览，保存按钮提示「二期开放」**（§1.5 `:51` 一期 DoD 判据第 1 条 + §13 `:1601` 的「对 Agent 说…能出候选卡片」）。ReAct 循环、分发器、SSE、假模型回放、试验台页**全部已在**（取证 ①），本批零重建、只接断掉的管子（取证 ③：dispatcher 已提取 `ui`，runner 落事件时丢弃）。

**Architecture:** 照搬已验证的分层，不发明新的：
1. **元工具住 `app/modules/agent/metatools/`，手写 `ToolSpec` 直接 `REGISTRY.register`**——§6.2 `:540` 明写「手写,非 service」，所以不走 `@service` 装饰器（它捆绑 HTTP 路由/OpenAPI，元工具没有 HTTP 面）；但注册进**同一张 REGISTRY 单一真相**（取证 ④：`ToolSpec` 是纯数据 + `REGISTRY.register` 是公开口，`core/service.py:92-104` 只是现存唯一调用点）。这样权限过滤（`list_tools(perms)`）、模式门（effect=read 才进 PLAN）、审计（dispatcher `_audit` 统一落 `entry="agent"`）全部白得，一行不重写。
2. **契约安全 = 走 search/workbench 同一条 composition 路**（取证 ⑤）：agent 本来就是编排/composition 模块（pyproject `:133-134` R26 注释「agent 是编排模块…可正向读取领域模块」，runner/tasks 已在 import iam/model_cfg 的 models）。元工具 import 领域 models = 正向依赖，契约 1（领域模块互相独立）不含 agent、契约 3（领域不得反依赖 agent）方向相反——**两条都天然保住**，且 pyproject 契约 3 清单**不需要**加 agent 自己（agent 是 forbidden_modules 目标，登记的是「谁不许 import agent」）。
3. **卡片协议 = payload 形状 + 共享渲染组件**，不是 bench.tsx 里的 if 分支：后端形状是 `ToolResult.ui="card"` + `content.card={kind, ...}`（§12.2 `:1570` 的 kind 枚举照抄，1F 只实现 `scenario_plans` 与 `generic`，`report_summary`/`device_status` 值预留不渲染）；前端新建 `web/src/agent/cards/`（`registry.ts` kind→渲染器映射 + `ScenarioPlansCard.tsx` + `QuestionCard.tsx`），`EventCard.tsx` 只加一个分支：`payload.ui==="card"` 时查注册表分派——审批卡/摘要卡后续注册自己的 kind 即可复用（`:607` 的通用件语义）。卡片上的用户操作回写成**一条普通用户消息**（§9.7 `:607`「自然衔接对话」），不发明第二套回传端点。
4. **候选卡 payload 自包含**（§13 `:1599` + §4 `:206`「scenario_draft 建表启用在二期(一期卡片自包含)」）：`propose_scenario_plans` 的每个候选带完整**步骤大纲 + 引用的真实资产 id/名**，前端拿到就能渲染步骤预览和画布预览，**1F 零建表、零迁移**——画布预览把 payload 里的图喂给**已存在的只读 Canvas**（取证 ⑧：`Canvas.tsx` 有 `readOnly`、reportDetail 已在用这条复用路），保存按钮 disabled 文案「二期开放」，不做假门。
5. **DoD 机器可检 = 假模型回放夹具**（§14 `:1623`「循环用脚本化假模型测；真模型冒烟放 nightly，不进 PR 门禁」）：新增 `two_candidate_plans.jsonl` 回放脚本，3 轮内 `propose_scenario_plans(plans=[≥2])` 且 plans 里引用的资产 id 必须能在演示库里对上（取证 ⑫ 夹具用 `{{PID}}`/`{{TR:search_test_assets:...}}` 现成机制），测试逐字段钉「≥2 卡 / ≤3 轮 / 资产真实存在」。

**Tech Stack:** 后端**零新依赖**（口径不是愿望：`search_test_assets` 一期走 MySQL LIKE 关键词路——`search/services.py:8-9` 已把同一口径立过账「不上向量/FULLTEXT」，Qdrant 容器在 docker-compose 里躺着但 `grep -rni qdrant app/` 全仓零客户端代码，取证 ⑥；引 qdrant 客户端要过 §5.4 点名关，且 §9.10 `:683/:694` 明写「索引为空/RAG 关闭/无向量模型 → 自动降级纯关键词路(零依赖可跑)」——一期就交付降级态，向量路整条不做，见「不在 1F」）。前端零新依赖（卡片全是 antd Card/Tag/Button + 已装的 @xyflow/react 只读画布）。

**Spec 覆盖:** §6.2 `:540` 元工具清单（八件一期全落，`read_skill` 除外——Skills 是二期，§13 `:1604` 点名，工具面不挂一个恒 404 的假工具）；§9.2 `:542` 工具可见性分层的**一期最小子集**（`resident` 列已在 `ToolSpec.resident`，取证 ④：registry 有字段但全仓 `resident=True` 出现 0 次——1F 只把元工具标 resident 并让 `search_tools` 能按关键词临时载入分组声明，300+ 声明的常态 6k token 预算是 LLM 网关侧的事，一期工具总量 131 个注册、按权限过滤后远小于爆炸线，不做压缩）；§9.7 `:595-607` 场景智能组装流（步骤 1-3 + 选择的对话回写全做，步骤 4 的 scenario_draft 迭代与步骤 5 的 create_scenario 转正是二期——`:601` 的「画布预览」按钮用自包含 payload 喂只读画布兑现）；§12.2 `:1570` 卡片协议信封（ui 值域 + kind 枚举照抄）；§11.4.30 试验台（已有页增量：卡片渲染 + 计划列表侧栏 §11.4.33 的 propose_plan/update_plan_item 事件渲染）；§13 `:1599` 1F 行全部（「全部读工具」= 已注册 131 个 `effect="read"` service 经 PLAN 门可被调用，本批补的是 §9.7 流的**编排知识**（系统提示）与元工具，不是重造读工具）。

**不在 1F:** `scenario_draft` 建表与草稿迭代闭环（§4 `:206`「建表启用在二期」、§13 `:1604` 二期点名——**1F 零迁移**是本计划的结构性承诺，见 R147）；`create_scenario` 转正 + 「另存为正式场景」（二期，同句点名）；写/破坏性工具与页面审批门（二期；bench.tsx 的 APPROVAL_REQ 卡现有「暂不支持在页面上批准」文案不动）；`report_summary` / `device_status` 卡片渲染（协议 kind 预留、值域先进枚举后进渲染器——1D 计划 D19 已裁「`device_status` agent 卡片无批次归属」，本批仍不做，只保证协议不挡路）；MCP / Skills / `read_skill`（二期，§13 `:1604`）；Qdrant 向量路 / FULLTEXT(ngram) / RRF 融合（§9.10 的完整双路——一期按 `:683` 的降级条款交付纯关键词路，向量路无批次点名 → **D34**）；`/compact` 与命令全集、上下文压缩（二期）；真模型质量验收（§14 `:1623` nightly 条款，见 T6 诚实条款）；工作台「让 Pilot 生成」按钮（`workbench.tsx:254` 的 disabled 哨兵翻真是 **1E T6/T9 收尾条款的交叠点，见「与 1E 的边界」④——默认归 1F T6，1E 若先到则以跳转 bench 的最简动作翻，两边不重复做弹窗）。

**1D/1E 在飞（写进计划，防止误读）：** 截至本文件写成之日 `git log -1` = `e3d5945 docs(1d/t7+d11/1e)`——**1D 的 T8–T11 未完成**（T8/T10/T11 未勾、T9 部分），**1E 计划刚落盘、T0 未开工**。1F 与 1E 按 §13 `:1599` 本就设计为并行，撞车面比 1E 小（1F 零迁移、零 seed_demo、零 handlers.py），但仍有三处：**① `README.md` 门禁数字**——1D T11 与 1E T9 都要回填，1F T6 是第三个，规矩沿 1E 原文「后到者改」；**② `pyproject.toml` 契约清单**——1E T1 要往契约 1/3 加 `schedule`/`notify`，1F 若动 pyproject（本计划默认**不动**，见 Architecture 2 与 T0 门禁说明）必须基于届时 HEAD 重新 diff，不许拿今天的行号改；**③ `seed_demo.py`**——1F T5 夹具要演示项目里有真资产，现状 `seed_demo.py` 已铺 接口/用例/场景/UI 用例（1A–1D 逐批加过），1F 默认**只读不写** seed（夹具挂 TR 引用现取现用），仅当演示项目缺可组场景的资产面时才追加种子行——**动 seed_demo.py 前确认 1D T10 已合**（撞车点与 1E 取证 ⑩ 同源同规）。

---

## 前置取证（写计划之前已经跑通的事实，全部 2026-11-16 实测）

结论是硬前提；每条都可复跑。环境：本机 Windows、MySQL/Redis 在 db.internal.test、`backend/.venv/Scripts/python.exe`。**【复跑勘误 2026-11-19】这里的 db.internal.test 是 2026-11-16 当轮取证的实际环境，照原文读、不改写（含取证 ⑥「compose 里有 qdrant 容器但没人连它」——那条结论与容器无关，仍然成立）；自 2026-11-19 起业主口径改为「各种测试都在本机启动的软件上跑」，复跑请连 `127.0.0.1:3306`（服务 `MySQL84`）与 `127.0.0.1:6379`，不再要求 Docker——见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4。**
标「README 记录」的是引账不改；标「未实测」的就是没量过，不许当量过用。

1. **1F 的「循环侧」全部已在，本批不重建（逐文件读过）**：
   `app/modules/agent/runner.py`（204 行，ReAct 循环 + delta 聚合 + NeedApproval 挂起 + `RUN_END` 终态事件）、
   `dispatcher.py`（113 行，存在性→权限→模式门→校验→执行→审计五步）、`gateway.py`（174 行，
   `FakeGateway` JSONL 回放 + `{{PID}}` + `{{TR:工具:路径}}` 引用替换 + `OpenAICompatGateway`）、
   `routes.py`（155 行，会话/消息/中断/历史 + `GET /events/agent/{id}` SSE，D11 的建流前 rollback 已在 `:146`）、
   `tasks.py`（121 行，SETNX 锁 + 忙查 + `_execute`）、`web/src/pages/bench.tsx`（253 行，模式/思考/模型 + 事件流）、
   `web/src/agent/EventCard.tsx`（164 行，USER/THINKING/TEXT/TOOL_*/USAGE/ERROR/APPROVAL_REQ 八类卡片）、
   `web/src/agent/sse.ts`。回放夹具现存 6 份（`tests/fixtures/fake_model/`：
   `basic_two_tools` / `tools_capture` / `plan_write_denied` / `plan_debug_denied` / `bad_args_then_fix` /
   `onea_build_and_debug`）——**没有一份涉及候选场景卡**。
2. **七个元工具 + 卡片协议全仓零实现（grep 实测，逐个点名）**：
   `grep -rn "propose_scenario_plans\|propose_plan\|update_plan_item\|ask_user\|suggest_open_page\|get_project_outline\|search_tools"`
   全仓命中**只有蓝图 `docs/2026-11-13-ai-test-platform-design.md`**（`:540/:542/:582/:597/:600/:607/:666-671/:1211/:1253-1258/:1334/:1430`）
   ——`backend/` 与 `web/` 源码命中 0 条。`ui="card"` 同扫：源码命中 0 条，只有蓝图 `:607/:1570`。
   → T1–T3 是**全新增量**，不是改造。
3. **`ui` 这根管子已经通了一半，断在 runner（这是本批最省的一刀）**：
   `dispatcher.ToolResult` 有 `ui: str | None`（`:37`），`call()` 里 `ui = content.get("ui")`（`:95`）已从返回值提取；
   但 `runner.py:122-129` 落 `TOOL_RESULT` 事件时 **payload 只装 `tool_call_id/tool_name/ok/content/produced`，
   `res.ui` 被整个丢弃**，前端 `EventCard.tsx` 也没有任何 `ui`/`card` 分支。→ T2 补透传、T3 补渲染，各一处。
4. **手写注册的技术通路是干净的（读过 `core/registry.py` 全文 72 行）**：`ToolSpec` 是纯 dataclass
   （`name/description/json_schema/perm/effect/handler/model/tool/resident/http/domain`），
   `REGISTRY.register(spec)` 是公开方法且**只查重名**；`core/service.py:92-104` 的 `@service` 只是它的唯一现存调用点。
   `list_tools(perms)`（`:57-65`）按 `t.tool` + `match_perm(perms, t.perm)` 过滤，`perm_points()` 收所有权限位
   （启动同步入库，§15 纪律 7「代码即文档」）。`resident` 字段**已在结构里但全仓 `resident=True` 出现 0 次**。
   `http=None` 的 service 由 `build_router` 挡掉不生成路由（`service.py:223`）——元工具 `http=None` 天然无 HTTP 面。
5. **composition 层的契约先例有两条，都读过 pyproject 原文**（`:76-134`）：
   契约 1 `independence` 的清单是 iam/env/api_test/audit/model_cfg/scenario/ui_test/adb_test **八个领域模块，不含 agent，
   也不含 search/workbench**；契约 3 `forbidden`「领域模块不得反向依赖 agent」的 `source_modules` 含
   `app.modules.search` 与 `app.modules.workbench`（注释原文：「search 是 composition 模块(与 agent 同类，可正向读领域模型)，
   不进契约 1 的独立清单(它按设计 import api_test/scenario)，但必须进本清单——组合层也不许认识 agent，
   登记了才被扫，漏登记就是假绿」）；文件尾 `:133-134` R26 原话「agent 是编排模块(与 main.py 装配层同类)，
   **可正向读取领域模块**；反向(领域模块认识 agent)禁止」。`runner.py:149` 已在函数体内 `from app.modules.iam.models import User`
   并留同款注释；`search/services.py:26-30` 直接 import 四个领域模块的 models。
   → **元工具 import 领域 models 与 search 同构，契约 1/3 双向天然安全**；`lint-imports` 仍须逐字念 `Contracts: 4 kept, 0 broken`。
6. **检索现状 = 纯 LIKE，Qdrant 是空容器**：`app/modules/search/services.py:8-9` docstring 原话
   「一期口径(§9.10)：MySQL LIKE 关键词，不上向量/FULLTEXT——向量路只服务 search_test_assets 与未来的语义检索」；
   `grep -rni "qdrant\|fulltext\|ngram\|embedding" app/` 只命中 `model_cfg` 的 `EMBEDDING` 枚举与这条 docstring，
   **无 qdrant 客户端代码**；`docker-compose.yml:24-28` 有 `qdrant/qdrant:latest` 容器但没人连它。
   → `search_test_assets` 一期落关键词路 + 显式降级注释；蓝图 §9.10 `:683` 本身写了降级条款，不是我们偷懒。
7. **权限面现状与读类命名规范（1D 已量过的 glob 坑，本批照防）**：`grep -rc 'effect="read"' app` 实测 **48 处**
   （写 `effect="write"` 58 处；`@service(` 总量 131 处）。`search:read` 的先例注释（`search/services.py:13-14`）
   说明读类位必须以 `:read` 结尾才落进 READONLY 的 `["*:read"]` glob。元工具新增权限位定为
   **`agent:meta:read`**（读/盘点类三件）与 **`agent:plan:write`**（propose/update/ask/suggest 四件，
   effect 记 `read`——它们不落业务数据，只产事件与卡片；§10-1 三段式）。
8. **只读画布复用路已在生产路径上跑着**：`web/src/scene/Canvas.tsx` 有 `readOnly` 全流程
   （`:41` props、`:67` draggable、`:79/:87` 禁结构编辑与右键、`:245-246` 只读不跑本地校验、`:312` 不收拖拽载荷），
   `web/src/scene/store.ts` 有 `readOnly` state，`reportDetail.tsx:2` 注释原话「只读画布复用编辑器的 Canvas：
   store.loadReport 把 summary_graph(graph ⊕ result 快照)……」。**卡片预览要不要再造一个画布？不要**——
   照 reportDetail 的形状加一个 `store.loadCardGraph(graph)`（T4）。
9. **场景图协议有现成校验器可复用**：`app/modules/scenario/graph.py` 有 `iter_nodes`（`seed_demo.py:396` 在用），
   候选卡 payload 里的 graph 走**同一个**结构校验（T2 的门：形状不对就地拒绝回注模型，不许把野 JSON 递给画布）。
10. **门禁基线（引账 + README 数字）**：README `:91-110` 记录——1C+ 轮 ① **618 passed**（308.92s）、
    ③ **no issues in 93 source files**、⑥ vitest 164 passed / 12 files；1D 中间轮（README `:102-110`）
    ① **759 passed**（406.50s）、③ **no issues in 107 source files**、⑥ vitest **231 passed / 16 files**、
    ⑦ e2e **73 passed** 且 `sceneRun` 连跑 9 次全绿（D11 已修，「稳定 69 条」那句旧口径 README 自己宣布作废）、
    ⑧ `head = 0020`。**1F 的门禁基线以「合入时 README 最新数字」为准，只增不减**（1D/1E 任一在后，数字会变）。
    ④ 的逐字证据是 **`Contracts: 4 kept, 0 broken`**，必须用 `.venv/Scripts/lint-imports.exe`
    （README `:79`「只认打印文字，别用 -m importlinter」；1C 计划 `:366` 补了规矩：**退出码不算证据**，
    `python -m importlinter.cli lint` 是静默空跑的陷阱）。八道门禁的完整命令与 `backend/.venv/Scripts/python.exe`
    口径见 `README.md:68-89`，1F 全程复用不另立。
    <sub>**行号勘误（2026-11-18 写下，2026-11-19 第三十九轮把里面的 `现 :N` 删了）**：上面这几处
    `README :N` 在写入当天是对的，全部漂移——README 的门禁数字是**往下追加**的，所以快照条整体下移。
    按**节名**重新定位：1C+ 快照 = README「批次实跑快照（1C+，2026-11-16，历史数字）」条；
    1D 中间轮 = 「1D 中间轮实跑（T7 + D11 修复…）」条；
    「只认打印文字，别用 -m importlinter」= 「提交前必跑（八道门禁）」代码块里 ④ 那一行；
    八道门禁完整命令 = 「## 提交前必跑（八道门禁）」一节。
    **为什么删掉那四个 `现 :N`**：它们本身是第二份会漂的东西——第三十九轮给 README 加了一节
    「新机自举」（D155），四个数字当天又集体下移十几行；一个「为了纠正行号漂移」而写下的框，
    自己变成了下一个漂移源。节名是唯一不会漂的坐标，所以只留节名。
    **原文不改史**：这几行记的是 1F 开工当天读到的位置；往后引 README 一律用节名，不用 `:N`
    （这条已在 1G 计划 D156 处立为规矩）。</sub>
11. **alembic 链头 = `0020`**（`backend/migrations/versions/` 实测最新 `0020_adb.py`；链头钉在
    `test_ui_models.py`）。**1F 零迁移**——不碰链头钉，这是与 1D T11 / 1E T0 最大的脱钩点，也是 1F 能真并行的结构性理由。
12. **假模型的挂具接法（T5 的落点已读透）**：`tasks.set_gateway_factory(fn)`（`tasks.py:26-31`）是测试注入口，
    `tests/test_agent_api.py:27-34` 已示范「`fake://` 前缀 → `FakeGateway(name)`，否则回落 `basic_two_tools`」；
    `FakeGateway.__init__` 支持 `fake://<name>` URI 并注入 `project_id`（`tasks.py:85-86` 专门重建以带 PID）。
    `{{TR:search_test_assets:content.items.0.id}}` 这类引用由 `_apply_tool_refs` 现算，**找不到源工具结果就抛**
    （`gateway.py:64`）——这条「宁抛不带占位符继续」正是 T5 夹具能钉「资产必须真实存在」的机制。
13. **前端 1F 哨兵实测（T6 要翻真的假门清单）**：`scenes.tsx:244` 「让 Pilot 生成（1F 开放）」菜单项 +
    `:250` 的 Modal.info 文案、`workbench.tsx:254` disabled 按钮 + `:251-252` 注释自陈「Pilot 生成场景是 1F 的活」。
    这些是**诚实哨兵不是假门**（明说不开放），1F 交付后按 T6 翻真或改跳转 bench。
14. **未实测清单（对天发誓没量过的）**：真模型（`.env` 的 `http://127.0.0.1:9000/v1` 网关在否不赌）能否
    真的在 3 轮内产出 ≥2 个**语义合理**的候选——本批的门禁只证明「协议 + 渲染 + 判定可机检」，
    不证明「模型够聪明」，这条诚实边界写进 T6 与 README 手册，不靠假绿掩盖；
    Qdrant 容器的可达性（1F 不连它）；`resident=True` 对真实 token 占用的影响（一期无压缩，测不出意义）。

## 号段公告

**号段公告（与并行 session 的撞号记录；动笔前已复核，规矩承 1E：撞了就后移并留改号记录，不许悄悄复用别人的号）**：
写成之日 `grep -rn "R14[0-9]\|R15[0-9]" docs/ README.md backend/ web/src` 实测——
**1D 持有 R140（设备锁）、R141（D11 首帧专项）、R145（T8 引擎 adb 步骤同源，已落码进
`handlers.py`/`debug_services.py`/`test_scenario_run_adb.py`）；1E 预留 R142（自研读表 Scheduler）、
R143（notify httpx trust_env=False）、R144（entry=schedule 审计语义）**。R146 及其后全仓零命中。
→ **1F 从 R146 起号**（若实现时再撞，整体后移并在本节留一行改号记录）。
D 号复核：1D 止于 D21、1E 留到 D30，`grep "D3[0-9]" docs/` 除 1E 的 D30 外零命中 → **1F 从 D31 起号**。

## 批次决定记录（承 1E 的 R 序，实现时逐条补全）

- **R146 ·（落地回填，`ad2b358`）** 元工具绕开 `@service` 但进同一张 REGISTRY：§6.2 `:540`「手写,非 service」
  与 S0 的「五路同生」不冲突——五路同生是 `@service` 的实现手段不是目的，元工具要的三路
  （工具 schema / 权限位 / 审计）全部由 `REGISTRY.register(ToolSpec(...))` 本身携带（取证 ④），
  不要的两路（HTTP 路由 / OpenAPI）用 `http=None` 天然关闭。**形状钉测试**：`agent:meta:read` 等位
  出现在 `REGISTRY.perm_points()`（启动同步入库照常吃到）；`grep -c "@service" metatools/*.py == 0`
  的结构例（防后来者手滑把元工具改回 @service——那是蓝图口径回退，不是优化）。

  <sub>**落地**（`ad2b358`，T0）：`metatools/spec.py` 手写八个 ToolSpec 进同一张 REGISTRY（本轮打开核对：
  `spec.py:101` `ToolSpec(`、`:106` `effect="read"`、`:111` `http=None`、`:150` `REGISTRY.register`），
  `main.py._SERVICE_MODULES` 尾部 +1 行 import 触发自注册。两条承诺的形状测试都在并且本轮打开读到：
  `tests/test_agent_metatools.py:43` `test_no_service_decorator_in_metatools`（metatools/*.py 的 `@service`
  字面量扫描恒 0）与 `:69` `test_perm_points_contain_meta_bits`（两位进 `perm_points()`，`main.py:26`
  `sync_perm_points` 启动入库吃到）。偏差：计划写「grep -c 结构例」，实现为测试内源码扫描（同等强度，
  红在 CI）；其余逐字按计划。</sub>

- **R147 ·（结构性承诺，落地回填：全批持守，逐 commit 核验至收口 `8a3b3ef`）** 1F 零迁移、零 seed 依赖承诺：`scenario_draft` 建表在二期（§4 `:206`），
  卡片 payload 自包含（§13 `:1599`）——**因此 1F 不产 0021、不碰链头钉、不碰 `handlers.py`/`graph.py`**，
  与 1D T8/T11、1E T0 的三个已知撞车面物理脱钩（1E 取证 ⑩ 的撞车点清单逐条核对过）。
  若实现中有人主张「加一张草稿表更顺」，本条就是反对的白纸黑字：顺 = 撞 1E 的 0021 号 + 违纪律（二期件一期做）。

  <sub>**落地**（全批持守，逐 commit 核验 `ad2b358`/`d3f6766`/`b1c2017`/`405b66c`/`6cccb00`/`014208b`/
  `f732dea`/`8a3b3ef`）：本轮对以上每个 1F commit 的 `git show --stat` 逐一核过——**零笔**触碰
  `migrations/`、`handlers.py`、`graph.py`、`pyproject.toml`；`migrations/versions` 最新两档 0021/0022
  各属 1E（`2086f89`）与 1G（`3f0daa7`），1F 未产任何迁移。卡片 payload 自包含落在
  `card_tools.py:117`（「一期边界（R147）：payload 自包含、零落库——scenario_draft 是二期表」），
  全仓 grep `scenario_draft` 在 app/ 下只命中该文件的说明性注释，无建表无落库口子。零偏差。</sub>

- **R148 ·（落地回填，`b1c2017`）** `ui` 透传走事件 payload 而不是旁路端点：dispatcher 已提取
  `res.ui`（取证 ③），runner 落 `TOOL_RESULT` 时加 `"ui": res.ui` 一个键，卡片整坨在 `content.card` 里
  ——**与 §12.2 `:1570` 的信封逐字对齐**（`tool_result.payload.ui ∈ {null,"card","approval","diff"}`）。
  不引入第二个 SSE 事件类型：断线重连/历史重放（`store.replay`）免费覆盖卡片，这是「协议是通用件」的第一受益。
  审批卡的 `ui="approval"` 是二期（页面审批门）——值域现在写全，渲染器不注册即自然缺席，不做假卡。

  <sub>**落地**（`b1c2017`）：`runner.py:126` 一处 `payload["ui"] = res.ui`（本轮读到，紧邻 `:123-125`
  就是引用 §12.2 `:1570` 信封的 R148 注释）；dispatcher 提取侧 `dispatcher.py:95` `ui = content.get("ui")`。
  卡片整坨确在 `content.card`：`card_tools.py:94` `_card()` 返回 `{"ui": ui, "card": card}`，测试侧
  `test_agent_metatools_cards.py:123/:176` 按 `r.content["card"]` 取值。端到端钉 = 同文件 `:253`
  `test_ui_passthrough_end_to_end`（REST 与 SSE 逐事件字节一致；计划要求的「GET messages 与 SSE 的 ui
  字节一致」兑现）。值域双断言在 `_card()` 出口（`card_tools.py:90-93`，kind 与 ui 各一条 RuntimeError），
  `UI_KINDS`（`:56`）= `{None,"card","approval","diff"}` 与计划逐字同；`approval` 渲染器未注册即缺席，
  未做假卡。零偏差。</sub>

- **R149 ·（落地回填，`014208b`）** 卡片操作回写 = 一条普通用户消息：§9.7 `:607` 原话
  「用户操作回写为一条用户消息(自然衔接对话)」——「选择候选 A」发的是
  `POST /sessions/{id}/messages {content:"选择：登录回归（方案A）"}` 级别的可读文本（前缀 + 人话，
  模型侧不需要私有 DSL），**不建 /card-action 端点**。收益：历史重放、审计、S0 的忙语义全部复用；
  回退成本：端点另立时消息照发不误。

  <sub>**落地**（`014208b`）：`web/src/pages/bench.tsx:140` `onUserMessage: (t) => void sendText("[卡片操作] " + t)`，
  `sendText`（同文件 `:122-137`）就是拼前缀后调既有 `POST /agent/sessions/{id}/messages {content}`——历史重放、
  审计、忙语义（`status==="运行中"` 直接 return，`:124`）全部复用。`/card-action` 端点确实不存在
  （backend grep 全仓零命中，本轮亲验）。e2e 侧 `pilotCards.spec.mjs`（`8a3b3ef`）钉了「[选择] 回写
  『[卡片操作] 选择方案：…』进事件流」。偏差：计划例句前缀是「选择：」，实现统一成机器可断言的
  「[卡片操作] 」固定前缀 + 人话正文——可读性口径不变，模型侧仍无私有 DSL。</sub>

- **R150 ·（落地回填，`d3f6766`）** `search_test_assets` 与 `search_assets`（Ctrl+K）的关系 =
  共享谓词不共享服务面：两者权限语义不同（前者项目内资产盘点带 kind/module 收窄、给模型吃的是
  ≤2k token 摘要形状，后者是 Ctrl+K 六路分组 UI 形状），**实现各自独立，但可见性谓词必须同把尺**
  （`shared/visibility.visible_clause`，search/services.py 同款）——各自造谓词早晚分叉出「Ctrl+K 看得见、
  Pilot 看不见」的口径债。向量路按 §9.10 `:683` 降级条款显式留在注释与返回 meta 里（`mode:"keyword"`），
  不装双路。

  <sub>**落地**（`d3f6766`）：`metatools/read_tools.py:234` `search_test_assets` 独立 handler（未挂 HTTP 面，
  与 Ctrl+K 的 `search/services.py` 服务面各自独立）；共享谓词比计划更狠一档——不止「同款尺」，
  `:39` 直接 `from app.modules.search.services import _like`（同一把 LIKE 转义函数，注释原文
  「不是『同款实现』」）、`:154` `visible_clause(model, ctx)` 与 workbench/Ctrl+K 同尺；
  `meta.mode="keyword"` 在 `:71-72`/`:242-243` 双处如实标降级。变异自证与计数互钉见 T1 证据块。零偏差。</sub>

## 蓝图锚点复核（任务书给的行号 vs 今天实测）

| 锚点 | 任务书 | 实测 | 处置 |
|------|--------|------|------|
| §1.5 一期 DoD 判据「3 轮 ≥2 卡」 | `:51` | `:51` **一致** | 照引 |
| §6.2 元工具「手写,非 service」 | `:540` | `:540` **一致** | 照引 |
| §12.2 卡片协议 | `:1566` | 节标题在 `:1566`，**payload 值域行实测在 `:1570`** | 正文引 `:1570` |
| §9.7 卡片型工具/通用件 | `:600-607` | 节标题实测在 `:593`；`:600` propose_scenario_plans、`:607` 通用件句 **一致** | 正文引 `:600/:607`，节号 9.7 不变 |
| §4 scenario_draft 建表二期 | `:206` | `:206` **一致**（原话「建表启用在二期(一期卡片自包含,§13)」） | 照引 |
| §13 纪律 1 | 「不许假绿/假门」 | 纪律清单实测在 `:1609-1614`，**纪律 1（`:1611`）字面是「每个小步合并前必须有业主能亲手跑的演示路径 + E2E 冒烟；业主验收行为而非逐行读码」** | 「假绿/假门即违纪律 1」是 1D/1C 计划对该条款的既有解释口径（1D D21 原话「界面能配、执行恒假 = §13 纪律 1 的假功能形状」），本计划沿用该口径并在正文写明字面原文，不冒充蓝图原文 |
| §13 1F 批次行 | — | 实测 `:1599`（1E 计划引的 `:1598` 是 1E 行，相邻） | 照引 |

## 待业主裁决（1F 新增；先按假设实现，全部显式可回退）

- **D31 · PLAN 模式下元卡片工具算不算「写」**。§13 `:1599` 说 1F 是「Agent 只读预览…PLAN 模式」，
  而 `propose_scenario_plans`/`ask_user` 的 effect 语义上是「产卡片不落库」——dispatcher 的模式门按
  `spec.effect != "read"` 一刀切（`dispatcher.py:74`）。**假设：八个元工具 effect 全记 `read`**
  （它们确实一行业务数据都不写，R146 的形状里 `effect="read"`），PLAN 模式全可用——否则 PLAN 会话连候选卡都
  发不出来，DoD 判据第 1 条在「只读」档直接不可达，这是把「只读」读成了「只读还闭嘴」。
  业主裁「卡片也算表态」→ 八处 `effect` 改 `write`，一处常量表回退。

  <sub>**现状：已按假设落地**（`ad2b358` 起）。八个元工具 `effect` 全记 `read`——本轮读到两处实测证据：
  `spec.py:106`（构造处 `effect="read"` 单点）与 `tests/test_agent_metatools.py:64`
  `assert spec.effect == "read"`（注释即引用 D31），PLAN 模式门 `dispatcher.py:74` 因此全放行。
  业主若裁「卡片也算表态」，回退面 = spec.py 构造参数一处 + 该断言一行。</sub>
- **D32 · ask_user 挂不挂起 run**。§9.7 `:607` 说 ask_user 是「运行内提问卡片」，没说 run 停不停：
  挂起（类 WAIT_APPROVAL）需要新状态 + 恢复链路（二期审批门同款机器）；不挂起则 run 直接 DONE，
  用户点选项发新消息开新 run——对话继续，run 边界干净。**假设：不挂起**，ask_user 落卡后本轮正常 DONE，
  选项点击回写为新用户消息（R149 同路）。S0 的产品决策先例在 bench.tsx 头注（R23）里躺着：审批页内批准
  都是二期，提问挂起恢复更是。回退：runner 加一个 WAIT_USER 态 = 二期审批恢复链路顺带做，不单独开凿。

  <sub>**现状：已按假设落地（不挂起）**（`b1c2017` 出卡 + `f732dea` 钉形状）。本轮查证：全仓 grep
  `WAIT_USER` 在 app/ 下只命中 `card_tools.py:18` 的说明注释「不建 WAIT_USER 态」，runner 里没有该状态；
  夹具 `tests/fixtures/fake_model/ask_user_flow.jsonl` + `tests/test_agent_dod_cards.py`（文件头注「六 ·
  回归夹具 ask_user_flow：ask_user 出卡后 run 直接 DONE」）把形状钉死；选项回写走 R149 同路。
  业主裁挂起才开二期审批恢复链路的车。</sub>
- **D33 · 候选卡的「画布预览」在哪打开**。§9.7 `:601` 说按钮「加载 scenario_draft 到画布只读预览」——
  draft 表是二期，一期 payload 自包含，那预览是 (a) bench 页内嵌抽屉塞只读 Canvas，还是 (b) 跳独立路由
  `/scene-preview` 把 payload 走 sessionStorage/查询态带过去。**假设：(b) 独立路由**——bench 页 253 行已经
  不瘦，内嵌画布要把 @xyflow 拉进 bench 的渲染面（e2e 视口/高度塌陷坑 1B 踩过）；独立路由与 reportDetail
  的只读画布同构（取证 ⑧），复制的是形状不是代码。回退：抽屉化 = 把同一 `<Canvas readOnly>` 搬进 Drawer，
  组件不动。

  <sub>**现状：已按假设 (b) 落地**（`6cccb00`）。独立路由真实在册——本轮读到 `web/src/app.tsx:75`
  `{ path: "scene-preview", element: …`（懒载），页面 `pages/scenePreview.tsx`、payload 走
  `agent/cards/previewLink.ts`（sessionStorage 键 + 三态坏键校验）。键的 run 段因前端信封无 run_id
  退为点击期 token，偏差已记在 T4 证据块，不重复。</sub>
- **D34 · search_test_assets 一期做到哪一档**。§6.2 `:540` 写双路混合（FULLTEXT ngram + Qdrant + RRF），
  §9.10 `:683` 又写「索引为空/RAG 关闭/无向量模型 → 自动降级纯关键词路(零依赖可跑)」，而 `search/services.py`
  的在仓口径是「一期 LIKE 不上 FULLTEXT」（取证 ⑥）。三句按时间排：6.2 是目标态、9.10 承认降级合法、
  search 先例把降级定为「一期口径」。**假设：一期 LIKE + 返回 meta.mode="keyword"**，FULLTEXT(ngram) 与
  Qdrant 整条推给「RAG 批次」（无批次点名，蓝图 §11.4.28 把重建索引按钮挂在系统参数页、1E D25 也只裁了
  心跳一行）。业主裁「1F 就上 FULLTEXT」→ 加 DDL（ngram 解析器 + 全文索引）+ 查询路替换，元工具接口不变。

  <sub>**现状：一期档已落地（`d3f6766`），向量路归属仍待业主**。落地部分本轮亲验：
  `read_tools.py:71-72` `mode: str = "keyword"`（出参默认值）+ `:242-243` docstring 原文「不装 §6.2 的双路混合」，
  全 app/ 无任何向量检索路（grep 实测：`main.py:180-185` 的 readyz 探针自陈「全仓后端 grep qdrant 零客户端、
  零配置」并如实标 `skipped`，`search/services.py:10` 注释「一期 LIKE 不上向量/FULLTEXT」）。
  归属部分不自作主张：FULLTEXT+Qdrant+RRF 整条推「RAG 批次」是本条假设而非业主画押，1G 计划 `:223-224`
  已专门纠过「把 D34 当成侧栏裁定」的引用错——D34 管的**只是搜索向量路**，业主裁「1F 就上 FULLTEXT」才加 DDL。</sub>
- **D35 · 3 轮判定的「轮」怎么数**。§1.5 `:51`「3 轮对话内给出 ≥2 个候选场景」——轮 = 用户消息回合
  （user turn）还是 run？假模型夹具怎么算通过？**假设：轮 = 用户消息回合**（判据原文是对话轮次；夹具
  `two_candidate_plans.jsonl` 单 run 内完成 = 1 轮 ≤ 3，从严通过）；测试同时断言 run 终态 DONE 且
  TOOL_RESULT(ui=card, kind=scenario_plans) 的 plans.length ≥ 2。业主裁「轮 = run」→ 夹具不动，
  口径只会更松，无需改码。

  <sub>**现状：已按假设落地（轮 = 用户消息回合，从严）**（`f732dea`）。本轮读到
  `tests/test_agent_dod_cards.py:194`「④ 用户消息回合数 ≤ 3（D35 从严：单 run = 1 轮）——USER 恰 1 条、
  AgentRun 恰 1 行」，`:175` 另有 `assert len(plans) >= 2` 的 ≥2 卡硬断言。业主裁「轮 = run」只松不紧，零改码。</sub>
- **D36 · propose_plan/update_plan_item 的列表 UI 放哪**。§11.4.33 画的是 Pilot 页右侧「目标计划」侧栏
  （`:1334` 还有「首个 propose_plan 自动展开一次」的交互细节）。1F 做侧栏还是先渲染成事件流里的
  列表卡？**假设：一期渲染为 TOOL_RESULT 内嵌的 `ui="card", kind="generic"` 计划列表卡**（就在事件流里，
  update_plan_item 原地更新靠「同名工具最新结果」渲染），独立侧栏 Tab 推二期（与 §11.4.30 全景侧栏改版同批）——
  自动展开/偏好记忆这类交互细节没有二期之外的批次归属。回退：卡片组件原样搬进侧栏。

  <sub>**现状：已按假设落地（事件流内联卡，侧栏推二期）**（`014208b`：卡片 + fold + bench 注入同笔）。本轮读到：
  `web/src/agent/cards/PlanListCard.tsx`（状态点 pending/doing/done/skipped）+ `bench.tsx:13/:193` 的
  `foldPlanListCards(events)`（「原地更新」靠同名工具最新结果合流）；bench 页 grep 无任何侧栏组件——
  「目标计划」独立侧栏确实没做。这条是 §11.4.36 Agent 功能侧栏**任务清单 Tab** 的书面一期归属依据
  （1G D42 据此判「换形状实现、Tab 归二期」，1G `:220-224` 并纠正过「把 D36 的事记在 D34 头上」的旧引用错——
  D34 管搜索向量路、D36 管侧栏，勿再混）。侧栏四 Tab 整块的批次归属仍是业主裁（1G D42 等画押）。</sub>

## 与 1E 的边界（两条计划不许互抢同一块活）

1E 计划（`2026-11-16-1e-schedule-notify-workbench.md`）与本批并行（§13 `:1599` 原文「与 1E 并行」），
逐条划界、先到先得、后者只钉测试：

1. **迁移链**：1E T0 产 `0021_schedule_notify.py` 并改链头钉；**1F 零迁移**（R147），链头钉与 1F 无关。
   1F 合入时若链头已是 0021/0022，1F 什么都不用做——这是脱钩的全部含义。
2. **`model_cfg` / 模型配置中心**：归 1E T8（逐能力探测 + 卡片墙 + 出厂种子）。1F 只**消费**默认 CHAT 模型
   （`tasks.resolve_model` 现状，不碰 model_cfg 任何文件）；EMBEDDING 维度探测归 1E，1F 的 D34 假设不依赖它。
3. **`report_summary` 卡片**：1E 不渲染它（通知走 Markdown 出站，不走 SSE 卡），蓝图把「报告摘要卡」挂在
   二期执行类工具批次（§13 `:1604`）。1F 只保证卡片协议 kind 枚举含它（T2 的形状测试钉枚举），不做渲染器。
4. **工作台「让 Pilot 生成」哨兵**（`workbench.tsx:254` disabled + `scenes.tsx:244/250`「1F 开放」）：
   **功能归属 1F**（T6 翻真：菜单项改为跳转 /bench 并预选项目）；1E T6/T9 的收尾条款若先动了 workbench.tsx
   的其他块（导入按钮哨兵），1F 只改自己那两行，git 冲突时 1F 让路重 rebase。
5. **README 门禁数字**：三方都可能回填（1D T11 / 1E T9 / 1F T6），沿 1E 规矩「后到者改」，且各自的
   实跑轮标注写清批次与时点。
6. **审计页 / 工作台统计 / 定时 / 通知 / 导入导出**：1E 全部，1F 零触碰。**ReAct 循环 / dispatcher /
   gateway / bench 页 / 卡片协议**：1F 全部，1E 零触碰（1E 计划「不在 1E」原文已把「Agent 写工具与三档
   权限模式」推给二期，本批读工具面与它不重叠）。
7. **号段**：R142–R144 + D22–D30 是 1E 的（1E 计划「号段公告」自陈）；1F 用 R146+/D31+，R145 是 1D T8
   已落码的（代码里 grep 得到，不是预留）——三方号段互斥，见「号段公告」。

---

## 任务（checkbox = 状态；每任务尾部 = 门禁与自证）

### T0 · 元工具层骨架：手写注册 + 权限位 + 契约结构钉 ✅
- [x] `app/modules/agent/metatools/__init__.py` + `spec.py`：`register_metatools()` 把 ToolSpec 手工 register
  （R146 形状：`http=None`、`tool=True`、`resident=True`、`perm` 按取证 ⑦ 的两位、`model` 用各工具的 Pydantic 输入模型）；
  `main.py` 装配处 import 该模块触发自注册（与 @service 的 import-时注册同机制，只是手写调用点）。
  **结构钉（防假门的第一道）**：`grep -c "@service" app/modules/agent/metatools/*.py == 0` 的源码扫描例
  （R146 的账）+ `REGISTRY.perm_points()` 含 `agent:meta:read`/`agent:plan:write`（启动同步入库吃到）。
- [x] 工具名冲突自检：`REGISTRY.register` 重名即抛（registry.py:47-49 现成），测试喂一个重名 spec 钉它抛 RuntimeError
  ——元工具与 @service 同池，撞名要在 CI 红而不是启动炸。
- [x] **pyproject 默认零改动**（取证 ⑤：契约 1 不含 agent、契约 3 防的是别人 import agent）；
  测试目录加一条**结构例**：`app/modules/agent/**` 对 `app/modules/{schedule,notify}/**` 零 import
  （1E 在飞的防御——万一 1E 把什么塞进 agent，边界例先红先说）。
- **门禁与自证**：`pytest tests/test_agent_metatools.py -q` 骨架例绿；`ruff check app tests` 过；`mypy app` 0 错；
  `lint-imports.exe` 逐字 **`Contracts: 4 kept, 0 broken`**（退出码不算证据，README `:79` 的规矩）；
  变异自证：把一个元工具改用 `@service` 注册 → 结构扫描例红。

<sub>✅ **T0 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核）**：
`metatools/{__init__.py,spec.py}` 八件 ToolSpec 手写注册（§6.2 清单：读三件 + 卡片/计划五件），
`main.py:_SERVICE_MODULES` 尾部 +1 行触发自注册。实测：`pytest tests/test_agent_metatools.py -q` →
**7 passed in 0.29s**；`create_app()` 起真进程后 `REGISTRY` 里 resident=8、
`perm_points()` 两位齐（复核脚本亲测，不是照抄 agent 的话）；`ruff check app/modules/agent/metatools
tests/test_agent_metatools.py` → All checks passed；`lint-imports.exe` → 逐字 `Contracts: 4 kept, 0 broken.`；
`git diff --stat pyproject.toml` → 空（契约清单真没动）。变异自证红行：
`AssertionError: metatools 出现装饰器注册（蓝图口径回退）：{'spec.py': 1}` → 删行回绿。
**骨架的真实边界（不许当成做好了）**：八个 handler 全体 `raise NotImplementedError`——注册（schema/perm/
resident/审计面）是真的，功能一件没有；宁抛不装的理由写在 `_skeleton_handler` docstring：假结果会顺着
dispatcher 回注链骗过模型（纪律 1），异常则原样落 ok=False 审计。
**两处如实修正**：① `mypy app` 本轮**不是** 0 错——7 条全在并发中的 1E T4 文件
（`api_test/importers.py` 4 + `import_services.py` 3），metatools 自身 0 条，全仓 0 错留批次收尾复测；
② 取证 ⑤ 写「契约 1 = 八领域」已过期——1E T0 合入后契约 1/3 现在是 10/12 项（多了 schedule/notify），
对 1F 结论无影响（agent 仍不在契约 1），但「4 kept」清单内容比计划写成时宽。
⑧ `migrate_dev.py` 本轮未跑（1F 零迁移，本任务不涉库）。</sub>


### T1 · 读类元工具三件：get_project_outline / search_test_assets / search_tools
- [x] `metatools/read_tools.py`：
  `get_project_outline(project_id)` → 模块树 + 各类资产计数摘要（正向 import 领域 models，与 search 同构；
  输出 ≤2k token 截断口径写进 docstring）；
  `search_test_assets(project_id, kind?, keyword?, module?)` → R150：独立服务面 + `visible_clause` 同把尺 +
  返回 `meta:{mode:"keyword"}`（D34 的诚实标注：降级态如实说，不装双路）；
  `search_tools(keyword)` → 扫 REGISTRY 按名字/描述关键词回工具声明子集（§9.2 `:542` 分组级发现的一期最小实现：
  回声明 JSON 给模型「当轮载入」，不做上下文注入魔法）。
- [x] 三件全 `effect="read"`、`perm="agent:meta:read"`、`resident=True`；PLAN 模式可用（D31）。
- [x] 测试：outline 对演示库形状（计数与 workbench 口径一致性交叉断言一次）/ search_test_assets 回收资产不可见
  （visible_clause 回归，search 现有测试同尺）/ 越权项目 403 / LIKE 转义（"100%" 字面量，search 同款坑同款钉）/
  search_tools 关键词命中与空命中形状。
- **门禁与自证**：`-k "metatools or agent"` 全绿；ruff / mypy 0 错 / `lint-imports` **4 kept 0 broken** 逐字；
  变异自证：把 visible_clause 摘掉换裸 SELECT → 回收资产例红。

<sub>✅ **T1 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `d3f6766`）**：
`metatools/read_tools.py`（三个真 handler + Out 模型）+ `tests/test_agent_metatools_read.py`（13 例）+
`spec.py` 的 `REAL_HANDLERS` 回填口 + `__init__.py` 的 import 顺序钉。装配形状与原计划不同但等效：
spec 不认识实现模块（反向 import 会成环），实现模块尾部自登记进 `REAL_HANDLERS`，
`__init__` 钉「先 import 实现 → 再 `register_metatools()`」；领导用真注册表逐名核过 handler 落点：
读三件 → `read_tools.*`，卡片五件 → `spec._skeleton_handler`（骨架承诺未被顺手做掉）。
截断可观测：`meta` 带 `token_budget=2000/char_budget=4000`（1 token≈2 字符，docstring 已标「未实测」）
`chars_used/approx_tokens/modules_cut/truncated`——40 个长名模块喂进去钉 `truncated=True` 且 `chars_used<=预算`；
检索侧 30 行全局预算 + `meta.returned/truncated`。R150 兑现：`search_test_assets` 走
`shared/visibility.visible_clause` 与 Ctrl+K 同一谓词（变异自证：裸 SELECT →
`别人的私有定义在元工具面同样不可见` 当场红，回收态例同红 3 条）；`meta.mode="keyword"` 如实标降级。
计数互钉：同一份种子数据分别打 `GET /workbench-stats` 与 outline（`ToolDispatcher(mode="PLAN")`），
五个共享键逐键相等（outline 另计 `ui_element`，按设计排除在钉之外）。
越权码同源：`ensure_project_access` 的 `ApiError("forbidden",…,403)`，不存在的项目同码。
实测：`pytest tests/test_agent_metatools*.py -q` → **20 passed**；`-k "metatools or agent"` → **38 passed**；
`ruff check app tests` → All checks passed；`lint-imports.exe`（cwd=backend）逐字 `Contracts: 4 kept, 0 broken.`；
结构钉复扫 `metatools/*.py` 装饰器字面量 **0** 次（R146 未回退）。
**如实报的两处**：① 全仓 `mypy app` 当时剩 1 错，落在并发中的 `api_test/export_services.py:137`，
本任务文件 0 错；② token↔字符换算系数是估算不是实测（真分词器不在一期依赖里）。</sub>

### T2 · 卡片协议后端：ui 透传 + 五个卡片/列表型元工具
- [x] `runner.py` 的 TOOL_RESULT payload += `"ui": res.ui`（R148，一处）；REST 历史重放（`store.replay` 读同一事件）
  免费带上——测试钉「GET messages 与 SSE 事件里的 ui 字节一致」。
- [x] `metatools/card_tools.py`：
  `propose_scenario_plans(project_id, plans[])`——每个 plan `{name, intent, est_steps[], graph(§7.4 形状), env_hint, risks[]}`，
  **graph 先过 `scenario/graph.py` 的结构校验**（取证 ⑨：iter_nodes 复用；非法形状 → ok=False 回注模型自纠，
  不许把野 JSON 递给画布）；返回 `{ui:"card", card:{kind:"scenario_plans", plans:[...]}}`，**payload 自包含**
  （步骤预览 + 资产 id/名内联，前端零二次查询）；
  `ask_user(question, options[])` → `{ui:"card", card:{kind:"generic", form:"question", ...}}`（D32：不挂起）；
  `propose_plan(items[])` / `update_plan_item(id, state)` / `suggest_open_page(route, params)` →
  generic 卡 / 计划列表卡 / `{ui:"card", card:{kind:"generic", form:"open_page", route, params}}`；
  `suggest_open_page` 的 route **白名单常量表**（bench/scenes/scene-detail/reports…取自 shell.tsx 现行导航），
  白名单外 ok=False——「界面能配、跳了 404」是纪律 1 的假功能形状。
- [x] 五个全 `effect="read"`（D31）、`perm="agent:plan:write"`；kind 值域常量 `{"scenario_plans","report_summary","device_status","generic"}`
  与 §12.2 `:1570` 逐字对齐（单测钉枚举相等，防手滑改名）。
- [x] ui 值域校验：dispatcher 或 card_tools 出口断言 `ui ∈ {None,"card","approval","diff"}`（§12.2 值域），
  越界 = 编程错误直接抛（回注模型救不了协议违反）。
- [x] 测试：每工具的形状/校验拒绝/审计行（entry="agent"，dispatcher `_audit` 现成）；
  ui 透传端到端一例（FakeGateway 喂 `propose_scenario_plans` 调用 → 事件流里 TOOL_RESULT.ui=="card"）；
  graph 非法 → ok=False 且 error 人话；route 白名单外拒绝。
- **门禁与自证**：`-k "metatools or agent"` 全绿；mypy/ruff/`lint-imports` 同上；
  变异自证：删 runner 的 `"ui": res.ui` → 透传例红（这条就是取证 ③ 断管的反向钉）。


<sub>✅ **T2 落地证据（2026-11-17 实跑，agent 实现 + 领导逐条复核，commit `b1c2017` + `405b66c`）**：
`metatools/card_tools.py`（五件真 handler + `CARD_KINDS`/`UI_KINDS`/`OPEN_PAGE_ROUTES` 常量 +
`_card()` 出口值域断言）+ `runner.py` 一处 `payload["ui"] = res.ui` + `__init__.py` 自登记接法 +
`tests/test_agent_metatools_cards.py`（9 例）+ `fixtures/fake_model/card_plans.jsonl`。
领导复核实测：`test_agent_metatools*` 三文件合跑 **30 passed**、`-k "metatools or agent"`
**48 passed**、`mypy app` **Success: no issues found in 127 source files**、
`lint-imports` 逐字 **`Contracts: 4 kept, 0 broken.`**、`git diff pyproject.toml` **空**（R147 零依赖改动）。
变异自证：删掉 `payload["ui"] = res.ui` → `test_ui_passthrough_end_to_end` KeyError 红（取证 ③ 的反向钉）。
REST 重放与 SSE 帧**逐事件 `json.dumps` 字节相等**——「断线重连卡就没了」这条路从构造上不存在。

三条要记账的落地形状：① `update_plan_item` 的完整列表源是**进程内存槽**（零迁移承诺下不落表），
服务重启槽丢 → ok=False 提示先调 propose_plan；② `propose_scenario_plans` 按 **≥2** 硬门实现
（比蓝图 §9.7「1~3 个候选」更严：单候选没有可选项），若业主裁定 1 个也能出卡只放宽一个常量；
③ 路由白名单是**钉死值的对账测试**而非运行时读 shell.tsx——所以 web 侧加导航必须同批改这里：
`b6f93df` 落地 `/schedules` 时漏改（提交信息说了要改却没 stage 后端），由 `405b66c` 补上，
现在两侧实测同为 14 条。这条纪律的代价就摆在两处提交记录里，别删。
</sub>

### T3 · 卡片协议前端：共享渲染组件 + 操作回写用户消息
- [x] 新建 `web/src/agent/cards/`（协议是通用件，§9.7 `:607`——**不许写死进 bench.tsx**）：
  `types.ts`（`CardPayload = {kind, ...}`，kind 枚举与后端常量同源注释互指）、
  `registry.ts`（`registerCard(kind, renderer)` + `renderCard(payload)`——审批卡/报告摘要卡/设备状态卡
  后续注册自己的 kind 即复用，这就是 `:607` 的兑现点）、
  `ScenarioPlansCard.tsx`（候选场景卡：每卡名称/覆盖意图/**步骤预览列表**/风险点 + [画布预览][选择] 两钮，
  §11.4.30/§9.7 `:600-601` 的草图形状；**[保存] 不出现**——出现在卡片上就该恒 disabled 提示「二期开放」，
  放选择钮旁的 secondary 文案即可，别造能点的假钮）、
  `QuestionCard.tsx`（ask_user：问题 + 选项按钮组）、`PlanListCard.tsx`（propose_plan/update_plan_item 的
  目标计划列表，§11.4.33 状态点 pending/doing/done/skipped）、`OpenPageCard.tsx`（suggest_open_page：
  [前往] 按钮走 react-router，参数拼查询串）。
- [x] `EventCard.tsx` 只加一个分支：`kind==="TOOL_RESULT" && p.ui==="card" && p.content?.card` → `renderCard`，
  渲染器未注册的 kind 落**折叠的原始 JSON + 「暂不支持的卡片类型」人话**（未知 kind 不白屏不装渲染）。
- [x] 操作回写（R149/D32）：卡片按钮的回调经 props 注入的 `onUserMessage(text: string)`，bench.tsx 传入
  「拼可读前缀 + 调 POST messages」的实现——cards/ 目录**不认识** fetch，协议组件与页面解耦（vitest 好钉）。
  运行中（status==="运行中"）卡片按钮 disabled + 文案「等本轮结束」——复用现有忙语义，不排队不吞点击。
- [x] vitest：`registry.test.ts`（注册/分派/未知 kind 兜底）、`ScenarioPlansCard.test.tsx`（≥2 卡并排渲染、
  步骤预览逐行、点[选择]回调收到含方案名的文本、[保存]字样只以 disabled 提示存在）、
  `QuestionCard.test.tsx`（点选项回写）、`PlanListCard.test.tsx`（同名工具最新结果覆盖渲染——update_plan_item
  的「原地更新」口径）。
- **门禁与自证**：`pnpm test` vitest 基线（当前 README 记录 231/16）**只增不减**；`pnpm lint` 0 errors 基线不破；
  `tsc --noEmit` 0 错；变异自证：把 registry 分派摘掉 → TOOL_RESULT(ui=card) 走默认 JSON 折叠，
  ScenarioPlansCard 例红（证明渲染真的走协议而不是走 tool_name 硬编码——`:607` 通用件的反向钉）。

<sub>✅ **T3 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `014208b`）**：
`web/src/agent/cards/`（types/registry/index/四张卡/fold + 4 个测试文件）+ `EventCard.tsx` 一个分支
+ `bench.tsx` 注入（`sendText` 的 `[卡片操作] ` 前缀、`cardCtx.busy`、`foldPlanListCards` 一处调用）。
分派键是 `kind`，generic 再走 `kind:form` 二级键（`cardRegistryKey`）——`cards/` 零 fetch、零 tool_name 硬编码。
假门三处按纪律 1 处理：[画布预览] 恒 disabled + Tooltip（路由归 T4）、「保存（二期开放）」只是 secondary
文案、`cardCtx` 缺省时按钮恒 disabled（没接回写的宿主不开门）。未知 kind 折叠原始 JSON + 人话。
实测：`npx vitest run src/agent/` → **22 passed / 5 files**；全量 vitest → **293 passed / 27 files**
（领导在 T3 之前实测地板是 260/20，T3 贡献 +22/5，余 +11/2 是并发中的 1E T5 `api.test.tsx`）；
`pnpm lint` 0 errors（新文件 0 warning；第 8 条 warning 在 `api.test.tsx`，非本批）。
变异自证：`renderCard` 直接 `return null` → ScenarioPlansCard **6 例全红**
（`Unable to find an element by [data-testid="plan-select"]`）→ 复原回 22/22；
测试只经 `renderCard` 渲染、不直连组件，所以这次红真的证明了渲染走协议。
**与本页原文的一处口径补充**：分支条件除 `ui==="card" && p.content?.card` 外还加了 `p.ok !== false`——
工具调用失败时不该渲染成卡片（失败形状落默认 JSON 折叠），原文没写这条，属实现补的防守，认可保留。
**待与 T2 逐字对齐的三处（T2 落地必须回头核，别各说各话）**：① `generic` 的 `form` 取值
（本批先定 `question`/`plan_list`/`open_page`，T2 计划原文只说「计划列表卡」未定字面量）；
② `plan_list` 的 items 字段名（本批 `{id,text,state}`）；③ `ask_user` 的 options 是否要带自由输入框（计划未定，现只渲染选项组）。
领导已在 T2 派发词里把 ①② 作为对齐项写进要求；两侧「单测钉枚举相等」等 T2 落地后才能合拢。
**未实测**：SSE 与 REST 重放里 `ui` 字节一致（T2 的 runner 还没有 `ui` 字段）——端到端留 T2/T6。</sub>

### T4 · 候选卡 → 画布只读预览 + 「保存（二期开放）」
- [x] 新路由 `/scene-preview`（D33 假设 b）：payload 经 `sessionStorage`（键 = run_id + plan_index，
  刷新可重进；不走查询串——graph 超 2k 字符 URL 会炸）；页面 = `Canvas readOnly` + 顶部说明条
  「Pilot 候选预览（未落库）」+ **[保存为正式场景] disabled + Tooltip「二期开放」**
  （§4 `:206` scenario_draft 二期、§13 `:1604` create_scenario 转正二期——文案逐字用「二期开放」）。
- [x] `scene/store.ts` 加 `loadCardGraph(graph)`（照 `loadReport` 形状，取证 ⑧；不带 result 染色层——
  候选没跑过，**别复用 loadReport 塞假 result 装执行过**）。
- [x] ScenarioPlansCard 的 [画布预览] → 写 sessionStorage → `window.open`/新 Tab 跳 `/scene-preview?k=…`
  （同 Tab 跳会丢 bench 会话现场，e2e 与业主演示都更要新 Tab）。
- [x] vitest：store.loadCardGraph 往返（graph 序列化/反序列化一致性——1B 的「画布序列化必测往返」同款纪律）；
  e2e 见 T6。
- **门禁与自证**：vitest 基线只增不减；`tsc --noEmit` 0 错；预览页对非法/过期 sessionStorage 键
  渲染人话空态（不白屏）；门禁 ⑤⑥ 全绿 + 后端四道（本任务纯前端则后端引上一任务数字，README 注明）。


<sub>✅ **T4 落地证据（2026-11-17 实跑，agent 实现 + 领导逐条复核，commit `6cccb00`）**：
`agent/cards/previewLink.ts`（纯模块：键、读 + 三态校验、URL、可预览判定）+
`pages/scenePreview.tsx`（懒载，@xyflow 不进 bench 渲染面）+ `scene/store.ts` 的 `loadCardGraph` +
`store.cardGraph.test.ts`（4 例）+ `scenePreview.test.tsx`（5 例）+ ScenarioPlansCard 接真。
领导复核实测：`src/agent + src/scene + 预览页` **72 passed**、全量 **337 passed / 33 files**、
`npx tsc --noEmit` **0 错**、`pnpm lint` **0 errors / 8 warnings**（warning 全在他人既有文件）。
[保存为正式场景] 恒 disabled + Tooltip「二期开放」原文照用（`scenePreview.tsx:62-66`，
disabled 按钮不触发 hover 所以外层 span 拿事件）；顶部说明条「Pilot 候选预览（未落库）」；
三种坏键各有文案（键没了 / JSON 读不出 / 缺 nodes），存储写失败只 toast 不演已打开。
变异自证：把 `loadCardGraph` 的深拷贝改成丢 `config` → 往返例红（1B「序列化必测往返」同款纪律）。

与计划的两处分歧（照实记）：① 计划写「键 = run_id + plan_index」，但前端信封只有
`{seq,ts,type,payload}`——SSE 与 REST 重放都不带 run_id（`agent/sse.ts` 头注实证前端从没读过它），
实现退为**点击期生成的 token** 作 run 段，键形态与「刷新可重进」语义等价，后端日后带 run_id 只换一行；
② 任务描述称 `Canvas.tsx:41` 有 `readOnly` prop——实际 `Canvas()` 不接 props，readOnly 由 store 读
（`store.ts` loadReport 置真），预览页与 reportDetail 同构实现，Canvas 组件零改动。
</sub>

### T5 · 假模型回放夹具钉死「3 轮内 ≥2 卡」DoD
- [x] `tests/fixtures/fake_model/two_candidate_plans.jsonl`：脚本回合 =
  ①thinking + `get_project_outline({{PID}}…)` ②`search_test_assets(keyword="登录")`
  ③`propose_plan`（目标计划列表）④`propose_scenario_plans` 两方案，plans 里的资产 id **全部走
  `{{TR:search_test_assets:content.items.N.id}}` 引用**（取证 ⑫：源工具没结果就抛——「基于项目真实资产」
  因此是机器可检的，夹具编不出不存在的 id）⑤收敛 TEXT。
- [x] `tests/test_agent_dod_cards.py`：演示库 seed 上跑全链（set_gateway_factory 注 FakeGateway）→
  断言：run DONE；**TOOL_RESULT(ui=card, card.kind=scenario_plans) 事件里 plans.length ≥ 2**；
  plans 引用的每个 asset_id 回库真查得到且可见；**用户消息回合数 ≤ 3**（D35：单 run = 1 轮，从严）；
  审计里三个元工具各有一行 entry="agent"。**这条红 = §1.5 `:51` 判据第 1 条没闭合**。
- [x] 回归夹具补一份 `ask_user_flow.jsonl`（ask_user 卡 + 不挂起 run 直接 DONE，D32 的形状钉）。
- **门禁与自证**：`pytest tests/test_agent_dod_cards.py` 绿 + `-k agent` 回归全绿；
  变异自证：把 plans 里一个 TR 引用改成不存在的字面 id → run ERROR（宁抛不装绿，gateway.py:64 机制）→ 例红。

### T6 · e2e 演示路径 + 演示手册 + 八道门禁收尾
- [x] `web/e2e/pilotCards.spec.mjs`：bench 起会话（演示项目模型 = `fake://two_candidate_plans`——
  演示模型走行：seed 一条 `base_url=fake://…` 的 CHAT 模型配置，1A 金线先例）→ 发「创建一个登录功能的回归测试」→
  **候选卡 ×2 进 DOM、步骤预览非空** → 点[画布预览] 新 Tab 只读画布出节点 + [保存] disabled 文案「二期开放」→
  点[选择] 回写用户消息进事件流。诚实口径：这条 e2e 钉的是**协议 + 渲染 + 路径贯通**，模型智能见下条。
- [x] `README-1f-demo.md`：业主真模型演示手持路径（模型配置中心配网关 → bench 选它 → 真问一句话）+
  **显式声明：真模型下「3 轮 ≥2 卡」的内容质量靠 nightly/人工验收，门禁只保协议与回放路径**
  （§14 `:1623` 原文「真模型冒烟测试放 nightly，不进 PR 门禁」——这就是「需要真模型的部分不进门禁」的白纸黑字）。
- [x] 哨兵翻真（取证 ⑬）：`scenes.tsx:244-250` 菜单项改跳 /bench；`workbench.tsx:254` disabled 钮同改
  （撞车面见「与 1E 的边界」④）；`nav.spec.mjs` 失效哨兵同批改。
- [ ] 收尾：八道门禁全跑（①pytest ②ruff ③mypy ④`lint-imports.exe` 逐字 `Contracts: 4 kept, 0 broken`

<sub>**落地**：T5 = `f732dea`（4 passed，两发变异自证）；T6 = `8a3b3ef`（e2e 2 用例 + README-1f-demo + 
两处哨兵翻真：scenes 新建菜单此前是 Modal.info 说明占位、workbench 的钮此前 disabled + title「1F 开放」，
现在都真跳 /bench，各有「点击→URL→页面可见」的断言）。

**顺手修掉一处真 flake**：作者报「连跑 3 次全绿」，主线实测合跑连红 2/2——`testpilot_e2e` 跨轮次保留，
每跑一遍多留一条 `fake://` 模型配置，第 2 个用例起下拉里已有 5 条同前缀项，而 antd 虚拟列表
**不渲染视口外的项** → 目标项根本不在 DOM 里，120s 超时。修法是让它可搜：`bench.tsx` 的模型 Select
加 `showSearch` + `optionFilterProp` 按 label 过滤，spec 里键入配置名把候选收敛成 1 条。
通用教训：**e2e 里凡是「造一条具名数据再从下拉选它」都必须带搜索过滤**，因为 e2e 库只增不清。</sub>

<sub>**门禁实测（历史轮，`8a3b3ef` 时点，主线自己跑，不引 agent 数字）**：⑦ 全量 `pnpm build:e2e && npx playwright test` = 
**91 passed / 2 skipped**（4.1m；改前本批次口径 79/2）；`nav+scenes+pilotCards` 合跑 5 passed；
⑥ `pnpm test` 358 passed / 36 files + `tsc --noEmit` 0；⑤ eslint 0 errors / 8 warnings；
② ruff All checks passed；③ mypy Success（131 files）；④ 逐字 `Contracts: 4 kept, 0 broken`。
**① 只跑了子集**（`-k "metatools or agent"` 52、schedule/notify 全家等），**全量 pytest 本轮未跑**，
所以上面「收尾：八道门禁全跑」一行按规矩**不勾**——「一次绿不算绿」同样适用于门禁本身，
别让子集冒充全量。README 门禁数字滚动同样留给后到者（并发规矩）。</sub>

<sub>**门禁补账（2026-11-17 对账轮重测，只动本文件）**：⑥ `npx vitest run --reporter=basic` 本轮实跑
= **378 passed / 36 files**（与主线 2026-11-17 量到的同数互钉）；后端矩阵 `pytest tests/test_permission_matrix.py
--collect-only -q` 本轮实取 = **151 tests collected**（本文件此前无矩阵计数宣称，无账可对，数字入档备查）；
② `ruff check tests` 本轮实跑 = All checks passed。**⑦ 全量：未重跑，不作数**——上次全量基线 91 passed /
2 skipped 是 `8a3b3ef` 轮的，此后 `web/e2e/scheduleNotify.spec.mjs`（`387b165`）与 `web/e2e/importWizard.spec.mjs`
（`8375dab`）各加了用例，91 已不是当前树的下界；**⑧ 未执行**——demo 共享库禁跑迁移（库实测停在 0020、
仓库链头 0022，见 1G 计划同轮记录），等业主授权后由主线跑 `0020→0022`。收口条 checkbox 照规矩继续不勾。</sub>

  ⑤eslint ⑥vitest ⑦`pnpm build:e2e && playwright test` ⑧migrate_dev——1F 无迁移，⑧ 只核对 head 未动）；
  数字进 README（后到者改规矩）；台账 R146–R150 按落地形状回填本文件；D31–D36 落地情况逐条标注；提交。
- **门禁与自证**：⑦ 里 `pilotCards.spec.mjs` 连跑 3 次全绿才报数（D11 的教训：一次绿不算绿）；
  e2e 失败快照如实贴 README，不掩盖。
