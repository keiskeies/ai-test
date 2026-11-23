// 组织页（D270）：组织管理员/组织成员的独立入口。此前「组织」只挂在系统设置 Tab 上，
// 且按 isSysAdmin 门禁——组织管理员（非系统管理员）根本进不去，接口虽已按组织角色放行，
// 界面却是死路。组织是平台级分组层，不依赖当前项目，故本页不套 ProjectGate。
//
// 可见性：入口对已登录用户始终在（谁都有可能是某个组织的成员）；后端 org_list 对非管理员
// 只回「我所在的组织」，非成员看到的是诚实空态，不是 403 错误脸。
import { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import OrgTab from "../settings/OrgTab";

export default function OrgsPage() {
  const { user } = useAuth();
  return (
    <div data-testid="page-orgs" className="tp-fill-stack">
      <PageHead title="组织" descHover
        desc="组织是平台级的分组与管理层：管成员与项目归属；项目数据的可见性仍由项目成员决定。" />
      <div className="tp-fill tp-fill-body">
        <OrgTab isSysAdmin={Boolean(user?.is_system_admin)} />
      </div>
    </div>
  );
}
