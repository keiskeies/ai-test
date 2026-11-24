"""scenario schemas（§11.4.8/§11.4.9）：场景 CRUD + 模块树 + 引用检测 + duplicate/batch_move。"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.modules.scenario.models import PRIORITIES


class OkOut(BaseModel):
    ok: bool = True


# —— 模块树 ——
class ScenarioModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    count: int = 0  # 直属未回收场景数（含私有可见性过滤）
    children: list[ScenarioModuleNode] = []


class ScenarioModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class ScenarioModuleTreeOut(BaseModel):
    tree: list[ScenarioModuleNode] = []
    recycled: list[ScenarioModuleNode] = []


class ScenarioModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class ScenarioModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None  # 显式传入（含 null）即移动；缺省=不动父级


class ScenarioModuleDeleteIn(BaseModel):
    project_id: str
    module_id: str


class ScenarioModulePurgeIn(BaseModel):
    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ScenarioModulePurgeOut(BaseModel):
    ok: bool = True
    purged_modules: int = 0
    detached_scenarios: int = 0


# —— 场景 CRUD ——
class ScenarioCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    module_id: str | None = None
    priority: str = "P2"
    # D284：标签（去空白/去重保序，空 = 无标签；存法见 shared/tags.py）
    tags: list[str] = Field(default_factory=list)
    step_graph: dict = Field(default_factory=lambda: {"version": 1, "nodes": []})
    variables: dict[str, str] = {}
    fail_fast: bool = True
    max_runtime_ms: int | None = Field(default=None, ge=1000)
    # T20b 公共断言：场景级质量门，执行期对**每一个发出请求的步骤**求值（R88）；空 = 不启用
    common_assertions: list[dict[str, Any]] = Field(default_factory=list)
    env_id: str | None = None
    project_public: bool = True

    @field_validator("priority")
    @classmethod
    def _p(cls, v: str) -> str:
        if v not in PRIORITIES:
            raise ValueError("优先级必须是 P0-P3")
        return v


class ScenarioUpdateIn(BaseModel):
    project_id: str
    scenario_id: str
    version: int = Field(ge=1)  # 乐观锁：不匹配 → 409 conflict + current_version
    name: str | None = Field(default=None, min_length=1, max_length=200)
    priority: str | None = None
    # D284：标签三态——None = 不改、[] = 清空、带值 = 覆盖（与 api/functional 同款）
    tags: list[str] | None = None
    module_id: str | None = None
    module_set: bool = False  # 显式声明改绑/解绑模块（module_id 可为 null）
    step_graph: dict | None = None
    variables: dict[str, str] | None = None
    fail_fast: bool | None = None
    max_runtime_ms: int | None = Field(default=None, ge=1000)
    max_runtime_set: bool = False  # 显式声明改/清执行超时
    # T20b 公共断言：与 max_runtime_set 同款显式声明位——None 只表示「不改」，
    # 清空必须 common_assertions_set=True + common_assertions=[]（不许一值两义）。
    common_assertions: list[dict[str, Any]] | None = None
    common_assertions_set: bool = False
    env_id: str | None = None
    env_set: bool = False
    project_public: bool | None = None

    @field_validator("priority")
    @classmethod
    def _p(cls, v: str | None) -> str | None:
        if v is not None and v not in PRIORITIES:
            raise ValueError("优先级必须是 P0-P3")
        return v


class ScenarioListIn(BaseModel):
    project_id: str
    # 单值 module_id（直属）保留：与 module_ids 并存不互斥，现有调用方（工具入口等）不受影响。
    module_id: str | None = None
    recycled: bool = False
    cursor: str | None = None
    # current（D47-b 步 5b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（响应形状逐字节不变）；与 cursor 互斥，两者同时到场在 handler 里 400。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)
    # module_ids（D47-b 步 5b）：模块 id 集下推到 SQL（此前是前端拉一页回浏览器内存过滤）。
    # 场景树徽标是**直属**计数、前端 ownModuleIds 也只给选中节点自己——两边口径已一致，
    # 这里语义 = 「前端把直属那一个 id 发来」，不做子树展开（子树是另一刀，要业主先裁）。
    # None = 不加这一路；**空列表 = 谁都不匹配**（含 module_id IS NULL 的未分类行），不是「没筛选」。
    module_ids: list[str] | None = Field(
        default=None, description="直属模块 id 集（由前端从树上算好）；[]=不匹配任何行"
    )
    # keyword（D47-b 步 5b）：**只打 name 一列**的包含匹配——现状本地框就只搜 name，
    # 不顺手扩列（那是行为改变）。大小写不敏感来自 utf8mb4_0900_ai_ci（与浏览器
    # toLowerCase 同宽度）；% 与 _ 是字面量（转义复用 shared.filters._like）。全空白 = 没筛选。
    keyword: str | None = Field(default=None, description="名称关键字（大小写不敏感）；全空白=不过滤")
    # D284：标签精确筛选（FIND_IN_SET；全空白 = 不过滤）。与上面几路并行 AND。
    tag: str | None = Field(default=None, max_length=200, description="标签精确筛选；全空白=不过滤")
    # filter（D214）：D47-a 高级搜索条件组（JSON 串，形状见 shared.filters）。
    # 与 module_id/module_ids/keyword/recycled 并行 AND；字段白名单见 SCENARIO_LIST_FILTER。
    filter: str | None = Field(default=None, description="高级搜索条件组（JSON）；白名单外字段 400")


class ScenarioGetIn(BaseModel):
    project_id: str
    scenario_id: str


# —— 变更历史（D262）——
class ScenarioRevisionListIn(BaseModel):
    project_id: str
    scenario_id: str
    cursor: str | None = None
    size: int = Field(default=20, ge=1, le=200)


class ScenarioRevisionOut(BaseModel):
    """一行历史：version = 变更后的版本号；changed 是 [{field, before, after}] 摘要。

    variables 的 before/after 只含 `keys`（键名），step_graph 只含 `step_count`——
    响应里不会出现变量值或步骤配置原文（那些可能有 token/密码）。
    """

    id: str
    scenario_id: str
    version: int
    actor_id: str | None = None
    actor_name: str | None = None
    changed: list[dict[str, Any]] = Field(default_factory=list)
    created_at: str | None = None


class ScenarioPurgeIn(BaseModel):
    """彻底删除场景（R53）：confirm_name 与场景名逐字相等，仅回收站可 purge。"""

    project_id: str
    scenario_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ScenarioOut(BaseModel):
    id: str
    project_id: str
    module_id: str | None = None
    name: str
    status: str = "normal"
    priority: str = "P2"
    # D284：标签数组（空数组 = 无标签，不画假 0/假值）
    tags: list[str] = Field(default_factory=list)
    step_graph: dict = Field(default_factory=lambda: {"version": 1, "nodes": []})
    variables: dict[str, str] = {}
    fail_fast: bool = True
    max_runtime_ms: int | None = None
    common_assertions: list[dict[str, Any]] = Field(default_factory=list)
    env_id: str | None = None
    owner_id: str | None = None
    project_public: bool = True
    version: int = 1
    step_count: int = 0
    last_run_at: str | None = None
    last_run_status: str | None = None
    updated_by: str | None = None
    # §11.4.18 回收站「删除人」列：id→人名由 scenario_list 分页后的小查询回填（_user_names）；
    # get/create 等单行出口恒为 None（单主体场景前端不吃这列）。查不到人 → None，
    # 前端画「—」——**绝不拿 user id 冒充人名**（uuid 摊在「删除人」列里是拿 bug 冒充数据）。
    updated_by_name: str | None = None
    # 对外时间戳一律带时区标记（services._iso）：裸 naive 字符串会被前端按本地时区解析，
    # 整页时间差 8 小时。列表页的「更新时间」列就吃这条。
    created_at: str | None = None
    updated_at: str | None = None
    issues: list[dict[str, Any]] = []  # live issue（scenario_get 返回；create/update 时必为 []）
    produced: list[dict[str, str]] = []


class ScenarioReferencesIn(BaseModel):
    project_id: str
    case_id: str | None = None
    definition_id: str | None = None


class ScenarioReferenceItem(BaseModel):
    scenario_id: str
    scenario_name: str
    step_keys: list[str]
    sort: str = Field(default="P2", exclude=True)  # 服务内部排序键，不进响应 JSON


class ScenarioReferencesOut(BaseModel):
    items: list[ScenarioReferenceItem] = []


# —— 内部引用查询（1B RF9：删除保护用，不暴露 HTTP）——
class ScenarioCaseRefsIn(BaseModel):
    """批量口径：一次删除只涉及 1~2 个 id，但数据集删除会牵出一批用例，
    逐个问会把「场景数 × 用例数」变成 N+1 次全表扫。"""

    project_id: str
    case_ids: list[str] = Field(default_factory=list)
    definition_ids: list[str] = Field(default_factory=list)  # ui/adb 步骤的 ref（1C/1D 前一般为空）


class ScenarioRefGroup(BaseModel):
    ref_id: str  # 被引用的 case_id（或 definition_id）
    count: int = 0  # 引用它的未回收场景数：**永远照报**，拦不拦由数据决定，不由查看权限决定
    # 引用明细；调用方无 scenario:read 时为空列表（数量可见、名字不可见）
    items: list[ScenarioReferenceItem] = []


class ScenarioCaseRefsOut(BaseModel):
    groups: list[ScenarioRefGroup] = []
    # True = 有引用但明细被隐瞒（调用方缺 scenario:read）；UI 据此说明「为什么列表是空的」
    details_hidden: bool = False


class ScenarioDuplicateIn(BaseModel):
    project_id: str
    scenario_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    module_id: str | None = None


class ScenarioBatchMoveIn(BaseModel):
    project_id: str
    scenario_ids: list[str] = Field(min_length=1)
    module_id: str | None = None  # None = 移到根（未分类）


class ScenarioBatchIn(BaseModel):
    """D255：批量回收 / 批量恢复（全有或全无）。

    与 D251/D252 的接口定义批量同口径：重复 id → 422；任一不存在或状态不对 → 404
    且整批不动。场景列表页此前是「前端 for 循环逐条 delete」——3 条里第 2 条失败会
    留下半批已删、半批还在，用户看到的错误与真实状态对不上。
    """

    project_id: str
    scenario_ids: list[str] = Field(min_length=1, max_length=200)


class ScenarioBatchPurgeIn(ScenarioBatchIn):
    """D256：批量彻底删除。单条要逐字输场景名，批量降级为固定短语，但**服务端也验**——
    客户端 disabled 只是提示，API 直调不应该绕过这道确认。
    """

    confirm_word: str


class ScenarioBatchCopyIn(ScenarioBatchIn):
    """D257：批量复制。`module_id` 为 None 时各副本跟随各自源场景的模块。

    名称策略与单条 duplicate 不同：单条撞名是 409（用户自己起的名），批量里 N 个
    「- 副本」撞名若也 409，等于一次复制 200 个里有一个重名就全批失败。这里自动加
    数字后缀（「 - 副本 2」「 - 副本 3」…）保证每行都能落地，并在响应里回报最终名。

    D261：`target_project_id` 给定时复制到**另一个项目**（None/相同 = 项目内复制，
    旧语义不变）。跨项目时有两处必须按项目私有资产处理：
    - `env_id` **不跟随**：环境是项目私有资产（D181 已禁止跨项目引用），跟随过去
      会让副本一保存就违规；副本落 None，由目标项目的人重新绑定；
    - `module_id` 缺省 = 目标项目的「未分类」，**不跟来源模块**（模块树也是项目私有，
      同样的 id 在目标项目里不存在）。
    """

    module_id: str | None = None
    target_project_id: str | None = None


class ScenarioBatchCopyOut(BaseModel):
    ok: bool = True
    created: int
    names: list[str] = Field(default_factory=list)


class ScenarioBatchRunIn(ScenarioBatchIn):
    """D258：批量执行。`env_id` 只做统一覆盖；缺省时每个场景各用自己保存的环境。"""

    env_id: str | None = None


class ScenarioBatchRunFailed(BaseModel):
    scenario_id: str
    code: str
    message: str


class ScenarioBatchRunOut(BaseModel):
    """投递结果逐条可解释。

    预检（存在性/状态/重复/环境可解析）是全有或全无的；但「投递」是逐条 commit 的
    （enqueue 的设计不允许攒批），broker 在第 k 条时死掉的话前 k-1 条已经诞生。
    所以回包必须同时给 `run_ids` 与 `failed`，前端不能拿勾选数冒充「已启动数」。
    """

    ok: bool = True
    run_ids: list[str] = Field(default_factory=list)
    failed: list[ScenarioBatchRunFailed] = Field(default_factory=list)


ScenarioMoveTarget = Literal["duplicate", "batch_move"]


# —— 导出备份（D74，§11.4.8 场景列表批量条 [导出]）——
class ScenarioExportIn(BaseModel):
    """勾选（scenario_ids）或全量（缺省 = 项目内全部非回收可见场景；口径同接口域 ApiExportIn）。"""

    project_id: str
    scenario_ids: list[str] | None = Field(default=None, max_length=500)


class ScenarioExportOut(BaseModel):
    """scenarios = 每条场景一份**只读备份快照**（step_graph 逐字 + 保存期同口径 validate 判定
    + 引用原样 ref）；notes = 未导出/限制的人话如实报。

    **D274 起可回灌**（import_services.scenario_import）：导入会生成新 id、重新校验、
    模块/环境不存在则清空——是「复制成新场景」，不是恢复旧 id 的备份。
    """

    scenarios: list[dict[str, Any]] = []
    exported: int = 0
    notes: list[str] = []


# —— T11：执行 / 调试 / 取消 / 单步重跑 ——


class ScenarioRunIn(BaseModel):
    project_id: str
    scenario_id: str
    env_id: str | None = None  # None = 用场景配置的环境；给了就覆写（「选环境跑」）


class RunEnqueueOut(BaseModel):
    run_id: str
    status: str = "queued"  # 投递语义：返回时还没跑完（inline 也是后台协程）


class ScenarioDebugIn(BaseModel):
    """调试跑**传入**的图（未保存也许可 debug，§11.5.6）；形状校验复用 T4 validate。

    fail_fast 是草稿的一部分：抽屉里改了失败策略没保存就点调试，执行必须按草稿来
    （T11 裁定①「执行了什么以入队快照为准」的完整含义——图、变量、失败策略三件同源）。
    None = 本次没改，继承保存行（缺省不是第三种策略，是「没改」）。
    """

    project_id: str
    scenario_id: str
    graph: dict
    variables: dict[str, str] | None = None
    env_id: str | None = None
    fail_fast: bool | None = None


class RunCancelIn(BaseModel):
    project_id: str
    run_id: str


class RunCancelOut(BaseModel):
    ok: bool = True
    status: str  # 置旗时的 run 状态（queued/running）


class RerunStepIn(BaseModel):
    project_id: str
    run_id: str  # 来源 run
    step_key: str
    row_no: int | None = Field(default=None, ge=1)
    env_id: str | None = None


class RerunStepOut(BaseModel):
    run_id: str
    status: str  # 同步等待的终态（run_single_step 本就 await 完成，裁定⑤）
    rerun_of: str


# ══════════ D274：场景导入（回灌本平台导出的 JSON 快照） ══════════
class ScenarioImportEntry(BaseModel):
    """一条待导入场景。字段与 export_services._entry 的**可写子集**逐字对齐。

    导出文件里的 `scenario_id` / `validation` / `refs` 是溯源与只读判定，本模型不声明
    （pydantic 默认忽略未知键）：id 一律重新生成——跨项目/重复导入时沿用旧 id 会撞主键；
    validation 一律**重新现算**，不信任文件里那份结论（文件可能是手改过的）。
    """

    name: str = Field(min_length=1, max_length=200)
    priority: str = "P2"
    # D284：标签随导出/导入往返（存法不变，仍是逗号串）
    tags: list[str] = Field(default_factory=list)
    module_id: str | None = None
    step_graph: dict = Field(default_factory=lambda: {"version": 1, "nodes": []})
    variables: dict[str, str] = {}
    fail_fast: bool = True
    max_runtime_ms: int | None = Field(default=None, ge=1000)
    common_assertions: list[dict[str, Any]] = Field(default_factory=list)
    env_id: str | None = None
    project_public: bool = True

    @field_validator("priority")
    @classmethod
    def _p(cls, v: str) -> str:
        if v not in PRIORITIES:
            raise ValueError("优先级必须是 P0-P3")
        return v


class ScenarioImportIn(BaseModel):
    """一次导入整份文件。上限 200 与批量操作的既有上限同尺（ScenarioBatchIn）。"""

    project_id: str
    scenarios: list[ScenarioImportEntry] = Field(min_length=1, max_length=200)


class ScenarioImportOut(BaseModel):
    """导入结果逐项如实报：renamed / cleared_modules / cleared_envs 都是**被改写的输入**，
    不是错误；notes 里再用人话点名跨域引用指针的口径。"""

    ok: bool = True
    imported: int = 0
    names: list[str] = Field(default_factory=list)
    renamed: list[dict[str, str]] = Field(default_factory=list)
    cleared_modules: list[str] = Field(default_factory=list)
    cleared_envs: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
