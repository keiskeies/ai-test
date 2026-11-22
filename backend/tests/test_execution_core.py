"""执行核 run_api：ASGITransport 内存靶，无真实网络。Review Focus 2 钉在此。"""
import json
from urllib.parse import parse_qsl

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from httpx import ASGITransport

from app.modules.execution.core import MAX_BODY_CHARS, run_api

app = FastAPI()


@app.post("/echo")
async def echo(request: Request):
    return JSONResponse({"echo": await request.json(), "auth": request.headers.get("authorization"),
                         "q": dict(request.query_params)})


@app.post("/form")
async def form_echo(request: Request):
    # 不用 request.form()：那要 python-multipart（venv 未装）。直接读线上原始字节，
    # 测试侧自己 parse_qsl——钉的本来就是「发出去的到底是什么」。
    raw = (await request.body()).decode("utf-8")
    return JSONResponse({"form": dict(parse_qsl(raw, keep_blank_values=True)),
                         "ct": request.headers.get("content-type")})


@app.get("/big")
async def big():
    return Response(content="x" * 2_000_000, media_type="text/plain")


@app.get("/bin")
async def bin_():
    return Response(content=b"\x00\x01", media_type="application/octet-stream")


TR = ASGITransport(app=app)


async def test_run_api_vars_and_assertions():
    req = {"method": "POST", "url": "${base}/echo", "params": [["t", "${tenants}"]],
           "headers": [["Authorization", "Bearer ${token}"]],
           "body": {"type": "json", "content": "{\"a\": 1}"},
           "assertions": [{"type": "status_code", "expected": 200},
                          {"type": "json_path_equals", "path": "$.auth", "expected": "Bearer tk"}]}
    r = await run_api(req, variables={"base": "http://t", "token": "tk", "tenants": "a"}, transport=TR)
    assert r.ok and r.passed() and r.status == 200
    body = json.loads(r.body_text)
    assert body["echo"] == {"a": 1}      # 请求体真的送达
    assert body["q"] == {"t": "a"}       # 渲染后的 query 送达
    assert all(x["passed"] for x in r.assertions)


async def test_truncate_and_binary():
    r = await run_api({"method": "GET", "url": "http://t/big"}, transport=TR)
    assert r.truncated and len(r.body_text) <= MAX_BODY_CHARS
    b = await run_api({"method": "GET", "url": "http://t/bin"}, transport=TR)
    assert b.body_text is None and b.body_size == 2
    assert not b.truncated


async def test_connect_error_not_raise():
    r = await run_api({"method": "GET", "url": "http://127.0.0.1:1/x", "timeout_ms": 500})
    assert not r.ok and r.error and r.status is None


async def test_missing_var_raises_up():
    import pytest

    from app.shared.vars import MissingVar
    with pytest.raises(MissingVar):
        await run_api({"method": "GET", "url": "${nope}/x"}, transport=TR)


# —— D172：form body 的 urlencoded content 不许被静默清空 ——


def _form_req(content):
    return {"method": "POST", "url": "http://t/form", "body": {"type": "form", "content": content}}


async def test_form_urlencoded_string_reaches_target():
    """导入器真实产出的 k=v&k=v 串必须原样送达——旧行为 json.loads 失败 → {} 静默清空。"""
    r = await run_api(_form_req("a=1&b=2"), transport=TR)
    assert r.ok and r.status == 200
    got = json.loads(r.body_text)
    assert got["form"] == {"a": "1", "b": "2"}
    assert "application/x-www-form-urlencoded" in got["ct"]


async def test_form_json_object_and_pairs_still_work():
    """JSON 对象串 / pairs 列表串是既有合法形状，退回逻辑不许碰它们。"""
    for content in ('{"a": "1", "b": "2"}', '[["a", "1"], ["b", "2"]]'):
        r = await run_api(_form_req(content), transport=TR)
        assert r.ok and json.loads(r.body_text)["form"] == {"a": "1", "b": "2"}


async def test_form_blank_value_kept():
    """a= 的空值是合法表单值（keep_blank_values），不许丢键；无 '=' 的段按
    parse_qsl 既定语义收成空值对（裁定指定的唯一算法，不发明第二种形状）。"""
    r = await run_api(_form_req("a=&b=2"), transport=TR)
    assert r.ok and json.loads(r.body_text)["form"] == {"a": "", "b": "2"}
    r2 = await run_api(_form_req("a=&b"), transport=TR)
    assert r2.ok and json.loads(r2.body_text)["form"] == {"a": "", "b": ""}


async def test_form_garbage_raises_human_message():
    """非空垃圾串（parse_qsl 一个 pair 都出不来，如 '&&'）：宁抛不装绿（D157 纪律）。
    ValueError 沿调用链上抛，不是 ok=False；消息必须带人话 + 原文前 80 字符（超长截断）。"""
    import pytest

    garbage = "&&"
    with pytest.raises(ValueError) as ei:
        await run_api(_form_req(garbage), transport=TR)
    msg = str(ei.value)
    assert "form body 无法解析" in msg and garbage in msg
    long = "&" * 200
    with pytest.raises(ValueError) as ei2:
        await run_api(_form_req(long), transport=TR)
    assert "&" * 80 in str(ei2.value) and "&" * 81 not in str(ei2.value)


async def test_form_empty_whitespace_none_and_non_str_unchanged():
    """空串/纯空白/None → 空 data 合法；dict/pairs 列表直传照旧。"""
    for content in ("", "   ", None):
        r = await run_api(_form_req(content), transport=TR)
        assert r.ok and json.loads(r.body_text)["form"] == {}
    for content in ({"a": "1"}, [["a", "1"]]):
        r = await run_api(_form_req(content), transport=TR)
        assert r.ok and json.loads(r.body_text)["form"] == {"a": "1"}