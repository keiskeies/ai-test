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


class ScenarioGetIn(BaseModel):
    project_id: str
    scenario_id: str


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


ScenarioMoveTarget = Literal["duplicate", "batch_move"]


# —— 导出备份（D74，§11.4.8 场景列表批量条 [导出]）——
class ScenarioExportIn(BaseModel):
    """勾选（scenario_ids）或全量（缺省 = 项目内全部非回收可见场景；口径同接口域 ApiExportIn）。"""

    project_id: str
    scenario_ids: list[str] | None = Field(default=None, max_length=500)


class ScenarioExportOut(BaseModel):
    """scenarios = 每条场景一份**只读备份快照**（step_graph 逐字 + 保存期同口径 validate 判定
    + 引用原样 ref）；notes = 未导出/限制的人话如实报。

    **只读导出，不可回灌**（与接口域 api_export 的刻意分歧，见 export_services 模块 docstring）：
    导入侧没有场景解析器，声称可回灌就是自证无门；validate 判定让导出内容至少能被判真假。
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
