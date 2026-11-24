import type { ReactNode } from "react";

/** 全屏记录编辑器（接口 / 功能用例 / 缺陷）的字段壳：标签 12/500、必填点红、提示退一档。
 *  三处编辑器共用同一份 DOM，免得「同一个标签在三个页面三套字号」。 */
export default function EditorField({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="tp-field">
      <div className="tp-field-label">
        <span>{label}</span>
        {required && <span className="tp-field-req" aria-hidden>*</span>}
      </div>
      {children}
      {hint && <div className="tp-field-hint">{hint}</div>}
    </div>
  );
}
