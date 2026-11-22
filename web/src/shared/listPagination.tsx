// D47-b · 列表页码分页器（「两制并存」里页码分页那一半的共享件）。
//
// 只做 MeterSphere 式页码列表需要的那点事：「共 N 条」+ 页码跳转 + 档位选择，全受控。
// 下面每一段注释都对应一具被防住的具体谎：
// ① 没有总数（游标式接口）就整块不渲染——防「共 0 条」假象（§13 纪律 1 假门禁令）；
// ② 档位只有 20/50/100——后端 schema 的 size 上限是 200（schemas.py `Field(ge=1, le=200)`），
//    档位表里出现 500 就是假选项：选了它请求被后端钳成 200，页数跟着变，没人说得清生效没生效；
// ③ 换档位必须回第 1 页——防「放大档位后落在无关切片」被读成数据丢了；
// ④ 全受控、零 localStorage——D47-a 列设置的教训（ListToolbar.tsx）：一个设置的状态活在
//    两处早晚分叉；持久化是页面的事（URL / 偏好），组件碰了就是第二份真相。
import { Pagination } from "antd";

/** 档位表（**我们自己的选择，不是 MS 的档位集**——取证过：MS 前端默认 10、候选 [10,20,30,40,50]，
 *  服务端 `pageSize` 收 `@Min(5) @Max(500)`）。这里取 20/50/100 的理由只有一条硬的：
 *  **加档位要先抬后端上限**——各列表接口 size 一律 `Field(ge=1, le=200)`（schemas.py），
 *  上限 200 之内才放得下 20/50/100，顺序不能反（放个 500 进去就是假选项：选了被后端钳成 200，
 *  页数跟着变，没人说得清到底生效没生效）。要不要改成 MS 的 10/20/30/40/50，是产品口径，
 *  已在 D47-b 计划里挂给业主裁，不在这一刀里自己改。
 *  页面带进一个不在表里的当前档位（如历史上的 30）时不必在这里补：rc-pagination 会把
 *  当前 pageSize 自动并进下拉项再数值排序（Options.js 的 getPageSizeOptions），档位选择器
 *  永远显示得下真值；这一条是借用来的行为，测试里钉着，它哪天变了测试会红。 */
const PAGE_SIZE_PRESETS: number[] = [20, 50, 100];

export interface ListPagerProps {
  /** 1-based，由页面控制（URL 参数 / state），组件不自己记。 */
  current: number;
  pageSize: number;
  /** null/undefined = 这个接口是游标式的，压根不报总数。 */
  total: number | null | undefined;
  onPage: (current: number) => void;
  onPageSize: (size: number) => void;
}

export function ListPager(props: ListPagerProps) {
  const { current, pageSize, total, onPage, onPageSize } = props;

  // ① 假按钮禁令（§13 纪律 1）：没有总数就画分页器，AntD 会把缺省 total 当 0——
  //    每个游标式页面都将挂一条假「共 0 条」和一排假页码，用户读到的是「这页没数据」，
  //    而事实是「这页不按总数说话」，后者界面上没有任何地方说得出来。
  //    必须是 `== null`（null 与 undefined 都算「没有总数」），且**不能写成 !total**：
  //    total=0 是真·查无数据，该把「共 0 条」大方说出来、和 null 分支区分得开
  //    （测试文件拿 total=0 钉这一条，防整个文件假绿）。
  if (total == null) return null;

  return (
    <div data-testid="list-pager">
      <Pagination
        current={current}
        pageSize={pageSize}
        total={total}
        // 显式打开。默认值不是 true：rc-pagination 只在 total>50 时才显示档位选择器
        // （totalBoundaryShowSizeChanger=50）。档位是功能不是数据——筛出 30 条时它不该消失、
        // 变回 60 条又冒出来，功能随筛选结果忽隐忽现会被读成界面坏了。
        showSizeChanger
        pageSizeOptions={PAGE_SIZE_PRESETS}
        // 就渲染「共 N 条」五个字符外加一个数：不渲染「第 1-20 条」那种区间，那是控件自己
        // 按页做的算术（第 5 条约定），页面口径一变这份算术就漂，而它从不报错、只说谎。
        showTotal={(t) => `共 ${t} 条`}
        onChange={(page, size) => {
          // AntD 把「翻页」和「换档位」挤在同一个 onChange 里：size 和当前 pageSize 不一致
          // 的那次就是换档位（选同一个值 Select 根本不触发 onChange，不会误判）。
          if (size !== pageSize) {
            // ③ 换档位必须回第 1 页：20 条/页停在第 7 页，换成 100 条/页还停在第 7 页，
            //    落的是完全无关的切片、甚至越过末尾——总数明明真实，表格却是空的，
            //    读起来就是「改个档位把我的数据改丢了」。
            //    AntD 自己会钳一个页码换档位那次也带过来（上面那例钳成第 3 页），**不转发它**：
            //    「第几页才算数」是页面的业务，不是控件的算术。测试用 current=7 钉死这一点。
            onPageSize(size);
            onPage(1);
            return;
          }
          // ④ 只回报、不记状态：页面不改 props，屏幕就不动——受控性的可测之处全在这行。
          onPage(page);
        }}
      />
    </div>
  );
}
