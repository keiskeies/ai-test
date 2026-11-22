"""执行结果摘要 Markdown 模板（1E T3 / §6.7「执行结果摘要」）：纯函数、可单测。

三条口径（计划 T3 原文）：
- **不拼绝对 URL**：平台没有外部 base_url 配置，「打开报告」只给前端相对路径
  （/reports/<run_id>）——拼了就是假链接。
- **run_record 里没有的字段不显示**（workbench docstring 的诚实口径同尺）：
  键缺失或 None 的行整行省略，不画「未知」也不造假。
- **正文零密钥**：入参只有渲染要用的白名单字段（本模块连 config 的形状都不认识），
  模板测试钉「关键字段齐全 + 无 token/密钥字样」两条。

通过率口径与 report_services._pass_rate / workbench._rate 同一把尺：
pass / (total − skip)，分母 ≤ 0 → None（渲染成「算不出」，不画 0%）。
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

STATUS_LABEL = {"passed": "通过", "failed": "未通过", "error": "异常", "cancelled": "已取消"}
TRIGGER_LABEL = {"schedule": "定时", "manual": "手动", "debug": "调试",
                 "agent": "Pilot", "webhook": "Webhook"}


def pass_rate(stats: Mapping[str, Any] | None) -> float | None:
    """pass / (total − skip)；分母 ≤ 0 或 stats 缺 → None（同 report/workbench 的尺）。"""
    if not stats:
        return None
    denom = int(stats.get("total") or 0) - int(stats.get("skip") or 0)
    if denom <= 0:
        return None
    return float(int(stats.get("pass") or 0)) / denom


def _fmt_rate(rate: float | None) -> str:
    return "算不出（无有效步骤）" if rate is None else f"{rate * 100:.1f}%"


def _fmt_elapsed(ms: Any) -> str:
    if ms is None:
        return ""
    v = int(ms)
    return f"{v}ms" if v < 1000 else f"{v / 1000:.1f}s"


def render(summary: Mapping[str, Any]) -> str:
    """summary（终态钩子的入参形状，见 core.service.run_finalized）→ Markdown 正文。

    键控渲染：缺什么不显什么，永不抛——模板炸了就该是钩子的事，不是它的事。
    """
    status = str(summary.get("status") or "")
    label = STATUS_LABEL.get(status, status or "未知")
    trigger = TRIGGER_LABEL.get(str(summary.get("trigger") or ""), str(summary.get("trigger") or ""))
    lines = ["### TestPilot 执行结果摘要 · " + label]
    task_name = summary.get("task_name")
    if task_name:
        lines.append("- 定时任务：" + str(task_name))
    if summary.get("subject_name"):
        lines.append("- 场景：" + str(summary["subject_name"]))
    if trigger:
        lines.append("- 触发方式：" + trigger)
    lines.append("- 结果：" + label)
    lines.append("- 通过率：" + _fmt_rate(pass_rate(summary.get("stats") if isinstance(
        summary.get("stats"), Mapping) else None)))
    elapsed = _fmt_elapsed(summary.get("elapsed_ms"))
    if elapsed:
        lines.append("- 耗时：" + elapsed)
    if summary.get("env_name"):
        lines.append("- 环境：" + str(summary["env_name"]))
    if summary.get("executor_name"):
        lines.append("- 执行人：" + str(summary["executor_name"]))
    if status in ("failed", "error", "cancelled"):
        reason = str(summary.get("error") or summary.get("message") or label)
        lines.append("- 失败原因：" + reason[:200])
    run_id = summary.get("run_id")
    if run_id:
        lines.append("[打开报告](/reports/" + str(run_id) + ")")
    return "\n".join(lines)
