// 页头：改用 antd 官方 **PageHeader**（@ant-design/pro-components），不再自建标题/动作布局。
//
// 保留的两件事是契约不是样式：
//   ① `.tp-page-head` 容器类（ProjectGate.test 断言它在）与吸顶定位；
//   ② `.tp-page-title` 包住标题节点（e2e nav.spec 13 处按这个类取标题文本）。
// 标题/副标题/右侧动作/面包屑的排版交给 PageHeader。唯一的小偏差：官方 subTitle 是
// 标题右侧的小字，而我们的页面描述是「标题下方一句话」——用 children 槽放在标题下，
// 不硬改组件的布局参数。
import { PageHeader } from "@ant-design/pro-components";
import type { ReactNode } from "react";

export interface PageHeadProps {
  title: string;
  /** 一句话说明这一页干什么/数据口径，放在标题下方。 */
  desc?: ReactNode;
  /** 面包屑路径（不要含当前页标题）。 */
  crumbs?: string[];
  /** 右侧动作区：主按钮放最右，同屏最多一个 primary。 */
  extra?: ReactNode;
}

export default function PageHead({ title, desc, crumbs, extra }: PageHeadProps) {
  return (
    <div className="tp-page-head">
      <PageHeader
        ghost
        style={{ padding: "4px 0 0" }}
        title={<span className="tp-page-title">{title}</span>}
        extra={extra}
        breadcrumb={crumbs && crumbs.length > 0
          ? { items: crumbs.map((c) => ({ title: c })) }
          : undefined}
      >
        {desc && <div className="tp-page-desc">{desc}</div>}
      </PageHeader>
    </div>
  );
}