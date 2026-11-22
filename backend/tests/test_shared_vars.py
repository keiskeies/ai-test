import pytest

from app.shared.vars import MissingVar, merge_vars, render, render_deep


def test_render_subst():
    assert render("${base_url}/login", {"base_url": "http://x"}) == "http://x/login"
    assert render("a{{b}}c ${x}", {"x": "-"}) == "a{{b}}c -"  # 只认 ${} 语法


def test_render_missing_names_var():
    with pytest.raises(MissingVar) as e:
        render("Bearer ${token}", {})
    assert e.value.name == "token"


def test_render_deep_returns_copy():
    src = {"url": "${u}", "pairs": [["k", "${v}"]]}
    out = render_deep(src, {"u": "U", "v": "V"})
    assert out == {"url": "U", "pairs": [["k", "V"]]}
    assert src["url"] == "${u}"


def test_merge_later_wins():
    assert merge_vars({"a": "1", "b": "2"}, {"b": "3"}, {"b": "9"})["b"] == "9"
