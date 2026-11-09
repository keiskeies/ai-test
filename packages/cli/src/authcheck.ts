/**
 * `atest auth-check` 的判定部分（docs/05 §2）。
 *
 * 为什么单独成文件：`commands.ts` 里全是"读文件、打印、返回退出码"，
 * 而这条命令的核心是**判读**（"401 意味着凭证无效，500 意味着凭证被接受了"），
 * 判读要能被直接调用测试，不能要求真网络、真磁盘。
 * 与 gate.ts 是同一个分工理由。
 *
 * 为什么它复用 `buildAuthHook` + `AuthHook.apply` 而不是自己再解析一遍凭证：
 * 这条命令的**全部价值**是"不跑用例也能回答鉴权对不对"。
 * 它要是自己拼一遍凭证装配，就会与真正发请求时那套不一致，
 * 于是"auth-check 说没问题、跑起来还是 401" —— 那比没有这条命令更坏，
 * 因为它给了一个假的通过。
 */
import {
  AuthRequiredError,
  MissingCredentialError,
  TokenError,
  scrubSecrets,
  type AppliedAuth,
  type AuthHook,
  type CredentialTable,
} from '@atest/adapter-http';
import { secretEnvKey, type DocRegistry } from './wiring.js';
import { EXIT } from './exit.js';

/** 一次探测的结论。六态而不是"通过/失败"两态，理由见 interpret() */
export type ProbeOutcome =
  /** 后端接受了这组凭证 */
  | 'ok'
  /** 凭证被拒（401/403）。环境配了，但后端不认 */
  | 'rejected'
  /** 压根没配/取不到值。修法与 rejected 完全不同，所以不能并成一态 */
  | 'needs-config'
  /** 连不上。此时**不知道**凭证对不对 */
  | 'unreachable'
  /** 没探测（没有只读接口可探，或该 operation 声明了本平台不支持的方案） */
  | 'not-probed';

export interface ProbeTarget {
  docRef: string;
  operationId?: string;
  method: string;
  path: string;
  /** 身份标签。(默认) 表示 env 里没配 identities 时那条路 */
  identityLabel: string;
  /** 传给鉴权层的身份名。undefined = 不指定 */
  identity?: string;
}

export interface ProbeRow {
  target: string;
  /**
   * 探的是哪份 spec。**多文档时必须能分清**：同一个 `GET /orders` 在 shop 与 crm 上
   * 用的是不同桶的凭证，两行结论不同而目标字符串相同的话，
   * 报告读起来就像"同一个接口一会儿好一会儿坏"。
   */
  docRef: string;
  identity: string;
  outcome: ProbeOutcome;
  /** 人可读的一句。**已经过 scrubSecrets**，不含任何凭证值 */
  detail: string;
  /**
   * **身份回落到默认**时的那句告警。单独成字段而不是拼进 detail：
   * detail 是一行一条打出来的，往里塞换行会让那份表对不齐 ——
   * 而这张表的用途就是让人一眼扫出哪一行是绿的、为什么。
   */
  warning?: string;
  /** 可行动的下一步。needs-config 必须给，否则用户只能猜变量名 */
  hint?: string;
  statusCode?: number;
}

export interface AuthCheckInput {
  /** 已装配好的鉴权层（与真实运行同一个实例）。 */
  hook: AuthHook;
  /**
   * 凭证表，同样来自 buildAuthLayer（不是另建一份）。
   * 只用它回答一件事：**这个身份有没有自己的凭证**。
   * 少了这个入参，`admin` 那一行会在"其实用的是默认凭证"的情况下报
   * "admin 凭证有效" —— 权限矩阵就这样被一条绿灯糊过去了。
   */
  table: Pick<CredentialTable, 'hasIdentityBinding'>;
  registry: DocRegistry;
  env: Record<string, unknown>;
  /** 身份标签集合：'(默认)' + 凭证表里声明的那些 */
  identities: Array<{ label: string; identity?: string }>;
  /** 发请求。测试里注一个假的进来 —— 这条命令不该在单测里碰网络 */
  send: (req: { method: string; url: string; headers: Record<string, string>; timeoutMs: number }) => Promise<{
    status: number; body?: unknown; error?: { kind: string; message: string };
  }>;
  /** 每种鉴权组合最多探几个接口。默认 1：目的是验凭证，不是扫接口 */
  sampleLimit?: number;
}

/** 只读方法。探测绝不能写数据 —— 见 pickTargets 的说明 */
const READ_ONLY = new Set(['GET', 'HEAD']);

export interface AuthCheckResult {
  rows: ProbeRow[];
  /** 有凭证问题的行数（决定退出码） */
  problems: number;
  /** 整体结论，给人的一句话 */
  summary: string;
}

/**
 * 逐个探测。返回的每一行都必须能回答"我该怎么修"。
 */
export async function checkAuth(i: AuthCheckInput): Promise<AuthCheckResult> {
  const rows: ProbeRow[] = [];
  const limit = i.sampleLimit ?? 1;
  const baseUrl = typeof i.env.baseUrl === 'string' ? i.env.baseUrl.replace(/\/+$/, '') : undefined;

  for (const docRef of i.registry.names()) {
    const doc = i.registry.get(docRef);
    if (!doc) continue;
    const targets = pickTargets(docRef, doc, i.identities, limit);
    if (!targets.length) {
      // 只可能是"没有 GET/HEAD 接口"（identities 至少含 '(默认)'，不会因身份为空而空）。
      // **不能**写成"没有鉴权声明" —— 那是两件不同的事，说错了人会去补一份本来就没错的 spec
      rows.push({
        target: '-', docRef, identity: '-', outcome: 'not-probed',
        detail: '这份 spec 里没有 GET/HEAD 接口，本命令不做探测。',
        hint: '探测只走只读方法：一条诊断命令在 CI 里产生业务副作用（下单/删除）是不可接受的。要自动验凭证，给服务加一个只读健康检查接口',
      });
      continue;
    }
    if (!baseUrl) {
      rows.push({
        target: '-', docRef, identity: '-', outcome: 'not-probed',
        detail: '环境里没有 baseUrl，探测请求拼不出绝对 URL。',
        hint: '加 --env-var baseUrl=https://staging.example.com',
      });
      continue;
    }
    for (const t of targets) {
      rows.push(await probeOne(t, baseUrl, i));
    }
  }

  // 一份 spec 都没导：这条命令没有判断依据。
  // **不能报"全绿"** —— "没检查出任何问题"与"压根没检查"必须是两个结论
  if (!rows.length) {
    rows.push({
      target: '-', docRef: '(无)', identity: '-', outcome: 'not-probed',
      detail: '本次没有导入任何 OpenAPI 文档，无法判断哪些接口需要哪种鉴权。',
      hint: '加 --doc shop=./spec/openapi.json。没有 spec 时只能靠用例里显式的 auth 字段，那条路本命令不覆盖',
    });
  }

  // needs-config / rejected 才算问题。unreachable 与 not-probed **不算**：
  // 把"网络不通"报成"鉴权有问题"会把人引去改凭证，而真相是 VPN 没连
  const problems = rows.filter((r) => r.outcome === 'needs-config' || r.outcome === 'rejected').length;
  const unknown = rows.filter((r) => r.outcome === 'unreachable' || r.outcome === 'not-probed').length;
  const ok = rows.filter((r) => r.outcome === 'ok').length;
  const fellBack = rows.filter((r) => r.warning).length;
  // 回落**不进 problems**：凭证确实是有效的，只是"哪个身份"这个问题没答上。
  // 把它算成问题会让"只配了一个共享凭证"的正常用法在 CI 里恒红；
  // 但它必须出现在 summary 里，否则一个绿灯会让人以为权限矩阵验过了
  const summary = `${rows.length} 项：凭证有效 ${ok}，有问题 ${problems}，未判定 ${unknown}`
    + (fellBack ? `；其中 ${fellBack} 项的身份回落到默认凭证（权限未验）` : '');
  return { rows, problems, summary };
}

/**
 * 选探测目标。两条规则，第二条是硬的：
 *
 *  1. 每种 (docRef, 身份) 只探有限几个 —— 目的是验凭证，不是扫接口。
 *  2. **只探只读方法**。手写的 `probe: true` 开关看着更"可控"，
 *     但 CI 里没人读文档就加开关，而 spec 里的 POST 可能是下单、删除、转账。
 *     一条诊断命令在流水线里产生业务副作用，是这一类工具最不能犯的事。
 *     没有只读接口时宁可报"未探测"，并说明原因。
 */
function pickTargets(
  docRef: string,
  doc: { operations: Array<{ operationId: string; method: string; path: string; security?: Array<Record<string, string[]>> }> },
  identities: AuthCheckInput['identities'],
  limit: number,
): ProbeTarget[] {
  const candidates = doc.operations.filter((op) => READ_ONLY.has(op.method.toUpperCase()));
  // 优先挑**声明了鉴权**的只读接口：探一个公开接口只能证明"网络通"，
  // 证明不了凭证有效，而后者才是这条命令的存在理由
  const secured = candidates.filter((op) => (op.security ?? []).length > 0);
  const pool = secured.length ? secured : candidates;
  const out: ProbeTarget[] = [];
  for (const idt of identities) {
    for (const op of pool.slice(0, limit)) {
      // docRef 必须带上：凭证表按 (docRef, 身份) 查，漏了它就全查进匿名桶，
      // 于是"shop 与 crm 配了不同凭证"这种最常见的多系统配置会被验成同一个
      out.push({
        docRef, operationId: op.operationId, method: op.method, path: op.path,
        identityLabel: idt.label, identity: idt.identity,
      });
    }
  }
  return out;
}

/**
 * 探一个。三分法：**配了没有 / 后端认不认 / 连不连得上**。
 * 这三件事在报告里必须分开，因为它们对应的修法毫无重叠：
 * 缺配置去设环境变量，被拒去换凭证，连不上去查网络。
 * 合成一句"鉴权失败"的话，用户三件事都会做一遍。
 */
async function probeOne(t: ProbeTarget, baseUrl: string, i: AuthCheckInput): Promise<ProbeRow> {
  const target = `${t.method} ${t.path}`;
  const url = `${baseUrl}${t.path.startsWith('/') ? '' : '/'}${t.path}`;
  /**
   * **身份回落到默认**必须在结论里看得见。
   *
   * 场景：env 里给 crm 配了 default 但没给 admin，而以 admin 探一次。
   * 查找顺序是"身份精确 > doc default > 匿名 default"，身份查不到就用 default ——
   * **这本身是对的**（不然每个身份都得在每份 spec 上配齐才能跑），
   * 危险的是报告侧看不出来：那一行会写"admin 凭证被接受"，
   * 而它验的其实是默认凭证。于是"admin 读不到别人的资源"这类权限判据拿到一个绿灯，
   * 与本仓修过的那批"身份没生效但显示成功"完全同形，只是这次发生在**报告里**。
   *
   * 也算在 needs-config 那条路上：那种情况下"用了谁的凭证"同样是未知，
   * 与其让两种情况只有一种带告警，不如两处都说清。
   */
  const fellBack = t.identity !== undefined && !i.table.hasIdentityBinding(t.docRef, t.identity);
  const warning = fellBack
    ? `身份 "${t.identity}" 在 ${t.docRef} 上没有自己的凭证，本次实际用的是**默认凭证** —— 这一行不等于"该身份的权限验过了"`
    : undefined;
  const detail = (m: string, values: readonly string[] = []): string => clean(m, values);

  // 先过鉴权层：它决定"该带什么"，取不到凭证时**抛错而不是裸发**
  // （裸发得到 401，而 401 会被读成"后端坏了"，这是 docs/05 §2 点名的第一体验杀手）
  let applied: AppliedAuth;
  try {
    applied = await i.hook.apply({
      url, headers: {}, docRef: t.docRef, operationId: t.operationId,
      method: t.method, path: t.path, identity: t.identity,
    });
  } catch (e) {
    if (e instanceof AuthRequiredError || e instanceof MissingCredentialError || e instanceof TokenError) {
      return {
        target, docRef: t.docRef, identity: t.identityLabel, outcome: 'needs-config',
        detail: detail(e.message), warning,
        hint: missingVarHint(e),
      };
    }
    throw e; // 不是鉴权问题 -> 让它冒到 main()，那里打堆栈并按 RUNTIME 退出
  }

  const res = await i.send({ method: t.method, url: applied.url, headers: applied.headers, timeoutMs: 15_000 });
  if (res.error) {
    return {
      target, docRef: t.docRef, identity: t.identityLabel, outcome: 'unreachable',
      detail: detail(`连不上：${res.error.kind} — ${res.error.message}。带的鉴权：${applied.detail}`, applied.secretValues), warning,
      hint: '这**不是**凭证问题。先确认 baseUrl 对不对、VPN/白名单、后端是否起着',
    };
  }
  const verdict = interpret(res.status);
  return {
    target, docRef: t.docRef, identity: t.identityLabel, outcome: verdict.outcome, statusCode: res.status,
    detail: detail(`${verdict.detail}（HTTP ${res.status}）。带的鉴权：${applied.detail}`, applied.secretValues), warning,
    hint: verdict.hint,
  };
}

/**
 * 状态码 → 结论。这里有本文件唯一一处真正的判断，所以单独拆出来好测。
 *
 * 最不直观的一条：**500 算凭证被接受**。
 * 500 的含义是"请求已经进到业务代码了" —— 而进到业务代码的前提是网关放行了。
 * 把它报成"鉴权有问题"会让人去换一份好凭证，然后同样 500，
 * 而他会以为"新凭证也不对"，实际是那个接口坏了。
 * 同理 404：进到路由了但没匹配上，凭证这关过了。
 *
 * 403 与 401 一起算 rejected，但含义不同，所以 detail 里分开写：
 * 403 常见于"凭证有效但角色不够"，那恰恰是权限用例**期望**的结果，
 * 所以它不是"凭证坏了"而是"这个身份权限不足" —— 修法不同。
 */
export function interpret(status: number): { outcome: ProbeOutcome; detail: string; hint?: string } {
  if (status >= 200 && status < 400) {
    return { outcome: 'ok', detail: '凭证被接受' };
  }
  if (status === 401) {
    return {
      outcome: 'rejected', detail: '凭证被拒（未认证）',
      hint: '凭证取到了但后端不认。确认这份凭证属于**这个环境**（staging 的 token 打 prod 就是这个现象），以及有没有过期',
    };
  }
  if (status === 403) {
    return {
      outcome: 'rejected', detail: '凭证被拒（权限不足）',
      hint: '403 也可能是"凭证有效但这个角色读不到这个接口"。如果你正要测的就是权限，这个结果是对的，不算问题',
    };
  }
  if (status === 404) {
    return { outcome: 'ok', detail: '路由没匹配上，但请求过了鉴权这关', hint: '接口路径可能变了 —— 这值得单独看一眼，只是与凭证无关' };
  }
  if (status >= 500) {
    return { outcome: 'ok', detail: '后端内部错误，但请求已进到业务代码（说明网关放行了）', hint: '凭证这一关没问题。500 本身要另查' };
  }
  return { outcome: 'ok', detail: `凭证未被拒（HTTP ${status}）` };
}

/**
 * 洗掉文本里的凭证值。
 *
 * 这条命令是**专门围绕凭证**设计的，输出的每一行都可能被贴进工单、
 * 截图发群、留在 CI 日志里。而 `?api_key=xxx` 这种值形态
 * 命中不了 engine 那套按字段名/值形态的通用脱敏规则（docs/08 §3 记过），
 * 所以这里必须用"本轮实际用到的那几个值"再洗一遍（scrubSecrets 的注释说明了
 * 它与 redact.ts 的分工，不是重复实现）。
 */
function clean(text: string, values: readonly string[]): string {
  return scrubSecrets(text, values).slice(0, 400);
}

/** 从异常里取"该设哪个变量"。取不到就返回 undefined，**不猜一个变量名给用户** */
function missingVarHint(e: unknown): string | undefined {
  const m = /(secret:[A-Za-z0-9_-]+)/.exec((e as Error)?.message ?? '');
  // 捕获组存在与否要显式取：不检查的话下面会把 undefined 拼进报错，
  // 变成"设环境变量 ATEST_SECRET_UNDEFINED=..."这种照抄会中招的修法
  const ref = m?.[1];
  if (!ref) return undefined;
  const key = secretEnvKey(ref);
  if (!key) return undefined;
  // 只给变量名与写法，绝不说"当前值是 …"—— 这条命令本来就在处理凭证，
  // 它的输出是全套系统里最容易被复制粘贴的东西
  return `设环境变量 ${key}="<真值>"（ref ${ref}）。不要把真值写进 env 文件或命令行`;
}

/**
 * 退出码。
 *
 * needs-config / rejected → EXIT.ENV(4)：docs/05 §2 定的语义是"环境缺失"，
 * 与"产品坏了"(1) 必须分开 —— 混起来的后果是值班人拿 401 去查产品代码。
 * unreachable / not-probed → EXIT.OK(0) 但**必须在 stdout 明说"未判定"**：
 * 让流水线因为"某台机器没连上内网"而红，会让人开始忽略红灯，
 * 而这条命令的价值恰恰在于它的结论可信。
 */
export function authCheckExit(r: AuthCheckResult): number {
  return r.problems > 0 ? EXIT.ENV : EXIT.OK;
}
