# D190 逐帧对账 · 第 1 刀：bug-management（缺陷）两张差集表

> **方法**：总账 `2026-11-22-d188-full-replication-ledger.md` §6 —— 一个 controller 一刀，
> 每刀产**表 1 契约差集** + **表 2 字段差集**，先落对账文档、再开计划文件实做。
> **本刀范围** = MS `bug-management` 6 controller / **50 端点** + 缺陷域 7 张表。
>
> 四份取证的底稿在 `backend/.tmp/d190-framediff/`（gitignored，`.gitignore:20`）：
> `ms-endpoints.md`（50 端点逐条）、`ms-schema.md`（7 表逐列 + 增量迁移 + 状态图 seed）、
> `ms-ui.md`（前端逐帧：12 列 / 11 筛选项 / 表单 / 详情 5 Tab / 回收站）、
> `ours-survey.md`（我们侧形状与先例）。**本文只写结论与差集，不复述底稿。**
>
> 本文所有行号现读于 MS `f1565d99a0`（只读）与我们 `main`。三份代理报告我都抽查过承重断言，
> 改错记在 §6（含 1 条代理标「推断」但实为可证伪的默认排序）。

---

## 0. 三句结论（先看这个再往下看表）

1. **缺陷在我们是真零，不是"有表没接口"**：`grep '"defect:' app/` = **0 权限位**、
   `web/src/layout/shell.tsx` 菜单**无缺陷项**、`defect/` 只有 `models.py`（无 schemas/services）。
   ⇒ 复刻缺陷 = **接线 + 写服务**，不是改行为（与 A 档「已有页面差行为」性质不同）。
2. **50 端点里有 23 条（46%）必须先有地基才能存在**，分 5 块：模板/EAV 4（1.2/1.3/1.18/1.19）、
   三方同步 4（1.1/1.10/1.11/1.12）、**附件 12 条全在**文件库（C12）后、模块树 2（3.2/3.3 需 `module_id`）、
   拖拽排序 1（1.17 需 `pos`）。它们不是"缺陷模块自己写"的东西，属总账 §6 排期 2/3。
3. **状态图不用动**：MS 默认 seed 的 5 态 9 边与我们 `defect/models.py:49-55` 的
   `DEFECT_TRANSITIONS` **逐条同构**（含 `closed→in_process`、`rejected→in_process` 两条重开边）。
   差异在**谁来兜底**：MS 后端保存路径**从不校验边**（ms-endpoints §7 负向 grep 证据），
   我们写路径真校验 —— 这是**主动不跟**，不是差集。

---

## 1. 表 1 · 契约差集（MS 50 端点 → 我方）

**图例**：`无` = 我方零对标端点且**本刀可做**；`可做（简化）` = 形状可降级后本刀做；`地基` = 依赖尚未存在的横切子系统（不排进本刀）；`待裁` = 能做但形状归属未定（见 §7）。50 行全列，不许省略。
`地基?` = 依赖已点名但也可先做简化版。50 行全列，不许省略。

### 1.1 BugController（`/bug`，21 端点）— 我方 0

| # | MS 端点 | 权限（字面值） | 我方 | 差异 / 缺什么 |
|---|---|---|---|---|
| 1.1 | GET `/bug/current-platform/{projectId}` | READ | 地基 | 无 `project_application` 开关表，也无平台概念；Local 恒定时此端点退化为常量 |
| 1.2 | GET `/bug/header/custom-field/{projectId}` | READ | 地基 | 无 `custom_field`/`template_custom_field` ⇒ 无表头动态列可返回 |
| 1.3 | GET `/bug/header/columns-option/{projectId}` | READ | 地基 | 状态下拉选项可由源码常量出，但 MS 形状是"按当前状态给流转集" ⇒ 要状态流转表才能同形 
| 1.4 | POST `/bug/page` | READ | 无 | 缺列表服务。**默认序 `pos desc`**（现读 `BugController.java:99-100`）我们无 `pos` 列；我方分页先例 `paginate_page`（`core/errors.py:204`）形状可照 |
| 1.5 | POST `/bug/add` | READ+ADD | 无 | multipart 建单（内联附件）；`templateId` @NotBlank（`BugEditRequest.java:36`）⇒ 依赖模板地基 |
| 1.6 | POST `/bug/update` | READ+UPDATE | 无 | 同上。**MS 改状态不校验流转边**（`BugService.java:1008-1020`）⇒ 我们跟形状、不跟这个洞 |
| 1.7 | GET `/bug/check-exist/{id}` | READ | 无 | 存在性探测，无 @CheckOwner；小端点，可并入本刀 |
| 1.8 | GET `/bug/get/{id}` | READ | 无 | 详情＝主表+content+自定义字段+附件+followFlag+关联用例数；后半四项全无 |
| 1.9 | GET `/bug/delete/{id}` | READ+DELETE | 无 | **GET 做删除**；Local 软删/三方物理删。我们用 POST + `recycled` 位（先例 `ui_case_delete` `case_services.py:290`） |
| 1.10 | GET `/bug/sync/{projectId}` | READ+UPDATE | 地基 | 三方同步（Redis 锁 + @Async + SPI 外呼），依赖 C4 服务集成 + C7 插件 |
| 1.11 | POST `/bug/sync/all` | READ+UPDATE | 地基 | 同上，区间全量拉取；DTO 无 @Validated（校验不生效，MS 病） |
| 1.12 | GET `/bug/sync/check/{projectId}` | READ+UPDATE | 地基 | 读 Redis 同步进度 —— 属总账 §4 任务中心观测面那一格 |
| 1.13 | GET `/bug/export/columns/{projectId}` | READ | 可做（简化） | 导出字段配置。我方有导出先例（`api_test/export_services.py:208`、`scenario/export_services.py:81`）但无"字段可选配置" 
| 1.14 | POST `/bug/export` | READ+EXPORT | 无 | zip 流导出；导出先例可照，但导出列含自定义字段 ⇒ 完整形仍靠地基 |
| 1.15 | POST `/bug/batch-delete` | READ+DELETE | 无 | 批量删；我方批量先例见 D47-d。controller **有** @Log |
| 1.16 | POST `/bug/batch-update` | READ+UPDATE | 无 | **实现只有标签**：追加/清空/覆盖（`BugService.java:493-524`）；controller 无 @Log、service 内手动补审计 |
| 1.17 | POST `/bug/edit/pos` | READ+UPDATE | 地基 | 拖拽取中插值（`getPrePos/getLastPos`）。⚠ **MS 前端本页未接**（ms-ui §1.5）⇒ 后端有、入口无 |
| 1.18 | GET `/bug/template/option/{projectId}` | READ | 地基 | 模板四件套（总账 §6 排期 2） |
| 1.19 | POST `/bug/template/detail` | READ | 地基 | 同上，且三方分支会外呼 SPI |
| 1.20 | GET `/bug/follow/{id}` | **READ** | 无 | **写库但只读位 + GET**；判重靠复合主键撞库。⇒ §5 第 1 条"不跟" |
| 1.21 | GET `/bug/unfollow/{id}` | **READ** | 无 | 同上；按 (bugId,currentUser) 删所以天然只能取关自己 |

### 1.2 BugTrashController（`/bug/trash`，5 端点）— 我方 0

| # | MS 端点 | 权限 | 我方 | 差异 |
|---|---|---|---|---|
| 2.1 | POST `/bug/trash/page` | READ | 无 | 与 1.4 共用请求体、排序换 `delete_time desc`；**无 @CheckOwner**（1.4 有）⇒ MS 自己不对称 |
| 2.2 | GET `/bug/trash/recover/{id}` | READ+DELETE | 无 | 恢复**仅 Local**，三方抛 `NOT_LOCAL_BUG_ERROR`；**不清 delete_user/delete_time**（§5 第 5 条不跟） |
| 2.3 | GET `/bug/trash/delete/{id}` | READ+DELETE | 无 | 彻底删；先例 `ui_case_purge`（不在回收站则 409 `not_recycled`，`case_services.py:373`） |
| 2.4 | POST `/bug/trash/batch-recover` | READ+DELETE | 无 | 循环 recover，controller 无 @Log、service 手动补 |
| 2.5 | POST `/bug/trash/batch-delete` | READ+DELETE | 无 | 循环硬删 |

⇒ 回收站是我们**已有先例最完整**的一块（进/恢复/硬删三态 + 徽标 + 前端谓词全在 ui_test）。

### 1.3 BugRelateCaseController（`/bug/case`，7 端点）— 我方 0（但表已有）

| # | MS 端点 | 权限 | 我方 | 差异 |
|---|---|---|---|---|
| 3.1 | POST `/bug/case/un-relate/page` | READ | 无 | 走 SPI provider 工厂按 sourceType 取候选用例；我们用表名反射（`testplan/services.py:114-138`）替代 SPI |
| 3.2 | POST `/bug/case/un-relate/module/count` | READ | 地基 | 模块树计数；我方 `module_services` 的 `_counts` 同形（4 份先例） 
| 3.3 | POST `/bug/case/un-relate/module/tree` | READ | 地基 | 第 5 份模块树（`defect` 现无 `module_id` 列 ⇒ 先加列） 
| 3.4 | POST `/bug/case/relate` | READ+UPDATE | 无 | 批量 insert，**代码层判重**（`BugRelateCaseCommonService.java:114-124`）；我们有 DDL 唯一键 ⇒ 等价且更强 |
| 3.5 | POST `/bug/case/page` | READ | 无 | 已关联列表；**无 @CheckOwner** |
| 3.6 | GET `/bug/case/un-relate/{id}` | READ+UPDATE | 无 | 按关联行 id 硬删 |
| 3.7 | GET `/bug/case/check-permission/{projectId}/{caseType}` | **无权限注解** | 待裁 | 方法体内二次查权。**我们没有"关联对象跨域权限"这件事的同形需求**（`DEFECT_CASE_TYPES` 4 类都在我们自己的权限域内）⇒ 待裁，见 §7 第 5 条 

⇒ `defect_case_link` 表**已在**（迁移 0027）且比 MS 多一个唯一键。这一族是**纯接线**，不等地基。

### 1.4 BugAttachmentController（`/bug/attachment`，12 端点）— 我方 0（附件表也无）

| # | MS 端点 | 权限 | 我方 | 差异 |
|---|---|---|---|---|
| 4.1 | GET `/bug/attachment/list/{bugId}` | READ | 地基 | 合并 `bug_local_attachment` + `file_association` 两路 ⇒ 依赖文件库 C12 |
| 4.2 | POST `/bug/attachment/file/page` | READ | 地基 | 直接委托文件库模块 |
| 4.3 | POST `/bug/attachment/upload` | READ+UPDATE | 地基 | MinIO 正式目录；**无 @FileLimit**（§5 第 4 条不跟） |
| 4.4 | POST `/bug/attachment/delete` | READ+UPDATE | 地基 | 删对象+删行；DTO **无 @Validated ⇒ 校验不生效**（MS 病） |
| 4.5 | POST `/bug/attachment/preview` | READ | 地基 | 字节流 + Content-Disposition |
| 4.6 | POST `/bug/attachment/download` | READ | 地基 | 同上 |
| 4.7 | GET `/bug/attachment/transfer/options/{projectId}` | READ | 地基 | 文件库模块树 |
| 4.8 | POST `/bug/attachment/transfer` | **READ** | 地基 | 写操作只读位（§5 第 1 条） |
| 4.9 | POST `/bug/attachment/check-update` | READ | 地基 | 裸 `List<String>` 入参、无 DTO 无校验 |
| 4.10 | POST `/bug/attachment/update` | **READ** | 地基 | 写操作只读位 |
| 4.11 | POST `/bug/attachment/upload/md/file` | ADD∪UPDATE∪COMMENT | 地基 | 富文本贴图进临时目录；`maxFileSize(50MB)` 字段**声明后未使用** |
| 4.12 | GET `/bug/attachment/preview/md/{projectId}/{fileId}/{compressed}` | **无权限注解** | 地基 | 按 fileId 全局查、不带 bugId、无 @CheckOwner |

⇒ **12/12 全在地基后**。文件库（C12，总账 §3.4 = 31 端点）不落地，这 12 条一条都做不出真形状。

### 1.5 BugCommentController（`/bug/comment`，4 端点）— 我方 0（评论表也无）

| # | MS 端点 | 权限 | 我方 | 差异 |
|---|---|---|---|---|
| 5.1 | GET `/bug/comment/get/{bugId}` | READ | 无 | 两代嵌套（parentId 空=父）；表 `bug_comment` 10 列，我们零 |
| 5.2 | POST `/bug/comment/add` | READ+COMMENT | 无 | 事件枚举 COMMENT/REPLY/AT 驱动通知；**DTO 无 @Validated** |
| 5.3 | POST `/bug/comment/update` | READ+COMMENT | 无 | 方法体内"仅创建人可编辑"（`bug_comment_not_owner`）⇒ 归属校验在体内不在切面 |
| 5.4 | GET `/bug/comment/delete/{commentId}` | READ+COMMENT | 无 | 父删带删子；**无 @CheckOwner、无 @Log** |

⇒ 依赖通知/AT 事件（我们有 `notify` 域 6 services，但 AT 提及是富文本能力）⇒ 标 `地基?`：
纯文本评论可先做，贴图与 @ 提及等富文本地基。

### 1.6 BugHistoryController（`/bug/history`，1 端点）— 我方 0

| # | MS 端点 | 权限 | 我方 | 差异 |
|---|---|---|---|---|
| 6.1 | POST `/bug/history/page` | READ | 待裁 | 读 `operation_history`（限定 module + sourceId、标 latest）。**我们没有字段级历史**：`audit_log` 是动作日志，`diff` 列现值只有 `{"produced"}` / `{"error"}` 两种形状（现读 `core/service.py:365-369`），全仓无字段前后值写入方（`write_audit(` 仅 4 处：导入 1 + 调度 3） 

---

### 1.7 契约差集汇总

| 分组 | MS 端点 | 本刀可做 | 等地基/待裁 | 说明 |
|---|---|---|---|---|
| Bug 核心（CRUD/详情/存在性/批量/导出） | 1.4/1.5/1.6/1.7/1.8/1.9/1.13/1.14/1.15/1.16 = **10** | 10（导出列简化为固定列） | — | 只砍掉 multipart 内联附件 |
| 回收站 | **5** | 5 | — | ui_test 三态先例齐全 |
| 用例关联 | **7** | 4（3.1/3.4/3.5/3.6） | 2（3.2/3.3 模块树要先有 `module_id`）+ 1 待裁（3.7） | 表已在 |
| 评论 | **4** | 4（纯文本） | — | @提及/贴图后置 |
| 关注人 | **2** | 2 | — | 需新表 + 用写位（不跟 READ） |
| 变更历史 | **1** | 0（1 待裁）| 1 | 需先裁"字段级历史怎么落"（§7 第 4 条）|
| 表头选项/模板 | 1.2/1.3/1.18/1.19 = **4** | 0 | 4 | 模板四件套；1.3 的按当前状态出流转集还需状态流转表 |
| 三方同步 | 1.1/1.10/1.11/1.12 = **4** | 0 | 4 | C4 + C7 |
| 拖拽排序 | **1** | 0 | 1 | `pos` 列 + 我方无拖拽 UI |
| 附件 | **12** | 0 | 12 | C12 文件库 |
| **合计** | **50** | **25** | **23 等地基 + 2 待裁** | 25 是纯接线；另 25 条**逐条点名了依赖**，无一是"暂时不知道怎么做" |

⚠ 口径提醒：**25 不等于"做完就等价"**。做完是"缺陷能建、能查、能回收、能评论、能关联用例"，
MS 缺陷面的观感差异（模板动态字段、平台列、附件 Tab、富文本）全在等的那 23 条里。

---

## 2. 表 2 · 字段差集（MS 缺陷域 7 表逐列 → 我方）

我方现有（列数含 mixin，按 `mapped_column` 实数）：
`defect` **12 列** = 自声明 9（id/title/description/status/priority/handle_user_id/recycled/created_by/updated_by）
+ mixin 3（`ProjectScopedMixin.project_id`、`TimestampMixin.created_at/updated_at`）；
`defect_case_link` **8 列** = 自声明 5 + mixin 3。MS：7 表 / 基线 53 列 / 终态 54 列（3.5.0 加 1 列）。

### 2.1 `bug`(19) vs `defect`(12)

| MS 列 | MS 类型/约束 | 我方 | 判定 |
|---|---|---|---|
| id | VARCHAR(50) PK | `id` String(36) PK | 同形 |
| num | INT NOT NULL | **缺** | **横切前置**：MS 的取号器在 `system-setting/.../uid/NumGenerator.java:21`（`INIT=100001`），调用方跨 4 个域（BUG×2/CASE×2/REVIEW×1/TASK×1 + `SUB_NUM` 白名单 5 类）⇒ **不是缺陷表加一列，是先建跨域取号服务**。我方 Redis 已在地基（`config.py:45 redis_url`、Celery broker、`core/eventbus.py` 有 fakeredis 注入与 `client` 属性），**无新依赖、也无 INCR 先例** |
| title | VARCHAR(255) NOT NULL | `title` String(200) | **长度不同**：255 vs 200。MS 前端 maxLength=255（ms-ui §3.2）。⇒ 改 255 才等价；`models.py:101` 那处 200 无理由，是随手值 |
| handle_users | VARCHAR(1000) NULL 预留 | **缺** | 原判"死列"，实为**在写**（`BugService.java:1076-1078` 逗号追加）全仓无读方 ⇒ **仍不建**，但理由要改成"MS 自己没读方"（§5 第 2 条） |
| handle_user | VARCHAR(50) NOT NULL | `handle_user_id` 可空 | **可空性不同**：MS 缺失直接抛错。我们的"可空"是**主动改良**（`models.py:124-127` 已给理由），保留 |
| create_user / create_time / update_user / update_time | 4 列 | `created_by`/`created_at`/`updated_by`/`updated_at` | 同形异名，跟我们的列名 |
| project_id | VARCHAR(50) NOT NULL | `project_id` | 同形 |
| template_id | VARCHAR(50) NOT NULL | **缺** | 模板地基。**原判"这列的存在本身就是我们不抄模板的形状"已作废**（总账 §0） |
| platform | VARCHAR(50) NOT NULL | **缺** | 三方地基（C4/C7）。⚠ 它 NOT NULL 且参与列表筛选与"非本平台禁止编辑"（ms-ui §1.3：`record.platform !== currentPlatform` 时禁用编辑） |
| status | VARCHAR(50) NOT NULL DEFAULT '' | `status` String(24) | 同形 |
| tags | VARCHAR(1000) NULL | **缺** | **全后端零 tags 列**（现查：`grep "tags: Mapped"` 0 命中，命中的全是 FastAPI 路由 tags）。⇒ 新列 + 新写入方 + 批量编辑三态（追加/清空/覆盖）+ 前端标签控件，四件事一起 |
| platform_bug_id | VARCHAR(50) NULL | **缺** | 随 platform |
| delete_user / delete_time | 均 NULL | **缺** | 回收站展示位。D187 说"等它的读取方同一个提交"——新口径下读取方就是回收站列表（MS 排序键 `delete_time desc`），⇒ **随回收站那一刀一起做** |
| deleted | BIT(1) NOT NULL | `recycled` Boolean | 同义异名；我们的两轴分离（`status` 工作流 + `recycled` 回收站）**优于** MS 单轴，保留 |
| pos | BIGINT NOT NULL 间隔5000 | **缺** | **列表默认排序键就是它**（`pos desc`）。原判"无拖拽就先不建"在新口径下要重议：不建则默认排序无处可去，只能继续 `created_at desc`（§5 第 3 条给可复跑理由） |

**`bug` 表无一处 UNIQUE KEY**（PK + 12 普通索引）⇒ 我们的 `title` 不建唯一键与 MS 一致（`models.py:97-101` 那条论证依然成立，只是理由不再是"改良"而是"对齐"）。

### 2.2 其余 6 表

| MS 表（列数） | 我方 | 差集 |
|---|---|---|
| `bug_content`(2) | description **内联在 `defect`** | **拆表 vs 内联**：MS 把 LONGTEXT 富文本单拆一张 1:1 表。富文本地基到位前保持内联（`Text` 已够），到位时是一次迁移而非改语义 |
| `bug_follower`(2) | **缺** | 新表 `defect_follower`，PK (defect_id, user_id) 复合 —— 与 MS 同形。配套 follow/unfollow 两条服务，**权限用写位** |
| `bug_local_attachment`(8) | **缺** | 新表，含 `source ∈ {ATTACHMENT, RICH_TEXT, COMMENT}`（`BugAttachmentSourceType.java:8-16`）⇒ 三种来源一张表是 MS 的形状，可照；对象存储层缺 |
| `bug_comment`(10) | **缺** | 新表，两代嵌套（parent_id/reply_user/notifier）。notifier 是 @ 提及的结果，纯文本刀可先收空 |
| `bug_custom_field`(3+1) | **缺** | EAV 值表，PK (bug_id, field_id)，value LONGTEXT + content LONGTEXT。定义表 `custom_field`/`custom_field_option`/`template`/`template_custom_field` 四张是横切物（总账 §6 排期 2） |
| `bug_relation_case`(9) | `defect_case_link` | **我方多一个唯一键**（`uq(defect_id,case_id,case_type)`），MS 无。MS 两个写入口判重口径不同 ⇒ 同一对可重复插（ms-schema §D）⇒ **不跟** |

**表级差集**：MS 7 张，我方 2 张。新增优先级：`defect_follower` → `defect_comment` →
（地基）`defect_attachment` → （地基）EAV 四件套。

### 2.3 DTO 校验差集（MS 请求侧 → 我方 pydantic）

| MS 约束 | 出处 | 我方该有 | 备注 |
|---|---|---|---|
| title @Size(1,255) | `BugEditRequest.java:27` | `max_length=255` | 与 §2.1 的列宽一起改 |
| templateId @NotBlank | `:36` | 地基 | 模板到位前不引入 |
| id @NotBlank(Updated) + @Size(1,50) | `:22` | `min_length=1` | |
| current @Min(1) | `BasePageRequest.java:18` | 已有 `ge=1` | 我方 `testplan/schemas.py:33` |
| pageSize @Min(5) @Max(500) | `:22-25` | 我方 `ge=1, le=200` | **上下界都不同**。我们的更严且更合理（下限 1 不是 5）；上限 200 已能跑 CI ⇒ 保留，§5 第 6 条 |
| sort(Map) key @Pattern(`^[A-Za-z]+$`) | `:27` | **无同形物** | ⚠ MS 的 sort 最终拼进 `order by ${sort}`（`ExtBugMapper.xml:22,57`）—— 靠这个 Pattern 防注入。我们用 SQLAlchemy 表达式排序，**不存在该注入面**，也不需要这层校验 |

---

## 3. UI 差集（ms-ui 四份对照，摘要）

| 面 | MS | 我方 | 判定 |
|---|---|---|---|
| 列表列 | 12 列（ID/名称锁列不可隐藏），ID 列 dataIndex=`num` | 零页面 | 复刻时 **ID 列就是 `num`** ⇒ 取号服务是 UI 硬前置，不是可选优化 |
| 高级搜索 | 11 系统字段 × 各自运算符集 + 自定义字段，AND/OR、存为视图（≤10） | `saved_view` 表已在（迁移 0023） | 视图存储有地基；11 字段里 ID/所属平台/用例数依赖新列与新表 |
| 系统视图 | 全部数据/我关注的/我创建的（后端枚举 `UserViewType.BUG`） | 无 | "我关注的"依赖 follower 表 |
| 新建表单 | 固定 5 项 + 模板动态字段；"保存并继续创建"；首次成功页 15s 倒计时 | 零 | 动态字段 = 地基 |
| 详情抽屉 | 5 Tab；基本信息**改动 300ms 防抖自动保存**、无确认（现读 `basicInfo.vue:176-183`） | 零 | 自动保存是行为决定：我们若照做，需要给"改了但没点保存"的失败可见性 |
| 批量编辑 | 弹窗属性下拉**当前只有"标签"一项**（现读 `batchEditModal.vue:159-163` 的 `systemOptionList` 只含 `tags`） | 零 | MS 批量编辑的真实面 = 标签三态，与 §1.1 的 1.16 实现一致 |
| 回收站 | 行内 2 项 + 批量 2 项；恢复无确认、彻底删除有逐字确认 | ui_test 同款三态 | 直接照自家先例 |
| 行拖拽 | **无**（后端 `/bug/edit/pos` 存在但本页未接） | 全仓无拖拽位 | ⇒ `pos` 在 MS 的实际效果就是"创建顺序"，见 §5 第 3 条 |

---

## 4. 本刀的可执行边界（对账之后才敢说）

按 §1.7 的 27 条，一刀能吃下的最小闭环（每条形成本仓 `@service`，四段式照 `testplan/services.py:180-194`）：

1. **表**：`defect_follower`（新）+ `defect_comment`（新）+ `defect` 加列 `tags`、`title`→255、
   `delete_user`/`delete_time`。**迁移 0028**，`check_migration_down.py:42` 补 EXPECT。
2. **服务**：**24 个 @service**覆盖本刀的 25 条 MS 端点（逐条映射见下；四段式照 `testplan/services.py:180-194`）：核心 10（list/create/update/get/exists/delete/batch_delete/batch_update/export_columns/export）+ 回收站 4（restore/purge/batch_restore/batch_purge）+ 关联 4（候选/关联/已关联列表/取消）+ 评论 4 + 关注 2。**唯一一处折叠**：MS 的 `/bug/page` 与 `/bug/trash/page` 是两个端点，我们是一个 `defect_list` 带 `recycled` 谓词（先例 `ui_case` 列表 :159）；其余 1:1。⇒ 新权限位组 `defect:defect:{read,create,update,delete,comment}` 与 `defect:link:*`，  按我们的**原子位**形状，不抄 MS 的 `READ+ADD` 组合位。
   （⇒ 新权限位组 `defect:defect:{read,create,update,delete,comment}` 与 `defect:link:*`，
   按我们的**原子位**形状，不抄 MS 的 `READ+ADD` 组合位）。
3. **零登记**：权限位、router、Agent 工具全自动（`@service` 单点，`ours-survey §3.3`）。
4. **前端最小集 5 文件**（`ours-survey §5`），`perms.ts` **不用登记新位**（内置角色 `*` 通配天然覆盖，
   现读 `web/src/auth/perms.ts:5,23-30`；写动词靠 `WRITE_TAIL` 正则 `:57`）。
5. **本刀明确不含**（每项点名依赖，不是"先不做"）：
   模板/EAV（4 端点）、三方同步（4）、附件（12）、拖拽 pos（1）、变更历史（1）、模块树（2）、跨域关联权校验（3.7 待裁 §7）。

---

## 5. 「不跟 MS」清单（照 D187 §三 格式，逐条给可复跑的理由）

新口径是**复刻行为，不复刻病**。以下是抽查时确认的 MS 侧缺陷，每条都要有用例钉住我们不跟：

1. **写副作用只用 READ 位的 6 条端点**：`GET /bug/follow/{id}`、`GET /bug/unfollow/{id}`（`BugController.java:238-250`，
   写关注关系）、`POST /bug/attachment/transfer`、`POST /bug/attachment/update`（`BugAttachmentController` 的
   `/transfer`、`/update`，均 READ）、以及 `POST /bug/case/un-relate/{page,module/count,module/tree}`
   三条与同族 `relate`/`un-relate/{id}`（UPDATE）**权限不对称**。
   ⇒ 我们的口径：**写副作用一律写位**，且写操作不用 GET 方法。
2. **`handle_users` 有写无读**：`BugService.java:1076-1078` 每次编辑逗号追加，全仓无读方。
   ⇒ 不建；且把 `models.py:79` 那句"MS 那列写两次全仓无一处读"改成准确表述"在写、无读方"。
3. **`pos` 后端有、前端无入口**（`/bug/edit/pos` 存在但缺陷列表未接拖拽，ms-ui §1.5）。
   ⇒ 我们不建 `pos`，默认排序 `created_at desc`。**这条在新口径下是待翻案的**：
   一旦将来做"每项目自定义排序/看板列"，`pos` 必须回来，且回来时要连拖拽端点一起做，
   不能像 MS 一样留一个没人调的写端点。
4. **附件上传绕过大小校验**：`@FileLimit` 只挂在 `/bug/add`、`/bug/update`，
   `grep -c @FileLimit BugAttachmentController.java = 0`；`CommonFileService.java:34-35` 的
   `maxFileSize(50MB)` 声明后未使用；无 MIME/扩展名白名单。
   ⇒ 附件那一刀做时**限制必须在上传路径上**，不复制这个洞。
5. **恢复不清 `delete_user`/`delete_time`**：行上永久留着上一次删除的"谁、何时"。
   ⇒ 我们加这两列时必须同时定义恢复语义（清空，或改为历史表）——与列同一个提交，否则就是把病抄过来。
6. **`pageSize @Min(5)`**：MS 不允许每页 1~4 条，前端档位却有 [10,20,30,40,50]。
   ⇒ 保留我方 `ge=1, le=200`（已有 `testplan/schemas.py:33-34` 与 CI 覆盖）。
7. **保存改状态不校验流转边**（`BugService.java:1008-1020`）：边只用于渲染下拉，后端不兜底。
   ⇒ 我们**保留真校验 + 非法转移 409**（`models.py:31-33` 原话："改它等于改接口契约"）。
8. **5 个 DTO 的 `@Validated` 漏挂**：1.11/1.19/4.4/5.2/5.3 ⇒ DTO 上写了约束但不触发。
   ⇒ 我们 pydantic 天然无此面；列在此处是为了**别把 MS 的"有注解=有校验"当成对账依据**。
9. **`BugSyncService.java:84-87`**：检测到 Local 时只删 Redis 锁键、**未 return**，之后仍继续查库尝试同步。
   随三方地基那刀再看，先登记。

## 6. 本轮对账中改掉的取证错处（防止下游按错的做）

| 出处 | 原述 | 现读结论 |
|---|---|---|
| `ms-ui.md:94` | 缺陷列表默认排序【推断：服务端按创建时间倒序】 | **`pos desc`**，`BugController.java:99-100` 现读：`isNotBlank(sort) ? sort : "pos desc"`。已就地改写该行并点名原推断错 |
| `ms-schema.md` §5 | `num` 生成器在 bug-management | 在 `system-setting/.../uid/NumGenerator.java:21`；缺陷侧只是调用方 ⇒ 已在 §8 把它升为横切前置 |
| `ms-endpoints.md` §复核 | "transfer/update 只要 READ"（未点名 controller） | 歧义：`BugController./update` 是 UPDATE，`BugAttachmentController./update` 才是 READ。复核表已点名，主代理自己第一遍就误读过 |
| `ours-survey.md:177` | 模块树"标准操作面 = 7 个 @service" | 实测 **6 个**（`grep 'name="ui_module'` → tree/create/update/delete/restore/purge） |
| `ours-survey.md:85` | `defect` 命中 13 个文件 | 含 `.import_linter_cache/*.json` 与 `.tmp/d187s1/mut-step1.py`；**排除缓存与临时产物后 = 9 个**（3 处还只是注释里提了一句 0027）。结论"零接线"不变，数字要准 |
| 四份报告 | 中文 U+FFFD | 共 25 处（ours-survey 9、ms-ui 10、其余 6），已逐行修并断言 `count(U+FFFD)==0` |

## 7. 待业主裁（本刀新增 2 条，总账 §5 的 3 条不变）

4. **字段级变更历史怎么落？** MS 用 `operation_history` 存"每个字段每次改动 + latest 标记"，
   缺陷详情的「变更历史」Tab 就是它（6.1 端点）。我们有 `audit_log`（动作级，`diff` 现值只装
   `{"produced"}`/`{"error"}`），**没有字段级历史**，也没有任何模块有。三个选项：
   (a) 给 `audit_log` 加"字段前后值"写入约定（不新增表，但语义混两种东西）；
   (b) 新建 `defect_history`（每域一张，各域重复）；
   (c) 建一张跨域 `entity_history`（横切，等同步/用例/计划都要）。
   这条决定它是**缺陷刀内**还是**又一格横切前置**，我不能替业主定。
5. **关联用例要不要做「跨域权限预检」？**（端点 3.7）MS 在关联前调 `check-permission`：
   前端先问「这个用户能不能看这类用例」，不能就禁用入口（方法体内二次查权，无注解）。
   我们的 `DEFECT_CASE_TYPES` 四类用例**全在同一项目权限域内**，没有 MS 那种「关联对象属于
   用户无权读的域」的真实场景。裁「要」⇒ 多一个预检端点且要先定义它监谁；
   裁「不要」⇒ 3.7 从 50 里正式出局（**无对应物，不是漏做**），待裁从 2 降 1。
