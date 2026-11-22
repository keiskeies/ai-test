// §11.4.12 展开区的参数表单（1C T16）：按命令 type 动态切字段。
// 字段口径 = 后端 execution/ui_core.py 真消费的字段（§7.2 协议里没有的字段一律不进表单
// ——表单能写出的东西必须被执行核读到）。共用件：ElementPicker（§11.4.13）与
// PairTable（api/RequestEditor 复用，不重写键值表）。
// 定位器互斥在这里做实：Segmented 二选一，切一侧清另一侧，**给不出两个都给**；
// 后端 both_locators 只是老数据防线。BLOCKED_1C 的 5 种在下拉里 disabled + 写明原因
// （R101 口径「要到 1C+ 批次才开放」），选不中也就保存不了。
// PairTable 复用：计划点名「需要键值行的地方（如 js 的参数）复用 PairTable」，但 T7-T10
// 落地的执行核里 **没有任何命令消费键值参数**（js 只 evaluate(input) 整段表达式），
// 放一个写了也不生效的键值表就是假控件（§13 纪律 1）——本表单不放，差异记录上报。
import { Input, InputNumber, Segmented, Select, Space, Switch, Tooltip, Typography } from "antd";
import ElementPicker from "./ElementPicker";
import {
  BLOCKED_1C, COMMAND_TYPES, ELEMENT_TYPES, INPUT_REQUIRED, LABELS, LOCATOR_REQUIRED,
  type UiCommand,
} from "./commands";

const TYPE_OPTIONS = COMMAND_TYPES.map((t) => ({
  value: t,
  disabled: Boolean(BLOCKED_1C[t]),
  // 24 种的下拉靠搜索定位比滚动找快；label 可能是 JSX（disabled 项带 Tooltip），
  // 所以过滤走 searchText，不赌 optionFilterProp 量 JSX 的能力
  searchText: LABELS[t] + " " + t,
  label: BLOCKED_1C[t]
    // disabled 的选项必须说清为什么（计划：不给「选得到、存不了」的选项；这里是
    // 「看得见但选不了」分支，文案与 validateCommands 的 command_not_available 同口径）
    ? <Tooltip title={t + " 命令要到 " + BLOCKED_1C[t] + " 批次才开放（R101：文件选择/下载监听/"
        + "frame 与窗口句柄/原生弹窗各需独立机制，半做等于做假）"}>
        <span>{LABELS[t]}（要到 {BLOCKED_1C[t]} 批次才开放）</span>
      </Tooltip>
    : LABELS[t],
}));

const LOC_TYPE_OPTIONS = ELEMENT_TYPES.map((t) => ({ value: t, label: t }));

/** 本表单能产出的命令形态（T17 的编辑器持有真命令；受控组件，改即回传）。 */
export default function CommandParams({ cmd, onChange, onElementNames, readOnly, testIdPrefix = "cmdp" }: {
  cmd: UiCommand;
  onChange: (next: UiCommand) => void;
  /** 选中/就地新建元素时把 {id: name} 交给宿主合并进行摘要表（§11.4.12 显示名）。 */
  onElementNames?: (name: string, id: string) => void;
  readOnly?: boolean;
  testIdPrefix?: string;
}) {
  const t = cmd.type;
  const hasLocatorType = (LOCATOR_REQUIRED as readonly string[]).includes(t);
  // 未给定位器时默认落在「元素库」一侧（空选择器比空表达式行更符合使用顺序）；
  // 给了 inline_locator（老数据）则如实显示就地定位态。
  const mode = cmd.inline_locator != null ? "inline" : "lib";

  const patch = (p: Partial<UiCommand>) => onChange({ ...cmd, ...p });

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space wrap size={8} align="center">
        <span data-testid={testIdPrefix + "-id"} style={{ fontWeight: 600 }}>{cmd.id || "（未分配 id）"}</span>
        <Select data-testid={testIdPrefix + "-type"} style={{ width: 220 }} value={t} disabled={readOnly}
          showSearch optionFilterProp="searchText"
          options={TYPE_OPTIONS}
          onChange={(nt: string) => {
            // 切类型 = 换一套字段：清掉不兼容的定位器/input 占位，绝不带着旧值装新命令
            const needsInput = (INPUT_REQUIRED as readonly string[]).includes(nt);
            onChange({
              ...cmd, type: nt,
              element_id: (LOCATOR_REQUIRED as readonly string[]).includes(nt) ? cmd.element_id : null,
              inline_locator: (LOCATOR_REQUIRED as readonly string[]).includes(nt) ? cmd.inline_locator : null,
              input: needsInput ? (typeof cmd.input === "string" ? cmd.input : "")
                : (nt === "sleep" || nt === "scroll" ? cmd.input ?? null : null),
            });
          }} />
        {cmd.id && (
          <Tooltip title="从变量/其它来源改命令 id 会让历史步骤明细指向错的行（R102），这里只读">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>id 不可改</Typography.Text>
          </Tooltip>
        )}
      </Space>

      {hasLocatorType && (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Segmented data-testid={testIdPrefix + "-locator-mode"} disabled={readOnly}
            value={mode}
            options={[{ value: "lib", label: "元素库" }, { value: "inline", label: "就地定位" }]}
            onChange={(v) => {
              // 互斥做实：切一个清另一个，UI 状态里 both_locators 不可达
              if (v === "lib") patch({ element_id: cmd.element_id ?? null, inline_locator: null });
              else patch({ element_id: null, inline_locator: cmd.inline_locator ?? { type: "css", value: "" } });
            }}
          />
          {mode === "lib" ? (
            <ElementPicker value={cmd.element_id}
              onPick={(id, el) => { patch({ element_id: id, inline_locator: null }); onElementNames?.(el.name, id); }} />
          ) : (
            <Space.Compact style={{ width: "100%" }}>
              <Select data-testid={testIdPrefix + "-inline-type"} style={{ width: 120 }} disabled={readOnly}
                value={cmd.inline_locator?.type ?? "css"} options={LOC_TYPE_OPTIONS}
                onChange={(v: string) => patch({ inline_locator: { type: v, value: cmd.inline_locator?.value ?? "" },
                  element_id: null })} />
              <Input data-testid={testIdPrefix + "-inline-value"} style={{ width: "calc(100% - 120px)" }}
                disabled={readOnly} placeholder="定位表达式，如 #submit-btn 或 //button[text()='登录']"
                value={cmd.inline_locator?.value ?? ""}
                onChange={(e) => patch({ inline_locator: { type: cmd.inline_locator?.type ?? "css",
                  value: e.target.value }, element_id: null })} />
            </Space.Compact>
          )}
        </Space>
      )}

      {t === "open" && (
        <Input data-testid={testIdPrefix + "-input"} disabled={readOnly}
          placeholder="URL 或相对路径，支持 ${base_url}，如 ${base_url}/login"
          value={(cmd.input as string) ?? ""} onChange={(e) => patch({ input: e.target.value })} />
      )}
      {(t === "input" || t === "select" || t === "assert_text" || t === "assert_title" || t === "wait_text") && (
        <Input data-testid={testIdPrefix + "-input"} disabled={readOnly}
          placeholder={{ input: "填入的文本，支持 ${var}", select: "选项 value",
            assert_text: "期望出现的文本", assert_title: "期望的页面标题",
            wait_text: "等待出现的文本" }[t]}
          value={(cmd.input as string) ?? ""} onChange={(e) => patch({ input: e.target.value })} />
      )}
      {t === "key" && (
        <Input data-testid={testIdPrefix + "-input"} disabled={readOnly} placeholder="按键名，如 Enter / Tab / Escape"
          value={(cmd.input as string) ?? ""} onChange={(e) => patch({ input: e.target.value })} />
      )}
      {t === "sleep" && (
        <InputNumber data-testid={testIdPrefix + "-input"} disabled={readOnly} min={0} step={100}
          addonAfter="ms" style={{ width: 180 }}
          value={cmd.input == null || cmd.input === "" ? null : Number(cmd.input)}
          onChange={(v) => patch({ input: v == null ? null : String(v) })} />
      )}
      {t === "scroll" && (
        <Tooltip title="给了定位目标时滚到元素；这里填的是无目标时的滚动像素（默认 300）">
          <InputNumber data-testid={testIdPrefix + "-input"} disabled={readOnly} step={100}
            placeholder="300" style={{ width: 180 }}
            value={cmd.input == null || cmd.input === "" ? null : Number(cmd.input)}
            onChange={(v) => patch({ input: v == null ? null : String(v) })} />
        </Tooltip>
      )}
      {t === "get_attr" && (
        <Input data-testid={testIdPrefix + "-input"} disabled={readOnly}
          placeholder="属性名，如 href / data-price（get_attr 读它）"
          value={(cmd.input as string) ?? ""} onChange={(e) => patch({ input: e.target.value })} />
      )}
      {t === "js" && (
        <div>
          <Input.TextArea data-testid={testIdPrefix + "-input"} disabled={readOnly} rows={3}
            placeholder="浏览器里执行的 JS 表达式，结果可存进变量"
            value={(cmd.input as string) ?? ""} onChange={(e) => patch({ input: e.target.value })} />
          {/* 执行核只吃一段表达式（page.evaluate(input)），没有键值参数注入位——
              所以这里**不放** PairTable：放了就是一个写了也不生效的假控件（§13 纪律 1）。
              需要变量就存进 save_var，下一步用 ${var} 引。 */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            执行核按整段表达式运行；要传值请先存变量再用 ${'{'}var{'}'} 引用。
          </Typography.Text>
        </div>
      )}
      {t === "screenshot" && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          截图命令无参数：制品会出现在运行详情的制品区（失败命令另有自动截图）。
        </Typography.Text>
      )}

      <Space wrap size={12} align="center">
        <Tooltip title="本命令超时（毫秒），留空用执行默认">
          <InputNumber data-testid={testIdPrefix + "-timeout"} disabled={readOnly} min={1} step={500}
            placeholder="默认" addonAfter="ms" style={{ width: 170 }}
            value={cmd.timeout_ms ?? null}
            onChange={(v) => patch({ timeout_ms: v == null ? null : Math.trunc(v) })} />
        </Tooltip>
        {(["get_text", "get_attr", "js"] as const).includes(t as "get_text" | "get_attr" | "js") && (
          <Tooltip title="把结果存进变量，后续命令用 ${var} 引用">
            <Input data-testid={testIdPrefix + "-save-var"} disabled={readOnly} style={{ width: 200 }}
              placeholder="结果存变量（变量名）" addonBefore="$"
              value={cmd.save_var ?? ""} onChange={(e) => patch({ save_var: e.target.value || null })} />
          </Tooltip>
        )}
        <Tooltip title="失败不中断后续命令（默认失败即停）">
          <Space size={6}>
            <Switch data-testid={testIdPrefix + "-optional"} disabled={readOnly} size="small"
              checked={Boolean(cmd.optional)} onChange={(v) => patch({ optional: v })} />
            <span>失败继续</span>
          </Space>
        </Tooltip>
      </Space>
    </Space>
  );
}
