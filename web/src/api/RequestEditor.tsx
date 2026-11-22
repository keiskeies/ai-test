// 请求编辑器（§11.4.4 子集）：参数/请求头/Body/断言/超时 五 Tab；pairs 表格可增删。
// 与 req.ts 同层复用；readOnly 供详情只读渲染。
import { lazy, Suspense } from "react";
import { Button, Input, InputNumber, Select, Space, Spin, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from "../ui/icons";
import { ASSERT_TYPES, METHODS } from "./req";
import type { Assertion, AuthType, Pair, RequestObject } from "./req";

// R49/D174：Body 与脚本断言两个多行输入升级 CodeEditor。与 scene/PropsPanel、adb/StepParams
// 同一口径懒加载（monaco 4.5MB chunk 只在字段出现时才拉）。CodeEditor 不转发 data-testid，
// 字段原 testid 落在外层包裹 div 上——现有测试经 wrapper 定位，e2e 定位符不变。
const CodeEditor = lazy(() => import("../components/CodeEditor"));
const editorFallback = <Spin style={{ display: "block", padding: 24 }} />;

export interface DraftAuth {
  type: AuthType;
  username: string;
  password: string;
  token: string;
}

export interface Draft {
  method: string;
  url: string;
  params: Pair[];
  headers: Pair[];
  // 摊平成三个字符串字段：输入框直接绑定，切类型不丢已填值（存盘时按类型挑着装）
  auth: DraftAuth;
  body: { type: "none" | "json" | "text" | "form"; content?: string };
  timeout_ms: number;
  assertions: Assertion[];
}

export function toDraft(r?: Partial<RequestObject> | null): Draft {
  return {
    method: r?.method ?? "GET",
    url: r?.url ?? "",
    params: r?.params ? r.params.map((p) => [p[0] ?? "", p[1] ?? ""] as Pair) : [],
    headers: r?.headers ? r.headers.map((p) => [p[0] ?? "", p[1] ?? ""] as Pair) : [],
    auth: {
      type: r?.auth?.type ?? "none",
      username: r?.auth?.config?.username ?? "",
      password: r?.auth?.config?.password ?? "",
      token: r?.auth?.config?.token ?? "",
    },
    body: { type: r?.body?.type ?? "none", content: r?.body?.content ?? "" },
    timeout_ms: r?.timeout_ms ?? 10000,
    assertions: (r?.assertions ?? []).map((a) => ({ ...a })),
  };
}

const used = (ps: Pair[]): number => ps.filter((p) => p[0].trim() !== "").length;

/** 断言行排序（D78）：交换两行的位置，后端按数组顺序求值，改顺序就是改判定顺序。 */
function swap<T>(xs: T[], i: number, j: number): T[] {
  const next = xs.slice();
  const t = next[i];
  next[i] = next[j];
  next[j] = t;
  return next;
}

export function fromDraft(d: Draft): RequestObject {
  const auth = d.auth.type === "none"
    ? null
    : d.auth.type === "basic"
      ? { type: d.auth.type, config: { username: d.auth.username, password: d.auth.password } }
      : { type: d.auth.type, config: { token: d.auth.token } };
  return {
    method: d.method,
    url: d.url,
    params: d.params.filter((p) => p[0].trim() !== ""),
    headers: d.headers.filter((p) => p[0].trim() !== ""),
    // 后端 RequestAuth.type 必填：none 也显式落键，Round-trip 才逐字一致
    auth: auth ?? { type: "none" },
    body: d.body.type === "none" ? { type: "none" } : { type: d.body.type, content: d.body.content ?? "" },
    timeout_ms: d.timeout_ms,
    assertions: d.assertions.filter((a) => a.type),
  };
}

export function PairTable({ rows, onChange, ro, kPh, vPh, idPrefix = "pair" }: {
  rows: Pair[]; onChange: (v: Pair[]) => void; ro?: boolean; kPh: string; vPh: string;
  /** 同一页面可能并存多个 pair 表（参数/请求头/环境变量…），用前缀区分避免定位歧义 */
  idPrefix?: string;
}) {
  const data = rows.map((p, i) => ({ i, k: p[0], v: p[1] }));
  const set = (i: number, side: "k" | "v", val: string) => {
    const next = rows.map((p) => [...p] as Pair);
    next[i][side === "k" ? 0 : 1] = val;
    onChange(next);
  };
  return (
    <div>
      <Table size="small" pagination={false} rowKey="i" dataSource={data}
        locale={{ emptyText: "暂无" }}
        columns={[
          { title: kPh, render: (_, r) => (
            <Input data-testid={idPrefix + "-key-" + r.i} size="small" value={r.k} disabled={ro}
              placeholder={kPh} onChange={(e) => set(r.i, "k", e.target.value)} />
          ) },
          { title: vPh, render: (_, r) => (
            <Input data-testid={idPrefix + "-val-" + r.i} size="small" value={r.v} disabled={ro} placeholder={vPh}
              onChange={(e) => set(r.i, "v", e.target.value)} />
          ) },
          ...(ro ? [] : [{ title: "", width: 44, render: (_: unknown, r: { i: number }) => (
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={"删行" + r.i}
              onClick={() => onChange(rows.filter((_, j) => j !== r.i))} />
          ) }]),
        ]}
      />
      {!ro && (
        <Button size="small" type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
          data-testid={idPrefix + "-add"} onClick={() => onChange([...rows, ["", ""]])}>
          添加一行
        </Button>
      )}
    </div>
  );
}

export default function RequestEditor({ value, onChange, readOnly, assertLabel, assertHint, testIdPrefix = "req" }: {
  value: Draft;
  onChange?: (d: Draft) => void;
  readOnly?: boolean;
  assertLabel?: string;   // 用例场景：断言是「追加在定义之后」，与定义内断言语义不同
  assertHint?: string;
  /** 同一屏可能并存两个编辑器（接口定义 / 用例覆盖层），前缀区分避免定位歧义 */
  testIdPrefix?: string;
}) {
  const patch = (p: Partial<Draft>) => onChange?.({ ...value, ...p });
  // 页签计数只算将执行的行：enabled===false 的行后端不执行也不产结果行
  // （shared/assertions.py evaluate），写总数会把「断言(3)」报给一份只有 1 行结果的报告。
  const enabledCount = value.assertions.filter((a) => a.enabled !== false).length;
  const disabledCount = value.assertions.length - enabledCount;
  const setAssertion = (i: number, p: Partial<Assertion>) => {
    const next = value.assertions.map((a, j) => (j === i ? { ...a, ...p } : a));
    patch({ assertions: next });
  };
  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Select data-testid={testIdPrefix + "-method"} style={{ width: 110 }} value={value.method} disabled={readOnly}
          options={METHODS.map((m) => ({ value: m, label: m }))} onChange={(m) => patch({ method: m })} />
        <Input data-testid={testIdPrefix + "-url"} style={{ width: 460 }} value={value.url} disabled={readOnly}
          placeholder="URL，支持 ${var}，如 ${base_url}/order/1"
          onChange={(e) => patch({ url: e.target.value })} />
        <Tooltip title="毫秒">
          <InputNumber data-testid={testIdPrefix + "-timeout"} min={1} max={120000} style={{ width: 120 }}
            value={value.timeout_ms} disabled={readOnly}
            addonAfter="ms" onChange={(v) => patch({ timeout_ms: Number(v ?? 10000) })} />
        </Tooltip>
      </Space>
      <Tabs size="small" items={[
        { key: "params", label: `参数(${used(value.params)})`, children: (
          <PairTable idPrefix={testIdPrefix + "-param"} kPh="参数名" vPh="参数值" rows={value.params} ro={readOnly}
            onChange={(v) => patch({ params: v })} />
        ) },
        { key: "headers", label: `请求头(${used(value.headers)})`, children: (
          <PairTable idPrefix={testIdPrefix + "-header"} kPh="头名" vPh="头值" rows={value.headers} ro={readOnly}
            onChange={(v) => patch({ headers: v })} />
        ) },
        { key: "body", label: "Body", children: (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Select data-testid={testIdPrefix + "-body-type"} style={{ width: 140 }} value={value.body.type} disabled={readOnly}
              options={["none", "json", "text", "form"].map((t) => ({ value: t, label: t }))}
              onChange={(t) => patch({ body: { ...value.body, type: t } })} />
            {value.body.type !== "none" && (
              <div data-testid={testIdPrefix + "-body-content"}>
                <Suspense fallback={editorFallback}>
                  <CodeEditor height={140} language={value.body.type === "json" ? "json" : "plaintext"}
                    readOnly={!!readOnly} value={value.body.content ?? ""}
                    onChange={(v) => patch({ body: { ...value.body, content: v } })} />
                </Suspense>
              </div>
            )}
          </Space>
        ) },
        { key: "auth", label: value.auth.type === "none" ? "Auth" : `Auth(${value.auth.type})`, children: (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Select data-testid={testIdPrefix + "-auth-type"} style={{ width: 140 }} value={value.auth.type} disabled={readOnly}
              options={["none", "basic", "bearer"].map((t) => ({ value: t, label: t }))}
              onChange={(t) => patch({ auth: { ...value.auth, type: t as AuthType } })} />
            {value.auth.type === "basic" && (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input data-testid={testIdPrefix + "-auth-username"} style={{ width: 260 }} value={value.auth.username}
                  disabled={readOnly} placeholder="用户名" onChange={(e) => patch({ auth: { ...value.auth, username: e.target.value } })} />
                {/* 口令一律密文渲染：明文回显会进肩窥与截屏 */}
                <Input.Password data-testid={testIdPrefix + "-auth-password"} style={{ width: 260 }} value={value.auth.password}
                  disabled={readOnly} placeholder="密码" visibilityToggle={!readOnly}
                  onChange={(e) => patch({ auth: { ...value.auth, password: e.target.value } })} />
              </Space>
            )}
            {value.auth.type === "bearer" && (
              <Input.Password data-testid={testIdPrefix + "-auth-token"} style={{ width: 320 }} value={value.auth.token}
                disabled={readOnly} placeholder="Token，随 Authorization: Bearer <token> 发出" visibilityToggle={!readOnly}
                onChange={(e) => patch({ auth: { ...value.auth, token: e.target.value } })} />
            )}
            {value.auth.type !== "none" && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Auth 配置发出的 Authorization 头会覆盖「请求头」页签里手写的同名头。
              </Typography.Text>
            )}
          </Space>
        ) },
        { key: "assert", label: `${assertLabel ?? "断言"}(${enabledCount}${disabledCount > 0 ? " · 停用 " + disabledCount : ""})`, children: (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {assertHint && <Typography.Text type="secondary">{assertHint}</Typography.Text>}
            {value.assertions.map((a, i) => (
              <Space key={i} data-testid={testIdPrefix + "-assert-row"} wrap>
                <Select data-testid={testIdPrefix + "-assert-type-" + i} style={{ width: 150 }} value={a.type} disabled={readOnly}
                  options={ASSERT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  // 切类型 = 换语义：上一类型的载荷键（path/expected/timeout_ms/code）一律归零，
                  // 否则旧 code 会跟着 status_code 存进请求，执行人看见却永不执行。
                  onChange={(t) => setAssertion(i, { type: t, path: null, expected: null, timeout_ms: null, code: null })} />
                {(a.type === "json_path_equals" || a.type === "regex") && (
                  <Input data-testid={testIdPrefix + "-assert-path-" + i} style={{ width: 180 }}
                    placeholder={a.type === "regex" ? "JSONPath（可选，先取字段再匹配）" : "JSONPath，如 $.status"}
                    value={a.path ?? ""} disabled={readOnly}
                    onChange={(e) => setAssertion(i, { path: e.target.value })} />
                )}
                {a.type === "script" && (
                  <div data-testid={testIdPrefix + "-assert-code-" + i} style={{ width: 520 }}>
                    <Suspense fallback={editorFallback}>
                      <CodeEditor height={140} language="python"
                        readOnly={!!readOnly} value={a.code ?? ""}
                        onChange={(v) => setAssertion(i, { code: v })} />
                    </Suspense>
                  </div>
                )}
                {(a.type === "response_time_lt" || a.type === "script") ? (
                  // timeout_ms 一键两用：response_time_lt 是延迟阈值，script 是单条沙箱时限（§8.5）——与后端 schema 同键。
                  // 留空落真 null（禁 0：0 对 response_time_lt 是恒假阈值 elapsed_ms<0，对 script 是假的默认回落）：
                  // script 留空真走后端 5s 默认；response_time_lt 没有默认，留空得一条「缺少阈值」失败行。
                  <InputNumber data-testid={testIdPrefix + "-assert-timeout-" + i} style={{ width: 140 }} min={1} placeholder="毫秒" value={a.timeout_ms ?? null} disabled={readOnly}
                    addonAfter="ms" onChange={(v) => setAssertion(i, { timeout_ms: v == null ? null : Number(v) })} />
                ) : (
                  <Input data-testid={testIdPrefix + "-assert-expected-" + i} style={{ width: 200 }}
                    placeholder={a.type === "regex" ? "正则，如 ^tk$" : "期望值"} value={String(a.expected ?? "")} disabled={readOnly}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const num = a.type === "status_code" && raw !== "" && /^\d+$/.test(raw);
                      setAssertion(i, { expected: num ? Number(raw) : raw });
                    }} />
                )}
                {/* D78 启用开关：关掉的行后端不执行、不产结果行（evaluate 只跳 enabled===false，
                    缺省 = 启用，老数据照旧）。这是真闸不是装饰，语义与 shared/assertions.py 同源。 */}
                <Tooltip title="停用后这条断言不参与执行，报告里也不出现">
                  <Switch size="small" data-testid={testIdPrefix + "-assert-enabled-" + i}
                    checked={a.enabled !== false} disabled={readOnly}
                    checkedChildren="启用" unCheckedChildren="停用"
                    onChange={(v) => setAssertion(i, { enabled: v })} />
                </Tooltip>
                {/* D78 排序：上移/下移改数组顺序；后端按数组顺序求值，顺序即语义，不引拖拽库 */}
                {!readOnly && (
                  <>
                    <Button size="small" type="text" icon={<ArrowUpOutlined />}
                      data-testid={testIdPrefix + "-assert-up-" + i} aria-label={"上移断言" + i}
                      disabled={i === 0} onClick={() => patch({ assertions: swap(value.assertions, i, i - 1) })} />
                    <Button size="small" type="text" icon={<ArrowDownOutlined />}
                      data-testid={testIdPrefix + "-assert-down-" + i} aria-label={"下移断言" + i}
                      disabled={i === value.assertions.length - 1}
                      onClick={() => patch({ assertions: swap(value.assertions, i, i + 1) })} />
                  </>
                )}
                {!readOnly && (
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}
                    aria-label={"删断言" + i} onClick={() => patch({ assertions: value.assertions.filter((_, j) => j !== i) })} />
                )}
              </Space>
            ))}
            {!readOnly && (
              <Button size="small" type="dashed" block icon={<PlusOutlined />} data-testid={testIdPrefix + "-assert-add"}
                onClick={() => patch({ assertions: [...value.assertions, { type: "status_code", expected: 200 }] })}>
                添加断言
              </Button>
            )}
          </div>
        ) },
      ]} />
      {readOnly && value.assertions.length === 0 && (
        <Typography.Text type="secondary"><Tag>无断言</Tag>调试只发请求不校验，建议至少加一条状态码断言</Typography.Text>
      )}
    </div>
  );
}
