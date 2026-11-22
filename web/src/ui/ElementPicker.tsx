// §11.4.13 元素选择器（1C T16，CommandParams 展开区共用件）：
// 元素库搜索 + 最近使用（localStorage tp_ui_recent_elements，最多 8 个，解析守卫见
// recentElements.ts）+ 底部 [+ 就地新建元素] **内联展开**新建表单（蓝图原文「内联展开
// 11.4.11 新建弹窗」——就地新建、建完直接选中，不跳走）。
// 搜索口径 = 元素库页同款（GET /ui-elements 拉一页 + 客户端按名过滤；后端列表没有
// q 参数，R110 的 LIKE 搜索在 Ctrl+K 那侧，这里不假造服务端搜索）。
// 新建按钮按权限**隐藏不是禁用**（settings.spec 钉的手感）；无 ui:element:create 时
// 选择/最近使用照常用，只是不给新建入口。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Select, Space, Tooltip, Typography, message } from "antd";
import { PlusOutlined } from "../ui/icons";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { uiApi } from "../api/ui";
import { ApiErr } from "../api/client";
import { ELEMENT_TYPES } from "./commands";
import { readRecent, pushRecent, writeRecent, type RecentEntry } from "./recentElements";
import type { components } from "../api/schema";

type ElementRow = components["schemas"]["UiElementOut"];

// 与元素库页同一张色表语义（那里是徽标色，这里只用类型词表）：5 种逐字来自
// ELEMENT_TYPES（R100/D2——不给第 6 个，后端给不出的类型不许出现在界面上）。
const TYPE_OPTIONS = ELEMENT_TYPES.map((t) => ({ value: t, label: t }));

export default function ElementPicker({ value, onPick, testIdBase = "el-pick" }: {
  /** 当前选中的 element_id（null/undefined = 未选）。 */
  value?: string | null;
  /** 选中（含就地新建后自动选中）时回调；行对象给出去让调用方免去二次查名。 */
  onPick: (id: string, el: ElementRow) => void;
  testIdBase?: string;
}) {
  const { project, user } = useAuth();
  const pid = project?.id ?? null;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "ui:element:create");

  const [rows, setRows] = useState<ElementRow[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [cName, setCName] = useState("");
  const [cType, setCType] = useState("css");
  const [cLocator, CLocator] = useState("");
  const [busy, setBusy] = useState(false);

  // 拉取状态必须分开记：listElements 是 silent 的（client 不弹 toast），失败后这里
  // 只剩一张空表——空表和「没拉到」在界面上长得一样，就会被说成「元素库还是空的」，
  // 让人去新建一个本来就存在的元素。首帧也得算一个状态：antd 会缓存选中项的 label，
  // 首帧就把「还没查」讲成「库中未找到」，这个字样之后清不掉。
  const [loadState, setLoadState] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [partial, setPartial] = useState(false);

  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await uiApi.listElements({ project_id: pid, size: 200 });
      setRows(r.items);
      // 单页封顶 200：有游标就是没看全，「没有匹配的元素」只能算前 200 条的结论。
      setPartial(r.next_cursor != null);
      setLoadState("ok");
    } catch (e) {
      setRows([]);
      setPartial(false);
      setLoadState(e instanceof ApiErr && e.status === 403 ? "denied" : "error");
    }
  }, [pid]);
  useEffect(() => {
    setRecent(readRecent(localStorage));
    void load();
  }, [load]);

  // 名字不能叫 `use`：那会被 eslint 的 react-hooks 规则当成 Hook 调用（`use(el)` 读起来
  // 就是 `useX()`），报「Hook 不能在 try/catch 里调用」。它只是个普通回调，改名了事——
  // 比给三处调用点各贴一条 disable 诚实（那条规则报得对，错的是名字）。
  const pickAndRemember = useCallback((el: ElementRow) => {
    const next = pushRecent(localStorage.getItem("tp_ui_recent_elements"), { id: el.id, name: el.name });
    writeRecent(localStorage, next);
    setRecent(next);
    onPick(el.id, el);
  }, [onPick]);

  const options = useMemo(() => {
    const opts = rows.map((r) => ({
      value: r.id,
      // 过滤走 searchText（label 是 JSX，optionFilterProp 量不了）；元素库页同款按名匹配
      searchText: r.name,
      label: <span data-testid={testIdBase + "-option"}>{r.name}
        <Typography.Text className="tp-text-sm" type="secondary" style={{ marginLeft: 6 }}>{r.locator_type}:{r.locator}</Typography.Text>
      </span>,
    }));
    // 值在库里查不到（元素被回收/删除）时也得显示点什么，而不是裸 id 闪一下没了名字。
    // 「查不到」只在真的拉到过清单时才算数——清单没取到时说「库中未找到」是替一次
    // 网络故障下结论。
    if (value && loadState === "ok" && !rows.some((r) => r.id === value)) {
      opts.unshift({ value, searchText: value, label: <span>元素 {value}（库中未找到）</span> });
    }
    return opts;
  }, [rows, value, testIdBase, loadState]);

  const recentVisible = useMemo(
    () => recent.filter((r) => rows.some((row) => row.id === r.id)).slice(0, 8),
    [recent, rows],
  );

  async function submitCreate(): Promise<void> {
    if (!pid) return;
    const v = cName.trim();
    if (!v) { message.warning("元素名必填"); return; }
    if (!cLocator.trim()) { message.warning("定位表达式必填"); return; }
    setBusy(true);
    try {
      const el = await uiApi.createElement({
        project_id: pid, name: v, locator_type: cType, locator: cLocator.trim(),
        module_id: null, comment: null,
        project_public: true, // 生成物类型要求此字段（schema 有默认值但 TS 类型必填，同元素库页）
      });
      message.success("元素已创建并选中");
      setCreating(false); setCName(""); CLocator(""); setCType("css");
      await load();
      pickAndRemember(el); // 「建完直接选中」（e2e ③）
    } catch { /* toast；重名 409 留在内联表单里改 */ } finally { setBusy(false); }
  }

  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Select
        data-testid={testIdBase + "-select"}
        style={{ width: "100%" }}
        showSearch optionFilterProp="searchText" disabled={!pid}
        placeholder={pid ? "搜索并选择元素库元素" : "等待项目上下文…"}
        value={value ?? undefined}
        options={options}
        labelInValue={false}
        onChange={(id: string) => {
          const el = rows.find((r) => r.id === id);
          if (el) pickAndRemember(el);
        }}
        notFoundContent={loadState === "loading" ? "元素库加载中…"
          : loadState === "denied" ? "没有读取元素库的权限，这里列不出元素"
          : loadState === "error" ? "元素库没取到（不是库是空的）——重新打开这一步可再拉一次"
          : rows.length ? partial ? "前 200 个元素里没有匹配的，换个关键词" : "没有匹配的元素"
          : "元素库还是空的，就地新建一个"}
      />
      {recentVisible.length > 0 && (
        <Space size={4} wrap data-testid={testIdBase + "-recent"}>
          <Typography.Text className="tp-text-sm" type="secondary">最近使用</Typography.Text>
          {recentVisible.map((r) => (
            <Tooltip key={r.id} title={r.name}>
              <Button size="small" data-testid={testIdBase + "-recent-" + r.id}
                type={value === r.id ? "primary" : "default"}
                onClick={() => {
                  const el = rows.find((row) => row.id === r.id);
                  if (el) pickAndRemember(el);
                }}>
                {r.name}
              </Button>
            </Tooltip>
          ))}
        </Space>
      )}
      {canCreate && !creating && (
        <Button size="small" type="dashed" block icon={<PlusOutlined />}
          data-testid={testIdBase + "-new-toggle"} onClick={() => setCreating(true)}>
          就地新建元素
        </Button>
      )}
      {canCreate && creating && (
        // 内联展开的新建表单（§11.4.11 的字段口径：名称/类型/表达式；备注留给元素库页）
        <div data-testid={testIdBase + "-new-form"}
          style={{ border: "1px dashed #d9d9d9", borderRadius: 6, padding: 8 }}>
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <Input data-testid={testIdBase + "-new-name"} size="small" maxLength={200} value={cName} autoFocus
              placeholder="元素名（项目内唯一）" onChange={(e) => setCName(e.target.value)} />
            <Select data-testid={testIdBase + "-new-type"} size="small" style={{ width: "100%" }} value={cType}
              options={TYPE_OPTIONS} onChange={setCType} />
            <Input data-testid={testIdBase + "-new-locator"} size="small" maxLength={500} value={cLocator}
              placeholder="定位表达式，如 #submit-btn"
              onChange={(e) => CLocator(e.target.value)} onPressEnter={() => void submitCreate()} />
            <Space>
              <Button size="small" type="primary" loading={busy} data-testid={testIdBase + "-new-ok"}
                onClick={() => void submitCreate()}>
                创建并选中
              </Button>
              <Button size="small" data-testid={testIdBase + "-new-cancel"}
                onClick={() => { setCreating(false); setCName(""); CLocator(""); }}>取消</Button>
            </Space>
          </Space>
        </div>
      )}
    </Space>
  );
}
