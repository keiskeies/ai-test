"""T8 api_definition：金线全形（@service + 域模型 + produced 协议 + 乐观锁）。"""
from __future__ import annotations

REQ = {
    "method": "GET",
    "url": "http://127.0.0.1:9999/order/1",
    "headers": [["X-Tenant", "t1"]],
    "params": [["lang", "zh"]],
    "body": {"type": "none"},
    "timeout_ms": 5000,
    "assertions": [{"type": "status_code", "expected": 200}],
}


async def _setup(client, make_user, name="apiprog"):
    _, h = await make_user(name)
    r = await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)
    return h, r.json()["id"]


async def test_api_def_crud_http(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/order/{id}", "request": REQ}, headers=h)
    assert r.status_code == 201, r.text
    body = r.json()
    did = body["id"]
    assert body["status"] == "complete" and body["version"] == 1
    assert body["produced"] == [{"kind": "api_definition", "id": did, "name": "查询订单", "link": "/api/definition/" + did}]

    r2 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    assert r2.status_code == 200 and [x["id"] for x in r2.json()["items"]] == [did]

    r3 = await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)
    assert r3.status_code == 200 and r3.json()["name"] == "查询订单"

    r4 = await client.patch("/api/v1/api-definitions/" + did, json={
        "project_id": pid, "name": "查询订单V2", "request": REQ, "version": 1}, headers=h)
    assert r4.status_code == 200, r4.text
    assert r4.json()["version"] == 2


async def test_updated_at_exposed_for_list_column(client, make_user) -> None:
    """蓝图 :1376 列表列「更新时间」的数据源。

    列一直在 TimestampMixin 里躺着，但 ApiDefOut 没这个字段 → 前端无从画起
    （D79 登记时把「库里有」当成「接口给了」）。这里钉的是出参这一层：
    有值、且是带偏移的 ISO（裸串会让前端按本地时区猜，和审计日志差一个时区）。
    """
    from datetime import datetime

    h, pid = await _setup(client, make_user, "apiprog_ts")
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "有时间", "method": "GET", "path": "/ts", "request": REQ}, headers=h)
    assert r.status_code == 201, r.text
    created = r.json()["updated_at"]
    assert created, "创建响应没带 updated_at → 列表这列只能是空"
    assert datetime.fromisoformat(created).tzinfo is not None, \
        "裸串（无偏移）会让前端按本地时区猜：" + str(created)

    # 改一次 → updated_at 跟着走：这列报的是「最后改动」，不是「创建时刻」
    did = r.json()["id"]
    r2 = await client.patch("/api/v1/api-definitions/" + did, json={
        "project_id": pid, "name": "有时间V2", "version": 1}, headers=h)
    assert r2.status_code == 200, r2.text
    assert datetime.fromisoformat(r2.json()["updated_at"]) >= datetime.fromisoformat(created)

    r3 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    assert r3.json()["items"][0]["updated_at"], "列表出参也得给（列就是画在列表上）"


async def test_owner_name_resolved_in_list(client, make_user, session) -> None:
    """蓝图 :1376 列表列「负责人」的数据源：owner_id 是 UUID，画给人看就是骗人。

    名字必须在后端 join app_user 回填（前端拉 /members 换名字在权限上就是错的——
    该端点要 ensure_member）。这里钉两种必须可区分的 null：
    ① 建接口的人（owner_id=ctx.user_id）→ 列表回他的 name；
    ② owner_id 为 null（没有负责人）→ owner_name 也是 null，前端画「—」。
    """
    h, pid = await _setup(client, make_user, "apiprog_owner")
    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "有人管", "method": "GET", "path": "/own", "request": REQ}, headers=h)
    assert r.status_code == 201, r.text
    # 创建出参就带名字（详情/其它消费方与列表同一形状，不用各自再认人）
    assert r.json()["owner_id"] == me["id"]
    assert r.json()["owner_name"] == me["name"], "创建出参也要回填人名（与列表同形）"
    r_get = await client.get("/api/v1/api-definitions/" + r.json()["id"],
                             params={"project_id": pid}, headers=h)
    assert r_get.status_code == 200, r_get.text
    assert r_get.json()["owner_name"] == me["name"], "单查出参也要回填人名"

    r2 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    assert r2.status_code == 200, r2.text
    items = {x["name"]: x for x in r2.json()["items"]}
    assert items["有人管"]["owner_name"] == me["name"]

    # owner_id 为 null：测试侧直接清掉这一列（创建路径恒写 ctx.user_id，HTTP 无法置空）。
    # 悬空 owner（id 查不到人）与「没填负责人」是两种 null，这里钉后者。
    # client 与 session 是同一个被覆盖的会话（conftest 的 get_db override），改动直接可见。
    from sqlalchemy import update

    from app.modules.api_test.models import ApiDefinition

    await session.execute(update(ApiDefinition).where(ApiDefinition.id == items["有人管"]["id"])
                          .values(owner_id=None))
    await session.commit()
    r3 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    row = {x["name"]: x for x in r3.json()["items"]}["有人管"]
    assert row["owner_id"] is None and row["owner_name"] is None, \
        "没填负责人必须回 null——回个空串前端就画得出「假名字」"


async def test_invalid_request_object(client, make_user) -> None:
    """§7.1：json 体 content 必须为合法 JSON 文本。"""
    h, pid = await _setup(client, make_user, "apiprog2")
    bad = dict(REQ)
    bad["body"] = {"type": "json", "content": "{不是json"}
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "坏接口", "method": "POST", "path": "/x", "request": bad}, headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed"


async def test_optimistic_lock_conflict(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "apiprog3")
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "锁", "method": "GET", "path": "/l", "request": REQ}, headers=h)
    did = r.json()["id"]
    await client.patch("/api/v1/api-definitions/" + did, json={"project_id": pid, "name": "v2", "version": 1}, headers=h)
    r2 = await client.patch("/api/v1/api-definitions/" + did, json={"project_id": pid, "name": "v2again", "version": 1}, headers=h)
    assert r2.status_code == 409 and r2.json()["code"] == "conflict"


async def test_via_dispatcher_produced_and_audit(client, make_user, session) -> None:
    from sqlalchemy import select

    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.audit.models import AuditLog

    h, pid = await _setup(client, make_user, "apiprog4")
    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    ctx = ServiceCtx(entry="agent", user_id=me["id"], perms={"*"}, db=session)
    disp = ToolDispatcher(session)
    r = await disp.call("api_definition_create", {
        "project_id": pid, "name": "agent建接口", "method": "GET", "path": "/a", "request": REQ}, ctx, mode="FULL", grants=set())
    assert r.ok is True, r.error
    assert len(r.produced) == 1 and r.produced[0]["kind"] == "api_definition"
    rows = (await session.execute(select(AuditLog).where(AuditLog.action == "api_definition_create"))).scalars().all()
    assert len(rows) == 1 and rows[0].ok and "produced" in (rows[0].diff or {})


async def test_registry_visibility_shape(client) -> None:
    from app.core.registry import REGISTRY
    from app.modules.iam.roles import match_perm

    spec = REGISTRY.get("api_definition_create")
    assert spec is not None and spec.tool is True and spec.effect == "write"
    assert match_perm({"*:read"}, "api:def:read") and not match_perm({"*:read"}, "api:def:create")


async def test_http_entry_audit(client, make_user, session) -> None:
    """判据 1 五路之审计：HTTP 写操作落 audit_log(entry=http)，GET 不落。"""
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    _, h = await make_user("auditboss")
    r = await client.post("/api/v1/projects", json={"name": "auditproj"}, headers=h)
    pid = r.json()["id"]
    r2 = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "审计接口", "method": "GET", "path": "/a", "request": REQ}, headers=h)
    assert r2.status_code == 201, r2.text
    # 越权写也落（ok=False）；只读 GET 不落
    _, h_outsider = await make_user("auditout")
    r3 = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "y", "method": "GET", "path": "/b", "request": REQ}, headers=h_outsider)
    assert r3.status_code == 403, r3.text
    await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)

    rows = (await session.execute(select(AuditLog).where(AuditLog.entry == "http"))).scalars().all()
    ok_rows = [a for a in rows if a.action == "api_definition_create" and a.ok]
    bad_rows = [a for a in rows if a.action == "api_definition_create" and not a.ok]
    assert len(ok_rows) == 1 and ok_rows[0].user_id is not None
    assert len(bad_rows) == 1 and bad_rows[0].diff and "error" in bad_rows[0].diff
    assert not any(a.action.startswith("api_definition_list") for a in rows)  # 只读不审计
