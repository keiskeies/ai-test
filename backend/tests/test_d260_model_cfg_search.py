"""D260：模型池的关键字搜索（名字 / 模型标识 / 网关地址三列）。

此前 `/model-cfgs` 只有 model_type 一个收窄轴，前端拉 `size=200` 一屏卡片墙，
模型一多就只能肉眼找。与场景/接口列表同口径：两端空白不进入匹配、`%`/`_` 是字面量
（不转义会把「搜 100%」变成「搜任意串」，界面看不出坏、只是结果多）。
"""
from __future__ import annotations

BASE = "/api/v1"


async def _admin(client, make_user, tag):
    _, h = await make_user("d260_" + tag, admin=True)
    return h


def _body(tag: str, **kw):
    b = {"name": "模型" + tag, "model_type": "CHAT", "protocol": "OPENAI_COMPAT",
         "base_url": "http://127.0.0.1:9/v1", "model_name": "gpt-fake"}
    b.update(kw)
    return b


async def _names(client, h, **params) -> set[str]:
    r = await client.get(BASE + "/model-cfgs", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _seed(client, h) -> None:
    for tag, kw in (
        ("甲", {"name": "通义千问", "model_name": "qwen-max", "base_url": "https://dash.example/v1"}),
        ("乙", {"name": "DeepSeek", "model_name": "deepseek-chat",
                "base_url": "https://api.deepseek.com/v1"}),
        ("丙", {"name": "向量模型", "model_type": "EMBEDDING", "model_name": "bge-m3",
                "base_url": "http://10.0.0.5:8080/v1"}),
        ("丁", {"name": "折扣测试", "model_name": "gpt-50%off"}),
    ):
        r = await client.post(BASE + "/model-cfgs", json=_body(tag, **kw), headers=h)
        assert r.status_code == 201, r.text


# ══════════ 1. 三列都能命中；大小写不敏感 ══════════
async def test_keyword_searches_three_columns(client, make_user) -> None:
    h = await _admin(client, make_user, "cols")
    await _seed(client, h)

    assert await _names(client, h, keyword="通义") == {"通义千问"}          # name
    assert await _names(client, h, keyword="DEEPSEEK") == {"DeepSeek"}     # model_name，大小写不敏感
    assert await _names(client, h, keyword="10.0.0.5") == {"向量模型"}      # base_url
    assert await _names(client, h, keyword="v1") == {"通义千问", "DeepSeek", "向量模型", "折扣测试"}
    assert await _names(client, h, keyword="不存在的模型") == set()


# ══════════ 2. 空白 = 不筛；两端空白被裁掉 ══════════
async def test_keyword_blank_means_no_filter(client, make_user) -> None:
    h = await _admin(client, make_user, "blank")
    await _seed(client, h)
    all_names = {"通义千问", "DeepSeek", "向量模型", "折扣测试"}

    assert await _names(client, h) == all_names
    assert await _names(client, h, keyword="   ") == all_names
    assert await _names(client, h, keyword="  qwen  ") == {"通义千问"}


# ══════════ 3. % / _ 是字面量；与 model_type 叠加 ══════════
async def test_keyword_escapes_wildcards_and_composes(client, make_user) -> None:
    h = await _admin(client, make_user, "esc")
    await _seed(client, h)

    # 转义没做的话 "%" 会把四条全捞出来
    assert await _names(client, h, keyword="50%") == {"折扣测试"}
    assert await _names(client, h, keyword="%") == {"折扣测试"}
    assert await _names(client, h, keyword="gpt_") == set()
    # 关键字收窄既有取数轴，不替换它
    assert await _names(client, h, keyword="模型", model_type="EMBEDDING") == {"向量模型"}
    assert await _names(client, h, keyword="v1", model_type="CHAT") == {
        "通义千问", "DeepSeek", "折扣测试"}
