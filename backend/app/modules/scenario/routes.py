"""场景执行 SSE 通道（T11）：GET /api/v1/events/run/{run_id}。

SSE 不是 @service：返回 StreamingResponse、无 Pydantic 出参，走不了「路由=注册表投影」
那条金线——沿用 agent SSE 的显式 router 手法（ledger R26：SSE 端点住模块 routes.py）。

依赖必须由装配层注入（落地裁定③）：契约 1 把 scenario 与 iam 判了独立性，
`get_current_user` 是 iam 的私有依赖，本模块 import 它就破契约——照 `core.build_router`
的同款形状出 `build_scenario_router(*, get_db_dep, get_user_dep, user_model)`，
`create_app` 注入。鉴权复用 `core.build_ctx`：与 @service 同一条数据权限门
（build_ctx 内已做 ensure_project_access：非成员/不存在 → 403），再 require 读位。

顺序纪律（R47 的消费端）：先按 run_id+project_id 定位 run（跨项目 404，与 report_get
同尺不泄露存在性），再建流；流内「先订阅后重放」由 core.sse 保证。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.service import build_ctx
from app.core.sse import sse_response
from app.modules.scenario.engine.events import replay_events


async def build_run_sse(db: AsyncSession, request: Request, project_id: str,
                        run_id: str, cursor: int | None) -> Any:
    """已鉴权后的建流（测试直调入口，agent 的 build_agent_sse 同法）。

    session 生命周期：SSE 流的存活期远长于 HTTP 依赖注入的 session 约定——与 agent
    同一处理，调用方（路由/测试）给一条独立 session。重放只读 run_event，安全。

    **建流前换读快照**（D11 首帧丢失的第二半）：MySQL 实测 REPEATABLE-READ，鉴权与
    「运行存在性」两处 SELECT 已经把快照钉在鉴权那一刻，重放若沿用就查不到其后才 commit
    的事件——而直播订阅也未必收到它，首帧两头落空。rollback 之后第一条 SELECT 起新事务，
    快照晚于订阅建立，窗口才闭合。放这里而不是放 replay_events 里：那条函数也服务 REST 路，
    回滚别人的请求事务会丢掉调用方未提交的写。此处到这一行为止只做过读，回滚不损失任何东西。
    """
    await db.rollback()
    return sse_response(request, "run." + run_id,
                        lambda cur: replay_events(db, run_id, cur), cursor)


def build_scenario_router(*, get_db_dep: Any, get_user_dep: Any, user_model: Any) -> APIRouter:
    """由装配层注入 iam 依赖后生成 run SSE 路由（契约 1 的正解：依赖注入，不是 import）。"""
    router = APIRouter(tags=["scenario"])

    @router.get("/events/run/{run_id}")
    async def run_events(run_id: str, request: Request, project_id: str = Query(...),
                         cursor: int | None = Query(default=None),
                         db: AsyncSession = Depends(get_db_dep),
                         user: user_model = Depends(get_user_dep)):
        # build_ctx 带 project_id 即走数据权限门：非成员/项目不存在 → 403（R22 口径）
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("api:run:read")
        from app.modules.execution.models import RunRecord

        hit = (await db.execute(
            select(RunRecord.id).where(RunRecord.id == run_id,
                                       RunRecord.project_id == project_id)
        )).first()
        if hit is None:
            # 项目成员 + 别的 run → 404（report_get 同尺：不泄露存在性）
            raise ApiError("not_found", "运行不存在", 404, {"run_id": run_id})
        return await build_run_sse(db, request, project_id, run_id, cursor)

    return router


__all__ = ["build_run_sse", "build_scenario_router"]
