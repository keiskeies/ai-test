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
  AndroidOutlined, ApiOutlined, DesktopOutlined, MoonOutlined, PanelLeftCloseOutlined,
  PanelLeftOpenOutlined, ProfileOutlined, RobotOutlined, SearchOutlined, SettingOutlined,
  SunOutlined, TeamOutlined, UserOutlined,
} from "../ui/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import { get } from "../api/client";
import CommandPalette from "../components/CommandPalette";
import ChangePasswordModal from "./ChangePasswordModal";
import { useTheme } from "../ui/themeMode";
import type { ThemePref } from "../ui/themeMode";

type Leaf = { key: string; label: string; testid: string; to?: string; note?: string };
type Group = { key: string; label: string; icon: ReactNode; children: Leaf[] };
/** ProLayout 的 route 项（只写我们用到的字段）。 */
type RouteItem = { path: string; name: ReactNode; icon?: ReactNode; children?: RouteItem[] };

// §11.1 模块树。图标语义按各自域挑（旧版：工作台=人、任务中心=文档、ADB=品牌标）。
const MENU: Group[] = [
  {
    key: "g-work",
    label: "工作台",
    icon: <TeamOutlined />,
    children: [
      { key: "home", label: "项目与工作台", testid: "nav-home", to: "/" },
      { key: "bench", label: "Pilot 试验台", testid: "nav-bench", to: "/bench" },
    ],
  },
  {
    key: "g-api",
    label: "API 测试",
    icon: <ApiOutlined />,
    children: [
      { key: "api", label: "接口管理", testid: "nav-api", to: "/api" },
      { key: "scene", label: "场景编排", testid: "nav-scene", to: "/scene" },
      { key: "datasets", label: "数据集", testid: "nav-datasets", to: "/datasets" },
    ],
  },
  {
    key: "g-ui",
    label: "UI 测试",
    icon: <DesktopOutlined />,
    children: [
      { key: "ui-elements", label: "元素库", testid: "nav-ui-elements", to: "/ui/elements" },
      { key: "ui-cases", label: "UI 用例", testid: "nav-ui-cases", to: "/ui/cases" },
    ],
  },
  {
    key: "g-adb",
    label: "ADB 测试",
    icon: <AndroidOutlined />,
    children: [
      { key: "adb-devices", label: "设备管理", testid: "nav-adb-devices", to: "/adb/devices" },
      { key: "adb-cases", label: "ADB 用例", testid: "nav-adb-cases", to: "/adb/cases" },
    ],
  },
  {
    key: "g-task",
    label: "任务中心",
    icon: <ProfileOutlined />,
    children: [
      { key: "runs", label: "运行记录", testid: "nav-runs", to: "/runs" },
      { key: "plans", label: "测试计划", testid: "nav-plans", to: "/plans" },
      { key: "reports", label: "报告中心", testid: "nav-reports", to: "/reports" },
      { key: "cron", label: "定时任务", testid: "nav-cron", to: "/schedules" },
    ],
  },
  {
    key: "g-sys",
    label: "系统设置",
    icon: <SettingOutlined />,
    children: [
      { key: "settings", label: "项目与成员", testid: "nav-settings", to: "/settings" },
      { key: "mcp", label: "MCP 服务", testid: "nav-mcp", note: "未开放（计划二期）" },
      { key: "skills", label: "Skills", testid: "nav-skills", note: "未开放（计划二期）" },
      { key: "notify", label: "通知渠道", testid: "nav-notify", to: "/notify/channels" },
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
  ["/ui/cases/", "ui-cases"], ["/adb/cases/", "adb-cases"],
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
      menu={{
        items: [
          { key: "who", label: (user?.name ?? "") + "（" + (user?.account ?? "") + "）", disabled: true },
          // D105 自助改密：门禁 = 已登录（后端判平台级基础位，按项目 perms 门禁会造新假门）。
          ...(user ? [{ key: "password", label: <span data-testid="menu-change-password">修改密码</span> }] : []),
          { key: "logout", label: <span data-testid="logout">退出登录</span> },
        ],
        onClick: ({ key }) => {
          if (key === "logout") logout();
          if (key === "password") setPwdOpen(true);
        },
      }}
    >
      <Space data-testid="user-menu" size={8} style={{ cursor: "pointer", paddingTop: 2 }}>
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
        menu={{ defaultOpenAll: true, autoClose: false, locale: false }}
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
              suffix={<span className="tp-mono" style={{ color: "var(--tp-text-3)", fontSize: 11 }}>Ctrl K</span>}
              style={{ width: 260, cursor: "pointer" }}
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