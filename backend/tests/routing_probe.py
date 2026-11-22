"""路由探针子进程：只 import app.main、只调 create_app()，然后如实报告路由覆盖。

被 tests/test_registry.py::test_every_http_service_is_routed_by_real_app 用 subprocess
拉起来。为什么不就地跑：pytest 全量跑时，别的测试文件早就把各 services 模块 import 过了，
sys.modules 里一片齐全，「main.py 漏 import」这件事在进程内根本测不出来（T14 就是这么漏掉
artifact_download 的）。子进程是全新解释器，除了 app.main 谁都没 import，唯一真相。

sys.path 修正：`python tests/routing_probe.py` 会把 sys.path[0] 设成 tests/，app 包不在
里面；显式把 backend/ 插进去，好让这个文件从任何 cwd 都能跑。
"""
from __future__ import annotations

import importlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import main as main_mod  # noqa: E402  （必须在 sys.path 修正之后）


def main() -> int:
    # 基线：探针自己只 import 了 app.main，此刻 app.modules.* 应该一个都不在场。
    # 若将来有人把领域模块提到 app/main.py 或 app/core/* 的顶层 import，这个基线就脏了，
    # 「create_app 有没有 import 它」的判定随之失效——所以把基线也如实报给测试去断言。
    preexisting = sorted(m for m in sys.modules if m.startswith("app.modules."))

    app = main_mod.create_app()
    have = set(app.openapi()["paths"].keys())

    from app.core.registry import REGISTRY  # noqa: PLC0415

    # 扫描口径与被替换掉的那版一致：app/ 下任何写了 http={ 的文件都算「带路由的模块」。
    root = pathlib.Path(main_mod.__file__).parent
    scanned = []
    for f in sorted(root.rglob("*.py")):
        if "__pycache__" in f.parts:
            continue
        if "http={" not in f.read_text(encoding="utf-8"):
            continue
        scanned.append(".".join(f.relative_to(root.parent).with_suffix("").parts))

    # create_app 该 import 的没 import 上 ⇒ 现在还不在场。先补 import 再比路由，
    # 才能把「漏 import」和「注册了但没建路由」分成两条不同的红来报。
    not_imported = [m for m in scanned if m not in sys.modules]
    for m in not_imported:
        importlib.import_module(m)

    # 扫描口径自检：注册表知道它有 http 路由、但扫描没把这个模块算进来 ⇒ 扫描瞎了。
    # 触发方式是有人改了 http={...} 的字面写法（比如抽成常量、换关键字），或把服务挪出
    # app/。这比「模块数 >= N」可靠——模块数会因为正当重构而变，这条不会无故红。
    scanned_set = set(scanned)
    blind = sorted({s.handler.__module__ for s in REGISTRY.all() if s.http is not None} - scanned_set)

    want = {"/api/v1" + s.http["path"] for s in REGISTRY.all() if s.http is not None}
    print(json.dumps({
        "scanned": len(scanned),
        "preexisting": preexisting,
        "not_imported": not_imported,
        "scan_blind": blind,
        "missing_paths": sorted(want - have),
        "n_paths": len(have),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
