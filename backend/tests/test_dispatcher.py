"""T6 审计日志 + 工具分发器（模式门 / 权限门 / 校验自纠 / 审计）。"""
from __future__ import annotations

import pytest
from pydantic import BaseModel, Field

from app.core.service import ServiceCtx, service


class DIn(BaseModel):
    project_id: str
    value: str = Field(min_length=3)


class DOut(BaseModel):
    echo: str


@service(perm="demosample:read", effect="read", name="_t6_read", description="t6 读", http=None)
async def t6_read(payload: DIn, ctx: ServiceCtx) -> DOut:
    return DOut(echo=payload.value)


@service(perm="demosample:write", effect="write", name="_t6_write", description="t6 写", http=None)
async def t6_write(payload: DIn, ctx: ServiceCtx) -> DOut:
    return DOut(echo="w:" + payload.value)


@service(perm="demosample:boom", effect="write", name="_t6_boom", description="t6 异常", http=None)
async def t6_boom(payload: DIn, ctx: ServiceCtx) -> DOut:
    raise RuntimeError("炸了")


def _ctx(user_id="u1", perms=None, db=None) -> ServiceCtx:
    return ServiceCtx(entry="agent", user_id=user_id, perms=perms if perms is not None else {"*"}, db=db)


@pytest.fixture
def disp(session):
    from app.modules.agent.dispatcher import ToolDispatcher

    return ToolDispatcher(session)


async def test_read_passthrough(disp, session) -> None:
    r = await disp.call("_t6_read", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="PLAN", grants=set())
    assert r.ok is True and r.content["echo"] == "abc"


async def test_plan_mode_rejects_write(disp, session) -> None:
    r = await disp.call("_t6_write", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="PLAN", grants=set())
    assert r.ok is False and "只读" in (r.error or "")


async def test_ask_mode_approval_required(disp, session) -> None:
    from app.modules.agent.dispatcher import NeedApproval

    with pytest.raises(NeedApproval) as ei:
        await disp.call("_t6_write", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="ASK", grants=set(),
                        tool_call_id="tc1")
    assert ei.value.tool_name == "_t6_write" and ei.value.tool_call_id == "tc1"
    r = await disp.call("_t6_write", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="ASK",
                        grants={"_t6_write"}, tool_call_id="tc2")
    assert r.ok is True
    r2 = await disp.call("_t6_write", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="FULL", grants=set())
    assert r2.ok is True


async def test_unknown_and_no_perm_byte_identical(disp, session) -> None:
    """无权限与不存在工具：返回字节一致，不泄露工具存在性。"""
    ctx = _ctx(perms={"demosample:read"}, db=session)
    r_unknown = await disp.call("no_such_tool_xyz", {}, ctx, mode="FULL", grants=set())
    r_noperm = await disp.call("_t6_write", {"project_id": "p", "value": "abc"}, ctx, mode="FULL", grants=set())
    assert r_unknown.ok is False and r_noperm.ok is False
    assert r_unknown.model_dump() == r_noperm.model_dump()


async def test_invalid_args_returns_error_with_field(disp, session) -> None:
    r = await disp.call("_t6_read", {"project_id": "p", "value": "x"}, _ctx(db=session), mode="FULL", grants=set())
    assert r.ok is False
    assert "value" in (r.error or "")


async def test_handler_exception_captured(disp, session) -> None:
    r = await disp.call("_t6_boom", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="FULL", grants=set())
    assert r.ok is False and "炸了" in (r.error or "")


async def test_audit_written(disp, session) -> None:
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    await disp.call("_t6_read", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="FULL", grants=set())
    rows = (await session.execute(select(AuditLog))).scalars().all()
    assert len(rows) == 1
    a = rows[0]
    assert a.entry == "agent" and a.action == "_t6_read" and a.ok is True and a.user_id == "u1"
    await disp.call("_t6_boom", {"project_id": "p", "value": "abc"}, _ctx(db=session), mode="FULL", grants=set())
    rows = (await session.execute(select(AuditLog).where(AuditLog.action == "_t6_boom"))).scalars().all()
    assert len(rows) == 1 and rows[0].ok is False and "炸了" in (rows[0].diff or {}).get("error", "")
