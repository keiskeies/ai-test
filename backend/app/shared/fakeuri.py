"""fake://<name> URI 约定：base_url 指向 tests/fixtures/fake_model/<name>.jsonl 回放脚本。

放 shared（非 modules）：agent 网关与 model_cfg 探测共用，断开模块间横向依赖。
"""
from __future__ import annotations

from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "fake_model"


def is_fake(base_url) -> bool:
    return str(base_url).startswith("fake://")


def fixture_path(base_url) -> Path:
    """fake://<name>[?x=1] → tests/fixtures/fake_model/<name>.jsonl"""
    name = str(base_url)[len("fake://"):].split("?")[0]
    return FIXTURE_DIR / (name + ".jsonl")
