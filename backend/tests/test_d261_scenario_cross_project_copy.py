"""D261：场景跨项目复制（`target_project_id`）。

基础场景：团队把一套编排从「履约 A」复制到「履约 B」复用。两处不能照搬项目内复制：

- 环境（`env_id`）与模块（`module_id`）都是**项目私有资产**：跟随过去会让副本一保存
  就违反 D181（场景绑定环境必须同项目），模块 id 在目标项目里根本不存在。跨项目时
  环境清空、模块缺省落目标未分类；
- 权限是两边都要：读源场景要源项目成员，落副本要目标项目的 `scenario:create`。
  且源行的可见性必须在**切到目标权限之前**判定（目标管理员 + 源普通成员不能借道
  看见源项目里别人私有的场景）。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post(_BASE + "/projects", json={"name": name + "_p"},
                             headers=h)).json()["id"]
    return h, pid


async def _env(client, h, pid, name):
    r = await client.post(_BASE + "/envs", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mod(client, h, pid, name):
    r = await client.post(_BASE + "/scenario-modules", json={"project_id": pid, "name": name},
                          headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _scene(client, h, pid, name, **kw):
    body = {"project_id": pid, "name": name, "step_graph": {"version": 1, "nodes": []}}
    body.update(kw)
    r = await client.post(_BASE + "/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _copy(client, h, pid, ids, target=None, module_id=None):
    body = {"project_id": pid, "scenario_ids": ids}
    if target is not None:
        body["target_project_id"] = target
    if module_id is not None:
        body["module_id"] = module_id
    return await client.post(_BASE + "/scenario-batch-copy", json=body, headers=h)


async def _rows(client, h, pid):
    r = await client.get(_BASE + "/scenarios", params={"project_id": pid, "size": 200},
                         headers=h)
    assert r.status_code == 200, r.text
    return r.json()["items"]


# ══════════ 1. 跨项目：环境清空、模块不跟随、目标撞名自动加后缀 ══════════
async def test_copy_to_other_project_resets_project_private_fields(client, make_user) -> None:
    h, pa = await _setup(client, make_user, "d261a")
    pb = (await client.post(_BASE + "/projects", json={"name": "d261a_b"},
                            headers=h)).json()["id"]
    env = await _env(client, h, pa, "预发环境")
    mod = await _mod(client, h, pa, "源模块")
    a = await _scene(client, h, pa, "甲", env_id=env["id"], module_id=mod["id"])
    b = await _scene(client, h, pa, "乙", env_id=env["id"], module_id=mod["id"])
    # 目标项目已有同名副本 → 必须顺延到「 - 副本 2」，而不是 409 或覆盖
    await _scene(client, h, pb, "甲 - 副本")

    r = await _copy(client, h, pa, [a["id"], b["id"]], target=pb)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 2
    assert set(body["names"]) == {"甲 - 副本 2", "乙 - 副本"}

    target_rows = {x["name"]: x for x in await _rows(client, h, pb)}
    assert set(target_rows) == {"甲 - 副本", "甲 - 副本 2", "乙 - 副本"}
    for name in ("甲 - 副本 2", "乙 - 副本"):
        row = target_rows[name]
        assert row["module_id"] is None, "项目私有模块不能跟随到另一个项目"
        assert row["env_id"] is None, "项目私有环境不能跟随（D181）"
        assert row["version"] == 1
        assert row["updated_by"] is not None

    # 源项目两份原样保留（env/module 不变，没有被复制动作改写）
    src = {x["name"]: x for x in await _rows(client, h, pa)}
    assert set(src) == {"甲", "乙"}
    assert src["甲"]["env_id"] == env["id"] and src["甲"]["module_id"] == mod["id"]


# ══════════ 2. 目标项目无权限 → 403，目标一行不写 ══════════
async def test_copy_to_inaccessible_project_is_forbidden(client, make_user) -> None:
    ha, pa = await _setup(client, make_user, "d261b_a")
    hb, pb = await _setup(client, make_user, "d261b_b")
    a = await _scene(client, ha, pa, "甲")

    r = await _copy(client, ha, pa, [a["id"]], target=pb)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "forbidden"
    assert await _rows(client, hb, pb) == []

    # 目标不存在与无权限同码（不泄露存在性）
    r2 = await _copy(client, ha, pa, [a["id"]], target="no-such-project")
    assert r2.status_code == 403, r2.text


# ══════════ 3. 模块必须属于落点项目；跨项目用源模块 id → 404 且零写入 ══════════
async def test_cross_copy_rejects_source_module(client, make_user) -> None:
    h, pa = await _setup(client, make_user, "d261c")
    pb = (await client.post(_BASE + "/projects", json={"name": "d261c_b"},
                            headers=h)).json()["id"]
    mod = await _mod(client, h, pa, "源模块")
    a = await _scene(client, h, pa, "甲", module_id=mod["id"])

    r = await _copy(client, h, pa, [a["id"]], target=pb, module_id=mod["id"])
    assert r.status_code == 404, r.text
    assert await _rows(client, h, pb) == []

    # 目标项目自己的模块则可以用，副本落在该模块
    mod_b = await _mod(client, h, pb, "目标模块")
    ok = await _copy(client, h, pa, [a["id"]], target=pb, module_id=mod_b["id"])
    assert ok.status_code == 200, ok.text
    assert [x["module_id"] for x in await _rows(client, h, pb)] == [mod_b["id"]]
