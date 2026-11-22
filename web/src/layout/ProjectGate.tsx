// 项目作用域页面的统一外壳：未选项目 → 诚实引导（不演假数据）；选了就渲染子内容。
// 只读横幅也挂这里（§11.5.1）：所有项目页共用一个外壳，横幅就只写这一份。
//
// PageHead 从本文件**再导出**而非各自 import ui/PageHead：17 个页面写着
// `import ProjectGate, { PageHead } from "../layout/ProjectGate"`，把实现挪走后
// 保留这行再导出，页面文件不必为「页头换了实现」付一次改名成本。
import { Alert, Button } from "antd";
import { useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../auth/store";
import { isReadOnlyPatterns, patternsForProject } from "../auth/perms";
import PageHeadImpl from "../ui/PageHead";
import type { PageHeadProps } from "../ui/PageHead";
import StateView from "../ui/StateView";

export function PageHead(props: PageHeadProps) {
  return <PageHeadImpl {...props} />;
}

export default function ProjectGate({ children }: { children: ReactNode }) {
  const { project, user } = useAuth();
  const nav = useNavigate();
  if (!project) {
    return (
      <div data-testid="no-project" className="tp-card" style={{ marginTop: 8 }}>
        <StateView kind="empty" title="先在工作台选项目"
          desc="本页的数据都挂在项目下——没选项目时不展示任何别人的数字。"
          action={(
            <Button type="primary" data-testid="no-project-goto" onClick={() => nav("/")}>
              去工作台选项目
            </Button>
          )} />
      </div>
    );
  }
  // 判定不看单个权限位也不看 role 字符串，看生效模式里到底还有没有写得起的条目
  // （isReadOnlyPatterns 的注释里写清了为什么）；文案只陈述事实，不许诺「联系管理员」。
  const readOnly = isReadOnlyPatterns(patternsForProject(project, user?.is_system_admin));
  return (
    <>
      {readOnly && (
        <Alert
          type="info" showIcon style={{ marginBottom: 12 }}
          data-testid="readonly-banner"
          message={"当前项目角色「" + (project.my_role || "未分配") + "」在本项目没有任何编辑权限，页面为只读。"}
        />
      )}
      {children}
    </>
  );
}