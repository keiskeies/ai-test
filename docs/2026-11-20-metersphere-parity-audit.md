# MeterSphere 复刻对账(功能全集差集 · 2026-11-20 业主定口径)

> **建档**:2026-11-20。上一篇是 `2026-11-19-metersphere-source-and-local-testing.md`——那篇解决的是
> 「源码在哪、怎么跑、测试在本机跑」;那篇末尾留了一句没做的事:「**逐页逐接口逐项对照**」。
> 本文就是那次对照的**第一轮全量差集**,以及业主当轮拍下的执行口径。
>
> **本文所有数字都是 2026-11-20 在这台机器上现跑的**,不是引用蓝图、不是引用台账、不是记忆。
> 每条都附了复跑命令(§6)。MS 侧一律 `D:\item\metersphere` @ `v3.x` / `f1565d99a0`;
> 我们侧一律 `D:\item\ai-test` @ `main` / `c7998f4`。

---

## 0. 业主口径(2026-11-20,本轮拍定)

问:「平台的功能除了 agent 外,按照 MeterSphere 复刻」——「复刻」按哪个口径执行?
(现树 167 个 HTTP 操作 vs MS 1047,两种读法的工作量差一个数量级,不能猜。)

**业主答复两条**:

1. **口径 = 「先行为后范围,分两批」**。
   - **批次 A(行为复刻)**:范围不动,把**已有页面**的交互与数据结构逐项照 MS 实物核齐。
     这就是蓝图 §13 纪律 4 与 §11.5「照搬」表一直要的那件事,也是台账 **D47** 挂了四天的包。
   - **批次 B(范围复刻)**:再把 MS 独有模块纳入承诺范围,排队补做。
2. **批次 B 的头名 = 测试计划 + 计划报告**(MS 143 端点)。
   功能用例库+评审(127)、缺陷管理(50)、API Mock(19)按此顺序顺延。

「除了 agent 外」这条正好有实物支撑:**MS 的 AI 面只有 4 个 controller / 21 个端点**
(`ApiTestCaseAIController` 5 + `FunctionalCaseAIController` 5 + `AiConversationController` 6 +
`SystemAIConfigController` 5),而我们的 agent 模块是 3 权限位 + 121 个 Agent 工具中的一部分 +
5 条路由。**Agent 这块 MS 没有可对标的实物**,我们的设计蓝图 §9 是自研的,不参与复刻。

---

## 1. 量级对账(现跑,2026-11-20)

| 维度 | MeterSphere v3.x `f1565d99a0` | TestPilot `c7998f4` | 比 |
| --- | --- | --- | --- |
| 后端业务模块 | 7 个 service 目录 | 15 个 `app/modules/*` | — |
| Controller / `@service` | **119** 个 Controller | **164** 个 `@service` | — |
| HTTP 操作数 | **1047** | **167** | 16% |
| 权限位 | **223 条 / 58 组** | **89 条 / 15 域** | 40% |
| 数据表 | **158** 唯一表(含 11 张 QRTZ 调度表 → **业务表 147**) | **35** | 24% |
| 前端页面 | **463 个 `.vue`** | **20 个页面文件 / 20 条叶子路由** | 4% |
| Agent 工具 | (无此概念) | 121 | — |

**这张表不能读成「还差 6 倍工作量」**,三个理由:

1. **MS 的 1047 里有一大块是我们范围外的**:测试计划 143、功能用例 127、缺陷 50、
   性能(0,见 §3)、组织三级与系统面 277——业主从未承诺过这些。
2. **我们的 167 是「双注册」的产物**:164 个 `@service` 同时是 HTTP 路由 + Agent 工具
   (121 个) + 权限位 + 审计点。MS 的端点没有 Agent 工具这一路,所以**两端不是同一种计数单位**。
3. **UI 测试与 ADB 测试 MS 一个端点都没有**(§2.3),而这两块占我们 50 个 HTTP 操作(30%)。
   把这 50 剔掉再比,可对标面我们只剩 117 / MS 1047 = **11%**——这才是复刻的真实起点。

我们侧 167 按域:`api 57 / sys 32 / adb 27 / ui 23 / proj 21 / agent 5`。

---

## 2. 三档差集

### 2.1 A 档:已有对应实现,只差行为(→ 批次 A,本轮开工)

这些页面我们**有**,MS 也**有**,差的是交互与数据结构。全部落在蓝图 §11.5 那张「照搬」表里,
其中大部分已在台账 **D47** 登记过——**本节不重复取号,只把 MS 侧的实物契约补进去**(以前只有
蓝图草图,现在有源码,「照搬」从形容词变成了可核对的字段清单)。

| 我们的页面 | MS 实物位置 | MS 端点数 | 差什么 | 台账号 |
| --- | --- | --- | --- | --- |
| `api.tsx` 接口管理 | `views/api-test/management` + `ApiDefinitionController` | 34 | 列表工具栏三件套、跨页全选、收藏/标签、服务端检索 | D47-a/b/c/d |
| `scenes.tsx` 场景 | `views/api-test/scenario` + `ApiScenarioController` | 35 | 同上 + 批量操作 8 端点对照 | D47-a/b/d |
| `reports.tsx`/`reportDetail` | `views/api-test/report` + `ApiReportController`/`ApiScenarioReportController` | 25 | 分页档位、PDF 导出(三期点名项)、分享 | D47-b |
| `datasets.tsx` | `api_scenario_csv` + `_csv_step`(3 表) | 挂在场景内 | 数据集从「场景附属」到「可独立管理」的差距未裁 | 新(本文 D182) |
| `workbench.tsx` | `views/workbench` + `dashboard`(35) + `MyViewController`(7) + `ToDoController`(4) | 46 | 我们**已交付 §11.5.2 简化版**(统计卡 ×4 + 近 7 天 ECharts 趋势 + 最近执行 10 条 + 我最近编辑 + 快捷入口,`workbench.tsx:1` 自陈)。**差的是另一件事**:MS 是**自定义卡片仪表盘**(`homePage/components/cardSettingDrawer` 可增删卡片)+ **个人视图** + **待办流**(`ToDoController` 4)——蓝图 §11.5.2 原话已把「MS 的待办/评审/关注流 [三期]」写明,故这一格**只有「卡片可自定义」是新的**,余皆既有分期 | D47 系 |
| `settings.tsx` 角色 Tab | `ProjectUserRoleController`(10)+`GlobalUserRoleController` | 10 | 两级权限树我们已落地(D37),差 MS 的「用户组」层级(§2.3-C) | D37 已结 |
| 通用列表交互 | `components/pure/ms-table/*` + `ms-advance-filter/*` | 组件级 | 见 §2.1.1 | D47 |

#### 2.1.1 MS 列表页底色的**实物契约**(源码读语义,不抄文件)

以前 D47 只能写「未实现」,说不出该实现成什么样。现在有了:

- **高级搜索**(`ms-advance-filter/type.ts`):一次筛选 = `{searchMode: "AND"|"OR", conditions: [{dataIndex, operator, value, customField}]}`。
  **操作符 13 枚**:`CONTAINS / NOT_CONTAINS / IN / NOT_IN / GT / LT / EQUALS / NOT_EQUALS / EMPTY / NOT_EMPTY / BETWEEN / COUNT_LT / COUNT_GT`。
  **值控件 10 型**:`Input / Number / Select / Member / DatePicker / TagsInput / TreeSelect / textArea / SelectEqual / Cascader`。
  后端侧 `BaseCondition.searchMode` 默认 `"AND"`(`framework/sdk/.../dto/BaseCondition.java:27`)。
- **保存视图**(`ViewItem` + 表 `user_view` / `user_view_condition`,3.3.0 起):
  `{id, userId, name, viewType, internal, scopeId(=项目), searchMode, pos}`。
  **`internal` 分内置视图与个人视图两类**,`viewType` 是**每个列表页一个枚举值**(MS 枚举了 20 个:
  `api-definition / api-scenario / api-case / api-mock / api-report / test-plan / bug / …`)。
  → 我们的实现照这个形状:`view_type` 按页面取值、`internal` 区分内置、`pos` 排序。
- **跨页全选**(`ms-table/select-all.vue`):三态 `NONE / CURRENT / ALL / CANCEL_ALL`,
  选「ALL」时**不把全量 id 拉回前端**,而是把筛选条件发给后端按条件批量。
  → 这条与 D47-d 登记的理由(「现在的批量接口按 id 数组收」)对上了,MS 的解法就是**条件批量端点**。
- **列设置**(`ms-table/type.ts`):`showInTable` 逐列布尔 + 拖拽序(`showDrag`),本地持久化。
- **分页**(`MsPaginationI`):`{current, pageSize, total}` + `showPageSize/showTotal/showJumper`。
  → 与 D47-b 登记一致:MS 是**页码制带 total**,我们是**游标制无 total**,两套取数形状,不是改个 UI。

### 2.2 B 档:MS 有、蓝图点名但排到三期(→ 批次 B,业主已排队)

| 模块 | MS 端点 | MS 表 | 蓝图原话 | 业主排队 |
| --- | --- | --- | --- | --- |
| 测试计划 + 计划报告 | **143** | `test_plan*` 20 张 | §13 三期「测试计划」 | **第 1 位** |
| 功能用例库 + 用例评审 | **127** | `functional_case*` 11 + `case_review*` 8 | §4.7 `[三期]预留表` | 第 2 |
| 缺陷管理 | **50** | `bug*` 7 | §4.7 `defect` | 第 3 |
| API Mock | **19** | `api_definition_mock*` 2 | §4.7 `mock_service/mock_rule`;§11.5 差异表「Tab 位改为场景引用,Mock [三期]」 | 第 4 |
| 模板管理 | 18 | `template*` 2 | §11.5 差异表「模板、素材库 [三期]」 | 待排 |
| 自定义字段 | 10 | `*_custom_field` 4 | §11.5 差异表「字段已预留」 | 待排 |

**测试计划这一条有个先手优势要记下来**:蓝图 §4.7 写明「**蓝图保证 scenario/execution 的报告模型
对四类执行通用**(`subject_type` 枚举含 PERF/TEST_CASE_BATCH)」。我们的 `run_record` 正是按
subject 通用设计的——所以批次 B 头名不是从零建执行模型,是**在既有 run 模型上加一层编排与聚合**。

### 2.3 C 档:MS 有、我们蓝图与台账**从未提及**(本轮新浮出,全部待裁)

这 15 项是翻源码才看见的。判据严格:**`grep -rl <词> 蓝图 + 1G台账` 零命中**才算「从未提及」,
命中过的都归回 A/B 档或既有 D 号,不重复报。端点数逐个 `grep -cE "@(Get|Post|Put|Delete|Patch)Mapping"` 实数。

| # | MS 功能 | 端点 | MS 语义(summary 原文摘) | 我们没有的原因是… |
| --- | --- | --- | --- | --- |
| C1 | 环境组 | 7 | 「项目管理-环境组-新增/修改/删除/列表/详情/获取项目/修改排序」 | 我们是单层 `environment` + `global_config` 分层变量,**没有「多环境打包成一组」这一层** |
| C2 | 公共脚本(自定义函数) | 8 | 「公共脚本-列表/详情/添加/更新/更新状态/删除/变更历史」+ `/custom/func/run` 脚本测试 | 我们的前后置脚本**内联在每个步骤里**(`script` 27 处),**没有可复用、可启停、有版本历史的脚本库** |
| C3 | 项目应用开关 | 22 | 8 个 `PROJECT_APPLICATION_*:READ/UPDATE` 组 | 我们没有「项目级按需开启模块」的开关,菜单对所有人一样 |
| C4 | 服务集成 | 7 | 组织级;实测支持 GitHub/GitLab | 我们零第三方集成 |
| C5 | API Key(用户密钥) | 7 | `UserApiKeysController` | §12.4 有 service token 设计但**排二期**,零实现;与 MS 的「用户自助签发密钥」不是同一个东西 |
| C6 | 资源池 | 5 | `TestResourcePoolController` | 我们是单 Celery worker,**无多执行机/池化调度** |
| C7 | 插件体系 | 7 | `PluginController` + `ApiTestController:/plugin/*` 协议插件 | 我们的协议与断言**硬编码在 `shared/assertions.py`**,无插件装载 |
| C8 | 个人中心 | 8 | `PersonalCenterController`(语言/最近项目/…/我的资产) | 我们只有顶栏「修改密码」(`shell.tsx:230`),**没有个人中心页** |
| C9 | 状态流转设置 | 14 | 组织级 7 + 项目级 7 | 我们 `api_definition.status` 是 `draft/complete` 两值常量,**无可配置状态机** |
| C10 | 分享链接 | 18 | `ApiDocShareController` 13 + `ApiReportShareController` 3 + `ApiShareController` 2 | 我们**无任何对外分享**;报告只能登录后看 |
| C11 | 用例脑图 | 6 | `FunctionalCaseMinderController` + `ms-minder-editor` 组件 | 我们无脑图(依赖 B 档功能用例库,排在它后面) |
| C12 | 文件管理/仓库 | 31 | 5 个 controller(仓库 8 + 管理 13 + 模块 5 + 关联 3 + 预览 2) | 我们只有执行**制品**(`run_artifact`),**没有项目文件库** |
| C13 | 许可证 | 2 | `LicenseController.validate` | **MS 商业版门,复刻应主动排除**(§4) |
| C14 | 用户组 | 10 | `ProjectUserRoleController`(项目级角色) | **不是纯缺口**:我们的 `custom_role`(D37 已交付)语义等价,差的是 MS 的**组织级用户组**那一层 → 属「三级组织」范围题 |
| C15 | 误报库 | 5 | 「新增/编辑/启停/列表误报规则」,表 `fake_error` | 我们执行失败**一律算失败**,无「已知误报」白名单 |

**C 档不擅自实现,一条都不做。** 理由与 D47 待裁那八条同尺:每一项都要新表或新契约,
且「MS 有」不等于「我们该有」——§3 就是反例(连 MS 自己都没做完的东西)。

---

## 3. **MS v3 自己也没有的**——复刻时别当缺口去找

三条,都是本轮实测,防止后面有人(包括我)拿旧印象来找:

1. **性能测试:MS v3.x 零代码**。`find backend -ipath "*performance*"` 零命中,
   只剩 `PermissionConstants.java:153-154` 两枚 `PROJECT_APPLICATION_PERFORMANCE_TEST:*` 残留权限位,
   和菜单词条 `menu.performanceTest = 性能测试`。**158 张表里 `performance` 零命中**。
   → 蓝图 §13 三期把「性能测试(JMeter)」排着,但**无源可对标**;真要做只能回 v2.x 取证。
2. **UI 测试:MS v3 模块级为零**。`backend/services/` 只有七项(api-test / case-management / test-plan /
   project-management / system-setting / dashboard / bug-management),`frontend/src/views/` 无 UI 测试目录,
   463 个 `.vue` 里零个 UI 测试页。**残留只剩字符串,没有代码**:
   `Schedule.java:46` 的 `@Schema(description = "资源ID，api_scenario ui_scenario load_test")` 注释、
   测试资源 `init_task_center.sql` 里 4 行 `UI_SCENARIO` 数据、测试里 `setModuleSetting("[\"apiTest\",\"uiTest\"]")`。
   → 上一轮那份 grep 报了 5 个文件命中,**逐个读原文后全是这类注释/夹具残留**;v2.x 分支 `git ls-tree` 亦零命中。
   模块、controller、页面三者皆零,判「无 UI 测试」成立,但**依据是读了每一条命中的原文,不是 `grep` 报零**。
3. **ADB 测试:MS 全仓零命中**(上一篇文档已记:全仓 `grep -rli uiautomator` 零命中)。

**结论**:UI 测试(23 端点)+ ADB 测试(27 端点)= 我们 167 里的 50 端点(30%)**在 MS 里没有对标物**。
这两块是原创项,复刻口径对它们不适用。这条要写死——否则每次对账都会得出「UI/ADB 页面质量没锚点」的
错误结论,那只能靠我们自己的 §11.4 草图与真机验收把关(§13 纪律 4 把 1C 排在「业主强项区」正是此意)。

---

## 4. 复刻的三条边界(不变,复述以免下一轮重议)

1. **GPLv3**:读语义,不抄文件、不引 jar/npm。本文引用的 MS `type.ts` 字段名与 enum 值是
   **语义描述**(「MS 用 13 个操作符」),不是把它的代码搬进我们仓库。我们的实现用自己的
   命名与约定(我们前端是 React+AntD,MS 是 Vue+Arco,**照搬不了也不该照搬**)。
2. **技术栈不照搬**:MS = Java/Spring/Vue/Arco,表名、类名、目录约定都不搬,只取行为与数据结构语义。
3. **范围不因源码在手而膨胀**:C 档 15 项一律待裁;MS 的商业门(License、插件市场)与
   我们的部署形态无关,建议直接裁「不做」而不是排队。

---

## 5. 本轮之后的账

- **批次 A**(行为复刻)首刀 = **D47-a 列表工具栏三件套**(视图选择器 + 高级搜索 AND/OR + 列设置)。
  选它的理由:D47 八条里只有它有 MS 的**完整实物契约**可照(§2.1.1),且它是业主的 MS 肌肉记忆
  (D47 原话:「每页右上角习惯性去点的地方」)。台账 D47 由本文的业主答复**结案改判**。
- **批次 B** 头名 = 测试计划。**开工前另开计划文件**,本轮不动。
- C 档 15 项 → 台账 **D182** 一条打包登记待裁(不逐项取号,理由见 D47 先例:
  同一批同域未提及项拆成 15 个号,只会让取号表失去意义)。

---

## 6. 取数命令(全部本轮真跑过)

```bash
# MS 侧(注意:PermissionConstants 用换行+注释分组,rg 的 -A/-B 不可靠,一律 grep -c)
cd D:/item/metersphere && git log --oneline -1   # f1565d99a0
grep -cE "public static final String [A-Z_]+ = \"" \
  backend/framework/sdk/src/main/java/io/metersphere/sdk/constants/PermissionConstants.java   # 223
grep -oE '= "[A-Z0-9_]+:' backend/framework/sdk/.../PermissionConstants.java | sed 's/= "//;s/://' | sort -u | wc -l  # 58 组
grep -rhoE "@(Get|Post|Put|Delete|Patch)Mapping" --include=*Controller.java backend/services | wc -l  # 1047
find frontend/src/views -name "*.vue" | wc -l   # 463
# 表:全迁移去重。3.0.0 基线 139 张唯一表,增量到 3.6.0 共 158 张(其中 11 张 QRTZ 调度表,业务表 147)。
# 反引号在 git-bash 里会被吃掉,数表一律用 python 正则,别用 grep 管道(本轮就这么把 158 数成了 0):
backend/.venv/Scripts/python.exe -I -c "
import re,glob
t=''.join(open(f,encoding='utf-8',errors='ignore').read()
          for f in glob.glob('backend/framework/domain/src/main/resources/migration/*/ddl/*.sql'))
n=re.findall(r'CREATE TABLE(?: IF NOT EXISTS)?\s+\`?([A-Za-z0-9_]+)\`?', t, re.I)
u=sorted(set(x.lower() for x in n)); print('stmts',len(n),'unique',len(u),
      'qrtz',sum(1 for x in u if x.startswith('qrtz')))"     # stmts 159 unique 158 qrtz 11

# 我们侧(注册表是唯一真相:164 个 @service 同时是路由/工具/权限/审计)
cd D:/item/ai-test/backend && .venv/Scripts/python.exe -I -c "
import sys; sys.path.insert(0,'.')
from app.main import create_app
from app.core.registry import REGISTRY
app=create_app(); spec=app.openapi()
print('services', len(REGISTRY.all()), 'perms', len(REGISTRY.perm_points()),
      'tools', len([t for t in REGISTRY.all() if t.tool]),
      'ops', sum(len([m for m in v if m in ('get','post','put','patch','delete')]) for v in spec['paths'].values()))"
# 服务必须经 create_app() 才全注册:逐个 import modules/**/*.py 会得到 services=0(本轮踩过)
grep -rh "__tablename__" app/modules/*/models.py | wc -l   # 35
find ../web/src/pages -name "*.tsx" ! -name "*.test.tsx" | wc -l   # 20（叶子路由同样 20 条：app.tsx 五条带 path 的父/通配路由不计）
```

**两个取数坑(记下来,下一轮别再踩)**:
- **`grep -c` 与 `grep -l` 不是一回事**:前者数行、后者数文件。本文所有端点数用 `grep -c` 数行;
  上一轮那份「关键词差集」草稿用 `-l` 数文件,同一个功能在 6 个文件里各命中一次会被数成「命中 6 处」,
  反过来一个功能只出现一次时又会把「有」和「只有类型声明」混为一谈。**C 档那 15 项每条都用
  `grep -c` 数了 controller 的 mapping 行,并逐个读了 `summary` 原文确认语义**。
- **关键词命中 ≠ 功能存在**。本轮三个假阳性都靠读源码摘要是消掉的:
  ① `api_key` 在我们仓库命中 15 处,读下来全是**模型配置的 provider key**(`model_cfg`),
  不是 C5 的用户自助密钥;② `global_config` 看起来对得上 C2「全局参数」,读 `GlobalParamsController`
  的 summary 才知道是**环境维度的参数包(带导入导出)**,与我们 `global_config` 的
  `VAR/HEADER/ASSERT/EXTRACT` 四档不是一回事;③ 我们 `shared/` 里 27 处 `script` 是
  **步骤内联脚本**,对不上 C2「公共脚本」这个独立资产库。

---

## 勘误（2026-11-20 同日，测试计划取证回来时对撞出来的）

本文 §2.2 表格写「测试计划 + 计划报告 = `test_plan*` **20 张**」——**多算一张，实测 19 张建表、
GA 删 1 张、活 18 张**。逐条数（`grep -rhoiE "create table[^(]*" --include=*.sql`，全仓而非只 backend/，
两种正则口径互证）：`test_plan` / `_allocation` / `_api_case` / `_api_scenario` /
`_case_execute_history` / `_collection` / `_config` / `_execution_queue` / `_follower` /
`_functional_case` / `_module` / `_report` / `_report_api_case` / `_report_api_scenario` /
`_report_attachment` / `_report_bug` / `_report_component` / `_report_function_case` /
`_report_summary` = **19**；其中 `_allocation` 在 3.0.1 被 `DROP TABLE`（`V3.0.0_12__beta_ddl.sql:32`
建、`V3.0.1_2__ga_ddl.sql:47` 删）。多出来的那张最可能是 `share_info`（通用分享表，靠类型值区分
计划报告）或 `bug_relation_case`（缺陷关联表上挂了计划两列）——都不是 `test_plan*`。

**顺带记一条取数坑（和上面两条同性质）**：`create table[^;]{0,40}?test_plan[a-z0-9_]*` 这种
「宽松邻近」正则会把 **`test_plan_id` 数成第 20 张表**（它是 `bug_relation_case` 的索引列与
`api_scenario_report` 的列名）。数表名必须锚定 `create table` 到第一个左括号之间，不能只靠关键词邻近。
端点数 143 那条**复核无误**。详见 `2026-11-20-ms-testplan-forensics.md` §4。

