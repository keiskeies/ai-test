// 文件管理（D195）：项目文件库。目录树复用 ModuleTree；文件上传/下载走 /files/* 独立路由。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, Input, Modal, Select, Space, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ModuleTree, { type ModNode } from "../api/ModuleTree";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import { fileApi, fmtSize, type FileEntry, type FolderNode } from "../api/filelib";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

// D222：列设置面板（列表七列，操作列不在内）。「目录」列是左树的镜像展示，可以藏。
const FILE_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "size", label: "大小" },
  { key: "mime", label: "类型" },
  { key: "folder", label: "目录" },
  { key: "tags", label: "标签" },
  { key: "by", label: "上传人" },
  { key: "upd", label: "更新时间" },
];

function toModNodes(nodes: FolderNode[]): ModNode[] {
  return nodes.map((n) => ({
    id: n.id, parent_id: n.parent_id, name: n.name, sort: n.sort, status: n.status,
    count: n.file_count, children: toModNodes(n.children),
  }));
}

function flattenFolders(nodes: FolderNode[], depth = 0): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of nodes) {
    out.push({ value: n.id, label: "　".repeat(depth) + n.name });
    out.push(...flattenFolders(n.children, depth + 1));
  }
  return out;
}

function folderNameMap(nodes: FolderNode[], acc: Record<string, string> = {}): Record<string, string> {
  for (const n of nodes) {
    acc[n.id] = n.name;
    folderNameMap(n.children, acc);
  }
  return acc;
}

function EditModal({ open, projectId, row, folders, onClose, onSaved }: {
  open: boolean;
  projectId: string;
  row: FileEntry | null;
  folders: FolderNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !row) return;
    setName(row.name); setDescription(row.description ?? "");
    setTags(row.tags); setFolderId(row.folder_id); setErr(null);
  }, [open, row]);

  async function submit(): Promise<void> {
    if (!row || !name.trim()) { message.warning("文件名必填"); return; }
    setBusy(true); setErr(null);
    try {
      await fileApi.update(row.id, {
        project_id: projectId, name: name.trim(), description, tags,
        folder_id: folderId, folder_set: true,
      });
      message.success("已保存");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={560} destroyOnHidden
      title="编辑文件" okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "file-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>目录</Typography.Text>
          <Select allowClear style={{ width: "100%" }} value={folderId ?? undefined}
            placeholder="未分类" onChange={(v) => setFolderId(v ?? null)} options={flattenFolders(folders)} />
        </div>
        <div>
          <Typography.Text strong>描述</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>标签</Typography.Text>
          <Select mode="tags" style={{ width: "100%" }} value={tags} onChange={setTags}
            tokenSeparators={[",", "，"]} placeholder="回车创建标签" />
        </div>
        {err && <Alert type="error" showIcon message={err} />}
      </Space>
    </Modal>
  );
}

function FilesList() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canUpload = can(perms, "file:file:create");
  const canUpdate = can(perms, "file:file:update");
  const canDelete = can(perms, "file:file:delete");
  const canFolderCreate = can(perms, "file:folder:create");
  const canFolderDelete = can(perms, "file:folder:delete");

  const [tree, setTree] = useState<FolderNode[]>([]);
  const [recycledFolders, setRecycledFolders] = useState<FolderNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inRecycled, setInRecycled] = useState(false);
  const [shownRecycled, setShownRecycled] = useState(false);
  const [rows, setRows] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [kwDraft, setKwDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  // D222：高级搜索条件 + 列偏好（键 file，与后端 view_type 同字）。条件与目录树、
  // 关键词、回收站开关并行（后端同一个 WHERE），不是替代关系。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("file", FILE_COL_CHOICES.map((c) => c.key));
  const [edit, setEdit] = useState<FileEntry | null>(null);
  const [purge, setPurge] = useState<FileEntry | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadTree = useCallback(async () => {
    setTreeError(null);
    try {
      const t = await fileApi.folders(pid, inRecycled);
      setTree(t.tree); setRecycledFolders(t.recycled);
    } catch (e) {
      setTree([]); setRecycledFolders([]);
      setTreeError(e instanceof ApiErr ? e.message : "目录树加载失败");
    }
  }, [pid, inRecycled]);
  useEffect(() => { void loadTree(); }, [loadTree]);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fileApi.list({
        project_id: pid, folder_id: selected ?? undefined, keyword: keyword || undefined,
        recycled: inRecycled, current, size: pageSize,
        // D222：空条件整个参数不上线（后端把空串读成「没筛选」只是兜底）
        filter: isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter),
      });
      setRows(r.items); setTotal(r.total); setShownRecycled(inRecycled);
    } catch (e) {
      setRows([]); setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "文件列表加载失败");
    } finally { setLoading(false); }
  }, [pid, selected, keyword, inRecycled, current, pageSize, advFilter]);
  useEffect(() => { void load(); }, [load]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await fileApi.upload(pid, file, selected);
      message.success("已上传");
      await load(); await loadTree();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "上传失败");
    } finally { setUploading(false); }
  }

  async function download(row: FileEntry): Promise<void> {
    try { await fileApi.download(pid, row.blob); }
    catch (err) { message.error(err instanceof Error ? err.message : "下载失败"); }
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await fileApi.purge(pid, purge.id, purgeName);
      message.success("已彻底删除");
      setPurge(null); setPurgeName("");
      await load(); await loadTree();
    } catch { /* toast */ } finally { setPurging(false); }
  }

  const folderNames = folderNameMap(tree);

  return (
    <div className="tp-fill tp-fill-body" style={{ flexDirection: "row", alignItems: "stretch" }}>
      <div style={{ width: 240, flex: "0 0 240px", marginRight: 12, overflow: "auto" }}>
        <ModuleTree projectId={pid} tree={toModNodes(tree)} recycled={toModNodes(recycledFolders)}
          inRecycled={inRecycled}
          onToggleRecycled={(v) => { setInRecycled(v); setSelected(null); setCurrent(1); }}
          selected={selected} onSelect={(id) => { setSelected(id); setCurrent(1); }}
          onChanged={() => { void loadTree(); void load(); }}
          canManage={canFolderDelete} canCreate={canFolderCreate}
          apiBase="/file-folders" allLabel="全部文件" noun="文件"
          purgeCountKey="purged_folders"
          loadError={treeError}
          countTip="徽标是该目录直属的文件数（不含子目录）"
          deleteHint="目录下还有子目录或文件时会被拒绝（409）；请先移走或回收它们。" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }} className="tp-fill tp-fill-body">
        <div style={{ flex: "0 0 auto" }}>
          {/* D222：D47-a 三件套（视图保存 / 高级搜索 / 列设置）铺到文件管理页。条件与
              左树目录、快捷搜索、回收站开关并行（后三者是取数/视图轴）。 */}
          <ListToolbar
            projectId={pid} viewType="file"
            filter={advFilter} onFilterChange={(f) => { setAdvFilter(f); setCurrent(1); }}
            allColumns={FILE_COL_CHOICES}
            columnPref={colPref} onColumnPrefChange={setColPref}
            canSaveView canDeleteView
          />
          <FilterBar actions={(
            <>
              {canUpload && !inRecycled && (
                <Button type="primary" icon={<PlusOutlined />} loading={uploading}
                  data-testid="file-upload" onClick={() => inputRef.current?.click()}>
                  上传文件
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={() => { void load(); void loadTree(); }}>刷新</Button>
              <Button data-testid="file-recycled" type={inRecycled ? "primary" : "default"}
                onClick={() => { setInRecycled((v) => !v); setSelected(null); setCurrent(1); }}>
                {inRecycled ? "退出回收站" : "♻ 回收站"}
              </Button>
              <input ref={inputRef} type="file" data-testid="file-input" style={{ display: "none" }} onChange={(e) => void onPick(e)} />
            </>
          )}>
            <Input.Search allowClear placeholder="文件名/描述" style={{ width: 220 }} value={kwDraft}
              onChange={(e) => setKwDraft(e.target.value)}
              onSearch={() => { setKeyword(kwDraft.trim()); setCurrent(1); }} />
          </FilterBar>
          {loadError && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="文件列表加载失败"
            description={loadError} />}
        </div>
        <AdminTable<FileEntry> rowKey="id" loading={loading} dataSource={rows} pagination={false}
          locale={{ emptyText: loadError ? (
            <StateView kind="error" title="文件列表没取到，以上方提示为准"
              action={<Button size="small" onClick={() => void load()}>重试</Button>} />
          ) : <StateView title={shownRecycled ? "回收站是空的" : "这个目录还没有文件"} /> }}
          columns={applyColumnPrefs([
            { title: "名称", key: "name", dataIndex: "name", render: (v: string, r) => (
              <Typography.Link onClick={() => void download(r)}>{v}</Typography.Link>) },
            { title: "大小", key: "size", width: 100, render: (_, r) => fmtSize(r.blob.size) },
            { title: "类型", key: "mime", width: 120, render: (_, r) => (
              <Tag>{r.blob.mime.split("/").pop() || "file"}</Tag>) },
            { title: "目录", key: "folder", width: 130, render: (_, r) => (
              r.folder_id ? (folderNames[r.folder_id] ?? "—") : "未分类") },
            { title: "标签", key: "tags", dataIndex: "tags", width: 160, render: (v: string[]) => (
              v.length ? v.map((t) => <Tag key={t}>{t}</Tag>) : "—") },
            { title: "上传人", key: "by", width: 110, render: (_, r) => r.created_by_name ?? "—" },
            { title: "更新时间", key: "upd", width: 140, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 200, render: (_, r) => (
              r.recycled ? (
                <Space size={4}>
                  {canUpdate && (
                    <Button size="small" onClick={async () => {
                      await fileApi.restore(pid, r.id); message.success("已恢复");
                      await load(); await loadTree();
                    }}>恢复</Button>
                  )}
                  {canDelete && (
                    <Button size="small" danger onClick={() => { setPurge(r); setPurgeName(""); }}>
                      彻底删除
                    </Button>
                  )}
                </Space>
              ) : (
                <Space size={4}>
                  <Button size="small" onClick={() => void download(r)}>下载</Button>
                  {canUpdate && <Button size="small" onClick={() => setEdit(r)}>编辑</Button>}
                  {canDelete && (
                    <Button size="small" danger onClick={async () => {
                      await fileApi.remove(pid, r.id); message.success("已放入回收站");
                      await load();
                    }}>删除</Button>
                  )}
                </Space>
              )) },
          ], colPref)}
          cardFooter={(
            <div className="tp-cardfoot">
              <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
                {loadError ? "本次列表加载失败，本行计数不作数" : ""}
                {shownRecycled ? " · 回收站视图" : ""}
                文件按内容去重；附件与仓库共用同一份字节
              </Typography.Text>
              <ListPager current={current} pageSize={pageSize} total={total}
                onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
            </div>
          )}
        />

        <EditModal open={edit !== null} projectId={pid} row={edit} folders={tree}
          onClose={() => setEdit(null)} onSaved={() => { void load(); void loadTree(); }} />

        <Modal centered open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
          width={520} title="彻底删除文件？" okText="我已确认，彻底删除" cancelText="取消"
          okButtonProps={{ danger: true, disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
          onOk={() => void submitPurge()}>
          <Typography.Paragraph>
            「{purge?.name}」将从仓库物理删除；若没有其他附件引用，盘上字节也会删除。
          </Typography.Paragraph>
          <Input value={purgeName} autoFocus placeholder={purge?.name}
            onChange={(e) => setPurgeName(e.target.value)} />
        </Modal>
      </div>
    </div>
  );
}

export default function FilesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-files" className="tp-fill-stack">
      <PageHead title="文件管理" descHover
        desc="项目文件库：目录、文件、标签与内容去重；缺陷/用例附件与仓库共用同一份字节。" />
      <ProjectGate>{project ? <FilesList /> : null}</ProjectGate>
    </div>
  );
}
