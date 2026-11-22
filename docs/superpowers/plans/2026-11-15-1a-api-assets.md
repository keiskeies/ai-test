# 1A 资产与调试 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **✅ 本批次已完成（2026-11-16 回填）**——下面 38 个未勾 checkbox 是**写法陈旧，不是待办**：1A 收尾时没人回来逐格打勾，完成度由别处追踪。别照这些格子找活干（S0/1B/1C 同此口径；本轮主线就被它骗过一次，故留此横幅）。
> 完成的证据：**git tag `1a-api-assets`**（本文末尾 Task 的收尾条款就要求打这个 tag）｜**逐条完成判据见 `## 完成判据（= §13「1A」条目逐条）`**｜演示手册 `docs/superpowers/plans/README-1a-demo.md`。
> **注意 1A 的提交没有批次前缀**（实测 `git log`：`(1a)` 前缀 **0 条**，只有 2 条 `(1a手册)` 是后来的文档修正），本文件的 Task 是按计划内各步自己写的 `feat(shared): …` 这类步名提交的——所以**查 1A 的落地别用批次前缀 grep**，用 tag 与文件本体。`(...)` 批次前缀从 1B 才成体系（实测 `(1b)` 4 条、`(1c)` 30 条、`(1c+)` 10 条，1D 用 `(1d/tN)`）。
> 后续批次改用「`### TN · …` 标题带 ✅ + 尾部 `**落地证据（commit XXXXXXX）**` 段 + 门禁实测数字」的口径（见 1D），**新批次以 1D 为格式模板**，不再依赖本文件的 checkbox。

**Goal:** 一期 1A 落地——IAM 收尾（用户管理/角色模板/私有资源数据权限）、环境与全局配置、API 模块树/接口/用例/数据集全套 CRUD、走真实执行核的单接口调试（不落报告草稿、落运行记录）、简易运行记录列表；业主可演示「建接口→建用例→调试通过→列表见最近结果」。

**Architecture:** 延续 S0 工具化单体：一切新能力仍是 `@service` 五路同生。新增 `app/modules/execution/`（执行核 `run_api()` + run_record）与 `app/shared/`（变量模板 `${var}`、断言引擎、jsonpath 子集、请求合并）；调试 = api_test 解析请求与变量后调 execution 服务（正向依赖，反依赖 agent 契约不受影响）。前端补 API 三页 + 设置页 + 运行记录页（§11.4.2-11.4.4 草图）。

**Tech Stack:** 同 S0（Python 3.12/FastAPI/SQLAlchemy async/MySQL 8.4 本机实例/Redis 7 db6 本机实例/React18+AntD5）；**本计划不引入任何新第三方依赖**（jsonpath 用自研子集，脚本沙箱延后 1B——§8.5 与执行引擎同期）。

**Spec:** `docs/2026-11-13-ai-test-platform-design.md`（本计划实现其 §13「1A」条目；§4.1-4.3、§6.1/6.2 非导入部分、§7.1、§7.5、§10 数据权限、§11.4.2-11.4.5/11.4.30 子集、§11.1 导航）。导入导出/报告中心/场景=1B-1E，不在本计划。

## Global Constraints

- MySQL 8.4 **本机实例** 127.0.0.1:3306（服务 `MySQL84`，新库自建）；Redis **本机实例** 127.0.0.1:6379 密码见 `backend/.env` db6。开发禁 SQLite；不引新依赖。**【2026-11-19 业主口径】各种测试都在本机启动的软件上跑，不再要求 Docker、不再用远端 db.internal.test；见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4**（下文「前置取证」里的 db.internal.test 是当轮实测记录，照原文读、不改写）。
- REST 前缀 `/api/v1`；错误信封 `{code,message,details}`；游标分页 `{items,next_cursor}`；UTC 存储、Asia/Shanghai 展示；UI 仅中文。
- 变量语法 `${var}`（§7.5）；渲染顺序 **步骤/用例覆盖 > 环境 vars > 项目全局配置**（§7.5 的“用例>环境>全局”次序，步骤级=1B）。
- 断言类型 = §7.1 全集：status/jsonpath/contains/response_time/script；`script` 1A 返回 `{"passed":false,"error":"脚本断言 1B 开放"}`（不装作通过——反目标条款）。
- 私有资源（§4.1）：api_definition/api_case 带 `owner_id` + `project_public`(默认 true)；列表可见性 = public 或 owner；项目管理员/系统管理员看全部。
- 每个 Alembic 迁移必带 down；每任务 commit；本计划 tag `1a-api-assets`。
- 审计沿用 S0 双入口：HTTP 写与 Agent 工具自动落 audit（GET 不审计）。
- lint-imports 现有 3 契约必须保持；`execution` 是领域模块（可被 api_test 正向 import 服务函数；不得 import agent）。

## Review Focus

蓝图没逐字写、但最可能咬人的五类输入，行为预期如下，各自钉死在对应任务测试里：

1. **模板未定义变量**（`${token}` 无值）→ 不静默留空：422 `validation_error` + `details={"var":"token",...}`，调试与用例执行同一行为 → T8。
2. **超大/二进制响应**（>1MB 或非文本 content-type）→ 执行核截断 `body_text` 至 1MB 并置 `truncated=true`，二进制 `body_text=null` 只留大小/类型，断言 contains 对截断体求值 → T6。
3. **jsonpath 求值对象不存在**（`$.a.b` 而响应无 a）→ 断言判失败（非 500、非跳过），detail 说明缺失路径 → T5。
4. **模块树环/自父**（parent 改成自己的后代）→ 400 `invalid_input` 拒绝移动，树读取不死循环 → T9。
5. **回收站模块下的资产** → 默认列表与模块计数都不含（软删语义 `status=recycled`），回收站视图专参 `recycled=true` 才可见 → T9/T10。
6. **跨项目 id 注入**（把别家 definition_id/case/module_id 传进本项目的调试/绑定）→ 404 not_found（与不存在同码，不泄露存在性）→ T7/T10/T12。

## 文件结构（1A 建成后）

```
backend/app/shared/vars.py            # ${var} 渲染 + deep_merge（新）
backend/app/shared/jsonpath.py        # $.a.b[0].c 子集求值（新，stdlib）
backend/app/shared/assertions.py      # 断言引擎（新）
backend/app/modules/execution/models.py    # run_record（新）
backend/app/modules/execution/core.py      # run_api(request,vars)->RunResult（新）
backend/app/modules/execution/services.py  # run_record_list @service（新）
backend/app/modules/api_test/models.py     # +ApiModule +ApiCase +DataSet（改）
backend/app/modules/api_test/services.py   # 全套 @service（改）
backend/app/modules/env/services.py        # +global_config @service（改）
backend/app/modules/env/models.py          # +GlobalConfig（改）
backend/app/modules/iam/user_services.py   # 用户管理 @service（新）
backend/app/modules/iam/auth_services.py   # 自助改密（并入现有 routes 流）
backend/app/core/service.py                # GET-with-body 支持（若需要，Task7 现场裁）
web/src/pages/api.tsx            # 接口管理（模块树+列表+详情抽屉）
web/src/pages/datasets.tsx       # 数据集
web/src/pages/runs.tsx           # 运行记录
web/src/pages/settings.tsx       # 成员/用户/角色模板
web/src/api/RequestEditor.tsx    # 请求编辑器（§11.4.4 子集，调试/定义/用例共用）
web/src/api/DebugPanel.tsx       # 调试响应+断言卡
web/e2e/api.spec.mjs datasets.spec.mjs runs.spec.mjs settings.spec.mjs
backend/tests/test_shared_vars.py test_jsonpath.py test_assertions.py test_execution_core.py
  test_execution_run.py test_api_module.py test_api_definition1a.py test_api_case.py
  test_dataset.py test_env_global.py test_user_mgmt.py test_api_debug.py test_run_record.py
```

---

### Task 1: shared/vars —— `${var}` 渲染与变量分层合并

**Files:**
- Create: `backend/app/shared/vars.py`
- Test: `backend/tests/test_shared_vars.py`

**Interfaces:**
- Produces: `class MissingVar(Exception)`（属性 `.name`）；`render(text: str, vars: dict[str,str]) -> str`；`render_deep(obj, vars)`（递归 dict/list/tuple，返回新对象不改入参）；`merge_vars(*layers: dict[str,str]) -> dict[str,str]`（后层覆盖前层；调用方按 全局→环境→用例/数据集行 的顺序传层）。

- [ ] **Step 1: 写失败测试** `test_shared_vars.py`：

```python
import pytest
from app.shared.vars import MissingVar, merge_vars, render, render_deep

def test_render_subst():
    assert render("${base_url}/login", {"base_url": "http://x"}) == "http://x/login"
    assert render("a{{b}}c ${x}", {"x": "-"}) == "a{{b}}c -"  # 只认 ${} 语法

def test_render_missing_names_var():
    with pytest.raises(MissingVar) as e:
        render("Bearer ${token}", {})
    assert e.value.name == "token"

def test_render_deep_returns_copy():
    src = {"url": "${u}", "pairs": [["k", "${v}"]] }
    out = render_deep(src, {"u": "U", "v": "V"})
    assert out == {"url": "U", "pairs": [["k", "V"]]}
    assert src["url"] == "${u}"

def test_merge_later_wins():
    assert merge_vars({"a": "1", "b": "2"}, {"b": "3"}, {"b": "9"})["b"] == "9"
```

- [ ] **Step 2: 跑红** Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_shared_vars.py -q`（cwd=backend）→ ModuleNotFoundError。
- [ ] **Step 3: 实现**：正则 `\$\{([A-Za-z_][A-Za-z0-9_]*)\}` 一次替换；未定义即 `MissingVar(name)`（快败，不静默——Review Focus 1）。
- [ ] **Step 4: 跑绿** 同上 → 4 passed。
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(shared): variable template rendering with fail-fast missing-var"`

### Task 2: shared/jsonpath —— 点路径子集求值

**Files:**
- Create: `backend/app/shared/jsonpath.py`（仅 stdlib；**不引入 jsonpath 库**——Global Constraints）
- Test: `backend/tests/test_jsonpath.py`

**Interfaces:**
- Produces: `class JsonPathMissing(Exception)`（属性 `.path`=原始表达式）；`jsonpath_get(data, expr)`：支持 `$.a.b[0].c` 与 `$['a b']`；`expr == "$"` 返回整根；任何一段缺失/类型不符 → `JsonPathMissing`。

- [ ] **Step 1: 写失败测试**（钉 Review Focus 3）：

```python
import pytest
from app.shared.jsonpath import JsonPathMissing, jsonpath_get

DATA = {"a": {"b": [{"c": 1}, {"c": 2}]}, "data": {"token": "tk"}, "": 3}

def test_get_paths():
    assert jsonpath_get(DATA, "$.data.token") == "tk"
    assert jsonpath_get(DATA, "$.a.b[1].c") == 2
    assert jsonpath_get(DATA, "$") is DATA

def test_missing_paths_raise_not_none():
    for bad in ("$.a.x", "$.a.b[9].c", "$.nope.deep", "$.a.b.c"):
        with pytest.raises(JsonPathMissing):
            jsonpath_get(DATA, bad)

def test_quoted_key_with_space():
    assert jsonpath_get({"a b": 7}, "$['a b']") == 7
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**：tokenize（`.key` / `[int]` / `['key']`）后逐段 `dict.__getitem__` / `list` 下标，段间校验 isinstance。 → **Step 4: 跑绿** 3 passed。 → **Step 5: Commit** `feat(shared): jsonpath subset evaluator`

### Task 3: shared/assertions —— 断言引擎

**Files:**
- Create: `backend/app/shared/assertions.py`
- Modify: `backend/app/modules/api_test/schemas.py`（`ASSERTION_TYPES` 增加 `"script"`）
- Test: `backend/tests/test_assertions.py`

**Interfaces:**
- Consumes: `jsonpath_get`（T2）。
- Produces: `@dataclass ResponseView(status: int, headers: dict[str,str], body_text: str | None, elapsed_ms: int)`（headers 键已小写）；`evaluate(assertions: list[dict], resp: ResponseView) -> list[dict]`，每项 `{"type","passed","expected","actual","error": str|None}`。类型语义（键名对齐现有 `Assertion` schema）：
  - `status_code`：`resp.status == expected`；
  - `json_path_equals`：`path` 为表达式；求值失败=断言失败且 `error="路径不存在: ..."`（不 500——Review Focus 3）；比较用 `==`，但对字符串期望做数字归一（`"200" == 200` 视为相等，比对前双方尝试 `float()`）；
  - `body_contains`：`expected in (resp.body_text or "")`；
  - `header_exists`：`expected.lower() in resp.headers`；
  - `response_time_lt`：`resp.elapsed_ms < (expected if expected is not None else timeout_ms)`（兼容现有 schema 把阈值放 `timeout_ms` 的写法）；
  - `script`：**1A 恒 `passed=False, error="脚本断言 1B 开放"`**（反目标：不许装作通过）；
  - 未知类型：`passed=False, error="未知断言类型"`。空断言列表 → 返回 `[]`（调用方视为通过）。

- [ ] **Step 1: 写失败测试**（表驱动，§7.1 全集各 1 正 1 反 + 数字归一 + script 占位 + jsonpath 缺失=失败非异常）：

```python
from app.shared.assertions import ResponseView, evaluate

R = ResponseView(status=200, headers={"content-type": "application/json", "x-trace": "t1"},
                 body_text='{"code": 0, "data": {"token": "tk"}}', elapsed_ms=120)

def _res(a): return evaluate(a, R)[0]

def test_all_types():
    assert _res([{"type": "status_code", "expected": 200}])["passed"]
    assert not _res([{"type": "status_code", "expected": 500}])["passed"]
    assert _res([{"type": "json_path_equals", "path": "$.data.token", "expected": "tk"}])["passed"]
    assert _res([{"type": "json_path_equals", "path": "$.code", "expected": "0"}])["passed"]  # 数字归一
    f = _res([{"type": "json_path_equals", "path": "$.nope", "expected": 1}])
    assert not f["passed"] and "路径不存在" in f["error"]
    assert _res([{"type": "body_contains", "expected": "token"}])["passed"]
    assert _res([{"type": "header_exists", "expected": "X-Trace"}])["passed"]
    assert _res([{"type": "response_time_lt", "expected": 1000}])["passed"]
    assert not _res([{"type": "response_time_lt", "timeout_ms": 50}])["passed"]  # 兼容 timeout_ms
    s = _res([{"type": "script", "code": "assert True"}])
    assert not s["passed"] and "1B" in s["error"]

def test_empty_assertions():
    assert evaluate([], R) == []
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**（纯函数无 IO；每条断言独立 try/except 归一为结果行）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(shared): assertion engine with §7.1 full type set`

### Task 4: execution 模块 —— run_api 执行核 + run_record 表

**Files:**
- Create: `backend/app/modules/execution/__init__.py` `models.py` `core.py`
- Create: `backend/migrations/versions/0009_execution_run.py`（down=drop_table）
- Modify: `backend/pyproject.toml`（import-linter 第三契约 source_modules 增加 `app.modules.execution`——执行核不得 import agent/iam/api_test）
- Test: `backend/tests/test_execution_core.py`

**Interfaces:**
- Consumes: `render/render_deep/MissingVar`(T1)、`evaluate/ResponseView`(T3)。
- Produces（`execution/core.py`，纯引擎无 DB）：
  - `MAX_BODY_CHARS = 1_000_000`
  - `@dataclass RunResult(ok: bool, status: int | None, headers: dict[str,str], body_text: str | None, truncated: bool, body_size: int, elapsed_ms: int, error: str | None, assertions: list[dict])`；属性 `passed = ok and all(a["passed"])`（方法）。
  - `async def run_api(request: dict, *, variables: dict[str,str] | None = None, transport: httpx.AsyncBaseTransport | None = None) -> RunResult`：`render_deep` 整个请求（未定义变量向上抛 `MissingVar`，由调用方转 422）→ httpx（`follow_redirects=False`，`timeout=timeout_ms/1000`）→ 文本判定（content-type 含 json/text/xml/html/urlencoded 才解 body_text，否则 None；截断 1MB 置 `truncated`）→ headers 小写化 → `elapsed_ms=perf_counter` → `evaluate`。网络层异常 → `ok=False, error=type(e).__name__+": "+str(e)[:180]`，不抛。
- Produces（`execution/models.py`）：`RunRecord`（表 `run_record`）：`id, project_id(idx), subject_type("api_definition"|"api_case"|"scenario"[1B]), subject_id, subject_name, env_id|None, env_name|None, trigger("debug"|"manual"|"schedule"|"agent"|"webhook"), status("passed"|"failed"|"error"), status_code|int|None, elapsed_ms|int|None, request_snapshot(JSON), response_snapshot(JSON), assertions(JSON), error(str|None), created_by|None` + TimestampMixin。

- [ ] **Step 1: 写失败测试**（ASGITransport 内存靶，无真实网络）：

```python
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from httpx import ASGITransport
from app.modules.execution.core import run_api

app = FastAPI()
@app.post("/echo")
async def echo(request: Request):
    return JSONResponse({"echo": await request.json(),
                         "auth": request.headers.get("authorization"),
                         "q": dict(request.query_params)})
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
    assert r.ok and r.passed and r.status == 200
    import json as _j
    assert _j.loads(r.body_text)["echo"] == {"a": 1}  # 请求体真的送达

async def test_truncate_and_binary():
    r = await run_api({"method": "GET", "url": "http://t/big"}, transport=TR)
    assert r.truncated and len(r.body_text) <= 1_000_000
    b = await run_api({"method": "GET", "url": "http://t/bin"}, transport=TR)
    assert b.body_text is None and b.body_size == 2  # Review Focus 2

async def test_connect_error_not_raise():
    r = await run_api({"method": "GET", "url": "http://127.0.0.1:1/x", "timeout_ms": 500})
    assert not r.ok and r.error and r.status is None
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**（body.form/json/text 都走 content 字符串；form 以 `data=json.loads(content)` 发送 pairs）→ **Step 4: 跑绿** → **Step 5: 迁移+契约**：`alembic revision` 手写 0009（含 down），`alembic upgrade head`；pyproject 契约加 execution；跑 `lint-imports` → 3 kept。 → **Step 6: Commit** `feat(execution): api run engine + run_record table`

### Task 5: IAM 收尾 —— 用户管理、自助改密、角色目录

**Files:**
- Create: `backend/app/modules/iam/user_services.py`
- Modify: `backend/app/modules/iam/auth_services.py`（+change_password）、`backend/app/modules/iam/roles.py`（READONLY perms 增加 `"auth:password:self"`）、`backend/app/main.py`（注册新 services 模块 import，与现有同款）
- Test: `backend/tests/test_user_mgmt.py`

**Interfaces:**
- Produces（全部 `@service` 五路同生）：
  - `user_list`（perm `system:user:read`, read）→ `Page[UserOut]`（id/account/name/email/status/is_system_admin/created_at）；
  - `user_create`（perm `system:user:create`, write, POST /system/users 201）入参 `{account,name,email?,password}`，account 撞库 → 409 `conflict`；密码强度同 bootstrap 规则；
  - `user_update`（perm `system:user:update`, write）可改 name/email/重置 password（重置后审计 diff 不含密码字段——§10.3 审计不落密钥）；
  - `user_status`（perm `system:user:disable`, write）status=active/disabled；禁用用户下次请求即 401（auth 依赖查 status）；不允许禁用自己与最后一个系统管理员（400 `invalid_input`）；
  - `password_change_self`（perm `auth:password:self`, write, POST /auth/password）入参 `{old_password,new_password}`：旧密不符 → 403 `bad_credentials`；
  - `role_template_list`（perm `project:member:read`, read, GET /role-templates）→ 内置模板 `[{code,name,perms}]`（成员管理下拉数据源；与成员列表同门，**裁量**：目录级信息不设独立权限位）。
- Consumes: `hash_password/verify_password`(core.security)、`Page/paginate`(core.errors)。

- [ ] **Step 1: 写失败测试** `test_user_mgmt.py`：
  ① admin 建用户→列表可见→禁用→该用户登录 200 但带旧 token 访问受保护接口仍 401（token 有效但 status 检查在 auth 依赖里查库）；② 非系统管理员 `GET /system/users` → 403；③ 自助改密：错旧密 403，改后用新密登录 200、旧密 401；④ READONLY 用户自助改密 200（模板含 `auth:password:self`）；⑤ 禁用自己 → 400；⑥ `GET /role-templates` 项目成员 200 返回 4 内置角色。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（auth 依赖现查 `User.status`——在现有 `get_current_user` 加一行判断并返回 401 unauthorized；**顺带**给 `user_update` 的 diff 白名单 `["name","email"]`）→ **Step 4: 跑绿** → **Step 5: 全量回归+commit** `feat(iam): user admin, self password change, role catalog`

### Task 6: 环境增强 —— 项目级全局配置 + 环境头/超时

**Files:**
- Create: `backend/migrations/versions/0010_env_global.py`（表 `global_config`，down 配套）
- Modify: `backend/app/modules/env/models.py`（+`GlobalConfig`）、`backend/app/modules/env/services.py`（+2 个 @service + 变量/头合并函数）
- Test: `backend/tests/test_env_global.py`

**Interfaces:**
- Produces：`GlobalConfig`（表 `global_config`，UniqueConstraint(project_id, scope_type)）：`project_id, scope_type("VAR"|"HEADER"|"ASSERT"|"EXTRACT"), items(JSON)`。VAR/HEADER items=`[[k,v],...]`；ASSERT/EXTRACT 存而不用（1B 消费，UI 置灰"1B 开放"——诚实原则）。
  - `global_config_get`（perm `env:config:read`, read, GET /envs/global-config?project_id=）→ `{scopes: {VAR: [...], HEADER: [...], ASSERT: [...], EXTRACT: [...]}}`（缺省空表）；
  - `global_config_update`（perm `env:config:update`, write, POST /envs/global-config）入参 `{project_id, scope_type, items}` 整段覆盖；
  - `async def resolve_env(db, *, project_id, env_id: str|None) -> tuple[dict[str,str], list[list[str]], int|None]`：**给 T8/T11 用**——返回 (vars, headers, timeout_ms 或 None)；vars = 项目 VAR ∪ 环境 config.vars（环境覆盖项目）；headers = 项目 HEADER ∪ 环境 config.headers（后者覆盖，按 key 大小写不敏感去重）；env_id=None → 仅项目层（超时取 `get_settings().http_default_timeout` 语义由调用方 default 处理）。非成员 → 403（复用 `require_project_member` 现有模式）。

- [ ] **Step 1: 写失败测试**：① update VAR `[[base_url,A]]` 后 get 回显；② env1.vars 覆盖项目 VAR 同名 key；③ HEADER 项目层+环境层合并且大小写不敏感去重；④ 非成员 403；⑤ resolve_env(env_id=None) 只含项目层。
- [ ] **Step 2: 跑红** → **Step 3: 实现 + 迁移 0010（带 down）** → **Step 4: 跑绿** → **Step 5: Commit** `feat(env): project global config + env/header resolution`

### Task 7: 私有资源数据权限基座 + 运行记录查询

**Files:**
- Create: `backend/app/shared/visibility.py`、`backend/app/modules/execution/services.py`
- Create: `backend/migrations/versions/0011_api_ownership.py`（api_definition 加 `owner_id` String(36) null + `project_public` Bool default true，down drop 两列）
- Modify: `backend/app/modules/api_test/models.py`（ApiDefinition 两列）、`backend/app/modules/api_test/services.py`（create 落 owner、list 应用可见性谓词）
- Test: `backend/tests/test_visibility.py`、`backend/tests/test_run_record.py`

**Interfaces:**
- Produces（visibility.py）：`def visible_clause(model, ctx)` → SQLAlchemy 条件：系统管理员或项目管理员（`match_perm(ctx.perms,"*:delete")` 判管理员，与 MEMBER 模板一致）**恒真**；否则 `or_(model.project_public.is_(True), model.owner_id == ctx.user_id)`。配套 `def assert_row_visible(row, ctx)`：行级不可见 → 抛 `ApiError("not_found","…",404)`（与不存在同码——Review Focus 6）。
- Produces（execution/services.py）：`run_record_list`（perm `api:run:read`, read, GET /runs?project_id=&subject_id=&trigger=&status=&cursor&size）→ `Page[RunOut]`：`{id, subject_type, subject_id, subject_name, env_name, trigger, status, status_code, elapsed_ms, error, created_at, created_by_name}`（created_by_name join app_user.name；**列表不带 body**，详情另路：`run_get`(read) 返回含 request/response_snapshot——§11.4 列表页够用，1B 报告中心升级）。
  - 写入口 `async def save_run(db, *, project_id, subject_type, subject_id, subject_name, env_id, env_name, trigger, result: RunResult, request_snapshot: dict, created_by: str) -> RunRecord`：status = `"error"` if not result.ok else (`"passed"` if result.passed else `"failed"`)；response_snapshot 只存 `{status, headers, body_text(截断标记 truncated/body_size), elapsed_ms}`。commit 由调用方负责。

- [ ] **Step 1: 写失败测试**：① 同项目两个用户，A 建私有接口（project_public=False）→ B 列表看不到、B get/update → 404 not_found（不泄露存在性）、B delete → 404；② 同项目 PROJECT_ADMIN 看得到并可管；③ public 默认全员可见；④ 造 RunRecord 两行 → `GET /runs` 过滤+游标+created_by_name 正确，列表 JSON 无 response_snapshot 键。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（api_definition create 把 `ctx.user_id` 写 owner_id；update/delete 走 `assert_row_visible`）→ **Step 4: 跑绿** → **Step 5: Commit** `feat: private-resource visibility + run record query`

### Task 8: 单接口调试（走真实执行核，落运行记录）

**Files:**
- Modify: `backend/app/modules/api_test/services.py`（+`api_debug`）、`backend/app/modules/api_test/schemas.py`
- Test: `backend/tests/test_api_debug.py`（真 httpx 打 `scripts/target_app.py`？——**不**：CI 无靶场。用 FastAPI ASGITransport 注入：`api_debug` 的 run_api 调用允许经模块级 `_transport_factory` 注入，与 tasks.set_gateway_factory 同款测试钩子，默认 None=真实网络）

**Interfaces:**
- Consumes: `resolve_env`(T6)、`run_api`(T4)、`save_run`(T7)、`assert_row_visible`(T7)。
- Produces：`api_debug`（perm `api:debug:run`, **effect="write"**（裁量：对目标系统发真实请求属外部副作用，PLAN 模式必须拒绝——§9.4）, POST /api-debug）入参：
```python
class ApiDebugIn(BaseModel):
    project_id: str
    definition_id: str | None = None      # 三选一：定义 / 内联请求（编辑器未保存先调试）
    request: RequestObject | None = None
    env_id: str | None = None
    variables: dict[str, str] = {}         # 调试临时变量（最高优先级）
```
  行为：定义与内联二选一（都空/都填 → 422）；definition 跨项目 → 404（Review Focus 6）；请求体 = 定义 `request` 或内联；vars = resolve_env(T6) ⊕ payload.variables（覆盖层）；`MissingVar` → 422 `validation_error` details=`{"var": name}`（Review Focus 1）；执行 → `save_run(trigger="debug")` → 出参 `{run_id, ok, passed, status, headers, body_text, truncated, body_size, elapsed_ms, error, assertions}`（RunResult 全量回显——调试面板直接渲染）。

- [ ] **Step 1: 写失败测试**：① 内联请求调试 200 + 断言卡数据齐 + run_record 落库 trigger=debug；② 用定义 id 调试（`${base_url}` 由 env 解析）passed；③ 缺变量 → 422 details.var=="token"；④ 别项目 definition_id → 404；⑤ PLAN 模式 agent 入口调用被模式门拒（沿用 dispatcher 现有门，断言错误文案含"只读"）。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（`_transport_factory: Callable|None = None` 模块级 + `set_debug_transport()` 测试钩子；ctx.entry=="http" 与 "agent" 同码路径）→ **Step 4: 跑绿** → **Step 5: 全量回归 + commit** `feat(api): single-request debug through real execution core with run records`

### Task 9: API 模块树（无限级 + 回收站）

**Files:**
- Create: `backend/migrations/versions/0012_api_module.py`（表 `api_module`：id,project_id,parent_id null,name,sort int,status normal/recycled, + UniqueConstraint(project_id,parent_id,name)；down drop）
- Modify: `backend/app/modules/api_test/models.py`（+ApiModule）、`services.py`、`schemas.py`
- Test: `backend/tests/test_api_module.py`

**Interfaces:**
- Produces（@service×5）：`api_module_tree`(read, GET /api-modules?project_id=)→整棵树 `[{id,parent_id,name,sort,count,children:[…]}]`（count=该模块直属**未回收**接口数，含私有可见性过滤——Review Focus 5）；`api_module_create`(write, POST /api-modules 201){project_id,parent_id?,name}；`api_module_update`(write){project_id,module_id,name?,sort?,parent_id?}——**环检测**：新 parent 是自己或后代 → 400 `invalid_input`（Review Focus 4）；重名同父 → 409；`api_module_move` 合入 update 的 parent_id；`api_module_delete`(destructive){project_id,module_id}→软删自身+全部后代 status=recycled（接口不删，模块树回收站视图可恢复）；`api_module_restore`(write){project_id,module_id}。
- 权限位：`api:module:read/create/update/delete`（delete=destructive，仅管理员与 MEMBER 模板外——MEMBER 无 `*:delete`，天然禁删，符合 §10）。

- [ ] **Step 1: 写失败测试**：① 三层树建齐→tree 结构/计数正确；② 把父挂到自己孙子下 → 400；③ 删除中间层 → 子孙全 recycled，tree 默认视图不含、`include_recycled=true` 入参可见；④ restore 后回归；⑤ 非成员 403；同父重名 409。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（tree 一次查全量内存组树，防 N+1；环检测=沿 parent 链上溯，visited 集合防死循环）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(api): module tree with cycle guard and recycle bin`

### Task 10: 接口用例 + 数据集（含用例调试）

**Files:**
- Create: `backend/migrations/versions/0013_case_dataset.py`（表 `api_case`：id,definition_id,project_id,name,priority(P0-P3 default P2),request JSON null(覆盖语义),assertions JSON,dataset_id null,sort,owner_id,project_public,status normal/recycled + Timestamp；表 `data_set`：id,project_id,name,columns JSON,rows JSON + UniqueConstraint(project_id,name)；api_definition.module_id 已存在；down 配套）
- Modify: `api_test/models.py schemas.py services.py`
- Test: `backend/tests/test_api_case.py` `test_dataset.py`

**Interfaces:**
- Produces：`api_case_*`×5（list/create/get/update/delete；perm `api:case:*`；create 需 definition 可见；request=null 表示"继承定义"；update 乐观锁不需要（用例无 version 列，**裁量**：1A 用例不做版本，§6.2 版本历史二期 UI）；delete=软删进回收站（`status=recycled`+list 默认过滤——与模块回收站同语义，Review Focus 5）；可见性=owner/public（T7 谓词）。
- Produces：`data_set_get`(read, GET /datasets?project_id=) / `data_set_create`(write 201){project_id,name,columns:[str],rows:[[str]]，行长必须=列数否则 422}` / `data_set_update`(write，整表覆盖) / `data_set_delete`(destructive)。**不**做 CSV 粘贴解析——前端粘贴转 rows（编辑器职责，后端只认结构）。
- Produces（用例调试）：`api_debug`（T8）payload 增 `case_id: str | None`——三选一：请求合并 = 定义 request ← 用例 request **按键浅覆盖**（method/url/params/headers/body 逐键，params/headers 整对表替换），vars 增数据集首行（若用例绑 dataset：columns→rows[0] 作为最低优先级层，1B 场景循环时全行驱动）。

- [ ] **Step 1: 写失败测试**：① 用例 CRUD+继承（get 返回 effective_request=合并结果，用例未覆盖的 url 来自定义）；② 用例覆盖 url 后调试打不同路径（ASGITransport 钩子）；③ dataset 行长≠列数 422；④ 用例绑数据集后调试 vars 含首行 key；⑤ 软删后 list 不可见 + `recycled=true` 可见 + delete 二次=404；⑥ 私有用例 B 404。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(api): cases with request overlay + datasets`

### Task 11: Agent 工具面同步 + 权限点全量入库

**Files:**
- Modify: `backend/app/modules/agent/dispatcher.py` 或既有工具目录（无需改代码——新 @service 自动注册；**此任务只钉断言**），`scripts/seed_demo.py`（demo 项目补：模块树 2 层 + 用例 2 条 + 数据集 1 个 + 全局配置）
- Test: `backend/tests/test_tool_surface_1a.py`

**Interfaces:**
- Consumes: T5-T10 全部 @service。
- Produces: 无新接口；**回归钉**：① `GET /agent/tools`（admin 会话）包含 1A 新工具全集（api_case_create/api_debug/data_set_create/api_module_delete/run_record_list/user_create/password_change_self…按 `tool=True` 的清单逐一断言存在）；② `api_debug` 的 effect=="write"（PLAN 拒绝）；③ READONLY 会话看不到任何写工具但能看到 `run_record_list`；④ `perm_point` 表启动同步后包含全部新权限位（registry_sync 现有机制，断言计数增长）；⑤ demo 项目经 seed 后 tree/cases/datasets 可查。

- [ ] **Step 1: 写失败测试**（此时部分断言应已绿——绿了也算步骤完成，红项修复）→ **Step 2: 跑** 记录红项 → **Step 3: 修** 直至全绿（预期改动集中在 tool 描述质量：每个新 @service 的 description 面向模型写清楚何时用）→ **Step 4: seed_demo 重跑幂等验证**（跑两遍不重复）→ **Step 5: Commit** `feat(agent): 1A tool surface pinned; demo seed extended`

### Task 12: 后端金线扩展 —— 1A 全链路集成测试

**Files:**
- Test: `backend/tests/test_golden_1a.py`

**Interfaces:** Consumes: 前述全部。Produces: 无；证明 1A 后端判据。

- [ ] **Step 1: 写集成测试**（同 test_golden_path 骨架：fakeredis+ASGITransport+ASGITransport 注入调试传输）：登录→项目→全局配置 base_url→环境→模块树→接口定义（URL 用 `${base_url}`）→用例（覆盖 params）→数据集→绑定→**agent FULL 会话 fake 模型脚本（新 fixture `onea_build_and_debug.jsonl`：api_definition_create→api_case_create→api_debug({{PID}} 绑定)）**→断言：事件序列含 3 组 TOOL_CALL/RESULT、run_record 落库 status=passed、`GET /runs` 可见 trigger=agent 记录、审计含 http+agent 双入口、私有用例对只读成员 404、PLAN 会话里 api_debug 被拒。
- [ ] **Step 2: 跑红→修→跑绿** → **Step 3: 全量回归**（pytest + ruff + lint-imports）→ **Step 4: Commit** `test: 1A golden chain`

### Task 13: 导航与骨架 —— 左侧模块树路由（§11.1）

**Files:**
- Modify: `web/src/App.tsx`（路由 +/api /datasets /runs /settings）、`web/src/layout/Shell.tsx`（或现有侧栏组件：菜单换成 §11.1 结构，未开放项 `disabled` + Tooltip「1B/1C 开放」——诚实原则，不做假页面）
- Test: `web/e2e/nav.spec.mjs`

**Interfaces:**
- Consumes: `useAuth()`、`api/client.get/post`。
- Produces: 路由 `/api`（接口管理）、`/datasets`、`/runs`、`/settings`；菜单项 data-testid：`nav-api` `nav-datasets` `nav-runs` `nav-settings`；场景编排/UI/ADB/报告 = disabled。无项目时三页显示「先在工作台选项目」空态（复用现有 Empty 模式）。

- [ ] **Step 1: 写失败 Playwright**：登录→点 nav-api→URL `#/api` 且见接口页头→点 disabled 的「场景编排」不跳转→nav-settings 打开设置。
- [ ] **Step 2: 跑红** `pnpm exec playwright test e2e/nav.spec.mjs` → **Step 3: 实现** → **Step 4: 跑绿 + `pnpm build` 过** → **Step 5: Commit** `feat(web): IA navigation with honest disabled items`

### Task 14: 接口管理页（§11.4.2 列表 + §11.4.3 详情抽屉）

**Files:**
- Create: `web/src/pages/api.tsx`、`web/src/api/RequestEditor.tsx`、`web/src/api/DebugPanel.tsx`、`web/src/api/ModuleTree.tsx`
- Test: `web/e2e/api.spec.mjs`

**Interfaces:**
- Produces: `RequestEditor({value,onChange,readOnly})` = §11.4.4 子集 Tabs（参数/请求头/Body/断言/超时），pairs 表格可增删行，断言行=类型下拉(§7.1 全集+script 置灰注「1B」)+path/expected；`DebugPanel({result})` = 状态码徽标（2xx 绿/4xx 橙/5xx 红/error 灰）、耗时、断言卡（✓/✗ + 期望/实际 + error 红字）、响应体 `<pre>` 折叠 + 「已截断」提示。
- 页面结构（§11.4.2）：左 208 ModuleTree（树+计数+右键/悬停菜单：新建子模块/重命名/移动/删除/回收站切换），右列表（搜索本地过滤、方法 Tag 色、状态、最近结果列来自 `GET /runs?subject_id=` 首条 status 徽标——**性能裁量**：列表页对当页 id 一次 `POST /runs/batch-latest`？——**不做**：1A 用 `GET /runs?subject_id=` 逐行懒加载 50 行内可接受，1B 报告中心改批量接口）。行悬停[详情][删除]；「+新建」开全屏编辑页（左基本信息 360 + 右 RequestEditor + 顶栏保存）；详情抽屉 `min(70vw,1000px)` Tabs[定义/用例(N)]，定义 Tab 只读渲染 + 「编辑」跳全屏，用例 Tab = 用例列表 + 新建 + 单条[调试]。
- data-testid：`api-new` `api-row` `api-debug` `api-save` `module-create` `debug-panel` `assertion-card`。

- [ ] **Step 1: 写失败 Playwright**（后端 fake 模型无关，用真 seed 演示项目 + ASGITransport 不适用→**e2e 用 target_app 真靶场**：playwright webServer 增加第三台 `target_app.py :9999`，`reuseExistingServer: true`）：建模块→新建接口（url `${base_url}/order/1`，断言 status_code 200）→保存→列表 1 行→打开抽屉→点调试→DebugPanel 见 200 + 断言 ✓→列表「最近结果」变绿点。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（api 页 + 编辑器 + 调试面板；env 选择器复用顶栏当前项目 + 页内环境下拉，默认第一个环境）→ **Step 4: 跑绿** → **Step 5: Commit** `feat(web): api management with module tree, request editor and live debug`

### Task 15: 用例/数据集页 + 调试体验细化

**Files:**
- Create: `web/src/pages/datasets.tsx`；Modify: `web/src/api/*`（用例列表组件化进 `web/src/api/CaseList.tsx`）
- Test: `web/e2e/datasets.spec.mjs`

**Interfaces:**
- Produces: 数据集页 = 左列表右编辑（列头可增删、单元格表格编辑、CSV 粘贴解析：首行=列名，`	` 或 `,` 分隔，前端解析后传 rows——后端只认结构）；用例抽屉内「继承自定义」提示 + 覆盖字段高亮；用例行[调试]复用 DebugPanel。

- [ ] **Step 1: 写失败 Playwright**：建数据集（含粘贴 2 行）→ 接口抽屉用例 Tab 新建用例绑数据集 → 用例调试 200 → 断言卡 2 张（继承 1 + 自加 1）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿** → **Step 5: Commit** `feat(web): datasets and case authoring with inherited-request debug`

### Task 16: 运行记录页 + 设置页（成员/用户/角色/审计入口）

**Files:**
- Create: `web/src/pages/runs.tsx`、`web/src/pages/settings.tsx`
- Test: `web/e2e/runs.spec.mjs` `web/e2e/settings.spec.mjs`

**Interfaces:**
- Produces: 运行记录页 = 表格（时间/对象/触发徽标（调试=✎Pilot=✦手动=▶）/状态/码/耗时/操作[详情 Drawer 显示 request+response+断言]）+ 触发/状态筛选 + 游标「加载更多」；设置页 Tabs：成员（列表+改角色，数据源 `/role-templates`）、用户（仅系统管理员 Tab 可见，建/禁用/重置密码——重置密码 Modal 提示「新密码将告知用户，平台不保存明文」）、审计日志（S0 已有 API？若无则 Tab 显示「1E 开放」+ 后端 `audit_list` @service 在本任务补：perm `system:audit:read`, read, GET /audit?project_id=&entry=&action=&cursor&size）。

- [ ] **Step 1: 写失败测试**（后端 `tests/test_audit_query.py`：admin 查 /audit 能看到 http+agent 行、非管理员 403；前端 e2e：跑一次调试→runs 页见行→详情 Drawer；settings 成员改角色→只读用户登录后 nav-api 可看但「+新建」按钮隐藏（按钮按权限位渲染，§10.1））。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（前端权限渲染小工具 `can(perm)` 放 `web/src/auth/perms.ts`：复用后端 match_perm 语义——`*`、`*:read`、`-*:delete` 拒绝优先；**必须与后端 match_perm 行为一致**，用 3 个单测钉住）→ **Step 4: 跑绿** → **Step 5: Commit** `feat: run records, audit query, settings pages with permission-aware rendering`

### Task 17: 演示手册、CI 与收尾

**Files:**
- Create: `docs/superpowers/plans/README-1a-demo.md`
- Modify: `backend/scripts/seed_demo.py`（若 T11 未覆盖全）、`web/playwright.config.ts`（target_app 已在 T14 加入）、`.github/workflows/ci.yml`（无需改——已有全量门；确认 e2e 三服务端口不撞 Windows 排除段）

- [ ] **Step 1: 手册**：从零（本机起 MySQL/Redis → 建库）→ alembic → seed → 起靶场(9999) → 起平台 → 前端；演示脚本 20 分钟版：建项目→全局配置 base_url→模块→建接口→调试→用例+数据集→运行记录→Pilot 自动建接口+调试（FULL）→PLAN 模式拒绝调试（展示 §9.4 门在真实副作用上的价值）→只读成员视角（新建按钮消失、工具清单只剩读）。真实模型复跑章节同 S0 手册。
- [ ] **Step 2: 本地按手册完整走一遍**（curl/浏览器逐条，记录截图路径到 ledger）。
- [ ] **Step 3: 全量回归**：`pytest -q`、`ruff check app scripts tests`、`lint-imports`、`pnpm build`、`pnpm exec playwright test`。
- [ ] **Step 4: Commit + tag `1a-api-assets`**。

---

## 完成判据（= §13「1A」条目逐条）

1. IAM/项目/成员/角色模板/数据权限 → T5/T7/T16（私有资源可见性 + 4 角色矩阵 + 按钮级权限渲染）。
2. 环境与全局配置 → T6（变量/头分层合并，`${var}` 快败语义 T1/T8）。
3. API 模块/接口/用例/数据集 → T9/T10/T14/T15。
4. 单接口调试走同一执行核 → T4/T8（不落报告，落 run_record；PLAN 模式拒绝）。
5. 简易运行记录（列表可看，详情后补）→ T7/T16。
6. 业主可演示「建接口→建用例→调试通过→列表见最近结果」→ T14/T17 手册。

**不在本计划**（1B 起）：导入导出、场景与步骤树、执行引擎其余 handler、报告中心、Celery worker、定时/通知（1E）、UI/ADB（1C/1D）、脚本沙箱与 script 断言真实执行（1B §8.5）、版本历史 UI（二期）。

