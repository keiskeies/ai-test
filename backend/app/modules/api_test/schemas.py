"""api_definition schemas（§7.1 请求对象 S0 子集）。"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Pair = list[str]  # ["k","v"]


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传（adb_test/ui_test/notify 的 iso 同款）。

    补 `+00:00` 而不是裸串：库里存的是 naive UTC，前端拿到裸串只能按本地时区猜，
    列表的「更新时间」就会和审计日志差一个时区（同 §11.6 的「同一时间只有一个画法」）。
    """
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


ASSERTION_TYPES = {"status_code", "json_path_equals", "body_contains", "header_exists", "response_time_lt", "script", "regex"}
BODY_TYPES = {"none", "json", "text", "form"}


class Assertion(BaseModel):
    type: str
    path: str | None = None          # json_path_equals 用；regex 可选（先取字段再匹配）
    expected: Any = None
    timeout_ms: int | None = None    # response_time_lt 用 / script 单条超时
    code: str | None = None          # script 用：脚本正文（1B §8.5）
    # D78 启用开关：缺省 None = 启用（老数据不带这个键必须照旧执行）；只有显式 False 才跳过。
    # exclude_none 落库（case_services）保证 None 不占存储位，缺省语义与历史逐字一致。
    enabled: bool | None = None

    @model_validator(mode="after")
    def _script_needs_code(self) -> Assertion:
        # 字段级 after 校验器对「缺省值」不运行（pydantic v2），script 漏填 code 会静默过关，
        # 所以必须在 model 级判：缺正文要在 422 拦住，而不是跑起来才说「没有脚本」。
        if self.type == "script" and not (self.code and self.code.strip()):
            raise ValueError("script 断言必须填 code 脚本正文")
        return self

    @field_validator("type")
    @classmethod
    def _t(cls, v: str) -> str:
        if v not in ASSERTION_TYPES:
            raise ValueError("断言类型必须是 " + "/".join(sorted(ASSERTION_TYPES)))
        return v


class RequestBody(BaseModel):
    type: Literal["none", "json", "text", "form"] = "none"
    content: str | None = None

    @field_validator("content")
    @classmethod
    def _json_must_parse(cls, v: str | None, info):
        if info.data.get("type") == "json" and v:
            try:
                json.loads(v)
            except json.JSONDecodeError as e:
                raise ValueError("body.type=json 时 content 必须是合法 JSON：" + e.msg) from e
        return v


class RequestAuth(BaseModel):
    """§7.1 auth 子集（1A 只实现 basic/bearer）。

    type 在写入层就收紧：apikey 等未实现值存不进来（422 里看得见可选值），
    比「存得下、跑起来才炸」诚实；执行层 request_auth.py 仍对每个收到的值
    点名拒绝——它同时服务无 schema 的自由 JSON 通道（场景 http_direct）。
    type 必填（无缺省）：{"config": {...}} 漏 type 若默认 none 会静默吞掉 config。
    """

    type: Literal["none", "basic", "bearer"]
    config: dict[str, Any] = {}


class RequestObject(BaseModel):
    """§7.1 请求对象（S0：执行在 1A，存储与校验在 S0）。"""

    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
    url: str = Field(min_length=1, max_length=2000)
    params: list[Pair] = []
    headers: list[Pair] = []
    auth: RequestAuth | None = None
    body: RequestBody = RequestBody()
    timeout_ms: int = Field(default=10000, ge=1, le=120000)
    assertions: list[Assertion] = []

    @field_validator("params", "headers", mode="after")
    @classmethod
    def _pairs(cls, v: list[Pair]) -> list[Pair]:
        for it in v:
            if len(it) != 2 or not all(isinstance(x, str) for x in it):
                raise ValueError('键值对必须是 ["key","value"] 形式')
        return v


class OkOut(BaseModel):
    ok: bool = True


class ProducedRef(BaseModel):
    kind: str
    id: str
    name: str
    link: str


class ApiDefCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    method: str = Field(min_length=2, max_length=10)
    path: str = Field(min_length=1, max_length=500)
    request: RequestObject | None = None
    module_id: str | None = None
    project_public: bool = True


class ApiDefListIn(BaseModel):
    project_id: str
    recycled: bool = False  # True=回收站视图
    cursor: str | None = None
    # current（D47-b 步 4b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（形状逐字节不变）；与 cursor 互斥，两者同时到场在 handler 里 400。
    # 这一路的存在前提：筛选（module_ids/keyword/filter）已全部下推到 SQL，页码才画得出
    # 真 total——本地过滤时代挂页脚会得到「第 3 页显示 2 行而脚注说共 300 条」那种谎。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)
    # D47-a §11.5.1 高级搜索：JSON 串（GET query 装不下嵌套对象，见 filter_registry
    # .parse_filter_json 的注释）。字段白名单在 services.py 的 API_LIST_FILTER 里登记，
    # 不在这里列——入参模型只负责「收下一个条件」，能收哪些条件是页面的事。
    filter: str | None = None
    # D47-b 步 4a：模块子树筛选与关键字搜索下推到 SQL（此前是前端拉一页回浏览器内存过滤）。
    # 调用方（前端）把**选中节点 + 其全部子孙**的 id 一起发来——MS 语义「点模块看整棵子树」，
    # owner 裁定推翻 T23/R120 的直属旧口径；模块树徽标（module_services.api_module_tree）
    # 同步翻成子树计数，两边口径必须一致，否则「徽标写 3、列表出 7」那个谎只是换了方向。
    # None = 不加这一路；**空列表 = 谁都不匹配**，不是「没筛选」——把 [] 读成不过滤，
    # 「清空选择」和「选了个恰好没有接口的子树」两种意图就永远分不开。库里没有可点选的
    # 「未分类」树节点，所以这里不为 module_id IS NULL 造线协议哨兵（那是假功能）。
    module_ids: list[str] | None = Field(
        default=None, description="模块子树 id 集（选中节点+全部子孙，由前端从树上算好）；[]=不匹配任何行"
    )
    # 关键字 = name/path 两列的 OR 包含。MS 还匹配 num/tags，**本库的 api_definition
    # 没有这两列**（列集见 models.py），只匹配 name+path，不为此造列。
    # 全空白 = 没筛选（清空输入框和敲了空格是同一件事）。
    # 大小写不敏感来自 utf8mb4_0900_ai_ci 排序规则（前轮已验证）；但 `_ci` 同时是
    # **重音不敏感**的（é 与 e 判等），这比它替代的浏览器端 `.toLowerCase().includes()`
    # **更宽**——搜 "cafe" 能命中 "Café"。这是 shipped 语义，test_d47b_api_pushdown
    # 钉的是它本身，不是旧的浏览器行为。
    keyword: str | None = Field(default=None, description="名称/路径关键字（大小写与重音不敏感）；全空白=不过滤")


class ApiDefGetIn(BaseModel):
    project_id: str
    definition_id: str


class ApiDefDeleteIn(BaseModel):
    """回收接口定义。force 与 CaseDeleteIn 同款语义，是「已经看见引用清单、确认要连带
    断掉那些场景步骤」的第二段：第一段不带 force 只会 409 并列出引用者，误触不了。"""

    project_id: str
    definition_id: str
    force: bool = False


class ApiDefPurgeIn(BaseModel):
    """彻底删除（§11.4.18）：confirm_name 必须与接口名逐字相等。

    不可逆操作只给一次反悔机会——界面上要求手输名称，服务端同样硬校验，
    不指望前端已经拦过。
    """

    project_id: str
    definition_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ApiDefUpdateIn(BaseModel):
    project_id: str
    definition_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    path: str | None = Field(default=None, min_length=1, max_length=500)
    request: RequestObject | None = None
    module_id: str | None = None
    project_public: bool | None = None
    version: int = Field(ge=1)  # 乐观锁


class ApiDefOut(BaseModel):
    id: str
    project_id: str
    module_id: str | None = None
    name: str
    method: str
    path: str
    request: dict[str, Any] | None = None
    status: str = "draft"
    version: int = 1
    owner_id: str | None = None
    # 蓝图 :1376 列表列「负责人」：owner_id 是 UUID，画给人看就是骗人。名字由后端 join
    # app_user 回填（adb_test updated_by_name 同款手法）——前端拉成员表换名字在权限
    # （GET /members 要 ensure_member）和性能上都不对。null 有两种：没填负责人，
    # 或负责人账号已删；前端画法不同，不许混成「没有负责人」。
    owner_name: str | None = None
    project_public: bool = True
    produced: list[ProducedRef] = []
    # 蓝图 :1376 列表列「更新时间」：列一直在 TimestampMixin 里躺着，出参没给过，
    # 前端因此画不出这列（D79 登记时误记成「Mixin 自带所以已有」——库里有条 ≠ 接口给了）。
    updated_at: str | None = None


class ApiDebugIn(BaseModel):
    """调试入参：definition_id / request 二选一；variables 为调试临时最高优先级层。"""

    project_id: str
    definition_id: str | None = None
    request: RequestObject | None = None
    case_id: str | None = None
    env_id: str | None = None
    variables: dict[str, str] = {}
    # 草稿调试归属：编辑器里改着没保存的请求，运行记录仍挂在该接口名下（列表徽标靠它）
    subject_definition_id: str | None = None


class DebugOut(BaseModel):
    run_id: str
    ok: bool
    passed: bool
    status: int | None = None
    headers: dict[str, str] = {}
    body_text: str | None = None
    truncated: bool = False
    body_size: int = 0
    elapsed_ms: int = 0
    error: str | None = None
    assertions: list[dict] = []
    env_name: str | None = None


# —— 模块树（T9） ——
class ModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    count: int = 0  # 直属未回收接口数（含私有可见性过滤）
    children: list[ModuleNode] = []


class ModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class ModuleTreeOut(BaseModel):
    tree: list[ModuleNode] = []
    recycled: list[ModuleNode] = []


class ModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class ModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None  # 显式传入（含 null）即移动；缺省=不动父级（model_fields_set 判定）


class ModulePurgeIn(BaseModel):
    """彻底删除模块（§11.4.18）：confirm_name 与模块名逐字相等才动手。"""

    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ModulePurgeOut(BaseModel):
    """回执要说清动了什么：删了几层模块、有多少接口因此变成未分类。"""

    ok: bool = True
    purged_modules: int = 0
    detached_definitions: int = 0


class ModuleDeleteIn(BaseModel):
    project_id: str
    module_id: str


# —— 接口用例 + 数据集（T10） ——
PRIORITIES = {"P0", "P1", "P2", "P3"}


# 用例可对定义做的覆盖键（合并、校验、取消覆盖三处共用同一份口径）
OVERLAY_KEYS = ("method", "url", "params", "headers", "auth", "body", "timeout_ms")

class CaseOverlay(BaseModel):

    """用例对定义的按键覆盖层：缺省键 = 继承定义。"""

    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] | None = None
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    params: list[Pair] | None = None
    headers: list[Pair] | None = None
    auth: RequestAuth | None = None
    body: RequestBody | None = None
    timeout_ms: int | None = Field(default=None, ge=1, le=120000)

    @field_validator("params", "headers", mode="after")
    @classmethod
    def _pairs(cls, v):
        if v is None:
            return v
        for it in v:
            if len(it) != 2 or not all(isinstance(x, str) for x in it):
                raise ValueError('键值对必须是 ["key","value"] 形式')
        return v


class CaseOut(BaseModel):
    id: str
    project_id: str
    definition_id: str
    name: str
    priority: str
    request: dict | None = None
    assertions: list[dict] = []
    dataset_id: str | None = None
    sort: int = 0
    owner_id: str | None = None
    project_public: bool = True
    status: str = "normal"
    effective_request: dict | None = None  # 定义←覆盖 合并结果（可执行形态）
    produced: list[ProducedRef] = []


class CaseCreateIn(BaseModel):
    project_id: str
    definition_id: str
    name: str = Field(min_length=1, max_length=200)
    priority: str = "P2"
    request: CaseOverlay | None = None
    assertions: list[Assertion] = []
    dataset_id: str | None = None
    sort: int = 0
    project_public: bool = True

    @field_validator("priority")
    @classmethod
    def _p(cls, v: str) -> str:
        if v not in PRIORITIES:
            raise ValueError("优先级必须是 P0-P3")
        return v


# —— 执行引擎出口（1B T3）：内部服务，不出 HTTP、不进工具箱 ——
class CaseResolveIn(BaseModel):
    project_id: str
    case_id: str


class CaseResolveOut(BaseModel):
    """用例的**有效**执行形态：定义←覆盖层合并 + 断言 + 全量数据集行。

    与 api_debug 的有意分歧：不可执行时返回 executable=False + reason，而不是 422
    —— 引擎需要可判定的标记把步骤标 error 并写进报告，而不是中断整场执行。
    """

    case_id: str
    case_name: str
    definition_id: str
    definition_name: str
    priority: str = "P2"
    request: dict | None = None
    assertions: list[dict] = []
    dataset: dict | None = None  # {id, columns, rows}；引擎按行展开（§8.6）
    timeout_explicit: bool = True  # False = 用例没写 timeout_ms，可被环境超时覆盖（与 api_debug 同口径）
    executable: bool = True
    reason: str | None = None

class CaseListIn(BaseModel):
    project_id: str
    definition_id: str | None = None
    recycled: bool = False
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class CaseGetIn(BaseModel):
    project_id: str
    case_id: str


class CaseDeleteIn(BaseModel):
    """回收用例。force 是给「已经看见引用清单、确认要连带断掉场景步骤」的人用的第二段：
    第一段不带 force 只会 409 并把引用者列出来，所以 force 永远不可能被误触。"""

    project_id: str
    case_id: str
    force: bool = False


class CasePurgeIn(BaseModel):
    """彻底删除用例（§11.4.18）：confirm_name 与用例名逐字相等。用例名无唯一约束，
    这里要的是「你真的看清了要删哪条」，不是防重名。"""

    project_id: str
    case_id: str
    confirm_name: str = Field(min_length=1, max_length=200)

class CaseUpdateIn(BaseModel):
    project_id: str
    case_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    priority: str | None = None
    request: CaseOverlay | None = None
    assertions: list[Assertion] | None = None
    request_unset: list[str] = []  # 显式取消覆盖的键（恢复继承）；空 = 只加不减
    dataset_id: str | None = None
    dataset_set: bool = False  # 显式声明改绑/解绑数据集（dataset_id 可为 null）
    sort: int | None = None
    project_public: bool | None = None

    @field_validator("priority")
    @classmethod
    def _p(cls, v: str | None) -> str | None:
        if v is not None and v not in PRIORITIES:
            raise ValueError("优先级必须是 P0-P3")
        return v

    @field_validator("request_unset")
    @classmethod
    def _unset(cls, v: list[str]) -> list[str]:
        # 打错的键名必须当场拒：静默忽略会让用户以为已恢复继承，实际还在覆盖
        bad = [k for k in v if k not in OVERLAY_KEYS]
        if bad:
            raise ValueError("request_unset 只能是覆盖层键，收到：" + ", ".join(bad))
        return v


class DatasetIn(BaseModel):
    project_id: str
    dataset_id: str


class DatasetListIn(BaseModel):
    project_id: str
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class DatasetCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    columns: list[str]
    rows: list[list[str]]


class DatasetUpdateIn(BaseModel):
    project_id: str
    dataset_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    columns: list[str] | None = None
    rows: list[list[str]] | None = None


class DatasetOut(BaseModel):
    id: str
    project_id: str
    name: str
    columns: list[str]
    rows: list[list[str]]
    row_count: int = 0
    # 被多少条未回收用例引用：删除是 destructive，用户得在点之前就知道后果
    used_by: int = 0
    # 绑定它的用例（含回收站里的）是否还被未回收场景扣着 → 删除必 409。
    # 与 used_by 是两个数，不能合并：徽标说 0 条用例引用而删除却 409，
    # 是 1B 加了「回收站用例仍被场景引用」这道拦截后必然出现的缺口（RF9）。
    scenario_held: bool = False
    produced: list[ProducedRef] = []


# —— 导入向导（1E T4，§11.4.6）——
IMPORT_SOURCES = {"openapi3", "swagger2", "postman"}
# D26：一期只有 跳过/覆盖 两策略——「新版本」与版本历史二期打架，按钮都不出现。
IMPORT_STRATEGIES = {"skip", "overwrite"}


class ImportPreviewIn(BaseModel):
    """步骤①：三选一的源 + 文本/URL 二选一（URL 由后端代拉：trust_env=False/5s/2MB）。"""

    project_id: str
    source: str
    text: str | None = None
    url: str | None = None

    @field_validator("source")
    @classmethod
    def _s(cls, v: str) -> str:
        if v not in IMPORT_SOURCES:
            raise ValueError("source 只能是 openapi3/swagger2/postman")
        return v

    @model_validator(mode="after")
    def _one_source(self) -> ImportPreviewIn:
        if bool(self.text) == bool(self.url):
            raise ValueError("text 与 url 必须二选一（粘贴文本或给 URL）")
        return self


class ImportPreviewItem(BaseModel):
    name: str
    method: str
    path: str
    request: dict[str, Any]
    source_ref: str = ""
    exists: bool = False           # 冲突（method+归一路径 撞上现有接口）
    definition_id: str | None = None


class ImportPreviewOut(BaseModel):
    new_count: int = 0
    conflict_count: int = 0
    items: list[ImportPreviewItem] = []
    errors: list[str] = []         # 解析人话列表——「下载错误报告」的数据源


class ImportCommitItem(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    method: str
    path: str = Field(min_length=1, max_length=500)
    request: dict[str, Any]
    strategy: str = "overwrite"    # skip / overwrite（仅对冲突条目有意义）
    definition_id: str | None = None  # 冲突时前端回传预览给的现有 id


class ImportCommitIn(BaseModel):
    """步骤③的载荷：整批一事务——失败条目只记账，不污染事务；崩了整体不 commit。"""

    project_id: str
    items: list[ImportCommitItem] = Field(min_length=1, max_length=500)


class ImportFailure(BaseModel):
    name: str
    reason: str


class ImportCommitOut(BaseModel):
    ok: bool = True
    created: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    failures: list[ImportFailure] = []
    produced: list[ProducedRef] = []


# —— 导出备份（1E T5）——
class ApiExportIn(BaseModel):
    """勾选（definition_ids）或全量（缺省 = 项目内全部非回收接口）。"""

    project_id: str
    definition_ids: list[str] | None = Field(default=None, max_length=500)


class ApiExportOut(BaseModel):
    """openapi 是完整 OpenAPI3 文档（前端 blob 下载）；notes = 未导出/改写的人话如实报。"""

    openapi: dict[str, Any]
    exported: int = 0
    notes: list[str] = []
