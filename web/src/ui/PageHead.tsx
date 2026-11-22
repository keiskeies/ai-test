// 页头：改用 antd 官方 **PageHeader**（@ant-design/pro-components），不再自建标题/动作布局。
//
// 保留的两件事是契约不是样式：
//   ① `.tp-page-head` 容器类（ProjectGate.test 断言它在）与吸顶定位；
//   ② `.tp-page-title` 包住标题节点（e2e nav.spec 13 处按这个类取标题文本）。
// 排版交给 PageHeader。两处刻意的偏差：官方 subTitle 是标题右侧的小字，而我们的页面
// 描述是「标题下方一句话」——用 children 槽放在标题下；满高页则用 descHover 把这行收进
// 标题旁的悬停（文案一字不减），因为页头每多一行，正文就少一行。
import { PageHeader } from "@ant-design/pro-components";
import { Tooltip } from "antd";
import { InfoCircleOutlined } from "./icons";
import type { ReactNode } from "react";

export interface PageHeadProps {
  title: string;
  /** 一句话说明这一页干什么/数据口径，放在标题下方。 */
  desc?: ReactNode;
  /** 满高页专用：说明不占标题下方那一行，收进标题旁的悬停。
   *  915 高的视口里页头是吸顶 chrome，每多一行正文就少一行（接口管理实测 86 → 40）。 */
  descHover?: boolean;
  /** 面包屑路径（不要含当前页标题）。 */
  crumbs?: string[];
  /** 右侧动作区：主按钮放最右，同屏最多一个 primary。 */
  extra?: ReactNode;
}

export default function PageHead({ title, desc, descHover, crumbs, extra }: PageHeadProps) {
  const heading = <span className="tp-page-title">{title}</span>;
  return (
    <div className={"tp-page-head" + (descHover ? " tp-page-head--compact" : "")}>
      <PageHeader
        ghost
        style={{ padding: "4px 0 0" }}
        title={descHover && desc ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {heading}
            {/* 说明收进悬停但一个字不减：悬停里放的就是原来那整句，不是删掉。 */}
            <Tooltip title={desc}>
              <InfoCircleOutlined data-testid="page-head-desc"
                style={{ fontSize: 14, color: "var(--tp-text-3)", cursor: "help" }} />
            </Tooltip>
          </span>
        ) : heading}
        extra={extra}
        breadcrumb={crumbs && crumbs.length > 0
          ? { items: crumbs.map((c) => ({ title: c })) }
          : undefined}
      >
        {descHover || !desc ? null : <div className="tp-page-desc">{desc}</div>}
      </PageHeader>
    </div>
  );
}