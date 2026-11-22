import pytest

from app.shared.jsonpath import JsonPathMissing, jsonpath_get

DATA = {"a": {"b": [{"c": 1}, {"c": 2}]}, "data": {"token": "tk"}, "": 3}


def test_get_paths():
    assert jsonpath_get(DATA, "$.data.token") == "tk"
    assert jsonpath_get(DATA, "$.a.b[1].c") == 2
    assert jsonpath_get(DATA, "$") is DATA


def test_missing_paths_raise_not_none():
    for bad in ("$.a.x", "$.a.b[9].c", "$.nope.deep", "$.a.b.c"):
        with pytest.raises(JsonPathMissing):
            jsonpath_get(DATA, bad)


def test_quoted_key_with_space():
    assert jsonpath_get({"a b": 7}, "$['a b']") == 7
