// 系统设置（§11.4.27 子集）：成员 / 用户 / 组织 / 审计。
// Tab 本身也按权限渲染：非系统管理员看不到「用户」「审计」——不是藏起来当惊喜，
// 而是那两个口对他们是永久 403，留个 Tab 只会让人反复撞墙。门禁永远在后端。
import { useCallback, useState } from "react";
import { Tabs, Typography } from "antd";
import { useLocation } from "react-router-dom";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { roleLabel } from "../shared/roleName";
import MembersTab from "../settings/MembersTab";
import UsersTab from "../settings/UsersTab";
import AuditTab from "../settings/AuditTab";
import ModelTab from "../settings/ModelTab";
import McpTab from "../settings/McpTab";
import SkillTab from "../settings/SkillTab";
import RolesTab from "../settings/RolesTab";
import ProjectMetaTab from "../settings/ProjectMetaTab";
import DefectFlowTab from "../settings/DefectFlowTab";
import ProjectSettingsTab from "../settings/ProjectSettingsTab";
import PlatformOpsTab from "../settings/PlatformOpsTab";

function SettingsWorkbench() {
  const { project, user, refreshProject } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const isSysAdmin = Boolean(user?.is_system_admin);
  const canManageMembers = can(perms, "project:member:manage");
  const canReadUsers = isSysAdmin && can(perms, "system:user:read");
  const canCreateUsers = isSysAdmin && can(perms, "system:user:create");
  const canUpdateUsers = isSysAdmin && can(perms, "system:user:update");
  const canDisableUsers = isSysAdmin && can(perms, "system:user:disable");
  const canReadAudit = isSysAdmin && can(perms, "system:audit:read");
  // D270：组织从本页移出，独立成 /orgs 页（组织管理员非系统管理员也要能进）。
  const canReadMeta = can(perms, "project:template:read");
  const canReadProjectSettings = can(perms, "project:application:read");
  const canUpdateProjectSettings = can(perms, "project:application:update")
    && can(perms, "project:fake_error:create");
  const canCreateMeta = can(perms, "project:template:create");
  const canUpdateMeta = can(perms, "project:template:update");
  const canDeleteMeta = can(perms, "project:template:delete");
  // D203：三块登记面的读位任一命中即可见（四枚内置角色的 `*:read` 都盖得住）。
  const canReadPlatformOps = can(perms, "integration:integration:read")
    || can(perms, "resource:pool:read") || can(perms, "plugin:plugin:read");
  const [reload, setReload] = useState(0);
  // 侧栏「MCP 服务」直接落到本页的 MCP Tab（/settings/mcp）；没有治理位时回落到第一块。
  const location = useLocation();
  const wantedKey = location.pathname.endsWith("/mcp") ? "mcp"
    : location.pathname.endsWith("/skills") ? "skills" : "members";

  // 改角色后必须重新拉项目：否则本页仍按旧 my_perms 渲染按钮，点了才被后端 403。
  const bump = useCallback(() => {
    setReload((n) => n + 1);
    void refreshProject();
  }, [refreshProject]);

  const items = [
    { key: "members", label: "项目成员", children: (
      <MembersTab key={"m" + reload} projectId={pid} canManage={canManageMembers}
        canSaveView={can(perms, "search:view:create")}
        canDeleteView={can(perms, "search:view:delete")}
        selfId={user?.id ?? ""} onChanged={bump} />
    ) },
    ...(canReadUsers ? [{ key: "users", label: "平台用户", children: (
      <UsersTab projectId={pid} canCreate={canCreateUsers} canUpdate={canUpdateUsers}
        canDisable={canDisableUsers} selfId={user?.id ?? ""} />
    ) }] : []),
    ...(canReadProjectSettings ? [{ key: "project-settings", label: "项目设置", children: (
      <ProjectSettingsTab key={"ps" + reload} projectId={pid}
        canUpdate={canUpdateProjectSettings}
        canSaveView={can(perms, "search:view:create")}
        canDeleteView={can(perms, "search:view:delete")} />
    ) }] : []),
    ...(canReadPlatformOps ? [{ key: "platform-ops", label: "平台运维", children: (
      <PlatformOpsTab key={"po" + reload} projectId={pid} perms={perms} />
    ) }] : []),
    ...(canReadMeta ? [{ key: "meta", label: "模板与字段", children: (
      <ProjectMetaTab key={"pm" + reload} projectId={pid}
        canCreate={canCreateMeta} canUpdate={canUpdateMeta} canDelete={canDeleteMeta}
        canSaveView={can(perms, "search:view:create")}
        canDeleteView={can(perms, "search:view:delete")} />
    ) }] : []),
    // D267：缺陷状态流转是项目级配置（写位 defect:flow:manage；内置角色里只有项目管理员
    // 的 `*` 盖得住，MEMBER 的 `*:manage` 被排除——与 MS 的「状态流转设置」同一条线）。
    ...(can(perms, "defect:flow:manage") ? [{ key: "defect-flow", label: "缺陷状态", children: (
      <DefectFlowTab key={"df" + reload} projectId={pid} />
    ) }] : []),
    ...(canReadAudit ? [{ key: "audit", label: "审计日志", children: (
      <AuditTab projectId={pid} canSaveView={can(perms, "search:view:create")}
        canDeleteView={can(perms, "search:view:delete")} />
    ) }] : []),
    // 1E T8 §11.4.23 模型卡片墙：model:cfg:* 平台位仅系统管理员（R19 治理线）——
    // 与用户/审计同口径按 isSysAdmin 渲染 Tab，非管理员点了也是恒 403。
    // D248：登记走 model:cfg:create；删除后端先门后查、仅系统管理员（403 不泄露存在性）。
    ...(isSysAdmin && can(perms, "model:cfg:read") ? [{ key: "model", label: "模型配置", children: (
      <ModelTab canManage={can(perms, "model:cfg:update")}
        canCreate={can(perms, "model:cfg:create")}
        canDelete={isSysAdmin && can(perms, "model:cfg:delete")} />
    ) }] : []),
    // D265 二期 MCP：治理位 mcp:server:* 仅系统管理员；启停/测试/保存都会拉起或断开连接。
    ...(isSysAdmin && can(perms, "mcp:server:read") ? [{ key: "mcp", label: "MCP 服务", children: (
      <McpTab canManage={can(perms, "mcp:server:manage")} />
    ) }] : []),
    // D266 二期 Skills：治理位 skill:manage 仅系统管理员；文件是真相源，同步才落库。
    ...(isSysAdmin && can(perms, "skill:manage") ? [{ key: "skills", label: "Skills", children: (
      <SkillTab canManage={can(perms, "skill:manage")} />
    ) }] : []),
    // D37 §11.4.21 角色：树/列表是 :read（四枚内置角色的 glob 都盖得住，成员都可见）；
    // 建/改/删钮按 iam:role:{create,update,delete} 逐个显隐——门禁在后端。
    { key: "roles", label: "角色", children: (
      <RolesTab key={"r" + reload} projectId={pid}
        canCreate={can(perms, "iam:role:create")} canUpdate={can(perms, "iam:role:update")}
        canDelete={can(perms, "iam:role:delete")} />
    ) },
  ];

  return (
    // 必须同时挂 .tp-fill：.tp-fill-stack > * 只把 flex 给 .tp-fill（styles.css:341-342），
    // 只写 .tp-fill-body 会被同特异性的后代选择器覆盖回 flex:0 0 auto，整块卡在内容高。
    <div data-testid="settings-body" className="tp-fill tp-fill-body">
      {/* 抬头：role 是后端生码，这里翻译成中文名（唯一词表在 shared/roleName.ts，
          工作台与设置页同一份——此前只有工作台翻译，本页把 PROJECT_ADMIN 摊给业主读）。 */}
      <Typography.Paragraph type="secondary" className="tp-text-sm"
        style={{ marginBottom: "var(--tp-gap-xs)" }}>
        当前项目「{project!.name}」·我的角色 {roleLabel(project!.my_role)}
        {isSysAdmin ? "（平台管理员）" : ""}
      </Typography.Paragraph>
      {/* 视觉层次：line 型 Tabs（下划线指示，不做卡片页签的「一格格」观感）+ 整块
          内容区落进一张 tp-card——否则 tab 栏与内容悬在同一片底色上，分不出「壳」与「页」。
          className 直接挂在 Tabs 根上（而不是再包一层 div）：Tabs 根自带 testid 与
          ant-tabs 类，settings.test.tsx 钉着「body.children[1] 就是 tab 根」的层序。 */}
      {/* items 与权限过滤一个字都没动（门禁口径见上面各 Tab 的注释）。 */}
      <Tabs type="line" className="tp-card" style={{ padding: "var(--tp-gap-xs) var(--tp-gap-md) var(--tp-gap-md)" }}
        defaultActiveKey={items.some((i) => i.key === wantedKey) ? wantedKey : items[0]?.key}
        items={items} data-testid="settings-tabs" destroyInactiveTabPane />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div data-testid="page-settings" className="tp-fill-stack">
      <PageHead title="系统设置" descHover
        desc="项目成员与角色、平台用户、审计、模型与通知——可见范围由你的权限决定。" />
      <ProjectGate>
        <SettingsWorkbench />
      </ProjectGate>
    </div>
  );
}
