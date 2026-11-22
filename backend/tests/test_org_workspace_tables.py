"""org / workspace 一期建表钉（§4.1「[三期] 启用,一期仅建表」）。

钉四件事：
  ① 迁移后 information_schema 里真有这两张表（0019 真的落了库，不是只写了脚本）；
  ② ORM 能插入并读回（模型列和迁移列对得上——只查 information_schema 钉不出这个）；
  ③ org.code 唯一约束在 DB 层生效（重复 code 必须 IntegrityError，不是靠服务层自觉）；
  ④ project **没有** workspace_id——这是 §4.1 写明的三期项（「[三期]补 workspace_id
     并回填」），一期提前加列就是半截功能树（§13 纪律 1）。将来三期真要加，
     必须连这条断言一起改，改的人就被迫先读 §4.1。
"""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.modules.iam.models import Org, Project, Workspace


async def test_org_and_workspace_tables_exist(session) -> None:
    """① information_schema：0019 之后两张表都在当前 schema 里。"""
    rows = (await session.execute(
        text("SELECT table_name FROM information_schema.tables "
             "WHERE table_schema = DATABASE() AND table_name IN ('org', 'workspace')")
    )).scalars().all()
    assert set(rows) == {"org", "workspace"}, rows


async def test_insert_and_read_back_orm(session) -> None:
    """② ORM 往返：Org + Workspace 插入、读回，字段原样。"""
    from sqlalchemy import select

    org = Org(name="Acme", code="acme")
    session.add(org)
    await session.flush()
    ws = Workspace(org_id=org.id, name="platform")
    session.add(ws)
    await session.commit()

    got_org = await session.scalar(select(Org).where(Org.code == "acme"))
    assert got_org is not None and got_org.name == "Acme"
    # TimestampMixin 的默认值真的落库（不是 NULL 撞 NOT NULL）
    assert got_org.created_at is not None and got_org.updated_at is not None
    got_ws = (await session.execute(
        select(Workspace).where(Workspace.org_id == org.id))).scalars().all()
    assert [w.name for w in got_ws] == ["platform"]


async def test_org_code_unique(session) -> None:
    """③ code 重复必须炸在 DB（unique=True 建了真约束，不是摆设）。"""
    session.add(Org(name="A", code="dup"))
    await session.flush()
    session.add(Org(name="B", code="dup"))
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


async def test_project_has_no_workspace_id_yet(session) -> None:
    """④ 三期钉：project 此刻**不许**有 workspace_id（§4.1 明示三期才补列并回填）。

    若三期按蓝图加列，删掉本断言并在迁移里补回填——不许绕过本测试悄悄加。
    """
    cols = (await session.execute(
        text("SELECT column_name FROM information_schema.columns "
             "WHERE table_schema = DATABASE() AND table_name = 'project'")
    )).scalars().all()
    assert "workspace_id" not in cols, \
        "workspace_id 是 §4.1 的三期项，一期建了半截功能树（见 0019 迁移文档字符串）"
    # 顺带钉模型侧也干净：ORM 类同样不许长出这个属性
    assert not hasattr(Project, "workspace_id")
