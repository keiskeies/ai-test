# S0 金线纵切 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **✅ 本批次已完成（2026-11-16 回填）**——下列未勾 checkbox 是**写法陈旧，不是待办**：S0 收尾时没人回来逐格打勾，完成度由别处追踪。别照这些格子找活干（1A/1B/1C 同此口径）。
> 完成的证据是这三处：**git tag `s0-golden-slice`**（每批收尾必打 tag 是蓝图 §13 纪律 3）｜**逐条完成判据在本文末尾 `## 完成判据(= §13 S0 定义逐条)`**｜演示手册 `docs/superpowers/plans/README-s0-demo.md`。
> 后续批次改用「`### TN · …` 标题带 ✅ + 尾部 `**落地证据（commit XXXXXXX）**` 段 + 门禁实测数字」的口径（见 1D），**新批次以 1D 为格式模板**，不再依赖本文件的 checkbox。

**Goal:** 用最小纵切证明"工具化单体"架构成立——`@service` 装饰器一次标注,HTTP 路由 + OpenAPI + Agent 工具 schema + 权限位 + 审计五路同生,并由假模型回放驱动 ReAct 循环调用真实工具、SSE 逐步出事件。

**Architecture:** 模块化单体(FastAPI + SQLAlchemy async + MySQL8 + Redis),`app/core` 提供配置/错误/事件总线/注册表等底座,`app/modules/*` 只经 service 函数互调;`web` 为 Vite+React+AntD5 最小前端(登录→项目→Pilot 试验台)。**S0 不含执行引擎与 Celery**(那是 1B),MySQL/Redis 用本机启动的实例(生产/Linux 才用 compose 栈)。

**Tech Stack:** Python 3.12、FastAPI、Pydantic v2、SQLAlchemy 2(asyncmy)+ Alembic、MySQL 8(本机实例)、Redis 7(本机实例)、httpx、openai SDK(仅 OpenAI 兼容协议适配)、React 18 + TS + Vite + Ant Design 5、pytest + pytest-asyncio。

**Spec:** `docs/superpowers/specs/2026-11-13-ai-test-platform-design.md`(本计划实现其 §3.2/§3.3、§6.1-6.2、§7.1、§9.1-9.4、§12;§13 的 S0 条目)

## Global Constraints

- Python 3.12;MySQL 8(**本机启动的实例**,开发禁 SQLite);Redis 7(**本机实例**)。依赖只准 §5 清单内,新增须评审。**【2026-11-19 口径变更(业主)】各种测试一律在本机启动的软件上跑,不再要求 MySQL/Redis 经 Docker;「必须 MySQL 8、禁 SQLite 双轨」与容器无关,原样保留**(详见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4)。
- 不使用任何 Agent 框架(无 LangChain);模型适配 = openai/anthropic SDK 上的自研薄层。
- 实时通道只用 SSE,不引入 WebSocket。
- 时刻 UTC 存储,展示 Asia/Shanghai;一期 UI 仅中文。
- REST 前缀 `/api/v1`;错误包 `{code, message, details}`;游标分页 `{items, next_cursor}`。
- 事件信封 `{seq, ts, type, payload}`;agent 事件 type ∈ USER/THINKING/TEXT/TOOL_CALL/TOOL_RESULT/APPROVAL_REQ/APPROVAL_DECISION/COMPACT_NOTE/USAGE/ERROR(S0 用其子集)。
- 工具名 = 稳定 snake_case 全局唯一;service 装饰器必填 perm/effect/name/description。
- 模块间禁止跨模块 import 内部实现(core/shared 除外);用 import-linter 规则强制。
- 每个 Alembic 迁移必带 down;`git tag` 收尾本计划为 `s0-golden-slice`。
- 前端色板/尺寸按 §11.6/§11.7(ConfigProvider Token,主按钮底色 primary-600 #1D7257)。

## Review Focus

蓝图未逐字写明但最可能咬人的五类输入,行为预期如下,各自钉死在对应任务的测试里:

1. **过期/伪造 JWT** → 401 + `{code:"unauthorized"}` 信封,前端统一登出跳登录钉在 T3/T14。
2. **SSE 断线重连**(cursor 续传)→ 以 PG 中 agent_message.seq 为准补齐断线期间事件,不丢不重钉在 T9。
3. **模型返回非法 tool_call 参数**(非 JSON/缺必填)→ 校验错误以 TOOL_RESULT(ok=False)回注上下文让模型自纠,循环不崩钉在 T11。
4. **访问非成员项目** → 403 统一文案且与"项目不存在"同码,不泄露存在性钉在 T4。
5. **同一会话已有 RUNNING run 时再发消息** → 409 `{code:"session_busy"}`(S0 不排队)钉在 T12。

## 文件结构(S0 建成后)

```
backend/
  pyproject.toml  alembic.ini  migrations/versions/0001_s0_baseline.py
  app/main.py                    # 组装:路由/异常/生命周期/启动自检
  app/core/config.py             # pydantic-settings,env 前缀 TP_
  app/core/db.py                 # engine/sessionmaker/Base/UTC DateTime 列型
  app/core/errors.py             # ApiError + handler + Page[T]
  app/core/security.py           # hash/JWT/deps
  app/core/eventbus.py           # Redis pub/sub 发布订阅抽象
  app/core/registry.py           # ToolSpec/ServiceRegistry/REGISTRY
  app/core/service.py            # @service 装饰器 + ServiceCtx
  app/modules/iam/               # models/schemas/services/routes/bootstrap
  app/modules/env/               # models/schemas/services
  app/modules/api_test/          # models/schemas/services(S0 只做 definition)
  app/modules/audit/             # models/services
  app/modules/agent/             # models/gateway/runner/dispatcher/routes
  app/modules/model_cfg/         # models/services(种子)
  tests/                         # conftest(连本机 MySQL/Redis 的 db fixture)+ fixtures/fake_model/
  scripts/seed_demo.py           # demo 数据 + 靶场 mock app
web/                             # Vite React TS:src/{app.tsx,api/,pages/{login,workbench,bench}}
docker-compose.yml               # 仅生产/Linux 可选形态:mysql8 + redis7(+qdrant profile rag);本机测试不需要它
.github/workflows/ci.yml         # lint + import-linter + pytest + web build
```

---

## Task 1: 仓库脚手架与基础设施基线(本机实例)

**Files:**
- Create: `docker-compose.yml`, `.gitignore`, `backend/pyproject.toml`, `backend/app/main.py`, `backend/app/core/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_health.py`, `.github/workflows/ci.yml`
- Modify: 无(全新)

**Interfaces:**
- Consumes: 无
- Produces: `app.main:create_app() -> FastAPI`(`/api/v1/healthz` → `{"status":"ok"}`);本机 mysql8(root 密码/库 `tp`,端口 3306)+ redis7(6379)可直连;`pytest` 可跑。

- [ ] **Step 1: 写失败测试** `tests/test_health.py`

```python
from httpx import ASGITransport, AsyncClient

async def test_healthz_ok():
    from app.main import create_app
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
```

- [ ] **Step 2: 跑测试确认失败**(ModuleNotFoundError: app)
  Run: `cd backend && python -m pytest tests/test_health.py -v`
- [ ] **Step 3: 实现** pyproject(依赖固定:fastapi/uvicorn/pydantic>=2/pydantic-settings/sqlalchemy[asyncio]/asyncmy/alembic/httpx/openai/redis/celery(先装不用)/passlib[bcrypt]/pyjwt/pytest/pytest-asyncio/fakeredis/import-linter),create_app 与 healthz 路由;compose 文件(仅生产/Linux 可选);conftest 设 asyncio_mode;CI 先跑 pytest(不含 DB)。
- [ ] **Step 4: 跑测试确认通过**;本机 MySQL/Redis 起得来,`mysqladmin ping`(127.0.0.1)与 `redis-cli ping` 通。
- [ ] **Step 5: Commit** `feat: S0 scaffold, healthz(基础设施走本机实例)`

## Task 2: core 底座(配置/错误/DB/Alembic 基线)

**Files:**
- Create: `backend/app/core/config.py`, `backend/app/core/errors.py`, `backend/app/core/db.py`, `backend/migrations/*`(alembic init), `backend/migrations/versions/0001_s0_baseline.py`, `backend/tests/test_core_db.py`
- Modify: `backend/app/main.py`(挂 handler、启动时按 env 决定跑不跑迁移)

**Interfaces:**
- Consumes: T1 create_app
- Produces:
  - `Settings`(TP_ 前缀:`TP_DB_URL`、`TP_REDIS_URL`、`TP_SECRET_KEY`、`TP_FERNET_KEY`、`TP_ENV`),`get_settings() -> Settings`(lru_cache)
  - `ApiError(code: str, message: str, http_status: int, details: dict | None = None)`,handler 输出 `{code,message,details}`;任意未捕获异常 → 500 `{code:"internal"}`
  - `Base`(DeclarativeBase)、`UtcDateTime` 列型(存 UTC tz-aware)、`UUIDPk` 列型、`get_db() -> AsyncIterator[AsyncSession]` 依赖
  - `Page[T]`:`{items: list[T], next_cursor: str | None}` + `paginate(stmt, cursor, size)`

- [ ] **Step 1: 写失败测试** `tests/test_core_db.py`:连本机 MySQL 起一个当轮专属临时 schema → `alembic upgrade head` → 插一行带时间 → 读回断言 tz-aware 且为 UTC;`ApiError` 经 handler 出信封(断言 code/details);非法游标 `paginate` → 400 `{code:"bad_cursor"}`。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** config/errors/db 与 0001 基线迁移(空迁移,仅建立后续迁移起点;`down` 为空操作)。conftest 提供 `db`+`session` fixture(会话级建一次当轮专属 schema,用例级清表)。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat: core config/errors/db with UTC convention`

## Task 3: 认证与首次启动引导

**Files:**
- Create: `backend/app/core/security.py`, `backend/app/modules/iam/{models.py,schemas.py,services.py,routes.py,bootstrap.py}`, `migrations/versions/0002_iam_users.py`, `backend/tests/test_auth.py`
- Modify: `app/main.py`(挂 iam 路由、启动钩子调 bootstrap)

**Interfaces:**
- Consumes: T2 全部
- Produces:
  - `hash_password(pw)->str` / `verify_password(pw,h)->bool` / `create_access_token(user_id: UUID)->str`(HS256,12h)/ `decode_access_token(t)->UUID`
  - `get_current_user` FastAPI 依赖 → `User`;失败抛 `ApiError("unauthorized",...,401)`【Review Focus 1 钉此处】
  - 表:`user(id, account UNIQUE, name, password_hash, is_system_admin bool, status, created_at)`
  - `POST /api/v1/auth/login {account,password} -> {token,user}`;错误 → 401 `{code:"bad_credentials"}`;`GET /api/v1/auth/me -> UserOut`(需 token)
  - `bootstrap.run_bootstrap(db)`:幂等——建系统管理员(env `TP_BOOTSTRAP_ACCOUNT/PASSWORD`,缺省 admin/首随机打印一次);建内置 4 角色模板(T4)
- [ ] **Step 1: 写失败测试** `test_auth.py`:login 成功发 token → `/auth/me` 可达;错密码 401 bad_credentials;篡改 token 401 unauthorized【RF1】;bootstrap 幂等(跑两次一条管理员)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: auth + bootstrap`

## Task 4: 项目 / 成员 / 角色模板与数据权限

**Files:**
- Create: `migrations/versions/0003_iam_projects.py`, `backend/app/modules/iam/{project_services.py,deps.py}`(并入 iam 模块), `backend/tests/test_projects.py`
- Modify: `backend/app/modules/iam/models.py`, `routes.py`

**Interfaces:**
- Consumes: T2 paginate、T3 get_current_user
- Produces:
  - 表:`project(id,name,description,created_by,created_at)`、`project_member(project_id,user_id,role_code)`、`role_template(code,name,perms JSON)`
  - 内置角色 perms(种子常量 `BUILTIN_ROLES`):ADMIN=全部权限点;PROJECT_ADMIN=除系统管理外全部;MEMBER=读+写+执行(不含删除类`:delete`与`*:manage`);READONLY=全部`:read`。权限点字符串以 registry 启动同步为准(T5)。
  - `require_project_member(project_id)->Depends` → `ProjectCtx(user, project_id, role_code, perms: set[str])`;非成员 → `ApiError("forbidden", "无此项目权限", 403)`;项目不存在同码同文案【Review Focus 4 钉此处】
  - REST:`POST/GET /projects`、`GET/PATCH /projects/{id}`、`PUT/DELETE /projects/{id}/members/{user_id}`(body {role_code});游标分页。

- [ ] **Step 1: 写失败测试** `test_projects.py`:建项目→创建者自动 ADMIN;加成员 MEMBER;非成员访问 → 403 且与不存在项目 403 响应体逐字段相等【RF4】;MEMBER 删除成员 → 403 `{code:"insufficient_permission"}`(权限点判定走 T5 前的临时角色映射)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(perms 解析函数 `perms_of_role(code) -> set[str]` 先读种子常量,T5 起改为并上 registry 同步结果)→ **Step 4: 通过** → **Step 5: Commit** `feat: projects, members, builtin roles`

## Task 5: @service 装饰器与注册表(金线核心·上)

**Files:**
- Create: `backend/app/core/service.py`, `backend/app/core/registry.py`, `backend/tests/test_registry.py`
- Modify: `backend/app/main.py`(启动时 `REGISTRY.build_router()` 挂载 + `sync_perm_points`)

**Interfaces:**
- Consumes: T2/T3/T4(db、ApiError、ProjectCtx 不在此层强绑)
- Produces(全文档统一,后续任务只准引用不准改名):
  - `ServiceCtx(user_id: UUID, project_id: UUID | None, perms: set[str], db: AsyncSession, entry: Literal["http","agent","schedule"], audit_extra: dict)`
  - `@service(*, perm, effect: Literal["read","write","destructive"], name, description, tool=True, resident=False, http=None)`;被装饰函数签名固定为 `async def fn(payload: BaseModel, ctx: ServiceCtx) -> BaseModel | None`;http = `{"method":"POST","path":"/projects","tags":["iam"],"status":201}`
  - `ToolSpec(name, description, json_schema: dict, perm, effect, handler, model, tool, resident, http)`
  - `REGISTRY.register(spec)`(重名启动即抛)、`REGISTRY.build_router() -> APIRouter`(payload 从 body/project_id 从 query 或 path 注入 ctx;返回 `payload.model` 校验后 JSON)、`REGISTRY.list_tools(perms) -> list[ToolSpec]`(过滤 tool=False 与无权限点)【§9.4"不可见"钉此处】、`REGISTRY.perm_points() -> set[str]`;启动 `sync_perm_points` 落 `perm_point(code, module)` 表并断言 BUILTIN_ROLES 引用合法。

- [ ] **Step 1: 写失败测试** `test_registry.py`:定义样例 service(Pydantic payload 含约束:Field(min_length,ge))→ 断言 json_schema 由 Pydantic 推导(minLength/minimum 在);重名注册抛错;build_router 挂载后 httpx 调用样例路由成功(200 且响应=model dump;权限点缺失用户经 get_current_user+角色注入 → 403 insufficient_permission);list_tools 按 perms 过滤(READONLY 看不到写工具);perm_points 收集完整。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(路由错误统一 ApiError;分页返回 Page)→ **Step 4: 通过** → **Step 5: Commit** `feat: @service decorator + registry dual registration (HTTP/OpenAPI/perm)`

## Task 6: 审计与工具分发器(金线核心·中)

**Files:**
- Create: `backend/app/modules/audit/{models.py,services.py}`, `backend/app/modules/agent/dispatcher.py`, `migrations/versions/0004_audit.py`, `backend/tests/test_dispatcher.py`

**Interfaces:**
- Consumes: T5 REGISTRY/ServiceCtx、T2 db
- Produces:
  - 表 `audit_log(id, ts, user_id, entry, action, target, ok, diff JSON, ip)`;`audit.record(db, *, user_id, entry, action, target, ok, diff=None)`(同事务写)
  - `ToolResult(ok: bool, content: Any = None, error: str | None = None, ui: str | None = None, produced: list[dict] = []`)
  - `ToolDispatcher.call(tool_name: str, args: dict, ctx: ServiceCtx, *, mode: Literal["PLAN","ASK","FULL"], grants: set[str], emitter=None) -> ToolResult`:顺序=①`REGISTRY` 查无 → ok=False "unknown_tool";②权限点(无权限=同 unknown_tool,不泄露)③模式门:PLAN 且 effect≠read → 拒绝注文案"当前只读模式";ASK 且 effect∈(write,destructive) 且 tool_name∉grants → 抛 `NeedApproval(tool_call_id, tool_name, args)`(由 runner 处理,T11);FULL 直通;④Pydantic 校验 args(失败 → ok=False + 校验详情,模型可自纠);⑤执行 handler(异常捕获 → ok=False);⑥audit.record(entry="agent");⑦写类返回值若为 dict 且含 `produced` 键则透传。

- [ ] **Step 1: 写失败测试** `test_dispatcher.py`:读工具直通;PLAN 拒写(ok=False,含"只读");ASK 未授权抛 NeedApproval;grants 含名 → 直通;FULL 直通;unknown_tool 与无权限位返回**字节一致**的 ok=False;非法 args → ok=False 且 error 含字段名;每次调用落 audit_log(断言 entry/ok/action)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: audit log + tool dispatcher with mode gate`

## Task 7: 环境管理(第一个真实 @service)

**Files:**
- Create: `backend/app/modules/env/{models.py,schemas.py,services.py}`, `migrations/versions/0005_env.py`, `backend/tests/test_env_service.py`

**Interfaces:**
- Consumes: T5/T6
- Produces:
  - 表 `environment(id, project_id, name, position, config JSON)`;config= `{"vars":[["base_url","http://127.0.0.1:9999"]]}`(S0 只存不消费)
  - @service ×4:`env_create(perm="env:config:create",effect=write,http=POST /envs)`、`env_list(env:config:read, GET /envs)`、`env_update(env:config:update, PATCH /envs/{id})`、`env_delete(env:config:delete, DESTRUCTIVE, DELETE /envs/{id})`——payload 均含 project_id,成员校验在 service 内 `ensure_member(ctx, project_id)`(新增公共函数,`core/service.py` 提供 helper)。

- [ ] **Step 1: 写失败测试** `test_env_service.py`:HTTP 建/查/改/删全链路(经路由,非直调);同 project_id 经 Dispatcher 以 agent entry 再调 env_create 成功且 audit_log 多一条 entry=agent(金线双路证明);非成员 project_id → forbidden。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(迁移带 down)→ **Step 4: 通过** → **Step 5: Commit** `feat: environment CRUD as first dual-registered service`

## Task 8: API 接口定义(金线全形:@service + 域模型 + 工具可见性)

**Files:**
- Create: `backend/app/modules/api_test/{models.py,schemas.py,services.py}`, `migrations/versions/0006_api_def.py`, `backend/tests/test_api_definition.py`

**Interfaces:**
- Consumes: T5-T7
- Produces:
  - 表 `api_definition(id, project_id, module_id NULL, name, method, path, request JSON, status ENUM("draft","complete"), version int DEFAULT 1, updated_at)`;request 结构 = §7.1 请求对象(整段 JSON 存,Pydantic `RequestObject` 校验:S0 实现 method/url/params/headers/body.type+content/timeout_ms/assertions 基础 5 型)
  - @service ×4:`api_definition_create(api:def:create,write)`、`api_definition_list(api:def:read)`、`api_definition_get(api:def:read)`、`api_definition_update(api:def:update,乐观锁 version,冲突→409 conflict)`;删除 1A 再开(S0 不做,装饰器照写 DESTRUCTIVE 但 http=None、tool=True 以便 T12 可见性测试)→ 修正:删除服务不建,避免死代码;S0 以 update 充当写类测试对象。
  - 返回体含 `produced=[{"kind":"api_definition","id":...,"name":...,"link":"/api/definition/"+id}]`(写类三件套统一附带,§11.4.36 协议首次落地)。

- [ ] **Step 1: 写失败测试** `test_api_definition.py`:创建(合法 §7.1 request)→ 列表 → 获取;非法 request(json 体但 content 非 JSON)→ 422 信封;乐观锁:旧 version 更新 → 409;经 Dispatcher 调 api_definition_create → 成功且 produced 非空、审计含 diff。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: api definition dual-registered with produced protocol`

## Task 9: 事件总线与 SSE(游标续传)

**Files:**
- Create: `backend/app/core/eventbus.py`, `backend/app/core/sse.py`, `backend/tests/test_sse.py`
- Modify: `app/main.py`

**Interfaces:**
- Consumes: T2(db/Redis 配置)、fakeredis(测试)
- Produces:
  - `EventBus(redis_url)`:`publish(channel: str, event: dict) -> None`、`subscribe(channel: str) -> AsyncIterator[dict]`、`replay_after(channel, cursor) -> list[dict]`(由 channel 绑定的回放源提供,agent 通道绑 agent_message)
  - `sse_response(request, channel, replay_fn, cursor) -> StreamingResponse`:先重放 `seq > cursor`,再进 pub/sub;发 `id: {seq}\nevent: {type}\ndata: {json}\n\n`;客户端断开即退订。
  - 约定:PG 里 seq 是唯一真相(单调整数,会话内),pubsub 只是加速器——**重放与直播同一信封**【Review Focus 2 钉此处】。
- [ ] **Step 1: 写失败测试** `test_sse.py`:向 fake bus 发 seq 1..5 → 客户端 cursor=0 收全 5;cursor=3 只收 4,5(不重不漏)【RF2】;断线模拟(读半程关闭 client)后 cursor 续传仍完整;信封字段齐(seq/ts/type/payload)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: event bus + resumable SSE`

## Task 10: Agent 数据模型与消息落库

**Files:**
- Create: `backend/app/modules/agent/models.py`, `backend/app/modules/agent/store.py`, `migrations/versions/0007_agent.py`, `backend/tests/test_agent_store.py`

**Interfaces:**
- Consumes: T2/T9
- Produces:
  - 表:`agent_session(id, project_id, user_id, title, mode ENUM(PLAN/ASK/FULL) DEFAULT ASK, model_id, thinking ENUM(off/low/medium/high) DEFAULT medium, status ENUM(active/archived), created_at)`;`agent_run(id, session_id, seq int, status ENUM(RUNNING/WAIT_APPROVAL/DONE/CANCELLED/ERROR), lease_owner, error, created_at)`(seq=会话内第几轮);`agent_message(id, session_id, run_id NULL, seq BIGINT, type, payload JSON, created_at)`——**append-only,永不 UPDATE/DELETE**(§9.9b);`agent_approval(id, run_id, tool_call_id, tool_name, args JSON, decision NULL, comment NULL, decided_at NULL)`。
  - `store.append_event(db, session_id, run_id, type, payload) -> AgentMessage`:seq=会话内 max+1(同一事务内 SELECT ... FOR UPDATE 会话行防并发)且即时 `bus.publish("agent.{sid}", envelope)`;envelope={seq,ts,type,payload}。
  - `store.replay(session_id, cursor) -> list[envelope]`。
- [ ] **Step 1: 写失败测试** `test_agent_store.py`:并发 append(两协程交错)seq 仍单调无重复;replay(cursor) 正确;append 后 bus 通道能收到同信封。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: agent tables + append-only event store`

## Task 11: 模型网关与假模型回放(含 ReAct Runner)

**Files:**
- Create: `backend/app/modules/model_cfg/{models.py,services.py,seed.py}`, `backend/app/modules/agent/gateway.py`, `backend/app/modules/agent/runner.py`, `migrations/versions/0008_model_cfg.py`, `backend/tests/fixtures/fake_model/basic_two_tools.jsonl`, `backend/tests/fixtures/fake_model/bad_args_then_fix.jsonl`, `backend/tests/test_runner.py`

**Interfaces:**
- Consumes: T5-T10(dispatcher、store、REGISTRY.list_tools)
- Produces:
  - 表 `model_config`(§4.8 S0 子集:name, model_type CHAT/EMBEDDING, protocol OPENAI_COMPAT/ANTHROPIC, base_url, api_key_enc(Fernet), context_window, max_output, supports_thinking, thinking_levels JSON, supports_vision, supports_tools, temperature_default, enabled, is_default, embed_dimensions NULL, probe_result JSON);`model_cfg.seed.seed_default_model(db)`(读 env `TP_MODEL_SEED_BASE_URL/TP_MODEL_SEED_NAME`,幂等,默认 CHAT 唯一)。
  - `ModelEvent` 判别联合(dict 形式):`{"type":"thinking_delta","text":str}` | `{"type":"text_delta","text":str}` | `{"type":"tool_call","id":str,"name":str,"args":dict}` | `{"type":"usage","input_tokens":int,"output_tokens":int}` | `{"type":"done","stop_reason":str}`
  - `ModelGateway.stream(*, messages: list[dict], tools: list[dict], model: ModelConfig, thinking: str, api_key: str) -> AsyncIterator[ModelEvent]`;实现 `OpenAICompatGateway`(openai SDK,stream=True;tool_calls 增量聚合后一次性产出;thinking 按 `thinking_delta` 风格字段读取,协议无该字段则跳过——降级容忍);S0 不实现 ANTHROPIC 分支(抛 NotImplemented,1B 补)。
  - `FakeGateway(script_path)`:逐行 JSONL 回放 ModelEvent(测试与演示都用它:`{"model":"fake"}` 特殊 base_url=`fake://<fixture名>`)。
  - `AgentRunner(gateway, registry, dispatcher, store, session_factory)`:`async def run_turn(session_id: UUID) -> None`——组装 messages(system 段 S0 固定 + 历史重放 + 本轮 USER);循环:stream→聚合(delta 合并:thinking/text 各自攒段,段结束 append 一条 THINKING/TEXT 事件,流内每 200ms 合并一次发布,防事件洪水);tool_call → `dispatcher.call`(mode 来自 session;NeedApproval → 落 APPROVAL_REQ + run=WAIT_APPROVAL 返回【S0 到挂起为止,T13 测】)→ TOOL_RESULT 落库继续;无 tool_call → DONE;每轮结束 USAGE。**同轮多 tool_call 顺序执行**(§9.3)。**args 校验失败(ok=False)回注 TOOL_RESULT 继续循环**【Review Focus 3 钉此处】。
- [ ] **Step 1: 写失败测试(两个 fixture)** `basic_two_tools.jsonl`:THINKING×2 + tool_call(search 读工具 env_list)+ TOOL_RESULT 期望 + tool_call(api_definition_create)+ final TEXT;断言 store 事件序列严格 = USER,THINKING,TOOL_CALL,TOOL_RESULT,THINKING,TOOL_CALL,TOOL_RESULT,TEXT,USAGE 且 api_definition 真被创建(双路金线闭环)。
  `bad_args_then_fix.jsonl`:首个 tool_call args 缺必填 → 断言 TOOL_RESULT ok=False 且 error 含字段名、run 继续、第二个 tool_call 修正成功、run DONE【RF3】。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(gateway/runner/seed)→ **Step 4: 通过** → **Step 5: Commit** `feat: model gateway + fake replay + ReAct runner`

## Task 12: Agent HTTP API 与并发防护

**Files:**
- Create: `backend/app/modules/agent/routes.py`, `backend/tests/test_agent_api.py`
- Modify: `app/main.py`

**Interfaces:**
- Consumes: T9/T10/T11
- Produces(§12.3 全等):
  - `POST /api/v1/agent/sessions {project_id, model_id?, thinking?, mode?} -> 201 {id,...}`(model_id 缺省取 CHAT 默认;mode 非法 422)
  - `POST /api/v1/agent/sessions/{id}/messages {content} -> 202 {run_id}`:同会话已有 RUNNING/WAIT_APPROVAL run → 409 `{code:"session_busy"}`【Review Focus 5 钉此处】;accepted 后 asyncio.create_task(runner.run_turn)(后台任务,进程内单跑:Redis SETNX `agent.lock.{sid}` 防双实例)
  - `POST /api/v1/agent/sessions/{id}/interrupt {run_id}` → asyncio task cancel,run=CANCELLED,落 ERROR 事件(payload.reason=interrupted)
  - `GET /api/v1/agent/sessions/{id}/messages?cursor= -> Page(envelopes)`(历史重放)
  - `GET /api/v1/events/agent/{sessionId}?cursor=`(T9 sse_response 接线)
  - 工具可见性端到端:READONLY 用户会话中模型声明里**没有**写工具(经 FakeGateway 捕获 tools 入参断言)【§9.4 不可见】。
- [ ] **Step 1: 写失败测试**:上列 5 条 + busy 409【RF5】+ 不可见断言;SSE 拉流收到 USER/THINKING...全序列。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: agent REST/SSE API with busy guard and visibility filter`
## Task 13: 模型配置管理(key 加密 + 打码 + 连通性测试)

**Files:**
- Create: `backend/app/modules/model_cfg/schemas.py`, `backend/app/modules/model_cfg/services.py`, `backend/tests/test_model_cfg.py`

**Interfaces:**
- Consumes: T5/T11
- Produces:@service:`model_cfg_create`(model:cfg:create,write)、`model_cfg_list`(model:cfg:read,api_key 恒回显打码串)、`model_cfg_update`、`model_cfg_delete`(DESTRUCTIVE)、`model_cfg_probe`(read;OpenAI 兼容 GET /models 计延迟);api_key Fernet 加解密 helper `enc_key/dec_key` 落 `core/security.py`。

- [ ] **Step 1: 写失败测试**:创建→list 打码;probe 对 fake:// 模型返回 ok;update 空 api_key 不覆盖旧值;无 model:cfg:create 权限 → 403。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat: model config CRUD with encryption and probe`

## Task 14: 前端脚手架(登录 + 项目 + 生成客户端)

**Files:**
- Create: `web/package.json` 等 Vite 脚手架, `web/src/app.tsx`, `web/src/theme.ts`(§11.6 Token 全套:primary-500/600、text/bg/border、S1 阴影、4px 网格、14px 基准), `web/src/api/client.ts`(openapi-typescript 生成 + fetch 封装:token 注入、401 统一登出、错误信封 toast), `web/src/pages/login.tsx`, `web/src/pages/workbench.tsx`(项目列表/切换/新建), `web/scripts/gen-api.mjs`, `web/e2e/auth.spec.mjs`

**Interfaces:**
- Consumes: 后端 /api/v1/openapi.json
- Produces: `useAuth()`(token/user/当前项目;localStorage+Zustand)、`ProjectSwitcher`;路由 /login、/、/bench(占位)。

- [ ] **Step 1: 写失败 Playwright 测试**(auth.spec:登录→见项目页→建项目→切换后刷新仍保持)
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(TopBar 56/侧栏 208,§11.7;pnpm build 过)→ **Step 4: Playwright 通过** → **Step 5: Commit** `feat(web): scaffold with theme, auth, projects`

## Task 15: Pilot 试验台页(§11.3 事件流最小子集)

**Files:**
- Create: `web/src/pages/bench.tsx`, `web/src/agent/sse.ts`, `web/src/agent/EventCard.tsx`, `web/e2e/bench.spec.mjs`

**Interfaces:**
- Consumes: T12 全部接口;T14 useAuth/client
- Produces:会话创建/消息发送(202→SSE 拉流);卡型子集=USER/THINKING(灰斜体折叠 2 行)/TEXT(Markdown)/TOOL_CALL·TOOL_RESULT(读蓝写橙,展开 JSON)/USAGE(状态条)/ERROR(红条含继续重试占位);输入区=模式·思考·模型三选择器(§11.4.30 简化)+ 发送/停止(A/B 两态,§11.4.32)。侧栏/钉住/会话列表=1F 起。

- [ ] **Step 1: 写失败 Playwright 测试**(后端以 fake:// 模型起:发消息→事件卡按序出现→TOOL_RESULT 可展开→USAGE 出现)
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: Commit** `feat(web): pilot bench with streaming event cards`

## Task 16: 金线 E2E、demo 种子与收尾

**Files:**
- Create: `backend/scripts/target_app.py`(靶场 mock :9999,/login 返 token,/order 返固定 JSON;1A 复用), `backend/scripts/seed_demo.py`(demo 项目+环境 base_url 指靶场+3 个 api_definition+fake 会话脚本), `backend/tests/test_golden_path.py`, `docs/superpowers/plans/README-s0-demo.md`(业主演示手册)
- Modify: `.github/workflows/ci.yml`(全量:pytest(连 CI 自带 mysql/redis 服务)+import-linter+web build+web e2e), `.importlinter`(modules.* 互不 import,仅 core/shared 可被引)

**Interfaces:** Consumes: 前述全部;Produces: git tag `s0-golden-slice`。

- [ ] **Step 1: 写失败集成测试** test_golden_path(真连本机 MySQL/Redis,fake:// 模型):bootstrap→登录→建项目→建环境→HTTP 建 api_definition→同 token 开 Pilot 会话发消息→FakeGateway 脚本调 api_definition_create→断言:库里+1、SSE 全序列、audit_log 含 http 与 agent 两入口、READONLY 用户同问句的 tools 声明无写工具【§9.4】。
- [ ] **Step 2: 确认失败** → **Step 3: 实现脚本/靶场/CI 收口/手册**(手册含「本机起 MySQL/Redis → alembic → seed → uvicorn → 浏览器演示」,以及手工在设置页填 9000 网关 key 后用真实模型复跑一节的说明)
- [ ] **Step 4: CI 全绿;本地按手册完整走一遍**
- [ ] **Step 5: Commit + tag**

---

## 完成判据(= §13 S0 定义逐条)

1. `@service` 一处标注 ⇒ HTTP 路由/OpenAPI/工具 schema/权限位/审计五路同生 → T5/T6/T7/T8 测试证明。
2. 登录+项目+环境 CRUD → T3/T4/T7。
3. 假模型回放驱动 ReAct、事件逐步落库+SSE 可回放、ASK 到挂起为止 → T9~T12。
4. 业主手动演示路径 30 分钟内走通 → T16 手册。

**不在本计划**(1A 起):执行引擎/Celery 任务/UI/ADB/报告/回收站/导入/Qdrant RAG。S0 结束后基于实测重写《1A 实施计划》。



