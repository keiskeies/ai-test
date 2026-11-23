"""评审域的共享查询谓词（不放 services.py，供 composition 层复用同一把尺）。

`my_todo_review_ids` 有两处调用方：`review_list` 的 `my_todo` 过滤，与工作台的
「待我评审」卡片（D227）。**一份实现，两处调用**——各写一遍就是两份会各自漂移的
「待办」定义（工作台说有 3 条、评审页筛出 2 条，用户没法解释差在哪）。

语义（review_list 的既有口径，逐字沿用）：我是该用例的评审人，且该用例的聚合结论
仍是 `pending`（尚未有人给出当前有效的 pass/fail）。`CaseReviewCase.result` 由
`_recompute_case` 在每次提交结果后重算，是「用例级」结论；这里不按人拆——评审规则
（single/all）决定几个人的意见才算数，那个判定只有 `_case_result` 一处。
"""
from __future__ import annotations

from sqlalchemy import Select, and_, select

from app.modules.review.models import CaseReviewCase, CaseReviewReviewer


def my_todo_review_ids(user_id: str) -> Select:
    """我名下仍有 pending 用例的评审 id（去重，未过滤项目——调用方自己加 project_id）。"""
    return (
        select(CaseReviewCase.review_id)
        .join(
            CaseReviewReviewer,
            and_(CaseReviewReviewer.review_id == CaseReviewCase.review_id,
                 CaseReviewReviewer.case_id == CaseReviewCase.case_id),
        )
        .where(CaseReviewReviewer.user_id == user_id, CaseReviewCase.result == "pending")
        .distinct()
    )
