"""D243 判据刀：通知渠道页高级搜索（D47-a 三件套铺到 /notify-channels）。

钉的契约（对应 notify/service.py CHANNEL_LIST_FILTER 的注释）：

1. **字段白名单 = 页面上看得见的标量列**：名称 / 类型 / 创建时间 / 更新时间。
   `config` / `last_send` 是 JSON（密钥打码回显与发送回执），`id` 是定位键，
   都不进白名单；点名即 400。
2. **渠道是平台级配置**：列表没有 project_id 过滤（既定口径）；filter-meta 的
   project_id 只做作用域校验，不参与数据过滤——两个项目看到的渠道集合相同。
3. **条件进 SQL 且在分页前**：与 type 快捷轴并行 AND；current 模式的 total 吃
   同一份条件。
4. **空 filter = 没传**；非法字段/非法操作符/坏 JSON 400 且 code=bad_filter，
   message 点名本页可筛清单。
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from app.modules.notify.models import NotifyChannel

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _chan(session, *, cid: str, name: str, type_: str = "WEBHOOK",
                created_at: datetime | None = None) -> str:
    row = NotifyChannel(id=cid, name=name, type=type_, config={},
                        created_at=created_at or datetime.now(UTC).replace(microsecond=0),
                        updated_at=created_at or datetime.now(UTC).replace(microsecond=0))
    session.add(row)
    await session.commit()
    return cid


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, **params) -> set[str]:
    r = await client.get(_BASE + "/notify-channels", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_channel(client, make_user) -> None:
    _, h = await make_user("d243a", admin=True)
    pid = await _proj(client, h, "D243元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "channel"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "channel" in body["supported_view_types"]
    assert body["view_label"] == "通知渠道"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "type", "created_at", "updated_at"}
    # JSON 配置 / 发送回执 / 定位键都不是业务字段
    assert not ({"config", "last_send", "id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["type"]["kind"] == "enum" and "CONTAINS" not in by_field["type"]["ops"]
    assert by_field["created_at"]["kind"] == "time" and "BETWEEN" in by_field["created_at"]["ops"]
    assert "EMPTY" not in by_field["name"]["ops"]
    assert "EMPTY" not in by_field["type"]["ops"]


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    _, h = await make_user("d243b", admin=True)
    base = datetime.now(UTC).replace(microsecond=0)
    await _chan(session, cid="d243-b1", name="D243-钉钉群", type_="DINGTALK",
                created_at=base - timedelta(days=2))
    await _chan(session, cid="d243-b2", name="D243-飞书群", type_="FEISHU", created_at=base)
    await _chan(session, cid="d243-b3", name="别的-钉钉群", type_="DINGTALK",
                created_at=base - timedelta(days=5))

    assert await _names(client, h, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "D243"})) == {"D243-钉钉群", "D243-飞书群"}
    assert await _names(client, h, filter=_f(
        {"field": "type", "operator": "EQUALS", "value": "FEISHU"})) == {"D243-飞书群"}
    # OR：名字含「飞书」或类型是钉钉
    assert await _names(client, h, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "飞书"},
        {"field": "type", "operator": "EQUALS", "value": "DINGTALK"}, mode="OR")) == {
        "D243-钉钉群", "D243-飞书群", "别的-钉钉群"}
    # 时间列：GT 只看昨天之后的
    assert await _names(client, h, filter=_f(
        {"field": "created_at", "operator": "GT", "value": (base - timedelta(days=1)).isoformat()}
    )) == {"D243-飞书群"}


async def test_filter_composes_with_type_axis_and_counts(client, session, make_user) -> None:
    _, h = await make_user("d243c", admin=True)
    await _chan(session, cid="d243-c1", name="D243-冒烟钩子", type_="WEBHOOK")
    await _chan(session, cid="d243-c2", name="D243-冒烟邮件", type_="EMAIL")
    await _chan(session, cid="d243-c3", name="D243-回归钩子", type_="WEBHOOK")

    # 快捷轴 type=WEBHOOK 与条件「名字含冒烟」并行 AND，不是二选一
    assert await _names(client, h, type="WEBHOOK", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "冒烟"})) == {"D243-冒烟钩子"}
    # 条件在 LIMIT 之前：两行匹配，size=1 只回一行但 total 是 2
    r = await client.get(_BASE + "/notify-channels", params={
        "size": 1, "current": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "D243"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 3


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d243d", admin=True)
    pid = await _proj(client, h, "D243坏条件")

    r = await client.get(_BASE + "/notify-channels", params={
        "filter": _f({"field": "config", "operator": "CONTAINS", "value": "url"}),
    }, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "channel"
    assert "本页可筛" in body["message"] and "名称" in body["message"]

    # 枚举列没有「包含」
    r2 = await client.get(_BASE + "/notify-channels", params={
        "filter": _f({"field": "type", "operator": "CONTAINS", "value": "WEB"})}, headers=h)
    assert r2.status_code == 400 and r2.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r3 = await client.get(_BASE + "/notify-channels",
                          params=[("filter", "{not json")], headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_filter"
    assert pid  # 渠道列表本身不带 project_id（平台级），这里只用它建了个项目


async def test_empty_filter_returns_all(client, session, make_user) -> None:
    _, h = await make_user("d243e", admin=True)
    await _chan(session, cid="d243-e1", name="D243-甲")
    await _chan(session, cid="d243-e2", name="D243-乙")
    assert await _names(client, h, filter="") == {"D243-甲", "D243-乙"}


async def test_platform_level_scope_is_shared_across_projects(client, session, make_user) -> None:
    """渠道没有项目归属：两个项目的 filter-meta 都能用，列表集合也相同（不是项目过滤漏了）。"""
    u, h = await make_user("d243f", admin=True)
    pid_a = await _proj(client, h, "D243项目A")
    pid_b = await _proj(client, h, "D243项目B")
    await _chan(session, cid="d243-f1", name="D243-平台渠道")
    cond = _f({"field": "name", "operator": "EQUALS", "value": "D243-平台渠道"})
    for pid in (pid_a, pid_b):
        meta = await client.get(_BASE + "/filter-meta",
                                params={"project_id": pid, "view_type": "channel"}, headers=h)
        assert meta.status_code == 200, meta.text
        assert await _names(client, h, filter=cond) == {"D243-平台渠道"}
