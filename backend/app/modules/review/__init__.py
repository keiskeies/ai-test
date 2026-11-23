"""用例评审域（D194）：评审 + 评审模块树 + 评审↔用例 + 评审人 + 结论历史。

不建 ARCHIVED/空快照表；评审状态读时聚合；结论历史 append-only。
依赖 functional_case（表名反射）与 project_meta 取号（REGISTRY）。
"""
