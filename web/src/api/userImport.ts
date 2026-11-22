// D40（§11.4.22）用户批量导入的前端调用面：本地类型 + client 调用。
// 纪律：schema.d.ts 是生成物不许手改，新端点的手写调用集中在这里；
// 口径复用 1E T4 导入向导（api/ImportWizard.tsx）的「冲突逐条跳过 + 报告」形状——
// 解析、字段映射、角色选择全部由后端参数真认（假门禁令），前端不内置任何规则副本。
import { post } from "./client";

export interface UserImportPreviewItem {
  line: number;
  account: string;
  name: string;
  email: string | null;
  exists: boolean;
}
export interface UserImportPreviewOut {
  new_count: number;
  conflict_count: number;
  items: UserImportPreviewItem[];
  errors: string[]; // 带行号的人话（这些行没进列表）
}
export interface UserImportRowOutcome {
  line: number;
  account: string;
  reason: string;
}
export interface UserImportCommitOut {
  ok: boolean; // false = 落库层故障整批回滚（一个用户都没建）
  created: number;
  skipped: number;
  failed: number;
  failures: UserImportRowOutcome[];
  skipped_detail: UserImportRowOutcome[];
}

export function userImportPreview(text: string): Promise<UserImportPreviewOut> {
  return post<UserImportPreviewOut>("/system/users/import-preview", { text });
}

export interface UserImportCommitPayload {
  items: Array<{ line: number; account: string; name: string; email: string | null; strategy: "skip" | "create" }>;
  initial_password: string;
  is_system_admin: boolean;
}

export function userImportCommit(p: UserImportCommitPayload): Promise<UserImportCommitOut> {
  return post<UserImportCommitOut>("/system/users/import-commit", p);
}
