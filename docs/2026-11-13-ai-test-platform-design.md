# 测试平台 "TestPilot" 设计文档

- 日期:2026-11-13(定稿中,评审问题见 §16)
- 状态:待业主批准
- 代号:平台暂定名 **TestPilot**,内置 AI 助手暂定名 **Pilot**(名字可整体替换,不影响任何设计)

---

## 0. 阅读指南

本文是"蓝图 + 分期"文档:数据模型、接口、权限位按 MeterSphere 功能全集的**蓝图**设计(业主决策 C),但实施分三期,每期边界与验收标准写死在 §13。未列入当期交付的模块,文中以 **[三期]** 标注;当期实现必须按 §4 的表结构预留字段,避免日后迁移。**【2026-11-19 补充:对标对象现在有本机源码可查】**MeterSphere 全量源码(带 git 版本,可切 tag 对照)已 clone 到 `D:\item\metersphere`(分支 `v3.x`,187 个 tag,GPLv3 **只读参考、不得复制代码**);本文所有「对标 MeterSphere / 参考 MS v3」的条款(§11.4 草图走查、§11.5 页面级设计、§10 权限位、§4 表结构)拿不准时**以该源码为准做二次取证**——权限位全集看 `PermissionConstants.java`、表结构看 `migration/3.0.0/ddl/*.sql`、页面与文案看 `frontend/src/views/**` + `frontend/src/locale/zh-CN/**`;位置/版本/结构地图/版本切换/无 Docker 直跑法见 `docs/2026-11-19-metersphere-source-and-local-testing.md`。

---

## 1. 背景与意图

### 1.1 要做什么、给谁用、为什么

团队需要一个自研 Web 测试平台,功能对标 MeterSphere(API 测试 / UI 测试 / ADB 安卓测试三类测试资产的完整管理 + 可视化场景编排 + 项目/人员/数据权限),并且**原生内置一个 Claude Code 风格的 AI Agent**:它能以 ReAct 多轮多步方式逐步执行(思考/文本/执行→询问 的流式呈现),把平台所有基础功能 service 当作工具调用,支持 MCP/Skills/斜杠命令,最终能理解"帮我创建一个 XX 测试"这种模糊意图,扫描项目下全部 API/UI/ADB 资产,组装出候选测试场景供用户抉择、修改、落库。

用户:公司内部测试团队(数十人内),自托管部署,非多租户 SaaS。

**为什么自研而不改 MeterSphere 开源版**(业主方向性认同,此处记录):MS v3 为 GPLv3 且为 Java 技术栈;深度嵌入 Agent(全 service 工具化、抽屉式交互、逐步事件流)对 MS 代码库侵入过大;MS 无 ADB 安卓测试模块,而这恰是核心诉求之一。自研可让"Agent 全工具化 + 统一权限"成为一等公民。

### 1.2 目标

1. 三类测试(API/UI/ADB)资产与用例的完整 CRUD、导入导出、版本字段预留。
2. 场景编排:像可视化代码脚本——循环/等待/判断/遍历/提取变量/自定义脚本等流程控件,任意嵌套。
3. 平台所有 service 通过一个装饰器同时成为 HTTP API 与 Agent 工具,权限与数据权限同一代码路径。
4. Agent:ReAct 循环、逐步流式事件、三档权限模式、MCP、Skills、/compact /new 等命令、模型全自定义(上下文长度/思考程度/是否支持图片等)。
5. 场景智能组装:按用户意图检索项目资产 → 产出多个候选场景 → 卡片化抉择 → 画布编辑 → 落库。
6. 页面清新自然,整体布局与 MeterSphere 同构;Agent 为右侧抽屉式大浮窗。

### 1.3 非目标

- 不做多租户 SaaS(单租户自托管,组织/工作空间表仅预留)。
- 不做 CI/CD 平台(提供 webhook 触发与回调,不接管流水线)。
- 一期不做性能测试、Mock 服务、功能用例评审、缺陷管理([三期]蓝图预留)。
- Agent 不做平台外联网操作(不浏览网页、不执行宿主机任意命令——除受控脚本步骤)。

### 1.4 反目标(做成了也算失败的情形)

- Agent 只是"能聊天"却不能真正操作平台 → 失败。
- 场景画布沦为"只能看不能改"的摆设 → 失败。
- 权限模型只管页面菜单、管不住 Agent 工具调用 → 失败。
- 一期贪多把每个模块都做浅 → 失败(蓝图分期就是为此)。

### 1.5 成功判据

- 新人 30 分钟内走通:建项目 → 导入 20 接口 → 建混合场景(API+等待+判断+ADB)→ 执行 → 看报告。
- 对 Agent 说"创建一个登录功能的回归测试",3 轮对话内给出 ≥2 个基于项目真实资产的候选场景,选定后可直接进画布编辑并保存。
- Agent 每一步(思考/文本/工具调用/询问)在 UI 上逐步可见、可回放、可中断。

---

## 2. 已锁定决策(对话记录)

| # | 决策 | 内容 | 来源 |
|---|------|------|------|
| D1 | 功能范围 | 蓝图分期:文档全量蓝图,实施三期,一期核心、二期 Agent、三期长尾 | 业主 |
| D2 | ADB 接入 | 平台服务器直连,**仅 WiFi 无线调试**(USB 不作产品承诺,DeviceService 内部保留能力),不做独立执行节点;代码收敛在 DeviceService 薄接口后可扩展 | 业主 |
| D3 | 技术栈 | 后端 Python 3.12 + FastAPI;前端 React + TypeScript(桌面版预案见 §11.8,Agent 永远在后端) | 业主 |
| D4 | 模型接入 | 服务器可出外网;模型高度自定义:协议/base_url/key/上下文长度/最大输出/思考支持及档位/是否支持图片/工具能力/温度等全配置 | 业主 |
| D5 | 整体架构 | 模块化单体 + 异步 Worker(测试执行走 Worker,Agent 交互在 Web 进程内),不用独立 Agent 服务与微服务 | 业主 |
| D6 | 其余选型 | §5 所列全部为我的决定,业主可逐项否决 | 我(授权) |
| D7 | 实施人力 | **业主一人 + AI 协作**完成全部开发(业主熟 Playwright);实施计划按单人节奏重排(§13) | 业主 |
| D8 | 存储栈 | 数据库 **MySQL 8**(替代 PostgreSQL);新增 **Qdrant** 向量库启用资产语义检索(RAG);向量(embedding)模型纳入模型配置中心(§4.8/§9.10) | 业主 |

---

## 3. 总体架构

### 3.1 架构图

```
                 浏览器 / Tauri 桌面壳(同一套 React 前端)
                        | HTTPS  REST + SSE
        +---------------v--------------------------------+
        |            Web 进程 (Uvicorn/FastAPI)           |
        |  - 模块 API 层(项目/权限/API/UI/ADB/场景/报告/设置)|
        |  - Service 层(全部业务逻辑;@service 装饰 -> 同时   |
        |    产出 OpenAPI schema 与 Agent 工具 schema,      |
        |    同一代码路径鉴权)                              |
        |  - Agent 引擎(ReAct 循环、工具分发器、审批门、      |
        |    上下文压缩、MCP 客户端管理、Skills 加载)         |
        |    ——交互态在 Web 进程 asyncio task               |
        |  - 事件总线(Redis pub/sub)-> SSE 推流            |
        |    (执行进度 & Agent 事件)                       |
        |  - 静态资源托管(前端构建产物)                     |
        +-------+--------------------------+-------------+
                | 任务入队                   | 发布/订阅事件
        +-------v--------+          +------v-------+
        | Celery Worker  |          | MySQL/Qdrant |
        | 场景执行引擎     |          |  Redis       |
        | (api/ui/adb)   |          +--------------+
        | Celery Beat    |-- adb CLI ----------> WiFi 安卓设备群(D2)
        | (定时调度)      |-- playwright -----> Chromium
        | 制品存储 data/artifacts/
        + [三期] JMeter 子进程池
```

**Agent 为什么在 Web 进程**:Agent 回合是"交互式流"(边生成边推、随时可被用户中断/审批打断),状态活在会话里;测试执行是"批式长任务"(分钟级、可排队可重试)。前者 asyncio 任务在 Web 进程,后者 Celery Worker。审批等待期间 Agent 会话挂起落库,不占进程资源(§9.4)。

### 3.2 模块划分(代码结构)

```
backend/
  app/
    core/            # 配置、安全、数据库、事件总线、错误规范
    modules/
      iam/           # 用户、角色、权限位、项目、(预留:工作空间/组织)
      env/           # 环境、全局公共配置(公共请求头/变量/断言)
      api_test/      # API 模块树、接口定义、接口用例、数据集、导入导出
      ui_test/       # UI 元素库、UI 用例(步骤序列)
      adb_test/      # 设备管理(DeviceService 薄接口)、ADB 用例
      scenario/      # 场景(统一承载三类)、步骤树、草稿
      execution/     # 执行引擎(step handlers)、运行记录、制品
      report/        # 报告查询、趋势统计、工作台聚合
      schedule/      # 定时任务、通知渠道
      model_cfg/     # 模型配置中心、能力探测、连通性测试
      agent/         # ReAct 引擎、工具注册表、审批、会话、MCP、skills、命令
      audit/         # 审计日志
    shared/          # 断言引擎、脚本沙箱、变量模板解析、公共 JSON Schema
  worker/            # Celery app:执行任务、beat 调度、adb 心跳、设备锁
web/                 # React+TS(见 §11)
docs/                # 本目录
```

模块间只准通过 service 函数或事件总线互相调用,禁止跨模块 import 内部实现——这是二期后若需拆分的唯一保险,用 lint 规则强制。

### 3.3 部署形态

- **生产推荐(Linux)**:docker-compose 栈:nginx、api、worker、mysql8、redis、qdrant。worker 容器仅需 host 网络(或同网段 bridge)+ 宿主 adb 二进制——WiFi ADB(D2)无设备挂载
- **开发(Windows)**:venv 直跑 uvicorn + celery worker;本机 adb、本机 Chromium;**数据库用本机启动的 MySQL 8 实例(与生产同版本,禁用 SQLite)**,Redis 同样本机直起,qdrant 同形态(可选,RAG 关时不起)。开发环境**不要求 Docker**,各种测试一律连本机实例(2026-11-19 业主口径修订,详见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4)。
- 单实例起步;api 进程可无状态水平扩(SSE 依赖 Redis pub/sub 广播,任意实例都能推)。

### 3.4 横切能力

1. **认证**:JWT access(2h)+ refresh(7d,HttpOnly Cookie);密码 bcrypt;预留 LDAP/OAuth SSO 接口位 [三期]。
2. **鉴权**:所有 API 与 Agent 工具共享"权限位字符串"(如 api:def:create);FastAPI 依赖与 Agent 审批门读取同一份注册表。
3. **事件总线**:Redis pub/sub;主题 run.{runId}(执行进度)与 agent.{sessionId}(Agent 事件);SSE 端点桥接。
4. **审计**:全写操作 + 全部 Agent 工具调用落 audit_log(谁/何时/入口 web|agent/动作/对象/结果)。
5. **制品**:截图/录屏/HAR/响应体快照 → data/artifacts/{run_id}/,DB 存相对路径。
6. **时间与语言**:时刻一律 UTC 存储,展示层 Asia/Shanghai;一期 UI 仅中文(i18n 结构不预留,避免空转)。

---

## 4. 数据模型(全量蓝图)

约定:所有业务表含 id(UUID)、project_id、created_at/updated_at/deleted_at(软删)、created_by/updated_by。以下仅列业务字段;类型从略(以 UUID/JSON/text/bool/int 为主)。

### 4.1 组织与权限(iam)

| 表 | 关键字段 | 说明 |
|----|---------|------|
| org | name, code | [三期] 启用,一期仅建表 |
| workspace | org_id, name | [三期] 启用,一期仅建表 |
| project | name, description, status | 一期核心容器;[三期]补 workspace_id 并回填 |
| app_user | username, password_hash, display_name, email, status, prefs(JSON:默认模型/主题/抽屉偏好) | 系统级用户 |
| role | scope(SYSTEM/PROJECT), name, perm_points(JSON) | 内置模板:系统管理员;项目管理员/测试负责人/测试工程师/只读 |
| project_member | project_id, user_id, role_id | 数据权限主载体 |
| perm_point | key, name, group | 注册表:权限位全集启动时由代码同步入库 |

**数据权限模型(一期)**:资源可见性 = 项目成员制;私有资源(project_public=false,仅 owner 与项目管理员可见)载体:接口/用例/场景/UI/ADB 资产均带 owner_id + project_public(默认 true)。[三期]扩展:工作空间层、自定义角色数据范围。

### 4.2 环境与全局配置(env)

| 表 | 关键字段 |
|----|---------|
| environment | project_id, name, config(JSON: 变量表、全局请求头、Host 映射、数据库连接([预留]SQL 步骤为三期候选,一期不实现不消费)、超时) |
| global_config | project_id, scope_type(HEADER/VAR/ASSERT/EXTRACT), items(JSON) |

变量引用语法:`${var}`(平台自解,渲染顺序:步骤变量 > 用例变量 > 环境 > 全局)。

### 4.3 API 测试(api_test)

| 表 | 关键字段 | 说明 |
|----|---------|------|
| api_module | project_id, parent_id, name, sort | 模块树(收藏/排序) |
| api_definition | module_id, name, method, path, protocol(HTTP/DUBBO[三期]), status, version, request(JSON), response(JSON: 示例+schema), tags | request 结构见 §7.1 |
| api_case | definition_id, name, priority, request(JSON 覆盖), assertions(JSON), dataset_id, sort | 一个接口 N 用例 |
| data_set | project_id, name, rows(JSON: 参数化数据表) | 数据集驱动 |
| api_import_record | source_type(OPENAPI3/SWAGGER2/POSTMAN/MS[三期]), payload_ref, result(JSON) | 导入批次 |

### 4.4 UI 测试(ui_test)

| 表 | 关键字段 |
|----|---------|
| ui_module | 同 api_module |
| ui_element | module_id, name, locator_type(ID/CSS/XPATH/TEXT/NAME), locator, comment | 元素库,跨用例复用 |
| ui_case | module_id, name, priority, steps(JSON: 命令序列,结构见 §7.2) |

### 4.5 ADB 测试(adb_test)

| 表 | 关键字段 |
|----|---------|
| adb_device | project_id, name, serial, connect_type(WIFI;USB 枚举预留), wifi_addr, enabled, last_state(JSON: 机型/电量/在线) | 服务器直连(D2) |
| adb_module | 同 api_module |
| adb_case | module_id, name, priority, steps(JSON,结构见 §7.3), default_device(指定设备或"空闲即可") |

### 4.6 场景与执行(scenario / execution)

| 表 | 关键字段 | 说明 |
|----|---------|------|
| scenario | project_id, module_id, name, status, priority, step_graph(JSON: 步骤树,§7.4), variables(JSON), enable_schedule_ref | 统一承载 API/UI/ADB/混合 |
| scenario_draft | scenario_id(可空), origin(user/agent), session_id, graph(JSON), base_version | Agent 产出的候选/草稿;转正即写 scenario;**建表启用在二期**(一期卡片自包含,§13) |
| run_record | scenario_id 或 subject_type/subject_id, trigger(web/schedule/agent/api_hook), env_id, status, started/finished, stats(JSON), summary_graph(JSON: 带每步结果快照) | 报告主体 |
| run_step_result | run_id, step_key, status, attempts, detail(JSON: 请求/响应/截图 ref/日志/断言明细), parent_step_key | 支持步骤级重跑 |
| run_artifact | run_id, kind(SCREENSHOT/VIDEO/HAR/LOG), ref | 存 data/artifacts 相对路径 |
| schedule_task | subject_type/subject_id, cron, env_id, enabled, notify_channel_ids, last_run | Celery Beat 读表 |
| notify_channel | type(WEBHOOK/DINGTALK/WECOM/FEISHU/EMAIL), config(JSON 密文) | |

### 4.7 功能用例库 / 缺陷 / 性能 / Mock([三期]预留表)

test_case(功能用例:标题/前置/步骤/预期/评审状态)、review_request、defect、mock_service/mock_rule、perf_scenario/perf_run(含 jmx_ref、jtl 聚合)——仅建表或先不建,§13 说明;**蓝图保证 scenario/execution 的报告模型对四类执行通用**(subject_type 枚举含 PERF/TEST_CASE_BATCH)。

### 4.8 模型配置(model_cfg)

| 表 | 关键字段 |
|----|---------|
| model_config | name, model_type(CHAT/EMBEDDING), provider_hint, protocol(OPENAI_COMPAT/ANTHROPIC;EMBEDDING 仅 OAI 兼容), base_url, api_key(加密), context_window, max_output, supports_thinking(bool), thinking_levels(JSON: ["low","medium","high"] 或 null), supports_vision, supports_tools, temperature_default, extra_headers(JSON 加密), enabled, is_default(按 model_type 各一默认位), embed_dimensions(EMBEDDING:探测回填), embed_batch_max, probe_result(JSON: 最近连通性/能力探测) |
| model_probe_log | model_id, ok, latency_ms, error, probed_at |

### 4.9 Agent(agent)

| 表 | 关键字段 | 说明 |
|----|---------|------|
| agent_session | user_id, project_id(上下文项目), title(可 LLM 自动摘要), model_id, thinking_level, permission_mode(PLAN/ASK/FULL), status, compacted_from_seq, token_usage(JSON 累计) | |
| agent_message | session_id, seq, turn_no, kind(USER/THINKING/TEXT/TOOL_CALL/TOOL_RESULT/APPROVAL_REQ/APPROVAL_DECISION/COMPACT_NOTE/USAGE/ERROR), content(JSON), model_id, created_at | 事件溯源:重开会话=重放渲染 |
| agent_run | session_id, turn_no, state(RUNNING/WAIT_APPROVAL/DONE/ERROR/CANCELLED), lease_owner(实例), updated_at | 回合状态机落库;审批挂起/进程重启后可恢复 |
| mcp_server | name, transport(stdio/sse/http), command/args/env(加密)/url, enabled, tool_cache(JSON), status | |
| skill | name, dir_ref, frontmatter(JSON: name/description/allowed-tools), enabled, source(builtin/upload[三期]) | 内容在 skills/ 目录,表做索引与开关 |
| agent_approval | run_id, tool_call_id, tool_name, args(JSON), decision(ONCE/SESSION/DENY), decided_by, decided_at | 审计+前端回放 |

### 4.10 审计与杂项

audit_log(actor_id, entry(web/agent/schedule), action(权限位串), target_type/id, before/after_ref, ok, ip, created_at)、kv_setting(系统级键值:默认环境策略、制品保留天数、RAG 开关/向量模型/top_k/相似度阈值等)。

---

## 5. 技术选型(含理由;全部为 D6,可逐项否决)

### 5.1 后端

| 项 | 选型 | 理由(一句话) |
|----|------|--------------|
| 语言/框架 | Python 3.12 / FastAPI + Pydantic v2 | 类型注解自动产 OpenAPI 与工具 schema,装饰器双注册的地基 |
| ORM/迁移 | SQLAlchemy 2.0(async,asyncmy 驱动)+ Alembic | 生态标准,async 与 FastAPI 合拍 |
| 数据库 | MySQL 8.0(业主 D8) | JSON 列承载步骤树/请求体半结构数据;FULLTEXT ngram 中文全文 + 项目域复合索引扛 100 项目 × 2.5 万接口;运维生态最普及 |
| 向量库 | Qdrant(单容器,embedded 磁盘存储,业主 D8) | 资产 RAG 语义检索;与 embedding 模型配置联动,可整体关闭(§9.10) |
| 缓存/队列/广播 | Redis 7 | Celery broker、事件 pub/sub、设备锁、限流四合一 |
| 任务队列 | Celery(Worker)+ 自研 Beat Scheduler 读 schedule_task 表 | 场景执行要依赖编排/重试/取消,capability 最成熟;不引 django-celery-beat |
| API 执行 | httpx(异步客户端)+ 自研断言引擎 | 断言语义要跨 API/UI/ADB 统一,不绑 pytest |
| 脚本沙箱 | restricted exec(白名单 builtins + import 钩子 + 5s 超时 + resource 限额) | 前置/后置脚本;见 §8.5,不引容器(成本/热路径) |
| UI 执行 | Playwright(Python 版) | 官方 asyncio 集成、trace/截图/录像全,不用背 Selenium Grid |
| ADB | adb CLI(subprocess)+ uiautomator2(控件级定位与断言) | CLI 覆盖 90% 操作,u2 补控件树;两者都藏在 DeviceService 后面 |
| 模型 SDK | openai + anthropic 官方 SDK,自研薄适配层 | 两协议统一为内部事件流;不用 LangChain(见 §9.1) |
| MCP | 官方 mcp Python SDK | stdio/SSE/StreamableHTTP 客户端齐全 |
| 导入解析 | openapi-spec-validator、postman schema 自写 | 导入器按来源插件化 |
| 加密 | cryptography.Fernet,主密钥来自 env | 模型 key、渠道配置的落库加密 |

### 5.2 前端

| 项 | 选型 | 理由 |
|----|------|------|
| 框架/构建 | React 18 + TypeScript + Vite | 生态与招聘面;TS 与后端 OpenAPI 生成客户端类型(见 §12.3) |
| 组件库 | Ant Design 5(ConfigProvider 自定义 Token) | 与 MeterSphere 布局同构成本最低;"清新自然"靠主题 Token 定制(§11.6),不引第二套组件库 |
| 流程图/场景画布 | @xyflow/react(React Flow 12)+ elkjs 自动布局 | React 原生、自定义节点自由度高;elkjs 解决循环容器展开后的自动排布 |
| 服务端状态 | TanStack Query;客户端小状态 Zustand | 表格驱动产品的标准解 |
| 代码编辑 | Monaco(请求体/脚本/JSON) | 语言高亮 + 补全开箱即用 |
| 图表 | ECharts 5 | 报表趋势图中文档全 |
| 图标 | Lucide | 线条风格契合清新主题 |
| 实时 | SSE(fetch + ReadableStream,支持 POST 与自定义头) | 单向推流够用,不引 WebSocket 双工复杂度;桌面壳内同样工作 |
| 桌面壳预案 | Tauri 2(WebView 壳,连同一后端) | §11.6;不重写任何 Agent 逻辑 |

### 5.3 质量与工程

pytest + pytest-asyncio(集成测试连**本机启动的** MySQL/Redis 实例,连接串走 `TP_DB_URL`/`TP_REDIS_URL`;2026-11-19 修订:去掉 testcontainers 这条 Docker 硬依赖——它从未进过 `backend/pyproject.toml` 的依赖表,口径与实现自此一致);前端 Vitest + Playwright E2E;CI:GitHub Actions 或公司 Jenkins 均可(ruff + mypy + pytest + build)。

---

## 6. 后端功能设计(逐模块)

所有列表接口:游标分页、关键字/多条件筛选、排序白名单;所有写接口走权限位依赖 + 审计。以下只写**要点**,不复述常规 CRUD。

### 6.1 iam / 项目 / 环境

- 用户管理(系统管理员)、项目 CRUD、项目成员与角色分配;内置角色模板不可删可复制。
- 权限位注册表:模块代码声明 → 启动同步入 perm_point(代码即真相)。
- **首次启动引导**:创建系统管理员(首登强制改密)→ 种入内置 4 角色 → 自动建 **demo 项目**(预置接口/用例/场景,被测靶指向 §14 沙盒靶场)——支撑"新人 30 分钟走通"验据与全部 E2E 数据源。
- 环境复制/导出;环境切换器是执行/调试的全局入口参数。
- [三期] 组织→工作空间→项目三级树,project.workspace_id 回填,菜单/数据范围挂到 workspace。

### 6.2 API 测试

- 接口定义:模块树无限级;单接口多用例;快速"调试"按钮(不落报告的即时执行,走同一执行核)。
- 请求编辑器承载结构见 §7.1;响应支持 JSON Schema 与示例;接口支持关联"单接口断言组"。
- 数据集:CSV 粘贴/表编辑;用例绑定数据集后按行驱动(场景内引用该用例时同样生效,执行引擎统一处理)。
- 导入:OpenAPI 3 / Swagger 2 / Postman v2.1;导入预览(冲突检测:同 path+method 选择覆盖/跳过/新建版本);导入记录可回滚。
- 导出:项目级 zip(资产 JSON + 附件),可跨实例迁移;MeterSphere 格式互导 [三期]。
- 版本:api_definition.version + 变更历史表(全模块通用 version_history 设计,记录整行快照 diff)[二期做 UI,表一期建]。

### 6.3 UI 测试

- 元素库:定位器六类型;同名元素按环境覆盖(不同环境 URL 不同)。
- 用例 = 有序命令序列(§7.2),命令 ~20 种(打开/点击/输入/清除/等待元素/等待文本/断言文本/断言元素/获取文本入变量/截图/执行JS/滚动/按键/上传/下载/切frame/切窗口/处理弹窗/等待时间)。
- 录制器[二期]:浏览器插件不在一期;二期做 Playwright codegen 半自动包装(生成命令草稿)。
- 执行:无头/有头(有头仅 Worker 有桌面环境时可用,默认无头);并发上限 = 信号量(配置项,默认 4);失败自动截图 + DOM 快照 + trace.zip[二期开关]。

### 6.4 ADB 测试

- 设备管理:添加设备(WiFi 地址 ip:port,先 adb connect 验证再入库)、断开/重连、心跳(Beat 每 15s:adb devices + getprop,状态入库);设备卡片:型号/系统/电量/在线/占用中。USB 类型仅表枚举预留,UI 不露出。
- 设备占用锁:Redis 锁,同设备任务串行,跨设备并行;任务队列 FIFO + 场景优先级。
- 用例 = 有序步骤(§7.3)。控件级操作(click_by_text/xpath/assert_text)走 uiautomator2;其余走 adb shell。atx-agent 经 WiFi ADB 部署与端口转发(不需要设备额外网络条件);失败退路 = adb shell uiautomator dump 轮询解析(慢但可用),此为预设降级线。
- 失败自动截屏;支持整案录屏(起止命令包裹)。[三期] scrcpy 实时投屏(web 拉流),一期只做"执行后截图"。
- 文件操作 push/pull 走制品目录,支持"预期文件存在/内容包含"断言。

### 6.5 场景(scenario)

- 场景统一承载 API 步骤/用例、UI 用例、ADB 用例与逻辑控件(循环/等待/判断/遍历集合/提取变量/脚本/HTTP 直连/并发组[二期]),任意嵌套(深度上限 10,防失控)。
- 画布数据 = 步骤树 + 节点间序(§7.4);保存带乐观锁 version(冲突→diff 弹窗);其余资产 last-write-wins + 变更历史表兜底(历史 UI 二期);Agent 草稿走 scenario_draft,用户在画布"另存为正式场景"转正。
- 场景级:公共变量、失败策略(遇错停止/忽略继续)、失败重试(整场景/单步)、执行环境选择、定时任务绑定、webhook 触发端点(/hook/run/{token})。
- 复制/移动/跨项目复制(二期);引用检测(删除被场景引用的用例→警告并列出引用)。

### 6.6 报告与工作台

- 报告中心:按场景/触发方式/执行人/环境/时间筛选;详情 = 步骤树快照,逐步展开请求/响应/断言明细/截图;失败步骤一键"单步重跑"。
- 工作台:我的项目概览(近7天通过率趋势、失败 TOP 场景、待我处理——一期只有"最近执行")。
- 趋势统计 SQL 视图化,不建独立统计库。

### 6.7 定时与通知

- schedule_task → 自研 Celery Beat Scheduler 读表(cron 表达式校验入库前)。
- 通知模板:执行结果摘要(Markdown),渠道:Webhook/钉钉/企微/飞书/SMTP。

### 6.8 模型配置中心

- 模型 CRUD + "能力探测":发探测请求验证连通、是否支持 tools/thinking/vision(按能力位逐项探测),结果回填 probe_result;新会话默认取 is_default。
- **向量模型(type=EMBEDDING)**:与对话模型同表同管理页,独立默认位;保存/启动时探测维度(embed 一条短文本取向量长度回填 embed_dimensions);未配置或 RAG 关闭时检索自动降级纯关键词(§9.10)。
- key 等敏感字段 Fernet 加密,API 回显打码(仅"重置"操作)。

- **出厂种子配置**(业主 D4 补充):默认模型 = OpenAI-compatible 网关 `http://127.0.0.1:9000/v1` 上的 `fundgpt-coder-next`,默认思考档 medium;API key 经 .env 注入或配置页写入,**不落仓库**;后端与网关不同机时改内网地址。首次启动跑能力探测,回填 tools/vision/context_window 能力位。

### 6.9 审计

- 中间件自动记录写操作;Agent 工具调用由分发器记录;查询页(管理员):时间/操作人/入口/权限位过滤。

### 6.10 平台自诊与运维基线(为单人运维设计)

- **健康检查**:/healthz(存活)/readyz(MySQL/Redis/Qdrant 依赖探测);compose healthcheck 联动。
- **管理诊断页**:Celery 队列深度/在线 worker、Redis 内存、MySQL 连接、Qdrant 状态、设备心跳快照、Pilot 活动会话与当日 token 用量、登录失败 TOP——单人运维的一页总览。
- **备份**:夜间 mysqldump + artifacts tar + qdrant snapshot → 异卷存放,保留 7 天;**每季度一次恢复演练(目标 30 分钟复原)**。
- **发布/回滚**:镜像 tag + `alembic upgrade head`(迁移必带 down,§13 纪律 3);回滚=前一镜像+down 迁移;维护窗口用设置页横幅公告。
- **告警**(复用 notify_channel):定时任务连续失败 / worker 离线 / 备份失败 → 通知管理员。

---

## 7. 核心数据结构(JSON 协议)

### 7.1 API 请求对象(request JSON)

```json
{
  "method": "POST",
  "url": "${base_url}/login",
  "params": [["tenant", "a"]],
  "headers": [["Content-Type", "application/json"]],
  "cookies": [],
  "auth": {"type": "none|basic|bearer|apikey", "config": {}},
  "body": {"type": "none|json|form|multipart|raw|graphql",
           "content": "...", "files": [["key", "artifact_ref"]]},
  "timeout_ms": 30000,
  "pre_script": "python 受限脚本(沙箱)",
  "post_script": "",
  "extractors": [{"name": "token", "source": "body_jsonpath", "expr": "$.data.token"}],
  "assertions": [
    {"type": "status", "expect": 200},
    {"type": "jsonpath", "expr": "$.code", "op": "eq", "expect": "0"},
    {"type": "contains", "target": "body", "expect": "success"},
    {"type": "response_time", "op": "lt", "expect": 2000},
    {"type": "script", "code": "assert ctx.status == 200"}
  ]
}
```

### 7.2 UI 命令对象(steps JSON 数组元素)

```json
{"id": "u1", "type": "click", "element_id": "<元素库id>", "inline_locator": null,
 "input": null, "timeout_ms": 10000, "save_var": null, "optional": false}
```

type 枚举:open|click|dblclick|input|clear|select|hover|key|scroll|wait_element|wait_text|sleep|assert_text|assert_element|assert_title|get_text|get_attr|screenshot|js|upload|download|switch_frame|switch_window|dialog_accept。element_id 与 inline_locator 二选一(画布"就地定位"不落库到元素库)。

### 7.3 ADB 步骤对象

```json
{"id": "a1", "type": "click_by_text", "device": "auto|<device_id>",
 "config": {"text": "登录", "timeout_ms": 8000},
 "pre_wait_ms": 0, "optional": false}
```

type 枚举:connect|shell|install|uninstall|start_app|kill_app|click_xy|long_click|swipe|input_text|click_by_text|click_by_xpath|assert_text|assert_element|assert_toast|screenshot|screen_record_start|screen_record_stop|sleep|file_push|file_pull|assert_file|back|home|open_url|extract_ui_text。

### 7.4 场景步骤树(step_graph JSON)

```json
{
  "version": 1,
  "nodes": [
    {"key": "n1", "kind": "api_case", "ref": "<api_case_id>", "name": "登录", "disable": false},
    {"key": "n2", "kind": "loop", "name": "重试直到成功",
     "config": {"mode": "while", "cond": "ctx.vars.get('ok') != '1'", "max_iter": 5},
     "children": [ {"key": "n2.1", "kind": "api_case", "ref": "...", "name": "轮询状态"} ]},
    {"key": "n3", "kind": "if", "config": {"branches": [
        {"cond": "ctx.vars['code'] == '0'", "children": [ ... ]},
        {"cond": "else", "children": [ ... ]}]},
    {"key": "n4", "kind": "foreach", "config": {"list_var": "users", "item_var": "u"}, "children": [...]},
    {"key": "n5", "kind": "sleep", "config": {"ms": 3000}},
    {"key": "n6", "kind": "script", "config": {"code": "..."}},
    {"key": "n7", "kind": "extract", "config": {"rules": [{"var": "uid", "from": "last_response", "expr": "$.id"}]}},
    {"key": "n8", "kind": "adb_case", "ref": "<adb_case_id>", "name": "手机端下单"}
  ],
  "layout": {"n1": {"x": 0, "y": 0}, "n2": {"x": 0, "y": 120}}
}
```

kind 枚举:api_case|ui_case|adb_case|http_direct|sleep|loop|if|foreach|break|continue|script|extract|assert|set_var|group。**执行语义为纯树 + 顺序数组,无 DAG 汇聚边**(画布连线仅是先后可视化);**一期 kind 白名单**= 全集全部,其中 group 一期仅作串行容器;**group 并发执行(.parallel)为二期**。break/continue 出现在 loop/foreach 之外时保存校验报错并在画布标红。layout 仅画布坐标,与执行语义无关。

### 7.5 执行上下文与变量

- ctx.vars:全局(环境/全局配置)→ 场景变量 → 步骤 extract 逐层覆盖;模板 `${var}` 与脚本内 ctx.vars 双通道。
- last_response:最近一次 API/HTTP 直连响应,供 assert/extract 速取。

---

## 8. 执行引擎

### 8.1 调度路径

```
触发(web/定时/Agent/webhook)
  -> execution.enqueue(subject, env, trigger)
  -> Celery 任务 run_scenario(run_id)
     ├─ 加载 step_graph,构建 ExecutionContext(环境渲染、变量初始化)
     ├─ 顺序解释执行步骤树;kind handler 注册表分发
     │    api_case  -> httpx + 断言引擎
     │    ui_case   -> Playwright(信号量限并发)
     │    adb_case  -> DeviceService(设备 Redis 锁)
     │    loop/if/foreach/... -> 递归执行子树
     ├─ 每步开始/结束 → 写 run_step_result + pub/sub run.{runId}
     └─ 终态:汇总 stats、写 run_record、通知渠道 fan-out
```

### 8.2 取消与超时

- 取消:API 置 cancel 标志(Redis key 轮询点=每步边界+长等待切片);Playwright/adb 步骤在下一步边界生效,单步内部有硬超时。
- 全局:场景级 max_runtime(默认 30min);单步超时取步骤配置。

### 8.3 失败策略与重跑

- 场景级 fail_fast(默认 true);步骤 optional=true 失败不阻断。
- 单步重跑:从 run_step_result 重建该步上下文快照(变量快照+last_response),仅重跑该步(调试利器)。

### 8.4 执行进度事件(SSE,前端画布高亮用)

```json
{"type": "step", "run_id": "...", "step_key": "n2.1", "status": "running|pass|fail|skip|error",
 "elapsed_ms": 412, "screenshot_ref": null, "message": null}
{"type": "run_end", "run_id": "...", "status": "fail", "stats": {"total": 12, "pass": 10, "fail": 2}}
```

### 8.5 脚本沙箱(前置/后置/脚本步骤/断言脚本)

- restricted-exec:白名单 builtins(len/str/dict/json/re/math/datetime/random/time/hashlib/base64/urllib.parse/assert 等),禁 import 其余模块、禁 open/exec/eval/dunder 遍历。
- 运行在 Worker 进程内线程 + 超时(5s)+ 输出上限;需要更强隔离的租户场景([三期]评估子进程容器化)。
- 脚本 API:ctx(vars 读写)、log()、http.get/post(受 URL 白名单约束的出网助手)、assert 语句可用。

### 8.6 数据集(参数化)在场景内的语义

- 用例绑定数据集且被场景引用:该步骤按行展开,每行产生子结果 step_key#r{N};报告节点可折叠(显示 pass_rows/total_rows)。
- 统计口径:数据集步骤计 1 步,全行通过才算 pass。
- 失败策略:场景 fail_fast=true 时任一行失败终止整个场景;false 时行失败继续后续行。
- 嵌套:循环内引用数据集用例 = 嵌套乘积,总展开上限 500 次(保存校验拒绝)。
- 画布实时高亮:步骤节点呼吸 + 行进度徽标(如 3/10)。

### 8.7 调度全景(四条泳道,一图讲清所有"谁在跑什么")

```
┌ L1 Web 进程(Uvicorn) ─────┐ ┌ L2 Celery Worker ──────┐ ┌ L3 Beat ──────────┐
│ HTTP REST / SSE / 静态托管    │ │ 场景执行任务 run_*      │ │ 15s adb 设备心跳    │
│ Agent 回合 = asyncio 任务     │ │  api/ui/adb/逻辑 handler│ │ cron tick → 入队    │
│ (交互态,不走 Celery)         │ │  脚本沙箱(§8.5)        │ │ 制品清理(每日)      │
└─────────┬──────────────┘ └────────┬─────────────┘ └──────────┬──────┘
          │        ┌── L4 Redis + MySQL + Qdrant ────┐        │
          └───────►│ celery 队列 | pubsub run.{id} /   │◄───────┘
                   │ agent.{sid} | 设备锁 adb:dev:{id} │
                   │ 取消标志 cancel:{run_id} | 落库事件 seq │
                   └──────────────────────────────────┘

执行链(批式): 触发(页面/定时/Pilot/webhook) → execution.enqueue()
  → PG run_record=QUEUED → 入队 → L2 领取(RUNNING)
  → 每步: 落 run_step_result + pubsub → L1 桥接 SSE → 画布呼吸高亮
  → adb 步骤: SETNX adb:dev:{id}(抢不到=排队,报告页显示位次)→ 执行 → 释放
  → 取消: [取消] → cancel:{run_id} → L2 每步边界检查 → CANCELLED(已开浏览器/录屏正常收尾)
  → 终态: 汇总 stats → 通知 fan-out(钉钉/邮件/webhook 回调)

Agent 链(交互式,全在 L1): POST /messages → agent_run=RUNNING(lease=本实例)
  → LLM 流式 → 事件落库+pubsub agent.{sid} → SSE 推前端
  → 审批等待: WAIT_APPROVAL 落库,asyncio 任务退出(挂起零占用)
  → POST /approval → 由落库上下文重建循环 → 续推
  → 实例重启: 启动扫描 lease 过期 → RUNNING 标"中断可续"(重进会话一键继续);
    WAIT_APPROVAL 原样恢复(审批卡重新可见可操作)
```

### 8.8 执行数据生命周期(量级推演:50 场景/日 × 15 步 × 2KB ≈ 1.5MB/日)

- 一期不分区不分表:run_step_result 按 (run_id) 与 (created_at) 建索引即可,千万行内 MySQL 无压力。
- 单条 detail 超 64KB 的响应体/日志 → 外置制品文件,DB 只存 ref(防大行拖垮备份与查询)。
- 终态 run 超保留期(默认 90 天,kv_setting):步骤明细压缩后转冷表 run_archive,明细删;报告列表与统计永久保留。
- 冷表归档/制品清理/备份为同一夜间任务序列(互斥锁串行,备份先于清理)。

---

## 9. Agent 子系统(核心卖点,全量设计)

### 9.1 总原则:自研 ReAct 循环,不用 Agent 框架

理由:需求⑥要求"每一步(思考/文本/执行→询问)逐步输出"——需要**事件粒度完全可控**的循环;上下文压缩、审批门、能力降级(无 vision/无 tools)全是循环内的私有逻辑,框架反而是阻力。循环本体约几百行 Python,依赖只有模型 SDK 与 mcp SDK。(借鉴 Claude Code 的:系统提示结构、工具描述规范、compaction 策略、斜杠命令。)

### 9.2 工具层(D5 的兑现点)

- **平台工具**:service 方法装饰器
  ```python
  @service(perm="api:def:create", effect="write", name="api_definition_create",
           description="在项目下创建 API 接口定义...")
  async def create_definition(project_id: UUID, module_id: UUID, payload: ApiDefIn) -> ApiDefOut: ...
  ```
  同一装饰器产出:① FastAPI 路由 + OpenAPI schema;② Agent 工具 JSON Schema(Pydantic 推导,docstring 为描述)。工具名稳定 snake_case。注册覆盖率要求:所有模块的查询/创建/更新/删除/执行类 service 100% 标注;仅 UI 展示专用接口可标 tool=False。
- **元工具**(手写,非 service):search_test_assets(kind?,keyword,module?;双路混合:MySQL FULLTEXT(ngram) 关键词路 + Qdrant 向量语义路,RRF 融合,§9.10)、get_project_outline(项目结构树摘要)、search_tools(keyword)、propose_plan(items[])/update_plan_item(id,state)(目标计划列表,§11.4.33)、propose_scenario_plans(plans[]) ——渲染候选场景卡片(§9.7)、ask_user(question,options) ——运行内提问卡片、suggest_open_page(route,params)、read_skill(name)。
- **MCP 工具**:命名 mcp__<server>__<tool>;effect 默认 write(保守),可在 mcp_server 配置逐工具覆写为 read。
- **工具可见性分层(上下文工程)**:注册覆盖率要求不变(100% service 工具化),但运行时分两级——**常驻级**(≤40 个:元工具 + 各类资产 search/get + 会话高频写工具)+ **分组级**(其余按模块分组,经 search_tools(keyword) 发现后当轮载入声明)。目标:常态上下文工具声明 ≤6k token,防止 300+ 声明挤爆窗口、把自动压缩压成常态。
- 工具分发器 = 唯一入口:权限位检查(以**会话所属用户**身份)→ 权限模式门(§9.4)→ 执行 → 结果整形(大响应截断+制品引用;写类结果附 produced[] 登记到侧栏产物 Tab,§11.4.36)→ 审计。

### 9.3 ReAct 循环与会话状态机

```
用户消息 -> turn 开始(agent_run RUNNING)
  loop:
    模型调用(流式) -> 事件:thinking_delta* / text_delta* / tool_call*
    若无 tool_call:发 final text,turn DONE
    若有 tool_call:权限模式门
      PLAN 模式且 effect!=read -> 拒绝并回注"当前只读模式"
      ASK 模式且 effect in (write,destructive) -> 发 APPROVAL_REQ,run 转 WAIT_APPROVAL(落库挂起)
      通过 -> 执行 -> TOOL_RESULT 事件(含 card 类型则前端渲染卡片)
    上下文预算检查 -> 必要时自动 compaction(§9.5)
  直到 final / 用户中断 / 错误
```

- 并行工具调用:同轮多 tool_call 顺序执行(简单可靠);二期视需要放开只读并行。
- 中断:用户"停止"→ asyncio cancel + 当前步落 CANCELLED。
- 恢复:WAIT_APPROVAL/RUNNING 状态在 agent_run;Web 进程重启后由会话级 lease 扫描恢复续推(Redis 锁防双推)。

### 9.4 权限模式(会话级,需求⑤)

| 模式 | 读工具 | 写工具 | 破坏性工具(删除/批量执行) |
|------|--------|--------|------------|
| 查看 PLAN | 允许 | 拒绝(自动回复) | 拒绝 |
| 询问 ASK(默认) | 允许 | 卡片审批 | 卡片审批(红色警示+参数 diff) |
| 完全 FULL | 允许 | 直接执行 | 直接执行 |

- 审批卡片展示:工具名/参数 JSON(高亮变更)/影响面提示;按钮:本次允许/本会话允许/拒绝(可附一句话反馈注入对话)。
- 审批超时 10 分钟 → 视为拒绝,turn 收尾提示"因未获批准而停止"。
- 用户无某权限位 → 该工具对 Agent **不可见**(菜单即权限,从模型侧就看不到,而非调用被拒)。

### 9.5 上下文与命令系统(需求④)

- 上下文预算 = model.context_window - max_output - 安全垫(4k)。用量事件(USAGE)每轮推前端,状态条显示百分比。
- **/compact [聚焦说明]**:保留系统提示 + 工具声明 + 最近 3 轮原文;更早历史交当前模型摘要为 COMPACT_NOTE 摘要消息(可附业主指定的聚焦指令);重放渲染仍显示全部历史(agent_message 表不删,compacted_from_seq 标记生效边界)。
- 自动压缩:预算占用 ≥80% 触发同流程(在 UI 标注"自动")。
- **/new** 新会话(询问是否携带当前会话摘要);**/skills** 列出启用技能与用法;**/model** **/think** **/mode** 会话内切换;/**mcp** 列出 MCP server 及在线状态;**/help**。**/** 触发前端命令面板补全。
- 系统提示组装:平台人格 + 当前项目上下文摘要 + 已启用 skills 的 name/description 清单(正文由 read_skill 渐进加载)+ 平台导航地图(可 suggest_open_page 的 route 清单)。
- **平台人格段可管理**(管理员):DB 版本化;设置页提供编辑/diff/预览(假模型跑一遍组装结果)/恢复默认;项目级可追加一段「项目须知」。

### 9.6 模型适配层(D4 的兑现点)

- 内部统一请求:messages(system 折叠)、tools(JSON Schema)、thinking_level、温度、max_output → 适配器(OpenAI-compat / Anthropic)翻译 + 流式事件归一:thinking_delta / text_delta / tool_call_delta / usage / done。
- 能力降级矩阵:thinking 不支持→忽略档位并提示;vision 不支持→剔除 image parts 并提示"该模型不支持图片";tools 不支持→**该模型禁用于操作类会话**(提示;纯聊天可放宽,提示"无法操作平台")。
- 图片输入:聊天粘贴/截图上传 → 制品存储 → vision 消息 parts。
- 思考程度 UI:关/低/中/高四档,按模型 thinking_levels 渲染可选项。
- **运行基线建议**:操作类会话推荐 ≥64k 上下文 + function calling 的模型;低于基线在会话头部给黄色警示(不禁止)。若长期只有无 tools 能力的模型,需另行立项「文本协议兜底解析层」(未列三期)。

### 9.7 场景智能组装流程(需求⑦,专项设计)

```
"创建一个 xxx 测试"
 1. Agent 调 get_project_outline + search_test_assets(多关键词/模块)
    -> 盘点可用 API/UI/ADB 资产与数据集、环境
 2. 规划:产出 1~3 个候选方案(名称/覆盖意图/步骤大纲/所需环境/风险点)
 3. propose_scenario_plans 工具 -> 前端渲染"候选场景卡片"(每卡:步骤预览
    + "画布预览"按钮[加载 scenario_draft 到画布只读预览] + 选择按钮)
 4. 用户选择/提修改意见 -> Agent 迭代草稿(更新 scenario_draft,版本+1)
 5. 用户点"保存为正式场景" -> 触发 create_scenario(仍过权限模式门)
    -> 跳转画布继续编辑
```

关键设计:**propose_scenario_plans 与 ask_user 是"卡片型工具"**——tool_result 带 ui="card" 标记与结构化 payload,前端渲染为交互卡片,用户操作回写为一条用户消息(自然衔接对话)。这套卡片协议(§12.2)是通用件,后续"审批卡/报告摘要卡/设备状态卡"都走它。

### 9.8 Skills 与 MCP

- Skill = 目录(skills/<name>/SKILL.md + 附件);frontmatter:name/description/allowed-tools(可选,限缩工具集)。系统提示只注入清单,Agent 判定相关时 read_skill 拉全文(渐进披露,省 token)。
- 管理页:启停、从 git 目录同步[builtin 一期]、zip 上传[三期]。
- MCP:stdio(command/args/env)与 sse/http(url);启动策略:会话首次调用懒启动,闲置 15 分钟卸载;tool_cache 存发现结果,失效自动重发现;mcp_server 页面显示在线状态与工具数。
- **治理**:模型/MCP/Skills 配置权仅系统管理员(权限位 model:cfg:manage / mcp:server:manage / skill:manage);一期模型全池共享 + 按用户/会话用量统计,项目级配额 [三期];stdio 型 MCP 本质是「管理员在服务器上执行既定命令」,纳权限位 + 全量审计,默认不做容器隔离——若公司要求安全评审,结论回填 §16-7。

### 9.9 Agent 流程全景图

**(a) 回合状态机(agent_run 生命周期)**

```
用户消息 / 审批回传
      ▼
 ┌→ MODEL_STREAM(流式: thinking* / text* / tool_call*)
 │       │
 │       ├─ 纯文本无工具 → FINAL_TEXT → TURN_DONE
 │       │
 │       └─ tool_call(s,同轮顺序执行) → 权限门(§9.4)
 │             ├ 无权限位 → 工具不存在(模型侧不可见,不会走到这)
 │             ├ PLAN 模式+写操作 → TOOL_RESULT(拒绝:只读模式) ─┐
 │             ├ ASK+写/破坏性 → APPROVAL_REQ → WAIT_APPROVAL  │
 │             │      ├ 批准(本次/本会话)→ TOOL_EXEC           │
 │             │      └ 拒绝/10min 超时 → TOOL_RESULT(已拒绝+用户备注)│
 │             └ FULL / 读操作 / 已允许 → TOOL_EXEC            │
 │                    → TOOL_RESULT(+card?)                  │
 └── 回 MODEL_STREAM ◄────────────────────────────────────┘
      (每轮回查上下文预算 ≥80% → 先自动 /compact 再继续)
用户 [停止] → CANCELLED(当前步收尾落库) | 异常 → ERROR 事件(含继续重试建议)
```

**(b) 事件落库与重放(需求⑥"逐步输出+可回放"的实现机制)**

```
Agent 循环 ─事件(seq=n)→ PG agent_message(append-only,永不改写)
                    └→ Redis pubsub agent.{sid} → SSE → 前端流式渲染
前端直播 = SSE 增量;重开会话 = GET /messages 按 seq 全量重放(同一套卡片组件)
断线续传: 重连带 last_seq → 服务端从 PG 补差集 → 无缝接上(执行进度 SSE 同理)
```

**(c) /compact 上下文压缩**

```
触发: 用户 /compact [聚焦指令] 或 自动(预算≥80%)
 → 冻结 seq≤now;保留段 = 系统提示+工具声明+最近 3 轮原文
 → 更早历史交当前模型摘要(附用户聚焦指令,如有)
 → 摘要落 COMPACT_NOTE 事件;compacted_from_seq 记边界
 → 后续请求组装 = 系统+工具+摘要+最近 3 轮
 UI: 摘要卡(点击看被压缩范围原文——agent_message 不删,重放仍完整)
```

**(d) 场景组装时序(需求⑦)**

```
用户 "创建一个履约回归测试"     Pilot                        平台服务
    │──────────────────────►│ search_test_assets ×N ────────►│ 接口/UI/ADB/数据集/环境
    │                       │◄──────────────── 资产摘要(≤2k tok,含 id)
    │                       │ propose_plan(目标计划,§11.4.33)
    │◄─候选场景卡×2(propose_scenario_plans)─────┐ 卡片 payload 自包含
    │ [画布预览]→只读画布;选B + "加一步短信断言"        │ (一期);二期落 draft
    │──────────────────────►│ update_plan_item + 迭代草稿 → diff 摘要卡
    │ [保存为正式场景]         │ create_scenario(仍过权限门,ASK 则先出审批卡)
    │◄─suggest_open_page(场景画布)→ 跳转+高亮新场景────┘
```


### 9.10 资产检索与 RAG(Qdrant,D8)

**目的**:让 Pilot 与全局搜索理解"履约""登录冒烟"这类语义意图——百项目 × 2.5 万接口规模下,纯关键词匹配同义词/中英混写会漏。

**集合设计**:单集合 `tp_assets`(全局)。point payload:project_id、asset_kind(api_def/api_case/ui_case/adb_case/scenario)、asset_id、module_path、text_digest。查询硬过滤 project_id(数据权限在工具执行层再查一遍,双保险)。向量维度按所选 embedding 模型建集合(维度变更 → 全量重建)。

**索引内容(摘要化,控成本控噪)**:资产名 + 描述 + 接口路径/URL + 关键参数名与响应字段名 + 标签 + 模块路径,拼成 ≤1KB 文本;**不**含完整请求体/脚本正文。

**索引时机**:资产增删改 → 模块事件总线 → 异步 upsert/delete(同资产 500ms 去抖合并);内容 hash 未变跳过 embed;系统设置页 [重建资产索引](全量分批、断点续跑);索引为空/RAG 关闭/无向量模型 → search_test_assets 自动降级纯关键词路(零依赖可跑)。

**查询路径(search_test_assets 内部)**

```
关键词路: MySQL FULLTEXT(ngram, 中文 token=2),无全文环境退化 LIKE+项目索引
向量路:   embed(query) → Qdrant top_k=20(filter: project_id + kind)
融合:     RRF(倒数排名融合) → 取 top 8 → 回 DB 取详情 → 组 ≤2k tok 摘要给模型
阈值:     向量相似度 < 0.30 丢弃(kv_setting 可调;top_k/阈值/开关/向量模型同页配置)
```

**模型与降级**:embedding = model_config 中 model_type=EMBEDDING 的一类(§4.8),独立默认位;未配置向量模型或 RAG 关闭 → 向量路停用,设置页黄条提示,Pilot 不感知差异(工具返回同一结构)。**UI 列表页检索**一期仍走 MySQL 关键词,向量路仅服务 search_test_assets 与 Ctrl+K(避免过早扩大索引写路径)。

**运维体量**:qdrant 单容器(磁盘存储,无集群);2.5 万点 × dim1024 × float32 ≈ 100MB 级,单机绰绰有余;夜间 snapshot 随制品清理任务顺带执行。

### 9.11 Agent 运行护栏

- **回合上限**:单轮 tool_call ≤25 次,超出即收尾"本轮达到上限,等你的指示"(防死循环烧钱)。
- **并发与配额**:单用户 ≤3 个 RUNNING 会话(超出排队);全平台 8;单用户日 token 超阈值(默认 2M,kv_setting)→ 用量黄条 + 诊断页聚合。
- **失败熔断**:同会话同一工具连续 3 次失败 → 注入"必须换方案或问用户"指令;第 5 次自动结束回合。
- **幂等**:TOOL_EXEC 以 tool_call_id 为幂等键——审批重复提交、进程恢复重放都不会双写;写失败不自动重放。
- **挂起 TTL**:WAIT_APPROVAL/中断会话 7 天无人处理 → 自动归档(产物 Tab 仍可点)。

---

## 10. 权限与安全

1. **权限位体系**:三段式 key(模块:资源:动作,如 adb:device:update);内置角色模板(§4.1);前端菜单/按钮按权限位渲染,后端逐接口依赖校验,Agent 工具同一注册表(§9.2/9.4)。
2. **数据权限**:一期=项目成员制 + 私有资源(owner 可见);所有列表 SQL 强制 project_id 过滤(基类查询封装,漏写=测试红)。
3. **密钥安全**:模型 api_key/渠道配置 Fernet 加密,主密钥只存 env;回显一律打码;审计不落密钥字段。
4. **Agent 边界**:Agent 永远以会话用户身份执行(无超级身份);无权限的工具对模型不可见;FULL 模式也仅限平台内工具(无宿主 shell、无任意 URL 出网——脚本沙箱 http 助手受 URL 白名单约束)。
5. **注入与执行**:SQL 全 ORM 参数化;前端 React 默认转义 + Markdown 渲染白名单沙化(Agent 回复富文本);脚本沙箱 §8.5。
6. **Webhook 触发**:run-hook 用一次性 token,可吊销、限次、可绑环境。
7. 速率限制(登录、执行触发)、制品保留天数(kv_setting,默认 90 天清理任务)。

---

## 11. 前端设计

### 11.1 信息架构(导航)

顶部全局栏:Logo | 工作空间[三期,先隐] | 项目切换器 | 全局搜索(接口/场景/用例,⌘K) | 帮助 | 用户菜单。
左侧模块树(项目内,对标 MeterSphere 二级导航):

```
工作台
API 测试      ├ 接口管理  ├ 场景编排  ├ 数据集
UI 测试       ├ 元素库    ├ UI 用例
ADB 测试      ├ 设备管理  ├ ADB 用例
测试计划[三期]
任务中心      ├ 报告中心  ├ 定时任务  ├ 失败重试队列(并入报告)
系统设置(管理员)├ 项目与成员 ├ 用户与角色 ├ 模型配置 ├ MCP 服务 ├ Skills ├ 通知渠道 ├ 审计日志
```

### 11.2 全局框架 + Agent 抽屉

```
+------------------------------------------------------------------+----+
| TopBar:  TestPilot | [项目: 交易中心 v]   [搜索...]        [?] [陈] |    |
+--------+-----------------------------------------------+---------+    |
| 侧栏    |  内容区(面包屑 + 页面)                        |  (页面) |    |
| 工作台  |  +------------------------------------------+ |         |    |
| API测试 |  | 列表/画布/表单 ...                         | |         |    |
| UI测试  |  |                                          | |         |    |
| ADB测试 |  +------------------------------------------+ |         |    |
| 任务中心 |                                               |         |    |
| 系统设置 |                                    (  )  <- 机器人悬浮球 +----+ 收起态
+--------+-----------------------------------------------+---------+
   收起 208px 可折叠                      Agent 抽屉(右滑出,默认 55vw,可全屏):
```

### 11.3 Agent 抽屉(需求⑥⑧的核心界面)

**分区地图**(①~⑨ 为全文档统一编号,后续小节按此引用):

| 区 | 名称 | 尺寸 | 职责与规格 |
|---|------|------|-----------|
| ① | 头部栏 | 56 | Pilot 标识 · 会话名(可改) · 模型/思考/模式三选择器 · 窗口操作 →§11.4.30 |
| ② | 会话列表列 | 224(收40) | 新建/搜索/历史/归档;当前会话高亮;后台会话新事件蓝点 |
| ③ | 计划进度条 | 28 sticky | 轻量一行"计划 3/6 ▓▓▓▸",点击展开⑥的✅Tab →§11.4.33 |
| ④ | 消息流 | flex ≥560 | 事件卡片流,11 种卡型 →§11.4.31;上滚出"回到底部"泡 |
| ⑤ | 功能图标轨 | 40 | ✅📦🔍⚡ 竖排+角标,点击开合⑥ →§11.4.36 |
| ⑥ | 侧栏面板 | 320(全屏420) | 四 Tab 内容区,展开挤压④ →§11.4.36 |
| ⑦ | 状态条 | 28 | 上下文水位/本轮token/用时/模型名,点击用量明细 |
| ⑧ | 输入区 | 88~200 | 附件/斜杠命令/发送状态机 →§11.4.32 |
| ⑨ | 悬浮球 | 48 | 收起入口;后台新事件红点(抽屉未开时) |

**结构框图**(几何关系一眼清,文字细节看各小节):

```
┌────────── 抽屉 55vw ⇄ 全屏 · 360ms ease-out · 默认无遮罩(可钉住) ───────────┐
│ ① 头部栏 56 ────────────────────────────────────────────────────────┤
├───────┬──────────────────────────────────────────────┬──────┬───────┤
│②会话  │③ 计划条28(sticky):"计划 履约回归 3/6 ▓▓▓▸" 点击开⑥✅Tab │⑤图标轨│⑥侧栏  │
│ 列表224├──────────────────────────────────────────────┤  40  │ 面板320 │
│(收40) │                                              │ ✅3/6│ (默认  │
│       │        ④ 消息流 flex ≥560 —— 事件卡片流(11种卡型)        │ 📦2● │ 收起, │
│       │        详图见下 · 上滚浮出"回到底部"泡                     │ 🔍   │ 规格  │
│       │                                              │ ⚡1● │ §11.4. │
│       ├──────────────────────────────────────────────┤ 36~37│ 36)   │
│       │⑧ 输入区 88~200:[📎][输入消息或 /命令…][发送➤ / ■停止]            │      │       │
├───────┴──────────────────────────────────────────────┴──────┴───────┤
│ ⑦ 状态条 28:上下文水位 43% · 本轮 12.4k tok · 用时 18s · 模型名(点开用量明细)  │
└─────────────────────────────────────────────────────────────────────┘
```
**④ 消息流详图**(示例会话;卡型全套规格见 §11.4.31):

```
+---------------------------------------------- Agent 抽屉 55vw ------+
| Pilot          [模型: fundgpt-coder-next ▾ | 思考:中 ▾ | 模式:询问 ▾]  [_][X] |
| 会话: 履约回归测试          [+新建] [历史会话...]           |
+--------+-----------------------------------------------------------+
| 会话   |  [用户] 帮我创建一个"订单履约"的回归测试                    |
| 列表   |  --------------------------------------------------------- |
| (可折 |  [思考] 项目里有 14 个 API、3 个 UI 用例、2 台设备。         |
|  叠)   |         履约相关:下单/支付/库存/发货通知...先查资产。        |
|        |  [工具·读] search_test_assets("履约") -> 8 个结果   [展开]  |
|        |  [思考] 可组合两条路径:纯 API 快回归 / API+APP 端上验证。   |
|        |  [文本] 我准备了 2 个候选方案:                              |
|        |  +------------------ 候选场景卡片(2 张并排) --------------+ |
|        |  | A. 接口级回归(6步,~2min)   B. 端到端混合(9步,~4min)   | |
|        |  | 下单→支付→库存扣减…          APP下单→API支付→APP查单…   | |
|        |  | [画布预览] [选择A]           [画布预览] [选择B]         | |
|        |  +----------------------------------------------------------+|
|        |  [用户] 选B,支付后加一步断言短信                            |
|        |  [工具·写] update_scenario_draft  +1步(断言短信) [审批卡?]  |
|        |    + 审批卡: 参数 diff 高亮 [本次允许][本会话允许][拒绝]     |
|        |  [文本] 已更新,共 10 步。[保存为正式场景] [去画布编辑]        |
+--------+-----------------------------------------------------------+
| [附件] / 输入消息... (/ 唤起命令面板)                    [发送/停止] |
| 状态条: 上下文 43% | 本次 12.4k tok | 用时 18s                       |
+---------------------------------------------------------------------+
```

**要点**:
- 分区优先级:④是主角,⑤⑥克制(默认收起/角标制),②③可折叠——"安静能干"。
- **每步一条事件**,思考(灰斜体可折叠)/文本/工具(读蓝写橙)/审批(红边)/卡片。历史会话重开=事件重放,渲染一致。
- 模式/模型/思考三开关就在①头部,会话级生效(需求⑤);⑧"停止"即时中断。
- ⑨悬浮球红点=后台会话有新事件(抽屉收起时 Agent 继续跑);②列内该会话带蓝点。

### 11.4 页面布局草图(全套)

> 约定:草图表达**结构与相对比例**,像素值一律以 §11.7 为准,色彩以 §11.6 为准。符号:`⊞`勾选 `⊙`收藏 `▾`下拉 `☑/☐`开关 `·`更多菜单 `●`状态点 `✗/✓`失败/通过;`[xxx]`按钮或输入框;左侧栏 208px 与顶栏 56px 在所有页面图中省略不画(见 11.2)。

#### 11.4.1 工作台

```
+ 工作台 ──────────────────────────────────────────────────────+
| [统计卡] 资产 128   近7天执行 42   通过率 91.2%   失败TOP:履约回归    |
+---------------------------------------------------------------+
| 通过率趋势(近7天折线,主色)                | 最近执行(10 条)        |
|                                            | 场景·结果点·耗时·触发   |
+-------------------------------------------+-----------------------+
| 我最近编辑(10 条:名称·类型·时间 → 打开)                              |
+---------------------------------------------------------------+
```

#### 11.4.2 API 接口管理(列表页 = 全平台列表页标准形)

```
+----------------+------------------------------------------------------+
| 模块树 208      | 搜索[__] 视图[全部▾] [高级搜索]  [+新建▾][导入][导出]  |
|  ├ 登录注册(12) | ---------------------------------------------------- |
|  ├ 订单(31)     | ⊙ 名称        方法  路径       状态  标签  最近结果 时间· |
|  │  └ 履约(9)   | ⊙ 创建订单     POST  /order    完善  订单  ●通过   11-12·|
|  └ 支付(7)      | ⊙ 查询订单     GET   /order/id 拟定   -    ●失败   11-11·|
|                 | 行悬停右侧浮出 [详情][复制][移动][删除]                   |
| [♻回收站]       | ─── 勾选后浮出批量条 ───                               |
|                 | 已选12 [移动][复制][标签][回收站] [×取消]                |
+----------------+------------------------------------------------------+
```

#### 11.4.3 接口详情(右抽屉,主页面保留可继续操作)

```
            |<------ 抽屉 min(70vw, 1000px) ------------------>|
  主列表页   | POST /order/create  ⊙  [编辑全部→全屏][×]         |
  (变暗不遮) | 状态[拟定▾] 标签[订单+] 负责人[陈▾] 版本 v1        |
            | Tabs: [定义] [用例(4)] [场景引用(2)]               |
            | -------------------------------------------------|
            | (定义=11.4.4 请求编辑器骨架;用例 tab=11.4.5+列表)   |
            +--------------------------------------------------+
全屏编辑页:顶栏[←返回·名称·保存] | 左 基本信息 360 | 右 请求编辑器 flex
```

#### 11.4.4 请求编辑器骨架(调试/用例/接口定义/HTTP直连步骤共用)

```
+--------------------------------------------------------------------+
| [POST▾] [/order/create___________] [发送调试]      快捷索引▎字段跳转  |
| Tabs [Params][Headers][Cookies][Body][Auth][前后置脚本][超时]  │复制路径|
| Body子签 (•)json ( )form ( )multipart ( )raw ( )graphql       │复制cURL|
| +------------------------------------------------------------+      |
| | Monaco 编辑器:高亮/格式化/JSON校验(错误行波浪线)                    |      |
| +------------------------------------------------------------+      |
| 调试响应面板(发送后展开,最高40vh):                                    |
| [200 · 231ms] [Body|Headers]  …响应 JSON…        [保存为用例]        |
+--------------------------------------------------------------------+
```

#### 11.4.5 断言配置抽屉(640;用例与场景公共断言共用)

```
+ 断言配置 -----------------------------------------------------+
| [+ 添加断言▾: 响应码|文本包含|正则|JSONPath|XPath|响应时间|结构|脚本] |
| ☰ [JSONPath] $.code  等于  [0]            ☑启用 [删除]           |
| ☰ [响应码]    等于  [200]                 ☑启用 [删除]           |
| ☰ [响应时间]  小于  [2000] ms             ☐禁用 [删除]           |
| (拖把手排序;脚本类型展开 Monaco 小编辑器)                          |
+-----------------------------------------------[取消][保存]------+
```

#### 11.4.6 导入向导(960 模态,三步 Steps)

```
+ 导入 (960) ─────────────────────────────────────────────────+
| ① 来源 (•)OpenAPI3 ( )Swagger2 ( )Postman                    |
|   [拖拽文件] 或 URL[______________] [解析]                     |
| ② 预览: 新增18 · 覆盖3 · 跳过2    冲突策略[逐条选择▾|全跳过|新版本] |
|   ┌名称───────方法──路径────────冲突───────────┐               |
|   │创建订单     POST  /order     无 → 新增      │               |
|   │查询订单     GET   /order/1   已存在 [跳过▾]  │               |
| ③ 结果: 成功18 · 失败2 [下载错误报告] [回滚整批]                 |
+-------------------------------------------------------------+
```

#### 11.4.7 数据集编辑器(640 抽屉)

```
名称[__] 模式: (•)表格 ( )粘贴CSV
+----------------------------------------------------------+
| ⊞ | username▦ | password▦ | expect▦        [+列]          |
| ☑ | u_test1   | ******    | success        (表头=变量名,  |
| ☑ | u_test2   | ******    | fail            用例内引用同名  |
|                        [+行] [粘贴CSV]     变量自动覆盖)    |
+----------------------------------------------------------+
```

#### 11.4.8 场景列表

```
+ 场景编排 ───────────────────────────────────────────────────────+
| 搜索[__] 视图[全部▾] [高级]      [+新建场景▾: 空白|从资产生成|Pilot生成] |
| ⊞ 名称        模块   优先级 最近结果 步骤数 定时 负责人 更新           |
| ⊞ 履约回归     履约   P0    ●失败    10    ⏰   陈    11-12 ·      |
| ⊞ 登录接口集   登录   P1    ●通过     6    -    王    11-10 ·      |
| 批量条: 已选12 [执行(选环境)][启用禁用][移动][复制][导出][回收站]       |
+-------------------------------------------------------------------+
```

#### 11.4.9 场景详情 - 画布模式(默认)

```
+ 场景: 履约回归 [模式: 画布|列表] [环境:测试v] [保存⌘S][调试][执行] ------+
+----------------+----------------------------------+-------------------+
| 资产树 240      |           画布 flex                | 属性面板 360        |
| API用例         |    (开始)                         | Tabs[配置|断言|高级] |
|  登录 ✓        |      |                            | 名称: 创建订单      |
|  创建订单      |   [API 创建订单] ←224×64           | 用例: [创建订单▾]   |
| UI用例 ▸       |      |                            | 环境覆盖: -         |
| ADB用例 ▸      |   [循环 while ≤5] ←容器头40        | 失败策略: [停止▾]   |
| 逻辑控件        |    ├ [API 查单状态]                | 断言(2) ✓          |
|  +循环 +判断    |    ├ [等待 5s]                    | [仅此步调试]        |
|  +等待 +脚本    |   [IF 支付成?]──成立→[ADB APP查单]  |-------------------|
|                |                └否则→[截图]        | 调试日志(本步)      |
+----------------+----------------------------------+-------------------+
| 底部调试抽屉(默认高300,可拖120~60vh):步骤执行树+响应日志,运行中节点呼吸高亮  |
+-----------------------------------------------------------------------+
画布: 缩放0.5~2.0/自动适配/小地图120×80/节点左边条=域色/右键菜单(重命名·复制·禁用·
插入到后·移入容器)/框选成组/undo50/校验错=节点角标+底部"问题"面板定位
```

#### 11.4.10 场景详情 - 列表模式(照搬 MS v3 步骤树交互,与画布同一数据)

```
+---------------------------------------------------------------------+
| ☑ 1 ▾ API·创建订单 (POST /order)                          [+] [···]  |
| ☑ 2 ▾ 循环·while≤5次                                         [+] [···]  |
|     ☑ 2.1 API·查单状态                                       [···]   |
|     ☑ 2.2 等待 5s                                            [···]   |
| ☑ 3 ▸ IF·支付成功?(折叠)                                      [+] [···]  |
| 拖把手=排序,缩进=嵌套 | 搜索步骤[__] [+ 添加步骤▾] | 剪贴板[粘贴(2)]      |
+---------------------------------------------------------------------+
```

#### 11.4.11 UI 元素库

```
+ 元素库 ──────────────────────────────────────────────────────+
| 搜索[__] [+ 新建元素]                                [♻回收站]  |
| 名称      定位方式    定位表达式               引用数  更新   操作 |
| 登录按钮   [ID]      login_btn                3     11-10  ·  |
| 搜索框     [XPATH]   //input[@name='q']       1     11-02  ·  |
| (新建弹窗: 名称/类型▾/表达式/备注;删除弹引用检测列表)                  |
+---------------------------------------------------------------+
```

#### 11.4.12 用例步骤编辑器(UI 用例 / ADB 用例共用一个组件)

```
+ UI用例: 登录流程 ── 环境[测试环境v] [保存][调试] ─────────────────+
| ☑ 1 打开   base_url/login(变量渲染)                    [···]     |
| ☑ 2 输入   元素[用户名框] 值[u_test1]                    [···]     |
|   └展开参数: 元素[选择器▸]|就地定位 值[__] 超时[10s]               |
|              结果存变量[__] ☐失败继续                             |
| ☑ 3 点击   元素[登录按钮]                                [···]     |
| ☑ 4 断言文本 页面包含 "工作台"                            [···]     |
| [+ 添加命令▾]        剪贴板: [粘贴(2)]                             |
+-------------------------------------------------------------------+
| 调试面板(底部300): ✓1打开230ms ✓2输入12ms ✗3点击超时 [截图][控制台]  |
+-------------------------------------------------------------------+
ADB 用例同骨架,步骤参数表单随类型切换(click_by_text→文本/超时;shell→命令
Monaco;file_push→本地文件+设备路径…),设备策略: (•)任一空闲 ( )指定设备
```

#### 11.4.13 共用选择器弹窗

```
元素选择器(640): 搜索[__] | 列表: 名称·定位方式·表达式(单选) | 最近使用tab
                 | [+ 就地新建元素]内联展开 11.4.11 新建弹窗
设备选择器(560): 卡片单选网格: Pixel6 ●空闲 | 小米13 ●占用(排队#2·预计3m)
                 底部[确定];占用设备可选"排队等待"勾选
```

#### 11.4.14 ADB 设备管理(卡片墙)

```
+ 设备管理 ── 筛选[全部|空闲|占用|离线] [+ 添加设备] ─────────────────+
| +----------------+ +----------------+ +----------------+          |
| ▌Pixel6 绿=空闲   | ▌小米13 蓝=占用   | ▌Nexus5 灰=离线 |  卡168高  |
| │Android13 电86% | │Android14        | │最后心跳3m前    |  左状态带 |
| │192.168.1.20:5555| │占用:履约回归     | │[重连][编辑][删] |  4px     |
| │hover[测·编·删]  | │步骤3/10 已12s    | +----------------+          |
| +----------------+ │[占用详情→强制释放]|                             |
|                    +----------------+                             |
+---------------------------------------------------------------------+
添加设备弹窗: 名称[__] WiFi地址[ip:5555__] [测试连接]→ adb connect+getprop
结果原样回显,成功才允许保存(失败给排错提示:先执行 adb connect/同一网段?)
```

#### 11.4.15 报告中心(列表)

```
+ 报告中心 ─────────────────────────────────────────────────────────+
| 时间[近7天▾] 场景[___] 触发[全部▾] 执行人[▾] 环境[▾] 结果[全部▾]         |
| 场景名        触发      执行人  环境   通过率   步骤    耗时   开始·    |
| 履约回归      ⏰定时     -      测试1  ◔91%    10/11   2m31s  02:00 ·  |
| 登录接口集    ✦Pilot    陈      测试env ◔100%  6/6     41s    14:02 ·  |
| (触发徽标: 手动/⏰定时/✦Pilot/⚡webhook;批量[删除][导出])                  |
+---------------------------------------------------------------------+
```

#### 11.4.16 报告详情(三栏)

```
+ 报告: 履约回归 @测试1 · 定时触发 ── [失败步骤重跑][返回] ────────────+
| 概览: ◔91% · 2m31s · 步骤10/11 · 触发·环境·执行人                       |
+--------------+---------------------------------+---------------------+
| 步骤树 300    | 只读画布(结果着色:              | 步骤详情 420          |
| ✓ 创建订单    |  pass绿/fail红/未执行灰)        | [请求|响应]Monaco对照  |
| ✓ 查单状态    |  (11.4.9 画布的渲染态,          | 断言表: 项·预期·实际✓✗ |
| ✗ APP查单    |   禁编辑,点击节点联动右栏)        | 截图[灯箱] [下载制品]   |
| 数据集 ▸3/10  |                                 | 日志/脚本输出          |
+--------------+---------------------------------+---------------------+
```

#### 11.4.17 定时任务(列表 + 编辑抽屉 640)

```
+ 定时任务 [+ 新建任务] ───────────────────────────────────────────+
| 名称      场景         计划(人话)     下次      最近结果   启用     |
| 夜间回归   履约回归      每天 02:00     02:00     ●失败      ☑     |
+---------------------------------------------------------------------+
编辑抽屉: 名称[__] 场景[选择器▾] 环境[▾]
计划: (•)每天[02:00] ( )每周[☑一☑三…] ( )自定义cron[____] 预览未来5次:…
通知: ☑钉钉群A ☐邮箱 | 告警: 连续失败[3]次后通知
```

#### 11.4.18 回收站(各模块底部"♻回收站"内嵌页)

```
名称         删除人  删除时间  来源模块   操作
订单查询旧版   王     11-01    接口管理   [恢复][彻底删除→输名称确认]
```

#### 11.4.19 全局快捷查找(Ctrl+K 居中浮层 640)

```
| 搜索接口/用例/场景/设备…(即时过滤,↑↓选择,Enter直达详情)
| 接口(3)  POST /order 创建订单
| 场景(1)  履约回归
| 设备(1)  Pixel6 → ADB设备管理
```

#### 11.4.20 高级搜索面板(筛选栏下方展开 ~120 高)

```
[+条件] [+条件组]   组关系: (•)满足全部 ( )满足任意
[状态▾][等于▾][拟定][×]  [更新时间▾][最近▾][7天][×]
(字段全集: 名称/状态/优先级/标签/负责人/更新时间/最近结果;保存为视图→11.5.1)
```

#### 11.4.21 系统设置 - 项目 / 成员 / 角色

```
+ 系统设置 ── Tabs[项目|成员与角色|用户|模型|MCP|Skills|通知|审计|参数] ─+
| 成员: [+邀请(搜索用户)]  用户·角色·加入时间·最近活跃·[改角色▾][移出]        |
| 角色: [内置×4只读查看] [+新建自定义(从模板复制)]                          |
| 角色编辑抽屉(720): 名称[__] 权限菜单树(两级勾选):                          |
|  ▾ API测试   ☑查看 ☑新建 ☑修改 ☐删除 ☑执行                              |
|  ▾ ADB设备   ☑查看 ☐管理(连接/释放)                                     |
|  ▾ Agent     ☑会话 ☐FULL模式                                          |
+-------------------------------------------------------------------------+
```

#### 11.4.22 用户管理

```
[+ 新建用户] [批量导入]  (列表页标准形: 账号·姓名·邮箱·状态点·创建时间·
 [编辑][重置密码][禁用])
```

#### 11.4.23 模型配置(卡片墙 + 编辑抽屉 640)

```
+ 模型配置 ─────────────────────────────────────────────────────+
| +------ 模型卡(min320) -------+ +---------------------------+  |
| | fundgpt-coder-next   默认★ ·|| | gpt-x  [停用]         ·   |  |
| | OAI兼容 · 127.0.0.1:9000    | | ...                       |  |
| | [✓工具][✓思考][✗视觉]        | | [✓工具][✗思考][✓视觉]       |  |
| | 探测●OK 412ms · 用量34会话    | | 探测●失败 [重试]            |  |
| +-----------------------------+ +---------------------------+ [+新建]
编辑抽屉: 名称/协议[OpenAI兼容|Anthropic▾]/base_url[__]/key[••••重置]
上下文窗口[__] 最大输出[__] 温度[__]
能力: ☑工具调用 ☑图片 ☑思考→档位[☑低 ☑中 ☑高](未勾选思考则档位组禁用)
[连通性测试]→ 延迟 + 逐能力✓/✗ | [设为默认] 用量统计→
· 类型=向量模型:协议锁 OAI兼容,思考/视觉位隐藏,显示[维度探测]按钮(§9.10)
```

#### 11.4.24 MCP 服务

```
+ MCP 服务 [+ 添加] ─────────────────────────────────────────────+
| 名称        transport 状态    工具数 操作                                |
| filesystem  stdio     ●在线   12    [停用][编辑][工具预览▸][事件日志]      |
| my-http     http      ●离线   -     [重试][编辑] 最近错误:connect refused  |
+---------------------------------------------------------------------------+
编辑抽屉: 名称/transport▾(stdio→command+args+env加密行 / http→URL+headers)
[保存并重连];启停即时,状态点实时刷新
```

#### 11.4.25 Skills

```
+ Skills ── [+ 同步 skills 目录](扫描后端目录,报告新增/变更/移除) ──────+
| 名称             描述             来源   启用   操作                     |
| api-scenario-gen 场景生成指引      内置   ☑     [查看(Markdown渲染)][停用] |
+---------------------------------------------------------------------------+
```

#### 11.4.26 通知渠道

```
+ 通知渠道 [+ 新建渠道▾: Webhook|钉钉|企微|飞书|邮件] ─────────────────+
| 名称     类型   关键配置(打码)      最近测试   操作                      |
| 钉钉群A  钉钉   access_token••••   ✓11-12    [编辑][测试发送][删除]      |
+---------------------------------------------------------------------------+
编辑抽屉按类型出动态表单;底部 [发送测试] → 行内 ✓/✗ + 原始响应
```

#### 11.4.27 审计日志

```
+ 审计日志 ── 时间[__] 操作人[▾] 入口[全部|Web|Pilot|定时] 权限位[___] ──+
| 时间    操作人 入口    动作              对象          结果            |
| 14:02  陈     ✦Pilot  api:def:create    创建订单接口    ✓ [diff]       |
| 11:30  王     Web     scenario:delete   履约回归V2      ✓ [diff]       |
+---------------------------------------------------------------------------+
[diff]→模态: before/after 双栏 JSON 高亮对照
```

#### 11.4.28 系统参数

```
制品保留天数[90] 场景执行并发[4] ADB心跳间隔[15]s Agent功能总开关☑
RAG: 开关☑ 向量模型[fundgpt-embed▾] top_k[8] 相似度阈值[0.30] [重建资产索引](全量,断点续跑进度条)
```

#### 11.4.29 登录页与通用空态

```
登录(居中卡片400): Logo · 账号[__] 密码[__] [登录] (无注册入口,管理员建号)
权限空页: 锁形插画 + "需要权限: api:def:create" + [复制申请文案给管理员]
通用空态: 80px线稿 + "还没有场景" + [新建场景] + [让 Pilot 生成](描边钮)
```




#### 11.4.30 抽屉头部控制区(模型 / 思考程度 / 权限模式 三选择器)

```
+ Pilot 头部 ───────────────────────────────────────────────────+
| Pilot   会话: 履约回归                          [_][最大][×]   |
| [模型: fundgpt-coder-next ▾][思考: 中 ▾][模式: 询问 ▾]          |
| 上下文 43% ▓▓▓▓░░ | 本轮 12.4k tok · 18s(点击展开用量明细)      |
+----------------------------------------------------------------+
模型下拉(420宽): 每行 = 名称 + 能力徽标[工具][思考][视觉] + 默认★ + 探测状态点
  · 当前模型低于运行基线(无工具/<64k) → 列表顶部黄条:"该模型无法执行平台操作,
    仅可对话"(§9.6 降级);切换即时生效,记入会话事件流
思考下拉: 选项由所选模型 thinking_levels 渲染(关/低/中/高);模型不支持 → 整组
  置灰 + tooltip"模型不支持思考";新会话默认 = 模型配置默认档,会话内改动不回写全局
模式下拉(单选,每项一行说明,§9.4):
  ○ 查看  只读:写操作自动拒绝(模型仍全量回答)
  ● 询问  写/破坏性操作逐次弹审批卡(默认)
  ○ 完全  全部自动执行(需角色授予 FULL 权限位,否则置灰+tooltip,§11.4.35)
三个选择器状态 = 会话级;每次切换落 AGENT 事件(回放与审计可见"当轮用了什么配置")
```

#### 11.4.31 消息事件卡片全套(直播与回放同一套组件;左边线色 = §11.6 Pilot 竹青体系)

```
┌ 用户 ────────┐ [陈] 帮我创建一个"履约回归"测试
├ 思考(灰斜体)─┤ 需要先盘点项目内履约相关资产…           [展开▾](折叠2行)
├ 文本 ────────┤ 正文 Markdown(表格/代码块/列表)
├ 工具·读(蓝)──┤ ⌕ search_test_assets("履约") ✓ 1.2s   [展开:入参/结果JSON]
├ 工具·写(橙)──┤ ✎ update_scenario_draft (+1步 短信断言) ✓
│              │ [展开参数][diff摘要](失败时:✗ + [仅重试该步])
├ 提问卡(蓝框)─┤ ask_user: 断言走哪个通道?
│              │ (•)短信 ☎ (•)推送 🔔 ( )其他 [____] [提交]→ 提交转为用户消息
├ 候选场景卡 ──┤ A/B 两列步骤预览+耗时预估 [画布预览][选择](详见 11.3)
├ 审批卡(红框)─┤ ⚠ 请求执行: delete_scenario("旧版V2", id=88)
│              │ 参数 diff 高亮(删除类附影响:被 2 个定时任务引用)
│              │ [本次允许][本会话允许·仅该工具][拒绝 +一句话理由?]
├ 计划卡(青)──┤ ▸ 计划更新 3/6(点击滚动到 11.4.33 面板)
├ 压缩卡(灰)──┤ ‹自动压缩 23~102 条为摘要› [查看摘要][查看被压缩范围]
├ 用量(灰一行)┤ 本轮 12.4k tok · 18s · fundgpt-coder-next(默认折进状态条)
└ 错误(红)────┤ ✗ 网关 502 中断于第 4 步 [继续重试][换模型重试▾]
折叠规则:除 提问/审批/候选 三卡外,其余默认折叠一行高;工具卡 max-h 320 内滚
```

#### 11.4.32 输入区与发送按钮状态机

```
+---------------------------------------------------------------+
| [📎附件] 输入框(88~200px 自扩;输入 / 弹命令面板补全)               |
|                              [发送主按钮]  ⏎ 发送 · Shift+⏎ 换行 |
+---------------------------------------------------------------+
A 空闲      按钮[发送➤](空内容禁用)
B 流式输出中 按钮[■停止](红);输入框仍可打草稿,⏎=浮出"停止并发送?"确认泡;
            附件按钮置灰;头部三选择器锁定不可改(避免半路换模型错乱)
C 待审批    输入区上方黄横幅"⚠ 等待确认: delete_scenario [跳审批卡]";发送置灰;
            抽屉收起时悬浮球红点 + 系统通知(可关)
D 模型无工具 蓝条"该模型无法执行平台操作,仅对话"(仍可发送)
E 上下文≥95% 发送置灰 + 泡内快捷钮 [执行 /compact 后继续]
F 会话归档  输入区整体置灰 + [基于此会话新建](继承压缩摘要)
```

#### 11.4.33 目标计划列表(TodoList 面板,Claude Code 式)

```
(抽屉内容区顶部只留**轻量一行进度条**"计划 3/6 ▓▓▓▸";完整任务清单面板在功能侧栏 ✅ Tab,§11.4.36;点进度条即打开该 Tab)
+ 计划 · 生成履约回归场景 ────────────── 3/6 ── [折叠▾] ─+
| ✓ 盘点履约相关资产(API 8 · UI 2 · ADB 3)                |
| ✓ 分析依赖链: 下单→支付→库存→发货                        |
| ▶ 生成 2 个候选场景                       ← 进行中呼吸动画 |
| ○ 等待用户抉择与修改                                     |
| ○ 保存正式场景(将走审批)                                |
| ○ 冒烟执行一次(可选)                          [跳过]     |
+----------------------------------------------------------+
数据协议: Pilot 调元工具 propose_plan(items[文本,依赖序]) 建列表;
  每步推进调 update_plan_item(id, pending→doing→done/skipped)→ 事件落库
渲染规则: 折叠=一行"计划 3/6 ▓▓▓▸";点击条目 → 滚动定位到产生它的工具卡;
  done 绿勾 strikethrough? 否——保持绿勾不删除线(审计感);skipped 灰划掉
执行约定(写进系统提示): 凡预计 ≥3 步的操作必须先出计划;
  计划本身可被用户改("跳过冒烟")→ Pilot 调 update_plan_item(skipped) 响应
```

#### 11.4.34 审批链路(UI ↔ 引擎 ↔ 审计 一图)

```
引擎: 写操作 tool_call → ASK 门 → 落 APPROVAL_REQ 事件 → run=WAIT_APPROVAL(挂起)
  → pubsub 推前端;抽屉收起 → 悬浮球红点 + 浏览器系统通知(可关)
UI:  审批卡(红框)出现在消息流原位:工具名+入参 diff+影响提示(引用检测/删除警示)
  [本次允许] [本会话允许→仅该工具粒度,下次同名工具免问]
  [拒绝] → 可选一句话理由(注入对话,模型据此改方案,不是死路)
回传: POST /agent/runs/{run}/approval → 引擎由落库上下文恢复循环
  允许→TOOL_EXEC;拒绝→TOOL_RESULT(已拒绝+理由)→模型继续思考
审计: agent_approval(决策快照)+ audit_log(入口=Pilot)双落,§11.4.27 可查
超时: 10min 未决 → 视为拒绝,回合尾提示"因未获批准而停止",已完成的步骤不回滚
  (每个写工具本身事务原子;半途而废场景由计划列表标明断点,续跑从断点继续)
重开会话: 未决审批卡按 WAIT_APPROVAL 状态原样呈现,依旧可操作(§8.7 重启恢复)
```

#### 11.4.35 权限的双层门(角色级 × 会话级)

```
角色级(管理员,11.4.21 权限树): "Agent:☑会话 ☐FULL模式"
   └ 无 FULL 位 → 该用户模式下拉里"完全"永远置灰(§11.4.30)
会话级(用户自选): 查看 / 询问(默认) / 完全(过角色门才可选)
效果矩阵见 §9.4;权限位真相唯一:工具对无权限用户不可见(§15-10)
两层任何改动都落事件与审计;报告/审计中 Pilot 行为永远带 ✦Pilot 徽标
```

#### 11.4.36 Agent 功能侧栏(任务清单 / 产物 / 引用 / 执行监控)

```
抽屉展开态(55vw): 会话列表224 | 消息流 flex | 图标轨40 ⇄ 面板320
+-----------------------------------------------+--+--─┬─────+
| 消息流(主对话)                                  |  |▤ ✅| ✅ 任务清单 · 履约回归 3/6 [▾][✕]
|  …事件卡片流…                                   |  |  | ✓ 盘点履约相关资产(API8·UI2·ADB3)[→]
|                                                |  |  | ✓ 分析依赖链: 下单→支付→库存 [→]
|                                                |  |  | ▶ 生成 2 个候选场景  ←呼吸
|                                                |  |  | ○ 等待用户抉择与修改
|                                                |  |  | ○ 保存正式场景(将走审批)
|                                                |  |  | ○ 冒烟执行一次          [跳过]
+-----------------------------------------------+--+--┴──────+
图标轨(竖排,收起态仅 40px): ✅3/6 | 📦2● | 🔍 | ⚡1●   ●=新内容徽标
面板 Tab 规格(宽 320,抽屉全屏 420;展开挤压消息流,消息流保底 560,
抽屉不足 960 宽时面板改悬浮覆盖):
📦 产物 —— Pilot 本次会话动过的平台对象,按类型分组:
   场景  履约回归(V2·草稿)              [打开画布]
   报告  履约回归 #1289 · 91%            [打开报告]
   截图  APP查单失败现场                 [灯箱]
   草稿  scenario_draft v4               [预览]
   协议: 写类工具 TOOL_RESULT 附 produced[]=(kind,id,name,link) 自动登记;
   产物=真实平台资产,会话归档后仍可点(按用户自身权限校验,无权→11.4.29)
🔍 引用 —— "Pilot 看过什么":本轮 search_test_assets 命中清单/环境/skills/
   MCP 来源,每行可跳平台对象(审计视角:让业主能核查依据,敢信它的结论)
⚡ 监控 —— Pilot 触发的执行任务实况(run.{runId} SSE,§8.7):
   场景·环境·状态呼吸·通过率·[详情],可多个并行,失败红点直跳报告
```

**视觉构件规格**(⑤⑥专用,色彩取 §11.6 Token):

- **⑤ 轨道项**(高48:图标18+底部计数12):五态——默认 text-3 灰 / 选中 Pilot竹青+primary-50底 /
  新内容 红点6px(弹入180ms) / 运行中 图标呼吸 / 错误 error小三角叠角。hover=tooltip(名称+一句摘要,
  如"产物 2 项 · 新增:报告#1289");点击开合⑥,面板已开时再点该 Tab = 收起面板。
- **⑥ 面板头**(高48):Tab名+计数/进度环+[▾收起为轨][✕关面板];正文独立滚动。
- **列表行解剖**(高56):域色图标20 | 两行正文(名称14 text-1 / 来源+时间12 text-3) |
  尾操作 hover 显形(打开/预览/灯箱);整行点击=主操作;选中底 bg-selected。
- **hover 速览卡**(200ms 延迟浮出 240px):场景=步骤骨架树缩略;报告=通过率环+失败TOP3;
  截图=缩略图(点击进灯箱)。速览卡不可交互外溢,移开即散。
- **Tab 内组织**:📦按类型分组+筛选chips(全部/场景/报告/草稿/制品);🔍按回合分组(轮次标题可折);
  ⚡run 卡(通过率环+步骤3/10+环境徽标+[详情])可多条并行,完成 30s 后自动沉底。
- **空态**:每 Tab 一句引导文案+图标(如产物:"Pilot 还未改动任何资产")。
- **键盘**:面板聚焦后 1~4 切 Tab;Ctrl+Shift+A 开合面板;✅Tab 内 ↑↓ 选条目 Enter 跳转。

#### 11.4.37 侧栏自动展开与打扰规则(安静能干)

```
会话首个 propose_plan      → ✅Tab 自动展开一次(偏好记住,之后不强开)
新产物登记                 → 📦 角标+1;收起态只角标不展开
Pilot 触发 run_scenario    → 抽屉开着:自动切 ⚡Tab;收着:悬浮球红点
计划全部终态               → ✅ 进度徽标转绿,保留到切换会话
约束: 无声音/无弹窗打断;一切打扰仅为角标或一次性展开;
     用户手动收起的 Tab,同会话内不再自动强开(尊重偏好)
```

### 11.5 页面级详细设计(对标 MeterSphere v3)

对标原则:MS v3 的页面骨架与交互约定(模块树+列表+详情抽屉、高级搜索、保存视图、勾选批量条、回收站、操作日志、快捷索引、用例剪贴板、Ctrl+K 快捷查找)**照搬**;差异集中列在下面的差异表,其余不重新发明。**本节所有「照搬」项在源码里有实物**:`D:\item\metersphere\frontend\src\views\{api-test,case-management,test-plan,project-management,setting,workbench}` + `router/routes/modules/*.ts`(导航层级)+ `locale/zh-CN/**`(文案),别凭印象猜交互。

**与 MS v3 的差异表(拍定值)**

| MS v3 做法 | 本平台 | 理由 |
|---|---|---|
| 场景详情 = 步骤列表(嵌套折叠拖拽) | **双模式:画布(默认)+ 列表模式可切换**,编辑同一 step_graph | 业主需求 2 要可视化;MS 式列表交互保留,批量编辑不降效 |
| 场景按模块拆分(API 场景/UI 场景/性能场景) | **统一场景体系**,步骤可混合引用三类资产;入口仍分布在各模块菜单(默认过滤本域) | 混合场景是核心卖点 |
| 接口详情第 3 Tab = Mock 期望 | Tab 位改为"场景引用";Mock [三期] | 一期无 Mock |
| 测试计划模块 | [三期];一期由定时任务+报告中心承接执行编排 | 分期 |
| 用例剪贴板 | **保留**(本地 + 后端各留 20 条,跨页粘步骤/用例) | 组场景利器,照搬 |
| 工作台待办/评审流 | 一期简化统计版;待办中心 [三期] | 分期 |
| 版本/文件/模板管理 | [二期]版本;模板、素材库 [三期];字段已预留 | 分期 |
| 深色模式/消息中心 | 二期起;一期仅个人偏好(默认模型/抽屉宽度) | 分期 |

#### 11.5.1 全局通用交互(所有列表页的"底色",对标 MS)

- **Ctrl+K 快捷查找**:搜接口/用例/场景/设备/UI 元素,按类型分组,回车直达详情。
- **列表页标配**:筛选区(关键字 + **视图选择器**:系统视图/个人视图/保存当前筛选为视图)→ **高级搜索面板**(AND/OR 条件组;字段:名称/状态/优先级/标签/负责人/更新时间/最近结果)→ 表格(**列设置**显隐+排序、排序、分页 20/50/100)→ **勾选后顶部浮出批量条**(移动/复制/标签/启用禁用/回收站;显示计数,支持"跨页全选")。
- **模块树**:过滤输入、拖拽、右键菜单(新建子级/重命名/移动/复制/删除[引用检测弹窗:列出引用者并跳转])、数量徽标、底部回收站入口。
- **回收站**:每模块一个(软删资产列表:删除人/时间/原因,恢复/彻底删除[权限位+输名称确认])。
- **操作日志**(项目设置内):操作人/模块/动作/对象/时间过滤,详情显 before/after diff;**Agent 的写操作同表呈现,带 "Pilot" 徽标**——业主在 MS 里怎么审计人,就怎么审计 Agent。
- **详情统一**:抽屉(宽 60~70%)或全页;标题可编辑、收藏星、标签、状态、负责人;未保存离开警告;按钮级权限点**隐藏**(非禁用),只读角色顶部横幅提示。
- **空态**:插画 + 主操作 + "让 Pilot 帮你生成"次操作。

#### 11.5.2 工作台(一期简化版)

统计卡 ×4(资产数/近 7 天执行/通过率/失败 TOP1 场景)| 近 7 天通过率趋势(ECharts)| 最近执行 10 条 | 我最近编辑 10 条 | 快捷入口(新建接口/导入/新建场景/UI 用例/ADB 用例/问 Pilot)。MS 的待办/评审/关注流 [三期]。

#### 11.5.3 API 测试 - 接口管理(对标 MS"定义"页)

- 布局:模块树 | 列表 | 详情抽屉(70%);"编辑全部"进全屏页(左基本信息右编辑区)。
- 列表列:收藏 | 名称 | 路径 | 方法(彩色徽标) | 状态(拟定/完善/弃用) | 优先级 | 标签 | 负责人 | 更新时间 | **最近结果**(●通过/失败/未执行,hover 时间+环境)。
- 工具栏:[+ 新建|导入] 下拉 | 导出(选中/全部) | 列设置 | 视图选择器 | [让 Pilot 生成]。
- 行操作:详情 | 复制(选模块) | 移动 | 删除(引用检测)。
- **详情-定义 Tab**:method+path 行内编辑;请求编辑器六区(Auth/Params/Headers+Cookies/Body[json|form|multipart|raw|graphql]/超时/前后置脚本 Monaco);**快捷索引**(右侧竖栏:定位到字段/复制完整路径/复制为 cURL);**调试**按钮 → 响应面板(状态码/耗时/headers/body)+ [保存为用例]。
- **详情-用例 Tab**:用例列表(名称/优先级/数据集/最近结果/启用);用例编辑器 = 请求编辑器 + **断言配置抽屉**(类型:响应码/文本包含/正则/JSONPath/XPath/响应时间/响应结构/脚本;条件+预期值;启用开关;拖拽排序) + 数据集绑定(表格编辑/CSV 粘贴) + 步骤容器(一期单请求,结构预留 MS"用例步骤")。
- **详情-场景引用 Tab**:引用此接口/用例的场景列表,点击跳转。
- **导入流**(对标 MS 一键导入):选来源(OpenAPI3/Swagger2/Postman)→ 文件或 URL → 解析预览(新增/覆盖/跳过 统计 + 冲突逐条策略)→ 确认 → 结果页(成功 N/失败 N + 错误报告下载 + 整批回滚)。

#### 11.5.4 UI 测试(对标 MS UI 用例 + 元素库)

- **元素库**:列表列:名称 | 定位方式(徽标) | 定位表达式(省略+hover 复制) | 关联用例数 | 更新时间;新增用快速弹窗(名称/类型/表达式/备注);删除有引用检测。
- **UI 用例**:列表列:名称 | 优先级 | 启用 | 最近结果 | 负责人 | 更新时间。详情 = **步骤列表编辑器**(对标 MS 命令表):每行 = 图标+命令名+关键参数摘要;行展开参数表单(元素选择器弹窗[元素库搜索+最近使用] / 就地定位 / 超时 / 结果存变量 / 失败继续);行操作:插入后/复制/粘贴(剪贴板)/拖拽/删除;顶部:环境选择 | 保存 | **调试**(底部结果面板:逐步耗时+截图+控制台输出)。录制器 [二期](codegen 半自动包草稿)。

#### 11.5.5 ADB 测试

- **设备管理(卡片墙)**:卡片:名称/型号/系统/电量徽标/WiFi 地址/最近心跳;状态色带:灰离线/绿空闲/蓝占用/红异常;hover 操作:连接/断开/测试(即拍一张设备屏缩略+读设备信息)/编辑/删除(占用检测)。**添加设备弹窗**:名称+ip:port+[测试连接](adb connect+getprop,失败原样展示 adb 输出)。占用中详情抽屉:占用场景/当前步骤/已执行时长 + [强制释放](管理员)。
- **ADB 用例**:与 UI 用例同款列表编辑器,参数表单随步骤类型(§7.3)动态切换;**设备选择策略**:指定设备 / 任一空闲(执行时锁);调试必选空闲设备。设备选择器组件(迷你卡片+排队提示)与执行/定时任务共用。

#### 11.5.6 场景(统一场景体系;画布+列表双模式)

- 列表列:名称 | 模块 | 优先级 | 状态(拟定/通过/失败[最近]) | 步骤数 | 定时(徽标) | 标签 | 负责人 | 更新时间 | 最近执行(人/时间)。批量条:执行(选环境)/启用禁用/移动/复制/导出/回收站。
- 新建下拉:空白 | **从接口/用例生成**(勾选 N 个资产生成步骤骨架——对标 MS"按定义生成场景",与 Agent 候选卡片同一条数据通路)| 让 Pilot 生成。
- **画布模式**(§11.4 草图)补充交互:节点右键(重命名/复制/禁用/删除/插入到后/移入容器);容器头操作条(循环类型/if 分支+加 else/折叠);框选成组(=容器);undo/redo(50 步);Ctrl+S(乐观锁冲突 → 差异对比弹窗);校验错误=节点角标+底部"问题"面板点击定位;小地图/缩放适配。
- **列表模式**(照搬 MS 步骤树):树形行(展开折叠/拖拽排序与嵌套/启用勾选/复制进剪贴板/搜索定位);与画布实时同数据。
- 右面板:基本信息 | 场景变量表 | 失败策略 | 重试 | 公共断言(场景级)| 定时绑定(跳配置)| 通知绑定。
- 底部调试抽屉:运行"当前未保存草稿"(对标 MS 调试语义),步骤树+日志;执行终态出结果徽标。
- 引用检测:保存/执行前查循环引用(用例引用例深度 ≤5)。

#### 11.5.7 任务中心

- **报告中心**:筛选(时间/场景/触发方式/执行人/环境/结果)+ 列表:名称 | 触发徽标(手动/定时/**Pilot**/webhook)| 执行人 | 环境 | 通过率(环形进度)| 步骤数 | 耗时 | 开始时间;详情 = 概览卡(通过率环/耗时/触发/环境信息)→ 左:执行步骤树(场景画布**只读渲染+结果着色**,数据集步骤折叠显 3/10)→ 右:步骤详情(request/response 对照/断言结果表/截图灯箱/制品下载);顶部 [失败步骤重跑]。
- **定时任务**:列表:名称 | 主体(场景)| cron 人话化("每天 02:00")| 下次执行 | 最近结果 | 启用开关;编辑抽屉:选场景+环境 → cron 可视化(每天/每周/每月/自定义 + 未来 5 次预览校验)→ 通知多选 → 连续失败 N 次告警。
- **Webhook 触发**:场景详情"触发"页:token 生成/复制/重置/限次;全局任务中心可总览。

#### 11.5.8 系统设置

- **项目与成员 → 角色**(对标 MS 权限设置):内置 4 角色只读详情;自定义角色 = 复制后在**权限菜单树**(模块→动作两级勾选)上裁剪;成员管理:邀请(邮箱/用户名搜索)/改角色/移出/批量。
- **用户管理**:账号/姓名/邮箱/状态/创建时间;新建/编辑/重置密码/禁用/批量导入。
- **模型配置**:§11.4 草图 + 编辑抽屉(能力位勾选按 §9.6 降级规则联动置灰)/连通性测试(延迟+逐项能力 ✓✗)/设为默认/用量统计(会话数/tokens)。
- **MCP 服务**:列表:名称/transport/状态点(在线|离线|停用)/工具数/最近错误;编辑:command+args+env(加密回显)/url;展开预览工具清单;启停即重连。
- **Skills**:列表:名称/描述/来源/启用;详情 = SKILL.md 渲染;[同步 skills 目录]。
- **通知渠道**:类型动态表单 + 测试发送(内嵌结果)。
- **审计日志**:筛选(时间/操作人/入口 web|Pilot|定时/权限位)+ before/after JSON diff。
- **系统参数**:制品保留天数/执行并发上限/Agent 功能总开关。

#### 11.5.9 页面级 Agent 触点(汇总,与 §11.3 抽屉配套)

| 页面 | 触点 |
|---|---|
| 所有列表页 | 工具栏 [问 Pilot](带当前页对象+筛选上下文)/勾选行 → "让 Pilot 批量处理"(走审批卡)|
| 接口/用例详情 | 编辑器空态"口述生成请求体";调试失败 → "让 Pilot 分析"(带响应体)|
| 场景画布 | 空态"描述需求让 Pilot 生成";候选卡片"画布预览"=本页只读态 |
| 报告详情 | 顶部"让 Pilot 总结失败原因"(带失败步骤上下文)|
| ADB 设备卡片 | "让 Pilot 排查"(带心跳/占用/最近失败)|
| 全局 | suggest_open_page 跳转带高亮定位动画;Pilot 徽标贯穿审计/报告触发列 |

### 11.6 色彩与视觉 Token(可直接写入 AntD ConfigProvider)

**基调**:白卡 + 极浅灰绿底,低饱和高亮度;"清新"的实现手段 = 中性色带一点绿相 + 大面积留白 + 饱和色只出现在小元素。本节是浅色主题唯一真相;Token 名即 AntD token/自定义 CSS var,`--tp-*` 前缀,深色模式([三期])只换映射不改名。

#### 11.6.1 品牌主色阶(青竹绿)

| Token | Hex | 用途 |
|---|---|---|
| --tp-primary-50 | #EAF6F1 | 选中行底/悬停底/浅色标签底 |
| --tp-primary-100 | #D6ECE2 | 浅色标签边框 |
| --tp-primary-200 | #ABD9C7 | 分割型浅色强调 |
| --tp-primary-300 | #7CC3A6 | 图表次要序列 |
| --tp-primary-400 | #52B391 | 图标装饰/大图形 |
| **--tp-primary-500** | **#2BA47D** | **品牌基准**:链接图标、进度、焦点环、徽标 |
| --tp-primary-600 | #1D7257 | **按钮实底底色/文字链接**(白字对比 5.4:1 过 WCAG AA) |
| --tp-primary-700 | #175A45 | 按钮按下态 |
| --tp-primary-800/900 | #124636 / #0D3427 | 深色插画/极少用 |

规则:**实底按钮与可点击文字用 600**(小字 AA 达标),500 只作装饰/大元素(≥3:1);hover=500,active=700,disabled=600 + 40% 不透明度。

#### 11.6.2 功能色(状态语义)

| 语义 | 主值 | 浅底 | 用途 |
|---|---|---|---|
| success | #1D7257(同 primary-600) | #EAF6F1 | 通过/在线/成功 toast |
| processing/info | #4C86E8 | #EDF3FE | 运行中(呼吸动画)/排队/链接蓝 |
| warning | #D48806 | #FDF4E3 | 拟定/电量低/待确认 |
| error | #D3564F | #FBEBEA | 失败/删除/危险审批边框 |
| skip/neutral | #8B8E94 | #F2F3F4 | 跳过/未配置/禁用 |
| 未执行 | #C0C6CC | — | 报告未跑到 |

状态徽标一律"浅底+深字"(底=浅底列,字=主值),杜绝纯饱和底白字小徽标。

#### 11.6.3 功能域与业务徽标色

| 域/元素 | 色值 | 出现位置 |
|---|---|---|
| API 域 | #5B8FF9 | 模块图标、步骤节点左边条、场景标签 |
| UI 域 | #9270CA | 同上 |
| ADB 域 | #47A861 | 同上(节点条 + 设备状态带绿色系时仍用 success 语义色) |
| 逻辑控件 | #8B8E94(循环 #4C86E8、判断 #D48806 点缀在图标) | 画布循环/IF 节点 |
| **Pilot/Agent** | **#13A8A8 竹青** | 悬浮球、Pilot 徽标、Agent 事件流左边线、审批卡头像——全站唯一,不与域色混用 |
| HTTP 方法 | GET #1D7257 / POST #4C86E8 / PUT #D48806 / DELETE #D3564F / PATCH #9270CA / 其他 #8B8E94 | 方法徽标(72px 列宽,等宽字体大写) |
| 执行状态 | 通过·success / 失败·error / 运行·processing+呼吸 / 跳过·skip / 未执行·未执行灰 | 报告画布节点着色 |

#### 11.6.4 中性色(冷灰带绿相,与白卡相配)

| Token | Hex | 用途 |
|---|---|---|
| --tp-text-1 | #1F2833 | 主文本 |
| --tp-text-2 | #5F6B76 | 次要文本/表头 |
| --tp-text-3 | #8A949E | 辅助/占位符 |
| --tp-text-4 | #B4BBC2 | 禁用 |
| --tp-bg-layout | #F6F8F7 | 页面底 |
| --tp-bg-container | #FFFFFF | 卡片/抽屉/表格 |
| --tp-bg-hover | #F2F6F4 | 行悬停 |
| --tp-bg-selected | #EAF6F1 | 选中行(附左 3px primary-600 竖条) |
| --tp-split | #EBEEF0 | 分割线 |
| --tp-border | #E2E6E9 | 输入框/卡片描边 |
| --tp-border-hover | #C4CBD1 | 悬停描边 |
| --tp-mask | rgba(31,40,51,.45) | 模态遮罩 |

#### 11.6.5 数据可视化色板(ECharts 固定顺序)

#2BA47D, #5B8FF9, #9270CA, #D48806, #47A861, #13A8A8, #D3564F, #8B8E94(8 色循环;通过率折线恒用 #2BA47D,失败柱恒用 #D3564F)。

#### 11.6.6 字体 / 间距 / 圆角 / 阴影 / 动效

- 字体:-apple-system, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei";等宽:JetBrains Mono, Consolas(方法徽标/耗时/JSON 编辑器统一用等宽数字 tabular-nums)。
- 字号:12 辅助 / 13 表格正文 / 14 全局基准 / 16 区块标题 / 20 页标题 / 24 统计卡数值(600 字重)。行高 1.5715。
- 间距 4px 网格:4/8/12/16/24/32;卡片 padding 20,页面 padding 24,表单项 gap 16,区块 gap 24。
- 圆角:控件 6,卡片/抽屉/模态 8,浮层 10,胶囊 999。
- 阴影:S1 0 1px 2px rgba(16,24,40,.05) 卡片|S2 0 4px 12px rgba(16,24,40,.08) 下拉/浮层|S3 0 12px 32px rgba(16,24,40,.14) 抽屉/模态。全局禁用多层阴影堆叠。
- 动效:控件反馈 120ms;面板进出 240ms ease-out;Agent 抽屉 360ms cubic-bezier(.25,.8,.25,1);运行中节点呼吸 1.2s 循环(opacity .55↔1)。全部尊重 prefers-reduced-motion(动效降级为透明度直切)。
- 使用红线(防丑条款):每屏主色实底按钮 ≤1;饱和色禁止大面积铺;标签永远浅底深字;表格行不用斑马纹(用 hover 与分割线);图标一律 Lucide 1.6px 描边线性风,禁止 emoji 混入 UI。

### 11.7 布局网格与尺寸规范

#### 11.7.1 全局框架

| 区域 | 尺寸规则 |
|---|---|
| TopBar | 高 56;白底 S1;左 Logo 区 208(与侧栏对齐);项目切换下拉 min-w 240;全局搜索 w 280(Ctrl+K 徽标内嵌);右侧图标组 24px/间距 16 |
| 侧栏 | 宽 208(收起 56);菜单项高 40,16 圆角内边距 8;选中=浅底 primary-50 + 左 3px 主色条;二级缩进 16,分组标题 12 灰字 |
| 内容区 | bg-layout,padding 24;页头高 64 吸顶(面包屑+标题 20/600+页面级操作右对齐);最大内容宽 1600(表格页通铺) |
| 断点 | ≥1600 标准;1280~1599 树 208→180、右面板 360→320;<1280 侧栏自动收起、树变抽屉列、详情抽屉全宽。Tauri 壳默认 1440×900,最小 1280×768;支持浏览器=Chromium 内核(Chrome/Edge)最新两个大版本,不支持 Safari/IE |
| Agent 悬浮球 | 48×48 圆形,bottom 24 / right 24,Pilot 竹青底白图标,红点 8px;收起态抽屉露 40px 边缘把手 |

#### 11.7.2 标准列表页(全平台密度基准)

```
页头 64
筛选栏 48   [搜索 240][视图选择器][高级搜索]        工具按钮右对齐
主体 flex   [树 208 | 拖拽把手 8 | 表格区 flex]
表格区      [批量浮条 48(勾选时覆盖筛选栏)] / 表体 / 分页 48 吸底
```

表格:表头 40(bg #FAFBFB,12 灰);行高 48(compact 40);列宽:名称 min 240 flex、方法 72、状态 96、优先级 80、标签 160、人 120、时间 160、操作 88 固定右(悬停显形);横向溢出左固定名称列。树:节点 36、缩进 20、头部=标题+新建+折叠。
详情抽屉:min(70vw, 1000),头 56(标题+状态+收藏)/体 padding 24 分区块/底栏 56 右对齐按钮组(主按钮最右);未保存关闭 → 确认框。

#### 11.7.3 场景编排页(三栏工作台)

```
[资产树 240 | 画布 flex | 属性面板 360(收起为 40 边缘签)]
[底部调试抽屉:默认高 300,可拖 120~60vh,可全屏遮罩]
```

画布节点:步骤 224×64(图标+两行文字),循环/IF 容器头 40 + 子区 padding 16 底色 2% 主色,节点间垂直距 48;缩放 0.5~2.0,进页自动适配;小地图 120×80 右下;节点左边条 4px = 域色。属性面板:Tabs(配置/断言/高级),表单 label 上置。

#### 11.7.4 其余关键布局

- **设备卡片墙**:grid minmax(280,1fr) gap 16;卡 168 高,左状态带 4px,hover 浮 S2 + 底部操作条显形。
- **报告详情**:步骤树 300 | 只读画布 flex | 步骤详情 420;截图灯箱全屏遮罩,S3。
- **Agent 抽屉**:宽 clamp(720px, 55vw, 1100px) 高全视口;**默认无遮罩**(可边看边点主页面),可"钉住"切有遮罩模式;左会话列表 224 可折叠;右侧功能侧栏:图标轨 40 + 面板 320(全屏 420,§11.4.36);事件卡:思考折叠 2 行起、工具卡 max-h 320 内滚、候选卡通栏;输入区 min 88 自动扩至 200;状态条 28。
- **模型/MCP 设置**:卡片 grid minmax(320,1fr);编辑走抽屉 640。
- 模态规格:480 确认 / 640 表单 / 960 导入预览(大表)。

#### 11.7.5 反馈与空态

加载中 <300ms 不显 spinner(防闪);表格骨架屏;错误 toast 右上 3s(可复制详情);表单错误落字段下方 12 号红字;空态=80px 线稿插画(绿灰) + 一句话 + 主按钮 + "让 Pilot 生成"描边钮;权限空页=锁形插画 + 所需权限名文案。

### 11.8 桌面版预案(业主关切)

桌面化 = Tauri 2 壳加载同一前端(直连服务器 URL 或内嵌静态资源),**Agent/MCP/工具调用全部留在 Python 后端,零 Node 重写**。官方 MCP Python SDK 覆盖客户端全部能力;第三方以 npx 分发的 MCP server 由服务器端 Node 运行时拉起(部署依赖,不是代码语言)。远期若需"离线单机版":PyInstaller 打包后端为 sidecar 随安装包分发(代价:体积与自动更新,出现真需求再立项)。

---

## 12. API 与事件协议约定

### 12.1 REST

- 前缀 /api/v1;资源复数 + 动作子资源(run/draft/debug);错误包 {code, message, details};游标分页 {items, next_cursor}。
- OpenAPI 文档站内置(/api/docs);**前端类型由 openapi.json 代码生成**(openapi-typescript),前后端契约不手写。

### 12.2 SSE 与卡片协议

- GET /api/v1/events/agent/{sessionId}?cursor=…(断线重连按事件 seq 续传)
- GET /api/v1/events/run/{runId}?cursor=…
- 事件信封:{seq, ts, type, payload};type:agent 事件见 §9.3 状态机,tool_result.payload.ui ∈ {null, "card", "approval", "diff"};card.payload.kind ∈ {scenario_plans, report_summary, device_status, generic}。
- 审批回传:POST /api/v1/agent/runs/{runId}/approval {tool_call_id, decision, comment?}。

### 12.3 Agent 主接口

POST /api/v1/agent/sessions(建会话:project_id, model_id?, thinking?, mode?)
POST /api/v1/agent/sessions/{id}/messages {content, attachments[]} → 202(事件走 SSE)
POST .../interrupt;GET .../messages(历史重放);命令(/compact 等)即普通消息文本,后端命令解析器拦截。

### 12.4 开放 API 与 service token(二期)

- 项目级 **API token**:绑定权限点子集+有效期+速率限制,供 CI/发布平台触发场景、拉报告摘要;token 的创建与使用全落审计(入口=token)。
- 一期先用 run-hook(§6.5 一次性 token)过渡;二期统一进 token 体系,hook 保留为轻量入口。

---

## 13. 实施计划(单人 + AI 协作版,D7)

排布原则:每个小步以"可演示、可回归"收尾;先纵切贯通架构金线,再横向堆模块;Playwright 是业主强项,UI 模块放在能由业主亲自把关的位置。**预估(日历月,AI 高产出前提):一期 5~7 个月,二期 2~3 个月;一期结束平台即可日常使用,不等 Agent。**

### S0 金线纵切(1~2 周)
仓库脚手架、生产 compose 栈(可选交付物,本机开发不依赖)、CI、登录+项目+环境 CRUD、**service 装饰器双注册**(HTTP + OpenAPI + Agent 工具 schema + 权限位 + 审计)在一个真实小 service 上全线打通;Agent 循环的"假模型回放"测试骨架同步建立。→ 用最小成本证明"工具化单体"架构成立,这是全蓝图最大风险,必须最先做。

### 一期(平台核心)
- **1A(4~6 周)** IAM/项目/成员/角色模板/数据权限;环境与全局配置;API 模块/接口/用例/数据集;单接口调试;简易运行记录(列表可看,详情后补)。
- **1B(4~6 周)** 步骤树协议(§7.4)+ 执行引擎(API 类 handler)+ 场景画布(全逻辑控件)+ SSE 实时进度 + 报告中心 + 失败单步重跑。
- **1C(3~5 周)** UI 测试:元素库 + 命令列表编辑器 + Playwright 执行 + 失败截图。**业主强项区,深度参与验收。**
- **1D(3~5 周)** ADB:WiFi 设备管理 + 心跳 + 设备锁 + 步骤编辑器 + uiautomator2 控件操作 + 截图制品。**1D 末达成混合场景端到端 DoD。**
- **1E(2~3 周)** 定时 + 通知渠道 + 工作台 + 审计查询 + 导入(OpenAPI/Swagger/Postman)+ 导出备份 + 模型配置中心(含出厂种子 §6.8)。
- **1F(1~2 周,与 1E 并行)** Agent 只读预览:ReAct 循环 + 逐步事件流 + 全部读工具 + PLAN 模式 + 候选场景卡片(payload 自包含,保存按钮提示"二期开放")。

一期 DoD:§1.5 判据第 1 条;混合场景(API+UI+ADB)执行→报告→定时→通知全链路;权限矩阵测试(4 角色×主要页面/接口);SSE 断线重连不丢步;对 Agent 说"创建一个 XX 测试"能出候选卡片。

### 二期(Agent 全能力,2~3 个月)
写/破坏性工具与三档权限模式 + 审批门、scenario_draft 落库与草稿迭代闭环、MCP(stdio+http 各验收一个)、Skills、/compact 与命令全集、上下文自动压缩、执行类工具(run_scenario/run_case)与报告摘要卡、图片输入、进程重启后 WAIT_APPROVAL 会话恢复、版本历史 UI。DoD:§1.5 判据 2/3;审批全覆盖审计;kill -9 Web 进程可恢复。

### 三期(长尾,按需拉动,不设 deadline)
性能测试(JMeter)、服务 Mock、功能用例库+评审、缺陷管理、工作空间/组织三级、scrcpy 投屏、SSO、PDF 导出、深色模式、Tauri 桌面壳、**MeterSphere 互导与存量迁移(业主:后期再做)**、SQL 步骤评估、逐页对标 MS 打磨;Pilot 会话导出(HTML/MD,含事件回放);执行数据分表评估(明细总量过亿时再启动)。

### 单人 + AI 作业纪律(防翻车条款)

1. 每个小步合并前必须有业主能亲手跑的演示路径 + E2E 冒烟;业主验收行为而非逐行读码,但 AI 的 diff 自审清单留档。
2. 不引入未论证的重依赖;新增第三方库先过 §5 清单评审("AI 与业主能否共同维护它")。
3. 每小步打 git tag;数据库迁移必须带 down 脚本。
4. **UI 验收基线(业主已定)**:参考 MeterSphere v3 布局同构度,逐页按 §11.4 草图走查;无公司视觉规范,§11.6/§11.7 即规范。走查有分歧时直接开本机源码 `D:\item\metersphere\frontend\src\views\**` 对照真实交互(2026-11-19 起可用,见 §0 补充)。

---

## 14. 质量保障

- 后端:pytest(+asyncio),service 层单测;执行引擎对 handler 全 kind 表驱动测试;权限矩阵快照测试(每权限位至少一例 403/放行);MySQL/Redis 集成测试连**本机启动的实例**(2026-11-19 修订:不再用 testcontainers 起临时容器;CI 里由 Actions 自带 service 提供同一版本的 MySQL/Redis,连接串走 env 覆盖)。
- 执行核自测:内置"沙盒靶场"服务(可控 echo/delay/错误接口 + 假设备 fixture)供 CI。
- 前端:Vitest 组件测(画布步骤树序列化/反序列化必测往返一致);Playwright E2E 覆盖三条金路径(建接口→场景→执行 / UI / ADB 挂 mock 设备)/Agent 事件流渲染(mock SSE)。
- Agent:循环用"脚本化假模型"(回放录制的事件序列)测事件/审批/压缩/中断;真模型冒烟测试放 nightly,不进 PR 门禁。
- CI:ruff+mypy+pytest+前端 lint/test/build 全绿才合主干。

---

## 15. 我的裁量清单(D6 汇总,业主阅读时重点核对)

1. 队列选 Celery(非 ARQ);Beat 用自研 DB Scheduler。
2. Agent 循环自研,不用 LangChain 系框架。
3. 画布 React Flow + elkjs;UI 步骤/ADB 步骤用"列表编辑器",只有场景用画布(降低一期风险,UI 用例本身是线性脚本,列表比画布好用——与 MeterSphere 一致)。
4. 实时通道统一 SSE,不引入 WebSocket。
5. 开发环境也强制 MySQL 8(**本机实例即可,不要求 Docker**),禁 SQLite 双轨(D8;2026-11-19 修订:业主取消容器硬性要求,各种测试都在本机启动的软件上跑)。
5b. 语义检索走 Qdrant+embedding,关键词检索走 MySQL FULLTEXT ngram;RAG 可整体关闭降级纯关键词。
6. 场景步骤树 JSON 为"有序数组语义",画布坐标与执行语义解耦(§7.4)。
7. 权限位字符串注册表为唯一鉴权真相(代码即文档,启动同步入库)。
8. MCP 工具默认按"写"对待(保守审批)。
9. 制品本地磁盘存储起步,接口层抽象(预留 S3 驱动)。
10. 无权限的工具对模型不可见(而非运行时才拒绝)。

## 16. 开放问题(2026-11-13 业主全部答复,已回写正文,结案)

1. 人力:业主一人 + AI 协作,熟悉 Playwright → §13 按单人节奏重排;Celery/SQLAlchemy/React 等由 AI 主写,业主按行为验收(§13 纪律 1)。
2. ADB:**仅 WiFi 无线调试**(D2 修订);uiautomator2 经 WiFi ADB 部署,预设退路 dump 轮询(§6.4)。
3. 模型:出厂种子 fundgpt-coder-next @ 127.0.0.1:9000/v1(OpenAI-compatible),默认思考 medium,预算不限;key 走 env 不入仓库(§6.8)。
4. 存量迁移:暂不做,列三期(§13)。
5. 资产量级:约 100 项目 × 平均 200~300 接口,峰值单项目 1000+,总量约 2.5 万接口 → pg_trgm + 项目域复合索引成立(§9.2),执行引擎与报告列表按此量级压测。(D8 修订:检索实现改为 MySQL FULLTEXT ngram + Qdrant 混合,量级结论不变)
6. UI 基线:参考 MeterSphere v3,按 §11.4 草图走查;暂无视觉规范(§13 纪律 4)。
7. 安全评审:暂无 → stdio MCP = 管理员权限 + 全量审计,不做容器隔离(§9.8)。

## 17. 评审记录

- 2026-11-13 builder check(全新子代理通读 775 行初稿)提出 12 问。分流:5 项当场按裁量拍定并回写正文——工具可见性分层(§9.2)、一期候选卡片 payload 自包含且 scenario_draft 推二期(§13)、步骤树纯树语义与一期 kind 白名单(§7.4)、数据集行驱动执行语义(§8.6)、SQL 步骤不做仅预留环境字段(§4.2)+ 检索 pg_trgm(§9.2);另 MCP/配置治理默认值(§9.8)。其余 7 项为业主事实/偏好问题,列入 §16。未发现蓝图外矛盾。
- 2026-11-13 业主答复 §16 全部 7 项(一人+AI/WiFi-only/种子模型 fundgpt-coder-next/迁移后置/百项目 2.5 万接口/参考 MS v3/无安全评审)→ 回写 D2、D7、§3.1/3.3、§6.4、§6.8、§13(重排单人+S0 金线节奏)、§16 结案。文档进入待批准状态。
- 2026-11-13 业主意见二:『配色、布局再写详细』→ §11.6 重写为完整色彩 Token 体系(主色阶/功能色/域色/中性色/字体间距阴影动效/防丑红线),新增 §11.7 布局网格与尺寸规范(框架尺寸表/列表页密度基准/画布三栏/抽屉与卡片规格);桌面预案顺延 §11.8。
- 2026-11-13 业主意见三:『像 11.1~11.4 那样给每个前端功能画布局草图』→ §11.4 扩为全套草图(11.4.1~11.4.29,29 张,覆盖全部页面与全局组件),实施按图施工。
- 2026-11-13 业主意见四:『调度/Agent 流程/消息展示/权限·模型·思考·发送按钮·目标计划列表画清楚』→ 新增 §8.7 调度全景(四泳道)、§9.9 流程四图(回合状态机/事件重放/compact/组装时序)、§11.4.30~11.4.35(头部三选择器/事件卡片全套/输入区状态机/目标计划列表/审批链路/权限双层门)。
- 2026-11-13 业主意见五(D8):数据库 MySQL 8 替代 PG;新增 Qdrant;RAG 需向量模型配置 → 全文 JSONB→JSON、compose/泳道图/选型表/裁量清单改写,§4.8 模型表增 model_type/embed 字段,§6.8/§11.4.23/§11.4.28 管理面联动,新增 §9.10 资产检索与 RAG。
- 2026-11-13 业主意见六:『抽屉右上/右侧要有任务清单/产物区域,像现代编程 Agent』→ 新增 §11.4.36 功能侧栏(图标轨40+面板320,✅任务/📦产物/🔍引用/⚡监控,TOOL_RESULT.produced 协议)+ §11.4.37 打扰规则;11.3/11.4.33/11.7.4/§9.2 联动更新。
- 2026-11-13 终稿自查(业主问"还有什么要补充"):补 9 项——UTC 存储+Asia/Shanghai 展示且一期仅中文、首次启动 bootstrap+demo 项目(联动靶场)、非场景资产编辑并发语义、§6.10 平台自诊/备份/发布/告警、§8.8 执行数据生命周期、§9.11 Agent 运行护栏(回合上限/配额/熔断/幂等/TTL)、系统提示平台人格可管理、§12.4 service token(CI 集成)、浏览器矩阵与三期备忘(会话导出/分表评估)。
- 2026-11-13 业主意见七:『稍微设计好点』→ §11.3 重写为九区编号+结构框图+消息流详图三层递进;§11.4.36 增视觉构件规格(轨道五态/面板头/行解剖/hover速览卡/分组chips/空态/键盘)。
- 2026-11-13 业主意见:『前端功能展示不够详细,需对标 MeterSphere』→ 新增 §11.5 页面级详细设计(对标 MS v3 交互约定 + 差异表 + 9 组页面清单 + Agent 触点表);原视觉规范/桌面预案顺延为 §11.6/§11.7。
- 2026-11-19 业主意见八(两件事):① 『MeterSphere 源码已在 `D:\item\metersphere`,带 git 版本可切换查看,写进 docs』→ 新增参考文档 `docs/2026-11-19-metersphere-source-and-local-testing.md`(源码位置/版本/结构地图/版本切换/无 Docker 直跑方法/复刻用法与 GPLv3 边界),本文 §0 加「对标对象现在有本机源码可查」横幅、§11.5 对标原则点明实物路径、§13 纪律 4 补「走查有分歧看源码」。② 『去掉 docs 对 Docker 的硬性要求,各种测试都在本机启动软件测试』→ §3.3 开发形态改「本机 MySQL/Redis 实例,不要求 Docker」、§13 S0 条目里 compose 降为可选交付物、§14 集成测试由 testcontainers 改「连本机实例」、§15-5 裁量项改为「本机实例即可,不要求 Docker」;**「必须 MySQL 8、禁 SQLite 双轨」与容器无关,原样保留**。联动:s0 计划 T1/T2/T12、五份演示手册 §0、README 最短启动。
