"""T5 @service 装饰器与注册表（金线核心：一处标注五路同生）。"""
from __future__ import annotations

import pytest
from pydantic import BaseModel, Field

from app.core.registry import REGISTRY, ToolSpec
from app.core.service import ServiceCtx, service


class SampleIn(BaseModel):
    project_id: str
    name: str = Field(min_length=2, max_length=50)
    count: int = Field(ge=1, le=10)


class SampleOut(BaseModel):
    echo: str
    doubled: int


@service(
    perm="sample:thing:create",
    effect="write",
    name="_t5_sample_create",
    description="样例写服务（测试专用）",
    http={"method": "POST", "path": "/_t5/sample", "tags": ["_t5"], "status": 201},
)
async def sample_create(payload: SampleIn, ctx: ServiceCtx) -> SampleOut:
    assert ctx.entry in ("http", "agent", "schedule")
    return SampleOut(echo=payload.name, doubled=payload.count * 2)


@service(
    perm="sample:thing:read",
    effect="read",
    name="_t5_sample_read",
    description="样例读服务（隐藏于 http）",
    http=None,
)
async def sample_read(payload: SampleIn, ctx: ServiceCtx) -> SampleOut:
    return SampleOut(echo="read", doubled=0)


def test_json_schema_from_pydantic() -> None:
    spec = REGISTRY.get("_t5_sample_create")
    assert spec is not None
    js = spec.json_schema
    assert js["properties"]["name"].get("minLength") == 2
    assert js["properties"]["count"].get("minimum") == 1
    assert set(js["required"]) >= {"project_id", "name"}
    assert spec.effect == "write" and spec.perm == "sample:thing:create"


def test_duplicate_registration_raises() -> None:
    with pytest.raises(RuntimeError):
        REGISTRY.register(
            ToolSpec(
                name="_t5_sample_create", description="dup", json_schema={}, perm="x:y:read",
                effect="read", handler=sample_create, model=SampleIn, tool=True, resident=False, http=None,
            )
        )


def test_perm_points_collected() -> None:
    pts = REGISTRY.perm_points()
    assert {"sample:thing:create", "sample:thing:read"} <= pts


def test_list_tools_filters_by_perms() -> None:
    from app.modules.iam.roles import match_perm

    def visible(perms: set[str]) -> set[str]:
        return {t.name for t in REGISTRY.list_tools(perms)}

    # READONLY（*:read）只见读工具
    ro = {"*:read"}
    vis = visible(ro)
    assert "_t5_sample_read" in vis and "_t5_sample_create" not in vis
    # 管理员全见
    assert {"_t5_sample_read", "_t5_sample_create"} <= visible({"*"})
    assert match_perm({"*:read"}, "sample:thing:read") is True


async def test_http_route_created_and_perm_enforced(client, make_user) -> None:
    # 系统管理员：路由存在且可通
    _, h_root = await make_user("t5root", admin=True)
    r = await client.post("/api/v1/_t5/sample", json={"project_id": "p1", "name": "ab", "count": 3}, headers=h_root)
    assert r.status_code == 201, r.text
    assert r.json() == {"echo": "ab", "doubled": 6}

    # 非成员/不存在项目 → 数据权限门 403 forbidden（与不存在项目同码同文案）
    _, h_plain = await make_user("t5plain")
    r2 = await client.post("/api/v1/_t5/sample", json={"project_id": "p1", "name": "ab", "count": 3}, headers=h_plain)
    assert r2.status_code == 403
    assert r2.json()["code"] == "forbidden"

    # 成员但权限点不足（READONLY 无写权限）→ 403 insufficient_permission
    _, h_boss = await make_user("t5boss")
    pr = await client.post("/api/v1/projects", json={"name": "t5proj"}, headers=h_boss)
    pid = pr.json()["id"]
    member = await make_user_named(client, h_boss, pid, "t5ro", "READONLY")
    r2b = await client.post("/api/v1/_t5/sample", json={"project_id": pid, "name": "ab", "count": 3}, headers=member)
    assert r2b.status_code == 403, r2b.text
    assert r2b.json()["code"] == "insufficient_permission"

    # 非法 payload → 422 validation_failed
    r3 = await client.post("/api/v1/_t5/sample", json={"project_id": "p1", "name": "a", "count": 99}, headers=h_root)
    assert r3.status_code == 422
    assert r3.json()["code"] == "validation_failed"


async def make_user_named(client, boss_headers, pid, account, role):
    """造用户并加为项目成员，返回其 headers。"""
    from app.core.db import get_sessionmaker
    from app.core.security import create_access_token, hash_password
    from app.modules.iam.models import User

    async with get_sessionmaker()() as s:
        u = User(account=account, name=account, password_hash=hash_password("Passw0rd!"), status="active")
        s.add(u)
        await s.commit()
        uid = u.id
    r = await client.put(f"/api/v1/projects/{pid}/members/{uid}", json={"role_code": role}, headers=boss_headers)
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + create_access_token(uid)}


def test_build_router_registered_on_app(client) -> None:
    app = client._transport.app  # type: ignore[attr-defined]
    paths = set(app.openapi()["paths"].keys())
    assert "/api/v1/_t5/sample" in paths


def test_every_http_service_is_routed_by_real_app(client) -> None:
    """凡是标了 http= 的服务，真 app 上就必须有这条路由——结构性钉死。

    来历：T14 的 artifact_download 写完后自测全绿，但 main.py 的 import 行留给「主线」补，
    而它的测试模块自己 import 了 artifacts，于是注册表里有、路由也建得出来，**唯独真
    app 上没有**——下载端点只活在 pytest 里。这类缺口不会让任何单测变红，只能这样兜。

    为什么不查注册表：模块没被 import 时它压根不在 REGISTRY 里，查不出「漏 import」；
    全量跑时别的测试文件又会替它 import，生产是坏的而测试是绿的。

    为什么不就地扫源码（这一版改掉了旧做法，别改回去）：旧实现是
    `inspect.getsource(create_app)` 里找字面量 `import app.modules.xxx`。那测的其实是
    main.py 的**写法**而不是路由的**事实**——1C+ 为了消 mypy 的 8 条报错，把那串
    `import app.modules.x  # noqa` 换成了 `_SERVICE_MODULES` 名字清单 + importlib，
    运行时一条路由都没少（91 条全在），门却当场红了。门红是因为它瞎，不是因为产品坏；
    照着红字把 import 写回去只是让正则重新满意，产品没得到任何多一点的保证。
    现在拉 tests/routing_probe.py 子进程：全新解释器只 import app.main，谁都没替它 import，
    「谁没被 create_app 带进来」「哪条注册过的路径不在 app 上」都由解释器回答，
    与 main.py 用哪种 import 写法彻底解耦。
    """
    import json
    import subprocess
    import sys
    from pathlib import Path

    probe = Path(__file__).parent / "routing_probe.py"
    proc = subprocess.run(
        [sys.executable, str(probe)], capture_output=True, text=True, timeout=180,
        cwd=str(Path(__file__).parents[1]),
    )
    assert proc.returncode == 0, f"探针子进程退出码 {proc.returncode}：\n{proc.stderr}"
    # 探针只 print 一行 JSON；stderr 可能有库的噪声，所以只在解析失败时把它一起报出来。
    try:
        got = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise AssertionError(f"探针输出不是 JSON：\nstdout={proc.stdout!r}\nstderr={proc.stderr!r}") from None

    # 基线脏 = 有领域模块在 app.main 之外被顶层 import 进来，那样「不在场 ⇒ create_app
    # 没 import 它」的推断就不成立了。今天为零；哪天不为零要改的是这个断言的理由，不是删断言。
    assert got["preexisting"] == [], ("探针基线不干净，app.main 之外就有领域模块在场，"
                                     "「漏 import」判定失效：" + "、".join(got["preexisting"]))
    assert not got["not_imported"], ("以下模块带 http 路由却没被 create_app import（端点不会挂上真 app）：\n"
                                     + "\n".join(got["not_imported"]))
    # 扫描口径自检：注册表里有 http 路由、探针的源码扫描却没把这个模块算进来 ⇒ 扫描瞎了
    # （有人把 http={...} 的字面写法抽成了常量，或把服务挪出 app/）。用这条不变量代替
    # 「模块数 >= N」的魔数——模块数会因正当重构增减，这条只在口径真的漏了时才红。
    assert not got["scan_blind"], "探针扫描漏掉这些已注册 http 路由的模块，口径失效：" + "、".join(got["scan_blind"])
    assert not got["missing_paths"], "已注册但未建路由：" + "、".join(got["missing_paths"])

    # 真 app（client 起的那个）上也得一条不缺——探针证的是 create_app，这里证的是装配后的实例。
    paths = set(client._transport.app.openapi()["paths"].keys())  # type: ignore[attr-defined]
    orphans = [spec.name for spec in REGISTRY.all()
               if spec.http is not None and "/api/v1" + spec.http["path"] not in paths]
    assert not orphans, "已注册但未建路由：" + "、".join(orphans)


def test_entry_vocabulary_normalization() -> None:
    """actor 快照里的 entry 折算回词表（§4 audit_log.entry：http/agent/schedule）。

    这条钉的是「未知一律 http」这个方向，而不只是几个返回值。理由是**不对称的后果**：
    entry 只有 `== "agent"` 会改变分支（trigger 派生、审批口径），所以
    - 把认不出的当 http ⇒ 最多是审计上少标一次「Pilot 干的」；
    - 把认不出的当 agent ⇒ 给一次人点的操作伪造了「Pilot 干的」，那是审计里最不该有的错。
    旧代码在这里写 `or "web"`，而 "web" 从来不在词表里，等价于「未知的第三种」；
    正因如此，光测「认不出→http」不够，还得测**存量快照**里那个 "web" 今天读出来是什么，
    否则改了折算规则也没人知道老数据会被标成什么。
    """
    from app.core.service import normalize_entry

    # 词表内的三个原样通过——agent 必须原样，否则"Pilot 干的"这条 attribution 会整批丢
    assert normalize_entry("http") == "http"
    assert normalize_entry("agent") == "agent"
    assert normalize_entry("schedule") == "schedule"
    # 词表外的一切（含旧代码亲手写下的 "web"、空串、None、非字符串）都落回 http
    for junk in ("web", "WEB", "", None, 7, ["http"], object()):
        assert normalize_entry(junk) == "http", f"{junk!r} 应折算成 http"


async def test_ctx_from_actor_preserves_agent_entry(session) -> None:
    """引擎由快照重建 ctx 时，agent 发起的不能被改写成 http（审计与 trigger 都读它）。"""
    from app.core.service import ctx_from_actor

    agent = ctx_from_actor({"user_id": "u1", "entry": "agent", "perms": ["api:case:read"]}, session)
    assert agent.entry == "agent"
    assert agent.perms == {"api:case:read"}  # list → set：require 要按集合读
    legacy = ctx_from_actor({"user_id": "u1", "entry": "web"}, session)
    assert legacy.entry == "http"
    missing = ctx_from_actor({"user_id": "u1"}, session)
    assert missing.entry == "http"

async def test_sync_perm_points(session) -> None:
    from sqlalchemy import select

    from app.modules.iam.models import PermPoint
    from app.modules.iam.registry_sync import sync_perm_points

    await sync_perm_points(session)
    codes = {r.code for r in (await session.execute(select(PermPoint))).scalars().all()}
    assert {"sample:thing:create", "sample:thing:read"} <= codes
    await sync_perm_points(session)  # 幂等
