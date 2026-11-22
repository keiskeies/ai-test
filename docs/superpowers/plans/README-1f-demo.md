# 1F 演示手册（业主版 · 20 分钟）

> 目标：亲眼看一遍 1F 新增的那条链——**bench 发一句话 → Pilot 基于项目真实资产给出
> ≥2 张候选场景卡 → 点[画布预览] 新 Tab 只读画布 → 预览页顶栏明写「Pilot 候选预览
> （未落库）」、[保存为正式场景] 点不动（Tooltip「二期开放」）→ 点[选择] 回写用户消息**。
>
> **一句话诚实承诺（本批最重要的一句）**：门禁与这条 e2e 钉死的是**协议 + 渲染 + 路径
> 贯通**，不证明「真模型足够聪明」。§14 `:1623` 原文「真模型冒烟测试放 nightly，不进
> PR 门禁」——真模型下「3 轮内 ≥2 卡」的内容质量靠 nightly/人工验收；仓库里的证据全部
> 跑在假模型回放夹具上（`backend/tests/fixtures/fake_model/two_candidate_plans.jsonl`，
> T5 钉死的那份）。演示有两条路：路 A 假模型回放（确定性，§3）、路 B 真模型（§4）。
>
> 装环境那套（MySQL/Redis/.env/建表/起平台）与 1D 手册 §0.1–§4 完全通用，跑过 1D 的
> 机器直接从 §1 开始。**1F 零迁移**：链头仍是 0021/0022（1E/1G 的），1F 没碰 alembic。

## 1. 环境与入口（2 分钟）

- 起平台照 1D 手册 §4（后端 8320 + worker + 前端 5173）。**1F 的 agent run 在 HTTP
  进程内起 asyncio 任务**（`agent/tasks.py` 的 `accept_message`：建 run →
  `asyncio.create_task`），**不经 Celery worker**——所以 1F 演示只起后端 + 前端就够，
  worker 留给执行类动线。
- 入口（1F T6 哨兵已翻真，两处都是真跳转，不再是说明占位）：
  - 工作台右上角 **「让 Pilot 生成」** → 跳 Pilot 试验台（`/#/bench`）；
  - 场景编排 →「新建场景」下拉 → **「让 Pilot 生成」** → 同样跳试验台；
  - 侧栏的入口叫 **「Pilot 试验台」**（`layout/shell.tsx` 的 `nav-bench`），工作台快捷位叫
    **「问 Pilot」**（`workbench.tsx` 的 `pilot` 项）——两个名字都存在，侧栏没有第二个「问 Pilot」。
    （设备页还有第三个说法「让 Pilot 排查」，那是 D84 的预填入口，只填不发。）
- 进 bench 后左上角先**选项目**（挂载时自动预选当前项目卡选中的那个）。

## 2. 演示前提：项目里要有真资产（1 分钟）

候选卡的 graph 节点引用**项目内真实资产**：工具侧有一道可见性硬门
（`card_tools.py`：ref 解析不到本项目可见资产 → 该次出卡 ok=False，宁抛不装绿）。
所以先确认演示项目（如 seed 的「演示商城」）里至少有 **2 条名字含「登录」的接口用例**
（注意口径：`search_test_assets kind=api_case` 只 LIKE **用例名**（`ApiCase.name`），
接口**定义**名检索不到——seed 那条叫「登录获取令牌」的是定义，不算数。
这两条现在由 seed 幂等自动补齐：**「登录冒烟」** 与 **「登录冒烟（重试）」**（同挂定义
「登录获取令牌」、同名不同、全继承）。老手册让人去接口页手动新建第二条的步骤已取消——
你现在要验证的只剩一条：跑过 seed 后，用例页「登录获取令牌」下**两条都在**，
§3 发那句话时候选卡的检索就会命中 2 条（`items.0`/`items.1` 各指一条）。

> 假模型脚本检索关键词固定是「登录」（`two_candidate_plans.jsonl` 第 3 行
> `search_test_assets keyword=登录 kind=api_case`），脚本尾部硬引用 `items.0` 与 `items.1`
> 两条结果，检索不到两条真用例就抛、run 如实 ERROR——这正是「基于项目真实资产」机器可检的机制。
> **抛出来的话有两类**，别只认一种（`agent/gateway.py` `_walk`，D157 后全带人话）：
> 命中不足 2 条（1 条或 0 条）→ 「TR 路径不可达: content.items.1.id（段: 1）」——
> 0 条曾是裸 `IndexError`「list index out of range」，已与人话同治
> （`test_agent_gateway_tool_refs.py` 钉死）；
> 被引用的工具**压根没跑出结果** → 「TR 引用了尚无结果的工具: …」（这条一般是夹具被人动过）。

## 3. 路 A：假模型回放演示（确定性，5 分钟）

假模型 = `base_url` 以 `fake://` 开头的 CHAT 模型配置，回放 JSONL 脚本
（`app/shared/fakeuri.py` 约定：`fake://<名>` → `backend/tests/fixtures/fake_model/<名>.jsonl`）。

1. **登记假模型**：设置 →「模型配置」（仅平台管理员可见此 Tab）→ 对种子卡（fake-basic）
   点[编辑]，或经 API `POST /api/v1/model-cfgs` 新登一条：
   - 名称随意（如 `fake-two-cand`）、`base_url` = `fake://two_candidate_plans`、
     模型名随意。
   - 注意：**UI 卡片墙只给已登记模型【编辑】，不给新增**（1E T8 的形状）；新增走 API
     或改现有种子卡。e2e 就是走 API 新登一条、 bench 里显式选它，不动默认。
2. **bench 选模型**：进试验台 →「开始新会话」→ 右侧「模型」选择器选 `fake-two-cand`
   （默认是 fake-basic，**不选它就不会出候选卡**）。
3. **发 DoD 那句话**：输入 `创建一个登录功能的回归测试` → 发送。

你会看到（与 `web/e2e/pilotCards.spec.mjs` 钉的同一套）：
- 事件流按序：THINKING（「先盘点项目资产…」）→ **四个工具**（`get_project_outline`、
  `search_test_assets`、`propose_plan`、`propose_scenario_plans`）的调用/结果行按序滚出，
  其中前两个挂蓝色「只读」标；`propose_plan` 与 `propose_scenario_plans` 的
  **TOOL_RESULT 各自渲染成卡**（计划列表卡 / 两张候选场景卡），但它们的 **TOOL_CALL 仍是普通行**
  ——所以视觉上是 6 条普通工具行 + 2 张卡，别按「三个 TOOL_CALL」去数（`EventCard.tsx`：
  卡片分支只接管 `ui==="card"` 的 TOOL_RESULT）；
- 卡面（方案 A「登录冒烟（方案A）」/ 方案 B「登录重试（方案B）」）：
  - 「覆盖意图：覆盖登录成功主链路」（B 卡是「覆盖登录抖动重试」）；
  - 「步骤预览：」有序列表非空（A 卡：调登录接口 / 断言返回码；B 卡：while 重试登录 /
    断言最终成功）；
  - 「风险点：依赖造数」「环境建议：本地环境」——**这两栏只有 A 卡有**：
    夹具里方案 B 没给 `risks` / `env_hint`，卡片按字段条件渲染（`ScenarioPlansCard.tsx`：
    `risks.length > 0` 才出「风险点」、`env_hint` 才出「环境建议」）。B 卡上找不到这两行不是丢渲染。
  - 三个动作：**[画布预览]**、**[选择]**、旁边一句灰字 **「保存（二期开放）」**——
    [保存] 根本不出现为可点按钮（§13 纪律 1：能点但后端不认就是假门）；
- 最后一条 TEXT：「已基于项目真实资产给出 2 个候选方案，请选择。」+ USAGE 条，状态回「空闲」。

4. **点 A 卡的[画布预览]**：新开一个标签页（同 Tab 跳会丢 bench 会话现场）。你会看到：
   - 顶部说明条：**「Pilot 候选预览（未落库）」**＋「方案「登录冒烟（方案A）」是 Pilot
     给出的候选，尚未保存为场景，仅在此只读预览。」；
   - 右侧 **「保存为正式场景」按钮是灰的（disabled）**，悬停 Tooltip 逐字
     **「二期开放」**（§4 `:206` draft 表二期 + §13 `:1604` create_scenario 二期）；
   - 只读画布真渲染出方案 A 的节点（单节点「登录冒烟」；B 方案是 while 重试容器套
     登录步骤）。拖不动、右键菜单不给编辑口子——只读由 store 关死（同报告详情画布）。
   - 这个页面刷新不丢（payload 走 sessionStorage）；直接瞎拼 URL 进来会看到三种
     人话空态之一（「预览内容不存在 / 读不出来 / 不是可画的场景图」），不白屏。
5. **回 bench 点 B 卡的[选择]**：事件流尾部出现一条用户消息卡
   **「[卡片操作] 选择方案：登录重试（方案B）」**——卡片动作真的回写成一条用户消息
   （走既有 POST messages），不是纯前端高亮。

## 4. 路 B：真模型演示（手持，10 分钟）

1. 设置 →「模型配置」→ [编辑] 现有 CHAT 卡（或 API 新登），`base_url` 填真网关
   （`.env` 先例：`http://127.0.0.1:9000/v1`，OpenAI 兼容）+ 真 API Key；
   点[连通性测试]看逐能力徽标（tools 必须 ✓，否则 Pilot 不能调工具）。
2. bench 选它 → 同样发「创建一个登录功能的回归测试」（可再加自由问题）。
3. 该看到什么：形状与路 A 同构（候选卡/预览/选择都走同一份渲染与协议代码），
   **但方案名、步骤内容完全取决于模型**——出几张、语义合不合理，门禁不背书。
4. **未实测声明（照实说）**：本手册的撰写机器上没有可达的真模型网关，路 B 的每一步
   未在撰写环境实跑过；出卡下限（3 轮 ≥2 卡）由假模型回放钉死（T5，
   `test_agent_dod_cards.py` 4 passed），真模型质量按 §14 走 nightly/人工。

## 5. 门禁与回归（读数字，不用跑）

**八道门禁命令与 README.md「提交前必跑」逐字同源，本手册不抄死数字**（抄了就会过期）。
1F T6 本轮（2026-11-17）实测：

| 门禁 | 本轮数字 | 口径 |
|------|----------|------|
| ① pytest | 后端引上一批数字（T5 轮 `f732dea`：本文件 4 passed；`-k "metatools or agent"` 52 passed） | 1F T6 零后端改动，不重跑全量 |
| ② ruff | All checks passed（`f732dea` 同轮） | 同上 |
| ③ mypy | Success: no issues found in 127 source files（`f732dea` 同轮） | 同上 |
| ④ lint-imports | Contracts: 4 kept, 0 broken（`f732dea`/`8b22c6c` 同轮） | 同上 |
| ⑤ pnpm lint | **0 errors / 8 warnings**（本轮实跑；warnings 全是 react-hooks/exhaustive-deps） | T6 实跑。**两笔纠偏（2026-11-18）**：① 构成说错了——T6 那棵树上的 8 条是 7 条 `react-hooks/exhaustive-deps` + 1 条 `@typescript-eslint/no-unused-vars`（`api.test.tsx` 未用形参 `init`），README「提交前必跑」的对账轮已把这条账纠过；② 条数只在当时那棵树成立，**当前树实跑 `npm run lint` 是 0 errors / 7 warnings**（那条 `no-unused-vars` 随形参一起被后续轮次删掉了）——照本行数字验收今天的主线会以为少了告警是好事 |
| ⑥ vitest + tsc | **378 passed / 36 files**；`tsc --noEmit` 0 错（2026-11-17 主线对账轮实测，当前树） | 原记「352 passed / 35 files·T6 实跑」系误挂——35 files 是 1G D38 轮（`20d5d7e`）的树，T6 树本轮 `git ls-tree` 核得有 36 个测试文件，352/35 不可能是 T6 量出来的。**再纠一笔**：这里的「当前树」是 11-17 那个提交点的当前树，今天的树 `web/src/**/*.test.*` 已有 90 个文件、README「提交前必跑」最新一行的 vitest 数字远高于 378——本行是**历史读数**，验收请以 README 同一节里最新一行为准 |
| ⑦ playwright | **本轮范围：nav + scenes + pilotCards 三文件 5 passed（20.1s，workers=1）**；`pilotCards.spec.mjs` 单独连跑 3 次全绿（7.1s/7.3s/7.3s，D11 教训「一次绿不算绿」） | T6 实跑；跑时 8321/5173 空闲（T6 独占） |
| ⑧ 迁移 head | 1F 零迁移：alembic heads 本地核对 = **0022 (head)**，未动任何库 | T6 核对（未对共享库跑 migrate） |

e2e 自己的库（testpilot_e2e）由 `playwright.config.ts` 的 webServer 自动 `alembic upgrade
head`，跑 e2e 不需要、也**绝对不该**手动对 demo/dev 库跑 migrate_dev.py。

## 6. 三个「为什么长这样」

**6.1 为什么 [保存] 在候选卡上根本不出现、在预览页只是灰钮？**
`scenario_draft` 建表与 create_scenario 转正是二期点名项（§4 `:206`、§13 `:1604`），
1F 零迁移。灰钮 + 「二期开放」Tooltip 是诚实哨兵；变成能点会写库的按钮才是假门。

**6.2 为什么预览要开新 Tab？**
同 Tab 跳走会丢 bench 会话现场（SSE 流、已发的事件）。payload 走 sessionStorage 不走
URL：graph 超 2k 字符查询串会炸（计划 T4 原文），键 = 前缀 + 唯一 token + 方案下标，
刷新可重进。

**6.3 为什么「选择」回写的是「[卡片操作] …」前缀的消息？**
卡片动作复用既有 POST messages（R149/D32），前缀让事件流里一眼分清「人打的字」和
「点卡片的动作」，审计与重放都诚实。

## 7. 常见问题

**Q：发了话只出计划列表卡，不出候选场景卡。**
A：十有八九是没选假模型——默认模型是 `fake://basic_two_tools`（两个通用工具，
不会调 `propose_scenario_plans`）。右侧「模型」选择器换 `fake://two_candidate_plans` 那条。

**Q：run 直接 ERROR。**
A：假模型的链式引用要求前面几步真的跑出结果，报错原文分三种（§2 的框），别只认一句：
「TR 路径不可达: content.items.1.id」= 检索到的「登录」用例只有 1 条（§2 的前提没做够）；
「list index out of range」= 一条都没检索到（裸 `IndexError`，后端对 list 越界没写人话，
这是已上报的产品缺口 D157，不是你的操作错）；
「TR 引用了尚无结果的工具: X」= 夹具里 X 这个工具压根没被调用过（一般是 `two_candidate_plans.jsonl` 被动过）。
三种都是设计使然：宁抛不带占位符继续。

**Q：run 是 DONE 但候选卡没出来。**
A：看 `propose_scenario_plans` 的结果卡是否标「失败」：卡片侧可见性硬门
（`card_tools.py`）会拒「不存在/已回收/无权限」的资产引用，错误原话写在卡的 JSON 里。

**Q：预览页显示「预览内容不存在」。**
A：sessionStorage 的键随标签页会话走——关过原标签页或清过浏览器数据就失效，
回 bench 重新点[画布预览]即可。

**Q：点[选择]提示「先开始会话再操作卡片」。**
A：卡片操作要求会话已建立（首轮消息发过）；运行中点按钮不会排队也不会吞——
钮直接灰着，旁边写「等本轮结束」。

## 8. 1F 交付边界（诚实清单）

**已可用**：候选场景卡（≥2 卡、步骤预览/风险点/环境建议）、画布只读预览（新 Tab、
banner「未落库」、坏键三人话空态）、[选择] 回写、计划列表卡原地更新、
工作台/场景页两个 Pilot 入口翻真（跳 /bench）、e2e 演示路径（`pilotCards.spec.mjs`）。

**二期（灰着并明说）**：[保存为正式场景]（「二期开放」）、页面审批门、
`report_summary`/`device_status` 渲染器、MCP/Skills、向量检索路、`/compact`。

**不在任何批次的承诺里**：真模型内容质量（nightly/人工，§14 `:1623`）、
「另存为正式场景」的一键迭代闭环（依赖 draft 建表）。
