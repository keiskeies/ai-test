"""权限点通配匹配：全系统唯一鉴权判定（ledger R9）。

语法："*" / "mod:*" / "*:action" / "-pattern"（显式拒绝优先）。
"""
from __future__ import annotations


def match_perm(patterns: set[str], perm: str) -> bool:
    for p in patterns:
        if p.startswith("-") and _match_one(p[1:], perm):
            return False
    return any(_match_one(p, perm) for p in patterns if not p.startswith("-"))


def _match_one(pattern: str, perm: str) -> bool:
    if pattern == "*":
        return True
    if pattern.endswith(":*"):
        return perm.startswith(pattern[:-1])
    if pattern.startswith("*:"):
        return perm.endswith(pattern[1:])
    return pattern == perm
