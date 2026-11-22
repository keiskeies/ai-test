// T16 探针页：证明自托管 Monaco（离线、可输入、有高亮、可被 Playwright 定位）。
import { useState } from "react";
import CodeEditor from "../components/CodeEditor";

const initial = `{
  "name": "probe",
  "count": 1
}`;

export default function ProbePage() {
  const [value, setValue] = useState(initial);
  return (
    <div data-testid="page-monaco-probe" style={{ padding: 24 }}>
      <h3>Monaco 探针（T16）</h3>
      <CodeEditor language="json" value={value} onChange={setValue} height={320} />
      <pre data-testid="probe-value" style={{ whiteSpace: "pre-wrap" }}>{value}</pre>
    </div>
  );
}
