"""1B T3：api_case_resolve —— 引擎取「用例有效请求」的唯一出口（R44 + 契约 4）。

存在理由：引擎不得 import api_test（契约 4），也不能复用 api_debug（它会自己落一条
run_record → 一次场景执行出现两条运行记录，且只跑数据集首行）。它与 api_case_get
共用同一个 merge_request，因此「界面看到的有效请求」与「引擎执行的有效请求」不可能分叉。
"""
from __future__ import annotations

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.core.service import ServiceCtx


async def _spec():
    spec = REGISTRY.get("api_case_resolve")
    assert spec is not None, "api_case_resolve 未注册（create_app 之后才有）"
    return spec


async def _resolve(db, user, pid: str, cid: str, *, perms=None) -> dict:
    spec = await _spec()
    ctx = ServiceCtx(entry="agent", user_id=user.id, user_name=user.name,
                     is_system_admin=user.is_system_admin, perms=perms or {"api:case:read"}, db=db)
    out = await spec.handler(spec.model.model_validate({"project_id": pid, "case_id": cid}), ctx)
    return out.model_dump()


async def _resolve_err(db, user, pid: str, cid: str, *, perms=None) -> ApiError:
    try:
        await _resolve(db, user, pid, cid, perms=perms)
    except ApiError as e:
        return e
    raise AssertionError("应当抛 ApiError")


async def _kit(client, h, tag: str) -> dict:
    """项目 → 接口（带断言与 body）→ 用例。返回 id 包。"""
    pid = (await client.post("/api/v1/projects", json={"name": tag}, headers=h)).json()["id"]
    body = {"type": "json", "content": '{"u":"demo"}'}
    req = {"method": "POST", "url": "/login", "headers": [["X-Src", "def"]], "body": body,
           "assertions": [{"type": "status_code", "expected": 200}]}
    body = {"project_id": pid, "name": "登录", "method": "POST", "path": "/login", "request": req}
    did = (await client.post("/api/v1/api-definitions", headers=h, json=body)).json()["id"]
    body = {"project_id": pid, "definition_id": did, "name": "正常登录"}
    cid = (await client.post("/api/v1/api-cases", headers=h, json=body)).json()["id"]
    return {"pid": pid, "did": did, "cid": cid}


async def test_resolve_is_internal_and_read(client) -> None:
    """注册形状：http=None（不开 HTTP 面）、tool=False（不进模型视野，R44）。"""
    r = await client.post("/api/v1/api_case_resolve", json={"project_id": "x", "case_id": "y"})
    assert r.status_code == 404, "内部服务不得暴露 HTTP 路由"
    spec = await _spec()
    assert spec.http is None
    assert spec.tool is False, "引擎内部件不得进 Pilot 工具箱"
    assert spec.effect == "read"


async def test_resolve_inherits_definition_request(client, session, make_user) -> None:
    """完全继承的用例：请求来自定义，断言来自定义，dataset=None，并带出可执行标记。"""
    u, h = await make_user("res1boss")
    k = await _kit(client, h, "res1")
    out = await _resolve(session, u, k["pid"], k["cid"])
    assert out["executable"] is True
    assert out["case_id"] == k["cid"] and out["definition_id"] == k["did"]
    assert out["case_name"] == "正常登录" and out["definition_name"] == "登录"
    assert out["request"]["method"] == "POST" and out["request"]["url"] == "/login"
    assert out["request"]["headers"] == [["X-Src", "def"]]
    assert [a["type"] for a in out["assertions"]] == ["status_code"]
    assert out["dataset"] is None


async def test_resolve_overlay_and_assertion_order(client, session, make_user) -> None:
    """覆盖层按键替换；断言 = 定义 + 用例（与调试台同一口径）。"""
    u, h = await make_user("res2boss")
    k = await _kit(client, h, "res2")
    body = {"project_id": k["pid"], "definition_id": k["did"], "name": "覆盖 url",
            "request": {"url": "/login/v2", "headers": [["X-Case", "1"]]},
            "assertions": [{"type": "body_contains", "expected": "token"}]}
    cid = (await client.post("/api/v1/api-cases", headers=h, json=body)).json()["id"]
    out = await _resolve(session, u, k["pid"], cid)
    assert out["request"]["url"] == "/login/v2", "覆盖层 url 必须生效"
    assert out["request"]["headers"] == [["X-Case", "1"]], "headers 整键替换（§7.5）"
    assert out["request"]["body"]["content"] == '{"u":"demo"}', "未覆盖的键继续继承定义"
    assert [a["type"] for a in out["assertions"]] == ["status_code", "body_contains"]


async def test_resolve_includes_full_dataset_rows(client, session, make_user) -> None:
    """引擎要跑全行（api_debug 只跑首行）：必须给完整 columns + rows。"""
    u, h = await make_user("res3boss")
    k = await _kit(client, h, "res3")
    body = {"project_id": k["pid"], "name": "账号池", "columns": ["u", "p"],
            "rows": [["a", "1"], ["b", "2"], ["c", "3"]]}
    dsid = (await client.post("/api/v1/datasets", headers=h, json=body)).json()["id"]
    body = {"project_id": k["pid"], "definition_id": k["did"], "name": "数据驱动",
            "dataset_id": dsid}
    cid = (await client.post("/api/v1/api-cases", headers=h, json=body)).json()["id"]
    out = await _resolve(session, u, k["pid"], cid)
    assert out["dataset"]["columns"] == ["u", "p"]
    assert out["dataset"]["rows"] == [["a", "1"], ["b", "2"], ["c", "3"]]
    assert out["dataset"]["id"] == dsid


async def test_resolve_rejects_missing_recycled_and_borrowed(client, session, make_user) -> None:
    """不存在 / 跨项目借用 / 用例回收 / 定义回收 → 一律 404（不泄露存在性）。"""
    u, h = await make_user("res4boss")
    k = await _kit(client, h, "res4")
    u2, h2 = await make_user("res4other")
    pid2 = (await client.post("/api/v1/projects", json={"name": "res4b"}, headers=h2)).json()["id"]

    e = await _resolve_err(session, u, k["pid"], "nope")
    assert (e.code, e.http_status) == ("not_found", 404)

    e = await _resolve_err(session, u2, pid2, k["cid"])
    assert (e.code, e.http_status) == ("not_found", 404), "跨项目借用必须 404"

    r = await client.post("/api/v1/api-cases/" + k["cid"] + "/delete",
                       json={"project_id": k["pid"]}, headers=h)
    assert r.status_code == 200, r.text  # 传错 payload 会得到 422，那样这条断言就是空的
    e = await _resolve_err(session, u, k["pid"], k["cid"])
    assert e.code == "not_found", "回收的用例必须 404"

    k2 = await _kit(client, h, "res4c")
    r = await client.post("/api/v1/api-definitions/" + k2["did"] + "/delete",
                       json={"project_id": k2["pid"]}, headers=h)
    assert r.status_code == 200, r.text
    e = await _resolve_err(session, u, k2["pid"], k2["cid"])
    assert e.code == "not_found", "定义在回收站 → 用例同样不可解析"


async def test_resolve_requires_project_membership(client, session, make_user) -> None:
    """内部服务不是权限旁路：非项目成员 → 403。

    注意不能靠塞一个空 perms 的 ctx 来「测权限」：ensure_project_access 会用真实
    解析覆盖它，那样断言的是空气。这里用真外部用户走真 resolver。
    """
    u, h = await make_user("res6boss")
    k = await _kit(client, h, "res6")
    outsider, _ = await make_user("res6outsider")
    e = await _resolve_err(session, outsider, k["pid"], k["cid"])
    assert e.code == "forbidden" and e.http_status == 403, e


async def test_resolve_draft_definition_is_not_executable(client, session, make_user) -> None:
    """草稿定义（request=None）+ 用例未覆盖 url → executable=False，而不是硬造请求。

    为什么直接写库造这个状态：api_case_create 已经拒绝过这个组合（422「请先补全定义
    或用例覆盖 url」），api_definition_update 也不允许把 request 清空 —— 也就是说
    经 API 走不出这个状态。但 merge_request 的**契约**允许返回 None，而 seed 脚本与
    将来的导入功能都会绕过 API 写库；引擎因此必须拿到可判定的标记，而不是收到一个
    指向空 URL 的请求或一次莫名其妙的 422。
    """
    from app.modules.api_test.models import ApiCase, ApiDefinition

    u, h = await make_user("res5boss")
    pid = (await client.post("/api/v1/projects", json={"name": "res5"}, headers=h)).json()["id"]
    defn = ApiDefinition(project_id=pid, name="草稿接口", method="GET", path="/draft",
                         request=None, status="draft")
    session.add(defn)
    await session.commit()
    case = ApiCase(project_id=pid, definition_id=defn.id, name="无请求用例", request=None)
    session.add(case)
    await session.commit()

    out = await _resolve(session, u, pid, case.id)
    assert out["executable"] is False, out
    assert out["request"] is None
    assert out["reason"], "必须给出不可执行原因，报告页要直接展示"

    # 用例覆盖 url 之后立刻变可执行 —— 证明 executable 是算出来的，不是存字段
    case.request = {"url": "/login"}
    await session.commit()
    out = await _resolve(session, u, pid, case.id)
    assert out["executable"] is True and out["request"]["url"] == "/login"
    assert out["request"]["method"] == "GET", "method 兜底取定义"
