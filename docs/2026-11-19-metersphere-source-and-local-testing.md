# MeterSphere 本机源码(复刻参考基线)与「无 Docker、全本机」测试口径

> 建档:2026-11-19。本文是**取证型参考文档**:所有路径、版本、端口、命令都在这台机器上实地核过。
> 用途有两条:
> ① 本项目对标 MeterSphere 做复刻(蓝图 §0「按 MeterSphere 功能全集的蓝图设计」、§13 纪律 4「UI 验收基线参考 MeterSphere v3」、§11.5「页面级详细设计对标 MS v3」)——以前只能照 §11.4/§11.5 的草图施工,**现在有源码、有 git 版本可切**,可以逐页逐接口逐项对照。
> ② 把 docs 里「MySQL/Redis 必须走 Docker」的硬性要求全部拆掉:各种测试一律在本机启动的软件上跑(改动清单见 §5)。

---

## 1. 源码在哪、是什么版本

| 项 | 值(实测) |
| --- | --- |
| 本地路径 | `D:\item\metersphere` |
| 远端 | `https://github.com/metersphere/metersphere.git`(`git remote -v`) |
| 当前分支 | `v3.x`(`origin/HEAD` 也指它) |
| HEAD | `f1565d99a03dfa54935eabcaab5da3473b6d0744` · 2026-10-27 · `fix: template resource thread local` |
| 工作树 | 干净(`git status --porcelain` 空) |
| tag 总数 | 187(`git tag` 计数) |
| 分支覆盖 | `v1.0`~`v1.20+`、`v2.x`、`v3.x`、`dev`,以及 `pr@v3.x@…` 的 PR 分支 |
| LTS tag | v1 线 `v1.10.x-lts` … ;v3 线 `v3.6.0-lts` ~ `v3.6.10-lts`;最新普通 tag `v3.6.10-lts` |
| 许可证 | **GPLv3**(`LICENSE` 第 1 行)+ 附加条款 |

**这一条纪律先说死**:MS 是 GPLv3,本项目是自研闭源方向的代码库。**只读参考,不得复制粘贴源码文件、不得引入 MS 的 jar/npm 包**;要的是「功能与交互的应然行为」和「数据结构长什么样」,实现自己写。§1.1 的「为什么自研而不改 MS」结论不变(蓝图 `:23`)。

### 1.1 怎么切版本

```bash
cd D:/item/metersphere
git tag | sort -V                 # 187 个版本
git switch v3.6.10-lts            # 切到某个发布点(会进 detached HEAD)
git switch -                      # 回 v3.x
git log --oneline v3.0.0..v3.6.10-lts -- backend/services/api-test | head -50   # 看某模块的演进
git diff v3.0.0 v3.6.10-lts -- frontend/src/views/api-test | less                # 看某页面两版之间怎么变的
```

**动手切之前先 `git status` 确认干净**(现在就是干净的)。本文写的行号/文件清单以 **v3.x@f1565d99a0** 为准;切了版本再引用就要重新取证。

---

## 2. 代码结构地图(v3.x 实测)

### 2.1 后端(Java 21 / Spring Boot 3.5.7 / MyBatis / Flyway)

根 `pom.xml`:`<java.version>21</java.version>`、parent `spring-boot-starter-parent:3.5.7`、`<revision>3.x</revision>`。共 **2706 个 `.java`**。

```
D:\item\metersphere
├── pom.xml                    # 父 POM(java21/spring3.5.7/版本属性都在这)
├── build.md                   # 官方构建两步:mvnw install -N → mvnw clean package
├── backend/
│   ├── app/                   # 启动模块 io.metersphere.Application + 运行时配置
│   │   └── src/main/resources/commons.properties   # ★ 端口/中间件/开关都在这份
│   ├── framework/
│   │   ├── domain/            # 实体 + ★ Flyway 迁移 SQL(migration/{3.0.0..3.6.0}/{ddl,dml})
│   │   ├── sdk/               # ★ 权限位常量、枚举、公共注解(全体服务依赖它)
│   │   ├── provider/ sdk/ plugin/ ai-engine/
│   └── services/              # ★ 业务服务,一个目录一个模块
│       ├── api-test/          (28 个 *Controller.java)
│       ├── case-management/   (15)
│       ├── test-plan/         (13)
│       ├── project-management/(22)
│       ├── system-setting/    (32)
│       ├── dashboard/         (3)
│       └── bug-management/    (6)
└── frontend/                  # Vue 3 + Vite + Arco Design(655 个 .vue)
```

### 2.2 前端

```
frontend/src/
├── views/  api-test / case-management / test-plan / bug-management /
│           project-management / setting / workbench / taskCenter / login / base / exception
├── router/routes/modules/  apiTest.ts caseManagement.ts testPlan.ts bugManagement.ts
│                           projectManagement.ts setting.ts workbench.ts share.ts fullPage.ts
├── api/        # 按模块分目录的接口封装(axios)
├── locale/     # zh-CN / en-US —— 两份都要改,MS 是双语,本项目一期只中文(§11.6)
├── components/ store/ hooks/ enums/ directive/ theme/ config/
└── package.json   # name=meter-sphere version=3.1.0;UI 库 @arco-design/web-vue
```

**对标本项目时的映射关系**(我们 `web/src/pages/*` ↔ MS `frontend/src/views/*`):

| 我们的页面 | MS 参照位置 |
| --- | --- |
| `api.tsx`(接口定义/用例) | `views/api-test/management` + `ApiDefinitionController`/`ApiTestCaseController` |
| `scene*.tsx`(场景画布) | `views/api-test/scenario` + `ApiScenarioController`(MS 也是列表+树,画布语义看 §7.4) |
| `datasets.tsx` | `views/api-test/management` 数据集 + 用例数据集绑定 |
| `reports.tsx`/`reportDetail.tsx` | `views/api-test/report` + `ApiReportController`/`ApiScenarioReportController` |
| `uiCases/adbCases`(MS **没有**) | 无对应——MS 全仓 `grep -rli uiautomator` **零命中**,ADB 是我们的原创项 |
| `notifyChannels.tsx` | `system-setting` 的通知组(`NotificationController` 一族) |
| `workbench.tsx` | `views/workbench` + `dashboard` 服务 |
| 权限/角色 | `GlobalUserRoleController`/`OrganizationUserRoleController` + `sdk/constants/PermissionConstants.java` |

### 2.3 复刻时真正值钱的四个「字典」

1. **权限位全集**:`backend/framework/sdk/src/main/java/io/metersphere/sdk/constants/PermissionConstants.java`
   —— 蓝图 §10 说权限位注册表是唯一鉴权真相、启动同步入库;MS 这份常量表就是「功能全集」的权威清单,我们的 `app/core/permissions.py` 覆盖面够不够,拿它对表。
2. **数据结构**:`backend/framework/domain/src/main/resources/migration/3.0.0/ddl/*.sql`
   (`V3.0.0_1__init.sql`、`_2__sdk_ddl`、`_3__test_plan`、`_4__project_management`、`_5__api_test`、`_6__qrtz_schema`、`_7__bug_management`、`_10__functional_case`、`_11__system_setting`),后续版本增量在 `migration/3.0.1 … 3.6.0/{ddl,dml}`。**这是 MySQL 建表语句,可以直接读**——我们的 `backend/migrations/versions/*` 字段留没留全,照它核(注意 §1.1 的许可纪律:读语义,不抄文件)。
3. **枚举语义**:`sdk/constants/` 下 `ExecStatus`、`ApiReportType`、`CaseType`、`MsAssertionCondition`、`HttpMethodConstants`、`KafkaTopicConstants`…——断言类型/执行状态这些正是我们 §7 协议里手写的枚举,MS 版可作第二只眼(呼应第 29 轮「同一枚举多端镜像」那条轴)。
4. **接口面**:`backend/services/*/controller/**Controller.java`(119 个)——每个页面背后有哪些端点、参数怎么分组,拿它核我们的路由有没有漏。

---

## 3. 本机怎么把 MeterSphere 跑起来(不装 Docker)

蓝图 §3.3 的 Windows 开发形态本来就不是 all-in-one 容器;MS 这侧同理:**它的依赖在这台机器上都能直装**,官方 Docker 只是打包方式,不是硬前提。

### 3.1 依赖对照

| MS 需要 | 这台机器 | 结论 |
| --- | --- | --- |
| JDK 21 | `java -version` = 21.0.10 LTS ✅(注意 `JAVA_HOME` 指 `jdk-17`,直跑前要么改指 21,要么用 `C:\Program Files\Java\jdk-21\bin\java.exe` 显式起) | 直装可用 |
| Maven | 仓库自带 `mvnw` / `mvnw.cmd` | 不用装 |
| MySQL 8 | 本机服务 `MySQL84` = 8.4.4,监听 3306(`net start` / `mysql --version`) | ✅ 直连 |
| Redis | 本机装 `C:\Program Files\Redis`,密码见 `backend/.env` | ✅ 直连 |
| Kafka | 运行时配置 `commons.properties` 里 `spring.kafka.bootstrap-servers=${kafka.bootstrap-servers}` 是占位,**必须由外部 properties 注入**;`KafkaTemplate` 只用在异步导出/插件/任务中心(`ExportTaskManager`、`PluginService`、`ApiTaskCenterService`) | 需要装,或按 §3.3 指到别处 |
| MinIO(文件存储) | 未装 | 见 §3.3 |
| JMeter 引擎 | 未装;`jmeter.home=/opt/jmeter` 是 Linux 路径 | 见 §3.3 |

### 3.2 构建(两步,`build.md` 原文)

```bash
cd D:/item/metersphere
./mvnw install -N                                             # 父 POM 进本地仓库
./mvnw clean install -DskipTests -DskipAntRunForJenkins --file backend/pom.xml
./mvnw clean package                                          # 整体打包
cd frontend && pnpm install && pnpm build                     # 前端产物(本机 Node 24 + pnpm 10 可用)
```

### 3.3 直跑要补的注入点

`backend/app/src/main/resources/commons.properties` **不含** datasource 与中间件地址,全靠外部注入。直跑时在启动目录放一份 `application.properties`(或用 `-D`/环境变量),最少给这些:

```properties
spring.datasource.url=jdbc:mysql://127.0.0.1:3306/metersphere?autoReconnect=false&useUnicode=true&characterEncoding=UTF-8&characterSetResults=UTF-8&zeroDateTimeBehavior=convertToNull&allowPublicKeyRetrieval=true&useSSL=false&sessionVariables=sql_mode='STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
spring.datasource.username=root
spring.datasource.password=<本机 root 密码>
spring.data.redis.host=127.0.0.1
spring.data.redis.port=6379
spring.data.redis.password=<你的口令>
kafka.bootstrap-servers=127.0.0.1:9092
jmeter.home=D:/opt/jmeter            # Windows 下换成真实目录
```

要点(都是实读配置得出的,不是猜的):

- **建表不用管**:`spring.flyway.enabled=true` + `locations=classpath:migration`,连上一个空库 `metersphere` 就会自动建表,表版本记在 `metersphere_version`。
- **端口**:`server.port=8081`、`management.server.port=7071`。8081 **落在本机 Hyper-V 保留段风险区**,起不来时按 1A 手册 §1 先跑 `netsh int ipv4 show excludedportrange protocol=tcp`,换 `--server.port=8381` 之类。
- **日志目录**:`logging.file.path=/opt/metersphere/logs/metersphere` 是 Linux 路径,Windows 要覆盖成本地目录,否则日志落不到地方。
- **Redisson**:`spring.redis.redisson.file=file:/opt/metersphere/conf/redisson.yml` 也是 Linux 绝对路径,同样要覆盖。
- **前端**:dev 期改 `frontend/.env.development` 的 `VITE_DEV_DOMAIN` 指到后端(仓库里现值是 `http://172.16.200.18:8081/`,**那是别人的机器,必须先改掉**);prod 走 `frontend/nginx.conf`(仅生产用,本机 `pnpm dev` 不需要 nginx)。
- **Kafka/MinIO/JMeter 这三样是 MS 的运行时依赖**(README 自述技术栈:MySQL/Kafka/MinIO/Redis + JMeter)。本机直装 Kafka+MinIO 可行;不想在 Windows 上折腾 Kafka,就用 **WSL2/Docker Desktop 只补这两件**、其余全走本机(蓝图 §3.3 的 Windows 形态本就是直跑+外部依赖)——但这条**只在「跑起来对照 MS 行为」时成立,和本项目的测试无关**:本项目测试一个 MS 组件都不需要(§4)。

---

## 4. 本项目测试:统一在本机启动的软件上跑

### 4.1 本机基线(2026-11-19 实测)

| 件 | 位置/取法 | 连接串 |
| --- | --- | --- |
| MySQL 8.4.4 | 本机 Windows 服务 `MySQL84`(自动启动) | `mysql+asyncmy://root:<密码>@127.0.0.1:3306/testpilot?charset=utf8mb4` |
| Redis | `C:\Program Files\Redis`(`redis-server.exe` / `redis-cli.exe`) | `redis://:<你的口令>@127.0.0.1:6379/6` |
| Python 3.12 | `backend/.venv` | — |
| Node + pnpm | Node 24 / pnpm 10 | — |
| Chromium | `pnpm exec playwright install chromium` | — |
| 被测靶场 | `backend/scripts/target_app.py`(127.0.0.1:9999) | — |

**Redis 的两种本机起法**(第 2 条已实测通):

```powershell
# A. Windows 服务
net start Redis
# B. 前台直起(实测输出 "ready to accept connections on port 6379",redis-cli PONG)
& "C:\Program Files\Redis\redis-server.exe" --port 6379 --requirepass <你的口令> --bind 127.0.0.1
```

> 踩过的坑(如实记):`net start Redis` 报「服务已成功启动」但 6379 没人监听——服务的 `redis.windows-service.conf` 是 `port 6379 / requirepass <你的口令>`,而那次 `Get-Process redis-server` 有 PID、`netstat` 零监听(**报告成功 ≠ 真在监听**,与「工具假绿」同族)。所以下面这类判定只认监听端口和 `redis-cli ping`,不认服务状态文案。

### 4.2 统一口径(替代原来「MySQL 8 仅经 Docker」那条)

1. **MySQL 8 / Redis 7 必须是本机启动的实例**,连接串一律 `127.0.0.1`。不再要求 Docker,也不再默认任何远端 IP。
2. **数据库仍是 MySQL 8,禁 SQLite**——这条和「用不用 Docker」是两件事,保留(§13 纪律 5 只改前半句)。
3. 测试库名固定 `testpilot_test`(pytest 每轮另建 `testpilot_t<HHMMSS>` schema 隔离)、`testpilot_e2e`(Playwright);库由 `alembic upgrade head` 现建,不需要预先准备。
4. **本机路径实测证据**:`backend/tests/test_health.py` + `test_auth.py` 用上面两条连接串跑 → **8 passed in 17.12s**(2026-11-19,`TP_DB_URL`/`TP_REDIS_URL` 走环境变量覆盖,全默认值文件未动)。全量套件的复跑结论回填在本文末「回填」段。
5. `docker-compose.yml` **留在仓库**,定位降级为「生产/Linux 部署可选形态」(它本来只被生产文档引用,D98 仍待裁);任何人**不得**把它当跑测试的前提。
6. `.github/workflows/ci.yml` 的 `services: mysql/redis` 不动——那是 CI 自带的服务容器,本机跑测试与它无关。

### 4.3 环境覆盖写法

仓库里 `conftest.py` / `playwright.config.ts` 的内置默认值仍是旧远端 `db.internal.test`,**但都是 env 可覆盖**的默认值:

```powershell
# PowerShell
$env:TP_DB_URL       = "mysql+asyncmy://root:<密码>@127.0.0.1:3306/testpilot?charset=utf8mb4"
$env:TP_REDIS_URL    = "redis://:<你的口令>@127.0.0.1:6379/6"
# pytest / e2e 用的库名由 conftest 自己换 schema;e2e 另用 TP_E2E_DB_URL / TP_E2E_REDIS_URL
$env:TP_E2E_DB_URL   = "mysql+asyncmy://root:<密码>@127.0.0.1:3306/testpilot_e2e?charset=utf8mb4"
$env:TP_E2E_REDIS_URL= "redis://:<你的口令>@127.0.0.1:6379/6"
```

```bash
# bash / CI 之外的一键本机跑
TP_DB_URL="mysql+asyncmy://root:<密码>@127.0.0.1:3306/testpilot?charset=utf8mb4" \
TP_REDIS_URL="redis://:<你的口令>@127.0.0.1:6379/6" \
  backend/.venv/Scripts/python.exe -m pytest -q
```

---

## 5. 本次改动清单(Docker 硬要求拆除)

| 文件 | 原口径 | 现口径 |
| --- | --- | --- |
| `docs/2026-11-13-s0-golden-slice.md` | Global Constraints「MySQL 8 **仅经 Docker**」;Tech Stack `MySQL 8(Docker)`/`Redis 7(Docker)`/`testcontainers`;Task 1 标题「容器基线」+ `docker compose up -d` + `mysqladmin ping` 验收;T2/T12 用 testcontainers 起临时库 | 本机 MySQL 8 + 本机 Redis(127.0.0.1);SQLite 禁令原样保留;compose 降为「生产/Linux 可选形态」;testcontainers → 连本机实例 |
| `docs/2026-11-13-ai-test-platform-design.md` | §3.3「数据库**仍用 Docker 里的** MySQL 8」;§15-5「开发环境也强制 MySQL 8(**Docker**)」;§13 纪律 5;§14「**testcontainers 起 MySQL/Redis/Qdrant** 集成」;§13 S0 条目把 docker-compose 当交付件 | 开发形态 = 本机直装 MySQL/Redis(附本文 §4.1 连接串);Qdrant 保持「RAG 关时不起」;§14 集成测试改「连本机实例」 |
| `README.md` | 最短启动里 `docker compose up -d mysql redis` | 本机起 MySQL 服务 + `redis-server`,compose 那行改成可选注释 |
| `docs/superpowers/plans/README-s0-demo.md` / `README-1a-demo.md` / `README-1b-demo.md` | 前置「或 `docker compose up -d mysql redis`」+ 连网示例 `db.internal.test` | 本机实例 + 本机 IP,并给出 `net start` / 前台直起两条路 |
| `README-1c/1d/1e-demo.md` | 「逐条照 1B/1C 手册 §0 做」(继承 Docker 口径) | **文件一个字没改**——它们的 §0.1 继承句照抄 1B §0,1B §0 已是本机实例口径,继承自然跟上;1D 的 adb、1E 的假接收端口径不变 |
| `docs/superpowers/plans/2026-11-16-1f-agent-metatools-cards.md` | 取证段拿「Qdrant 容器在 docker-compose 里躺着但零客户端」当证据 | **原文不动**(它是当轮取证记录,改了就是篡改证据);只在旁边加一行勘误指向本文 §4.2 |
| `docs/superpowers/plans/2026-11-17-1g-perm-gaps-closeout.md` | 台账里的 D98 行(生产 compose 栈缺 api/worker/nginx)、门禁 ⑧ 环境动作描述 | **不改判**:D98 继续待裁,但注明「compose 已不是测试前提,只影响生产形态裁定」 |
| **本文** | — | 新增:MS 源码位置/版本/结构/直跑方法 + 本机测试口径 |

**不动的三处**(刻意保留,别当漏改):
1. `.github/workflows/ci.yml` 的 `services:` —— GitHub Actions 自带服务容器,本机测试无关。
2. `docker-compose.yml` —— 生产/Linux 可选形态,D98 未裁之前不删不补。
3. `docs/superpowers/plans/2026-11-16-1f-agent-metatools-cards.md:67-70` —— 历史取证原文。

---

## 6. 复刻时拿 MS 源码怎么用最省事

按「差集」的用法排(和本文档库既有的第 N 道差集口径配套):

1. **文案承诺 → 兑现**:MS 每个页面的空态/错误态/确认弹窗文案在 `frontend/src/locale/zh-CN/**`,可以直接读出「同类产品这句话该怎么说」,再核我们对应页面有没有兑现(第十道差集最出活的那一轴)。
2. **接口面 ↔ 页面按钮**:先 `grep` MS 的 controller 找出这个页面真实有哪些写操作,再数我们的页面上有没有等价入口(第 5/11 道差集)。
3. **权限位覆盖表**:`PermissionConstants.java` 全量 vs 我们 `permissions.py` 的位——列出双方差集,再判「是我们的范围外还是漏」(别直接当成缺陷)。
4. **DDL 字段核缺口**:`migration/3.0.0/ddl/V3.0.0_5__api_test.sql` 的字段 ↔ 我们 `api_*` 表,专查「蓝图说一期预留、实际没建」的列。
5. **版本对照**:同一功能在 `v3.0.0` 与 `v3.6.10-lts` 的差异(`git diff`),用来看 MS 自己踩过的坑往哪个方向改——这是**唯一必须用 git 历史**才拿得到的信息,也是这份带版本的 checkout 相对 zip 的的全部价值。

三条边界:
- **GPLv3**:读,不抄(§1)。
- **范围**:MS 有 8 大模块、我们没有的不少(性能测试、Mock、缺陷管理、测试计划、组织三级…)——蓝图 §13 三期清单已定,**别因为源码在手就扩范围**。
- **技术栈**:MS = Java/Spring/Vue/Arco,我们 = Python/FastAPI/React/AntD;它的表名、类名、目录约定都**不要照搬**,只取行为与语义。

---

## 7. 待办 / 未证事项

- 本文只**核实到「构建命令与注入点齐全」**,没有真跑过 MS 后端(那要装 Kafka + MinIO + JMeter,是新环境动作,需业主点头)。装齐后按 §3.2/§3.3 复跑,把结论回填这里。
- `JAVA_HOME` 当前指 `jdk-17`,本机另有 `jdk-21`;`mvnw` 用哪个要显式确认(`mvnw -version` 先看),否则 Spring Boot 3.5.7 会以 class file 61 vs 65 报错。
- 本项目全量后端套件在本机实例上的复跑数字见下方回填;e2e 与前端门禁的本机复跑尚未做。

### 回填

- 2026-11-19:`test_health.py` + `test_auth.py` 本机实例 **8 passed in 17.12s**(§4.2 第 4 条)。
- 2026-11-19 全量后端套件本机复跑:**2 failed / 1254 passed / 1 skipped in 2297.40s(38 分 17 秒)**,
  日志 `.local-fulltest.log`,两条连接串就是 §4.1 那两条(环境变量覆盖,默认值未动)。
  **两条红与本机基础设施无关**:`tests/test_r157_project_scope_coverage.py` 的两条是**静态源码扫描**,
  不碰 DB。它们的哨兵自己报「`inspect.getsource(run_cancel)` 串到了邻居函数」,而 `run_cancel` 所在的
  `app/modules/scenario/services.py` **mtime = 18:26:14,正落在这次跑的窗口(17:56→18:34)里** ⇒
  跑测试期间有源文件被保存,行号错位 ⇒ 这正是本仓已记过账的「gate ① 跑动时改源码会造出像代码缺陷的假红」
  (单文件隔离重跑 **2 passed in 0.76s** 证实)。结论:**本机 MySQL/Redis 承接全量套件零失败**,
  那两条按既有口径判为「跑动期间源码被改」的假红,处置方式是让树静下来重跑,而不是改断言。
