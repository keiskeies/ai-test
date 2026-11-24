// 全局框架：改用 antd 官方 **ProLayout**（@ant-design/pro-components）——不再自建壳层。
//
// 为什么换：此前是自建 Layout/Sider/Menu 薄封装，偏离了 antd 内部契约
// （Sider 的 children 容器没拿到 flex/min-height，菜单滚不动、底部按钮被裁出视口），
// 且头部/菜单/折叠/响应式/滚动这些本就是 admin 框架的内建能力。按业主裁定：
// 能用框架组件的不许自己写。
//
// 本文件只保留**业务态**：菜单数据（含 testid 与诚实标注）、项目切换、全局搜索、
// 主题开关、用户菜单、侧栏折叠状态。布局、滚动、菜单展开、折叠与响应式交给 ProLayout。
//
// 未开放模块仍保留诚实提示（不做假页面骗点击）：MCP/Skills = 二期仍未开放。
import { useEffect, useState, type ReactNode } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { Dropdown, Input, Select, Space, Tooltip, Typography } from "antd";
import {
  AndroidOutlined, ApiOutlined, BellOutlined, BugOutlined, ClockCircleOutlined, CodeOutlined,
  DatabaseOutlined, DesktopOutlined, ExperimentOutlined, FileTextOutlined,
  HddOutlined, LayersOutlined, MoonOutlined, NodeIndexOutlined,
  OrderedListOutlined, PanelLeftCloseOutlined, PanelLeftOpenOutlined,
  ProfileOutlined, ProjectOutlined, RobotOutlined, ScheduleOutlined, SearchOutlined,
  SettingOutlined, SparklesOutlined, SunOutlined, TableOutlined, TeamOutlined,
  TerminalOutlined, ToolOutlined, UsergroupOutlined, UserOutlined,
} from "../ui/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import { get } from "../api/client";
import CommandPalette from "../components/CommandPalette";
import ChangePasswordModal from "./ChangePasswordModal";
import { useTheme } from "../ui/themeMode";
import type { ThemePref } from "../ui/themeMode";

type Leaf = { key: string; label: string; testid: string; to?: string; note?: string; icon: ReactNode };
type Group = { key: string; label: string; icon: ReactNode; children: Leaf[] };
/** ProLayout 的 route 项（只写我们用到的字段）。 */
type RouteItem = { path: string; name: ReactNode; icon?: ReactNode; children?: RouteItem[] };

// §11.1 模块树。图标语义按各自域挑（旧版：工作台=人、任务中心=文档、ADB=品牌标）。
// 叶子一律带图标：无图标项 ProLayout 只留一个 display:none 的占位槽，17 个叶子的
// 文字因此全贴在同一根左轨上，与分组标题只差字号（2026-11-22 审计实测）。
const MENU: Group[] = [
  {
    key: "g-work",
    label: "工作台",
    icon: <TeamOutlined />,
    children: [
      { key: "home", label: "项目与工作台", testid: "nav-home", to: "/", icon: <ProjectOutlined /> },
      { key: "bench", label: "Pilot 试验台", testid: "nav-bench", to: "/bench", icon: <ExperimentOutlined /> },
    ],
  },
  {
    key: "g-api",
    label: "API 测试",
    icon: <ApiOutlined />,
    children: [
      { key: "api", label: "接口管理", testid: "nav-api", to: "/api", icon: <CodeOutlined /> },
      { key: "scene", label: "场景编排", testid: "nav-scene", to: "/scene", icon: <NodeIndexOutlined /> },
      { key: "datasets", label: "数据集", testid: "nav-datasets", to: "/datasets", icon: <DatabaseOutlined /> },
      { key: "mock", label: "API Mock", testid: "nav-mock", to: "/mock", icon: <ApiOutlined /> },
    ],
  },
  {
    key: "g-ui",
    label: "UI 测试",
    icon: <DesktopOutlined />,
    children: [
      { key: "ui-elements", label: "元素库", testid: "nav-ui-elements", to: "/ui/elements", icon: <LayersOutlined /> },
      { key: "ui-cases", label: "UI 用例", testid: "nav-ui-cases", to: "/ui/cases", icon: <OrderedListOutlined /> },
    ],
  },
  {
    key: "g-adb",
    label: "ADB 测试",
    icon: <AndroidOutlined />,
    children: [
      { key: "adb-devices", label: "设备管理", testid: "nav-adb-devices", to: "/adb/devices", icon: <HddOutlined /> },
      { key: "adb-cases", label: "ADB 用例", testid: "nav-adb-cases", to: "/adb/cases", icon: <TerminalOutlined /> },
    ],
  },
  {
    // D191：补 MS 的「测试跟踪」一级；D193 功能用例本体已落地（评审仍在后续批次）。
    key: "g-tracking",
    label: "测试跟踪",
    icon: <BugOutlined />,
    children: [
      { key: "cases", label: "功能用例", testid: "nav-cases", to: "/functional/cases", icon: <OrderedListOutlined /> },
      { key: "defects", label: "缺陷管理", testid: "nav-defects", to: "/defects", icon: <BugOutlined /> },
      { key: "reviews", label: "用例评审", testid: "nav-reviews", to: "/reviews", icon: <ProfileOutlined /> },
    ],
  },
  {
    key: "g-task",
    label: "任务中心",
    icon: <ProfileOutlined />,
    children: [
      { key: "task-center", label: "任务中心", testid: "nav-task-center", to: "/task-center", icon: <ClockCircleOutlined /> },
      { key: "runs", label: "运行记录", testid: "nav-runs", to: "/runs", icon: <ClockCircleOutlined /> },
      { key: "plans", label: "测试计划", testid: "nav-plans", to: "/plans", icon: <TableOutlined /> },
      { key: "reports", label: "报告中心", testid: "nav-reports", to: "/reports", icon: <FileTextOutlined /> },
      { key: "cron", label: "定时任务", testid: "nav-cron", to: "/schedules", icon: <ScheduleOutlined /> },
    ],
  },
  {
    key: "g-sys",
    label: "系统设置",
    icon: <SettingOutlined />,
    children: [
      { key: "settings", label: "项目与成员", testid: "nav-settings", to: "/settings", icon: <UsergroupOutlined /> },
      // D270：组织是平台级分组层，不依赖当前项目——独立成页，组织管理员（非系统管理员）
      // 也有入口；此前只挂在设置页的系统管理员 Tab 下，组织管理员界面是死路。
      { key: "orgs", label: "组织", testid: "nav-orgs", to: "/orgs", icon: <TeamOutlined /> },
      { key: "files", label: "文件管理", testid: "nav-files", to: "/files", icon: <FileTextOutlined /> },
      { key: "mcp", label: "MCP 服务", testid: "nav-mcp", to: "/settings/mcp", icon: <ToolOutlined /> },
      { key: "skills", label: "Skills", testid: "nav-skills", to: "/settings/skills", icon: <SparklesOutlined /> },
      { key: "notify", label: "通知渠道", testid: "nav-notify", to: "/notify/channels", icon: <BellOutlined /> },
    ],
  },
];

const ROUTES: Record<string, string> = {};
for (const g of MENU) for (const l of g.children) if (l.to) ROUTES[l.key] = l.to;
const PATH_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(ROUTES).map(([k, p]) => [p, k]),
);
// 详情页按前缀回落到所属列表项（否则侧栏在详情页上「什么都不选中」）。
const PREFIX_TO_KEY: Array<[string, string]> = [
  ["/scene/", "scene"], ["/reports/", "reports"], ["/plans/", "plans"], ["/plan-reports/", "plans"],
  ["/ui/cases/", "ui-cases"], ["/adb/cases/", "adb-cases"], ["/defects/", "defects"],
  ["/functional/cases/", "cases"], ["/reviews/", "reviews"],
];
function currentKey(pathname: string): string {
  const exact = PATH_TO_KEY[pathname];
  if (exact) return exact;
  const hit = PREFIX_TO_KEY.find(([p]) => pathname.startsWith(p));
  return hit ? hit[1] : "home";
}

/** ProLayout 的菜单数据。未开放项给伪路径 `/_disabled/<key>`，由 menuItemRender 拦下。 */
function menuRoutes(isSysAdmin: boolean): RouteItem[] {
  return MENU.map((g) => ({
    path: "/" + g.key,
    name: g.label,
    icon: g.icon,
    children: g.children
      // D165 §11.5.1「按钮级权限点隐藏(非禁用)」：通知渠道是平台级配置，非系统管理员留入口
      // 只会引入恒 403 的页。路由本身不藏：直访仍进得去，页面给诚实空态。
      .filter((l) => l.key !== "notify" || isSysAdmin)
      .map((l) => ({
        path: l.to ?? "/_disabled/" + l.key,
        icon: l.icon,
        // 未开放项走 antd 原生 disabled：整行（图标+文字）降到 disabled 态、光标 not-allowed，
        // 不靠 hover 才知道它点不动（2026-11-22 审计：此前 text-2/opacity1 与可用项无差别）。
        // 诚实口径不变：note 文案仍在 name 的 Tooltip 上，且 disabled 项 onClick 不进路由。
        disabled: Boolean(l.note),
        name: (
          <span data-testid={l.testid}>
            {l.note ? <Tooltip title={l.note}><span>{l.label}</span></Tooltip> : l.label}
          </span>
        ),
      })),
  }));
}

const SIDER_KEY = "tp_sider_collapsed";
const THEME_ORDER: ThemePref[] = ["system", "light", "dark"];
const THEME_LABEL: Record<ThemePref, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

function ProjectSwitcher() {
  const { project, setProject } = useAuth();
  const [opts, setOpts] = useState<ProjectOut[]>([]);
  // 失败要留痕：下拉空了会露 antd 的「暂无数据」——对正在项目里的人说「你没有项目」。
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    get<{ items: ProjectOut[] }>("/projects?size=200")
      .then((r) => { setFailed(false); setOpts(r.items); })
      .catch(() => setFailed(true));
  }, [project]);
  return (
    <div data-testid="project-switcher" style={{ minWidth: 220 }}>
      <Select
        style={{ width: "100%" }}
        variant="filled"
        placeholder="选择项目"
        value={project?.id}
        options={opts.map((o) => ({ value: o.id, label: o.name }))}
        notFoundContent={failed
          ? "项目列表没取到，可能是网络不通——当前项目照常可用，重新进入本页可重试"
          : undefined}
        onChange={(id) => {
          const hit = opts.find((o) => o.id === id);
          setProject(hit ?? null);
        }}
      />
    </div>
  );
}

/** 主题三态循环：图标反映当前生效模式（system 时显示实际深浅）。 */
function ThemeToggle() {
  const { pref, mode, setPref } = useTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length];
  return (
    <Tooltip title={`主题：${THEME_LABEL[pref]}（点击切到${THEME_LABEL[next]}）`}>
      <button type="button" className="tp-iconbtn" data-testid="theme-toggle"
        aria-label={`主题：${THEME_LABEL[pref]}，切换到${THEME_LABEL[next]}`}
        onClick={() => setPref(next)}>
        {mode === "dark" ? <MoonOutlined size={17} /> : <SunOutlined size={17} />}
      </button>
    </Tooltip>
  );
}

export default function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const { user, logout } = useAuth();
  const selectedKey = currentKey(loc.pathname);
  // 侧栏折叠状态按浏览器记（设备偏好，不存服务端）。
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDER_KEY) === "1"; } catch { return false; }
  });
  const toggleCollapsed = (): void => {
    setCollapsed((c) => {
      try { localStorage.setItem(SIDER_KEY, c ? "0" : "1"); } catch { /* 只影响本次 */ }
      return !c;
    });
  };
  // 浮层开关只有这一个 state：open 是显隐，nonce 是「这一次唤起」的实例键（理由见旧版注释）。
  const [palette, setPalette] = useState({ open: false, nonce: 0 });
  const [pwdOpen, setPwdOpen] = useState(false);
  // 浮层跟着路由走：同文档导航组件不重建，残留会误导「这是当前页的数据」。
  useEffect(() => {
    setPalette((p) => (p.open ? { ...p, open: false } : p));
  }, [loc.pathname, loc.search, loc.hash]);
  // Ctrl+K / ⌘K 全局唤起（§11.4.19）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => (p.open ? { ...p, open: false } : { open: true, nonce: p.nonce + 1 }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const userMenu = (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          { key: "who", label: (user?.name ?? "") + "（" + (user?.account ?? "") + "）", disabled: true },
          // D198：个人中心（资料/偏好/API Key），门禁 = 已登录。
          ...(user ? [{ key: "me", label: <span data-testid="menu-me">个人中心</span> }] : []),
          // D105 自助改密：门禁 = 已登录（后端判平台级基础位，按项目 perms 门禁会造新假门）。
          ...(user ? [{ key: "password", label: <span data-testid="menu-change-password">修改密码</span> }] : []),
          { key: "logout", label: <span data-testid="logout">退出登录</span> },
        ],
        onClick: ({ key }) => {
          if (key === "logout") logout();
          if (key === "password") setPwdOpen(true);
          if (key === "me") nav("/me");
        },
      }}
    >
      <Space data-testid="user-menu" size={8} style={{ cursor: "pointer" }}>
        <span className="tp-avatar" aria-hidden><UserOutlined size={14} /></span>
        <Typography.Text className="tp-text-md" strong>{user?.name}</Typography.Text>
      </Space>
    </Dropdown>
  );

  return (
    <>
      <ProLayout
        title="TestPilot"
        logo={<span className="tp-logo-mark"><RobotOutlined size={15} /></span>}
        // mix + splitMenus=false：全宽顶栏（logo/操作区）+ 左侧整棵菜单。
        // `side` 会把 actionsRender 全部塞进侧栏底部（实测：项目切换/搜索/用户名挤在左下角），
        // `mix` 默认把一级菜单拆到顶栏，splitMenus=false 关掉拆分，菜单仍留在侧栏。
        layout="mix"
        splitMenus={false}
        navTheme="light"
        siderWidth={208}
        fixSiderbar
        fixedHeader
        collapsed={collapsed}
        onCollapse={setCollapsed}
        // 官方折叠钮默认在侧栏底部（业主明确否掉）；关掉，用顶栏最左的自有按钮。
        collapsedButtonRender={false}
        // 顶栏已有 logo/title，侧栏不再重复一份。
        menuHeaderRender={false}
        // 菜单：默认全展开（诚实标注一眼可见）、不自动收起其它分组。
        // type=group：一级节点画成「分组标签 + 分隔线」（非可折叠 submenu）——
        // ① ProLayout 的叶子图标只在 group 模式渲染（BaseMenu: hasIcon = level===0
        //    || isGroup && level===1），普通 submenu 下叶子图标槽恒 display:none；
        //    ② 全展开布局里 submenu 的折叠箭头是冗余 affordance（默认永远展开）；
        //    ③ 折叠态组间留 4px 分隔。
        // collapsedShowGroupTitle 在 group 模式下**不生效**（2026-11-22 复测）：折叠轨 6 个
        // .ant-menu-item-group-title 实测 display:none、宽高 0——没有分组图标也没有悬浮飞层，
        // 17 个叶子平铺成一条 56px 图标轨。它只作用于 submenu，别再指望它撑折叠态分组语义。
        menu={{ type: "group", defaultOpenAll: true, autoClose: false, locale: false, collapsedShowGroupTitle: true }}
        // 顶部面包屑与页面标题重复，关掉（页面标题由 PageHeader 负责）。
        breadcrumbRender={false}
        location={{ pathname: ROUTES[selectedKey] ?? loc.pathname }}
        route={{ path: "/", routes: menuRoutes(Boolean(user?.is_system_admin)) }}
        menuItemRender={(item, dom) => {
          const to = item.path && !item.path.startsWith("/_disabled") ? item.path : undefined;
          return (
            <span style={{ display: "block", cursor: to ? "pointer" : "not-allowed" }}
              onClick={() => { if (to) nav(to); }}>
              {dom}
            </span>
          );
        }}
        actionsRender={() => [
          <Tooltip key="sider" title={collapsed ? "展开侧栏" : "收起侧栏"}>
            <button type="button" className="tp-iconbtn" data-testid="sider-toggle"
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={toggleCollapsed}>
              {collapsed ? <PanelLeftOpenOutlined size={16} /> : <PanelLeftCloseOutlined size={16} />}
            </button>
          </Tooltip>,
          <ProjectSwitcher key="project" />,
          <Tooltip key="search" title="全局快捷查找（⌘/Ctrl+K）">
            <Input data-testid="shell-search" prefix={<SearchOutlined />}
              placeholder="搜索接口 / 场景 / 用例"
              readOnly variant="filled"
              suffix={<span className="tp-text-xs tp-mono" style={{ color: "var(--tp-text-3)" }}>Ctrl K</span>}
              // flex 0 1 260：顶栏是 flex 行，此前只有 width:260 而 shrink 默认 1，
              // 1366 视口实测被挤到 187.7——写了宽度却从不生效。显式给出基准与地板，
              // 挤到 168（只读触发框，占位文案截断不影响点击）为止。
              style={{ flex: "0 1 260px", minWidth: 168, cursor: "pointer" }}
              onClick={() => setPalette((p) => ({ open: true, nonce: p.nonce + 1 }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setPalette((p) => ({ open: true, nonce: p.nonce + 1 }));
                }
              }} />
          </Tooltip>,
          <ThemeToggle key="theme" />,
          <span key="user">{userMenu}</span>,
        ]}
        contentStyle={{ padding: 0 }}
      >
        <div className="tp-content">
          <Outlet />
        </div>
      </ProLayout>
      <CommandPalette key={palette.nonce} open={palette.open}
        onClose={() => setPalette((p) => ({ ...p, open: false }))} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </>
  );
}