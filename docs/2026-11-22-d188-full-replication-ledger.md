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
