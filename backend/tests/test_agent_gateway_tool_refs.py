"""D157 · {{TR:...}} 路径 miss 必须带人话（gateway.py `_walk`）。

`_apply_tool_refs` 的契约（gateway.py 原文）：找不到就抛，run 落 ERROR 让问题可见，
而不是带占位符继续。ERROR 卡片取的是 str(e)（runner.py :56-57），所以「抛了但没
人话」等于卡片上一句 `list index out of range` / `invalid literal for int()...`。

本档纯单元（不碰 DB）：`_walk` / `_apply_tool_refs` 直接调用。钉五种 miss +
一个正对照 + 真实世界触发形态（0 行工具结果按下标取）：
① list 下标越界 → 「TR 路径不可达」全句 + 完整路径（杀裸 IndexError）；
② 段不是数字（content.id.id 打在 list 上）→ 同一句（杀 ValueError「invalid literal」面）；
③ dict 缺键 → 同一句 + 完整路径 + 出错段（杀裸 KeyError('key')：路径全丢）；
④ 标量中断路径 → 同一句（本修把它从 KeyError 换成 ValueError，卡片才不带引号）；
⑤ 引用的工具压根没结果 → 「TR 引用了尚无结果的工具: 」干净句首。

①②③④⑤ 都钉 str(e) 以人话句首开头无引号：KeyError 会 repr 套引号，卡片上多一层引号
就不是这句话的形状（所以生产侧一律抛 ValueError，gateway.py build_gateway「未知协议」同款）。
全部按消息文本断言——只断异常类型的测试在消息丢失时照样绿。
"""
from __future__ import annotations

import json

import pytest

from app.modules.agent.gateway import _apply_tool_refs, _walk

SENTENCE = "TR 路径不可达: "

# 真实 TOOL_RESULT 形状（api_definition_list 返回 {"tool_name", "content": [...]}）
NESTED = {"tool_name": "api_definition_list", "content": [{"id": "abc-123"}, {"id": "def-456"}]}


def _msgs(payload: dict) -> list[dict]:
    return [{"role": "tool", "content": json.dumps(payload)}]


def test_miss_list_index_out_of_range_carries_human_sentence() -> None:
    """①：越界下标原来抛裸 IndexError("list index out of range")——卡片没人能看懂。"""
    with pytest.raises(ValueError) as ei:
        _walk(NESTED, "content.9.id")
    msg = str(ei.value)
    assert SENTENCE in msg and "content.9.id" in msg
    assert "list index out of range" not in msg


def test_miss_non_numeric_segment_on_list_carries_same_sentence() -> None:
    """②：int(seg) 对非数字段抛 ValueError("invalid literal...")——同病不同型，同一句治。"""
    with pytest.raises(ValueError) as ei:
        _walk(NESTED, "content.id.id")
    msg = str(ei.value)
    assert SENTENCE in msg and "content.id.id" in msg
    assert "invalid literal" not in msg


def test_miss_message_has_no_keyerror_quotes_and_names_segment() -> None:
    """卡片 str(e)：句首必须干净（KeyError 会把整句 repr 成带引号），且单独点出出错段。

    「段」要钉 `（段: X）` 这个记法本身，不能钉 `"9" in msg`——段名按构造就是路径的子串，
    后者在实现把段整个丢掉时照样绿（第三十九/四十轮量过的「永远绿探针」）。
    """
    with pytest.raises(ValueError) as ei:
        _walk(NESTED, "content.9.id")
    msg = str(ei.value)
    assert msg.startswith(SENTENCE)  # 引号变异：KeyError(...) 时这里首字符是 '
    assert "（段: 9）" in msg


def test_miss_dict_key_missing_gets_same_sentence_with_path() -> None:
    """③：dict 缺键原来抛 KeyError(段名)——卡片上一串带引号的 'missing_key'，路径全丢。

    裁：与 list 越界同一种病（卡片只剩半句），同治成一句人话。原「钉 KeyError 带键名」
    的口径里「说得出是哪个段」这半条留着（下面 seg 断言），换掉的是「只报键名不报路径」。
    """
    with pytest.raises(ValueError) as ei:
        _walk(NESTED, "content.0.missing_key")
    msg = str(ei.value)
    assert msg.startswith(SENTENCE)  # 引号变异：KeyError(...) 时首字符是 '
    assert "content.0.missing_key" in msg and "（段: missing_key）" in msg


def test_miss_scalar_mid_path_keeps_existing_sentence() -> None:
    """④：路径中段撞标量（id 之后还有段）——那句人话原样在，且同样不带引号。"""
    with pytest.raises(ValueError) as ei:
        _walk(NESTED, "content.0.id.name")
    msg = str(ei.value)
    assert msg.startswith(SENTENCE) and "content.0.id.name" in msg
    assert "（段: name）" in msg  # 三支同口径：缺了这一支的段，另两支绿着也看不出


def test_missing_source_tool_message_has_no_quotes() -> None:
    """源工具压根没结果：金线钉过句子内容（test_agent_dod_cards.py），这里钉卡片形状。

    run.error 取的是 str(e)，KeyError 版本会让卡片多一层引号——手册 §2 承诺的是干净那句。
    """
    with pytest.raises(ValueError) as ei:
        _apply_tool_refs("x={{TR:no_such_tool:content.0.id}}", _msgs(NESTED))
    msg = str(ei.value)
    assert msg.startswith("TR 引用了尚无结果的工具: ")  # 引号变异在这条红
    assert "no_such_tool" in msg


def test_positive_control_valid_path_still_resolves() -> None:
    """正对照：永远抛/永远替换成错的实现过不了这条。"""
    assert _walk(NESTED, "content.0.id") == "abc-123"
    assert _walk(NESTED, "content.1.id") == "def-456"
    line = _apply_tool_refs("id={{TR:api_definition_list:content.0.id}}", _msgs(NESTED))
    assert line == "id=abc-123"


def test_zero_row_tool_result_with_index_path_gets_human_message() -> None:
    """真实世界最常踩的 miss：工具 0 行结果，脚本仍按 content.0.id 取下标。"""
    empty = {"tool_name": "api_definition_list", "content": []}
    with pytest.raises(ValueError) as ei:
        _apply_tool_refs("id={{TR:api_definition_list:content.0.id}}", _msgs(empty))
    msg = str(ei.value)
    assert SENTENCE in msg and "content.0.id" in msg
    assert "list index out of range" not in msg
