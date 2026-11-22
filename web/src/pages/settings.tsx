// 系统设置（§11.4.27 子集）：成员 / 用户 / 审计。
// Tab 本身也按权限渲染：非系统管理员看不到「用户」「审计」——不是藏起来当惊喜，
// 而是那两个口对他们是永久 403，留个 Tab 只会让人反复撞墙。门禁永远在后端。
import { useCallback, useState } from "react";
import { Tabs, Typography } from "antd";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { roleLabel } from "../shared/roleName";
import MembersTab from "../settings/MembersTab";
import UsersTab from "../settings/UsersTab";
import AuditTab from "../settings/AuditTab";
import ModelTab from "../settings/ModelTab";
import RolesTab from "../settings/RolesTab";

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
  const [reload, setReload] = useState(0);

  // 改角色后必须重新拉项目：否则本页仍按旧 my_perms 渲染按钮，点了才被后端 403。
  const bump = useCallback(() => {
    setReload((n) => n + 1);
    void refreshProject();
  }, [refreshProject]);

  const items = [
    { key: "members", label: "项目成员", children: (
      <MembersTab key={"m" + reload} projectId={pid} canManage={canManageMembers}
        selfId={user?.id ?? ""} onChanged={bump} />
    ) },
    ...(canReadUsers ? [{ key: "users", label: "平台用户", children: (
      <UsersTab canCreate={canCreateUsers} canUpdate={canUpdateUsers}
        canDisable={canDisableUsers} selfId={user?.id ?? ""} />
    ) }] : []),
    ...(canReadAudit ? [{ key: "audit", label: "审计日志", children: <AuditTab projectId={pid} /> }] : []),
    // 1E T8 §11.4.23 模型卡片墙：model:cfg:* 平台位仅系统管理员（R19 治理线）——
    // 与用户/审计同口径按 isSysAdmin 渲染 Tab，非管理员点了也是恒 403。
    ...(isSysAdmin && can(perms, "model:cfg:read") ? [{ key: "model", label: "模型配置", children: (
      <ModelTab canManage={can(perms, "model:cfg:update")} />
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
        defaultActiveKey="members" items={items} data-testid="settings-tabs" destroyInactiveTabPane />
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
