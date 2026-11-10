/**
 * run 的**环境指纹**（docs/06 §1、docs/01 §6 的 runs 表）。
 *
 * **为什么要有这个文件**：`EnvFingerprintSchema` 在 IR 里定义了很久的，
 * 而全仓**没有任何地方构造它** —— 只有 baseline.ts 拿它做类型引用，
 * 然后 `envDiffForPerf` 认真比较 `environmentRef` / `platform` / `appSha`。
 * 后果不是"少一个字段"：性能基线的**可比性判据**要求两侧都有 env，
 * 而没有任何东西能产出 env，于是"这次 p95 比基线差 20%"这句话
 * 在实现上永远缺一个前提。docs/06 §1 那条
 * "响应式断点相关的用例今天过明天挂，且查不出来"治法就在这儿：
 * 视口/DPR/locale/tz 必须固定下来**并记进 run**，而不是随机器默认值漂。
 *
 * 位置选 CLI 而不是 engine，有两条硬约束：
 *  - 引擎禁止碰 node 内置模块，而 `platform` 来自 `node:os`（docs/01 §8.2）；
 *  - 指纹的输入（浏览器视口、环境文件、时钟模式）**只有装配点同时知道**，
 *    让引擎猜等于把"配置"变成"运行时推断"，那正是本仓反复记账的方向。
 */
import { platform as osPlatform } from 'node:os';

import { EnvFingerprintSchema, type EnvFingerprint } from '@atest/ir';
import type { Clock } from '@atest/engine';

export interface FingerprintInput {
  /** 场景声明的环境名（`env.environmentRef`） */
  environmentRef: string;
  /** 环境配置（已解析到具体修订）。只读几个约定键，见下面每个字段旁的注释 */
  env: Record<string, unknown>;
  /** `--env-revision`。schema 要求必填，缺省值怎么处理见下面 envRevision 那条 */
  envRevision: number | undefined;
  /** Web adapter 的实际生效值。**用 adapter 的 meta 而不是 env 里的原始值**：
   *  env 里写 `viewport: "1440x900@2"` 是**声明**，adapter 真正设上去的是解析后的
   *  三元组；记声明的话，解析规则一改（比如以后支持 "auto"），指纹就与实况脱钩了 */
  web?: { meta: { viewport: { width: number; height: number; deviceScaleFactor: number }; locale?: string; timezoneId?: string } };
  clock: Clock;
  /** `--seed`。只有确定性时钟下才有意义 */
  randomSeed?: number;
  /** 执行器版本。缺省 '0.0.0'（与 evidence 里 versions 的处理一致：如实缺着） */
  runnerVersion?: string;
}

/**
 * 建指纹并**用 IR 的 schema 过一遍**。
 *
 * 校验不是为了好看：这个结构唯一的用途是**拿两次 run 的指纹做比较**
 * （baseline.ts 的 envDiffForPerf）。一次写成 `viewport: 1440`（数字而不是字符串）、
 * 一次写成 `"1440x900"`，比较结果会是"视口不同"，而人会花半天去找
 * "谁改了视口"—— 没有人改，是类型漂了。
 * 报错不回显整份指纹：指纹里可能带 appSha 之类的内部标识，而它会进 CI 日志。
 */
export function buildEnvFingerprint(i: FingerprintInput): EnvFingerprint {
  const vp = i.web?.meta.viewport;
  const locale = i.web?.meta.locale ?? strEnv(i.env, 'locale');
  const timezone = i.web?.meta.timezoneId ?? strEnv(i.env, 'timezoneId') ?? strEnv(i.env, 'timezone');
  const draft = {
    environmentRef: i.environmentRef,
    /*
     * 环境修订号。**必填**（schema 要求），所以缺 `--env-revision` 时不能不填。
     * 这里刻意用 0 而不是 Date.now() 之类"看起来像修订"的东西：
     * 填一个会变的值会让**每次 run 的指纹都不同**，于是性能基线永远判"环境不同"、
     * 门禁形同虚设 —— 那正是 docs/09 §4.3 里"没基线要说 unknown"要避免的方向。
     * 0 是"未提供修订"的哨兵值：两次都 0 就是"两次都没声明"，比较结果一致，
     * 这比造一个假装不同的值诚实。
     */
    envRevision: i.envRevision ?? 0,
    runnerVersion: i.runnerVersion ?? '0.0.0',
    platform: osPlatform(),
    // 被测版本。前端构建号/APK versionCode/后端 git sha 都由**环境**给，
    // 因为"这次跑的是哪个版本"只有部署方知道；CLI 不去猜（猜 = git 命令 + 沙箱问题）
    ...(strEnv(i.env, 'appSha') ? { appSha: strEnv(i.env, 'appSha') } : {}),
    ...(vp ? { viewport: `${vp.width}x${vp.height}` } : {}),
    // DPR 单独一维：`1440x900@1` 与 `1440x900@3` 的截图与像素断言完全不可比
    ...(vp && vp.deviceScaleFactor !== 1 ? { deviceScaleFactor: vp.deviceScaleFactor } : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
    // 时钟模式直接来自 Clock.mode，**不看 env 里写了什么**：
    // 声明与实际生效不一致时，指纹要说的是实际生效的那个
    clockMode: i.clock.mode === 'live' ? 'live' : i.clock.mode,
    ...(i.clock.mode !== 'live' && i.randomSeed !== undefined ? { randomSeed: i.randomSeed } : {}),
  };
  const parsed = EnvFingerprintSchema.safeParse(draft);
  if (!parsed.success) {
    // 只报**字段路径**，不报实际值：值里可能带 appSha 等内部标识，而这条报错会进 CI 日志
    const paths = [...new Set(parsed.error.issues.map((x) => x.path.join('.') || '(根)'))];
    throw new Error(`环境指纹不合法（字段：${paths.join(', ')}）。这是装配缺陷，不是配置问题`);
  }
  return parsed.data;
}

/** 环境里的字符串配置。非字符串一律当没配 —— 不 String(1) 那种"看着能用"的转换 */
function strEnv(env: Record<string, unknown>, key: string): string | undefined {
  const v = env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
