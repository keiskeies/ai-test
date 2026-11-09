# 测试平台设计文档

一个**测试领域的 Claude Code**：TypeScript 全栈，覆盖 API / Web / Android / iOS / 鸿蒙，能力通过 MCP + Skills + 斜杠命令扩展，用例是可编程的 IR（判断/循环/等待/上游输出→下游输入），LLM 多模型可热切换，数据层 MySQL + Qdrant + Redis。

## ⚠ 先读这段

`docs/00`（市场调研）是在**本机无外网**的条件下写的（`WebSearch`/`WebFetch` 均不可用，已复核）。其中**结构性论断可信**（某类产品的架构取舍与共性缺陷），**版本/功能有无/定价/榜单数字不可信**，均标 `[未核实]`。修复办法：换一个支持 tool calling 的模型组 + 开外网，重跑一遍。其余 12 份是设计推导，不依赖外网。

## 文档索引

| 文件 | 讲什么 | 什么时候读 |
|---|---|---|
| `00-市场调研与能力矩阵.md` | 三张竞品矩阵、7 个空白点、10 条可抄设计、11 个坑 | 想知道"为什么要这么做" |
| `01-架构与技术栈.md` | 五层架构、选型与**明确排除项**、数据层与表结构、投屏、P0–P4 | 开工前必读 |
| `02-场景IR设计.md` | **用例的唯一真相源**：节点全集、等待策略、断言三原则、变量作用域、定位阶梯、12 条 lint | 核心，反复读 |
| `03-LLM配置层.md` | Provider/Model/TaskGroup/Binding、八分组档位、预算熔断、安全边界 | 配模型时 |
| `04-P0实施计划.md` | 包结构、M0–M7 与**完成判据**、P0 取舍记录 | 现在就要执行 |
| `05 · 06 · 07` | API / Web UI / ADB 三端深度细节（每份末尾有待确认问题） | 做对应端时 |
| `08-未决问题与假设登记.md` | **全部未决问题 + 已确认答复 + 假设登记 + 建议顺序** | 每轮决策前扫一遍 |
| `09-多目标扩展与平台中立抽象.md` | `TargetAdapter`/`snapshotKind`/`DeviceLease` 三契约、iOS、鸿蒙、压测(IR→k6)、**重排后 P0–P7** | 定架构边界时 |
| `10-视觉类界面与可回放化.md` | canvas/Unity/Flutter 空树怎么办：**模板指纹**让视觉定位可回放 | 碰自绘界面前必读 |
| `11-存量用例迁移.md` | Excel/禅道/Jira → CaseDraft → IR；断言缺失与审校治理；覆盖矩阵 | P1 第一个里程碑 |
| `12-信息架构与页面设计.md` | 导航、26 个页面清单与优先级、4 个 must-nail 流程、Agent 交互、反模式 | 画界面之前 |
| `13-设计系统与视觉语言.md` | 密度/语义色/布局/8 个自研组件/动效预算/token 实现约束 | 写第一行样式之前 |

## 按角色的最短路径

- **要写代码**：`04` → `02` → `01` → `09`§1 → `13`§6
- **要画界面**：`12` → `13` → `02`（编辑器要表达什么）→ `11`§4（审校交互）
- **要定范围**：`08`（尤其 §0 答复与 §1 未决）→ `09` → `10`
- **要说服别人**：`00`§4（空白点）→ `02`§9（三端共享变量空间的终局用例）→ `11`§2.2（断言从资源推导而非 AI 想象）

## 已确认的六项决策

| 决策 | 选择 | 出处 |
|---|---|---|
| 部署形态 | 服务端团队平台（多租户/worker 池/设备租约） | `01` |
| AI 执行权限 | 脚本模式 + Agent 模式**显式切换** | `01`/`02`§1 |
| 用例形态 | **IR 双向同步**：可视化步骤表 ⇄ TS SDK，IR 是唯一真相 | `02`§8 |
| MVP 顺序 | API → Web → ADB | `04` |
| 被测端可改代码 | ✅ 能（testid/resource-id/ValueKey/webview debug/测试 CA） | `08` C1 |
| 界面技术栈 | 原生+RN、Flutter、H5/WebView(含小程序)、Unity-Cocos-canvas **全都在范围内** | `08` C2 |
| 平台范围 | API/Web/Android + **iOS + 鸿蒙 NEXT + 压测** | `08` C3 |
| 存量资产 | 有成堆 Excel/禅道/Jira → 迁移是 P1 首个价值里程碑 | `08` C4 / `11` |
| UI：设计师 | **无设计师，纯工程实现**（品质靠四条工程纪律，`13`§7.1） | `13` U1 |
| UI：形态 | **独立后台系统**，不嵌客户系统（免掉微前端/样式隔离/登录态打通） | `13` U2 |
| UI：密度 | **三档都给，默认紧凑**（13px/32px），切换写个人设置 | `13` U7 |

## 七条贯穿全部设计的原则

1. **AI 在设计期写用例，运行时确定性回放**；Agent 模式产轨迹，轨迹蒸馏成 IR。CI 只跑冻结用例。
2. **一个执行引擎，GUI 只是它的一个视图** —— 引擎禁止 import node 内置模块，这样本地/CI/服务端/GUI 校验必然一致。
3. **IR 是唯一真相**，TS SDK 是它的 builder，不做源码 AST 反解。
4. **每个等待是条件不是时长，每个循环有硬上限，每个断言是独立节点。**
5. **自愈 = 软失败 + 人审 diff**，静默自愈生产"绿色构建点错按钮"。
6. **每个 AI 产物带来源与置信度**（`prompt_hash`/`model_id`/`seed`/`spec_hash`），断言从已导入资源推导而非模型想象。
7. **红绿必须可信**：`skipped`≠`failed`、`error`≠`fail`、`healed` 不算绿、`triaged` 不计入通过率、`assertLlm` 不进门禁。

## 当前状态

**设计**：14 份文档（`00`–`13`）已成形。**进度与产出物见 `14-进度与产出物.md`**（做了什么给落点路径、没做什么直说）。

**代码**：P0 的地基已落地并有测试（判据明细见 `04` §当前实现状态）：

| 已完成 | 内容 |
| --- | --- |
| M0 / M0.5 / M1 / M2 / M3 / **M0.6** | `packages/ir`（场景 IR + zod schema + builder + **`baseline` 性能基线模型**）、`packages/engine`（引用/表达式/等待/断言/解释器/静态闸/**`StepExecutor` 两种执行形态**）、`packages/adapter-http`（OpenAPI 3 解析 + 确定性别名 + style 序列化 + ajv 双向校验 + spec 生成的 mock server）、`tooling/lint-layers`（分层与 node-free 强制） |
| **M6 / M7 判据侧** | `packages/store`（磁盘内容寻址 + 脱敏在序列化时发生 + 自研 zip + 证据包组装）、`packages/cli`（**`atest run/lint/gen/agent/init/evidence/auth-check`** 七命令，七档退出码 + `--ci` 门禁闸）、`engine/report.ts`（`trace.jsonl` + JUnit XML + manifest/summary） |
| **鉴权层**（`docs/05` §2） | apiKey×3 / bearer / basic / oauth2 clientCredentials + token 缓存与过期前刷新 + **`atest auth-check`**（逐方案×逐身份，只走只读方法）。方案语义与密钥值都**留在 adapter**，引擎只传不透明引用 |
| 测试 | `node:test`，`npm test` 全绿。**例数不钉**（这里写死过 "647 例"以及五个分项数字，而它每个 commit 都在动 —— 要数字自己跑：`npm test > /tmp/t.log 2>&1; echo $?` 再读 `# pass`/`# fail`，**别接管道取 `$?`**）。测的东西：鉴权层（adapter 侧方案与凭证表 / 引擎侧身份意图 / `auth-check` 判读）、并发语义（分支作用域隔离 + 池调度）、字段接线扫描器自身、「引擎在浏览器里能跑」的 esbuild+vm 行为验证、「引擎跑真实 IR 打到 spec 生成的 mock server」的端到端验证、「**功能形态与预编译形态逐步等价**」（含随机树属性测试），以及 M6 的**外部实现验产物**两类：JUnit XML 交给 CPython 的 expat 解析、`evidence.zip` 交给系统 `unzip -t`。`npm run build` / `npm run typecheck:test` / `npm run lint`（分层 + 字段接线两道）同样在 CI 里跑 |
| 字段接线扫描 | `npm run lint:fields`（`tooling/unread-fields.mjs`）。列出 ir 的每个 zod 字段、查执行侧有没有读过；未读要有 `tooling/unread-baseline.json` 豁免并写归属阶段。**它只答"有没有被碰过"**，"读了但用错"仍要靠测试（`docs/08` §3 那个缺陷类的第九例就是它报不出来的那种） |
| 变异检查 | `npm run mutate tooling/mutate/<名>.json`（`tooling/mutate.mjs`）。关键断言必须在实现被改坏时变红；等价变异照列并标 `expect:"equivalent"`。**harness 自己的判读也有测试** —— 它产出的是"这条断言已验证"这个结论，判错与它要防的 bug 一样坏。份数与例数**不钉**（写过"三份共 56 例"，新增一份就过期，且过期方式是少算）。**抓到几例、有没有"没跑成"以 `npm run mutate` 自己的输出为准** —— 那两档要真把实现改坏一次才知道，写进文档就会过期 |

M2 的判据是「打本地 mock server（mock 由 spec 生成）全绿」—— 现在引擎自测**不依赖任何真实后端**，
CI 的可用性不外挂在别人的 staging 上（`docs/05` §6）。

**已开工但未收口**：
- **M7（判据侧）** —— `--ci` 下未冻结/缺 provenance **一个请求都不发**就拒绝；真 socket 跑 20 次断言逐条一致；证据包无条件带 `scenario.irSha`（全长 sha256，规范化投影见 `ir/src/scenario.ts` 的 `canonicalScenario`）。**仍缺 `versionId`**：本地文件没有"第几版"的概念，硬编一个号就是编一个 —— 它等 P1 的版本表，证据包里如实是 `undefined`。
- **M6 里故意没做**：`atest agent` 是明确的"不可用"实现（给出替代路径，不是 `command not found`）；`--yes`（跳过人工确认）被拒绝，理由是 `docs/03` §5 的不可逆动作必须过白名单或人。生成器不产 `statefulSequence`/`authMatrix`/`contract`/`idempotency`/`perfSmoke` 五个策略，原因逐条写在 `cli/src/gen.ts` 的 `STRATEGIES` 表里。

M0.6 交付的是**接口分离 + 等价性证据 + 基线模型**，**不是能压测**：
预编译形态目前只支持纯计算与断言子集，`http` 一律拒绝（请求对象构造还长在解释器里，
要先抽成共享出口 —— 那是 P7 的前置）。所以它验证的是"表达式预编译"这个前提成立，
`baseline` 那套判据要等 P7 有真实指标进来才真正跑起来。别说成"压测已支持"。
**M2 里故意没做**（`04` §M2 的落点与没做的部分 有完整表格）：鉴权层（bearer/apiKey/oauth2cc/cookie jar/签名 provider 全部未实现，现在能跑通只因为 mock 不检查鉴权）、契约车道的独立调度、`openapiCall` 的数组 query 未走 spec 声明的 style。
**被环境阻塞**：M4/M5 需要支持 tool calling + structured output 的模型组（当前网关报 `tool_choice requires at least one available tool`）。

**开工前请先读 `04` §「与计划的偏离」与 §「M6 里新增的偏差」** —— 那里记着本机环境造成的技术选型替换（npm 而非 pnpm、`node:test` 而非 vitest、自研 JSONPath 与 lint 而非引第三方、**自研 argv 解析而非 Commander + @clack、OpenAPI 只吃本地 JSON 文件不吃 YAML/URL**），照文档正文去装会装不上。

**代码与文档目前已知不一致的两处**（都记在 `08` §3，别当已实现）：`maxCostUsdPerResolve` 只是 schema 字段、执行侧无人读它；`assertions.ts` 断言响应时自动拆一层 `body`。

**待你回答的 8 个问题**：`08` §1 的 C5–C12（未答复期间按 `08` §1.1 的默认自行推进，每条都写明了推翻它要重做什么）+ `12`/`13` 的 U1–U7（有无设计师、是否被嵌入客户系统、默认紧凑档能否接受）。
