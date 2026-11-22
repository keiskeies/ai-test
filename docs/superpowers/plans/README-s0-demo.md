# S0 金线演示手册（业主版 · 目标 30 分钟）

> 目标：从零把平台跑起来，亲眼看一遍「一个 @service 注解五路同生」与「Pilot 假模型回放驱动 ReAct」。
> 全程离线可演示（假模型无需任何 API Key）。

## 0. 前置

- MySQL 8.x 与 Redis 7.x：**用本机启动的实例**（2026-11-19 业主口径修订，**不再要求 Docker、不再默认远端 db.internal.test**）。MySQL = 本机服务 `MySQL84`（127.0.0.1:3306）；Redis = `C:\Program Files\Redis`，起法与「服务报成功但没监听」的坑见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4.1。仓库根 `docker-compose.yml` 只用于生产/Linux，演示与测试都不需要它。
- Python 3.12（backend/.venv 已就绪）、Node 22 + pnpm 10（web/）。
- 所有后端命令均在 `backend/` 目录执行；Windows 用 `.venv\Scripts\python.exe`（相对 `backend/`，
  不是 `backend\.venv\…`——那条是仓库根写法，站在 `backend/` 里会报「找不到路径」。本轮第九道差集实测：
  `cd backend && ls backend/.venv/Scripts/python.exe` ⇒ 不存在，`ls ../backend/.venv/…` 才存在）。

环境变量（PowerShell 示例；Linux 用 export）：

```powershell
$env:TP_DB_URL       = "mysql+asyncmy://root:<密码>@127.0.0.1:3306/testpilot?charset=utf8mb4"
$env:TP_REDIS_URL    = "redis://:<你的口令>@127.0.0.1:6379/6"
$env:TP_SECRET_KEY   = "dev-secret-key-0123456789abcdef0123456789"
$env:TP_BOOTSTRAP_ACCOUNT  = "admin"
$env:TP_BOOTSTRAP_PASSWORD = ""   # 留空 = 首次启动随机生成并打印一次（下面 §4 会读到它）
```

## 1. 起基础设施与数据库（约 2 分钟）

```powershell
cd backend
..\backend\.venv\Scripts\python.exe -m alembic upgrade head   # 建表（幂等）
```

## 2. 起靶场（演示用"被测系统"，约 1 分钟）

```powershell
# 另开一个终端，cwd 仍是 backend/（§0 的口径）
.venv\Scripts\python.exe scripts/target_app.py
```

- 靶场 = 迷你商城 API，演示只用其中两个：`POST /login`（demo/demo123 → token）、
  `GET /order/{id}`（需 Bearer，固定 JSON）。
- 自检：浏览器打开 http://127.0.0.1:9999/docs。**页面上是十个接口，不是两个**——除演示那两个，
  还有 `/healthz`、`/slow`、`/flaky`（GET+DELETE）与 `/ui/login`（GET+POST）、`/ui/frame`、`/ui/home`
  四条 UI 夹具路由（`backend/scripts/target_app.py` 的 `@app.*` 实测 10 处）。
  拿「两个」当自检标准会在自检这一步就误判「靶场起错了」。

## 3. 灌演示数据（约 1 分钟）

```powershell
.venv\Scripts\python.exe scripts/seed_demo.py
```

- 幂等脚本：创建/补齐 **项目「演示商城」→ 环境「本地靶场」(base_url 指 :9999) → 3 个接口定义 → 出厂假模型「演示假模型（离线回放）」**。
- 首次运行会打印 admin 初始密码——**但只在 `TP_BOOTSTRAP_PASSWORD` 留空时**：
  留空才随机生成、随机才打印（`iam/bootstrap.py` 的 `if not pw: pw = generated = "Tp@"+…`，
  打印点在 `seed_demo.py` 与 `app/main.py` 各一处，都读同一个 `printed_password`）。
  §0 的 env 块把它留空 ⇒ 按本手册照敲**会打印一次随机密码**，记下那行输出用于下面登录。
  另外它还会建两个演示成员并打印密码（`demo_ro` / `demo_pm`），§5.4 第 4 步直接用它们。

## 4. 起平台（约 1 分钟）

```powershell
# 后端（cwd=backend）
.venv\Scripts\python.exe -m uvicorn app.server:app --port 8320   # 8000 见 §6 端口条
# 前端（另开终端，cwd=仓库根；在 backend/ 里 `cd web` 是找不到的——web 与 backend 同级）
cd web; pnpm install; pnpm build; $env:TP_BACKEND="http://127.0.0.1:8320"; npx vite preview --port 5173
```

- 后端自检：http://127.0.0.1:8320/api/docs 能看到全部路由（金线：**路由=注册表投影**，与 Agent 工具同一来源）。
- 前端：http://127.0.0.1:5173 → 用 `admin` / 上面打印出的那条初始密码登录。

## 5. 演示路径（约 15 分钟）

### 5.1 项目与环境（判据 2）

1. 工作台可见「演示商城」→ 点击进入（顶栏出现当前项目）。
2. 演示点：环境数据来自靶场配置；接口列表里有 seed 的 3 个接口（登录/查询订单/1 号单）。

### 5.2 一个注解五路同生（判据 1）

1. 打开 http://127.0.0.1:8320/api/v1/openapi.json —— 搜索 `api_definition_create`：HTTP 路由 + OpenAPI schema 都在。
2. 进 Pilot 试验台（左侧 ✦Pilot），选中项目后点「开始新会话」——
   **这一页没有「工具清单卡」**：注册表在这条链路上的可见证据是会话事件流的工具卡配色与标签
   （只读=蓝 / 写入·破坏性=橙，数据源是 GET /agent/tools 的效果表投影）。
   要核对「Agent 到底有哪些工具、各自什么权限属性」，用接口：GET /api/v1/agent/tools
   （名称/描述/effect/权限位都在响应里）。**同一个 @service 声明，同时是 HTTP 路由、OpenAPI、Agent 工具、权限位、审计动作**——
   前两项在第 1 步的 openapi.json 里当场可查。

### 5.3 Pilot 假模型回放（判据 3 前半）

1. 模式选「全自动（FULL）」、模型选「演示假模型（离线回放）」。
2. 发送：**帮我建一个查询订单接口**。
3. 逐步看事件卡：思考（灰斜体）→ 工具调用 env_list（蓝=只读）→ 结果 → 工具调用 api_definition_create（橙=写入）→ 结果可展开 JSON → 回答（Markdown）→ 用量条（输入 1234 / 输出 456 tokens）→ 状态回到「空闲」。
4. 演示点：**这一步在 seed 过的「演示商城」里必然红**——假模型脚本第二次调用固定要建
   名为「查询订单」的接口（`tests/fixtures/fake_model/basic_two_tools.jsonl` 第 5 行），
   而 seed 的 3 个接口里就有同名一条（`scripts/seed_demo.py` 的 `DEMO_APIS`），
   服务面按「同项目同名 = 冲突」回 409「接口名已存在」（`api_test/services.py`）。
   工具异常不炸 run，回注成 `ok=False` 的结果卡（`agent/dispatcher.py` 的
   `except Exception … ToolResult(ok=False, …)`），所以**事件流照样跑到「空闲」、USAGE 照样出**，
   只有那张橙卡的 JSON 里是失败。要演示「Pilot 建出一个新接口」：
   **用 §5.1 的手法新建一个空项目**（或换个名字发），别在 seed 项目里发这句。
   **刷新页面会回到空态**：试验台挂载只拉项目与模型列表、不回放历史事件，本轮事件流不恢复——要留证据看审计（§5.4 第 3 步）。

### 5.4 权限模式与审计（判据 3 后半 + 审计）

1. 「重新开始」→ 模式改「询问（ASK）」→ 再发同一句：写工具出现 **审批卡**，状态「等待审批」。
   审批卡**没有批准按钮**——卡面灰字原文就是「暂不支持在页面上批准（审批门按蓝图 §14 属二期）。
   先点『中断』结束本轮——此刻『重新开始』是灰的，中断后它才可点；要换 FULL 模式，
   也只能走这条两步路另起会话，没有当场切换的入口」（`web/src/agent/EventCard.tsx` 的 APPROVAL_REQ 分支）。
2. 「重新开始」→ 模式「只读（PLAN）」→ 发同一句：写工具被模式门拒绝（结果卡红色「只读（PLAN）模式，写类工具被拒绝」），库里**不会**多出接口。
3. 审计（用 curl 或 MySQL 客户端查 audit_log）：`entry=http` 的手工建单 与 `entry=agent` 的 Pilot 工具调用**同表两入口**，动作/对象/成败/差异一目了然。
4. 加一个只读成员：项目卡 → 系统设置 →「项目与成员」Tab（`shell.tsx` 的 `nav-settings` 条目，
   `settings/MembersTab.tsx`）。seed 已经把两个演示成员挂进「演示商城」了——
   `demo_ro`（READONLY）与 `demo_pm`（PROJECT_ADMIN），密码 seed 跑时打印过（§3）。
   手动加人要两个调用（先建用户、再挂成员）：

```bash
# 1) 造一个平台用户（仅系统管理员；POST /system/users 就是 user_create 服务的 HTTP 投影）
curl -X POST "http://127.0.0.1:8320/api/v1/system/users" \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" \
  -d '{"account": "ro_demo", "name": "演示只读", "password": "Ro@123456"}'
# 2) 加成员并设只读：
curl -X PUT "http://127.0.0.1:8320/api/v1/projects/<pid>/members/<uid>" \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" \
  -d '{"role_code": "READONLY"}'
```

   用该账号进试验台：页面上看不到工具清单；工具可见性的证据在服务端——用该账号的 token 调
   GET /api/v1/agent/tools 只回 `effect=read` 的只读工具（§9.4 可见性过滤，写工具不进清单，模型根本看不到）。

## 6. 真实模型复跑（可选，约 8 分钟）

1. 准备一个 OpenAI 兼容网关（例：本机 :9000 `/v1`），拿到 API Key。
2. 系统设置页**已经有了**（1E T8 起的模型卡片墙，`settings/ModelTab.tsx`），但**新登模型只能走 API**：
   卡片墙只给已登记模型 [连通性测试] / [设为默认] / [编辑]，没有 [新增]（`ModelTab.tsx` 的按钮区就这三个）。
   而且这个 Tab 的门是 `isSysAdmin && model:cfg:read`（`pages/settings.tsx:46`）——**只有系统管理员看得见**。
   所以下面两条 curl 是必经之路，不是「S0 没做页面」的兜底：

```bash
curl -X POST "http://127.0.0.1:8320/api/v1/model-cfgs" \
  -H "Authorization: Bearer <admin_token>" -H "Content-Type: application/json" \
  -d '{"name":"fundgpt","protocol":"OPENAI_COMPAT","base_url":"http://127.0.0.1:9000/v1","model_name":"fundgpt-coder-next","api_key":"<key>","is_default":true}'
# 探测连通性（GET {base_url}/models 回填延迟/能力）：
curl -X POST "http://127.0.0.1:8320/api/v1/model-cfgs/<cfg_id>/probe" -H "Authorization: Bearer <admin_token>"
```

   （**模型配置读接口不是「全员打码可见」**：`GET /model-cfgs` 的门是 `model:cfg:read`，
   而这个请求的 payload 不带 `project_id`，走的是 R30 的平台级基础位
   `perms = {"*"} if is_system_admin else {"auth:*"}`（`core/service.py` 的 `build_ctx`）——
   非系统管理员一律 403，只有 `is_system_admin` 才拿得到打码名单。**删除**更硬，
   `model_cfg_delete` 里还有一道 `if not ctx.is_system_admin` 的先门后查。）
   seed 也可用 env 出厂：TP_MODEL_SEED_BASE_URL / TP_MODEL_SEED_NAME / TP_MODEL_SEED_API_KEY 随启动自动落库。）
3. 回试验台，模型选新配置，重复 5.3。真模型下工具 schema 来自同一注册表 —— 五路同生的直接验证。
   （S0 未做：会话级多轮上下文优化、审批闭环；出现跑偏属预期，属 1A/二期范围。）

## 7. 回归命令（演示前 3 分钟自检）

```powershell
cd backend
.venv\Scripts\python.exe -m pytest -q            # 全量后端
.venv\Scripts\python.exe -m ruff check app scripts tests
.venv\Scripts\lint-imports.exe                   # 架构契约（S0 时 3 条，现批次已加到 4 条，逐字认打印行 `Contracts: 4 kept, 0 broken`）
cd ..\web && pnpm build:e2e && pnpm exec playwright test   # 前端 e2e 档构建 + 浏览器金线
```

> 最后一条**不能用 `pnpm build`**：`probe.html`（Monaco 夹具页）只在 `vite build --mode e2e` 下进包，
> 拿生产产物跑 playwright 会被 `web/e2e/globalSetup.mjs:14-19` 当场抛「请用 pnpm build:e2e……不要用 pnpm build」。
> 这条是本轮第九道差集扫出来的——旧文本写的就是 `pnpm build`，照着敲一定红，而红的样子像编辑器坏了。

## 常见问题

- **端口绑不上（winerror 10013）**：Windows/Hyper-V 常把 7999-8098 整段保留，8000 就在里面。
  用 `netsh int ipv4 show excludedportrange protocol=tcp` 查保留段，本项目统一改用 **8320**；
  换端口后必须同步前端代理目标 `$env:TP_BACKEND="http://127.0.0.1:8320"`，否则页面能开但 /api 全挂。
- **登录 401**：清 localStorage（F12 → Application → Local Storage）重登。
  access token 有效期是 **2 小时**（`core/config.py` 的 `jwt_ttl_hours: int = 2`，
  `core/security.py` 直接用它算 `exp`；`backend/.env` 没有覆盖这一项），不是过去写的 12h。
  演示动辄一下午，中途掉登录是设计内的，别当成服务挂了。
- **试验台无模型可选**：模型配置表为空 ⇒ 跑一次 seed_demo.py 或按 §6 建一个；非成员账号看不到试验台项目属正常（需项目成员）。
- **假模型没反应**：确认跑的是 seed 的「演示假模型」（base_url=fake://…），且 `tests/fixtures/fake_model/*.jsonl` 在仓库内（随代码分发）。

