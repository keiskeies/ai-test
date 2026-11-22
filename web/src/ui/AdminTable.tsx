// 列表统一用官方 **ProTable**（@ant-design/pro-components），不再手搓表格壳。
//
// 本适配层只做三件「项目约定」的事，其余全部走 ProTable：
//   ① 默认关掉搜索表单与内置工具栏（筛选由页面的后端驱动工具栏负责；要列设置/密度时
//      在调用点显式打开 options）；
//   ② 默认无分页（页面用 ListPager，服务端页码语义已在既有测试里钉死）；
//   ③ 统一白卡外壳（.tp-tablecard）与 size="middle" 密度。
// 业务列、dataSource、rowKey、onRow、locale 原样透传——ProTable 与 antd Table 的列协议一致。
import { ProTable } from "@ant-design/pro-components";
import type { ColumnsType } from "antd/es/table";
import type { ParamsType, ProTableProps } from "@ant-design/pro-components";

/**
 * ProTable 的 render 签名是 (dom, entity, index)，antd 是 (value, record, index)。
 * 业务列全按 antd 写，这里逐列包一层：把 value 还原成 record 上 dataIndex 的值。
 * 不这么做会静默出错——实测：进度环把 dom 当数值算出 NaN，null 环境名被 ProTable
 * 的默认值处理改成 "-" 而不是我们约定的 "—"。
 */
function adaptColumns<T extends object>(cols?: Array<ColumnsType<T>[number] & { hideInSetting?: boolean }>): ProTableProps<T, ParamsType>["columns"] {
  if (!cols) return undefined;
  const val = (record: T, dataIndex: unknown): unknown => {
    const path = Array.isArray(dataIndex) ? dataIndex : [dataIndex];
    return path.reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[String(k)]), record);
  };
  return cols.map((c) => {
    const col = c as unknown as Record<string, unknown>;
    const render = col.render as ((v: unknown, r: T, i: number) => React.ReactNode) | undefined;
    return {
      ...col,
      ...(render ? { render: (_dom: React.ReactNode, record: T, i: number) => render(val(record, col.dataIndex), record, i) } : {}),
    } as unknown as NonNullable<ProTableProps<T, ParamsType>["columns"]>[number];
  });
}

/** columns 用 antd 的 ColumnsType（业务列都按它写）；ProTable 内部接受超集，入口处断言一次。 */
export type AdminTableProps<T extends object, U extends ParamsType = ParamsType> =
  Omit<ProTableProps<T, U>, "columns" | "footer"> & {
    className?: string;
    /** hideInSetting 是 ProColumns 的能力，antd 列类型里没有；适配层会原样透传给 ProTable。 */
    columns?: Array<ColumnsType<T>[number] & { hideInSetting?: boolean }>;
    /** 卡内脚注（页码 + 口径小字）：走 antd Table 的 footer，DOM 落在 .ant-table 里。 */
    cardFooter?: React.ReactNode;
  };

export default function AdminTable<T extends object, U extends ParamsType = ParamsType>(
  props: AdminTableProps<T, U>,
) {
  const { className, options, search, pagination, columns, cardFooter, ...rest } = props;
  return (
    <ProTable<T, U>
      search={search ?? false}
      options={options ?? false}
      pagination={pagination ?? false}
      columns={adaptColumns(columns) as ProTableProps<T, U>["columns"]}
      className={"tp-tablecard" + (className ? " " + className : "")}
      cardProps={false}
      bordered={false}
      {...rest}
      {...(cardFooter ? { footer: () => cardFooter } : {})}
    />
  );
}