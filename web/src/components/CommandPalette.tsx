// Ctrl+K 全局快捷查找（T22，§11.4.19/R51；1C T12/R109 扩五路；1D 扩七组；1E T9 扩九组）：
// 居中浮层 640，九组（定义/用例/场景/元素/UI 用例/ADB 用例/定时任务/通知渠道/设备），
// ↑↓ 移动焦点、Enter 直达详情、Esc 关闭。
// 数据源是后端 search_assets——前端不装假结果：每组空了说「无匹配」，全空一块「没有匹配」。
// adb_cases / schedules / notify_channels 已随 gen:api 进生成物 SearchAssetsOut，直读字段
// （后端改键名编译先报错）；渲染侧仍 (x ?? []) 兜运行时缺键——缺键 = 该组如实「无匹配」，绝不编条目。
// 「设备」组是本地导航项（设备页没有可搜 kind，D19 不预留空实现），永远恰好一条、
// Enter 落 #/adb/devices。
// 键盘导航自绘（不用 antd Select 的 a11y 隐藏副本，e2e 测过它会骗人）。
// Enter 落点映射在 ../ui/paletteNav（纯函数，vitest 钉着「每个 kind 都有落点」）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, Input, Spin, Tag, Typography, type InputRef } from "antd";
import { MobileOutlined } from "../ui/icons";
import { useNavigate } from "react-router-dom";
import { searchApi, type SearchAssetItem } from "../api/search";
import { ApiErr } from "../api/client";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { tp, tpv } from "../theme";
import { gotoPalette, type Kind } from "../ui/paletteNav";

interface Flat { kind: Kind; item: SearchAssetItem }

const GROUPS: Array<{ kind: Kind; label: string }> = [
  { kind: "definition", label: "接口定义" },
  { kind: "case", label: "用例" },
  { kind: "scenario", label: "场景" },
  { kind: "ui_element", label: "元素" },
  { kind: "ui_case", label: "UI 用例" },
  { kind: "adb_case", label: "ADB 用例" },
  { kind: "schedule", label: "定时任务" },
  { kind: "notify_channel", label: "通知渠道" },
  { kind: "nav_device", label: "设备" },
];

// 后两组除了 search:read 还各要一把自己的位（search/services.py:200 / :217）：
// 缺位时后端**整组返回空**而不是 403（注释原话：一组 403 会把其余七组一起带走）。
// 于是前端拿到的就是一个空数组——和「查过了，确实一条没有」在数据上一模一样。
// 组头再统一喊「无匹配」，就是对着一个根本没查的组说假话，而这句话的下一句
// （「换个词试试」）在这条路上永远走不通。这里按同一把尺（auth/perms 与后端
// match_perm 逐语义对齐）把「这一组没参与搜索」如实说出来。
const GROUP_PERM: Partial<Record<Kind, string>> = {
  schedule: "schedule:task:read",
  notify_channel: "notify:channel:read",
};

// 本地导航项（不进搜索）：关键词非空时挂在「设备」组下，Enter 直达卡片墙。
const DEVICE_NAV_ITEM: SearchAssetItem = { id: "", name: "设备管理（ADB 设备卡片墙）" } as SearchAssetItem;

/** 搜索失败的四分类：只认错误信封的 code / 状态码，不正则匹配中文 message（D38 同口径）。
 *
 * GET /search-assets 的 403 只有两条来路（顺序即后端顺序），两条都是读得出的事实：
 * - core/service.py:209 `forbidden`：路由构造 ctx 时 resolve_project_perms 返回 None
 *   （main.py:105 装的 resolver = project_services.py:304，项目不存在或非成员 → None）。
 *   它走在 require 之前，所以非成员拿到的永远是这一条。
 * - core/service.py:57 `insufficient_permission`：是成员但角色里没有 search:read
 *   （GET 路由投影 service.py:372 的 ctx.require(spec.perm)，位名由 D38 塞进 details.perm）。
 * 422 是第四条：search/services.py:57 `q: Field(min_length=1, max_length=100)`——
 * 粘一段日志（≥101 字）会被入参模型当面拒掉。这是服务**答了并明确拒了**，不是没回应；
 * 喊「稍后再试」指向的重试同样长度再发一次还是 422，永远走不通。出口是截短关键词。
 * 其余状态码（5xx / 断网后 client 兜的 http_0）归 outage。 */
function errKindOf(e: unknown): "perm" | "outsider" | "too_long" | "outage" {
  if (e instanceof ApiErr) {
    if (e.status === 403) return e.code === "insufficient_permission" ? "perm" : "outsider";
    if (e.status === 422) return "too_long";
  }
  return "outage";
}

const ERR_TEXT: Record<"perm" | "outsider" | "too_long" | "outage", (kw: string) => string> = {
  perm: (kw) => "搜不了「" + kw + "」——当前角色在本项目没有全局查找权限（search:read），重试不会变成能搜",
  outsider: (kw) => "搜不了「" + kw + "」——已经读不到这个项目的数据（不是成员或项目已不可用），换个项目再搜",
  too_long: (kw) => "搜不了「" + kw.slice(0, 20) + "…」——搜索关键词太长了（上限 100 字），截短一点再搜",
  outage: (kw) => "暂时搜不到「" + kw + "」——搜索服务没回应，稍后再试",
};

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { project, user } = useAuth();
  const [q, setQ] = useState("");
  const [out, setOut] = useState<{ definitions: SearchAssetItem[]; cases: SearchAssetItem[]; scenarios: SearchAssetItem[]; ui_elements: SearchAssetItem[]; ui_cases: SearchAssetItem[]; adb_cases?: SearchAssetItem[] | null; schedules?: SearchAssetItem[] | null; notify_channels?: SearchAssetItem[] | null } | null>(null);
  const [loading, setLoading] = useState(false);
  // 搜索失败 ≠ 没有匹配：把「取不到」演成「无结果」会让业主对着明明存在的资产说"搜不到"。
  // 四种失败各有各的下一句话，所以存「哪一种」而不是一个布尔：
  // perm     = 角色里没有 search:read（search/services.py:101 → service.py:57 的 insufficient_permission）
  //            ——重试一万次也是 403，喊「稍后再试」是让人白等；
  // outsider = 已经不是这个项目的成员 / 项目不在了（core/service.py:262 的 forbidden，
  //            同一句 403 的另一条来路，出口是切项目不是等）；
  // too_long = 关键词超过入参上限 100 字（search/services.py:57 的 422），
  //            出口是截短关键词——原样重试还是 422；
  // outage   = 5xx / 断网，这一种才配「稍后再试」。
  // 一个 `errored` 布尔装不下这四句话，而两个布尔（errored + denied）会各记各的：
  // 漏 reset 一个就演成「有 denied 没 errored」的幽灵态，所以用单一来源。
  const [errKind, setErrKind] = useState<"perm" | "outsider" | "too_long" | "outage" | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 每次打开重置：上次的关键词与结果留在浮层里会误导「这就是当前项目的数据」
  useEffect(() => {
    if (open) { setQ(""); setOut(null); setLoading(false); setErrKind(null); setActive(0); }
  }, [open]);

  // 300ms 防抖：Ctrl+K 边打字边搜，不打后端每键一枪
  useEffect(() => {
    if (!open || !project) return;
    const kw = q.trim();
    if (!kw) {
      // setLoading(false) 不能省：上面那条非空关键词的 effect 已经把 loading 提成 true 了，
      // 而它注册的 clearTimeout 让那次请求永远不发 → .finally 也就永远不跑。
      // 实测（本文件「打字后立刻删空」用例）：删掉这一句，打完一个字再退格，
      // 浮层就卡在转圈——请求零发、关键词是空的、也没有任何出口，只能关掉重开。
      setOut(null); setErrKind(null); setLoading(false); return;
    }
    let dead = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchApi.assets(project.id, kw)
        .then((r) => {
          if (!dead) {
            setOut({
              definitions: r.definitions, cases: r.cases, scenarios: r.scenarios,
              ui_elements: r.ui_elements, ui_cases: r.ui_cases,
              // gen:api 已把 adb_cases / schedules / notify_channels 烘进生成物
              // SearchAssetsOut——直读字段，不再走 `as` 兜底：后端改键名时这里先编译报错，
              // 而不是静默演成「无匹配」。`?? []` 留着纯防御运行时缺键（旧后端混部）。
              adb_cases: r.adb_cases,
              schedules: r.schedules,
              notify_channels: r.notify_channels,
            });
            setErrKind(null);
            setActive(0);
          }
        })
        // 失败态如实报「哪一种搜不了」，不伪装成空结果，也不把权限问题演成临时故障
        .catch((e: unknown) => {
          if (dead) return;
          setOut(null);
          setErrKind(errKindOf(e));
          setActive(0); // 行表塌成一行了，旧下标会指到空位：↑↓ 之外 Enter 会静默失灵
        })
        .finally(() => { if (!dead) setLoading(false); });
    }, 300);
    return () => { dead = true; clearTimeout(t); };
  }, [q, open, project]);

  // 设备项（本地导航，不打后端）在失败态要不要留：只看「这次失败有没有牵连设备页」——D145。
  // outsider = 已经读不到整个项目（core/service.py:209 的 forbidden），设备页读的正是这个项目
  //            （adbDevices.tsx:272 `project_id: pid`）⇒ 递一个入口就是许一个兑现不了的诺，
  //            与 :306 那块「没项目时不许喊『输入关键词开始搜索』」同一条尺：死路不写成邀请。
  // perm     = 缺的是 search:read（core/service.py:57，位名由 D38 塞进 details.perm），
  //            断的是「这一路搜索不能走」；设备页要的是 adb:device:*，同一把尺上没有这一位。
  // too_long = 422 拒的是这一串关键词（search/services.py:57），查询根本没执行。
  // outage   = 搜索没回应，但「搜索没回应」推不出「设备页也没回应」= 无情报，不下结论
  //            （与下面 groupUnsearched 对未知角色「宁可不横幅」同一条尺）；摘掉它反而把
  //            浮层变成 D144 那种「失败态没有出口」。
  // 空关键词（out 与 errKind 双 null）不在这里放行：空闲态维持原样，靠引导语那句
  // 「搜『设备』可打开设备卡片墙」，不新增常驻行。
  const deviceNavShown = out !== null || (errKind !== null && errKind !== "outsider");

  const flat: Flat[] = useMemo(() => {
    if (!deviceNavShown) return [];
    const head: Flat[] = out ? [
      ...out.definitions.map((item) => ({ kind: "definition" as const, item })),
      ...out.cases.map((item) => ({ kind: "case" as const, item })),
      ...out.scenarios.map((item) => ({ kind: "scenario" as const, item })),
      ...out.ui_elements.map((item) => ({ kind: "ui_element" as const, item })),
      ...out.ui_cases.map((item) => ({ kind: "ui_case" as const, item })),
      // 键已在生成物里（上面直读取），这里的 ?? [] 只兜运行时缺键（旧后端混部）：
      // 缺键 = 空数组 = 该组「无匹配」，这是如实降级而不是编条目。
      ...(out.adb_cases ?? []).map((item) => ({ kind: "adb_case" as const, item })),
      ...(out.schedules ?? []).map((item) => ({ kind: "schedule" as const, item })),
      ...(out.notify_channels ?? []).map((item) => ({ kind: "notify_channel" as const, item })),
    ] : [];
    // 设备 = 本地导航项（不进搜索）：且不进「有结果」计数。
    return [...head, { kind: "nav_device" as const, item: DEVICE_NAV_ITEM }];
  }, [out, deviceNavShown]);

  // 「没有匹配」的判据只看搜索八组——设备导航项恒在，不许把它算进「有结果」。
  const searchHitCount = flat.filter((f) => f.kind !== "nav_device").length;

  useEffect(() => {
    if (!open) return;
    // 焦点进输入框：打开就能打字，不用再点一次
    setTimeout(() => inputRef.current?.input?.focus(), 0);
    // Esc 关窗挂在 window 上：关窗不该押在「焦点恰好还在输入框」上——
    // 点击结果项导航后焦点会掉到 body，再开浮层时若不点输入框，Esc 会静默失灵。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pick = (f: Flat) => {
    const to = gotoPalette(f.kind, f.item);
    if (to) { onClose(); nav(to.replace(/^#/, "")); }
  };

  const byKind = (kind: Kind) => flat.filter((f) => f.kind === kind);

  // 「这一组根本没参与搜索」的判据。patterns 为空 = 未知角色/旧快照，是**无情报**：
  // 这时不猜，沿用「无匹配」（与 auth/perms.ts:65 isReadOnlyPatterns 对未知角色的
  // 「宁可不横幅」同一条尺——把没把握的结论写死，比少一句提示更坏）。
  const perms = patternsForProject(project, user?.is_system_admin);
  const groupUnsearched = (kind: Kind): string | null => {
    const perm = GROUP_PERM[kind];
    if (!perm || perms.length === 0 || can(perms, perm)) return null;
    return `本角色缺 ${perm}，这一组没有参与搜索`;
  };
  const unsearchedLabels = GROUPS
    .filter((g) => groupUnsearched(g.kind) !== null)
    .map((g) => g.label);
  // 真正把参与搜索的组名摊给人看的两处（输入框 placeholder、空闲引导语）共用这一份名单：
  // placeholder 曾静态列全八类，而同层浮层下面已承认「定时任务/通知渠道 你的角色没有读
  // 权限，不会出现在结果里」（后端对缺位的组整组返回空，services.py:200/:217）——
  // 引导语按 groupUnsearched 收了口，placeholder 没跟上，就是同一段浮层里的两句相反的话。
  const searchableLabels = GROUPS
    .filter((g) => g.kind !== "nav_device" && groupUnsearched(g.kind) === null)
    .map((g) => g.label);

  return (
    <div data-testid="palette-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: tpv.mask,
        display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "12vh",
      }}>
      <div style={{ width: 640, maxWidth: "92vw", background: "var(--tp-bg-container)", borderRadius: 10,
        boxShadow: "0 12px 48px rgba(16,24,40,.18)", overflow: "hidden" }}>
        <div style={{ padding: 8, borderBottom: "1px solid var(--tp-split)" }}>
          <Input ref={inputRef} data-testid="palette-input" variant="borderless"
            placeholder={"搜" + searchableLabels.join(" / ") + "（↑↓ 选择，Enter 打开，Esc 关闭）"}
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (flat.length) setActive((a) => (a + 1) % flat.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (flat.length) setActive((a) => (a - 1 + flat.length) % flat.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (flat[active]) pick(flat[active]);
              }
            }} />
        </div>
        <div ref={listRef} style={{ maxHeight: "52vh", overflow: "auto", padding: "6px 0" }}>
          {loading && <div style={{ padding: 24, textAlign: "center" }}><Spin size="small" /></div>}
          {!loading && errKind && (
            // 「没搜到」和「搜不了」必须是两句话，「搜不了」的三种原因又是三句话：
            // 空态模板在这里是撒谎，而把 403 喊成「稍后再试」是让人对着死路反复按重试。
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} data-testid="palette-error"
              description={ERR_TEXT[errKind](q.trim())}
              style={{ padding: "18px 0" }} />
          )}
          {!loading && out && searchHitCount === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} data-testid="palette-empty"
              description={"没有匹配「" + q.trim() + "」的接口定义 / 用例 / 场景 / 元素 / UI 用例 / ADB 用例 / 定时任务 / 通知渠道"
                // 同一句话里不许一边说「都没有」、一边把没搜的组算进「都」：
                // 组头改口了而这块还照旧列八类，等于换个位置接着撒谎。
                + (unsearchedLabels.length
                  ? "；其中 " + unsearchedLabels.join(" / ") + " 因缺权限没有参与搜索，不算查过"
                  : "")}
              style={{ padding: "18px 0" }} />
          )}
          {!loading && deviceNavShown && (out ? GROUPS : GROUPS.filter((g) => g.kind === "nav_device")).map((g) => {
            const rows = byKind(g.kind);
            return (
              <div key={g.kind} data-testid="palette-group" data-kind={g.kind}>
                <div className="tp-text-xs" style={{ padding: "4px 16px", color: "var(--tp-text-3)", letterSpacing: 1 }}>
                  {g.label}
                  {/* 空组的两种来路分开说：查过了没有 vs 这一组根本没查。 */}
                  {rows.length === 0 && <span style={{ marginLeft: 8 }}>{groupUnsearched(g.kind) ?? "无匹配"}</span>}
                </div>
                {rows.map((f) => {
                  const idx = flat.indexOf(f);
                  return (
                    <div key={g.kind + ":" + f.item.id} data-testid="palette-item" data-kind={g.kind}
                      data-active={idx === active ? "true" : "false"}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(f)}
                      style={{
                        display: "flex", gap: 8, alignItems: "center", padding: "6px 16px", cursor: "pointer",
                        background: idx === active ? "#EAF6F1" : undefined,
                      }}>
                      <Typography.Text className="tp-text-md" style={{ flex: 1, minWidth: 0 }}
                        ellipsis={{ tooltip: f.item.name }}>{f.item.name}</Typography.Text>
                      {f.kind === "definition" && (
                        <Typography.Text type="secondary" className="tp-mono tp-text-sm">
                          {f.item.method} {f.item.path}
                        </Typography.Text>
                      )}
                      {f.kind === "case" && (
                        <Typography.Text className="tp-text-sm" type="secondary">
                          属于 {f.item.definition_name ?? "（定义已删）"}
                        </Typography.Text>
                      )}
                      {f.kind === "scenario" && <Tag style={{ marginInlineEnd: 0 }}>{f.item.priority}</Tag>}
                      {f.kind === "ui_case" && <Tag style={{ marginInlineEnd: 0 }}>{f.item.priority}</Tag>}
                      {f.kind === "adb_case" && <Tag style={{ marginInlineEnd: 0 }}>{f.item.priority}</Tag>}
                      {f.kind === "nav_device" && (
                        <Typography.Text className="tp-text-sm" type="secondary">
                          <MobileOutlined /> 打开 /adb/devices
                        </Typography.Text>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!loading && !out && !project && (
            // 没项目时搜索请求根本发不出去（上面的 effect 第一行就 return），
            // 再喊「输入关键词开始搜索」就是让业主打字打到疲倦也不会有一个结果。
            <div className="tp-text-sm" data-testid="palette-no-project" style={{ padding: "18px 16px", color: tpv.text[3] }}>
              还没有选定项目，全局查找搜不了——先在顶栏的项目下拉或工作台选一个项目，再按 Ctrl+K。
            </div>
          )}
          {!loading && !out && !errKind && project && (() => {
            // 引导语的名单与组头、placeholder 共用同一份筛后名单：缺位的组在后端整组返回空，
            // 这里却把它们列进「输入关键词就能搜到」，是同一段浮层里的第二句谎。
            const named = searchableLabels.join("、");
            return (
              <div className="tp-text-sm" style={{ padding: "18px 16px", color: "var(--tp-text-3)" }}>
                输入关键词开始搜索——{named}，搜「设备」可打开设备卡片墙。
                {unsearchedLabels.length > 0
                  && ` ${unsearchedLabels.join(" / ")} 你的角色没有读权限，不会出现在结果里。`}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
