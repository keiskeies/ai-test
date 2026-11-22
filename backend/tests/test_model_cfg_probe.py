"""1E T8 模型配置中心：逐能力探测（§6.8）+ 假网关表驱动 + 首启探测幂等 + D29 豁免点名。

形状口径：
- 假网关 = stdlib http.server 起线程（test_notify.py 的假接收端同款，零新依赖）；
  按请求体标记（tools[] / thinking / image_url）分发，逐能力喂 支持/不支持/含糊。
- 三能力 × 支持/不支持/含糊 = 9 形状表驱动（计划 T8 点名），走真 HTTP 端点
  POST /model-cfgs/{id}/probe，判定 → 落库 → 回显一条链全钉。
- 假阴性红线（变异自证对象）：含糊/超时 → 能力位**不改存储值** + probe_result 标
  unknown（null）——探测不许把「没测出来」写成「不支持」。
- EMBEDDING：embed("ping") 回填 embed_dimensions（§6.8 兑现点，列在、此前零写入）。
- 首启探测幂等：seed 跑两次不多行；probe_backfill 跑两次第二次零写入；
  人工值不被再探测覆盖（only_missing 语义）。
- D29：model_cfg 写类 tool=False 在注册覆盖率测试里显式豁免点名（可数、有名字）。
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "/api/v1"

# 三能力 × 三形状 = 9 例（计划点名的表驱动）；其余能力在每例里固定为 ok，
# 保证「这一格红了就是这一格的问题」。
SHAPES = [
    ("tools", "support"), ("tools", "reject"), ("tools", "ambiguous"),
    ("thinking", "support"), ("thinking", "reject"), ("thinking", "ambiguous"),
    ("vision", "support"), ("vision", "reject"), ("vision", "ambiguous"),
]


class FakeGateway:
    """OAI 兼容假网关：GET /models 恒 200；POST 按请求体标记认出探测类型再按 mode 回包。

    mode = {"tools": "support|reject|ambiguous", "thinking": ..., "vision": ...}；
    embeddings = 返回向量长度（None = 回坏形状，测维度判定）。
    """

    def __init__(self, mode: dict[str, str] | None = None, embeddings: int | None = 42,
                 hang: str | None = None) -> None:
        self.mode = mode or {}
        self.embeddings = embeddings
        self.hang = hang  # 该类型的请求先 sleep 6s（>5s 超时）→ 客户端视角的含糊
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[]}')

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                body = json.loads(raw.decode("utf-8"))
                if self.path.endswith("/embeddings"):
                    outer.requests.append({"kind": "embeddings", "body": body})
                    if outer.embeddings is None:
                        outer._reply(self, 200, '{"data":[{"embedding":"不是数组"}]}')
                    else:
                        vec = [0.1] * outer.embeddings
                        outer._reply(self, 200, json.dumps({"data": [{"embedding": vec}]}))
                    return
                kind = outer._kind(body)
                outer.requests.append({"kind": kind, "body": body})
                if outer.hang == kind:
                    time.sleep(6)  # 客户端 5s 超时先到 → 含糊
                outer._reply(self, *outer._respond(kind, body))

            def log_message(self, *_a):  # 静音
                pass

            def handle_error(self, *a):  # hang 例里客户端先断连：断连回写炸了别打整屏 traceback
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:" + str(self.port) + "/v1"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    @staticmethod
    def _kind(body: dict) -> str:
        if "tools" in body:
            return "tools"
        if "thinking" in body:
            return "thinking"
        c = (body.get("messages") or [{}])[0].get("content")
        if isinstance(c, list):
            return "vision"
        return "plain"

    @staticmethod
    def _reply(h: BaseHTTPRequestHandler, status: int, payload: str) -> None:
        h.send_response(status)
        h.send_header("Content-Type", "application/json")
        h.end_headers()
        h.wfile.write(payload.encode("utf-8"))

    def _respond(self, kind: str, body: dict) -> tuple[int, str]:
        shape = self.mode.get(kind, "support")
        msg: dict = {"role": "assistant", "content": "pong"}
        if shape == "ambiguous":
            return 500, '{"error":{"message":"gateway boom"}}'
        if kind == "tools":
            if shape == "support":
                msg["tool_calls"] = [{"id": "t1", "type": "function",
                                      "function": {"name": "__tp_probe__", "arguments": "{}"}}]
            else:  # reject：400 点名 tool（tools[] 被拒）
                return 400, '{"error":{"message":"The model does not support tool_calls"}}'
        elif kind == "thinking":
            if shape == "support":
                msg["reasoning_content"] = "让我先想一想"
            # reject：2xx 但思考块缺席（参数被吞）——与 5xx 的含糊可区分
        elif kind == "vision":
            if shape == "reject":
                return 400, '{"error":{"message":"image input is not supported"}}'
        return 200, json.dumps({"choices": [{"message": msg, "finish_reason": "stop"}]})


def _dead_gateway_cfg(tag: str = "m") -> dict:
    return {"name": "模型" + tag, "model_type": "CHAT", "protocol": "OPENAI_COMPAT",
            "base_url": "http://127.0.0.1:9/v1", "model_name": "gpt-fake"}


async def _admin(client, make_user, tag):
    _, h = await make_user("mp_" + tag, admin=True)
    return h


async def _mkcfg(client, h, gw_url: str, tag: str, **kw) -> str:
    b = {**_dead_gateway_cfg(tag), "base_url": gw_url}
    b.update(kw)
    r = await client.post(BASE + "/model-cfgs", json=b, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ── 判定表纯函数（probe.py 的判定表本体，逐格钉） ──


def test_judges_truth_tables() -> None:
    from app.modules.model_cfg import probe

    ok_msg = {"choices": [{"message": {"role": "assistant", "content": "x"}}]}
    tc = json.loads(json.dumps(ok_msg))
    tc["choices"][0]["message"]["tool_calls"] = [{"id": "1"}]
    th = json.loads(json.dumps(ok_msg))
    th["choices"][0]["message"]["reasoning_content"] = "…"
    err = lambda w: {"error": {"message": w}}  # noqa: E731

    assert probe.judge_tools(200, tc) is True
    assert probe.judge_tools(200, ok_msg) is False       # tools 字段被吞（2xx 无 tool_calls）
    assert probe.judge_tools(400, err("no tool_calls")) is False
    assert probe.judge_tools(500, err("boom")) is None   # 含糊
    assert probe.judge_tools(0, None) is None            # 超时/连接失败（_post 折算成 0）
    assert probe.judge_tools(200, "非 JSON") is None     # 坏体不猜

    assert probe.judge_thinking(200, th) is True
    assert probe.judge_thinking(200, ok_msg) is False
    assert probe.judge_thinking(400, err("thinking disabled")) is False
    assert probe.judge_thinking(500, None) is None

    assert probe.judge_vision(200, ok_msg) is True
    assert probe.judge_vision(400, err("image not supported")) is False
    assert probe.judge_vision(400, err("rate limit")) is None  # 4xx 但没点名 image → 含糊
    assert probe.judge_vision(500, None) is None

    assert probe.judge_dimensions(200, {"data": [{"embedding": [0.1] * 64}]}) == 64
    assert probe.judge_dimensions(200, {"data": []}) is None
    assert probe.judge_dimensions(500, None) is None


def test_merge_caps_unknown_never_overwrites() -> None:
    """合并语义纯函数钉：None（含糊）永远沿用旧值；only_missing 保人工值。"""
    from app.modules.model_cfg import probe

    old = {"tools": True, "thinking": False, "vision": True}
    new = {"tools": None, "thinking": True, "vision": False}
    m = probe.merge_caps(old, new, only_missing=False)
    assert m == {"tools": True, "thinking": True, "vision": False}  # 含糊沿用旧值
    m2 = probe.merge_caps(old, new, only_missing=True)
    assert m2 == old  # 全有人工值 → 一条都不覆盖
    m3 = probe.merge_caps({"tools": None, "thinking": None, "vision": None},
                          {"tools": None, "thinking": False, "vision": None}, only_missing=True)
    assert m3 == {"tools": None, "thinking": False, "vision": None}  # 空位才回填


# ── 假网关表驱动：三能力 × 支持/不支持/含糊 = 9 形状（走真 HTTP 端点） ──


async def test_nine_shapes_via_real_endpoint(client, make_user) -> None:
    """表驱动 9 例：每例只把一型设成待验形状，其余恒 support。

    支持 → 能力位 True；不支持 → False；含糊 → **能力位保持创建时的存储值**
    （这里预置 True/False 交叉看钉死）且 probe_result.capabilities[该型] is None。
    """
    for cap, shape in SHAPES:
        mode = {c: "support" for c in ("tools", "thinking", "vision")}
        mode[cap] = shape
        gw = FakeGateway(mode=mode)
        try:
            h = await _admin(client, make_user, "ns" + cap + shape)
            # 存储位全预置 True 的用意：support 例仍验 True（reject 例验 True→False 的回填），
            # ambiguous 例验「True 原样留住」——把 unknown 折成 False 的变异只有预置 True 才红。
            # False→True 方向的回填由 test_ambiguous_timeout 覆盖（列默认值即 False）。
            preset = {"supports_tools": True, "supports_thinking": True, "supports_vision": True}
            rid = await _mkcfg(client, h, gw.url, "ns" + cap + shape, **preset)
            r = await client.post(BASE + "/model-cfgs/" + rid + "/probe", json={}, headers=h)
            assert r.status_code == 200, r.text
            out = r.json()
            pr_caps = out["probe_result"]["capabilities"]
            col = {"tools": out["capabilities"]["tools"],
                   "thinking": out["capabilities"]["thinking"],
                   "vision": out["capabilities"]["vision"]}
            others = [c for c in ("tools", "thinking", "vision") if c != cap]
            assert all(pr_caps[c] is True for c in others), (cap, shape, pr_caps)
            if shape == "support":
                assert pr_caps[cap] is True and col[cap] is True, (cap, shape, out)
            elif shape == "reject":
                assert pr_caps[cap] is False and col[cap] is False, (cap, shape, out)
            else:  # ambiguous：unknown ≠ 不支持——存储位原样（preset 的相反值），三态 null
                assert pr_caps[cap] is None, (cap, shape, pr_caps)
                # 读库验列（不是探回显）：含糊把存储位折成 False 就是假阴性红线
                g = await client.get(BASE + "/model-cfgs", headers=h)
                row = next(i for i in g.json()["items"] if i["id"] == rid)
                assert row["supports_" + cap] is preset["supports_" + cap], \
                    "含糊态把存储位改写了（假阴性红线）：" + str(row)
            # 每型确实发出了对应的探测请求（tools 带 tools[]、thinking 带思考档、vision 带图）
            kinds = [q["kind"] for q in gw.requests]
            assert kinds == ["tools", "thinking", "vision"], kinds
            vq = next(q for q in gw.requests if q["kind"] == "vision")
            assert "base64" in json.dumps(vq["body"]), "vision 探测必须真带 1px 图 base64"
        finally:
            gw.stop()


async def test_ambiguous_timeout_keeps_store(client, make_user) -> None:
    """超时也是含糊（hang 6s > 5s 超时）：该型 unknown、存储位不动、其余照常回填。"""
    gw = FakeGateway(mode={c: "support" for c in ("tools", "thinking", "vision")}, hang="thinking")
    try:
        h = await _admin(client, make_user, "to")
        rid = await _mkcfg(client, h, gw.url, "to", supports_thinking=True)
        r = await client.post(BASE + "/model-cfgs/" + rid + "/probe", json={}, headers=h)
        out = r.json()
        assert out["probe_result"]["capabilities"]["thinking"] is None
        assert out["capabilities"]["thinking"] is True  # 列上原值（preset）原样
        assert out["capabilities"]["tools"] is True and out["capabilities"]["vision"] is True
    finally:
        gw.stop()


async def test_dead_gateway_all_unknown_not_reject(client, make_user) -> None:
    """连接失败 = ok=False 且三型全 unknown——不可达落成一排 ✗ 就是假阴性。"""
    h = await _admin(client, make_user, "dead")
    rid = await _mkcfg(client, h, "http://127.0.0.1:9/v1", "dead")
    r = await client.post(BASE + "/model-cfgs/" + rid + "/probe", json={}, headers=h)
    out = r.json()
    assert out["ok"] is False and out["error"]
    assert all(v is None for v in out["probe_result"]["capabilities"].values()), out
    # 列上默认值（supports_tools 默认 True）没被落成一排 False
    g = await client.get(BASE + "/model-cfgs", headers=h)
    row = next(i for i in g.json()["items"] if i["id"] == rid)
    assert row["supports_tools"] is True


# ── EMBEDDING：embed("ping") 回填 embed_dimensions（§6.8，列在、此前零写入代码） ──


async def test_embedding_probe_backfills_dimensions(client, make_user) -> None:
    gw = FakeGateway(embeddings=64)
    try:
        h = await _admin(client, make_user, "emb")
        rid = await _mkcfg(client, h, gw.url, "emb", model_type="EMBEDDING")
        assert (await client.get(BASE + "/model-cfgs", headers=h)).json()["items"][0]["embed_dimensions"] is None
        r = await client.post(BASE + "/model-cfgs/" + rid + "/probe", json={}, headers=h)
        assert r.status_code == 200 and r.json()["embed_dimensions"] == 64, r.text
        assert gw.requests[0]["body"]["input"] == "ping"  # §6.8 原话：embed 一条短文本
        g = await client.get(BASE + "/model-cfgs", headers=h)
        assert g.json()["items"][0]["embed_dimensions"] == 64  # 列回填（读侧也钉）
        # 坏形状回显：不猜维度，列保持 null
        bad = FakeGateway(embeddings=None)
        try:
            rid2 = await _mkcfg(client, h, bad.url, "emb2", model_type="EMBEDDING")
            r2 = await client.post(BASE + "/model-cfgs/" + rid2 + "/probe", json={}, headers=h)
            assert r2.json()["embed_dimensions"] is None
        finally:
            bad.stop()
    finally:
        gw.stop()


# ── §6.8 默认思考档 medium 唯一落点 ──


def test_thinking_default_medium_landing() -> None:
    from app.modules.model_cfg.services import thinking_default

    assert thinking_default(["low", "medium", "high"]) == "medium"
    assert thinking_default(["low", "high"]) is None   # 没 medium 不硬造
    assert thinking_default(None) is None
    assert thinking_default([]) is None


# ── 首启探测：seed 幂等 + probe_backfill 幂等/人工值保护/不可达静默 ──


async def test_seed_first_start_probe_idempotent(session, monkeypatch, caplog) -> None:
    """seed 跑两次不多行；probe_backfill 跑两次第二次零写入；人工值不被覆盖；
    网关不可达只 warning 一次且不动任何位。"""
    import logging

    from sqlalchemy import func, select

    from app.modules.model_cfg import seed
    from app.modules.model_cfg.models import ModelConfig

    seed.reset_warning_flags()
    # D130 后 seed 只认 get_settings()（env_file 永不回填 os.environ，setenv 是死源）：
    # 注入改走 Settings 对象本体（test_adb_core.py 同款 setattr 夹具），并清掉可能
    # 串进来的 backend/.env 出厂 seed 键，保证本例只测假网关。
    from app.core.config import get_settings

    for _k in ("TP_MODEL_SEED_BASE_URL", "TP_MODEL_SEED_NAME", "TP_MODEL_SEED_API_KEY"):
        monkeypatch.delenv(_k, raising=False)
    s = get_settings()
    gw = FakeGateway(mode={c: "support" for c in ("tools", "thinking", "vision")})
    try:
        monkeypatch.setattr(s, "model_seed_base_url", gw.url)
        monkeypatch.setattr(s, "model_seed_name", "fundgpt-coder-next")
        monkeypatch.setattr(s, "model_seed_api_key", "")
        assert await seed.seed_default_model(session) is not None
        first = await seed.seed_default_model(session)  # 第二遍命中 existing
        assert first is not None
        n1 = await session.scalar(select(func.count()).select_from(ModelConfig))
        assert n1 == 1, "seed 跑两次多出了行"

        wrote = await seed.probe_backfill(session)
        assert wrote == 1
        await session.rollback()
        cfg = (await session.execute(select(ModelConfig))).scalar_one()
        assert cfg.supports_tools is True and cfg.supports_thinking is True
        assert cfg.supports_vision is True
        assert (cfg.probe_result or {}).get("capabilities", {}).get("vision") is True

        # 幂等：第二次跑——不新增行、零写入（probe_result 同果不改写）
        wrote2 = await seed.probe_backfill(session)
        assert wrote2 == 0
        await session.rollback()
        n2 = await session.scalar(select(func.count()).select_from(ModelConfig))
        assert n2 == 1
        cfg = (await session.execute(select(ModelConfig))).scalar_one()
        assert cfg.supports_vision is True

        # 人工值保护：人工把 vision 关掉（update 端同步 probe_result），再探测不许冲回 True
        cfg.supports_vision = False
        pr = dict(cfg.probe_result or {})
        pr["capabilities"] = {**pr["capabilities"], "vision": False}
        cfg.probe_result = pr
        await session.commit()
        assert await seed.probe_backfill(session) == 0  # only_missing：全有确定值 → 零写
        await session.rollback()
        cfg = (await session.execute(select(ModelConfig))).scalar_one()
        assert cfg.supports_vision is False, "首启回填把人工关掉的 vision 冲回 True 了"
    finally:
        gw.stop()

    # 网关不可达：一次性 warning、零写入、能力位原样
    seed.reset_warning_flags()
    monkeypatch.setattr(s, "model_seed_base_url", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(s, "model_seed_name", "dead-gw")
    await seed.seed_default_model(session)
    await session.rollback()
    with caplog.at_level(logging.WARNING, logger="app.modules.model_cfg.seed"):
        assert await seed.probe_backfill(session) == 0
    warns = [r for r in caplog.records if "不可达" in r.getMessage()]
    assert len(warns) == 1, "不可达必须静默跳过且只 warning 一次，实际 " + str(len(warns))
    await session.rollback()
    dead = (await session.execute(select(ModelConfig).where(
        ModelConfig.model_name == "dead-gw"))).scalar_one()
    assert dead.supports_tools is True and dead.probe_result is None  # 一位没动、账没落


# ── D29 落地：写类 tool=False 显式豁免点名（可数、有名字，不靠 glob 漏网） ──


def test_d29_model_cfg_write_tools_explicitly_exempted() -> None:
    """注册覆盖率钉：model_cfg 全部服务显式点名——写类 tool=False（D29），
    读类/探测 tool 也不开放（§6.8 治理线：模型配置权仅系统管理员，Pilot 不该碰）。
    新增服务不进这份名单 = 本例红（豁免要可数、有名字）。
    """
    import app.modules.model_cfg.services  # noqa: F401  确保注册
    from app.core.registry import REGISTRY

    by_name = {t.name: t for t in REGISTRY.all() if t.name.startswith("model_cfg_")}
    assert set(by_name) == {"model_cfg_create", "model_cfg_list", "model_cfg_update",
                            "model_cfg_delete", "model_cfg_probe"}, \
        "model_cfg 服务集合变了：显式豁免名单要逐名补/删，不许 glob 放过：" + str(set(by_name))
    for n in ("model_cfg_create", "model_cfg_update", "model_cfg_delete"):
        assert by_name[n].tool is False, n + " 写类必须 tool=False（D29）"
    assert by_name["model_cfg_delete"].effect == "destructive"
    assert by_name["model_cfg_probe"].effect == "read"
    assert by_name["model_cfg_probe"].perm.endswith(":read")  # READONLY glob 坑口径
    for n, spec in by_name.items():
        assert spec.tool is False, n + " 泄漏进工具面（§6.8 治理线：模型池仅业主侧管理）"


# ── 真网关诚实条款：本文件的回环端口全部来自 FakeGateway（port=0 系统分配），
# 127.0.0.1:9000 在 CI 与本机是否存在都不赌——真网关探测**未实测**，只进演示手册。


def test_r143_probe_http_client_trust_env_false() -> None:
    """R143 源码钉（senders 同款变异自证）：probe.py 的 AsyncClient 必须 trust_env=False。"""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "app" / "modules" / "model_cfg" / "probe.py"
           ).read_text(encoding="utf-8")
    ctors = re.findall(r"httpx\.AsyncClient\(([^)]*)\)", src)
    assert ctors, "probe.py 里没有任何 httpx.AsyncClient 构造——扫描例被架空"
    for args in ctors:
        assert "trust_env=False" in args, "AsyncClient 缺 trust_env=False（R143）：" + args
        assert "timeout=5.0" in args, "探测必须 5s 超时：" + args
