"""D102：Agent 角色级模式门（§11.4.35 双层门的角色那一半）。

第五十轮裁「做」的前提（第二十八轮更正 ②/D166）：FULL 是全仓唯一「什么都不拦」的档
（PLAN 在 dispatcher 挡写，ASK 抛 NeedApproval 而无 approve 端点 = 永远挂起），
**FULL == 写能力**，建会话选 FULL 必须过 agent:full:use，default-deny MEMBER/READONLY，
SYSTEM_ADMIN/PROJECT_ADMIN 命中既有通配。钉四层：

① 注册位：agent:full:use 进 REGISTRY.perm_points()（sync_perm_points 零迁移入库的前提，
   §15 纪律 7 与 metatools 两位同款），且**不进** Agent 工具面（tool=False，模型看不见）；
② 角色表：match_perm 逐内置角色 × FULL 位的真值表（default-deny 的落点是 MEMBER 那条
   "-agent:full:*" deny——"*" 正通配会静默放行，这条 deny 是整个案的 crux）；
③ 服务端门：MEMBER + mode=FULL → 403 forbidden（且零落行——只断状态码的话
   「先落行再报错」也能过，test_session_create_requires_project_membership 同款纪律）；
   PLAN/ASK 不设位，MEMBER 照旧 201（门只拦 FULL，不许顺手打死只读档）；
   PROJECT_ADMIN + FULL → 201（放行的那半边）；
④ 门在成员门之后：非成员 + FULL 同 403 forbidden（先成员后位，不泄露 FULL 这件事）。

夹具复用 test_agent_api 的 _mk/make_user_named 路线（远端 MySQL 临时 schema，conftest 建）。
"""
from __future__ import annotations

import pytest_asyncio

from tests.test_registry import make_user_named


@pytest_asyncio.fixture()
async def bus():
    """与 test_agent_api 同款 fakeredis：本文件的 leg 不发消息，但 app 装配期事件总线要可建。"""
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


# —— ① 注册位 ——

def _ensure_routes_imported() -> None:
    """注册发生在 app.modules.agent.routes 的 import 时（与 metatools 的 import 即注册同机制）。

    不能蹭 client 夹具的 create_app：本组用例不起库（与 r157 自己 importlib 的理由同款）。
    重复 import 是 no-op（模块级守卫在 REGISTRY.register 查重之外再兜一层不会发生）。
    """
    import app.modules.agent.routes  # noqa: F401


def test_full_perm_registered_as_perm_point() -> None:
    """agent:full:use 走注册表投影（perm_points → registry_sync 入库），零迁移。"""
    from app.core.registry import REGISTRY

    _ensure_routes_imported()
    assert "agent:full:use" in REGISTRY.perm_points()


def test_full_perm_not_an_agent_tool() -> None:
    """注册只吃权限点那一路：tool=False → list_tools 不收，模型的工具声明面永远没有它。

    反向变异：把 tool=True 漏出来 = 给模型递一张它不该有的「模式开关」声明。
    """
    from app.core.registry import REGISTRY

    _ensure_routes_imported()
    spec = REGISTRY.get("agent_full_mode_perm")
    assert spec is not None
    assert spec.tool is False and spec.http is None
    names = {t.name for t in REGISTRY.list_tools(None)}
    assert "agent_full_mode_perm" not in names


async def test_sync_perm_points_lands_full_bit(session) -> None:
    """sync_perm_points 把它落进 perm_point 表（角色编辑页的权限树数据源，§15 纪律 7）。"""
    from sqlalchemy import select

    from app.modules.iam.models import PermPoint
    from app.modules.iam.registry_sync import sync_perm_points

    _ensure_routes_imported()
    await sync_perm_points(session)
    codes = {r.code for r in (await session.execute(select(PermPoint))).scalars().all()}
    assert "agent:full:use" in codes


# —— ② 角色表真值（match_perm 直接量，不经过任何 HTTP）——

def test_frontend_fallback_table_synced_on_full_bit() -> None:
    """前端 perms.ts ROLE_PATTERNS.MEMBER 兜底表也带 -agent:full:*（r158 式跨语言防漂钉）。

    前端表只在服务端没随项目下发 my_perms 时兜底；它比生产表宽一个位 = 旧快照下的
    MEMBER 在前端多看见一个按了必 403 的档位。后端改 MEMBER 的 deny 而前端不跟，
    本例红（与 R158 对 WRITE_TAIL 的做法同纪律：手抄表必须被对着源头钉）。
    """
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2] / "web" / "src" / "auth" / "perms.ts")
    member_line = next(line for line in src.read_text(encoding="utf-8").splitlines()
                       if "MEMBER:" in line)
    assert '"-agent:full:*"' in member_line, (
        "perms.ts 的 MEMBER 兜底行没有 -agent:full:*，与 iam/roles.BUILTIN_ROLES 漂移")


def test_match_perm_builtin_roles_full_bit() -> None:
    """四内置角色 × agent:full:use 真值表。

    这是 default-deny 的 crux：MEMBER 的 "*"-glob 会静默放行 FULL（它的两条 deny
    -*:delete/-*:manage 罩不住 :use 尾词），靠 "-agent:full:*" 域内 deny 收回；
    READONLY 的 "*:read" 结构上吃不到 :use。改 roles.py 的任何一侧都必须过这张表。
    """
    from app.core.permissions import match_perm
    from app.modules.iam.roles import role_by_code

    def patterns(code: str) -> set[str]:
        role = role_by_code(code)
        assert role is not None
        return set(role["perms"])

    assert match_perm(patterns("SYSTEM_ADMIN"), "agent:full:use") is True
    assert match_perm(patterns("PROJECT_ADMIN"), "agent:full:use") is True
    assert match_perm(patterns("MEMBER"), "agent:full:use") is False
    assert match_perm(patterns("READONLY"), "agent:full:use") is False


# —— ③④ 服务端门 ——

async def _member_project(client, make_user, tag, role):
    """owner（=PROJECT_ADMIN）+ 一个挂 role 的成员 + 默认 CHAT 模型，返回 (pid, h_owner, h_member)。

    默认模型是建会话前置条件（routes.create_session 无 model_id 时取 is_default CHAT，
    没有则 422）——_mk 同款播种；本文件的门必须量在 403/201 上，不能让 422 抢跑。
    """
    from app.core.db import get_sessionmaker
    from app.modules.model_cfg.models import ModelConfig

    _, h_owner = await make_user("d102o_" + tag)
    r = await client.post("/api/v1/projects", json={"name": "d102proj_" + tag}, headers=h_owner)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    async with get_sessionmaker()() as s:
        s.add(ModelConfig(name="d102m_" + tag, model_type="CHAT", protocol="OPENAI_COMPAT",
                          base_url="fake://basic_two_tools", model_name="fake",
                          is_default=True, enabled=True))
        await s.commit()
    h_member = await make_user_named(client, h_owner, pid, "d102m_" + tag, role)
    return pid, h_owner, h_member


async def test_member_full_denied_zero_rows(client, make_user, bus) -> None:
    """MEMBER + FULL → 403 forbidden；且会话行数必须为零（不许先落行再报错）。"""
    from sqlalchemy import func, select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentSession

    pid, _h_owner, h_member = await _member_project(client, make_user, "full", "MEMBER")
    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"},
                          headers=h_member)
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["code"] == "forbidden", body
    # D38 契约字段：缺的位名进 details.perm（与 ServiceCtx.require 同形），但 code 仍是
    # forbidden——按位拒绝不借机泄露「项目存在」以外的东西。
    assert (body.get("details") or {}).get("perm") == "agent:full:use", body
    async with get_sessionmaker()() as s:
        n = (await s.execute(select(func.count()).select_from(AgentSession)
                             .where(AgentSession.project_id == pid))).scalar_one()
    assert n == 0


async def test_member_plan_ask_still_allowed(client, make_user, bus) -> None:
    """门只拦 FULL：MEMBER 的 PLAN/ASK/默认档照旧 201（缺位不许顺手打死只读档）。"""
    pid, _h_owner, h_member = await _member_project(client, make_user, "planask", "MEMBER")
    for mode in ("PLAN", "ASK", None):
        payload = {"project_id": pid} if mode is None else {"project_id": pid, "mode": mode}
        r = await client.post("/api/v1/agent/sessions", json=payload, headers=h_member)
        assert r.status_code == 201, f"mode={mode}: {r.text}"
        assert r.json()["mode"] == (mode or "ASK")


async def test_project_admin_full_allowed(client, make_user, bus) -> None:
    """PROJECT_ADMIN（"*" + "-system:*"）命中 FULL 位 → 201 且回显 mode=FULL。"""
    pid, h_owner, _h_member = await _member_project(client, make_user, "admin", "MEMBER")
    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"},
                          headers=h_owner)
    assert r.status_code == 201, r.text
    assert r.json()["mode"] == "FULL"


async def test_readonly_full_denied(client, make_user, bus) -> None:
    """READONLY 结构上吃不到 :use（"*:read" 后缀通配）→ FULL 403。"""
    pid, _h_owner, h_ro = await _member_project(client, make_user, "ro", "READONLY")
    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"},
                          headers=h_ro)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "forbidden"


async def test_outsider_full_denied_same_shape(client, make_user, bus) -> None:
    """非成员 + FULL：成员门先落，403 forbidden 与「项目不存在」同形——FULL 门不泄露任何信息。"""
    pid, _h_owner, _h_member = await _member_project(client, make_user, "out", "MEMBER")
    _, h_outsider = await make_user("d102x_out")
    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"},
                          headers=h_outsider)
    assert (r.status_code, r.json()["code"], r.json()["message"]) == (403, "forbidden", "无此项目权限")
