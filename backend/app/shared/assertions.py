"""断言引擎（§7.1 类型全集）：纯函数，无 IO；单条断言任何意外归一为失败行，绝不让执行核 500。

script 断言自 1B 起真求值（§8.5 受限沙箱），variables 只读传入：要改场景变量请用 script
步骤而不是断言——断言的职责是判定，不承担状态写入，避免「断言顺便改环境」这种查不出来的耦合。"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from app.shared.jsonpath import JsonPathMissing, jsonpath_get
from app.shared.sandbox import DEFAULT_TIMEOUT_S, run_script

Q = chr(34)  # 双引号常量，供少量字符串拼接处使用


@dataclass
class ResponseView:
    status: int
    headers: dict[str, str]  # 键已小写
    body_text: str | None
    elapsed_ms: int


def _num(x: Any) -> Any:
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return x
    return x


def _eq(actual: Any, expected: Any) -> bool:
    if actual == expected:
        return True
    na, ne = _num(actual), _num(expected)
    return type(na) is type(ne) and na == ne


def _row(a: dict, passed: bool, actual: Any = None, error: str | None = None) -> dict:
    row = {"type": a.get("type"), "passed": passed, "expected": a.get("expected"),
           "actual": actual, "error": error}
    # 回显 path：一个接口挂多条 jsonpath 断言时，结果卡得能看出是哪条在说话
    if a.get("path"):
        row["path"] = a["path"]
    return row


def _eval_one(a: dict, resp: ResponseView, variables: dict[str, Any] | None) -> dict:
    t = a.get("type")
    exp = a.get("expected")
    if t == "status_code":
        # D173：两个前端编辑器一个存 Number 一个存字符串，'200' 对 200 必须判过——
        # 与 json_path_equals 同一套 _eq 数字归一（'abc' 对 200 仍判不过）。
        return _row(a, _eq(resp.status, exp), resp.status)
    if t == "json_path_equals":
        try:
            doc = json.loads(resp.body_text) if resp.body_text else None
        except (ValueError, TypeError):
            return _row(a, False, None, "响应不是合法 JSON，无法按 jsonpath 断言")
        try:
            actual = jsonpath_get(doc, a.get("path") or "$")
        except JsonPathMissing as e:
            return _row(a, False, None, str(e))
        return _row(a, _eq(actual, exp), actual)
    if t == "body_contains":
        return _row(a, str(exp) in (resp.body_text or ""), (resp.body_text or "")[:200])
    if t == "regex":
        # expected=正则正文；path 可选——给了先按 JSONPath 取字段再匹配，不给匹整份 body_text。
        # 已知风险（登记，不做半成品拦截）：re 无超时，灾难性回溯的写法（如 (a+)+b 配长文本）
        # 会拖住这一条求值。script 断言有 §8.5 沙箱时限兜底，regex 一期没有等价物；
        # signal/线程包装是半成品（跨平台/事件循环都有坑），宁可留账不偷偷上。
        pat = exp if isinstance(exp, str) else ("" if exp is None else str(exp))
        try:
            rx = re.compile(pat)
        except re.error as e:
            return _row(a, False, None, "正则写法不合法：" + str(e))
        if a.get("path"):
            try:
                doc = json.loads(resp.body_text) if resp.body_text else None
            except (ValueError, TypeError):
                return _row(a, False, None, "响应不是合法 JSON，无法按 jsonpath 断言")
            try:
                val = jsonpath_get(doc, str(a["path"]))
            except JsonPathMissing as e:
                return _row(a, False, None, str(e))
            text = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
        else:
            text = resp.body_text or ""
        hit = rx.search(text)
        return _row(a, hit is not None, hit.group(0)[:120] if hit else text[:200])
    if t == "header_exists":
        return _row(a, str(exp).lower() in resp.headers, sorted(resp.headers)[:20])
    if t == "response_time_lt":
        limit = exp if exp is not None else a.get("timeout_ms")
        if limit is None:
            return _row(a, False, resp.elapsed_ms, "response_time_lt 缺少阈值（expected/timeout_ms）")
        return _row(a, resp.elapsed_ms < limit, resp.elapsed_ms)
    if t == "script":
        code = a.get("code")
        if not isinstance(code, str) or not code.strip():
            # 缺正文要在这一层说清楚，不能让执行核因为 KeyError 整条 500
            return _row(a, False, None, "script 断言缺少 code 正文，无法求值")
        view = {"status": resp.status, "headers": resp.headers, "body": resp.body_text,
                "elapsed_ms": resp.elapsed_ms}
        ms = a.get("timeout_ms")
        # 复用断言已有的 timeout_ms 字段做单条脚本上限；不传走 §8.5 默认 5s
        timeout_s = (ms / 1000) if isinstance(ms, (int, float)) and ms > 0 else None
        # 显式传「默认值本身」而不是 `**({} if None else {...})`：后者让 mypy 无法
        # 判断这个值会落到哪个形参，对 run_script 的每个关键字形参各报一次。
        # 传 DEFAULT_TIMEOUT_S 与省略该参数完全等价（它就是 run_script 的默认值）。
        res = run_script(code, ctx_vars=variables or {}, last_response=view,
                         timeout_s=DEFAULT_TIMEOUT_S if timeout_s is None else timeout_s)
        if res.ok:
            return _row(a, True, "脚本通过" + ("（日志 " + str(len(res.logs)) + " 行）" if res.logs else ""))
        err = str(res.error)[:600]
        if res.logs:
            err += " ｜脚本日志: " + " / ".join(res.logs)[:400]
        return _row(a, False, None, err)
    return _row(a, False, None, "未知断言类型: " + str(t))


def prune_rows(rows: list | None) -> list[dict]:
    """断言配置行的**入库口径**：丢掉值为 None 的键，其余逐字保留（含顺序）。

    为什么必须有它：断言编辑器的行是 `Partial<Assertion>`（`web/src/api/req.ts`），切类型
    会把上一类型的载荷键显式清零（`PropsPanel.tsx` / `RequestEditor.tsx`，防旧 `code`
    跟着 `status_code` 存进去），所以发上来的行天然带 `code: null` / `timeout_ms: null`。
    api_case 侧一直有 `model_dump(exclude_none=True)` 兜着（`api_test/case_services.py:48`），
    场景的 `common_assertions` 是 `list[dict[str, Any]]` 原样落 JSON——同一种断言在两张表里
    长得不一样，「保存 → GET 原样」这条资产往返就漏了（D77/D78 之后由门禁⑦ e2e 撞出来）。

    None 不落存储位与读取侧的缺省语义严格等价，所以老数据零迁移：`enabled` 认的就是
    「缺键/None/true 都算启用」（见 `evaluate` 的 D78 说明），`timeout_ms` / `path` /
    `expected` 的读取方全部 `.get()` 且 None 与缺键同路。**唯一必须显式留存的假值是
    `enabled: False`**——它是 D78 唯一有语义的关闭位，被顺手丢掉就等于把用户关掉的断言
    重新打开，比多存一个 null 严重得多，因此这里只按值筛 None、不碰 False。
    """
    return [{k: v for k, v in dict(r).items() if v is not None} for r in rows or []]


def evaluate(assertions: list[dict], resp: ResponseView, *,
             variables: dict[str, Any] | None = None) -> list[dict]:
    """variables 只读：script 断言能读 ctx.vars，但写不回执行上下文。

    enabled 语义（D78）：只有显式 `enabled is False` 的行跳过执行、**不产结果行**；
    缺键/None/true 都视为启用——老数据不带这个键，必须照旧执行（向后兼容唯一正确解）。
    选「不出现」而非「出现但标未启用」：结果行的 passed 是各判定口径
    （RunResult.passed / handlers 的 all(passed)）直接吃的输入，给未执行行填
    passed=True 会让报告画出一个「查过且通过」的假绿——比不出现更骗人。
    执行顺序 = 数组顺序（含 enabled 行按原相对顺序），这就是断言「排序」的全部语义。"""
    out = []
    for a in assertions or []:
        if a.get("enabled") is False:
            continue
        try:
            out.append(_eval_one(a, resp, variables))
        except Exception as e:  # noqa: BLE001 断言引擎任何意外都归一为失败行
            out.append(_row(a, False, None, type(e).__name__ + ": " + str(e)[:180]))
    return out