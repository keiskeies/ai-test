"""通知渠道发送器（§11.4.26，1E T2）：五类渠道的纯出站 I/O。

三条硬口径（计划 T2 原文）：
- **httpx 一律 `trust_env=False`**（R143，第三次踩同一坑）：宿主 no_proxy 含 [::1]
  会让 httpx 解析炸；tests/test_notify.py 的源码扫描例把「每个 AsyncClient 构造都带
  这个参数」钉成契约，摘掉就红。超时 5s（对齐 model_cfg_probe）。
- **`except Exception` 吸收一切网络异常**：回环关闭端口实测 ConnectTimeout ≈2094ms
  （取证 ⑤），测试发送不许把挂起/拒绝变成 500——错误按 `type(e).__name__ + ": " +
  str(e)[:180]` 原样回显（model_cfg_probe 同款形状）。
- **EMAIL 不引新依赖**（无 aiosmtplib）：stdlib smtplib 经 `asyncio.to_thread`，
  超时靠 socket timeout（smtplib 构造函数的 timeout 参数）。

D24 的加解密知识集中在本模块（`encrypt_config`/`decrypt_config`/`mask_config`）：
敏感键（键名含 token/secret/password/api_key）的**值** Fernet，url 键的 query 段逐值
Fernet、其余明文；回显解密后逐键打码（`token前5位••••` / query 段 `[已配置]`）。
发送器解密失败回 `****(无法解密)`，不 500（D24 原文）。
"""
from __future__ import annotations

import asyncio
import smtplib
import ssl
import time
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.core.errors import ApiError
from app.core.security import dec_key, enc_key

TIMEOUT_S = 5.0  # 对齐 model_cfg_probe（计划 T2 点名的尺）
RAW_CAP = 500
ERR_CAP = 180

# D24 敏感键判定：键名（小写）含以下任一片段即「值需加密」。
SENSITIVE_SUBSTRINGS = ("token", "secret", "password", "api_key", "apikey")
DECRYPT_FAILED = "****(无法解密)"


class DecryptFailedError(Exception):
    """D24：主密钥变更后旧密文解不开——发送器如实回 DECRYPT_FAILED，不 500。"""


@dataclass
class SendResult:
    """一次发送的结果：ok + 延迟 + 错误回显 + 原始响应（§11.4.26 行内 ✓/✗ + 原始响应）。"""

    ok: bool
    latency_ms: int = 0
    error: str | None = None
    raw: str | None = None


# ── D24：config 逐键加解密/打码（服务层与发送器共用的唯一真相） ──


def is_sensitive_key(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in SENSITIVE_SUBSTRINGS)


def _is_url_key(key: str) -> bool:
    return key.lower() == "url" or key.lower().endswith("_url")


def _map_url_query(url: Any, fn: Any) -> Any:
    """对 url 的 query 段逐值应用 fn（加密/解密/打码）；无 query 段原样返回。"""
    if not isinstance(url, str):
        return url
    parts = urlsplit(url)
    if not parts.query:
        return url
    qs = [(k, fn(v)) for k, v in parse_qsl(parts.query, keep_blank_values=True)]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(qs), parts.fragment))


def encrypt_config(config: dict[str, Any]) -> dict[str, Any]:
    """落库前（D24）：敏感键值 + url query 段值 Fernet；其余明文原样。"""
    return {k: _encrypt_value(k, v) for k, v in config.items()}


def _encrypt_value(key: str, value: Any) -> Any:
    if is_sensitive_key(key) and isinstance(value, str) and value:
        return enc_key(value)
    if _is_url_key(key) and isinstance(value, str):
        return _map_url_query(value, enc_key)
    return value


def merge_config_for_update(stored: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """PATCH 整体替换的 D24 归并：新值 == 当前打码回显 → 视为「没改」、保留旧密文
    （前端把回显原样 PATCH 回来不许毁密钥，也不许把 •••• 当新值再加密一层）；
    其余新值逐键加密。**不许对 stored 的旧密文二次加密**——所以逐键判定而非整包重加密。"""
    masked = mask_config(stored)
    out: dict[str, Any] = {}
    for k, v in incoming.items():
        if k in stored and v == masked.get(k):
            out[k] = stored[k]
        else:
            out[k] = _encrypt_value(k, v)
    return out


def decrypt_config(config: dict[str, Any]) -> dict[str, Any]:
    """发送前解回明文；任一敏感值解不开 → DecryptFailedError（调用方如实回显）。"""
    out: dict[str, Any] = {}
    for k, v in config.items():
        try:
            if is_sensitive_key(k) and isinstance(v, str) and v:
                out[k] = dec_key(v)
            elif _is_url_key(k) and isinstance(v, str):
                out[k] = _map_url_query(v, dec_key)
            else:
                out[k] = v
        except ApiError as e:
            raise DecryptFailedError(k) from e
    return out


def mask_config(config: dict[str, Any]) -> dict[str, Any]:
    """回显逐键打码（§11.4.26「关键配置(打码)」）：敏感值露前 5 位 + ••••，
    url query 段整段换 `[已配置]`（不泄露前缀）；解不开 → `****(无法解密)`。"""
    out: dict[str, Any] = {}
    for k, v in config.items():
        if is_sensitive_key(k) and isinstance(v, str) and v:
            try:
                p = dec_key(v)
            except ApiError:
                out[k] = DECRYPT_FAILED
            else:
                out[k] = p[:5] + "••••" if len(p) > 5 else "••••"
        elif _is_url_key(k) and isinstance(v, str):
            try:
                out[k] = _map_url_query(v, lambda _v: "[已配置]")
            except ApiError:  # pragma: no cover - 打码不解密，理论不可达，留着兜底
                out[k] = DECRYPT_FAILED
        else:
            out[k] = v
    return out


# ── 五类渠道的载荷与发送 ──


def _title(markdown: str) -> str:
    """钉钉/飞书卡片标题 = 首个非空行去 Markdown 井号；兜底平台名。"""
    for line in markdown.splitlines():
        s = line.strip().lstrip("#").strip()
        if s:
            return s[:60]
    return "TestPilot 通知"


def _http_payload(channel_type: str, markdown: str) -> dict[str, Any]:
    """三家 webhook 的 JSON 信封差异（表驱动测试钉住）+ 通用 WEBHOOK 的 {"text"}。"""
    if channel_type == "WEBHOOK":
        return {"text": markdown}
    if channel_type == "DINGTALK":
        return {"msgtype": "markdown", "markdown": {"title": _title(markdown), "text": markdown}}
    if channel_type == "WECOM":
        return {"msgtype": "markdown", "markdown": {"content": markdown}}
    if channel_type == "FEISHU":
        return {"msg_type": "interactive", "card": {
            "header": {"title": {"tag": "plain_text", "content": _title(markdown)}},
            "elements": [{"tag": "markdown", "content": markdown}],
        }}
    raise ValueError("未知渠道类型：" + channel_type)


async def _send_http(channel_type: str, config: dict[str, Any], markdown: str) -> SendResult:
    url = str(config.get("url") or "")
    if not url:
        raise ValueError("渠道配置缺少 url")
    # 钉钉允许 access_token 单独成键（敏感键加密落库）；拼进 query 前先解密（已解密态）。
    token = str(config.get("access_token") or "")
    if channel_type == "DINGTALK" and token and "access_token" not in url:
        url += ("&" if "?" in url else "?") + "access_token=" + token
    payload = _http_payload(channel_type, markdown)
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, trust_env=False) as client:
            resp = await client.post(url, json=payload)
        latency = int((time.perf_counter() - t0) * 1000)
        raw = resp.text[:RAW_CAP]
        if resp.status_code >= 400:
            return SendResult(ok=False, latency_ms=latency, error="HTTP " + str(resp.status_code), raw=raw)
        return SendResult(ok=True, latency_ms=latency, raw=raw)
    except Exception as e:  # noqa: BLE001  网络异常一律吸收回显（取证 ⑤：挂起/拒绝不许冒泡）
        latency = int((time.perf_counter() - t0) * 1000)
        return SendResult(ok=False, latency_ms=latency,
                          error=type(e).__name__ + ": " + str(e)[:ERR_CAP])


def _smtp_send(config: dict[str, Any], markdown: str) -> str:
    """同步 smtplib 发送体（跑在 asyncio.to_thread 里）；超时靠 socket timeout。"""
    host = str(config.get("smtp_host") or config.get("host") or "")
    if not host:
        raise ValueError("邮箱渠道配置缺少 smtp_host")
    port = int(config.get("smtp_port") or config.get("port") or 465)
    use_ssl = bool(config.get("use_ssl", port == 465))
    use_tls = bool(config.get("use_tls", not use_ssl))
    to = config.get("to_addr")
    tos = to if isinstance(to, list) else [t.strip() for t in str(to or "").replace(";", ",").split(",") if t.strip()]
    if not tos:
        raise ValueError("邮箱渠道配置缺少 to_addr")
    msg = EmailMessage()
    # D140：表单写着「留空用登录账号」，from_addr 空 + username 也空时不许再造一个
    # 不存在的 testpilot@localhost（收不发的域名本地地址，骗过一个是一个）——
    # 按本模块既有失败口径（缺 smtp_host / 缺 to_addr 同款）在**打开 SMTP 之前**
    # 硬配置错误，_send_email 照旧吸收成 ok=False 回显。username 在则留空回落 = 承诺兑现。
    from_ = str(config.get("from_addr") or config.get("username") or "")
    if not from_:
        raise ValueError("SMTP 渠道缺少发件地址：from_addr 与 username 均为空")
    msg["From"] = from_
    msg["To"] = ", ".join(str(t) for t in tos)
    msg["Subject"] = _title(markdown)
    msg.set_content(markdown)
    ctx = ssl.create_default_context()
    if use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_S, context=ctx)
    else:
        server = smtplib.SMTP(host, port, timeout=TIMEOUT_S)
    with server:
        if not use_ssl and use_tls:
            server.starttls(context=ctx)
        if config.get("username"):
            server.login(str(config["username"]), str(config.get("password") or ""))
        server.send_message(msg, to_addrs=[str(t) for t in tos])
        code, data = server.noop()  # 一次廉价往返，拿服务器原文当 raw
    return (str(code) + " " + repr(data))[:RAW_CAP]


async def _send_email(config: dict[str, Any], markdown: str) -> SendResult:
    t0 = time.perf_counter()
    try:
        raw = await asyncio.to_thread(_smtp_send, config, markdown)
        return SendResult(ok=True, latency_ms=int((time.perf_counter() - t0) * 1000), raw=raw)
    except Exception as e:  # noqa: BLE001  同款吸收（socket 挂起/拒绝不许冒泡）
        return SendResult(ok=False, latency_ms=int((time.perf_counter() - t0) * 1000),
                          error=type(e).__name__ + ": " + str(e)[:ERR_CAP])


def _channel_parts(channel: Any) -> tuple[str, dict[str, Any]]:
    """channel 允许 ORM 行（.type/.config）或 dict（{"type","config"}）——测试与 T3 都能喂。"""
    if isinstance(channel, dict):
        return str(channel.get("type") or ""), dict(channel.get("config") or {})
    return str(getattr(channel, "type", "") or ""), dict(getattr(channel, "config", None) or {})


async def send(channel: Any, markdown: str) -> SendResult:
    """按渠道类型发送一条 Markdown 通知；**永不抛**——一切失败回 SendResult(ok=False, error=…)。"""
    ctype, config = _channel_parts(channel)
    try:
        config = decrypt_config(config)
    except DecryptFailedError:
        return SendResult(ok=False, error=DECRYPT_FAILED)
    try:
        if ctype == "EMAIL":
            return await _send_email(config, markdown)
        if ctype in ("WEBHOOK", "DINGTALK", "WECOM", "FEISHU"):
            return await _send_http(ctype, config, markdown)
        return SendResult(ok=False, error="ValueError: 未知渠道类型：" + ctype)
    except Exception as e:  # noqa: BLE001  最后一道闸：send 的签名承诺是不抛
        return SendResult(ok=False, error=type(e).__name__ + ": " + str(e)[:ERR_CAP])
