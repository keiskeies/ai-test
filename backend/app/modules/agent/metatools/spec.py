"""元工具的 ToolSpec 手写注册（R146 形状；1F T0 = 骨架，实现体在 T1/T2 回填）。

R146 形状（1F 计划 T0 原文）：http=None（无 HTTP 面，build_router 天然挡掉）、
tool=True（进 list_tools 的工具声明面）、resident=True（§9.2 分层的最小集——取证 ④：
字段在 registry 里但全仓出现 0 次，1F 首批元工具就是它的第一个真实用户）、
effect 全线 "read"（D31：元工具不落业务数据，只产事件与卡片，PLAN 模式必须可用）、
perm 按取证 ⑦ 两位：读/盘点三件 = agent:meta:read（以 :read 结尾，落进 READONLY 的
`*:read` glob），计划/卡片五件 = agent:plan:write（READONLY 吃不到——PLAN 门看
effect、角色门看 perm，两者正交，见 dispatcher 模式门）。

model 用各工具的 Pydantic 输入模型：dispatcher.call 走 spec.model.model_validate(args)，
校验失败回注模型自纠（Review Focus 3），所以模型即契约，T1/T2 只加字段不改机制。

T0 骨架承诺（诚实条款）：八个 handler 全体抛 NotImplementedError——注册是真的
（schema/权限位/审计面全活），业务逻辑是零。T1 回填 read_tools.py（读三件已接真
handler，经 REAL_HANDLERS 装配），T2 回填 card_tools.py；未回填的件任何调用方拿到的
都是明确异常，不是假的空结果。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.registry import REGISTRY, ToolSpec
from app.core.service import ServiceCtx

META_READ_PERM = "agent:meta:read"
PLAN_WRITE_PERM = "agent:plan:write"


def _todo(tool_name: str) -> str:
    return f"元工具 {tool_name} 尚未实现（1F T0 只落注册骨架，实现体在 T1/T2）"


# —— 输入模型：字段按 §6.2 `:540` 与 T1/T2 的任务形状先行钉住，实现批只增不改 ——


class GetProjectOutlineIn(BaseModel):
    project_id: str


class SearchTestAssetsIn(BaseModel):
    project_id: str
    kind: str | None = None
    keyword: str | None = None
    module: str | None = None


class SearchToolsIn(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)


class ReadSkillIn(BaseModel):
    # name 与 skills/<name>/SKILL.md 的目录名一致；错误时 detail 里带可用清单自纠
    name: str = Field(min_length=1, max_length=64)


class ProposeScenarioPlansIn(BaseModel):
    project_id: str
    # T2 的门：每个 plan 的 graph 先过 scenario/graph.py 结构校验再出卡——
    # 骨架期只钉「plans 非空列表」，元素形状由 T2 收紧。
    plans: list[dict[str, Any]] = Field(min_length=1)


class AskUserIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    options: list[str] = []


class ProposePlanIn(BaseModel):
    items: list[dict[str, Any]] = Field(min_length=1)


class UpdatePlanItemIn(BaseModel):
    id: str
    state: str = Field(pattern="^(pending|doing|done|skipped)$")


class SuggestOpenPageIn(BaseModel):
    route: str
    # T2 钉 route 白名单常量表（bench/scenes/…，白名单外 ok=False）；
    # 骨架期 params 先钉成扁平字符串表，避免 schema 里出现自由 JSON 洞。
    params: dict[str, str] = {}


def _skeleton_handler(tool_name: str):
    """骨架 handler 工厂：调用即抛 NotImplementedError。宁抛不装——假结果会顺着
    dispatcher 的回注链骗过模型（纪律 1），异常则原样落 ok=False 审计（dispatcher 的
    except 捕获回注），读代码与读审计的人都能看到「未实现」这件事本身。"""

    async def handler(payload: BaseModel, ctx: ServiceCtx) -> Any:
        raise NotImplementedError(_todo(tool_name))

    return handler


# T1/T2 回填口：实现模块（read_tools / card_tools）在模块尾部把自己的真 handler
# 按名字登记进来，register_metatools() 装配时按名字取——没登记的名字继续吃骨架。
# spec 不 import 实现模块（实现模块 import spec 的输入模型，反向 import 是循环）；
# 装配顺序由 __init__.py 钉：先 import 实现模块（触发自登记），再 register_metatools()。
REAL_HANDLERS: dict[str, Any] = {}


def _spec(name: str, description: str, model: type[BaseModel], perm: str) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=description,
        json_schema=model.model_json_schema(),
        perm=perm,
        effect="read",
        handler=REAL_HANDLERS.get(name) or _skeleton_handler(name),
        model=model,
        tool=True,
        resident=True,
        http=None,
    )


# 顺序即注册顺序；名字是 §6.2 `:540` 清单，与 service 装饰器注册的工具同池，撞名靠 register 查重兜底。
_METATOOLS: tuple[tuple[str, str, type[BaseModel], str], ...] = (
    ("get_project_outline", "盘点项目模块树与各类测试资产计数摘要（T1 实现）",
     GetProjectOutlineIn, META_READ_PERM),
    ("search_test_assets", "按关键词跨模块检索测试资产，回收不可见，降级态如实标注（T1 实现）",
     SearchTestAssetsIn, META_READ_PERM),
    ("search_tools", "按关键词检索工具声明子集，供当轮载入（§9.2 一期最小实现，T1）",
     SearchToolsIn, META_READ_PERM),
    ("read_skill", "读取指定 Skill 全文（D266 渐进披露；allowed-tools 会限缩本轮工具）",
     ReadSkillIn, META_READ_PERM),
    ("propose_scenario_plans", "产出 ≥2 个候选场景方案卡（graph 过结构校验，T2 实现）",
     ProposeScenarioPlansIn, PLAN_WRITE_PERM),
    ("ask_user", "向用户提问并给出选项（不挂起运行，D32，T2 实现）",
     AskUserIn, PLAN_WRITE_PERM),
    ("propose_plan", "产出多步计划列表卡（§11.4.33，T2 实现）",
     ProposePlanIn, PLAN_WRITE_PERM),
    ("update_plan_item", "原地更新计划项状态（同名工具最新结果渲染，T2 实现）",
     UpdatePlanItemIn, PLAN_WRITE_PERM),
    ("suggest_open_page", "建议跳转页面（route 白名单外拒绝，T2 实现）",
     SuggestOpenPageIn, PLAN_WRITE_PERM),
)

META_TOOL_NAMES: tuple[str, ...] = tuple(t[0] for t in _METATOOLS)

_registered = False


def register_metatools() -> None:
    """手写注册八个元工具（main.py 经 import 本包触发一次）。

    幂等守卫只挡「本函数被重复调用」（测试直调/装配重入）；与装饰器注册的名字相撞
    仍然照抛 RuntimeError——那是真冲突，要红在启动而不是静默覆盖。
    """
    global _registered
    if _registered:
        return
    for name, description, model, perm in _METATOOLS:
        REGISTRY.register(_spec(name, description, model, perm))
    _registered = True
