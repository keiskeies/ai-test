// T16 探针页（ui-params 挂载点）：T17 的 uiCaseDetail 还没落地，命令参数表单与元素
// 选择器在产品里暂时没有宿主页面。这个夹具挂载的是**真实组件 + 真实 api client**
// （token/project 走 e2e seedProject 注入的 localStorage），打的都是真接口——它不假造
// 用例页，只回答「这两个组件自己能不能用」这一个问题；T17 落地后 uiCase.spec 的断言
// 迁到真页面，这个挂载点的用例职责由产品页接管。
import { useEffect, useState } from "react";
import { App as AntApp, Button, ConfigProvider, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import { antdThemeFor } from "../ui/antdTheme";
import { useAuth } from "../auth/store";
import { post } from "../api/client";
import { uiApi } from "../api/ui";
import CommandParams from "../ui/CommandParams";
import { newCommand, summary, type UiCommand } from "../ui/commands";

function initialCmd(): UiCommand {
  const c = newCommand("click");
  c.id = "u1";
  return c;
}

export default function UiParamsProbe() {
  const { project, ready, bootstrap, refreshProject } = useAuth();
  const [cmd, setCmd] = useState<UiCommand>(initialCmd);
  const [names, setNames] = useState<Record<string, string>>({});
  const [roundtrip, setRoundtrip] = useState("—");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      await bootstrap();
      // 项目快照按 my_perms 决定「就地新建」入口：拿服务端下发的那份，不靠前端猜角色
      await refreshProject();
    })();
  }, [bootstrap, refreshProject]);

  const pid = project?.id ?? null;

  async function saveAndFetchBack(): Promise<void> {
    if (!pid) return;
    setSaving(true);
    try {
      const created = await post<{ id: string }>("/ui-cases", {
        project_id: pid, name: "probe-rt-" + Date.now().toString(36), priority: "P2",
        steps: [cmd], project_public: true,
      });
      const back = await uiApi.getCase(pid, created.id);
      const step = (back.steps ?? [])[0] ?? null;
      setRoundtrip(step === null ? "—" : JSON.stringify(step));
    } finally { setSaving(false); }
  }

  return (
    <ConfigProvider theme={antdThemeFor("light")} locale={zhCN}>
      <AntApp>
        <div data-testid="page-ui-params-probe" style={{ padding: 24, maxWidth: 720 }}>
          <Typography.Title level={4}>T16 参数表单探针</Typography.Title>
          {!ready || !pid
            ? <Typography.Text>等待登录态（tp_token / tp_project）…</Typography.Text>
            : <CommandParams cmd={cmd}
                onChange={(c) => { setCmd(c); setRoundtrip("—"); }}
                onElementNames={(name, id) => setNames((n) => ({ ...n, [id]: name }))} />}
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>行摘要：</Typography.Text>
            <span data-testid="probe-summary">{summary(cmd, names)}</span>
          </div>
          <pre data-testid="probe-cmd-json" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(cmd)}</pre>
          <Button data-testid="probe-roundtrip-save" loading={saving} disabled={!pid}
            onClick={() => void saveAndFetchBack()}>
            存进 ui-cases 并读回（后端往返）
          </Button>
          <pre data-testid="probe-roundtrip" style={{ whiteSpace: "pre-wrap" }}>{roundtrip}</pre>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
