// 数据集页（§11.4.5）：左列表右编辑。粘贴优先——数据本来躺在 Excel 里，
// 让用户一格一格敲等于逼他放弃数据驱动。解析在前端（csv.ts），后端只认结构。
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { CopyOutlined, DeleteOutlined, LockOutlined, PlusOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import type { ColumnsType } from "antd/es/table";
import AdminTable from "../ui/AdminTable";
import { get, patch, post } from "../api/client";
import type { DatasetRow, Page } from "../api/api";
import { parseTabular } from "../api/csv";
import type { PasteResult } from "../api/csv";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";

// 粘贴示例：TSV（Excel 复制出来就是 Tab 分隔），首行是列名
const PASTE_SAMPLE = ["order_id\tstatus", "1\tPAID", "2\tNEW"].join("\n");

function DatasetsWorkbench() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "api:dataset:create");
  const canUpdate = can(perms, "api:dataset:update");
  const canDelete = can(perms, "api:dataset:delete");
  const [items, setItems] = useState<DatasetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, setSaving] = useState(false);

  // 边粘边解析：预览与告警必须在点「导入」之前就看到，导入后才发现行宽不齐只能重来
  const parsed = useMemo(() => (pasteOpen ? parseTabular(pasteText) : null), [pasteOpen, pasteText]);

  async function load(): Promise<void> {
    setLoading(true);
    setFailed(false);
    try {
      const r = await get<Page<DatasetRow>>("/datasets?project_id=" + encodeURIComponent(pid), { silent: true });
      setItems(r.items);
    } catch { setItems([]); setFailed(true); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [pid]);

  function open(d: DatasetRow | "new"): void {
    if (d === "new") {
      setSel("new"); setName(""); setColumns([]); setRows([]); return;
    }
    setSel(d.id);
    setName(d.name); setColumns([...d.columns]); setRows(d.rows.map((r) => [...r]));
  }

  function applyPaste(r: PasteResult): void {
    setColumns(r.columns); setRows(r.rows); setPasteOpen(false); setPasteText("");
    if (sel === null) setSel("new");
    const bits = [r.rows.length + " 行 × " + r.columns.length + " 列"];
    if (r.padded.length) bits.push("补齐 " + r.padded.length + " 行短行");
    if (r.overflow.length) bits.push("截断 " + r.overflow.length + " 行长行");
    if (r.capped) bits.push("超过 2000 行，第 2001 行起没有导入");
    if (r.duplicates.length) bits.push("重复列名（" + r.duplicates.join("、") + "），保存会被拦下：列名不能重复");
    message.success(bits.join("；"));
  }

  const setCell = (r: number, c: number, v: string): void => {
    const next = rows.map((x) => [...x]);
    next[r][c] = v; setRows(next);
  };

  async function save(): Promise<void> {
    const v = name.trim();
    if (!v) { message.warning("数据集名必填"); return; }
    if (columns.length === 0) { message.warning("先粘贴或添加列：数据集至少要有列头"); return; }
    setSaving(true);
    try {
      const body = { project_id: pid, name: v, columns, rows };
      if (sel === "new") await post<DatasetRow>("/datasets", body);
      else if (sel) await patch<DatasetRow>("/datasets/" + sel, { ...body, dataset_id: sel });
      message.success("数据集已保存");
      setSel(null);
      await load();
    } catch { /* 409 重名、422 行宽不齐：client 已 toast，留在编辑态不丢内容 */ } finally { setSaving(false); }
  }

  async function remove(d: DatasetRow): Promise<void> {
    try {
      await post("/datasets/" + d.id + "/delete", { project_id: pid });
      message.success("数据集已删除");
      if (sel === d.id) setSel(null);
      await load();
    } catch { /* 409 文案已写明被几条用例引用 */ }
  }

  const addColumn = (): void => {
    setColumns([...columns, "列" + (columns.length + 1)]);
    setRows(rows.map((r) => [...r, ""]));   // 补一行空串：新列宽度和已有行保持齐平
  };
  const addRow = (): void => setRows([...rows, columns.map(() => "")]);
  const delRow = (i: number): void => setRows(rows.filter((_, k) => k !== i));
  const cols: ColumnsType<DatasetRow> = [
    { title: "名称", dataIndex: "name", render: (v: string, r: DatasetRow) => (
      <span>{v} <Tag data-testid="ds-rows-tag">{r.row_count} 行</Tag></span>
    ) },
    { title: "引用", key: "used", width: 84, render: (_: unknown, r: DatasetRow) => (
      // 两个数各说各的：used_by 是「几条活用例绑着它」，锁标记是「绑定它的用例
      // （含回收站里的）还被未回收场景扣着」。缺了后者，徽标会在删除 409 时说谎。
      <Space size={4}>
        <Tooltip title="绑定这个数据集的未回收用例数，大于 0 删不掉">
          <Tag data-testid="ds-usedby" color={(r.used_by ?? 0) > 0 ? "purple" : "default"}>{r.used_by ?? 0}</Tag>
        </Tooltip>
        {r.scenario_held && (
          <Tooltip title="绑定它的用例还被未回收场景引用：就算这里显示 0，删除也会被拦下。要先在场景里改掉引用，或彻底删除那些用例">
            <LockOutlined data-testid="ds-held" style={{ color: "var(--wp-warn, #d48806)" }} />
          </Tooltip>
        )}
      </Space>
    ) },
  ];
  if (canDelete) cols.push({ title: "", key: "ops", width: 46, render: (_: unknown, r: DatasetRow) => (
    <Popconfirm title={r.scenario_held
      ? "删除「" + r.name + "」？绑定它的用例还被场景引用，现在删不掉"
      // 后端 data_set_delete 在 used_by≥1 时必 409：绑着用例时「失去数据源」根本不会发生，
      // 用户点之前需要听到的是「这刀会被拦下」。
      : (r.used_by ?? 0) > 0
        ? "删除「" + r.name + "」？" + (r.used_by ?? 0) + " 条用例绑着它，删除会被拦下：先在用例里解绑或回收"
        // D124：used_by 只数未回收用例；回收站里绑它的用例恢复时会 409 dataset_missing
        // （case_services 恢复出口，R82）——「不影响任何用例」对回收绑定是假话。
        // 前端拿不到回收绑定数，不许编「N 条」，只承认可能存在并说清恢复前要做什么。
        : "删除「" + r.name + "」？没有未回收用例绑着它；回收站里绑它的用例（如有）恢复前需先重新绑定数据集"} okText="删除" cancelText="取消"
      okButtonProps={{ danger: true }} onConfirm={() => void remove(r)}>
      <Button size="small" type="text" danger icon={<DeleteOutlined />} data-testid="ds-del" aria-label={"删除" + r.name} />
    </Popconfirm>
  ) });
  // 网格：列头本身就是输入框（改列名不用开第二个弹窗），单元格直接改值。
  // 行宽齐平由粘贴解析负责，这里只管显示与编辑。
  type Cell = { i: number; r: string[] };
  const gridCols: ColumnsType<Cell> = columns.map((c, ci) => ({
    title: (
      <Input size="small" variant="borderless" data-testid={"ds-col-" + ci} value={c} maxLength={100}
        onChange={(e) => { const nx = [...columns]; nx[ci] = e.target.value; setColumns(nx); }} />
    ),
    render: (_: unknown, rec: Cell) => (
      <Input size="small" variant="borderless" data-testid={"ds-cell-" + rec.i + "-" + ci}
        aria-label={"第" + (rec.i + 1) + "行" + (c || "列" + (ci + 1))}
        value={rec.r[ci] ?? ""} onChange={(e) => setCell(rec.i, ci, e.target.value)} />
    ),
  }));
  if (canUpdate || canCreate) {
    gridCols.push({ title: "", key: "ops", width: 44, render: (_: unknown, rec: Cell) => (
      <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={"删第" + (rec.i + 1) + "行"}
        onClick={() => delRow(rec.i)} />
    ) });
  }
  return (
    <Space size={16} align="start" style={{ width: "100%" }}>
      <div style={{ width: 320, flexShrink: 0 }}>
        <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
          {/* 取失败时不画 0：那是「没查到」，不是「查到了 0 条」（同 reports.tsx 的 failed 口径） */}
          <Typography.Text strong>数据集（{failed ? "—" : items.length}）</Typography.Text>
          {canCreate && (
            <Button size="small" type="primary" ghost icon={<PlusOutlined />} data-testid="ds-new" onClick={() => open("new")}>
              新建
            </Button>
          )}
        </Space>
        <AdminTable<DatasetRow> rowKey="id" loading={loading} dataSource={items}
          // 整行可点开编辑：数据集一般十几条，再来一列「查看」纯属浪费
          onRow={(r) => ({
            onClick: () => open(r), style: { cursor: "pointer" },
            "data-testid": "ds-row",
          } as React.HTMLAttributes<HTMLTableRowElement>)}
          locale={{ emptyText: (
            <div data-testid="ds-empty">
              {/* 失败 ≠ 空：403/500/断网都落到这里，说「还没有数据集」是编造测量结果 */}
              <Empty description={failed ? "数据集列表没取到（网络不通或权限变了）" : "还没有数据集，新建后直接粘贴表格"}
                image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) }}
          columns={cols}
        />
        {items.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
            引用数为 0 才删得掉：数据集是硬删，绑它的用例要先解绑。
          </Typography.Text>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {sel === null ? (
          <Empty description="左侧选一个数据集，或新建一个" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div data-testid="ds-editor">
            <Space wrap style={{ marginBottom: 8 }}>
              <Input data-testid="ds-name" style={{ width: 240 }} maxLength={200} value={name}
                placeholder="数据集名，如「订单参数」" onChange={(e) => setName(e.target.value)} />
              <Button icon={<CopyOutlined />} data-testid="ds-paste"
                onClick={() => { setPasteText(""); setPasteOpen(true); }}>粘贴表格</Button>
              <Button size="small" onClick={addColumn}>加列</Button>
              {columns.length > 0 && <Button size="small" onClick={addRow}>加行</Button>}
              <Button type="primary" data-testid="ds-save" loading={saving} onClick={() => void save()}>保存</Button>
              <Button type="text" onClick={() => setSel(null)}>关闭</Button>
            </Space>
            {columns.length === 0 ? (
              <Alert type="info" showIcon message="还没有列：点「粘贴表格」从 Excel/CSV 贴进来（首行=列名），或者手动加列" />
            ) : (
              <Table size="small" rowKey="i" pagination={{ pageSize: 20, hideOnSinglePage: true }}
                dataSource={rows.map((r, i) => ({ i, r }))}
                columns={gridCols}
              />
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {"列名就是变量名：用例绑定数据集后，用 ${列名} 取值（调试取首行，批量执行在 1B）。"}
            </Typography.Text>
          </div>
        )}
      </div>
      <Modal open={pasteOpen} width={760} destroyOnHidden title="粘贴表格（首行=列名，Tab 或逗号分隔）"
        data-testid="ds-paste-modal" okText="导入" cancelText="取消"
        okButtonProps={{ disabled: !parsed || parsed.columns.length === 0, "data-testid": "ds-paste-confirm" }}
        onCancel={() => setPasteOpen(false)} onOk={() => { if (parsed) applyPaste(parsed); }}>
        <Input.TextArea data-testid="ds-paste-text" rows={8} className="tp-mono" value={pasteText}
          placeholder={PASTE_SAMPLE}
          onChange={(e) => setPasteText(e.target.value)} />
        {pasteText.trim() !== "" && parsed && (
          <div data-testid="ds-paste-preview" style={{ marginTop: 8 }}>
            {parsed.columns.length === 0 ? (
              <Typography.Text type="danger">没解析出列：检查一下是否整行都是空的</Typography.Text>
            ) : (
              <>
                <Typography.Text>解析出 {parsed.rows.length} 行 × {parsed.columns.length} 列</Typography.Text>
                {parsed.padded.length > 0 && (
                  <Alert style={{ marginTop: 6 }} type="warning" showIcon
                    message={"第 " + parsed.padded.join("、") + " 行比列头短，已用空串补齐"} />
                )}
                {parsed.overflow.length > 0 && (
                  <Alert style={{ marginTop: 6 }} type="warning" showIcon
                    message={"第 " + parsed.overflow.join("、") + " 行比列头长，多出来的列被丢弃（先加列头再重新粘就能留下）"} />
                )}
                {parsed.capped && (
                  <Alert style={{ marginTop: 6 }} type="warning" showIcon
                    message="粘贴内容超过 2000 行，第 2001 行起没有导入" />
                )}
                {parsed.duplicates.length > 0 && (
                  <Alert style={{ marginTop: 6 }} type="warning" showIcon
                    message={"列名重复：" + parsed.duplicates.join("、") + "，保存会被拦下：列名不能重复"} />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  导入后是可直接编辑的表格，不是只读预览；列名会当成变量名。
                </Typography.Text>
              </>
            )}
          </div>
        )}
      </Modal>
    </Space>
  );
}

export default function DatasetsPage() {
  return (
    <div data-testid="page-datasets">
      <PageHead title="数据集"
        desc="场景参数化的数据来源：CSV 粘贴或导入，执行时逐行喂给步骤。" />
      <ProjectGate>
        <DatasetsWorkbench />
      </ProjectGate>
    </div>
  );
}
