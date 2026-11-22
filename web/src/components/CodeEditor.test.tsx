// CodeEditor（自托管 Monaco 封装）组件侧单测。此前 vitest 侧零 import（audit-test-debt 命中，
// testid code-editor 无人引用）。组件的全部职责就是四个 effect + 容器样式，这里逐条钉：
// ① create 仅挂载一次：选项九项逐字在场，value/language/readOnly 后续变化不得重建实例；
// ② 卸载三连释放（sub/model/editor）——页面反复挂编辑器，漏放 model 是实打实的内存泄漏；
// ③ 受控同步只在编辑器自己不持有该值时才 setValue：回声回写会让正在敲字的光标每次归位；
// ④ language→setModelLanguage、readOnly→updateOptions（create 只吃初值，复用实例切换全靠这俩）；
//    主题切换→monaco.editor.setTheme（Monaco 不读 CSS 变量，深浅主题靠主题名 vs/vs-dark）；
// ⑤ onChange 走最新引用：退化成 stale closure 会把编辑静默落进错误的父 state；
// ⑥ 宿主 div 的 height（默认 240 / 可覆盖）。
// 不证明什么：本文件把 monaco-editor 整体换成假模块——不证明 Monaco 真能渲染，不证明 worker
// 运行时接线（self.MonacoEnvironment.getWorker 根本不触发），更不证明「无 CDN」：那三个 ?worker
// import 存在的目的正是杜绝 jsdelivr 回退，但这条主张活在构建产物与网络面里，属 build/e2e
// （e2e/editor.spec.mjs）辖区，假模块边界天然验证不了它。组件不碰 antd，故无 ConfigProvider/matchMedia 样板。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// 假 Monaco：一个受控编辑器对象，create 收下的选项对象留档供逐字比对；
// getValue 读 __value（=编辑器自持的内容），setValue 写它——回声分支靠操纵 __value 驱动。
const h = vi.hoisted(() => {
  const subDispose = vi.fn();
  const model = { dispose: vi.fn() };
  const inner: { cb: null | (() => void) } = { cb: null };
  const editor: any = {
    __value: "",
    getValue: vi.fn(() => editor.__value),
    setValue: vi.fn((v: string) => { editor.__value = v; }),
    updateOptions: vi.fn(),
    getModel: vi.fn(() => model),
    onDidChangeModelContent: vi.fn((cb: () => void) => { inner.cb = cb; return { dispose: subDispose }; }),
    dispose: vi.fn(),
  };
  return {
    editor, model, inner, subDispose,
    setModelLanguage: vi.fn(),
    setTheme: vi.fn(),
    create: vi.fn(((_host: unknown, opts: { value?: string }) => {
      editor.__value = opts.value ?? "";
      return editor;
    }) as any),
  };
});

vi.mock("monaco-editor", () => ({
  editor: { create: h.create, setModelLanguage: h.setModelLanguage, setTheme: h.setTheme },
}));
// 三个 ?worker 是 vite 专用后缀、vitest 解析不了；组件只在 getWorker 里 new 它们（永不触发），
// 桩成空类只为让模块图装起来——worker 真接线归 e2e，见文件头。
vi.mock("monaco-editor/editor/editor.worker.js?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/language/json/json.worker.js?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/language/typescript/ts.worker.js?worker", () => ({ default: class {} }));

import CodeEditor from "./CodeEditor";

const createOpts = (): Record<string, unknown> => h.create.mock.calls[0][1] as Record<string, unknown>;
/** 模拟编辑器内容变了（真实路径 = 用户敲字触发 Monaco 的 onDidChangeModelContent）。 */
const fireChange = () => act(() => { h.inner.cb!(); });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.editor.__value = "";
  h.inner.cb = null;
});

describe("生命周期：create 一次、卸载三连", () => {
  it("无 props 挂载：create 恰一次且选项九项逐字在场（含 json/\"\"/readOnly:false 默认）", () => {
    render(<CodeEditor />);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(createOpts()).toMatchObject({
      value: "", language: "json", readOnly: false, theme: "vs", automaticLayout: true,
      minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", scrollBeyondLastLine: false,
    });
  });
  it("挂载后 value/language/readOnly 一起变 → 不重建第二个编辑器", () => {
    const { rerender } = render(<CodeEditor value="a" language="json" readOnly={false} />);
    rerender(<CodeEditor value="b" language="python" readOnly />);
    rerender(<CodeEditor value="c" language="sql" readOnly={false} />);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("卸载：订阅、model、editor 三个 dispose 全调用（漏 model = 反复挂载的内存泄漏）", () => {
    const { unmount } = render(<CodeEditor />);
    unmount();
    expect(h.subDispose).toHaveBeenCalledTimes(1);
    expect(h.model.dispose).toHaveBeenCalledTimes(1);
    expect(h.editor.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("受控 value 同步：回声不写回", () => {
  it("编辑器自持该值（用户敲字后父 state 回声）→ 不得 setValue，否则光标归位", () => {
    const { rerender } = render(<CodeEditor value="A" />);
    h.editor.__value = "B"; // 用户在编辑器里敲出了 B
    h.editor.setValue.mockClear();
    rerender(<CodeEditor value="B" />); // 父 onChange 回填后回声同一个 B
    expect(h.editor.setValue).not.toHaveBeenCalled();
  });
  it("外部把值改成编辑器没持有的串 → setValue 新值", () => {
    const { rerender } = render(<CodeEditor value="A" />);
    rerender(<CodeEditor value="C" />);
    expect(h.editor.setValue).toHaveBeenCalledWith("C");
  });
});

describe("language / readOnly 后续跟进", () => {
  it("language 变化 → setModelLanguage(现 model, 新语言)", () => {
    const { rerender } = render(<CodeEditor language="json" />);
    rerender(<CodeEditor language="typescript" />);
    expect(h.setModelLanguage).toHaveBeenCalledWith(h.model, "typescript");
  });
  it("readOnly 挂载后 false→true→false 切换 → updateOptions 逐次跟（create 只吃初值）", () => {
    const { rerender } = render(<CodeEditor readOnly={false} />);
    rerender(<CodeEditor readOnly />);
    rerender(<CodeEditor readOnly={false} />);
    expect(h.editor.updateOptions.mock.calls.map((c: unknown[]) => (c[0] as { readOnly: boolean }).readOnly))
      .toEqual([false, true, false]);
  });
});

describe("onChange 接最新引用", () => {
  it("重渲染换掉 onChange 后编辑器内容变化 → 调新回调、不调旧回调（stale closure 守卫）", () => {
    const oldCb = vi.fn();
    const newCb = vi.fn();
    const { rerender } = render(<CodeEditor value="A" onChange={oldCb} />);
    rerender(<CodeEditor value="A" onChange={newCb} />);
    h.editor.__value = "A // edited";
    fireChange();
    expect(newCb).toHaveBeenCalledWith("A // edited");
    expect(oldCb).not.toHaveBeenCalled();
  });
});

describe("宿主容器 height", () => {
  it("默认 240（React 落为 240px）", () => {
    render(<CodeEditor />);
    expect(screen.getByTestId("code-editor").style.height).toBe("240px");
  });
  it("显式 height 覆盖生效", () => {
    render(<CodeEditor height={400} />);
    expect(screen.getByTestId("code-editor").style.height).toBe("400px");
  });
});
