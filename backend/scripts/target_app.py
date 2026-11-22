"""靶场应用（:9999，TP_TARGET_PORT 可覆盖）：业主演示 + e2e 的假业务系统。1A 执行引擎复用。

启动：backend/.venv/Scripts/python.exe scripts/target_app.py
端口 9999 是 e2e lane 的固定约定（playwright webServer 钉死它）；并行工具（如
scripts/verify_worker.py）要起一份自己的靶场时必须换端口，用 TP_TARGET_PORT 指路。
"""
from __future__ import annotations

import asyncio
import os
from urllib.parse import parse_qs

import uvicorn
from fastapi import Cookie, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

app = FastAPI(title="TestPilot 靶场", docs_url="/docs")

_TOKEN = "tk-demo"  # 与种子 token 变量一致：静态演示令牌（e2e 可重放）


@app.post("/login")
async def login(payload: dict) -> dict:
    if payload.get("username") == "demo" and payload.get("password") == "demo123":
        return {"token": _TOKEN, "user": {"id": 1, "name": "演示用户"}}
    raise HTTPException(401, {"code": "bad_credentials", "message": "账号或密码错误"})


@app.get("/order/{order_id}")
async def order(order_id: str, authorization: str | None = Header(default=None)) -> dict:
    if authorization != "Bearer " + _TOKEN:
        raise HTTPException(401, {"code": "unauthorized", "message": "缺少或错误的令牌"})
    return {"order_id": order_id, "status": "PAID", "amount": 99.0,
            "items": [{"sku": "A-1", "qty": 2, "price": 49.5}]}


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


# ── 1B 加的两个「不完美」靶（§14：执行核自测要有可控 delay / 错误接口）────────────
# 没有这两件，引擎的超时、取消、重试、loop.while 退出条件全都能在「一切顺利」下测绿：
# 呼吸高亮要一个真跑得够慢的窗口才看得见，重试要一个真会失败的前几次才谈得上。


@app.get("/slow")
async def slow(ms: int = 500) -> dict:
    """睡 ms 毫秒再返回，上限 10s。给「运行中」留出可观察窗口（T21 呼吸高亮、取消）。

    钳上限而不是拒绝：调用方是测试与演示，写歪一个 0 或 999999 不该变成 4xx，
    但也绝不能让一个手滑把 worker 占住几分钟——占住 worker 是会连带拖垮别人的测试。
    """
    await asyncio.sleep(min(max(ms, 0), 10_000) / 1000)
    return {"slept_ms": min(max(ms, 0), 10_000), "status": "ok"}


# 每个 key 独立计数。**必须按 key 计**：全局计数的话同一条 e2e 跑第二遍时计数早已耗尽，
# 「前 N 次失败」变成「永远成功」，测试就退化成绿锁（本项目反复栽的那类）。
# 调用方每次用自己的唯一 key（如 run_id / 随机串），从而可重放。
_FLAKY: dict[str, int] = {}
_FLAKY_MAX = 1000  # 防泄漏：key 由调用方随便编，攒够就把早期的清掉


@app.get("/flaky")
async def flaky(key: str, fail_first: int = 1) -> dict:
    """同一个 key 的前 fail_first 次返回 500，之后返回 200。

    验 loop.while「三次后条件成立退出」、失败重试、以及 fail_fast 两种取向。
    """
    seen = _FLAKY.get(key, 0)
    _FLAKY[key] = seen + 1
    if len(_FLAKY) > _FLAKY_MAX:
        for stale in list(_FLAKY)[: _FLAKY_MAX // 2]:
            _FLAKY.pop(stale, None)
    attempt = seen + 1
    if attempt <= fail_first:
        raise HTTPException(500, {"code": "flaky_upstream",
                                  "message": f"第 {attempt} 次调用失败（前 {fail_first} 次设计为失败）"})
    return {"attempt": attempt, "status": "ok"}


@app.delete("/flaky")
async def flaky_reset(key: str) -> dict:
    """清掉某个 key 的计数，让同一条用例能原样重放。"""
    _FLAKY.pop(key, None)
    return {"reset": key}


# ── 1C 加的 UI 靶页（§6.3 / 计划 R98）────────────────────────────────────
# 1C 之前这个靶场只有 JSON 接口、**零 HTML**（实测），UI 用例没有可操作的东西。
# 加在同一进程而不是开第二个靶：端口是 e2e 的固定约定（playwright webServer 钉 9999），
# 多一个靶就多一个启停环节，演示时容易漏起——漏起的表现为「元素找不到」，很难归因。
#
# 纯 stdlib 字符串模板，不引 jinja：为几页 HTML 加一个依赖不值当。
# **锚点用 id 且刻意稳定**（#account / #title / …）：元素库演示与 e2e 都靠它们，
# 改动会让两边一起红，这是有意的耦合——脆断要断在编译期/单测期，不是断在演示中途。

_PAGE_CSS = """
body{font-family:system-ui,sans-serif;margin:2rem;background:#f6f7f9;color:#1f2328}
h1{font-size:1.3rem}table{border-collapse:collapse;margin-top:1rem}
th,td{border:1px solid #d0d7de;padding:.4rem .8rem;background:#fff;text-align:left}
.err{color:#c00;font-weight:600}.card{background:#fff;border:1px solid #d0d7de;
padding:1rem;max-width:22rem;border-radius:6px}
#overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;
align-items:center;justify-content:center}
#overlay.on{display:flex}#dialog{background:#fff;padding:1rem;border-radius:6px}
"""


def _html(title: str, body: str, status: int = 200):
    return HTMLResponse(f"<!doctype html><html lang=zh><head><meta charset=utf-8>"
                        f"<title>{title}</title><style>{_PAGE_CSS}</style></head>"
                        f"<body>{body}</body></html>", status_code=status)


# 登录页五个锚点（tests/test_ui_deps.py 钉着，改名要同步改种子元素）。
# #err **常驻但默认 hidden**：定位器指向一个「只在出错时才存在」的节点，会让
# 元素库里那个元素在正常页面上直接解析失败——所以节点一直在，出错时只是去掉 hidden
# 并填文案。断言判的是可见性与文案，不是节点存不存在。
_LOGIN_HTML = """
<h1>演示商城 · 登录</h1>
<p id="login-tip">演示账号 demo / demo123（错口令会停在本页并报「账号或密码错误」）</p>
<form id="login-form" method="post" action="/ui/login">
  <p><label>账号 <input id="account" name="account"></label></p>
  <p><label>口令 <input id="password" name="password" type="password"></label></p>
  <p><button id="submit" type="submit">登 录</button></p>
  <p id="err" class="err"[[ATTR]]>[[MSG]]</p>
</form>
"""


@app.get("/ui/login")
async def ui_login(err: str = ""):
    """登录页。错误走 **query 回显**（POST-Redirect-GET）而不是 flash cookie：
    演示与 e2e 要能一眼看出这一页是上次失败后停在这儿的，而不必猜服务端状态。"""
    bad = err == "bad"
    return _html("演示商城 · 登录",
                 _LOGIN_HTML.replace("[[ATTR]]", "" if bad else " hidden")
                           .replace("[[MSG]]", "账号或密码错误" if bad else ""))


@app.post("/ui/login")
async def ui_login_post(request: Request):
    """表单登录。用 stdlib 手解 urlencoded 而**不用 `Form()`**：FastAPI 的 Form 依赖
    `python-multipart`，为靶场一页演示表单给后端加运行时依赖不值当（同一份克制
    也是不引 jinja 的理由）。浏览器 `<form method=post>` 发的就是 urlencoded，
    这里解的正是浏览器真发的东西，不是为测试编的格式。

    另一处同族坑：裸标量参数在 FastAPI 里读的是 query，写 `account: str = ""`
    会永远读到空串、正确口令也走失败分支——所以干脆不走参数声明。
    """
    raw = (await request.body()).decode("utf-8", "replace")
    fields = parse_qs(raw)
    account = (fields.get("account") or [""])[0]
    password = (fields.get("password") or [""])[0]
    if account == "demo" and password == "demo123":
        resp = RedirectResponse("/ui/home", status_code=302)
        # httponly 不给 JS 读：「登录后才可见」必须是服务端判，不能是前端演给你看
        resp.set_cookie("ui_session", "demo", httponly=True, samesite="lax")
        return resp
    return RedirectResponse("/ui/login?err=bad", status_code=302)


_FRAME_HTML = """
<h2>内嵌工单</h2>
<p id="in-frame">帧内文本：订单 #20241116 已发货</p>
<button id="in-frame-btn">帧内按钮</button>
"""


@app.get("/ui/frame")
async def ui_frame():
    """iframe 的**内容属于它自己的文档**，不在父页 HTML 里——所以它必须是独立路由。

    这条不是洁癖：`switch_frame` 命令在 1C 是未开放的（R101），所以帧内元素
    **只能作为「未开放能力」的活靶存在**，界面上不出现任何点得动的帧切换按钮。
    """
    return _html("内嵌工单", _FRAME_HTML)


# #late-row 由前端定时器 3 秒后才插进 DOM —— 这是 UI 侧的 /slow：
# wait_element 的时间窗、以及「等待元素出现」这类命令的断言靶，都靠它拉出来。
_HOME_HTML = """
<h1 id="title">订单工作台</h1>
<table id="orders">
  <thead><tr><th>单号</th><th>状态</th><th>金额</th></tr></thead>
  <tbody>
    <tr id="row-1"><td>#20241115</td><td>已付款</td><td>99.00</td></tr>
  </tbody>
</table>
<p><button id="pop">弹一个 DOM 层</button></p>
<p>表达式求值结果：<span id="js-sum">（未执行）</span></p>
<iframe id="frame" src="/ui/frame" width="420" height="160" title="内嵌工单"></iframe>
<div id="overlay"><div id="dialog">
  <p id="dialog-text">这是一个 DOM 层弹层，不是浏览器原生对话框</p>
  <button id="dialog-ok">知道了</button>
</div></div>
<script>
setTimeout(function () {
  var tr = document.createElement('tr');
  tr.id = 'late-row';
  tr.innerHTML = '<td>#20241116</td><td>待发货</td><td>128.00</td>';
  document.querySelector('#orders tbody').appendChild(tr);
}, 3000);
document.getElementById('pop').addEventListener('click', function () {
  document.getElementById('overlay').classList.add('on');
});
document.getElementById('dialog-ok').addEventListener('click', function () {
  document.getElementById('overlay').classList.remove('on');
});
</script>
"""


@app.get("/ui/home")
async def ui_home(ui_session: str | None = Cookie(default=None)):
    """工作台。无 cookie → 401 页（**不是** 302 回登录页）。

    401 而不是跳转是刻意的：跳转会让「未登录访问受保护页」这条断言变成
    「页面打开了」，而 401 让状态码本身成为可断言的事实（元素库演示要演这一步）。
    必须显式声明成 Cookie：裸标量参数在 FastAPI 里是 **query** 参数，
    写成 `ui_session: str | None = None` 会永远读到 None，页面恒 401。
    """
    if ui_session != "demo":
        return _html("未登录", '<h1 id="title">未登录</h1>'
                               '<p id="err" class="err">请先登录（401）</p>'
                               '<p><a id="back" href="/ui/login">去登录</a></p>', status=401)
    return _html("订单工作台", _HOME_HTML)



if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TP_TARGET_PORT", "9999")),
                log_level="warning")
