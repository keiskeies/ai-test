// 自托管 Monaco 封装（T16 探针交付件，供 T20/T22 调试抽屉复用）。
// 内网部署硬要求：一切资源必须来自本包构建产物，禁止任何 CDN——
// 因此不用 @monaco-editor/react 的默认 loader（它会从 jsdelivr 拉 monaco），
// 而是直接 import monaco-editor 本体 + 用 vite ?worker 语法手动接 worker。
import { useEffect, useRef } from "react";
import { useTheme } from "../ui/themeMode";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

// 手动接线 worker——不配的话 Monaco 会回退到 getWorkerUrl 去 CDN 拉 worker，内网直接挂。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

export interface CodeEditorProps {
  language?: string;
  value?: string;
  onChange?: (value: string) => void;
  height?: number | string;
  /** 只读展示（T22 报告详情的请求/响应对照）：光标可选可复制，键盘不可改。 */
  readOnly?: boolean;
}

export default function CodeEditor({
  language = "json",
  value = "",
  onChange,
  height = 240,
  readOnly = false,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Monaco 同样不读 CSS 变量：深浅主题要靠它自己的主题名切换（vs / vs-dark）。
  const mode = useTheme((s) => s.mode);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language,
      theme: mode === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      readOnly,
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });
    return () => {
      sub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // 仅挂载时创建；value/language 的变化走下面的受控同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    monaco.editor.setTheme(mode === "dark" ? "vs-dark" : "vs");
  }, [mode]);

  useEffect(() => {
    const ed = editorRef.current;
    if (ed && ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  // readOnly 可在挂载后被切换（同一实例复用场景）：create 时只吃初值，变化要手动跟
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return (
    <div
      data-testid="code-editor"
      ref={hostRef}
      style={{ height, border: "1px solid var(--tp-border)", borderRadius: "var(--tp-radius-md)", overflow: "hidden" }}
    />
  );
}
