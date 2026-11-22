# 1C UI 测试（元素库 + UI 用例 + Playwright 执行）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) 或 executing-plans 逐任务实现。步骤用 checkbox（`- [ ]`）跟踪。
> 实现前若与本文件冲突，**先改本文件再改代码**，冲突不可静默吞掉（1A/1B 同规）。
> 蓝图原文是本计划的验收底线：`docs/2026-11-13-ai-test-platform-design.md` §13
> 「**1C(3~5 周)** UI 测试:元素库 + 命令列表编辑器 + Playwright 执行 + 失败截图。**业主强项区,深度参与验收。**」

> **✅ 本批次已完成（2026-11-16 回填）**——下面 56 个未勾 checkbox 是**写法陈旧，不是待办**：1C 收尾（T23 走查 + R137 门禁终值）时没人回来逐格打勾。别照这些格子找活干（S0/1A/1B 同此口径）。
> 完成的证据：**git tag `1c-ui-testing`**｜**逐条完成判据见 `## 完成判据（= §13「1C」条目逐条）`**｜**R 序台账：本文件内至 R138**（1C+ 段从 R130 起）｜**`## 计划 vs 现实（执行期收集的偏差台账，T23 收尾要逐条消化）`** 是本批最硬的完成证据，逐条给了处置｜演示手册 `docs/superpowers/plans/README-1c-demo.md`｜提交前缀 `(1c)` 30 条 + `(1c+)` 10 条。
> **1C 明确 handed 给 1D 的一条**：混合场景（API + 等待 + 判断 + ADB）执行 → 报告 的端到端 DoD——本文 :24「**不在 1C**：…混合场景端到端 DoD（§13 明写 **1D 末达成**）」、:151 D1、:720 完成判据 9、:724；1D 计划的 T10 兑现它。
> 后续批次改用「`### TN · …` 标题带 ✅ + 尾部 `**落地证据（commit XXXXXXX）**` 段 + 门禁实测数字」的口径（见 1D），**新批次以 1D 为格式模板**，不再依赖本文件的 checkbox。

**Goal:** 一期 1C 落地——**元素库**（§4.4 / §11.4.11 / §11.5.4：定位器类型 + 引用数 + 删除引用检测 + 回收站）、**UI 用例**（§7.2 命令序列 + §11.4.12 命令列表编辑器 + 行展开参数表单 + §11.4.13 共用选择器弹窗）、**Playwright 执行**（无头、信号量限并发、逐步耗时、失败自动截图 + DOM 快照制品）、以及把 1B 留好的插槽真的插上：场景里的 `ui_case` 步骤**能存也能跑**（`PENDING_KINDS` / `BLOCKED_1B` 两处一起摘）。业主可演示「建元素 → 拼一条 UI 用例 → 调试看到逐步耗时与失败截图 → 存成场景的一步 → 执行 → 报告里看命令明细与截图」。

**Architecture:** 延续「一切能力仍是 `@service` 五路同生」。新增两块，位置是**照搬 1B 已验证的两条分层**（R43/R44），不是新发明：

1. **领域模块 `app/modules/ui_test/`**——元素/用例/模块树三类资产 + §7.2 命令协议与保存期校验（纯函数）+ 独立调试端点。它**不认识** `api_test`/`scenario`/`agent`（契约 1 + 契约 3）。
2. **执行核下界 `app/modules/execution/ui_core.py`**——Playwright 驱动器，与 1A 的 `execution/core.py:run_api` 同一层：**不懂资产、不懂 step_graph 协议**，只吃「命令列表 + 变量 + 选项」吐结构化结果。1A 立的规矩是「执行核 = shared + stdlib + httpx」（`pyproject.toml` 契约 4 注释 R28），1C 把它扩成「+ playwright」，**仍然不 import 任何 `app.modules.*`**，所以契约 4 的字面（`forbidden_modules = ["app.modules"]`）与精神（可被一切复用）都保住。

**为什么执行核而不是 `ui_test` 里放驱动器**：场景引擎要跑 `ui_case`，而契约 1 禁止 `scenario ↔ ui_test` 横向 import。HTTP 那侧 1B 的解法是「驱动住 `execution`，资产住 `api_test`，引擎只 import `execution`」（`handlers.py:43` 直接 `from app.modules.execution.core import run_api`）。UI 照抄这一条，两条链的形状就还是同一套：**用例执行与场景步骤执行共用同一份驱动代码，不可能跑出两种结论**（§13 纪律 1 的「同源」口径）。跨模块**取数**照旧走注册表（`ui_case_resolve`，`http=None, tool=False`），与 `api_case_resolve` 一对一镜像。

**Tech Stack:** 同 1B + 后端新增 `playwright==1.65.2`（Python，唯一新依赖，§13 纪律 2 的口径：不擅自引第二套——Playwright 是蓝图 §6.3 点名的那一套，不是新选择）。前端**零新依赖**（antd 现有组件够做命令表 + 行展开 + 选择器弹窗；不引 dnd 库，1B 已在用原生 HTML5 DnD）。

**Spec:** 覆盖 §4.4（`ui_module`/`ui_element`/`ui_case` 三表）、§6.3（元素库/用例/执行三节全部一期条目）、§7.2（命令对象 + 24 种 type 枚举）、§8.1（`ui_case -> Playwright(信号量限并发)`）、§8.8（制品 64KB 外置线复用）、§11.4.11-11.4.13（三个界面规格）、§11.5.4（UI 页规格）、§11.4.19（Ctrl+K 补两类）、§12.2（复用 run 事件通道）。**不在 1C**：录制器（§6.3 明写二期）、trace.zip（§6.3 明写二期开关）、ADB（1D）、混合场景端到端 DoD（§13 明写 **1D 末达成**）。

---

## 前置取证（写计划之前已经跑通的事实）

写这份计划前跑了四组实测。**结论是硬前提**，后来者不要重新怀疑、也不要跳过；每条都给了可复跑的脚本路径。

1. **Playwright 能在本项目 venv 里跑，且必须用 async API（决定性）。**
   装到临时目录（`pip install --target D:/tmp/spiw2`），**项目 venv 全程未被动过**，用
   `backend/.venv/Scripts/python.exe -I` 驱动：

   | 测法 | 结果 |
   |---|---|
   | `asyncio.run` 里直接调 **sync** API | **硬报错**：`It looks like you are using Playwright Sync API inside the asyncio loop. Please use the Async API instead.` |
   | sync API 放进 `asyncio.to_thread` | 可用（0.3s） |
   | **async API** 原生跑 | 可用：标题读到、`fill`/`click`/`wait_for_selector` 通过、`evaluate("1+1")=2`、**截图 5509 字节**、总耗时 **0.5s** |
   | `asyncio.Semaphore(2)` + 5 个页面并发 | 全部正确返回，§6.3「信号量限并发」这条路成立 |

   → **架构钉死用 `playwright.async_api`**，理由是事实不是偏好：worker 的真实形态就是
   `asyncio.run` 包一层协程（`worker.py:52-69`），sync API 在那个环境里**直接抛异常**。
   脚本：`D:/tmp/spi_probe.py`、`D:/tmp/spi_probe2.py`、`D:/tmp/spi_probe4.py`。
2. **浏览器版本可以只装一份（省掉 CI 与业主机器的一半下载）。**
   `playwright==1.65.2`（Python）要 `chromium **1255**`；本仓前端 `@playwright/test@^1.49.0`
   实际解析到 `playwright-core@1.65.1`，它要的也是 `chromium **1255**`
   （`web/node_modules/.pnpm/playwright-core@1.65.1/.../browsers.json`）。两者默认共用
   `~/.cache/ms-playwright`（Windows 是 `%LOCALAPPDATA%\ms-playwright`，本机实测同一目录树）。
   → CI 现有那步 `pnpm exec playwright install --with-deps chromium`（`ci.yml:92`）投下来的
   chromium，**Python 侧直接能用**，前提是版本配对。配对由测试钉住（T1），不靠记忆。
   （对照：Python `playwright==1.49.0` 要的是 `chromium-1148`——差一个次版本就要多下一份。）
3. **离线/公司机器的退路可行**：`channel="chrome"` → 本机 Chrome **157.0.8103.39** 起得来（0.3s，截图 5276 字节）；`channel="msedge"` → Edge **157.0.4341.60** 同样可用（0.4s）。
   → 装不动自带 chromium 的机器，配一个 `TP_UI_BROWSER_CHANNEL=chrome|msedge` 就能用系统浏览器。
   这条不是假想兜底，是实测过的第二出口。
4. **靶场现在一个 HTML 页面都没有（决定性缺口）。**
   `backend/scripts/target_app.py` 只有 `/login`、`/order/{id}`、`/healthz`、`/slow`、`/flaky`
   （`grep -n "@app" scripts/target_app.py` 全在这五处），**全是 JSON 接口**。
   → 1C 第一件事必须是给靶场加一张**真能点的页面**，否则「Playwright 执行」无从演示。
5. **同一个进程里连续 5 次 `asyncio.run` 各起各关 chromium，全部成功、进程数不涨**（`D:/tmp/spi_probe5.py`：每次 0.2~0.3s，截图 4511B 一致，`tasklist` 前后都是 17）。
   → worker 每领一个任务就 `asyncio.run` 一次（`worker.py:52-69` 的真实形态）**不会**让 Playwright 绑死在首个 loop 上——这一点与 redis-asyncio 不同（那个必须每次 `init_bus()`，见 `worker.py:56-61`）。所以 `ui_core` 不需要「每 loop 重建 driver」这种花活，`async with async_playwright()` 放在函数体内即可。同一 loop 内跑两个用例也验过（`LOOP-REUSE-OK`）。**这是 R94 分层能落地的前提**：如果 Playwright 像 redis 那样绑 loop，1C 就得改成常驻 browser 池，那是另一个量级的工程。
6. **制品链能存能取，但图片现在会被当二进制下载**（两处要在 T11 修，都不是「以后再补」）：
   - `execution/artifacts.py:122` 扩展名只有 `.json`/`.bin`；`_sniff_type`（:91-104）对 PNG
     返回 `application/octet-stream` → 浏览器**不内联渲染**，截图等于只能下载。
   - `artifact_download`（:196-221）经**实测**只认 `Authorization: Bearer` 头：
     无头 → `401 {"code":"unauthorized"}`，坏 token → `401 登录状态无效或已过期`（进程内 ASGITransport 跑出来的，脚本 `D:/tmp/artifact_auth_probe.py`）。
     而 1B 报告页把制品渲染成 `<a target="_blank" href=/api/v1/artifacts/...>`（`reportDetail.tsx:361-366`），
     vite 代理也不注头（`vite.config.ts:31,35`），全站没有 cookie 会话（`iam/deps.py:17-34` 只读 bearer）。
     **实测（T11 Step 0 端到端已验证，不再是推断）**：起整套服务（真实 uvicorn :8321 +
     `vite preview` :5173，e2e 同库同配置），拿一条**真执行产生的制品**（真场景跑出 >64KB 响应体
     → runner `offload_detail` 落的 RESPONSE 制品），对报告页渲染的那个 href 逐字 `curl -i`：
     经 vite preview 代理**不带 header → `401 {"code":"unauthorized"}`**，带 `Bearer` → `200`
     （content-length 104840 与制品字节一致），坏 token → `401 登录状态无效或已过期`；
     直打后端 :8321 三档结果相同（脚本 `D:/tmp/t11probe/step0.py`）。
     所以 `<a target="_blank">` 点开来确实是 401，R107 的前提成立。它没被发现是因为
     **e2e 里没有任何一条碰制品**（`grep -rn "artifact" web/e2e/*.mjs` → 0 命中）。
     截图若不能内联，1C 的核心卖点（失败截图）就是哑的，所以这条修复进 T21 且必须**先端到端实测再修**。

**另有两条「我的前次笔记是错的」的更正，记在这里防后来者踩**（§13 纪律 1 对己也适用）：
① 没有任何现成的 UI 前后端脚手架——`grep -rn "UiElement" backend/app web/src` **0 命中**，
`web/src/api/` 下没有 `uiElement.ts`/`uiCase.ts`，`ui_test` 模块不存在（`ls app/modules/`）：1C 是**全新增**，不是接半截。
② `web/src/shared/runVocab.ts` **确实存在**（我一度说它不存在，是在错的 cwd 下 ls 的）。

---

## Global Constraints

- MySQL 8.4 **本机实例** 127.0.0.1:3306（服务 `MySQL84`；库 `testpilot` / 测试 `testpilot_test` / e2e `testpilot_e2e`）；Redis **本机实例** 127.0.0.1:6379 db6。开发禁 SQLite。新增第三方后端库**只有** `playwright==1.65.2` 一个（前置取证 2）；前端零新依赖。**【2026-11-19 修订】基础设施本机直起、`127.0.0.1`，不再要求 Docker；下文取证段的 `db.internal.test` 是当轮实测记录，照原文读**（见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4）。
- Alembic 现有 head **0017**（`migrations/versions/0017_scenario_common_assertions.py:20`），**下一个是 0018**；每个迁移**必带能跑的 down**（§13 纪律 3）。每任务独立 commit，可演示节点打轻量 tag。
- 表名**单数**（`ui_module`/`ui_element`/`ui_case`）；全库**无外键**，级联显式编码（`scenario/models.py:23-24` 同款注释要照抄）；模型必带 `owner_id` + `project_public`——`shared/visibility.py:25,32` 用 `getattr(row, "project_public", True)`，**漏建这两列等于每一行都公开**（这是静默失效，不是报错）。
- 权限位三段式 `域:资源:动作`，新前缀统一 `ui:`。`READONLY` 模板是 `*:read` 且匹配是**后缀 glob**（`core/permissions.py:19-21` `perm.endswith(pattern[1:])`），所以读类权限**必须以 `:read` 结尾**，否则只读成员看不见它也无从报错——这就是 `scenario_module_tree` 用 `perm="scenario:module:read"` 的原因。`MEMBER` 的 `-*:delete` 会自动盖住 `ui:*:delete`，回收站语义白拿。所有 `*_purge` 一律 `tool=False` + 逐字输名（R53 手感：每个软删资产都有出口）。
- `ui:*` 家族必须同时登记进 **`pyproject.toml` 契约 1 的 `modules`（:57-66）与契约 3 的 `source_modules`（:77-89）**。`ui_test` 是领域模块不是 composition 模块，所以**两个清单都要**（与 `search` 相反）。漏登记 = 该模块不被扫描 = 「4 kept」是漏数撑出来的假绿（`tests/test_tool_surface_1b.py:107-141` 就是钉这个的，1C 要有对偶测试）。
- **`ui_test` 与 `scenario` 零横向 import**：引擎跑 `ui_case` 只能 ① import `execution.ui_core`（合法，`handlers.py:43` 已有 `execution.core` 先例）② 经 `REGISTRY` 取资产（`ui_case_resolve`）。`tests/test_engine_runner.py:433-439` 那条源码扫描目前只扫 `runner.py` 且不认 `ui_test`——1C 要把它扩到 `handlers.py` 并把 `ui_test` 纳入禁词。
- `execution` **不得** import 任何 `app.modules.*`（契约 4，`pyproject.toml:91-95`）。`ui_core.py` 因此只许 import `playwright` + `app.shared.*` + stdlib；**playwright 必须延迟 import**（放在 `run_ui` 函数体内），否则没装浏览器的机器上连 `import app.modules.execution.core` 都会被拖下水。
- 命令协议按 §7.2 原文：字段 `id/type/element_id/inline_locator/input/timeout_ms/save_var/optional`；`element_id` 与 `inline_locator` **二选一**（就地定位不落库到元素库，line 393 原话）。type 枚举 24 个，逐字取自 §7.2 line 393：`open|click|dblclick|input|clear|select|hover|key|scroll|wait_element|wait_text|sleep|assert_text|assert_element|assert_title|get_text|get_attr|screenshot|js|upload|download|switch_frame|switch_window|dialog_accept`。
- 执行按 §6.3 一期口径：**默认无头**；并发上限 = 进程内 `asyncio.Semaphore`，配置项默认 **4**；失败**自动截图 + DOM 快照**（两种制品），trace.zip 是二期开关（不做，也不留假开关）。
- 执行链走 worker（D5）不变：真执行由 worker 领取；**独立「调试」在 web 进程内跑**（与 1A `api_debug` 同档），两档共用同一份 `run_ui`。`TP_EXEC_MODE=inline` 继续是测试档。
- 六道门禁基线：`pytest -q` **445 passed** / `ruff check app tests migrations scripts` / `lint-imports.exe`（**4 kept, 0 broken**——新增名字进清单不改这个数字）/ `pnpm build` + `pnpm build:e2e` / `pnpm exec playwright test` **47 passed** / `scripts/migrate_dev.py`（0017→0018）。④⑤ 不共用构建（`probe.html` 只在 e2e 档进包，`globalSetup.mjs` 会当场拦）。
- 诚实原则（§13 纪律 1）：导航里 UI 两项**解禁即真能用**，解禁与页面落地同一个 commit；`nav.spec.mjs` 那两条断言随之改（T16 钉）。**不做假按钮**：录制器 / trace / 元素版本历史一律不给入口（R89  precedent：宁可不给，不给假「查看历史」）。

---

## ⚖ 批次决定记录（R94 起，续 1B 的 R93）

业主按行为验收，不必逐条点头；有异议随时推翻，推翻后**先改本文件再改码**。

- **R94 · 驱动器住 `execution/ui_core.py`，不住 `ui_test`。** 契约 1 让 `scenario` 不能 import `ui_test`，但引擎必须能跑 `ui_case`。HTTP 侧 1B 已经用「驱动在 `execution`、资产在 `api_test`」解过同一道题（`handlers.py:43` 直接 import `execution.core`）。UI 照抄：`run_ui()` 不懂资产，`ui_test` 与 `scenario` 都只正向依赖它。**代价**：`execution` 的依赖闭包多了 playwright（R28 那句「shared + stdlib + httpx」要改注释），换来的是两条执行链同源、契约 4 不破。
- **R95 ·（承 R94）playwright 延迟 import。** `ui_core` 模块级不 `import playwright`，在 `run_ui()` 里 import。否则「后端没装浏览器」会表现为「整个后端起不来」，那是把可选能力做成硬依赖。
- **R96 · 用 async API，不用 sync。** 不是风格选择：sync API 在 `asyncio.run` 内**抛异常**（前置取证 1 实测原话）。`ui_core.run_ui` 是 `async def`，与 `run_api` 同签名风格（`*, variables, ...`）。
- **R97 · 版本配对钉成测试。** 后端 `playwright==1.65.2` 与前端 `@playwright/test` 各自 `browsers.json` 里的 chromium revision **必须相等**，T1 有一条测试逐字比对两个 json（前端那份要能从 `web/node_modules` 读到；读不到就 skip 并打印原因，**不许静默通过**）。这是「CI 只下一份浏览器」的唯一防线，也是业主机器少踩坑的防线。
- **R98 · 靶场加 HTML 页，而不是新建一个靶场。** 与 1A/1B 的假靶场同进程（9999），加 `GET /ui/login`（表单）+ `GET /ui/home`（受 cookie 保护的表格页 + 一个 iframe + 一个延迟 3s 才出现的行 + 一个弹窗）。理由：演示时业主只想起一个靶场；两套靶场必然漂移（1B §5.3 列表/画布同源的同一个理由）。
- **R99 · 元素用独立 `ui_module` 树（第三棵树）。** 照 R45 的判断：权限语义（`ui:module:*` 不该管接口）与引用完整性都不共享，且不去动已被 e2e 钉住的前两棵树。代价是模块树代码第三份——**同时把 `flatten`/`subtreeIds` 抽到 `web/src/api/moduleTree.ts`**（现状 `api.tsx:40-58` 与 `scenes.tsx:38-58` 已逐字重复两份，第三份是忍无可忍的点）。
- **R100 · `ui_element` 一期五个定位类型，`text` 走 Playwright 文本引擎。** 蓝图自身在这处不一致：§4.4 表列了 **5** 种（`ID/CSS/XPATH/TEXT/NAME`），§6.3 写「定位器**六**类型」。这是**蓝图的自相矛盾**，不是我的理解分歧——见「待业主裁决 D2」。一期先按**表**里的 5 个建枚举（表是字段定义，更接近数据契约），第 6 个待业主点名再进（新增枚举值不是破坏性变更）。
- **R101 · 24 种命令里，5 种在 1C 保存期就诚实拒绝。** `upload`/`download`/`switch_frame`/`switch_window`/`dialog_accept` 各需要独立机制（文件选择、下载目录监听、frame/窗口句柄生命周期、原生弹窗处理），半做等于做假。保存期 `validate_commands` 对它们出 issue `command_not_available`（文案带批次，**与 R48 `kind_not_available` 完全同构**，前后端两处同口径），下拉里可见但 disabled。理由：**「存得下但跑成 error」是把成本推给执行人**，「存不下并当场告诉你为什么」是把成本放在编辑时。
- **R102 · 独立 UI 用例执行的步骤明细：一个命令一行 `run_step_result`。** `step_key` = 命令 id（`u1`/`u2`…），`kind` = 命令 type，`parent_step_key` = 用例自身那个汇总节点。`summary_graph` 写**单节点图**（`kind="ui_case"`，result 标在该 key 上）。这样报告中心的列表/详情/步骤树/制品**一行代码都不用改**就能显示 UI 运行（`report_services.py` 根本不按 `subject_type` 过滤，实测 :174-196 无该条件）。**代价**：报告「步骤」列显示 1（顶层口径），命令数在详情里看——这条要在手册里讲明白，别让业主以为是 bug。
- **R103 · UI 命令行不可单步重跑，且要说出口。** 单独重放第 3 个 `click`（前面没导航）必然红，那是假红。做法：不特殊分支——`run_single_step` 从 `summary_graph` 找节点，命令 key 不在图里 → 现有 409 `snapshot_missing`（`runner.py:550-560`）。**但**要加测试钉住这个 409 的文案是真的在说「找不到这一步」，而不是含糊报错；要重跑就重跑整个用例（`ui_case` 汇总节点 key 可重跑，`vars_snapshot` 现成）。
- **R104 · `ui_case` 不做乐观锁 `version`。** 对齐 1A `api_case`（它也没有）：命令列表编辑器的冲突面比场景画布小一个量级，且 §4.4 的 `ui_case` 字段表里没有 version。将来要加是加列 + 迁移，不是改协议。**不做**不等于漏了：`schemas` 里不出现 `version` 字段，前端也不发。
- **R105 · 元素按环境覆盖一期不做（待裁决 D3）。** §6.3 那句「同名元素按环境覆盖（不同环境 URL 不同）」给出的**理由是 URL**，而 URL 在 1C 走 `open` 命令里的 `${base_url}`（环境层变量，1A 已有分层），已经被环境覆盖了。locator 级的环境覆盖是另一回事，需要新表 + 新 UI，且业主说不上来要它时**宁可不做**。界面留一句说明，不留假按钮。
- **R106 · 元素引用检测 = 409 硬拦，不是「提示了还让你删」。** 与 1A 的 `api_case_delete` 被未回收场景引用时同款（`referenced_by_scenario`）。§11.5.4 只说「删除有引用检测」、§11.4.11 说「删除弹引用检测列表」——**列表 + 拦**两者都给：409 的 `details.cases` 列用例名，弹窗列出来并说「先解引用再来」。软删还能靠回收站兜底，但**元素被回收时用例照跑不误会炸在执行期**，所以必须硬拦（R53 的补充：软删的资产也得守住引用完整性）。
- **R107 · 截图内联用「带 token fetch → Blob → objectURL」，不给制品加签名 URL。** 制品可见性跟着项目成员关系走（`artifacts.py:219-220` 那句「无 Cache-Control」的理由），签名 query 等于把凭证写进可被历史记录/复制分享的位置。前端用同一个 `client.ts` 的 transport 拿 `ArrayBuffer` → `createObjectURL`，`URL.revokeObjectURL` 收尾。顺带把 1B 的 `report-artifact-link`（前置取证 5 推断会 401）一起修掉。**先端到端实测，再改**（见 T21 Step 0）。
- **R108 · 断言类命令产出的行复用现成断言形状。** `assert_text`/`assert_element`/`assert_title` 的行必须逐键同 `shared/assertions.py:43-45` 的 `_row()`：`{type, passed, expected, actual, error, path}`（**是 `passed` 不是 `ok`、是 `expected` 不是 `expect`**——`DebugPanel.tsx:63-69` 读的就是这两个名字，写错会静默渲染成「期望 null」）。这样 `DebugPanel`（`web/src/api/DebugPanel.tsx:53-77` 断言卡）与报告页断言表**一行不改就能渲染 UI 断言**。`path` 对 UI 而言是定位器描述——这是字段复用，不是语义冒充（DebugPanel 只把它当代码片段显示）。
- **R109 · Ctrl+K 补两组（元素/元素用例）。** §11.4.19 原文的分组含「设备」是 1D，1C 先加 `ui_element` + `ui_case`。后端 `search/services.py:47` 的 `pattern` 与出参三列表、前端 `CommandPalette.tsx:11,15-19` 的 `Kind`/`GROUPS`/`goto()` 四处**同时**改，漏一处就是「搜得到但 Enter 没反应」（`goto()` 返回 `null` 正是这个静默失效的形状，见该文件 :21-27）。
- **R110 · 元素库/用例的搜索走 MySQL LIKE。** 与 §9.10 一期口径一致（`search/services.py:8-10` 原话：不上向量/FULLTEXT）。不发明 `asset_kind` 枚举——它不存在，凭空建一个只会让「向量检索」看起来已完成。
- **R111 · 场景里 `ui_case` 步骤的解禁要动七处，一处都不能省。** 后端两处：`handlers.py:54` `PENDING_KINDS`（摘 `ui_case`，否则 dispatch 在查 HANDLERS **之前**就短路成 error，注册了 handler 也没用）、`graph.py:23` `BLOCKED_1B`（摘 `ui_case`，否则保存就被拦）。前端三处：`stepTypes.ts:17` `BLOCKED_1B`（一张表被 `graphOps.ts:596` 与 `Canvas.tsx:45,105` 共用——画布角标「保存会被拒（1C 开放）」与 validateLocal 的 issue 同源，删键就两处一起好）、`AssetTree.tsx:78` 的「UI 用例 `1C 开放`」Tag（改成可拖入）、以及 `graphOps` 的 `Kind` 白名单里 `ui_case` 需要的 `config` 口径（`_required_config` 后端无 ui_case 分支，实测 `graph.py:69-107`，前端要对齐「只要求 ref」）。测试三处要**从「钉住被拦」翻成「钉住可跑」**：`test_engine_handlers.py:252-261`、`test_scenario_graph.py:75-79`、`graphOps.test.ts:387-393`，外加 e2e `sceneCanvas.spec.mjs:58-61`。**漏任何一处都是「一半开放」**——保存能过但跑 error，或反过来。`adb_case` 保持被拦（1D），两个键在四处都成对出现，改的时候极易一起删掉，`ui_case` 是 `adb_case` 的邻居。
- **R112 · 运行/报告列表不许把 UI 运行说成「接口」。** 实测缺陷：`web/src/pages/runs.tsx:104-105` 的对象类型标签是**二值**判断 `r.subject_type === "api_case" ? "用例" : "接口"`——一条 `ui_case` 运行会被贴成「接口」，那是**主动说错**，不是没说。1C 必须把它换成 `runVocab` 里的一张表（`api_definition→接口 / api_case→用例 / scenario→场景 / ui_case→UI 用例`），并加一条测试钉「未知 subject_type 渲染原文，绝不回落成接口」。**同时**：运行记录与报告中心的筛选下拉是从**场景/接口列表**现攒的（`reports.tsx:49,76-93` 的 subject 下拉只装场景），UI 运行会**出现在列表里却筛不出来**——1C 给两页各加一个「对象类型」筛选（后端 `run_list`/`report_list` 都没有 `subject_type` 条件，实测 `services.py` / `report_services.py:174-196` 无该 where，要加）。
- **R113 · 配置里的相对路径一律按仓库根锚定，不按启动目录（`6cfcf39`）。** 1C 实测踩到的真缺陷，不是假想敌：`artifacts_dir="backend/data/artifacts"` 与 `env_file=".env"` 写的都是**仓库根相对**的写法，解析却用 `Path(...).resolve()`（相对 **CWD**），而三份 demo 手册教的起法都是 `cd backend; uvicorn app.server:app`（README-1a-demo.md:68 / README-1b-demo.md:74 / README-s0-demo.md:51）。两个方向各错一次：CWD=backend → 制品写进 `backend/backend/data/artifacts`（本机实测 46 个文件在此，`backend/data/artifacts` 从来没存在过；`.gitignore:9` 只忽略 `backend/data/`，所以它以 `?? backend/backend/` 躺在工作区）；CWD=仓库根 → `.env` 静默读不到，pydantic 不报错，只把 `TP_SECRET_KEY` 等**悄悄换成代码默认值**。**为什么不是磁盘整洁问题**：制品 ref 在库里存的是相对根的 `{run_id}/{uuid}.png`，根一漂就变成「worker 写字节、server 读不到」——server 与 worker 启动目录不同则报告截图全 404，正撞 R42 的双进程拓扑。落地：`config.py` 立唯一锚点 `BACKEND_DIR`/`REPO_ROOT`（`__file__` 反推）+ `resolve_repo_path()`（相对按仓库根、**绝对原样尊重**），`env_file` 写绝对；配置默认值一个字没改，改的是语义。`test_config_paths.py` 从三种 CWD 解析必须同路，并**反向钉**「绝不解析到 CWD 下面」。**同族已知未修**：`Config("alembic.ini")` 在 `tests/conftest.py:57` / `scripts/migrate_dev.py:34` / `scripts/check_migration_down.py:75` 三处仍靠「cwd=backend」（最后一处把该依赖写进了注释），而 `scripts/verify_worker.py:80` 早已用绝对路径——同族两种口径，改要动三处启动脚本，与执行链无关，单独一条。
- **R114 · Ctrl+K 浮层不许跟着换页活着，且「开关」不能是一个不变的布尔（`63c8da3`）。** T23 第一道门禁实跑 playwright 就红了两条——不是测试写错，是产品缺陷，而且是两层：① `CommandPalette` 只在 Esc 与「选中结果」两处关闭，而 hash 路由跳转是**同文档**导航、Shell 不重建，于是浮层活过换页：半透明幕布盖在毫不相干的页面上，里面还是上一个项目的关键词与结果（键盘全进搜索框，看起来就是页面卡死）。② 更深一层是状态形状——`paletteOpen` 翻成 `true` 之后不再变化，任何 `useEffect([open])` 都漏掉「已经开着又换页 / 已经开着又按 Ctrl+K」；热键因此是纯 toggle，第二次 Ctrl+K「打不开」。改法：收敛成单个 `{open, nonce}` state，路由变化把 open 落回 false（已关着就原样返回，不多一次渲染），`nonce` 每次唤起 +1 当 React key，浮层每次都是全新实例，上次的半截请求不漏进下一次。两条 `palette.spec` 的 T13 陈旧钉（「路由还没注册，先钉通配重定向」）翻成真落点断言 + 各钉一条「浮层不许跟着换页活着」。
- **R115 · 演示数据的「负责人」不能是 uuid，种子的权限档位要跟人一致（`705037b`）。** 真走查打开元素库/UI 用例列表，「负责人」整列是 36 位串。两层原因：① 那列拿**项目成员表**换名字，而种子资产由 bootstrap admin 建（系统管理员不是这个项目的成员行），永远换不出名字；② 前端回落不分场合——成员表**加载中**或**拉挂了**也走回落，于是「还不知道」被演成「把 uuid 摊出去」，甚至说「非项目成员」，那是冤枉人。改法：种子 owner 落 demo_pm（是成员）+ 既有行只自愈 owner 一个字段；新增 `shared/ownerName` 三态（加载中 / 拉挂了 / ready）；场景列表同口径一起改。**连带改出的一条真缺陷更值得记**：种子 ctx 权限原先硬写 `{"*}"`，改取 `perms_for()` 里这个人在该项目真实那套之后，首跑立刻炸——`ProjectMember` 是这一轮 `db.add` 出来的，而会话 `autoflush=False`（`core/db.py:75`），不先 `flush` 就取权限拿到空集，种子死在自己的第一道权限门上。全新库路径由 `test_tool_surface_1b.py` 的 seed 幂等用例覆盖，**它比任何手工演示都更早发现这件事**（改前红、改后绿，已实证）。新用例 `test_seed_demo_ui_owner_is_project_member` 钉「owner 必须是成员」，并临时退回旧写法实证它会红，不是空过。元素库页**没有**负责人列（读过 columns 确认），这点写进模块头免得下一个人猜。
- **R116 · 报告左步骤树要按执行顺序、要显示步骤名（`51c89c2`）。** T22 那条金线在真浏览器里跑通之后（把种子 UI 用例拖进 1B 演示场景 → 保存零 issue → 执行 7 步全绿），报告页露出两条读不出的缺陷：① **顺序**是 `fin / login / n1 / poll / poll.q / poll.st / tok`——后端 `report_services.py:248` 按 `step_key` 字母序返回，执行顺序 `login→tok→poll→fin→n1` 被排没了；② **名字**——除数据集那一步外每行 `subject_name` 都是 null，树里只剩 u-key。**同一屏上就能证伪**：中间那栏只读画布又对又有名字，因为它渲染的就是 `summary_graph`——名字与顺序一直在这份报告自己的快照里，只有左树没去读。改法在渲染侧（`stepTreeHints` 前序遍历出 `{key: 序号+节点名}`，`orderKeysByHints` 每层排序，`subject_name` 为空退图上名字，最后退 `step_key`），理由同 R103/R102 那条自包含承诺：老报告不会重新生成，回写库里的 `subject_name` 等于让历史继续难看；只读图、不 join 资产表，所以资产彻底删除后照样读得出。**实测对象是改动之前跑出来的两份报告**，新前端打开就对了。诚实记下两条不完美：数据集展开行的 `subject_name` 是**用例名**（`runner.py:306` 的 `case_name or node.name`），所以那一行树里显示「数据驱动」而画布显示节点名「查询订单」——两个都是同一件事的真名字，树选了落库快照那个；独立 UI 运行的命令行不在图上（活在 `case` 节点的 `detail.commands` 里），所以 `orderKeysByHints` 让「没号的」保持原序排在后面，不去打乱本来就对的序。
- **R117 · `stats.total` 的口径按运行种类不同，手册与演示词都别用「步骤数」这一个词糊过去。** 实测：混合场景 `stats.total=5`（`runner.py:510` 的 `len(top)` = 顶层步数）而报告左树有 7 行（循环里两个子步也各是一行）；独立 UI 运行 `stats.total=6`（`debug_services.py:402` 的 `len(commands)` = 命令数），报告中心「步骤」列就显示 6，而 R102 计划里预期是 1（一条用例一个节点）。两种都是各自模块内部自洽的口径，**没有哪个是错的**，但报告中心把两者混在一个「步骤」列里，演示时必须说清「场景按顶层步、UI 按命令」，否则台下会以为数字对不上。现状保留（改口径会同时动 1A/1B 已交付面与既有报告），记为口径事实。
- **R118 · 环境事实：手工起的 celery worker 会偷走 golden 测试的任务。** `verify_worker.py` 与 `conftest.py` 用的是**同一个 Redis DB 6**（`conftest.py:23` 与 `verify_worker.py:57`），而 `orchestration.py:140` 的 `send_task` 走默认队列、`app/worker.py` 没有按环境分队列。后果：为了走查演示常驻的 worker 会把 `test_golden_1b_celery_end_to_end` 投的任务抢去执行——它连的是演示库，跑的是这条测试根本不认识的场景，于是测试这边永远 `queued` 直到超时（实测报 `{'status': 'timeout', 'error': 'last=queued'}`）。**这不是产品缺陷，是取证环境互相踩**：跑六道门禁前先确认没有常驻 worker（`Get-CimInstance Win32_Process -Filter "name='python.exe'"` 看 CommandLine 里的 celery），停掉之后该用例 6.67s 通过。要不要按 `TP_ENV` 分队列，留待裁（改了能根治，但要动 worker 启动脚本与部署说明）。
- **R119 · UI 用例页没有「执行」按钮，这是计划本来的口径，不是漏做。** 走查时一度当成缺陷：详情页只有 `环境选择 | 保存 | 调试`。回去核对蓝图 §11.5.4 与本计划 T17，两处点名的顶部按钮就是这三件，没有第四个。所以要跑出一条 UI 用例的**正式运行**（`trigger=manual`，进得了报告中心）有两条路：把它当 `ui_case` 步骤放进场景跑（R111 那条链），或直接调 `POST /ui-cases/{id}/run`。**手册必须写这句实话**，不许在界面上摆一个「执行」按钮然后让它做别的事（纪律 1）。同理，调试跑的是**已保存**序列（T17 那条最大语义偏离），面板与 toast 都已写明「本次发起前已代为保存」。
- **R120 · 模块筛选「含子模块」是文案在说谎，裁「改字不改行为」。** T14 遗留的那条待裁终于落定。事实链：`shared/moduleTree.ts` 里那个函数从前叫 `subtreeIds`、注释写「子树（含自身）」，而实现**从来收集不到子孙**——命中节点之后对每个孩子调 `walk(c)`，是在孩子的子树里再找**同一个 id**，永远 `null`；`api.tsx` / `scenes.tsx` 底部还写着「共 N 条（含子模块）」。为什么不顺手「把 bug 修好」：三棵模块树的徽标都是 `group_by(module_id)` 的**直属**计数（`ui_test/module_services.py:100` 明写「count=直属未回收元素+用例」，`api_test/module_services.py:69-91`、`scenario/module_services.py:88-95` 同形），列表真把子孙算进来，点一个徽标写 3 的模块会出 7 行——**徽标与列表打架比「不含子模块」严重得多**。所以裁：行为不动，名字落到 `ownModuleIds`、三页文案落到「（选中模块）」、`moduleTree.test.ts` 的 describe 改名并加**反向钉**（`has("b1") === false`），哪天有人「顺手修好」它，测试会红并逼他先去看徽标口径。`e2e/uiElements.spec.mjs:120` 那条注释从前自称是「含子树」的证明——它选的是叶子模块，根本没子孙可漏，是句没有证据的断言，一并改直。真要做子树过滤，得连后端徽标口径一起改，那是产品决定，不是收尾时顺手做的事。
- **R121 · Ctrl+K 落到元素库的 `?q=<id>` 从来没人读，「高亮定位」是句谎话——补齐了。** 写手册时自查撞出来的：`paletteNav.ts` 注释写「元素 → 元素库并用 ?q=<id> **高亮定位**」，`palette.spec.mjs` 那条用例名一路写到「**并高亮**」，而 `uiElements.tsx` 里 `useSearchParams` 一次都没出现过（`api.tsx` 的 `?def=` 有读、元素页没有）。T12 当时只钉到 hash 形状（它自己的注释承认「此刻只能钉到 hash」），T14 把页面做出来之后**没人回来兑现那句高亮**，用例名就一直挂着一个界面做不到的词。补齐而不是删文案：`?q=` 认出元素 id → 那一行加 `.tp-row-hit`（绿底 + 左侧色条，静态不闪，理由同呼吸高亮的无障碍档）+ 一条可关的横幅说明这条是快捷搜索带过来的；行不在当前列表时（被模块筛选/回收站视图挡住）横幅改口说「不在当前列表里」，不硬说「已标出」。**踩到一条真陷阱**：一次性 latch 是错的——hash 直访是同文档导航、组件不重建，第一次落点 latch 之后，第二次 Ctrl+K 换元素仍高亮旧行（同一个组件实例带着旧 state 到了新 URL）；这是我刚加的**反向钉**（`?q=nope-…` 时不许出现横幅）第一轮跑红给我的，改成记「上一个认过的 id」。同一串 q 仍只认一次，所以用户关掉横幅不会被查询串复活。
- **R122 · 树徽标写 5、列表只有 4 行：徽标口径要在界面上说清，purge 回执还漏报第二侧。** 写手册时拿演示项目核对 R120 的口径，量出两件：① UI 模块树的 `count` 是**未回收元素 + UI 用例**合计（`ui_test/module_services.py:100`），而元素库列表只有元素——演示项目 4 元素 + 1 用例，徽标 5、列表 4 行，界面上一个字不解释，业主第一反应就是「计数坏了」。**不改徽标数字**（它是后端事实，且三棵树同一套组件），在共用组件 `ModuleTree` 上加可选 `countTip`，元素库给出悬停说明「元素 + UI 用例合计（直属，不含子模块）……用例存在时徽标会比行数大」；API/场景树不传，行为一字不变。e2e ⑤′ 把这个形状钉死：往模块里塞一条用例，徽标 1→2、行数还是 1，悬停文字在。② 顺着这条 purge 了一遍挂着用例的模块，回执老老实实带 `detached_elements=1, detached_cases=1`，而提示语只说「1 个元素转为未分类」——**用例那条被静默吞掉**。`shared/moduleTree.ts` 里那个键的注释还写着「与资产名词不同侧，不进本组件的提示语」，这句话在 UI 模块真能装用例之后就不成立了：少说一件事的成功提示仍然是说错话，跟 R112 那个「算成 0」是同一种病。改成 `purgeDetachedClauses(r, noun)` 返回整句从句数组，元素与用例各说一句（`purgeDetachedCount` 退役），vitest 147、e2e 同条钉两句都在。
- **R123 · 「worker 没起 → 503」这句 1B 手册写错了，两条 run 路径都是「Redis 起着就 200 queued」。** 写 1C 手册 §5.7 时照抄 1B §6.2 那句「不起 worker 会得到 503」，觉得不对就去验：`enqueue`（`orchestration.py:128`）与 `ui_case_run`（`debug_services.py:603`）**同一形状**——先 `_broker_alive()`（kombu 连 `redis_url`，只探 broker 通不通），探不通才 503；探通了就落 `queued` 行、`send_task` 投出去。**Redis 起着而 worker 没起**是这条链上唯一没人接球的窗口：接口回 `200 {status:"queued"}`，那条 run 永远停在「排队中」（本轮实测：投完不开 worker，12 秒后仍 `queued`；起 worker 后 4.4 秒跑完）。所以 1B/1C 手册那句「不起 worker 直接 503」**只对「Redis 也没起」这一半成立**，写反的代价是业主照着 §7 排查 503 而现场根本没有 503。三份文档一并改直：1B §6.2 / §7 那条 Q 说清 503 的确切触发条件，1C §5.7 正面写「queued 卡住 → 去看 worker 进程」并给出「取消」这个出口（**这句出口当场没验，是错的，见 R127**）。**不改代码**：「投不出去就不该建 run 行」这句设计意图是靠探 broker 兑现的，worker 没起属于「投得出去但暂时没人跑」，`queued` + 可取消是它该有的样子，不是 bug。要不要让平台侧探一次「队列有没有人在听」（celery `inspect ping`）再决定回什么，那是产品决定，记下不顺手做。
- **R124 · UI 用例能挂模块、界面上却看不到也改不了，是本期口径不是漏做。** 后端 `ui_case.module_id` 存在、`ui_module_tree` 的 `count` 也把它算进去（就是 R122 那个「5 vs 4」），但 `uiCaseDetail.tsx` 创建时发 `module_id: null`、更新时发 `module_set: false`——**界面上没有任何入口改一条用例的模块归属**，列表页也没有左树。后果很具体：种子里那条用例挂着 `UI 演示`（`e3f3bceb…`），而这份归属在界面上唯一的体现就是元素库那个比行数大 1 的徽标。本期不补（元素有「页面/区域」这个天然树维度，用例按场景找已经够用；配第二棵树要新页面 + 新权限位）：手册 §6.3 写明「看不到也改不了，要不要给树请业主裁」，待业主裁决清单加一条 D6。
- **R125 · UI 用例列表的「启用」列现在只是个读数，既不参与执行也没有入口能改——手册不许把它演成开关。** 写 §5.3 时照着列名准备写「停用的用例不会被跑」，动手前先验：`ui_case.enabled` 有列、`PATCH` 收（`case_services.py:231`），**但全仓没有任何消费方读它**——执行入口 `ui_case_run`、场景 handler `h_ui_case`、执行核 `ui_core.py` 都不查（`grep '\.enabled'` 在 ui_test 只剩 schema/model/写入三处，消费侧 0 命中）；界面也没有开关（详情页 `create` 硬写 `enabled: true`、`update` 载荷里根本没这个键）。实测把种子用例 `PATCH` 成 `false` → `POST /run` 照样 `queued` 照样跑完（验完立刻还原 `true`，脚本不留在库里）。所以这一列的真实语义是「后端有这个字段」，**不是「停用就不会被跑」**——照列名写演示词就是替界面撒一个谎，跟 R112「未知类型贴成接口」、R121「高亮定位」是同一种病：字段存在 ≠ 行为存在。本期**不改行为也不删列**（列是蓝图 §11.5.4 点名的，删它等于悄悄改掉业主写过的 UI），改成手册 §5.3 正面写清「没有入口能改、执行链不看它」，并加 **D7** 请业主裁「停用要不要真的挡执行」。**同一条事实顺带照出 1B**：`scenario.enabled` 同样没有任何执行侧消费方，但 1B 列表**没有**这一列（`scenes.tsx` 搜不到），所以那边没有界面在承诺什么——不构成需要同改的缺陷，记在这里免得下一个人以为「1B 也有这列，一起改」。**没有为这条加测试**：一个还没有行为的字段没什么可钉的，等 D7 裁完再钉「停用 → 执行被拒」才有意义。
- **R126 · 手册 §5.4 把「最近使用」写成了常驻控件，实测是选了元素之后才出现的一排。** 写手册时照 `CommandParams` 的字段清单顺嘴写了「+ 下面一排『最近使用』」，动手量之前它就是个猜测。真 chromium（干净 profile、`#5173` preview + `#8320` 后端）里量：`el-pick-select` 在场、选中态与每一行都渲染成 `登录页账号框` + 灰字 `id:account`（这条 §5.4 说对了），但 `[data-testid="el-pick-recent"]` 文本为空——`ElementPicker.tsx:81-83` 的 `recentVisible.length > 0` 才渲染，而历史来自 localStorage（`:57-62` 在 `use()` 里写），**第一次用的人那排根本不存在**。手册改成「你在这条命令上选中过元素之后才会出现；换机器/清缓存后第一次来是空的——它不渲染，不是坏了」。顺带把 §5.5 那句「悬停有原因」也量实了：`.ant-select-item-option-disabled` 上 hover 1.5 秒后 `.ant-tooltip` 出全句「upload 命令要到 1C+ 批次才开放（R101：…）」，添加命令下拉搜 上传/下载/frame/窗口/弹窗 全 0 命中（对照组搜「断言」出 3 项，证明不是搜索本身坏了）——这条不用改字。**没有为这条加测试**：`uiElements`/`uiCase` 的 e2e 已钉住禁用项标签与「搜不到」，「最近使用」是 localStorage 驱动的展示时序，为它写测试要先把浏览器存储做成夹具，不值。
- **R127 · 「queued 的 run 可以在报告里点取消」这句是我编的——界面上没有这个入口，取消接口也只是置旗，没人接旗就永远不动。** R123 把「worker 没起 → 永远 queued」写进三份手册时，我顺手给了一句出口「报告里那一行可以点『取消』，取消后终态已取消、0 个步骤行」。写 1C 手册后收尾核对时撞上真实现场（R125 那条探针 run `40ddf0bf…` 一直停在 queued），去点它才发现**报告详情页与运行记录页都没有取消按钮**：`grep cancelRun` 在前端只有 `api/scene.ts` + `scene/SceneEditor.tsx` 两处，那颗按钮 `scene-cancel-run` 只在**场景编辑器且本地这轮正在跑**时渲染（`SceneEditor.tsx:147-154`，e2e `sceneRun.spec.mjs:138` 钉的就是这个），`reportDetail.tsx` 里 `cancelled` 只出现在「失败步骤重跑」的判定式里。第二处不实是终态形状：起 worker 让那条 queued 被接走后落库的是 **`cancelled` + 7 行步骤**（用例行 + `d1` 已取消 + `d2`~`d6` **跳过**，`stats` 是 `total:6 / cancelled:1 / skip:5 / pass:0`，310ms），不是我写的「0 个步骤行」——「已取消 = 一行都没跑」听着干净，但它抹掉了「第一条命令开始跑之前停住、后面的命令根本没轮到」这个真形状（同 1B 的 `34a30fae…`：跑完 2 步才在第 3 步取消，那 2 步仍是 `pass`）。第三处是取消语义本身：`run_cancel`（`scenario/services.py:557-578`）只做 `request_cancel(bus)` + `rec.cancel_requested = 1`，写终态的是**执行侧在步骤边界读到旗子**（`ui_core.py:174` 的 `should_cancel` 每条命令前探测）——所以 worker 没起时点取消（或 curl 取消）**旗子插了但没人看**，那条 run 照样停在 queued；这也是刚才实测「cancel 回 200 而 status 仍 queued」的确切原因。改文档三处：1C §5.7 与 §7 那条 Q、1B §6.2 与 §7 那条 Q，改成「queued 卡住的唯一真出路是把 worker 起来（它接走后自己会停在已取消），界面上没有撤销这条 run 的按钮」。代码只读没动；`api/runs` 页要不要给 queued/running 一个取消入口记成 **D8** 请业主裁。**演示库留了一条真行**（`40ddf0bf…` = UI 用例 / ▶手动 / 已取消 / 0 通过），它正好是 §5.7 那个坑的实物教材，不删——删掉一条真运行记录去让列表好看，本身就是假。
- **R128 · 1B 的种子幂等测试是「不可能红」的假证明——T20 报的那句陈旧说法我实测坐实了，并照 1C 的读法把它收紧（改 `test_tool_surface_1b.py`，与 R129 那条分两个 commit）。** 计划 T20 那条遗留写的是「1b 那份要不要同步收紧，T23 裁」，而它的全部依据只是 1C 测试注释里的一句「REPEATABLE-READ 下不结束事务读到旧快照」——**那句话本身没人证过**，我一度打算照抄它当理由。改成先做实验：一次性探针（`tests/test_zz_probe_isolation.py`，跑完即删）让 `client` fixture 把表灌出 4 个 `ui_element`，本 session 先读一次进入读事务，然后**另一条连接**（`get_sessionmaker()`，就是 seed 用的那条路）插一行并 `commit()`，独立连接复核确实在库里（=1）。本 session **不 rollback 再读 = 4，rollback 之后 = 5**，`SELECT @@transaction_isolation` 打印 `REPEATABLE-READ`。所以旧快照是真的，而 1B 原来那段代码路径正踩在上面：第一次 `select(Scenario)` 开启读事务 → `mod.main()` 在另一条连接跑第二遍 → 直接再 `select` 读的是旧快照，于是 `len(second) == 1` 只证明了「第一遍的形状」，**「第二遍没重复建」这条承诺根本没被执行到**。修法是 1C 已经用过的那套：第二遍 `main()` 前后各 `await session.rollback()` 结束读事务，并且**只回 `id` 标量**（`select(Scenario.id)`）而不是 ORM 实例——同一 session 的 identity map 会把命中行返回成已过期的旧实例，rollback 后碰它的属性就是 greenlet 外的惰性刷新（`MissingGreenlet`，1C 那条踩过，`s_id` 也因此必须在 rollback 前取）。收紧后 `test_tool_surface_1b.py` 7 passed、与 1C 同跑 16 passed、ruff 干净。**1A 不用同改**：它只 `assert callable(mod.main)` 和常量形状，不跑第二遍也不读第二遍（`test_tool_surface_1a.py:102-109`）。**没有为「幂等」本身加新断言**——原断言的形状是对的，坏的只是它读数据的方式。
- **R129 · `schema.d.ts` 落后了一整个批次；补生成，但把「代价是零」如实写下来，别报成修了个 bug。** 收尾时对 `pnpm gen:api` 跑了一遍：与仓库那份的**语义**差异 197 行（其余全是行尾噪声——生成物写 LF、检出成 CRLF，`diff` 不 `tr -d '\r'` 会报 14018 行，我第一遍就被这个骗过一次），内容是 `/ui-cases/{id}/debug` 与 `/ui-cases/{id}/run` 两条路径 + `UiDebugOut`/`UiRunEnqueueOut`/两个 body schema，外加 `ui_case_references` 从 `UiCaseRefGroup` 换成 `items` 直出。都是 T15/T18 改后端时该一起重生成的。但**它不会造成任何故障**，三条证据：`grep 'from ".*schema"'` 九处**全是 `import type`**（生成物不进产物，`pnpm build` 输出不可能变）；`api/ui.ts` 的 `debugCase`/`runCase` 用**手写**返回类型 `UiDebugResult`，而生成物的响应本来就是 `unknown`（`@service` 返回标注是 BaseModel，不进 OpenAPI）——计划 T18 定的「混合类型口径」本来就绕开了这一点；被删的 `UiCaseRefGroup` 前端 **0 处引用**（`ui.ts:6` 注释写明 references 是 `http=None` 的内部 service）。所以这条只是让类型重新等于后端（`tsc --noEmit` 0 错 + vitest 147 就是它完整的门禁，纯类型没有运行时可跑）。**顺带照出的那条是真缺陷，不改、留待裁**：没有任何门禁跑 `gen:api` 并断言无 diff（CI 只有 tsc/e2e，六道门禁里也没它），所以类型可以一路落后到有人手动 regen 那天，而 `api/ui.ts` 头注释承诺的「后端字段一改就编译报错」**在没人重生成时不成立**。加 `pnpm gen:api && git diff --exit-code src/api/schema.d.ts` 很便宜，但 `gen-api.mjs` 要自起后端（真 MySQL + Redis + `testpilot_e2e` 库），CI 的 typecheck job 目前没这两个服务——是新增依赖，不是收尾顺手做的事。列进待裁 **D9**。

---

## 待业主裁决（写进计划，不偷偷定；每项都有推荐）

蓝图 §13 明写 1C 是「**业主强项区，深度参与验收**」，所以这十项我不替业主定死。计划按推荐值写、可按推荐直接开工，业主推翻任何一条只改本文件对应任务即可。

- **D1 · 1C 的 Playwright 范围**。蓝图两处：§13 的 1C 条目写「Playwright 执行」，§8.1（line 448）把 `ui_case -> Playwright` 画在 `run_scenario` 里，而 §13 的 1D 条目写「**1D 末达成混合场景端到端 DoD**」。**推荐**：1C 两样都做（独立用例调试 + 场景内 `ui_case` 步骤真的能跑），但**混合场景的端到端验收留到 1D**。理由：插槽是 1B 留好的（`PENDING_KINDS`），只做资产不做执行等于把「能跑」这句承诺推到看不见的地方；而混合 DoD（API+UI+ADB 同场）确实缺 1D 的 ADB 那一半。T10 的测试 ④ 就是这条推荐范围的最小可演示证据（API→UI→API 同场跑通）。
- **D2 · 定位器到底几类型**。§4.4 表 5 个、§6.3 说「六类型」（R100）。**推荐**：一期做表的 5 个（`id/css/xpath/text/name`），第 6 个请业主点名（候选 `placeholder`——Playwright 原生 `get_by_placeholder` 是最自然的第 6 种；候选 `role` 语义最好但可访问性名映射最容易和测试人员的心智打架）。
- **D3 · 元素按环境覆盖**（R105）。**推荐**：一期不做。§6.3 给那句能力的理由是「不同环境 URL 不同」，而 URL 在 1C 走 `open` 命令里的 `${base_url}`（1A 已有的环境层变量），**已经被环境覆盖了**。界面在元素库顶部说明写「换环境请用环境变量」，而不是留一个不能用的开关。
- **D4 · 有头模式**。§6.3：「有头仅 Worker 有桌面环境时可用，默认无头」。**推荐**：1C 只做无头 + 配置项 `TP_UI_HEADLESS`（默认 `true`），**界面完全不出现「有头」字样**——worker 是否在桌面会话里跑不由平台决定，给个开关就是给人一个点了没反应的按钮（§13 纪律 1）。
- **D5 · 失败截图的默认张数**。§6.3 说「失败自动截图」。**推荐**：失败那一条命令 1 张 + 整案结束 1 张（终态），最多 2 图 + 1 DOM 快照/案。全命令截图会把制品目录撑爆——`artifact_max_bytes`（`config.py:26`）只管 `detail` 外置，**`save_artifact` 没有大小闸**（实测 `artifacts.py:114-127`）。
- **D6 · UI 用例要不要一棵自己的模块树**（R124）。**推荐**：一期不做，保持现状（后端可挂、界面不可见）。
  理由：元素库那棵树值钱是因为元素有天然地理维度（登录页 / 工作台），UI 用例的组织需求目前只有
  「按场景找」，Ctrl+K 已覆盖；真要做，得同时补列表左树、详情页归属选择器与可见性口径，不是一个字段的事。
  业主如果要，最小可交付是详情页一个「模块」下拉（后端 `module_id` / `module_set` 现成）。
- **D7 · UI 用例的「停用」要不要真的挡住执行**（R125）。**推荐**：一期保持现状（列照显示、行为不变），
  由手册 §5.3 写明它现在不算开关。业主如果要它生效，最小闭环是三件一起做：详情页给一个 `enabled` 开关、
  `ui_case_run` 与 `h_ui_case` 在停用时报错拒跑（不是静默跳过——静默跳过会让一条停用的用例把整条场景演成绿）、
  再补一条「停用 → 执行被拒」的测试。**不推荐**只做界面开关不做执行侧：那比现在更坏，
  因为用户会以为拨了勾就不跑了。
- **D8 · 「排队中 / 运行中」的 run 要不要在报告中心或运行记录里给一个取消入口**（R127）。**推荐**：一期先补
  **只读侧**的诚实——把 `cancel_requested` 这个已有字段画成「已请求取消，等待执行侧接走」的状态标，
  **不加**新按钮。理由：接口 `POST /runs/{id}/cancel` 与权限位 `scenario:run` 都是现成的，加按钮技术上很小，
  但它会让「取消」在 UI 上出现在一个**根本没有执行者在跑**的 run 上，点完状态不变（旗子没人看），
  那正是本条要修的病；真要给按钮，得连带把「取消一条尚未被接走的 queued run = 直接落终态」这条语义
  定下来（现在做不到），否则按钮是假的。业主如果觉得「至少让我撤掉投错的那条」值得，
  最小闭环是两件：`run_cancel` 对「queued 且从未被 worker 接过」直接落 `cancelled`（无步骤行、写明「未被执行」），
  以及报告列表对 queued/running 行渲染那颗按钮。
- **D9 · 要不要加一道「生成物不许落后」的门禁**（R129）。**推荐**：加，但**不在 1C 收尾时加**。
  形状是 `pnpm gen:api && git diff --exit-code src/api/schema.d.ts`（本地放进第七道门禁，或 CI 里单开一个
  typecheck job）。它的代价不是命令本身（三行），而是 `scripts/gen-api.mjs` **要自起后端**才拿得到
  `openapi.json`——于是要真 MySQL + 真 Redis + `testpilot_e2e` 库，而 CI 的 web job 现在两个服务都没有
  （只有 e2e job 起 MySQL，且它是 e2e 那套服务）。业主如果要，先答两个问题：① 这条门禁放哪个 job、
  为它多起一个服务值不值；② 生成物按 LF 还是 CRLF 入库（现在生成写 LF、检出成 CRLF，
  不统一的话 `git diff --exit-code` 每次都会红）。在有人答之前，先把 `api/ui.ts` 头注释那句
  「后端字段一改就编译报错」看成**有条件成立**：条件是有人记得跑 `gen:api`。
- **D10 · celery 队列要不要按 `TP_ENV` 分开**（R118；这条从 R118 那句「留待裁」提到这里，免得它在台账里
  挂着却不在裁决清单里）。**推荐**：做，放在 1D 开头而不是 1C 收尾。形状是 worker 启动时按 `TP_ENV`
  决定 `-Q <queue>`、`send_task` 带上同一个队列名（`orchestration.py:140` 与 `debug_services.py` 的投递各一处），
  于是 dev 的常驻 worker 再也接不到 e2e/golden 投的任务。**为什么现在不做**：它同时动 worker 启动脚本、
  `.env.example`、两份手册的 §4.2b 命令与 CI 说明——收尾时改这条会让刚交付的手册立刻过期。
  代价是**这条坑还在**：本轮它就咬了两次（R118 一次、R127 收尾取证时我自己又踩一次），
  眼下唯一的防线是手册里那句「跑门禁前先确认没有常驻 worker」。
- **D11 · 首帧 `running` 可丢（R136）：要不要立专项修执行/事件的时序**。现象是 e2e 里
  `sceneRun.spec.mjs` 三条依赖「看见 running 呼吸」的用例会偶发红在第一步，而**整棵 HEAD
  同样红（9 次里 3 次，与我这一轮数字相同）**——所以它先于本批次，不是 1C+ 带来的。
  失败现场的快照显示 `run_end`、`stats`、终态着色全对，事件行是 `[2]…[6]`，**唯独 `[1]`
  （step/running）没进 DOM**：`events.publish` 是先 `commit` 再 `publish`、`core/sse.py:39`
  是「先订阅再重放」，而浏览器要等 `POST /run` 返回才开流——这一小段窗口里首帧既没被订阅
  接住、也还没进重放的可见区。**推荐**：立专项修，别塞进 1C+。理由有三：① 它是 1B 的执行/
  事件时序范围，改法（run 端点先落库再返回？还是开流前强制补发 seq 1？还是前端首帧容忍？）
  会动到 1B 已交付且被 e2e 钉住的那条链；② 现有取证路有两条（1B 的 e2e + `verify_worker.py`），
  值得一次成型的改动而不是补丁；③ 眼下它有稳定复现率，掩盖不了别的缺陷，暂时不构成阻塞。
  **业主要有的一句话认识**：界面上「这一步正在跑」的呼吸动画偶尔不出现，跑完的结果是对的。

---

## ⚖ 1C+ 批次决定记录（R130 起）

业主看到成品后问「怎么这么多功能都没做完？而且和 docs 下的文档中描述的差别很大啊？」，
并裁定「全做」。这一节记的是那五项补齐**过程中**量出来并当场处理掉的东西——它们的共同点
是：都不是「功能没做」，而是**门禁没跑所以没人知道**。

- **R130 · mypy 从「写在蓝图里、从没装过」到 93 文件 0 错；它抓到的那一个是真产品缺陷，不是一行类型噪声。** §14 写的 CI 口径是 ruff + mypy + pytest，而 `ci.yml` 里只有 ruff + pytest——mypy 只躺在 `pyproject` 的 `[project.optional-dependencies].dev`，CI 装的是 `requirements.txt`，于是 **1A–1C 没有任何一道门跑过类型检查**。补装补跑，`git archive HEAD backend` 出来的提交态实测 **Found 87 errors in 28 files**（这个数字我重新量过一次才敢写进 `ci.yml` 注释，不是凭记忆）。清零之后 `Success: no issues found in 93 source files`。
  **口径补一句（2026-11-17，见 1G 收尾文件 D67）**：本节讲的是「mypy 这步有没有进 ci.yml」，
  别读成「ci.yml 现在在跑」——本轮实测 `git remote -v` 为空、`.github/workflows/` 只有 `ci.yml` 一份，
  **这份配置从未被任何托管执行器执行过**，mypy 从此稳定生效靠的是本地门禁手跑，不是 CI 变绿。
  **唯一那个产品缺陷**：`NeedApproval.__init__` 里 `self.args = args` 紧跟 `super().__init__(msg)`——`BaseException` 把自己的入参元组写进 `self.args`，把刚赋的**工具入参字典**覆盖成 `('awaiting approval for xxx',)`。这条消息随后被当 `tool_args` 落进 `agent_approval.args` 与 `APPROVAL_REQ` 事件，**审批卡上「将要执行的参数」那一栏显示的是一句话而不是参数**。ASK 档的审批就是这个动作存在的理由，它偏偏看不清要执行什么。改名为 `tool_args`（runner 两处消费点一起改），并把原来那条只断言 `tool_name`/`tool_call_id` 的 ASK 测试收紧到断言 `ap.payload["args"] == tc2.payload["args"]` 与 `AgentApproval.args`——**旧测试的形状正好绕开了坏的那个字段，所以它一直是绿的**。改名前先写独立探针证实覆盖真的发生（`mypy` 也独立报 `Incompatible types in assignment (dict → tuple[Any, ...])`，两路各自成立）。
  **口径选择记在这里，免得下一个人图省事改回去**：`ignore_missing_imports` 从全局改成**只豁免 `celery.*`**（它装了但没 `py.typed`）。全局开等于让 mypy 对任何拼错的 import 闭嘴——`from app.core.errros import X` 也能过，那是拿门禁换一个永远绿的假象。这条改动当天只多暴露 3 处 celery 相关报错，代价极小。
  几处结构性修法而不是就地 `# type: ignore`：`ServiceResult = BaseModel | Page[Any]` 一个别名干掉 13 条（13 个列表服务原先标 `-> BaseModel`，而 `_add_route` 明确不给裸 BaseModel 挂 `response_model`，标 `Page[T]` 又是 dataclass 不是 BaseModel——原来没有「正确的那个东西」可以抄）；`ServiceCtx.db` 从 `| None = None` 改成必填干掉 17 条（实测 14 处构造点**全都带 db**，没有一处依赖 None，那个可选只是把不存在的状态写进类型）；`main.py` 那 20 行 `import app.modules.x  # noqa` 换成 `_SERVICE_MODULES` 名字清单 + `importlib.import_module`（函数体内 `import app…` 会把局部名 `app` 绑成包模块，mypy 因此报 8 条「Module has no attribute include_router」，而人读代码时也要想「这个 app 是哪个 app」）。

- **R131 · 我把 `main.py` 改成清单式 import 之后，那条防「漏 import」的门红了——红的是门的视力，不是产品。** `test_registry.py::test_every_http_service_is_routed_by_real_app` 的实现是 `inspect.getsource(create_app)` 里找字面量 `import app.modules.xxx`。它测的其实是 **main.py 的写法**而不是**路由的事实**：换成清单式 import 后 91 条路由一条不少（`app.openapi()` 实测 91 条），门却当场红，把 19 个模块全列为「没 import」。照着红字把 `import` 写回去，只是让正则重新满意，产品没得到任何多一点的保证——**这就是本台账一路在抓的那种假绿的反面：假红把人推向错误的修法**。
  新实现拉 `tests/routing_probe.py` **子进程**：全新解释器只 import `app.main`，除它之外谁都没 import，于是「哪个带 http 路由的模块没被 `create_app` 带进来」「哪条注册过的路径不在 app 上」都由解释器回答，与用哪种 import 写法彻底解耦。子进程不是偷懒，而是这条测试**本来唯一有效的形态**——该测试自己的 docstring 就写了「全量跑时别的测试文件又会替它 import，生产是坏的而测试是绿的」，进程内 `sys.modules` 检查永远中这个招。探针另外自报两条不变量：基线（`app.main` 之外不许有领域模块在场，否则「不在场 ⇒ 没被 create_app import」的推断失效）与**扫描口径**（注册表里有 http 路由、扫描却没算到该模块 ⇒ 有人把 `http={...}` 抽成了常量）。我一开始给扫描范围写了 `scanned >= 19` 的魔数下限，随即换掉——模块数会因正当重构增减，那种断言只会到期变红。
  **改完必须证它还能红**：把 `"app.modules.workbench.services"` 从清单里删掉 → 该测试红，报的正是「带 http 路由却没被 create_app import」。旧的假红形状（换 import 写法）现在绿，新的真红形状（真漏一个模块）仍然红——这才是这条门该有的分辨力。

- **R132 · refresh 落地时，两条自带 `Authorization` 的路被漏在刷新机制外面，其中 SSE 是**每 1.5 秒空转一次的死循环**。** 蓝图 §3.4 的 refresh 半区（access 2h + refresh 7d HttpOnly Cookie）做完后，`client.ts` 的 `api()` 享受 401→静默刷新，但 `shared/sse.ts`（`EventSource` 不能带 header，所以手搓 fetch）与 `shared/artifactSrc.ts`（制品是裸字节，`res.json()` 会炸，所以也手搓 fetch）**各走各的**。后果不是「不方便」，是两个具体的坏行为：① SSE 把 401 当网络错——`throw` 落进 `catch {}` → `onDown` → 睡 1500ms → 再连，而手里那枚过期 access **永远不会突然变有效**，界面上只表现为「进度不动了，也没任何提示」（§13 纪律 1 明写的静默降级）；② 取制品直接 `onUnauthorized()`，登录着点一张截图就被踢回登录页。**「access 只有 2 小时」这条承诺本身就要求这两条路一起补**，只补 JSON 接口等于做了个半成品。
  三条路现在共用 `client.ts` 里同一个 `refreshOnce()`（导出它而不是各抄一份：`refreshPromise` 是「并发只刷一次」的唯一实现点，抄一份就少一份防踩踏，而 SSE 每 1.5 秒就可能再撞一次）。SSE 侧**限了次数**：一轮断连只许刷一次，刷成功就带着 `Last-Event-ID` 重连（服务端按 seq 补差集，不重不漏），刷不动才登出并 `return`。这个上限是必须的——不限的话，若 401 的原因不是过期（权限改判、后端把别的状态也报 401），refresh 会成功、重连仍 401，于是**把一个静默死循环换成一个拿 `/auth/refresh` 打洪的更吵的死循环**。也不是「整条流只一次」：一条能挂几小时的流中途网络抖一下时 access 早过期了，那次刷新是正当需要。
  后端侧确认口径对齐：`GET /events/run/{id}` 无令牌/坏令牌都返回 **401 `{"code":"unauthorized"}`**（对活着的 8320 实测，不是推测），所以前端按 `status === 401` 分支是对的。
  **`sse.ts` 此前一行单测都没有**（只有 `e2e/sse.spec.mjs` 测真断线重连，认证全程有效，压根走不到这段），新增 `sse.test.ts` 5 例钉住：刷得动就带新 access 重连且**不许登出**、刷不动就登出且**停手**、刷成功但仍 401 时**只补一次**、无 token 时不去调 refresh、以及重连带 `Last-Event-ID`。
  **两处我自己写的测试缺陷，都当场改掉了，因为它们正是本台账点名的病**：① 「停手」原来只等 60ms 就断言计数——而旧形状的重连间隔是 1500ms，**就算代码完全没修，那一轮也还没来得及再连**，这条断言当时是不可能红的；改成等 1800ms 越过间隔。② 更难看的是**跨用例污染**：断言一抛，写在它后面的 `h.close()` 就永远执行不到，那条 `pump()` 循环还在跑，会拿着**下一个用例**的 fetch 桩继续连，于是「测 401」的用例失败会把旁边只测 `Last-Event-ID` 的无辜用例一起带红（我一度以为是我改坏了重连，差点去查错的地方）。改成句柄一律登记、由 `afterEach` 统一 close，不靠每个用例自己记得。
  变异验过：把 `sse.ts` 的 401 分支整段删掉 → **恰好那 4 条认证测试红、`Last-Event-ID` 那条仍绿**（修污染之前它是 5 条全红，那个「全红」本身就是在骗人）。

- **R133 · 禁用一个账号能不能真的停用他，此前没有任何测试——而无状态设计里这是唯一还活着的闸。** refresh 令牌不落库、没有 jti 拒绝名单（`security.create_refresh_token` 的限制注释），`logout` 只清浏览器 Cookie，所以「停用」能生效的机制**只剩每次请求回表查 `status != "active"`**。Bearer 侧查（`iam/deps.py:31`）、refresh 侧也查（`iam/routes.py:78`），但**两侧都没测过**。这条必须一起封并钉住：否则管理员在控制台点了停用，对方仍能靠 7 天有效的 refresh 每 2 小时续一次命，「停用」成了只挡住一半的开关。新增 `test_refresh_for_disabled_user_is_401`：先在停用前证明 refresh **能用**（不这么做的
话这条测试可能一直在测「refresh 本来就不行」，那是最容易假绿的形状），再停用，断言 refresh 401
**且文案是「账号不可用」而不是「登录状态无效或已过期」**（前者说人被打断了，后者说令牌老了，
两件事混在一起运维就查不动），再断言停用前签发的 access 也立刻 401（同一次停用应当两边都断）。
变异验过：把 routes 里的 `user.status != "active"` 拿掉 → 该测试红，红得很具体（返回了 200 和一枚新令牌）。
用例结束把 admin 还原成 active——它是全局引导账号，留着 disabled 会毒化同 session 后面的测试。

- **R134 · `entry` 词表里那个 `"web"` 是第三个永远读不到的词，而生产代码里还在亲手造它。** `ServiceCtx.entry` 的词表是 `http/agent/schedule`（审计表列注释、审计筛选下拉都按它认），但执行引擎重建 ctx 时原先写 `str(actor.get("entry") or "web")`——`"web"` 从来不在词表里，于是它永远命不中任何分支（`entry` 只有 `== "agent"` 会改分支）。mypy 清干净之后 `normalize_entry()` 把词表外一律折算成 `http`（**方向是安全的**：把未知当 `agent` 等于给一次人点的操作伪造「Pilot 干的」，那是审计里最不该有的错；反过来最多审计上少标一次 Pilot）。**但只改读的一侧是半件事**：`engine/context.py:48` 的 `_copy_actor` 兜底还写着 `"web"`，等于一边宣称词表收敛了、一边继续往身份快照里造同义词。改成 `"http"` 并写明理由。
  顺手把这条折算规则**本身**钉成测试（`test_registry.py` 两例）：三个词表成员原样通过（`agent` 必须原样，否则「Pilot 干的」这条 attribution 整批丢）、`"web"`/`"WEB"`/空串/`None`/`7`/`["http"]`/`object()` 全落回 `http`、`ctx_from_actor` 保 `agent` 且把 `perms` 的 list 收成 set。此前**没有任何测试**碰过 `normalize_entry`/`ctx_from_actor`。变异（去掉 `in _ENTRIES` 成员检查）→ 红在 `assert 'web' == 'http'`。
  **10 处测试里的 `"entry": "web"` 我没动**：那些是各测试自己造的 actor 字典，改它们等于为了「搜不到这个词」去动 10 个与被测行为无关的夹具；`test_engine_context.py:306` 那条断言的是 `_copy_actor` 的**逐字拷贝**语义（传入什么就快照什么），与兜底值无关，所以兜底改成 `http` 不需要改它——它照旧绿，我也照旧能一眼看出它测的不是词表。

- **R135 · 门禁数字（本轮实跑，全部我自己重跑过，不引用子 agent 的自述）。** 后端 **616 passed**（`312.78s`）；ruff `app tests migrations scripts` All checks passed；`lint-imports` **Contracts: 4 kept, 0 broken**（新模块 `app.modules.workbench` 已登记进契约 3 的 composition 清单——不登记就扫不到，「4 kept」就是漏数撑出来的假绿，与 1B 登记 `search` 时同一个坑）；`mypy app` **0 错 / 93 文件**。前端 `tsc --noEmit` 0 错、`pnpm lint` **0 error / 7 warning**（warning 全是 `react-hooks/exhaustive-deps`，按 eslint.config.js 的裁定定级为 warn）、vitest **164 passed / 12 文件**（147 → 159 是 `client.test.ts` + `workbench.test.tsx`，本轮新增；再到 164 是本轮又加的 `sse.test.ts` 5 例。顺带纠正我自己中途报过的「147 vs 153」：那个 153 是错的，而且我把因果说反了——`vitest.config.ts` 的 include 原先只有三个 glob，这两个文件是**本轮新建**的（`git cat-file -e HEAD:...` 两个都不在 HEAD 里），所以 widen include 是新测试能跑起来的**前提**，不是「修好了一直没跑的旧测试」）。

- **R136 · e2e 有一条**先于本批次**的 flaky，我用控制变量证了它不是我改的，并且记下了它真正的形状。** `e2e/sceneRun.spec.mjs` 的「执行实时进度 / 断线重连 / 取消执行」三条都会偶发红在**第一步**：等 `[data-testid='scene-node-*'][data-run-status='running']` 超时。我第一反应是怀疑自己改的 `sse.ts`（其中一条正是断线重连），所以没猜，做了四臂对照，同一台机器、`--workers=1`、同一条 spec：
  - 我的前端 + 我的后端：3 次里 2 次红
  - HEAD 的 `sse.ts`/`artifactSrc.ts` + 我的其余前端 + 我的后端：3 次里 2 次红
  - 我的前端 + **HEAD 的后端**（`git archive HEAD backend` 起在 8321）：9 次里 3 次红
  - **整棵 HEAD**（前端也取 HEAD 自建自构建）：9 次里 3 次红
  后两臂数字相同 → **本批次不是原因**。（前两臂各只有 3 次，n 太小，我当时差点据此说「HEAD 也红所以肯定不是我」——真要说得清就得把 n 拉起来，所以补到 9/9。）
  **失败的真实形状**比「flaky」有用：失败现场的页面快照里 `run_end`、`stats`（共 3 · 过 1 · 败 1 · 跳 1）、终态着色**全都在**，事件行是 `[2]…[6]`——**唯独 `[1]` 那一帧（step/running）没进 DOM**。也就是说不是执行坏了、不是流断了，而是**第一帧没被看见**：`run` 端点返回前执行核就已经把 seq 1 发出去了（`events.publish` 是先 `db.commit()` 再 `bus.publish`，`core/sse.py:39` 是「先订阅再重放」，重放读 `run_event`），浏览器那侧 `POST /run` 回来才开流，中间这一小段窗口里 seq 1 既不在订阅里也还没进重放可见区。**这是真缺陷的形状**（首帧可丢 → 界面上「呼吸」这一视觉承诺偶尔不出现），但**修它属 1B 的执行/事件时序范围，不在 1C+ 这五项里**，且它有 1B 的 e2e 与 `verify_worker.py` 两条现成取证路，动之前该先立专项。列进待裁 **D11**，不悄悄修、也不悄悄不提。
  另记两条**取证环境**的坑（都不是产品缺陷，但都会让我误判门禁）：① `playwright.config.ts` 三个 webServer 全 `reuseExistingServer: true`，我做 HEAD 前端那臂时 5173 上一直有一个我自己早先起的 preview 占着——它服务的是**我的 dist**，于是那一臂最初几次其实测的不是 HEAD（我第一次得到「HEAD 3/3 全绿」正是这个无效样本）；靠 `--strictPort` 与 `➜ Local:` 那行才确认预览确实是**新起的一个**、 rooted 在 HEAD 的目录。② 我一度并行跑全量 pytest 与 e2e，README 早就写了这两件事会互抢（celery 队列 / 5173），所以那些数字不算取证，之后全部改成串行重跑。

- **R137 · 收尾：门禁从六道变八道、README 数字换成终值，以及我自己写错的两句注释被实测打脸（各改一次）。**
  **① 终值**（全部在最终工作树上自己重跑，不引用任何子 agent 自述，也不引用中途那次 in-flight 日志）：
  `pytest -q` **618 passed / 308.92s**（R135 里我写的 616 是那次**还在跑**的日志读来的，`PYTEST_EXIT` 还没落——同一个毛病我又犯了一次，见 R135 末尾对 615/616/618 的纠正）；
  `ruff check app tests migrations scripts` All checks passed；`mypy app` **0 错 / 93 文件**；
  `lint-imports` **4 kept, 0 broken**；`pnpm lint` **0 error / 7 warning**；`pnpm test` **164 passed / 12 文件**；
  `tsc --noEmit` 0 错；`pnpm build` 与 `pnpm build:e2e` 都过；**e2e 70 passed / 2.7m / `E2E_EXIT=0`**，
  且这次是**干净环境**（5173 与 8321 都空着、无常驻 worker——R136 那两条坑各自排除后再跑，所以这个 70 是取证，之前那几个数字不是）；
  `scripts/migrate_dev.py` **0018 -> 0019 (head = 0019)**。R136 的 flaky 这次没出现，但**一次绿不推翻 9 次里 3 次红的统计**，D11 照旧挂着。
  **② 门禁计数**：CI 现在真跑 mypy + `pnpm lint` + `pnpm test`，README 再写「六道」就是拿旧地图指路，
  所以改成**八道**并重排编号（①–④ 后端、⑤–⑦ 前端、⑧ 对齐 head）。计划文档里 1C 那几处「六道门禁」是**当时的历史事实**，不改。
  **③ 我写错的第一句**：`workbenchTrend.tsx` 头注释原本写「折线一种图不值得让整个**首屏**背 ~1MB 的全量 echarts」。
  这句话是**没量过的想象**，而且方向是错的：该组件在 `workbench.tsx` 里是 `lazy()` 引入的，
  我实测两种写法（同机、同树，只换 echarts 的引入方式）下入口 `main-*.js` **尺寸都是 1421.82 kB / gzip 437.13 kB**——
  全量 echarts **一个字节都没进首屏**（两次的 main 哈希不同：入口按名字引用懒加载分片，分片改名它就得跟着变，
  所以「尺寸一致」才是证据，我第一版把这句写成「一字不差」，是自己把哈希不同的事实看漏了，已改）。
  真正有差别的是懒加载分片本身：按需 **458.33 kB / gzip 152.28**，
  全量 **1023.43 kB / gzip 332.59**（≈2.2 倍）。注释现在写的是这组数字与「省的不是首屏」这句纠偏。
  顺带量出一条事实：`import * as echarts from "echarts"` 配 `echarts.use([LineChart, …])` 是**类型错误**
  （全量入口与 `echarts/charts` 子路径是两套互不兼容的声明，TS2322 ×4），所以「换全量」不是改一行 import。
  **④ 我写错的第二句**：同一处注释写「chunk 尺寸对比**见提交说明**」——那时还没有提交说明，而 ~1MB 是拍的。
  现在数字在注释里，不再挂在一段还不存在的文字上。**⑤ 顺手修掉我自己在 ledger 里造成的格式破坏**：
  R136 末段与 `---` 之间漏了空行，CommonMark 会把 `---` 读成 setext H2，把 R136 的结尾**变成一个二级标题**
  （全文只有这一处这么写，`awk` 逐行核过）。
  **⑥ 终值写进 README 之后我又复跑了一次 e2e，这次 69 passed / 1 failed**，我差点让「70 全绿」留在文档里过夜。
  失败的是 `sceneRun.spec.mjs:26`「执行实时进度」，形状与 D11 一字不差：等
  `scene-node-s1[data-run-status='running']` 超时，而失败快照里 `run_end`、
  `stats`（共 3 · 过 1 · 败 1 · 跳 1）、终态着色**全都在**，事件行是 `[2]…[6]`——
  **唯独 seq 1 那帧没进 DOM**。这次我没停在「看起来像 D11」：两次 `build:e2e` 的产物文件名
  逐一对齐（`main-CzFtUdQM.js`、`workbenchTrend-B_5C6x2h.js`、`index-BEUaFYHe.js`、
  `main-C955riXA.css` **哈希全同**），而夹在两次之间改的确实只有注释——
  **产物字节相同 ⇒ 70 与 69 的差不是代码，是那条 flake 本身**（同一份产物跑两次：1 绿 1 撞，
  与 R136 量到的「9 次里 3 次」同量级）。README 的 ⑦ 因此改成诚实口径「稳定 69 条，第 70 条撞 D11」，
  而不是挑好的那次写「70 全绿」。**这是「只有 git 是证据」的一次实际兑现**：我先提交的 README
  写了 70，自己的复跑把它证伪了，于是有了更正提交——推它改文档的不是新需求，是复跑。

- **R138 · R118(抢队列)的根治在 1D T0 落地（commit 2849b1e）**：Celery 队列按 `TP_ENV`
  分道，`Settings.task_queue = "tp." + env` 一条纯函数，投递现算 / 消费在 worker import 时烘焙
  （两种刻意不对称，理由写进 `config.py` 注释）。两条真投递路（scenario enqueue + ui_case run）
  都显式 `queue=`；worker `task_default_queue` 锁接；verify_worker 每次独占 `tp.verify{ts}`。
  从此「测试 lane 的消息被演示 worker 领走」**物理上不可能**，而非靠手册那句「跑门禁前先停掉
  手工 worker」（那条口头纪律在这个 commit 之后降级为历史）。钉它的 `tests/test_queue_split.py`
  五条四层，其中第 ④ 层用 kombu memory 传输复现事故现场：投进 `tp.test` 的消息，领 `tp.dev`
  的消费者取不到——改回共用默认队列这条必红。**顺手补了一个 1B 时代就存在的测试盲区**：
  celery 档以前只测过「broker 死了 → 503」，「broker 活着时投到哪个队列」全靠肉眼，这次用
  spy 把两条投递路的 queue 参数钉死。52 条相关回归全绿；mypy 4 文件、ruff 全过。

---

## 文件结构（1C 建成后新增/改动）

```
backend/app/modules/ui_test/          # 新领域模块（契约 1 + 契约 3 都要登记）
  __init__.py  models.py  schemas.py  commands.py        # commands = §7.2 协议与校验（纯函数）
  element_services.py  case_services.py  module_services.py
backend/app/modules/execution/ui_core.py                 # Playwright 驱动（契约 4：零 app.modules.* import）
backend/tests/test_ui_commands.py test_ui_element.py test_ui_case.py test_ui_core.py
             test_ui_debug.py test_tool_surface_1c.py test_golden_1c.py
backend/migrations/versions/0018_ui_test.py
web/src/ui/            # 命令列表编辑器 + 选择器弹窗 + 调试面板（页面在 pages/，组件在 ui/）
web/src/api/ui.ts      # 客户端，模板是 api/scene.ts
web/src/pages/uiElements.tsx  web/src/pages/uiCases.tsx
```

**复用而非新建的清单**（每条都是实测过的现成件，重写一份就是 §13 纪律 1 违例）：
`api/ModuleTree.tsx`（props 已参数化：`apiBase`/`allLabel`/`noun`，:27-29、:37）· `api/DebugPanel.tsx`（断言卡 :53-77，只吃 `DebugResult`）· `components/CodeEditor.tsx`（自托管 Monaco，无 CDN）· `api/EnvPanel.tsx` 的 `EnvSelect` · `shared/sse.ts` 的 `openRunStream` · `layout/ProjectGate.tsx` 的 `PageHead` · `execution/artifacts.py:save_artifact`（:114，`kind` 无任何枚举校验，`RunArtifact.kind` 注释里 `SCREENSHOT` 早就列着了，`execution/models.py:98`）。

---

## 后端：地基与资产（T1-T6）

### Task 1: Playwright 依赖接入 + 版本配对钉 + 靶场 HTML 页（先证明，再往上盖）

**Files:**
- Modify: `backend/pyproject.toml`（`dependencies` + `R28` 那条契约注释）、`backend/requirements.txt`、`backend/scripts/target_app.py`
- Create: `backend/tests/test_ui_deps.py`

**Interfaces:**
- Produces: 后端依赖 `playwright==1.65.2`（**精确等号**，不是 `>=`——版本配对是 R97 的前提，`>=` 会让 CI 在某天悄悄要第二份 chromium）。
- 靶场新增页面（R98，同进程 9999）：`GET /ui/login`（表单：`#account` `#password` `#submit`，错口令出 `#err`，对则 `Set-Cookie: ui_session=demo` 并跳 `/ui/home`）、`GET /ui/home`（无 cookie → 401 页；有则渲染 `#title`=「订单工作台」、一张表，其中 `#late-row` 由前端 `setTimeout(3000)` 才插入——1B §5.6 用 `/slow` 拉时间窗，这里靠它拉「等元素」）、`#frame` 一个 iframe（内部有 `#in-frame`）、`#pop` 按钮点开出 `#dialog`、`#js-sum` 由 `evaluate` 填。
- 配置项（`core/config.py`，与 `artifacts_dir` 同族）：`ui_headless: bool = True`、`ui_concurrency: int = 4`（§6.3 默认 4）、`ui_command_timeout_ms: int = 10_000`（对齐 §7.2 示例）、`ui_default_max_runtime_ms: int = 300_000`（UI 用例比接口慢两个量级，5 分钟是有依据的默认，不是抄 `max_runtime_default_ms`）、`ui_browser_channel: str = ""`（D4/前置取证 3 的离线退路）。

- [ ] **Step 1: 写失败测试** `test_ui_deps.py`：① `import playwright` 成功且 `__version__ == "1.65.2"`；② **版本配对**（R97）：读 `playwright/driver/package/browsers.json` 与 `web/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/browsers.json`，断言两者的 `chromium` revision 相等；**前端那份读不到时 `pytest.skip("前端未 pnpm install，版本配对未验证")`——skip 必须打印原因，不许静默绿**；③ 靶场四个页面可达（`ASGITransport` 打靶场 app），`/ui/home` 无 cookie 是 401、带 `ui_session` 是 200，`/ui/login` 的 HTML 里五个 testid 齐；④ 新配置项有默认值且 `ui_headless is True`（D4 的「默认无头」是配置事实，不是文案）。
- [ ] **Step 2: 跑红**（`playwright` 未装 → ImportError 就是红）。
- [ ] **Step 3: 装依赖 + 写靶场页**。`pip install playwright==1.65.2` 进 venv；靶场加 HTML（纯 stdlib 字符串模板，不引 jinja，别为一页 HTML 加依赖）。**本步不下载浏览器**（T7 才需要），先让单测只用 HTML。
- [ ] **Step 4: 跑绿**。顺带实跑一次 `python -m playwright install chromium --dry-run`（或读 `browsers.json`）把 revision 抄进 CI 注释，让 `ci.yml` 那步 `playwright install` 的存在理由写明「前后端共用这一份」。
- [ ] **Step 5: Commit** `feat(1c): playwright 1.65.2 pinned to the web browser revision + HTML pages in the demo target`

### Task 2: 迁移 0018 三表 + 模型（§4.4）

**Files:**
- Create: `backend/migrations/versions/0018_ui_test.py`、`backend/app/modules/ui_test/__init__.py`、`models.py`
- Modify: `backend/migrations/env.py:14`（autogenerate 清单补 `ui_test`，顺手补漏了的 `scenario`/`search`——现状 `("iam","env","api_test","audit","model_cfg","agent")` 落后两个模块）
- Test: `backend/tests/test_ui_models.py`

**Interfaces:**
- Produces 三表（照 `scenario/models.py` 的列风格，`ProjectScopedMixin, TimestampMixin, Base`）：
  - `ui_module`——镜像 `api_module`/`scenario_module`（R99 第三棵树）：`parent_id`(index)、`name`、`sort`、`status`；`UniqueConstraint("project_id","parent_id","name", name="uq_ui_module_parent_name")`。**根层重名 DB 管不住**（MySQL 唯一键不判等 NULL），服务层自查，这条注释要照抄 `0016` 的原话。
  - `ui_element`——`module_id`(index，**不设外键**，照抄 `scenario/models.py:23-24` 的理由)、`name`、`locator_type` String(16)、`locator` String(500)、`comment` String(500)、`owner_id`、`project_public`、`status`、`updated_by`；`UniqueConstraint("project_id","name", name="uq_ui_element_project_name")`（元素是**扁平命名空间**：§11.5.4 的列表没有「同模块可同名」的迹象，且引用检测按名字找人，同名跨模块是灾难）。
  - `ui_case`——`module_id`、`name`、`priority` String(4) default `P2`、`enabled` SmallInteger default 1（§11.5.4 列表有「启用」列）、`steps` JSON not-null、`env_id`(index)、`owner_id`、`project_public`、`status`、`step_count` Integer default 0（冗余计数，列表不 N+1，照 `scenario.step_count`）、`last_run_at`/`last_run_status`（§11.5.4「最近结果」，同 `scenario` 的终态回写）、`updated_by`。**无 `version`**（R104）。
- `locator_type` 一期词表（R100）：`id|css|xpath|text|name`——小写入库（与全站 status 词表小写一致），§4.4 表写的是大写枚举名，映射在注释里说清。
- **两列必须建**：`owner_id` + `project_public`（`shared/visibility.py:25,32` 的 `getattr(..., True)` 会让漏建等于全公开——这是静默失效）。

- [ ] **Step 1: 写失败测试** `test_ui_models.py`：① 三表可插可查；② `uq_ui_element_project_name` 撞名报 IntegrityError，**跨项目同名可以**；③ 每行默认 `project_public=True`、`status="normal"`、`enabled=1`、`step_count=0`；④ `down_revision == "0017"` 且链头唯一。
- [ ] **Step 2: 跑红** → **Step 3: 写迁移**（docstring 要写「§4.4 + 计划 T2 + R99/R100」，照 `0016:1-12` 的体例）。`upgrade` 建三表；`downgrade` 按 `_NEW` 逆序 `drop_table`（`0016:68-70` 同款）。
- [ ] **Step 4: 跑绿 + 验 down**：`python -m alembic upgrade head` 后 `downgrade -1` 再 `upgrade head`，**三张表真消失真回来**（§13 纪律 3 的「能跑的 down」，不是写了 `drop_table` 就算）。最后 `python scripts/migrate_dev.py` 对齐开发库（第六道门禁）。
- [ ] **Step 5: Commit** `feat(1c): ui_module/ui_element/ui_case tables (migration 0018 with working down)`

### Task 3: 模块骨架 + 契约登记 + 权限点（把假绿先炸出来）

**Files:**
- Modify: `backend/pyproject.toml`（契约 1 `modules` + 契约 3 `source_modules`，**并更新 :63 那句 1B 注释为 1C 登记**）、`backend/app/main.py:44-45` 附近加 import、`backend/tests/test_tool_surface_1c.py`
- Create: `backend/app/modules/ui_test/__init__.py`（一行 docstring，照 `scenario/__init__.py:1`）

**Interfaces:**
- Produces: `app.modules.ui_test` 进两个契约清单；权限点 `ui:element:read/create/update/delete`、`ui:case:read/create/update/delete`、`ui:module:read/create/update/delete`、`ui:case:debug`（T9 落地时才会全部出现，本任务先立骨架 + 契约测试）。
- **本任务先只登记契约、写测试，让它红**（红→绿是 T23⑥ 在 1B 立下的手法：先暴露再补，避免「写了清单再写测试」的自证）。

- [ ] **Step 1: 写失败测试** `test_tool_surface_1c.py` 的契约段（照 `test_tool_surface_1b.py:107-141` 直接解析 pyproject）：① `"app.modules.ui_test" in 契约1.modules`；② `in 契约3.source_modules`；③ **反向钉**：`ui_test` 不在契约 2/4 的 source 侧（它们是包级 glob，不该被逐名列举——列了就是外行）；④ 打印的 `lint-imports` 结果仍是 `4 kept, 0 broken`（**加名字不改契约数**，这条防有人误开第五个契约）。
- [ ] **Step 2: 跑红**（清单里没有 ui_test → ①② 红）。
- [ ] **Step 3: 登记 + 建模块 + `main.py` 加 import**（ruff `I` 会管顺序，`pyproject.toml:43`）。
- [ ] **Step 4: 跑绿 + 实跑 `.venv/Scripts/lint-imports.exe`**，逐字核对打印文字是 `Contracts: 4 kept, 0 broken`（退出码不算证据，`README.md:68` 立的规矩；也**不许**用 `-m importlinter.cli lint`，那是静默空跑的陷阱）。
- [ ] **Step 5: Commit** `chore(1c): register ui_test in import-linter contracts 1 and 3`

### Task 4: §7.2 命令协议与保存期校验（纯函数，无 DB）

**Files:**
- Create: `backend/app/modules/ui_test/commands.py`
- Test: `backend/tests/test_ui_commands.py`

**Interfaces:**
- Produces（全纯函数，对任何畸形输入**只产 issue、绝不抛异常**——`graph.py` 同规）：
  - `COMMAND_TYPES`（24 个，逐字取自 §7.2 line 393）、`BLOCKED_1C = {"upload":"1C+","download":"1C+","switch_frame":"1C+","switch_window":"1C+","dialog_accept":"1C+"}`（R101；值先统一写 `1C+`，业主裁决 D1 若要求 1C 内做完就整族删除）。
  - `ELEMENT_TYPES = ("id","css","xpath","text","name")`（R100）。
  - `validate_commands(steps: object) -> list[Issue]`，`Issue = {index, code, message}`（UI 命令是**扁平数组**，没有 key/tree，所以按 `index` 定位，不像 `graph.py` 要 key+path）。
  - code 全集：`bad_step`（不是对象）、`empty_steps`（空数组——空用例跑起来「零步全绿」是假绿，必须保存期就拦）、`bad_id`、`dup_id`、`unknown_type`、`command_not_available`、`missing_element_ref`（既无 `element_id` 又无 `inline_locator`）、`both_locators`（**两个都给**——§7.2 line 393 说的是二选一，两个都给等于运行时才知道听谁的）、`bad_locator`（`inline_locator` 不是 `{type, value}` 或 type 不在 `ELEMENT_TYPES`）、`bad_timeout`（给了但非正整数）、`bad_save_var`（非标识符）、`missing_input`（`input`/`key`/`select`/`js`/`assert_text`/`assert_title` 这几类必须有值）。
  - `summarize(step, element_names: dict[str,str]) -> str`——§11.4.12 每行「命令名 + 关键参数摘要」的**唯一**生成处（前端只显示后端给的字符串？不：后端提供同名函数只为测试与 Pilot 展示，前端有对等的 TS 实现，两边由 T15 的表驱动测试钉一致——**别做成后端算前端显示**，那会让改文案要发后端）。
- 语义钉点：`id` 规则同 `graph.py` 的 key 但**不需要点号分段**（扁平）；`optional` 是 bool（§7.2 的「失败继续」，与 1B `optional` 同语义）；`save_var` 存的是 `get_text`/`get_attr`/`js` 的结果（R 承 1B：变量值一律 `str`）。

- [ ] **Step 1: 写失败测试**（表驱动，一条 case 一个断言）：① **§7.2 文档示例逐字誊为 fixture**（协议对齐试金石，1B T4 的手法）→ 零 issue；② 24 种 type 各自的最小合法步 → 零 issue（除 5 个 `command_not_available`）；③ `element_id` 与 `inline_locator` 只给一个 → 过，都给 → `both_locators`，都不给（对需要定位器的 12 种 type）→ `missing_element_ref`；④ `open`/`sleep`/`screenshot`/`js` **不需要**定位器；⑤ 空数组 → `empty_steps`；⑥ 空串、`"abc"`、`{"steps":"x"}`、嵌套 list 等垃圾 → 返回 issue 不抛；⑦ `timeout_ms: 0` / `-1` / `"10"` → `bad_timeout`；⑧ 同 id 两行 → `dup_id`；⑨ `save_var: "a b"` → `bad_save_var`。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): §7.2 command protocol and save-time validation (pure)`

### Task 5: 元素库服务面（CRUD + 回收站三件套 + 引用检测）

**Files:**
- Create: `backend/app/modules/ui_test/schemas.py`、`element_services.py`
- Test: `backend/tests/test_ui_element.py`

**Interfaces:**
- Produces（§11.5.4 列表列 = 名称 | 定位方式 | 表达式 | **关联用例数** | 更新时间）：
  - `ui_element_list` GET `/ui-elements`（perm `ui:element:read`）→ `Page[UiElementOut]`，每行带 **`used_by: int`**（关联 UI 用例数，**批量一次算**：`select(ui_case.id, steps).where(project_id, status=='normal')` 内存里数，别 N+1；回收站里的用例不计——与 `search/services.py:89,104,119` 的 `status != "recycled"` 同口径）。
  - `ui_element_create` POST `/ui-elements`、`ui_element_update` PATCH `/ui-elements/{element_id}`、`ui_element_delete`/`restore`/`purge` POST `/ui-elements/{id}/{delete,restore,purge}`。
  - **引用检测（R106）**：`ui_element_delete` 与 `ui_element_update` 的「改 `locator_type`」两条路要查引用；delete 命中 → 409 `referenced_by_case`，`details.cases=[{id,name}]`（§11.4.11「删除弹引用检测列表」）。`ui_element_purge` 同样硬拦（**不**沿用「回收能过、彻底删除也拦」的两档——元素被引用时物理删除会让用例永久损坏；这条与场景 purge 的差异要在 docstring 写理由）。purge 一律 `tool=False` + 逐字输名（R53）。
  - 同项目同名（**含回收站占位**）→ 409 `name_exists`，文案给出口（「先恢复或彻底删除」），照 1A §5.10 手感。
  - 可见性：`visible_clause(UiElement, ctx)`（需 T2 两列）。
- 内部件：`ui_element_refs`（`http=None, tool=False, resident=False`，照 `scenario_case_refs` :411-415 的三点分歧——**不因缺 `ui:case:read` 而 403**，拦不拦由数据决定；无权限时 `details_hidden=True` 且明细为空，「查不到是谁」要说出口）。

- [ ] **Step 1: 写失败测试**：① 建/查/改/回收/恢复五步，列表带 `used_by`；② 造一条引用它的 UI 用例 → `used_by==1` → delete 得 409 且 `details.cases` 点名；③ 回收该用例后再删元素 → **通过**（回收的用例不算引用）；④ 回收站里的同名元素挡住新建（`name_exists`）；⑤ purge 未输名 → 409 `name_mismatch`，输对则物理删、同名立刻可重建；⑥ 跨项目 element_id → 404（不泄露存在性）；⑦ READONLY 角色 list 200 / create 403；⑧ `ui_element_purge` 不在 `GET /agent/tools`（`tool is False`）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): element library with reference-checked delete and recycle bin`

### Task 6: UI 用例服务面 + 第三棵模块树

**Files:**
- Create: `backend/app/modules/ui_test/case_services.py`、`module_services.py`
- Test: `backend/tests/test_ui_case.py`、`test_ui_module.py`

**Interfaces:**
- Produces:
  - `ui_case_list` GET `/ui-cases`（§11.5.4 列：名称 | 优先级 | 启用 | 最近结果 | 负责人 | 更新时间 → `last_run_at/last_run_status` 读冗余列，**不 N+1 查 run_record**，照 `scenario_list` 的做法）；`ui_case_get`/`create`/`update`/`delete`/`restore`/`purge`。
  - 保存期：`validate_commands` 有 issue → 422 `validation_error` + `details.issues`；**外加引用完整性**——`element_id` 必须属于同项目且未回收，否则 422 `unknown_element`（存下去等于跑时炸在执行期，1B R48 的同一判断：把成本放在编辑时）。
  - `step_count` 保存时算（冗余计数）。
  - `ui_module_tree`/`create`/`update`/`delete`/`restore`/`purge`，路径 `/ui-modules`（第三棵树，R99）。删除模块**不删**元素（「模块是收纳方式，元素是资产」——1A §5.10 业主已认的口径），彻底删除时把 `module_id` 置 None。
  - `ui_case_references`（给元素引用检测与 T10 用；场景将来引用 UI 用例的计数在 T10 顺带扫 `step_graph`）。
- **本任务不做调试**（T9），做完只能 CRUD——可演示节点在 T9/T16。

- [ ] **Step 1: 写失败测试**：① 用例 CRUD + `steps` 原样往返（`inline_locator` 这种嵌套结构不许被吃掉）；② 空 `steps` → 422；③ `element_id` 指向不存在/已回收元素 → 422 `unknown_element`；④ `command_not_available` 的步（`upload`）保存 → 422 且 message 带批次；⑤ 模块树无限级 + 根层同名被服务层拦（**DB 唯一键管不住 NULL**，专测钉这条，照 1A 模块树那条测试）；⑥ 删模块 → 元素还在且 `module_id=None`；⑦ 列表 `used_by`/`last_run_*` 不查 run_record（用 `session` 计数或 assert 不触发额外 SELECT）；⑧ 回收的用例不出现在 `ui_element_refs` 计数里。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): ui case CRUD with element reference integrity + third module tree`

---

## 后端：执行面与读侧（T7-T12）

### Task 7: `execution/ui_core.py` —— Playwright 驱动器（1C 的心脏）

**Files:**
- Create: `backend/app/modules/execution/ui_core.py`
- Test: `backend/tests/test_ui_core.py`

**Interfaces:**
- Produces：
  ```python
  @dataclass
  class UiResult:
      ok: bool                     # 整案有没有「跑完」（发得出/浏览器起得来）
      passed: bool                 # 断言全过
      commands: list[dict]         # 每命令 {id,type,status,message,elapsed_ms,assertions,detail}
      vars: dict[str, str]         # save_var 产出
      error: str | None
      artifacts: list[dict]        # [{kind:"SCREENSHOT"|"DOM", blob:bytes, step_id, reason}]

  async def run_ui(commands: list[dict], *, elements: dict[str, dict],
                   variables: dict[str, str] | None = None, base_url: str | None = None,
                   headless: bool = True, browser_channel: str = "",
                   timeout_ms: int = 10_000, max_runtime_ms: int | None = None,
                   should_cancel: Callable[[], Awaitable[bool]] | None = None) -> UiResult
  ```
  **与 `run_api` 同层同风格**（`execution/core.py:71-72`：关键字参数 + 结构化结果 + 网络异常吸收成 `ok=False`，不抛穿）。
- **契约 4 铁律**：模块级**零 `app.modules.*` import**，且 `playwright` 在 `run_ui` 体内 import（R95）。`elements` 由调用方解析好传进来——驱动器**不认识数据库**（这是「资产在 `ui_test`、驱动在 `execution`」分层的实质，R94）。
- 命令→动作映射（19 种可跑，5 种 R101 已被保存期拦掉，但驱动器**仍要防御**：收到 `BLOCKED_1C` 里的 type → 该命令 `status="error"` + message 点名未开放，不 `KeyError`）：`open`→`page.goto`（相对路径拼 `base_url`）、`click`/`dblclick`/`hover`→locator 动作、`input`→`fill`、`clear`→`clear`、`select`→`select_option`、`key`→`press`、`scroll`→`mouse.wheel`/`scroll_into_view_if_needed`、`wait_element`→`wait_for_selector(state=...)`、`wait_text`→`wait_for_selector(":has-text(...)")`（前置取证 1 实测过这个选择器可用）、`sleep`→切片的 `asyncio.sleep`（**每 500ms 查 `should_cancel`**，照 `handlers.py:330-359` 的 `SLEEP_SLICE_MS` 语义）、`assert_text`/`assert_element`/`assert_title`→产 R108 那种断言行、`get_text`/`get_attr`/`js`→写 `save_var`（值 `str()` 化，承 1B `_stringify`）、`screenshot`→制品。
- 定位器解析：`id`→`#v`、`css`→原样、`xpath`→`xpath=v`、`name`→`[name=v]`、`text`→Playwright 文本引擎（`get_by_text` 的 selector 形式）。**解析失败要说人话**（`status="error"` + 「定位器 `xxx` 没找到，超时 10s」，而不是把 Playwright 的堆栈甩进报告）。
- 失败自动制品（§6.3 + D5）：任一命令 `fail`/`error` → 立即 `screenshot` + DOM 快照（`await page.content()`）各一条；整案结束再补 1 张终态截图。**上限 2 图 + 1 DOM/案**，超了不再截并写一条 message（`save_artifact` 无大小闸，前置取证 5）。
- 运行超时：`max_runtime_ms` 到点 → 剩余命令 `status="skip"` + 整案 `error="运行超时…"`，照 `runner.py:161-162` 的口径。

- [ ] **Step 1: 写失败测试**（用靶场 T1 那些 HTML 页，`http://127.0.0.1:<port>/ui/...`；**没有浏览器时整文件 skip 并打印原因**，不许静默绿——判据是启动一次真实 browser，失败就 skip 全部）：① `open` + `assert_title` 绿；② `input` 后 `get_text`/`save_var` 取回值、`UiResult.vars` 有它；③ 错口令 → `#err` 出 → `assert_text` 判 `fail`（**不是 error**：断言没过 vs 没跑成，1B 的橙/红分色同源）；④ `wait_element` 对 `#late-row` 在 5s 内绿、timeout=500 时 error 且 message 含「超时」；⑤ 缺元素 → `error` 不 `fail`；⑥ 失败自动产 `SCREENSHOT`（>1000 字节）+ `DOM` 两件制品；⑦ `both` 类畸形输入（`elements` 里没这个 id）→ `error` 且不抛；⑧ `should_cancel` 返回 True 时 `sleep` 在 1s 内停下；⑨ 未开放 type → `error` 带批次；⑩ **契约 4 源码扫描**：读 `ui_core.py` 源码，断言无 `from app.modules` / `import app.modules`，且 `import playwright` 不在模块顶层（照 `test_engine_runner.py:433-439` 的扫描手法）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（首次会要浏览器：`python -m playwright install chromium`；前置取证 2 说 revision 与前端那份配对）→ **Step 5: Commit** `feat(1c): async playwright driver in execution/ui_core (asset-agnostic, contract-4 clean)`

### Task 8: 制品能当图片看（扩展名 + content-type + 内联）

**Files:**
- Modify: `backend/app/modules/execution/artifacts.py`（`_sniff_type` :91-104、`save_artifact` 扩展名 :122）
- Test: `backend/tests/test_artifacts.py`（扩既有文件，别新开——它是 §8.8 六判据的家）

**Interfaces:**
- Produces：`_sniff_type` 加**魔数嗅探**：`\x89PNG\r\n\x1a\n`→`image/png`、`\xff\xd8\xff`→`image/jpeg`、`GIF8`→`image/gif`、`RIFF....WEBP`→`image/webp`；`save_artifact` 扩展名跟着变（`.png`/`.jpg`/`.gif`/`.webp`），非图片仍走原 `.json`/`.bin` 逻辑（**1A/1B 的行为零变化**，老制品下载不受影响）。
- 下载端点**不改路径不改权限**（仍是 `GET /artifacts/{run_id}/{name}`、`perm="api:run:read"`）；改的只是 media_type 正确了，浏览器才肯内联。

- [ ] **Step 1: 写失败测试**：① 存一段 PNG 字节 → `ref` 以 `.png` 结尾、下载回来 `content-type: image/png` 且**字节逐字相等**；② JSON 文本仍是 `.json` + `application/json`（**回归钉**）；③ 中文日志文本仍是 `.bin` + `text/plain`；④ 随机二进制仍是 `.bin` + `octet-stream`；⑤ 越界 `ref` 仍 400 `bad_ref`（§8.8 三判据不许被这次改动弄坏）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `fix(artifacts): sniff image magic numbers so screenshots render inline`

### Task 9: `ui_case_resolve` + 独立用例调试/执行端点

**Files:**
- Create: `backend/app/modules/ui_test/debug_services.py`
- Modify: `backend/app/modules/execution/services.py`（`new_run` 复用即可，预期零改动）、`app/modules/execution/models.py:20`（`subject_type` 注释补 `ui_case(1C)`）
- Test: `backend/tests/test_ui_debug.py`

**Interfaces:**
- Produces：
  - `ui_case_resolve`（perm `ui:case:read`，effect read，`http=None`，`tool=False`，`resident=False`）入 `{project_id, case_id}` → `{case_id, case_name, priority, env_id, env_name, commands: list, elements: dict[id→{name,locator_type,locator}], variables: dict, base_url: str|None, executable: bool, reason: str|None}`。与 `api_case_resolve`（`api_test/case_services.py:563-568`）**一对一镜像**：不可执行时回 `executable=False` + `reason`，**不 422**（`schemas.py:303-305` 的既有口径——「跑不了」是数据事实不是请求非法）。变量解析走 `REGISTRY.get("env_resolve")`（`env/services.py:192-206`，返回全局⊕环境合并结果），**不 import `app.modules.env`**。
  - `ui_case_debug` POST `/ui-cases/{case_id}/debug`（perm `ui:case:debug`，effect write）→ **进程内跑**（与 1A `api_debug` 同档，不投 worker），落 `run_record(subject_type="ui_case", trigger="debug")` + 每命令一行 `run_step_result`（R102）+ 制品走 `save_artifact`。返回 `DebugResult` 形状的载荷给 `DebugPanel`。
  - `ui_case_run` POST `/ui-cases/{case_id}/run`（perm `ui:case:run`）→ 投 worker（`trigger="manual"`），复用 `orchestration.enqueue` 的**按名字投递**路子（R42：web 侧不 import 引擎）。**worker 任务体复用同一个 `run_ui`**，`trigger` 是唯一差别。
  - `subject_type="ui_case"` 的 `summary_graph` = 单节点图（R102）。
  - 并发闸：**按事件循环各持一个** `asyncio.Semaphore(get_settings().ui_concurrency)`，用 `WeakKeyDictionary` 以 `get_running_loop()` 为键缓存（默认 4）。原计划写的「进程级模块信号量」经实测是**缺陷**（`backend/.venv/Scripts/python.exe -I`，Python 3.12.9）：模块级信号量一旦在某个 loop 上留下等待者，下一个 `asyncio.run` 就 `RuntimeError: ... is bound to a different event loop`——不受争用的 acquire/release 能跨 loop 存活，所以这条**只在真的并发时炸**，正好是产线路径。而 `worker.py` 的任务体本就是「每个 Celery 任务一次 `asyncio.run`」、`--pool=solo` 又在同一进程里跑很多任务，等于第一个任务之后全炸；前置取证 6 只验过「同进程连续 5 个 loop 无进程堆积」，从未跨 loop 争用过锁，所以它挡不住这条。缓存必须弱引用（普通 dict 会把每个 loop 的信号量漏留一整个进程生命周期）。语义仍是「每进程每循环限并发」，且 `--pool=solo` 一次只有一个 loop，所以默认 4 是有效默认——这句要照实写进注释和手册，**跨进程不共享**。回归测试要专门钉「两个重叠批次跨两次 `asyncio.run`」：不这样修就以 loop 绑定 RuntimeError 红掉，防止后人「简化」回模块级信号量。

- [ ] **Step 1: 写失败测试**：① resolve 一个正常用例 → `executable=True`、`elements` 带定位器、`base_url` 来自环境；② 用例被回收 → 404；③ 元素被回收 → `executable=False` + reason 点名是哪个元素（**不是 422、不是静默忽略**）；④ 跨项目 case_id → 404；⑤ `ui_case_debug` 跑通 → 库里 `run_record.status="passed"`、`run_step_result` 行数 == 命令数、制品表有 `SCREENSHOT`（失败用例才有）；⑥ `trigger="debug"` 的这条**不进报告中心**（`report_list` 默认过滤 debug，`report_services.py:178-180`）但**进运行记录**；⑦ `ui_case_purge`/`ui_case_resolve` 不在工具面；⑧ 只读成员 debug → 403；⑨ `run_record.subject_type == "ui_case"` 时 `report_get` 仍完整可读（详情不炸）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): ui_case resolve exit + in-process debug and worker-run endpoints`

### Task 10: 场景 `ui_case` 步骤真的能跑（R111 七处之五）

**Files:**
- Modify: `backend/app/modules/scenario/engine/handlers.py`（:54 `PENDING_KINDS` 摘 `ui_case`、:802-817 加 `h_ui_case`）、`app/modules/scenario/graph.py:23`（`BLOCKED_1B` 摘 `ui_case`）、`app/modules/scenario/engine/runner.py:568-571`（`row_no` 的 kind 白名单）**不动**、`tests/test_engine_handlers.py:252-261`、`tests/test_scenario_graph.py:75-79`
- Test: 上述两文件 + `tests/test_scenario_run.py` 加用例

**Interfaces:**
- Produces：`h_ui_case(node, ctx, *, run_children, in_loop, run_lists)`——照 `h_api_case`（:292-324）的骨架：`ref` 空 → error；无 actor → error 且文案点名「场景归属人」（`:300-305` 同口径）；经 `REGISTRY.get("ui_case_resolve")` 取（**不 import `ui_test`**）；`executable=False` → error 带 reason；调 `execution.ui_core.run_ui`；把 `UiResult` 折成 `StepOutcome`：断言全过→`pass`，断言没过→`fail`，没跑成→`error`，`vars` 增量**返回**给 dispatch 合并（**不许直接写 `ctx.vars`**，`handlers.py:861-863` 的规矩，唯一例外是 foreach）。
- `detail` 走 `_detail()`（:107-121）再塞 UI 专属键：`detail["commands"] = 命令明细`、`detail["artifacts"] = 制品摘要`。**`detail["response"]` 也要有**——`runner.py:608-612` 的单步重跑靠它重建上游响应，缺了会退到 `_fallback_response` 去找邻居步骤（对 UI 步没意义）。折中：`response = {"status": None, "body": <终态 DOM 摘要或 None>}`，并在注释写明「UI 步没有 HTTP 响应，这里放的是占位，不是假状态码」。
- 制品：在 runner 的 persist 路径里，把 `detail["artifacts"]` 的 blob 经 `save_artifact(db, kind="SCREENSHOT"/"DOM", step_key=...)` 落盘（`save_artifact` 的 `kind` 无枚举校验，实测 `artifacts.py:114-127`；`RunArtifact.kind` 注释里 `SCREENSHOT` 本就列着）。
- **`adb_case` 保持被拦**：两个键成对出现在 4 处，改的时候手一抖就一起删了——留一条测试专钉 `PENDING_KINDS == {"adb_case": "1D"}`（**改钉成只剩 adb_case**）。

- [ ] **Step 1: 改写测试（先让它红）**：① `test_engine_handlers.py:252-261` 从「ui_case 判 error 带 1C」翻成「ui_case 走 handler」，并新增 `PENDING_KINDS == {"adb_case": "1D"}` 与 `set(HANDLERS) == {14 kinds}`（现在钉的是 13）；② `test_scenario_graph.py:75-79` 翻成「ui_case 保存零 issue」，`adb_case` 仍 `kind_not_available` 带 1D；③ `test_engine_runner.py:433-439` 的源码扫描扩到 `handlers.py` 并把禁词加 `ui_test`；④ 新用例：一个 `api_case → ui_case → api_case` 的场景 inline 跑通，**UI 步的 save_var 被后面的 API 步用上**（这就是 D1 推荐范围的最小混合证据）；⑤ UI 步失败 → 整场 `failed`（不是 error）；⑥ UI 步的截图出现在 `report_get` 的 `artifacts` 里且 `step_key` 对得上；⑦ 对 UI 步发 `rerun-step` 且带 `row_no` → 400（`runner.py:568-571` 现状正确，钉住它别被顺手改坏）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿（含 1B 全量回归：pytest 445 基线一条不许变红；`ui_case` 语义变了的那 3 条测试是**改钉**，不是删）** → **Step 5: Commit** `feat(1c): scenario ui_case step executes via playwright driver (unblocks the 1B slot)`

### Task 11: 运行记录与报告中心诚实接纳 UI 运行（R112 + R107）

**Files:**
- Modify: `backend/app/modules/execution/services.py`（`run_list` 加可选 `subject_type`）、`app/modules/execution/report_services.py`（`report_list` 同）、`web/src/shared/runVocab.ts`、`web/src/pages/runs.tsx:105`、`web/src/pages/reportDetail.tsx:361-364`、`web/src/api/report.ts`
- Create: `web/src/shared/artifactSrc.ts`
- Test: `web/e2e/runs.spec.mjs` 扩、`web/e2e/reports.spec.mjs` 扩、后端 `tests/test_execution_api.py` / `test_report_center.py` 扩

**Interfaces:**
- Produces：
  - 后端 `run_list` / `report_list` 各加一个可选 `subject_type` 筛选（`pattern="^(api_definition|api_case|scenario|ui_case)$"`，非法值 422）。现状实测**没有任何** `subject_type` 的 where，所以 UI 运行会**出现在列表里却筛不出来**——这不是假设，是缺的那一个条件。
  - 前端 `runVocab.ts` 加 `SUBJECT_TYPES: Record<string,{label,color}>` = `api_definition→接口 / api_case→用例 / scenario→场景 / ui_case→UI 用例`，**替换 `runs.tsx:105` 那个二值三元**（实测就是 `r.subject_type === "api_case" ? "用例" : "接口"`，UI 运行会被贴成「接口」，那是主动说错）。查不到的值**渲染原文**，绝不回落成「接口」。
  - `shared/artifactSrc.ts`：`fetchArtifactBlob(runId, name, opts) → Promise<string /* objectURL */>`，走 `api/client.ts` 的 transport（带 `Authorization`），调用方负责 `revokeObjectURL`。**不给制品加签名 URL**（R107）。
  - `reportDetail.tsx:361-364` 那个裸 `<a target="_blank">` 按 `kind` 分流：`SCREENSHOT` → `<img>`（可点开原图）；其余仍是链接但走同一个带鉴权 fetch。

- [ ] **Step 0（先实测，不许跳过）：把「1B 的制品链接到底能不能打开」跑成事实**。起后端 + `vite preview`（1B 手册 §4），拿一条真有制品的 run，用**不带 header** 的 `curl -i` 打那个 href → 记状态码；再带 token 打一次。**只有实测确认 401 才改鉴权**（若居然能通，说明我漏了一条鉴权路径，那就把真实机制写进前置取证 5 再继续）。**测完回写前置取证 5，把「推断」两字去掉或改成事实**。
- [ ] **Step 1: 写失败测试**：后端 ① `run_list(subject_type="ui_case")` 只回 UI 运行；② `report_list` 同；③ 非法值 422。前端 e2e ④ 造一条 `ui_case` 运行 → 运行记录那行的对象标签是「UI 用例」，**断言它不是「接口」**；⑤ 报告详情里 `SCREENSHOT` 渲染成 `<img>` 且 `naturalWidth > 0`（真解码成功，不是 src 拼错也绿）；⑥ 直插一条 `subject_type="xxx"` 的运行 → 标签渲染 `xxx`，不是「接口」。
- [ ] **Step 2: 跑红**（④⑥ 现在必红——⑥ 红就是 R112 那个缺陷的复现）→ **Step 3: 实现** → **Step 4: 跑绿 + `runs.spec` / `reports.spec` 整套回归**（这两页是 1A/1B 已交付面）→ **Step 5: Commit** `fix(1c): run/report lists know ui_case; screenshots fetch with auth and render inline`

### Task 12: Ctrl+K 补两组（§11.4.19 / R109）

**Files:**
- Modify: `backend/app/modules/search/services.py`（`kind` 的 pattern、出参三组 → 五组）、`web/src/components/CommandPalette.tsx`（`Kind` / `GROUPS` / `goto()`）、`web/src/api/search.ts:15`
- Test: 后端 search 测试扩、`web/e2e/palette.spec.mjs` 扩

**Interfaces:**
- Produces：`kind` pattern 扩成 `^(definition|case|scenario|ui_element|ui_case)$`；出参加 `ui_elements` / `ui_cases`；`GROUPS` 加「元素」「UI 用例」；`goto()` 加两条落点（元素 → `#/ui/elements?q=<id>`；UI 用例 → `#/ui/cases/<id>`，**它有独立详情页，落点比接口用例直接**）。
- **四处必须同时改**（后端 pattern / 后端出参 / 前端 `Kind`+`GROUPS` / 前端 `goto`）。`search.ts:15` 那个 `kind?: "definition"|"case"|"scenario"` 联合类型是第五处隐性窄化——漏改它 TS 先报错，这是好事，**别用 `as any` 绕**。`goto()` 落到 `return null` = Enter 没反应且**不报错**，正是「搜得到但点不动」的静默失效形状。

- [ ] **Step 1: 写失败测试**：① 搜元素名 → 元素组命中、Enter 落元素库并高亮；② 搜 UI 用例名 → 命中、Enter 落它自己的详情页；③ 某组没命中时**那一组自己**写「无匹配」（不是整屏空白）；④ 搜索请求失败仍是另一句话（1B §5.9 那条口径不许被新组稀释）；⑤ 既有断言 `palette.spec.mjs` 的计数是**按 `data-kind` 限定**的（实测 :44-56，且它故意不钉分组顺序），加组不该弄红它——**如果它红了说明有人把计数改成了全局**，那是回归，改回来而不是放宽断言。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): Ctrl+K finds elements and UI cases (four registration points together)`

---

## 前端（T13-T20）

### Task 13: 前端地基 —— api 客户端 + 路由 + 导航解禁（必须同一个 commit）

**Files:**
- Create: `web/src/api/ui.ts`
- Modify: `web/src/app.tsx`（路由 children）、`web/src/layout/shell.tsx:57-58`、`web/e2e/nav.spec.mjs`
- Test: 上述 spec

**Interfaces:**
- Produces：
  - `api/ui.ts` 照 `api/scene.ts` 的**混合类型口径**（入参类型直引生成的 `schema.d.ts`，后端字段一改就编译报错；出参 `Page[XxxOut]` 手写镜像，因为生成物里 GET 响应是 `unknown`）。
  - 路由三条：`ui/elements`、`ui/cases`、`ui/cases/:id`。**详情页 lazy**（它静态引入 Monaco；`app.tsx` 的既有规矩是「拉 monaco/xyflow 的一律 lazy」，monaco chunk 4.5MB 不随首屏出货），两个列表页 eager。
  - 导航解禁：`shell.tsx:57-58` 补 `to: "/ui/elements"` / `to: "/ui/cases"` 并**删掉 `note`**。`:96-100` 的 `ROUTES` 与 `:156` 的 `disabled: !l.to` 都是派生的，**不用改别的**（`to` 有无就是门禁本身）。
- **解禁与页面同 commit**：先解禁再补页面会留一个「点进去白屏」的窗口，那就是假按钮（§13 纪律 1）。本任务只解禁到 T14/T17 已存在的**骨架页**，完整功能在 T14/T17 填。

- [ ] **Step 1: 先改两条既有 e2e（让它红）**：`nav.spec.mjs:50-53` 那条「点了不跳」把 `nav-ui-elements` 换成**仍然禁用**的 `nav-adb-devices`（1D 还关着，诚实断言继续有效），并新增「点 UI 元素库 → URL 是 `#/ui/elements` → `page-ui-elements` 可见 → `.tp-page-title` 是「元素库」」；`:78` 的 `expectNote("nav-ui-elements","1C")` **删掉**（Tooltip 不再存在，留着必超时），`:56-58` 那段「这批文案只有 Tooltip 看得见」的注释跟着改——**注释和断言一起落后才叫诚实**。`nav-ui-cases` 现状没有任何断言（实测只有 `:52` / `:78` 碰 `ui-elements`），只需新增不需删。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（`.tp-page-title` 每页**恰好一个**——`nav.spec.mjs:44,47` 用的是 strict-mode `toHaveText`，多一个头就红）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): unlock UI test nav items with routes and typed api client`

### Task 14: 元素库页（§11.4.11 / §11.5.4）

**Files:**
- Create: `web/src/pages/uiElements.tsx`、`web/src/api/moduleTree.ts`
- Test: `web/e2e/uiElements.spec.mjs`

**Interfaces:**
- Produces：
  - `moduleTree.ts`：把 `flatten` / `subtreeIds` 从 `pages/api.tsx:40-56` 与 `pages/scenes.tsx:38-54` 这两份**逐字重复**里抽出来共用（第三份不再复制）。这是 R99 落地点，纯搬移 + 两处改 import，**不改行为**（既有 e2e 全绿就是搬对了的证据）。
  - 元素库页：`PageHead title="元素库"` + 根 testid `page-ui-elements` + `ProjectGate`（三样是页面契约，`scenes.tsx:2-3` 写的）。左树复用 `ModuleTree`，传 `apiBase="/ui-modules" allLabel="全部元素" noun="元素"`（props 实测已参数化，**零改动复用**）。表格五列 = 名称 | 定位方式（徽标）| 表达式（省略 + hover 复制）| **关联用例数** | 更新时间；`+ 新建元素` 快速弹窗（名称 / 类型▾ / 表达式 / 备注）；回收站开关复用 ModuleTree 底部那个；**删除弹引用检测列表**（409 的 `details.cases` 直接列出来 + 「先解引用再来」，R106）。
  - 空态三分支照 `scenes.tsx`（回收站空 / 有行但筛空 / 真没数据），文案各不同——「没有匹配」和「还没有」是两句话。
  - 按钮按权限**隐藏不是禁用**（`settings.spec.mjs` 钉的手感：「写入口一个都不渲染」）：`can(perms,"ui:element:create")` 等，`perms = patternsForProject(project, user?.is_system_admin)`。

- [ ] **Step 1: 写失败测试**：① 建元素 → 行出现，定位方式是徽标、超长表达式省略；② 被引用的元素点删除 → 弹窗**列出引用它的用例名**且删不掉；③ 回收 → 回收站视图能恢复；④ 彻底删除要逐字输名（差一个字符按钮是灰的）；⑤ 只读成员 → **新建/删除按钮不在 DOM 里**（不是 disabled）；⑥ 建子模块、删模块后元素仍在且归「未分类」（后端语义的前端可见性）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿（含 `api.spec` / `scenes.spec` 回归，`moduleTree.ts` 是它们共用件）** → **Step 5: Commit** `feat(1c): element library page with reference-checked delete`

### Task 15: 命令列表编辑器内核（纯 TS，先测后画）

**Files:**
- Create: `web/src/ui/commands.ts`、`web/src/ui/commands.test.ts`
- Modify: `web/vitest.config.ts:8`（`include` 实测只有 `src/scene/**/*.test.ts` 与 `src/shared/**/*.test.ts`——**不加 `src/ui/**` 这个目录下的测试根本不会被跑，而且是静默不跑，不是报错**；文件头那段注释还写着「不碰组件（组件测试要 jsdom，那是另一个决定）」，本任务不推翻它：`commands.ts` 仍是纯模块，不需要 jsdom）
- Test: 同 Create 的 `.test.ts`

**Interfaces:**
- Produces（全纯函数、不可变、无 DOM，照 `scene/graphOps.ts` 的既有范式）：
  `COMMAND_TYPES`（24）、`BLOCKED_1C`（5，与后端 `commands.py` 同名单）、`ELEMENT_TYPES`（5）、`newCommand(type)`、`insertAfter`、`removeAt`、`move(list, from, toIndex)`、`duplicateAt(list, i) → [list, newCmd]`（新 id）、`updateAt`、`validateCommands(list) → Issue[]`、`summary(cmd, elementNames) → string`、`nextId(list)`。
- **`validateCommands` 与后端 `commands.py` 是同一套规则的两个实现**（1B 的 `graphOps.validateLocal` ↔ `graph.py` 就是这个格局，`graphOps.test.ts:383` 那句注释写着「与后端同源」）。同源靠**同一批用例表**钉：本任务的测试要把 T4 后端测试的每条 case 在 TS 里复述一遍，case 名对齐。
- `summary` 就是 §11.4.12 每行那句「命令名 + 关键参数摘要」的唯一前端真相。

- [ ] **Step 1: 写失败测试**（表驱动，~30 条）：不可变性（改完原数组逐字不变，照 `graphOps.test.ts` 那组）；`nextId` **不复用已删的 id**（复用会让历史 run 的步骤行指向错误的命令）；24 种 type 的 `summary` 各一条快照；`validateCommands` 与后端 case 表逐条对齐（含 5 种 `command_not_available` 的文案带批次）；`move` 到自身位置 = 无变化；空数组 → `empty_steps`。
- [ ] **Step 2: 跑红** → **Step 3: 实现 + 改 vitest include** → **Step 4: 跑绿并实跑 `pnpm test` 确认用例数真的涨了**（改了 include 但数字没变 = 路径没匹配上，这是静默失效）→ **Step 5: Commit** `feat(1c): pure command-list reducer core with backend-aligned validation (vitest scope widened)`

### Task 16: 参数表单 + 共用元素选择器（§11.4.12 展开区 / §11.4.13）

**Files:**
- Create: `web/src/ui/CommandParams.tsx`、`web/src/ui/ElementPicker.tsx`
- Test: `web/e2e/uiCase.spec.mjs`（本任务起才有可点的东西，e2e 从这里开始）

**Interfaces:**
- Produces：
  - `ElementPicker`（§11.4.13）：元素库搜索 + **最近使用**（`localStorage` 键 `tp_ui_recent_elements`，最近 8 个），底部 `[+ 就地新建元素]` **内联展开**新建弹窗（蓝图原文「内联展开 11.4.11 新建弹窗」——不是跳走）；选定回填 `element_id`。
  - 「就地定位」开关：切到 `inline_locator = {type, value}`，**与 `element_id` 互斥**（UI 做成二选一 Segmented，切一个就清另一个，**给不出两个都给**；后端 `both_locators` 仍是防线）。
  - `CommandParams`：按 type 动态切的参数表单（超时 / 结果存变量 / 失败继续 + 各 type 专属字段）。**`BLOCKED_1C` 那 5 种不进下拉**，或进去但 disabled + 写明未开放原因——**不给一个能选到、选了保存报错的选项**。
  - 需要「键值行」的地方（如 `js` 的参数）直接复用 `api/RequestEditor.tsx:44` 已导出的 `PairTable`（全通用，带 `idPrefix`），别再写一个。

- [ ] **Step 1: 写失败测试**：① 选元素 → 行摘要显示元素**名**而不是 id；② 就地定位 → 存 `inline_locator` 且 `element_id` 为 null（后端往返一次仍是如此）；③ 就地新建 → 建完**直接选中**并出现在元素库列表；④ 最近使用：用两次同一元素 → 第三次打开排第一；⑤ 未开放的 type（如「上传」）在下拉里 disabled 且有说明，点它不会保存。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): shared element picker with inline create and per-type parameter forms`

### Task 17: UI 用例页 + 调试面板（§11.4.12 / §11.5.4）

**Files:**
- Create: `web/src/pages/uiCases.tsx`、`web/src/pages/uiCaseDetail.tsx`、`web/src/ui/UiDebugPanel.tsx`
- Test: `web/e2e/uiCase.spec.mjs` 扩

**Interfaces:**
- Produces：
  - 列表页：§11.5.4 六列（名称 | 优先级 | 启用 | 最近结果 | 负责人 | 更新时间），testid `page-ui-cases`，根 + `PageHead` + `ProjectGate`。
  - 详情页 = **命令列表编辑器**：每行 = 启用勾选 + 序号 + 图标 + 命令名 + 摘要 + `···` 菜单（插入后 / 复制 / 粘贴 / 删除），**原生 HTML5 拖拽**（照 `scene/ListMode.tsx:185-198` 的手法，不引 dnd 库），**搜索/筛选态禁用拖拽**（`ListMode.tsx:185` 那句注释的理由：过滤后的行序不代表真实顺序，拖了会误导），行展开 `CommandParams`。顶部 = `EnvSelect`（实测 `api/EnvPanel.tsx:40` 的默认导出，`api.tsx:21` 就是这么引的）| 保存 | **调试**。
  - 调试面板（底部，§11.4.12 那个「300」）：逐步耗时 + 截图 + 控制台输出。**断言部分直接复用 `api/DebugPanel.tsx`**（R108 的行形状就是为这个），UI 专属的「命令时间线 + 截图」是它**旁边**多出来的块，不是替换；高度与拖拽手感照 `scene/DebugDrawer.tsx` 的既有 mechanic。图片走 T11 的 `fetchArtifactBlob`。
  - **跑的是屏幕上那份草稿**（1B §5.5 的调试语义：不保存也能试）。
  - 这里的复制粘贴是**页内命令剪贴板**（§11.4.12 那个「剪贴板: [粘贴(2)]」），不是系统剪贴板——全站只有一处用 `navigator.clipboard`，别混。

- [ ] **Step 1: 写失败测试**：① 建用例 → 加 4 条命令（打开 / 输入 / 点击 / 断言文本）→ 保存 → 刷新仍在、顺序不变；② 拖第 4 行到第 2 位 → 保存 → 库里 `steps` 顺序跟着变；③ **调试跑未保存草稿**（改了断言文本不保存直接调，结论按新的判）；④ 失败那条命令行**内联出截图**（`naturalWidth>0`）；⑤ `save_var` 存下的变量在下一步输入值里能用 `${var}` 引到；⑥ 只读成员：保存 / 调试按钮不渲染；⑦ 空命令列表保存被拒且界面说明为什么（后端 `empty_steps` 那句「空用例跑起来零步全绿是假绿」要显示出来）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): UI case list and command-list editor with debug panel`

### Task 18: 场景侧解禁（R111 前端三处）

**Files:**
- Modify: `web/src/scene/stepTypes.ts:17`（`BLOCKED_1B` 摘 `ui_case`）、`web/src/scene/AssetTree.tsx:78`（Tag 改可拖入）、`web/src/scene/graphOps.ts`（`ui_case` 的 config 口径：只要 `ref`）
- Test: `web/src/scene/graphOps.test.ts:387-393` 翻转、`web/e2e/sceneCanvas.spec.mjs:58-61` 翻转

**Interfaces:**
- Produces：`BLOCKED_1B = { adb_case: "1D" }`（实测这张表被 `graphOps.ts:596` 与 `Canvas.tsx:14,45,105` 共用，改一处三处好）；AssetTree 的「UI 用例」从 disabled + `1C 开放` Tag 变成**可拖入**（拖进去 = 插一个 `kind:"ui_case"`, `ref=<case_id>` 的节点）。右面板复用既有 `api_case` 那种「用例下拉 + 只读说明」形态（UI 用例的断言长在命令里，不在场景里，所以「断言」页同样是只读说明）。
- **`adb_case` 必须仍然被拦**，且专测钉住（R111：两个键成对出现在四处，最容易一起删）。

- [ ] **Step 1: 翻转测试（先红）**：`graphOps.test.ts:387-393` 从「ui_case → `kind_not_available`」改成「ui_case 零 issue（带 ref）；无 ref → `missing_ref`」，`adb_case` 那条**保持**；`sceneCanvas.spec.mjs:58-61` 从「可见但 disabled + 1C 开放」改成「可拖入 → 画布出节点 → 保存成功」；新增一条**混合场景**画布测试（api_case + ui_case 同场，保存零 issue）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(1c): scenario canvas accepts ui_case steps (adb stays honest about 1D)`

### Task 19: 报告详情里的 UI 步骤（复用现成三栏，不新开页面）

**Files:**
- Modify: `web/src/pages/reportDetail.tsx`（步骤详情按 kind 分流）
- Test: `web/e2e/reports.spec.mjs` 扩

**Interfaces:**
- Produces：`ui_case` 独立运行的报告 = 三栏照旧（概览环 / 步骤树 / 步骤详情）。**中间画布**只画单个 `ui_case` 节点（R102 的单节点 `summary_graph`），**这看起来会很空**——所以要说清「1 个顶层步骤 = 1 条 UI 用例，命令明细在右栏」（R102 的代价必须说出口，不能让业主以为是 bug）。右栏命令明细 = 命令时间线（逐条耗时/状态）+ 断言卡（复用 `DebugPanel` 渲染，R108）+ 制品（复用 T11 的 `fetchArtifactBlob`；制品过滤已按 `step_key` 走，`reportDetail.tsx:179`）。
- **不新开一套报告页**：`reportDetail.tsx` 按 `subject_type` 分流渲染。同一份数据两套渲染是 §13 纪律 1 明令禁止的形状（`runs.tsx:2-3` 那句「否则现场与档案给出两种结论」就是这条）。

- [ ] **Step 1: 写失败测试**：① 跑一条会失败的 UI 用例 → 报告中心能看到（`trigger=manual`）、通过率环与 stats 一致；② 详情右栏命令明细行数 == 命令数、失败那行有截图；③ 「1 个顶层步骤」那句说明**只出现在 UI 运行**上，API/场景运行上不出现（别把说明撒到所有报告）；④ 场景里的 `ui_case` 步骤在只读画布上按结果着色（橙=断言失败 / 红=没跑成，1B 的分色）；⑤ **资产删除后报告仍完整可读**（把用例彻底删掉再开报告——1B §5.8 的自包含承诺，UI 也要兑现）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿（`reports.spec` 整套回归）** → **Step 5: Commit** `feat(1c): report detail renders UI case runs through the same three-pane view`

### Task 20: 种子数据（可反复执行，只补缺）

**Files:**
- Modify: `backend/scripts/seed_demo.py`
- Test: `backend/tests/test_tool_surface_1c.py` 加种子段（照 `test_tool_surface_1b.py:166-202` 的「跑两遍」）

**Interfaces:**
- Produces：演示项目里加「UI 演示」模块（挂在元素库树根下）、**4 个元素**（登录页账号框 / 口令框 / 登录按钮 / 工作台标题，定位器全部指向靶场 T1 那两张 HTML 页）、**1 条 UI 用例**「演示：登录工作台」（打开 → 输入 → 输入 → 点击 → 断言文本「工作台」→ 一个 `wait_element` 演示慢元素）。全部走**公开服务**建（照 seed 现有做法），**不直插 DB**——种子必须和人手点出来走同一条路，否则「种出来的东西能跑」不代表「人能建出来」。
- 幂等：select-then-skip（照 seed 现有那句 `[seed] …已存在` 的打印形状）。

- [ ] **Step 1: 写失败测试**：跑 `main()` 两遍 → 元素恰好 4、UI 用例恰好 1、**其他任何资产计数不变**（照 `test_tool_surface_1b.py:189-198` 的断言形状）；第二遍打印「已存在」而不是重复建。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿 + 手工实跑一次 seed 后在 UI 里真跑一遍那条演示用例**（种子跑不过调试就是死种子）→ **Step 5: Commit** `feat(1c): demo elements and a demo UI case in the seed (idempotent)`

---

## 收尾（T21-T23）

### Task 21: 工具面 / 权限面 / 契约回归（1C 版）

**Files:**
- Modify: `backend/tests/test_tool_surface_1c.py`（补全六项，T3 只起了契约段）

**六项**（照 `test_tool_surface_1b.py:3-11` 的契约逐条对偶）：
① `NEW_TOOLS`：`ui_element_*` / `ui_case_*` / `ui_module_*` 出现在 admin 的 `GET /agent/tools`，并断言 `effect`（`..._run` / `..._debug` = write，`..._delete` = destructive）；② `NOT_TOOLS`：`ui_element_purge` / `ui_case_purge` / `ui_element_refs` / `ui_case_resolve` **必须缺席**（`:46-47` 那句「`tool=False` 的工具漏进了工具面」）；③ PLAN 门：`ToolDispatcher.call(mode="PLAN")` 拒 `ui_case_run`、放行 `ui_case_list`；④ perm 点同步：`ui:*` 全集在 `perm_point` 表里、`REGISTRY.perm_points() <= codes`、`await sync_perm_points(session) == 0`（幂等）；⑤ 只读双层：工具面不含写 + HTTP 层 403 而读端点 200；⑥ **契约成员**：直接解析 pyproject 断言 `ui_test` 在契约 1 与 3、且 `search` 仍不在契约 1（composition 层那两条反向钉要保住，`test_tool_surface_1b.py:127-128,140`）。

- [ ] **Step 1: 写测试**（先跑，缺哪个补哪个，**不许为了绿而放宽**）→ **Step 2: 补缺** → **Step 3: 实跑 `.venv/Scripts/lint-imports.exe` 逐字核对 `4 kept, 0 broken`** → **Step 4: Commit** `test(1c): tool surface, permission points and contract membership regressions`

### Task 22: 1C 金线 —— 一条链从头跑到尾

**Files:**
- Create: `backend/tests/test_golden_1c.py`

**链路**（照 `test_golden_1b.py` 的手法：全走 HTTP + inline 执行）：
建模块 → 建 4 元素 → 建 UI 用例（引用元素）→ **调试**（`trigger=debug`，报告中心看不到）→ **执行**（`trigger=manual`，报告中心看到）→ 报告详情读命令明细与制品 → **把用例加进场景当一个 `ui_case` 步骤** → 跑场景 → 混合报告（api_case + ui_case 同场）→ **彻底删除用例后报告仍完整** → 元素引用检测拦住删除 → 解引用后能删。
这条链就是 D1 推荐范围的**可执行版本**：它证明「独立可用 + 场景内可用 + 历史自包含」，同时把混合 DoD 留给 1D（本文件不写「混合场景完成」这种话）。

- [ ] **Step 1: 写测试**（真实浏览器；无浏览器时 **skip 并打印原因**，用 1B 那种「大声跳过，绝不静默」的口径）→ **Step 2: 跑通** → **Step 3: Commit** `test(1c): golden path from element library to mixed scenario run`

### Task 23: 六道门禁 + 1C 演示手册 + ledger + tag

**Files:**
- Create: `docs/superpowers/plans/README-1c-demo.md`
- Modify: `README.md`（§门禁段）、`README-1a-demo.md` §9 与 `README-1b-demo.md` §8 的「未开放」清单（元素库 / UI 用例已从「1C 未开放」变成交付——**手册落后于代码也是不诚实**，1A 手册 :352-354 记过这个教训）、`.github/workflows/ci.yml`（后端 job 补 `playwright install chromium`；实跑发现 CI 的 `ruff check app scripts tests` 与 README 写的 `app tests migrations scripts` 口径不一致，顺手对齐）
- Test: 六道门禁全跑

**手册要求**（1B 的教训：手册的错只能在真浏览器里量出来）：
- 逐节 §5.1-§5.x **业主照着点一遍**，每节末尾写「你会看到」判据。对不上的**当场改手册或改代码**，不留「以后再对」。
- §0-§4 复用 1B（含 §1 Windows 保留端口、§4.2b 必须起 worker、`--host 127.0.0.1` 不能省）。
- **新增 §4.4「装浏览器」**：`python -m playwright install chromium`；写清版本配对（R97）与离线退路 `TP_UI_BROWSER_CHANNEL=chrome`（前置取证 3）。
- 诚实边界必须写：那 5 种命令未开放且**为什么**（R101 / D1）；无头 only（D4）；命令行不可单步重跑且**为什么**（R103）；「步骤」列显示 1 的口径（R102）；元素不做环境覆盖（D3）。
- 门禁表填**本轮实跑数字**（要么是真数字，要么写明是哪一轮的）。

- [ ] **Step 1: 六道门禁实跑**并记录：`pytest -q` / `ruff check app tests migrations scripts` / `.venv/Scripts/lint-imports.exe` / `pnpm build` + `pnpm build:e2e` / `pnpm exec playwright test` / `python scripts/migrate_dev.py`（0017 → **0018**）。
- [ ] **Step 2: 手册逐节真走**（脚本化驱动或手点都行，但要留下「这一节我看见了 X」的记录）。**e2e 服务的是 `dist/`，改过源码必须 `pnpm build:e2e`**——「改了源码跑 e2e 还是绿」这个假通过 1B 期间踩过两次；守卫手法：`grep -rl <新 testid> dist/assets/` 有命中再跑。
- [ ] **Step 3: ledger 追加 R94-R112**（按 R### 递增，数字不许跳）。
- [ ] **Step 4: 演示库回收走查残留**（走查期间建的元素 / 用例要么删干净、要么就是种子）。
- [ ] **Step 5: 打轻量 tag `1c-ui-testing`**，`git show --stat HEAD` 核对提交面（共享工作树规矩：`git commit -F - -- <精确路径>`，**永不 `--amend` / `reset` / `checkout --`**）。

---

## 完成判据（= §13「1C」条目逐条）

1. **元素库可用**：五类定位器、模块树、关联用例数、**删除有引用检测**（409 点名用例）、回收站三件套 + 逐字输名彻底删除。
2. **UI 用例可用**：§7.2 命令协议可存可校验；命令列表编辑器（行摘要 + 展开参数 + 拖拽 + 复制粘贴 + 就地定位）；元素选择器弹窗含最近使用与就地新建。
3. **Playwright 执行是真的**：默认无头、信号量限并发、逐步耗时、**失败自动截图 + DOM 快照**，截图在调试面板与报告里**能内联看见**（不是只能下载）。
4. **1B 的插槽真的插上**：场景里 `ui_case` 步骤**保存能过、执行能跑**（`PENDING_KINDS` / `BLOCKED_1B` 前后端四处一起摘，`adb_case` 仍诚实指向 1D）；UI 步的 `save_var` 能被后续步骤用上（T10 测试 ④）。
5. **报告自包含继续兑现**：UI 运行进报告中心，资产彻底删除后报告仍完整可读（1B §5.8 的承诺对 UI 同样成立）。
6. **Ctrl+K 找得到元素与 UI 用例**，Enter 有落点（四处注册点同改）。
7. **导航没有假按钮**：UI 两项解禁即真能用；未开放能力（录制器 / trace / 有头 / 版本历史 / 环境覆盖）**界面上不出现**。
8. **六道门禁全绿并把数字写进手册与 ledger**，其中 `lint-imports` 必须逐字核对打印文字（`ui_test` 已进两个契约清单，否则 kept 是假绿）。
9. **混合场景端到端 DoD 不在 1C 验收**（§13 明写 1D 末），但 1C 必须交出一条 API+UI 同场跑通的金线（T22）——「不在验收」不等于「没跑过」。

## 不做清单（1C 明确不做，别顺手做，也别假装做了）

- ADB 设备与用例（1D）、混合场景端到端 DoD（1D 末）、设备选择器组件（1D）。
- 录制器（§6.3 明写二期：Playwright codegen 半自动包草稿）；trace.zip（§6.3 明写二期开关）。
- `upload` / `download` / `switch_frame` / `switch_window` / `dialog_accept` 五种命令（R101，待裁决 D1）；第 6 种定位器（待裁决 D2）。
- 元素按环境覆盖（R105，待裁决 D3）；元素 / 用例的版本历史（1B 先例：不给假「查看历史」按钮）。
- 有头模式界面入口（D4）；跨项目复制 UI 用例（二期）。
- UI 命令单步重跑（R103，做不到就说做不到，不给假按钮）。
- UI 用例数据集驱动（1A 的数据集只服务接口用例；UI 要参数化是「命令里引变量」，已够）。
- 视觉回归 / 截图比对 / 元素自愈——蓝图里没有，一句都不承诺。

## 风险登记（实现时最可能翻车的地方）

| # | 风险 | 缓解 | 兜底 |
|---|------|------|------|
| 1 | **机器装不上 chromium**（离线 / 公司网 / 代理） | 前置取证 3 实测 `channel="chrome"/"msedge"` 可用（Chrome 157 / Edge 157） | 配 `TP_UI_BROWSER_CHANNEL`，手册专节写清 |
| 2 | **前后端浏览器版本不配对** → CI 下两份、业主机器跑不起来 | R97 把两份 `browsers.json` 的 revision 相等钉成测试（T1），并 pin 死 `==1.65.2` | 配对测试红就**改 pin 不改 CI**（改 CI 等于默认两份，问题回到业主机器） |
| 3 | **e2e 里跑真浏览器拖慢/搞不稳门禁**（`workers=1` 已经够慢） | 后端金线用 `skip` + 打印；e2e 只在 `uiCase.spec` 跑**一条**真浏览器链，其余用假驱动注入（`run_ui` 的元素解析 / `should_cancel` 可注入） | 真浏览器用例单独 job；**不许**把 skip 当通过 |
| 4 | **Playwright 与 `--pool=solo` 的并发** | 前置取证 6 实测同进程连续 5 个 loop 可行、无进程堆积 → 不需要浏览器池；信号量默认 4 | 退 `ui_concurrency=1`（配置项，不是改代码），手册写明性能影响 |
| 5 | **制品目录被截图撑爆**（`save_artifact` 无大小闸，前置取证 5） | D5 限 2 图 + 1 DOM/案；T8 只加嗅探不加闸 | 加 `ui_artifact_max_bytes`，超限时明确报「截图已省略」，**不许静默不截** |
| 6 | **选择器脆断**（靶场页面一改 e2e 全红） | 靶场 HTML 用**稳定 testid**，不依赖样式类；演示元素只用 id / name | 靶场页面是**我们的**，改它合法；元素库跟着改，不留两套 |
| 7 | **R111 的七处解禁漏一处 → 「一半开放」** | T10 / T18 把每处的测试**从钉住被拦翻成钉住可跑**，`adb_case` 反向钉 | 缺一处就有一条红，不会静默 |
| 8 | **改 `runs.tsx` / `reportDetail.tsx` 弄红 1A/1B 已交付面** | T11 / T19 要求整套回归 `runs.spec` / `reports.spec`，新增断言只针对 `ui_case` | 既有断言变红 = 我方回归，**改回来而不是放宽断言** |
| 9 | **`ui:*` 权限词表与 `READONLY` 的 `*:read` 后缀 glob 不合**（只读成员看不见读面） | Global Constraints 钉死「读类 perm 必须以 `:read` 结尾」；T21 ④⑤ 双层验 | T21 的 403 / 200 双测就是防线 |
| 10 | **vitest include 漏改 → TS 内核测试静默不跑** | T15 Step 4 明写「跑 `pnpm test` 确认用例数真的涨了」 | 数字没变就是没跑上，回去查路径 |
| 11 | **`@service` 五向扇出漏一面**（有 HTTP 没工具 / 有工具没 perm 点） | T3 的契约测试 + T21 的六项；`REGISTRY.perm_points() <= codes` 与 `sync_perm_points()==0` 是网 | 漏的那一面在 T21 里必红，不会静默 |

## 执行顺序与并行度

- **后端串行为主**（同仓库同文件）：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12。
- **前端链**：T13 → (T14 ∥ T15) → T16 → T17 → T18 → T19。T15（纯 TS 内核，只依赖 T4 的规则表）与 T14（元素库页，只依赖 T5）是**唯一稳的两股并行**。
- **适合分派给子 agent 的独立股**（互不碰同一文件）：① T4 + T15（协议双实现、规则表同源，**同一个 agent 做两边才不会漂**）；② T7（驱动器，纯后端新文件）；③ T12（Ctrl+K，四个文件独立）；④ T8（制品嗅探，独立）。
- **不可并行**：T2 / T3（迁移与 pyproject 是全局单点）、T10（改引擎，与所有引擎测试纠缠）、T11 / T19（改同一批已交付页面）、T23（门禁必须串行独占）。
- 每任务独立 commit；可演示节点（T7 驱动器跑通、T9 独立调试、T10 场景内跑通、T17 编辑器）各打轻量 tag；**迁移必带能跑的 down**（§13 纪律 3）。

---

## 计划 vs 现实（执行期收集的偏差台账，T23 收尾要逐条消化）

每条都是执行 agent 实测后报上来、主线核过的。**改钉不藏**：产品与计划不一致时，
先证明现实是什么，再决定是钉现实还是改产品——「测试改成能过」不算处理。

- **T14 → 缺陷已修**：计划写的 `web/src/api/moduleTree.ts` 落不了地（Windows 大小写
  不敏感 FS 与 `api/ModuleTree.tsx` 撞名，tsc TS1149），实际在 `web/src/shared/`。
  同任务撞出 `ModuleTree` 回执缺陷（UI 树 `detached_elements` 被链式取值漏掉 →
  成功提示说错话），已修并钉（e82ae56）。**遗留已裁**（见 R120）：搬来的 `subtreeIds`
  其实不收集子孙，函数名与「含子模块」文案都超出实际行为——裁「改字不改行为」，
  改名 `ownModuleIds` + 三页文案落「选中模块」+ 反向钉，不动已交付的筛选行为。
- **T16 → 偏离**：计划说 js 参数用 PairTable 键值行，但 T7-T10 执行核没有任何命令
  消费键值参数（`js` 就一个 `page.evaluate(input)`），挂个没人读的表是纪律 1 的
  假控件——**不做**，`CommandParams.tsx` 头注释备案；js 真带参数了再裁（5d4d073）。
  类型/元素下拉加可搜索（24 项虚拟列表不搜没法用，e2e 靠它点到第 20 项）。
- **T17 → 最大的语义偏离**：计划写「调试跑屏幕上那份草稿」（1B §5.5），但
  `UiCaseDebugIn` 实测只有 `{project_id, case_id}`（`debug_services.py:470`）——
  调试跑的是**已保存**序列。前端做法：脏草稿先存再调 + 面板与 toast 都写明
  「本次发起前已代为保存」，e2e ③ 钉语义；后端若将来收草稿，这条塌回一个请求字段。
  另两处不做：行「启用勾选」（ui_core 无逐命令禁用语义）、「控制台输出」块
  （执行核不采 `page.on("console")`），都是假控件不做（a066d83）。
- **T20 → 原型缺陷**：`test_tool_surface_1b.py` 的跑两遍模式两遍读的是同一份
  脏快照（staleness），1C 种子测试加了 rollback-before-reread 比原型严；
  **1b 那份要不要同步收紧，T23 裁** → **T23 已裁：收紧**，并把「为什么原型的读法是假证明」用一次性探针实测坐实（R128）。
- **T22 → 两种 step_key 形态**：独立 UI 运行的制品 `step_key` 是**命令 id**
  （终图挂 `u7`，`_execute_ui_run` 按 step_id 存），场景内运行才挂画布步骤 key。
  两种都是产品真实承诺（T9 测试早就钉过独立形态），金线分两支钉；
  **T19 报告页展示独立运行截图时必须按命令 id 对行**（cf4fe5f）。
- **计划文本错误 ×2**：T11 点名的 `tests/test_execution_api.py` 不存在
  （run-list 测试在 `test_run_record_v2.py`）；R111 点名的 `AssetTree.tsx` 在
  `web/src/scene/` 不在 `web/src/api/`。执行时都按现实走了。
- **环境事实（省后人一小时）**：dev 库 `testpilot` 里制品为零——制品在
  `testpilot_e2e` schema；e2e 跑过之后 admin 密码会被改掉（用 dev `TP_SECRET_KEY`
  自签 token 是只读取证的可行路）；antd Select 虚拟列表，24+ 项必须搜索过滤才点到。
- **流程事故（记给我自己的）**：① 一次把已完成任务当新任务重派（T11，压缩后台账
  断片——commit 是 `07dcb46`，比记忆更早），执行 agent 以「已交付，给独立复验而非
  造假红」正确收场；② 两次把「工作区出现改动」误读成「agent 已交报告」——**交报告
  的只有 task notification，文件出现在 git status 不是**；③ 两个 agent 各报过一次
  不存在的 prompt-injection（R89 同族，主线 grep 均为 0 命中）——纪律有效：
  拒绝 + 上报 + 复验，且上报前必 grep。
- **T23 走查（真浏览器 + 真后端 + 真 worker，逐节留「我看见了 X」的记录）**：
  T1–T22 的界面口径全部在真 chromium 里过了一遍，量出的四条缺陷都已修并钉
  （R114 / R115 / R116 与 palette 的两条陈旧钉）。走查还确认了三件「不在界面上」
  的事：未开放能力（录制器 / trace.zip / 有头 / 版本历史 / 环境覆盖）在 `src/` 里
  **0 处出现**（完成判据 7）；5 种未开放命令**不进可插入清单**（`uiCaseDetail.tsx:37`
  的 `INSERTABLE` 把它们从 24 种里滤掉，添加下拉只剩 19 种，搜「上传」0 命中——R101/D1
  的界面兑现），它们的「禁用 + 写明批次」在**已存在命令的参数区类型下拉**里
  （`CommandParams.tsx` 用 `BLOCKED_1C` 渲染 disabled 项）；`调试` 运行默认不进报告中心
  （`include_debug` 默认关，勾上才出，触发列 `✎调试`；本轮量到的 18 / 29 是这份演示库
  当下的行数，列表是游标分页，**手册里不写这两个数**，只写「默认过滤、开关可看」这个事实）。
  混合场景金线真人跑通：拖种子 UI 用例进 1B 演示场景副本 →
  本地预检零 issue → 保存 → 执行 7 步全绿（4276ms，`api_case` + 循环嵌套 + `ui_case`
  同场）→ 混合报告两种步骤同场。走查残留全部清干净（元素库回到种子 4 条、场景
  回到 1 条、副本走「回收 → 逐字输名彻底删除」），顺带把回收站三件套与引用拦截
  （409 点名「工作台标题」被第 5 步用着）演了一遍。
- **我自己的两处提交信息不实，写在这里更正（`51c89c2` 不改写，共享工作树不动
  历史）**：① 那条写「共 +9 用例」，实际是 **+13**（`debugRows.test.ts` 从 11 例
  到 24 例）；② 那条说改法是「与上一版 `stepTreeLabel` 同一条理由」，读起来像
  `stepTreeLabel` 早已提交——实际它**就在这同一个 commit 里**第一次落地（`git show
  51c89c2~1` 里搜不到这个名字）。代码与门禁数字都是真的，不实的只是这两句叙述。
  规矩照旧：只有 git 是证据，我自己的记忆和自述都不是。

