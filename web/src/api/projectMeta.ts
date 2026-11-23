// 项目元数据前端镜像（D192）：模板 / 自定义字段。
// 后端 app/modules/project_meta/services.py 为准；gen:api 本刀禁跑（会抢 8321），
// 类型手写并逐字对齐 schemas.py。词表与 backend/app/shared/custom_fields.py 同源。
import { get, patch, post } from "./client";

export type Scene = "functional" | "bug" | "api" | "ui" | "test_plan";
export const SCENES: { value: Scene; label: string }[] = [
  { value: "functional", label: "功能用例" },
  { value: "bug", label: "缺陷" },
  { value: "api", label: "接口" },
  { value: "ui", label: "UI" },
  { value: "test_plan", label: "测试计划" },
];

export type FieldType =
  | "input" | "textarea" | "select" | "multiple_select" | "radio" | "checkbox"
  | "member" | "multiple_member" | "date" | "datetime" | "int" | "float" | "multiple_input";

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "input", label: "单行文本" },
  { value: "textarea", label: "多行文本" },
  { value: "select", label: "下拉单选" },
  { value: "multiple_select", label: "下拉多选" },
  { value: "radio", label: "单选" },
  { value: "checkbox", label: "多选" },
  { value: "member", label: "成员单选" },
  { value: "multiple_member", label: "成员多选" },
  { value: "date", label: "日期" },
  { value: "datetime", label: "日期时间" },
  { value: "int", label: "整数" },
  { value: "float", label: "小数" },
  { value: "multiple_input", label: "多值文本" },
];

export const OPTION_TYPES: ReadonlySet<string> = new Set([
  "select", "multiple_select", "radio", "checkbox",
]);
export const MULTI_TYPES: ReadonlySet<string> = new Set([
  "multiple_select", "checkbox", "multiple_member", "multiple_input",
]);

export type FieldOption = { value: string; label: string; sort?: number };

export type TemplateField = {
  field_id: string;
  name: string;
  field_key: string;
  type: FieldType;
  required: boolean;
  sort: number;
  default_value: unknown;
  options: FieldOption[];
};

export type TemplateItem = {
  id: string;
  project_id: string;
  scene: Scene;
  name: string;
  description: string | null;
  internal: boolean;
  is_default: boolean;
  sort: number;
  field_count: number;
  created_at: string | null;
  updated_at: string | null;
};

export type TemplateDetail = TemplateItem & { fields: TemplateField[] };

export type TemplateFieldInput = {
  field_id: string;
  required?: boolean;
  sort?: number;
  default_value?: unknown;
};

export type CustomFieldItem = {
  id: string;
  project_id: string;
  scene: Scene;
  name: string;
  field_key: string;
  type: FieldType;
  description: string | null;
  sort: number;
  internal: boolean;
  options: FieldOption[];
  template_count: number;
  created_at: string | null;
  updated_at: string | null;
};

export type CustomFieldInput = {
  project_id: string;
  scene: Scene;
  name: string;
  field_key: string;
  type: FieldType;
  description?: string | null;
  sort?: number;
  options?: FieldOption[];
};

function qs(q: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

export const projectMetaApi = {
  // D247：filter 是高级搜索条件 JSON 串（空 = 不传，URL 里不出现 filter=）。
  templates: (projectId: string, scene: Scene, filter?: string) =>
    get<{ items: TemplateItem[] }>("/templates" + qs({ project_id: projectId, scene, filter })),
  template: (projectId: string, id: string) =>
    get<TemplateDetail>("/templates/" + encodeURIComponent(id) + qs({ project_id: projectId })),
  createTemplate: (body: { project_id: string; scene: Scene; name: string; description?: string | null;
                           sort?: number; fields?: TemplateFieldInput[] }) =>
    post<TemplateDetail>("/templates", body),
  updateTemplate: (projectId: string, id: string, body: {
    project_id: string; name?: string; description?: string | null; sort?: number;
    fields?: TemplateFieldInput[];
  }) => patch<TemplateDetail>("/templates/" + encodeURIComponent(id), { ...body, project_id: projectId }),
  deleteTemplate: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/templates/" + encodeURIComponent(id) + "/delete",
      { project_id: projectId, template_id: id }),
  setDefaultTemplate: (projectId: string, id: string) =>
    post<TemplateDetail>("/templates/" + encodeURIComponent(id) + "/set-default",
      { project_id: projectId, template_id: id }),

  fields: (projectId: string, scene: Scene, filter?: string) =>
    get<{ items: CustomFieldItem[] }>("/custom-fields" + qs({ project_id: projectId, scene, filter })),
  createField: (body: CustomFieldInput) => post<CustomFieldItem>("/custom-fields", body),
  updateField: (projectId: string, id: string, body: {
    project_id: string; name?: string; description?: string | null; sort?: number;
    options?: FieldOption[];
  }) => patch<CustomFieldItem>("/custom-fields/" + encodeURIComponent(id), { ...body, project_id: projectId }),
  deleteField: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/custom-fields/" + encodeURIComponent(id) + "/delete",
      { project_id: projectId, field_id: id }),
};
