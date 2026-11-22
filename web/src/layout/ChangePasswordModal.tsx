// D105 自助改密（后端 1A 就交付了 password_change_self，前端一直没有入口）。
// 入口在 shell 头像菜单；门禁口径是「已登录」而不是 can(perms, "auth:password:self")——
// 理由钉在 shell.tsx 挂点处与 auth/perms.ts:51 的注释里（项目词表不保证含这一位，
// 按项目 perms 门禁会把 READONLY / 未选项目的人挡成假门，而后端对他们一律放行）。
// 错误面：POST /auth/password 旧密不符是 403 bad_credentials（user_services.py:115）。
// 上屏口径与 uiElements/UsersTab/login 一致：不 silent、不自译——client.ts 的默认 toast
// 直接吃后端信封的中文 message（「旧密码不正确」本就是人话，code 不上屏），组件只补一条
// 「失败不关窗可重试」；后端 message 哪天变英文，修 client 一处，不在这里抄一份。
// 成功后的裁决依据：改密**不**吊销任何令牌——access 是无状态 JWT（security.py:27，无 jti），
// refresh 明写「签发后到过期前无法撤销」（security.py:45-48），get_current_user 只查 status
// 不查口令版本（deps.py:30）。既然后端选择让现有会话继续活着，前端不发明「改完强制登出」
// 这种后端没有的策略；弹窗里如实写明这条真实语义，不许诺做不到的事。
import { useState } from "react";
import { Form, Input, Modal, Typography, message } from "antd";
import { post } from "../api/client";

export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function submit(): Promise<void> {
    // validateFields 失败必须在这里就地吞掉：校验不过时字段旁已有红字，再 toast 是噪音；
    // 而让它 reject 出去（外层是 void submit()）就是 unhandled rejection。
    let v: { old_password: string; new_password: string };
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await post("/auth/password", { old_password: v.old_password, new_password: v.new_password });
      message.success("密码已修改");
      form.resetFields();
      onClose();
    } catch {
      /* 错误 client 已 toast（bad_credentials → 后端中文原话「旧密码不正确」，code 不上屏）；
         这里刻意不关窗：旧密打错就地重填，不必重开弹窗。 */
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal centered open={open} title="修改密码" data-testid="pwd-change-modal" okText="确认修改" cancelText="取消"
      okButtonProps={{ loading: saving, "data-testid": "pwd-change-ok" } as never}
      onOk={() => void submit()} onCancel={onClose} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="old_password" label="旧密码" rules={[{ required: true, message: "请输入旧密码" }]}>
          <Input.Password data-testid="pwd-field-old" autoComplete="current-password" />
        </Form.Item>
        {/* min 8 与后端 PasswordChangeIn.new_password 的 min_length=8 对齐（schemas.py:63） */}
        <Form.Item name="new_password" label="新密码"
          rules={[{ required: true, min: 8, message: "至少 8 位" }]}>
          <Input.Password data-testid="pwd-field-new" autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" dependencies={["new_password"]}
          rules={[
            { required: true, message: "请再次输入新密码" },
            ({ getFieldValue }) => ({
              validator(_, value: string) {
                if (!value || getFieldValue("new_password") === value) return Promise.resolve();
                return Promise.reject(new Error("两次输入的新密码不一致"));
              },
            }),
          ]}>
          <Input.Password data-testid="pwd-field-confirm" autoComplete="new-password" />
        </Form.Item>
      </Form>
      <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginBottom: 0 }}>
        平台只存密码哈希，不保存明文。修改后当前浏览器的登录状态仍会保持到有效期结束，
        需要立即退出请再点「退出登录」。
      </Typography.Paragraph>
    </Modal>
  );
}
