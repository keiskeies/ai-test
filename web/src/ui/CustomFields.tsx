// 动态自定义字段渲染（D192）。模板字段 → 控件；值一律以 native 形式持有
// （string / number / string[]），保存前不需要前端二次编码——后端统一 JSON 落库。
// 未知类型**原样渲染只读文本**（R112：陌生码不翻译、不隐藏）。
import { Checkbox, Input, InputNumber, Radio, Select, Space, Typography } from "antd";
import type { TemplateField } from "../api/projectMeta";
import { MULTI_TYPES } from "../api/projectMeta";

export type MemberOption = { user_id: string; name: string | null; account: string | null };

function toLocalInput(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function memberOptions(members: MemberOption[]): { value: string; label: string }[] {
  return members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id }));
}

export default function CustomFieldForm({ fields, values, onChange, members = [], disabled = false }: {
  fields: TemplateField[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  members?: MemberOption[];
  disabled?: boolean;
}) {
  if (fields.length === 0) {
    return <Typography.Text type="secondary" className="tp-text-sm">当前模板没有自定义字段</Typography.Text>;
  }
  const set = (id: string, v: unknown): void => {
    const next = { ...values };
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete next[id];
    else next[id] = v;
    onChange(next);
  };
  const v = (id: string): unknown => values[id];

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      {fields.map((f) => {
        const val = v(f.field_id);
        const label = (
          <Typography.Text strong>
            {f.name}{f.required ? <Typography.Text type="danger"> *</Typography.Text> : null}
          </Typography.Text>
        );
        let control: React.ReactNode;
        switch (f.type) {
          case "textarea":
            control = <Input.TextArea rows={3} disabled={disabled} value={String(val ?? "")}
              onChange={(e) => set(f.field_id, e.target.value)} />;
            break;
          case "select":
            control = <Select allowClear disabled={disabled} style={{ width: "100%" }} value={val as string | undefined}
              options={f.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(x) => set(f.field_id, x)} />;
            break;
          case "multiple_select":
            control = <Select mode="multiple" allowClear disabled={disabled} style={{ width: "100%" }}
              value={(val as string[] | undefined) ?? []}
              options={f.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(x) => set(f.field_id, x)} />;
            break;
          case "radio":
            control = <Radio.Group disabled={disabled} value={val as string | undefined}
              onChange={(e) => set(f.field_id, e.target.value)}
              options={f.options.map((o) => ({ value: o.value, label: o.label }))} />;
            break;
          case "checkbox":
            control = <Checkbox.Group disabled={disabled} value={(val as string[] | undefined) ?? []}
              onChange={(x) => set(f.field_id, x)}
              options={f.options.map((o) => ({ value: o.value, label: o.label }))} />;
            break;
          case "member":
            control = <Select allowClear disabled={disabled} style={{ width: "100%" }}
              value={val as string | undefined} options={memberOptions(members)}
              onChange={(x) => set(f.field_id, x)} />;
            break;
          case "multiple_member":
            control = <Select mode="multiple" allowClear disabled={disabled} style={{ width: "100%" }}
              value={(val as string[] | undefined) ?? []} options={memberOptions(members)}
              onChange={(x) => set(f.field_id, x)} />;
            break;
          case "date":
            // 原生 date 控件：值就是 YYYY-MM-DD，不引 dayjs（antd 的 DatePicker 要 dayjs 实例，
            // 而 dayjs 只是 antd 的传递依赖，pnpm 下不适合直接从业务代码 import）。
            control = <Input type="date" disabled={disabled} value={String(val ?? "")}
              onChange={(e) => set(f.field_id, e.target.value)} />;
            break;
          case "datetime":
            control = <Input type="datetime-local" disabled={disabled}
              value={toLocalInput(val)}
              onChange={(e) => set(f.field_id, e.target.value ? new Date(e.target.value).toISOString() : undefined)} />;
            break;
          case "int":
            control = <InputNumber disabled={disabled} style={{ width: "100%" }} precision={0}
              value={typeof val === "number" ? val : val ? Number(val) : null}
              onChange={(x) => set(f.field_id, x ?? undefined)} />;
            break;
          case "float":
            control = <InputNumber disabled={disabled} style={{ width: "100%" }}
              value={typeof val === "number" ? val : val ? Number(val) : null}
              onChange={(x) => set(f.field_id, x ?? undefined)} />;
            break;
          case "multiple_input":
            control = <Select mode="tags" disabled={disabled} style={{ width: "100%" }}
              value={(val as string[] | undefined) ?? []} tokenSeparators={[",", "，"]}
              onChange={(x) => set(f.field_id, x)} />;
            break;
          case "input":
            control = <Input disabled={disabled} value={String(val ?? "")}
              maxLength={5000} onChange={(e) => set(f.field_id, e.target.value)} />;
            break;
          default:
            control = <Typography.Text type="secondary">
              {MULTI_TYPES.has(f.type) ? "未知多值类型：" : "未知字段类型："}{f.type}
            </Typography.Text>;
        }
        return (
          <div key={f.field_id} data-testid={"custom-field-" + f.field_key}>
            {label}
            {control}
          </div>
        );
      })}
    </Space>
  );
}
