"""D280：缺陷「缺陷来源 / 严重程度」两列（对齐 MS 缺陷列表）。

钉四条：
① 创建可写、列表/详情可读（出参同形，列表不 N+1）；
② 更新三态：不带 = 不改、带 null = 清空、带值 = 改（`source_set`/`severity_set`）；
③ 高级搜索能筛：`severity` 枚举精确、`source` 文本包含（DEFECT_LIST_FILTER 两项）；
④ 词表外的严重程度 422（词表唯一来源 = models.DEFECT_SEVERITIES）。

不钉：`platform` 仍不做（无第三方同步 = 没人写，判断 1）；`priority` 与 `severity` 并存
不是重复列——「先修谁」与「坏得多重」是两个轴（models.Defect 列注释）。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create(client, h, pid: str, title: str, **extra) -> dict:
    r = await client.post(_BASE + "/defects", headers=h,
                          json={"project_id": pid, "title": title, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def test_create_read_and_filter(client, make_user) -> None:
    """①③：来源/严重程度创建可写、列表与详情可读，且能按两者筛。"""
    _, h = await make_user("d280a")
    pid = await _proj(client, h, "D280 缺陷两列")
    d = await _create(client, h, pid, "结算页 500", source="客户反馈", severity="critical")
    assert d["source"] == "客户反馈"
    assert d["severity"] == "critical"
    await _create(client, h, pid, "文案错别字", source="回归测试", severity="trivial")
    await _create(client, h, pid, "未评估缺陷")

    # 列表原样读回
    lst = await client.get(_BASE + "/defects", headers=h,
                           params=[("project_id", pid), ("current", "1"), ("size", "20")])
    assert lst.status_code == 200, lst.text
    rows = {r["title"]: r for r in lst.json()["items"]}
    assert rows["结算页 500"]["source"] == "客户反馈"
    assert rows["结算页 500"]["severity"] == "critical"
    assert rows["未评估缺陷"]["severity"] is None, "未评估就是 null，不编默认值"

    # 详情同形
    got = await client.get(_BASE + "/defects/" + d["id"], headers=h,
                           params={"project_id": pid})
    assert got.status_code == 200, got.text
    assert got.json()["source"] == "客户反馈"
    assert got.json()["severity"] == "critical"

    # 高级搜索：severity 枚举精确
    f = {"search_mode": "AND", "conditions": [
        {"field": "severity", "operator": "EQUALS", "value": "critical"}]}
    r = await client.get(_BASE + "/defects", headers=h, params=[
        ("project_id", pid), ("current", "1"), ("size", "20"), ("filter", json.dumps(f))])
    assert r.status_code == 200, r.text
    assert [i["title"] for i in r.json()["items"]] == ["结算页 500"]

    # 高级搜索：source 文本包含
    f2 = {"search_mode": "AND", "conditions": [
        {"field": "source", "operator": "CONTAINS", "value": "回归"}]}
    r2 = await client.get(_BASE + "/defects", headers=h, params=[
        ("project_id", pid), ("current", "1"), ("size", "20"), ("filter", json.dumps(f2))])
    assert r2.status_code == 200, r2.text
    assert [i["title"] for i in r2.json()["items"]] == ["文案错别字"]


async def test_update_three_states(client, make_user) -> None:
    """②：不带 = 不改；带 null = 清空；带值 = 改。"""
    _, h = await make_user("d280b")
    pid = await _proj(client, h, "D280 三态")
    d = await _create(client, h, pid, "三态缺陷", source="客户反馈", severity="major")

    # 只改优先级：source/severity 一个都不许动
    r = await client.patch(_BASE + "/defects/" + d["id"], headers=h,
                           json={"project_id": pid, "priority": "P0"})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "客户反馈" and r.json()["severity"] == "major"

    # 带 null + set = 真清空
    r = await client.patch(_BASE + "/defects/" + d["id"], headers=h, json={
        "project_id": pid, "source": None, "source_set": True,
        "severity": None, "severity_set": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["source"] is None and r.json()["severity"] is None

    # 再写回一个新值
    r = await client.patch(_BASE + "/defects/" + d["id"], headers=h, json={
        "project_id": pid, "severity": "minor", "severity_set": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["severity"] == "minor" and r.json()["source"] is None


async def test_severity_vocab_is_enforced(client, make_user) -> None:
    """④：词表外的严重程度 422（模型 pattern 与 DEFECT_SEVERITIES 同源）。"""
    _, h = await make_user("d280c")
    pid = await _proj(client, h, "D280 词表")
    r = await client.post(_BASE + "/defects", headers=h, json={
        "project_id": pid, "title": "坏严重程度", "severity": "blocker"})
    assert r.status_code == 422, r.text
