# TestPilot

面向 API / UI / 设备的 AI 测试平台：把「接口 → 用例 → 场景 → 执行 → 报告」这条链
做成可反复执行、可追责、可被 AI（Pilot）调用的资产，而不是每个人手里一套脚本。

- 设计蓝图：[`docs/2026-11-13-ai-test-platform-design.md`](docs/2026-11-13-ai-test-platform-design.md)
- 能亲手跑起来的演示手册：[S0（金线：五路同生 + Pilot 回放）](docs/superpowers/plans/README-s0-demo.md)、
  [1A（接口与用例）](docs/superpowers/plans/README-1a-demo.md)、
  [1B（场景编排与执行）](docs/superpowers/plans/README-1b-demo.md)、
  [1C（元素库与 UI 用例）](docs/superpowers/plans/README-1c-demo.md)、
  [1D（ADB 真机与混合场景）](docs/superpowers/plans/README-1d-demo.md)、
  [1E（定时任务/通知/模型中心界面）](docs/superpowers/plans/README-1e-demo.md)、
  [1F（Pilot 候选卡片）](docs/superpowers/plans/README-1f-demo.md)
- 实施计划与验收判据：[`docs/superpowers/plans/`](docs/superpowers/plans/)

## 批次状态

菜单里灰着的项带开放批次标注，**不做假按钮**；下表与 `web/src/layout/shell.tsx` 同源。

| 批次 | 内容 | 状态 |
|------|------|------|
| 1A | 项目/成员/权限、项目全局配置与环境分层变量、模块树、接口定义、请求编辑器与真实调试、用例（继承+覆盖+数据集）、数据集、运行记录、Pilot 试验台（PLAN/ASK/FULL 三档 + 按权限过滤工具箱；**ASK 只到「挂出审批卡并挂起」，页面批准按钮属二期**）、审计、回收站与彻底删除 | 已交付 |
| 1B | 场景编排（画布+列表同源）、执行引擎（数据集行展开/超时/取消）、Celery worker 投递、SSE 实时进度与断线续传、报告中心（含只读结果画布、失败单步重跑）、场景级公共断言、Ctrl+K 全局查找 | 已交付 |
| **1C** | **元素库（5 种定位方式、引用检测硬拦、回收站三件套）、UI 用例（命令列表编辑器 + 元素选择器 + 就地新建）、真浏览器执行（无头 chromium，逐命令耗时与截图）、UI 运行报告（命令树按执行顺序）、混合场景（`ui_case` 作为场景步骤）、Ctrl+K 五组直达** | **本轮交付** |
| 1C+ | 蓝图里挂着「一期」却一直没做的四项，本轮补齐：**登录态刷新**（§3.4 refresh 令牌 HttpOnly Cookie + 前端 401 单次静默重放）、**组织/工作区两张表**（§4.1「一期仅建表」）、**工作台统计页**（§11.5.2 简化版）、**CI 补齐 mypy 与前端 lint**（§14 写了但一直没跑的两道门） | **本轮交付** |
| 1D | ADB 设备管理、ADB 用例 | 未开放 |
| 1E | 模型配置中心界面、通知渠道、定时任务、高级搜索/保存视图 | 未开放 |
| 1F | Pilot 自然语言生成场景骨架 | 未开放 |
| 二期 | MCP 服务、Skills、审批门（写/破坏性工具的页面批准）、场景变更历史、跨项目复制场景 | 未开放 |
| 三期 | 测试计划 | 未开放 |

`ui_case` / `adb_case` 两种步骤类型在 1B **保存即报错**并写明「1C/1D 开放」，
不会让你把场景跑到第 7 步才发现那一步没人执行。1C 起 `ui_case` 真的有执行器了
（与 API 步骤混着跑通），`adb_case` 仍按这句话报错到 1D。

## 一期 DoD 第 3 条「权限矩阵」的实测口径（诚实版）

判据原文（`docs/2026-11-13-ai-test-platform-design.md:1601`）要「4 角色 × 主要页面/接口」。
它的证据分两面，**覆盖面不一样，不混着说**：

- **接口面：已证。** `backend/tests/test_permission_matrix.py`（commit `5508097` 起，
  此后随批次行长）把主要接口 × 4 角色逐格 parametrize，加跨项目隔离 + 覆盖率钉 +
  角色表快照钉。形状按 `--collect-only` 实测定，**当前是 38 行 × 4 = 152 格 / 155 collected**
  （`f7c7fba` 之后；此段曾长期手写「29 行 / 116 格 / 119 passed」，而 parametrize 一直跟着
  `len(ROWS)` 走，所以文字比代码旧了好几批）。加行时必须重跑 collect 再改本段——
  这就是该文件 docstring 里那条「别手写这个数」的规矩。每格一次真 HTTP 调用对真 JWT，
  期望值从 §4.1 角色表字面快照 + 独立实现的 glob 推（不是实现自证）。
- **UI 面：抽样，不是全覆盖。** 页面级角色门控用例目前覆盖 **12 个页面**：
  `web/src/pages/adbCases.test.tsx`、`adbCaseDetail.test.tsx`、`adbDevices.test.tsx`（1D），
  `api.test.tsx`（新建/导入/导出/删除）、`scenes.test.tsx`（新建/行删/批量删）、
  `settings.test.tsx`（READONLY 看不到审计 Tab——§11.4.26 审计可见性的界面证据）、
  `schedules.test.tsx`（无 `schedule:task:read` 连列表请求都不发 + READONLY 无新建/删除/保存但有
  next-5 预览）、`notifyChannels.test.tsx`（READONLY 隐藏写入口）（后三条 1E 补），
  `reportDetail.test.tsx`（重跑钮 = `scenario:run` 写端点的前端口，缺位整钮不在 DOM）、
  `datasets.test.tsx`（create/update/delete 三处隐藏）、`uiElements.test.tsx`（新建/回收/恢复/彻底删除跟位走）、
  `uiCaseDetail.test.tsx`（update/debug 隐藏不是禁用）（后四条为 DoD 第 3 条补洞，各带一条
  「换显式 `my_perms` 让按钮回来」）。
  前三类钉三件事：该看到的看得到、不该看到的看不到、**换一个显式 `my_perms` 让同一按钮回来**
  （证明按钮跟权限位走，不跟写死的 role 字符串走）。1E 那两条的口径略弱一档：
  「无权限 → 看不到 + 不打请求」和「READONLY → 缺写按钮」各自有钉，但**没有单独一条
  「换 perms 让按钮回来」**（默认项目就是 `["*"]`，回得来的证据藏在别的用例里，没点名）。
  **未覆盖页面（照实列）**：`uiCases`、`runs`、`reports`、`bench` 连页面级测试文件都没有，
  `workbench` 有测试文件但无角色断言（`scenePreview` 同样有文件、零角色断言，且它是路由页
  `app.tsx:35,77`）
  （本轮对账时逐个 `ls`/`grep` 核过）。这些页面的门控只有接口面证据，
  「全部页面 UI 已验」这句话**不成立**。


## 最短启动

依赖：**本机启动的** MySQL 8.x 与 Redis 7.x（1B 起 Redis 是硬依赖：Celery broker + 执行事件总线）、
Python 3.12、Node 22 + pnpm 10。**各种测试与演示都连本机实例（`127.0.0.1`），不要求 Docker**
（2026-11-19 业主口径修订；`docker-compose.yml` 只用于生产/Linux 形态，见
[docs/2026-11-19-metersphere-source-and-local-testing.md](docs/2026-11-19-metersphere-source-and-local-testing.md) §4）。

```bash
cp .env.example backend/.env            # 改库/Redis 地址与密钥（本机就填 127.0.0.1）
# 起本机基础设施（Windows 实测路径；只认「端口在听 + ping 通」，不认服务状态文案）
net start MySQL84                       # 本机 MySQL 8.4，3306
net start Redis                         # 或前台直起：
#   & "C:\Program Files\Redis\redis-server.exe" --port 6379 --requirepass <你的口令> --bind 127.0.0.1
netstat -ano | findstr :6379 && "C:\Program Files\Redis\redis-cli.exe" -a <你的口令> ping   # 期望 PONG
# Linux/macOS 若要起服务栈：docker compose up -d mysql redis（可选，测试不需要）

cd backend
.venv/Scripts/python.exe scripts/migrate_dev.py      # 建表/对齐 head（Windows 路径；Linux 用 scripts/migrate_dev.py）
.venv/Scripts/python.exe scripts/seed_demo.py        # 演示数据（幂等，只补缺）
.venv/Scripts/python.exe -m uvicorn app.server:app --port 8320
# 另开终端（cwd=backend）：必须起 worker，否则执行投不出去（broker 不通直接 503，
# worker 没起则 run 永远停 queued——两种都不静默降级，见手册 §6.2 / R123）
.venv/Scripts/python.exe -m celery -A app.worker:celery_app worker --pool=solo -l info

cd ../web && pnpm install && pnpm build
# 1C 起多一件（只做一次）：UI 用例执行要真浏览器（版本配对见手册 §0.2）
pnpm exec playwright install chromium
TP_BACKEND=http://127.0.0.1:8320 npx vite preview --host 127.0.0.1 --port 5173 --strictPort
```

打开 http://127.0.0.1:5173（默认管理员见 `backend/.env` 的 `TP_BOOTSTRAP_*`）。
Windows 上 8000 常落在 Hyper-V 保留段里，所以演示统一用 8320（详见手册 §1）。

## 新机自举（第一次 clone 要先补的那一步）

上面的「最短启动」通篇用 `.venv/Scripts/python.exe`，但 **`backend/.venv` 不在仓库里**——
第一次拿到代码的机器（或 CI 的全新 job）上它不存在，而 S0/1A/1B/1C/1D/1E 六份演示手册的
前置条件都写着「`backend/.venv` 已就绪」。所以那一段之前先补这一步：

```bash
cd backend
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
# Linux/macOS 换这两行：source .venv/bin/activate && pip install -r requirements.txt
```

几件容易踩的事，都在装的时候发生，所以写在这里而不是 troubleshooting：

- **Python 版本**：约束是 `pyproject.toml` 的 `requires-python = ">=3.12"`，不是「必须是 3.12」。
- **`requirements.txt` 的 23 条里 22 条是下限（`>=`）**，只有 `playwright==1.65.2` 是精确等号——
  它必须与 `web/` 的 `playwright-core` 落在同一个 chromium revision 上（配对说明见
  `backend/pyproject.toml` 的同条目注释与 1C 手册 §0.2）。下限意味着**同一份 requirements
  在不同日期解析出的版本不同**，这不是缺陷而是现状，后果写在下面门禁表那句口径里。
- **前端同样没有钉死版本**：`web/package.json` 没有 `engines` 字段，本文件上面写「Node 22 + pnpm 10」，
  而写下本段与历代门禁数字的这台机器实测是 **Node 24.14 / pnpm 10.33**——「Node 22」这句话
  从来没有任何东西在执行（`engines` 缺席 ⇒ 换 Node 大版本不会有提示）。它与上一条下限一起，
  构成本文件「八道门禁」一节开头那句口径的两条来源。
- **前端要补一次浏览器**：`pnpm exec playwright install chromium`（1C 起 UI 用例执行要真浏览器，
  「最短启动」里也有这一行）。revision 与后端那个 `playwright==` 对上时，两边共用同一份下载。

## 仓库结构

```
backend/   FastAPI + SQLAlchemy(async) + Celery；app/core（内核）+ app/modules/*（领域模块，互不依赖）
           app/modules/* 的每个 @service 一处标注 ⇒ HTTP 路由 + OpenAPI + Pilot 工具 schema
           + 权限位 + 审计 五路同生（架构口径见 docs/2026-11-13-s0-golden-slice.md）
web/       Vite + React + antd + @xyflow/react（Monaco 自托管，不连外网 CDN）
docs/      设计蓝图 + 各批次实施计划 + 业主演示手册（S0 + 1A–1F 共七份）
           对标参照：MeterSphere 全量源码（带 git 版本可切 tag）clone 在 `D:\item\metersphere`，
           位置/版本/结构地图/复刻用法与 GPLv3 只读边界见
           docs/2026-11-19-metersphere-source-and-local-testing.md
```

## 提交前必跑（八道门禁）

编号即下面的执行顺序：①–④ 在 `backend/`（CI 的 `backend` job），⑤–⑦ 在 `web/`（CI 的 `web`
job），⑧ 回 `backend/`。其中 **③ mypy、⑤ eslint、⑥ vitest 是 1C+ 才补上的**
——在那之前 1A–1C 的代码从未被类型检查、lint 或单测跑过，只跑过 e2e；补上 mypy 当天量到 87 处报错。

> **这张表里出现过的任何数字都不是绝对真值。** `backend/requirements.txt` 除 `playwright==` 外
> 全是下限（见「新机自举」），所以同一棵树在新 venv 上跑 ① 可能多几条少几条用例、
> mypy 可能多几处报错；e2e ⑦ 还额外吃 chromium revision 与本机有没有设备/AVD。
> 台账与手册里的「NNN passed」都是**当时那台机器那次 venv** 的实录——照抄数字没有意义，
> 要判的是「这一道门有没有跑过、退出码与失败名是什么」。

```bash
cd backend
.venv/Scripts/python.exe -m pytest -q                        # ① 单测/集成（需**本机** MySQL + Redis）
.venv/Scripts/python.exe -m ruff check app tests migrations scripts   # ② lint
.venv/Scripts/python.exe -m mypy app                         # ③ 类型（§14 写了很久，1C+ 起才真的跑）
.venv/Scripts/lint-imports.exe                               # ④ 模块边界四契约（只认打印文字，别用 -m importlinter）
cd ../web
pnpm lint && pnpm test                                       # ⑤ eslint + ⑥ vitest（秒级，先挡便宜问题）
pnpm build:e2e && pnpm exec playwright test                  # ⑦ e2e 构建 + e2e（生产包另跑 pnpm build）
pnpm audit:debt                                              # 测试债差集（非门禁：找活用的尺子，见下）
cd ../backend
.venv/Scripts/python.exe scripts/migrate_dev.py              # ⑧ 开发库对齐 head
```

> **`pnpm audit:debt` 不是第九道门禁**，是 [`web/scripts/audit-test-debt.mjs`](web/scripts/audit-test-debt.mjs)
> 的入口：它算三个数——零测试 import 的生产文件、有 `export default` 却没被测试接走的、
> 以及测试/e2e 里零引用的 `data-testid`。**README 与计划里这类数字只能由它产出**：
> 此前每轮在会话里现写一份脚本，两份口径不一致时读者分不清是树变了还是尺子变了
> （1G 计划「一次假红」就是这个坑）。`--check` 给解析器装了 7 种 import 形状的自哨兵，
> 因为它第一版就漏过具名-only 的写法、把孤儿数虚高到 61。**明细里的文件要抽查再动手**——
> 第三条尤其只是候选清单，不是缺陷清单。

> ⑦ 用的是 **`build:e2e`** 而不是 `pnpm build`：编辑器回归要的夹具页 `probe.html`
> 只在 e2e 构建档位进包，拿生产产物跑 e2e 会被 `web/e2e/globalSetup.mjs` 当场拦下。
> `pnpm e2e` 已把两步串好。

**批次实跑快照（1C+，2026-11-16，历史数字）**：① **618 passed**（308.92s）｜② All checks passed｜
③ **Success: no issues found in 93 source files**｜④ **Contracts: 4 kept, 0 broken**｜
⑤ `pnpm lint` **0 errors**（7 warnings，全是 `react-hooks/exhaustive-deps` 的 warn 档）｜
⑥ vitest **164 passed / 12 files**（`tsc --noEmit` 同时 0 错）｜⑦ e2e **70 passed**（2.7m，workers=1）
——但同一棵最终树**再跑一次是 69 passed / 1 failed**，那 1 条是 `sceneRun.spec.mjs` 的
「执行实时进度」，**先于本批次**的已知缺陷（首帧 `running` 可丢，台账 R136 / 待裁 D11）：
失败快照里 `run_end`、`stats`（共 3 · 过 1 · 败 1 · 跳 1）、终态着色全在，事件行是
`[2]…[6]`——**唯独 seq 1 那帧没进 DOM**。所以 ⑦ 的诚实口径是「70 条里稳定 69 条，
第 70 条撞 D11」，不是「70 全绿」｜⑧ `0018 -> 0019 (head = 0019)` OK。③ 的口径见
`backend/pyproject.toml` 的 `[tool.mypy]`：豁免只有两条 `[[tool.mypy.overrides]]`——`celery.*` 与
`uiautomator2.*`（两者都是"装上有没 py.typed"的库，不是我们引用错了），不做全局宽松。

**1D 中间轮实跑（T7 + D11 修复，2026-11-16；1D 未收尾，最终数字仍由 T11 覆盖这条）**：
① **759 passed**（406.50s）｜② All checks passed｜③ **Success: no issues found in 107 source files**｜
④ **Contracts: 4 kept, 0 broken**｜⑤ `pnpm lint` **0 errors**（7 warnings，同上一轮那七条）｜
⑥ vitest **231 passed / 16 files**｜⑦ e2e **73 passed**（3.5m，workers=1）**且 `sceneRun.spec.mjs`
连跑 9 次全绿**——D11（首帧 `running` 可丢）立专项修掉了，两处窗口各自闭合：`EventBus.subscribe`
曾是 async generator（`bus.subscribe(ch)` 那一行什么都没订阅），改成 await 到 SUBSCRIBE 在服务端
真的生效；换读快照的 `rollback` 放在**建流处**而非 replay 函数内（后者也服务 REST 路，在里面回滚
会丢掉调用方未提交的写——第一版就是这么写红的）。上面那句「70 条里稳定 69 条」从此作废｜
⑧ `0020 -> 0020 (head = 0020)` OK。

**1D 收尾轮实跑（T8–T11，2026-11-16；本批次最终数字，覆盖上面那条中间轮）**：
① **775 passed**（413.92s）｜② All checks passed｜③ **Success: no issues found in 107 source files**｜
④ **Contracts: 4 kept, 0 broken**（`adb_test` 在两枚契约清单里逐字在场：`pyproject.toml:93` 与 `:128`
——R64 假绿坑的核对方式就是查这两行，光看 lint-imports 绿不算）｜⑤ `pnpm lint` **0 errors**
（7 warnings，仍是那七条 `react-hooks/exhaustive-deps`）｜⑥ vitest **243 passed / 18 files**
（`tsc --noEmit` 同时 0 错）｜⑦ e2e 两种形状都实跑过：**CI 形状 79 passed / 2 skipped**（3.6m，
workers=1）与**注入假 adb 后 81 passed / 0 skipped**（4.2m，同一条命令 `TP_ADB_PATH`/`FAKE_ADB_STATE`
由 `mixedScene.FakeAdb()` 现生成、经 `playwright.config.ts` 透传进后端 webServer）——那 2 条 skip 是
`mixedScene.spec.mjs` 的 ②③（opt-in 全绿通路），注入跑不是「理论会绿」而是量出来的：dump 降级徽标、
真 POST /adb-devices 建建设备、末步两张真解码截图全在断言里。⑦ 本轮从红修到绿的 8 条全是**规格错**
不是产品错：三份新规格把步骤参数写在行顶层（§7.3 要 `config` 嵌套，后端 `missing_config` 当场 422）、
`palette.spec` 用 `click()` 选中导航项后再按 Enter（click 当场卸载浮层，键盘通路根本没测到，改
`hover()`）——断言一条没放松。同轮另修一处 strict-mode：调试面板末步本就两张截图（`screenshot`
命令 + 执行核的「整案终态截图」`adb_core.py:679`），规格改成精确钉 2 张 + 两个理由都在，
而不是 `.first()` 摸过去｜
⑧ `0020 -> 0020 (head = 0020)` OK: 开发库已在 head（`testpilot` 查得 current=0020、`adb_device`
在场，1D T2 的迁移早就跟上，这条这轮是空跑；1E 的迁移落地后仍要按这条对齐——**别的库别拿它练手**，
1E 计划 T9 明写「demo 库禁」）。

**本轮主线实跑（2026-11-17，1G 收口后对账轮，覆盖上面所有快照）**：① **1118 passed / 1 failed**
（910s）——那 1 条 `test_adb_debug.py::test_manual_run_inline_writes_back_last_result` **单跑
3.09s 绿**（本轮对账时复测），是全量并发下的负载抖动而非产品缺陷，重跑单条即证；
② ruff All checks passed｜③ mypy no issues found in **131 source files**｜④ **Contracts: 4 kept,
0 broken**｜⑤ eslint **0 errors / 8 warnings**（~~仍是 `react-hooks/exhaustive-deps` 家族；1D 收尾轮
量到的是 7 条，第 8 条出现在其后哪一轮未逐轮考古~~ ——**构成后来量清了，别再照这句读**：
8 = **7 条 `react-hooks/exhaustive-deps` + 1 条 `@typescript-eslint/no-unused-vars`**
（`src/pages/api.test.tsx:49` 的未用形参 `init`）。**计数一直对，构成说错过**，
而下一个判断「这 8 条该不该动」靠的正是构成）｜⑥ vitest **378 passed / 36 files**（`tsc --noEmit` 同时 0 错）｜
⑦ playwright **本轮未全量实测**：上一次全量基线是 91 passed / 2 skipped（`8a3b3ef` 轮），此后
`scheduleNotify.spec.mjs` 加了第 3 条、`importWizard.spec.mjs` 加了用例 ⑥，单规格抽查为
scheduleNotify 2 passed、notifyChannel+settingsTabs 合跑 7 passed——**全量数字在未重跑前一律不作数**；
⑧ `migrate_dev.py` **本轮未执行**：对共享 dev/demo 库跑迁移需业主授权（见 1G 收口文件门禁 ⑧
一节）。已知漂移：demo 库在 `0020`，迁移链头 `0022`。
权限矩阵该轮重测 `--collect-only` = **151 collected**（37 行 × 4 + 3 非矩阵钉）；**其后 1G/d47
轮补了 `run_rerun_step` 一行，现为 38 行 / 152 格 / 155 collected**（`:43` 是本数，别按本段取）。

**⑦ 的全量数字已补测（2026-11-17，`879dbab` 干净树）**：**101 passed / 2 skipped（4.8m）**，
命令 `pnpm build:e2e && npx playwright test`（workers=1，三条 webServer 全由 config 起）。
上面那段 91 的基线**自此作废**。那 2 条 skip 逐字核实是 `mixedScene.spec.mjs:173,242` 的
`test.skip(!backendHasAdb(), …)`——就是既有口径里「未注入假 adb 时跳过的 opt-in 全绿通路」，
不是新出现的静默跳过（全站 `test.skip` 只有这两处，grep 实测）。91 → 101 的差额含其间的
scheduleNotify 第 3 条、`importWizard` ⑥⑦ 与其后各轮新增，**逐条加法本轮没做**（要复算得回到
`8a3b3ef` 重跑一次，不值）。注入假 adb 后那 2 条会转为实跑，总数随之变——**该形状本轮未重测，
别引「103」这种推算数**。

**① 的全量数字已补测（2026-11-17，`b2b10c5` 树，后台单跑）**：**1162 passed / 0 failed（932.26s）**
——上面那行 1118/1 的快照**自此作废**。两点要说清：① 这次**没有那条 `test_adb_debug` 负载抖动**，
但**不读作「flake 已修」**，只读作「这一跑没复现」（它的复现条件是并发压力，本轮是单跑）；
② 该数测在 `b2b10c5`。~~原写「其后的提交只有 `e664ab1` 与三笔纯 docs 提交，**后端代码自那以后
一字未动**，所以这个数对当前树的后端依然成立」~~——**这句是错的，本轮按 diff 核过（不是数提交）**：
`git diff --stat b2b10c5 HEAD -- backend/app` = **14 个文件、+579/−48**，其中有真执行核改动
（`shared/sandbox.py` +75 沙箱出网洞 `063e968`、`shared/assertions.py` +55 断言入库口径 `80f03c6`、
`scenario/services.py` +72 场景引用缺陷 `d0c403f`）。**所以 1162 只是历史基线，对当前树不成立；
当前树的 ① 未实测**——写「未实测」而不是估一个数填在这儿。
——但**别顺着读成「所有数字都作废」**，同一把尺子量出的另一半结论正相反：`b2b10c5..4bb1ded` 是
**71 个文件、+6482/−419** 的前端大批量交付，`4bb1ded..HEAD` **只有两笔**（一笔纯 docs 计划 +
一个新后端测试文件 `test_d110_read_perm_write_sentinel.py`），**`web/` 与 `backend/app/` 自
`4bb1ded` 起到 `HEAD` 一字未动**。故 ⑤⑥⑦ 在 `4bb1ded` 那轮的实测数**对 `HEAD` 成立**：
⑥ vitest **571 passed / 51 files**（`tsc --noEmit` 净）、⑤ eslint **0 error / 8 既有 warning**、
⑦ **101 passed / 2 skipped**（两次 4.9m/4.8m，`workers=1`，DB `testpilot_e2e`）——README 上面把
⑦ 记在 `c39a8c7` 是**比 `4bb1ded` 更旧的口径**，以 `4bb1ded` 为准。

**本轮（第七轮：D105 自助改密入口 + D106 UI 用例引用检测 + D112 用户管理补测）`web/src` 与
`backend/app` 又动了，上面那三个数对新树再度过期**，逐条按本轮实测更新（HEAD=`f9de141`，
后端 `backend/app` 自 ② ③ ④ 重测后未再动，前端最后一动是 `f9de141` 的 `UsersTab.tsx`）：
② ruff **All checks passed**、③ mypy **no issues found in 133 source files**、
④ **Contracts: 4 kept, 0 broken**、⑤ eslint **0 error / 8 既有 warning**、
⑥ 全量 vitest **595 passed / 53 files** + `tsc --noEmit` **exit 0**、
⑦ 全量 **108 passed / 2 skipped（5.2m，exit 0）**——**七项全是当前树实测**，非转述。
⑦ 的 108 比 `4bb1ded` 那轮 101 多 7 条，正是 `closeout.spec.mjs` 新增的那 7 条（D85 补的 e2e），
它第一次真跑红 4 条、逐条修因写在 1G 计划文末；2 条 skip 仍是 `mixedScene.spec.mjs:173,242`
的假 adb opt-in。**① 当前树仍未实测**（最近的全量数 1162 属 `b2b10c5`，见上文）。
（同一天里 ⑥ 还记过一个 **582 passed / 52 files**，那是 D105+D106 落地时点、`UsersTab.test.tsx`
进树之前的数；**+13 = 那一个文件**，逐条对得上。再往前 **427 / 44 files** 与 mypy **132**
属 `b2b10c5` 那一轮，早作废，只留作「数字会这样过期」的痕迹。）
下面这段 ⑦ 的历史记录**保留**（它测在 `c39a8c7`，早于 `4bb1ded`，只是口径更旧）：
`c39a8c7`，命令同上，exit 0）：**101 passed / 2 skipped（5.0m）**，那 2 条 skip 仍是
`mixedScene.spec.mjs:173,242` 的假 adb opt-in（全站 `test.skip` 只有这两处，grep 复核）。
**passed 数与 `879dbab` 那轮持平不是巧合**：1G 尾轮的 D69/D70/D73/D74 四条前端交付只有 vitest
单测，**一条 e2e 都没加**——门禁绿了，但这四处新用户入口在浏览器层零覆盖，已作为缺口登记。

**第十轮（D115/D116/D117 三处编辑器缺陷 + D84 的 Pilot 预填切片 + 第五道差集六支组件单测）
八道门禁重测，七项本轮实测、⑧ 归业主**（`web/src` 与 `backend/app` 都有改动，上面所有旧数
对新树一律过期，以本段为准）：

| 门禁 | 本轮实测 | 说明 |
| --- | --- | --- |
| ① pytest | **1211 passed / 0 failed（954.29s）** | 后台单跑。`find backend -newermt` 证明这 954 秒的窗口内后端零改动，故数对当前树成立。上面 1162 与 1118/1 两个数**同时作废** |
| ② ruff | All checks passed | 跑于 19:08。`find backend -newermt 18:00` 抓到 `modules/env/services.py` 的 mtime 是 **18:40:03**、`backend/tests` 最新是 `test_r157_project_scope_coverage.py` **18:04:47**——**都早于 19:08**，「之后未动」成立。我写这行时一度把 18:40 当成「晚于开跑时刻」，据此宣布结论被推翻：**那是我看反了大小，撤回**。外加一层内容口径兜底：该文件 `md5sum` 与 `git show HEAD:` 逐字节相同（`6cbfd526…`，`git status` 也不挂它）⇒ mtime 动过但字节没动。**mtime 只能否掉一个数，不能证明一个数**，但这条不需要证明——它没被否掉 |
| ③ mypy | no issues found in **133 source files** | 同上（同一时刻、同一口径） |
| ④ lint-imports | **Contracts: 4 kept, 0 broken** | 同上；认打印文字，别用 `-m importlinter` |
| ⑤ eslint | **0 errors / 8 warnings** | 构成是 **7 条 `react-hooks/exhaustive-deps` + 1 条 `@typescript-eslint/no-unused-vars`**（`api.test.tsx:49` 形参 `init`）。中途一度 9 条，多出的那条是本轮新测试文件里一个未用导入，删掉即回 8。**收尾时又跑一遍**（改完注释、删掉一处测试内 `console.log` 之后），仍是 0/8 |
| ⑥ vitest | **816 passed / 69 files** + `tsc --noEmit` **exit 0** | 上表 595/53 作废。第二遍跑在 20:50:05，`find src -newermt` 之后零命中——**注释级改动也重跑一次**，不拿「反正只是注释」当免测理由 |
| ⑦ e2e | **113 passed / 2 skipped（5.4m，workers=1）** | `build:e2e` 起于 **20:56:03**（20:56:59 出包），`find src e2e scripts -newermt "20:56:03"` 零命中——**这条是本段唯一需要额外自证的数，而它本轮自证了三次**，理由见下。**这一遍没记 playwright 自己的退出码**：我把 `date` 和它串在一条命令里，`date` 参数写错让整条链 exit 1，Playwright 的码被盖住了。证据只有日志尾部 Playwright 自己打的汇总 `2 skipped / 113 passed (5.4m)`——**汇总里没有 `failed` 这一项**（`grep -icE "failed|error"` 整份日志 = **0**），有失败时 Playwright 一定会打 `N failed`，所以「通过」站得住；**但「exit 0」这一项本轮未实测**，上一遍（20:37 那次）单独跑过、当时确认过 |
| ⑧ `migrate_dev.py` | **未执行** | 对共享 dev/demo 库跑迁移归业主授权（demo 库 `0020` vs head `0022`） |

**⑦ 为什么值得单独自证（以及为什么要自证三次）**：本轮第一次跑 ⑦（也是 113/2，5.4m）**测在两支子 agent 正在改
`AdbDebugPanel.tsx` / `ModuleTree.tsx` 的那几分钟里**，构建之后仍有生产文件被写过——那次数字
描述的是它们的半成品，不是这棵树，**不能引**。定稿树重跑（第二次）后仍是 113/2，`build:e2e` 之后
`find` 查不到任何更新的源文件。**第三次是交作业前的最后一遍**：我在第二次之后又动了三个生产文件的
**注释**（把 `agent/routes.py:32-33` 这类错引改成 `backend/app/modules/agent/routes.py:33`）和一处测试里的
`console.log`——**「只是注释」不是免测理由**，注释会骗人、mtime 不会，所以重跑一次并重新记构建时刻。
**判据是 mtime，不是"我记得没人改"**。
2 条 skip 仍是 `mixedScene.spec.mjs:173,242` 的假 adb opt-in（`grep test.skip(` 全站只有这两处）。
108 → 113 的差额逐条对得上：`sceneList.spec.mjs` 的 D115 往下拖 1 条 + 新文件 `pilotDraft.spec.mjs`
4 条（日志里 `ok 60–63` 四条真跑），**不是推算**。

**测试债差集（`pnpm audit:debt`，非门禁）**：本轮把轴②「有 `export default` 却没有测试把默认导出
接走」从 **2 清零**（`AdbDebugPanel` 10 例、`ModuleTree` 29 例），轴① 零测试 import 的生产文件
**26 → 22**，轴③ 零引用 testid **138 → 137**。README 与各计划里凡是"测试债"数字**只许取自这个脚本**；
注意轴① 明细只打前 15 条（`TOP`），**计数 22 里有 7 个文件不露面**。

**第十一轮（§11.5.9 蓝图 `:1426` 后半条：调试失败 → 「让 Pilot 分析」，D84 复用原号不新取）
八道门禁全部重测，七项本轮实测、⑧ 归业主**（HEAD=`081e916`；本轮**只动前端**，
`backend/` 零改动，但后端四道仍重跑了一遍——重跑成本 90 秒，比"论证旧数仍然成立"便宜）：

| 门禁 | 本轮实测 | 说明 |
| --- | --- | --- |
| ① pytest | **1211 passed / 0 failed（966.30s）** | 后台单跑，起于 21:33:49。窗口内 `find backend -name "*.py" -newermt "21:33:49"` = **0**，且本轮 9 个改动文件**逐个 `md5sum` 与 `git show HEAD:` 逐字节相同** ⇒ 数对当前树成立。与第十轮同为 1211，是"后端没动"的旁证，不是巧合 |
| ② ruff | All checks passed | 21:52:24 重跑，exit 0。**这一条差点读到陈旧日志**：上一条命令里我多打了一个前导短横，`date` 报 `unknown option` → `&&` 短路 → ruff 根本没跑，而终端里那句 `All checks passed!` 是 `/tmp/g2.log` 的**上一轮残留**。下一行单独重跑并先 `rm -f` 日志，才拿到真的 exit 0 |
| ③ mypy | no issues found in **133 source files** | 21:52:17，exit 0 |
| ④ lint-imports | **Contracts: 4 kept, 0 broken** | 同上，exit 0；认打印文字，别用 `-m importlinter` |
| ⑤ eslint | **0 errors / 8 warnings** | 21:51:43。**3.1 秒跑完快得可疑**，所以额外用 `--format json` 数了覆盖面：**211 个文件**、8 条警告的构成仍是 7 条 `react-hooks/exhaustive-deps` + 1 条 `api.test.tsx:49` 形参 `init` 的 `no-unused-vars`——与第十轮逐条同名同处，不是"扫了 0 个文件所以绿" |
| ⑥ vitest | **846 passed / 71 files** + `tsc --noEmit` **exit 0** | 21:50:31→21:51:33（exit 0）、tsc 21:51:50（exit 0）。**为什么重跑**：提交前那个 vitest 数（同为 846/71）测在 21:16:34，而 `find web/src -newermt` 抓到 `api.tsx` 的 mtime 是 **21:25:13**（变异检验后按 md5 还原的一次写盘）——**mtime 晚于测试时刻，按纪律这个数不能直接引**。虽然内容 md5 相同，仍然重跑一遍拿干净时刻。**增量逐条对得上**：846 = 816 + 19（`debugPilot.test.ts`）+ 8（`DebugPanel.pilot.test.tsx`）+ 3（`runs.test.tsx`），71 = 69 + 2 个新文件 |
| ⑦ e2e | **116 passed / 2 skipped（5.6m，workers=1，PW_EXIT=0）** | `build:e2e` 21:52:36→21:53:34（exit 0），`find src e2e scripts vite.config.ts playwright.config.ts -newermt "2026-11-17 21:52:36"` **零命中**；跑测 21:53:42→21:59:20。退出码直接读 `$?`（日志重定向，**不接管道**）。116 = 第十轮 113 + 本轮 `debugPilot.spec.mjs` 3 条（日志里 `ok 26/27/28` 三条真跑），2 条 skip 是 `mixedScene.spec.mjs:172` / `:241` 的假 adb opt-in（日志里 `- 38` / `- 39` 两行点名） |
| ⑧ `migrate_dev.py` | **未执行** | 对共享 dev/demo 库跑迁移归业主授权（demo 库 `0020` vs head `0022`） |

**「数对当前树成立」这一条本轮是量出来的，不是推出来的**：提交时刻 **21:34:29**，
②③④⑤⑥⑦ 六项开跑都晚于它；**只有 ① 早了 40 秒**（21:33:49 开跑）。
所以 ① 不能靠"跑在提交之后"自证，改走内容口径，两层都够：
`git show --stat 081e916` 的 9 个文件**全在 `web/` 下、零后端文件**，
且 `find backend -name "*.py" -newermt "2026-11-17 21:33:49"` = **0**——① 的窗口里后端字节没动；
再加上本轮 9 个改动文件逐个 `md5sum` 与 `git show HEAD:` 相同。**顺序不够时用内容补，
但要说清是哪一层在作证**。写表格时 ⑦ 还没跑完，那一格先写「见下段」而不是填一个推测数，
跑完才回填——数字晚于表格出现，是这套台账一直可信的原因。

> **跑 mtime 判据时必须排除跑测自己的产物**：本轮第一次 `find backend -newermt "<①开跑时刻>"`
> 返回 **33 个文件**，照字面读就是"① 的窗口内后端被改了 33 处 → 这个数作废"。**全是这次 pytest
> 自己写的**——`data/artifacts/**/*.png`（调试产物落盘）与 `.pytest_cache/v/cache/nodeids`。
> 加 `-name "*.py"` 才是 **0**。**尺子要量的是源码，不是被测程序的输出目录**；不排除就会亲手
> 否掉一个本来成立的绿数（比假绿更糟的一种自伤）。

> 跑 ①⑦ 前先确认**没有你手工起的 5173 preview**：它的 `reuseExistingServer: true`
> 会把 e2e 悄悄接到演示后端上（假绿）。手工起的 **celery worker 最近已不用管**——
> 1D T0 起队列按 `TP_ENV` 分道（R118 根治：测试投 `tp.test`，演示 worker 领 `tp.dev`，
> 物理上看不见），这条是取证环境互相踩，不是产品缺陷——但会让你误以为门禁红了。

**第十二轮（测试债：四个纯模块 34 例；本轮真正值得记的是我给子 agent 的验收口径漏了半道门禁）
八道门禁全部重测，七项本轮实测、⑧ 归业主**（HEAD=`5922578`；**四笔交付全是测试文件，
`backend/` 与前端生产码逐字节未动**，md5 收口：`scene/layout.ts` `a4a9e42e…`、
`shared/artifactSrc.ts` `8e7a50b3…`、`api/modelUsage.ts` `2338f903…`、`api/schedule.ts` `6042f3d8…`）：

| 门禁 | 本轮实测 | 说明 |
| --- | --- | --- |
| ① pytest | **1211 passed，exit 0**（978.26s / 16:18） | 22:17:12 起跑 → 22:33:34 收尾，退出码读日志末 `PYTEST_EXIT=0`。跑的那 16 分钟里**前端正被三个子 agent 改**（含 `AssetTree.tsx` 一次活的 `ui_case`→`api_case` 变异探针，我亲眼看进了 `git diff`），这数仍然成立——**理由不是"它们在 `web/`"，是 ① 的读集里没有那些文件**，见下一节的读集结论 |
| ② ruff | All checks passed，exit 0 | 22:17:11 |
| ③ mypy | no issues found in **133 source files**，exit 0 | 22:17:11，与上轮同数 = 后端零改动的旁证 |
| ④ lint-imports | **Contracts: 4 kept, 0 broken**，exit 0 | 22:17:12；认打印文字，别用 `-m importlinter` |
| ⑤ eslint | **0 errors / 8 warnings**，EXIT=0 | 22:06:20→22:06:23。`--format json` 数覆盖面 = **215 个文件**（上轮 211 + 本轮 4），四个新文件逐个 `err=0 warn=0` |
| ⑥ vitest | **880 passed / 75 files**，EXIT=0 | 首跑 22:06:38→22:07:38；**改完类型后 22:08:23 复跑仍 880/75**（改的是类型、运行时用例数不变，这本身是「没偷偷改断言」的旁证）。846 + 34 = 880、71 + 4 = 75 |
| ⑥ tsc | 首跑 **EXIT=2（4 错）** → 修后 **EXIT=0** | **本轮唯一的真红，且是我造成的**，见下段 |
| ⑦ 前置 | `pnpm build:e2e` **EXIT=0** | 22:09:47→22:10:45（`tsc -b && vite build --mode e2e`）——顺带证明四个新测试文件不进包 |
| ⑦ playwright | **116 passed / 2 skipped（5.5m，workers=1，PW_EXIT=0）** | 跑测 22:10:57→22:16:29，退出码读 `$?`（重定向不接管道）。与上轮同数 = 本轮零 e2e 改动的旁证；2 条 skip 仍是 `mixedScene.spec.mjs:172`/`:241` 的假 adb opt-in |
| ⑧ `migrate_dev.py` | **未执行** | 业主专属（demo 库 `0020` vs head `0022`） |

**「子 agent 全绿、门禁⑥ 红」——红是我 brief 里漏的，不是它报错了。** 两个子 agent 都报告
「vitest 一次跑过」，**这是真的**；我照单收下后自己跑 `tsc --noEmit` 才拿到 **EXIT=2 / 4 错**
（TS2493 ×2、TS2352、TS2339）。根因是 **vitest 走 esbuild，一行类型检查都不做**，
所以「我没让跑 tsc」= 那半道门禁根本没进验收面。修法在 brief 层不在返工层：
**以后派「补单测」的活，验收清单必须带一句 `cd web && npx tsc --noEmit` 退出 0**。
类型修复只在类型层（给 `vi.fn` 写出形参、`as Blob` 但**保留**运行时 `toBeInstanceOf`），
修完把那条变异重跑一遍确认断言仍然咬得住。

> **本轮还纠正了自己一条写下才一天的台账**：`:1722`「高亮定位动画没有（grep 排除测试 = 零命中）」
> 重跑是 **23 命中**——代码是我自己后来改的（三页现在消费 `?q=<id>` 挂 `tp-row-hit`）。
> **结论方向没翻，证据翻了**。**否定式断言有保质期**，而且它变假之后读起来仍像一条正常历史记录；
> 现在改成记「命中数 + 各自是什么」，并把 grep 原话留在台账里以便一秒重放。
> 顺这条线量出 **D119（待裁）**：`?q=` 高亮只有 Ctrl+K 触发得到，Pilot 的跳转卡带 `params`
> 却不带 `q`、模型读的工具描述也没教它带——**能力在、通路在、没人按**，裁"要"是一句话的成本。
> 全文见 1G 计划「第十二轮落地回填」第九节。

> **本轮核出一条纪律层面的自我更正，值得每个跑门禁的人知道**：我此前判断「等待期能不能改文件」
> 一直**按目录划界**（"① 只看 `backend/`"）。实际核完：**`backend/tests/test_r158_readonly_verb_drift.py:23`
> 直接 `read_text` 前端 `web/src/auth/perms.ts`**（抠 `WRITE_TAIL`），是全仓唯一一处跨端读——
> 所以 ① 的读集是 `backend/**` ∪ 那一个文件。反向同理：`web/src/api/assertionTypes.contract.test.ts:19`
> 读后端 `schemas.py` 与 `shared/assertions.py`，**跑 ⑥⑦ 时这两个不许动**。
> **本轮结论碰巧安全，但论证是错的，而且错在放行那一侧**。正确问法永远是
> **「哪个测试会读这个文件」，不是「它在哪个目录」**。文档/README 安全（0 个测试 `open()` 它们）。

**第十三轮（测试债：五个组件 39 例；本轮最值得记的是我复核时用错了尺子，
以及一笔账我记漏了一半）**。门禁全部重测，数字表与逐条取证在
[1G 计划「第十三轮落地回填」](docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md)：

| 门禁 | 本轮实测 | 与上轮的差 |
| --- | --- | --- |
| ① pytest | **1211 passed，exit 0**（978.26s） | 同数（本轮前端独改，后端零动） |
| ②③④ | ruff 0 / mypy **133 files** / **4 kept, 0 broken** | 三项全同数 = 后端零改动旁证 |
| ⑤ eslint | **0 errors / 8 warnings**，EXIT=0 | 同数 |
| ⑥ tsc | **EXIT=0** | 上轮这里红过。**规矩生效了**：三个 brief 的验收清单都写了「`npx tsc --noEmit` 退出 0」，三家各报 0，我全量再报 0 |
| ⑥ vitest | **919 passed / 80 files**，EXIT=0 | 880+39=919、75+5=80 |
| ⑦ | `build:e2e` **EXIT=0**（54.31s，22:36:00→22:36:58）；playwright **116 passed / 2 skipped（5.6m，workers=1，PW_EXIT=0）** | 跑测 22:36:58→22:42:37，退出码读日志末 `PW_EXIT`（重定向不接管道）。`find src e2e scripts vite.config.ts playwright.config.ts -newermt "2026-11-17 22:36:00"` **零命中** = 出包后前端零改动。与上轮同数 = 本轮零 e2e 改动的旁证；2 条 skip 仍是 `mixedScene.spec.mjs:172`/`:241` 的假 adb opt-in |
| ⑧ | **未执行** | 业主专属（demo 库 `0020` vs head `0022`） |
| 尺子 | **生产 103 / 测试 112 ｜ 轴① 13 ｜ 轴② 0 ｜ 轴③ 130/685** | **轴① 18 → 13，减的正好是本轮五个靶子**；轴③ 只记差值 −7，**不记哪七个**（要坐实得跑两版尺子做集合差，没跑就不编）。**轴① 的 13 行有 2 行是假阳性**：`ScenarioPlansCard` / `QuestionCard` 都有同名测试，只是走 `renderCard` 注册表通路、不直接 import 生产文件——**真孤儿 11，扣掉 4 个 0-testid 结构壳与 2 个 probe 页，剩 5 个靶子**（明细见计划同节） |

**「生产码逐字节未动」这件事，我第一反应用错了尺子。** 我拿 `md5sum <file>` 比
`git show HEAD:<file> | md5sum`，22:32:13 那次 `AssetTree.tsx` 工作区 md5（`2229c96d…`）
**不等于** HEAD blob（`99ff13b7…`），而 `git status` 说它 CLEAN——**两条信号都是对的，
我却只信了更差的那条**，判成"尺子坏了"。真相是 CRLF 过滤器让工作区字节合理地异于 blob，
**而且当时另一个子 agent 的变异探针正活在这个文件里**；改用 `git diff`（与提交同口径）
后它直接躺在 diff 里：`addStep("ui_case"…)` → `addStep("api_case"…)`。
**尺子改成：`git diff` 判"改没改"，md5 只在"已经改了"之后比内容。**
我做对的是没碰那个活着的探针，等它 90 秒后自己还原。

**一笔我记漏一半的账**：D118 原先只记了 `AdbDebugPanel.tsx:133/:136`。本轮为判一条 FINDING
注释是否可信，把三个调试面板的渲染门一次列全，发现 **`UiDebugPanel.tsx:116`（环境标）
与 `:117`（报告链接）是同一个不对称**——成因是同一块面板被复制成两份、补 `!running` 时
只补了徽标/耗时/那一组。**所以 D118 是「两面板四触点」而不是「一块面板两行」**，
账已在 memory 与计划里就地更正（**业主待裁的那个问题本身一个字没变**，只是作用域翻倍）。
`api/DebugPanel.tsx` 同 grep **0 命中**（它没有 running 半截态），不是第三处。

**第六道差集（写而未接）两条后果各自取号、都不自修**：
**D120** `PATCH /ui-elements/{id}` 带着 R106 点名的第二道引用闸（`element_services.py:224-232`，
有引用时改定位器 → 409）且后端测试打过四次，**前端零调用**（`updateElement` 全仓 1 命中 = 包装件自己）；
但**蓝图 `:1386` 从没要求元素有「编辑」**——所以这是"闸该为人服务还是承认 Pilot 专用"的口径题。
**D121** 设备「编辑」**是**蓝图 `:1391` 白纸黑字，且 `adbDevices.tsx:13` 注释自己承诺了它，
而渲染区 `:456-492` 只有测试/排查/重连/强制释放/回收；后端边界已定死（`name`/`enabled`/可见性可改，
改 `serial` 故意 422）——**先造一个只能改名的弹窗 = 替业主回答"编辑包含什么"**，故待裁。

> **本轮还纠正了自己一条否定式表述**：memory 里「`scrollIntoView` 全仓零命中」重跑是
> **1 命中，且是测试注释**（`IssuePanel.test.tsx:13` 断言它的缺席）。结论方向不变
> （生产确实没有滚动定位），但"零命中"这句话本身不诚实。同族新账：
> `CommandPalette.tsx:47/:156` 把 `listRef` 挂在 52vh 滚动容器上**却没有任何人读它**，
> ↑↓ 只挪 `data-active` 不滚动——高亮的那行可以在视口外。与 D119 是同一个业主决定。

**第十四轮（测试债：四个靶子 44 例；本轮最该记的是尺子上那个"变差"的数其实是我搬的家）**。
门禁重测数与逐条取证在
[1G 计划「第十四轮落地回填」](docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md)：

| 门禁 | 本轮实测 | 说明 |
| --- | --- | --- |
| ⑥ vitest | **963 passed / 85 files** | 73.10s，日志末 `Test Files 85 passed (85)` / `Tests 963 passed (963)`、全份 `failed` 行 0。**退出码本轮没有单独取**：命令接了管道到 `tail`，`$?` 被 `tail` 盖住——按本仓既有的口径，"无 failed 行 + 末行全 passed"支持"通过"，但**不支持"exit 0"这句话**，所以这里不写。919+44=963、80+5=85 两处加法同时成立才算数——**四个子 agent 各自报的数我一个都没直接用** |
| ⑥ tsc | **TSC_EXIT=0** | 单独跑、`echo $?` 取的，全仓零 error |
| ⑤ eslint | **0 errors / 8 warnings**，ESLINT_EXIT=0 | 同数 |
| ⑦ | **116 passed / 2 skipped（5.6m），PW_EXIT=0** | ⑥ 那五个 agent 收工后**在同一棵树上重跑**：`build:e2e` 23:09:38→23:10:36（BUILD_EXIT=0）、跑测 23:10:36→23:16:13。`grep -cE "^  ok " /tmp/pw2.log` = 116、全份 `failed` 行 0；`find src e2e scripts vite.config.ts playwright.config.ts -newermt "2026-11-17 23:09:38"` **零命中** ⇒ 跑的就是出包那份。**退出码的出处是 `/tmp/g7b-full.log` 不是 `/tmp/pw2.log`**——`echo PW_EXIT=$?` 打到终端 stdout，不进那份日志（第十三轮那格我指错了文件，本轮已在计划里更正） |
| ①②③④ | **本轮未重跑** | 本轮 `git diff --stat -- web/src backend` = **空输出**，后端与 `perms.ts`（① 唯一的前端读集）逐字节未动 |
| 尺子 | **生产 103 / 测试 117 ｜ 轴① 13→8 ｜ 轴② 0→1 ｜ 轴③ 130→123/685** | 轴② 变差见下 |

**轴② 从 0 变 1，不是退步，是我给它搬了个家。** `OpenPageCard.tsx` 上轮在轴①（真孤儿），
本轮它的测试写了 `import { toPageUrl } from "./OpenPageCard"`——**只引具名子件**，轴① 放它走，
轴② 立刻抓它进来。可它的默认导出**确实渲染了**：测试 `import "./index"` 注册后走 `renderCard`
分派。这正是尺子自己承认的一跳盲区（`audit-test-debt.mjs:11-14`，第一实例是 `PropsPanel.tsx`；
**我第一稿把这条引成 `:19`，而 `:18-20` 讲的是另一个盲区"只被构建配置接走"——重开文件才抓到**）。
**我拒绝为了让轴② 回到 0 而加一行用不上的默认 import**——那是给尺子喂假边，量的就不再是树。

**顺带清了一笔不是我建的账**：`git status` 出现一个仓库根 `node_modules/`（`.gitignore` 只写了
`web/node_modules/`）。`find -type f` = 17 个文件，全是 vitest 缓存（`.vitest-cache` + `.vite/vitest`，
22:59:44 由本轮全量 vitest 落在仓根），**无一个源码或配置**，删前已逐条列过才 `rm -rf`。

**第十五轮（测试债：两个页面 23 例；本轮该记的是"子 agent 报的观察"和"它报的数"一样不能直接用）**。
门禁重测数与逐条取证在
[1G 计划「第十五轮落地回填」](docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md)：

| 门禁 | 本轮实测 | 说明 |
| --- | --- | --- |
| ⑥ vitest | **986 passed / 87 files**，VITEST_EXIT=0 | 78.69s。`986 = 963 + 12 + 11`、`87 = 85 + 2` 两处加法同时成立才算数——**两个子 agent 各自报的数我一个都没直接用** |
| ⑥ tsc | **TSC_EXIT=0** | 单独跑、`echo $?` 取的 |
| ⑤ eslint | **0 errors / 8 warnings**，ESLINT_EXIT=0 | 八条全是老面孔，本轮零新增 |
| ⑦ | **116 passed / 2 skipped（5.6m），PW_EXIT=0** | BUILD `23:54:42`→`23:55:41`（BUILD_EXIT=0）、跑测至 `00:01:19`。**四个数与两个退出码同在一份 `/tmp/g15-full.log`**：`echo` 写进 `{ }` 里才会进日志（上一轮那格指错文件就是这么来的）。`grep -c failed` = 1 但那是 `:61` 的 WebServer 探测行不是失败；`-newermt "2026-11-17 23:54:42"` **零命中** |
| ⑦ 为什么照跑 | 新增两个 `.test.tsx` **不进包**，但 `build:e2e` 第一步是 `tsc -b`，**它读测试文件** | 6 分钟换一条实测，不换推理 |
| ①②③④ | **本轮未重跑** | `git diff --quiet -- backend web/src/api/schemas.py web/src/api/assertionTypes.contract.test.ts` = CLEAN |
| 尺子 | **生产 103 / 测试 119 ｜ 轴① 8 ｜ 轴② 1 ｜ 轴③ 123→101/685** | 只记差值：轴③ **−22**，两根轴没动 |

**本轮取三个号 D127 / D128 / D129，全部待裁**（下一个可用号见下一段——同一晚我又开了三个号，
`README` 这里曾写过「下一个可用号 D130」，那句现在作废；**号段一律以 1G 计划文末那一节为准，
别在这里追数字**——我在这里写死的每一个数都会被下一轮取号追死）：
报告页「加载更多」翻到第二页
立刻被 effect 重跑打回第一页；审计页「动作」框的清空钮只清框不清筛选（`antd` 的清空图标走
`onClear`，**不经过 `onSearch`**，我在装的 5.29.3 源码里核的）；元素库深链横幅说「已在下表标出」，
可它的 `<Table>` **没有 `pagination={false}`**（同仓两个兄弟页都写了），antd 默认每页 10 行，
第 11 条起的「标出」打在一个没画出来的行上。

**D129 这条我差点写错两次，值得单独留字**：子 agent 断言这一页写了 `pagination={false}`，
我第二稿把这句话当证据抄进了台账——`grep -n pagination pages/uiElements.tsx` **0 命中**当场抓住。
它是看了 `schedules.tsx:750` / `notifyChannels.tsx:420` 两页都这么写，就当成这页也这么写。
**兄弟页有某个属性 ≠ 本页有；一条缺陷的证据只能是被审文件自己的 grep。** 它还把缺陷定在另一个分支，
真缺陷在它没看的那个分支。观察比数字容易信，所以观察也要一样过尺子。

**一笔自伤照记**：B agent 死在半路，交回来的 12 例里 10 例红 + 2 个 tsc 错，而它的报告写的是"已跑通"。
五个根因（缺字段、留着的 `expect(true).toBe(false)` 调试探针、点在已被替换的卡片节点上、
`seqAt` 返回裸对象而不是 `Response` 形状导致所有错误信封断言塌成「请求失败」、
以及把 antd 关闭的弹窗断成 `null`）全是我读码定位的，它一个字都没报。**它欠的变异取证一条没跑**，
A 报的 9 条我这轮也没复现——两份文件下轮由我自己逐条回滚生产码取证，在那之前它们只是"绿"，不是"钉过"。

**第十五轮补：那笔"只是绿"的账，B 那份当场结清**（取证手法与逐腿证据见
[1G 计划「第十五轮补」](docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md)）。
我自己写的一次性变异脚本，对 `reports.filters.test.tsx` + `adbDevices.purge.test.tsx`
**37 条单点变异**逐条「改生产码 → 只跑目标测试 → 从内存里那份原始字节还原并比对」：

| 实测 | 数 | 怎么量的 |
| --- | --- | --- |
| 红 / 绿 / 跳过 | **34 红 ｜ 3 绿 ｜ 0 跳过** | `.mut15.log` 里以 `#` 开头的腿行 `grep -c '^#[0-9].*RED '` = 34、`GREEN` = 3、`SKIP` = 0；脚本自报的两行小结（24 条：23/1/0，13 条：11/2/0）与之相加一致 |
| 还原 | **37/37 OK，0 次还原失败** | 每条腿跑完拿内存 Buffer `.equals()` 比字节；`grep -c '还原FAIL'` = 0，末尾 `git status` 两个目标文件干净 |
| 退出码与时长 | `EXIT_R=0` `EXIT_A=0`，`00:09:26`→`00:12:45`（3m19s） | 都写在同一份 `.mut15.log` 里，不是我凭记忆报的 |
| 三条绿 | 逐条有机证，不是"应该没事" | ①行链接不导航：另写探针把它打成红（`reports.filters.test.tsx:292` 的 `Set` 少一个 URL）；②`confirm_name` 送输入框的值：与①同族的门禁已被 P1–P3 三条腿钉红，判**等价变异**；③硬拦后不复位：只删 `:399` 看不见，**同时**删 `:465` 才红在 `:272` |

**三条绿是产出，不是失败**：一条是测试真漏（探针补证），一条是等价变异（改语义不改行为），
一条是**生产码有两处复位、测试只钉得住合起来的效果**——第三种只有逐条回滚才看得见。
顺带钉死了我自己的一个错注释：`adbDevices.purge.test.tsx:260` 把复位归给 `:399`，实测删 `:399` 不红。

**本轮再取三个号 D130 / D131 / D132，全部待裁、全部未自修**（下一句里的「下一个可用号 D133」
在紧接着的第十六轮已被用掉，**号段以 1G 计划文末为准**）：
模型 Tab 的空态把业主指向 `backend/.env`，可 `seed.py:33` 读的是 `os.environ`，而 pydantic 的
`env_file` **只填 `Settings` 对象、从不回填 `os.environ`**（我另起一个 `backend/.probe-tmp` 实测过，
第一次拿 `/tmp` 路径试的那次在 Windows 上根本不成立，作废）；接口回收文案说用例「跟着进回收站」，
一个即建即删的 pytest 打出 `[('用例A', 'normal')]`——**没跟**；调试断言计数无视 `enabled`，
而引擎 `assertions.py:156` 恰恰跳过 `enabled is False`，开关就在 `RequestEditor.tsx:228`。
另四条（同文件另一句归因、三页空态指向不存在的按钮、`scenes.tsx:551` 把取数失败说成没有环境、
`api.tsx:701` 的 422）**不占号**：前三个属已登记的 D47 同族，最后一条机制成立但 UI 建不出入口，只到 LATENT。

**A agent 报的 9 条变异仍没由我复现**——按同一把尺子那还是声明，那是前几轮该结的账，不并入本轮。

**这张表到此为止，往后的轮次不在这里回填（第 27 轮定的口径，结掉一笔挂了 10 轮的账）**：
第 16–27 轮的实测数**只写在**
[1G 计划文末各轮的「落地回填」小节](docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md)，
理由与上面号段那几句一模一样——**逐轮往这张表里追加，就会被下一轮的数字追死**，
而且它已经漂到「引行号必错」（D156）。所以这里只留**指针 + 一份当前树的基线**：

| 门禁 | 当前树实测（2026-11-18） | 证据（打印行就在文件里，不是我转述） |
| --- | --- | --- |
| ① pytest | **1221 passed / 0 failed（1008s）** | `.g26-pytest.log` 尾行 |
| ② ruff / ③ mypy / ④ lint-imports | 全过 ｜ **133 source files** ｜ **4 kept, 0 broken** | `.g26-ruff.log`、`.g26-mypy.log`、`.g26-imports.log` 各尾行 |
| ⑤ eslint | **0 errors / 7 warnings**，exit 0 | `.g5-r26d.log` 尾行；本轮只动 docs，收工前复跑同数 |
| ⑥ vitest + tsc | **1319 passed / 90 files / 0 failed**，`G6TSC4_EXIT=0` | `.g26v4.json`（`testResults.length`=90）+ `.g6-r26v4.log` |
| ⑦ e2e | **本轮未跑** | 只动 docs；上一轮的 ⑦ 数在它那一轮的台账节里，别引第 15 轮这格 |
| ⑧ 迁移 | **归业主** | demo 库仍 `0020` 而 head=`0022`——定时/通知/自定义角色在业主点的那套库里不存在 |

**为什么这六个数算在「当前树」头上**（不写这句，下一轮又要重推一遍）：
①②③④ 的日志之后没有任何后端文件被改过
（`find backend -name '*.py' -newer .g26-pytest.log | grep -v __pycache__` **零命中**），
⑤⑥ 同理（`find web/src -name '*.ts*' -newer .g26v4.json` 零命中）。
比的是**日志 mtime vs 文件 mtime**，不是「工作树相对 HEAD 干不干净」——
第 26 轮那 8 个后端文件仍未提交，但它们全部早于那份日志。

CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：pytest 走 `TP_EXEC_MODE=inline`
（与 worker 同一份执行引擎），**CI 不起 worker**；celery 端到端由
`backend/scripts/verify_worker.py` 在本地/夜间任务证明（真 broker + 真 worker 子进程 +
跨进程 pub/sub），在 CI 里大声跳过而不是假装跑过。
