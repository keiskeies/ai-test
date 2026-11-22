// 导入向导（§11.4.6，1E T4）：960 模态三步 Steps——①来源（三选一 + 文本/URL/选文件）→
// ②预览（新增/冲突计数 + 逐条策略 跳过/覆盖）→ ③结果（成功n·失败n + 下载错误报告）。
// D26：一期只有 跳过/覆盖 两策略，「新版本」按钮不出现（与版本历史二期打架）。
// 「下载错误报告」= 前端把 errors[] 存 blob，无后端端点。
import { useMemo, useRef, useState } from "react";
import {
  Alert, Button, Checkbox, Input, Modal, Radio, Space, Steps, Table, Tag, Typography, message,
} from "antd";
import { post } from "./client";
import { METHOD_TAG } from "../theme";

export type ImportSource = "openapi3" | "swagger2" | "postman";

export interface PreviewItem {
  name: string;
  method: string;
  path: string;
  request: Record<string, unknown>;
  source_ref: string;
  exists: boolean;
  definition_id: string | null;
}
export interface PreviewOut {
  new_count: number;
  conflict_count: number;
  items: PreviewItem[];
  errors: string[];
}
export interface ImportFailure { name: string; reason: string }
export interface CommitOut {
  ok: boolean; created: number; updated: number; skipped: number;
  failed: number; failures: ImportFailure[];
}

/** 落盘公共手法：任意 blob → <a download> 点击一次即走（api.tsx 的 OpenAPI3 导出共用这份）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 错误报告落盘：errors + failures 拼文本存 blob 下载（无后端端点）。 */
export function downloadErrorReport(lines: string[], filename = "导入错误报告.txt"): void {
  downloadBlob(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }), filename);
}

/** 选文件入口（§11.4.6 的 [拖拽文件] 落成点选）：原生 <input type=file> 真读文本灌进
 *  调用方的 text state——解析/预览/提交流水一行不改，后端零改动。诚实三件：
 *  ①空文件/二进制给一句人话提示，不静默不崩；②maxChars 只对齐后端 schema 已有的约束
 *  （ImportPreviewIn.text 无长度限制故不传；UserImportPreviewIn.text 是 2_000_000 故传它），
 *  不自己发明上限；③选文件覆盖当前文本框——写在按钮旁边的说明里，不静默覆盖。 */
export function FileTextPicker({ testId, maxChars, onText }: {
  testId: string;
  maxChars?: number;
  onText: (text: string, filename: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    const label = "「" + file.name + "」";
    if (file.type.startsWith("image/") || file.type.startsWith("application/pdf")) {
      message.warning(label + "不是文本文件，读不了"); return;
    }
    const content = await file.text();
    // 二进制兜底：浏览器给不出 MIME 时（旧内核/未知扩展名），NUL 字节即二进制
    if (content.includes("\u0000")) { message.warning(label + "看着是二进制，读不了"); return; }
    if (content.trim() === "") { message.warning(label + "是空文件，没读进来"); return; }
    if (maxChars !== undefined && content.length > maxChars) {
      message.error(label + content.length + " 字符，超过后端上限 " + maxChars + "，没读进来"); return;
    }
    onText(content, file.name);
    message.success("已读入 " + label + "，覆盖当前文本框");
  }

  return (
    <Space size={8} wrap data-testid={testId}>
      <Button onClick={() => ref.current?.click()}>选择文件</Button>
      <input ref={ref} type="file" data-testid={testId + "-input"} style={{ display: "none" }}
        accept=".json,.yaml,.yml,.csv,.tsv,.txt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = ""; // 同一个文件连选两次也要触发
        }} />
      <Typography.Text type="secondary" data-testid={testId + "-hint"} className="tp-text-sm">
        选文件会覆盖当前文本框内容
        {maxChars === undefined ? "" : "（上限 " + maxChars + " 字符，与后端一致）"}
      </Typography.Text>
    </Space>
  );
}

export default function ImportWizard({ projectId, open, onClose, onImported }: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<ImportSource>("openapi3");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewOut | null>(null);
  // 冲突条目的策略：索引 -> 是否跳过（缺省 = 覆盖）
  const [skipMap, setSkipMap] = useState<Record<number, boolean>>({});
  const [receipt, setReceipt] = useState<CommitOut | null>(null);

  const reset = () => {
    setStep(0); setPreview(null); setSkipMap({}); setReceipt(null); setText(""); setUrl("");
  };

  const counts = useMemo(() => {
    if (!preview) return { fresh: 0, overwrite: 0, skip: 0 };
    let overwrite = 0; let skip = 0;
    preview.items.forEach((it, i) => {
      if (!it.exists) return;
      if (skipMap[i]) skip += 1; else overwrite += 1;
    });
    return { fresh: preview.new_count, overwrite, skip };
  }, [preview, skipMap]);

  async function parse() {
    if (!text && !url) { message.warning("先粘贴文本或填 URL"); return; }
    // 「与 URL 二选一」得是真的二选一：两处都填时后端 import_services.py:69 是
    // `text if text is not None else fetch(url)`——静默优先文本。让业主填了 URL 却被
    // 解析了旧文本，等于把口径藏在实现里；当场说清楚比猜他要哪个便宜。
    if (text.trim() && url.trim()) {
      message.warning("文本框和 URL 二选一：两处都填了，请先清空其中一个");
      return;
    }
    setBusy(true);
    try {
      const p = await post<PreviewOut>("/api-import-preview", {
        project_id: projectId, source, ...(text ? { text } : { url }),
      });
      setPreview(p); setSkipMap({}); setStep(1);
    } catch { /* toast 在 client */ } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const items = preview.items.map((it, i) => ({
        name: it.name, method: it.method, path: it.path, request: it.request,
        // 新条目恒建（skip 只属于冲突条目）；冲突条目按逐条勾选（D26：无「新版本」）
        strategy: it.exists && skipMap[i] ? "skip" : "overwrite",
        ...(it.definition_id ? { definition_id: it.definition_id } : {}),
      }));
      const r = await post<CommitOut>("/api-import-commit", { project_id: projectId, items });
      setReceipt(r); setStep(2);
      if (r.ok) message.success("导入成功 " + (r.created + r.updated) + " 条");
      // 成功刷列表；失败（整批回滚）也刷一次——让界面与「一行没动」的口径当面对得上
      onImported();
    } catch { /* toast 在 client */ } finally { setBusy(false); }
  }

  const reportLines = useMemo(() => {
    const out: string[] = [];
    if (preview) out.push(...preview.errors);
    if (receipt) out.push(...receipt.failures.map((f) => f.name + "：" + f.reason));
    return out;
  }, [preview, receipt]);

  return (
    <Modal title="导入" open={open} width={960} centered onCancel={() => { reset(); onClose(); }}
      data-testid="import-wizard"
      footer={step === 2 ? [
        <Button key="dl" data-testid="iw-download" disabled={reportLines.length === 0}
          onClick={() => downloadErrorReport(reportLines)}>下载错误报告</Button>,
        <Button key="close" type="primary" data-testid="iw-close" onClick={() => { reset(); onClose(); }}>关闭</Button>,
      ] : step === 1 ? [
        <Button key="back" data-testid="iw-back" onClick={() => setStep(0)}>上一步</Button>,
        <Button key="go" type="primary" data-testid="iw-commit" loading={busy}
          disabled={!preview || preview.items.length === 0} onClick={() => void commit()}>导入</Button>,
      ] : [
        <Button key="parse" type="primary" data-testid="iw-parse" loading={busy} onClick={() => void parse()}>解析</Button>,
      ]}
    >
      <Steps current={step} items={[{ title: "来源" }, { title: "预览" }, { title: "结果" }]}
        style={{ marginBottom: 16 }} />

      {step === 0 && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Radio.Group data-testid="iw-source" value={source} onChange={(e) => setSource(e.target.value)}>
            <Radio value="openapi3">OpenAPI3</Radio>
            <Radio value="swagger2">Swagger2</Radio>
            <Radio value="postman">Postman</Radio>
          </Radio.Group>
          <Input.TextArea data-testid="iw-text" rows={10} value={text} className="tp-mono"
            placeholder="粘贴 JSON 文档（与 URL 二选一）" onChange={(e) => setText(e.target.value)} />
          {/* 后端 ImportPreviewIn.text 无长度限制——前端照实不设限 */}
          <FileTextPicker testId="iw-file" onText={(t) => setText(t)} />
          <Input data-testid="iw-url" value={url} placeholder="或填文档 URL（后端代拉：5s 超时 / 2MB 上限）"
            onChange={(e) => setUrl(e.target.value)} />
        </Space>
      )}

      {step === 1 && preview && (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Typography.Text data-testid="iw-counts">
              新增 {counts.fresh} · 覆盖 {counts.overwrite} · 跳过 {counts.skip}
            </Typography.Text>
            <Button size="small" data-testid="iw-skip-all"
              onClick={() => setSkipMap(Object.fromEntries(preview.items.map((it, i) => [i, it.exists])))}>全跳过</Button>
            <Button size="small" data-testid="iw-overwrite-all" onClick={() => setSkipMap({})}>全覆盖</Button>
          </Space>
          {/* preview 判重不含回收站行，commit 门槛含（import_services name_taken 连回收站一并算）：
              占名条目预览报「新增」提交却被拒，任一失败整批回滚——门槛差异要在提交前说清。 */}
          <Typography.Text type="secondary" data-testid="iw-recycle-note" className="tp-text-sm"
            style={{ display: "block", marginBottom: 8 }}>
            「新增」以现有接口判重：回收站里的接口同样占名，占名条目提交会被拒且整批回滚，请先清理回收站同名接口。
          </Typography.Text>
          {preview.errors.length > 0 && (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }} data-testid="iw-errors"
              message={"解析告警 " + preview.errors.length + " 条（字段被忽略/降级，或整条丢弃，逐条见明细）"}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>} />
          )}
          <Table<PreviewItem> size="small" rowKey={(_r, i) => String(i)} dataSource={preview.items}
            pagination={false} scroll={{ y: 320 }}
            columns={[
              { title: "名称", dataIndex: "name", ellipsis: true },
              { title: "方法", dataIndex: "method", width: 90,
                render: (v: string) => <Tag color={METHOD_TAG[v] ?? "default"}>{v}</Tag> },
              { title: "路径", dataIndex: "path", ellipsis: true, className: "tp-mono" },
              // 176 = 最坏内容「跳过（不勾 = 覆盖）」：8 全角字 ×14 = 112 + " = " ≈ 15，
              // 加勾选框 16 + 标签左右 padding 8×2、格子 padding 8×2 ≈ 175 → 8 倍数取 176。
              { title: "冲突", width: 176, render: (_v, _r, i) => (
                _r.exists
                  ? <Checkbox data-testid={"iw-skip-" + i} checked={!!skipMap[i]}
                      onChange={(e) => setSkipMap({ ...skipMap, [i]: e.target.checked })}>
                      跳过（不勾 = 覆盖）
                    </Checkbox>
                  : <Typography.Text type="secondary">无 → 新增</Typography.Text>
              ) },
            ]} />
        </>
      )}

      {step === 2 && receipt && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text data-testid="iw-receipt" className="tp-text-lg">
            {receipt.ok
              ? <>成功 {receipt.created + receipt.updated} · 失败 {receipt.failed}
                  （新增 {receipt.created} · 覆盖 {receipt.updated} · 跳过 {receipt.skipped}）</>
              : <>成功 0 · 失败 {receipt.failed}——整批已回滚，现有接口一行未动</>}
          </Typography.Text>
          {reportLines.length > 0 && (
            <Alert type={receipt.ok ? "warning" : "error"} showIcon data-testid="iw-report"
              message={reportLines.length + " 条问题明细（可用左下角按钮下载）"}
              description={<ul style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflow: "auto" }}>
                {reportLines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>} />
          )}
        </Space>
      )}
    </Modal>
  );
}
