"""1E T2 通知渠道：五类发送器 + 加密回显 + 删除引用检测 + R143 源码钉。

形状口径：
- 假接收端 = stdlib http.server 起线程（不引 aiohttp——零新依赖是口径）；
  EMAIL = stdlib socket 手搓的最小假 SMTP。真发送真收到、非 2xx ok=False、
  连接失败回显错误类名（取证 ⑤：回环关闭端口是 Connect* 不是瞬时拒绝）。
- 三家 webhook 载荷差异 = 表驱动（计划 T2 点名）。
- 加密往返：库里 grep 不到明文 token——§10-3 的自证。
- R143 变异自证：正则扫 senders.py 源码，每个 AsyncClient 构造必须带 trust_env=False。
"""
from __future__ import annotations

import asyncio
import json
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tests.test_registry import make_user_named

BASE = "/api/v1"
SENDERS_SRC = Path(__file__).resolve().parents[1] / "app" / "modules" / "notify" / "senders.py"


# ── stdlib 假接收端（http.server，进程内线程） ──


class FakeReceiver:
    """收 POST 记 body/headers 并回固定状态码；port=0 让系统分配。"""

    def __init__(self, status: int = 200, body: str = '{"ok":true}') -> None:
        self.status = status
        self.body = body
        self.received: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                outer.received.append({
                    "path": self.path,
                    "headers": dict(self.headers),
                    "json": json.loads(raw.decode("utf-8")),
                })
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(outer.body.encode("utf-8"))

            def log_message(self, *_a):  # 静音
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:" + str(self.port) + "/hook"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# ── stdlib 最小假 SMTP（socket 手搓；够 smtplib 走完 MAIL/RCPT/DATA/NOOP/QUIT） ──


class FakeSmtp:
    """D140 起带两格计数：connections（accept 次数）与 auth_attempts（AUTH 命令次数）。

    (b) 腿要断言「失败发生在打开 SMTP 之前」——connections==0 是唯一不留死连接的证法；
    EHLO 多行通告 AUTH=LOGIN、AUTH 一律回 235，够 smtplib 的 login() 走完（(a) 腿
    username 回落必须真登录成功才谈得上 From==username）。"""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.messages: list[tuple[bytes, bytes, bytes]] = []  # (mail_from, 全部rcpt拼接, raw)
        self.connections = 0
        self.auth_attempts = 0
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self._handle, args=(c,), daemon=True).start()

    def _handle(self, c: socket.socket) -> None:
        buf = b""
        data_mode = False
        data_lines: list[bytes] = []
        mail_from = b""
        rcpts: list[bytes] = []
        c.sendall(b"220 fake\r\n")
        try:
            while True:
                chunk = c.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\r\n" in buf:
                    line, buf = buf.split(b"\r\n", 1)
                    if data_mode:
                        if line == b".":
                            self.messages.append((mail_from, b"\r\n".join(rcpts), b"\r\n".join(data_lines)))
                            data_mode = False
                            data_lines = []
                            rcpts = []
                            c.sendall(b"250 queued\r\n")
                        else:
                            data_lines.append(line[1:] if line.startswith(b".") else line)
                        continue
                    up = line.upper()
                    if up.startswith(b"EHLO") or up.startswith(b"HELO"):
                        c.sendall(b"250-fake\r\n250 AUTH=LOGIN\r\n")
                    elif up.startswith(b"MAIL"):
                        mail_from = line
                        c.sendall(b"250 ok\r\n")
                    elif up.startswith(b"RCPT"):
                        rcpts.append(line)
                        c.sendall(b"250 ok\r\n")
                    elif up.startswith(b"AUTH"):
                        self.auth_attempts += 1
                        c.sendall(b"235 ok\r\n")
                    elif up.startswith(b"DATA"):
                        data_mode = True
                        c.sendall(b"354 go\r\n")
                    elif up.startswith(b"QUIT"):
                        c.sendall(b"221 bye\r\n")
                        return
                    else:  # NOOP / RSET / 其余一律应答，协议够 smtplib 活着
                        c.sendall(b"250 ok\r\n")
        finally:
            c.close()

    def stop(self) -> None:
        self.sock.close()


# ── R143 · 源码扫描（变异自证：摘掉 trust_env=False 本例必须红） ──


def test_r143_every_async_client_has_trust_env_false() -> None:
    src = SENDERS_SRC.read_text(encoding="utf-8")
    ctors = re.findall(r"httpx\.AsyncClient\(([^)]*)\)", src)
    assert ctors, "senders.py 里没有任何 httpx.AsyncClient 构造——扫描例被架空"
    for args in ctors:
        assert "trust_env=False" in args, "AsyncClient 构造缺 trust_env=False（R143 第三次踩坑）：" + args


# ── 三家 webhook 载荷差异（表驱动，计划 T2 点名） ──


def test_webhook_envelopes_are_distinct_per_channel() -> None:
    from app.modules.notify import senders

    md = "### 报告标题\n正文**加粗**"
    wh = senders._http_payload("WEBHOOK", md)
    dt = senders._http_payload("DINGTALK", md)
    wc = senders._http_payload("WECOM", md)
    fs = senders._http_payload("FEISHU", md)

    assert wh == {"text": md}
    # 钉钉：msgtype=markdown，正文字段是 markdown.text，标题取首行去井号
    assert dt["msgtype"] == "markdown" and dt["markdown"]["text"] == md
    assert dt["markdown"]["title"] == "报告标题"
    # 企微：同为 msgtype=markdown，但正文字段是 markdown.content（无标题）——与钉钉的分歧点
    assert wc == {"msgtype": "markdown", "markdown": {"content": md}}
    assert "title" not in wc["markdown"]
    # 飞书：interactive 卡片，键是下划线 msg_type（不是 msgtype！），正文在 elements[].content
    assert fs["msg_type"] == "interactive" and "msgtype" not in fs
    assert fs["card"]["header"]["title"]["content"] == "报告标题"
    assert fs["card"]["elements"][0]["content"] == md


async def test_senders_real_receive_non2xx_and_refused() -> None:
    from app.core.security import enc_key
    from app.modules.notify import senders

    rx = FakeReceiver()
    try:
        chan = {"type": "DINGTALK", "config": {"url": rx.url, "access_token": enc_key("tk-real-123")}}
        res = await senders.send(chan, "### 定时日报\n通过 12/12")
        assert res.ok is True and res.latency_ms >= 0 and res.error is None
        assert len(rx.received) == 1
        got = rx.received[0]
        assert "access_token=tk-real-123" in got["path"]  # 密文解回后才拼 URL
        assert got["json"]["msgtype"] == "markdown"
        assert "定时日报" in got["json"]["markdown"]["text"]
        assert '"ok":true' in (res.raw or "")
    finally:
        rx.stop()

    # ② 非 2xx → ok=False，HTTP 状态码回显
    rx5 = FakeReceiver(status=500, body="boom")
    try:
        res2 = await senders.send({"type": "WEBHOOK", "config": {"url": rx5.url}}, "x")
        assert res2.ok is False and res2.error == "HTTP 500" and res2.raw == "boom"
    finally:
        rx5.stop()

    # ③ 连接失败 → 错误类名原样回显（取证 ⑤：回环关闭端口是 Connect* 挂起/拒绝）
    res3 = await senders.send({"type": "WECOM", "config": {"url": "http://127.0.0.1:9/hook"}}, "x")
    assert res3.ok is False and res3.error is not None
    assert res3.error.split(":")[0].startswith("Connect"), res3.error
    assert res3.latency_ms >= 0


async def test_send_email_via_fake_smtp_subject_and_body() -> None:
    from app.modules.notify import senders

    srv = FakeSmtp()
    try:
        md = "### 执行结果摘要\n场景：冒烟\n结果：通过"
        chan = {"type": "EMAIL", "config": {
            "smtp_host": "127.0.0.1", "smtp_port": srv.port,
            "use_ssl": False, "use_tls": False,
            "from_addr": "pilot@tp.local", "to_addr": "ops@tp.local, boss@tp.local",
        }}
        res = await senders.send(chan, md)
        assert res.ok is True, res.error
        for _ in range(50):  # 服务端线程在回 250 之后才落 messages：最多等 0.5s
            if srv.messages:
                break
            await asyncio.sleep(0.01)
        assert len(srv.messages) == 1
        _mail_from, rcpt, raw = srv.messages[0]
        text = raw.decode("utf-8")
        # 主题 = 首个非空行去 Markdown 井号；中文主题按 RFC 2047 编码，钉编码后的确切串
        assert "Subject: =?utf-8?b?5omn6KGM57uT5p6c5pGY6KaB?=" in text  # = 「执行结果摘要」
        assert "场景：冒烟" in text and "结果：通过" in text  # 正文原样
        assert b"ops@tp.local" in rcpt
    finally:
        srv.stop()


# ── D140：From 头的三条腿（username 回落照承诺、双空硬失败不碰 SMTP、from_addr 优先） ──


def _email_config(srv_port: int, **over) -> dict:
    """按**落库态**造 config：password 是敏感键（D24），发送器会先解密——裸明文会撞
    DecryptFailedError（test_senders_real_receive 给 token 加密同法）。"""
    from app.core.security import enc_key

    cfg: dict = {"smtp_host": "127.0.0.1", "smtp_port": srv_port,
                 "use_ssl": False, "use_tls": False, "to_addr": "ops@tp.local"}
    for k, v in over.items():
        cfg[k] = enc_key(v) if k == "password" else v
    return cfg


async def test_email_from_falls_back_to_username() -> None:
    """(a) from_addr 空 + username 有 → 照常发，From = 登录账号（表单承诺的那半句）。"""
    from app.modules.notify import senders

    srv = FakeSmtp()
    try:
        chan = {"type": "EMAIL", "config": _email_config(
            srv.port, from_addr="", username="pilot@tp.local", password="pw")}
        res = await senders.send(chan, "### 回落\n正文")
        assert res.ok is True, res.error
        for _ in range(50):  # 服务端线程在回 250 之后才落 messages：最多等 0.5s
            if srv.messages:
                break
            await asyncio.sleep(0.01)
        assert len(srv.messages) == 1
        mail_from, _rcpt, raw = srv.messages[0]
        assert b"pilot@tp.local" in mail_from, raw.decode("utf-8")
        assert srv.auth_attempts == 1, "username 在场就该照常登录"
    finally:
        srv.stop()


async def test_email_missing_from_and_username_fails_before_smtp() -> None:
    """(b) from_addr 与 username 都空 → 硬配置错误，**一条 SMTP 连接都不许发起**。

    此前的兜底 testpilot@localhost 是凭空发明的域名本地地址：发送看着「成功」，
    邮件永远不会到人手里。口径按本模块既有失败形状：_smtp_send 里 raise ValueError
    （与缺 smtp_host/缺 to_addr 同族），_send_email 吸收成 ok=False 回显。
    """
    from app.modules.notify import senders

    srv = FakeSmtp()
    try:
        chan = {"type": "EMAIL", "config": _email_config(srv.port, from_addr="", username="")}
        res = await senders.send(chan, "x")
        assert res.ok is False and res.error is not None
        assert "发件地址" in res.error, res.error
        assert srv.connections == 0, "配置错误必须拦在打开 SMTP 之前"
        assert srv.auth_attempts == 0 and srv.messages == []
    finally:
        srv.stop()


async def test_email_from_addr_wins_over_username() -> None:
    """(c) from_addr 与 username 都有 → From = from_addr（显式值赢，回落只在缺位时生效）。"""
    from app.modules.notify import senders

    srv = FakeSmtp()
    try:
        chan = {"type": "EMAIL", "config": _email_config(
            srv.port, from_addr="noreply@tp.local", username="pilot@tp.local", password="pw")}
        res = await senders.send(chan, "x")
        assert res.ok is True, res.error
        for _ in range(50):
            if srv.messages:
                break
            await asyncio.sleep(0.01)
        assert len(srv.messages) == 1
        mail_from, _rcpt, raw = srv.messages[0]
        assert b"noreply@tp.local" in mail_from and b"From: noreply@tp.local" in raw
    finally:
        srv.stop()


async def test_send_never_raises_decrypt_failed() -> None:
    """D28：密文解不开（主密钥变更）→ 如实回 DECRYPT_FAILED，不抛不 500。"""
    from app.modules.notify import senders

    chan = {"type": "WEBHOOK", "config": {"url": "http://127.0.0.1:9/h", "access_token": "gAAAA-not-a-real-token"}}
    res = await senders.send(chan, "x")
    assert res.ok is False and res.error == "****(无法解密)"

    # 未知渠道 / 缺 url 同样不许抛
    assert (await senders.send({"type": "SMS", "config": {}}, "x")).ok is False
    assert (await senders.send({"type": "WEBHOOK", "config": {}}, "x")).ok is False
    assert (await senders.send({"type": "EMAIL", "config": {}}, "x")).ok is False


# ── 服务面：枚举 422 / 打码回显 / 加密落库（§10-3 自证）/ PATCH 打码不毁钥 / 删除引用 ──


async def _admin_h(client, make_user, tag: str):
    _u, h = await make_user("nt_" + tag, admin=True)
    return h


def _hook_config(token: str = "abcdefghij9876", url: str = "http://127.0.0.1:9/hook") -> dict:
    return {"url": url, "access_token": token, "at_mobiles": ["13800000000"]}


async def test_create_bad_type_422_and_legal_types_ok(client, make_user) -> None:
    """枚外 422 只钉「明显不是渠道提供者」的串（NOT_A_CHANNEL 永远不会变合法——
    负例不抄清单， CHANNEL_TYPES 扩容时不会 rot）；合法侧从 CHANNEL_TYPES 推导。"""
    from app.modules.notify.models import CHANNEL_TYPES

    h = await _admin_h(client, make_user, "ty")
    r = await client.post(BASE + "/notify-channels",
                          json={"name": "坏类型", "type": "NOT_A_CHANNEL", "config": {}}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_failed", r.text
    for t in CHANNEL_TYPES:
        rr = await client.post(BASE + "/notify-channels",
                               json={"name": "渠道-" + t, "type": t, "config": {}}, headers=h)
        assert rr.status_code == 201, t + " 应合法：" + rr.text


async def test_encrypt_at_rest_and_masked_readback(client, make_user, session) -> None:
    """§10-3 自证：库里 grep 不到明文 token；回显逐键打码（token•••• / query 段[已配置]）。"""
    from sqlalchemy import text as sa_text

    from app.core.security import dec_key
    from app.modules.notify.models import NotifyChannel

    h = await _admin_h(client, make_user, "enc")
    url = "https://oapi.example.com/robot/send?access_token=QUERYSECRET999&x=1"
    r = await client.post(BASE + "/notify-channels",
                          json={"name": "密文渠道", "type": "DINGTALK", "config": _hook_config(url=url)}, headers=h)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["config"]["access_token"] == "abcde••••"  # 前 5 位 + 掩码
    # D24：url 的 query 段逐值加密/打码（整段无明文联调值），path/scheme 明文
    _cfgd = "%5B%E5%B7%B2%E9%85%8D%E7%BD%AE%5D"
    assert out["config"]["url"] == "https://oapi.example.com/robot/send?access_token=" + _cfgd + "&x=" + _cfgd
    assert out["config"]["at_mobiles"] == ["13800000000"]  # 非敏感键明文
    assert "abcdefghij9876" not in r.text and "QUERYSECRET999" not in r.text

    # 库里逐字节 grep：明文不许出现（§10-3 原话「渠道配置 Fernet 加密」）
    raw = (await session.execute(sa_text("SELECT CAST(config AS CHAR) FROM notify_channel WHERE id=:i"),
                                 {"i": out["id"]})).scalar_one()
    assert "abcdefghij9876" not in raw and "QUERYSECRET999" not in raw
    row = (await session.get(NotifyChannel, out["id"])) or None
    assert row is not None
    assert dec_key(row.config["access_token"]) == "abcdefghij9876"

    # PATCH 把打码回显原样送回 = 没改：旧密文必须活着（不许把 •••• 当新值加密）
    patched = dict(out["config"])
    patched["at_mobiles"] = ["13900000000"]
    u = await client.patch(BASE + "/notify-channels/" + out["id"], json={"config": patched}, headers=h)
    assert u.status_code == 200, u.text
    await session.refresh(row)
    assert dec_key(row.config["access_token"]) == "abcdefghij9876"
    assert row.config["at_mobiles"] == ["13900000000"]

    # 真换 token → 新密文新明文
    u2 = await client.patch(BASE + "/notify-channels/" + out["id"],
                            json={"config": {**patched, "access_token": "zzz-new-token"}}, headers=h)
    assert u2.status_code == 200
    await session.refresh(row)
    assert dec_key(row.config["access_token"]) == "zzz-new-token"


async def test_delete_reference_detection_409(client, make_user, session) -> None:
    """删除前引用检测：schedule_task.notify_channel_ids 命中 → 409 列引用（scenario_case_refs 语义）。"""
    from app.modules.schedule.models import ScheduleTask

    h = await _admin_h(client, make_user, "ref")
    rid = (await client.post(BASE + "/notify-channels",
                             json={"name": "被引用渠道", "type": "WEBHOOK", "config": {}}, headers=h)).json()["id"]

    task = ScheduleTask(project_id="p_ref", name="夜跑", subject_type="scenario", subject_id="s1",
                        cron="0 2 * * *", notify_channel_ids=[rid, "other"])
    task2 = ScheduleTask(project_id="p_ref", name="无关", subject_type="scenario", subject_id="s2",
                         cron="0 3 * * *", notify_channel_ids=["nope"])
    session.add_all([task, task2])
    await session.commit()
    task_id = task.id  # HTTP 端的 rollback 会过期 ORM 实例：id 提前存成标量

    d = await client.post(BASE + "/notify-channels/" + rid + "/delete", json={}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    det = d.json()["details"]
    assert det["count"] == 1 and det["details_hidden"] is False
    assert det["tasks"][0]["name"] == "夜跑" and det["tasks"][0]["task_id"] == task_id

    # 解绑后可删；未引用的渠道直删（重新取行：旧实例已被端点 rollback 过期）
    fresh = await session.get(ScheduleTask, task_id)
    assert fresh is not None
    fresh.notify_channel_ids = []
    await session.commit()
    d2 = await client.post(BASE + "/notify-channels/" + rid + "/delete", json={}, headers=h)
    assert d2.status_code == 200, d2.text
    g = await client.get(BASE + "/notify-channels", headers=h)
    assert all(i["id"] != rid for i in g.json()["items"])


async def test_channel_get_single_and_platform_level_access(client, make_user) -> None:
    """notify_channel_get 首次走 HTTP（此前这个 url 只被 PATCH/DELETE/test 试过）。

    与实际行为对齐的钉（不是预判的「跨项目 403 forbidden」）：notify_channel 表没有
    project_id 列——渠道是平台级资产，不存在「别人项目的那条渠道」。非管理员无论 id
    存在与否都是同一个 403 insufficient_permission（perm 先于查库挡下），存在性不泄露。
    """
    h = await _admin_h(client, make_user, "g1")
    created = await client.post(BASE + "/notify-channels",
                                json={"name": "单查渠道", "type": "DINGTALK", "config": _hook_config()}, headers=h)
    assert created.status_code == 201, created.text
    cid = created.json()["id"]

    # ① 正常单查：打码回显 + last_send（新渠道没发过 = None）
    g = await client.get(BASE + "/notify-channels/" + cid, headers=h)
    assert g.status_code == 200, g.text
    body = g.json()
    assert body["id"] == cid and body["name"] == "单查渠道" and body["type"] == "DINGTALK"
    assert body["config"]["access_token"] == "abcde••••" and body["last_send"] is None
    assert "abcdefghij9876" not in g.text  # 打码回显不许漏明文

    # ② 不存在的 id → 404 not_found
    miss = await client.get(BASE + "/notify-channels/no-such-channel", headers=h)
    assert miss.status_code == 404 and miss.json()["code"] == "not_found", miss.text

    # ③ 别的项目的人（哪怕项目管理员）来 GET 这条 id：平台位缺失 → 403。
    #    存在与不存在回同一个码，探不出「这条 id 在不在」。
    pid = (await client.post("/api/v1/projects", json={"name": "nt_gget"}, headers=h)).json()["id"]
    hs = await make_user_named(client, h, pid, "nt_gget_pa", "PROJECT_ADMIN")
    r1 = await client.get(BASE + "/notify-channels/" + cid, headers=hs)
    assert r1.status_code == 403 and r1.json()["code"] == "insufficient_permission", r1.text
    # 不存在的 id 也回 403（不是 404）：两种 id 同码同形，存在性探不出来
    r2 = await client.get(BASE + "/notify-channels/no-such-channel", headers=hs)
    assert r2.status_code == r1.status_code and r2.json()["code"] == r1.json()["code"], r2.text

    # ④ 平台级语义：另一个系统管理员也读得到（渠道不绑项目，这是实际模型，如实钉住）
    _u2, h2 = await make_user("nt_g2_admin", admin=True)
    g2 = await client.get(BASE + "/notify-channels/" + cid, headers=h2)
    assert g2.status_code == 200 and g2.json()["id"] == cid, g2.text


async def test_test_send_returns_and_lands_last_send(client, make_user, session) -> None:
    """测试发送：POST 端点 + :read 权限 + 行内 ✓/✗ + 原始响应 + last_send 落账（D28）。"""
    from app.modules.notify.models import NotifyChannel

    rx = FakeReceiver(status=202, body='{"status":"queued"}')
    try:
        h = await _admin_h(client, make_user, "ts")
        rid = (await client.post(BASE + "/notify-channels",
                                 json={"name": "测试发送渠道", "type": "WEBHOOK",
                                       "config": {"url": rx.url}}, headers=h)).json()["id"]
        r = await client.post(BASE + "/notify-channels/" + rid + "/test", json={}, headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True and body["raw"] and '"queued"' in body["raw"]
        assert body["last_send"]["ok"] is True and body["last_send"]["checked_at"]
        row = await session.get(NotifyChannel, rid)
        assert row is not None and row.last_send["ok"] is True
        assert len(rx.received) == 1 and "渠道测试" in rx.received[0]["json"]["text"]
    finally:
        rx.stop()


async def test_readonly_glob_covers_test_send_perm(client) -> None:
    """READONLY glob 坑第三次预警的钉：测试发送 perm 必须以 :read 结尾且被 ["*:read"] 命中；
    写类 tool=False（D29）；四权限位齐。"""
    import app.modules.notify.service  # noqa: F401  确保注册
    from app.core.permissions import match_perm
    from app.core.registry import REGISTRY

    by_name = {t.name: t for t in REGISTRY.all() if t.name.startswith("notify_channel_")}
    test = by_name["notify_channel_test"]
    assert test.perm == "notify:channel:read" and test.perm.endswith(":read")
    assert match_perm({"*:read"}, test.perm), "READONLY 角色必须能测试发送"
    assert test.effect == "read", "测试发送不写业务数据（只回写 last_send），effect 照 model_cfg_probe"
    assert {t.perm for t in by_name.values()} >= {
        "notify:channel:read", "notify:channel:create", "notify:channel:update", "notify:channel:delete"}
    for n in ("notify_channel_create", "notify_channel_update", "notify_channel_delete"):
        assert by_name[n].tool is False, n + " 写类必须 tool=False（D29）"
    assert by_name["notify_channel_delete"].effect == "destructive"


async def test_permissions_and_platform_level(client, make_user) -> None:
    """平台级渠道：无 project_id → 非管理员基础位不含 notify:* → 403 insufficient_permission。"""
    h = await _admin_h(client, make_user, "pm")
    _u, h_ro = await make_user("nt_ro_user")
    r = await client.get(BASE + "/notify-channels", headers=h_ro)
    assert r.status_code == 403 and r.json()["code"] == "insufficient_permission", r.text
    # 平台项目管理员的项目权限也不含 notify:*（三段式平台位与项目位不互相渗漏，R30）
    pid = (await client.post("/api/v1/projects", json={"name": "nt_gov"}, headers=h)).json()["id"]
    hs = await make_user_named(client, h, pid, "nt_pa", "PROJECT_ADMIN")
    r2 = await client.post(BASE + "/notify-channels",
                           json={"name": "越权渠道", "type": "WEBHOOK", "config": {}}, headers=hs)
    assert r2.status_code == 403 and r2.json()["code"] == "insufficient_permission", r2.text
    # 管理员全程可用
    assert (await client.get(BASE + "/notify-channels", headers=h)).status_code == 200


async def test_service_module_registered_in_main() -> None:
    """注册钩点钉：notify.service 在 app/main._SERVICE_MODULES 清单里（漏 import = 路由静默 404）。"""
    from app.main import _SERVICE_MODULES

    assert "app.modules.notify.service" in _SERVICE_MODULES
