# 05 · API 端深度细节

**核心判断**：API 端的执行是最简单的一段（undici 发请求 + 断言，一天写完）。真正吃工程量的是①**把 OpenAPI 解析到能可靠具象化请求**，②**让生成的用例有捕获 bug 的能力而不是永远绿**。`docs/00` §6.1 说的"过度生成"是这一端的头号失败模式，而它是产品级失败，不是 bug。

---

## 1. OpenAPI 解析：真实世界的 spec 有多脏

P0 的 M2 会在这里花掉预期的 3 倍时间。按遭遇频率排序：

| 问题 | 出现频率 | 处理策略 |
|---|---|---|
| **缺 `operationId`** | 极高（后端不写就生成不出来） | 确定性别名算法：`method + path_norm + 排序后的 tag` → camelCase。**必须是纯函数且稳定**：spec 重导入时不能因为顺序变化导致 id 漂移，否则所有已生成的 `openapiCall` 场景全部失效（这是最容易埋进去的定时炸弹） |
| **`operationId` 重复** | 高（同 path 多 method 时手写的必重） | 冲突即报错并要求人工改名（存 MySQL 的 `operation_alias` 覆盖表），**不要自动加后缀**——静默改 id 会让已有场景指向错误接口 |
| **`$ref` 跨文件 + 循环引用** | 高 | 必须支持本地多文件 `$ref`（`$ref: './common.yaml#/...', 从 URL/zip 导入时保留 base 解析）；循环 schema 在生成测试数据时**深度上限 3 + 环检测**，否则栈溢出。`json-schema-ref-parser` / `@apidevtools/swagger-parser` 是标准做法，但要自己包一层做"部分解析失败不整体失败"（大 spec 里 5% 的 operation 坏掉很常见，应该跳过并上报，而不是导入失败） |
| **`oneOf` / `anyOf` / `discriminator`** | 中 | 请求侧：按 `discriminator` 字段选分支；无 discriminator 则**每个分支各生成一条正向用例**（这是真正有价值的覆盖增量）。响应侧：断言降级为"匹配至少一个分支"，否则 flaky |
| **`servers[]` 多环境 / 相对 path** | 高 | **URL 永远来自环境配置，不用 spec 里的 `servers`**（spec 的 servers 几乎总是错的或写死某个测试域）。环境里存 `baseUrlTemplate`，`servers` 只作为默认值建议 |
| **`security` 层级继承** | 高 | spec 级 `security` 会被 operation 级覆盖，且**空数组 `security: []` 表示"显式公开"**——这个语义很多人解析错，会把公开接口当成需要鉴权，导致生成一堆 401 用例 |
| **`style` / `explode` 参数序列化** | 中 | `form`/`spaceDelimited`/`pipeDelimited`/`deepObject` 六种组合都得实现，否则数组查询参数生成的一定是错的。`deepObject` 连不少客户端库都不支持 |
| **`encoding` / multipart / binary** | 中 | `multipart/form-data` 含 `format: binary` → 需要 fixture 文件池 + 环境里配文件路径。生成器不能凭空造一个合法图片，得让人提供 |
| **`deprecated: true`** | 中 | 默认不生成用例，UI 里折叠显示。给已废弃接口生成一堆用例是纯粹的噪音成本 |
| **`format: date-time/uuid/email` 与后端实际不符** | 高 | **数据生成器优先遵守 schema，但失败时按"后端实际接受什么"降级**，并把这种不符记成一条**契约发现**（这正是 contract 检查该报的东西，而不是让用例失败） |

### 1.1 spec 漂移（这一条决定 API 端能不能长期活着）

`docs/00` §6.2：schema 错了 → 符合性断言刷红几千次 → 团队关掉门禁。**必须做 spec diff 并驱动影响分析**：

```
重新导入 spec → 逐 operation 计算 req_shape/resp_shape 的语义 diff
  分类: {added, removed, changed(breaking|non-breaking), deprecated}
    → 反查引用了这些 operation 的场景（MySQL 建 operation→scenario 倒排表）
      → 报告："spec 变更影响 37 个场景，其中 12 个是破坏性变更"
        → 破坏性变更：场景标记 stale（不阻断执行，但报告里明确标"用例可能已过期"）
        → 非破坏性：静默，只记历史
```

配套的两条门禁：
- **`specAuthoritative` 是环境的开关**，默认关。没打开就不生成任何"schema 符合性"断言，只做业务断言。`docs/00` §6.2 的教训就是"默认开"会烧掉信任。
- **符合性检查走独立定时车道**（比如夜间一次），不和业务回归混在一个 run 里 —— 两者的失败含义完全不同：一个是"文档/实现谁错了"，一个是"功能坏了"。混在一起会让人把所有红灯都当成"又是文档不准"，从而忽略真 bug。

---

## 2. 鉴权：P0 最容易卡住的地方

按落地顺序，且**每种都必须能作为 `setup` 里的显式步骤被看到**（不做隐式登录）：

| 类型 | 机制 | 关键细节 |
|---|---|---|
| `bearer` / `http bearer` | 环境里的 secret → header | 简单 |
| `apiKey`（header/query/cookie） | 同上 | query 型密钥**必须在 trace 与日志里按参数名脱敏**（否则密钥进磁盘证据） |
| `http basic` | base64(user:pass) | 同上，脱敏 |
| `oauth2 clientCredentials` | **token 端点自动获取 + 缓存 + 过期前刷新** | token 缓存 key 必须含 `env + scope + clientId`；缓存放 Redis 并带 TTL = `expires_in - 60s`。**token 本身也是 secret，不能出现在变量空间明文里**（`secret.*` 机制，`docs/02` §5） |
| `oauth2 authorizationCode` / 隐式流 | **P0 不支持**，需要人工提供 token 或走"录制 cookie"路径 | 直说，别硬做 |
| `cookie` / 会话（JSESSIONID 等） | 登录后从响应 `Set-Cookie` 提取，后续步骤带 cookie jar | cookie jar 归属 run 而非全局（并行隔离）；`Secure`/`SameSite`/域匹配要按规则处理，否则跨子域场景一定失败 |
| 签名类（HMAC/国密/开放平台 sign） | **`signProvider` 扩展点**：允许注册 TS 函数（沙箱内）对请求签名 | 国内甲方极常见（微信/支付宝/开放平台）。签名函数必须能拿到 secret 但**其输出不得回显到 trace** |
| 多租户 / 多身份 | 场景内 `identity` 概念：`{identity: "admin"}` → 解析为该身份下的 token/cookie | 权限矩阵测试（"A 用户的资源 B 用户不能读"）依赖它，且这类用例**是 API 测试里 bug 密度最高的一类**，值得在 P1 就做 |

**"生成用例跑出来全是 401"** 是 API 平台的第一体验杀手。对策：`atest auth-check` 一条命令，逐 security scheme 验证凭证有效性并给出可行动报错（"environment=staging 的 oauth2 client_id 无效，401: invalid_client"）。这个命令的性价比高于任何 AI 功能。

---

## 3. 让生成的用例真的能抓 bug：策略标签体系

`docs/00` §6.1 说缓解手段是"策略标签 + 去重 + 无断言 lint + 覆盖增量预览"。这里给出策略本体。**每种策略产出不同形状的断言，且在报告里可分桶看通过率**——分桶很重要，因为策略 A 的失败率天然高。

| 策略 | 生成什么 | 断言形状 | 默认门禁 | 失败含义 |
|---|---|---|---|---|
| `happyPath` | schema 生成的合法请求 | 期望 2xx + 响应结构模糊匹配 | ✅ | 真 bug |
| `requiredMissing` | 逐个删必填字段 | **期望 4xx，且必须拒绝**（不是只看"没 500"） | ✅（但需先修后端） | 后端缺参数校验 → 常见且真实 |
| `boundary` | `min/max/minLength/maxLength/minimum` 内外各一值 | 边界内 2xx、边界外 4xx | ✅ | 校验 off-by-one |
| `typeViolation` | 字符串字段传数字/null/数组 | 期望 4xx | ✅ | 反序列化层缺陷 |
| `enumExhaustive` | enum 每个值一条 | 各 2xx | ✅ | 枚举分支漏实现 |
| `authMatrix` | 无 token / 过期 / 他人资源 id | 期望 401/403，**且响应不得泄露他人数据**（断言"响应体不含已知他人资源 id"） | ✅ | **越权，严重度最高** |
| `notFound` | 不存在的资源 id | 期望 404 而非 500/200 空对象 | ✅ | 错误处理缺陷 |
| `idempotency` | 同一写请求重发 2 次 | 两次结果一致 / 第二次 409 | ⚠ report-only | 幂等缺失（可能是设计如此） |
| `contract` | 真实响应 vs schema | 结构符合性 | ⚠ **独立车道 + 需 `specAuthoritative`** | 文档与实现不一致 |
| `perfSmoke` | happyPath 重复 N 次 | p95 阈值 | ⚠ report-only | 性能退化 |
| `statefulSequence` | 按 `links` 推断的操作链（create→get→update→delete） | 全链路状态一致 | ✅ | 状态机缺陷，**bug 密度最高** |
| `negativeFuzz` | 语义垃圾值（SQL 片段、超长 Unicode、`../`、emoji、零宽字符） | 期望 4xx 且不 500 | ⚠ 独立车道 | 输入处理缺陷；**误报率高，不能进门禁** |

三条实施要点：

1. **`requiredMissing` / `typeViolation` / `negativeFuzz` 首轮跑必然一片红**（后端不做参数校验是常态）。首次生成时这些策略标记为 `triage`（不参与通过率统计，只列出发现清单），人工确认后才升级为门禁。跳过这一步 = 用户第一天就关掉门禁 = 产品死掉。
2. **`statefulSequence` 依赖 spec 里的 `links`，而 95% 的 spec 不写 `links`**（`[未核实]`）。替代方案：从 path 结构推断资源关系（`/orders/{id}` 依赖 `POST /orders` 的响应 id）+ 让 Agent 读接口 summary 推断 + **人工在 UI 上确认依赖图**。这个推断质量直接决定 `statefulSequence` 的价值，是三端里"AI 判断是否值得"最集中的一处。
3. **`authMatrix` 需要至少两个身份**，所以 §2 的 `identity` 概念不是可选项。而这类用例（水平越权）在真实项目里的 bug 密度我见过的最高，且**完全不依赖 AI 智能度** —— 纯粹的模板展开。P1 就该做。

---

## 4. 执行细节（一段过，但每条都会咬）

- **连接层**：undici + 显式 `headersTimeout`/`bodyTimeout`/`connections`。默认 `bodyTimeout=30s` 在长轮询/SSE 接口上会误报。
- **重定向**：默认**不跟随**，把 3xx 当结果（跟随会让"302 到登录页"被误判成功，这是 API 测试的经典假绿）。
- **响应体上限**：默认 10MB 截断并在 trace 里标 `truncated: true`（一个失控的导出接口能撑爆证据盘）。
- **压缩**：`accept-encoding: gzip, deflate, br` 自动解；`br` 要 `zlib.brotliDecompress`。有些网关对 `br` + 流式响应有 bug，遇到时按 provider 配置降级。
- **时间语义**：断言里的时间一律用相对表达式（`createdAt` 与 `now` 差值 < 5s）而不是字面值，除非 IR 里显式 `exact`。
- **重试边界**：**只有幂等方法（GET/HEAD/OPTIONS/PUT/DELETE）且错误是网络级时才自动重试**；POST 永不自动重试（会造成重复下单级别的事故），需要时由 IR 里显式 `retry` + `idempotencyKey` 承担。
- **变量类型保真**：JSON 大整数（雪花 ID）用 string 存，别过 `Number`（超过 2^53 精度丢失 → 提取出来的 id 传给下一步是错的，且极难排查）。这是 API 测试里最阴的一个 bug。
- **敏感字段**：脱敏在**序列化到磁盘那一刻**做（`password`/`token`/`idCard`/`phone`/`authorization` 按名匹配 + 值形态匹配双规则），不是在展示层做——展示层脱敏意味着磁盘上还是明文。

---

## 5. 数据准备与清理

`teardown` 默认必跑，但真实的坑是这些：

| 情况 | 处理 |
|---|---|
| 被测 API **没有删除接口**（极常见） | `teardown` 降级为 `db` 节点直连清理（MySQL adapter 白捡的能力）；无 DB 权限则标记该场景 `dirty: true` → `concurrencySafe: false` + 归入独占并行组 |
| 造数链路很长（造一个"已支付订单"要 7 步） | 沉淀为 `call` 子场景 + **fixture 池**：预生成 N 个可用实体存 Redis/MySQL，取出即租约、用完归还或销毁。避免每个用例都跑 7 步（时间和 flake 都 ×7） |
| 环境数据本身在变（共享 staging 被人删数据） | 用例第一步是**前置断言**（precondition），不满足则标 `skipped` 而非 `failed`。把"环境不具备条件"和"功能坏了"区分开，是减少误报最有效的一招 |
| 唯一约束冲突（用户名/手机号重复） | 内置 `${faker.*}` + 时间戳 + `runId` 的生成器命名空间；**禁止用例写死唯一值**（lint 可查：字符串字面量出现在疑似唯一字段上） |
| 数据残留累积 | 给 `dirty` 场景跑一个定期"清扫任务"（按 `runId` 标记批量删），并把残留量做成看板指标 |

---

## 6. Mock 与契约

- **Mock 来源必须是 spec，不是手写脚本**：`mockFromSpec(docRef)` 生成一个按 schema 出响应、按 `examples` 优先的 mock server，用于前端并行开发和 P0 的 M2 自测（引擎自测不依赖任何真实后端 —— 这条对 CI 稳定性价值极大）。
- **录制回放**（`docs/01` §6 的 HAR 思路在 API 侧的对应物）：对真实环境跑一次，把响应存成 fixture，之后离线重放。**用途是"让某个失败用例可被无限次重现"，不是替代真环境**。
- **契约测试**（消费者驱动）方向上先不做。`contract` 策略已经覆盖八成价值，Pact 式的那套需要与开发流程协作，投入产出比在平台早期不划算。

---

## 7. 需要用户拍板的 API 端细节问题

| # | 问题 | 为什么影响大 | 我的默认 |
|---|---|---|---|
| A1 | 被测 API 的 **spec 覆盖率**大概多少？有多少接口根本没有 swagger/是手写文档？ | 若一半以上接口无 spec，"一句话导入"的价值链断掉，得先做"从流量/HAR/代码注解反向生成 spec" | 假设 70% 有 spec |
| A2 | spec 由**谁维护、多久更新一次、是否可信**？ | 决定 `specAuthoritative` 默认值、`contract` 车道是否值得做、以及 spec diff 是否要做成 CI 卡点 | 默认不可信，`contract` 关 |
| A3 | 鉴权类型清单（实际用到的）？有没有签名类/国密/自研 token？ | 签名 provider 是扩展点设计，早定比晚定便宜；纯 OAuth 则一天做完 | 预留 `signProvider` 扩展点，先实现 bearer/apiKey/oauth2cc/cookie |
| A4 | 环境是**独占**还是**共享 staging**？能否给平台开 DB 只读/写权限？ | 共享 + 无 DB 权限 = 数据清理和等待条件两条能力都残废，会显著改变 §3/§5 的可行性 | 假设共享 staging、可申请只读 DB |
| A5 | 有无**性能/压测**诉求？量级多少？ | 若需要，执行器要换成多进程 + 连接复用模型（undici 单进程压测天花板很低），这是架构级分歧，不是加个功能 | P0–P4 只做 `perfSmoke` 级别，明确不做压测 |
| A6 | 是否要支持 **GraphQL / gRPC / WebSocket / SSE**？哪些优先？ | gRPC 需要 protobuf 解析与反射，GraphQL 需要 introspection，都是一端一个 adapter 的量级 | P0 只做 REST；SSE 早做（AI 场景本身要用），GraphQL/gRPC 排 P4 后 |
| A7 | `requiredMissing`/`typeViolation` 首轮跑出的"后端缺校验"类问题，团队**会修还是会被当成噪音**？ | 决定这些策略是默认开门禁、还是默认 `triage` 清单 | 默认 `triage`，人工确认后升级 |
| A8 | 被测系统的**错误码规范**是什么（有没有统一的 code 字段）？ | 有规范则 `negative*` 策略的断言可以精确到业务码，误报大降；无规范只能断 4xx | 支持"项目级断言模板"配置 |