// D40（§11.4.22）用户批量导入向导：1E T4 ImportWizard 的同款三步——
// ①来源（粘贴 CSV/TSV 文本 + 选文件入口：T4 同款「不放文件选择」的欠账已还，
//   复用 FileTextPicker 真读文本灌进同一 text state，超 UserImportPreviewIn.text 的 2_000_000 上限拒读）→
// ②预览（新增/冲突计数 + 逐条冲突勾选跳过；初始密码 + 「导入为平台管理员」都是后端参数）→
// ③回执（成 n 跳 n 失败 n + 逐条行号原因 + 下载错误报告）。
// 解析与冲突判定全在后端（user_import_preview/commit），前端只回显，不内置规则副本。
import { useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Input, Modal, Space, Steps, Table, Typography, message,
} from "antd";
import { downloadErrorReport, FileTextPicker } from "../api/ImportWizard";
import { userImportCommit, userImportPreview } from "../api/userImport";
import type { UserImportCommitOut, UserImportPreviewItem, UserImportPreviewOut } from "../api/userImport";

export default function UserImportWizard({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<UserImportPreviewOut | null>(null);
  // 新增行的排除勾选：行号 -> 是否「本次不导入」（缺省 = 导入）。
  // 冲突行没有勾选框也没有「覆盖」档：用户批量导入的蓝图口径就是冲突跳过——
  // 「覆盖已有账号」意味着改别人的账号资料，那不是导入的语义（后端 commit 同样恒 skip 冲突行）。
  const [skipMap, setSkipMap] = useState<Record<number, boolean>>({});
  const [password, setPassword] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [receipt, setReceipt] = useState<UserImportCommitOut | null>(null);

  const reset = () => {
    setStep(0); setPreview(null); setSkipMap({}); setReceipt(null);
    setText(""); setPassword(""); setAsAdmin(false);
  };

  const counts = useMemo(() => {
    if (!preview) return { fresh: 0, skip: 0 };
    let skip = 0;
    preview.items.forEach((it) => {
      if (it.exists) return;
      if (skipMap[it.line] === true) skip += 1;
    });
    return { fresh: preview.new_count, skip };
  }, [preview, skipMap]);

  async function parse() {
    if (!text.trim()) { message.warning("先粘贴 CSV/TSV 文本"); return; }
    setBusy(true);
    try {
      const p = await userImportPreview(text);
      setPreview(p);
      // 冲突行缺省 = 跳过（冲突不覆盖是 D40 口径），勾掉 = 反而不建它没意义，
      // 所以勾选框只给「新增」行：勾上 = 这行我不导。
      setSkipMap({});
      setStep(1);
    } catch { /* toast 在 client */ } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    if (password.length < 8) { message.warning("初始密码至少 8 位（后端同样强校验）"); return; }
    setBusy(true);
    try {
      const items = preview.items.map((it) => ({
        line: it.line, account: it.account, name: it.name, email: it.email,
        // 冲突行恒 skip；新增行按逐条勾选（勾了 = skip）——界面勾了什么后端就认什么
        strategy: (it.exists || skipMap[it.line] === true ? "skip" : "create") as "skip" | "create",
      }));
      const r = await userImportCommit({
        items, initial_password: password, is_system_admin: asAdmin,
      });
      setReceipt(r); setStep(2);
      if (r.ok && r.created > 0) message.success("已创建 " + r.created + " 个用户，请把初始密码转告本人");
      onImported(); // 部分成功也要刷列表：界面与「成 n 跳 n」的账当面对得上
    } catch { /* toast 在 client */ } finally { setBusy(false); }
  }

  const reportLines = useMemo(() => {
    const out: string[] = [];
    if (preview) out.push(...preview.errors);
    if (receipt) {
      out.push(...receipt.failures.map((f) => `第 ${f.line} 行 ${f.account}：${f.reason}`));
      out.push(...receipt.skipped_detail.map((f) => `第 ${f.line} 行 ${f.account}：${f.reason}`));
    }
    return out;
  }, [preview, receipt]);

  return (
    // 960 = 浮层五档里的向导档（880 不在档上）；centered 防 768 高屏底部顶出视口。
    <Modal title="批量导入用户" open={open} width={960} centered onCancel={() => { reset(); onClose(); }}
      data-testid="uiw-modal"
      footer={step === 2 ? [
        <Button key="dl" data-testid="uiw-download" disabled={reportLines.length === 0}
          onClick={() => downloadErrorReport(reportLines, "用户导入报告.txt")}>下载错误报告</Button>,
        <Button key="close" type="primary" data-testid="uiw-close" onClick={() => { reset(); onClose(); }}>关闭</Button>,
      ] : step === 1 ? [
        <Button key="back" data-testid="uiw-back" onClick={() => setStep(0)}>上一步</Button>,
        <Button key="go" type="primary" data-testid="uiw-commit" loading={busy}
          disabled={!preview || preview.items.length === 0} onClick={() => void commit()}>导入</Button>,
      ] : [
        <Button key="parse" type="primary" data-testid="uiw-parse" loading={busy} onClick={() => void parse()}>解析</Button>,
      ]}
    >
      <Steps current={step} items={[{ title: "来源" }, { title: "预览" }, { title: "结果" }]}
        style={{ marginBottom: 16 }} />

      {step === 0 && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text type="secondary" className="tp-text-sm">
            粘贴 CSV/TSV（首行列头，认「账号,姓名,邮箱」或 account,name/email；逗号或制表符分隔）。
            格式不合法的行会在下一步逐行说明「第几行为什么被跳过」，不静默丢行。
          </Typography.Text>
          <Input.TextArea data-testid="uiw-text" rows={10} value={text} className="tp-mono"
            placeholder={"账号,姓名,邮箱\nzhangsan,张三,z@x.com"} onChange={(e) => setText(e.target.value)} />
          {/* 上限照抄后端 UserImportPreviewIn.text 的 max_length=2_000_000，不是前端发明的数 */}
          <FileTextPicker testId="uiw-file" maxChars={2_000_000} onText={(t) => setText(t)} />
        </Space>
      )}

      {step === 1 && preview && (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Typography.Text data-testid="uiw-counts">
              可建 {counts.fresh - counts.skip} · 不建 {preview.conflict_count + counts.skip}
              （冲突 {preview.conflict_count} · 手动排除 {counts.skip}）
            </Typography.Text>
          </Space>
          {preview.errors.length > 0 && (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }} data-testid="uiw-errors"
              message={"格式问题 " + preview.errors.length + " 条（这些行没进列表）"}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>} />
          )}
          <Table<UserImportPreviewItem> size="small" rowKey={(r) => String(r.line)} dataSource={preview.items}
            pagination={false} scroll={{ y: 280 }}
            columns={[
              { title: "行", dataIndex: "line", width: 56 },
              { title: "账号", dataIndex: "account", ellipsis: true },
              { title: "姓名", dataIndex: "name", ellipsis: true },
              { title: "邮箱", dataIndex: "email", ellipsis: true, render: (v: string | null) => v ?? "—" },
              { title: "处置", width: 190, render: (_v, r) => (
                r.exists
                  ? <Typography.Text type="secondary" data-testid={"uiw-conflict-" + r.line}>账号已存在 → 跳过</Typography.Text>
                  : <Checkbox data-testid={"uiw-skip-" + r.line} checked={skipMap[r.line] === true}
                      onChange={(e) => setSkipMap({ ...skipMap, [r.line]: e.target.checked })}>
                      本次不导入
                    </Checkbox>
              ) },
            ]} />
          <Space direction="vertical" style={{ width: "100%", marginTop: 12 }} size={8}>
            <Input.Password data-testid="uiw-password" value={password}
              placeholder="整批共用初始密码（至少 8 位；平台只存哈希，请线下转告本人）"
              onChange={(e) => setPassword(e.target.value)} />
            <Checkbox data-testid="uiw-admin" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)}>
              导入为平台管理员
            </Checkbox>
          </Space>
        </>
      )}

      {step === 2 && receipt && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text className="tp-text-lg" data-testid="uiw-receipt">
            {receipt.ok
              ? <>成功 {receipt.created} · 跳过 {receipt.skipped} · 失败 {receipt.failed}</>
              : <>成功 0 · 失败 {receipt.failed}——落库故障，整批已回滚，一个用户都没建</>}
          </Typography.Text>
          {reportLines.length > 0 && (
            <Alert type={receipt.ok ? "warning" : "error"} showIcon data-testid="uiw-report"
              message={reportLines.length + " 条明细（逐行可对回粘贴原文；可用左下角按钮下载）"}
              description={<ul style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflow: "auto" }}>
                {reportLines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>} />
          )}
        </Space>
      )}
    </Modal>
  );
}
