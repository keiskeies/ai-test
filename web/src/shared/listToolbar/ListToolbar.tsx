// D47-a · 列表工具栏三件套（视图选择器 + 高级搜索 AND/OR + 列设置）。
//
// 照 MeterSphere v3 的 ms-advance-filter / MsColumnSetting 的**语义**做（读语义不抄码，
// docs/2026-11-20-metersphere-parity-audit.md §2.1.1；MS 是 Vue+Arco，我们是 React+AntD，
// 组件搬不过来也不该搬）。
//
// 四条约束是这一轮的裁定，不是随手写成这样：
// ① **字段清单与每字段可用操作符全部来自后端 `filter_meta`**。前端再列一份字段名或操作符
//    就是第二份真相（第 29 轮那条轴：手抄必漂）。前端唯一自带的镜像是 OPERATOR_LABELS
//    那份人话名表，由 listFilters.mirror.test.ts 逐字读后端源码核对。
// ② **`supported_view_types` 没列这一页，就不渲染可用的高级搜索入口**：后端不认的 view_type
//    两侧都 400，摆一个点开就报错的按钮比没按钮更糟（§13 纪律 1 假门禁令）。
// ③ 元数据「在路上 / 拉挂了 / 真不支持」是三句话，各说各的。混成一种，网络抖动就会把
//    功能说成「本页不支持高级搜索」——那是拿故障演事实。
// ④ 列设置**受控**：偏好由页面持有。工具栏只管画开关，被影响的是页面的表格；把 state
//    关在组件里，勾掉一列只写了 localStorage、列纹丝不动，就是「能设但不生效」的假功能。
import { Button, Checkbox, Divider, Input, InputNumber, Modal, Popover, Select,
  Space, Tooltip, Typography, message } from "antd";
import { FilterOutlined, SaveOutlined, SettingOutlined, StarOutlined, TriangleAlertOutlined } from "../../ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiErr, del, get, post } from "../../api/client";
import {
  OPERATOR_LABELS, checkedKeys, columnPrefsKey, describeFilter, emptyFilter,
  hiddenFromChecked, incompleteConds, isFilterEmpty, loadColumnPrefs, opsFor, resetValueFor,
  saveColumnPrefs, timeFromLocalInput, timeToLocalInput,
  type ColumnChoice, type ColumnPref, type FieldMeta, type FilterDoc, type FilterMeta,
  type SavedView, type SearchMode,
} from "../listFilters";

const OPT = { silent: true } as const;
const enc = encodeURIComponent;

export interface Option { label: string; value: string }

// ── 高级搜索能力元数据 ────────────────────────────────────────────────────────
// 三态分开是有内容的：加载中的入口画成 disabled + loading，拉挂了必须说「没取到」并给真
// 重试，真不支持才说「本页不支持」。混起来就是拿故障演事实。
export type MetaState =
  | { state: "loading" }
  | { state: "failed"; reason: string; retry: () => void }
  | { state: "ready"; meta: FilterMeta };

export function useFilterMeta(projectId: string, viewType: string): MetaState {
  const [meta, setMeta] = useState<FilterMeta | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let dead = false;
    setMeta(null); setReason(null);
    get<FilterMeta>(`/filter-meta?project_id=${enc(projectId)}&view_type=${enc(viewType)}`, OPT)
      .then((m) => {
        if (dead) return;
        // 形状不对当失败：拿 get<FilterMeta> 的类型标注当真，后端改形状就是把整页白屏
        // 换成一个未捕获 TypeError
        if (Array.isArray(m?.fields) && Array.isArray(m?.supported_view_types)) setMeta(m);
        else setReason("筛选配置返回的形状不对");
      })
      .catch((e) => {
        if (!dead) setReason(e instanceof ApiErr ? e.message : "筛选配置加载失败");
      });
    return () => { dead = true; };
  }, [projectId, viewType, nonce]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  if (meta) return { state: "ready", meta };
  if (reason) return { state: "failed", reason, retry };
  return { state: "loading" };
}

// ── 个人视图 ─────────────────────────────────────────────────────────────────
// 后端按 owner 隔离（saved_view.owner_id == 当前用户），所以这份列表天然就是「我的」。
export interface ViewState {
  state: "loading" | "ready" | "failed";
  views: SavedView[];
  reload: () => void;
  save: (name: string, conditions: FilterDoc) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

export function useSavedViews(projectId: string, viewType: string): ViewState {
  const [views, setViews] = useState<SavedView[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let dead = false;
    setLoading(true); setFailed(false);
    get<SavedView[]>(`/saved-views?project_id=${enc(projectId)}&view_type=${enc(viewType)}`, OPT)
      .then((rows) => {
        if (dead) return;
        if (Array.isArray(rows)) setViews(rows); else setFailed(true);
      })
      .catch(() => { if (!dead) setFailed(true); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [projectId, viewType, nonce]);

  const save = useCallback(async (name: string, conditions: FilterDoc) => {
    try {
      const row = await post<SavedView>("/saved-views",
        { project_id: projectId, view_type: viewType, name, conditions });
      // pos/name 按「可能缺席」排：排序键来自服务端，缺一个就把整页换成未捕获 TypeError 不值当
      setViews((p) => [...p, row].sort((a, b) =>
        (a.pos ?? 0) - (b.pos ?? 0) || String(a.name ?? "").localeCompare(String(b.name ?? ""))));
      message.success(`视图「${name}」已保存（仅自己可见）`);
      return true;
    } catch (e) {
      // 同名 409 / 条件不合法都要让用户看见：静默失败就是「点了没反应」的假按钮
      message.error(e instanceof ApiErr ? e.message : "视图保存失败");
      return false;
    }
  }, [projectId, viewType]);

  const remove = useCallback(async (id: string) => {
    try {
      await del(`/saved-views/${enc(id)}`,
        { project_id: projectId, view_type: viewType, view_id: id });
      setViews((p) => p.filter((v) => v.id !== id));
    } catch (e) {
      message.error(e instanceof ApiErr ? e.message : "视图删除失败");
    }
  }, [projectId, viewType]);

  const state = failed ? "failed" : loading ? "loading" : "ready";
  return { state, views, reload: () => setNonce((n) => n + 1), save, remove };
}

// ── 值控件：operator 决定单值/多值/区间，kind 决定用什么控件 ─────────────────
// 「为空/不为空」不配值控件（后端压根不看 value）——给它们摆输入框就是骗人。
// 时间用原生 datetime-local 而不是 AntD DatePicker：本仓**没有 dayjs 这个直接依赖**
// （antd 把它放在自己的依赖树里，没提到根，import 不到；为筛选项加直接依赖要走 §5 评审），
// 且 DatePicker 要求 value 是 dayjs 对象——写 `value={null}` 会让生效中的时间条件画成空框，
// 用户点「应用」就把它清了。原生控件的值是纯字符串，我们能完整读写它，往返如实。
function ValueControl(props: {
  field: FieldMeta; operator: string; value: unknown;
  options?: Record<string, Option[]>; onChange: (v: unknown) => void;
}) {
  const { field, operator, value, options, onChange } = props;
  if (operator === "EMPTY" || operator === "NOT_EMPTY") return null;
  const opts = options?.[field.field];
  const range = operator === "BETWEEN";
  const multi = operator === "IN" || operator === "NOT_IN";

  if (field.kind === "time") {
    const cell = (v: unknown, on: (s: string) => void, testid: string) => (
      <Input type="datetime-local" size="small" style={{ width: 196 }} data-testid={testid}
        value={timeToLocalInput(v)} onChange={(e) => on(timeFromLocalInput(e.target.value) ?? "")} />
    );
    if (range) {
      const v = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Space size={4}>
          {cell(v[0], (s) => onChange([s || undefined, v[1]]), "lt-val-range-a")}
          {cell(v[1], (s) => onChange([v[0], s || undefined]), "lt-val-range-b")}
        </Space>
      );
    }
    return cell(value, (s) => onChange(s || undefined), "lt-val-time");
  }
  if (field.kind === "number") {
    if (range) {
      const v = Array.isArray(value) ? (value as (number | undefined)[]) : [];
      return (
        <Space size={4}>
          <InputNumber size="small" style={{ width: 92 }} placeholder="下界" value={v[0]}
            onChange={(x) => onChange([x ?? undefined, v[1]])} />
          <InputNumber size="small" style={{ width: 92 }} placeholder="上界" value={v[1]}
            onChange={(x) => onChange([v[0], x ?? undefined])} />
        </Space>
      );
    }
    return <InputNumber size="small" style={{ width: 140 }} placeholder="数值"
      value={typeof value === "number" ? value : undefined}
      onChange={(x) => onChange(x ?? undefined)} />;
  }
  if (multi) {
    // 有候选 → multiple（只能选真值）；没候选 → tags（自由输入 + 回车加）。
    // tags 不拦错值，所以面板底部如实写了「值不校验，查不到就是空集」。
    return (
      <Select size="small" style={{ minWidth: 176 }} data-testid="lt-val-multi"
        mode={opts ? "multiple" : "tags"} open={opts ? undefined : false}
        options={opts ?? []} placeholder={opts ? "可多选" : "回车可加多个"}
        value={Array.isArray(value) ? (value as string[]) : []}
        onChange={(v) => onChange(v)} />
    );
  }
  if (range) {
    const v = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Space size={4}>
        <Input size="small" style={{ width: 92 }} placeholder="起" value={v[0] ?? ""}
          onChange={(e) => onChange([e.target.value || undefined, v[1]])} />
        <Input size="small" style={{ width: 92 }} placeholder="止" value={v[1] ?? ""}
          onChange={(e) => onChange([v[0], e.target.value || undefined])} />
      </Space>
    );
  }
  if (opts) {
    return <Select size="small" style={{ minWidth: 176 }} allowClear data-testid="lt-val-one"
      options={opts} placeholder="选择" value={(value as string) ?? undefined}
      onChange={(v) => onChange(v)} />;
  }
  return <Input size="small" style={{ width: 176 }} allowClear data-testid="lt-val-text"
    placeholder="填入值" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

export interface ListToolbarProps {
  projectId: string;
  viewType: string;
  filter: FilterDoc;
  onFilterChange: (f: FilterDoc) => void;
  /** 列设置要的列（key 必须与 AntD columns 的 key 一致，否则隐藏不生效——由页面侧测试钉住）。 */
  /** 可选：页面若已把列设置交给 ProTable（options.setting），这里不传即可隐藏自建面板。 */
  allColumns?: ColumnChoice[];
  columnPref?: ColumnPref | null;
  onColumnPrefChange?: (next: ColumnPref | null) => void;
  /** 候选值由页面给：模块树、成员表、方法词表都已经在页面手里，共享组件不去拉第二遍。
   *  这是**页面既有词表的复用**，不是新抄一份（method 用 src/api/req.ts 的 METHODS，
   *  与编辑器下拉同源）。后端声明 enum 候选是后续刀。 */
  valueOptions?: Record<string, Option[]>;
  canSaveView: boolean;
  canDeleteView: boolean;
  /** 页面自己的按钮（新建/导入/刷新…），排在三件套之后。 */
  extra?: React.ReactNode;
}

export function ListToolbar(props: ListToolbarProps) {
  const { projectId, viewType, filter, onFilterChange, allColumns, valueOptions,
    extra, canSaveView, canDeleteView, columnPref, onColumnPrefChange } = props;
  const metaState = useFilterMeta(projectId, viewType);
  const views = useSavedViews(projectId, viewType);

  const [searchOpen, setSearchOpen] = useState(false);
  const [colOpen, setColOpen] = useState(false);
  const [draft, setDraft] = useState<FilterDoc>(filter);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");

  // 面板每次打开都以「屏幕上正在生效的条件」为草稿：选视图、清空条件之后再开面板，
  // 面板里看到的必须就是列表现在筛的东西，否则「应用」会悄悄覆盖刚才的选择。
  useEffect(() => { if (searchOpen) setDraft(filter); }, [searchOpen, filter]);

  const meta = metaState.state === "ready" ? metaState.meta : null;
  const supported = !!meta && meta.supported_view_types.includes(viewType);
  const fields = meta?.fields ?? [];

  // 当前条件正好等于某个已存视图 → 视图选择器显示它的名字（而不是「全部数据」+ 一长串条件）
  const appliedView = useMemo(() => {
    if (isFilterEmpty(filter)) return null;
    const key = JSON.stringify(filter);
    return views.views.find((v) => JSON.stringify(v.conditions) === key) ?? null;
  }, [filter, views.views]);

  const viewOptions = useMemo(() => [
    { value: "", label: "全部数据" },
    ...views.views.map((v) => ({ value: v.id, label: v.name })),
  ], [views.views]);

  function applyView(id: string): void {
    if (!id) { onFilterChange(emptyFilter()); return; }
    const hit = views.views.find((v) => v.id === id);
    // 找不到就是视图刚被删掉：说清楚，不清空条件假装什么都没发生
    if (hit) onFilterChange(hit.conditions);
    else message.warning("这个视图刚被删除，列表保持当前条件");
  }

  async function doSaveView(): Promise<void> {
    const name = viewName.trim();
    if (!name) { message.warning("给视图起个名字"); return; }
    if (await views.save(name, filter)) { setNaming(false); setViewName(""); }
  }

  const panel = (
    <div style={{ width: 560 }} data-testid="lt-panel">
      <Space size={8} style={{ marginBottom: 8 }}>
        <Typography.Text>条件之间</Typography.Text>
        <Select<SearchMode> size="small" style={{ width: 148 }} data-testid="lt-mode"
          value={draft.search_mode}
          options={[{ value: "AND", label: "且（同时满足）" }, { value: "OR", label: "或（任一满足）" }]}
          onChange={(search_mode) => setDraft((d) => ({ ...d, search_mode }))} />
      </Space>
      {draft.conditions.map((c, i) => {
        const fm = fields.find((f) => f.field === c.field);
        const ops = fm ? fm.ops : opsFor(meta, c.field);
        return (
          <Space key={i} size={6} wrap style={{ marginBottom: 6 }} data-testid="lt-cond-row">
            <Select size="small" style={{ width: 132 }} value={c.field} placeholder="字段"
              data-testid="lt-cond-field"
              options={fields.map((f) => ({ value: f.field, label: f.label }))}
              onChange={(field) => {
                const nf = fields.find((f) => f.field === field);
                const op = nf?.ops[0] ?? "EQUALS";
                setDraft((d) => withCond(d, i, { field, operator: op, value: resetValueFor(op) }));
              }} />
            <Select size="small" style={{ width: 104 }} value={c.operator} data-testid="lt-cond-op"
              options={ops.map((op) => ({ value: op, label: OPERATOR_LABELS[op] ?? op }))}
              // 换操作符必须清值：留着上一个操作符的值会发出 {operator:"IN", value:"串"}
              // 这种后端必 400 的条件，而界面上看着什么都没改
              onChange={(operator) => setDraft((d) =>
                withCond(d, i, { ...c, operator, value: resetValueFor(operator) }))} />
            {fm && (
              <ValueControl field={fm} operator={c.operator} value={c.value} options={valueOptions}
                onChange={(value) => setDraft((d) => withCond(d, i, { ...c, value }))} />
            )}
            <Button size="small" type="text" data-testid="lt-cond-del" onClick={() => setDraft((d) => ({
              ...d, conditions: d.conditions.filter((_, j) => j !== i),
            }))}>删除</Button>
          </Space>
        );
      })}
      <Space wrap>
        <Button size="small" icon={<FilterOutlined />} data-testid="lt-add-cond"
          disabled={fields.length === 0}
          onClick={() => {
            const f = fields[0];
            if (!f) return;
            const op = f.ops[0] ?? "EQUALS";
            setDraft((d) => ({ ...d,
              conditions: [...d.conditions, { field: f.field, operator: op, value: resetValueFor(op) }] }));
          }}>加条件</Button>
        <Button size="small" data-testid="lt-clear" onClick={() => {
          onFilterChange(emptyFilter()); setDraft(emptyFilter()); setSearchOpen(false);
        }}>清空条件</Button>
        <Button size="small" type="primary" data-testid="lt-apply" onClick={() => {
          const conds = draft.conditions.filter((c) => c.field);
          const missing = incompleteConds({ ...draft, conditions: conds }, fields);
          // 半填的条件不发：后端对缺 value 的 CONTAINS 是 400，对空串是 LIKE '%%' 命中全表，
          // 两种都比「不让你点」糟——所以点名是哪一条没填，让用户补而不替他猜。
          if (missing.length > 0) {
            message.warning(`这些条件还没填完：${[...new Set(missing)].join("、")}`);
            return;
          }
          onFilterChange({ ...draft, conditions: conds });
          setSearchOpen(false);
        }}>应用</Button>
      </Space>
      <Typography.Text type="secondary" className="tp-text-sm" style={{ display: "block", marginTop: 6 }}>
        字段与操作符由后端给出；未列候选的列按原值精确匹配，填错不会报错、只是查不到。
        {meta && Object.keys(meta.unavailable ?? {}).length > 0 && (
          <>暂不支持：{Object.keys(meta.unavailable).join("、")}。</>
        )}
      </Typography.Text>
    </div>
  );

  return (
    <div className="tp-filterbar" data-testid="list-toolbar">
      {/* 左 = 影响「看到什么」的筛选件（视图 / 已存视图 / 高级搜索 / 列设置）；
          右 = 页面自己的动作（extra：刷新/导入/导出/新建…）。此前 11 个控件在同一个
          Space 里同权平铺，主按钮与筛选件抢同一条线，扫读成本高。 */}
      <Select style={{ width: 150 }} data-testid="lt-view"
        value={appliedView?.id ?? ""} options={viewOptions} loading={views.state === "loading"}
        onChange={applyView}
        notFoundContent={views.state === "failed" ? "视图没取到（不是你没有视图）"
          : views.state === "loading" ? "加载中…" : "还没有保存的视图"} />
      {views.state === "failed" && (
        <Button size="small" type="link" data-testid="lt-view-retry" onClick={views.reload}>重试视图</Button>
      )}
      {canSaveView && (
        <Tooltip title="把当前筛选存成个人视图（仅自己可见）">
          <Button icon={<SaveOutlined />} data-testid="lt-save-view" aria-label="存为视图"
            disabled={isFilterEmpty(filter)} onClick={() => setNaming(true)} />
        </Tooltip>
      )}
      {canDeleteView && appliedView && (
        <Tooltip title={`删除视图「${appliedView.name}」（不影响列表数据）`}>
          {/* 钮上写死「删除视图」，视图名放 title 与 aria-label：按钮文案里带变量会让这一格
              按不定长文本抖。名字已经在旁边的选择器里显示着，这里重复不增加信息。 */}
          <Button icon={<StarOutlined />} data-testid="lt-delete-view"
            aria-label={`删除视图 ${appliedView.name}`}
            onClick={() => void views.remove(appliedView.id)} />
        </Tooltip>
      )}

      {/* 三态各画各的：加载中不给可点入口、拉挂了指向重试、真不支持才说「不支持」 */}
      {metaState.state === "loading" && (
        <Tooltip title="高级搜索：筛选配置加载中">
          <Button icon={<FilterOutlined />} loading disabled aria-label="高级搜索加载中"
            data-testid="lt-search-loading" />
        </Tooltip>
      )}
      {metaState.state === "failed" && (
        <Tooltip title={metaState.reason + "（点此重试）"}>
          {/* 故障必须在按钮上显形（icon-only 只把原因藏进 tooltip，等于把故障画小了）：
              保留「未取到」三个字，去掉后半句长文案，宽度减半。 */}
          <Button icon={<TriangleAlertOutlined />} danger type="text" size="small"
            data-testid="lt-search-failed" onClick={metaState.retry}>筛选配置未取到</Button>
        </Tooltip>
      )}
      {metaState.state === "ready" && !supported && (
        <Tooltip title="这一页还没有登记可筛字段">
          <Button icon={<FilterOutlined />} disabled aria-label="本页不支持高级搜索"
            data-testid="lt-search-unsupported" />
        </Tooltip>
      )}
      {supported && (
        <Popover content={panel} trigger="click" open={searchOpen} onOpenChange={setSearchOpen}>
          <Button icon={<FilterOutlined />} type={isFilterEmpty(filter) ? "default" : "primary"}
            data-testid="lt-search">
            {isFilterEmpty(filter) ? "高级搜索" : describeFilter(filter, fields)}
          </Button>
        </Popover>
      )}

      {(allColumns?.length ?? 0) > 0 && (
        <Popover trigger="click" open={colOpen} onOpenChange={setColOpen} title="列设置"
          content={(
            <div style={{ width: 208 }} data-testid="lt-col-panel">
              <Checkbox.Group style={{ display: "grid", gap: 4 }}
                value={checkedKeys(allColumns ?? [], columnPref ?? null)}
                onChange={(keys) => onColumnPrefChange?.(hiddenFromChecked(allColumns ?? [], keys as string[]))}
                options={(allColumns ?? []).map((c) => ({ label: c.label, value: c.key }))} />
              <Divider style={{ margin: "8px 0" }} />
              {/* 只回报「恢复默认」，删键由 useColumnPrefs 做：受控组件不碰 localStorage，
                  否则落盘逻辑两处各一份，早晚分叉（写盘与写 state 只中一个就是假设置）。 */}
              <Button size="small" data-testid="lt-col-reset"
                onClick={() => onColumnPrefChange?.(null)}>恢复默认</Button>
            </div>
          )}>
          <Tooltip title="列设置"><Button icon={<SettingOutlined />} aria-label="列设置"
            data-testid="lt-cols" /></Tooltip>
        </Popover>
      )}

      {extra && <div className="tp-filterbar-actions">{extra}</div>}
      <Modal open={naming} title="存为视图" okText="保存" cancelText="取消"
        onCancel={() => { setNaming(false); setViewName(""); }} onOk={() => void doSaveView()}
        okButtonProps={{ "data-testid": "lt-view-name-ok" }}
        cancelButtonProps={{ "data-testid": "lt-view-name-cancel" }}>
        <Typography.Paragraph type="secondary" className="tp-text-sm">
          当前条件：{describeFilter(filter, fields)}
        </Typography.Paragraph>
        <Input data-testid="lt-view-name" placeholder="视图名称，如「我的 GET 接口」"
          value={viewName} maxLength={128}
          onChange={(e) => setViewName(e.target.value)}
          onPressEnter={() => void doSaveView()} />
      </Modal>
    </div>
  );
}

function withCond(d: FilterDoc, i: number, c: FilterDoc["conditions"][number]): FilterDoc {
  const conditions = d.conditions.slice();
  conditions[i] = c;
  return { ...d, conditions };
}

/** 页面持有的列设置偏好：读本地偏好 + 「改偏好」（落盘与重渲染一起做）。
 *  为什么偏好放页面而不放工具栏里：工具栏只管画开关，被影响的是**页面的表格**——
 *  把 state 关在组件内部，勾掉一列只写了 localStorage、列纹丝不动，
 *  正是「看起来能设、其实不影响表格」那类假功能。落盘逻辑也只有这一处。
 *
 *  「恢复默认」= 传 null = **删键**（不写空隐藏集）：删了下次才读回 null（真没设过，
 *  用列自己的默认显隐）；写空集会把「设过且全显示」说成「没设过」，日后某列默认改成
 *  隐藏会被这份空集压住。 */
export function useColumnPrefs(viewType: string, allKeys: string[]):
  [ColumnPref | null, (next: ColumnPref | null) => void] {
  const [pref, setPref] = useState<ColumnPref | null>(() => loadColumnPrefs(viewType, allKeys));
  const key = allKeys.join("|");
  useEffect(() => {
    setPref(loadColumnPrefs(viewType, key === "" ? [] : key.split("|")));
  }, [viewType, key]);
  const set = useCallback((next: ColumnPref | null) => {
    if (next === null) {
      try { localStorage.removeItem(columnPrefsKey(viewType)); } catch { /* 偏好丢了不毁页面 */ }
      setPref(null);
      return;
    }
    saveColumnPrefs(viewType, next);
    setPref(next);
  }, [viewType]);
  return [pref, set];
}
