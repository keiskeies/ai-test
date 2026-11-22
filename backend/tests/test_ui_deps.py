"""1C 依赖与靶场前置（计划 T1）：playwright 版本配对 + HTML 靶页 + UI 配置默认值。

这一档测试是 1C 的地基守卫，全部**不启动浏览器**（下载浏览器是 T7 的事）：
- ②版本配对（R97）是这条计划里最容易「CI 绿、业主机器跑不起来」的一处：
  后端 playwright 与前端 playwright-core 各自带一份 browsers.json，
  chromium revision 不相等就要下两份浏览器（CI 多几百 MB、离线演示直接失败）。
  所以把它钉成测试，而不是写在手册里当口头约定。
- ③靶场 HTML：1C 之前 target_app.py 只有 JSON 接口、零 HTML 页（实测），
  UI 用例没有可操作的东西。这五个 testid 是元素库演示与 e2e 的公共契约，
  改任何一处都会在这里先红，而不是等到 e2e 里对着超时猜原因。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

EXPECTED_PW = "1.65.2"
REPO_ROOT = Path(__file__).resolve().parents[2]


def _chromium_revision(pkg_dir: Path) -> int | None:
    """browsers.json → chromium 的 revision。读不到返回 None（由调用方决定 skip 还是红）。"""
    data = json.loads((pkg_dir / "browsers.json").read_text(encoding="utf-8"))
    for b in data["browsers"]:
        if b["name"] == "chromium":
            return int(b["revision"])
    return None


def test_playwright_installed_and_pinned() -> None:
    from importlib.metadata import version

    assert version("playwright") == EXPECTED_PW, (
        f"playwright 必须精确钉在 {EXPECTED_PW}：它带的 chromium revision 要与前端 "
        f"playwright-core 相等（R97），用 >= 会让 CI 某天悄悄多下一份浏览器"
    )
    import playwright  # noqa: F401  # 只是证明 import 得动


def test_backend_and_frontend_chromium_revisions_match() -> None:
    """前后端各有一份 browsers.json；revision 不等 = 要下两份 chromium。"""
    from importlib.metadata import distribution

    import playwright as _pw  # noqa: F401

    backend_dir = Path(distribution("playwright").locate_file("playwright")) / "driver" / "package"
    assert (backend_dir / "browsers.json").exists(), f"后端 browsers.json 缺失：{backend_dir}"

    web_matches = sorted((REPO_ROOT / "web" / "node_modules" / ".pnpm").glob(
        "playwright-core@*/node_modules/playwright-core"))
    if not web_matches:
        # skip 必须带原因：静默跳过等于「这条守卫没跑」，而 R97 恰恰需要它真跑过。
        pytest.skip("前端未 pnpm install（找不到 playwright-core 的 browsers.json），版本配对未验证")

    backend_rev = _chromium_revision(backend_dir)
    frontend_rev = _chromium_revision(web_matches[-1])
    assert backend_rev == frontend_rev, (
        f"chromium revision 不配对：后端 playwright={backend_rev}、"
        f"前端 playwright-core={frontend_rev} → 会下两份浏览器。"
        f"改 pyproject 的 pin 去对齐前端（R97），不要改 CI 去容忍两份"
    )


# ── 靶场 HTML 页（R98：加在既有靶场同进程，不再开第二个靶）────────────────────────

@pytest.fixture
async def target():
    import httpx

    from scripts.target_app import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://target") as client:
        yield client


# /ui/home 的锚点**不含** #in-frame：iframe 的内容属于它自己的文档（/ui/frame），
# 在 /ui/home 的 HTML 里断言它存在是测不到的——那条断言归 test_frame_page_is_a_real_document。
# 也不含 #late-row：它是 JS 延后插的，静态 HTML 里根本没有（见 test_late_row_is_timer_inserted）。
LOGIN_TESTIDS = ("login-form", "account", "password", "submit", "err")
HOME_TESTIDS = ("title", "orders", "frame", "pop", "overlay", "dialog", "dialog-ok", "js-sum")


async def test_login_page_has_the_five_element_anchors(target) -> None:
    r = await target.get("/ui/login")
    assert r.status_code == 200, r.status_code
    assert "text/html" in r.headers["content-type"], r.headers["content-type"]
    for tid in LOGIN_TESTIDS:
        assert f'id="{tid}"' in r.text, f"/ui/login 缺 #{tid}（元素库演示与 e2e 的公共契约）"


async def test_login_then_home_roundtrip(target) -> None:
    """POST 走 PRG（302）——真实浏览器点提交就是这条路，单测不能测一条浏览器不走的路。

    错口令 → 回本页并带 ?err=bad，且**不发** cookie；对口令 → 302 到 /ui/home 带 cookie。
    """
    bad = await target.post("/ui/login", data={"account": "demo", "password": "wrong"},
                            follow_redirects=False)
    assert bad.status_code == 302, bad.status_code
    assert bad.headers["location"] == "/ui/login?err=bad"
    assert "ui_session" not in (bad.headers.get("set-cookie") or ""), "错口令绝不能发会话 cookie"
    back = await target.get(bad.headers["location"])
    assert 'id="err"' in back.text and "账号或密码错误" in back.text
    assert "hidden" not in back.text.split('id="err"')[1][:40], "出错时 #err 必须可见"

    ok = await target.post("/ui/login", data={"account": "demo", "password": "demo123"},
                           follow_redirects=False)
    assert ok.status_code == 302, ok.status_code
    assert ok.headers["location"] == "/ui/home"
    assert "ui_session=demo" in ok.headers["set-cookie"]
    home = await target.get("/ui/home", cookies={"ui_session": "demo"})
    assert home.status_code == 200, home.status_code


async def test_login_error_marker_is_present_but_hidden(target) -> None:
    """#err 常驻但默认 hidden：定位器不能指向一个「只在出错时才存在」的节点，
    否则元素库里那个元素在正常页面上直接解析失败。"""
    r = await target.get("/ui/login")
    assert 'id="err"' in r.text, "#err 节点必须一直在"
    assert "hidden" in r.text.split('id="err"')[1][:40], "正常页面上 #err 必须是 hidden"


async def test_home_requires_cookie_and_has_the_element_anchors(target) -> None:
    anon = await target.get("/ui/home")
    assert anon.status_code == 401, "无 cookie 必须 401——否则「登录后才可见」的断言演不出来"

    auth = await target.get("/ui/home", cookies={"ui_session": "demo"})
    assert auth.status_code == 200, auth.status_code
    for tid in HOME_TESTIDS:
        assert f'id="{tid}"' in auth.text, f"/ui/home 缺 #{tid}"
    assert "订单工作台" in auth.text


async def test_late_row_only_exists_after_the_timer(target) -> None:
    """#late-row 必须**不在**静态 HTML 里、只由 3 秒定时器插入。

    如果它写成静态节点，wait_element 就永远秒过——那这条靶子等于没有：
    UI 侧「等元素出现」的时间窗（1B 用 /slow 拉的那个窗口）就演不出来了。
    """
    auth = await target.get("/ui/home", cookies={"ui_session": "demo"})
    body = auth.text.split("<body>", 1)[1].split("<script>", 1)[0]
    assert 'id="late-row"' not in body, "#late-row 不能是静态节点，否则 wait_element 秒过"
    script = auth.text.split("<script>", 1)[1]
    assert "late-row" in script and "setTimeout" in script and "3000" in script, \
        "#late-row 必须由 3000ms 定时器插入"


async def test_frame_page_is_a_real_document(target) -> None:
    """iframe 的 src 必须是独立可达的文档，否则 switch_frame 类命令连靶都没有。"""
    r = await target.get("/ui/frame")
    assert r.status_code == 200, r.status_code
    assert 'id="in-frame"' in r.text


# ── 配置默认值（D4 的「默认无头」是配置事实，不是文案）──────────────────────────────

def test_ui_settings_defaults() -> None:
    from app.core.config import Settings

    s = Settings(_env_file=None)
    assert s.ui_headless is True, "D4：默认无头"
    assert s.ui_concurrency == 4, "§6.3 默认信号量 4"
    assert s.ui_command_timeout_ms == 10_000, "§7.2 示例的单命令超时"
    assert s.ui_default_max_runtime_ms == 300_000, "UI 用例比接口慢两个量级，5 分钟是有依据的默认"
    assert s.ui_browser_channel == "", "留空 = 用 playwright 自带 chromium；非空是离线退路（chrome/msedge）"
