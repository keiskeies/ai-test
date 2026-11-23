# 全量复刻总账（D188 · 2026-11-22 业主改口径）

> **建档**：2026-11-22。上游是 `2026-11-20-metersphere-parity-audit.md`（下称「审计」）。
> 本文不重做审计的三档差集，只做两件审计没做的事：**① 记录口径变更**，
> **② 把范围按 controller 粒度摊开**（审计的最小单位是「模块」，最小 35 端点、最大 277 端点，
> 那个颗粒度没法排期）。
>
> 本文所有数字都是 **2026-11-22 在这台机器上现跑**的，取数命令在 §6。
> MS 侧 `D:\item\metersphere` @ `v3.x` / `f1565d99a0`；我们侧 `D:\item\ai-test` @ `main` / `7fc85c6`。

---

## 0. 口径变更（2026-11-22，本文的建档理由）

审计 §0 记的口径是「**先行为后范围，分两批**」，并把 C 档 15 项判成「一律待裁、一条都不做」。

2026-11-22 业主答复（原话「MeterSphere 项目的功能还是需要逐帧复刻」，追问后拍定）：

1. **范围 = 全量复刻，C 档 15 项一并纳入。**
2. **起手 = 先做一轮逐帧对账**，不先写代码。

于是下面这些**不再是结论，是待翻案清单**：

| 被推翻的东西 | 位置 | 冲突点 |
| --- | --- | --- |
| 「C 档 15 项不擅自实现，一条都不做」 | 审计 §2.2 末 | 全部纳入范围 |
| 「商业门（License、插件市场）建议直接裁不做」 | 审计 §4.3 | License/插件在 C 档内，按新口径要做（License 见 §5 待裁） |
| D187 各列「不建 `template_id`/`num`/`pos`/`platform`」的逐列论证 | `backend/app/modules/defect/models.py:74-91` | `template_id` 在 MS 是 **NOT NULL 硬前置**，「不抄模板」等于缺陷表无法与 MS 对齐 |
| D185「评审不做」「版本族不做」 | `plans/2026-11-21-d185-functional-case.md` §一/§五 | 同上，纳入 |
| D187「评论/关注人/附件不做」 | `plans/2026-11-21-d187-defect.md` §一 | 纳入 |

**没有推翻的两条**（复述以免重议）：GPLv3 读语义不抄文件；技术栈不照搬（MS=Java/Spring/Vue/Arco，
我们=FastAPI+SQLAlchemy / React+AntD）。这两条在「全量」下**更要紧**——范围越大，
越容易顺手抄结构，而抄过来的表名与目录约定正是审计 §4 划的线。

---

## 1. 复核：审计的两个数没错，但**口径**要说清（我先错了一次）

我按 `find backend -name "*Controller.java"` 复跑，得到 **121 controller / 1050 端点**，
和审计的 119 / 1047 对不上。**审计是对的，我的取数范围多算了**：

- 多出来的 3 个端点、2 个 controller 全在 `backend/app/`：`IndexController`(2) + `CustomErrorController`(1)，
  前者是 SPA 静态入口、后者是全局异常映射，**不是业务面**。
- 命令口径：`--include=*Controller.java backend/services` = **1047**（复现审计，逐字对上）。

**再加一条审计也没记的**：`backend/services` 的 119 个 controller 里，**7 个 `Ms*Controller` 零 HTTP 端点**
（`MsCountController` / `MsForEachController` / `MsIfController` / `MsLoopController` /
`MsWhileController` / `MsOnceOnlyController` / `MsConstantTimerController`）——它们是场景组件的执行 Bean，
类名带 Controller 但没有 mapping。**真实 HTTP 面 = 112 个 controller**。

⇒ 后面凡是数「有多少个界面要复刻」，分母用 **112**，不是 119 也不是 121。

## 2. 我们侧现状（现跑，`7fc85c6`）

| 维度 | MS `f1565d99a0` | 我们 `7fc85c6` | 备注 |
| --- | --- | --- | --- |
| HTTP 操作 | 1047（112 controller） | **188** | 我们经 `create_app()` + OpenAPI 实数 |
| `@service` 注册项 | — | **185** | 一个 `@service` 同时是路由 + Agent 工具 + 权限位 + 审计点 |
| Agent 工具 | 无此概念 | 141 | 不参与复刻 |
| 权限位 | 223 条 / 58 组 | **104 条 / 16 域** | testplan 是新加的一域（12 条） |

我们侧按域（`REGISTRY.all()` 的 `domain` 字段实数）：
`api 35 / adb 30 / ui 26 / scenario 22 / testplan 16 / agent 9 / system 7 / env 7 / model 6 /
search 6 / notify 6 / schedule 6 / iam 5 / auth 2 / project 1 / workbench 1`。

⚠ **README 的批次表已过期**：仍写「三期 测试计划 未开放」，
而 D183 已交付（`app/modules/testplan/` + 迁移 0024–0026 + `plans.tsx`/`planDetail.tsx`/`planReportDetail.tsx`
+ 5 个 `test_d183_*.py`）。这不是笔误级问题——「菜单里灰着的项带开放批次标注，不做假按钮」
是 README 自己立的规矩，表与树现在互相矛盾。**本轮不动它**（改表要连带核每一行，属独立一刀）。

---

## 3. 逐帧对账的靶子目录：112 个 controller 逐个映射

**图例**：`已有` = 我们有同域实现，差行为；`部分` = 有相邻实现但覆盖不到；`无` = 零对标物（新面）。
「我方」列填的是现查的 domain 或其 `@service` 数。

### 3.1 api-test（28 controller / 242 端点，其中 7 个 Ms* 零端点）

| MS controller | 端点 | 我方 | 判定 |
| --- | --- | --- | --- |
| ApiScenarioController | 35 | scenario 22 | 部分 |
| ApiDefinitionController | 34 | api 35 | 已有 |
| ApiTestCaseController | 34 | api | 已有 |
| ApiDefinitionMockController | 14 | — | **无**（Mock，原 B 档第 4） |
| MockServerController | 5 | — | **无**（同上，Mock 合计 19） |
| ApiDocShareController | 13 | — | **无** = C10 分享链接 |
| ApiScenarioReportController | 13 | api(报告) | 部分 |
| ApiReportController | 12 | api(报告) | 部分 |
| ApiDebugController | 12 | api 内 `api-debug` | 已有 |
| ApiTestController | 11 | 部分 | 部分（含 `/plugin/*` = C7） |
| ApiDefinitionModuleController | 10 | api 模块树 | 已有 |
| ApiTaskCenterController | 9 | — | **无** = 任务中心（§4） |
| ApiScenarioBatchOperationController | 8 | 部分 | 部分（批量 8 端点，D47-d） |
| ApiScenarioModuleController | 8 | scenario | 已有 |
| ApiDebugModuleController | 6 | — | **无**（调试专用的第二棵模块树） |
| ApiDefinitionScheduleController | 5 | schedule 6 | 部分 |
| ApiTestCaseAIController | 5 | agent | **不参复刻**（口径：agent 自研） |
| ApiReportShareController | 3 | — | **无** = C10 |
| ApiExecuteResourceController | 2 | — | **无** = C6 资源池侧 |
| ApiShareController | 2 | — | **无** = C10 |
| ApiScenarioSelectAssociateController | 1 | 部分 | 已有 |

**小计**：无对标 **54 端点** = Mock 19 + 分享 18 + 任务中心 9 + 调试树 6 + 资源池 2（逐条见上表；
第一版这里写的 51 是把五项加错了，按表内数字复加 = 54）。

### 3.2 case-management（15 controller / 127 端点）

| MS controller | 端点 | 判定 |
| --- | --- | --- |
| FunctionalCaseController 28 / FunctionalTestCaseController 12 / FunctionalCaseTrashController 6 / FunctionalCaseModuleController 6 | 52 | **无**（D185 只有计划文档，零代码） |
| CaseReviewController 13 / CaseReviewFunctionalCaseController 12 / ReviewFunctionalCaseController 6 / CaseReviewModuleController 5 / FunctionalCaseReviewController 2 | 38 | **无**（评审，D185 明确推后 → 新口径纳入） |
| FunctionalCaseAttachmentController 11 | 11 | **无** = C12 文件域 |
| FunctionalCaseMinderController 6 | 6 | **无** = C11 脑图 |
| FunctionalCaseDemandController 6 | 6 | **无**（需求关联，MS 走插件 C7） |
| FunctionalCaseRelationshipController 5 | 5 | **无**（用例前后置关系图，D185 未登记的新面） |
| FunctionalCaseCommentController 4 | 4 | **无**（评论） |
| FunctionalCaseAIController 5 | 5 | 不参复刻 |

### 3.3 test-plan（13 controller / 143 端点）—— D183 已交一半

| MS controller | 端点 | 我方 | 判定 |
| --- | --- | --- | --- |
| TestPlanController | 24 | testplan 16 | 部分 |
| TestPlanReportController | 23 | testplan | 部分 |
| TestPlanFunctionalCaseController | 19 | — | **无**（依赖功能用例库） |
| TestPlanApiCaseController | 17 | testplan | 部分 |
| TestPlanApiScenarioController | 17 | testplan | 已有 |
| TestPlanReportShareController | 16 | — | **无** = C10 |
| TestPlanTaskCenterController | 9 | — | **无** = 任务中心 |
| TestPlanAssociateController 5 / TestPlanModuleController 5 / TestPlanExecuteController 3 | 13 | 部分 | 部分 |
| TestPlanCollectionMinderController 2 / TestPlanFunctionalCaseMinderController 2 | 4 | — | **无** = C11 |
| TestPlanBugController | 1 | — | **无**（依赖 D187） |

### 3.4 project-management（22 controller / 173 端点）—— C 档最密集的一层

| MS controller | 端点 | 判定 |
| --- | --- | --- |
| ProjectApplicationController | 22 | **无** = C3 项目应用开关 |
| ProjectTaskHubController | 19 | **无** = 任务中心（§4，新浮出） |
| EnvironmentController | 13 | env 7 → 部分 |
| FileManagementController | 13 | **无** = C12 |
| ProjectMemberController | 11 | iam 5 → 部分 |
| ProjectUserRoleController | 10 | 部分 = C14（我们有 custom_role，差组织级） |
| ProjectTemplateController | 9 | **无**（模板，MS `template_id` 硬前置） |
| CustomFunctionController | 8 | **无** = C2 公共脚本 |
| FileRepositoryController | 8 | **无** = C12 |
| ProjectController | 8 | project 1 + iam → 部分 |
| EnvironmentGroupController | 7 | **无** = C1 |
| ProjectStatusFlowSettingController | 7 | **无** = C9 |
| ProjectRobotController | 6 | notify → 部分 |
| FakeErrorController | 5 | **无** = C15 |
| FileModuleController | 5 | **无** = C12 |
| GlobalParamsController | 5 | 部分（我们 `global_config` 语义不同，审计 §6 已核） |
| ProjectCustomFieldController | 5 | **无**（自定义字段） |
| NoticeMessageTaskController 4 / NoticeTemplateController 1 | 5 | notify 6 → 部分 |
| FileAssociationController 3 / FilePreviewController 2 | 5 | **无** = C12 |
| ProjectLogController | 2 | audit → 已有 |

**C12 文件域合计 31 端点**（13+8+5+3+2），与审计一致。

### 3.5 system-setting（32 controller / 277 端点）

| MS controller | 端点 | 判定 |
| --- | --- | --- |
| TaskCenterController | 24 | **无** = 任务中心 |
| SystemTaskHubController | 22 | **无** = 任务中心 |
| OrganizationTaskHubController | 20 | **无**（组织级，见 §5 三倍化） |
| SystemOrganizationController 17 / OrganizationController 10 / OrganizationProjectController 16 / OrganizationUserRoleController 10 / OrganizationTemplateController 9 / OrganizationStatusFlowSettingController 7 / OrganizationCustomFieldController 5 / OrganizationLogController 3 | **77** | **组织层整块无**——见 §5；另有 `OrganizationTaskHubController` 20 已计入 §4 任务中心 ⇒ **组织级 controller 共 9 个 / 实测 97 端点** |
| UserController | 17 | iam → 部分 |
| SystemProjectController | 15 | 部分 |
| SystemParameterController | 10 | system 7 → 部分 |
| PersonalCenterController | 8 | **无** = C8 |
| PluginController | 7 | **无** = C7 |
| ServiceIntegrationController | 7 | **无** = C4 |
| UserApiKeysController | 7 | **无** = C5 |
| TestResourcePoolController | 5 | **无** = C6 |
| GlobalUserRoleController 6 / GlobalUserRoleRelationController 4 | 10 | iam → 部分 |
| UserViewController 6 / UserLocalConfigController 6 / BaseDisplayController 4 / UserPlatformAccountController 5 | 21 | 部分（我们有 `saved_view` 迁移 0023，余无） |
| NotificationController | 5 | notify → 部分 |
| AiConversationController 6 / SystemAIConfigController 5 | 11 | 不参复刻（model_cfg + agent 自研） |
| OperationLogController | 3 | audit → 已有 |
| LoginController | 4 | auth 2 → 已有 |
| LicenseController | 2 | **无** = C13（待裁，§5） |
| SystemVersionController | 2 | **无** |

### 3.6 bug-management（6 / 50）、dashboard（3 / 35）

- **bug**：BugController 21、**BugAttachmentController 12**、BugRelateCaseController 7、
  BugTrashController 5、BugCommentController 4、BugHistoryController 1。
  ⇒ 我方 = `defect` 模块两列两表、**零 `@service`**。附件那 12 个端点是 MS 缺陷面的 24%，
  正是 D187 裁掉的那块。
- **dashboard**：DashboardController 24（自定义卡片）、MyViewController 7、ToDoController 4。
  我方 workbench 1 个 service（统计卡简化版）⇒ 差的是「卡片可增删 + 个人视图 + 待办流」，与审计结论一致。

---

## 4. 新浮出：**任务中心一族 ≈ 103 端点**，审计从未单列

审计的 C 档 15 项里**没有**任务中心，§1 量级表把它揉进了「组织三级与系统面 277」。
逐 controller 摊开才发现它的真实形状：

| controller | 端点 | MS summary 原文（`grep -oE '@Operation\(summary = "[^"]*"'` 实抄） |
| --- | --- | --- |
| TaskCenterController | 24 | 「系统/组织/项目-任务中心-定时任务列表」「…-删除定时任务」「…-定时任务开启关闭」「…-修改定时任务」「…-定时任务批量开启」「…-定时任务批量关闭」「…-定时任务总数」「…-实时任务总数」 |
| SystemTaskHubController | 22 | 「系统-任务中心-执行任务列表」「…-后台执行任务列表」「…-用例执行任务详情列表」「…-获取任务统计{通过率}接口」「…-获取资源池下拉选项」「任务详情节点状态接口」「…-用例执行任务-停止任务/重跑任务/批量停止任务/删除任务/批量删除任务」「…-获取任务项的排队信息」 |
| OrganizationTaskHubController | 20 | 同上形状，组织级；另有「获取全部组织下拉选项」「获取全部项目下拉选项」「获取组织下全部项目下拉选项」 |
| ProjectTaskHubController | 19 | 同上形状，项目级 |
| ApiTaskCenterController | 9 | 「项目/组织/系统-任务中心-接口用例/场景-实时任务列表」×3、「…-接口用例/场景-停止任务」×6 |
| TestPlanTaskCenterController | 9 | 「项目/组织/系统-任务中心-测试计划-实时任务列表」×3、「…-接口用例/场景-停止任务」×6 |

⚠ **上面最后两行的「停止任务 ×6」是 MS 自己的文案错位，不是我有笔误**：
`TestPlanTaskCenterController` 里 6 条 stop 端点的 summary 写的是「**接口用例/场景**」（从 Api 那份复制来的），
`ProjectTaskHubController` 里也有一条写着「**系统**-任务中心-…排队信息」。
**这条要记着**：MS 的 summary 不能当唯一键用，逐帧对账时得按路径 + 方法体认端点。

**两条判读，都不该被「全量复刻」四个字盖过去**：

1. **三倍化是实测的**。按 summary 剥掉「系统/组织/项目-任务中心-」前缀再去重：

   | 组 | 端点 | 剥前缀后按文案去重 |
   | --- | --- | --- |
   | TaskCenterController | 24 | 8 |
   | System + Organization + Project TaskHub | 61 | 23 |
   | ApiTaskCenterController | 9 | 2 |
   | TestPlanTaskCenterController | 9 | 2 |
   | **合计** | **103** | **35** |

   ⇒ 约 **2/3 是同一个操作乘三次层级**（`PermissionConstants` 里对应
   `SYSTEM_TASK_CENTER:READ` / `ORGANIZATION_TASK_CENTER:READ` / `PROJECT_TASK_CENTER:READ` 三枚位），
   我们**只有项目一级**（组织/工作区两张表建了没用）。
   ⚠ **35 这个数有两个已知失真**：① 上面那条文案错位会污染按文案的去重；
   ② 文案相同**不等于**实现相同——Api/TestPlan 各 6 条 stop 极可能是「单个停止 + 批量停止」
   共用同一句 summary，那样 2 应为 4。⇒ **35 是按文案的下界，真数要逐 controller 读方法体**（属 §6 的一刀）。
2. **另约 1/3 是真能力，不是重复**：MS 有「正在排队 / 正在执行 / 后台任务」三态的运行观测面——
   排队位置、通过率统计、单任务停止与重跑、后台任务与执行任务分列。
   我们有 Celery worker 投递、SSE 实时进度、失败单步重跑，**但没有队列可观测面**：
   排了多少、谁在跑、能不能停一个正在跑的任务、后台导入导出的进度，全部无处可看。
   ⇒ 这一格**不能记成「三倍化所以不用做」**，它是我们的真实缺口。

---

## 5. 三个「全量」这个词没有回答的问题（要业主裁，别我裁）

1. **要不要三级组织模型？** 两个口径都现跑了，**它们不一致，而差异本身就是这条要裁的理由**：
| 口径 | 量法 | 实测 |
| --- | --- | --- |
| 按 **controller 归属** | `find -ipath "*rganization*"` 逐个数 mapping | **9 个 controller / 97 端点**（含 TaskHub 20；不含则 77） |
| 按 **summary 层级前缀** | 1038 条 summary 里以「组织」开头 | **仅 33 条** |

   差 64 条的原因是**大量组织级端点的 summary 不带「组织」二字**（例：`OrganizationTemplateController`
   的模板 CRUD、`OrganizationCustomFieldController` 的字段 CRUD 都不带前缀）。
   ⇒ **没有任何一句 grep 能答「哪些端点属于组织层」**，只能逐端点读——这既是 §6 那一刀存在的理由，
   也说明**别拿「组织层 97 端点」当决策依据**：它是**下界**，各模块内的组织级分身尚未计入
   （TaskCenter 8 操作里的组织级 1/3、Api/TestPlanTaskCenter 各 3 条）。
   我们只有项目一级（组织/工作区两张表建了没用）。
   **裁「要」** ⇒ iam/权限/菜单/审计全都要加一层 scope，是横切改造，不是加模块；
   **裁「不要」** ⇒ ≥97 端点直接出局，且**这一层牵动权限模型，不是加页面**。权限位现量
   （223 条，按「常量名首段，取不到再取值首段」归一）：
   **PROJECT 119 / SYSTEM 59 / ORGANIZATION 31 / 判不出层级 14** ⇒ 组织级占 **14%**。

   ⚠ **那 14 条「判不出层级」是真发现，不是取数噪音**：`FUNCTIONAL_CASE_*`（8）与
   `CASE_REVIEW_*`（6）的名字与值**都不带层级词**（`FUNCTIONAL_CASE_READ → "FUNCTIONAL_CASE:READ"`），
   它们挂在哪个 scope **只能读代码里的映射表**才知道。同族对照：`TEST_PLAN_*`（11 条）名字无层级词、
   值有（→ `PROJECT_TEST_PLAN`），所以归 PROJECT。
   ⇒ **这是本仓第三次撞到「字符串前缀推不出归属」**（前两次：MS 端点的 summary 前缀、
   `Ms*Controller` 类名）。逐帧对账时，层级/归属一律要读到实现，不能靠命名。
   ⚠ 另记一条会直接影响复刻口径的量：**223 条权限位里 157 条的值是 `READ+ADD` 这类组合动作**，
   即 MS 的权限点是「动作包」而非原子动词；我们是 104 条原子位。**照搬位名等于照搬它的打包方式。**
   2026-11-22 那一问没覆盖它，我不能替业主定。
2. **License（C13，2 端点）做不做？** 它是 MS 商业版的功能门。复刻它意味着我们的表里要有一个
   自己给自己上锁的开关。审计建议直接裁不做，但那是旧口径下的建议。
3. **插件体系（C7，7 端点 + `ApiTestController:/plugin/*`）** 的复刻目标是什么？
   MS 的插件是**装载第三方 jar 扩展协议**；我们没有插件市场，也没有第三方生态。
   照搬装载机制 = 造一个没人供件的空插槽；等价替代 = 把 `shared/assertions.py` 与协议分发改成可注册表。
   这两件事工作量与价值完全不同，得选一个。

---

## 6. 逐帧对账怎么跑（本轮定的方法，不是待办）

一个 controller 一刀。每刀产**两张表**，落 `docs/`（对账）→ 再开计划文件（实做）：

- **表 1 契约差集**：MS 每个端点一行 → 我方端点 / 差异（缺哪个、语义不同在哪）。
- **表 2 字段差集**：MS 每张表逐列 + 每个 DTO 校验注解 → 我方列 / 缺列 / 类型不同。

判据沿用审计 §6 那两个坑（`grep -c` 数行不是数文件；**关键词命中 ≠ 功能存在**，
必须读 `summary` 与实现体原文），再加一条：**「MS 有这列」不等于「我们该有这列」**——
D185/D187 那两张「不做」表里，有相当一部分理由（有 schema 没写入方、静默类型丢弃）
是 MS 自己的病。**复刻行为，不复刻病**；要故意不跟的，照 D187 §三 的写法逐条给可复跑的理由。

排期建议（按「依赖方向」而不是按端点数）：

| 序 | 靶子 | 端点 | 为什么在这个位置 |
| --- | --- | --- | --- |
| 1 | bug-management 6 个 | 50 | 在途件（D187 有 models）。⚠ **D190 对账后修正**：50 条里只有 **25 条不依赖地基**（`docs/2026-11-22-d190-defect-framediff.md` §1.7），其余 **23 条等模板/EAV + 文件库 + 三方**、2 条待裁 ⇒ 本行原写的「不依赖任何未建地基」**错**，应为「**可先交前 25 条，后半与 2/3 同刀**」 |
| 2 | 模板 + 自定义字段（Project/Organization 各 2 个）+ **跨域取号 `num`** | 28 | `template_id` 是缺陷与用例的 **NOT NULL 硬前置**，卡在 1 与 3 之间。`num` 经 D190 核实是**跨模块取号服务**（MS `NumGenerator.java:21`，调用方跨 4 域 + `SUB_NUM` 白名单 5 类），且列表页 ID 列就是它 ⇒ 与模板同级，不能留给缺陷模块自己加列 |
| 3 | 文件域 5 个（C12） | 31 + 用例附件 11 | 缺陷附件 12 端点与用例附件 11 端点共用它 |
| 4 | case-management 其余 | 85 | 依赖 1–3 |
| 5 | 任务中心（去重后 ≈35 操作） | 103 | §4 第 2 条那块观测面是真缺口，但要先把 worker 侧的排队信息落库 |
| 6 | test-plan 补全 + 分享 18 + 脑图 | 剩余 | 依赖 4 |
| 7 | C 档余项（C1–C15 去掉已排的） | ≈100 | 每项先答 §5 三类问题 |

## 7. 取数命令（全部 2026-11-22 真跑）

```bash
# MS：HTTP 面必须限 backend/services，且要单独排除零端点的 Ms*Controller
cd D:/item/metersphere && git log --oneline -1        # f1565d99a0
grep -rhoE "@(Get|Post|Put|Delete|Patch)Mapping" --include=*Controller.java backend/services | wc -l   # 1047
find backend/services -name "*Controller.java" | wc -l                                                # 119
for f in $(find backend/services -name "*Controller.java"); do
  [ "$(grep -cE '@(Get|Post|Put|Delete|Patch)Mapping' "$f")" = 0 ] && echo "0 $(basename $f .java)"; done  # 7 个 Ms*
# 逐 controller 计数（本文 §3 的表全部出自这条）
for f in $(find backend -name "*Controller.java" | sort); do
  n=$(grep -cE "@(Get|Post|Put|Delete|Patch)Mapping" "$f"); echo "$n|$(basename $f .java)"; done

# 我们侧：必须经 create_app()，逐个 import modules 会得到 services=0（审计 §6 已记过一次）
cd D:/item/ai-test/backend && .venv/Scripts/python.exe -I -c "
import sys, collections; sys.path.insert(0,'.')
from app.main import create_app
from app.core.registry import REGISTRY
app=create_app(); spec=app.openapi()
svc=REGISTRY.all()
print('services',len(svc),'perms',len(REGISTRY.perm_points()),'tools',len([t for t in svc if t.tool]),
      'ops',sum(len([m for m in v if m in ('get','post','put','patch','delete')]) for v in spec['paths'].values()))
for k,n in collections.Counter(s.domain for s in svc).most_common(): print(n,k)"
# services 185 perms 104 tools 141 ops 188
```

**本轮新踩的坑（补进审计 §6 那两个）**：
**`find backend` 与 `--include=*Controller.java backend/services` 不是一回事**。
前者把 `backend/app/` 的 SPA 入口与全局异常映射算进业务面，多报 2 controller / 3 端点。
量级差 0.3% 无所谓，**但 controller 是本文的排期最小单位**，
分母从 121 变 112 会让「还剩多少个界面」这种话直接说错。

---

## 8. 第 1 刀交付：缺陷域服务面（D191，2026-11-23）

§6 排期表第 1 位（bug-management 6 controller / 50 端点）按 D190 的边界交付了**可立即做的
25 条**，落成 **24 个 `@service`**（MS 的 `/bug/page` 与 `/bug/trash/page` 折叠成一个
`defect_list` + `recycled` 谓词，先例 = ui_case 列表）。

**代码形状**：

- 迁移 `0028`：`defect` 加 `tags` / `delete_user` / `delete_time`，`title` 200→255；
  新表 `defect_follower`（复合主键 (defect_id,user_id)）与 `defect_comment`（两层嵌套）。
- 服务：核心 CRUD/存在性/批量/导出 10、回收站 4、关联用例 4、评论 4、关注 2。
- 权限：`defect:defect:{read,create,update,delete,comment}` + `defect:link:update`
  （原子位；不抄 MS 的 READ+ADD 组合位）。内置角色靠通配自动覆盖，`sync_perm_points` 零迁移入库。
- 前端：`pages/defects.tsx`（列表/筛选/批量标签/回收站/导出）、`pages/defectDetail.tsx`
  （基本信息/评论/关联用例/关注）、`api/defect.ts` 镜像、菜单「测试跟踪」与两条路由。
- 测试：`tests/test_d191_defect_services.py`（10 条）、`web/src/pages/defects.test.tsx`（7 条）；
  迁移 down/up/down 真跑（`scripts/check_migration_down.py 0028`）。

**与 MS 的主动分歧**（D190 §5，逐条有用例钉住）：写操作一律 POST + 写位；状态流转写路径
真校验（非法 409）；恢复清空 delete_user/delete_time；彻底删除同事务清三张子表；关联用 DDL
唯一键判重；CSV 导出做公式注入中和。

**仍然缺的 25 条**（每条点名地基，不是「暂时不知道怎么做」）：模板/EAV 4、三方同步 4、
附件 12（C12 文件库）、模块树 2、拖拽 `pos` 1、字段级变更历史 1、跨域关联权预检 1（待裁）。

**同轮修正的上游账**：D187 测试里「defect 不建 tags/delete_\*」的清单、四份模型测试的
迁移链头（0027→0028）、权限矩阵的已知前缀族（新增 `defect`）、前端 `WRITE_TAIL`（新增
`comment`）——四处都是旧口径/旧快照，不改会与新实现互相矛盾。

---

## 9. 第 2 刀交付：项目级元数据（D192，2026-11-23）

§6 排期第 2 位（模板 + 自定义字段 + 跨域取号，28 端点）先落了**项目级 12 条公开端点 + 2 条内部服务**
（组织级 9+9 随三级组织模型；图片上传随文件库 C12）。

**代码形状**：

- 新域 `app/modules/project_meta/`：`project_template` / `project_template_field` /
  `project_custom_field` / `project_custom_field_option` / `num_sequence` 五张定义表；
  迁移 `0029`；值表 `defect_custom_field` 归缺陷域。
- 公开面：模板 list/get/create/update/delete/set-default/enable-config（7）+
  自定义字段 list/get/create/update/delete（5）。
- 内部服务（`http=None`、`tool=False`）：`project_template_resolve`（按场景取默认/指定模板 →
  字段+选项+默认值）、`project_num_next`（DB 单行原子 upsert，非 MS 的 Redis-only）。
- 缺陷接入：`defect.num`（项目内唯一，100001 起）与 `defect.template_id`（NOT NULL）；
  创建/更新按模板校验必填/类型/选项，值 JSON 落 `defect_custom_field`；彻底删除同事务清值。
- 主动不跟 MS 的病：DDL 唯一键（模板名/字段键/模板-字段对）、删模板/删字段的引用护栏、
  选项 value 在使用中不可删、字段类型创建后不可改、DB 取号而非 Redis。
- 前端：`settings/ProjectMetaTab.tsx`（模板/字段 CRUD、设默认、选项编辑）、
  `ui/CustomFields.tsx`（13 种字段类型控件）、缺陷列表/详情/新建接入动态字段。
- 测试：`tests/test_d192_project_meta.py`（8 条）+ `settings/ProjectMetaTab.test.tsx`（4 条）；
  迁移 down/up/down 真跑。

**仍然缺的**：组织级模板/字段（等三级组织模型）、模板图片上传（等文件库）、
MS 的 `/bug/header/custom-field` 与 `/bug/header/columns-option` 的同形端点
（行为已由 templates 详情 + list 的 custom_fields 覆盖，端点数未凑齐）。


---

## 10. 第 3 刀交付：功能用例本体（D193，2026-11-23）

D185 计划的最小闭环在 D192 之后落地：**16 个 `@service` + 迁移 0030 + 列表/详情页**。

- 表：`functional_case`（num/template_id NOT NULL、项目内唯一 num、normal/回收站）、
  `functional_module`（第 5 份模块树）、`functional_case_custom_field`（EAV JSON 值）。
- 服务：模块树/创建/更新（防环）/回收/恢复/彻底删除（非空拒绝）+ 用例 CRUD/
  回收站/批量 + 模板必填/类型/选项校验 + 项目内取号。
- 前端：`pages/functionalCases.tsx`（ModuleTree 复用 + 动态字段 + 回收站）、
  `functionalCaseDetail.tsx`；菜单「功能用例」解禁；设置页模板/字段的 functional 场景可用。
- 测试：`tests/test_d193_functional_case.py`（4 条）、`functionalCases.test.tsx`（4 条）、
  迁移 down/up/down。
- 评审（约 38 端点）仍在 D194；附件/脑图/需求关联/关系图/评论仍缺。


---

## 11. 第 4 刀交付：用例评审（D194，2026-11-23）

D185 §一推后的 38 端点评审面落地，落成 **22 个 `@service` + 迁移 0031 + 列表/详情页**。

- 表：`case_review`（num/通过规则/时间窗/started，**不存 status/pass_rate/case_count**）、
  `case_review_module`（评审专用树，非空拒绝）、`case_review_case`（当前结论 pending/pass/fail
  与 re_review）、`case_review_reviewer`（per-case 唯一一张评审人表）、
  `case_review_result`（append-only 历史，active 标记）。
- 服务：模块树 6 + 评审 list/create/get/update/delete 5 + 评审内用例 list/associate/
  disassociate/batch/reviewers 6 + 结论 submit/batch/re-review/batch 4 + history/case-side 2。
- 主动不跟 MS 的病：不建 ARCHIVED 与空快照表；状态/通过率读时聚合；结论在提交事务内重算；
  评审人只一张表；历史 append-only；删除非空模块拒绝（不级联删评审）。
- 前端：`pages/caseReviews.tsx`、`caseReviewDetail.tsx`；菜单「用例评审」；功能用例详情新增
  「所在评审」；结论/历史/重审/批量评审人全接。
- 测试：`tests/test_d194_case_review.py`（6 条）、`caseReviews.test.tsx`（4 条）、
  迁移 down/up/down。
- 仍缺：评审快照归档（MS 自己也没写）、通知钩子、附件意见、评审评论、评审关注人。


---

## 12. 第 5 刀交付：文件库 / 附件（D195，2026-11-23）

C12 文件域先落**内容层与项目仓库层**，并把缺陷/用例附件接上（D190/D193 里「等文件库」
的 23 条由此解耦）。

- 表：`file_blob`（project+sha256 唯一，内容寻址）、`file_folder`（目录树）、
  `file_entry`（仓库条目，留 root/version/is_latest）、`file_link`（bug/functional_case ×
  attachment/richtext，硬删）。迁移 0032。
- 存储：本地磁盘 `files/{project}/{sha[:2]}/{sha}`；`storage_key` 是抽象键，换 S3 只换
  put/open/delete。单文件 50MB 上限。
- 路由：`POST /files/upload`（multipart，建仓库条目）、`POST /files/blobs`（附件专用，
  只建 blob）、`GET /files/{blob}/content`（鉴权字节流，inline/attachment）。
- 服务：目录树 CRUD/回收 6、仓库文件 list/get/update/delete/restore/purge 6、
  附件 link/list/delete 3、内部 `file_target_purge`（缺陷/用例彻底删除时同事务清链接与零引用 blob）。
- 前端：`pages/files.tsx`（目录树 + 上传 + 下载 + 编辑/回收站）、`ui/Attachments.tsx`
  （缺陷/用例详情共用）；菜单「文件管理」。
- 主动不跟 MS 的病：一套附件模型、预览/下载都鉴权、删文件/删链接做引用计数、不把用户
  文件名当存储路径、不做三份附件表。
- 测试：`tests/test_d195_filelib.py`（6 条）、`files.test.tsx`（3 条）、
  `Attachments.test.tsx`（3 条）；迁移 down/up/down。
- 仍缺：文件版本重传 UI、批量下载 zip、Git 仓库接入、富文本编辑器内嵌贴图（后端 role=richtext
  已通）、文件与测试计划/接口的关联面。


---

## 13. 第 6 刀交付：任务中心观测面（D196，2026-11-23）

总账 §4 那一格「排队可观测面」落地：**6 个 `@service`，无新表**，数据源 = `run_record`
（反射）+ Celery 队列（Redis）。

- `send_task(..., task_id=run_id)`：队列消息的 headers.id 就是 run id，位次可查。
- 服务：summary（状态计数/活跃数/通过率/平均耗时）、list（active/finished、域/触发/关键词）、
  queue（项目 queued + Redis `LRANGE` 解析位次与队列总长，Redis 不可用如实 `available=false`）、
  detail（run 头 + stats + 步骤状态计数）、stop（复用 `run_cancel` 的域权限与取消旗）、
  rerun（scenario/ui_case/adb_case 派发到原执行服务；api_case 等如实 422）。
- 前端：`pages/taskCenter.tsx`（概览卡 + 运行中/已结束 + 停止/重跑 + 详情）；菜单「任务中心」。
- 测试：`tests/test_d196_taskcenter.py`（4 条，fakeredis 隔离）、`taskCenter.test.tsx`（3 条）。
- 仍缺：后台导入/导出任务（当前同步，无表）、组织/系统两级任务中心（三级组织模型）、
  通过率趋势图、资源池排队（C6）。


---

## 14. 第 7 刀交付：功能用例评论 + 前后置关系（D197，2026-11-23）

用例域剩下的两块低成本面落地，**7 个 `@service` + 迁移 0033**。

- 表：`functional_case_comment`（两层嵌套、父删连子删）、`functional_case_relation`
  （有向边 from→to，`relation_type=predecessor` 表示 from 是 to 的前置；同项目唯一）。
- 服务：评论 list/add/update/delete（仅创建人可改/删，权限 `functional:case:comment`）+
  关系 list/add/delete（自环 422、直接反向环 409、同边幂等；权限 `functional:case:update`）。
- 用例彻底删除同事务清评论与关系；软删/恢复保留。
- 前端：`ui/CaseComments.tsx`、`ui/CaseRelations.tsx` 接入用例详情。
- 测试：`tests/test_d197_case_comment_relation.py`（4 条）、迁移 down/up/down。
- 仍缺：评论 @ 提及/贴图（富文本地基已有 role=richtext）、跨类型用例关联、需求关联、脑图。


---

## 15. 第 8 刀交付：个人中心 + API Key（D198，2026-11-23）

C8 个人中心与 C5 用户密钥落地：**7 个 `@service` + 迁移 0034**。

- 个人面（`auth:self`，dynamic_perm）：资料 GET/PATCH（prefs 合并）、最近项目（按项目更新时间）、
  我的资产（跨域表名反射计数）、API Key list/create/revoke。
- API Key：`tp_` 前缀 + `secrets.token_urlsafe(32)`，只存 sha256；明文只在创建响应出现一次；
  `get_current_user` 同时接受 JWT 与 API Key（同一 Bearer 头），吊销/过期/停用统一 401。
- 前端：`pages/me.tsx`（资料/偏好、资产、最近项目、Key 签发与吊销、明文一次性弹窗）；
  用户菜单新增「个人中心」。
- 测试：`tests/test_d198_personal_apikey.py`（3 条，含 API Key 真鉴权与吊销后 401）、
  `me.test.tsx`（3 条）；迁移 down/up/down。
- 仍缺：语言真正切换 i18n（当前只存 prefs）、头像上传（文件库已有）、个人待办流
  （与任务中心/评审待办合并）。


---

## 16. 第 9 刀交付：项目应用开关 + 误报库（D199，2026-11-23）

C3 项目应用开关（8 项）与 C15 误报库落地：**8 个 `@service` + 迁移 0035**。

- `project_application`：(project_id,key) 覆盖表，无行 = 代码默认；8 项含
  functional.re_review / bug.sync / api.test / ui.test / testplan.enable / mock.enable /
  share.enable / minder.enable。
- `fake_error`：名称项目内唯一，match_type contains/exact/regex（regex 先编译校验），
  enabled 开关，CRUD 5 条。
- **真实联动**：`functional.re_review` 默认开——功能用例名称/描述实际变化时，经 REGISTRY
  调 review 的 `review_case_auto_re_review`，把该用例在所有评审里置 pending + re_review
  并作废旧结论；关掉开关则不触发（用例测试钉正反两面）。
- 前端：设置页「项目设置」Tab（分组开关 + 误报规则 CRUD）。
- 测试：`tests/test_d199_project_settings.py`（4 条，含开关联动的正反两面）、迁移 down/up/down。
- 仍缺：bug.sync/mock/share/minder 等开关的消费者（对应模块后续落地）、误报规则在执行
  结果里的匹配标记（消费者待接）。


---

## 17. 第 10 刀交付：环境组 + 公共脚本（D200，2026-11-23）

C1 环境组与 C2 公共脚本落地：**13 个 `@service` + 迁移 0036**。

- `environment_group` + `environment_group_item`：组名项目内唯一；env 多对多；
  append/replace 两种加环境方式；删组不删环境。
- `public_script`：名称项目内唯一，语言 python/javascript/groovy/shell，内容更新 version+1，
  启停独立端点；不做任意脚本执行（执行沙箱是独立安全题，未在本刀开放）。
- 前端：设置页「项目设置」下新增环境组/公共脚本两个面板。
- 测试：`tests/test_d200_env_group_public_script.py`（3 条）、迁移 down/up/down。
- 仍缺：环境组在执行入口的一键选择（消费者）、脚本版本历史与执行沙箱、Git 服务集成（C4）。


---

## 18. 第 11 刀交付：API Mock（D201，2026-11-23）

Mock 19 端点收敛为 **11 个 `@service` + 1 条公开 router + 迁移 0037**。

- `mock_service`（项目内唯一、启停）+ `mock_rule`（method/ANY、path exact/prefix/regex、
  状态码、响应头 JSON、响应体 Text、延迟 ≤5s、优先级、启停）。
- 公开入口 `/mock/{service_id}/{path:path}`（**不鉴权**，Mock 的用途）；服务停用/规则未命中
  404；规则按 priority desc、created_at 选取。Vite dev/preview 已加 `/mock` 代理。
- 服务/规则 CRUD + 试匹配端点；regex 先编译校验；服务删除级联规则。
- 前端：`pages/mock.tsx`（服务/规则/公开地址复制/试匹配）；菜单「API Mock」。
- 测试：`tests/test_d201_mock.py`（3 条，含公开路由与优先级）、`mock.test.tsx`（3 条）、
  迁移 down/up/down。
- 仍缺：Mock 命中日志/请求记录、按请求体/查询串匹配、Mock 分享/环境变量替换。


---

## 19. 第 12 刀交付：公开分享链接（D202，2026-11-23）

C10 分享收敛为 **4 个 `@service` + 1 条公开 router + 迁移 0038**，只做「必须登录才能看的东西，
给一个不带账号的人看」这一件事，不做评论/协作式的对外站点。

- `share_link`：`token`（secrets 随机、唯一）、`target_type` ∈ report/plan_report/api_doc、
  `target_id`、标题快照、`password_hash`（bcrypt，可空）、`expires_at`、`revoked_at`、
  `view_count` / `last_viewed_at`、`created_by`、`project_id`。
- 目标解析在创建时校验一次（不存在/跨项目 404），**公开读时再校验一次**（目标被物理删除即 404，
  不拿快照冒充仍存在）；报告载荷是 `run_record` 的 stats/summary_graph 快照字段，
  计划报告载荷含生成时刻的明细行，接口文档载荷含 `request` 定义。
- 公开读 `GET /api/v1/share/{token}`（**不鉴权**）：吊销/不存在 404、过期 410、
  要密码/密码错 401（`details.password_required`）；密码可走 `?password=` 或
  `X-Share-Password`。每次成功读取 `view_count += 1`。
- 前端：`pages/shareView.tsx` 挂在 `/#/share/:token`，**在 RequireAuth 之外**；
  公开读走裸 fetch（`client.ts` 的 401 会登出跳转，而「要密码」正是 401）。
  `ui/ShareButton.tsx` 接进报告详情、计划报告详情、接口详情抽屉（缺 `share:link:create` 不渲染）。
- 测试：`tests/test_d202_share.py`（4 条：公开读/计数、密码+过期+吊销、计划报告明细、
  权限与跨项目）、`shareView.test.tsx`（4 条：载荷渲染/不碰登录态、密码门、404+410、创建 body）、
  迁移 down/up/down。
- 仍缺：分享页里的截图/制品（当前载荷刻意只含报告快照，不含原始字节）、
  分享访问审计列表、项目级 `share.enable` 开关的消费者（D199 已建开关，消费点待接）。


---

## 20. 第 13 刀交付：D203 平台设置（2026-11-23 收口）

上一轮 Qoder 会话在 D202 之后开过 D203（服务集成/资源池/插件/系统版本/License），
代码与迁移 0039 已落但会话中断；本轮补齐验收与前端面板：

- `app/modules/platform_ops/`：21 个 `@service`（服务集成 7、资源池 5、插件 7、系统版本 1、
  License 1），迁移 `0039_platform_ops`（三张项目级表）。
- **接线修正**：`main._SERVICE_MODULES` 此前漏了 `platform_ops.services`——代码在库、路由却
  全是 404（测试首跑当场暴露）。已补一行 import。
- 测试 `tests/test_d203_platform_ops.py`（6 条）：
  - 服务集成：token 加密落库、响应只回末 4 位且无明文键；`None` 保留 / 空串清除；
    `base_url` 只收 http(s)；重名 409；启停与删除。
  - 资源池：容量 1..1000（0/1001/坏类型均 422）；名称项目内唯一；改容量与启停。
  - 插件：config 建与改都校验 JSON，改失败不落半截值；`loadable` 恒 False，meta 写明
    「没有动态装载点」——启用开关不冒充已装载。
  - 系统信息：`migration_head` 读真 `alembic_version`（测试塞哨兵值证明不是硬编码）；
    社区版 `licensed=True / enforced=False`。
  - 项目隔离与权限：跨项目 404；READONLY 可读、写 403 且 `details.perm` 指名。
  - 表形状 = 迁移：三张表列集合与 ORM 一致。
- 前端：设置页新增「平台运维」Tab（`settings/PlatformOpsTab.tsx` + `api/platformOps.ts`），
  三块列表/新建/编辑/启停/删除；令牌只显示 hint；插件「装载」列恒「未装载」；
  编辑集成时平台类型锁住（后端 update 不含 kind，避免「改了没生效」）。
- 前端测试：`PlatformOpsTab.test.tsx` 6 条 + `settings.test.tsx` Tab 集合同步（12 条全绿）；
  tsc/eslint 干净；web 全量 vitest 绿。
- 全域守卫同步（接线后第一次跑出来的欠账，一并收）：
  - `test_permission_matrix.py`：新增 3 个前缀族（integration/plugin/resource）+ 4 行
    （三块列表 + 平台级 system_info），17 格实测 2xx/403 与角色表一致。
  - `test_r157_project_scope_coverage.py`：5 条 `http=None/tool=False` 的内部件入白名单并写明
    「外层已带门、同事务直调」（project_num_next / project_template_resolve /
    project_application_enabled / file_target_purge / review_case_auto_re_review）。
  - `test_r158_readonly_verb_drift.py`：前端 `WRITE_TAIL` 补 `execute`（D204 的新写动词，
    此前会让挂 `testplan:functional:execute` 的自定义角色被误判只读）。
  - `test_d110_read_perm_write_sentinel.py`：`defect_export` / `mock_rule_test` 两条
    「POST 只承载参数、函数体只读」裁决；三条内部写件的审计承载写明。
  - `test_role_services.py`：迁移链头断言 0038 → 0040（D204/D205 欠账）。
- 仍缺（有意不动，安全边界见 `platform_ops/models.py` docstring）：集成连通性测试
  （SSRF 面）、资源池真正调度、插件动态装载（任意代码执行面）。


---

## 21. 第 14 刀交付：计划内功能用例（D204，2026-11-23）

测试计划主链路此前只能挂接口/场景/UI/ADB 四类，**功能用例（D193 本体）挂不进计划**。
D204 把它接入，并解决「功能用例是人工执行、没有 run_record 可 join」的结论来源问题：

- 关联词表 `PLAN_LINK_SUBJECT_TYPES` 新增 `functional_case`（env 恒 None：功能用例不绑环境）。
- 结论两张表（迁移 0040）：
  - `plan_functional_exec`：**每条关联一行**当前结论（pass/fail/blocked/skip + comment +
    executed_by/at），`link_id` 唯一；
  - `plan_functional_exec_history`：append-only 流水，**`seq` 按 link 续号**——MySQL DATETIME
    默认秒级精度，同一秒内的两次改判用时间戳分不出先后（测试当场栽过），序号才确定。
- 口径：pass → passed；fail/blocked/skip → **已执行未通过**（failed）。理由：通过率只有
  两轴，把阻塞算通过会抬高通过率、算未执行会拉低执行率；列表行仍显示原值，
  blocked 不会被界面谎报成失败。
- 4 个 `@service`：列表（keyword/module_id/result 筛选**下推 SQL**，total 同谓词）、
  详情（用例描述 + 自定义字段 + 当前结论）、写结论（批量/去重；归档计划 409；
  跨计划 link 整批 404 不写半批；非功能用例关联 422）、历史（seq 倒序）。
- 级联：摘挂与删计划同事务删净当前结论 + 流水（按 link_id/plan_id，不波及别的计划）。
- `_aggregate_links` 统一折叠：functional_case 读人工结论表，其余四类读 run_record——
  实时状态与报告共用同一函数，通过率分母不分裂。
- 前端：`planDetail` 选择器支持功能用例（服务端 keyword）、关联表精确结论列、
  「记录结论」弹层（`testplan:functional:execute` + 未归档双门）。
- 测试：`tests/test_d204_plan_functional_case.py`（4 条：挂载/执行/聚合、四种拒绝+筛选、
  级联、权限位+表形状）、`planDetail.test.tsx` 44 条全绿、`runVocab.test.ts` 全绿、
  迁移 0040 up 通过。
- 仍缺：计划内功能用例的**树/模块计数**、批量改执行人、计划内移动/排序、关联缺陷、
  执行历史分页（当前一次全量）、前端独立「功能用例」页签。


---

## 22. 第 15 刀交付：功能用例 Excel 模板/导入/导出（D205，2026-11-23）

「批量建用例」此前只能一条条点，这是功能用例最基础的能力缺口。D205 补齐三端点：

- 独立 router（`app/modules/functional/routes.py`）：multipart 上传与文件流下载走不了
  `@service` 的 JSON 投影，装配层注入 `get_db/get_current_user`（同 filelib R26 手法），
  鉴权仍复用 `core.build_ctx`（含项目数据权限门）+ 权限位。
- 三个端点（不计入注册表 ops，属 custom routes）：
  - `GET /functional-cases/import-template?project_id&template_id` —— 模板，列头 =
    `编号/用例名称/优先级/模块/描述` + 当前（或默认）模板自定义字段列，必填带 `*`；
    附「填写说明」页（类型/必填/可选项/多值写法）。
  - `POST /functional-cases/import` —— **全有或全无**：任何一行校验失败 → 整批 422，
    `details.errors` 带 Excel 行号与原因，零落库；模块列按**全路径**解析；优先级留空按
    P2；多值按中英文逗号/顿号/分号拆；选项单元格 label/value 都收，入库统一存 value。
  - `GET /functional-cases/export` —— 模块**递归** + 关键字 + 优先级筛选；选项导出写
    label（人读），再导入可回环；只读权限即可导出。
- 依赖：`openpyxl>=3.1`（成熟库，不手搓 xlsx）。
- 前端：功能用例页新增「下载模板 / 导出 / 导入」；导入失败弹层逐行列出行号，并明示
  「一行都没写入」；`client.getBlob`/`postForm` 复用 401 刷新与错误信封。
- 测试：`tests/test_d205_functional_exchange.py`（4 条：模板列头与说明页、导入成功
  与详情回读、三类坏行原子拒绝、导出回环/筛选、READONLY 权限与坏文件）；
  `functionalCases.test.tsx` + `ImportWizard.test.tsx` 16 条全绿。
- 已知限制：导出按指定/默认模板的字段列出，**多模板字段不合并**；单次最多 2000 行、
  文件 ≤10MB；成员类字段填 user id（未做账号→id 翻译）。



---

## 23. 第 16 刀交付：计划关联行收尾（D206，2026-11-23）

D183 的计划关联只解决「挂什么、用哪个环境」；MS 计划详情里还差三件每天都在用的操作：
指派执行人、拖顺序、批量摘挂。D206 一并补齐：

- 迁移 `0041_plan_link_executor_sort`：`plan_case_link` 加 `executor_id`（可空 = 未指派）
  与 `sort_order`（默认 0 = 从未排过），加组合索引 `(plan_id, sort_order)`。
- 三个 `@service`（`app/modules/testplan/services.py`，均带 `ensure_project_access`）：
  - `plan_link_assign`（POST `/plans/{plan_id}/case-links/assign`，perm
    `testplan:link:update`）：批量指派；`executor_id=None` = **取消指派**（不是「不改」）；
    执行人必须是本项目成员（422 invalid_executor）；任一 link 不在本计划 → 404，
    整批不落库。
  - `plan_link_sort`（POST `.../sort`，perm 同上）：`link_ids` 必须覆盖计划内**全部**
    关联（否则 422 incomplete_sort——子集会让未列出的行与第 1 名抢同一个 sort_order，
    产生不确定序）；sort_order 从 1 连续写回。
  - `plan_link_batch_delete`（POST `.../batch-delete`，perm `testplan:link:delete`）：
    只删关联行 + 该行的 plan_functional_exec / _history，用例本体与已生成报告不动；
    全有或全无。
- 读侧：`plan_link_list` 改按 `(sort_order, id)`（全为 0 时仍是 D183 的 id 升序，
  绝对期望序不变）；`PlanLinkOut` 与功能用例列表暴露两列；`executor_id`（指派给谁）
  与 `executed_by`（谁真跑了）并列，互不覆盖。
- 前端 `planDetail`：执行人下拉（成员名单来自 `/projects/{id}/members`，拉不到就画短 id
  不编名）；上移/下移（**仅当整页装下全部关联**时出把手，跨页不摆假门）；勾选后出现
  「批量摘除」并二次确认。
- 测试：`tests/test_d206_plan_assign_sort.py` 6 条（指派/取消/非成员/跨计划原子拒绝、
  排序全覆盖与子集拒绝、批量摘除级联结论与全有或全无、功能列表同一份指派、
  READONLY/MEMBER 权限位、表形状由 D183 用例扩到十二列 + 新索引）；前端
  `planDetail.test.tsx` 新增 3 条（下拉 body 逐字段、跨页不出排序把手/整页出、勾选批量摘除）。
- 迁移证据：`scripts/check_migration_down.py` 补登 0039/0040/0041（0041 是纯加列，
  EXPECT 空清单 → 跳过查表只验版本链），`0041` 实跑 `upgrade → downgrade -1 → upgrade`
  通过（临时库已删）；四个模型测试的「链头唯一」期望同步到 0041。
- 仍未做（有意）：计划任务中心 9 端点（本项目的执行是同步 run_record，没有异步任务
  消费者，做出来只是空转表）；计划树/模块计数；计划复制/批量归档。列入下一刀候选。

## 24. 第 17 刀交付：功能用例关联缺陷 + 计划缺陷清单（D207，2026-11-23）

MS 的缺陷详情可关联功能用例（`functional`），计划详情可看「计划内用例暴露的缺陷」。
本仓 D193 已有功能用例主体、D187/D191 已有缺陷与关联表，差的正是这两段接线：

- 词表：`DEFECT_CASE_TYPES` 补 `functional_case`（`defect/models.py`）；
  `CASE_TABLES` / `CASE_LABELS` 同步（`defect/services.py`），`schemas` 的
  `_CASE_TYPE_PATTERN` 由元组自动生成，无需另改。D187 那条「不含 functional」的
  防线测试改写为「词表恰为这五类」（防线随 D193 落地解除，改动理由写在用例 docstring）。
- 读侧新服务 `plan_bug_list`（GET `/plans/{plan_id}/bugs`，perm `testplan:link:read`，
  **只读、无迁移**）：`plan_case_link (subject_type, subject_id)` ←
  `defect_case_link (case_type, case_id)` → `defect`，`distinct` 按缺陷去重；
  `recycled = 0` 排除回收站；`(updated_at desc, id desc)` 确定性排序；status/priority/
  keyword 下推且 total 同谓词。三张跨域表全部**反射**，不 import defect 领域模块（契约 1）。
- 前端：`api/plan.ts` 加 `PlanBugRow` / `PlanBugQuery` / `listBugs`；`planDetail` 在
  「关联用例」与「报告」之间加只读「计划缺陷」卡片（ID/标题/状态/优先级/处理人/更新时间，
  状态走缺陷词表人话，标题真链接去 `/defects/:id`，空态与失败态分岔）；`api/defect.ts`
  的 `CASE_TYPE_LABELS` 补「功能用例」，缺陷详情关联弹层自动多出该选项。
- 测试：`tests/test_d207_plan_bug_list.py` 5 条（功能用例链路 + 双用例去重、回收站排除与
  恢复重现、跨项目隔离与 404 同文案、空计划/筛选/total/分页、READONLY 可读）；前端
  `defects.test.tsx` 新增 1 条（选「功能用例」后候选请求带 `case_type=functional_case`），
  `planDetail.test.tsx` 新增 1 条（状态词表人话、标题真链接跳转），并把分页器断言从
  「全页一个」改成「按卡片定位」（D207 让 DOM 里出现第二个分页器，旧断言是环境假设）。
- 门禁（本轮实测）：`test_d207` + D187 + D191 **29 passed**；权限矩阵 **267 passed**；
  d110/r157/r158 **9 passed**；web `tsc` exit 0、eslint 0 error、
  planDetail+defects **44 passed**；ruff 全过。无迁移，head 仍 0041。
- 仍未做（顺延）：计划树/模块计数、计划复制/批量归档、计划任务中心 9 端点（无异步消费者）。

## 25. 第 18 刀交付：计划复制（D208，2026-11-23）

§24 顺延项「计划复制」落地；MS 的对照物是 `TestPlanController.copy`（POST `/copy/{id}`，
`TestPlanService.copy:1179-1275`：抄头 + `copyPlanPrincipal` + `copyPlanCase`，
关联行 `status` 复位 Prepare、`executor`/`remark`/`order` 随行抄）。

- 新服务 `plan_copy`（POST `/plans/{plan_id}/copy`，perm **`testplan:plan:create`**——
  MS 用的是 `READ_CREATE` 或 `READ_COPY` 二选一，本仓没有独立的 copy 位，
  与新建同门是位选择的最小面；`ensure_project_access` + `_plan` 的跨项目 404 同文案）。
- 抄什么：计划头 `description` 抄、`archived=False`（MS 复位 Prepare，复制件是可用的新计划）、
  `created_by/updated_by` = 复制人；`plan_case_link` 逐行抄
  `subject_type/subject_id/subject_name/env_id/executor_id/sort_order`，`created_by` = 复制人。
- **不抄**：`plan_functional_exec` / `_history`（人工结论）、`plan_report`（历史快照）——
  MS 复制时把功能用例行重置 Prepare，等价语义是「用例挂进去了、还没跑」；
  把上一轮通过率搬进新计划 = 新计划出生即谎称已执行（测试钉「新计划 status=not_started、
  功能列表 result=none、报告 total=0」）。
- 默认名 = MS 形状 `<源名>_<5 位>_COPY`，按 200 列宽先保后缀截断；随机后缀防「同源连复制
  两次撞 uq_plan_record_project_name」。显式 `name` 走同项目重名 409 与 200 上限 422。
- 事务：新头 + 全部关联行**一次 commit**（与 plan_delete 的级联同尺：要么全在、要么全不在）。
- 前端：`api/plan.ts` 加 `copy`（`PlanCopyBody` 手写，gen:api 本刀禁跑）；
  `plans.tsx` 操作列加「复制」钮（与新建同门 `:create`，已归档行也可复制——这是把归档
  计划捡回来的正路）；成功后回显后端生成的名并**重新取列表**（新行可能不在当前页，
  前端不往 rows 里塞凭空位置）。
- 测试：`tests/test_d208_plan_copy.py` 6 条（头/关联逐列/零结论/源不动、默认名与截断、
  显式名 409/422、跨项目 404 同文案、READONLY 403 且不落库 + MEMBER 可复制、空计划）；
  `plans.test.tsx` 新增 2 条（POST body 恰 `{project_id}` + 重取列表、READONLY 无钮）；
  权限矩阵加 `plan_copy` 一行（4 角色 × 1 格）。无迁移，head 仍 0041。
- 仍未做（顺延）：MS 的**批量删除计划**（`/delete/batch`，我们只有单删——§26 已交付）、
  计划树/模块计数、计划任务中心 9 端点。

## 26. 第 19 刀交付：计划批量删除 + 架构契约修复（D209，2026-11-23）

§25 顺延项「批量删除」落地。MS 对照物：`TestPlanController` 的 `@PostMapping("/delete/batch")`
（`BatchOperateRequest` + `testPlanService.deleteTestPlanByIds`，逐个走与单删同一条级联）。

- 新服务 `plan_batch_delete`（POST `/plans/batch-delete`，perm **`testplan:plan:delete`**——
  MS 有独立 BATCH_DELETE 位，本仓不为此新造位：单删与批删是同一个破坏性动作的两种传参形状，
  新位只会让 MEMBER 的 `-*:delete` 之外再漏一个未覆盖的授权面）。
- **全有或全无**（与 plan_link_batch_delete 同纪律）：重复 id → 422（同一计划删两次说明调用方
  拼错）；任一 id 不在本项目 → 404「计划不存在」+ `details.plan_ids` 恰列缺的，**整批一行不动**；
  空列表 → schema 422。
- **级联抽成 `_purge_plan` 单实现**：单删与批删调同一函数（关联/功能结论/历史/报告头/报告明细
  五张表 + 计划本体），调用方决定事务边界——批量删**一次 commit** 落所有计划的所有刀。
  报告明细仍按「本计划的报告 id 子查询」删（不留孤儿），谓词只有自有 plan_id。
- 前端：`api/plan.ts` 加 `batchDelete`；`plans.tsx` 在有 `:delete` 时挂勾选列 + 工具栏
  「批量删除（N）」；确认后只发 `{project_id, plan_ids}`，**本地不先删行**，成功后清勾选并重取列表；
  READONLY/MEMBER 不渲染勾选列（不摆用不了的把手）。
- **架构契约修复（本轮实测发现的历史债）**：`testplan/services.py` 在 D206 引入了
  `from app.modules.iam.models import ProjectMember`，`lint-imports` 契约 1 实测 broken
  （跨域 import）。改为 `project_member` 表名反射 + 两列谓词（`project_id`/`user_id`），
  与 SUBJECT_TABLES 同款纪律；复跑 4 契约全 kept。
- 测试：`tests/test_d209_plan_batch_delete.py` 5 条（两计划五表级联归零 + 第三计划毫发无损、
  缺 id 整批回滚、重复/空 422、跨项目 404 同文案、READONLY/MEMBER 403 + PA 放行）；
  `plans.test.tsx` 新增 2 条（全选 → POST body 恰 `{project_id, plan_ids}` → 清勾选重取；
  READONLY 无勾选列）；权限矩阵加 `plan_batch_delete` 一行（**271 passed**）。
  守卫复跑：d183 四件 + d204 + d206 + d207 + d208 共 **72 passed**；d206/d208/d209 16 passed；
  r157/r158/d110 9 passed；web plans.test.tsx 25 passed；tsc 0；eslint 0 error（1 条既有
  unused `Table` warning，非本刀引入）。无迁移，head 仍 0041。
- 仍未做（顺延）：计划树/模块计数、计划任务中心 9 端点、计划报告重命名/删除端点（§27 改名已交付；删除端点早已在）。

## 27. 第 20 刀交付：报告改名 + 操作列（D210，2026-11-23）

§26 顺延项「报告重命名」落地。MS 对照物：`TestPlanReportController.reName`
（perm `PROJECT_TRACK_REPORT_READ_EDIT`，只改标题）。

- 新服务 `plan_report_rename`（PATCH `/plan-reports/{report_id}`，perm
  **`testplan:report:update`**，effect write）。**只写 name 一列**：status/五个计数/明细/
  plan_id/created_at 全部原样；报告仍是生成时刻的内容快照。这是把「内容不可改」与
  「标题不能改」拆开——MS 的 reName 也只改标题；逼用户删了重生成才改名 = 用更贵、更丢证据
  的动作换同一结果。
- 没有重名预检：plan_report 无 name 唯一约束（MS 也没有），报告靠 id 引用。
- 模型 docstring 同步收窄：`updated_at` 自本刀起有第二个写入方（改名）；快照不可变断言的
  口径改为「**未改名的行** updated_at ≡ created_at，改名只动 name/updated_at」，
  守卫 `test_report_services_declare_exactly_four_bits_no_manage`（原 three bits 版）
  同步钉 read/create/delete/update 四位、仍无 :manage。
- 前端：`api/plan.ts` 加 `renameReport`；计划详情报告表新增「操作」列（:update → 重命名，
  :delete → 删除；两位都缺则整列不渲染）。改名走 Modal.confirm 内联输入，trim 后空名本地
  拦下；改名/删除成功后只重取报告列表（不重新生成、不动快照）。
- 测试：`tests/test_d210_report_rename.py` 5 条（只动 name 且归档后仍可改名、库侧明细
  逐 link 结论不变、404 同文案、空/超长 422、READONLY 403 + MEMBER 放行、详情/列表读到新名）；
  `planDetail.test.tsx` 新增 3 条（PATCH body 恰 `{project_id,name}` 且 trim；DELETE body
  `{project_id}`；READONLY 无钮）；矩阵加 `plan_report_rename` 一行（定向 24 passed）。
- 守卫复跑：d210 + d183 reports **19 passed**；ruff 全过；lint-imports 4 contracts kept；
  web planDetail 39 passed；tsc 0；eslint 0 error。无迁移，head 仍 0041。
- 仍未做（顺延）：计划树/模块计数、计划任务中心 9 端点、工作台余量。

## 28. 第 21 刀交付：计划模块树（D211，2026-11-23）

§25–§27 连写三处「顺延：计划树/模块计数」，本刀落地。MS 对照物：
`TestPlanModuleService`（模块树 + 增改删），前端是计划列表左侧的模块树。

- 迁移 `0042_plan_module`：新建 `plan_module`（`id/project_id/parent_id/name/sort` +
  `uq(project_id,parent_id,name)` + `ix(project_id)`），并给 `plan_record` 加 `module_id`
  （可空、带索引；`NULL` = 未分组）。`plan_record` 列集因此由九列变十列——D183 的两处
  「列集恰好九列」断言同步改为十列并写明 `module_id` **有写方也有读方**，不进「挂名死列」。
- 四个 `@service`（复用 `testplan:plan:*` 四位，**不新造权限**）：
  - `plan_module_tree`（GET `/plan-modules/tree`，:read）：节点带**直属** `plan_count`
    （子树不并入父）与树外 `unassigned_count`；「未分组」不是树里的假节点。
  - `plan_module_create`（POST `/plan-modules`，:create，201）：父模块须在本项目（404
    同文案「模块不存在」）；同父重名 409——DB 唯一约束在 `parent_id IS NULL` 时拦不住
    根层重名，服务层才是真正生效的门。
  - `plan_module_update`（PATCH `/plan-modules/{module_id}`，:update）：`parent_set` 哨兵
    区分「不传」与「传 null（移到根层）」；挂到自身/后代 → 422 `cycle`（上溯有 guard，
    脏环不死循环）；移动后同父重名 409（排除自己）。
  - `plan_module_delete`（POST `.../delete`，:delete，destructive）：有子模块或有计划 →
    409 `module_not_empty` + `details{children,plans}`；**不递归删计划**。
- 计划侧接线：`PlanCreateIn.module_id`（验同项目存在）、`plan_update` 的 `module_set`
  哨兵、`plan_copy` **随源抄 module_id**（复制件不掉进未分组）；`plan_list` 新增
  `module_id`（整棵子树，内存拼 id 集合；目标模块须在本项目否则 404，空结果仍是 200 空表）
  与 `unassigned=True`，两者同传 422。
- 偏差裁决（写在 `models.PlanModule` docstring）：MS 删模块会连带删模块内计划；本仓
  明确拒绝这条隐含级联（非空 409，用户先把计划移出或删掉）。理由与 D183「删除是显式
  动作」同尺：一个「删目录」的请求不许悄悄删掉一批带执行历史的计划。
- 前端：`api/plan.ts` 手写 `PlanModuleNode/PlanModuleTree/PlanModuleCreateBody/
  PlanModuleUpdateBody` 与 4 个调用（gen:api 禁跑），并把 `PlanCreateBody`、模块过滤
  query 用交集补上生成物缺的键；`plans.tsx` 左侧模块树（`Tree`，节点带计数）+ 「全部计划 /
  未分组（N）」两条树外入口 + 新建/改名/删除模块钮（各按 `:create/:update/:delete` 渲染）；
  新建计划落到当前选中模块，换过滤回第 1 页。
- 测试：`tests/test_d211_plan_module.py` 7 条（树直属计数/未分组/归档不改计数、同父与
  根层重名 409、防环 422 不动库、删非空 409 且计划一根毫毛没动 + 腾空后可删、三类跨项目
  404 同文案且别项目数据原样、子树/未分组/互斥 422/移动后过滤跟随、READONLY 只读树 +
  MEMBER 可建改不可删）；`plans.test.tsx` 新增 4 条（树渲染与三种过滤 query、选中模块后
  新建计划 body 带 `module_id`、建模块 body 恰 `{project_id,parent_id,name}` 且重取树、
  READONLY 无管理钮）；权限矩阵加 4 行。
- 门禁（本轮实测）：D211 **7 passed**；d183 四件 + d204/d206/d207/d208/d209/d210 回归
  全绿；r157/r158/d110 **9 passed**；矩阵定向 `plan_module` + 前缀覆盖全绿；五个模型测试
  （迁移链头 0042）全绿；web plans.test.tsx **29 passed**；tsc 0；eslint 0 error（既有
  unused `Table` warning）；ruff 全过；lint-imports 4 contracts kept。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、A 档列表交互（高级搜索/视图/列设置）。

## 29. 第 22 刀交付：计划列表高级搜索（D212，2026-11-23）

§28 顺延的「A 档列表交互」在计划页落地。D47-a 的三件套（视图选择器 / 高级搜索 /
列设置）本来只长在「接口」页；本刀把同一套组件与注册表铺到计划页，**不新增前端手写
表单**——字段清单仍由后端 `/filter-meta?view_type=plan` 给。

- 后端：`testplan/services.py` 登记 `PLAN_LIST_FILTER`（view_type=`plan`，label=测试计划），
  字段 = `name/description/archived/module_id/created_by/updated_by/created_at/updated_at`
  （全是 plan_record 真实列；`project_id` 刻意不可筛，越权正门只归 `ensure_project_access`）。
  `PlanListIn.filter` 收 JSON 条件组，`plan_list` 把它与 `project_id` 并列写进**同一个**
  `.where(...)`（OR 组自带括号，不会吃掉可见性谓词）。白名单外字段/控件型不符/坏 JSON
  → 400 `bad_filter`，message 带本页可筛清单。
- 与 D211 左树的两个入口**并行不覆盖**：左树 `module_id`（整棵子树）/`unassigned` 与
  高级搜索条件是 AND；`module_id` 同时在可筛字段里（业务属性），两条路语义不同但都通。
- 可空列否定谓词保留 NULL 行：`module_id NOT_IN [m1]` 会把「未分组」计划留下
  （`filters._neg` 的三值逻辑口径，D212 用例钉住）。
- 前端：`plans.tsx` 工具栏换 `ListToolbar`（viewType `plan`），列偏好键 `plan`
  （名称/描述/归档/创建时间/更新时间；操作列不进面板）；模块树的节点摊平成
  `module_id` 的候选值；空条件不拼 `filter` 参数。顺带删掉该文件里既有的 unused
  `Table` 导入（D47-a 之前的残留）。
- 测试：`tests/test_d212_plan_advanced_search.py` 6 条（meta 字段与 plan 登记、CONTAINS/
  archived EQUALS/OR 三组条件、可空列 NOT_IN 保留未分组、与左树子树过滤及 unassigned
  并行、project_id 等坏条件 400 带清单、READONLY 可筛但坏条件仍 400）；
  `plans.test.tsx` +2（应用条件后请求带逐字 filter JSON、列设置只藏点名列）；
  `test_d47a_list_filters.py` 的「已登记页面清单」改为 `["api","plan"]`（该断言本来就是
  故意的加页绊线，随行用例已补）。
- 门禁（本轮实测）：D212 **6 passed**；d47a **31 passed**；D211/D183/D208/D209 同批全绿；
  web 全量 **1986 passed / 125 files**；tsc 0；eslint 0 warning（plans.tsx 的旧 unused
  `Table` 已清）；ruff 全过；lint-imports 4 contracts kept。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、其余列表页的高级搜索铺设
  （scenario / report / defect / ui / adb 等仍只有 api + plan 两页）。

## 30. 第 23 刀交付：UI 用例列表高级搜索（D213，2026-11-23）

§29 顺延的「其余列表页铺设」从 UI 用例页继续。机制与 D212 逐字同源：后端注册表
出字段清单，前端 `ListToolbar` 消费，**不新增第二套手写表单**。

- 后端：`ui_test/case_services.py` 登记 `UI_CASE_LIST_FILTER`（view_type=`ui_case`，
  label=UI 用例），字段 = `name/priority/enabled/module_id/env_id/owner_id/step_count/
  last_run_at/last_run_status/updated_by/created_at/updated_at`（全是 ui_case 真实列；
  `project_id` 与 `status` 刻意不可筛——越权正门归 `ensure_project_access`，回收站是
  视图轴）。
- 三个视图轴与 filter **并行 AND**，互不吃掉：`recycled`（回收站）、`module_id`
  （单模块）、`unfiled_only`（未分组）仍是顶层参数；filter 只写业务属性条件。OR 组自带
  括号，`visible_clause`（私有用例只有本人/管理员可见）在括号之外，**筛不掉也绕不过**
  ——`test_d213_ui_case_advanced_search.py` 的 not-leak 用例钉死。
- `UiCaseListIn.filter: str | None`；`ui_case_list` 的 WHERE 增加
  `UI_CASE_LIST_FILTER.parse(payload.filter)`，与 `project_id`/`visible_clause`/`status`
  三轴并列在同一 `.where(...)`。
- 前端：`web/src/api/ui.ts` 的 `CaseListInput` 增 `filter?: string`；`uiCases.tsx` 工具栏换
  `ListToolbar`（viewType `ui_case`，`canSaveView/canDeleteView`，新建/回收站钮进 `extra`），
  列偏好键 `ui_case`（名称/优先级/启用/最近结果/负责人/更新时间；回收站专属的
  「删除人/删除时间」与操作列不进面板）；空条件不拼 `filter`；顺带删掉该文件既有 unused
  `Table` 导入与 `FilterBar` 旧导入。
- 测试：`tests/test_d213_ui_case_advanced_search.py` 6 条（meta 字段与控件型 ops、
  CONTAINS+EQUALS+OR+total、可空 `last_run_status` EMPTY/NOT_EMPTY、与 recycled/module/
  unfiled 三轴并行、私有用例不因 filter 泄露、READONLY 坏条件仍 400 带清单）；
  `test_d47a_list_filters.py` 的「已登记页面清单」改为 `["api","plan","ui_case"]`
  （故意的加页绊线，随行用例已补，docstring 注明加页须随行）；
  `uiCases.test.tsx` 27 passed（既有用例与新增断言同跑）。
- 门禁（本轮实测）：D213 **6 passed**；ui/filter 回归批（d47a + ui_case + ui_models +
  d212）**62 passed**；web 单文件 **27 passed**；web 全量 **1988 passed / 125 files**；
  `tsc --noEmit` 0；eslint 0 error 0 warning；ruff 全过；lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、其余列表页高级搜索
  （scenario / report / defect / adb 等，现只有 api / plan / ui_case 三页）、
  功能用例执行历史分页、计划定时执行与报告订阅。

## 31. 第 24 刀交付：场景列表高级搜索（D214，2026-11-23）

§30 顺延的列表页铺设继续，落到场景页。机制与 D212/D213 同源：后端注册表出字段
清单，前端 `ListToolbar` 消费，不新增第二套手写表单。

- 后端：`scenario/services.py` 登记 `SCENARIO_LIST_FILTER`（view_type=`scenario`，
  label=场景编排），字段 = `name/priority/module_id/env_id/owner_id/fail_fast/
  max_runtime_ms/project_public/step_count/last_run_at/last_run_status/updated_by/
  created_at/updated_at`（全是 scenario 真实列；`project_id`/`status` 不可筛——越权
  正门归 `ensure_project_access`，回收站是视图轴）。
- 四个既有入口与 filter **并行 AND**，互不吃掉：`recycled`（回收站开关）、
  `module_id`/`module_ids`（模块树，直属口径）、`keyword`（快捷搜索，只打 name）、
  `current`（页码）。filter 只写业务属性条件，OR 组自带括号，`visible_clause`
  在括号之外——`test_d214_scenario_advanced_search.py` 的 not-leak 用例钉死。
- `ScenarioListIn.filter: str | None`；`scenario_list` 的 WHERE 增加
  `SCENARIO_LIST_FILTER.parse(payload.filter)`，与 `project_id`/`visible_clause`/
  `status` 三轴并列在同一 `.where(...)`。
- 前端：`web/src/api/scene.ts` 的 `ScenarioListQuery` 增 `filter?: string`；
  `scenes.tsx` 工具栏换 `ListToolbar`（viewType `scenario`，`canSaveView/canDeleteView`，
  快捷搜索 `Input.Search` + 刷新 + 新建菜单进 `extra`），列偏好键 `scenario`
  （名称/模块/优先级/最近结果/步骤数/定时/负责人/更新时间；回收站的删除人/删除时间与
  操作列不进面板）；`name`/`priority`/`step_count` 三列补 `key`（列偏好按 key 过滤，
  只有 dataIndex 的列藏不掉）；候选值复用页面词表：优先级 P0-P3、模块树摊平、
  最近结果读本页 `RUN_DOT`（终态四值）；空条件不拼 `filter`。
- 测试：`tests/test_d214_scenario_advanced_search.py` 6 条（meta 字段与控件型 ops、
  CONTAINS+EQUALS+OR+total、可空 `last_run_status` EMPTY/NOT_EMPTY、与 recycled/
  module_ids/keyword 三轴并行、私密场景不因 filter 泄露、READONLY 坏条件仍 400 带清单）；
  `test_d47a_list_filters.py` 的「已登记页面清单」改为 `["api","plan","scenario","ui_case"]`；
  `scenes.test.tsx` +2（应用条件后请求带逐字 filter JSON、列设置只藏点名列），
  文件内既有 71 条全绿。
- 门禁（本轮实测）：D214 **6 passed**；D212/D213/d47a 回归批 **49 passed**；
  场景相关后端用例（`-k scenario`）**140 passed**；web 场景单文件 **73 passed**；
  web 全量 **1990 passed / 125 files**；`tsc --noEmit` 0；eslint 0；ruff 全过；
  lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、其余列表页高级搜索
  （report / defect / adb 等，现只有 api / plan / ui_case / scenario 四页）、
  功能用例执行历史分页、计划定时执行与报告订阅。

## 32. 第 25 刀交付：报告中心高级搜索（D215，2026-11-23）

§31 顺延的列表页铺设继续，落到报告中心。机制与 D212/D213/D214 同源：后端注册表
出字段清单，前端 `ListToolbar` 消费，不新增第二套手写表单。

- 后端：`execution/report_services.py` 登记 `REPORT_LIST_FILTER`（view_type=`report`，
  label=报告中心），字段 = `subject_name/subject_type/trigger/status/env_id/env_name/
  created_by/status_code/elapsed_ms/started_at/finished_at/created_at/updated_at`
  （全是 RunRecord 真实列；`project_id`/`include_debug`/`since`/`until`/`subject_id`
  仍是顶层参数——前两个管越权与视图口径，时间窗与对象轴是页面既有入口，
  `cursor`/`current`/`size` 是取数机制）。
- 条件与五个顶层轴**并行 AND**，互不吃掉：`include_debug`（报告=结论，默认排除
  debug）、`since`/`until`（COALESCE 排序键同一坐标）、`subject_id`/`subject_type`、
  七个快捷筛选、页码分页。OR 组自带括号，`trigger EQUALS debug` 在默认视图下仍是
  空集——**默认视图轴不可被条件组重写**，`test_d215_report_advanced_search.py`
  的 `test_filter_cannot_bypass_default_debug_axis` 钉死。- `ReportListIn.filter: str | None`；`report_list` 的 select 在
  `project_id` 那条 `.where(...)` 后串 `REPORT_LIST_FILTER.parse(payload.filter)`
  （同一 stmt，页码/游标两制共用；页码模式的 `total` 因此吃同一份条件，
  不是「筛了但页脚报全量」）。
- 前端：`reports.tsx` 工具栏顶部换 `ListToolbar`（viewType `report`，
  `canSaveView/canDeleteView`），七维快捷筛选（时间/场景/对象类型/触发/结果/环境/
  执行人）+ 含调试开关 + 刷新保留为第二行；列偏好键 `report`（对象/触发/结果/
  通过率/步骤/耗时/环境/执行人/开始时间），九列全部补 `key`（列偏好按 key 过滤，
  只有 dataIndex 的列藏不掉）；候选值复用页面词表（触发/结果/对象类型用本页同一份
  runVocab，env_id 用已到手的 `/envs`，created_by 用项目成员名单）；空条件不拼
  `filter`；advanced search 变化与快捷筛选同一条「回第 1 页」入口。
- 测试：`tests/test_d215_report_advanced_search.py` 5 条（meta 字段与控件型 ops、
  CONTAINS+EQUALS+OR+total、默认 debug 视图轴不可绕过、可空 env_name/started_at
  的 EMPTY/NOT_EMPTY、坏条件 400 带清单）；`test_d47a_list_filters.py` 的
  「已登记页面清单」改为 `["api","plan","report","scenario","ui_case"]`；
  `reports.test.tsx` +2（应用条件后请求带逐字 filter JSON、列设置只藏点名列），
  两个报告测试文件的 fetch 桩同步补 `/filter-meta` 与 `/saved-views`。
- 门禁（本轮实测）：D215 **5 passed**；报告回归批（report_center + d47b_report_page）
  **21 passed**；d47a + d47b + d214 回归批 **43 passed**；web 报告单文件
  **25 passed**；web 全量 **1992 passed / 125 files**；`tsc --noEmit` 0；
  eslint 0 error 0 warning（顺带删掉本文件存量的 unused `Table` 导入）；ruff 全过；
  lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、缺陷页高级搜索、
  adb 页高级搜索（现只有 api/plan/report/scenario/ui_case 五页）、
  功能用例执行历史分页、计划定时执行与报告订阅。

## 33. 第 26 刀交付：缺陷页高级搜索（D216，2026-11-23）

§32 顺延的列表页铺设继续，落到缺陷管理。机制同源：后端注册表出字段清单，
前端 `ListToolbar` 消费。

- 后端：`defect/services.py` 登记 `DEFECT_LIST_FILTER`（view_type=`defect`，
  label=缺陷管理），字段 = `num/title/status/priority/handle_user_id/template_id/
  created_by/updated_by/created_at/updated_at`（defect 表真实列）。三类**不进**
  条件组的列各有理由写进代码：`recycled` 是视图开关（进条件组会造出
  「recycled=false 的视图再筛 recycled=true」）；`delete_user/delete_time` 只在
  回收站视图有意义；`tags` 逗号串在条件组只能 LIKE，会复刻 D190 明令避免的
  「bug1 命中 bug10」，精确匹配留在顶层 `tag`（find_in_set）。
- `DefectListIn.filter: str | None`；`defect_list` 的 `select(...).where(...)` 里
  三个谓词并列：project_id / recycled / `DEFECT_LIST_FILTER.parse(payload.filter)`。
  OR 组自带括号，不吃掉前两个；页码模式的 `total` 吃同一份条件。
- 前端：`defects.tsx` 顶部换 `ListToolbar`（viewType `defect`），原快捷筛选条
  （关键词/状态/优先级/标签/我关注的 + 新建/刷新/导出/回收站）原样保留为第二行；
  列偏好键 `defect`（12 列：ID/标题/状态/优先级/标签/自定义字段/处理人/关联用例/
  评论/关注/更新人/更新时间），回收站独有「删除人/删除时间」不进偏好——它们跟着
  视图走；候选值复用页面已在手的词表（STATUS_OPTIONS/优先级/成员/模板下拉，
  模板候选取自同一次 templates 请求）。空条件不拼 `filter`；高级搜索变化与
  快捷筛选同一条「回第 1 页」纪律。
- 测试：`tests/test_d216_defect_advanced_search.py` 5 条（meta 字段与控件型 ops、
  CONTAINS/EQUALS/状态转移/OR/total、回收站轴不可被条件绕过、可空
  handle_user_id 的 EMPTY/NOT_EMPTY 与 updated_by 反向对照、坏条件 400 带清单）；
  `test_d47a_list_filters.py` 的页面清单改为
  `["api","defect","plan","report","scenario","ui_case"]`；
  `defects.test.tsx` +2（应用条件后请求带逐字 filter JSON、列设置只藏点名列），
  fetch 桩同步补 `/filter-meta` 与 `/saved-views`；`api/defect.ts` 的
  `DefectListQuery` 补 `filter?: string`（手写类型，非生成物）。
- 门禁（本轮实测）：D216 **5 passed**；缺陷回归批（d191 + d47a + d216）
  **46 passed**；web 缺陷单文件 **10 passed**；web 全量 **1994 passed / 125 files**；
  `tsc --noEmit` 0；eslint 0；ruff 全过；lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、adb 页高级搜索
  （现只有 api/defect/plan/report/scenario/ui_case 六页）、
  功能用例执行历史分页、计划定时执行与报告订阅。

## 34. 第 27 刀交付：ADB 用例高级搜索（D217，2026-11-23）

§33 顺延的列表页铺设继续，落到 ADB 用例页。机制同源：后端注册表出字段清单，
前端 `ListToolbar` 消费。

- 后端：`adb_test/case_services.py` 登记 `ADB_CASE_LIST_FILTER`（view_type=`adb_case`，
  label=ADB 用例），字段 = `name/priority/enabled/default_device/owner_id/
  project_public/step_count/last_run_at/last_run_status/updated_by/created_at/
  updated_at`（adb_case 表真实列）。`recycled`（视图轴，status 原值由顶层开关决定）与
  `module_id`/`unfiled_only`（模块树轴，页面由左侧树驱动）不进条件组，避免两套尺子。
- `AdbCaseListIn.filter: str | None`；`list_cases` 的 `select(...).where(...)` 四个谓词
  并列：project_id / `visible_clause` / status（normal|recycled）/ `parse(filter)`。
  OR 组自带括号，不吃掉可见性与回收站谓词；页码模式的 `total` 吃同一份条件。
- 前端：`adbCases.tsx` 顶部换 `ListToolbar`（viewType `adb_case`），新建/回收站按钮
  原样保留为第二行；列偏好键 `adb_case`（7 列：名称/优先级/默认设备/启用/最近结果/
  负责人/更新时间；回收站独有「删除人/删除时间/操作」不进偏好，跟着视图走）；
  候选值复用页面已在手的优先级/`STATUSES`/成员表，成员表未就绪时不给候选而保留
  真值精确筛。空条件不拼 `filter`；高级搜索变化与回收站开关同一条「回第 1 页」纪律。
- 测试：`tests/test_d217_adb_case_advanced_search.py` 5 条（meta 字段与控件型 ops、
  CONTAINS/EQUALS/bool/CONTAINS 设备/OR/total、回收站轴不可被条件绕过、
  可空 last_run_at/last_run_status 的 EMPTY/NOT_EMPTY、坏条件 400 带清单）；
  `test_d47a_list_filters.py` 的页面清单改为
  `["adb_case","api","defect","plan","report","scenario","ui_case"]`；
  `adbCases.test.tsx` +2（条件 JSON 上线、列设置只藏点名列），三处 fetch 桩同步补
  `/filter-meta` 与 `/saved-views`；`api/adbCase.ts` 的查询类型补 `filter?: string`。
- 门禁（本轮实测）：D217 **5 passed**；ADB 回归批（adb_case + d47a + d217）
  **44 passed**；web ADB 单文件 **20 passed**；web 全量 **1996 passed / 125 files**；
  `tsc --noEmit` 0；eslint 0
  （顺带删掉本文件存量的 unused `Table` 导入）；ruff 全过；
  lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、
  功能用例执行历史分页、计划定时执行与报告订阅。

## 35. 第 28 刀交付：功能用例结论历史（D218，2026-11-23）

D204 落库了每次改判（append-only，seq 续号），但历史端点一次全量、前端也没有入口——
「能改判」成立，「翻旧账」不成立。本刀补分页 + 入口。

- 后端：`PlanFunctionalHistoryIn` 增 `current`（默认 1，ge=1）与 `size`（默认 20，
  ge=1 le=200）；`plan_functional_case_history` 的 select 交 `paginate_page`（同一
  stmt 出 items 与 total，total 数的是这条 link 的历史，不另起全表 count）。
  排序键 `seq DESC, created_at DESC`：seq 按 link 续号且唯一，同秒两次改判靠 seq
  定先后（DATETIME 秒精度的坑 D204 已踩过）。越界由 pydantic 拦成 422，不落到 OFFSET。
- 前端：`planDetail.tsx` 每条 `functional_case` 关联加「历史」入口（不看归档/写权限——
  旧账是事实，只读成员也该看得见）；`FunctionalHistoryDrawer` 用 `ListPager`
  10 条/页，切目标用例、切档位都回第 1 页；请求失败时列表与 total 一起清空并明说
  「没取到 ≠ 没有改判」，不留陈旧页脚；行类型 `PlanFunctionalHistoryRow` 是手写镜像
  （端点标注 ServiceResult，Out 不进 OpenAPI），字段与后端逐字一致。
- 测试：`tests/test_d218_plan_functional_history_paging.py` 2 条（newest-first +
  total=3 + 两页不重不漏；默认参数不 500、size/current 越界 422、越过末页空
  items 但 total 不变）；`planDetail.test.tsx` +1（打开 Drawer 发
  `current=1&size=10`、第 1 页第 12 次改判在场而第 1 次不在、共 12 条，
  点第 2 页再发 `current=2` 且行替换）。
- 门禁（本轮实测）：D218 **2 passed**；D204 回归批 **18 passed**；
  web 计划详情单文件 **40 passed**；web 全量 **1997 passed / 125 files**；
  `tsc --noEmit` 0；eslint 0；ruff 全过；lint-imports **4 kept, 0 broken**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅。

## 36. 第 29 刀交付：功能用例高级搜索（D219，2026-11-23）

D47-a 三件套从接口/计划/报告/缺陷/场景/UI/ADB 七页铺到第 8 页——功能用例。此前
该页只有关键字 + 优先级两个快捷筛选，任意组合条件、列设置、个人视图都缺。

- 后端：`functional/services.py` 登记 `FUNCTIONAL_CASE_LIST_FILTER`（view_type=
  `functional_case`，label「功能用例」），9 个 `functional_case` 真实列：`num`
  （number）/`name`、`description`（text）/`priority`（enum）/`template_id`（id）/
  `created_by`、`updated_by`（id）/`created_at`、`updated_at`（time）。`description`
  Text 可空，因此有 EMPTY/NOT_EMPTY；`name` NOT NULL 拿不到这两项假筛选项。
  三个轴刻意不进条件组：`recycled`（正常/回收站同一端点的视图开关）、`module_id`+
  `unfiled_only`（左树取数轴，与条件组并行 AND 而非互相替代）、`status`（视图状态）。
  `module_id` 列本身也不作为业务字段暴露（ADB 页同款裁定：模块归属由左树表达）。
  `CaseListIn` 增 `filter: str | None`；`functional_case_list` 把
  `FUNCTIONAL_CASE_LIST_FILTER.parse(payload.filter)` 串进 `.where(...)`，谓词写在
  `paginate_page` 之前——total 与 items 吃同一份条件。
- 前端：`functionalCases.tsx` 在快捷筛选条上方加 `ListToolbar`（viewType
  `functional_case`），关键字/优先级/新建/导入/导出/回收站入口保留在第二行；
  列设置 7 列（编号/名称/优先级/模块/自定义字段/更新人/更新时间，操作列不进偏好），
  `applyColumnPrefs([...], colPref)` 包住 columns；`advFilter` 生效时列表请求带
  `filter` JSON，空条件整个参数不上线；候选值复用页面已有的优先级词表与成员表。
  `api/functional.ts` 的 `CaseListQuery` 补 `filter?: string`。
- 测试：`tests/test_d219_functional_case_advanced_search.py` 5 条（meta 9 字段与
  轴排除/条件即 WHERE + OR + total、回收站轴不可绕过、模块树轴与条件并行且
  `module_id` 进条件组 400、可空 description EMPTY/NOT_EMPTY、坏条件 400 带本页
  清单）；`test_d47a_list_filters.py` 的注册清单绊线同步到 8 个 view_type；
  前端 `functionalCases.test.tsx` +2（空条件不拼 filter / 应用「用例名称包含 登录」
  发出条件 JSON；列设置勾掉「自定义字段」只藏那一列）。桩补 `/filter-meta` 与
  `/saved-views`。
- 门禁（本轮实测）：D219+D47-a+D193 **40 passed**；ruff 全过；
  lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；eslint 0；
  web `functionalCases.test.tsx` **6 passed**；web 全量 **1999 passed / 125 files**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅、
  其余列表页（ADB 设备/UI 元素/评审/数据集等）的高级搜索铺设。

## 37. 第 30 刀交付：元素库高级搜索（D220，2026-11-23）

D47-a 三件套从第八页（功能用例）铺到第九页——元素库。此前该页只有模块树 +
元素名关键字两个取数轴，任意组合条件、列设置、个人视图都缺。

- 后端：`ui_test/element_services.py` 登记 `UI_ELEMENT_LIST_FILTER`（view_type=
  `ui_element`，label「元素库」），9 个 ui_element 真实列：`name` / `locator` /
  `comment`（text；`name`、`locator` 非空所以没有 EMPTY/NOT_EMPTY）、
  `locator_type`（enum，5 种定位方式）、`owner_id` / `updated_by`（id）、
  `project_public`（bool，只有 EQUALS/NOT_EQUALS）、`created_at` / `updated_at`（time）。
  四个轴刻意不进条件组：`recycled`（正常/回收站同一端点的视图开关）、
  `module_id` + `module_ids` + `unfiled_only`（左树取数轴，本页口径=直属，与条件组
  并行 AND）、`status`（视图状态）。`used_by`（关联用例数）是列表时现算的引用计数、
  不是列——SQL 筛不了，摆进白名单就是假筛选项（`current`/`size`/`cursor`/`keyword`
  同属取数机制参数）。`UiElementListIn` 增 `filter: str | None`；`ui_element_list`
  把 `UI_ELEMENT_LIST_FILTER.parse(payload.filter)` 串进 `.where(...)`，谓词写在
  `paginate_page` 之前——total 与 items 吃同一份条件。
- 前端：`uiElements.tsx` 在 FilterBar 上方加 `ListToolbar`（viewType `ui_element`），
  关键词搜索与刷新/新建入口保留在第二行；列设置 5 列（名称/定位方式/表达式/
  关联用例数/更新时间，操作列不进偏好；回收站专属的删除人/删除时间也不进——
  视图态列不是常态列），`applyColumnPrefs([...], colPref)` 包住 columns，
  并给原先只有 dataIndex 的四列补上 `key`（applyColumnPrefs 只按 key 隐藏，
  缺 key 的列勾掉也不生效）；`advFilter` 生效时列表请求带 `filter` JSON，
  空条件整个参数不上线；候选值复用页面已有的定位方式词表。
  `api/ui.ts` 的 `ElementListInput` 补 `filter?: string`。
- 测试：`tests/test_d220_ui_element_advanced_search.py` 5 条（meta 9 字段与轴/现算列
  排除、条件即 WHERE + bool + OR + total、回收站轴不可绕过、模块树轴与条件并行且
  `module_id` 进条件组 400、可空 comment EMPTY/NOT_EMPTY 且 `used_by` 进条件组 400）；
  `test_d47a_list_filters.py` 的注册清单绊线同步到 9 个 view_type；前端
  `uiElements.test.tsx` +2（空条件不拼 filter / 应用「元素名包含 登录」发出条件 JSON；
  列设置勾掉「关联用例数」只藏那一列）。桩补 `/filter-meta` 与 `/saved-views`。
- 门禁（本轮实测）：D220+D47-a **36 passed**；D47-b 元素页 + ui_models 回归
  **15 passed**；ruff 全过；lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（uiElements.tsx 的 `Table` 未用是存量 warning）；
  web `uiElements.test.tsx` **45 passed**；web 全量 **2001 passed / 125 files**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅、
  其余列表页（ADB 设备/评审/数据集/文件等）的高级搜索铺设。

## 38. 第 31 刀交付：用例评审高级搜索（D221，2026-11-23）

D47-a 三件套从第九页（元素库）铺到第十页——用例评审。此前该页只有模块树 +
关键字 + 状态 + 我创建/我评审/我的待办几个固定轴，任意组合条件、列设置、个人视图都缺。

- 后端：`review/services.py` 登记 `CASE_REVIEW_LIST_FILTER`（view_type=`case_review`，
  label「用例评审」），11 个 case_review 真实列：`num`（number）、`name` / `description`
  （text，`name` 非空所以没有 EMPTY/NOT_EMPTY）、`pass_rule`（enum，单人/多人）、
  `started`（bool，只有 EQUALS/NOT_EQUALS）、`start_at` / `end_at`（time，可空）、
  `created_by` / `updated_by`（id）、`created_at` / `updated_at`（time）。
  五类轴刻意不进条件组：`module_id` + `unfiled_only`（左树取数轴）、`keyword`（快捷
  搜索，避免两套「名称含」写法）、`status` / `pass_rate` / `case_count` / `reviewer_count`
  （**读时聚合**出来的展示值，库里没有这些列，进白名单就是假筛选项）、
  `created_by_me` / `reviewing_me` / `my_todo`（「我」的视图开关，同一列配当前用户，
  不是任意值筛选）。`ReviewListIn` 增 `filter: str | None`；`review_list` 把
  `CASE_REVIEW_LIST_FILTER.parse(payload.filter)` 串进 `.where(...)`，位置在 order_by /
  `paginate_page` 之前——total 与 items 吃同一份条件。
- 前端：`caseReviews.tsx` 在 FilterBar 上方加 `ListToolbar`（viewType `case_review`），
  关键字/状态/我相关三开关保留在第二行；列设置 8 列（ID/名称/状态/通过率/规则/评审人/
  创建人/更新时间；操作列不进偏好），`applyColumnPrefs([...], colPref)` 包住 columns，
  并给原先只有 dataIndex 的列补 `key`（applyColumnPrefs 只按 key 隐藏）；`advFilter`
  生效时列表请求带 `filter` JSON，空条件整个参数不上线。`api/review.ts` 的 `list`
  入参补 `filter?: string`。候选值复用通过规则词表与成员表。
- 测试：`tests/test_d221_case_review_advanced_search.py` 4 条（meta 11 字段与五类轴/
  聚合列排除、条件即 WHERE + bool + number + OR + total、模块树/关键词轴与条件并行且
  `module_id` 进条件组 400、可空 description EMPTY/NOT_EMPTY 且 status/pass_rate/
  case_count 进条件组 400）；`test_d47a_list_filters.py` 的注册清单绊线同步到 10 个
  view_type；前端 `caseReviews.test.tsx` +2（空条件不拼 filter / 应用「评审名称包含
  登录」发出条件 JSON；列设置勾掉「通过率」只藏那一列）。桩补 `/filter-meta` 与
  `/saved-views`。
- 门禁（本轮实测）：D221 + D194 + D47-a **41 passed**；ruff 全过；lint-imports
  **4 kept, 0 broken**；`tsc --noEmit` 0；eslint 0；`caseReviews.test.tsx` **6 passed**；
  web 全量 **2003 passed / 125 files**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅、
  其余列表页（ADB 设备卡片墙/数据集/文件等）的高级搜索铺设。

## 39. 第 32 刀交付：文件库高级搜索（D222，2026-11-23）

D47-a 三件套从第十页（用例评审）铺到第十一页——文件管理。此前该页只有目录树 +
关键词 + 回收站三个固定轴，任意组合条件、列设置、个人视图都缺。

- 后端：`filelib/services.py` 登记 `FILE_LIST_FILTER`（view_type=`file`，label「文件库」），
  11 个**列表实际 join 的** file_entry + file_blob 真实列：`name` / `description` / `tags`
  （text，`name` 非空所以没有 EMPTY/NOT_EMPTY）、`version` / `size`（number，其中 `size`
  是 blob 字节数、与查询串的 page size 不在同一层）、`mime` / `original_name`（text，
  来自 `file_blob`——跨表列同样走 SQL，不是现算）、`created_by` / `updated_by`（id）、
  `created_at` / `updated_at`（time）。四个轴刻意不进条件组：`folder_id` +
  `unfiled_only`（左树目录轴）、`keyword`（快捷搜索本来就同时匹配文件名与描述）、
  `recycled` + `status`（视图轴）、`current` / `size`（分页参数）。`FileListIn` 增
  `filter: str | None`；`file_list` 把 `FILE_LIST_FILTER.parse(payload.filter)` 串进
  `.where(...)`，位置在 order_by / `paginate_page` 之前——total 与 items 吃同一份条件。
- 前端：`files.tsx` 在 FilterBar 上方加 `ListToolbar`（viewType `file`），上传/刷新/
  回收站与关键词保留在第二行；列设置 7 列（名称/大小/类型/目录/标签/上传人/更新时间；
  操作列不进偏好），`applyColumnPrefs([...], colPref)` 包住 columns，并给原先只有
  dataIndex 的「名称/标签」补 `key`；`advFilter` 生效时列表请求带 `filter` JSON，
  空条件整个参数不上线。`api/filelib.ts` 的 `list` 入参补 `filter?: string`。
- 测试：`tests/test_d222_file_advanced_search.py` 4 条（meta 11 字段与轴排除、条件即
  WHERE + number + 跨表 size/mime/original_name + OR + total、回收站轴不可绕过、目录轴
  并行且 `folder_id` 进条件组 400 + 可空描述 + 400 带本页清单）；`test_d47a_list_filters.py`
  的注册清单绊线同步到 11 个 view_type；前端 `files.test.tsx` +2（空条件不拼 filter /
  应用「文件名包含 设计」发出条件 JSON；列设置勾掉「标签」只藏那一列）。桩补
  `/filter-meta` 与 `/saved-views`。
- 门禁（本轮实测）：D222 + D195 + D47-a **41 passed**；ruff 全过；lint-imports
  **4 kept, 0 broken**；`tsc --noEmit` 0；eslint 0；`files.test.tsx` **5 passed**；
  web 全量 **2005 passed / 125 files**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅、
  其余列表页（ADB 设备卡片墙/数据集等）的高级搜索铺设。

---

## 40. 第 33 刀交付：数据集高级搜索（D223，2026-11-23）

D47-a 三件套从文件库铺到**第十二页**——数据集。这一页此前只有「新建 + 全量列表」，
连关键词都没有；任意组合条件、个人视图、列设置都缺。

- 后端：`api_test/case_services.py` 登记 `DATASET_LIST_FILTER`（view_type=`dataset`，
  label「数据集」），白名单只收 `data_set` 上**真实存在的三列**：`name`（text，项目内唯一
  名所以 EQUALS 恰好一行）、`created_at` / `updated_at`（time）。刻意不进的四类，理由各写
  在登记处：`columns` / `rows` 是 JSON 表格内容（按「第几列叫什么」筛没有语义）、
  `row_count` 是出参里 `len(rows)` 现算的、`used_by` / `scenario_held` 是列表时现算的
  引用计数与拦截标记、`project_id` 是越权正门（由 `ensure_project_access` 管）。
  `DatasetListIn` 增 `filter: str | None`；`data_set_list` 把
  `DATASET_LIST_FILTER.parse(payload.filter)` 串进 `.where(...)`，位置在 order_by /
  `paginate`（游标）之前——**条件先于游标**，翻页接着筛出来的集合走。
- 前端：`datasets.tsx` 在分栏**之上**加 `ListToolbar`（viewType `dataset`）。
  工具栏放全文宽而不是塞进 360px 左栏：视图选择器 + 高级搜索 + 列设置在 360px 里必然折行，
  且条件作用于整页列表，摆在分栏之上才读得出「筛的是左边这列」。列设置两列
  （名称/引用；「引用」同时承载 used_by 徽标与 scenario_held 锁标记，不拆列），
  `applyColumnPrefs([...], colPref)` 包住 columns 并给「名称」补显式 `key`；
  `advFilter` 生效时列表请求带 `filter` JSON（`filterQuery`），空条件整个参数不上线。
- 测试：`tests/test_d223_dataset_advanced_search.py` 5 条（meta 三字段与现算量/表格内容
  排除、条件即 WHERE + EQUALS/OR/BETWEEN、**条件进游标分页不重不漏**、现算量点名必 400
  且带本页清单、跨项目不因条件命中而现身）；`test_d47a_list_filters.py` 的注册清单绊线
  同步到 12 个 view_type；前端 `datasets.test.tsx` +2（空条件不拼 filter / 应用
  「数据集名称包含 参数」发出条件 JSON；列设置勾掉「引用」只藏那一列）。桩补
  `/filter-meta` 与 `/saved-views`。
- 门禁（本轮实测）：D223 + D47-a **36 passed**；dataset 相关回归
  （test_dataset / test_api_case / test_case_resolve / test_agent_metatools_cards）
  **33 passed**；ruff 全过；lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（1 条既有 exhaustive-deps warning 原样保留）；`datasets.test.tsx`
  **14 passed**；web 全量 **2007 passed / 125 files**。
- 仍未做（顺延）：ADB 设备卡片墙（若上工具栏需先定列设置对卡片墙的语义）、
  计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅。

---

## 41. 第 34 刀交付：ADB 设备卡片墙高级搜索（D224，2026-11-23）

D47-a 三件套铺到**第十三页**——ADB 设备卡片墙。这一页此前只有三档状态 Segmented
（全部/空闲/占用/离线）与回收站开关，按名字/串号/启用与否找设备全凭眼睛扫墙。

- 后端：`adb_test/device_services.py` 登记 `ADB_DEVICE_LIST_FILTER`（view_type=
  `adb_device`，label「设备管理」），7 个真实列：`name` / `serial`（text）、
  `connect_type`（enum）、`enabled` / `project_public`（bool）、`created_at` /
  `updated_at`（time）。刻意不进的四类，理由各自写在登记处：
  `state`（空闲/占用/离线）是 Redis 参与的两阶段轴、本页已有自己的 Segmented，
  再塞进条件组就是两把尺子量同一个词；`recycled` / `status` 是视图轴；
  `owner_id` / `updated_by` 是裸 id（界面上没有人名可比）；`last_state` 是心跳 JSON 帧。
  `AdbDeviceListIn` 增 `filter: str | None`；条件组写进 base stmt，位置在 order_by 与
  **两条取数腿之前**——SQL 分页腿与两阶段腿（occupied/idle）筛的是同一份条件后的集合，
  total 天然「筛完再数」；`visible_clause` 在条件之前，非公开仅 owner 可见绕不过。
- 前端：`adbDevices.tsx` 把 `ListToolbar` 放进页头那个 `flex: 0 0 auto` 块、Segmented
  之上；**不给 `allColumns`**——卡片墙没有可切列的表格，组件在 allColumns 为空时不渲染
  列设置入口（§13 纪律 1：不摆点了没反应的假钮）。条件变更与 state/回收站同一口径
  回第 1 页（停在第 5 页套新条件会落空页）；空条件整个参数不上线。
- 测试：`tests/test_d224_adb_device_advanced_search.py` 5 条（meta 七字段与三把尺子/
  心跳帧/裸 id 排除、条件即 WHERE（CONTAINS/EQUALS 布尔/OR/BETWEEN）、**两阶段腿
  state=idle + 条件的 total 是条件筛过的在线全集**、轴点名必 400 且带本页清单、
  可见性不被条件绕过）；`test_d47a_list_filters.py` 注册清单绊线同步到 13 个 view_type；
  前端 `adbDevices.test.tsx` +2（空条件不拼 filter / 应用条件后请求带 JSON 且回第 1 页，
  卡片墙不渲染列设置；先切「空闲」再应用 → `state=idle` 与 `filter` 同时在请求里）。
- 门禁（本轮实测）：D224 + D47-a **36 passed**；ADB 设备回归
  （test_d47b_adb_device_page + 上述两文件）**50 passed**；ruff 全过；
  lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；eslint 0 error；
  `adbDevices.test.tsx` **55 passed**；web 全量 **2009 passed / 125 files**。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、计划定时执行与报告订阅。

---

## 42. 第 35 刀交付：执行计划（D225，2026-11-23）

补的是计划域**最后一块核心闭环**：此前计划能建、能挂用例、能现算执行状态、能手动生成
报告快照，但**没有任何一个入口真的把计划里的用例跑一遍**（`planDetail` 只有状态卡和
「生成报告」）。本刀补上手动执行，逐条回执。

- 后端：`testplan/services.py` 新增 `plan_execute`（`POST /plans/{plan_id}/execute`，
  perm 新位 `testplan:plan:execute` —— 「改计划配置」与「把计划跑一遍」是两件事，
  复用 `:update` 会让「只给改配置权」的角色顺带获得执行权）。要点：
  1. **投递走各域既有执行服务**（`scenario_run` / `ui_case_run` / `adb_case_run`），
     经 REGISTRY 派发（契约 1：领域模块零横向 import）。它们各自做可见性/回收站/环境
     回落/broker 探活/503 无孤儿回滚，并各自再鉴本域运行位——从计划调用**不放大权限**；
     某域 403 只让那一条记跳过，整体不 abort。
  2. **逐条失败不拖垮整批，且失败可见**：`ApiError.message` 原样进 `reason`。
  3. **跑不了的如实跳过**：`api_case`（本仓尚无独立执行引擎，只能经场景跑）与
     `functional_case`（人工结论，D204）不进投递表，各给一句可上屏的理由。
  4. **归档计划 409**（归档是终态，封的就是「继续执行它」）；跨项目与不存在同码同文 404。
  5. 入参按 subject 成形：场景喂 `scenario_id` + 可选 `env_id`（环境覆盖只喂认环境的
     那一家，ui/adb 的执行入参没有 env_id，硬塞会 422 把「能跑」变「全跳」）。
- 前端：`planDetail.tsx` 头部加「执行计划」主钮（`testplan:plan:execute` 且未归档才渲染，
  不摆点了必 409 的假门）；执行后弹「执行回执」——成功与跳过同表（`已投递` 徽标 / 后端
  原话原因），弹层正文写明「投递 ≠ 跑完，结果去报告中心/任务中心看」；状态卡与关联表
  各重取一次（不本地插行）。新增 `planApi.execute` 与 `PlanExecuteItem/Result` 类型。
- 测试：`tests/test_d225_plan_execute.py` 4 条（投递三条 + 两类如实跳过 + 入参成形与
  items 按关联 id 序、单条 503 不拦整批、归档 409 且零投递、跨项目 404 同文 + READONLY
  403）；前端 `planDetail.test.tsx` +2（POST body 恰好 `{project_id, plan_id}`、回执逐条
  列结果且状态/关联各重取；归档计划不摆执行钮），并给 ⑦ READONLY 补「执行钮缺席」。
- 门禁（本轮实测）：D225 + 计划回归（d183_plan_crud 13 / d183_plan_links 11 / d204 4）
  **28 passed**；ruff 全过；lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；
  eslint 0 error；`planDetail.test.tsx` **42 passed**；web 全量 **2011 passed / 125 files**。
  权限矩阵（新位前缀 `testplan` 已在 KNOWN_PREFIX_FAMILIES 内）见本轮收尾记录。
- 收尾记录（权限矩阵补行）：`test_permission_matrix.py` 新增 `plan_execute` 一行（靶子 = 每角色
  一条**空计划**，零关联 → `submitted=0`，不把执行引擎拖进矩阵；`_build_ctx` 增 `empty_plan`），
  并把 docstring 的过期手写数改成实测 **74 行 / 296 格 / 299 例**（`--collect-only` 实测）。
  实测：矩阵全量 **295 passed in 955.54s**（加行前 73 行）；加行后 `-k "plan_execute or
  test_role_table_snapshot or test_perm_prefix_coverage"` **6 passed**，ruff 全过。
- 仍未做（顺延）：计划任务中心 9 端点、工作台余量、**报告订阅**（计划定时执行已由
  D226 补上，见 §43）、`api_case` 的独立执行引擎。


## 43. 第 36 刀交付：计划定时执行（D226，2026-11-23）

补的是一条**已经在用的能力里的断头**：定时任务（§11.4.17 / D30）从 1E 起只认
`subject_type="scenario"`，而计划域 D183–D225 已经能建计划、挂用例、现算状态、生成报告、
手动执行——却没有「按 cron 周期把计划跑一遍」的入口。MS 的计划页正是靠这条把夜间回归
挂到定时器上。

- 后端（`schedule/service.py`）：
  1. `SUBJECT_TYPES = ("scenario", "plan")`，白名单外 422 且 `details.allowed` 报全量；
     `SUBJECT_LABELS` 与白名单由 import 时 assert 钉住（两处漂移 = 422 文案说漏一种）。
  2. **计划任务不绑任务级环境**：`env_id` 在 plan 上没有读面（环境属于计划内的每条关联），
     create 带 `env_id` → 422 显式拒；update 切到 plan 时把旧 `env_id` **清空**并由 GET
     立即可见（PATCH 无法用 null 解绑，不清就是留一个永远读不到的孤儿绑定）。
  3. `fire_task` 按主体分支：plan → `_fire_plan`。后者校验计划存在（`plan_record` 表名
     SQL，不 import testplan）、`archived` 为假（归档是终态），再以创建者身份
     （`_creator_actor` → `ctx_from_actor`）调 **REGISTRY 的 `plan_execute`**——复用
     D225 的逐条派发与回执，不抄第二份「哪些能跑」的判定。回执
     `{ok, plan_id, submitted, skipped, fired_at}` 落 `last_run`，审计
     `schedule_task.run` 带 subject_type=plan 与计数/原因。
  4. 跑不了的四类如实回执且零派发：计划不存在 / 已归档 / 任务创建者已删除 /
     `plan_execute` 未注册；单条 `ApiError`（如 broker 503）由 `plan_execute` 记 skipped，
     不拖垮整批。`fire_task` 仍不抛（worker 不记红账，真相在 last_run + 审计）。
- 后端（trigger 事实口径）：新增 `core.service.trigger_from_entry(entry)`——`agent`→agent、
  `schedule`→schedule、其余→manual；`scenario_run` / `ui_case_run` / `adb_case_run` 三处
  统一改用它。此前「非 agent 即 manual」会把计划定时跑出来的子 run 记成「手动」——
  一件真实发生过的事被记错（`run_record.trigger` 词表本就含 schedule）。
- 前端（`schedules.tsx`）：
  1. 主体类型下拉从「焊死在 scenario」放开为两值；切换主体清空 `subject_id`（旧 id 属于
     另一张表）并在切到 plan 时清空 `env_id`。
  2. 抽屉候选按类型取：场景 → 页体那份 `/scenarios`；计划 → 新增页体 `/plans` 候选
     （一次请求，主体列与抽屉共用）。plan 态**不渲染**环境框（不是灰着）。
  3. 主体列按 `subject_type` 各查各的名单（两张表的 id 空间不混用），名单外仍画截断 id。
  4. 页头描述改为「场景或测试计划」。
- 测试：后端 `tests/test_d226_schedule_plan.py` **12 passed**——白名单四值 422 + allowed
  清单、plan 带 env 422、切主体清 env 且二次带 env 422 原行不动、fire 派发（入参成形 +
  `ctx.entry=="schedule"` + last_run 计数）、单条 503 记 skipped、计划不存在/已归档/
  创建者已删除三种零派发回执、`trigger_from_entry` 映射。前端 `schedules.test.tsx`
  **113 passed**（原 D30「控件焊死」用例改写为两值行为：切计划→环境框消失、候选换
  `/plans`、POST body `subject_type=plan`/`env_id=null`；新增主体列 plan 名称解析）。
- 门禁（本轮实测）：D226 **12 passed**；schedule 回归（test_schedule_service /
  test_schedule_1e / d162_schedule_overlap / schedule_notify_hook / schedule_beat）
  **54 passed**；scenario/adb/golden 执行回归 **26 passed**；ui_case/ui_debug
  **35 passed**；ruff 全过；lint-imports **4 kept, 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（schedules.tsx 有 1 条**历史遗留** `Table` 未用 warning，本刀未引入）；
  `schedules.test.tsx` 113 passed；web 全量 **2012 passed / 125 files**（117s）。
  权限矩阵不受影响（D226 未新增权限位，schedule 行原样）。
- 仍未做（顺延）：计划任务中心 9 端点、**报告订阅**、`api_case` 的独立执行引擎
  （工作台「我的待办」已由 D227 补上，见 §44）。


## 44. 第 37 刀交付：工作台「我的待办」（D227，2026-11-23）

MS 工作台的「我的待办」把两件人类要做的事摆在一屏：**待我执行**（计划里指派给我的
功能用例）与**待我评审**（我参与评审、还没出结论的用例）。我们此前工作台只有四张统计卡、
趋势、最近运行/编辑、快捷入口——计划关联从 D206 起就有 `executor_id`，评审从 D219 起就有
评审人表，两个数都算得出来，缺的只是把它们摆上工作台。

- 后端（`workbench/services.py`，**不新增端点**，扩 `GET /workbench-stats` 的响应）：
  1. `todos` 两桶：`my_execution_total/items` + `my_review_total/items`；total 与 items
     **两条查询吃同一份谓词**，items 至多 10 条——「待我执行 12」而列表 1 条时前端写
     「另有 11 条未列出」，不让列表长度冒充总数。
  2. 待我执行谓词：`plan_case_link.project_id` + `executor_id = 我` +
     `subject_type = functional_case` + 计划未归档 + 功能用例 `status != recycled` +
     **NOT EXISTS plan_functional_exec(link_id)**。只认功能用例是口径不是遗漏：其余类型
     由计划「执行」自动投递，没有「人工点结论」的动作（把自动化的事派给人是一种撒谎）。
  3. 待我评审谓词抽到新文件 `review/queries.py::my_todo_review_ids`，`review_list` 的
     `my_todo` 与工作台**共用一份实现**（两份会各自漂移：「工作台说 3 条、评审页筛出 2 条」
     没法向用户解释）。语义沿用列表既有口径：我是该用例评审人 且 `case_review_case.result`
     仍 `pending`（用例级聚合结论，规则 single/all 的判定仍只在 `_case_result` 一处）。
  4. 跨项目按 `project_id` 显式过滤；READONLY 能读（`workbench:read` 被 `*:read` 罩住）
     且待办为空（它没有指派）；非成员 403。
- 前端（`workbench.tsx`）：新增「我的待办」卡片（`wb-todos`），计数行
  `待我执行 N · 待我评审 M`；两桶各列计划名+用例名+优先级 / 评审名+编号，点击跳
  `/plans/{id}`、`/reviews/{id}`；两桶皆空画「暂无待办」。`todos` 在类型上可选并回落
  空值（老桩/老响应不至于让整页崩）。
- 测试：后端 `tests/test_d227_workbench_todos.py` **5 passed**——待我执行成正向且
  **写真实人工结论后消失**（走 `/plans/{id}/functional-cases/execute`，不直改库）、
  归档/他人指派/自动化类型/回收用例四类排除、待我评审正向且提交评审结论后消失、
  跨项目分账、READONLY 空待办、非成员 403；评审与工作台回归
  （test_d194 / test_d221 / test_workbench_stats / D227）**27 passed**。
  前端 `workbench.test.tsx` **20 passed**（原 18 + 新增 2：空态计数 0/0；有数据逐条渲染 +
  total 12 > 列表 1 → 「另有 11 条未列出」+ 点击真落地 /plans、/reviews）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（workbench 作为
  composition 层读 review/queries 与 functional/testplan 模型在契约内）；`tsc --noEmit` 0；
  eslint 0；web 全量 **2014 passed / 125 files**（115s）；权限矩阵 workbench 行
  **4 passed**（READONLY/MEMBER/PA/SYS 全 2xx，READONLY 由 `*:read` 罩住）。
  权限矩阵无新增位（workbench_stats 行原样，响应加字段不影响 2xx 形状）。
- 仍未做（顺延）：计划任务中心 9 端点、**报告订阅**、`api_case` 的独立执行引擎
  （工作台「我的待办」已由 D227 补上，见 §44；接口用例独立执行已由 D228 补上，见 §45）。


## 45. 第 38 刀交付：接口用例独立执行（D228，2026-11-23）

MS 的接口用例是能单独点「运行」的一等执行对象；我们此前只有两个入口：场景引用
（`run_api` 被场景引擎调）与调试。D225 的计划执行因此把 `api_case` 归进「跑不了，
如实跳过」，这不是一个能长期成立的口径——用户把接口用例挂进计划，就是为了让它跑。

- 后端（`api_test`）：
  1. `services._execute_case(ctx, project_id, case_id, env_id, extra_vars=None)`：把
     `api_debug(case_id)` 原本内联的整套执行步骤原样抽出（`_visible_case` 可见性 →
     用例/定义回收站 404 → `merge_request` 分层合并 → 数据集首行 → `env_resolve`
     环境变量/请求头/超时 → `run_api`），返回 `(result, 请求快照, 环境名, 用例名)`。
     **不新写第二套执行器**：两套「用例怎么跑」的实现会在变量层或超时默认值上各自
     漂移，而调试面已被大量用例钉住，抄一份必然走样。
  2. `case_services.api_case_run`：新权限位 `api:case:run`，`POST /api-cases/{case_id}/run`
     （body：`project_id` + `case_id` + 可选 `env_id`）。调 `_execute_case` 后经
     `save_run` 落 `subject_type="api_case"` 的 run_record，trigger 走
     `trigger_from_entry(ctx.entry)`——HTTP 手动 = `manual`、定时计划重建的
     ctx = `schedule`，不冒充调试（调试入口仍 `api_debug`，trigger=`debug`）。
  3. 计划执行（`testplan/services.py`）：`_PLAN_RUN_SERVICES` 增
     `"api_case": "api_case_run"`；`plan_execute` 的 description 与判断 3 改为
     「只有 functional_case 人工执行跳过」；四类自动化关联（场景/UI/ADB/接口）都进投递表。
- 前端（`api/CaseList.tsx`）：用例行新增「运行」按钮（`can(perms, "api:case:run")`），
  POST 带 `project_id/case_id/env_id`；通过 → 「执行通过（HTTP 200）」、未通过 →
  「断言未通过（HTTP …）」，成功后 `onChanged` 通知父级刷新；回收站视图不摆按钮。
- 测试：后端 `tests/test_d228_api_case_run.py` **4 passed**——落 run_record 且
  `trigger=manual`/`subject_type=api_case`/`subject_name` 正确；**与调试共用链**
  （两次执行的 `request_snapshot` 逐字相等，只 trigger 不同）；`entry=schedule` 直调
  handler → `trigger=schedule`；READONLY 403 / MEMBER 200；用例或定义在回收站 404
  且零 run_record。`test_d225_plan_execute.py` 改造后 **4 passed**（api_case 由「跳过」
  改为投递，断言 `case_id` 入参与 submitted 4/skipped 1——只剩功能用例跳过）。
  前端 `CaseList.test.tsx` **25 passed**（原 22 + 3：入参与「执行通过」且通知父级；
  未通过回「断言未通过」；无 `api:case:run` 不摆按钮）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（CaseList.tsx 有 1 条**历史遗留** `load` 依赖 warning，非本刀引入）；
  web 全量 **2017 passed / 125 files**（114s）；权限矩阵 api/plan_execute 子集
  **26 passed**（`api:case:run` 归 api 前缀族，矩阵无新增行；位名真守护在
  test_d228 的真实角色用例：READONLY 403 / MEMBER 200）。
- 仍未做（顺延）：报告订阅（需先定「计划执行完自动生成报告」时机）、计划任务中心
  9 端点、`api_case` 在报告中心的对象类型展示、其余列表页高级搜索。


## 46. 第 39 刀交付：定时计划报告 / 报告订阅（D229，2026-11-23）

§45 把「报告订阅」列为顺延项时写的前提是「需先定时机」。本刀把时机定死在一个**已经
存在的事件**上：**cron 触发（`schedule.fire`）**。不发明「计划执行完成」这种本仓不存在的
时刻（`plan_execute` 是逐条投递：inline 下同步跑完，celery 下立即返回，没有单一完成点），
而是让订阅本身成为一个定时任务主体 `plan_report`——到点生成一份报告快照并推渠道。
这就是 MS「报告订阅」在我们这套架构里能诚实成立的最小形态，且每一环都有真相。

- 后端：
  1. `schedule.service`：`SUBJECT_TYPES = ("scenario", "plan", "plan_report")`（词表与
     `SUBJECT_LABELS` 由 import 期 assert 钉住不分叉）；`_check_env_binding` 对
     **计划类主体**（plan/plan_report）带 env_id → 422；`update` 切到计划类主体时清空
     旧 env（模型注释同步为三值）。
  2. `_fire_report`（D229 的判断 3 条写在函数上方）：① 生成复用 `plan_report_create`
     （REGISTRY 按名取、`ctx_from_actor(创建者)`、`ctx.entry=schedule`）——不另写一份
     取数；② **归档计划照样出报告**（与 plan_report_create 判断 3 同源：归档封执行不封
     出凭证），所以 plan 主体的 409 规则不搬过来；③ **报告先成立、通知后发生**：报告行
     已 commit 才调通知钩子，通知失败只体现在回执 `channels/notified` 上。回执字段：
     `report_id/report_name/status/total/passed/failed/executed/not_executed/notified/
     channels/reason/fired_at`；跑不了（计划不存在/创建者已删除）→ `ok=false` + 人话
     reason，零报告。
  3. `core.service` 新增 **`set_report_notify_hook` / `notify_report`**：形状与
     `set_run_finalized_hook` 同款（core 只调钩子、不认识 notify）；钩子异常一律吞并
     返回 `[]`（通知是旁路，worker 不许因此记红账）；`main.create_app` 接线
     `notify.hooks.on_report_notified`——schedule 与 notify 之间仍然零横向 import。
  4. `notify`：`template.render_report`（计划名/状态/总数/通过/未通过/未执行/通过率/
     执行率/相对链接，键控渲染、缺键不显、未知状态画原码）；`hooks.on_report_notified`
     逐渠道发送并复用 `_send_one` 落 `last_send`，返回逐渠道回执；渠道行已删 →
     `ok=false`「渠道不存在」；空 channel_ids → `[]`（没绑就是没发，不造假）。
- 前端（`pages/schedules.tsx`）：主体下拉第三项「计划报告（plan_report）」；候选
  `isPlanSubject` → `/plans`（subject_id 也是 plan_id）；切主体清 subject_id，非 scenario
  连带清 env；主体列对 plan/plan_report 都用计划名单解析名字；`LastRunCell` 新增报告
  分支——有 `report_id` 画「已生成报告 + 详情链接 + 总数/通过 + 未推送原因」，
  plan_report 的失败回执画「本次未生成报告」，不再冒用「未产生执行，不会回结果」。
- 测试：后端 `tests/test_d229_schedule_plan_report.py` **10 passed**——白名单收
  plan_report 且带 env 422；切主体清 env；fire 生成快照（计数/状态/明细 result=none、
  无渠道时 notified=false + reason）；连发两次两份快照 id 不同；计划不存在/创建者已删除
  → ok=false 且零报告；归档计划照样生成（status=archived）；绑渠道真发（替身发送器、
  正文含计划名与 `/plan-reports/<id>`、渠道 last_send 落账）；渠道行已删逐条
  ok=false「渠道不存在」；**钩子自身炸了**（core 吞异常返回 []）→ 回执
  「通知发送异常（已记日志），报告已生成」而不是冒充「未绑定通知渠道」。
  `test_d226_schedule_plan.py` 的 allowed 断言随词表改为
  `["scenario","plan","plan_report"]`；d229+d226 合跑 **22 passed**。前端
  `schedules.test.tsx` **117 passed**（114 + 3：plan_report 抽屉保存体、主体列计划报告行、
  报告回执两形状——已生成/本次未生成）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（schedules.tsx 有 1 条**历史遗留** `Table` 未使用 warning，非本刀引入）；
  web 全量 **2021 passed / 125 files**；后端相关面 `test_d229 + test_d226 + test_notify +
  test_schedule_notify_hook + test_d183_plan_reports` **59 passed**；权限矩阵
  `-k schedule` **8 passed**（未新增权限位）。
- 仍未做（顺延）：计划任务中心 9 端点（无异步任务消费者，容易空转表）；计划的「执行完
  自动生成报告」（本仓无单一完成点，需先有异步计划级 run 或完成事件）；报告分享链接的
  订阅版（当前报告详情已有只读链接，订阅走本刀定时任务）；脑图。


## 47. 第 40 刀交付：计划报告导出（D230，2026-11-23）

MS 的计划报告有「导出」。本仓此前报告只能在页面里看，离线/归档场景没有凭证。本刀补上
导出，但**不引 PDF 依赖**（weasyprint/reportlab 都不在依赖树里，为一个导出加一条重依赖
不划算），导出为**自包含 HTML**：可离线打开、浏览器可直接打印为 PDF，且不丢任何快照字段。
偏差逐字写进服务 docstring / README，不装成「和 MS 一样」。

- 后端：
  1. `schemas.PlanReportExportOut`：`{filename, media_type, content, item_count}`——
     **JSON 文本载体**而不是 `FileResponse`。理由是注册表：本仓每个端点都在 @service 里
     （权限矩阵/审计/OpenAPI/路由探针同一张网），绕出去做 raw 路由就漏一张网；
     `defect_export` 的 CSV 文本载体是同一条先例，前端 `downloadBlob` 落地。
  2. `testplan.services.plan_report_export`（GET `/plan-reports/{id}/export`，
     perm=`testplan:report:read` 复用、不新增位）：与详情同一条读路径（`_report` +
     `_report_out`），率/计数/明细全部抄快照，**零现算零 join**。
  3. `_report_html`（纯函数）：自包含 HTML（内联 CSS、零外链）；用例名/环境 id/报告名/
     词表外的状态与结论全部 `html.escape`（导出文件会在浏览器里打开）；词表外值画原码；
     空报告如实写「（该报告没有明细行）」；页脚写明「快照副本，不是实时数据」。
  4. `_html_filename`：报告名里的 `\ / : * ? " < > |` 换 `_`，日期取 `created_at[:10]`。
- 前端：
  1. `planApi.exportReport(reportId, projectId)`：GET 导出端点，返回类型是本地
     `{filename, media_type, content, item_count}`（OpenAPI 没有这个出参类型时不用 any）。
  2. 报告详情页新增「导出 HTML」按钮（`data-testid=plan-report-detail-export`）：
     `downloadBlob(new Blob([content], {type: media_type}), filename)`，成功话术
     「已导出 N 条明细（文件名）」；失败不落地文件（client 原话 toast）。
- 测试：
  - `tests/test_d230_plan_report_export.py` **6 passed**：HTML 转义（用例名/报告名里
    的 `<script>`/`<b>` 只以 `&lt;…&gt;` 出现）；快照不回流（报告生成后再挂关联，
    导出仍 1 行、不含后来者、头行总数仍 1）；文件名净化且改名后跟着新名字；READONLY
    可导出 + 跨项目 404 与不存在同码同文；陌生人 403「无此项目权限」；纯函数腿
    （词表外 status/result 画原码仍 escape、空明细行话术）。
  - 前端 `planReportDetail.test.tsx` **24 passed**（22 + 2）：导出请求带 project_id、
    Blob 内容逐字 == 后端 content（size 相等）、成功话术带文件名与条数；失败腿零下载。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error（`planReportDetail.tsx` 有 1 条**历史遗留** `tp` 未使用 warning，非本刀
  引入）；web 全量 **2023 passed / 125 files**；后端 `test_d230 + test_r157` **8 passed**；
  注册表/矩阵/哨兵组合（`test_registry + test_model_usage + test_permission_matrix +
  test_d110 + test_d164 + test_d229 + test_d226`）**352 passed**；**干净全量后端
  1851 passed / 2 failed**（48:54）——两条失败都是 ADB 域的既有用例
  （`test_cancel_stops_sleep_within_one_second` 与 `test_debug_…` 的 401），与 D229/D230
  零交集；**单独重跑 2 passed（6.28s）**，判定为全量长跑下的时序/令牌抖动（49 分钟跑到
  后段时 ADB 用例的登录态与切片计时受负载影响），不是本刀引入的缺陷。
- 一次真实教训（已写进证据链）：全量后端跑**期间**改了 `testplan/services.py`（插本刀
  代码），`test_r157_project_scope_coverage` 用 `inspect.getsource` 按行号取源码，行号
  错位当场红两条（「解析串到了邻居函数」）。**测试跑期间不改被测源文件**；停手后重跑
  该文件 2 passed。上一轮全量 1845 passed / 2 failed 的 2 条即此因，不是代码缺陷。

## 48. 第 41 刀交付：计划关注人（D231，2026-11-23）

MS 计划域有「关注人」（`TestPlanController` 关注/取消关注 + 列表按关注筛）。本仓缺陷域早已有
关注（`defect_follower` + `followed_by_me`），计划域一直空着——同一个人对计划的关注无处可放。
本刀按缺陷先例补齐，并把「我关注的」做成计划列表的**视图轴**（不是高级搜索字段：
关注不是 `plan_record` 上的列，是关系表里的行——同缺陷 `followed_by_me` 的口径）。

- 后端：
  1. `models.PlanFollower`（表 `plan_follower`）：复合主键 `(plan_id, user_id)`，另带
     `project_id` 显式索引与 `created_at`。**不建 `updated_at`**——关注关系没有更新语义，
     建了就是一列永远等于 `created_at` 的假列；**不建 `followed` 反向列**——真相是行在不在。
  2. 迁移 `0043_plan_follower`：只建一张表、无 DML；`check_migration_down` 登记
     `{"0043": ["plan_follower"]}`；五处「链头唯一」断言同步到 0043。
  3. `schemas`：`PlanListRowOut(PlanOut)+followed`（列表只回答「我」，不做每页 GROUP BY
     凑关注总数）、`PlanDetailOut(PlanOut)+followed+follower_count`、`PlanFollowIn`、
     `PlanFollowOut{following, follower_count}`；`PlanListIn.followed_by_me`。
     写路径（create/update/archive/copy）仍返回 `PlanOut`——不凭空补库外没读过的两位。
  4. `services`：`_followed_ids`（一页一条 IN 批量查，绝不逐行）与 `_follower_count`（现查）；
     `plan_list` 在分页**之前**加 `followed_by_me` 条件（`total` 吃同一份 WHERE），分页后
     一次批量标 `followed`；`plan_get` 现查两问。
  5. `plan_follow` / `plan_unfollow`（POST，perm=`testplan:plan:update`）：幂等——重复关注
     不插第二行、重复取关不报错；回执 `follower_count` 是操作后现查行数，不是「本次影响数」。
     **写副作用走写位**，不借 read（MS 用 READ 位，我们按本仓纪律不跟）；归档计划仍可关注
     （归档是执行编排终态，不是「话题关闭」，后端不设这道闸）。
  6. `_purge_plan` 同事务按 `plan_id` 删净关注行（零外键纪律的应用层级联），单删与批量删共用。
- 前端：
  1. `web/src/api/plan.ts`：手写 `PlanRow` / `PlanDetail` / `PlanFollowOut` 交集
     （gen:api 禁跑，不抢业主 :8321 的服务），`followed_by_me` 进查询类型，新增 `follow`/`unfollow`。
  2. 计划列表：名称旁星标（只在 `testplan:plan:update` 在位时渲染；回执只改这一行，
     「我关注的」视图里取关则重取列表——分页总数必须由后端重算），工具条新增「我关注的」
     开关（读行为，无写位也能用；打开带 `followed_by_me=true` 并回第 1 页）。
  3. 计划详情：关注/取关钮 + 「N 人关注」；归档回执是 `PlanOut`，合并时保留已读到的
     followed/count（不让一次归档把星标抹成未关注——那不是后端答过的）。
- 测试：
  - `tests/test_d231_plan_follow.py` **8 passed**：幂等两问 + 库里行数；详情两问现查
    （换成员看同一计划 followed 翻、count 不翻）；列表标志位逐行 + `followed_by_me`
    的 items 与 total 同条件 + 无关注者空页 total=0；跨项目与不存在同码同文案（follow/
    unfollow/get 三处）；单删/批量删级联（别的计划一根毫毛不动）；归档仍可关注；
    READONLY 可读不能关注（403 带 `testplan:plan:update`）、MEMBER 可关注、陌生人 403；
    复制不抄关注（复制件 0 人、源计划仍 1 人）。
  - `tests/test_d183_plan_crud.py`：详情比对摘掉 D231 的两问并单独钉「新计划 = 未关注/0 人」
    （写路径不回答这两问是设计，不是遗漏）。
  - 前端 `plans.test.tsx` **+3**、`planDetail.test.tsx` **+2**：星标按当前态选
    follow/unfollow 且 body 恰为 `{project_id}`、回执数字照抄（桩给 3 人，本地 +1 会显示 1）、
    「我关注的」带 `followed_by_me=true` 且回第 1 页、关掉即不传；READONLY 无星标无关注钮、
    但「N 人关注」与筛选开关照常。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error；`plans.test.tsx + planDetail.test.tsx` **78 passed**；后端 12 文件组合
  （`test_d231 + test_d183 + test_d208 + test_d209 + test_d212 + test_d225 +
  test_permission_matrix + 五个迁移断言文件`）**384 passed / 17:57**；矩阵补 D231 两行
  与 `test_d183` 导入整理后**最终重跑 328 passed / 16:33**；web 全量
  **2028 passed / 125 files**（D230 的 2023 + 本刀 5）。

## 49. 第 42 刀交付：功能用例批量编辑（D232，2026-11-23）

MS 功能用例列表支持勾选后批量改属性。本仓此前只能一条条编辑——这个「基础功能」缺着，
用例一多就是折磨。本刀只开**两个真实列**（优先级 / 模块），其余（名称、描述、模板、
自定义字段）属「覆盖内容」，语义与风险都不同，不混进批量。

- 后端：
  1. `CaseBatchUpdateIn{project_id, case_ids(1..200), priority?, module_id?, module_set}`
     ——`module_set` 是哨兵：JSON 里 `null` 与「缺省」在 Pydantic 里都是 `None`，
     没有它分不清「不改模块」与「移到未分组」。`priority` 吃与单条编辑同一个
     `_PRIORITY_PATTERN`，不另立词表。
  2. `functional_case_batch_update`（POST `/functional-cases/batch-update`，
     perm=`functional:case:update`，`tool=False`）：两字段都不给 → 422 `empty_update`
     （先拦，不静默成功）；`case_ids` 有重复 → 422 `duplicate_case_ids` **整批不写**
     （半改比不改更难收拾）；`module_set` 且 `module_id` 非空才做 `_module(...)` 归属校验。
  3. 选择面：`project_id + id.in_ + status==STATUS_NORMAL`——回收站与跨项目行不参与，
     `affected` 只数真正落入 UPDATE 的行（不是 `len(case_ids)`）。
- 前端：
  1. `functional.ts` 手写 `CaseBatchUpdateBody`（与后端字段同名同义），新增 `batchUpdate`。
  2. 列表：`rowSelection` 只在「有 update 位且非回收站」时传——回收站里的用例按后端口径
     本就不参与，不摆一个必然报错的勾选列；`load()` 开头清空勾选（结果集换了，
     旧勾选不对新行负责）。
  3. 批量弹层：优先级 `allowClear`（留空=不改）+ 模块下拉三态（`__keep__` 不修改 /
     `__unfiled__` 未分类 → `module_id:null` / 具体模块）；两个字段都空先 `message.warning`
     拦住，不发一次注定 422 的请求；成功话术 `已更新 N 条` 用后端 `affected`，随后刷新
     列表与模块树（直属用例数会变）。
- 测试：
  - `tests/test_d232_functional_case_batch_update.py` **5 passed**：只改优先级不动模块/
    内容；`module_set` 哨兵两态（含 `module_id:null`=未分组、只改优先级不动模块）；
    空/重复/坏模块（422/422/404，且库值不变）；只改正常态（回收站/跨项目不参与、
    `updated_by` 落账）；READONLY 403 带 `functional:case:update`。
  - 前端 `functionalCases.test.tsx` **+4**：勾选两条改优先级+未分类 → body **精确等于**
    `{project_id, case_ids, priority, module_set:true, module_id:null}` 且成功话术/刷新；
    只改优先级 → body 不含 `module_set`/`module_id`；两字段都不选 → 前端拦住零请求；
    READONLY 与回收站视图都没有勾选列与批量按钮。
  - 交互踩坑记一笔：antd 两字中文按钮会自动插空格（「保 存」），
    `getByRole("button",{name:"保存"})` 找不到——用 `/保\s*存/` 定位。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error；`functionalCases.test.tsx` **10 passed**；后端
  `test_d232 + test_d193 + test_d219` **14 passed / 25.86s**；web 全量
  **2032 passed / 125 files**（D231 的 2028 + 本刀 4）。

## 50. 第 43 刀交付：功能用例批量复制（D233，2026-11-23）

复制是 MS 用例列表最常用的动作之一（选几条 → 复制到某模块/改名再改）。本仓此前只能
新建空用例再手抄——D232 把「批量改」补上后，「批量生」就是同一排按钮上缺的那一个。

- 后端 `POST /functional-cases/batch-copy`（perm=`functional:case:create`，`tool=False`）：
  1. **复制 = 新建**：本仓没有 MS 的 copy 专用权限位，复制产出的就是一条新用例，
     用 create 位才与「能不能建」同尺；每条 `num` 新取，`created_by/updated_by` 是操作者。
  2. **content 全抄、关系不抄**：模板、名称+后缀、优先级、描述、自定义值（
     `functional_case_field` 随行复制）都跟着走；评论与前后置关系说的是「源那一条」的
     事，刻意不复制（测试钉住副本 0 评论/0 关系）。
  3. **module_set 哨兵**与 D232 同款：缺省 = 副本各留源模块；`true+module_id` = 全落到
     目标模块；`true+null` = 未分类。坏模块 404 且零新行。
  4. **只复制正常态**：回收站/跨项目/不存在的 id → 404 带 `case_ids`，**整批不写**
     （既不做半批，也不借 404 泄露别项目用例的存在性）。
  5. 重复 id 去重保序（`dict.fromkeys`）：复制两次同一条只产出一个副本。
  6. 名称+后缀 > 255 → 422 `name_too_long`（带 `case_id`），零新行；后缀可为空串
     （副本与源同名，本仓名称不要求唯一）。
- 前端：`batchCopy` + `CaseBatchCopyBody`；勾选列沿用 D232 的（有 update 位且非回收站），
  「批量复制（N）」按钮按 `functional:case:create` 单独判权——只有 create 位没有 update 位
  的角色看不到勾选列，这是已知口径（列表目前只有一套勾选）。复制弹层：目标模块默认
  「保持原模块」+ 可编辑后缀（默认「（副本）」），成功后话术用回执 `affected`，并刷新
  列表与模块树（副本会让模块计数变化）。
- 测试：
  - `tests/test_d233_functional_case_copy.py` **7 passed**：内容随行+源不动（含自定义值/
    模板/描述/new num/操作者）；`module_set` 三态与坏模块零新行；回收站/跨项目/空数组
    （404/404/422）且整批不写；重复 id 去重；评论与关系不复制；后缀空串与超长 422；
    READONLY 403（`details.perm=functional:case:create`）/MEMBER 200。
  - `functionalCases.test.tsx` **+3**（共 13）：复制到未分类 → body **精确等于**
    `{project_id, case_ids, name_suffix:"（副本）", module_set:true, module_id:null}` 且
    成功话术/刷新；默认保持原模块+后缀留空 → body 不含 `module_set`、`name_suffix:""`；
    READONLY 与回收站视图无复制按钮（也无勾选列）。
  - 踩坑：工具栏「批量复制（2）」也含「复制」二字，`getByRole("button",{name:/复\s*制/})`
    会撞上——按弹层标题 `closest(".ant-modal")` 收窄再点页脚按钮。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error；`functionalCases.test.tsx` **13 passed**；后端
  `test_d233 + test_d193 + test_d232 + test_d219` **21 passed / 37.89s**；web 全量
  **2035 passed / 125 files**（D232 的 2032 + 本刀 3）。

## 51. 第 44 刀交付：功能用例关注（D234，2026-11-23）

MS 用例支持「关注」（`/test/case/follow/{caseId}` 取关注人、`/edit/follows/{caseId}` 设关注人）。
本仓的缺陷与计划都已有关注（D1xx/D231），唯独用例没有——用户没法「盯住一条用例」。
本刀按 D231 的形制补齐，并在两处做了取舍：

- 后端：
  1. `functional_case_follower`（迁移 0044）：复合主键 `(case_id, user_id)` + `project_id`
     索引 + 只有 `created_at`。**不建 followed 冗余列**——真相是行在不在；也不建
     `updated_at`（关注态没有「改」这个动作）。
  2. `POST /functional-cases/{case_id}/follow|unfollow`：幂等；回执
     `{following, follower_count}` 里的 count 是操作后**现查**的行数，不是本次影响数。
     写副作用走 `functional:case:update`（写位不借 read，同 D231 计划的口径）。
  3. 列表新增 `followed_by_me` 视图轴：与模块/未分组/关键词/高级搜索**并行 AND**，
     分页与 `total` 吃同一份 WHERE（不是筛后本地截断）；行上的 `followed` 用一页一条
     `IN` 查（不逐行 N+1）。详情返回 `CaseDetailOut{followed, follower_count}`，
     创建/更新回执仍是 `CaseOut`（回执形状不因读路径加字段而变）。
  4. 彻底删除（单删 `_purge_one` / 批量删复用同函数）同事务删净关注行：零外键纪律下
     级联写在应用层，漏一处就是孤儿行。
  5. 回收站用例**仍可**关注/取关（用户可能先关注等恢复；后端没有这道闸，测试钉住
     「没有」，防后来人顺手加个没需求的 409）。
- 前端：
  1. `functional.ts`：`CaseRow.followed?`、`CaseDetail`、`CaseFollowOut`、`followCase/
     unfollowCase`，列表查询加 `followed_by_me?`。
  2. 列表：名称旁星标（`data-followed`），只有有 update 位才渲染；点星只改本行，
     **在「我关注的」视图里取关后整页重取**（那行不该再出现）；「我关注的」开关是
     读行为，后端视图轴，不做本地过滤。
  3. 详情：顶部关注钮 + 「N 人关注」；保存后把更新回执 merge 进原 row（保留
     followed/count，不被 `CaseOut` 的形状冲掉）。
- 测试：
  - `tests/test_d234_functional_case_follow.py` **8 passed**：幂等与现查计数；详情两问
    现查（换成员 followed 翻、count 不翻）；列表标志位 + `followed_by_me` 的 items/total、
    分页、非法布尔 422；跨项目与不存在同码同文案（follow/unfollow/get 三处）；单删/批量删
    级联；回收站仍可关注/取关；READONLY 可读详情但关注 403（`details.perm=
    functional:case:update`）、MEMBER 200、非成员 403；复制不抄关注（D233 交叉）。
  - 前端 `functionalCases.test.tsx` **+3**（共 16）：点星只改本行且 body 恰为
    `{project_id,case_id}`（不触发整页请求）；「我关注的」开关前后 URL 的
    `followed_by_me` 如实（关掉后参数整个下线，不是 `=false`）；READONLY 无星标但有开关。
  - 详情页此前没有独立测试文件，本刀没为它新起一套 mock 携带（模板/树/成员/评审/评论/
    附件），关注钮由 tsc+eslint 与后端两问测试兜底。
- 迁移链：头断言 5 处（test_adb_models / test_d187_defect_models / test_role_services /
  test_schedule_models / test_ui_models）与 `scripts/check_migration_down.py` 的 EXPECT
  已同步到 0044；`check_migration_down 0044` 实跑 up→down→up 通过（表真消失、真回来）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**；`tsc --noEmit` 0；
  eslint 0 error；`functionalCases.test.tsx` **16 passed**；后端
  `test_d234 + test_d233 + test_d232 + test_d219 + test_d193 + test_registry +
  test_dispatcher` **46 passed / 70.20s**，迁移链 5 文件 **43 passed / 39.71s**；
  web 全量 **2038 passed / 125 files**（D233 的 2035 + 本刀 3）。

## 52. 第 45 刀交付：功能用例导出与列表同一把尺（D235，2026-11-23）

这是 D219/D234 留下的**正确性债**：列表按高级搜索/我关注的筛完，用户点「导出」拿到的
却是「模块+关键词+优先级」那一套老条件的结果——多出来的行不会被用户察觉，还以为是
筛选失效。导出与列表必须是同一把尺，这不是新功能，是补一个静默错误。

- 后端（`functional/routes.py` 的 export，仍单一路由、不动交换层）：
  1. `filter`：**直接复用列表的 `FUNCTIONAL_CASE_LIST_FILTER.parse`**——不是照抄一份
     白名单（两份迟早漂移）；非法条件 400 `bad_filter` 带本页可筛清单，**不降级成忽略**
     （忽略等于导出没筛过的全量，比报错更坏）。
  2. `followed_by_me`：与 D234 列表视图轴同一子查询（`user_id + project_id`）。
  3. `ids`：逗号分隔的「导出所选」，与其它条件 AND、与 `project_id` 硬边界 AND；
     空串 422 `empty_ids`、超 500 条 422 `too_many_ids`（导出是同步流式生成，
     无上限会被一次勾全选拖垮）。
  4. 权限不变：仍是 `functional:case:read`（导出不产生写副作用）；READONLY 可用。
- 前端：
  1. `exportCases` 类型补 `filter / followed_by_me / ids`；`exportCases()` 现在带
     当前高级搜索与「我关注的」——**所见即所得**。
  2. 勾选非空时工具栏出现「导出所选（N）」：只发 `ids`（不叠加筛选，语义是
     「就导这几条」）。
- 测试：
  - `tests/test_d235_functional_case_export_scope.py` **4 passed**（新）：`ids` 只导所选且
    别项目 id 不串入；`filter` 与列表同条件同结果 + 非法字段 400 `bad_filter`；
    `followed_by_me` 只导我关注的；`ids` 空/超限 422 且 READONLY 仍可导出。
    全部断言读**真 xlsx 字节**（openpyxl 取「用例」页列值），不是只看 200。
  - 前端 `functionalCases.test.tsx` **+3**（共 19）：高级搜索后导出 URL 的 `filter` 与列表
    同一份 JSON 且无 `ids`；勾选两条 → 「导出所选（2）」→ URL 恰 `ids=c1,c2` 且无
    `filter`；「我关注的」开着导出带 `followed_by_me=true`。导出走真 `getBlob` 路径，
    jsdom 的 `createObjectURL/revokeObjectURL` 按 api.test.tsx 同款桩掉。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件/1238 依赖）；
  `tsc --noEmit` 0；eslint 0 error；`functionalCases.test.tsx` **19 passed**；后端
  `test_d235 + test_d205 + test_d219 + test_d234 + test_d233` **28 passed / 51.05s**；
  web 全量 **2041 passed / 125 files**（D234 的 2038 + 本刀 3）。











## 53. 第 46 刀交付：功能用例统计（D236，2026-11-23）

这是功能用例页最后一个「看得见但点不动」的基础面：模块树徽标只回答「本模块直属几条」，
页头只回答「当前筛选下几页」，没有一个地方能回答「P0 有多少、谁建的、未分类多少」。
MS 把它放在 `/report/test/case/count/getReport`（X 轴 creator/maintainer/casetype/
casestatus/caselevel，Y 轴 testCase/apiCase/scenarioCase/loadCase）。本仓只复刻**有真列
支撑**的那部分，缺的列不硬造——统计轴必须是真列，否则就是假报表。

- 后端（`functional/services.py` + `schemas.py`，一个 `@service`）：
  1. `POST /functional-cases/stats`，perm=`functional:case:read`（只读；POST 是为了避开
     `GET /functional-cases/{case_id}` 的路由匹配顺序——`export` 住独立 router 才没事，
     本端点住注册表，`stats` 会被当成 case_id）。MS 的统计本身也是 POST。
  2. `group_by ∈ priority/module/creator`（Literal，写错 422，不静默退回默认轴）。
     MS 的 casetype/casestatus/maintainer 在本仓没有等价列（无用例类型、状态只有
     normal/recycled 一个视图轴、无维护人），不造。
  3. 两个总数并排：`total` 吃当前视图（`recycled` 开关，与列表同口径），
     `recycled_total` 永远是回收站行数——「在用多少 / 删了多少」两个事实，一个数换名字
     就分不清。
  4. 分组之和 = total：同一份 where 元组分两路（一次 count、一次 group by），不各写一遍。
     优先级四档**全部列出**（没有用例的记 0）：统计横轴不因数据缺口变形，「P0 一条都没有」
     本身就是要看的事实。模块 null 归「未分类」（key=""），创建人现查 `app_user` 姓名。
- 前端（`api/functional.ts` + `functionalCases.tsx`）：
  1. 工具栏新增「统计」（读权限即可见，回收站视图同样可用），弹层里选分组轴，
     请求体带 `project_id + group_by + recycled`（范围跟随当前视图，弹层里写明）。
  2. 每行一个计数 + 占比 + `Progress` 进度条；页头一句「共 N 条 · 回收站 M 条」。
- 测试：
  - `tests/test_d236_functional_case_stats.py` **4 passed**（新）：优先级四档含 0 值、
    删一条后 total/recycled_total 各自变化、回收站视图单独成表；模块分组含未分类且
    计数降序；创建人分组按姓名、跨项目不串入；READONLY 200、非成员 403、
    `group_by=status` 422。
  - 前端 `functionalCases.test.tsx` **+3**（共 22）：默认优先级请求体与四档渲染；
    切到模块轴带新 `group_by` 重取且「未分类」在列；回收站视图里 `recycled=true`
    且弹层写明统计范围。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件/1238 依赖）；
  `tsc --noEmit` 0；eslint 0 error；`functionalCases.test.tsx` **22 passed**；后端
  `test_d236 + test_d193 + test_registry + test_dispatcher` **25 passed / 33.00s**；
  web 全量 **2044 passed / 125 files**（D235 的 2041 + 本刀 3）。

## 54. 第 47 刀交付：任务中心批量停止（D237，2026-11-23）

§46 顺延项里「计划任务中心 9 端点」被误读成「任务中心整个没做」——实际 D196 已交付
summary/list/queue/detail/stop/rerun 六端点。对着 MS `TaskController` 逐条核对，真正缺的、
且在本仓有真实语义的只有 **`/task/center/stop/batch`**：MS 的 case/scenario 下钻、
runningTask（cron 作业）分别对应本仓已有详情/计划页，perf 停止无性能域可停。
本刀只补批量停止，不抄用不上的端点。

- 后端（`taskcenter/services.py` + `schemas.py`）：
  1. `POST /task-center/tasks/batch-stop`（`task:center:stop`，上限 100 条）。去重保序；
     空列表 422。
  2. **三桶分账**：`stopped + skipped + failed = 去重后条数`。`skipped` = 已结束或已在
     取消中（单条 stop 对已结束回 409 是「用户点错要告知」；批量里列表停在页上、任务
     自己跑完是常态，逐条 409 会让整批不可用）——skip 计数与 `skipped_ids` 一样说清，
     不静默。`failed` 带 code/message（某条没有域执行权限时该条失败、其余照停）。
  3. **缺 id / 跨项目 id → 404 且整批零写入**：与 batch-update / batch-copy 同一把尺，
     请求点到的对象有一半不存在时不能悄悄只做存在的那半。
  4. **不假装跨行事务**：每条 run_cancel 自己 commit（取消旗 + 队列摘除），批量如实
     逐条报告；回滚是假承诺。
- 前端（`api/taskcenter.ts` + `pages/taskCenter.tsx`）：
  1. 新增勾选列（`can_stop` 的行才可勾；每次重拉按新行集剪选中，防翻页幽灵选中）。
  2. 工具栏「批量停止（N）」（无 `task:center:stop` 不摆；未勾选时 disabled，不是点了
     没反应），确认弹层写明「已结束会被跳过，结果按条计数」。
  3. 成功文案按回执拼「已停止 X 个任务，跳过 Y，失败 Z」，随后清空选中并重拉。
- 测试：
  - `tests/test_d237_task_batch_stop.py` **4 passed**（新）：两条活跃被停且落取消旗、
    已结束与取消中被 skip、重复 id 去重；缺 id 与跨项目 id 一次 404 且存在的那条也
    零写入；空列表与 101 条 422；READONLY 整批 403、MEMBER 可停。
  - 前端 `taskCenter.test.tsx` **4 passed**（原 3 + 1）：未勾选按钮不可点、已结束行
    勾选框 disabled、勾选后发 `{project_id, run_ids:["r1"]}`、成功后选中清空、READONLY
    无批量入口也无勾选列。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件/1238 依赖）；
  `tsc --noEmit` 0；eslint 0 error；后端 `test_d237 + test_d196 + test_registry +
  test_dispatcher` **25 passed / 40.94s**；web 全量 **2045 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」（本仓无单一完成点）、报告分享链接的
  订阅版、脑图、`api_case` 在报告中心的对象类型展示、其余列表页高级搜索。

## 55. 第 48 刀交付：工作台「我的关注与创建」（D238，2026-11-23）

MS 工作台首页的三组数字（我创建的用例 / 我关注的 / 本周缺陷）在本仓一直缺位：现有
`/workbench-stats` 只有项目资产总数、7 天执行、待办，没有「我」的维度。本刀补上，
但**只补算得出来的部分**——这是本仓与 MS 表结构差异决定的，不是偷懒：

- `api_definition` / `api_case` / `scenario` / `ui_case` / `adb_case` **都没有 created_by 列**
  （部分表只有 updated_by），MS 的「我创建的用例 ×4 类」在本仓没有事实来源。拿资产
  总数冒充「我创建的」是假报表，不做。
- 有真列可算的两种：功能用例（`functional_case.created_by + status`）与缺陷
  （`defect.created_by + created_at`）。缺陷还有 `recycled` 列，同样排除。
- 关注三桶落在 D191/D231/D234 三张关注表：`defect_follower` / `plan_follower` /
  `functional_case_follower`，按 (project_id, user_id) 现查，`followed_total` 是三者
  之和而不是另一次查询——分桶与合计必须同一把尺。

- 后端（`workbench/services.py`）：
  1. `WorkbenchStatsOut.contribution`（默认全零，老客户端不受影响）：
     `functional_case_created`、`defect_created_7d`、`followed_plan`、
     `followed_functional_case`、`followed_defect`、`followed_total`。
  2. 「近 7 天」复用工作台已有窗口（`WINDOW_DAYS=7` 的 `since`），不新增口径；
     功能用例只算 `normal`，缺陷排除 `recycled`。
  3. 每个数字都带 `project_id` + `created_by/user_id` 两个条件，跨项目与跨用户双向隔离。
- 前端（`pages/workbench.tsx`）：新增「我的关注与创建」卡片（位于待办与快捷入口之间）：
  左侧「我创建：功能用例 N · 近 7 天缺陷 M」，右侧「我关注：计划 A · 功能用例 B ·
  缺陷 C（共 T）」，右上角一行合计。`contribution` 缺省按全零渲染，不出现 undefined。
- 测试：
  - `tests/test_d238_workbench_contribution.py` **2 passed**（新）：管理员的
    2 正常用例 + 1 回收站 + 别项目、缺陷 1 窗内 + 1 窗外 + 1 回收站、关注 2+1+1 且
    别项目不串入，逐字段断言；成员视角只看到自己的 1/1/1；空项目全零。
  - 前端 `workbench.test.tsx` **+2**（共 22）：分桶读数与合计、资产总数不得冒充
    「我创建」、老后端缺块时全零。
- 门禁（本轮实测）：ruff 全过（import 顺序修 1 处）；lint-imports **4 kept / 0 broken**
  （251 文件/1239 依赖，多出的 1 条是 workbench→defect 组合层读取）；`tsc --noEmit` 0；
  eslint 0 error；后端 `test_d238 + test_workbench_stats + test_d227 +
  test_registry + test_dispatcher` **36 passed / 62.06s**；web 全量
  **2047 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」、报告分享链接的订阅版、脑图、其余
  列表页高级搜索。

## 56. 第 49 刀交付：任务中心高级搜索（D239，2026-11-23）

D47-a 的三件套已经铺了 13 个页面，任务中心（`/task-center/tasks`）一直只有页头
keyword + state/类型两个快捷下拉。本刀把它补成同一套：

- **字段白名单只收 run_record 的真实列，且是用户看得懂的那种**。11 列：任务名称 /
  任务类型 / 触发方式 / 状态 / 环境 / 耗时（ms）/ 错误信息 / 触发人 / 创建 / 开始 /
  结束时间。刻意不进的五类，各有原因：
  - `queue_position` / `can_stop` / `can_rerun` 是**读时算出来的展示量**（Celery 队列
    位次、状态派生的按钮开关），不是列——拿它们当筛选条件等于承诺一个数据库里不存在
    的事实。
  - `cancel_requested` 是 worker 协作旗，列表里不展示；给看不见的状态开筛选口子，
    用户筛到了也无法在表上核对。
  - `id` 不进：页头 keyword 已经同时搜名称与 run id（`subject_name LIKE OR id LIKE`），
    再来一个筛同一列的框，会出现「两个入口搜同一列、结果却不一样」的镜面。
  - `project_id` 是取数机制参数（由 `ensure_project_access` 管），不能当业务筛选项。
  - 点名即 400（`bad_filter`），错误 message 里列出本页可筛清单，不静默降级。
- **条件是 WHERE，与快捷筛选并行 AND**：`TaskListIn.filter` → `TASK_LIST_FILTER.parse`
  直接进 `stmt.where`，在 `order_by` 与 `paginate_page` 之前；so 分页与 total 吃的是
  同一份筛出来的集合，不是「本页先取 20 条再页内过滤」。
- **前端**：任务列表接 `ListToolbar`（视图选择器 / 高级搜索 / 列设置），空条件不拼
  `filter=`（与其余页面同一把尺）；筛选一变 `setCurrent(1)`——停在第 5 页套新条件会
  落到新条件下无关的切片甚至空页。列设置 8 列可勾（操作钮不可隐藏），key 与 columns
  逐字一致。触发人候选取 `/projects/{id}/members`，拉不到就空着，筛选仍可按 id 走。
- 测试：
  - `tests/test_d239_task_center_advanced_search.py` **6 passed**（新）：
    meta 白名单/排除项/`EMPTY` 仅可空列；CONTAINS / EQUALS / IN / GT / EMPTY /
    BETWEEN / OR 七类条件逐条断言；与 state、subject_type、keyword 并行 AND；
    分页在条件之后（total=2，size=1 两页各 1 条且并集等于筛选集）；跨项目隔离；
    非法字段/非法操作符/坏 JSON 均 400 且 `code=bad_filter`；空 filter = 全部。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `task_center`（这条故意会红，
    逼新页带行为测试）。
  - 前端 `taskCenter.test.tsx` **6 passed**（+2）：空条件不拼 filter、应用「任务名称
    包含 登录」后请求带条件 JSON（字段名来自后端 meta 首项）；列设置勾掉「触发人」
    只藏那一列。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1240 依赖，多出的 1 条是 taskcenter→shared/filter_registry）；`tsc --noEmit` 0；
  eslint 0 error；后端相关子集（d239 + d47a + d196 + d237）**45 passed / 52.86s**；
  web 全量 **2049 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」（本仓无计划级完成点，需先有
  plan_run 之类的批次记录，不能用「抄最近一条运行」冒充）；报告分享链接的订阅版；
  脑图；schedules / mock 等其余列表页的 D47-a 三件套。

## 57. 第 50 刀交付：定时任务页高级搜索（D240，2026-11-23）

D47-a 三件套铺到定时任务页（`GET /schedule-tasks`）。该页此前只有 `enabled` 快递
筛选（1/0）与页码分页，没有条件组、视图与列设置。

- **字段白名单 = schedule_task 的真实标量列，且用户看得懂**。10 列：任务名称 /
  主体类型 / cron / 启用（1/0）/ 环境 / 连续失败次数 / 创建人 / 更新人 / 创建时间 /
  更新时间。刻意不进的四类：
  - `subject_id`：页面「主体」列画的是 scenario/plan 的对象名（另查名单），不是 id；
    按 id 开筛口等于让用户筛一个看不见的值（task_center 同尺）。
  - `last_run` / `notify_channel_ids`：JSON 回执 / 引用数组，没有稳定的标量比较
    语义——摆成可筛字段只会得到「选了没反应」的假筛选项。
  - `id`：Ctrl+K `?q=<id>` 直达已覆盖「找某一条」；再开一个筛口是同一列的镜面。
  - `project_id`：取数机制参数（`ensure_project_access` 管），不是业务筛选项。
  - 点名即 400（`bad_filter`），message 列出本页可筛清单，不静默降级。
- **条件是 WHERE，与 enabled 快捷轴并行 AND**：`TaskListIn.filter` →
  `SCHEDULE_LIST_FILTER.parse` 直接进 `stmt.where`，位于 `enabled` 条件之后、
  `order_by` 与 cursor/current 分页之前；total 与两页切片吃同一份筛后集合。
- **前端**：定时任务页接 `ListToolbar`（视图 / 高级搜索 / 列设置），原有「按启停
  筛选 / 刷新 / 新建任务」收进 `extra`；主体类型候选复用页面同一份 `SUBJECT_OPTIONS`
  （不另抄词表），空条件不拼 `filter=`，筛选一变 `setCurrent(1)`。列设置 6 列可勾
  （操作钮不可隐藏），key 与 columns 逐字一致。顺手删掉本地重复声明的 `Option`
  接口（与 ListToolbar 导出同形，TS2440），以及已无引用的 antd `Table` 导入。
- 测试：
  - `tests/test_d240_schedule_advanced_search.py` **6 passed**（新）：meta 白名单/
    排除项/`EMPTY` 仅可空列；CONTAINS / EQUALS / cron CONTAINS / enabled EQUALS 0 /
    EMPTY / NOT_EMPTY / GT / 创建人 EQUALS / 时间 BETWEEN / OR 逐条断言；与 enabled
    快捷轴并存 AND；分页在条件之后（total=2，size=1 两页各 1 条）；跨项目隔离；
    非法字段/非法操作符/坏 JSON 均 400 且 `code=bad_filter`；空 filter = 全部。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `schedule`（按字母序，故意会红，
    逼新页带行为测试）。
  - 前端 `schedules.test.tsx` **119 passed**（+2）：空条件不拼 filter、应用「任务名称
    包含 夜间」后请求带条件 JSON（字段名来自后端 meta 首项）；列设置勾掉「调度」
    只藏那一列，其余表头原样。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1241 依赖，多出的 1 条是 schedule→shared/filter_registry）；`tsc --noEmit` 0；
  eslint 0 error/0 warning；后端相关子集（d240 + d47a + schedule service/1e/
  notify_hook）**81 passed / 124.00s**；web 全量 **2051 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」；报告分享链接的订阅版；脑图；
  mock 等其余列表页的 D47-a 三件套。

## 58. 第 51 刀交付：Mock 规则页高级搜索（D241，2026-11-23）

D47-a 三件套铺到 Mock 规则列表（`GET /mock-services/{service_id}/rules`）。该页
此前只有「选服务 → 看该服务全部规则」与「试匹配」调试卡，没有条件组、视图与列设置。

- **字段白名单 = mock_rule 的真实标量列**。12 列：规则名 / 请求方法 / 匹配路径 /
  匹配方式 / 状态码 / 延迟（ms）/ 优先级 / 启用（1/0）/ 创建人 / 更新人 / 创建时间 /
  更新时间。刻意不进的四类：
  - `service_id` / `project_id`：取数作用域（页面已经按选中的服务取数），不是业务
    属性；开放成条件等于让 filter 参与作用域把关，是越权的正门。
  - `headers` / `body`：JSON 响应头与长文本响应体，没有稳定的标量比较语义。
  - `id`：当前服务的规则本就是小集合，页面没有按 id 找的需求。
  - 点名即 400（`bad_filter`），message 列出本页可筛清单，不静默降级。
- **条件是 WHERE，且关在服务作用域之内**：`RuleListIn.filter` →
  `MOCK_RULE_LIST_FILTER.parse` 直接进 `stmt.where`；外面那层
  `project_id + service_id` 的 where 不受影响，跨服务的规则一行都不出现。
- **前端**：Mock 规则表接 `ListToolbar`（视图 / 高级搜索 / 列设置），「新建规则」
  收进 extra；方法与匹配方式候选复用页面同一份词表（`MATCH_LABEL` 顺带替掉列里
  内联的重复映射）；空条件不拼 `filter=`；筛后空表的提示从「还没有规则」改成
  「没有符合筛选条件的规则」（不能把「筛没了」说成「一条都没有」）。列设置 5 列可勾
  （操作列不可隐藏），key 与 columns 逐字一致；render 参数显式标注 `MockRule`
  （applyColumnPrefs 的泛型推断不会再从 Table 的上下文类型借光）。
- 测试：
  - `tests/test_d241_mock_rule_advanced_search.py` **5 passed**（新）：meta 白名单/
    排除项/`EMPTY` 仅可空列；CONTAINS / method EQUALS / path CONTAINS /
    match_type EQUALS / status_code GT / delay_ms GT / priority EQUALS /
    enabled EQUALS 1 与 0 / 创建人 EQUALS / 更新人 EMPTY / 时间 BETWEEN / OR 逐条
    断言；服务作用域（另一个服务的同名规则不出现）；非法字段/非法操作符/坏 JSON
    均 400 且 `code=bad_filter`；空 filter = 全部。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `mock_rule`（按字母序，故意会红，
    逼新页带行为测试）。
  - 前端 `mock.test.tsx` **5 passed**（+2）：空条件不拼 filter、应用「规则名包含
    用户」后规则请求带条件 JSON（字段名来自后端 meta 首项）；列设置勾掉「匹配」
    只藏那一列（路径不再上屏，名称仍在）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1242 依赖，多出的 1 条是 mock→shared/filter_registry）；`tsc --noEmit` 0；
  eslint 0 error/0 warning；后端相关子集（d241 + d47a + d201 mock）**39 passed /
  43.92s**；web 全量 **2053 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」；报告分享链接的订阅版；脑图；
  runs 等其余列表页的 D47-a 三件套。

## 59. 第 52 刀交付：运行记录页高级搜索（D242，2026-11-23）

D47-a 三件套铺到运行记录列表（`GET /runs`）。该页此前有对象类型 / 触发 / 状态
三条快捷下拉与页码分页，但没有条件组、个人视图与列设置。

- **字段白名单 = run_record 的可见标量列**。12 列：对象名称 / 对象类型 / 触发方式 /
  状态 / 响应码 / 耗时（ms）/ 环境名称 / 错误信息 / 执行人 / 创建时间 / 开始时间 /
  结束时间。刻意不进的四类：
  - `project_id`：作用域参数，由 `ensure_project_access` 管；开放成条件等于让
    filter 参与越权把关。
  - `subject_id` / `id`：取数定位键，页面上不展示、也没有按 id 筛的入口；放进条件组
    会与「点详情」形成两套定位口径。
  - `request_snapshot` / `response_snapshot` / `assertions` / `stats` /
    `summary_graph`：JSON 快照列，没有稳定的标量比较语义。
  - `lease_owner` / `cancel_requested` / `max_runtime_ms` / `updated_at`：worker
    协作与执行机制列，页面上不展示（`updated_at` 也不在列表里），筛了看不见。
  - 与报告中心的 `report` 白名单是**两份**而非共用：两页可筛面各自演进（报告多
    `env_id`/`updated_at`，运行记录多 `error`），共用一份会让改一页顺手改掉另一页。
- **条件是 WHERE，且在项目作用域之内**：`RunListIn.filter` →
  `RUN_LIST_FILTER.parse` 直接进 `stmt.where`，与 `subject_type` / `trigger` /
  `status` 三条快捷轴并行 AND；写在 `order_by` 与分页之前，所以 `total` 与翻页吃
  同一份筛后集合。键集游标路径与页码路径共用这条 where，不是只改了一制。
- **前端**：运行记录页接 `ListToolbar`（视图 / 高级搜索 / 列设置）；对象类型 / 触发 /
  状态候选取页面同一份 `runVocab` 词表，触发**只给可承诺项**（与快捷筛选同口径，
  webhook 零写入方不摆假门）；空条件不拼 `filter=`；筛选一变回第 1 页。列设置 8 列
  可勾（操作列不可隐藏），`key` 与 columns 逐字一致——原列只有 `dataIndex`，
  `applyColumnPrefs` 只按 key 过滤，不补 key 的话列设置会成为「勾了没反应」的假开关。
- 测试：
  - `tests/test_d242_run_advanced_search.py` **7 passed**（新）：meta 白名单/排除项/
    非空列无 `EMPTY`/可空列有；CONTAINS / status EQUALS / status_code GT /
    elapsed_ms GT / subject_type EQUALS / created_by EQUALS / OR；与快捷轴
    （trigger/status）并行 AND；`size=1` 时 `total=2`（COUNT 吃同一份条件）；
    跨项目一行不漏出；env_name/started_at EMPTY 与 NOT_EMPTY、error CONTAINS；
    非法字段/枚举列 CONTAINS/坏 JSON 均 400 且 `code=bad_filter`；空 filter = 全部。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `run`（字母序
    `report` → `run` → `scenario`）。
  - 前端 `runs.test.tsx` **30 passed**（+2）：空条件不拼 filter、应用「对象名称包含
    登录」后请求带条件 JSON 且从第 3 页回第 1 页；列设置勾掉「环境」只藏那一列。
    ListToolbar 挂载即拉的 `/filter-meta?` 与 `/saved-views?` 两处 mock 补齐
    （两套假后端都要补，漏一套整页取数失败）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1243 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning（顺手删掉 runs.tsx 里
  一直未使用的 `Table` 导入）；后端相关子集 **38 + 33 passed**（d242/d47a + 
  run_record_v2/d47b_page_three/report_center）；web 全量 **2055 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」；报告分享链接的订阅版；脑图；
  runs 之外剩余列表页（settings 等）的 D47-a 三件套。

## 60. 第 53 刀交付：通知渠道页高级搜索（D243，2026-11-23）

D47-a 三件套铺到通知渠道列表（`GET /notify-channels`）。该页此前只有一条
「按类型筛选」快捷下拉与页码分页。

- **字段白名单 = 页面上看得见的标量列**：名称 / 类型 / 创建时间 / 更新时间。
  - `config` 是渠道配置（密钥逐键打码回显的 JSON），条件比较它既无稳定语义，
    还会把「按密钥值筛」这种不该存在的入口摆出来；`last_send` 同理是发送回执 JSON。
  - `id` 是定位键，页头没有按 id 找的入口。
  - 渠道是平台级配置（`notify_channel` 无 project_id 列），所以白名单天然没有项目
    维度；filter-meta / 保存视图仍需 project_id 做作用域校验，但它**不参与数据过滤**
    ——两个项目看到同一份渠道集合是设计，不是漏了项目条件（用例专钉）。
- **条件是 WHERE，且在分页前**：`ChannelListIn.filter` →
  `CHANNEL_LIST_FILTER.parse` 进 `stmt.where`，与 `type` 快捷轴并行 AND；写在
  `order_by` / 分页之前，`total` 与翻页吃同一份筛后集合（键集与页码两制共用）。
- **前端**：通知渠道页接 `ListToolbar`（视图 / 高级搜索 / 列设置）；类型候选取页面
  同一份 `TYPE_META` 词表；空条件不拼 `filter=`；筛选一变回第 1 页。列设置 4 列可勾
  （操作列不可隐藏），列的 key 原本已齐，直接包 `applyColumnPrefs`。
- 测试：
  - `tests/test_d243_notify_channel_advanced_search.py` **6 passed**（新）：meta 白名单/
    排除项/kind 操作符；name CONTAINS / type EQUALS / OR / created_at GT；
    与 type 轴并行 AND；`size=1` 时 `total=3`（COUNT 吃同一份条件）；
    非法字段 config / 枚举列 CONTAINS / 坏 JSON 均 400 且 `code=bad_filter`；
    空 filter = 全部；平台级作用域跨项目一致。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `channel`（字母序
    `case_review` → `channel` → `dataset`）。
  - 前端 `notifyChannels.test.tsx` **34 passed**（+2）：空条件不拼 filter、应用
    「名称包含 第一页」后请求带条件 JSON 且从第 3 页回第 1 页；列设置勾掉
    「关键配置」只藏那一列。三套假后端都补 `/filter-meta?` 与 `/saved-views?`；
    另修既有的「第几条列表请求」计数口径——ListToolbar 也往 `calls` 记账，
    必须只数 `/notify-channels` 一族，否则 `before+1` 会撞上工具栏的两条元数据请求
    （本轮实测 3 条既有用例因此变红，改成 `listReqs()` 后恢复）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1244 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning（顺手删掉
  notifyChannels.tsx 里一直未使用的 `Table` 导入）；后端子集 **46 passed**；
  web 全量 **2057 passed / 125 files**。
- 仍未做（顺延）：计划的「执行完自动生成报告」；报告分享链接的订阅版；脑图；
  settings 各 Tab 内的列表与其余页面（如 members/users/audit）的 D47-a 三件套。

## 61. 第 54 刀交付：平台用户页高级搜索（D244，2026-11-23）

D47-a 三件套铺到平台用户列表（`GET /system/users`，设置页「用户」Tab）。

- **字段白名单 = 页面上看得见的标量列**：账号 / 姓名 / 邮箱 / 类型（是否平台管理员）/
  状态 / 创建时间。刻意不进的：
  - `password_hash`：凭据材料，连「按哈希子串筛」的入口都不该存在——那等于给口令
    哈希一个可探测的比对面；`prefs` 是用户偏好 JSON；`id` 是定位键。
  - 平台用户表没有 project_id：filter-meta 的 project_id 只做作用域校验，不参与
    数据过滤；各项目看到同一份平台用户集合是设计（用例专钉）。
- **布尔列收真布尔**（本轮新契约）：`is_system_admin` 登记 `kind=bool`，只许
  EQUALS/NOT_EQUALS 且 value 必须是 JSON `true`/`false`；字符串 `"true"` 400。
  否则同一条件会有「字符串版」与「布尔版」两套写法，必有一边在 SQL 上撒谎。
  连带改前端：`ListToolbar` 的 `Option.value` 从 `string` 扩到 `string | boolean`
  （候选值与契约同型）；schedules.tsx 两处把 Option 值塞进 `Map<string,string>`
  的辅助函数补 `typeof o.value === "string"` 收窄（tsc 逼出来的真实调用点）。
- **条件是 WHERE 且在游标分页之前**：`UserListIn.filter` →
  `USER_LIST_FILTER.parse` 进 `stmt.where`；用例钉「筛出两行、size=1 只回一行且
  next_cursor 非空，下一页接着回另一行」——不是先取一页再在页内过滤。
- **前端**：平台用户 Tab 接 `ListToolbar`（视图 / 高级搜索 / 列设置）；列设置 6 列
  可勾（操作列不可隐藏），cols 补齐 key 并包 `applyColumnPrefs`；状态/类型候选取
  页面渲染词表（启用/停用、平台管理员/普通用户），布尔候选的 value 是真布尔；
  空条件不拼 `filter=`；`advFilter` 变化走 `load(true)` 重查（依赖只挂 advFilter，
  不挂 load——load 自己写 cursor，挂上去就是「取一页→换身份→再取一页」的回路，
  同行内注释与 eslint-disable 说明）。
- 测试：
  - `tests/test_d244_user_advanced_search.py` **7 passed**（新）：meta 白名单/排除项/
    bool 操作符；账号/姓名/邮箱 NOT_EMPTY/状态/管理员/OR；条件在游标分页前；
    字符串 "true" 400；password_hash 与坏 JSON 400 且 `code=bad_filter`；
    空 filter；平台级跨项目一致。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `user`（字母序末尾）。
  - 前端 `UsersTab.test.tsx` **26 passed**（+2）：空条件不拼 filter、应用
    「账号包含 admin」后重查带条件 JSON；列设置勾掉「邮箱」只藏那一列。
    假后端补 `/filter-meta?`、`/saved-views?`；既有「请求口径」断言从 `calls[0]`
    改为 `listGets(calls)[0]`——工具栏也往 calls 记账，第 0 条不再是列表请求。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1245 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning（删掉 UsersTab.tsx 里
  一直未使用的 `Table` 导入）；后端子集 **38 passed**（d244 + d47a，53.61s）；
  web 全量 **2059 passed / 125 files**（UsersTab.test.tsx 26 passed）。
- 仍未做（顺延）：计划的「执行完自动生成报告」（本仓无计划级完成点）；
  报告分享链接的订阅版；脑图（C 档，业主裁前不做）；settings 的 Members/Audit
  两个 Tab 与其余页面的 D47-a 三件套。

## 62. 第 55 刀交付：项目成员页高级搜索（D245，2026-11-23）

D47-a 三件套铺到设置页「成员」Tab（`GET /projects/{id}/members`）。

- **字段白名单 = 表格里看得见的标量列**：账号 / 姓名 / 角色。
  - `user_id` / `id` 是定位键（「我」标记、移出按钮、角色下拉的写入键都按它们走），
    `project_id` 是作用域参数——由 `ensure_member` 管，放开成条件等于让 filter
    参与越权把关。
  - 成员行没有独立的展示时间列，故不收 `created_at`/时刻列（筛了也看不见）。
- **条件只做收窄、不做扩权**：`MEMBER_LIST_FILTER.parse` 的谓词追加在
  `ProjectMember.project_id == ...` 之后；用例钉「同一 filter 在 A/B 两个项目各
  只回本项目的成员」，不是把项目条件换掉。
- **接口形状**：这条路由不是 `@service` 而是手写 FastAPI 路由，新增查询参数
  `filter_ = Query(alias="filter")`（形参名避内置 `filter`），响应仍是
  `{items: [...]}`（本页无分页，条件在 SQL 里收窄，不是页内过滤）。
- **前端**：成员 Tab 接 `ListToolbar`（视图 / 高级搜索 / 列设置）；角色候选取本页
  `/roles + /custom-roles` 的同一份角色词表（内置 + 自定义，含 code），列设置 3 列
  可勾（操作列不可隐藏），cols 补齐 key 并包 `applyColumnPrefs`；空条件不拼
  `filter=`；`advFilter` 进 `load` 的依赖，条件一变即重查。视图写入位由 settings
  按 `can(perms, "search:view:create/delete")` 传入——READONLY 只有 `*:read`，
  保存按钮不该摆给他们（摆了就是点一次 403 的假门）。
- 测试：
  - `tests/test_d245_member_advanced_search.py` **5 passed**（新）：meta 白名单/
    排除项/枚举操作符；账号/姓名/角色/OR；跨项目不露头；`project_id`/枚举
    CONTAINS/坏 JSON 均 400 且 `code=bad_filter`；空 filter 全量。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `member`（字母序
    `functional_case` → `member` → `mock_rule`）。
  - 前端 `MembersTab.test.tsx` **23 passed**（+2）：空条件不拼 filter、应用
    「账号包含 li」后重查带条件 JSON；列设置勾掉「姓名」只藏那一列。
    假后端补 `/filter-meta?`、`/saved-views?`，成员 GET 匹配从全等放宽到
    「以 members 开头」（过滤后带 query，全等会把新请求漏进未 mock 分支）。
  - `settings.test.tsx` 12 passed（新增必填 props 与工具栏依赖未破坏页级用例）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1246 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning（删掉 MembersTab.tsx 里
  一直未使用的 `Table` 导入）；后端子集 **36 passed**（d245 + d47a）；
  web 全量 **2061 passed / 125 files**（MembersTab.test.tsx 23 passed）。
- 仍未做（顺延）：计划的「执行完自动生成报告」（本仓无计划级完成点）；
  报告分享链接的订阅版；脑图（C 档，业主裁前不做）；settings 的 Audit Tab
  （已有自定义筛选组，接三件套需先决定是否替换现有筛选）与其余页面的三件套。

## 63. 第 56 刀交付：审计日志页高级搜索（D246，2026-11-23）

D47-a 三件套铺到设置页「审计」Tab（`GET /audit`）。这一页的裁定与前面几页不同
一处：**保留原有五条快捷筛选（RangePicker / 操作人 / 入口 / 结果 / 动作），在它们
上方叠加 ListToolbar**，不替换——那五条是 §11.4.27 的既定交互，且 e2e 与既有用例
按它们钉过；高级搜索是另一条并行筛选面（两层同时生效、互不覆盖）。

- **字段白名单 = 表格里看得见的标量列**：时间 / 操作人 / 入口 / 动作 / 目标 / 结果。
  - `diff` 是 before/after 快照 JSON（比较它没有稳定语义）、`id` 是定位键、
    `user_id` 与快捷轴重复（操作人已按姓名展示，按 id 筛是机器口径，留给
    `user_id` 参数）——三者不进白名单，点名即 400。
  - `ts` 为 `kind=time`（支持 BETWEEN），`entry` 为 `kind=enum`，`ok` 为
    `kind=bool`（只收 JSON true/false，字符串 "true" 400）。
- **条件只做收窄、不做扩权**：`AUDIT_LIST_FILTER.parse` 的谓词追加在
  `target == project_id` 作用域与五条快捷轴之后；用例钉「项目作用域 + entry 快捷轴
  + 条件」三层 AND，别的项目的同类行不被 filter 带出。
- **分页口径**：条件写在 `order_by` / `paginate_desc` 之前，游标页与总数吃同一份
  筛后集合；用例钉「筛出两行、size=1 时仍有下一页」。
- **前端**：`AuditTab` 接 `ListToolbar`（视图 / 高级搜索 / 列设置），入口候选取本页
  `ENTRIES` 词表、结果候选是真布尔 `true/false`（`Option.value` 联合型已在 D244
  扩好）；cols 补 key（time/user/entry/action/ok）并包 `applyColumnPrefs`；空条件
  不拼 `filter=`，`advFilter` 进 `load` 依赖与该页专用的重查 effect（`load` 写
  cursor，本就不能进依赖组）；「带筛选」空态判词把高级搜索条件也算进去。视图写入位
  由 settings 按 `can(perms, "search:view:create/delete")` 传入。
- 测试：
  - `tests/test_d246_audit_advanced_search.py` **6 passed**（新）：meta 白名单/
    排除项/各 kind 操作符；条件（含 OR、bool、EMPTY）真筛；与快捷轴 + 项目作用域
    三层 AND；过滤在 LIMIT 之前；坏字段/字符串布尔/坏 JSON 均 400 且
    `code=bad_filter`；空 filter 全量。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `audit`（字母序
    `api` → `audit` → `case_review`），docstring 同步。
  - 前端 `AuditTab.test.tsx` **29 passed**（+2）：选中已存视图后条件作为 `filter`
    参数重查；列设置勾掉「动作」只藏那一列。三套假后端补
    `/filter-meta?`、`/saved-views?`，首条列表请求断言从 `calls[0]` 改为按
    `/audit?` 端点族过滤（工具栏也往 calls 记账）。
  - `settings.test.tsx` 12 passed（新增必填 props 未破坏页级门控用例）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1247 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning（删掉 AuditTab.tsx 里
  未使用的 `Table` 导入、给重查 effect 补缺依赖说明）；后端子集 **37 passed**
  （d246 + d47a）；web 全量 **2063 passed / 689 suites / 0 failed**。
- 仍未做（顺延）：计划的「执行完自动生成报告」（本仓无计划级完成点）；
  报告分享链接的订阅版；脑图（C 档，业主裁前不做）；其余页面的三件套。

## 64. 第 57 刀交付：模板与字段两表高级搜索（D247，2026-11-23）

D47-a 三件套铺到设置页「模板与字段」Tab（`GET /templates` + `GET /custom-fields`）。
两表同住一个 Tab，但各是一张表、各登记一枚 view_type（`template` / `custom_field`），
视图与列设置也互不串门——一个 Tab 里两套筛选面，不能共用一枚页名。

- **白名单只收稳定标量列**：
  - `template`：模板名称 / 描述 / 系统内置 / 默认模板 / 排序号 / 创建 / 更新时间；
  - `custom_field`：字段名称 / field_key / 字段类型 / 描述 / 系统内置 / 排序号 /
    创建 / 更新时间。
  - `scene` 刻意不进白名单：列表入参已按 Tab 把场景钉死，再允许按 scene 筛只会
    立刻筛出空集（假筛选项，同 audit 里 project_id 的处理）；`field_count` /
    `template_count` 是聚合展示值、`options` 不是列——点名即 400。
  - `internal` / `is_default` 为 `kind=bool`（只收 JSON true/false）；
    `type` 为 `kind=enum`；`created_at` / `updated_at` 为 `kind=time`。
- **条件只收窄**：`parse` 的谓词与 `project_id == ...` + `scene == ...` 取数轴
  并排 AND；用例钉「别的项目同名模板/字段不会被 filter 带出」。
- **前端**：`ProjectMetaTab` 两表各接一套 `ListToolbar` + `useColumnPrefs`
  （`template` / `custom_field`），cols 补 key 并包 `applyColumnPrefs`；
  模板面板 valueOptions 给 internal/is_default 的真布尔，字段面板给 FIELD_TYPES
  同源的类型候选；空条件不拼 `filter=`，删模板/存字段后仍走同一个 `load` 重取。
  `settings.tsx` 按 `search:view:create/delete` 传视图写入位。
- 测试：
  - `tests/test_d247_project_meta_advanced_search.py` **5 passed**（新）：两枚
    view_type 的 meta（页面名/字段集/kind/ops/排除项）；模板与字段各自的真实筛选
    （文本 CONTAINS、枚举 EQUALS/IN、bool、可空列 EMPTY、否定留 NULL 行、
    time BETWEEN、数字 GT）；不越项目；坏字段/聚合列/scene/字符串布尔/坏 JSON
    均 400 且 `code=bad_filter`，空 filter 全量。
  - `tests/test_d47a_list_filters.py` 登记清单同步加 `custom_field` 与
    `template`（字母序），docstring 同步。
  - 前端 `ProjectMetaTab.test.tsx` **6 passed**（+2）：选中模板视图后条件作为
    `filter` 重查模板表、字段表不被牵连；列设置勾掉「更新时间」只藏那一列。
    假后端补 `/filter-meta?`（两页都登记）与 `/saved-views?`（按 view_type 分页
    返回），`beforeEach` 加 `localStorage.clear()`（列设置偏好落本地）。
  - `settings.test.tsx` 12 passed（新增必填 props 未破坏页级门控）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1248 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；后端子集 **44 passed**
  （d247 + d192 + d47a）；web 全量 **2065 passed / 689 suites / 0 failed**。
- 仍未做（顺延）：设置页其余 Tab（环境组 / 脚本面板）的三件套；模板字段的
  拖拽排序；自定义字段值表的跨场景统计。

## 65. 第 58 刀交付：模型配置中心补「登记 / 删除」（D248，2026-11-23）

问题面（不是加新功能，是补界面缺口）：后端 `model_cfg` 五个 `@service`
（create/list/update/delete/probe）与迁移早已齐，前端 `ModelTab` 只有「看 + 改 +
探测 + 设默认」——新模型只能靠 `.env` 种子导入，删模型只能直接动库。1E 批次表里
「模型配置中心界面」因此长期挂「未开放」。

- **登记**（`POST /model-cfgs`，perm `model:cfg:create`）：
  - 卡片墙右上「登记模型」；`canCreate` 为假时整钮不渲染（不做假门）。
  - 弹层字段：名称 / base_url / 模型名（三必填，前端先拦一道，空表不打网络）、
    API Key（可空 = 无密钥）、上下文 / 最大输出 / 温度、工具/思考/档位/视觉/启用、
    类型（对话/向量）与协议（OAI 兼容/Anthropic）与「设为默认」。
  - 类型/协议只在创建时给：`CfgUpdateIn` 没有这两键，改型 = 另一个模型配置。
  - 向量模型隐藏思考/档位/视觉三控件，且切型时把残留的 `supports_thinking` /
    `thinking_levels` / `supports_vision` 强制清空——与编辑弹窗同一口径，
    不让「隐藏但仍随 body 走」的假值偷渡。
  - 提交后 `await load()` 重拉列表；失败把 `ApiErr.message` 摆在弹层里（不关窗、
    不吞原文）。
- **删除**（`DELETE /model-cfgs/{id}`，后端仅系统管理员、先门后查）：
  - 卡片操作区「删除」，`canDelete` 由 `settings.tsx` 按 `isSysAdmin &&
    model:cfg:delete` 算；READONLY / 非超管不渲染。
  - Popconfirm 把两件真事说清楚：会话历史保留；若删的是默认模型，默认位补给
    同型最早启用的模型（与后端 `was_default` 分支同口径）。
- **接线**：`settings.tsx` 的模型 Tab 由「只传 canManage」改成三个位
  （create/update/delete）各按权限传；Tab 可见性仍是 `isSysAdmin &&
  model:cfg:read`（R19 治理线）。
- 测试（`ModelTab.test.tsx`，+3）：① `canCreate=false` 无钮；有钮时填三必填 →
  POST body 逐键断言（含默认能力位、`thinking_levels:null`、`api_key:""`），
  成功后弹层关闭且列表重拉；② 空表点登记零 POST；切「向量」后思考/档位/视觉
  三控件整卡缺席、工具位仍在；③ `canDelete=false` 无钮；有钮时 Popconfirm 确认
  才发 `DELETE /model-cfgs/m1`，成功后重拉。
- 门禁（本轮实测）：`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2068 passed / 690 suites / 0 failed**（D247 的 2065 + 新增 3）。后端本轮零改动，
  既有 `test_model_cfg.py` 6 例覆盖 create/delete 服务端判据。
- README：批次表 1E 由「未开放」改「已交付」（四件事——模型配置界面 / 通知渠道 /
  定时任务 / 高级搜索——均已落地），并新增 D248 行。
- 仍未做（顺延）：模型配置的「按类型分组 / 搜索」；`ANTHROPIC` 协议探测
  （后端如实返回「未实现该协议」，不是前端缺口）；设置页环境组 / 脚本面板的三件套。

## 66. 第 59 刀交付：环境组高级搜索（D249，2026-11-23）

D47-a 三件套铺到项目设置「环境组」面板（`GET /env-groups`，D200/C1）。

- **白名单**（`ENV_GROUP_LIST_FILTER`，view_type `env_group`，页面名「环境组」）：
  组名（text 非空）/ 说明（text 可空）/ 创建 / 更新时间。
  - `envs` 是 `environment_group_item + environment` 的打包结果（表格里是 Tag），
    按环境名或 env_id 筛需要 EXISTS 子查询——不在这把「只认列」的尺上，点名即 400，
    文件头注释留痕（这是有意的本轮不做，不是漏项）。
  - `project_id` 是取数轴，不重复登记；条件与之并排 AND，只收窄不越项目。
- **后端**：`EnvGroupListIn.filter` + `parse(payload.filter)` 进 WHERE（在
  `order_by` 之前），空串/缺省 = 不额外收窄；不合法条件统一 `bad_filter` +
  「本页可筛」字段中文名。
- **前端**：`projectAssetsApi.envGroups(projectId, filter?)`；`EnvGroupsPanel`
  接 ListToolbar（高级搜索 / 视图 / 列设置，view_type `env_group`）与
  `useColumnPrefs`，cols 补 key 并包 `applyColumnPrefs`（名称/环境/说明可隐藏，
  操作列不可隐藏）；空条件不拼 `filter=`。**组表单的环境下拉 `/envs` 是粮草请求，
  不带列表条件**（用例钉住，防止两件事串线）。`ProjectSettingsTab` 新增
  `canSaveView/canDeleteView` 并透传，`settings.tsx` 按 `search:view:create/delete` 传。
- 测试：
  - `tests/test_d249_env_group_advanced_search.py` **4 passed**（新）：meta
    （页面名/字段集/ops/排除 envs 与 project_id）；真实筛选（文本 CONTAINS、
    EQUALS、可空列 EMPTY、否定留 NULL 行、OR、time BETWEEN）；不越项目 + 空串全量；
    坏字段（envs / project_id）/ 时间列吃 CONTAINS / 坏 JSON 均 400 且
    `code=bad_filter`。
  - `tests/test_d47a_list_filters.py` 登记清单加 `env_group`（字母序），docstring 同步。
  - `EnvGroupsPanel.test.tsx`（新文件）**4 passed**：列表与只读无新建钮；新建
    POST body（project_id/name/description/env_ids）与成功后重拉；选视图后条件作为
    filter 重查且 `/envs` 不被污染；列设置只藏「说明」。
  - `settings.test.tsx` 12 passed（新增必填 props 未破坏页级门控）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1249 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；后端子集 **38 passed**
  （d249 + d200 + d47a）；web 全量 **2072 passed / 692 suites / 0 failed**。
- 仍未做（顺延）：公共脚本面板的三件套（`/scripts`，字段含语言/版本/启停）；
  环境组按「包含某环境」的 EXISTS 筛选；模型配置搜索。

## 67. 第 60 刀交付：公共脚本高级搜索（D250，2026-11-23）

D47-a 三件套铺到项目设置「公共脚本」面板（`GET /public-scripts`，D200/C2）。

- **白名单**（`PUBLIC_SCRIPT_LIST_FILTER`，view_type `public_script`，页面名「公共脚本」）：
  脚本名 / 语言 / 版本 / 启用 / 说明，全部是表格里看得见的标量列。
  - `content` 是脚本正文（大文本），按它做子串搜既不是「列」的用法也会压垮取数；
  - `created_by` / `updated_by` 存的是用户 id，界面按姓名展示（要联表）；
  - `created_at` / `updated_at` 不在表格里显示（列表本就按 updated_at 倒序）。
  - 以上点名即 400，理由写在 services.py 白名单注释里。
- **与快捷轴叠加**：`keyword`（名称/说明子串）与 `enabled_only` 原样保留，
  `filter` 在它们之后 AND——用例钉「keyword=脚本 + enabled_only + language=python」
  三者同时生效，也钉 keyword 单独作用不被新条件顶掉。
- **前端**：`projectAssetsApi.scripts(projectId, { keyword?, filter? })`；
  `ScriptsPanel` 接 ListToolbar（高级搜索 / 视图 / 列设置，view_type
  `public_script`）与 `useColumnPrefs`，cols 补 key 并包 `applyColumnPrefs`
  （名称/语言/版本/启用/说明可隐藏，操作列不可隐藏）；空条件不拼 `filter=`；
  语言/启用两列的 valueOptions 与表格 Tag/开关同源。
  **筛「启用=是」时把行切停用会重拉列表**——本地打补丁会留下一张与条件不符的
  旧脸；无筛选时仍走本地补丁省一次往返（用例分别钉到重拉次数）。
- 测试：
  - `tests/test_d250_public_script_advanced_search.py` **4 passed**（新）：meta
    （五个字段/kind/ops，排除 content 与作者/时间键）；真实筛选（语言 EQUALS、
    布尔 EQUALS、版本 GT（内容改动后 v2）、名称 CONTAINS、说明 EMPTY、OR）；
    快轴叠加；不越项目；空串全量；坏字段（content/created_by/updated_at）/
    字符串布尔 / 坏 JSON 均 400 且 `code=bad_filter`。
  - `tests/test_d47a_list_filters.py` 登记清单加 `public_script`（字母序），docstring 同步。
  - `ScriptsPanel.test.tsx`（新文件）**5 passed**：列表与只读门；新建 POST body
    原样与重拉；选视图带 filter；列设置只藏「说明」；有筛选时切启用触发重拉。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；后端子集 **38 passed**
  （d250 + d200 + d47a）；web 全量 **2077 passed / 694 suites / 0 failed**。
- 仍未做（顺延）：环境组「包含某环境」的 EXISTS 筛选；模型配置搜索/分组；
  二期（MCP/Skills/审批门/场景变更历史/跨项目复制）仍按 README 表挂起。

## 68. 第 61 刀交付：接口定义批量回收（D251，2026-11-23）

问题面：MS 的接口定义列表有 `/api/definition/delete/batch`，本仓只有单个
`/api-definitions/{id}/delete`——勾一排接口只能逐个点。补的是**基础批量动作**，
不是新造语义。

- **后端** `POST /api-definitions/batch-delete`（perm `api:def:delete`，
  `definition_ids` 1–200）：
  - 重复 id → 422（拼错列表，不是「删两次」）；
  - 任一不存在 / 已回收 → 404 + `details.definition_ids`，**整批一行不动**
    （已回收与不存在同码，沿用单删口径）；
  - 逐条 `assert_row_visible`：看不见的行按 404，不静默跳过；
  - 引用检查**先全查完再改状态**：任一被未回收场景引用 → 409
    `referenced_by_scenario` + `details.blocked[]`（definition_id/name/count/
    scenarios；明细被 `scenario_case_refs` 抹平时附 `hidden` 与
    `reason=missing_scenario_read`），仍是零写入；
  - **不提供批量 force**：单删的 force 建立在「已看见这一个接口的引用清单」上，
    批量里 N 份清单叠在一起，一键连带断掉的可能是 N 个别人的场景步骤——强删请逐个走；
  - 全部通过后统一置 `recycled` 一次提交；软回收/ restore 语义与单删完全一致。
- **前端** `api.tsx` 批量条新增「批量回收」（`canDelete` 才渲染）：
  - 确认弹窗写明全有或全无 + 用例不删 + restore 原样回来；
  - 409 时用 `ApiErr.details.blocked` 弹窗点名「接口（N 个场景）」，并提示逐个回收；
  - 成功后清选择并 `await load()`；失败保留选择（用户照着名单去解引用）。
- 测试：
  - `tests/test_d251_api_batch_delete.py` **3 passed**：正常批删（正常列表消失/
    回收站可见/restore 回来）；全有或全无（缺 id、已回收 id、重复 id 三种都是零写入）；
    被场景引用 409（blocked 清单逐字、同批可删的另一个也不许动；解除引用后同批能过）。
  - `api.test.tsx` +2：勾 2 行确认后 body 恰好 `["d1","d2"]`、成功后批量条消失且重拉；
    409 弹窗点名「查询订单（2 个场景）」、选择保留、列表零重拉。
  - 既有 86 例全绿（Modal.destroyAll 的脏弹窗纪律继续生效）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；后端子集 **16 passed**
  （d251 + api_def_recycle）；web 全量 **2079 passed / 695 suites / 0 failed**。
- 仍未做（顺延）：接口定义的批量**恢复**（回收站多选 restore）与批量彻底删除
  （purge 要求逐字确认名称，批量 purge 的确认语义需要单独设计，不硬塞）；
  环境组 EXISTS 筛选；模型配置搜索。

## 69. 第 62 刀交付：回收站批量恢复（D252，2026-11-23）

D251 的对称出口。批量回收之后，回收站里勾一排只能逐个点「恢复」——补上
`POST /api-definitions/batch-restore` 与回收站视图的行勾选。

- **后端**（perm `api:def:update`，1–200 个 id）：
  - 重复 id → 422；任一不存在或**不在回收站** → 404 + `details.definition_ids`，
    整批一行不动（单条 restore 对「不在回收站」也是 404 not_found，沿用同码同文案）；
  - 逐条 `assert_row_visible`；
  - 恢复状态逐行按「有没有 request」定 `complete`/`draft`——不是一律 complete；
  - 全过后统一提交，一次事务。
- **前端** `api.tsx`：
  - 回收站视图的 `rowSelection` 打开（`inRecycled && canUpdate`；正常视图仍是
    `canRead`，导出共用选择）；切换视图时既有的「成功加载即清选择」继续兜住脏 id；
  - 批量条在回收站里换成「批量恢复」（canUpdate）+ 取消选择，确认弹窗写明
    全有或全无与 complete/draft 的判定；
  - 失败保留选择（照着 404 的 ids 改名单重试）；**不做批量 purge**——彻底删除的
    逐字名称确认在批量里没有可用的等价交互，硬塞会把不可逆操作变成一键。
- 测试：
  - `tests/test_d252_api_batch_restore.py` **2 passed**：批量复活 complete+draft 两态
    （状态逐行断言 + 回收站清空）；全有或全无（活行/不存在/重复/空列表四种都是零写入，
    只带真回收行才成功）。
  - `api.test.tsx` +2：回收站勾 2 行 → 确认 → body 恰好 `["t1","t2"]`、成功后清选择
    并重拉（`recycled=true` 请求 >1 次）；404 时批量条仍在（选择保留）。
  - 既有 86 例全绿（antd 两字按钮插空格的 /恢\s*复/ 口径继续生效）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；后端子集 **16 passed**
  （d252 + d251 + api_def_recycle）；web 全量 **2081 passed / 696 suites / 0 failed**。
- 仍未做（顺延）：批量 purge（需设计等价确认）；环境组 EXISTS 筛选；模型配置搜索；
  二期清单照旧。

## 70. 第 63 刀交付：批次表审计 + 用例回收站批量恢复（D253，2026-11-23）

### 70.1 审计：1D / 1F 两行状态过期（文档订正，非新功能）

- **1D ADB**：此前写「未开放」是批次完成时漏改。现证据：路由
  `/adb/devices`、`/adb/cases` 在 App.tsx 注册；`backend/tests/test_adb_*.py`
  共 11 个文件（设备/用例/执行/心跳/锁/真机 worker）；混合场景
  `test_scenario_run_adb.py` 证明 ADB 步骤与 `ui_case` 同轴可编排；D217/D224
  的高级搜索与设备卡片墙也在。→ 改「已交付」并补一句能力范围。
- **1F Pilot 自然语言生成场景骨架**：`propose_scenario_plans` 元工具 + 图校验 +
  两方案候选卡片 + `ScenarioPlansCard`，测试
  `test_agent_metatools_cards.py`；按 1F 演示口径「候选卡片、零落库」= 已交付。
  「应用候选卡片 → 落库成场景」是二期 `scenario_draft` 表，单独标为二期边界。
- README 表格后加「批次审计（2026-11-23）」一段：一期 1A–1F 全部交付，未做只剩
  两处二期边界（ASK 页面批准按钮、候选卡片应用）与二期 5 项。

### 70.2 功能缺口：用例回收站只能逐行恢复（D253）

后端 `functional_case_batch_restore` / `functional_case_batch_purge` 早就在
（D232 批量的同批产物），前端却把勾选列限定在「非回收站」——回收站里要恢复
十条得点十次。

- **前端** `functionalCases.tsx`：
  - `rowSelection` 由 `canUpdate && !inRecycled` 改为 `canUpdate`：回收站也能勾；
  - 工具栏新增「批量恢复（N）」（testid `fc-batch-restore`，仅回收站 + 有选择时出现）；
  - 确认弹窗与结果话术**按后端真实口径**写：不是全有或全无，而是「能恢复的都恢复，
    不在回收站的跳过」；`affected < 勾选数` 时报「已恢复 X 条，跳过 Y 条」，
    不允许把部分成功说成整批成功；
  - 成功后清选择、重拉列表与模块树（模块计数、回收站计数都会变）；
  - 批量编辑/批量复制仍只属于正常视图（回收站里的行不该被改优先级/复制）。
- 测试：
  - `functionalCases.test.tsx` +1（D253）：回收站勾 2 条 → 确认 → body
    `{project_id:"p1", case_ids:["c1","c2"]}`，成功后按钮随选择消失、`recycled=true`
    重拉次数 +1。
  - 改 1：D232 的「回收站无勾选列」按新行为拆成「READONLY 无勾选；回收站有勾选
    但无批量编辑/复制」。
  - 加 `afterEach(Modal.destroyAll)`：静态 confirm 挂在 body、`cleanup` 收不走，
    否则下一个用例的 `findByRole("dialog")` 会摸到残留弹窗（本轮全量跑出来的真 bug）。
  - 全文件 **23 passed**。
- 门禁（本轮实测）：`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2082 passed / 697 suites / 0 failed**。后端本轮零改动（复用既有端点）。
- 仍未做（顺延）：用例回收站的「批量彻底删除」界面（后端 `batch-purge` 已有，
  需设计「输入确认」或计数二次确认）；环境组 EXISTS 筛选；模型配置搜索。

## 71. 第 64 刀交付：用例回收站批量彻底删除（D254，2026-11-23）

D253 的另一半。后端 `functional_case_batch_purge` 与 batch-restore 同批存在，
前端只有逐行的「彻底删除」（弹窗要求逐字输入用例名）——回收站里清十条要点十次。

- **确认交互的设计取舍**：单条的不可逆护栏是「逐字输入这一个用例名」；批量里
  N 个名字逐个输不现实，把它降级成固定短语「彻底删除」又会弱化护栏。折中：
  - 弹窗点名前 3 条并给出「等 N 条」，把「到底删哪些」摆到眼前；
  - 需求输满「彻底删除」四个字才解锁确认钮（不是勾一个「我已知晓」）；
  - 文案写明无法恢复、步骤与执行记录一并清理；
  - 不与「批量恢复」共用弹窗——两个方向相反的不可逆/可逆动作，不能靠读标题区分。
- **前端** `functionalCases.tsx`：新增 `fc-batch-purge`（canDelete + 回收站 + 有选择）；
  独立受控 Modal（要输入框，普通 `Modal.confirm` 撑不住），`destroyOnHidden` 不需要
  ——每次打开都 reset 短语；成功后清选择、关弹窗、`load()` + `loadTree()`。
- **口径一致性**：后端只删 `status=recycled` 的行，`affected` 可能小于勾选数——
  与 D253 同样如实报「已彻底删除 X 条，跳过 Y 条（已不在回收站）」，不把部分成功
  说成整批成功。
- 测试：`functionalCases.test.tsx` +1（D254）：勾 2 条 → 弹窗点名「登录成功」且含
  「无法恢复」→ 未输短语时确认钮 disabled → 输入后 enabled → body
  `{project_id:"p1", case_ids:["c1","c2"]}` → 按钮随选择消失。全文件 **24 passed**。
- 门禁（本轮实测）：`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2083 passed / 698 suites / 0 failed**。后端本轮零改动。
- 仍未做（顺延）：环境组 EXISTS 筛选；模型配置搜索；二期清单照旧。

## 72. 第 65 刀交付：场景批量回收 / 恢复（D255，2026-11-23）

审计发现的真问题：场景页批量「回收站」是**前端 for 循环逐条 POST
`/scenarios/{id}/delete`**。3 条里第 2 条失败时，第 1 条已经删了、第 3 条没动，
用户看到一条 toast 却不知道自己现在处于哪种状态；请求数也与选择数线性增长。
场景域后端此前只有 `scenario-batch-move`，没有批量回收/恢复。

- **后端**：
  - `POST /scenario-batch-delete`（`scenario:delete`）与
    `POST /scenario-batch-restore`（`scenario:update`），入参 `ScenarioBatchIn`
    （1–200 个 id）；
  - 共用一个 `_batch_rows`：重复 id → 422；任一不存在或状态不符 → 404 +
    `details.scenario_ids`，**整批一行不动**；逐条 `assert_row_visible`；
  - 删除逐行写 `updated_by = ctx.user_id`——回收站「删除人」列读的就是它（同单删，
    D180 的坑不再从批量口重开）；
  - 单条 delete/restore/purge 完全不动，批量只是把同一判据收拢成一次事务。
- **前端** `scenes.tsx`：
  - 批量回收的 `onOk` 由 `for (const id of sel) await sceneApi.remove(...)` 改为
    一次 `sceneApi.batchDelete`；确认文案补「全有或全无：只要有一个已在回收站，
    整批都不会删」；
  - 回收站视图的 `rowSelection` 由恒 `undefined` 改为 `canUpdate` 时开放，新增
    「批量恢复」（testid `scene-batch-restore`）+ 取消选择；确认弹窗说明判据；
  - 失败保留选择，交给用户按 404 的 ids 改名单。
- **客户端** `api/scene.ts`：`batchDelete` / `batchRestore` 两个方法；入参类型
  `ScenarioBatchIn` 先手写镜像（字段与后端一致，schema.d.ts 重生成后可直接替换）。
- 测试：
  - `tests/test_d255_scenario_batch_recycle.py` **3 passed**：批删/批恢复往返
    （回收站名单、删除人非空、单条读回仍正常）；批删全有或全无（已回收/不存在/
    重复三种零写入）；批恢复的 404 与 422 护栏 + 只带真回收行成功。
  - `scenes.test.tsx` +2（D255 组）：批量回收**只发一条** `/scenario-batch-delete`
    且 body 恰为勾选 ids，并断言旧的逐条 `/scenarios/{id}/delete` 一条都不剩；
    回收站勾选后 `/scenario-batch-restore` body 带 ids。该组 `afterEach` 补
    `Modal.destroyAll()` + `cleanup()`（此文件原先没有 afterEach，静态 confirm
    与上一份 DOM 会串到下一例）。全文件 **75 passed**。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2085 passed / 699 suites / 0 failed**。
- 仍未做（顺延）：场景回收站的批量**彻底删除**（单条 purge 要逐字场景名，
  批量需按 D254 的短语确认；本轮只做回收/恢复两向）；环境组 EXISTS 筛选；
  模型配置搜索；二期清单照旧。

## 73. 第 66 刀交付：场景回收站批量彻底删除（D256，2026-11-24）

补上 §72 明确顺延的那一向：批量 purge。

- **确认交互**：单条 purge 的护栏是「逐字输入这一个场景名」；批量里 N 个名字逐个输
  不现实（与 D254 用例批量同一取舍），降级为固定短语「彻底删除」。**但服务端必须验**
  ——`confirm_word` 精确等于「彻底删除」才执行，空串/带空格/近义词一律 409
  `confirm_word_mismatch`。前端 disabled 是提示，不能当成唯一防线。
- **后端** `POST /scenario-batch-purge`（`scenario:delete`）：
  - 短语校验**先于**行校验：短语错时永远回 confirm_word_mismatch，不会被
    「某 id 不在回收站」的 404 掩盖；
  - 行校验复用 `_batch_rows`（重复 → 422；任一不存在/非回收站 → 404 + ids，
    整批不动）；
  - 全过后逐行 `db.delete` + 一次提交——真物理删除，不是置状态。
- **前端** `scenes.tsx`：回收站批量条新增「批量彻底删除」（canDelete），受控 Modal
  （短语输入撑不住 `Modal.confirm`）：点名前 3 条 + 「等 N 个」、写明无法恢复而
  「运行记录与报告保留（历史不追删）」、未输对时确认钮禁用；失败弹窗留着重试。
- 测试：
  - `tests/test_d256_scenario_batch_purge.py` **3 passed**：短语四连错（空/尾空格/
    短词/中间空格）全 409 且零删除，正确的才放行；全有或全无（混活行 404 列 ids、
    重复 422 均零删除）；物理删除（两条详情都 404、列表只剩丙、回收站空）。
  - `scenes.test.tsx` +1（D256 组）：未输短语禁用 → 输对后 POST body
    `{project_id, scenario_ids:["s1"], confirm_word:"彻底删除"}` → 批量条消失。
    全文件 **76 passed**。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；后端子集 **37 passed**（d256 + d255 + d47a）；`tsc --noEmit` 0；
  eslint 0 error/0 warning；web 全量 **2086 passed / 700 suites / 0 failed**。
- 仍未做（顺延）：环境组 EXISTS 筛选；模型配置搜索；接口用例/场景用例的回收站
  批量入口审计（若有同类「后端有、界面无」的缺口照 D253/D255 补）；二期清单照旧。

## 74. 第 67 刀交付：场景批量复制（D257，2026-11-24）

审计「前端 for 循环调后端」的第二处：场景批量复制走 N 次
`POST /scenarios/{id}/duplicate`。与批量回收不同，这里的问题不是半批失败，而是
**名称策略在批量语境下不可用**——单条 duplicate 撞名回 409，批量 20 个里只要有一个
「甲 - 副本」已存在，整个循环就停在第 k 个，前面 k-1 个已建、后面没建，用户看到的
是「复制失败」而列表里多出一堆副本。

- **后端** `POST /scenario-batch-copy`（`scenario:update`）：
  - 前置校验复用 `_batch_rows`：重复 id → 422；任一不存在或在回收站 → 404 + ids，
    **一个副本都不建**；`module_id` 给定时先验模块属于本项目；
  - 名称：一次取出项目内全部名字做 set，逐条找 `源名 - 副本`、`源名 - 副本 2`…，
    找到即加入 set（同批内的新副本也互相避让）。**与单条 409 的差异是刻意的**，
    写在 schemas 类注释里；
  - 回包 `ScenarioBatchCopyOut{created, names[]}`：前端 toast 不用再拿勾选数冒充
    成功数；
  - 副本字段复制范围同单条 duplicate（step_graph、variables、fail_fast、
    max_runtime_ms、env_id、common_assertions、priority、step_count…），
    owner/updated_by 记为当前用户，version 重置为 1。
- **前端** `scenes.tsx`：`batchDuplicate` 由 for 循环改为一次 `batchCopy`；
  toast 改为「已复制 {回包 created} 个场景（名称自动加「 - 副本」）」；失败保留选择。
- 测试：
  - `tests/test_d257_scenario_batch_copy.py` **3 passed**：后缀避让（预占「甲 - 副本」
    → 新副本叫「甲 - 副本 2」；再复制 → 「甲 - 副本 3」；同批重复 id 被 422 先拦）；
    前置校验零写入（混合回收站行/不存在 id）；指定 module_id 时副本进该模块、
    源场景模块不动。
  - `scenes.test.tsx`：改写既有「批量复制」两组断言（原钉「duplicate 各一次」→
    现钉「batch-copy 恰一条 + duplicate 零调用」；原「第 2 个失败不谎报」→
    「整条失败不谎报、选择保留」），另 +1（body 带勾选 ids）。全文件 **77 passed**。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；d255–d257 共 **9 passed**；`tsc --noEmit` 0；eslint 0 error/0 warning；
  web 全量 **2087 passed / 700 suites / 0 failed**。
- 仍未做（顺延）：环境组 EXISTS 筛选；模型配置搜索；「批量执行」仍是 N 次
  enqueue（后端无批量执行端点，涉及每场景 env 解析与部分失败语义，单列一刀）；
  二期清单照旧。

---

## 75. 第 68 刀交付：场景批量执行（D258，2026-11-24）

审计「前端 for 循环调后端」的第三处：场景批量执行走 N 次
`POST /scenarios/{id}/run`（D70 解禁时留下的循环）。这一处与 D255/D257 的关键差别是
**投递天生不可攒批**：`orchestration.enqueue` 内部 `db.commit()`（它要为 broker 不可达时
删除孤儿 run 负责），所以「整批一次事务」在这里不成立；能做成全有或全无的只有预检。

- **后端** `POST /scenario-batch-run`（`scenario:run`）：
  - 预检全有或全无：重复 id → 422；任一不存在/在回收站 → 404 + ids；统一 `env_id`
    不可解析 → 404。任何一条不合格，**一个 run 都不建**；
  - `env_id` 缺省 = 各场景回落自己保存的环境（与单跑 `payload.env_id or s.env_id`
    同一条语义）；给定时统一覆盖；
  - 投递逐条 `enqueue`，回包 `ScenarioBatchRunOut{ok, run_ids[], failed[]}`，
    `failed[]` 带 `scenario_id/code/message`：broker 在第 k 条死掉时前 k-1 条已经诞生，
    回包必须如实分账，前端不能拿勾选数冒充「已启动数」；
  - 「先取标量」：`enqueue` 的 commit 会让 ORM 实例过期，循环前先把
    `(id, name, env_id, max_runtime_ms)` 快照出来（同 T9 的坑）。
- **前端** `scenes.tsx`：`submitBatchRun` 由 for 循环改为一次 `batchRun`；
  成功 toast「已入队 N 个执行，进度看报告中心」；有 `failed[]` 时改 warning
  「已入队 N 个，M 个没投递成功：原因…」；预检失败整批零 run，关窗重试安全。
- 测试：
  - `tests/test_d258_scenario_batch_run.py` **4 passed**：2 场景批量跑 → `run_ids`
    长度 2、终态 passed、`GET /runs?subject_type=scenario` 能查到、trigger=manual；
    混入回收站行 → 404 + 具体 id 且 run 总数不变；重复 id → 422 零 run；
    统一 env 不存在 → 404 零 run。
  - `scenes.test.tsx`：改写既有「批量执行」四组断言（原钉 N 次 `run` → 现钉
    一条 `batch-run` + `run` 零调用；`env_id=null` 逐场景回落；无环境可跑时一次请求
    都不发；部分失败按 `failed[]` 分账提示并清勾选）。全文件 **77 passed**。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；d255–d258 共 **13 passed**；`tsc --noEmit` 0；eslint 0 error/0 warning；
  web 全量 **2087 passed / 700 suites / 0 failed**。
- 仍未做（顺延）：环境组 EXISTS 筛选；模型配置搜索；二期清单照旧。

---

## 76. 第 69 刀交付：环境组按组内环境筛选（D259，2026-11-24）

D249 铺环境组高级搜索时把 `envs` 明确留白：「跨 environment_group_item + environment
的打包结果，按它筛需要 EXISTS 子查询，不在这把只认列的尺上」。本轮补上，同时避免
把「表达式」硬塞进「列」的语言坑。

- **共享层**（`shared/filters.py` + `shared/filter_registry.py`）：
  - `FieldSpec.ops` / `FieldDecl.ops_override`：**操作符子集**。缺省 = 控件型全集；
    构造时校验必须是全集子集（编译分支不动，只收窄选择面）。给「值由表达式拼出来、
    全集里有些操作符没有诚实语义」的字段用。
  - `filter-meta` 的 `ops` 与 400 文案照旧从同一份声明算，前端继续零字段知识。
- **环境组**（`env/group_services.py`）：
  - 相关标量子查询 `GROUP_CONCAT(environment.name, ', ')` 关联到
    `environment_group.id`，注册为 `envs`（kind=text，label「组内环境名」）；
  - 只开放 `CONTAINS / NOT_CONTAINS / EMPTY / NOT_EMPTY`：含 = 至少一个环境名匹配；
    不含 = 没有任何环境名匹配（`GROUP_CONCAT` 空集为 NULL，`_neg` 保留空组）；
    为空/不为空 = 组里有没有环境；
  - `EQUALS/IN` 对拼接串在多个环境时必然漏判，**刻意 400**（假筛选项禁令），
    由 d259 第 4 例从响应码与 400 文案两路钉住。
- 测试：
  - `tests/test_d259_env_group_envs_filter.py` **4 passed**：含/不含（空组在「不含」
    里保留）、为空/不为空、与组名/说明 AND+OR 组合且不越项目、EQUALS/IN → 400。
  - `tests/test_d249_env_group_advanced_search.py` 同步新契约（字段面加入 envs、
    meta ops = 四枚、坏字段只剩 project_id），4 passed。
  - `tests/test_d47a_list_filters.py` **31 passed**（共享层改动回归）。
  - `web/src/settings/EnvGroupsPanel.test.tsx` +1：保存视图里的 `envs` 条件原样进
    filter（5 passed；前端字段清单来自后端 meta，本刀零组件改动）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1250 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2088 passed / 700 suites / 0 failed**。
- 仍未做（顺延）：模型配置搜索；二期清单照旧。

---

## 77. 第 70 刀交付：模型池关键字搜索（D260，2026-11-24）

模型卡片墙此前是「拉 `size=200` 一次全画」：`/model-cfgs` 只有 `model_type` 一个收窄轴，
模型一多只能肉眼找 —— 这是审计里「模型配置搜索」那条的兑现。

- **后端** `GET /model-cfgs?keyword=`（`model:cfg:read` 不变）：
  - 三列 OR：`name` / `model_name` / `base_url`（用户认模型就是这三样；不搜协议/能力位，
    那些已有专门列与探测徽标）；
  - 两端空白不进入匹配（全空白 = 不筛，同场景列表口径）；
  - `%` / `_` 是字面量：复用 `shared.filters._like` + `ESCAPE '\'`——不转义时
    「搜 100%」会变成「搜任意串」，界面上看不出坏、只是结果变多；
  - 与 `model_type`、游标分页是同一条 stmt 上的 AND（筛选在前、翻页在后）。
- **前端** `ModelTab.tsx`：
  - 搜索框 `model-search`（`Input.Search`）；`kwDraft` 与已提交的 `kw` 分离——
    回车/点搜索才发请求，边敲边发会把 200 张卡片墙打成连连看；
  - 零命中时空态带关键词（「没有匹配「X」的模型」），不把「搜不到」画成
    「还没有登记模型」（那是两件事：一个该换词，一个该去登记）。
- 测试：
  - `tests/test_d260_model_cfg_search.py` **3 passed**：三列各自命中 + 大小写不敏感；
    空白 = 不筛、两端空白裁掉；`%`/`_` 字面量（不做转义时 `keyword="%"` 会把四条
    全捞出来）；与 `model_type` 叠加收窄。
  - `web/src/settings/ModelTab.test.tsx` **29 passed**（+1）：只改输入框不发请求；
    点搜索后 GET 带 `keyword=bge` 且卡片收窄到 1 张；零命中出带词空态。
  - 后端既有 `test_model_cfg.py` / `test_model_cfg_probe.py` / `test_model_usage.py`
    共 **24 passed**（列表形状与权限门回归）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1251 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2089 passed / 701 suites / 0 failed**。
- 仍未做（顺延）：二期清单（MCP / Skills / 审批门 / 场景变更历史 / 跨项目复制场景）。

---

## 78. 第 71 刀交付：场景跨项目复制（D261，2026-11-24）

D257 把「N 次 duplicate 循环」收成一次事务，但落点只能在当前项目。本轮补
`target_project_id`：把一套编排复制到另一个项目复用（MS 的常见工作流）。

- **后端** `POST /scenario-batch-copy`（decorator 仍为 `scenario:update`，跨项目另需目标
  项目 `scenario:create`）：
  - 两处项目私有资产不跟随：`env_id` 清空（D181 已禁止跨项目绑环境，跟随过去副本
    一保存就违规）；`module_id` 缺省 = 目标项目「未分类」（模块树也是项目私有，
    同 id 在目标项目里不存在）。显式给了 `module_id` 时必须属于**落点**项目，否则 404；
  - 权限两边都要：`ensure_project_access(源)` 读源，`ensure_project_access(目标)` +
    `require("scenario:create")` 落副本；
  - **源行可见性在切到目标权限之前判定**：`ensure_project_access` 会改写 `ctx.perms`，
    先切后查会让「目标项目管理员、源项目普通成员」借道看见源项目里别人私有的场景；
  - 名称在目标项目内去重（「 - 副本 2/3…」），与 D257 同一套；目标不存在/无权限同码 403，
    不泄露存在性；全有或全无的预检（重复 id / 回收站行）原样继承。
- **前端** `scenes.tsx`：批量条加「复制到项目」（`scene-batch-copy-to`）→ 弹窗才拉
  `/projects?size=200`（首屏不为偶发入口多打一发）；候选过滤当前项目；`my_perms` 有值
  且缺 `scenario:create` 的目标禁用并在文案里标原因（`my_perms` 缺席时不猜，交给后端）；
  弹窗明说「副本不带环境、落未分类」，避免用户到目标项目运行失败时病因与现场隔一次跳项目。
- 测试：
  - `tests/test_d261_scenario_cross_project_copy.py` **3 passed**：跨项目复制 2 条 →
    目标模块/环境为 None、源不动、目标撞名顺延「 - 副本 2」；无权限/目标不存在 →
    403 零写入；跨项目传源模块 id → 404 零写入，改传目标模块则落在该模块。
  - `web/src/pages/scenes.test.tsx` **78 passed**（+1）：开窗才拉候选、当前项目不出现、
    只读目标禁用并标原因；确认后恰一条 `batch-copy` 带 `target_project_id: "p2"`，
    toast 点名目标项目并清勾选。
  - `tests/test_d257_scenario_batch_copy.py` **3 passed**（项目内复制回归）。
- 门禁（本轮实测）：ruff 全过；lint-imports **4 kept / 0 broken**（251 文件 /
  1251 依赖）；`tsc --noEmit` 0；eslint 0 error/0 warning；web 全量
  **2090 passed / 701 suites / 0 failed**。
- 仍未做（顺延）：二期清单（MCP / Skills / 审批门 / 场景变更历史）。

## 79. 第 72 刀交付：场景变更历史（D262，2026-11-24）

D261 之后二期清单只剩 MCP / Skills / 审批门 / 场景变更历史；本轮补最后一项
「谁在什么时候把场景改成了什么」——`audit_log` 只有「谁点了保存」与产物 id，
没有 before/after，不能冒充变更历史。独立建表，独立读口。

- **后端**：
  - 新表 `scenario_revision`（迁移 `0045`）：`id / project_id / scenario_id /
    version / actor_id / changed(JSON) / created_at / updated_at`；复合索引
    `(scenario_id, version)`。append-only——没有任何 update/delete 服务。
  - `scenario_update` 成功即落一行（同事务）：`version` = 变更后的版本号；
    `changed=[{field, before, after}]` 由更新前后两份 digest 逐键比较得出。
    没有字段差异也落（`changed=[]`）：version 确实前进了，历史空档会让
    「v5 是谁改的」永久无法回答。
  - **敏感值不进历史**：`variables` 只留键名（值可能是 token/密码），
    `step_graph` 只留步骤数（节点 config 里可能内嵌鉴权头）；其余标量
    （name/priority/module_id/fail_fast/max_runtime_ms/env_id/project_public）
    按值记录。键集合在 `_revision_digest` 一处定义，读写不分叉。
  - `GET /scenarios/{scenario_id}/revisions`（perm `scenario:read`）：最新在前，
    `(version, id)` 倒序键集游标分页；可见性口径与 `scenario_get` 逐字一致
    （同项目 + `assert_row_visible` + 回收站 404）——历史里可能有旧名称等元信息，
    不能成为绕过回收站的第二扇门。`actor_name` 由分页后 APP_USER 小查询回填。
  - 彻底删除显式清历史：单条 `scenario_purge` 与 `scenario_batch_purge` 都在
    删场景前 `DELETE scenario_revision WHERE scenario_id IN (...)`（全库无外键，
    级联必须写出来，否则留孤儿行）。
- **前端**：
  - `sceneApi.revisions(projectId, scenarioId, {cursor,size})`（手写镜像，
    与后端 `ScenarioRevisionOut` 逐字一致）。
  - 新 `scene/RevisionDrawer.tsx`：编辑器顶栏「变更历史」（只读面，
    不跟 `readOnly` 隐藏）→ 抽屉里版本 Tag、操作人名、时刻、字段中文标签 +
    `before → after`；步骤数/变量键名/断言条数按摘要格式展示；`changed=[]`
    如实写「本次保存只推进了版本」；空态/失败态分开说，失败可重试，
    「加载更早的记录」按 cursor 续取。
- **测试**：
  - `tests/test_d262_scenario_revisions.py` **5 passed**：两次更新 → 两条历史、
    最新在前、字段与前后值正确；variables 值/step_graph 配置不进响应；
    size=1 游标翻三页不重不漏；跨项目 403/404、私有场景对普通成员 404、
    回收站 404；purge 后 `scenario_revision` 零行。
  - `web/src/scene/RevisionDrawer.test.tsx` **3 passed**：成功腿摘要格式、
    空态文案、失败腿 Error.message + 重试成功。
- **门禁（本轮实测）**：ruff 全过；lint-imports **4 kept / 0 broken**
  （251 文件 / 1251 依赖）；后端场景域 **46 passed**；`tsc --noEmit` 0；
  eslint 0 error/0 warning；web 全量 **2093 passed / 703 suites / 0 failed**。
- **二期清单**：剩 MCP 服务、Skills、审批门（写/破坏性工具的页面批准）3 项。

## 80. 第 73 刀交付：审批门（D263，2026-11-24）

D262 之后二期只剩 MCP / Skills / 审批门，以及「ASK 页面批准」这处一期边界。本轮
把两者合成一刀：ASK 的写/破坏性工具在页面上真正可批准，而不是只提示「去中断」。

- **后端**：
  - `POST /agent/runs/{run_id}/approval` body `{tool_call_id, decision, comment?}`，
    decision 三档：`once` / `session` / `deny`。返回 202。
  - `tasks.decide_approval`：SETNX 会话锁内做**第二遍**校验（run 属于会话、审批行
    存在、decision 仍为 NULL、run.status == WAIT_APPROVAL）→ 决策 + `APPROVAL_DECISION`
    事件同一次 commit → run 拉回 RUNNING → 异步 `_resume`。两个标签页同时点，只有先到
    的能写；重复点 409 `already_decided`，非待批 409 `run_not_waiting`。
  - `AgentRunner.resume_turn`：先补被挂起 tool_call 的配对 `TOOL_RESULT`，再回同一
    ReAct 循环（否则给模型一段「有 tool_calls、无 tool 消息」的残缺对话）。
    批准 = 按**落库 args** 真执行；拒绝 = `ok=False` +「用户拒绝了该工具调用（审批门）」，
    模型看得见并能改道。`once` 用临时 grant 只放行本次（不写库），`session` 才由
    `approved_grants` 持久免批（查询口径从 `decision=="approve"` 校正为 `"session"`）。
  - 鉴权两层：`_load_session`（项目成员）+ 会话所有者/系统管理员才能代表会话做决定；
    审批**不放宽**工具自身权限位——续推仍以会话所有者 perms 走 dispatcher。
  - `APPROVAL_REQ` 载荷补 `run_id`：刷新/重连后前端只能靠事件回放重建界面，
    没有它未决审批卡按钮只能恒灰，「重开会话依旧可操作」就是空话。
  - `_execute` 与 `_resume` 共用 `_prepare_runner` / `_fail_run`：模型缺失、模型不支持
    工具这两条 ERROR 路径只有一份实现。
- **前端**：
  - 审批卡三档按钮「批准本次 / 本会话都批准 / 拒绝」（`approval-once/session/deny`），
    在途禁用防连点；宿主没接回传时不画假按钮，只陈述「需要你在页面上确认」。
  - 回放里的 `APPROVAL_DECISION` 按 tool_call_id 把卡翻成只读徽标（已批准仅本次 /
    本会话该工具免再批 / 已拒绝），不再可点。
  - bench 从 `APPROVAL_REQ.payload.run_id` 认领 run（刷新后审批仍可操作）；
    回传成功前先切「运行中」上锁，失败还原原状态；顺带清掉 `composerFocus` 死状态。
- **测试**：
  - `tests/test_d263_approval_gate.py` **4 passed**：批准一次真执行真落库且续推 DONE、
    重复点 409 不二次执行；拒绝补 ok=False 且资源不落库；session 授权下第二次同名工具
    不再弹审批；非所有者 403、未知 run/tool_call 404、已中断 run 409 run_not_waiting。
  - `web/src/agent/EventCard.test.tsx` 新增 4 例（三档回传 / 已决只读 / 无宿主不画假门 /
    在途禁用）；`bench.test.tsx` 新增「审批 POST 路径与 body 逐字 + 决策事件翻只读」，
    旧的「暂不支持页面批准」文案断言按新事实改写。
- **门禁（本轮实测）**：ruff 全过；lint-imports **4 kept / 0 broken**
  （251 文件 / 1252 依赖）；agent 相关后端套件 **33 passed**；`tsc --noEmit` 0；
  eslint 0 error/0 warning；web 全量 **2096 passed / 128 files / 0 failed**。
- **剩余**：二期 MCP 服务、Skills 2 项；一期边界只剩候选卡片「应用/落库」。

## 81. 第 74 刀交付：候选方案落库（D264，2026-11-24）

D263 之后一期边界只剩候选卡的「应用/落库」，二期剩 MCP / Skills。本轮把候选方案接进
正式场景：不是新造一套草稿存储，而是**复用 `POST /scenarios`**——场景创建契约（重名 409、
图不合法 422、缺 `scenario:create` 403）早就存在，缺的只是入口。

- **前端公共件**：
  - `shared/planSave.ts`：`withoutRefNames` 深拷贝后递归删 `ref_name`（meta 工具为
    「人话步骤」补的渲染字段，不是 §7.4 执行契约），再调 `sceneApi.create`；
    `ScenarioCreateIn` 的四个带缺省值字段（priority/variables/fail_fast/project_public）
    显式带上，等价于走服务端缺省。
  - `shared/SavePlanAction.tsx`：候选卡与预览页共用的唯一交互件。没接 `onSave` 时
    **整个组件不渲染**；没带 graph 时 disabled + 人话 Tooltip；弹窗可改名（trim 后
    空名不发请求）；成功翻「已保存」Tag +「打开场景」（缺省 `#/scene/{id}`，新 Tab）；
    失败保留弹窗——后端原话已由 `client.ts` 弹过一次，用户可改名重试。保存成功经
    `onSaved` 回执宿主，预览页横幅同步从「未落库」翻成「已保存为正式场景」——
    页面上不许一边写未保存一边摆着已保存。
- **候选卡**：`CardContext` 增 `onSaveScenarioPlan` 与 `projectId` 两个宿主注入位；
  bench 按当前项目 `scenario:create` 决定注入与否（缺位不画保存钮），并把项目 id 写进
  预览信封。
- **预览页**（新 Tab）：读不到 bench 的本地选择，落库归属必须随 sessionStorage 带过来。
  与当前登录项目一致时直接用它的 `my_perms`；不一致就单拉 `/projects/{id}` 拿生效位；
  拉不到/没有 `scenario:create` 一律不渲染保存钮（宁缺，不写错项目）。旧信封没有
  `project_id` 时同样不画——不猜归属。
- **测试**：
  - `ScenarioPlansCard.test.tsx`：13 例（新增无宿主不渲染、改名后回调参数逐字、
    成功翻已保存 + 链接、无 graph disabled + Tooltip、失败留弹窗；预览信封断言带
    `project_id`）。
  - `scenePreview.test.tsx`：8 例（新增旧信封无保存钮、归属=当前项目时真发
    `POST /scenarios` 且 body 无 `ref_name`、只读角色不渲染、归属≠当前项目单拉项目位）。
  - `e2e/pilotCards.spec.mjs`：原「保存恒 disabled + Tooltip 二期开放」改为真实落库
    动线（改名保存 → 已保存 Tag + 场景链接 → 用 API 回查项目场景列表确认库里真有）。
- **门禁（本轮实测）**：`tsc --noEmit` 0；eslint 0 error/0 warning（9 个改动文件）；
  相关 3 个测试文件 31 passed；web 全量 **2102 passed / 128 files / 0 failed**。
  后端未动（复用既有端点），无后端门禁增量。
- **剩余**：二期只剩 MCP 服务、Skills 2 项；一期边界全部闭合。

## 82. 第 75 刀交付：MCP 服务（D265，2026-11-24）

二期开箱第一项。设计 §9.8 给的三条硬要求——工具命名 `mcp__<server>__<tool>`、
effect 默认 write、stdio 纳权限位 + 全量审计——本轮全部落地；「懒启动/闲置 15 分钟
卸载/tool_cache」按原文实现，不是把配置存进库就算完。

- **后端数据面**：`mcp_server`（迁移 `0046`）存 transport 配置、`tool_cache`、
  逐工具 `tool_effects`、`status/last_error/last_checked_at/last_latency_ms`。
  env/headers **整串 Fernet 加密**（值永不回显，列表只给键名）；更新时
  `None=保留 / {}=清空`，与模型 api_key 的「留空保留」同一口径。
- **七个 `@service`**：列表/登记/修改/删除/测试连接/启停/工具缓存。治理位只有
  `mcp:server:read`（读）与 `mcp:server:manage`（写），系统管理员外一律 403；
  「测试连接」是 write（会拉起进程/发网络请求），失败落成 `ok=false + last_error`
  而不是 500；登记/保存/启用都执行「保存并重连」，停用即断会话。
- **运行时**（`app/modules/mcp/client.py`）：stdio / SSE / StreamableHTTP 三种
  transport；探测走一次性连接（不污染在跑的会话）；调用走**每 server 一个常驻
  asyncio 任务 + 队列**——MCP SDK 的连接上下文内部是 anyio task group，跨任务
  `__aexit__` 会报 cancel scope 错误，所以连接的建立与关闭必须留在同一任务里。
  首次调用懒启动、闲置 15 分钟由 sweeper 卸载；连接失效时丢弃并重连一次。
- **Agent 接线**：工具箱 = `@service` 工具 + `tool_declarations()`（只对持有
  `mcp:server:manage` 的调用方展开）；分发器对 `mcp__` 前缀单独分流——不存在与
  无权限同一句话，PLAN 模式只放行 read，ASK 模式的 write 照走 D263 审批门，
  调用结果与异常都写审计（`target=mcp:<server>`）。`/agent/tools` 同样并入，
  前端工具箱不用改。
- **前端**：`settings/McpTab.tsx`（设置页新 Tab + `/settings/mcp` 侧栏真入口）：
  状态点（在线/离线/停用）、transport、工具数、最近错误、最近探测与延迟；添加/
  编辑弹窗支持 stdio 命令+参数（一行一个）与 sse/http URL+请求头（KEY=VALUE），
  密钥留空保留、显式勾选清空；「测试连接」显示工具数与延迟；「工具预览」弹窗
  展示原始 input schema；无管理位只读（隐藏写操作，预览仍可看）。
- **测试**：后端 `test_mcp_server.py` 7 例（真 stdio 子进程探测 2 个工具、密钥
  加密与回显、None/{ } 更新语义、启停/删除、HTTP 不可达落 offline、名称 409、
  权限门连 PROJECT_ADMIN 也 403、Agent 工具面 + 真调用 + ASK 审批 + PLAN read
  放行 + 停用后工具消失）；前端 `McpTab.test.tsx` 9 例；`shell.test.tsx` 按
  「MCP 已交付」翻新（只剩 Skills 哨兵 + nav-mcp 真导航到 /settings/mcp）。
- **门禁（本轮实测）**：后端 ruff 0、mypy 0、lint-imports 4 kept/0 broken
  （新增 `app.modules.mcp` 两处显式登记）；前端 tsc 0、eslint 0、相关 26 passed。
- **剩余**：二期只剩 Skills 1 项（系统提示注入清单 + read_skill 渐进披露 +
  `skills/<name>/SKILL.md` 管理页）。

## 83. 第 76 刀交付：Skills（D266，2026-11-24）

二期最后一项。设计 §9.8 的口径是「文件是真相源、库是索引」：Skill 不靠页面手写，
而是从 `backend/skills/<name>/SKILL.md` 扫描进库；系统提示只注入启用 Skill 的
name+description，正文靠 `read_skill` 渐进披露——**不是把全文塞进上下文**。

- **后端数据面**：`skill` 表（迁移 `0047`）：`name` 唯一、`description`、`source`、
  `dir_path`、`body`、`allowed_tools`（JSON）、`checksum`、`enabled`、`synced_at`。
  正文落库是为了 `read_skill` 读到稳定快照（文件在同步间隙被改也不会读到半截）。
- **四枚 `@service`**：`GET /skills`（键集分页）、`POST /skills/sync`（显式扫描，
  报告 `added/updated/removed/unchanged/errors/scanned_dir`）、`GET /skills/{id}`
  （含正文）、`POST /skills/{id}/toggle`。治理位只有 `skill:manage`，系统管理员外
  一律 403（与 MCP 的 `mcp:server:manage` 同一条短路口径）。
- **同步语义**（`app/modules/skill/services.py`）：
  - `checksum` 未变即 `unchanged`，不白写库；变更只更新内容列，**保留 `enabled`**
    （管理员停用的技能不会因为一次同步被悄悄打开）；
  - 删除判据是「**现存 SKILL.md 路径集合**」，不是「解析成功集合」——某个文件写坏了
    只进 `errors`，库里那行原样留着，等修好再同步，绝不因解析失败误删；
  - 目录不存在 → 400 人话（不静默清空整张表）。
- **解析护栏**：frontmatter 必须 `---` 闭合；`name` 必须与目录名一致且是 ASCII
  slug（≤64）；`description` 非空 ≤500；`allowed-tools` ≤50 项；正文 ≤200KB。
  错误按文件逐条返回，前端原样摆出来。
- **Agent 接线**：
  - `runner.skill_catalog(db)` 把启用 Skill 的 `name: description` 拼到系统提示后
    （只给目录，不给正文）；停用即消失；
  - 新元工具 `read_skill(name)`（`METAs` 里的读类，`META_READ_PERM`）：`enabled`
    校验，404 的错误消息里带可用清单（`可用：a、b`），模型能自纠；
  - 读到正文后若带 `allowed-tools`，**本轮后续工具集收窄**到该白名单 ∪ `{read_skill}`
    ——渐进披露不只是「少给 context」，还真的收窄可用动作。
- **示例 Skill**：`backend/skills/api-scenario-gen/SKILL.md`（允许
  `get_project_outline`、`search_test_assets`、`propose_scenario_plans`，正文写场景
  编排步骤），给同步/阅读/收窄三条链路一个真实样本，也把「目录约定」钉进仓库。
- **前端**：`settings/SkillTab.tsx`（设置页新 Tab + `/settings/skills` 侧栏真入口）：
  同步/刷新、同步报告 Alert（新增/变更/移除/未变/逐文件错误/扫描目录）、表格
  （名称+来源+描述、allowed-tools、状态、最近同步、查看+启停 Popconfirm）、
  Drawer + ReactMarkdown 渲染全文；无 `skill:manage` 只读。
- **测试**：
  - `tests/test_skill.py` **7 passed**：同步→列表→详情→启停；updated/removed/errors
    三类报告与 `enabled` 保留；缺目录 400；权限门（PROJECT_ADMIN 403）；
    内置 `SKILL.md` 可解析；Agent `read_skill` + `skill_catalog` + `build_messages`
    注入；另加 runner 收窄用例（假网关回放 `read_skill`，断言第二次进模型时
    工具箱只剩白名单 ∪ `read_skill`）。
  - 前端 `SkillTab.test.tsx` 6 例；`shell.test.tsx` 16 例（二期两枚入口全翻真）；
    `settings.test.tsx` 系统管理员 Tab 列表十枚（含 MCP 服务、Skills）；
    `e2e/nav.spec.mjs` 两枚入口 `toBeEnabled()`、不再断言「未开放」。
- **门禁（本轮实测）**：后端 ruff `app`+`tests` 0；mypy `skill/mcp/agent`
  **23 source files 0**；lint-imports **4 kept / 0 broken**（262 文件 / 1313 依赖）；
  `alembic heads` = `0047 (head)`；前端 `tsc --noEmit` 0、eslint 0，
  web 全量 **2117 passed / 130 files / 0 failed**。
- **剩余**：二期清单清空；本表已无「未开放」项。

## 84. 第 77 刀交付：缺陷状态流转（D267，2026-11-24）

补齐 MS「状态流转设置」的项目级那一半（C9）。此前缺陷五态与转移边是 `models.py`
里的两份常量，只能在代码里改；本刀让每个项目能整份覆盖，且**不丢引用完整性**。

- **两张表（迁移 `0048`）**：`defect_status`（`(project_id,key)` 唯一，`name`、
  `is_start`、`is_end`、`position`）+ `defect_status_transition`
  （`(project_id,from_key,to_key)` 唯一）。**迁移不 INSERT**——空表 = `models.py`
  的默认图（`DEFAULT_FLOW`），首次保存才落整份快照，`reset` 删行即回默认。
  `models.py` 老 docstring 里那个「存量项目的行谁来插」的问题就此消掉。
- **三枚 `@service`**（`app/modules/defect/flow.py` + `services.py`）：
  `GET /defect-statuses`（`defect:defect:read`，返回生效图 + `customized`）、
  `POST /defect-statuses`（`defect:flow:manage`，整份替换）、
  `POST /defect-statuses/reset`（同写位，回默认图）。
- **校验（422 `invalid_flow`）**：key 为 `^[a-z][a-z0-9_]{0,31}$`、不重名、≤20 个；
  name 1..32；**恰好一个起始态**；边两端必须存在、不自环、重复边去重、≤200 条。
  坏请求整份不落（先校验、后删除、同事务写入）。
- **引用护栏（409 `status_in_use`）**：删状态与 reset 前都先查本项目缺陷
  （**含回收站**）是否还挂着被移除的 key；有就把 `{key: count}` 摊给前端，
  绝不留悬空状态——这正是 MS 缺的那一步。
- **执行侧接线**：新建缺陷落 `flow.start_key`；改状态按 `flow.allows(old,new)`
  校验（非法转移 409 带 `allowed` 列表；未知状态 422 `invalid_status`）。
  `DefectListIn.status` 的 pattern 从「写死五态」放宽成 slug，列表可按自定义 key 过滤
  （存在性仍由库和写路径把关）。
- **前端**：新增 `settings/DefectFlowTab.tsx`（设置页「缺陷状态」Tab，按
  `defect:flow:manage` 渲染）：状态/名称/起始/终态/可流转到以矩阵式表格编辑，
  添加/删除、恢复默认（Popconfirm）、`自定义`/`内置默认` 标签、错误原话上屏；
  `api/defect.ts` 增 `defectFlowApi` + `flowLabel`/`flowAllowed`/`isDefectFlow`
  （形状守卫，假接口/网关错误页不会被塞进 state 炸渲染）；缺陷列表与详情的状态名、
  快捷筛选、详情改状态下拉都改读生效图，**拉不到图静默回落内置五态**。
- **测试**：
  - `tests/test_d267_defect_flow.py` **5 passed**：两张表形状与唯一键；默认图
    （5 态 / 9 边 / customized=false）→ 自定义图后新建落起始态、非法转移 409、
    未知状态 422、按自定义 key 过滤；删在用状态与 reset 都 409 且图不变；
    reset 回默认；四类非法图 422 且整份不落；权限门（MEMBER 写/重置 403、
    READONLY 读 200）。
  - 回归：`test_d187`（迁移链守卫的链头从 0044 修到 0048——它自 0045 起就是红的，
    这刀把它扶正）、`test_d191`、`test_d207`、`test_d216`、`test_d230`
    **40 passed**；`test_skill.py` 7 passed。
  - 前端：`DefectFlowTab.test.tsx` **5 passed**（默认图、改名保存整份载荷、
    添加状态且起始唯一、保存失败原话上屏、reset）；`defects.test.tsx` 10 +
    `settings.test.tsx` 12（Tab 集合 11 枚，含「缺陷状态」）同批绿。
- **门禁（本轮实测）**：后端 ruff `app`+`tests` 0；mypy `defect` **5 files 0**；
  lint-imports **4 kept / 0 broken**（263 文件 / 1322 依赖）；`alembic heads` = `0048`；
  前端 `tsc --noEmit` 0、eslint 0。
- **顺带校正**：README 里 `adb_case`「仍按 1D 报错」的陈旧句（1D T8 起早已有执行器）
  与三期表行错位已修；`defects.tsx` 顶部「没有 num 短编号」的旧注释改成 D192 后的真实形态。
- **剩余（C 档真缺口）**：C11 用例脑图（下一刀 D268）、C14 组织级用户组/三级组织、
  C9 的组织级状态流。**勘误**：C9 原表里「功能用例状态流」不算缺口——MS v3 的
  `functional_case` DDL 没有业务状态列（`V3.0.0_10__functional_case.sql` 只有
  `status`=normal/trash 这种视图位），「用例状态」是 `TestCaseTemplateService`
  返回的**模板自定义字段**；本仓 D192 起就有模板自定义字段与选项，能力已在。

## 85. 第 78 刀交付：用例脑图（D268，2026-11-24）

补齐 C 档的 C11。MS 的脑图由 `FunctionalCaseMinderController`（v3，6 端点）+
`minder_extra_node`（空白节点）组成；本刀照「行为」补，不照搬它的批量事务契约。

- **新表（迁移 `0049`）**：`functional_minder_note`（`project_id`、`parent_id`、
  `name`、`sort`、`created_by` + 时间戳）。**用例/模块表一列没动**——脑图是既有
  数据的另一个视图，不是新的一套用例存储。
- **边界与 MS 一致**：用例只挂模块（`functional_case.module_id`），便签（MS 的
  「空白节点」）只承载文字、不承载用例；模块仍只能挂模块（模块写路径不认便签父）。
- **四枚 `@service`**：`GET /functional-minder`（`functional:case:read`）、
  `POST /functional-minder/notes`（创建，201）、
  `PATCH /functional-minder/notes/{id}`（改名/移动）、
  `POST /functional-minder/notes/{id}/delete`（`effect=destructive`）。
  写位统一用 `functional:case:update`——**不学 MS 的 `FUNCTIONAL_CASE_READ_MINDER`
  （用 read 位改数据）**。
- **护栏**：父节点必须存在且为正常模块/便签（404）；便签不能移到自己的子树
  （422 `cycle`）；删便签连子便签一起删，但下面还有模块 → 409 `note_not_empty`
  （不静默丢模块）；便签上限 500（422 `too_many_notes`）。
- **脏数据不吞节点**：树构建 DFS 带 `visited`，父链断裂/成环时把未访问节点补到
  根层，环上节点各画一次、不死循环（测试用 SQL 造了一个 模块↔便签 互相为父的环）。
- **前端**：`web/src/api/CaseMindmap.tsx` + 功能用例页「脑图」抽屉。
  树 = 模块（带用例数 Tag）/ 便签（`✎` 前缀）/ 用例叶（`#num + 名称 + 优先级`），
  未分类用例单独一组；可拖拽移动（用例→模块/根、模块→模块/根、便签→模块/便签/根，
  非法落点当场 warning 不发请求）、菜单改名/新建子模块/新建子便签/放入回收站/删除便签、
  点用例叶跳详情。写操作一步一请求，失败即停（不做「批量保存」的假事务）。
  树异步到达，展开键受控（`defaultExpandAll` 对晚到数据不生效，踩过）。
- **测试**：后端 `tests/test_d268_functional_minder.py` **6 passed**（树形状/回收站
  排除；便签改名/移根/级联删；404/422 环/409 有模块/回收站模块不能当父；跨项目
  隔离；正常用例指向回收站模块时归「未分类」不消失；READONLY 读 200 + 写 403
  `functional:case:update` + 非成员 403）。
  前端 `api/CaseMindmap.test.tsx` **8 passed** + `pages/functionalCases.test.tsx`
  **25 passed**（+1：点「脑图」才发请求、带 `project_id`、画出用例叶）；
  **web 全量 132 files / 2132 passed**（2123 + 本刀 9）。
  迁移链守卫（`test_d187_defect_models.py`）同步接棒到 `0049`。
- **门禁**：ruff 0；`mypy app/modules/functional` 仅剩 3 条 `openpyxl` 缺 stub
  的**存量**报错（`exchange.py`，本刀未触碰）；`lint-imports` 4 kept / 0 broken；
  `alembic heads` = `0049`；前端 `tsc` 0、`eslint` 0（改动文件）。
- **剩余（C 档）**：C14 组织级用户组/三级组织、C9 组织级状态流；C11 已清。

## 86. 第 79 刀交付：组织层基础面（D269，2026-11-24）

- **口径先说清**：设计文档 §4.1 写的是「单租户自托管，org/workspace 仅三期预留」，
  而全量复刻口径（本文 §0）要求把 C 档 C14 纳入。两者不冲突的落法：**组织只做管理与
  分组层，不做租户隔离**——`perms_for_user` 一行不改，项目数据可见性仍只由
  `project_member` 决定；组织成员能看到本组织名下的项目清单，但打不开项目数据
  （测试钉了 `GET /projects/{id}` 仍是 403）。
- **表（迁移 0050）**：`org` 补 `description` / `status`；新表 `org_member`
  （`unique(org_id,user_id)`，`role_code ∈ {ORG_ADMIN, ORG_MEMBER}`）；
  `project.organization_id`（可空 + 索引）。升级时建 `code='default'` 的「默认组织」
  并把存量项目回填过去；downgrade 只脱 schema、保留这一行数据（删掉会让降级再升级
  丢组织归属）。
- **12 枚 `@service`**（全部 `tool=False`）：`org_list` / `org_get` / `org_create` /
  `org_update` / `org_delete` / `org_member_list` / `org_member_set` /
  `org_member_remove` / `org_project_list` / `org_project_assign` /
  `org_project_unassign` / `org_mine`。读接口也用 POST：GET 投影只认静态位，
  而授权必须按「是否为该组织成员/管理员」在体内定（`dynamic_perm=True`）。
- **授权矩阵**：创建/删除组织仅系统管理员；`ORG_ADMIN` 管本组织成员与项目归属、
  可改本组织资料；`ORG_MEMBER` 只读组织/项目清单；非成员的组织详情统一 403
  （与项目侧同形，不泄露存在性）。`org_mine` 走 `auth:self`，普通用户能看自己在哪个组织。
- **护栏**：组织代码/名称唯一（409）；默认组织不可删（409 `default_org`）；
  有项目的组织不可删（409 `org_not_empty`，先移出）；最后一名组织管理员不可降级/
  不可移出（409 `last_org_admin`）；组织成员角色非法在 schema 层 422。
- **项目创建**：`ProjectIn.organization_id` 可选；未传 → 默认组织（不存在则留空）；
  传了 → 组织必须存在（404），非系统管理员还必须是该组织成员（403）。
  归档/移出**不**改项目成员与数据权限。
- **前端**：系统设置新增「组织」Tab（仅系统管理员，跟平台用户/审计同 `isSysAdmin` 闸）：
  组织表 + 新建/编辑/删除 + 「成员」抽屉（按账号添加/调整角色、移出）+「项目」抽屉
  （选项目归档、移出）。
- **测试**：后端 `tests/test_d269_org.py` **5 passed**；`test_d269 + test_d187`
  **19 passed**（迁移链守卫接棒 `0050`）；`test_registry` **10 passed**；
  `test_d110 + test_role_services + test_adb/schedule/ui_models` **35 passed**。
  前端 `settings/OrgTab.test.tsx` **4 passed**；`OrgTab + settings + CaseMindmap +
  functionalCases` **49 passed**；`tsc` 0、`eslint` 0（改动文件）。
- **顺手补的存量债（本轮跑门禁才浮出来）**：
  1. `test_perm_prefix_coverage` 红——D265/D266 的 `mcp:server:*` / `skill:manage` 从未进
     `KNOWN_PREFIX_FAMILIES` 与矩阵。已补两族 + 两行平台读（列表 2xx / 其余角色 403），
     定向重跑 **9 passed**。
  2. 四条迁移链头守卫（`test_adb_models` / `test_schedule_models` / `test_ui_models` /
     `test_role_services`）仍钉在 `0044`，自 D262 起就是红的；`check_migration_down.py`
     的 `EXPECT` 也只登记到 `0044`。已补 `0045–0050` 的父链、链头改 `0050`，
     并把 0045–0050 的新表（`scenario_revision` / `mcp_server` / `skill` /
     `defect_status*` / `functional_minder_note` / `org_member`）登记进 `EXPECT`。
  3. `test_d110` 写形状只读位哨兵把 `functional_case_stats`（D236）与新组织读接口
     一起报出来；逐条核对函数体后按既有纪律登记理由（只读 select/聚合，授权在体内判定）。
- **门禁**：ruff 0；`mypy app/modules/iam` 0；`lint-imports` 4 kept / 0 broken；
  `alembic heads` = `0050`。
- **剩余（C 档）**：C14 的组织级用户组（一个组织多组 × 每组权限集）与三级组织树；
  C9 组织级状态流模板（项目级已由 D267 交付）。前端「组织」入口目前只挂在系统设置的
  系统管理员闸下（`ORG_ADMIN` 的独立组织页待做，本轮接口已按组织角色放行）。C13 License 按 §4 主动排除。

测试环境教训：并发起两路 pytest 会互抢 192.168.1.5 的 MySQL（`WinError 52`），
DB 相关测试必须单路跑；`permission_matrix` 全量约 17 分钟，`-k` 定向只跑 31 秒。

## 87. 第 80 刀交付：组织级用户组 + 组织管理员入口（D270，2026-11-24）

- **补的是什么**：C14 剩下的「组织级用户角色/用户组」。MS 里 `OrganizationUserRole` 是
  「一组 = 一份组织级权限集」；本仓落成 `org_user_group`（组）+ `org_user_group_member`
  （组员）。口径仍是 D269 的单租户：组**只**细化「谁能在组织层做什么」，不参与
  `perms_for_user`，组员对项目数据零增量（测试钉了 `GET /projects` 仍为空）。
- **四枚管理位**（`iam.models.ORG_GROUP_PERMS`，schema 侧 `OrgCap` 用 Literal 逐字镜像，
  测试 `test_schema_caps_match_model_constants` 钉住两处不漂）：
  `system:org:update`（改资料）/ `system:org:member:manage`（管成员）/
  `system:org:project:manage`（管项目归属）/ `system:org:group:manage`（管组）。
  `ORG_ADMIN` 与系统管理员天然全量，普通成员取所在组并集。
- **表（迁移 0051）**：`org_user_group`（`unique(org_id,name)`，`perms` JSON，
  `created_by`）+ `org_user_group_member`（`unique(group_id,user_id)`）。
  `check_migration_down.py` 的 `EXPECT` 与五条链头守卫同步到 0051。
- **7 枚新 `@service`**（全部 `tool=False`、`dynamic_perm=True`）：`org_group_list` /
  `org_group_create` / `org_group_update` / `org_group_delete` /
  `org_group_member_list` / `org_group_member_set` / `org_group_member_remove`。
  旧的 `_require_admin` 改名为 `_require_cap(org_id, cap)`：系统管理员或 ORG_ADMIN 直接放行，
  其余成员查组并集；`org_member_list/set/remove`、`org_project_assign/unassign`、
  `org_update` 全部改走对应管理位（组员因此可被委派其中任意一项）。
- **`my_perms` 投影**：`org_list` / `org_get` / `org_update` / `org_create` 逐行返回
  「我在本组织实际持有的管理位」——前端只看它显隐按钮，服务端每个请求仍复核。
  列表场景用一次 `_my_group_caps` 聚合查询，不按组织 N+1。
- **护栏（这刀新加的三条，都是越权面）**：
  1. 组委派的 `member:manage` **不能授予/移出 ORG_ADMIN**——否则一条组权限就能换到
     全量组织位（403）；
  2. 非系统管理员不能把「属于其他组织」的项目归档进本组织（409
     `project_in_other_org`）：组织之间的项目转移只有平台管理员能做；
  3. 移出组织成员时**同时清掉他在本组织各组里的关系**（组不是第二套成员制）；
     删组织时组与组员行级联清。
  其余沿用 D269：组名组织内唯一（409）、非法管理位 422（schema Literal）、
  非组织成员不能进组（409 `not_org_member`）、账号不存在 404。
- **前端**：
  1. 组织独立成 `/orgs` 页（`pages/orgs.tsx` + 侧栏「组织」入口，不套 ProjectGate）。
     上一刀的「组织」只挂在系统设置 Tab、且按 `isSysAdmin` 门禁——组织管理员根本进不去，
     接口放行了界面却是死路；本刀把 Tab 从设置页摘掉（12 → 11 枚），统一到 `/orgs`。
  2. `OrgTab` 不再看 `my_role`，改看 `my_perms`：`成员`/`编辑`/`用户组`/`项目抽屉的
     归档与移出`各自对应四枚管理位；`新建/删除组织`仍只给系统管理员。
  3. 新组件 `settings/OrgGroupDrawer.tsx`：组列表（管理位标签、组员数）、新建/编辑
     （名称 + 说明 + 管理位勾选）、删除、组员抽屉（按账号加入 / 移出）。
- **测试**：后端 `test_d270_org_groups.py` **5 passed**（授权委派、越权三护栏、
  组生命周期与级联、非成员不可见）；`d270 + d269 + d110 + registry + r157` **28 passed**；
  迁移链头 5 条守卫 + `check_migration_down` 实测 up→down→up 全绿（含 0051）。
  前端 `OrgGroupDrawer.test.tsx` **5 passed**、`OrgTab` 7 passed、`settings/shell` 同跑
  **45 passed**；web 全量 **134 files / 2144 passed**（第一次全量曾有一条 D268 脑图用例在
  并行负载下超时，单跑与复跑均绿，记作 flake）。`tsc` 0、`eslint` 0（改动文件）。
- **全量后端**：`pytest -q` **2034 passed / 4 failed / 1 error / 59:57**——5 条失败全是
  `WinError 52 / 10048`（MySQL 连接被环境掐断）与随之的 run 未进终态；把这 5 个用例
  单独重跑 **9 passed**，判定为环境 flake，非本轮回归。`permission_matrix` 单独重跑
  **315 passed**（17:04，中途同样出现过一次连接错误，重跑全绿）。
- **门禁**：ruff 0；`mypy app/modules/iam` 0；`lint-imports` 4 kept / 0 broken；
  `alembic heads` = `0051`。
- **剩余（C 档）**：只差 C9 组织级状态流模板（项目级已由 D267 交付）。
  C13 License 按 §4 主动排除；三级组织树按设计文档 §4.1 仍属三期，未在本轮范围内。

## 88. 第 81 刀交付：组织级缺陷状态流模板（D271，2026-11-24）

- **口径**：对齐 MS 的 `OrganizationStatusFlowSetting`，把 D267 的项目级状态图扩成三层优先级：
  **项目自定义行 > 所属组织模板行 > 内置默认图**。组织模板**不复制**到项目——改模板对
  「未自定义状态流」的项目立即生效；两表为空 = 本层没建模板，继续往下一层回落，
  迁移仍不 INSERT（全仓纪律）。
- **模块独立性**：缺陷模块不 import iam。项目 → 组织的映射走一条只读 SQL
  （`SELECT organization_id FROM project WHERE id=:p`，先例是 schedule 读 scenario/environment）；
  iam 的 `org_delete` 反向用 raw SQL 清两张模板表（无外键，级联在应用层同事务兑现）。
- **跨模块授权**：新增 iam 的 `org_cap_check`（POST `/system/orgs/cap-check`，`dynamic_perm`），
  判定「系统管理员 / ORG_ADMIN / 持某组织管理位的组员」。缺陷模块三个新服务经
  `REGISTRY.get("org_cap_check")` 调它，cap = `system:org:defect:manage`。
- **三枚新 `@service`**（`tool=False`）：`defect_org_flow_get`（POST `/system/orgs/defect-flow/get`，
  read 位 + `dynamic_perm`，进 D110 白名单并写明零副作用理由）、`defect_org_flow_save`
  （POST `/system/orgs/defect-flow/save`）、`defect_org_flow_reset`
  （POST `/system/orgs/defect-flow/reset`），后两枚声明 `system:org:update` 以如实表达写语义。
- **护栏**：
  1. 组织模板删状态前检查**所有继承该模板的项目**（本组织内、无 `defect_status` 行）里
     还有没有缺陷挂着被删 key → 409 `status_in_use`，`details.in_use` 按项目列出，整份不落；
  2. 项目重置的悬空检查按**实际回落图**做（有组织模板就按模板 key，而不是永远按内置默认）——
     否则「组织模板里也有 doing」会被误判成悬空；
  3. 删除组织时同事务清 `org_defect_status` / `org_defect_status_transition`。
- **前端**：
  1. `api/defect.ts` 抽出 `DefectFlowView`（项目/组织共用形状）+ `source`（project/org/default），
     新增 `defectOrgFlowApi` 与 `isOrgDefectFlow`；
  2. `DefectFlowTab` 支持 `orgId` 模式：读/存/重置走组织端点，文案改为「组织缺陷状态流模板」
     与「删除模板」，并提示「只影响未自定义状态流的项目」；项目侧标签区分
     「继承组织模板 / 内置默认」；
  3. `OrgTab` 第五枚管理位 `system:org:defect:manage` 控制「状态流」按钮，抽屉里渲染
     `DefectFlowTab orgId=...`；`ORG_CAP_OPTIONS` 同步第五项「管缺陷状态流」。
- **测试**：后端 `test_d271_org_defect_flow.py` **6 passed**（迁移形状、组委派/ORG_ADMIN/
  非成员授权、项目继承/项目覆盖/重置回落、组织模板悬空 409、删组织清模板）；
  与 D267/D270/D110 同跑 **21 passed**；五条迁移链头守卫 + `check_migration_down` 实测
  up→down→up 全绿（含 0052）。前端 `DefectFlowTab` 6 passed、`OrgTab` 9 passed、
  `OrgGroupDrawer` 5、`settings` 12，同跑 **32 passed**；`tsc` 0、`eslint` 0（改动文件）。
- **门禁**：ruff 0；`mypy app/modules/defect app/modules/iam` 0；
  `lint-imports` 4 kept / 0 broken；`alembic heads` = `0052`。
- **剩余（C 档）**：C9 至此项目级 + 组织级全部交付，C 档无未交付项。
  C13 License 按 §4 主动排除；三级组织树按设计文档 §4.1 仍属三期，未在本轮范围内。

## 89. 第 82 刀交付：工作台卡片设置（D272，2026-11-24）

- **来源**：审计 §2.1 的 `workbench.tsx` 行——MS 是 `homePage/components/cardSettingDrawer`
  可增删卡片的仪表盘；我们 D227/D238 已交统计/趋势/待办/关注，差的只剩「卡片可自定义」。
  本轮把它补齐（个人视图与待办流此前已交付，不再重复）。
- **口径**：卡片设置是**本机视图偏好**，不进库、不跨设备（MS 这一层也是前端偏好）。
  五个可配组：统计卡与趋势 / 最近执行与我最近编辑 / 我的待办 / 我的关注与创建 / 快捷入口。
- **实现**（`web/src/pages/workbench.tsx`）：
  1. `loadCardPrefs` / `saveCardPrefs` 读写 `localStorage["tp_workbench_cards"]`，存
     `[{key, visible}]` 的**有序**数组（顺序与显隐一个键，避免两份状态打架）；
  2. 读侧三重降级：坏 JSON → 默认全显示；未知/重复 key → 跳过；后续版本新增的 key →
     自动补在末尾且默认可见。隐私模式禁用存储时 `setItem` 静默失败，不影响页面；
  3. 显隐用外层容器的 `display:none` + `order`，**不卸载卡片**——隐藏不改变取数，
     重开抽屉不会二次闪烁；顺序用 `order` 表达，视觉顺序即用户设定；
  4. 「卡片设置」抽屉：Checkbox 显隐 + 上下移序（首/末项按钮禁用），文案声明「只保存在
     本机浏览器」。
- **测试**（`web/src/pages/workbench.test.tsx`，25 passed，+3）：
  ① 取消勾选快捷入口 → 容器 display=none 且 localStorage 落 `visible:false`；
  ② 连点两次上移把「我的待办」提到首位 → 持久化顺序正确，卸载重渲染（模拟刷新）后
     `order` 仍是 todos < stats；
  ③ 坏 JSON 不白屏，退回默认全显示。
  `beforeEach` 补 `localStorage.clear()`，用例之间不串偏好。
- **门禁**：`tsc --noEmit` 0；`eslint`（两个改动文件）0；工作台 25 passed；
  全量前端 **134 files / 2150 passed**（59.9s）。
- **文档**：README 批次表加 D272；审计 `workbench.tsx` 行改为「卡片可自定义由 D272 交付」，
  并把 `datasets.tsx` 行从「差距未裁」裁定为「独立管理面已交付，场景级多 CSV 属数据模型差异」。
