# 1B 场景编排与执行引擎 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本文件即 1A 收尾时承诺的「开工 1B 前先写出的计划」。实现前若与本文件冲突，先改本文件再改代码，冲突不可静默吞掉。

> **✅ 本批次已完成（2026-11-16 回填）**——下面 38 个未勾 checkbox 是**写法陈旧，不是待办**：1B 收尾时没人回来逐格打勾。别照这些格子找活干（S0/1A/1C 同此口径）。
> 完成的证据：**git tag `1b-scenario-engine`**｜**逐条完成判据见 `## 完成判据（= §13「1B」条目逐条 + 1A 之后的 DoD）`**｜**R 序台账：本文件内 R41 起至 R88**（本批次起才有 R 号）｜演示手册 `docs/superpowers/plans/README-1b-demo.md`｜提交前缀 `(1b)` / `(1b手册)`。
> 后续批次改用「`### TN · …` 标题带 ✅ + 尾部 `**落地证据（commit XXXXXXX）**` 段 + 门禁实测数字」的口径（见 1D），**新批次以 1D 为格式模板**，不再依赖本文件的 checkbox。

**Goal:** 一期 1B 落地——step_graph 步骤树协议（§7.4 全 kind 一期白名单）、真实执行引擎（Celery worker 跑批，API 类 handler + 全逻辑控件 + 脚本沙箱）、SSE 实时进度（断线续传不丢步）、场景画布 + 列表双模式、报告中心（列表 + 三栏详情 + 只读画布结果着色）、失败单步重跑、取消与超时、Ctrl+K 全局快捷查找。业主可演示「把若干接口用例编排成场景 → 调试/执行 → 画布节点逐步呼吸高亮 → 报告里看每一步请求响应断言 → 对失败那一步单独重跑」。

**Architecture:** 延续工具化单体（一切能力仍是 `@service` 五路同生），新增两条腿：① 领域模块 `app/modules/scenario/`（场景资产 + step_graph 协议与校验 + 引擎 handler 注册表）；② 顶层 `backend/app/worker.py`（Celery app + `run_scenario` 任务），执行链按 §8.1/§8.7 走 **L2 Worker**，Agent 交互保持在 L1 Web 进程——这是业主锁定决策 D5 的兑现点。跨模块取数一律经 `REGISTRY.get(name).handler(payload, ctx)`（既有 `_resolve_via_importlinter` 友好手法，见 api_test 的 `_resolve_via_registry`），**不 import 领域模块**。执行核（单请求发送 + 断言）复用 1A 的 `execution.core.run_api`，不复制第二套发请求的代码。

**Tech Stack:** 同 1A + 新增：后端 `celery`（已在 venv，5.7.0；Windows 用 `--pool=solo`，见「前置取证」）；前端 `@xyflow/react@12`（画布）+ `elkjs`（自动布局）+ `@monaco-editor/react`（脚本步骤与响应对照）+ `vitest`（§5.3/§14 点名的组件单测框架），全部来自 §5.2/§5.3/§14 清单，不擅自引第二套。

**Spec:** `docs/2026-11-13-ai-test-platform-design.md` —— 本计划实现 §13「1B」条目，覆盖 §4.6（scenario / run_record / run_step_result / run_artifact）、§6.5、§6.6（报告中心部分）、§7.4、§7.5、§8.1-8.6、§8.8（64KB 外置）、§11.4.8-11.4.10、§11.4.15-11.4.16、§11.4.19、§11.5.6、§11.5.7（报告中心）、§11.7.3-11.7.4、§12.2（run 事件通道）。定时任务/通知渠道/工作台/导入导出 = 1E；UI/ADB 步骤 = 1C/1D（本计划只钉「保存即诚实报错」）。

## 前置取证（写计划之前已经跑通的事实）

写这份计划前跑了三项验证，结论是计划的硬前提，后来者不要重新怀疑、也不要跳过：

1. **Celery 在本机可用（决定性）**。venv 里 `celery==5.7.0` 已装但 1A 全程未启用。隔离 spike（临时目录 `D:/tmp/tp_spike`，未进仓库）以 `--pool=solo` 起独立 worker 进程，实测证据：
   - worker 日志：`celery@CJMD v5.7.0 (collider)` / `transport: redis://:**@db.internal.test:16379/6` / `concurrency: 32 (solo)` / `celery@CJMD ready.`（1 秒就绪）
   - 任务执行：`Task spike.ping[cd5f056f…] succeeded in 0.188s: 'db+pubsub ok'`
   - **跨进程链路**：worker 内 `asyncio.run` 写 MySQL（run_record 插入）+ `get_bus().publish("run."+id, …)`，Web 侧另一进程的 `bus.subscribe` 收到 `{'seq':1,'type':'run_end','payload':{'status':'passed'}}` —— 这正是「L2 执行 → Redis pub/sub → L1 桥接 SSE → 画布高亮」的全链路，已被证明成立。
   - 结论：Windows 必须 `--pool=solo`（prefork 不支持）；worker 内用 `asyncio.run` 桥接现有 async 代码，不引入同步版 DB/总线。
2. **契约 4 的边界有了正统答案**（此前是阻塞 1B 的开放问题）。api_test 已有先例 `_resolve_via_registry`：跨模块数据只经 `REGISTRY.get("env_resolve").handler(...)` 取，不 import `app.modules.env`。因此场景引擎取「用例有效请求」走新增内部 service `api_case_resolve`（`http=None, tool=False`），引擎本体零领域 import。
3. **前端依赖可安装**：`npm view` 通，`@xyflow/react@12.12.1`、`elkjs@0.12.1`、`monaco-editor@0.57.0`、`@monaco-editor/react@4.7.0` 均可装；当前 `web/node_modules` 里一个都没有，`web/package.json` 只有 antd/react 五件套。

## Global Constraints

- MySQL 8.4 **本机实例** 127.0.0.1:3306（服务 `MySQL84`；库 `testpilot` / 测试 `testpilot_test` / e2e `testpilot_e2e`）；Redis **本机实例** 127.0.0.1:6379 密码见 `backend/.env` db6。开发禁 SQLite。新增第三方库仅限上面「前置取证 3」列出的四个（§13 纪律 2）。**【2026-11-19 修订】基础设施本机直起、连接串 `127.0.0.1`，不再要求 Docker；下文「前置取证」里的 `db.internal.test` 是当轮实测记录，照原文读、不改写**（见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4）。
- Alembic 现有 0011-0013，**下一个是 0014**；每个迁移必带 down（§13 纪律 3）；每个任务 commit，可交付步打轻量 tag。
- 表名**单数**（`scenario` / `run_step_result` / `run_artifact` / `run_event`）；全库**无外键**，级联一律显式编码；`run_record.`trigger`` 是 MySQL 保留字，裸 SQL 必须加反引号。
- 执行链走 Celery worker（D5）。Web 进程**只投递不执行**：`enqueue` 走 `send_task`；测试与无 worker 单机用 `TP_EXEC_MODE=inline`（同进程 await 同一份执行器，**不是假执行**——引擎代码两档 100% 共用）。
- worker 启动**必须**先 `create_app()` 一次：`REGISTRY` 在 `create_app()` 之前是空的（1A 踩过：`toolbox total: 0`），且 `set_perms_resolver` / `set_audit_writer` 也在其中注入。
- step_graph 语义按 §7.4 原文：纯树 + 有序数组，**无 DAG 汇聚边**；`layout` 只影响画布、与执行无关；嵌套深度 ≤ 10；一期 kind 白名单 = 全集，其中 `group` 仅串行容器（`.parallel` 二期）；`break`/`continue` 出现在 loop/foreach 之外 → 保存校验报错 + 画布红节点。
- SSE 事件信封统一 `{seq, ts, type, payload}`；**seq 真相在库**（`run_event`），重放与直播同一信封；`core/sse.py` 已实现「先订阅 → 再重放 seq > cursor → 直播按 seq 去重」，1B 只提供 `replay_fn`，不改这个不变量。
- 权限位三段式 `域:资源:动作`；新模块前缀统一 `scenario:`；所有 `*_purge` 一律 `tool=False` + 输名确认（沿用 1A 已定的 `name_mismatch` / `not_recycled` 409 语义）。
- 变量渲染顺序（§7.5 补全 1A 的两层为四层）：**数据集当前行 > 步骤 extract/步骤临时 > 场景变量 > 环境 vars > 项目全局配置**；未定义变量仍然 422 `validation_error` + `details.var`（1A Review Focus 1 的行为，不放宽）。
- 五道门禁必须保持全绿：`pytest -q`（基线 152 passed）、`ruff check app tests migrations scripts`、`lint-imports.exe`（基线 4 kept, 0 broken）、`pnpm build`、`pnpm exec playwright test`（基线 23 passed）。
- 诚实原则（业主已定）：未开放能力不给假入口。1B 期间导航里 UI/ADB 仍 disabled +「1C/1D 开放」；场景里放 `ui_case`/`adb_case` 步骤 → **保存时就报 issue**，不假装能跑。

## Review Focus

蓝图没逐字写、但最可能咬人的输入。每条钉死在对应任务的测试里，实现者不要靠临场发挥：

1. **`break`/`continue` 出现在循环外**（含在 `if` 里、在 `group` 里、在 `loop` 的兄弟层）→ 保存 422 `validation_error`，`details.issues=[{node,code:"break_outside_loop"}]`，画布节点红角标 + 底部问题面板可定位；执行期防御性再查一次（绕过保存直连 API 的路径）→ T4/T10。
2. **数据集展开爆炸**（10 行用例 × while 50 次 × foreach 20）→ 保存期能算出的静态乘积 > 500 → 409 `expansion_overflow`；循环次数不可静态确定（`mode:"while"`）时保存放行、**执行期实际展开 > 500 → run 立即 error**（不是静默截断）→ T8/T10。
3. **SSE 断线重连不丢步不重复**（一期 DoD 明写）→ 事件落 `run_event` 表；重连带 `Last-Event-ID` → 重放差集 + 直播去重；构造「订阅前已产生 3 条事件」与「重放与直播交叉」两个用例 → T11。
4. **取消落在长任务中间**（`sleep 30s`、数据集第 3/10 行）→ `sleep` 按 500ms 切片轮询 `cancel:{run_id}`；行与行之间检查边界；终态 `cancelled`，已完成的步骤明细**保留可读**（不回滚）→ T9。
5. **乐观锁冲突**（两人同开一个场景）→ `version` 不匹配 409 `conflict` + `details.current_version`，前端弹**差异对比**弹窗（不是「刷新重试」一句话打发）→ T10/T19。
6. **worker 崩溃 / 进程被杀** → run 卡 `running`：查询详情时发现租约（Redis `run.lease.{id}`，TTL 与 max_runtime 同量级）已失效 → 标 `error` + `error="执行进程中断"`，画布上未终态的 running 节点转灰，不留「永远呼吸」的死节点 → T6/T11。
7. **脚本沙箱逃逸**（`__globals__` / `open` / `import os` / `while True` / 打印 100MB）→ 前四类 422 拒绝且报因；死循环 5s 超时终止；输出超上限截断并标注 → T5。
8. **变量缺失与数据集同名覆盖**（步骤写 `${uid}` 但上游没 extract；数据集列名与场景变量重名）→ 前者步骤 error 且 message 点名变量；后者**数据集行胜出**（四层顺序），用例调试的单行语义不变 → T6/T8。
9. **删除被场景引用的资产**（1A 的 `data_set_delete` 只数用例引用）→ 1B 起引用要分级拦，且**徽标与删除 409 口径一致**，否则徽标说 0、删除却 409 → T10。

   > **勘误（RF9 原文按字面做是空操作，真缺口在别处）**：写这一条时假设「场景也直接引用数据集」，
   > 复核数据模型后不成立——`ApiCase.dataset_id` 才绑数据集，而场景步骤 `kind=api_case` 的
   > `ref` 是 **case_id**（`graph.py` 的 `REF_KINDS`，T3 `api_case_resolve` 同口径），
   > `scenario` 表与 `step_graph` 里没有任何 dataset 字段。所以「数据集的 used_by 计入场景引用」
   > 数的还是同一批用例，加不加都是那个数，纯属自欺。
   > **两处真缺口，改为钉这两条**：
   > ① **回收一个被未回收场景引用的用例**：`api_case_delete` 现在零场景口径检查，直接软删，
   >    场景里那一步从此 resolve 不到（执行期才炸）。§6.5 白纸黑字要「删除被场景引用的用例
   >    →警告并列出引用」。**注意语义分级**：软删可逆，且删除者可能恰恰没有 `scenario:read`
   >    （内置角色 READONLY/MEMBER 都含 `*:read`、MEMBER 只减 `*:delete`，但 `role_template`
   >    可自定义），所以**不硬拦 409**，而是 `force` 两段式：默认 409 + `details.scenarios`
   >    列出引用者与命中步骤 key，带 `force=true` 才真回收；无引用时 force 无副作用。
   >    调用方无 scenario:read 权限时，引用数照报、场景明细留空并说明原因——
   >    「因为查不到所以说不清被谁引用」比「假装没人引用」诚实。
   >    追加裁量：**看不见明细的人不许 force**——他不知道该断的是谁的步骤，
   >    一键下去坏的是别人的场景。
   > ② **purge 掉数据集，而绑定它的用例还被场景引用**：purge 是硬删不可逆，
   >    `api_case_purge` 现在也不看场景 → 硬拦，**不给 force 出口**（用例行没了就恢复不回来；
   >    且「回收 ≠ 解绑」，回收站里的用例 ref 照样指着它）。
   >    **数据集这一道的真缺口比原文写的更窄也更阴**：绑着**未回收**用例时 `used_by`
   >    第一道早就拦住了；漏的是「用例已回收（`used_by` 只数 normal → 徽标显示 0 引用）
   >    但它的 `dataset_id` 还指着这里，而该用例被未回收场景引用」。此时数据集能被硬删，
   >    用例一旦被恢复，执行期 `api_case_resolve` 就 404「数据集不存在」——正是那行注释
   >    写的「外力破坏」的来历。所以 `data_set_delete` 补的是**第二道**（只对回收站里
   >    绑着它的用例问场景引用）；第一道保持原 `conflict` 码不动，只把「其中 N 条还被场景
   >    引用」补进提示——否则用户照着「请回收用例」的提示去做，会一头撞上 ① 的 409。
   >    已知同源老洞（**1A 遗留**）：回收站用例绑着数据集、且没有任何场景时，
   >    数据集同样能被删掉，恢复用例后一样悬空。1B 没制造它。
   >    **裁定落地（主线复核确认后果、修法交后端 lane 裁，见 ledger R82）**：后果核实为
   >    真——恢复后的用例在列表里看着健康、执行期 resolve 才 404、永远跑不动。
   >    修法裁定为**恢复期校验**：`api_case_restore` 发现 `dataset_id` 悬空即 409
   >    点名缺失数据集（`dataset_missing`），不静默清绑（清绑=降级，§13 纪律 1）。
   >    **落选方案「删除期拦任何绑定用例（含回收）」**：它要推翻 `test_dataset.py:68-70`
   >    钉着的决定（回收即释放数据集是既定的可删语义——回收的用例还可以被 purge，
   >    扣着数据集不放没有出口），且与徽标语义（used_by=未回收用例数）正面冲突。
   >    恢复期拦是窗口收紧的最小刀口：数据集死在回收期间 → 恢复这一步响亮失败，
   >    修复路径（用例解绑 `dataset_set=true,dataset_id=null`）保持敞开。
   >    两案落选/入选理由全文见 ledger。
   >    **补完第二道后，徽标说谎是新造的**：第二道只数回收站用例，而徽标只数未回收用例，
   >    于是「徽标 0 · 删除 409」成了必然（不是偶发）。修法**不是**把场景引用并进
   >    `used_by`——那会把「几条活用例绑着它」和「被场景扣着」两个不同的数糊成一个谁也
   >    读不懂的数，且 `test_dataset.py` 与 `e2e/datasets.spec.mjs` 早把 `used_by` 钉成
   >    「未回收用例数」。改为**并列第二个信号** `DatasetOut.scenario_held`：定义直接取
   >    「删除会不会被场景这道拦下」，与 `data_set_delete` 共用同一个
   >    `_scenario_held_datasets()` 判据 → 一致率由构造保证，不靠两处各自记得同步。
   >    它两种拦法都为真（活用例被场景扣着、回收用例被场景扣着），所以第一道的 409
   >    `details` 也回带 `scenario_held`。前端 `web/src/pages/datasets.tsx` 在徽标旁加锁
   >    标记（`ds-held`）并改写 Popconfirm 文案；`used_by` 一列一字未改。
   > T10 的 `scenario_references` 已提供引用查询口径（`kind=api_case && ref=case_id`，
   > 只数 `status=normal` 的场景），但它单 id 且 require scenario:read；删除保护要的是
   > 批量 + 「没权限也必须拦」，故另开内部件 `scenario_case_refs`
   > （`http=None, tool=False`，与 `env_resolve` / `api_case_resolve` 同族）。
   > 跨模块仍走 REGISTRY（契约 1：api_test 不 import scenario）。
10. **报告自包含**（1A 已定原则：run 历史不追资产）→ 资产回收/彻底删除后报告仍完整可读：`subject_name` 快照 + `summary_graph` 快照 + 步骤 detail 自包含，报告页零依赖 `api_case` 是否还活着 → T12。
11. **草稿调试 vs 正式执行**（§11.5.6「运行当前未保存草稿」）→ 草稿跑出来的 run `trigger="debug"`，**报告中心默认过滤 debug**（报告是结论，调试是过程），运行记录页两者都看得到 → T11/T12。

## 产品与架构裁量（R42 起，续 1A 的 R41）

业主按行为验收，不必逐条点头；有异议随时推翻，推翻后改本文件再改码。

- **R42 · 执行链真的走 worker**。新增 `backend/app/worker.py`（Celery app，`--pool=solo`）。Web 侧 `enqueue` 用 `send_task("scenario.run", [run_id])`（按名字投递，web 进程不 import 引擎，省掉一半启动耦合，也让 web 侧不需要 Playwright/adb 依赖）。配置 `TP_EXEC_MODE=celery|inline`，默认 celery；`inline` 供 pytest 与「不想开 worker 的单机演示」——跑的是同一份引擎，差别只在谁起协程。**不把 inline 当生产默认**：那样 D5 就成了一句空话。
- **R43 · 引擎放 `scenario/engine/`，不放 `execution/`**。执行核 `run_api`（单请求 + 断言）是底层，`execution` 保持不懂 step_graph 协议（契约 4 的字面与精神都保住）；懂协议的人（handler 注册表、递归子树、数据集展开）住在新模块里，正向依赖 `execution` + `shared` + `core`。
- **R44 · 跨模块一律走注册表**。新增 `api_case_resolve`（`http=None, tool=False`）返回 `{name, request, assertions, dataset:{columns,rows}}`；场景引擎经 `REGISTRY` 调它。**不复用 `api_debug` 跑场景步骤**——它会自己落一条 run_record（步骤明细会双写）、且只跑数据集首行，语义不对。
- **R45 · 场景用独立的 `scenario_module` 树**，不给 `api_module` 加 `kind` 列。理由：权限语义（`api:module:*` 不该管场景）与引用完整性都不共享，且不去动 1A 已被 e2e 钉住的接口；代价是模块树代码结构重复约 150 行，接受。
- **R46 · trigger 词表统一为 `debug|manual|schedule|agent|webhook`**（模型注释口径）。现状是真不一致：`RunListIn` 的 pattern 允许 `case`、拒绝 `manual`/`webhook`，而 `api_debug` 实际只写 `debug`/`agent`——1B 一写 `manual` 就会被自己的列表接口 422。迁移里 `case→manual` 归一（当前库无 `case` 行，归一是空操作但语义保住），并补一条约束测试防回归。设计文档 §4.6 的 `web/api_hook` 分别映射到 `manual/webhook`（`manual` 比 `web` 更准确：定时也是 web 触发的）。
- **R47 · 新增 `run_event` 表作为进度事件真相**（`run_id, seq, type, payload`）。`run_step_result` 表达「步骤现状」，无法重建 `running→pass` 的完整时序，断线续传就会丢步；一表两用（重放 + 审计）比「靠 status 猜测」诚实。单 run 单写者（Celery 保证一次领取），`seq=max+1` 无竞态。
- **R48 · `ui_case`/`adb_case` 在 1B 保存即报 issue**（`kind_not_available`，文案「UI 用例 1C 开放 / ADB 用例 1D 开放」），不是等执行时才炸。画布上仍可拖入（看得见未来），但存不下去。
- **R49 · Monaco 进 1B，但先做探针任务**（T16）：自托管 worker、vite 配置、build 时长、e2e 可用性四项实测后才铺开，接入点只有两处（脚本步骤、报告响应对照）。探针不过 → 回来改本文件（不偷偷降级成 TextArea 交付，那是对设计文档的静默违约）。
- **R50 · 批次标注勘误**：1A 演示手册第 279 行把「报告中心」标成了 1D，§13 白纸黑字写在 1B。T23 修正该手册，并把「全局搜索 1B」的兑现一并写清。
- **R51 · 1B 兑现 Ctrl+K**（手册已承诺），范围=接口/用例/场景三类的名称+路径关键词搜索（§9.10 一期 UI 检索走 MySQL 关键词，向量路不在此）；**§11.4.20 高级搜索面板（AND/OR 条件组 + 保存视图）不在 1B**，属逐页打磨，写进「不做清单」。
- **R52 · 场景一期无 `scenario` 类型步骤** → 场景之间无引用环，§11.5.6 的「用例引用例深度 ≤5」在 1B 是空规则（用例不引用用例）；不实现也不假装实现，代码里留注释说明它在哪一期生效。
- **R53 · 场景软删三件套与接口/用例同构**（`scenario_delete/restore/purge`，purge 输名确认 + `tool=False`）。同族资产必须同手感，这一条是 1A 演示手册立下的口碑：**每个软删资产都有出口**。

## 文件结构（1B 建成后）

```
backend/app/worker.py                     # Celery app + run_scenario 任务（新；启动先 create_app()）
backend/app/core/config.py                # + exec_mode / max_runtime_default / artifact_max_bytes
backend/app/modules/scenario/
    models.py                             # Scenario / ScenarioModule
    graph.py                              # step_graph 纯校验（无 DB）：kind 白名单/深度/break-continue/key 唯一
    sandbox.py                            # §8.5 restricted-exec：白名单 builtins + import 钩子 + 5s + 输出上限
    engine/context.py                     # ExecutionContext：vars 四层、last_response、log、取消检查
    engine/handlers.py                    # kind → handler 注册表（api_case/http_direct/sleep/loop/if/foreach/
                                          #   break/continue/script/extract/assert/set_var/group）
    engine/runner.py                      # 顺序解释执行 + 数据集行展开 + fail_fast/optional + 事件与落库
    module_services.py                    # scenario_module 树 CRUD（环检测/回收站，同 api_module 语义）
    services.py                           # scenario_* CRUD + 乐观锁 + 执行/取消/单步重跑 + SSE + 报告查询
    schemas.py
backend/app/modules/execution/
    models.py                             # run_record +started_at/finished_at/stats/summary_graph/lease…
    services.py                           # trigger pattern 修正；save_run 支持终态字段
backend/app/modules/api_test/
    case_services.py                      # +api_case_resolve（http=None, tool=False）；删除分级拦 + DatasetOut.scenario_held（见 RF9 勘误）
backend/app/shared/assertions.py          # script 断言由「1B 开放」占位改为真走 sandbox
backend/migrations/versions/0014_run_record_v2.py     # run_record 扩列 + trigger 归一（down 齐全）
backend/migrations/versions/0015_run_detail_tables.py # run_step_result + run_artifact + run_event
backend/migrations/versions/0016_scenario.py          # scenario + scenario_module
backend/scripts/verify_worker.py          # 真 worker 冒烟（spike 转正）：起 worker → 投任务 → 校验落库与事件
backend/tests/test_scenario_graph.py / test_sandbox.py / test_engine_*.py / test_scenario_api.py /
           test_report_center.py / test_search.py / test_tool_surface_1b.py
web/src/scene/{Canvas,NodeView,ListMode,PropsPanel,DebugDrawer,AssetTree,graphOps,layout,stepTypes}.tsx|ts
web/src/components/CodeEditor.tsx         # Monaco 封装（探针通过后接入）
web/src/pages/{scenes,sceneEditor,reports,reportDetail}.tsx
web/src/shared/sse.ts                       # 由 agent/sse.ts 抽通用「fetch + Last-Event-ID + 去重」，两条通道共用
```

---

## 后端任务（T1-T11）

### Task 1: run_record 升级到报告主体 + trigger 词表归一

**Files:**
- Create: `backend/migrations/versions/0014_run_record_v2.py`（+started_at/finished_at datetime null、+stats JSON null、+summary_graph JSON null、+lease_owner String(64) null、+cancel_requested smallint default 0、+max_runtime_ms int null；down 逐列 drop）
- Modify: `backend/app/modules/execution/models.py`、`backend/app/modules/execution/services.py`（RunListIn.trigger pattern 改为 `^(debug|manual|schedule|agent|webhook)$`；RunOut 增 started_at/finished_at/stats）
- Test: `backend/tests/test_run_record_v2.py`

**Interfaces:**
- Consumes: 1A 的 `save_run(...)`。
- Produces: `save_run` 增可选入参 `started_at/finished_at/stats/summary_graph`（终态写入用；**不新建第二个写入口**——运行历史写入点唯一是 1A 定的）。
- 迁移内 `UPDATE run_record SET trigger='manual' WHERE trigger='case'`：当前库应为 0 行，空操作也要留着，防历史库残留（R46）。

- [ ] **Step 1: 写失败测试**：① 新列可写可读（save_run 带 stats/started_at/finished_at → run_get 回显）；② `trigger="manual"` 与 `"webhook"` 能被列表过滤接受（旧码在此 422——**这是本任务要修的真 bug**，取证见 R46）；③ `trigger="case"` 被拒绝（词表已归一）；④ 迁移 up→down→up 在 `testpilot_test` 上跑通且原数据不丢。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（先迁移后模型；down 的 drop 顺序与 up 相反）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(execution): run_record becomes report body; unify trigger vocabulary`

### Task 2: run_step_result / run_artifact / run_event 三表

**Files:**
- Create: `backend/migrations/versions/0015_run_detail_tables.py`
  - `run_step_result`：id, run_id(index), step_key, status(running/pass/fail/skip/error/cancelled), attempts int, parent_step_key null, subject_name String(200) null, kind String(24), elapsed_ms int null, detail JSON null, row_no int null, row_total int null, vars_snapshot JSON null, created_at/updated_at + UniqueConstraint(run_id, step_key, row_no)
  - `run_artifact`：id, run_id(index), step_key null, kind(SCREENSHOT/VIDEO/HAR/LOG/RESPONSE), ref String(500), bytes int null, created_at
  - `run_event`：id, run_id(index), seq int, type String(24), payload JSON, ts datetime + UniqueConstraint(run_id, seq)
  - 三表 down 全 drop
- Modify: `backend/app/modules/execution/models.py`（三个模型放执行域：执行产物属 execution，场景只是生产者，避免 execution 反依赖 scenario）
- Test: `backend/tests/test_run_tables.py`

**Interfaces:**
- Produces: 三个 ORM 模型；`vars_snapshot` 是 §8.3 单步重跑的重建依据；`row_no/row_total` 承载 §8.6 的 `step_key#r{N}`（row_no=null 表示非数据集步的整体一行）。

- [ ] **Step 1: 写失败测试**（表级：唯一约束冲突可复现；同一 (run_id,step_key,row_no) 不产生两行；数据集步多 row_no 并存；run_event seq 不可重；down 迁移可逆）→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(execution): step result, artifact and event tables`

### Task 3: `api_case_resolve` —— 用例有效请求的注册表出口（契约 4）

**Files:**
- Modify: `backend/app/modules/api_test/case_services.py`、`schemas.py`
- Test: `backend/tests/test_case_resolve.py`

**Interfaces:**
- Produces: `api_case_resolve`（perm `api:case:read`, effect=read, `http=None`, `tool=False`, `resident=False`），入 `{project_id, case_id}` → `{case_id, name, definition_id, request: dict, assertions: list, dataset: {columns:[str], rows:[[str]]} | None, executable: bool}`。内部复用 `_visible_case` + `merge_request`（**不复制合并逻辑，口径不可能与 `api_case_get` 分叉**）；回收站中的用例或所属接口 → 404。
- 为什么另开一个而不是复用 `api_case_get`/`api_debug`：`api_case_get` 面向 HTTP+模型，字段噪音多且不带全量数据集行；`api_debug` 会自己落一条 run_record（步骤明细将双写）且只跑数据集首行，语义不对（R44）。

- [ ] **Step 1: 写失败测试**：① 继承态用例 → request 来自定义（method/url 齐）；② 覆盖 url → url 取自用例、headers 取自定义（按键浅覆盖）；③ 断言 = 定义 + 用例，顺序如此；④ 绑数据集 → dataset 全行；⑤ 用例回收 → 404；⑥ 跨项目 case_id → 404（不泄露存在性）；⑦ 断言 `REGISTRY.get("api_case_resolve").tool is False`（引擎内部件不该进模型视野）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(api_test): registry-only effective-request resolver for the engine`

### Task 4: step_graph 协议与保存期校验（纯函数，无 DB）

**Files:**
- Create: `backend/app/modules/scenario/__init__.py`、`graph.py`、`engine/__init__.py`
- Test: `backend/tests/test_scenario_graph.py`

**Interfaces:**
- Produces（`scenario/graph.py`，全纯函数）：
  - `KINDS` = §7.4 全集 15 个 kind（一期白名单=全集）；`BLOCKED_1B = {"ui_case":"1C","adb_case":"1D"}`（R48）；`MAX_DEPTH = 10`
  - `validate(graph: dict, *, depth_limit=10, expansion_limit=500, dataset_rows: dict[str,int] | None=None) -> list[Issue]`，`Issue = {node_key, code, message, path}`
  - code 全集：`bad_version`、`dup_key`、`bad_key`、`unknown_kind`、`depth_exceeded`、`break_outside_loop`、`missing_ref`、`missing_config`、`children_not_allowed`、`bad_node`（节点不是对象、或 children/branches 不是数组）、`empty_cond`、`kind_not_available`、`expansion_overflow`、`not_supported_yet`（group.parallel）
  - `iter_nodes(graph) -> Iterator[tuple[node, parent_key, depth]]`
  - **kind 必填 config 表**（保存期校验的单一口径，T7 的 handler 与画布表单都以它为准）：
    `api_case/ui_case/adb_case` 需 `ref`；`http_direct` 需 `config.url`；`sleep` 需 `config.ms`（int>0）；
    `loop` 需 `config.max_iter`（int>0）且 while 模式需 `config.cond`；`foreach` 需 `list_var`+`item_var`；
    `if` 需非空 `config.branches` 且每支需 `cond`（空 children 合法——未填充分支是常态）；
    `script` 需 `config.code`；`extract` 需非空 `config.rules`（每条需 var+expr）；`assert` 需非空
    `config.assertions`；`set_var` 需 `config.vars`（非空 dict）；`break`/`continue`/`group` 无必填。
  - key 规则：点号分段的字母数字下划线短横线，段长 1-40、**段数 ≤10**、总长 ≤64（64 等于 `run_step_result.step_key`
    的列宽）。段数上限与 MAX_DEPTH 同源：key 的点号层级就是树深度，61 字符的 31 段 key
    靠总长拦不住（测试就是这么钉的）。不含 `#`：§8.6 用 step_key + #rN 作数据集行展示键，
    key 自身带 # 会让拆分二义。
- 语义钉点：children 数组顺序即执行顺序；`if` 的子节点在 `config.branches[i].children`（遍历要覆盖两处）；`group` 一期是串行容器；**校验函数对任何畸形输入只产 issue、绝不抛异常**（畸形 graph 不能变 500）。

- [ ] **Step 1: 写失败测试**（表驱动，一条 case 一个断言）：**§7.4 文档示例逐字誊写为 fixture**（协议对齐的试金石）：其中花括号省略号占位符按上下文补真实
    子节点；`n8` 的 `adb_case` 拆成第二个 fixture——R48 要拒绝它，所以「示例整体零 issue」在文档原文
    上是不成立的命题，诚实的钉法是「除 n8 外零 issue，且 n8 恰好一条 kind_not_available（含 1D）」；② break 在顶层 / 在 if 分支内 / 在 group 内 → 三种都报 `break_outside_loop`（Review Focus 1）；③ 11 层嵌套 → depth_exceeded，10 层放行；④ 同 key 两点 → dup_key；⑤ sleep 带 children → children_not_allowed；⑥ ui_case 步骤 → kind_not_available 且 message 含「1C」；⑦ 数据集乘积 499/500 通过、501 → expansion_overflow；⑧ version=2 → bad_version；⑨ 传入 `"abc"` / `{"nodes": "x"}` 等垃圾 → 返回 issue 列表而非异常。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（递归 + depth + path 记录，path 供画布定位）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): step_graph protocol validation (pure, no DB)`

### Task 5: 脚本沙箱（§8.5）+ script 断言真求值

**Files:**
- Create: `backend/app/shared/sandbox.py`（**不是** `modules/scenario/sandbox.py`，理由见下）
- Modify: `backend/app/shared/assertions.py`（script 类型从「脚本断言 1B 开放」占位改为真跑沙箱；不新增依赖）
- Test: `backend/tests/test_sandbox.py`

> **落点修正（写码前的层级取证）**：§8.5 沙箱服务的对象是「前置/后置/脚本步骤/断言脚本」，
> 前置后置与 script 断言属 1A 已有的 api_test 资产，断言引擎在 `app/shared/assertions.py`。
> 放 `modules/scenario/` 会造成两处结构伤害：① `shared/assertions.py` 必须 import `app.modules.*`
> —— shared 是全仓最底层（现状只 import `app.core.errors` 与标准库），一旦反向依赖模块，
> 谁都能找到理由往下插；② api_test 跑 script 断言就要跨模块 import scenario，违反契约 1
> 「modules 之间只经 service/事件总线互调」。沙箱是纯函数（无 DB、无模块依赖），shared 才是
> 它的真实层级；scenario 的 script handler 与 shared 的 script 断言因此共用同一份白名单，
> 安全口径全仓只有一份。

> **补第二处缺口**：`api_test/schemas.Assertion` 只有 `type/path/expected/timeout_ms`，
> **没有地方放脚本正文**（pydantic 会静默丢掉前端传来的 `code`，DB 里存的断言 dict 也就
> 没有正文，1A 才只写了「1B 开放」占位）。故本任务给 `Assertion` 加 `code: str | None = None`，
> 并用 `mode=after` 校验器要求 `type=="script"` 时 code 非空（缺失 → 422，而不是运行时才说
> 「没有脚本」）。`RequestObject` 走 `model_dump(exclude_none=True)`，非 script 断言不会多出
> `code: null` 键，DB 里既有 JSON 零迁移。同时 `evaluate()` 加 keyword-only `variables=None`
> （默认 None 保持既有调用方 `execution/core.py:93` 兼容），`run_api` 把已渲染的 variables
> 传进去，脚本断言因此能读变量。

**Interfaces:**
- Produces: `run_script(code, *, ctx_vars, last_response=None, timeout_s=5, max_output=64_000, url_allowlist=None) -> ScriptResult{ok, vars, logs, error, truncated}`
- 机制（§8.5 原文对齐）：`exec(code, restricted_globals)`；`__builtins__` 白名单（len/range/str/dict/list/int/float/bool/sorted/min/max/sum/abs/round/enumerate/zip/any/all/isinstance 等）；预绑模块名 `json/re/math/datetime/random/time/hashlib/base64/urllib.parse`；自定义 `__import__` 只放白名单，其余 ImportError；源码文本预检拒 `__` dunder 与 `open(/exec(/eval(/compile(`；在 `threading.Thread` + `join(timeout_s)` 内执行，超时 → `error="脚本超时 5s"`。**诚实条款**：Python 线程不可强杀，超时后**不再采信其 vars 输出**，并把这条残余风险写进 docstring——不谎称硬隔离（三期再评估子进程容器化）。
- 脚本 API：`ctx.vars` 读写（结束取差集回写）、`log(...)`、`assert` 可用；`http.get/post` 助手仅在 `url_allowlist` 命中前缀时放行，否则 error（§10-4）。
- `assertions.evaluate` 的 script 分支：AssertionError → passed=false + detail=断言消息；其他异常 → passed=false + error 原文。
- **默认关闭出网**：`url_allowlist=None`（断言与场景脚本的默认值）时 `http.get/post` 一调用
  即 error，而不是「能访问内网只是没配白名单」；只有调用方显式传前缀列表才放行。

- [ ] **Step 1: 写失败测试**：① 正常脚本改 vars + log → 回写正确、logs 有序；② `import os` → ok=False 且 error 含模块名；③ `open(...)` 文本预检拒绝；④ `ctx.__globals__` 拒绝；⑤ 死循环 → 5s 内返回超时 error，且用一个「sleep 后再写 vars」的脚本证明**超时后 vars 不被采信**；⑥ 打印 200KB → truncated=true 且 logs 总长 ≤64000；⑦ `assert ctx.vars['code']=='0'` 不成立 → 断言判 fail；⑧ 同步改掉 1A 里「脚本断言 1B 开放」的旧断言测试（**别留自相矛盾的绿**）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): restricted-exec sandbox; wire script assertions`

### Task 6: ExecutionContext + 事件发布 + 步骤落库

**Files:**
- Create: `backend/app/modules/scenario/engine/context.py`、`engine/events.py`
- Test: `backend/tests/test_engine_context.py`

**Interfaces:**
- Produces:
  - `ExecutionContext(db, bus, run_id, project_id, base_vars, headers, timeout_ms)`：`.vars`、`.last_response`、`.log(step_key, msg)`、`.render(tpl)`（缺变量抛 `MissingVar` → 步骤 error 且 message 点名变量，Review Focus 8）、`.vars_snapshot()`（§8.3 重跑依据）
  - `publish(db, run_id, type_, payload) -> dict`：**先落 `run_event`（seq=该 run max+1）→ commit → 再 `bus.publish("run."+run_id, envelope)`**。顺序不可反：Web 侧一旦收到，就一定重放得到（R47）
  - `replay_events(db, run_id, after_seq) -> list[dict]`：`{seq, ts, type, payload}` 信封，直接喂 `core/sse.py` 的 replay_fn
  - `write_step(db, run_id, step_key, *, status, kind, parent_step_key, subject_name, elapsed_ms, detail, row_no, row_total, vars_snapshot)`：按 `(run_id, step_key, row_no)` upsert
  - `is_cancelled(bus, run_id)` / `renew_lease(bus, run_id, owner, ttl)` / `lease_alive(bus, run_id)`（Redis 键 `cancel:{run_id}`、`run.lease.{run_id}`；Review Focus 6 的依据）
- 契约 4：只 import `core`/`shared`/`execution.models`；跨模块取数一律经 REGISTRY。

> **写码前补齐的四处接口缺口（取证后新增，避免实现时临时改形状）**：
> ① `publish(...)` 加 keyword-only `bus=None`：默认取 `get_bus()`（生产用全局单例），
>   测试因此能注入假 bus 去证「落库先于广播」，而不必 monkeypatch 模块全局。
> ② `EventBus` 目前只有 pub/sub 与 lock/unlock，**没有任何键级读写**，cancel/lease 三类
>   键无处落脚。给 `app/core/eventbus.py` 补通用原语 `set_key/get_key/del_key/exists_key/
>   ttl_key`（沿用 `channel()` 的 `tp.` 前缀，与 lock 同族）。这是 core 的通用扩展，不是
>   scenario 专属；契约 2（core ↛ modules）不受影响。最终键名 `tp.cancel.{run_id}`、
>   `tp.run.lease.{run_id}`。
> ③ 计划只给了 `is_cancelled` 却没有写入方 → 补 `request_cancel(bus, run_id)` /
>   `clear_cancel(bus, run_id)`（T11 的 cancel 服务用）。否则测试只能自己拼键名，键名知识
>   一旦复制到测试里，改名就测不出来了。
> ④ `renew_lease` 必须**只有当前 owner 能续**（GET 校验 owner + `SET XX EX`），否则崩溃后
>   复活的僵尸 worker 会把新持有人的租约续下去，租约就失去意义。剩余的 GET/SET 竞态窗口
>   在注释里写明并说明 1B 为何接受（真原子要 Lua，fakeredis 的 lupa 依赖不可靠）。
> ⑤ `write_step` 是 flush 不是 commit（写入口与 `publish` 成对调用，由 publish 的 commit
>   一并提交，避免半提交状态）；覆盖同一 `(run_id, step_key, row_no)` 时 `attempts += 1`，
>   让报告能看出这行被重跑过（§8.3 单步重跑的依据）。
> ⑥ `render(tpl)` 对非字符串入参走 `render_deep`（handler 要渲染整个请求对象），语义与
>   `shared/vars` 一致：缺变量一律抛 `MissingVar`。
> ⑦ 再加 `lease_owner(bus, run_id) -> str | None`：续租失败时「被谁持有」是唯一可观察
>   证据，报告页与 worker 日志都要它。

- [ ] **Step 1: 写失败测试**：① seq 严格递增，重复 publish 不产生同 seq 两行；② 落库先于广播——假 bus 记录「publish 时该 seq 已能查到」；③ write_step 两次同 key → 覆盖而非追加；④ 数据集步 `(key,row_no)` 多行并存；⑤ cancel/lease 三个键行为（含 TTL 传入与过期）；⑥ `render` 缺变量抛 `MissingVar("uid")` 且消息点名。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): execution context, event log, step upsert`

### Task 7: kind handler 注册表（API 类 + 全部逻辑控件）

**Files:**
- Create: `backend/app/modules/scenario/engine/handlers.py`
- Test: `backend/tests/test_engine_handlers.py`

**Interfaces:**
- Produces: `HANDLERS: dict[str, Handler]`；`Handler = async (node, ctx, *, run_children) -> StepOutcome`；`StepOutcome{status, message, detail, vars, control: None|"break"|"continue"}`
- 注册的 kind（§8.1 + §7.4 全集里 1B 能跑的 13 个）：
  - `api_case`：`REGISTRY.get("api_case_resolve")` 取有效请求 → `execution.core.run_api` → `shared.assertions.evaluate` → 更新 `ctx.last_response` 与 vars
  - `http_direct`：config 自身即请求描述（`url` 必填，见下方勘误 ①）直发，不落资产
  - `sleep`：config.ms，**按 500ms 切片、每片查 cancel**（§8.2 取消落在长等待里）
  - `loop`：mode `count`|`while`（cond 走沙箱求值）、`max_iter` 硬上限；在此消化 break/continue
  - `if`：branches 顺序求值，`cond=="else"` 兜底；未命中分支的子节点标 skip
  - `foreach`：`list_var`（list 或 JSON list 字符串）逐行写 `item_var` 递归
  - `break`/`continue`：返回 control；不在循环内出现 → error（与保存校验双保险）
  - `script`（T5）、`extract`（rules → `shared/jsonpath`）、`assert`（对 last_response 求值）、`set_var`、`group`（串行容器）
- `ui_case`/`adb_case` **不注册**：保存期已被 T4 拦住；执行期若仍出现 → status=error +「该能力将在 1C/1D 开放」，不静默跳过。
- 每个 handler 的 `detail` 结构在此钉死：`{request, response, assertions, logs, script?}`——报告页（T12）与单步重跑（T11）都依赖它。

> **写码前补齐的六处缺口（取证后新增）**：
> ① **`http_direct` 的 config 形状与 T4 已提交的 `graph.py` 冲突**：原稿此处写「config.request
>   直发」，而 T4 的保存期校验把 `config.url` 定为必填（validate 是保存期唯一口径，27 条测试
>   钉着）。以 **graph.py 为准**：config 自身就是请求描述
>   `{url, method?, headers?, params?, body?, timeout_ms?, assertions?}`，handler 内
>   `_build_request(cfg)` 组装成 run_api 的 request；**不引入嵌套的 config.request**。
> ② `run_script` 只能 exec 整段脚本，而 loop.while 与 if 的 cond 是**表达式**（§7.4 例子是
>   `ctx.vars.get("ok") != "1"`），模块级 `return` 非法。给 `shared/sandbox.py` 增加
>   `evaluate_condition(expr, *, ctx_vars, last_response=None, timeout_s=None) -> ConditionResult`
>   `（ok, value, true_, error）`：内部包装成 `__value__ = (expr)` 复用**同一套护栏**（AST 预检、
>   builtins 白名单、daemon 线程超时、vars 喂副本）。绝不另起一个裸 `eval()`——那等于绕开 §8.5
>   的护栏，且两条求值路径会慢慢分叉。
> ③ `api_case` 要走 `api_case_resolve`，而它 `ensure_project_access(ctx, pid)` + `ctx.require
>   ("api:case:read")` —— **需要发起人身份**。T6 的 ExecutionContext 没这字段。给它加两个可选
>   关键字：`actor`（供 handler 构造 ServiceCtx 的 (user_id, user_name, is_system_admin, perms,
>   entry) 快照）与 `transport`。1A 确有 `set_debug_transport(factory)`（api_test/services.py:235,
>   模块级全局钩子供 api_debug 注入），**引擎不复用它**：① 全局钩子在同进程并发多个 run 时会
>   互相踩（pytest 并行、worker 多任务都可能），② 引擎 import api_test 直接破契约 1。
>   因此走**每次执行传入**的 `ctx.transport`：生产 None 走真实网络，测试注入 ASGITransport
>   内存靶，handler 原样透传给 run_api（手法与 1A 同源，作用域从全局收到每次执行）。
> （勘误更正记录：本条初稿曾断言 `set_debug_transport` 在仓库里不存在——那是 findstr 的一次
>   漏报，实际存在于 `api_test/services.py:235`。教训：**工具说「没有」不等于没有**，
>   结论要用第二种方法复核（本次改用 Python rglob 逐文件扫描才算数）。
> ④ **撤回一条我自己造出来的勘误**：初稿曾写「`loop.mode="count"` 必须有 `config.count`」，
>   并要求改 T4 的 graph.py 与其 4 处测试。复核设计文档 §7.4 与 §8.6 后确认**这个字段根本不该
>   存在**：文档里 loop 的 config 只有 `mode` / `cond` / `max_iter` 三件，从未出现 `count`；
>   T4 已提交的语义是「count 模式恰好跑 `max_iter` 轮，while 模式最多 `max_iter` 轮」——
>   一个上限字段兼两职，简单且不会自相矛盾（若再加 count，就会问 count>max_iter 时谁赢）。
>   因此**不动 graph.py，不动 T4 的测试**：count 与 while 的唯一区别是退出原因。
>   教训：改一份已提交、被 27 条测试钉着的契约之前，先证明现契约真的表达不了需求；
>   这次是我先假设了「次数必须有独立字段」，再回头找证据。
> ⑤ `run_children` 的返回必须是**可判定的聚合**，否则 loop/if 无法决定父状态。定死：
>   `run_children(nodes, parent_key) -> BranchResult`，
>   `BranchResult{status: "pass"|"fail"|"error"|"skip"|"cancelled", stopped: bool, outcomes: list}`
>   —— `stopped` 表示因 fail_fast/cancel 提前中断（容器据此不再起下一轮）。T8 的 runner 实现同一
>   契约；T7 用假 run_children 驱动容器语义，所以先把形状钉死。
> ⑥ `foreach` 的 item 写进 vars 时仍受 T6「vars 一律 str」约束：标量 `str()`，dict/list
>   `json.dumps(ensure_ascii=False)`，脚本里再 `json.loads(ctx.vars["u"])`。不写死这条，画布上
>   `${u}` 的显示与断言里的比较会各说各话。

- [ ] **Step 1: 写失败测试**（表驱动 + ASGITransport 内存靶，手法见 1A `tests/test_execution_core.py`：给 run_api 传 transport；**不用** `set_debug_transport`，那是 api_debug 的模块级全局钩子，见勘误 ③）：13 个 kind 各至少一例，必含 loop.while 三次后条件成立退出、loop 到 max_iter 上限、if 走 else、foreach 三行各执行一次且 item_var 逐行变化、break 提前跳出、extract 后下一步 `${uid}` 生效、assert 失败判 fail、group 串行顺序、sleep 300ms 中途置 cancel → 提前结束。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): kind handler registry — api steps and all logic controls`

### Task 8: 顺序解释执行 + 数据集行展开（§8.6）

**Files:**
- Create: `backend/app/modules/scenario/engine/runner.py`
- Test: `backend/tests/test_engine_runner.py`

**Interfaces:**
- Produces: `async def run_graph(db, *, project_id, run_id, graph, env_id, fail_fast=True, max_runtime_ms=1_800_000, expansion_limit=500, transport=None, variables=None, actor=None, bus=None) -> dict`（返回 stats）
  - **签名比原文多了三个 keyword（落地后回填，T9 必须照此传参）**：`variables` = 场景变量层、
    `actor` = 发起人身份快照、`bus` = 事件总线实例。原文那版签名拿不到场景变量层与身份，
    四层变量合并凑不齐、注册表调用（`env_resolve` / `api_case_resolve` 内部有
    `ensure_project_access`）也无从判权限。**T9 的 `_amain` 必须传
    `variables=scenario.variables` 与 `actor={owner 快照}`**，否则数据集步骤按「缺身份」降级。
    三者默认 `None`，向后兼容。
  - 顺序遍历 + 递归子树；**每步边界**查 cancel 与 max_runtime（超时 → 剩余 skip，run=error 且 message 说明）
  - 每步：publish `step/running` → 执行 → `write_step` → publish `step/pass|fail|skip|error`。
    **例外（消费方必须知道）**：fail_fast / 超时之后被 skip 的步骤**不发 `running`**——
    从没执行过的步骤不该在画布上呼吸。所以 `step/skip` 可以没有前置 `running`，
    T11/T12 不得假设「每个步骤都有 running」。
  - 数据集展示键：§8.6 写的 `step_key#r{N}` 是**报告层格式化键**，落库唯一键仍是
    `write_step` 的 `(run_id, step_key, row_no)`。T12 渲染时再格式化，别往库里存 `#rN`。
  - `stats.rows_total` = **实际执行行数**；展开预算另记 `stats.expansions`（超限被拦的行不计入
    rows_total）。要「计划行数」读节点行的 `row_total`。
  - 数据集步骤：api_case 且 resolve 出行 → 逐行执行，`vars = merge_vars(全局, 环境, 场景, 行)`（**行最高**，Review Focus 8），落 `(step_key, row_no)` 明细；节点终态=全行通过才 pass；publish 带 `row_progress="3/10"`
  - `fail_fast=true`：首个非 optional 失败即终止（其余 skip）；`optional=true` 失败不阻断也不判 run 失败；`false`：行失败继续后续行（§8.6）
  - 展开总数（含循环内数据集）> expansion_limit → 立即终止，run=error `expansion_overflow`（Review Focus 2 执行期半边）
  - 每步写 `vars_snapshot`；终态写 `stats={total,pass,fail,skip,error,elapsed_ms,rows_total}` + `summary_graph`（graph ⊕ 每 key 结果，**报告自包含**）
  - **写 detail 前过 `offload_detail`**（Task 14 的 64KB 线，裁剪点按计划在这里）：runner 在
    scenario 内、artifacts 在 execution 内，scenario→execution 是允许方向（契约 4 约束的是
    execution 自己的依赖闭包，不是禁止别人 import 它），可直接 import 不必绕注册表。

- [ ] **Step 1: 写失败测试**：① 三步顺序与状态序列；② fail_fast=true 第 2 步失败 → 第 3 步 skip、run=failed；③ optional 第 2 步失败 → 第 3 步照跑、run=passed；④ 数据集 3 行 → 3 条 row_no 明细 + 节点 pass + rows_total=3；⑤ 数据集第 2 行失败：fail_fast → 第 3 行不跑；非 fail_fast → 3 行都跑、节点 fail；⑥ 场景变量与数据集列同名 → 行值胜出；⑦ `max_runtime_ms=1` + 首步 sleep 200 → run=error 且 message 含超时；⑧ 展开 >500 → expansion_overflow；⑨ 每步 vars_snapshot 非空且随 extract 增长。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): sequential runner with dataset row expansion`

### Task 9: 执行编排 —— enqueue / worker 任务 / 取消 / 租约

**Files:**
- Create: `backend/app/worker.py`、`backend/app/modules/scenario/orchestration.py`、`backend/scripts/verify_worker.py`、`backend/tests/test_execution_worker.py`
- Modify: `backend/app/core/config.py`（`exec_mode: Literal["celery","inline"]="celery"`、`max_runtime_default_ms=1_800_000`）、`backend/app/modules/execution/services.py`（`new_run()` + `RunListIn.status` 词表）、`backend/app/modules/scenario/engine/runner.py`（改调 `new_run`/终态回写口径见下）、`.env.example`（+`TP_EXEC_MODE=inline` 与注释：演示/生产改 celery）、`docs/superpowers/plans/README-1a-demo.md`（启动命令 +1 条 worker）
- Test: `backend/tests/test_execution_worker.py`

**Interfaces:**
- **落点裁定（写码前定，原文没写）**：`enqueue` / `_amain` 住 `scenario/orchestration.py`，不住 `execution`，也不住 `worker.py`。
  理由三条，缺一不可：① `_amain` 要 import `run_graph`（懂 step_graph 协议的东西按 R43 归 scenario），
  放进 `execution` 会当场破契约 4（execution 禁止 import 任何领域模块）；
  ② `worker.py` 是进程入口，`send_task("scenario.run", …)` 按名字投递的意义就是 web 侧不 import 引擎——
  若 `enqueue` 住在 `worker.py`，`scenario_run` 服务为了投递就得 import Celery 与整个引擎，R42 省掉的启动耦合又回来了；
  ③ inline 档的引擎 import **写在协程体内**（函数级 import），于是 `exec_mode=celery` 的 web 进程
  连引擎模块都不会被加载，「不 import 引擎」是可实测的事实而不是一句声明。
- **RunRecord 的构造仍只有一处**：`execution.services.new_run(db, *, project_id, subject_type, subject_id,
  subject_name, env_id, env_name, trigger, created_by, max_runtime_ms) -> RunRecord`（`status="queued"`，
  `flush` 不 commit）。`save_run` 继续服务 1A 的单请求调试（它从 `RunResult` 判终态，语义不同，不合并）。
  终态回写留在 `run_graph` 里（status 由执行决定，回写与决定同源），不新增第二个写入口以外的口径。
- **租约/取消的键名是跨模块协议**：`execution` 读路径要判「进程中断」（Review Focus 6），但契约 4 不许它
  import `scenario.engine.events`。它只能用 `app.core.eventbus.get_bus().exists_key("run.lease."+run_id)`，
  键名字符串因此存在于两处 → **钉一条字符串相等测试**（两边各引用一次），改一边必红。
- **测试/演示环境的 exec_mode 裁定（T9 落地时定，owner 已裁）**：`exec_mode` 默认保持 celery，
  但 `backend/tests/conftest.py` 以 `os.environ.setdefault("TP_EXEC_MODE","inline")` 给 pytest 设默认
  （显式声明仍优先——T24 的 celery 端到端自配），`web/playwright.config.ts` 的 e2e webServer env
  同样加 `TP_EXEC_MODE:"inline"`。理由必须说在白处：**D5「执行链真走 worker」的唯一证明点是
  `scripts/verify_worker.py`（真 broker + 真 worker 子进程）**；e2e 断言的是产品行为，把 e2e 绑在
  第二个受管进程上只会添 flake、不会多覆盖任何 worker 做出来不一样的东西。手工/演示用 celery 时
  「没开 worker」必须是响亮的 503（R42 的承诺），三处都不许出现「悄悄降级」。
- **报告排序键裁定（R70 落码）**：`report_list` 按 `COALESCE(started_at, created_at)` 降序 + id 兜底，
  对外仍回真 `started_at`（未开始/1A 老行如实显示「—」但参与时间线）。**不**给 queued 提前写
  `started_at`——「开始」一个词两个意思、耗时列跟着说谎（R70 原文）。游标键因此永不为 NULL，
  `bad_cursor` 断链（R70 实测）由构造消灭。`run_record_list` 的游标走 `created_at`（NOT NULL），**不动**。
  连带：`ReportListIn.status` 的 pattern 与 `RunListIn.status` 同源放宽为六态词表
  （queued/running/passed/failed/error/cancelled），否则报告中心筛不出 running/cancelled。
- **actor 携带方式修正（落地回填，对原文「_amain 传 actor={owner 快照}」的最小改动）**：actor 由
  `enqueue` 的调用方携带（T11 的 `scenario_run` 有真 ctx 身份），随 Celery 任务参数传给 worker。
  不按原文「worker 端查 owner 快照」：① scenario import iam 破契约 1；② 谁触发、以谁的身份跑，
  本来就该由触发点定，owner 兜底反而制造「谁都不负责」的执行。`actor=None` = 系统触发，
  runner 已有「缺身份」降级语义（T8 落地回填）。
- **worker 协程的两处落地修正（实测逼出，写进计划免得复刻 spike 的坑）**：
  ① `init_bus()` 从 `_boot()` 挪进任务协程体内：redis-asyncio 连接池绑死首次使用的 loop，
  solo 池每任务一个 `asyncio.run`，复用全局旧 bus 会在第二个任务上炸 "attached to a different loop"；
  ② `_amain` 用一次性 NullPool 引擎（用完 dispose），不用 `app.core.db` 的全局 sessionmaker——
  同一条 loop 亲和性教训（1A 踩过 asyncmy 跨循环）。
- Produces:
  - `app/worker.py`：`celery_app`（broker/backend 用 `settings.redis_url`，`task_serializer="json"`、`worker_send_task_events=False`、`worker_prefetch_multiplier=1`）；`@celery_app.task(name="scenario.run")` → `_boot()` → `asyncio.run(_amain(run_id))`；`_boot()` = **幂等调用 `from app.main import create_app; create_app()`**（不叫 REGISTRY 就是空的，1A 已证实）+ `init_bus()`；`_amain` 载 run/场景 → `renew_lease`（抢不到 = 已有他人持有 → 直接退出，不双跑）→ run 转 `running` + `started_at` → `run_graph(**载荷)` → publish `run_end` → 释放租约。Windows 起法写进 README：`celery -A app.worker:celery_app worker --pool=solo -l info`
  - `_amain` 必须传 `variables=scenario.variables` 与 `actor={owner 快照}`（R67：不传则场景变量层与身份缺失）
  - `enqueue(db, ...) -> RunRecord`：`new_run()` → commit → 按 `settings.exec_mode` 走 `send_task("scenario.run", [run_id])`（**按名字投递，web 进程不 import 引擎**）或同进程 `asyncio.create_task(_amain(run_id))`；**broker 连不上 → 503 `executor_unavailable`** 且 message 指向「worker 未启动」，不静默降级（R42）。inline 档的协程句柄要**持住引用**（`asyncio` 只持弱引用，裸 create_task 的任务可能被 GC 掉——那是「提交后无声无息」的最难查的一种）
  - `scripts/verify_worker.py`：把前置取证的 spike 转正为仓库内自检脚本——自起 worker（solo）→ 投一个真场景 → 断言 run 终态 + 步骤行数 + 事件序列 `step running/pass … run_end` → 自杀退出码 0/非 0。这是 §13 纪律 1 要的「业主亲手能跑的演示」。
  - `run_record.status` 词表扩为 `queued/running/passed/failed/error/cancelled`；`RunListIn.status` pattern 放宽以支持筛「运行中」。
- 说明：`inline` 跑的是**同一份引擎**，不是假执行；差别只在谁起协程（pytest 与单机演示用 inline，CI 不必起 worker）。

- [ ] **Step 1: 写失败测试**：① `exec_mode="inline"` 端到端出终态；② `exec_mode="celery"` + 假 broker → 503 `executor_unavailable`；③ cancel：置位后 sleep 步 ≤600ms 结束、run=cancelled、已完成步骤明细仍在；④ 租约：把 `run.lease.{id}` 指向不存在 owner 且 TTL=1 → 查询路径判中断并标 error（Review Focus 6）；⑤ 真跑 `python scripts/verify_worker.py`（自起自杀 worker），输出贴进 ledger。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿 + 真跑 verify_worker** → **Step 5: Commit** `feat(execution): Celery worker path with cancel, lease and inline fallback`
- **风险与退路**：若 `acks_late` + solo 出现重复消费 → 改默认 acks 并把 run 的「已领取」做成原子位；**不得**把 `exec_mode=inline` 当默认交付（那会让 D5 变成空话）。

### Task 10: scenario 资产面 —— 模块树 + CRUD + 乐观锁 + 引用检测

**Files:**
- Create: `backend/migrations/versions/0016_scenario.py`
  - `scenario`：id, project_id(index), module_id null, name, status(normal/recycled), priority default P2, step_graph JSON, variables JSON, fail_fast smallint default 1, max_runtime_ms int null, env_id null, owner_id, project_public default 1, version int default 1, step_count int default 0, last_run_at datetime null, last_run_status String(16) null, updated_by + UniqueConstraint(project_id,name) + TimestampMixin
  - `scenario_module`：镜像 `api_module`（id, project_id, parent_id null, name, sort, status + UniqueConstraint(project_id,parent_id,name)）
  - down 全 drop
- Create: `backend/app/modules/scenario/{models,module_services,services,schemas}.py`
- Modify: `backend/app/modules/api_test/case_services.py`（`_used_by` 增场景口径：只数**未回收**场景中 `kind=api_case && ref=case_id` 的引用）
- Test: `backend/tests/test_scenario_crud.py`、`backend/tests/test_scenario_module.py`

**Interfaces:**
- Produces（@service ×11）：`scenario_module_tree/create/update/delete/restore`（perm `scenario:module:*`；环检测、软删自身+后代、**根层重名服务层自查**（MySQL 唯一索引不判等 NULL，1A 教训）全套照抄 api_module 行为）；`scenario_list/create/get/update/delete/restore/purge`（perm `scenario:read/create/update/delete`）；`scenario_duplicate`；`scenario_batch_move`；`scenario_references`（read，供接口详情「场景引用」Tab：给 definition_id 或 case_id → 引用的未回收场景 + 命中步骤 key 列表）。
- `scenario_create/update`：graph 过 T4 `validate()`，有 issue → 422 `validation_error` + `details.issues`；`update` 带 `version` 乐观锁 → 409 `conflict` + `current_version`（Review Focus 5），成功则 `version+=1`、重算 `step_count`、记 `updated_by`；`scenario_get` 同时返回 `issues`（**打开老场景就看见问题**，不必等保存报错）。
- `scenario_purge`：`tool=False` + 输名确认 + 仅回收站可 purge（`name_mismatch` / `not_recycled` 两个 409，与 1A 同手感，R53）。
- 私有资源可见性沿用 1A 谓词；列表「最近结果」用 `last_run_at/last_run_status`（T9/T11 终态回写），不 N+1 查 run_record。

- [ ] **Step 1: 写失败测试**：① CRUD + 乐观锁（旧 version → 409 且 current_version 正确）；② 校验拦截（break 在循环外 → 422 且 issues[0].node_key 命中）；③ 回收站三件套（delete→list 不可见、recycled=true 可见、restore 回归、purge 输名不符 → `name_mismatch`、未回收 purge → `not_recycled`）；④ 模块树环检测 + 软删后代 + 根层重名 409；⑤ 引用检测（用例被 2 个未回收场景引用 → `scenario_references` 两条含步骤 key；场景回收后不计；`data_set_delete` 两道拦截 + `DatasetOut.scenario_held` 与 409 口径一致，Review Focus 9 勘误）；⑥ 非成员 403、READONLY 无写、MEMBER 无 `*:delete` 不可删；⑦ 同项目场景重名 409。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): scenario + module assets with optimistic lock and reference detection`

### Task 11: 场景执行 / 调试 / 取消 / 单步重跑 / SSE 端点

**Files:**
- Modify: `backend/app/modules/scenario/services.py`、`schemas.py`
- Create: `backend/app/modules/scenario/routes.py`（SSE 不是 @service：返回 StreamingResponse、无 Pydantic 模型，沿用 agent SSE 的挂载与鉴权写法）
- Test: `backend/tests/test_scenario_run.py`、`backend/tests/test_run_sse.py`

**Interfaces:**
- Produces（@service）：
  - `scenario_run`（perm `scenario:run`, effect=write, POST /scenarios/{id}/run）→ `{run_id, status:"queued"}`（走 T9 enqueue；trigger 默认 `manual`，Agent 入口自动 `agent`）
  - `scenario_debug`（perm `scenario:run`, effect=write）入 **未保存的 `graph`** + env_id → `run_id`，`trigger="debug"`，跑传入版而非库里的（§11.5.6 调试语义；Review Focus 11）
  - `run_cancel`（perm `scenario:run`, effect=write）→ 置 `cancel:{run_id}`
  - `run_rerun_step`（perm `scenario:run`, effect=write）入 `{run_id, step_key, row_no?}` → 新 run（`stats.rerun_of` 记来源）只跑该步，用该步 `vars_snapshot` 重建 ctx（§8.3）
- SSE：`GET /api/v1/events/run/{run_id}` → `sse_response(request, "run."+run_id, replay_fn)`；鉴权 = 项目成员 + `api:run:read`；游标取 `Last-Event-ID`。
- 终态回写 `scenario.last_run_at/last_run_status`。

- [ ] **Step 1: 写失败测试**：① `scenario_run`（inline）轮询到终态，明细齐全，`summary_graph` 每 key 有状态；② `scenario_debug` 传与库里不同的 graph → 跑的是传入版且 trigger=debug；③ `run_cancel` 中途取消 → cancelled；④ `run_rerun_step` 靶场调用计数 ==1、上游 extract 的 `${uid}` 在重跑中仍可用、`stats.rerun_of` 指向原 run；⑤ SSE 两种时序（跑完再连 → 全量重放 seq 单调；跑到一半连 → 重放+直播不重不漏，Review Focus 3 两个用例）；无权限 403；⑥ 重复投递同 run_id 不双写步骤（幂等）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): run/debug/cancel/single-step rerun + run SSE`
- **顺序勘误（主线裁定，写码前先改计划）**：本任务的 ④ 依赖 `run_single_step`，而它写在 **Task 13**——原文的 T9→T11→T12→T13 顺序会让 T11 要么发明一个临时版单步重跑、要么留一个 501 假端点，两个都违反诚实原则。**执行顺序改为 T9 → T13 → T11**：T13 是纯引擎件（`run_single_step` + 快照重建，无 HTTP），先行落地后 T11 的 `run_rerun_step` 一次接线就是真的。T12/T14 不在这条链上（T12 已交付，T14 已交付）。
- **写码前补齐的落点与口径（T11 落地裁定）**：
  ① **debug 的图随 run 行走**：`scenario_debug` 把 `{graph, variables, fail_fast}` 写进
     `run_record.request_snapshot`（1A 闲置列「执行了什么」的语义位），`_run_claimed` 对
     `trigger=debug` 的 run 执行**行上的图**而非 `scenario.step_graph`——queued 语义自包含，
     场景行连 existence 都不再需要（未保存的新场景 debug 也成立）。debug **不回写**
     `scenario.last_run_*`：debug 是过程不是结论（Review Focus 11 延伸到冗余列），
     「最近结果」只认 manual/schedule/agent/webhook。`new_run`/`enqueue` 相应增
     `request_snapshot` 透传（建行时就完整，inline 协程没有读-写竞态窗口）。
  ② **传输注入走 1A 同款钩子**：`scenario.services` 增设 `set_debug_transport(factory)`
     （与 `api_test.services.set_debug_transport` / `tasks.set_gateway_factory` 同款，
     仅供测试注入）——enqueue 走 HTTP 路由进来时没有任何通道把内存靶 transport 递进
     inline 协程；不注入时恒 None（真网络），生产路径零影响。
  ③ **SSE 路由的依赖由装配层注入**：契约 1 把 `scenario` 与 `iam` 判了独立性，
     `get_current_user` 是 iam 的私有依赖——`scenario/routes.py` 不许 import 它。
     照 `core.build_router` 的形状出 `build_scenario_router(*, get_db_dep, get_user_dep,
     user_model)`，`create_app` 注入（Files 追加 `Modify: backend/app/main.py`）。
     鉴权复用 `core.build_ctx`（与 @service 同一条数据权限门）+ `ctx.require("api:run:read")`；
     run 归属项目校验同 `report_get` 尺（跨项目 404 不泄露存在性）。
     模块级另出 `build_run_sse(db, request, project_id, run_id, cursor)` 供测试直调
     （agent 的 `build_agent_sse` 同法）。
  ④ `run_cancel`：queued/running → 置 `tp.cancel.{run_id}` 旗 + `cancel_requested=1`；
     已终态 → 409 `already_finished`（取消一个跑完的 run 是用户点错了，不是成功 no-op）。
  ⑤ `run_rerun_step` 是同步等待的（run_single_step 本就 await 完成）→ 响应带终态
     `{run_id, status}`，前端不必再轮询；`run_single_step` 补 run_graph 兜底 try/except
     （对齐 `_amain`：引擎炸穿 run 也必须落终态，不许永远 queued）。
  ⑥ trigger 词表在服务层的口径：HTTP 入口 `scenario_run` 只接受 `manual`；
     Agent 入口（`ctx.entry == "agent"`）**自动**改 `agent`——trigger 是事实记录，
     不许调用方自选 schedule/webhook（那两条链路 1B 还不存在，出现即撒谎）。


---

## 报告与制品（T12-T14）

### Task 12: 报告中心查询面（列表 + 详情 + 步骤明细）

**Files:**
- Modify: `backend/app/modules/execution/services.py`（或新建 `execution/report_services.py`，以单文件不超 400 行为准）、`schemas.py`
- Test: `backend/tests/test_report_center.py`

**Interfaces:**
- Produces（@service）：
  - `report_list`（perm `api:run:read`, read, GET /reports）入 `{project_id, subject_id?, trigger?, status?, env_id?, created_by?, since?, until?, include_debug?=false, cursor?, size?}` → Page of `{id, subject_name, subject_type, trigger, env_name, created_by_name, status, stats, pass_rate, elapsed_ms, started_at}`。**默认 `include_debug=false`**：报告中心是结论，调试过程去运行记录页看（Review Focus 11）。筛选维度对齐 §11.4.15（时间/场景/触发/执行人/环境/结果）。
  - `report_get`（perm `api:run:read`, read, GET /reports/{run_id}）→ run 概要 + `summary_graph`（自包含，含每 key 状态）+ 步骤明细摘要（数据集步带 pass_rows/total_rows）+ 制品列表。**不 join api_case/scenario**（Review Focus 10）。
  - `report_step_detail`（perm `api:run:read`, read）入 `{run_id, step_key, row_no?}` → detail 全量（request/response 对照、断言表、logs、vars_snapshot）；超阈值字段按 ref 附制品下载地址。
- pass_rate 口径：`pass / (total - skip)`，数据集步按节点计 1 步（§8.6 统计口径）。

- [ ] **Step 1: 写失败测试**：① 默认列表不含 trigger=debug，`include_debug=true` 可见；② 六个筛选维度逐一生效（含 since/until 取等边界）；③ pass_rate（10 步 8 pass 1 fail 1 skip → 8/9）；④ **先把场景与用例 purge 干净**再 `report_get` → 仍完整返回（Review Focus 10）；⑤ 游标分页与 started_at desc；⑥ 跨项目 run_id → 404；READONLY 可读报告。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(execution): report center query surface`

### Task 13: 单步重跑的上下文重建（§8.3 完整版）

**Files:**
- Modify: `backend/app/modules/scenario/services.py`、`engine/runner.py`（增 `run_single_step`）
- Test: `backend/tests/test_rerun_step.py`

**Interfaces:**
- Produces: `run_single_step(db, *, project_id, source_run_id, step_key, row_no=None, env_id=None, transport=None) -> run_id`：从该步 `vars_snapshot` 还原 vars；`last_response` 取该步 detail.response，缺省回落到同 run 内最近一条有响应的步骤；env 默认沿用源 run（可覆写）；新 run 的 `summary_graph` 只含该步并带 `{"rerun_of": source_run_id, "step_key": ...}`。
- 边界：源步是容器（loop/if/foreach）→ 重跑**整个容器子树**（语义完整优先）；明细已被清理 → 409 `snapshot_missing`；给了 `row_no` → 只重跑那一行。
- **写码前补齐的落点与口径（T13 落地裁定）**：
  ① **源节点取自源 run 的 `summary_graph`，不读 `scenario.step_graph`**——Review Focus 10 的
     自包含承诺延伸到重跑：场景 purge 之后重跑仍要能重建步骤（api_case 步骤 resolve 不到
     会以步骤 error 诚实失败，但图与变量重建不依赖资产存活）。
  ② `run_single_step` 增 keyword `actor`（与 run_graph 同族）与 `trigger="manual"` 默认、
     `created_by`：新 run 行由它经 `execution.services.new_run` 出生（写入口唯一不破）。
     actor 无法从库里凭空造——谁点重跑谁的身份，T11 的 @service 传 ctx 快照。
  ③ `last_response` 回落的「同 run 内最近一条有响应的步骤」按 **run_event.seq** 倒序找
     （执行顺序的唯一真相；run_step_result 没有顺序列，created_at 是秒精度排不出来）。
  ④ `row_no` 给定时通过 `run_graph` 新参数 `dataset_rows`（覆盖 resolve 出的行集，只留那一行）
     实现，行按 **resolve 结果的原始下标** 选——重跑发生在数据集被改之后时按新行跑，这是
     可解释的语义（改过的行本来就该按改过的跑）；行号越界 → 400 `validation_error`（不是
     静默跑空）。vars 基底 = 该行的 `vars_snapshot`；`run_graph` 会把**新** resolve 的行值
     再合并上去（行最高，与 §8.6 同一口径）——数据集里已删除的列在快照里留旧值，这是
     可解释的残留，写进注释。行号边界只能在**建行前**判（run_single_step 自己经 REGISTRY
     resolve 一次拿行数），所以 `row_no` 重跑必须带 actor，缺 actor → 400（不是 403：
     这是参数可满足性问题，不是权限判决）。明细行在新 run 里按**源行号**落
     （`row_no=3` 的重跑仍写 `(ds, 3)`，报告的 `step_key#r3` 展示键与源 run 对得上）。
  ⑤ `summary_graph` 的新 run 形状：`{"version":1,"nodes":[源节点],"rerun_of":<src>,"rerun_step":<key>[,"rerun_row_no":n]}`，
     `stats` 同时带 `rerun_of/rerun_step`（T11 判据④与报告页跳转都读 stats）。
  ⑥ 409 `snapshot_missing` 的三种形态合并成一个诚实口径：步骤行不存在 / 步骤行没有
     `vars_snapshot` / 源 run 没有 `summary_graph`（或其里找不到该 key）——三者都叫
     snapshot_missing，message 分别说清缺的是哪件（「查不到该步骤的执行明细」/「缺变量快照」/
     「缺步骤图快照」）。
  ⑦ **Files 勘误**：T13 不动 `scenario/services.py`——@service `run_rerun_step` 是 T11 的接线，
     本任务只交付引擎件 `run_single_step`（放 `engine/runner.py`）+ 测试。

- [ ] **Step 1: 写失败测试**：① 上游 extract 的变量在重跑中可用（证明快照真被用上）；② 容器步重跑跑完整子树；③ 指定 row_no 只跑一行；④ 明细缺失 → 409 `snapshot_missing`；⑤ 原 run 状态不被改写。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(scenario): single-step rerun rebuilt from step snapshot`

### Task 14: 大响应体外置制品（§8.8 的 64KB 线）

**Files:**
- Create: `backend/app/modules/execution/artifacts.py`（`save_artifact(project_id, run_id, kind, blob) -> ref` 写入 `{artifacts_dir}/{run_id}/`；`artifact_path(ref)` 带越界防护；下载端点 `GET /api/v1/artifacts/{run_id}/{name}`，鉴权 `api:run:read`）
- Modify: `backend/app/modules/scenario/engine/runner.py`（写 detail 前裁剪）、`engine/events.py`（`offload_detail`）、`backend/app/core/config.py`（`artifact_max_bytes=65536`）
- Test: `backend/tests/test_artifacts.py`

**Interfaces:**
- Produces: detail 里 `response.body_text` 或 logs 超阈值 → 落文件，DB 存 `{"_ref": "...", "truncated": true, "bytes": N, "head": "前 2KB 预览"}`；单条 detail 落库总大小 ≤ 阈值（§8.8 的动机：别让大行拖垮备份）。
- 越界防护：ref 只接受 artifacts 根下相对路径，含 `..` 或绝对路径 → 400（**防止报告页变成任意文件读取器**）。
- **前端调用必须带 `project_id`（query，必填）**：数据权限门只有 `build_ctx` / `ensure_project_access` 那一条通道，它认的是 payload 里的 `project_id`；`GET /api/v1/artifacts/{run_id}/{name}` 光靠路径判不出项目归属，非成员就能读任意 run 的制品。与 `report_get` 同尺（跨项目一律 404，不泄露存在性）。T22 的「制品下载链接」得把 `project_id` 拼上去。
- **实测事实（写代码前读过探针）**：`../`、`..%2f`、绝对路径在 URL 规范化层就被路由 404，**根本到不了 handler**；真能到达的是 `..%5c`、`%2e%2e` 这类编码变体。所以测试必须打能到达 handler 的变体——否则一片 404 是「看起来挡住了」的假绿，防护重心在解码后校验。

- [ ] **Step 1: 写失败测试**：① 200KB 响应体 → DB 存 ref + head，文件存在且字节数对；② 阈值内不外置（无文件产生）；③ 下载端点返回原字节与正确 content-type；④ `../.env` 与绝对路径 → 400；⑤ 无权限 → 403；⑥ 场景 purge 后制品的处理策略（删除或保留）在测试与注释里都写明。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(execution): offload oversized responses to artifacts`

---

## 前端（T15-T22）

### Task 15: 依赖接入 + 导航解禁 + 通用 SSE 抽取

**Files:**
- Modify: `web/package.json`（+`@xyflow/react@^12`、`elkjs@^0.12`；**Monaco 留到 T16 探针之后**）,`web/src/layout/shell.tsx`（场景编排加 `to:"/scene"` 解禁；任务中心加「报告中心」`to:"/reports"`）,`web/src/App.tsx`（路由 +2）,`web/src/api/schema.d.ts`（`pnpm gen:api` 重生成）
- Create: `web/src/api/scene.ts`、`web/src/api/report.ts`、`web/src/shared/sse.ts`
- Test: `web/e2e/nav.spec.mjs`（改：场景/报告中心可点击并落地正确路由）

**Interfaces:**
- Produces: `sceneApi`（list/get/create/update/delete/restore/purge/run/debug/cancel/rerunStep/references）、`reportApi`（list/get/stepDetail）、`openRunStream(runId, handlers)`。
- `shared/sse.ts` 从 `agent/sse.ts` 抽出通用实现（fetch + Bearer + `Last-Event-ID` + `\n\n` 分帧 + seq 去重 + 1500ms 重连），agent 与 run 两条通道共用；`agent/sse.ts` 改成薄封装（**纯重构，行为不变**）。
- 诚实原则：导航里 UI 测试 / ADB 仍 disabled +「1C/1D 开放」。

- [ ] **Step 1: 装依赖**（`pnpm add @xyflow/react elkjs`）→ **Step 2: 抽 SSE 后先跑 `pnpm exec playwright test`**，确认 agent 相关 e2e 仍是 23 passed（重构不许改语义）→ **Step 3: 导航与路由** → **Step 4: `pnpm build` + e2e 绿** → **Step 5: Commit** `feat(web): scene deps, nav unlock, shared SSE stream`

### Task 16: Monaco 探针（先证明再接入）

**Files:**
- Create: `web/src/components/CodeEditor.tsx`（自托管 worker：`monaco-editor` 手动 import worker，vite `?worker` 语法）、临时探针路由
- Modify: `web/vite.config.ts`（如需 worker 配置）

**Interfaces:**
- Produces: `<CodeEditor language value onChange height/>`，**离线可用**（禁止走 CDN——内网自托管是硬要求）。

- [ ] **Step 1: 装 `monaco-editor` + `@monaco-editor/react` 并接探针页** → **Step 2: 四项实测并记进 ledger**：`pnpm build` 是否成功；产物体积增量（对比 1A 记录）；`vite preview` 下能输入 + 高亮 + **Network 面板零 CDN 请求**；Playwright 能定位编辑器（e2e 可测性）。→ **Step 3: 决定**：全过 → 保留封装供 T20/T22 用；任一不过 → **停下回来改本计划的 R49**（附失败证据与替代方案）。**不得**静默降级成 textarea 交付（那是对 §5.2 的违约）。→ **Step 4: 删探针路由，Commit** `chore(web): self-hosted Monaco wrapper proven`

### Task 17: 场景列表页（§11.4.8 / §11.5.6）

**Files:**
- Create: `web/src/pages/scenes.tsx`
- Test: `web/e2e/scenes.spec.mjs`

**Interfaces:**
- Produces: 左 `scenario_module` 树（沿用 1A ModuleTree 的交互约定：新建子级/重命名/移动/删除带引用检测/底部回收站入口）+ 右列表：名称 | 模块 | 优先级 | 最近结果（`last_run_status` 状态点）| 步骤数 | 定时（1B 恒「-」并注明 1E 开放）| 负责人 | 更新时间；批量条：执行(选环境)/移动/复制/回收站；「+ 新建场景」下拉：空白 | **从用例生成**（勾选 N 个 api_case → 生成顺序步骤骨架）| 让 Pilot 生成（提示 1F 开放）。

- [ ] **Step 1: 写 e2e**：建模块 → 空白新建 → 列表可见 → 「从用例生成」选 2 个用例 → 落地画布且步骤数=2 → 批量移动 → 删除进回收站 → 恢复 → 彻底删除（输名确认；**AntD 两字按钮标签会变「回 收」**，1A 教训）。→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: e2e + `pnpm build` 绿** → **Step 5: Commit** `feat(web): scenario list with module tree and generate-from-cases`

### Task 18: step_graph 图操作（纯 TS，画布与列表共用）

**Files:**
- Create: `web/src/scene/graphOps.ts`、`web/src/scene/stepTypes.ts`
- Test: `web/src/scene/graphOps.test.ts`（**Vitest**：§5.3「Vitest + Playwright E2E」与 §14「画布步骤树序列化/反序列化必测往返一致」两处点名，属计划内依赖，不算擅自加库。本计划初稿曾写「不引 Vitest、用 e2e 顶」，与文档冲突，已按「冲突先改计划」的规矩纠正。）另加 `web/vitest.config.ts` 与 `package.json` 的 `test` 脚本，并把它加进 CI 门禁

**Interfaces:**
- Produces（纯函数 + 不可变更新）：`insertAfter / insertInto / remove / rename / toggleDisable / moveIntoContainer / duplicate / reorder / findByKey / walk / countSteps / nextKey`；`kindMeta(kind)` → 标签/域色（§11.6.3：API `#5B8FF9`、逻辑 `#8B8E94`、循环 `#4C86E8`、判断 `#D48806`）/图标/默认 config；`createUndoStack(limit=50)`；`toGraphV1(nodes, layout)` / `fromGraphV1(graph)`（§7.4 协议的**唯一**序列化点）。
- 前端预检复用与后端同源的规则子集（`validateLocal(nodes)`：key 唯一、深度 ≤10、break/continue 必须在循环内、必填 config），**后端仍是最终真相**。

- [ ] **Step 1: 装 `vitest`（devDependency，§5.3/§14 点名件）并接 `pnpm test` 脚本** → **Step 2: 写失败单测**：`toGraphV1/fromGraphV1` 往返一致（嵌套 if 分支 + loop children + layout + disable + 场景变量全覆盖，§14 硬条款）、`nextKey` 删除后不复用、`moveIntoContainer` 不能把容器塞进自己的后代、undo 超 50 步丢弃最旧、`validateLocal` 与后端 T4 规则同源（同一份畸形 graph 两边结论一致）→ **Step 3: 跑红** → **Step 4: 实现到绿** → **Step 5: `pnpm build` 不受影响 + Commit** `feat(web): step_graph operations with round-trip unit tests`

### Task 19: 场景画布（三栏工作台，§11.4.9 / §11.7.3）

**Files:**
- Create: `web/src/scene/SceneEditor.tsx`、`Canvas.tsx`、`NodeView.tsx`、`AssetTree.tsx`、`PropsPanel.tsx`、`IssuePanel.tsx`、`web/src/scene/layout.ts`（elkjs 自动布局；节点 224×64，容器头 40，垂直距 48）
- Test: `web/e2e/sceneCanvas.spec.mjs`

**Interfaces:**
- 布局：左资产树 240 | 画布 flex | 属性面板 360（收起为 40 边缘签）+ 底部问题面板 + 顶部工具条（模式 画布|列表、环境选择、保存 ⌘S、调试、执行）。
- 画布用 `@xyflow/react`，但**连线由树结构生成、用户不能自由拉边**：§7.4 明确「无 DAG 汇聚边，画布连线仅是先后可视化」。改结构走拖拽/右键，不走画边——这是与通用 flow 编辑器的关键差异，实现者别顺手开 `onConnect`。
- 左树：API 用例（可搜索、可拖入）+ 逻辑控件清单（循环/判断/遍历/等待/脚本/提取变量/断言/设变量/分组）；UI 用例与 ADB 用例节点显示但 disabled +「1C/1D 开放」。
- 右键菜单：重命名 / 复制 / 禁用 / 删除 / 插入到后 / 移入容器；容器头操作条：循环类型（count|while + max_iter / cond）、if 增删分支与 else、折叠；框选成组 = 生成 group。
- `PropsPanel`：Tabs 配置/断言/高级（label 上置）；`break/continue` 被拖到循环外 → **立刻**红角标（前端预检，不等后端）。
- 保存：先本地 `validateLocal` → 后端 `validate` 422 → 问题面板列出并可点击定位；**乐观锁 409 → 差异对比弹窗**（我的 vs 服务器，左右并排 + 三选：用我的 / 用服务器 / 复制我的到剪贴板；默认不覆盖他人）。
- 缩放 0.5-2.0、进页自动适配、小地图 120×80；undo/redo 50；未保存离开确认。
- 状态：zustand（graph + undo 栈 + dirty + 选中 key），保存成功后同步 `version`。

- [ ] **Step 1: 写 e2e**：拖入两个 api_case → 保存 → 重开数据一致；套一层循环并嵌套 → 保存重载结构不变；把 break 拖到顶层 → 红角标出现且保存被拒（面板可见 issue 文案）；两个 page 同开同一场景，后者保存 → 409 → 差异弹窗出现；⌘S 触发保存；连按 5 次 Ctrl+Z 回到初态。→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: e2e + build 绿** → **Step 5: Commit** `feat(web): scenario canvas — three-pane workbench, validation, conflict diff`

### Task 20: 列表模式 + 场景级面板 + 调试抽屉

**Files:**
- Create: `web/src/scene/ListMode.tsx`、`web/src/scene/DebugDrawer.tsx`；Modify: `SceneEditor.tsx`、`PropsPanel.tsx`
- Test: `web/e2e/sceneList.spec.mjs`

**Interfaces:**
- 列表模式（§11.4.10）：树形行 = 启用勾选 + 序号（1 / 2.1）+ 类型图标 + 名称 + 摘要（如 `API·创建订单 (POST /order)`）+ 行操作 [+] 与 [···]；展开折叠、拖拽排序与嵌套、搜索步骤定位、剪贴板（复制→粘贴(N)）；与画布**同一 graph 同一时刻**（无损切换）。
- 场景级右面板：基本信息 | 场景变量表（增删改）| 失败策略（遇错停止 / 忽略继续 = `fail_fast`）| 执行超时（`max_runtime_ms`，默认 30min）| 公共断言（场景级，执行期对最后一步求值）| 定时绑定（1B **disabled +「1E 开放」**）| 引用提示。
  （**落地修正 R85：公共断言是 T20 交付里唯一的静默缺口**。d6bfafe 的场景级面板只落了
  基本信息/变量/失败策略/执行超时/定时绑定/引用提示，公共断言**四处全无**——`scenario`
  表无列、`ScenarioCreateIn/UpdateIn/Out` 无字段、引擎不求值、UI 无入口，且 ledger 当时
  没记这一刀（对比：批量删除、模型配置中心界面都是**写明**砍掉的）。
  「计划里有、代码里没有、台账里也没记」正是 §13 纪律 1 禁的那类：演示时点不到、
  评审时说不清。补交付为 **T20b**，不砍（求值器 `app/shared/assertions.py:evaluate`
  与断言编辑抽屉都是现成的，成本一天内；砍掉则「场景级质量门」这条能力在 1B 直接消失）：
  · 后端：`scenario.common_assertions` JSON 列（迁移 0017，**必带 down**）+ 三个 schema 字段
    + `run_graph(common_assertions=...)`：拓扑跑完后对 `ctx.last_response` 求值，
    任一失败 → run 判 **failed**（不是 error：断言没过不是跑不动，与 §8.6 口径一致），
    失败明细写进 `stats.message`；`last_response is None`（空图/末步没发请求）→ **不判**，
    不拿「没响应」冒充「断言失败」；debug 与 manual 同路（都读入队快照，裁定①同源）。
  · 前端：场景级面板加「公共断言」区，复用步骤断言抽屉的行编辑；空列表 = 不启用。
  · 测试：后端专项（过/败/无响应三态 + 保存重载 + debug 生效）、e2e 一条（面板加了断言
    → 执行 → 报告里判负可见）。**守卫按 R79 做变异验证**：撤「判 failed」那一步必须变红。）

  （**语义修正 R88，业主 2026-11-15 直接裁定，推翻上面「对最后一步求值」那半段**：
  原话「公共断言一般不挂在最后一步，一般挂在每个步骤上，所有步骤通过才算过」。
  405647b 做成了 MeterSphere 式的**收尾门**（拓扑跑完拿 `last_response` 判一次），
  业主指的是 MeterSphere 里另一种用法——**全局断言作用于每一个采样器**。两者不是
  「哪个更常见」的口味之争，是**能力不同**：收尾门只能约束末步，逐步门能约束每一次调用
  （比如「全场任何一次响应都不许出现 `{"code":500}`」「每次都要返回 traceId」）。
  落地改为：
  · **作用点 = 每一次真正发出请求并拿到响应的时刻**（`handlers._send` 单一咽喉，
    http_direct 与 api_case 共用），与该步自己的断言**同一轮求值、同一套语义**
    （optional / fail_fast / 状态判定一视同仁，不另开第二套判定）。
  · **求值行并入该步的断言行**并打 `scope="common"` 标记 → 该步 pass/fail 自然含公共断言，
    报告通过率环与状态徽标**自动一致**（R86 那条「环 100% + 徽标断言失败」的观感矛盾
    随本次语义修正自然消失，不需要展示层补丁）。
  · 请求本身失败（网络不通 = error）**不叠加**公共断言判定：error 是比断言更高的事实层。
  · 取消/跳过/未执行的步骤不判。**run 级不再单独求值**，`stats.common_assertions`
    这个 run 级键随之取消（逐行结果现在在**步骤明细**里，位置更对）。
  · 面板与手册文案同步：不是「执行结束时判一次」，是「每一个请求步骤都判」。
  · 测试改口径（R79 变异验证照旧）：① 第一步过、第二步不过 → run failed 且**只有第二步**
    那行带未通过的 common 行；② 全部步骤都过 → passed；③ 无请求步骤的图 → 不判不报错；
    ④ 请求 error 的步骤不产 common 行；⑤ 保存重载与 debug 生效两条不变。）
- 底部调试抽屉：默认高 300，可拖 120~60vh；**跑当前未保存草稿**（`scenario_debug`）；步骤执行树 + 响应日志；运行中节点呼吸高亮（processing 1.2s，`prefers-reduced-motion` 下改静态描边）。

- [ ] **Step 1: 写 e2e**：画布加 3 步 → 切列表模式数量/顺序/嵌套一致 → 列表拖拽换序 → 切回画布一致；场景变量加 `uid=1` → 保存重载仍在；点调试 → 抽屉出现步骤树且终态徽标=通过；失败策略切「忽略继续」→ 保存后 GET 回来 `fail_fast=false`。→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: e2e + build 绿** → **Step 5: Commit** `feat(web): list mode, scenario panel, unsaved-draft debug drawer`

### Task 21: SSE 实时进度接入（画布呼吸高亮）

**Files:**
- Modify: `SceneEditor.tsx`、`DebugDrawer.tsx`、`Canvas.tsx`（NodeView 即 NodeInner，T19 起在 Canvas.tsx 内）、`web/src/styles.css`（呼吸 keyframes 落全局样式表；theme.ts 是 antd token，放不了 @keyframes）
- Test: `web/e2e/sceneRun.spec.mjs`

**Interfaces:**
- `openRunStream(projectId, runId, handlers)` → 节点状态色：running 呼吸 / pass 绿 / fail 红 / skip 灰 / error 红三角；抽屉滚动日志；数据集节点行进度徽标「3/10」；右上「取消」→ `run_cancel`（按钮进入「取消中…」态）；`run_end` 停流并出统计徽标（total/pass/fail）+「查看报告」跳 `#/reports/{run_id}`。
  （落地修正：`projectId` 必传——run 路由 `GET /events/run/{run_id}` 的数据权限门认 `?project_id=`，跨项目 404，与制品下载同口径；原计划签名 `openRunStream(runId)` 过不了这道门。
  配色修正：fail 描边用橙（`#D48806`）、error 用红（`#D3564F`）——与 `runVocab` 的 failed=断言失败（橙）/ error=请求失败（红）同口径；原计划「fail 红」会和请求失败混色，执行语义上「断言没过」与「请求都没发出去」必须一眼能分。）
- 断线自动重连且**不重不漏**（`Last-Event-ID` + seq 去重，共用 T15 的 `shared/sse.ts`）。
- 靶场扩能（§14 明写执行核自测要「可控 echo/delay/错误接口」）：给 `backend/scripts/target_app.py` 加 `GET /slow?ms=`（sleep 后返回，上限 10s）与 `GET /flaky?fail_first=N`（前 N 次 500、之后 200，用于验 loop.while 与重试语义），e2e 用它们制造 running 窗口与可复现失败。

- [ ] **Step 1: 写 e2e**：执行含 `/slow` 与一个失败步骤的场景 → 至少观察到 1 个 running 节点 → 终态着色与 `run_end.stats` 一致（数 DOM 里的绿/红节点数）；**断线用例**：执行中关掉流再触发重连 → 日志无重复行且终态完整（Review Focus 3 前端半边）；点取消 → 终态 cancelled。→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: e2e + build 绿** → **Step 5: Commit** `feat(web): live run progress on canvas via SSE with resume`

### Task 22: 报告中心 + 只读结果画布 + 失败步骤重跑 + Ctrl+K

**Files:**
- Create: `web/src/pages/reports.tsx`、`web/src/pages/reportDetail.tsx`、`web/src/components/CommandPalette.tsx`
- Modify: `web/src/layout/shell.tsx`（顶部搜索框解禁并绑 Ctrl+K——**不再是 disabled 摆设**）,`web/src/App.tsx` 路由
- Test: `web/e2e/reports.spec.mjs`、`web/e2e/palette.spec.mjs`

**Interfaces:**
- 报告列表（§11.4.15）：筛选 时间（默认近 7 天）/场景/触发/执行人/环境/结果 + 触发徽标（手动 / 定时 / Pilot / webhook）+ 列 名称 | 触发 | 执行人 | 环境 | **通过率环形进度** | 步骤 | 耗时 | 开始时间；「含调试」开关（默认关）。（落地修正：不做批量删除——后端没有报告删除端点，执行记录是审计事实；计划原文的「批量[删除]」随现实删掉，不做假按钮。）
- 报告详情（§11.4.16 / §11.7.4）：概览卡（通过率环 / 耗时 / 触发 / 环境 / 执行人）→ 左步骤树 300（数据集步折叠显示 3/10）→ 中**只读画布**（`Canvas readOnly` + 结果着色，点击联动右栏）→ 右步骤详情 420（request/response 对照（T16 结论决定 Monaco 还是 pre）、断言结果表 项/预期/实际/✓✗、日志、制品下载链接）+ 顶部 **[失败步骤重跑]** → 跳新 run 报告。
- 中断态诚实展示：run 停在 running 但租约失效 → 顶部红条「执行进程中断」，未终态节点转灰（Review Focus 6 的前端半边）。
- Ctrl+K（R51，§11.4.19）：新增后端 `search_assets`（perm `*:read` 级，effect=read，tool=True）三路搜接口/用例/场景（名称 + 路径关键词，MySQL LIKE，§9.10 一期不上向量）；前端居中浮层 640，按类型分组、↑↓ 选择、Enter 直达详情、Esc 关闭、空结果分节提示。
  （落地修正：用例没有独立详情页，「Enter 直达详情」对用例的落点=所属定义的详情抽屉并自动切到用例页签（`#/api?def=<id>&tab=case`）；定义 `#/api?def=<id>`，场景 `#/scene/<id>`。中断态红条由 report_get 的 settle_dead_run 把状态改写成 error+「执行进程中断」后自然渲染在概览卡，无需前端单独探测租约。）
- 明确不做（见「不做清单」）：§11.4.20 高级搜索条件组、保存视图、列设置。

- [ ] **Step 1: 写 e2e**：跑一个含失败步骤的场景 → 报告列表出现且通过率数字对 → 进详情点失败节点 → 右栏出请求/响应/断言表 → 点「失败步骤重跑」→ 新报告生成且原报告不变；Ctrl+K 搜接口名 → Enter 跳详情（断言 hash 路由）；「含调试」开关切换后调试运行出现/消失。→ **Step 2: 跑红** → **Step 3: 实现** → **Step 4: e2e + build 绿** → **Step 5: Commit** `feat(web): report center, read-only result canvas, step rerun, Ctrl+K palette`


---

## 收尾（T23-T25）

### Task 23: 工具面同步 + 契约与权限点回归

**Files:**
- Test: `backend/tests/test_tool_surface_1b.py`
- Modify: `web/src/auth/perms.ts`（新权限位镜像）、`docs/superpowers/plans/README-1a-demo.md`（批次勘误 R50：报告中心 1D → 1B；补 1B 已交付；worker 启动命令）

**Interfaces:**
- 无新接口；**回归钉**：① 1B 新工具（`scenario_create/update/list/get/delete/run/debug/rerun_step/references, report_list, report_get, run_cancel, search_assets`）出现在 admin 工具面；② `scenario_run` 的 effect=write → PLAN 模式被拒；③ `scenario_purge` 与 `api_case_resolve` **不在**任何角色的工具面（`tool=False`）；④ `perm_point` 表同步出 `scenario:*` 全集；⑤ READONLY 能 `report_list` 不能 `scenario_run`；⑥ `lint-imports` 四契约仍全绿（**新模块 scenario 必须显式加进契约 1 的独立模块清单与契约 3 的禁 import agent 清单**，否则「4 kept」是靠漏数撑起来的假绿）。

- [ ] **Step 1: 写失败测试**（预期 ⑥ 立刻暴露契约清单漏登记）→ **Step 2: 记录红项** → **Step 3: 修**（pyproject 的契约范围补 `app.modules.scenario`）→ **Step 4: `seed_demo.py` 扩展幂等验证**：demo 项目预置一个 4 步场景（登录 → 提取 token → 循环查单 → 断言），跑两遍不重复 → **Step 5: Commit** `test(scenario): 1B tool surface, contract scopes, demo scenario seed`

### Task 24: 后端金线扩展 —— 1B 全链路集成测试

**Files:**
- Test: `backend/tests/test_golden_1b.py`

**Interfaces:**
- 一个测试走完真实链路（ASGITransport 打靶场，`exec_mode=inline`）：建模块 → 建 2 接口 + 2 用例（其中 1 个绑数据集 3 行）→ 建场景（登录 → extract → loop while ≤3 查单 → 数据集步 → 断言）→ 保存触发校验 → `scenario_run` → 轮询终态 → 断言：`run_step_result` 行数（含 `row_no` 展开）、`summary_graph` 每 key 状态、`run_event` 序列完整且 seq 单调、`stats` 与 pass_rate 一致 → SSE 全量重放 == 事件表 → 失败步 `run_rerun_step` 只跑一步 → purge 场景与用例后 `report_get` 仍完整。
- 另加一条 **celery 端到端**（`exec_mode=celery`，脚本内自起自杀 worker；若环境不具备则 `pytest.skip` 但必须打印跳过原因——**跳过要显眼，不许悄悄绿**)。

- [ ] **Step 1: 写失败测试** → **Step 2: 跑红** → **Step 3: 修到绿** → **Step 4: 六门禁全跑并记录真实数字** → **Step 5: Commit** `test(1b): golden path from scenario to report with rerun`

### Task 25: 演示手册、CI 与收尾

**Files:**
- Create: `docs/superpowers/plans/README-1b-demo.md`（1B 演示手册：起后端 + **起 worker（--pool=solo）** + 起靶场 → 编排一个场景 → 调试 → 执行看呼吸高亮 → 报告 → 失败重跑 → 取消；含「inline 与 celery 的差别」诚实说明）
- Modify: `.github/workflows/ci.yml`（新前端依赖装得上即可，**CI 不起 worker**：pytest 走 inline；把 `scripts/verify_worker.py` 留作本地/夜间任务并在 yml 注释说明原因）
- Create: `README.md`（**仓库根目录，本仓从来没有过 README**——1A 只交付了 `docs/superpowers/plans/README-1a-demo.md`，本条原文写「Modify: README.md」是拿想象当现状。落地为新建：一句话定位 + 批次状态表（1A/1B 已交付、1C–1F 未开放）+ 最短启动命令，细节一律链两份演示手册，不重复内容避免两处漂移）

- [ ] **Step 1: 手册写完自己照做一遍**（§13 纪律 1：业主亲手能跑；跑不通的地方就是文档或产品的洞，就地修）→ **Step 2: 六门禁全绿并把数字写进手册**（pytest / ruff / lint-imports / pnpm build / playwright / `scripts/migrate_dev.py` 把开发库对齐 head）

> 第六门禁是 T6 期间补的：alembic head 前进后开发库不会自己跟上，而 pytest 每轮新建
> 临时库，全绿也照不出演示库滞后（0014/0015 建完时演示库还停在 0013，手工查表才发现）。
> 「测试绿」从来不等价于「演示库可用」。→ **Step 3: 更新 ledger**（`.superpowers/sdd/2026-11-15-1b-scenario-engine/progress.md`：产品决定、踩坑、门禁数字、跳过项）→ **Step 4: Commit + 打 tag** `1b-scenario-engine`

---

## 完成判据（= §13「1B」条目逐条 + 1A 之后的 DoD）

1. step_graph 协议（§7.4 全 15 kind）可保存、可校验、可往返；文档示例 graph 原样通过校验。
2. 执行引擎跑通 API 类 + 全部逻辑控件；数据集按行展开且统计口径符合 §8.6；`fail_fast` / `optional` / 超时 / 取消全部生效。
3. 执行链走 Celery worker（D5）：`scripts/verify_worker.py` 在业主机器上跑通并留下证据；inline 只是测试/单机档位。
4. SSE 实时进度：画布呼吸高亮，**断线重连不丢步不重复**（Review Focus 3 有专测）。
5. 报告中心：列表筛选 + 三栏详情 + 只读画布结果着色 + **失败单步重跑**可用；资产删除后报告仍完整（§14 自包含条款）。
6. 场景画布 + 列表双模式同源，乐观锁冲突走差异弹窗；未保存草稿可调试。
7. Ctrl+K 快捷查找可用（兑现 1A 手册承诺）；导航无假按钮。
8. 六门禁全绿（pytest / ruff / lint-imports 四契约 / pnpm build / playwright / migrate_dev 对齐开发库），数字进 ledger 与手册。
9. 混合场景端到端 DoD **不在 1B 验收**（UI/ADB 未开放），但 1B 必须保证：`ui_case`/`adb_case` 保存即报「1C/1D 开放」，引擎遇未知 kind 报 error 而非跳过（为 1C/1D 留好插槽）。

## 不做清单（1B 明确不做，别顺手做，也别假装做了）

- 定时任务与通知渠道（1E）；场景右面板的定时/通知绑定一律 disabled + 批次标注。
- 工作台统计页（1E）；`run_record` 已存的数据够它直接用。
- `ui_case`/`adb_case` 执行（1C/1D）；`group` 并发（`.parallel` 二期）；`scenario` 类型步骤（二期）。
- `scenario_draft` 表与 Pilot 生成场景（§4.6 明写二期建表 / 1F 只读预览）。
- §11.4.20 高级搜索条件组、保存视图、列设置、导出（1E）。
- 场景变更历史表与历史 UI（§6.5 明写历史 UI 二期）；场景版本历史（一期只有乐观锁 version）。
- 跨项目复制场景（§6.5 二期）；沙箱子进程级隔离（§8.5 三期评估）。

## 风险登记（实现时最可能翻车的地方）

| # | 风险 | 缓解 | 兜底 |
|---|------|------|------|
| 1 | Celery + Windows solo 的稳定性（重复消费 / acks_late / 信号处理） | T9 专项测试 + `verify_worker.py` 每日自检 | 退 acks 默认 + run「已领取」原子位；**不许**改成默认 inline |
| 2 | `@xyflow/react` 与「纯树无 DAG」语义冲突（用户拖出非法边） | 不开 `onConnect`，连线只由树生成；结构改动只走右键/拖拽（T19 已钉） | 自研轻量树画布（工作量大，最后手段） |
| 3 | Monaco 打进包出问题 | T16 探针任务先证 | 回改 R49，报告页用 pre 渲染并记 issue（不静默） |
| 4 | 执行核与用例调试两套请求组装分叉 | T3 单一出口 `api_case_resolve` + `merge_request` 复用 | 契约测试钉两处输出相等 |
| 5 | 大 graph / 大数据集把 SSE 打爆 | 事件只推摘要（step_key/status/elapsed/row_progress），detail 走 REST | 服务端合并同 key 高频事件（100ms 窗口） |
| 6 | 沙箱超时线程杀不掉，长跑泄漏 | 超时不采信输出 + 文档写明残余风险 | 三期子进程隔离 |
| 7 | 新模块忘了登记 import-linter 契约，「4 kept」变假绿 | T23 Step 1 专门先暴露它 | pyproject 契约补 `app.modules.scenario` |
| 8 | 场景列表 N+1 查最近结果 | 冗余 `last_run_at/last_run_status`，终态回写 | 列表改子查询一次取回 |

## 执行顺序与并行度

- 串行为主（同仓库同文件）：T1→T2→T3→T4→T5→T6→T7→T8→T9→T10→T11→T12→T13→T14→T23→T24→T25；前端 T15→(T16 ∥ T17→T18→T19→T20→T21→T22)。
- 唯一可并行的两股：后端链与「T15/T16 前端地基」；T17 起依赖 T10/T11 的真实服务。
- 每任务独立 commit，可演示节点（T11 后端全链、T19 画布、T22 报告）各打轻量 tag；**迁移必带 down**（§13 纪律 3）。

