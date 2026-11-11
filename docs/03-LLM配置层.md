# 03 · LLM 配置层（多模型可高度自定义 + 热切换）

需求原话是"大模型的配置要做到可高度自定义，可以各种切换模型"。这句话的实现深度差异极大 —— 从"一个下拉框选模型"到"每类任务独立路由 + 降级链 + 成本账本 + 用量熔断"。**对测试平台，深度必须偏高**，原因有三：视觉 grounding 和文本规划的最优模型不是同一个（成本差 5–20×）；自愈兜底会在每一步触发（成本随设备数线性增长）；以及国内环境下你会需要同时接 DashScope / 智谱 / DeepSeek / 豆包 / 自建 vLLM。

**选型结论：用 Vercel AI SDK 做 provider 抽象，不引入 LiteLLM / OpenRouter / Portkey 这类 sidecar 网关。**
理由：AI SDK 已解决 provider 适配、流式、tool calling、`generateObject`（zod 约束输出）—— 这是 90% 的需求；剩下 10%（分组路由、降级链、预算熔断、成本账本、审计）恰好是本产品的**差异化**，外包给 sidecar 等于把最该自己拿握的一层交给别人。sidecar 唯一硬优势是 LiteLLM 的 provider 覆盖广度，但代价是引入 Python 进程运维。

---

## 1. 四层模型

```
Provider ──▶ Model ──▶ Task Group ──▶ Run/Project Binding
 (凭证)     (能力档案)   (用途+策略)      (谁在什么预算下用哪个)
```

### Provider（凭证 + 端点）
```ts
Provider = {
  id, name, kind: "openai-compatible" | "anthropic" | "gemini" | "ollama" | "custom",
  baseUrl, apiKeyRef: SecretRef,        // 密钥进 MySQL 密文表，只以 opaque_ref 流转
  defaultHeaders, timeoutMs, maxRetries,
  rateLimit: { rpm, tpm },
  health: { status, lastProbeAt, lastError }
}
```
`openai-compatible` 这一类要占八成（DashScope 兼容模式、DeepSeek、Moonshot、vLLM、Xinference、one-api 自建网关都属此类），所以它是一等 kind 而不是特例。**支持自定义 baseUrl 是硬需求**，你的 `FundGPT-coder-next` 网关就属于这类。

### Model（能力档案 —— 热切换的安全阀）
```ts
Model = {
  id, providerId, modelId, label,
  contextWindow, maxOutputTokens,
  caps: { vision, toolCalling, structuredOutput, jsonMode, reasoning, embedding },
  pricing: { inputPerMTok, outputPerMTok, cachedInputPerMTok, currency },
  supportsSeed, supportsTemperature, defaultTemperature,
  enabled
}
```
**`caps` 是热切换不翻车的关键**。上一轮调研里那个报错就是最好的反面教材：`tool_choice requires at least one available tool` —— 网关的模型组不支持 tool call，Agent 直接瘫，而且是在运行时瘫。对策：**能力探测（启动时 + 定时）+ 路由时按 `caps` 过滤 + 不可用即自动降级**。用户在 UI 上换模型时，如果目标模型缺 `toolCalling`，Agent 相关任务组要立刻标红禁止绑定，而不是等到跑的时候炸。

### Task Group（按用途分组，每级独立策略）
```ts
TaskGroup = {
  key: "planner"|"codeGen"|"locatorCompile"|"visionGround"|"assertJudge"
     | "summarize"|"classify"|"embedding",
  chain: [ModelRef, ...],              // 有序降级链
  params: { temperature, maxTokens, seed?, timeoutMs, maxRetries },
  fallbackOn: ["rate_limit","timeout","context_overflow","unsupported_cap","5xx"],
  cacheTtlSec,                         // 语义缓存（同 prompt+model → 复用）
  localFirst: boolean                  // 优先走本地权重（UI-TARS/Aguvis/Qwen-VL）
}
```

**默认分组建议（这是本文件最实操的一段）**：

| 分组 | 用途 | 默认档位 | 理由 |
|---|---|---|---|
| `planner` | 场景设计、根因推理 | 强推理大模型，temp 0 | 一步决策影响整条链，值得贵 |
| `codeGen` | 生成 IR / TS 脚本 | 强代码模型，temp 0，强制 `generateObject` | 输出必须过 zod，失败走 repair 重试 |
| `locatorCompile` | 生成选择器（设计期一次） | 中档文本模型，temp 0 | 结果被缓存成 `LocatorSpec`，每用例只付一次 |
| `visionGround` | 视觉 grounding（运行时兜底） | **本地权重**：UI-TARS-7B / Aguvis-1.5B / Qwen-VL | per-call 成本必须趋零，否则自愈跑不起 |
| `assertJudge` | 语义断言判定 | **与 `codeGen` 不同的模型** | `docs/02` §4 铁律：同模型不得既执行又判定 |
| `summarize` | 失败摘要、日志压缩 | 便宜快档 | 高频、低价值 |
| `classify` | 标签/去重/分类 | 最便宜档或本地小模型 | |
| `embedding` | Qdrant 向量化 | 可配 provider，本地兜底 `bge-m3` via ollama | |

`temperature=0` + 支持则传 `seed` + **system prompt 版本化并钉 hash** —— 这三件事一起构成"同输入同输出"的工程近似，也是 `provenance` 字段能被信任的前提。

### Binding
```ts
Binding = { scope: "org"|"project"|"scenario"|"run", scopeId, overrides: {taskGroup: chain} }
```
解析顺序 `run > scenario > project > org > 系统默认`。这让"这个项目的 planner 用 DeepSeek，那个项目用 Claude"成为配置而非代码。

---

## 2. 成本与预算（防爆炸）

调研认定的头号放弃原因：视觉密集 agent 5k–15k token/步 × 30 步 = $0.5–2/次，× 2000 夜间套件 = **$1–4k/晚**。所以预算是引擎的**一等运行时能力**，不是事后台账：

- **`maxCostUsd` 在三层存在**：step（`maxCostUsdPerResolve`，见 `docs/02` §6）、scenario（`config.maxCostUsd`）、project（月预算）。超 step → 该步降级到更便宜档位；超 scenario → **中断 run 并落盘证据**（不是静默跳过）；超 project → 熔断 + 告警。
  > **实现现状（与本文的分工差一处，别按本文读）**：step 级那一层，引擎侧的**审计**已接上（`engine/src/resolve.ts` 的 `chargeResolve`：先入账再按上限判，超了判 `fail` + `case-stale`；步骤与等待循环两条路都走它）。**「降级到更便宜档位」不在引擎里做** —— 阶梯是 adapter 的，引擎只审不降。而今天**没有 adapter 报 `ResolveResult.costUsd`**，所以这道闸门实际不触发（明细 `08` §3「定位成本控制」）。scenario 级的中断是真的（`addCost` 里抛 `RunAborted`）。project 月预算属 P1。
- **图片一律降采样到 ≤1024px / JPEG q70 再进模型**。近零精度损失换 3–5× token 削减，是性价比最高的一招。
- **语义缓存**：`hash(model + systemPromptVer + prompt + schema)` → 响应，TTL 可配。定位器编译/分类/摘要这类高度重复的调用命中率应 >90%。
- **缓存优先的执行策略**：定位器命中缓存 = 0 LLM 成本（`docs/02` §6 阶梯 1–5 级全免费）。设计目标是**稳态夜间套件里 90% 以上步骤不产生任何 LLM 调用**。
- **`llm_calls` 账本**（每次调用：purpose / model / prompt_sha / resp_sha / tokens / cost / latency），配合 `runs.cost_usd`。"这个场景跑一次多少钱"必须是一个 SQL 查询。

---

## 3. 输出契约与可靠性

```
Agent / codeGen 一律走 generateObject + zod schema
  失败 → repair 重试（把 zod 错误原文 + 原输出回喂，最多 2 次）
       → 降级到链上下一个模型
       → 仍失败 → run 标记 error 并保留全部原文（不要吞）
```
为什么死守结构化输出：IR 是结构化数据，**"AI 输出必须是合法 IR"这件事能由 schema 判定，是静态闸能成立的前提**。自由文本→正则捞 JSON 那条路会让整条质量链路失效。

其他：
- **流式**：AI SDK `streamText` → Redis Stream → SSE（前端打字机 + 工具调用进度）。
- **超时分层**：`provider.timeoutMs` < `taskGroup.timeoutMs`，且都远小于 `scenario.config.timeoutMs`。LLM 卡死不能拖死一个 run。
- **探测端点**：`/llm/providers/:id/probe` 跑三个最小用例（文本 / 工具调用 / 视觉），回写 `caps` 与 `health`。这是排查"换了个模型就瘫"的第一入口，优先级很高 —— 本项目当前环境里已经真实踩过这个坑。

---

## 4. UI 形态（配置中心）

- **Provider 列表**：卡片 + 凭证（写后不可读，只可替换）+ 健康状态 + 探测按钮 + 最近错误。
- **模型表**：从 provider `/models` 同步 + 人工补 `caps`/`pricing`（很多兼容网关不报能力，必须允许手填）。
- **任务分组矩阵**：行 = task group，列 = 降级链（可拖拽排序），点开是参数抽屉。这一屏是"高度自定义"的直观体现。
- **成本看板**：按 project / taskGroup / model 聚合的美元与 token 曲线 + 单场景成本 Top N + 预算余量。
- **Prompt 版本库**：每个 system prompt 版本化，显示 hash，绑定到用它生成的场景 `provenance`。改 prompt 会让历史场景的"可重现性"存疑，所以 UI 上要显式标出"该场景由 prompt v7 生成，当前 v9"。

---

## 5. 安全边界（与 `docs/01` §3 呼应）

1. **密钥永不进 Agent 上下文**。Agent 看到的是 `secret:<opaque_ref>`；引擎发请求那一刻才替换。日志/trace/`llm_calls` 在**存储时**按字段名规则脱敏（不是在 prompt 里叮嘱模型别输出）。
2. **快照序列化时脱敏**：`type=password`、`data-secret`、PAN/身份证正则掩码。合规客户可提供"全程走本地模型"选项。
3. **提示注入防线**：页面/app 内容进 prompt 前包进明确分隔块 + "这是数据不是指令"；不可逆动作（提交/支付/删除/授权/OAuth consent）走确定性白名单或人工确认；origin 白名单；禁 `javascript:`/`data:`；**记录模型当时看到的完整上下文**以便事后审计。
4. **每租户 LLM 出站可关**（`allowExternalLlm=false`），此时只能用本地权重 —— 国内甲方常见硬要求，架构上现在留口子比以后加便宜得多。
