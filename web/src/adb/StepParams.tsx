// §7.3 ADB 步骤的展开参数表单（1D T9，§11.4.12「参数表单随类型切换」+ §11.5.5）。
// 形态与 UI 侧的 CommandParams 对称，但字段**不是手写分支**：整套控件由
// adb/commands.ts 的声明式参数表 CFG_SCHEMA 生成——表加一个键，表单、本地校验、
// 行摘要同一次提交里全部跟上（手写 if 分支迟早和校验表打架，ui 侧 1C 就有过教训）。
// 控件映射：text→单行（shell 的 cmd→Monaco，蓝图原话）| ms|ms0|coord|int→数字 |
// bool→开关 | var→变量名 | pkg|addr|url→单行带格式占位 | enum:a|b→下拉。
// testId 约定与 UI 侧一致：{prefix}-{key}（e2e 钉点），类型下拉 {prefix}-type。
import { lazy, Suspense } from "react";
import { Input, InputNumber, Select, Space, Switch, Tooltip, Typography } from "antd";
// Monaco 只服务 shell 一条命令的 cmd 字段；静态 import 会把 4.5MB 拉进本页 chunk，
// 所以懒载（app.tsx 对 monaco 的「不随首屏出货」规矩在页级之上的再一层）。
const CodeEditor = lazy(() => import("../components/CodeEditor"));
import {
  CFG_SCHEMA, LABELS, OPTIONAL_ALLOWED, STEP_TYPES, emptyConfig, summary, validateSteps,
  type AdbStep,
} from "./commands";

const TYPE_OPTIONS = STEP_TYPES.map((t) => ({
  value: t, searchText: LABELS[t] + " " + t, label: LABELS[t],
}));

const KIND_PLACEHOLDER: Record<string, string> = {
  pkg: "包名，如 com.example.app",
  addr: "WiFi 地址 ip:port，如 192.168.1.20:5555（§6.4）",
  url: "https://…（am start VIEW 打开）",
  var: "变量名（字母/数字/下划线，不以数字开头）",
  text: "",
};

/** 单键控件：值一律以字符串/数字原样进 config（空输入 = 删键，让 required 校验看得见「没填」）。 */
function KeyField({ kspec, kind, value, testId, disabled, onPatch, onRemove }: {
  kspec: string; kind: string; value: unknown; testId: string; disabled: boolean;
  onPatch: (v: unknown) => void; onRemove: () => void;
}) {
  const label = kspec.replace(/^!/, "");
  const req = kspec.startsWith("!");
  const row = (control: React.ReactNode) => (
    <Space size={8} align="center" wrap style={{ width: "100%" }}>
      <span className="tp-text-sm" style={{ width: 108, display: "inline-block", color: "#5B6670" }}>
        {label}{req && <span style={{ color: "#C4565C" }}> *</span>}
      </span>
      {control}
    </Space>
  );
  if (kind === "bool")
    return row(<Switch data-testid={testId} disabled={disabled} size="small"
      checked={value === true} onChange={(v) => onPatch(v)} />);
  if (kind.startsWith("enum:"))
    return row(<Select data-testid={testId} style={{ width: 220 }} disabled={disabled}
      placeholder="选择…" allowClear
      value={typeof value === "string" && value !== "" ? value : undefined}
      options={kind.slice(5).split("|").map((v) => ({ value: v, label: v }))}
      onChange={(v?: string) => (v == null ? onRemove() : onPatch(v))} />);
  if (kind === "ms" || kind === "ms0")
    return row(<InputNumber data-testid={testId} disabled={disabled} min={kind === "ms" ? 1 : 0}
      step={500} addonAfter="ms" style={{ width: 180 }}
      value={typeof value === "number" ? value : null}
      onChange={(v) => (v == null ? onRemove() : onPatch(Math.trunc(v)))} />);
  if (kind === "coord" || kind === "int")
    return row(<InputNumber data-testid={testId} disabled={disabled}
      min={kind === "coord" ? 0 : 1} step={kind === "coord" ? 1 : 10} style={{ width: 140 }}
      value={typeof value === "number" ? value : null}
      onChange={(v) => (v == null ? onRemove() : onPatch(Math.trunc(v)))} />);
  // text（非 shell）/var/pkg/addr/url：单行输入
  return row(<Input data-testid={testId} disabled={disabled}
    style={{ width: 380 }} placeholder={KIND_PLACEHOLDER[kind] ?? ""}
    value={typeof value === "string" ? value : ""}
    onChange={(e) => (e.target.value === "" ? onRemove() : onPatch(e.target.value))} />);
}

/** 步骤参数面板（StepDescriptor.renderParams 的 ADB 侧实现）。 */
export default function StepParams({ step, testIdPrefix, onChange, readOnly = false }: {
  step: AdbStep;
  testIdPrefix: string;
  onChange: (next: AdbStep) => void;
  readOnly?: boolean;
}) {
  const t = step.type;
  const schema = CFG_SCHEMA[t] ?? {};
  const cfg = step.config ?? {};

  const patchCfg = (key: string, v: unknown) => onChange({ ...step, config: { ...cfg, [key]: v } });
  const removeCfg = (key: string) => {
    const next = { ...cfg };
    delete next[key];
    onChange({ ...step, config: next });
  };

  // 切类型 = 换一套参数：config 整个重置成新类型的空壳（带着旧 config 装新命令就是
  // 拿脏值装合法）。空壳形状与 newStep 同源（emptyConfig），测试钉的也是同一份。
  const changeType = (nt: string) => onChange({ ...step, type: nt, config: emptyConfig(nt) });

  // 本地即时问题（同一张表的校验，表单里当场标出来，不用等保存撞 422）
  const issues = validateSteps([{ ...step, id: step.id || "a1" }]).filter((i) => i.index === 0);
  const issueFor = (key: string): string | null => {
    const hit = issues.find((i) => i.message.includes(key + " "));
    return hit ? hit.message : null;
  };
  const optionalBlocked = !OPTIONAL_ALLOWED.includes(t as typeof OPTIONAL_ALLOWED[number]);

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space wrap size={8} align="center">
        <span data-testid={testIdPrefix + "-id"} style={{ fontWeight: 600 }}>
          {step.id || "（未分配 id）"}
        </span>
        <Select data-testid={testIdPrefix + "-type"} style={{ width: 220 }} value={t}
          disabled={readOnly} showSearch optionFilterProp="searchText" options={TYPE_OPTIONS}
          onChange={changeType} />
        {/* 字段在 schema 里，但逐步骤换设备一期没开：执行核一次只吃一个 serial（设备锁按案
            占用），debug_services.resolve 见到非 auto 就回 executable=False 并点名步骤 id。
            文案不能写「填设备 id 覆盖」——那是承诺一个当场 422 的动作。 */}
        <Tooltip title="这一步打到哪台设备：只认 auto（=按用例的设备策略解析）。逐步骤换设备一期未开放，填了具体设备会在执行时被拒（debug_services 的「逐步骤换设备一期未开放」）">
          <Input data-testid={testIdPrefix + "-device"} style={{ width: 240 }}
            disabled={readOnly} placeholder="设备：只能填 auto"
            value={step.device ?? "auto"}
            onChange={(e) => onChange({ ...step, device: e.target.value.trim() || "auto" })} />
        </Tooltip>
        <Tooltip title="执行本步前先等待（毫秒），等界面稳一稳（§7.3）">
          <InputNumber data-testid={testIdPrefix + "-pre-wait"} disabled={readOnly} min={0}
            step={500} addonAfter="ms 前等" style={{ width: 170 }}
            value={step.pre_wait_ms ?? 0}
            onChange={(v) => onChange({ ...step, pre_wait_ms: v == null ? 0 : Math.trunc(v) })} />
        </Tooltip>
      </Space>

      {t === "shell" ? (
        // 蓝图 §11.4.12 原话：shell→命令 Monaco
        <div>
          <Typography.Text className="tp-text-sm" type="secondary">shell 命令
            （adb shell 之后那段；设备路径写 /sdcard/…，不要写宿主路径）</Typography.Text>
          <div data-testid={testIdPrefix + "-cmd"} style={{ marginTop: 4 }}>
            <Suspense fallback={<Typography.Text type="secondary">编辑器加载中…</Typography.Text>}>
              <CodeEditor language="shell" height={152} value={String(cfg.cmd ?? "")}
                onChange={(v) => patchCfg("cmd", v)} readOnly={readOnly} />
            </Suspense>
          </div>
        </div>
      ) : (
        Object.entries(schema).map(([kspec, kind]) => {
          const key = kspec.replace(/^!/, "");
          const problem = issueFor(key);
          return (
            <div key={key}>
              <KeyField kspec={kspec} kind={kind} value={cfg[key]} disabled={readOnly}
                testId={testIdPrefix + "-" + key}
                onPatch={(v) => patchCfg(key, v)} onRemove={() => removeCfg(key)} />
              {problem && (
                <Typography.Text className="tp-text-sm" type="danger" data-testid={testIdPrefix + "-" + key + "-issue"}
                  style={{ marginLeft: 116 }}>{problem}</Typography.Text>
              )}
            </div>
          );
        })
      )}
      {Object.keys(schema).length === 0 && (
        <Typography.Text className="tp-text-sm" type="secondary">
          {LABELS[t] ?? t} 没有参数。
        </Typography.Text>
      )}

      <Space wrap size={12} align="center">
        <Tooltip title={optionalBlocked
          ? "失败不阻断只对断言/提取类步骤开放"
          : "失败记 fail 但整案继续（§7.3 optional）"}>
          <Space size={6}>
            <Switch data-testid={testIdPrefix + "-optional"} disabled={readOnly || optionalBlocked}
              size="small" checked={Boolean(step.optional)}
              onChange={(v) => onChange({ ...step, optional: v })} />
            <span className="tp-text-sm">失败继续</span>
          </Space>
        </Tooltip>
        {optionalBlocked && (
          // 锁死的原因不藏进 hover：CommandParams 对 BLOCKED 类型的先例是「原因就写在
          // 控件旁边」——禁用了却说不出为什么，和用户自己乱猜禁用了什么是一个量级的坑。
          <Typography.Text className="tp-text-sm" type="secondary" data-testid={testIdPrefix + "-optional-why"}>
            操作类步骤不允许失败继续：点了没点上，后面全是对着空气操作
          </Typography.Text>
        )}
        <Typography.Text className="tp-text-sm" type="secondary" data-testid={testIdPrefix + "-summary"}>
          {summary(step)}
        </Typography.Text>
      </Space>
    </Space>
  );
}
