// §7.1 请求对象的前端镜像 + 断言常量（与后端 schemas.py 逐字段对齐）。
// 历史数据/导入/环境变量是两元 ["名","值"]；接口参数可带第三、四位
// ["名","值","1|0","描述"]（D288），执行层只读前两位。
export type Pair = [string, string, string?, string?];

/** 键值表的编辑行：把可选的两元/四元统一摊成四个字段。 */
export interface PairRow { k: string; v: string; required: boolean; description: string }

export interface ReqBody { type: "none" | "json" | "text" | "form"; content?: string | null }

// §7.1 auth 子集：一期只有 none/basic/bearer（apikey 执行层点名拒绝，UI 不给入口）
export type AuthType = "none" | "basic" | "bearer";
export interface ReqAuth {
  type: AuthType;
  config?: { username?: string; password?: string; token?: string };
}

export interface Assertion {
  type: string;
  path?: string | null;
  expected?: unknown;
  timeout_ms?: number | null;
  code?: string | null; // script 用：沙箱脚本正文（§8.5）
  // D78 启用开关：缺省（键不存在）= 启用，与后端 evaluate() 的 `enabled is False` 跳过对齐。
  // 关掉的断言后端**不执行、不产结果行**——编辑器里的开关是真闸，不是装饰。
  enabled?: boolean;
}

/**
 * 场景侧（步骤断言 / 场景公共断言）的行形状：草稿态，`type` 在用户填之前可以还没有。
 * 与 Assertion 同一份字段定义，不是第二份表——后端 evaluate() 吃的是同一套字典，
 * 各自抄一份就是 D77/D78 里「类型表漂了」的同一个病根。
 */
export type SceneAssertion = Partial<Assertion>;

export interface RequestObject {
  method: string;
  url: string;
  params?: Pair[];
  headers?: Pair[];
  auth?: ReqAuth | null;
  body?: ReqBody;
  timeout_ms?: number;
  assertions?: Assertion[];
}

export const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

// 七类 = 后端 shared/assertions.py 真求值的七种（D77 记的三类缺口是「蓝图有、两边都没」，
// 不是这里少列）。这里没有 hint/置灰机制：D75 摘掉的「脚本断言 1B 开放」就是把后端
// 已实现的能力在 UI 上锁成灰项（反向假门），机制留着，下一个人就会再往里塞一条。
// 蓝图 :887 全集还有「正则|XPath|结构」中的 XPath 与结构**故意不收**：结构要 JSON Schema
// （jsonschema 不在后端依赖）、XPath 要 lxml（只是传递依赖）——手写子集会骗人，待业主裁。
// 本表与后端 schemas.py 的 ASSERTION_TYPES 由 assertionTypes.contract.test.ts 钉死同源。
export const ASSERT_TYPES: { value: string; label: string }[] = [
  { value: "status_code", label: "状态码" },
  { value: "json_path_equals", label: "JSON 路径相等" },
  { value: "body_contains", label: "响应包含" },
  { value: "regex", label: "正则" },
  { value: "header_exists", label: "响应头存在" },
  { value: "response_time_lt", label: "响应时间<" },
  { value: "script", label: "脚本断言" },
];

export function pairsToRows(pairs?: Pair[] | null): PairRow[] {
  return (pairs ?? []).map((p) => ({
    k: p[0] ?? "", v: p[1] ?? "",
    required: p[2] === "1", description: p[3] ?? "",
  }));
}

/**
 * withMeta=true 用于接口参数：只有真的填了「必填/描述」才升级成四元，
 * 没填过的行仍写两元（旧数据、用例覆盖层、OpenAPI 导出的形状不变）。
 */
export function rowsToPairs(rows: PairRow[], withMeta = false): Pair[] {
  return rows.filter((r) => r.k.trim() !== "").map((r) => {
    if (withMeta && (r.required || r.description.trim() !== "")) {
      return [r.k, r.v, r.required ? "1" : "0", r.description] as Pair;
    }
    return [r.k, r.v] as Pair;
  });
}

export function cleanRequest(r: Partial<RequestObject>): RequestObject {
  const body = r.body ?? { type: "none" as const };
  return {
    method: r.method ?? "GET",
    url: r.url ?? "",
    params: rowsToPairs(pairsToRows(r.params), true),
    headers: rowsToPairs(pairsToRows(r.headers)),
    auth: r.auth ?? { type: "none" },
    body: body.type === "none" ? { type: "none" } : { type: body.type, content: body.content ?? "" },
    timeout_ms: r.timeout_ms ?? 10000,
    assertions: (r.assertions ?? []).filter((a) => a.type),
  };
}

export function statusColor(status: number | null | undefined): string {
  if (status == null) return "default";
  if (status < 300) return "green";
  if (status < 400) return "blue";
  if (status < 500) return "orange";
  return "red";
}

// ${var} 占位符计数（编辑器提示用）
export function varRefs(r: Partial<RequestObject>): string[] {
  const text = JSON.stringify(r);
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]);
  return [...out].sort();
}
