import { useState } from "react";
import { Button, Card, Form, Input, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/store";
import { tp, tpv } from "../theme";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const login = useAuth((s) => s.login);
  const nav = useNavigate();

  async function onFinish(v: { account: string; password: string }) {
    setLoading(true);
    try {
      await login(v.account, v.password);
      nav("/", { replace: true });
    } catch {
      /* client 已 toast（401 走统一登出路径，这里保持停留在登录页） */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: tpv.bg.layout, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 400, boxShadow: tpv.shadow.s2 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }} data-testid="login-heading">
            TestPilot
          </Typography.Title>
          <Typography.Text type="secondary">自托管智能测试平台</Typography.Text>
        </div>
        <Form onFinish={onFinish} layout="vertical" size="large">
          <Form.Item name="account" rules={[{ required: true, message: "请输入账号" }]} style={{ marginBottom: 16 }}>
            <Input data-testid="login-account" placeholder="账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]} style={{ marginBottom: 24 }}>
            <Input.Password data-testid="login-password" placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} data-testid="login-submit">
            登录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12, textAlign: "center" }}>
          没有账号？请联系管理员开通（平台不开放注册）
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
