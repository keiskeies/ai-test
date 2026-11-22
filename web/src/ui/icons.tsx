// 图标唯一入口（§11.6.6：Lucide 1.6px 描边线性风，禁止 emoji 混入 UI）。
//
// 为什么是「同名再导出」而不是逐页改 import 图标名：调用点写的是 antd 的
// `XxxOutlined`，直接换成 `<Plus />` 是 39 个文件 × 逐处改名，改错一个图标
// 编译器不会报（都是合法组件），只能人眼抓。这里保留旧名、实现换成 Lucide，
// 于是「换风格」是一次 import 源替换（`@ant-design/icons` → `ui/icons`），
// 图标语义的修正单独在消费侧做。
//
// 尺寸：默认 1em + 16 的 strokeWidth 1.75（视口 24 时视觉近似 1.6px 描边）；
// antd 按钮/菜单会给 svg 定宽高，图标因此跟随文字大小。需要显式尺寸时传 size。
//
// 少数 antd 专有图标没有 Lucide 一一对应（Android 品牌标、SomeFilled 族），
// 这里给出**语义等价**的替代并在别名旁注明，别让调用点以为拿到的是原图。
import type { LucideIcon, LucideProps } from "lucide-react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Battery, Bell, Bookmark, Bot, Boxes, Bug,
  CalendarClock, ChartLine, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert,
  CircleCheck, CircleHelp, CircleStop, CircleX, ClipboardList, Clock, Code2, Copy,
  CornerDownRight, Database, Download, FileJson, FileText, Filter, FlaskConical, FolderOpen,
  FolderTree, GanttChart, Gauge, Hash, Hourglass, Inbox, Info, Layers, LayoutDashboard,
  Lightbulb, ListChecks, ListFilter, ListTree, Loader2, Lock, Menu, Monitor, Moon,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pause, Play, Plug, Plus, RefreshCw, RotateCcw,
  RotateCw, Save, Search, Send, Server, Settings, Shield, Smartphone, Sparkles, SquarePen,
  Star, Sun, Table2, Terminal, Trash2, TriangleAlert, Upload, User, Users, Wifi, Workflow,
  Wrench, X,
} from "lucide-react";

export type { LucideIcon, LucideProps };

/** 统一描边与尺寸的包壳：所有派生图标都过这里，改线宽只改一处。 */
function make(Icon: LucideIcon, displayName: string): LucideIcon {
  const Wrapped = ((props: LucideProps) => (
    <Icon {...props} size={props.size ?? "1em"} strokeWidth={props.strokeWidth ?? 1.75} />
  )) as LucideIcon;
  Wrapped.displayName = displayName;
  return Wrapped;
}

/** 原样再导出（不包壳，供需要 antd 兼容 `spin` 等自定义属性少见的场合）。 */
export const Icon = make;

// ── 动作 ──
export const PlusOutlined = make(Plus, "PlusOutlined");
export const DeleteOutlined = make(Trash2, "DeleteOutlined");
export const EditOutlined = make(SquarePen, "EditOutlined");
export const SaveOutlined = make(Save, "SaveOutlined");
export const CopyOutlined = make(Copy, "CopyOutlined");
export const ImportOutlined = make(Download, "ImportOutlined");
export const ExportOutlined = make(Upload, "ExportOutlined");
export const UploadOutlined = make(Upload, "UploadOutlined");
export const SendOutlined = make(Send, "SendOutlined");
export const ReloadOutlined = make(RefreshCw, "ReloadOutlined");
export const UndoOutlined = make(RotateCcw, "UndoOutlined");
export const RedoOutlined = make(RotateCw, "RedoOutlined");
export const RestOutlined = make(Inbox, "RestOutlined");
export const SearchOutlined = make(Search, "SearchOutlined");
export const FilterOutlined = make(Filter, "FilterOutlined");
export const StarOutlined = make(Star, "StarOutlined");
export const CloseOutlined = make(X, "CloseOutlined");
export const CheckOutlined = make(Check, "CheckOutlined");
export const MoreOutlined = make(MoreHorizontal, "MoreOutlined");
export const MenuOutlined = make(Menu, "MenuOutlined");
export const PlayCircleOutlined = make(Play, "PlayCircleOutlined");
export const PauseCircleOutlined = make(Pause, "PauseCircleOutlined");
export const StopOutlined = make(CircleStop, "StopOutlined");

// ── 方向 ──
export const ArrowLeftOutlined = make(ArrowLeft, "ArrowLeftOutlined");
export const ArrowRightOutlined = make(ArrowRight, "ArrowRightOutlined");
export const ArrowUpOutlined = make(ArrowUp, "ArrowUpOutlined");
export const ArrowDownOutlined = make(ArrowDown, "ArrowDownOutlined");
export const DownOutlined = make(ChevronDown, "DownOutlined");
export const RightOutlined = make(ChevronRight, "RightOutlined");
export const EnterOutlined = make(CornerDownRight, "EnterOutlined");

// ── 状态 ──
export const CheckCircleOutlined = make(CircleCheck, "CheckCircleOutlined");
export const CheckCircleFilled = make(CircleCheck, "CheckCircleFilled");
export const CloseCircleOutlined = make(CircleX, "CloseCircleOutlined");
export const CloseCircleFilled = make(CircleX, "CloseCircleFilled");
export const ExclamationCircleOutlined = make(CircleAlert, "ExclamationCircleOutlined");
export const WarningOutlined = make(TriangleAlert, "WarningOutlined");
export const TriangleAlertOutlined = make(TriangleAlert, "TriangleAlertOutlined");
export const InfoCircleOutlined = make(Info, "InfoCircleOutlined");
export const QuestionCircleOutlined = make(CircleHelp, "QuestionCircleOutlined");
export const ClockCircleOutlined = make(Clock, "ClockCircleOutlined");
export const HourglassOutlined = make(Hourglass, "HourglassOutlined");
export const LoadingOutlined = make(Loader2, "LoadingOutlined");
export const CheckCircleTwoTone = make(CheckCheck, "CheckCircleTwoTone");

// ── 对象 / 领域 ──
export const ApiOutlined = make(Plug, "ApiOutlined");
export const BugOutlined = make(Bug, "BugOutlined");
export const BuildOutlined = make(Wrench, "BuildOutlined");
export const BulbOutlined = make(Lightbulb, "BulbOutlined");
export const DatabaseOutlined = make(Database, "DatabaseOutlined");
export const FileTextOutlined = make(FileText, "FileTextOutlined");
export const FileJsonOutlined = make(FileJson, "FileJsonOutlined");
export const FolderOutlined = make(FolderOpen, "FolderOutlined");
export const FolderTreeOutlined = make(FolderTree, "FolderTreeOutlined");
export const HddOutlined = make(Server, "HddOutlined");
export const HistoryOutlined = make(Clock, "HistoryOutlined");
export const NodeIndexOutlined = make(Workflow, "NodeIndexOutlined");
export const ProfileOutlined = make(ClipboardList, "ProfileOutlined");
export const ProjectOutlined = make(GanttChart, "ProjectOutlined");
export const ScheduleOutlined = make(CalendarClock, "ScheduleOutlined");
export const TableOutlined = make(Table2, "TableOutlined");
export const CodeOutlined = make(Code2, "CodeOutlined");
export const TerminalOutlined = make(Terminal, "TerminalOutlined");
export const UnorderedListOutlined = make(ListTree, "UnorderedListOutlined");
export const OrderedListOutlined = make(ListChecks, "OrderedListOutlined");
export const FilterListOutlined = make(ListFilter, "FilterListOutlined");

// ── 平台 / 设备 ──
export const DesktopOutlined = make(Monitor, "DesktopOutlined");
export const MobileOutlined = make(Smartphone, "MobileOutlined");
export const RobotOutlined = make(Bot, "RobotOutlined");
/** antd 的 Android 是品牌标（实心小人）；Lucide 无品牌图标，这里用手机语义替代。 */
export const AndroidOutlined = make(Smartphone, "AndroidOutlined");
export const BatteryOutlined = make(Battery, "BatteryOutlined");
export const WifiOutlined = make(Wifi, "WifiOutlined");

// ── 导航 ──
/** 工作台：antd 用 TeamOutlined（人），语义是「协作」——这里换成仪表盘，任务形态更贴。 */
export const TeamOutlined = make(LayoutDashboard, "TeamOutlined");
export const DashboardOutlined = make(LayoutDashboard, "DashboardOutlined");
export const ExperimentOutlined = make(FlaskConical, "ExperimentOutlined");
export const SettingOutlined = make(Settings, "SettingOutlined");
export const ToolOutlined = make(Wrench, "ToolOutlined");
export const UserOutlined = make(User, "UserOutlined");
export const UsergroupOutlined = make(Users, "UsergroupOutlined");
export const SafetyOutlined = make(Shield, "SafetyOutlined");
export const LockOutlined = make(Lock, "LockOutlined");
export const BellOutlined = make(Bell, "BellOutlined");
export const BookmarkOutlined = make(Bookmark, "BookmarkOutlined");
export const SparklesOutlined = make(Sparkles, "SparklesOutlined");
export const GaugeOutlined = make(Gauge, "GaugeOutlined");
export const ChartOutlined = make(ChartLine, "ChartOutlined");
export const BoxesOutlined = make(Boxes, "BoxesOutlined");
export const HashOutlined = make(Hash, "HashOutlined");
export const LayersOutlined = make(Layers, "LayersOutlined");

// ── 主题 / 骨架 ──
export const MoonOutlined = make(Moon, "MoonOutlined");
export const SunOutlined = make(Sun, "SunOutlined");
export const PanelLeftCloseOutlined = make(PanelLeftClose, "PanelLeftCloseOutlined");
export const PanelLeftOpenOutlined = make(PanelLeftOpen, "PanelLeftOpenOutlined");