"""D40（§11.4.22）用户批量导入：解析器纯函数 + preview/commit 服务端到端。

口径（计划原文）：复用 1E T4 的「冲突逐条跳过 + 报告」范式——注意与 T4 的一处**有意的**
差异：T4 的 commit 是整批一事务（任一失败全回滚），D40 计划明文「逐条冲突跳过 + 错误报告」，
所以这里的承诺是「成 3 跳 2」：冲突/非法行逐条跳过、有效行照建，回执必须能解释每一行；
只有落库层故障才整批回滚（ok=False，一个用户都没建）。

表驱动五格：全成功 / 全冲突 / 部分冲突 / 空输入 / 格式非法。
另钉：权限（非管理员恒 403）、审计 produced 有账且密码零踪迹、勾了跳过的行真的没建。
"""
from __future__ import annotations

import pytest

from app.modules.iam.user_importers import parse_user_csv, row_problem
from tests.conftest import ADMIN_PASSWORD


async def _admin_h(client, session):
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


# —————————————————————— 解析器纯函数（表驱动）——————————————————————

PARSE_CASES = [
    {
        "id": "all_ok",
        "text": "账号,姓名,邮箱\nalice,爱丽丝,a@x.com\nbob,鲍勃,\n",
        "n_rows": 2, "n_errors": 0,
    },
    {
        "id": "tab_delimited",  # Excel/WPS 粘贴 = TSV：制表符优先识别（csv.ts 同规则）
        "text": "账号\t姓名\nalice\t爱丽丝\n",
        "n_rows": 1, "n_errors": 0,
    },
    {
        "id": "header_aliases",  # 字段映射真认中英列头 + 乱序
        "text": "name,email,account\n爱丽丝,a@x.com,alice\n",
        "n_rows": 1, "n_errors": 0,
    },
    {
        "id": "empty",  # 空输入：人话报错，不抛
        "text": "   \n\n",
        "n_rows": 0, "n_errors": 1,
    },
    {
        "id": "no_header",  # 列头缺「姓名」
        "text": "账号,邮箱\nalice,a@x.com\n",
        "n_rows": 0, "n_errors": 1,
    },
    {
        "id": "bad_rows_skipped_good_kept",  # 部分非法：坏行带行号进 errors，好行照进 rows
        "text": "account,name\nalice,爱丽丝\nb@d,坏账号\n,缺账号\nalice,重复账号\nok_name,合法\n",
        "n_rows": 2, "n_errors": 3,
    },
]


@pytest.mark.parametrize("case", PARSE_CASES, ids=[c["id"] for c in PARSE_CASES])
def test_parse_table(case) -> None:
    out = parse_user_csv(case["text"])
    assert len(out.rows) == case["n_rows"], out.errors
    assert len(out.errors) == case["n_errors"], out.errors


def test_parse_errors_carry_line_numbers() -> None:
    """「第几行为什么被跳过」：错误必须带粘贴原文的物理行号（空行也占号）。"""
    out = parse_user_csv("账号,姓名\n\nbad account!,张三\nalice,李四\n")
    assert [r.account for r in out.rows] == ["alice"]
    assert len(out.errors) == 1 and "第 3 行" in out.errors[0]


def test_row_problem_single_ruler() -> None:
    """预览与 commit 共用同一把尺子：两边都认的账号预览才说能建。"""
    assert row_problem("a", "x", None) is not None  # 账号 <2 位
    assert row_problem("ok_1", "x", None) is None
    assert row_problem("ok_1", "x", "not-an-email") is not None
    assert row_problem("ok_1", "", None) is not None


# —————————————————————— 服务端到端：表驱动五格 ——————————————————————

async def _preview(client, h, text):
    r = await client.post("/api/v1/system/users/import-preview", json={"text": text}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _commit(client, h, items, **extra):
    body = {"initial_password": "Import@123", "items": items, **extra}
    r = await client.post("/api/v1/system/users/import-commit", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _item(line, account, name="导入用户", strategy="create"):
    return {"line": line, "account": account, "name": name, "strategy": strategy}


COMMIT_CASES = [
    {  # 全成功
        "id": "all_new", "pre": [],
        "items": [_item(2, "imp_a"), _item(3, "imp_b")],
        "created": 2, "skipped": 0, "failed": 0,
        "present": {"imp_a", "imp_b"}, "absent": set(),
    },
    {  # 全冲突（都已在库）→ 逐条失败报告，一个不建
        "id": "all_conflict", "pre": ["imp_a", "imp_b"],
        "items": [_item(2, "imp_a"), _item(3, "imp_b")],
        "created": 0, "skipped": 0, "failed": 2,
        "present": {"imp_a", "imp_b"}, "absent": set(),
    },
    {  # 部分冲突：「成 3 跳 2」——有效行照建，冲突行逐条可追溯
        "id": "partial", "pre": ["imp_b", "imp_d"],
        "items": [_item(2, "imp_a"), _item(3, "imp_b"), _item(4, "imp_c"),
                  _item(5, "imp_d"), _item(6, "imp_e")],
        "created": 3, "skipped": 0, "failed": 2,
        "present": {"imp_a", "imp_b", "imp_c", "imp_d", "imp_e"}, "absent": set(),
    },
    {  # 批内重复：第二条逐条报行号，不撞唯一约束
        "id": "dup_in_batch", "pre": [],
        "items": [_item(2, "imp_a"), _item(3, "imp_a")],
        "created": 1, "skipped": 0, "failed": 1,
        "present": {"imp_a"}, "absent": set(),
    },
    {  # 勾了跳过：即便该行其实能建也不建（界面勾了「跳过」还落库 = 骗人）
        "id": "skip_checked", "pre": [],
        "items": [_item(2, "imp_a"), _item(3, "imp_b", strategy="skip")],
        "created": 1, "skipped": 1, "failed": 0,
        "present": {"imp_a"}, "absent": {"imp_b"},  # 库里必须查无此人——跳过不是「建了但没说」
        "skip_reason": "本次不导入",
    },
    {  # 冲突行走 skip 策略时，报告说清「账号已存在」而不是笼统的「勾选跳过」
        "id": "skip_conflict_row", "pre": ["imp_b"],
        "items": [_item(2, "imp_a"), _item(3, "imp_b", strategy="skip")],
        "created": 1, "skipped": 1, "failed": 0,
        "present": {"imp_a", "imp_b"}, "absent": set(),
        "skip_reason": "账号已存在",
    },
    {  # 非法行（超长姓名）逐条跳过，有效行照建
        "id": "invalid_row", "pre": [],
        "items": [_item(2, "imp_a"), _item(3, "imp_b", name="名" * 129)],
        "created": 1, "skipped": 0, "failed": 1,
        "present": {"imp_a"}, "absent": {"imp_b"},
    },
]


@pytest.mark.parametrize("case", COMMIT_CASES, ids=[c["id"] for c in COMMIT_CASES])
async def test_commit_table(client, session, make_user, case) -> None:
    h = await _admin_h(client, session)
    for acct in case["pre"]:
        _, hh = await make_user(acct)
        assert hh  # 预置账号只用于撞冲突
    body = await _commit(client, h, case["items"])
    assert body["ok"] is True, body
    assert (body["created"], body["skipped"], body["failed"]) == (
        case["created"], case["skipped"], case["failed"]), body
    # 审计产出行与 created 一一对账（回执说建了几条，produced 就有几条，不多不少）
    assert len(body["produced"]) == case["created"], body
    # 每一笔 skipped/failed 都有行号 + 人话原因（不许只有个数）
    for f in body["failures"] + body["skipped_detail"]:
        assert f["line"] >= 1 and f["reason"], f
    if case.get("skip_reason"):
        assert case["skip_reason"] in body["skipped_detail"][0]["reason"], body["skipped_detail"]
    listed = {r["account"] for r in (await client.get("/api/v1/system/users?size=200", headers=h)).json()["items"]}
    assert case["present"] <= listed
    # 硬事实：跳过/失败且库里原本没有的账号，必须查无此人（回执与库当面对账）
    assert not (case["absent"] & listed), f"没该行却建了人：{case['absent'] & listed}"


async def test_conflict_report_explains_3_of_5(client, session, make_user) -> None:
    """「成 3 跳 2」的活账：回执 + 用户列表两头对得上，逐条原因带行号。"""
    h = await _admin_h(client, session)
    for acct in ("imp_b", "imp_d"):
        await make_user(acct)
    body = await _commit(client, h, [_item(i + 1, f"imp_{chr(96 + i)}") for i in range(1, 6)])
    assert (body["created"], body["failed"]) == (3, 2)
    reasons = {f["line"]: f["reason"] for f in body["failures"]}
    assert set(reasons) == {3, 5}
    assert "imp_b" in reasons[3] and "已存在" in reasons[3]


async def test_commit_landing_audit_no_password(client, session) -> None:
    """审计复用 T4 的 produced 形状可查，且回执/审计里初始密码零踪迹。"""
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    h = await _admin_h(client, session)
    body = await _commit(client, h, [_item(2, "imp_aud")])
    assert body["created"] == 1
    assert "Import@123" not in str(body)
    rows = (await session.execute(select(AuditLog).where(AuditLog.action == "user_import_commit"))).scalars().all()
    assert len(rows) == 1 and rows[0].ok is True
    produced = (rows[0].diff or {}).get("produced") or []
    assert len(produced) == 1 and produced[0]["kind"] == "user"
    assert "Import@123" not in str(rows[0].diff)
    # 真登录验证初始密码确实生效（回执说建了 = 库里真能用）
    r = await client.post("/api/v1/auth/login", json={"account": "imp_aud", "password": "Import@123"})
    assert r.status_code == 200


async def test_commit_flag_and_preview_counts(client, session, make_user) -> None:
    """假门禁令反向钉：is_system_admin 勾选真落库；预览计数与冲突真相一致。"""
    h = await _admin_h(client, session)
    await make_user("imp_x")
    pv = await _preview(client, h, "账号,姓名\nimp_x,已在\nimp_y,新来\n")
    assert (pv["new_count"], pv["conflict_count"]) == (1, 1)
    assert {i["account"]: i["exists"] for i in pv["items"]} == {"imp_x": True, "imp_y": False}
    body = await _commit(client, h, [_item(3, "imp_admin_y", "管理员行")], is_system_admin=True)
    assert body["created"] == 1
    listed = (await client.get("/api/v1/system/users?size=200", headers=h)).json()["items"]
    assert next(u for u in listed if u["account"] == "imp_admin_y")["is_system_admin"] is True


async def test_import_requires_admin(client, session, make_user) -> None:
    """权限：导入是写操作（system:user:create 族）——非系统管理员 preview/commit 恒 403。"""
    await _admin_h(client, session)
    _, hp = await make_user("plain_imp")
    r = await client.post("/api/v1/system/users/import-preview", json={"text": "账号,姓名\na2,b\n"}, headers=hp)
    assert r.status_code == 403
    r2 = await client.post("/api/v1/system/users/import-commit",
                           json={"initial_password": "Import@123", "items": [_item(2, "sneaky")]}, headers=hp)
    assert r2.status_code == 403


async def test_commit_envelope_validated(client, session) -> None:
    """信封级校验仍走 422：弱初始密码、空 items 列表不进业务层。"""
    h = await _admin_h(client, session)
    r = await client.post("/api/v1/system/users/import-commit",
                          json={"initial_password": "short", "items": [_item(2, "imp_s")]}, headers=h)
    assert r.status_code == 422
    r2 = await client.post("/api/v1/system/users/import-commit",
                           json={"initial_password": "Import@123", "items": []}, headers=h)
    assert r2.status_code == 422
