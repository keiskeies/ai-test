"""D266 Skills：目录同步（新增/变更/移除/解析错误）+ 管理面 + Agent 渐进披露。"""

from __future__ import annotations

from pathlib import Path

BASE = "/api/v1"

SKILL_MD = """---
name: {name}
description: {desc}
allowed-tools: get_project_outline, search_test_assets
---

# {title}

正文：先盘点资产，再产出候选场景。
"""

BAD_MD = """---
name: other-name
description: 名字对不上
---

正文
"""


def _write(root: Path, name: str, desc: str = "测试用 Skill", text: str | None = None) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    md = d / "SKILL.md"
    md.write_text(text if text is not None else SKILL_MD.format(name=name, desc=desc, title=name),
                  encoding="utf-8")
    return md


async def _admin(make_user, tag: str):
    _, headers = await make_user("sk_" + tag, admin=True)
    return headers


async def test_sync_list_get_toggle(client, make_user, tmp_path, monkeypatch) -> None:
    h = await _admin(make_user, "sync")
    monkeypatch.setenv("TP_SKILLS_DIR", str(tmp_path))
    _write(tmp_path, "alpha", "甲技能")
    _write(tmp_path, "beta", "乙技能")

    r = await client.post(BASE + "/skills/sync", json={}, headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["added"] == ["alpha", "beta"] and out["errors"] == []
    assert out["scanned_dir"] == str(tmp_path)

    g = await client.get(BASE + "/skills", headers=h)
    assert g.status_code == 200
    items = g.json()["items"]
    assert [x["name"] for x in items] == ["alpha", "beta"]
    a = items[0]
    assert a["enabled"] is True and a["source"] == "builtin"
    assert a["allowed_tools"] == ["get_project_outline", "search_test_assets"]
    assert "正文" not in str(a)  # 列表不带正文

    d = await client.get(BASE + "/skills/" + a["id"], headers=h)
    assert d.status_code == 200 and "先盘点资产" in d.json()["body"]

    t = await client.post(BASE + "/skills/" + a["id"] + "/toggle", json={"enabled": False}, headers=h)
    assert t.status_code == 200 and t.json()["enabled"] is False
    # 停用不改内容；再次同步也不该把它重新打开
    r2 = await client.post(BASE + "/skills/sync", json={}, headers=h)
    assert r2.json()["unchanged"] == 2
    g2 = await client.get(BASE + "/skills", headers=h)
    assert {x["name"]: x["enabled"] for x in g2.json()["items"]} == {"alpha": False, "beta": True}


async def test_sync_reports_updated_removed_and_errors(client, make_user, tmp_path, monkeypatch) -> None:
    h = await _admin(make_user, "sync2")
    monkeypatch.setenv("TP_SKILLS_DIR", str(tmp_path))
    _write(tmp_path, "alpha", "旧描述")
    _write(tmp_path, "beta")
    assert (await client.post(BASE + "/skills/sync", json={}, headers=h)).json()["added"] == ["alpha", "beta"]

    _write(tmp_path, "alpha", "新描述")
    (tmp_path / "beta" / "SKILL.md").unlink()
    (tmp_path / "beta").rmdir()
    _write(tmp_path, "gamma", text=BAD_MD)

    r = await client.post(BASE + "/skills/sync", json={}, headers=h)
    out = r.json()
    assert out["updated"] == ["alpha"]
    assert out["removed"] == ["beta"]
    assert len(out["errors"]) == 1 and "必须与目录名" in out["errors"][0]["error"]
    # 解析失败的 gamma 不建行（nan 名称而不是静默改名）
    names = {x["name"] for x in (await client.get(BASE + "/skills", headers=h)).json()["items"]}
    assert names == {"alpha"}


async def test_sync_missing_dir_is_400(client, make_user, tmp_path, monkeypatch) -> None:
    h = await _admin(make_user, "nodir")
    monkeypatch.setenv("TP_SKILLS_DIR", str(tmp_path / "nope"))
    r = await client.post(BASE + "/skills/sync", json={}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "skills_dir_missing"


async def test_permission_gate(client, make_user) -> None:
    _, h_ro = await make_user("sk_ro_user")
    for path in ("/skills", "/skills/sync"):
        r = await client.get(BASE + path, headers=h_ro) if path == "/skills" else \
            await client.post(BASE + path, json={}, headers=h_ro)
        assert r.status_code == 403 and r.json()["code"] == "insufficient_permission"


async def test_builtin_skill_parses() -> None:
    """仓库自带的 api-scenario-gen 必须能被解析器接受（否则同步页首屏就红）。"""
    from app.modules.skill.services import parse_skill

    md = Path(__file__).resolve().parents[1] / "skills" / "api-scenario-gen" / "SKILL.md"
    p = parse_skill(md.read_text(encoding="utf-8"), "api-scenario-gen")
    assert p.name == "api-scenario-gen" and p.description
    assert "get_project_outline" in p.allowed_tools and p.body


async def test_agent_read_skill_and_catalog(client, make_user, session, tmp_path, monkeypatch) -> None:
    h = await _admin(make_user, "agent")
    pid = (await client.post(BASE + "/projects", json={"name": "skill_proj"}, headers=h)).json()["id"]
    monkeypatch.setenv("TP_SKILLS_DIR", str(tmp_path))
    _write(tmp_path, "alpha", "甲技能")
    await client.post(BASE + "/skills/sync", json={}, headers=h)

    from sqlalchemy import select

    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.agent.runner import build_messages, skill_catalog
    from app.modules.skill.models import Skill

    ctx = ServiceCtx(entry="agent", user_id="u-sk", db=session, is_system_admin=True, perms={"*"})
    disp = ToolDispatcher(session)
    res = await disp.call("read_skill", {"name": "alpha"}, ctx, mode="PLAN", grants=set())
    assert res.ok is True, res.error
    assert res.content["name"] == "alpha"
    assert "先盘点资产" in res.content["content"]
    assert res.content["allowed_tools"] == ["get_project_outline", "search_test_assets"]

    bad = await disp.call("read_skill", {"name": "nope"}, ctx, mode="PLAN", grants=set())
    assert bad.ok is False
    # 错误里带可用清单，模型能自纠
    assert "alpha" in (bad.error or "")

    cat = await skill_catalog(session)
    assert "alpha: 甲技能" in cat and "read_skill" in cat
    # 停用后目录与 read_skill 同步消失
    row = (await session.execute(select(Skill).where(Skill.name == "alpha"))).scalar_one()
    row.enabled = False
    await session.commit()
    assert "alpha" not in (await skill_catalog(session))
    off = await disp.call("read_skill", {"name": "alpha"}, ctx, mode="PLAN", grants=set())
    assert off.ok is False
    # 系统提示真的带上了清单（不是只写在函数里）
    from app.modules.agent.models import AgentSession

    sess = AgentSession(user_id="u-sk", project_id=pid, title="t", mode="PLAN")
    session.add(sess)
    await session.commit()
    msgs = await build_messages(session, sess.id)
    assert msgs[0]["role"] == "system"
    assert "alpha" not in msgs[0]["content"]  # 已停用：清单里不许再出现


async def test_runner_narrows_tools_after_read_skill(client, make_user, session, tmp_path, monkeypatch) -> None:
    """allowed-tools 不是装饰：读到带白名单的 Skill 后，本轮后续工具箱必须真的收窄。

    直接跑 AgentRunner（假网关回放「先 read_skill，再收尾」），把第二次进入
    gateway 时拿到的 tools 名单钉住——只留白名单 ∪ {read_skill}。
    """
    import fakeredis.aioredis

    from app.core.eventbus import init_bus
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.agent.models import AgentSession
    from app.modules.agent.runner import AgentRunner

    bus = init_bus(client=fakeredis.aioredis.FakeRedis(decode_responses=True))
    h = await _admin(make_user, "narrow")
    pid = (await client.post(BASE + "/projects", json={"name": "skill_narrow"}, headers=h)).json()["id"]
    uid = (await client.get(BASE + "/auth/me", headers=h)).json()["id"]
    monkeypatch.setenv("TP_SKILLS_DIR", str(tmp_path))
    _write(tmp_path, "alpha", "甲技能")
    await client.post(BASE + "/skills/sync", json={}, headers=h)

    class RecordingGateway:
        """第一次回放 read_skill 调用，第二次只回一句话；每次记下 tools 名单。"""

        def __init__(self) -> None:
            self.calls: list[list[str]] = []

        async def stream(self, *, messages, tools, model, thinking, api_key):
            self.calls.append([t["name"] for t in tools])
            if len(self.calls) == 1:
                yield {"type": "tool_call", "id": "tc_1", "name": "read_skill", "args": {"name": "alpha"}}
            else:
                yield {"type": "text_delta", "text": "好"}
            yield {"type": "done", "stop_reason": "stop"}

    gw = RecordingGateway()
    sess = AgentSession(user_id=uid, project_id=pid, title="narrow", mode="PLAN")
    session.add(sess)
    await session.commit()
    await AgentRunner(gateway=gw, dispatcher=ToolDispatcher(session)).run_turn(sess.id)

    assert len(gw.calls) == 2
    assert "read_skill" in gw.calls[0] and len(gw.calls[0]) > 3  # 收窄前是完整工具箱
    assert set(gw.calls[1]) == {"get_project_outline", "search_test_assets", "read_skill"}
    await bus.aclose()

