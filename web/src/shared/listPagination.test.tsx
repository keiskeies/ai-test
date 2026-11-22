// D47-b · 分页器的行为钉（「两制并存」页码那一半）。只钉会说谎的几处，不重测 AntD 自身。
//
// 变异 ↔ 变红映射（开发时逐条摘掉防线实测过，恢复后全绿）：
// ① 摘掉 `total == null → null` 的守卫        → 「没有总数就整块不渲染」两条变红
//    （挂上假「共 0 条」）；
// ② 把守卫改成 `if (!total)`                 → 「total=0 也要把 共 0 条 说出来」变红
//    （这条存在的意义：null 与 0 两种「空」必须可分，否则整个文件假绿）；
// ③ 摘掉换档位时的 onPage(1)                 → 「换档位回第 1 页」变红；
// ④ 换档位时把 AntD 钳过的页码也转发出去     → 同③：onPage 实参只能是 [1]，混进 3 就红。
//
// jsdom 惯例：@vitest-environment 逐文件写（vitest.config.ts 注释）；matchMedia 桩抄
// ListToolbar.test.tsx（AntD 响应式钩子裸 jsdom 会炸）。
// AntD 在两个汉字按钮文案里插空格——本文件不拿两字按钮文本当断言，页码一律走
// .ant-pagination-item-N 类选择器。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import { ListPager } from "./listPagination";

type Props = React.ComponentProps<typeof ListPager>;

function Harness(over: Partial<Props> = {}) {
  const onPage = vi.fn();
  const onPageSize = vi.fn();
  const ui = (
    <ListPager
      current={1} pageSize={20} total={137}
      onPage={onPage} onPageSize={onPageSize}
      {...over}
    />
  );
  return { ui, onPage, onPageSize };
}

beforeEach(() => { cleanup(); });

describe("没有总数就不画分页器（§13 纪律 1）", () => {
  it("total=null：整块不渲染，回调无从触发", () => {
    const h = Harness({ total: null });
    const { container } = render(h.ui);
    // 游标式接口挂一条「共 0 条」= 把「不报总数」演成「没有数据」，纯谎
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(h.onPage).not.toHaveBeenCalled();
    expect(h.onPageSize).not.toHaveBeenCalled();
  });

  it("total=undefined：同上（缺字段和显式 null 是同一种「没有」）", () => {
    const { container } = render(Harness({ total: undefined }).ui);
    expect(container.firstChild).toBeNull();
  });
});

describe("总数如实渲染（这条能变红，不是摆设）", () => {
  it("total=137 → 共 137 条", () => {
    render(Harness().ui);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 137 条");
  });

  it("total=0 是真·查无数据：共 0 条要大方说出来，和 null 分支分得开", () => {
    render(Harness({ total: 0 }).ui);
    const pager = screen.getByTestId("list-pager");
    // 守卫写成 `if (!total)` 的话这里拿不到节点——null 与 0 一字之差、语义天壤
    expect(pager.textContent).toContain("共 0 条");
  });
});

describe("全受控：组件不自己翻页", () => {
  it("点第 3 页 → 只回报 onPage(3)，屏幕不动；页面回填 current=3 才真过去", () => {
    const h = Harness();
    const { rerender } = render(h.ui);
    const pager = screen.getByTestId("list-pager");
    fireEvent.click(pager.querySelector(".ant-pagination-item-3 a") as Element);
    expect(h.onPage).toHaveBeenCalledTimes(1);
    expect(h.onPage).toHaveBeenCalledWith(3);
    expect(h.onPageSize).not.toHaveBeenCalled();
    // props 没变（current 仍是 1），高亮必须还在第 1 页——DOM 自己动了就是藏了内部 state
    expect(pager.querySelector(".ant-pagination-item-1.ant-pagination-item-active")).toBeTruthy();
    // 页面落账、回填 current=3 重渲染，高亮才跟过来（受控闭环的另一半）
    rerender(<ListPager current={3} pageSize={20} total={137}
      onPage={h.onPage} onPageSize={h.onPageSize} />);
    expect(screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });
});

describe("换档位：onPageSize + 回第 1 页，一次都不多报", () => {
  /** 展开档位下拉并按前缀点其中一项（档位文案由 AntD locale 拼装，只认数字前缀，不拼全文）。 */
  async function pickSize(prefix: string): Promise<void> {
    const sel = (screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-options-size-changer .ant-select-selector")) as HTMLElement;
    fireEvent.mouseDown(sel);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(
      Array.from(document.querySelectorAll(contents))
        .some((n) => (n.textContent ?? "").startsWith(prefix))).toBe(true));
    const opt = Array.from(document.querySelectorAll(contents))
      .find((n) => (n.textContent ?? "").startsWith(prefix)) as Element;
    fireEvent.click(opt);
  }

  it("停在第 7 页换 50/页 → onPageSize(50) 与 onPage(1)，且不转发 AntD 钳过的页码", async () => {
    // current=7 是故意选的：137 条/20 正好 7 页，AntD 会自己算出「50/页时你在第 3 页」并
    // 把 onChange(3, 50) 递过来。转发那个 3 等于让控件替页面决定「第几页算数」——
    // 摘掉 onPage(1)（变异③）或照单转发（变异④），本条都会红：onPage 实参只允许是 [1]。
    const h = Harness({ current: 7 });
    render(h.ui);
    await pickSize("50");
    await waitFor(() => expect(h.onPageSize).toHaveBeenCalledWith(50));
    expect(h.onPage).toHaveBeenCalledTimes(1);
    expect(h.onPage).toHaveBeenCalledWith(1);
  });

  it("档位表就是 20/50/100：后端 size 上限 200，500 这种档位是假选项", async () => {
    render(Harness().ui);
    const sel = (screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-options-size-changer .ant-select-selector")) as HTMLElement;
    fireEvent.mouseDown(sel);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(document.querySelectorAll(contents).length).toBeGreaterThan(0));
    const sizes = Array.from(document.querySelectorAll(contents))
      .map((n) => (n.textContent ?? "").match(/\d+/)?.[0]);
    expect(sizes).toEqual(["20", "50", "100"]);
  });

  it("当前档位不在预设里（如 30）时下拉仍显示得出真值——档位选择器不许显示不存在的档位", async () => {
    // 这是 rc-pagination 的自动并档行为（Options.js getPageSizeOptions），不是我们写的；
    // 钉住它：哪天升级把它弄丢了，页面带着 pageSize=30 会显示成没选中，测试先红。
    render(Harness({ pageSize: 30 }).ui);
    const sel = (screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-options-size-changer .ant-select-selector")) as HTMLElement;
    fireEvent.mouseDown(sel);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith("30"))).toBe(true));
  });
});
