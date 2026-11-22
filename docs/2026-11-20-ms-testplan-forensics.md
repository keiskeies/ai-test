# MeterSphere 测试计划 + 计划报告 取证结论（2026-11-20）

取证对象：`D:\item\metersphere\backend`（v3 开源主干）。所有 `路径:行号` 均相对 `D:\item\metersphere\backend\`。
本文只用中文描述语义与结构，不复制任何 MS 源码/建表语句/字段清单。标注「推测」的条目未获代码直接证实，做架构决定时区别对待。
**边界说明（免生歧义）**：文中出现的 MS 表名/类名（含 §4 为核对张数而列的那串表名）是**指路用的引用**，
与本仓既有取证文档同口径；GPLv3 的约束落在**我们的实现**上——我们的表名、类名、目录约定一律不许照抄
MS，落码时另起一套命名并走 §5 评审。

---

## 1. 测试计划的生命周期

**持久化的计划状态只有两个值：未归档 / 已归档。**
- 创建时写入「未归档」：`services/test-plan/.../service/TestPlanService.java:208`。
- 归档写入「已归档」：`TestPlanService.java:465,491`（单计划）与 `:540-550`（计划组连坐归档）。归档前置条件：计划必须已「完成」（实时算出来的，见下），组内全部子计划完成才能归档组；归档同时删除该计划的定时任务（`:462,470`）。
- **没有反归档路径**：全仓再无任何把状态写回「未归档」的调用（读实现体确认）。归档后禁止执行（`TestPlanExecuteService.java:244` 直接抛错）、批量操作全部跳过归档件（ARCHIVED 的守卫散落 7 个 service，26 处）。
- DDL 注释里写的四态（未开始/进行中/已完成/已归档）与实际存的值不一致（`framework/domain/src/main/resources/migration/3.0.0/ddl/V3.0.0_3__test_plan.sql:34` 对比实际写入值）。

**列表页上的「未开始/进行中/已完成」是查询时现算的，不落库。**
- 算法：把计划下全部关联用例的「最近一次执行结果」映射成 COMPLETED（成功/失败/误报/阻塞都算已执行）或 PENDING；全部 COMPLETED→已完成，全部 PENDING→未开始，混合→进行中。读实现体确认：`TestPlanBaseUtilsService.java:80-121`，调用方 `TestPlanStatisticsService.java:100-179`。
- 另有「通过/未通过」两个展示态：通过率 ≥ 计划配置的通过阈值才算通过（`TestPlanConstants.java:27-29` 及各处比较）。
- `plan/enums/TestPlanStatus.java` 这个枚举（PENDING/RUNNING/STOPPED/COMPLETED/SUCCESS/ERROR/PREPARED/UNDERWAY）**基本是死代码**：全仓唯一的生产引用只在通知服务里拿它做 i18n 翻译（读实现体确认）。执行状态实际存在**报告**行上，不在计划行上。
- 报告有两条正交状态轴：执行状态（待执行/执行中/已停止/已完成）+ 结果状态（成功/失败）。见 `TestPlanReport.java` 对应 DDL（`V3.0.0_12__beta_ddl.sql:78-79`）与 `postHandleReport`（`TestPlanReportService.java:722-755`）。

**实际开始/结束时间：** 首次执行任意用例时回填实际开始时间（并级联回填父组）：`TestPlanService.java:837-846`，调用点散布在用例执行入口（如 `TestPlanApiCaseService.java:762,811`）。**实际结束时间没有任何写入方**（见第 6 节第 1 条）。

**有没有「计划基线/快照」层：没有。**
- 关联表只存指向用例本体的外键 + 执行态摘要，**不存用例内容副本、不存用例版本号**（`V3.0.0_3__test_plan.sql:71-135`；关联查询永远 join 用例表且默认强制 `latest=1`，版本只作为筛选项：`ExtTestPlanApiCaseMapper.xml:195-207`）。
- 所以：计划建立后用例被改动，计划列表/执行永远用**最新**用例；改动不追溯。
- 快照只发生在**生成报告**那一刻：把用例当时的名称/模块/等级/最近结果/缺陷数抄进报告明细表（`TestPlanReportService.java:467-683`）。报告生成之后，用例行怎么改、再执行多少次，已生成的报告**数字与明细都不动**（`getReport` 只读报告自己的 summary 大字段和明细表：`TestPlanReportService.java:773-822`；全文没有任何「重算旧报告」的路径）。
- 推论（推测，基于上述代码事实）：对 `run_record` 通用 subject 设计而言，MS 等价物 = 「subject 关联不冻结版本 + 报告是一次性的聚合副本」。

**其他生命周期动作：** 创建时自动建默认测试集（`TestPlanService.java:166-173,169`）；删除是物理删（`deleteByPrimaryKey`，`TestPlanService.java:244`）并级联删关联/执行历史/报告（`cascadeDeleteTestPlanIds`）；复制计划生成新计划（关联复制、清空实际起止时间：`TestPlanBatchOperationService.java:198-199`）。定时任务到期 = 以「定时触发」模式走单次执行通道（`plan/job/TestPlanScheduleJob.java:21-34`）。

---

## 2. 计划 × 用例的关联关系存了什么

**每种用例类型一张关联表**（功能 / 接口用例 / 场景），共同形状（读实现体确认）：
有一个存「指向用例」的字段、一个存「所属计划」的字段、一个存「所属测试集(collection)」的字段、排序 pos、创建人/时间；再挂执行结论四件套：**最近一次执行结果、执行人、最近执行时间**，接口/场景另有**最近一次执行报告 id**；接口/场景还挂**执行环境（或环境组）**字段（`V3.0.0_3__test_plan.sql:92-135` + `3.0.1/ddl/V3.0.1_2__ga_ddl.sql:68-84`）。**没有备注、没有轮次字段**——备注/评论不在关联上（三张关联表 DDL 读全确认，无 round/batch 之类的列，「第几轮」这个概念在 MS 表结构里不存在）。
**环境挂在关联行上、且执行读的是关联行那一份**：建关联时从用例抄一份环境进去，执行时用的是关联行上的环境而不是用例上当前的环境（`TestPlanApiCaseService.java:718`，读实现体确认）。这条决定了「同一用例挂在两个计划里可以用不同环境跑」，复刻时若把环境留在用例上就丢了这个能力。

**同一条用例能否在同一计划跑多次：能，两层含义都要回答：**

a) **重复关联**：由计划配置里的「允许重复添加用例」开关控制（`V3.0.0_3__test_plan.sql:64`；消费点 `TestPlanConfigService.java:30-32`）。关掉时，关联查询用 not-exists 排除已在计划里的用例（`ExtTestPlanApiCaseMapper.xml:98-100`），允许时同一用例可再插一行新关联（各自独立的执行态）。
   - 坑：即便开关打开，**同一次批量关联调用内部**仍会按用例 id 去重，一批里同一用例只插一条（`TestPlanApiCaseService.java:601-609` 读实现体确认）；跨两次调用才能重复。

b) **同一条关联反复执行、历史怎么留**：
   - **功能用例**：每次人工执行往独立的「计划用例执行历史表」插一行（状态 + 评论 + 步骤执行结果 JSON + 通知人 + 操作人时间），同时把关联行的「最近结果/最近时间」更新为本次值。`TestPlanFunctionalCaseService.java:499-500,509-511,557-572`；批量执行同样逐行插历史 `:606-623`。取消关联时关联行物理删、历史行**打软删标记保留**（`TestPlanFunctionalCaseService.java:228-231` + `ExtTestPlanCaseExecuteHistoryMapper.xml` 的 updateDeleted）。
   - **接口/场景用例**：历史 = 每次执行新生成的执行报告（接口报告/场景报告行带着「计划关联行 id」外键，`TestPlanApiCaseService.java:846`；计划页的「用例通过率」筛选就是按这个外键聚合历次执行报告算的，`ExtTestPlanApiCaseMapper.xml:599-626`）。**不写功能用例那张执行历史表**。关联行只保留「最近一次」摘要——但注意：接口/场景的「最近一次」字段在开源代码里没有任何写入方（见第 6 节第 2 条）。
   - 报告能否回溯：报告明细行里只有**快照字段 + 一个指针**——功能用例指向生成时「最近一条执行历史」的 id，报告里点进去看那一次执行（`TestPlanReportService.java:507-528`）；接口的指针字段在开源代码里永远为空（见第 6 节）。也就是说**报告不能回溯整个执行序列，只能回溯生成时被选中的那一次**。
   - 历史查询按「关联行 id + 用例 id + 未软删」过滤、时间倒序（`TestPlanFunctionalCaseService.java:720-723`）。这条软删口径的意义在报告侧：**删了关联，证据链不断**——报告要能自证当时的结论。

**「测试集」（test_plan_collection）**：计划内再分一层的执行组织树（类型=功能/接口/场景），挂环境或环境组、资源池、执行方式（串行/并行）、失败重试次数与间隔、失败停止、排序（`3.0.1/ddl/V3.0.1_2__ga_ddl.sql:88-108`）。执行编排（组/计划/用例类型/测试集 四级 Redis 队列）全部围绕它展开（`TestPlanExecuteService.java` 的四个 queue 前缀；队列实体只存在于 Redis，`TestPlanExecuteSupportService.java:95-146`）。

---

## 3. 计划报告怎么聚合出来

**两种生成方式，同一套管线**（`TestPlanReportService.java:286-407`）：
- 手动生成：拍当前快照（含用例最近结果），可带自定义布局组件与富文本总结。
- 执行生成：执行前预生成报告行，执行完成后汇总（`summaryTestPlanReport`，`TestPlanExecuteSupportService.java:59-94`）。
- 计划组执行时：一组 = 1 条组报告（integrated）+ 每子计划 1 条独立报告（parent_id 指向组报告，`3.0.1:221-224`）；组报告不存用例明细，汇总时数字从子报告的 summary 相加、缺陷按 bug id 去重（`summaryGroupReport`，`TestPlanReportService.java:1010-1073`）。

**数字来源**：三类报告明细表（报告-功能用例 / 报告-接口用例 / 报告-场景用例 / 报告-缺陷，各是生成时从关联表+用例表现抄的副本，`V3.0.0_12:115-160`、`3.0.1:177-219`）+ 每报告一行 summary（三类用例计数、缺陷数、计划数、四类 JSON 计数大字段：`3.0.1:51-59`）。汇总 = 对明细表按结果列 group by（`summaryPlanReport`，`TestPlanReportService.java:971-1003`）。

**口径（关键，逐条读实现体确认）**：
- 分母 = **生成时刻的关联用例条数**（三类之和，含未执行），不是执行次数。用例总数直接存 summary，详情接口单独返回（`TestPlanReportService.java:734-735,779`）。
- **通过率 = 成功数 ÷ 用例总数**（未执行拉低通过率！），执行率 = (总数−未执行) ÷ 总数。`TestPlanReportService.java:737-738`。
- 失败分类五档：成功 / 失败 / 误报 / 阻塞 / 未执行（`plan/dto/CaseCount.java`）；未执行与空结果在 SQL 层统一归入 PENDING（如 `ExtTestPlanReportApiCaseMapper.xml:5`）。被停止的执行里未跑的明细行标 STOPPED（`TestPlanExecuteSupportService.java:165-186`）。
- 报告结果状态：独立报告 = 通过率 ≥ 通过阈值 ? 成功 : 失败；组报告 = 子报告全成功才成功（`postHandleReport`，`TestPlanReportService.java:739-747`）。阈值在生成时从计划配置抄进报告（`:432`），此后独立演化。
- 「报告 = 一次快照，之后用例再变报告不动」：**成立**。明细是副本；summary 只在生成/汇总/停止那一刻写；读取路径无任何重算（`getReport` `:773-822`）。唯一的例外是「按任务查实时进度」接口故意绕开汇总、直读报告明细表现算完成率（`calcTaskExecActual`，`:1469-1486`）——执行中看实时、执行完定格。
- 重跑：同一报告行重置为执行中、清空结束时间，明细结果覆盖式更新（`resetRerunReport`，`ExtTestPlanReportMapper.xml:561-565`）——**报告不是每轮执行一份，执行历史另在任务中心/执行报告层**。

---

## 4. 模块切分（功能面）

**端点实数 143，与业主口径一致**（13 个 controller 的 mapping 注解计数合计）。
**表：建过 19 张、GA 时删掉 1 张，活着的 18 张——不是业主口径的 20 张**（这条由主会话独立复核三遍：
`grep -rhoiE "create table[^(]*" --include=*.sql` 全仓数得 19，且**跨 backend/ 之外也是 19**；
`test_plan_id` 是 `bug_relation_case` 的列名与 `api_scenario_report` 的列名，不是表名——**差点被
`create table[^;]{0,40}?test_plan[a-z0-9_]*` 这种宽松正则数成第 20 张，教训是数表名必须锚定
`create table` 到第一个左括号之间的内容**）。19 张建表 = 计划本体 / 计划模块 / 计划配置 / 关注人 /
三类关联 / 执行历史 / 测试集 / 执行队列 / 分配（allocation）/ 报告 / 报告汇总 / 三类报告明细 /
报告缺陷 / 报告附件 / 报告布局组件；其中 **allocation 在 3.0.1 被 `DROP TABLE`**
（`3.0.0/ddl/V3.0.0_12__beta_ddl.sql:32` 建、`3.0.1/ddl/V3.0.1_2__ga_ddl.sql:47` 删，实测）。
第 20 张最可能是把通用 `share_info`（分享链接存 sdk 通用表，靠类型值区分计划报告）或
`bug_relation_case`（缺陷-用例关联表上挂了计划两列，`V3.0.0_7__bug_management.sql:104-114`）算进来了。

功能面分组（143 端点的归属）：
1. **计划本体 CRUD + 归档/复制/排序/关注人/定时任务配置**（24，TestPlanController）——CRUD 为主，夹杂实时统计聚合读。
2. **计划模块树 CRUD**（5，ModuleController）。
3. **候选用例选取页**（5，AssociateController）——纯聚合读，全部是跨子系统分页（功能用例/接口/接口用例/场景 + 模块计数）。
4. **三类「关联管理 + 就地执行」× 3 组**（19+17+17）——关联 CRUD、批量移动/换测试集、批量执行人、关联缺陷、单条/批量执行、执行历史分页、脑图外的树操作；混合 CRUD 与执行触发。
5. **两个脑图编辑器**（4）：测试集树脑图（配置执行方式等）、功能用例脑图——聚合读 + 整树批量写。
6. **计划执行**（3，ExecuteController）：单计划执行 / 批量执行 / 执行人选项。停止执行挂在报告端点上。
7. **报告**（23，ReportController）：列表/重命名/删除/手动与自动生成的 CRUD，详情、用例明细分页（按类型）、缺陷分页、测试集/模块维度统计、布局编辑、总结编辑、导出、md 预览——聚合读为主。
8. **报告分享**（16，ReportShareController）：分享创建/更新/取消/校验 + 匿名侧的报告详情/明细/附件访问。
9. **任务中心（计划侧）**（9，TaskCenterController）：执行任务分页、详情、停止、任务-报告关联。聚合读。
10. **计划视角缺陷分页**（1，BugController）。
没有评审类端点、没有归档独立 controller（归档在本体里）。

---

## 5. 绑在 MS 其它子系统上的能力（我们一个都没有的那些）

**离开就不成立（结构性依赖，复刻时必须整块砍掉或自建）：**
1. **功能用例关联类型整体** —— 绑 `functional_case*`（case-management 模块）。列表/脑图/自动状态同步/缺陷数/优先级读取全部 join 功能用例表。我们无功能用例库 → 这条腿直接不做。
2. **功能用例的优先级字段** —— 绑模板/自定义字段体系：报告快照里的用例等级是从「功能用例-自定义字段-选项」四表 join 出来的（`ExtTestPlanReportFunctionalCaseMapper.xml:28-38`）。离开自定义字段体系不成立（接口/场景的等级是原生列，不受影响）。
3. **计划组（GROUP）** —— 双重绑定：a) 功能开关绑**商业 license**，无有效 license 时组服务直接返回 null（`TestPlanXPackFactory.java:29-35`，多处经它取组服务）；b) 组只是 test_plan 表里 type=GROUP 的自关联行。我们若不要商业位，可自行决定做不做组，但注意 MS 的开/关归档/统计都是组优先的，砍组要同步砍统计递归。
4. **缺陷维度（报告缺陷明细 + 用例缺陷数 + 计划缺陷分页）** —— 绑 `bug*` 与 `bug_relation_case`（计划关联行 id 存在缺陷关联表上，`3.0.0_7:104-105`）。离开缺陷管理不成立。
5. **报告附件与富文本图片** —— 绑文件库/对象存储（minio）的临时目录→资源目录转存管线（`TestPlanReportService.java:1130-1230`）。我们没有文件库；要附件先要有它。
6. **执行编排（四级队列 + 任务中心 + 报告-任务关联表）** —— 绑 api-test 执行引擎与 system-setting 的任务中心。MS 的报告数字本质上是「执行引擎回调 + 计划侧汇总」两段拼的；我们的对应物是 `run_record`/`run_step_result`，语义可映射，但别按 MS 的表形照抄。

**只是顺手带上的（可独立先做，不阻塞）：**
- 关注人（纯双列关系表）；通知（绑通知服务，我们有 notify，可后接）；分享链接（绑通用 share_info + 权限点，我们无分享链接则整组 16 端点后置）；标签、模块树（计划自己的模块树，独立）；定时执行（我们有 schedule 模块，可映射）；环境/环境组（我们有 env 模块，可映射；但「测试集上挂环境组+资源池+重试策略」这层是接口执行域带来的，第一版可以只留环境）。
- 报告布局组件（自定义仪表板式报告排版）：纯计划侧自有数据，可后置。
- 「自动把执行结果写成功能用例状态」开关：只在报告汇总前把接口/场景结果反推给功能用例关联（`TestPlanService.java:115-161`），没有功能用例就没有它。

---

## 6. MS 自己没做完的地方（读实现体实测，非命名推断）

1. **计划实际结束时间永远为空**。`ExtTestPlanMapper.xml:745-755` 有 setActualEndTime / clearActualEndTime 两条 update，但全仓 Java 侧没有任何 service 调用 setActualEndTime（copy 流程只往 null 清，`TestPlanBatchOperationService.java:198-199`）。读实现体确认。
2. **接口/场景关联行的执行结论三件套没有写入方**。`last_exec_result / last_exec_time / last_exec_report_id`：插入时写死 PENDING/0/null（`TestPlanApiCaseService.java:198-201,720`、`TestPlanApiScenarioService.java:186-189,288`），此后全仓（含 api-test、system-setting、case-management、dashboard 各模块 grep+读实现体）**无任何路径写入真实结果**；只有功能用例有真写入（人工执行 `TestPlanFunctionalCaseService.java:499-500` + 自动同步 `TestPlanService.java:146-159`）。证据链补全（第二个代理独立 grep 一遍的结果，两遍互证一致）：generated mapper 有全套 update 语句但非测试代码零调用方；`setLastExecReportId` 非测试代码只有置 null 的调用；两张关联表 Ext mapper 的自研 update 只有排序与执行人；api-test 模块不引用计划 mapper；计划级批量执行的回调服务（`PlanRunApiCaseExecuteCallbackService.java` 全文）只碰「报告×用例」表、不回写关联行。后果是实测语义：接口/场景用例的计划「最近结果」列恒为未执行，计划列表的现算状态（第 1 节）对纯接口计划永远停在未开始，统计 `countApiTestCaseExecResultMap` 全算 PENDING（`TestPlanStatisticsService.java:181-194`）。**但 UI 并没有满屏假 PENDING——列表/报告的实时数字是查询时 join api 报告表现算的**（Ext XML 里大量 `ifnull(last_exec_result,'PENDING')` + join 报告兜底，`ExtTestPlanReportApiCaseMapper.xml:17`），这三列更像没人维护的设计残留。**确信度：实锤「本仓库无写入方」；「企业版有补写」是推测**（xpack 不在本仓，无法证实）。对复刻的启示（推测）：别照抄「关联行上存最近结果」——存一列没人维护的数，就是给未来的自己埋一个说谎的列。
3. **执行生成的报告里，接口/场景明细行的执行结果同样无写入方**。执行生成时显式置 null（`TestPlanReportService.java:572-576,624-628`），此后唯一 update 是停止时把未跑的行标 STOPPED（`TestPlanExecuteSupportService.java:169-186`）。即纯按 OSS 代码走完整执行，汇总通过率恒为全未执行——单测却手工补写这些列来验证汇总逻辑（`TestPlanExecuteTests.java:349-384`），坐实了「设计上有写入方、开源仓里没有」。同上，推测在企业版补齐。复刻时这是必须自己补的环，不是可抄的环。
4. **`test_plan_allocation` 死表**：DDL 建了（`V3.0.0_12:32-41`），全仓零 domain 类、零 mapper、零引用（实测）。运行配置实际放在测试集/计划配置里。
5. **`test_plan_execution_queue` 死表**：建表了（`3.0.1:121-134`），但执行队列全部走 Redis（`TestPlanExecuteSupportService.java` 全文 stringRedisTemplate），零表读写（实测）。
6. **`test_plan_config.test_planning` 幽灵字段**：列 3.0.0 加、3.0.1 已删（`3.0.1:44`），实体类无此字段，但请求/响应 DTO 仍保留该字段、update 逻辑仍读它（只用于判空，`TestPlanService.java:414`）。API 收下来直接丢弃。
7. **`plan/enums/TestPlanStatus.java` 几乎全死**（仅通知 i18n 引用，见第 1 节）；DDL 注释与实际状态值漂移。
8. **允许重复关联在单批内不生效**（见第 2 节 a 条，`TestPlanApiCaseService.java:601-609`）——开关语义与实现不一致，属半实现。
9. 注释级半成品：接口用例 controller 的批量移动处标 TODO 但服务层实际已实现（`TestPlanApiCaseController.java:156`，陈旧注释）；缺陷侧「暂不支持缺陷关联测试集」两处 TODO（`TestPlanBugService.java:146,151`）；「计划组的删除暂时预留」处实际有实现（首版语义=删组时子计划提升），注释未清理（`TestPlanService.java:323`）。
10. 报告生成整体包在 try-catch 里吞异常只打日志、失败不抛（`TestPlanReportService.java:402-404`）——执行链路里报告生成失败会静默，坑。

**读不出来的**：xpack 目录不在本仓，第 2/3 条的「企业版写入方」仅能推测；功能用例脑图端点是否同时新建功能用例本体（前端组件存在，plan 模块内未见用例创建调用）——未读到确证，留白。
