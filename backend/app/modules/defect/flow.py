"""项目级/组织级缺陷状态图的读写与校验（D267 + D271）。

`models.py` 的两份常量（`DEFECT_STATUSES` / `DEFECT_TRANSITIONS`）是**默认图**；
每个项目可以在 `defect_status` / `defect_status_transition` 两张表里整份覆盖它，
每个组织可以在 `org_defect_status` / `org_defect_status_transition` 里建模板。
**空表 = 上一层**——迁移不 INSERT（全仓纪律），避开了「存量项目谁来插行」的老问题。

优先级（D271，对齐 MS 的 OrganizationStatusFlow）：
    项目自定义行 > 所属组织模板行 > 内置默认图
组织模板不复制到项目：改模板对所有「未自定义」的项目立即生效。项目 → 组织的映射
走一条只读 SQL（`project.organization_id`）——本模块不 import iam（独立性契约）。

读写口径：
- 读：`load_flow(db, project_id)` 永远能拿到可用图（并标明 `source`）；
- 写：`save_flow` / `save_org_flow` 都是**整份替换**（先删后插，同一事务）；
- 删状态前必须查引用：项目写只查本项目；组织写要查**所有继承该模板的项目**
  （没有自定义行、且缺陷挂在被删 key 上的项目）→ 409，不落半份图；
- 重置：删行，读侧立刻回落到上一层。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, text

from app.core.errors import ApiError
from app.modules.defect.models import (
    DEFECT_END_STATUSES,
    DEFECT_START_STATUS,
    DEFECT_STATUSES,
    DEFECT_TRANSITIONS,
    Defect,
    DefectStatus,
    DefectStatusTransition,
    OrgDefectStatus,
    OrgDefectStatusTransition,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from sqlalchemy.ext.asyncio import AsyncSession

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_STATUSES = 20
MAX_EDGES = 200

# 默认图的中文名（自定义状态由用户在保存时自带 name；这里只服务「没定制过」的项目）。
DEFAULT_NAMES: dict[str, str] = {
    "new": "新建",
    "in_process": "处理中",
    "resolved": "已解决",
    "rejected": "已拒绝",
    "closed": "已关闭",
}


@dataclass(frozen=True)
class FlowStatus:
    key: str
    name: str
    is_start: bool
    is_end: bool


@dataclass(frozen=True)
class DefectFlow:
    statuses: tuple[FlowStatus, ...]
    edges: Mapping[str, tuple[str, ...]]
    customized: bool
    # D271：这张图从哪来——"project"（项目自定义）/ "org"（继承组织模板）/ "default"。
    source: str = "default"

    @property
    def start_key(self) -> str:
        for s in self.statuses:
            if s.is_start:
                return s.key
        return self.statuses[0].key

    def has(self, key: str) -> bool:
        return any(s.key == key for s in self.statuses)

    def allowed(self, current: str) -> tuple[str, ...]:
        return self.edges.get(current, ())

    def allows(self, old: str, new: str) -> bool:
        return old == new or new in self.allowed(old)

    def name_of(self, key: str) -> str:
        for s in self.statuses:
            if s.key == key:
                return s.name
        return key


def _default_flow() -> DefectFlow:
    statuses = tuple(
        FlowStatus(
            key=k,
            name=DEFAULT_NAMES.get(k, k),
            is_start=(k == DEFECT_START_STATUS),
            is_end=(k in DEFECT_END_STATUSES),
        )
        for k in DEFECT_STATUSES
    )
    return DefectFlow(statuses=statuses, edges=dict(DEFECT_TRANSITIONS), customized=False,
                      source="default")


DEFAULT_FLOW: DefectFlow = _default_flow()


async def _org_id_of_project(db: AsyncSession, project_id: str) -> str | None:
    """项目归属组织（只读 SQL，不 import iam）。`None` = 未归档/组织已删。"""
    row = (await db.execute(
        text("SELECT organization_id FROM project WHERE id = :p"), {"p": project_id}
    )).first()
    return None if row is None or row[0] is None else str(row[0])


async def load_org_flow(db: AsyncSession, org_id: str) -> DefectFlow | None:
    """组织的状态流模板；两表都空返回 None（= 没建模板，不是空图）。"""
    rows = (await db.execute(
        select(OrgDefectStatus)
        .where(OrgDefectStatus.org_id == org_id)
        .order_by(OrgDefectStatus.position, OrgDefectStatus.created_at)
    )).scalars().all()
    if not rows:
        return None
    edge_rows = (await db.execute(
        select(OrgDefectStatusTransition)
        .where(OrgDefectStatusTransition.org_id == org_id)
        .order_by(OrgDefectStatusTransition.from_key, OrgDefectStatusTransition.to_key)
    )).scalars().all()
    edges: dict[str, list[str]] = {}
    for e in edge_rows:
        edges.setdefault(e.from_key, []).append(e.to_key)
    return DefectFlow(
        statuses=tuple(FlowStatus(r.key, r.name, r.is_start, r.is_end) for r in rows),
        edges={k: tuple(v) for k, v in edges.items()},
        customized=False, source="org",
    )


async def load_flow(db: AsyncSession, project_id: str) -> DefectFlow:
    """取项目生效的状态图：项目自定义 > 组织模板 > 内置默认。"""
    rows = (await db.execute(
        select(DefectStatus)
        .where(DefectStatus.project_id == project_id)
        .order_by(DefectStatus.position, DefectStatus.created_at)
    )).scalars().all()
    if not rows:
        org_id = await _org_id_of_project(db, project_id)
        if org_id is not None:
            inherited = await load_org_flow(db, org_id)
            if inherited is not None:
                return inherited
        return DEFAULT_FLOW
    edge_rows = (await db.execute(
        select(DefectStatusTransition)
        .where(DefectStatusTransition.project_id == project_id)
        .order_by(DefectStatusTransition.from_key, DefectStatusTransition.to_key)
    )).scalars().all()
    edges: dict[str, list[str]] = {}
    for e in edge_rows:
        edges.setdefault(e.from_key, []).append(e.to_key)
    return DefectFlow(
        statuses=tuple(FlowStatus(r.key, r.name, r.is_start, r.is_end) for r in rows),
        edges={k: tuple(v) for k, v in edges.items()},
        customized=True, source="project",
    )


def _validate(
    statuses: Iterable[tuple[str, str, bool, bool]],
    edges: Iterable[tuple[str, str]],
) -> tuple[list[FlowStatus], list[tuple[str, str]]]:
    """校验一份完整图；错误一律 422 `invalid_flow`，details 点名是哪条。

    - key 走 `KEY_RE`（与前端/URL/CSV 都不打架的 slug），最多 20 个、不重名；
    - name 去掉首尾空白后 1..32 字；
    - `is_start` 恰好一个；
    - 边两端的 key 必须存在；自环不落行（同态转移本来就放行，落行没有含义）；
    - 重复边去重（同一对 from/to 只存一条）。
    """
    out: list[FlowStatus] = []
    seen: set[str] = set()
    for key, name, is_start, is_end in statuses:
        k = (key or "").strip()
        n = (name or "").strip()
        if not KEY_RE.match(k):
            raise ApiError("invalid_flow", "状态 key 必须是 1..32 位小写字母开头的 slug：" + k, 422,
                           {"field": "key", "value": key})
        if not (1 <= len(n) <= 32):
            raise ApiError("invalid_flow", "状态名长度必须是 1..32：" + k, 422,
                           {"field": "name", "key": k})
        if k in seen:
            raise ApiError("invalid_flow", "状态 key 重复：" + k, 422, {"field": "key", "value": k})
        seen.add(k)
        out.append(FlowStatus(key=k, name=n, is_start=is_start, is_end=is_end))
    if not out:
        raise ApiError("invalid_flow", "至少保留一个状态", 422, {"field": "statuses"})
    if len(out) > MAX_STATUSES:
        raise ApiError("invalid_flow", "状态最多 " + str(MAX_STATUSES) + " 个", 422,
                       {"field": "statuses", "count": len(out)})
    starts = [s.key for s in out if s.is_start]
    if len(starts) != 1:
        raise ApiError("invalid_flow", "必须恰好有一个起始状态（当前 " + str(len(starts)) + " 个）", 422,
                       {"field": "is_start", "start_keys": starts})
    clean: list[tuple[str, str]] = []
    edge_seen: set[tuple[str, str]] = set()
    for frm, to in edges:
        f, t = (frm or "").strip(), (to or "").strip()
        if f not in seen or t not in seen:
            raise ApiError("invalid_flow", "转移边引用了不存在的状态：" + f + " → " + t, 422,
                           {"field": "transitions", "from_key": f, "to_key": t})
        if f == t:
            raise ApiError("invalid_flow", "同态转移不需要配边：" + f, 422,
                           {"field": "transitions", "from_key": f, "to_key": t})
        if (f, t) in edge_seen:
            continue
        edge_seen.add((f, t))
        clean.append((f, t))
    if len(clean) > MAX_EDGES:
        raise ApiError("invalid_flow", "转移边最多 " + str(MAX_EDGES) + " 条", 422,
                       {"field": "transitions", "count": len(clean)})
    return out, clean


async def _assert_no_dangling(db: AsyncSession, project_id: str, keep_keys: set[str]) -> None:
    """删状态项先查谁引用：还有缺陷（含回收站）挂着被删的 key 就整份不落。"""
    rows = (await db.execute(
        select(Defect.status, func.count())
        .where(Defect.project_id == project_id, Defect.status.notin_(keep_keys))
        .group_by(Defect.status)
    )).all()
    if rows:
        used = {r[0]: r[1] for r in rows}
        raise ApiError(
            "status_in_use",
            "这些状态仍有缺陷在用，先改派再删：" + "、".join(sorted(used)),
            409,
            {"in_use": used},
        )


async def save_flow(
    db: AsyncSession,
    project_id: str,
    statuses: Iterable[tuple[str, str, bool, bool]],
    edges: Iterable[tuple[str, str]],
) -> DefectFlow:
    """整份替换项目的状态图（调用方负责 commit）。"""
    clean_statuses, clean_edges = _validate(statuses, edges)
    await _assert_no_dangling(db, project_id, {s.key for s in clean_statuses})
    await db.execute(sa_delete(DefectStatus).where(DefectStatus.project_id == project_id))
    await db.execute(
        sa_delete(DefectStatusTransition).where(DefectStatusTransition.project_id == project_id)
    )
    for pos, s in enumerate(clean_statuses):
        db.add(DefectStatus(project_id=project_id, key=s.key, name=s.name,
                            is_start=s.is_start, is_end=s.is_end, position=pos))
    for frm, to in clean_edges:
        db.add(DefectStatusTransition(project_id=project_id, from_key=frm, to_key=to))
    await db.flush()
    return DefectFlow(statuses=tuple(clean_statuses), edges=_edges_map(clean_edges),
                      customized=True, source="project")


async def reset_flow(db: AsyncSession, project_id: str) -> None:
    """清空项目定制，回落到「下一层」图（调用方负责 commit）。

    D271 起下一层不一定是内置默认：所属组织有模板时回落组织模板，所以悬空检查
    必须对着**实际会生效的那张图**的 key 做——否则会把「组织模板里也有 doing」
    误判成悬空。
    """
    fallback = DEFAULT_FLOW
    org_id = await _org_id_of_project(db, project_id)
    if org_id is not None:
        inherited = await load_org_flow(db, org_id)
        if inherited is not None:
            fallback = inherited
    await _assert_no_dangling(db, project_id, {s.key for s in fallback.statuses})
    await db.execute(sa_delete(DefectStatus).where(DefectStatus.project_id == project_id))
    await db.execute(
        sa_delete(DefectStatusTransition).where(DefectStatusTransition.project_id == project_id)
    )


def _edges_map(edges: list[tuple[str, str]]) -> dict[str, tuple[str, ...]]:
    acc: dict[str, list[str]] = {}
    for frm, to in edges:
        acc.setdefault(frm, []).append(to)
    return {k: tuple(v) for k, v in acc.items()}


# ── D271：组织级模板 ─────────────────────────────────────────────────────────


async def _inheriting_projects(db: AsyncSession, org_id: str) -> list[str]:
    """本组织里「没有自定义状态图、会继承组织模板」的项目 id。

    项目集合用一条只读 SQL 取（不 import iam）；是否有自定义行查本模块的 defect_status。
    """
    ids = [str(r[0]) for r in (await db.execute(
        text("SELECT id FROM project WHERE organization_id = :o"), {"o": org_id}
    )).all()]
    if not ids:
        return []
    custom = set((await db.execute(
        select(DefectStatus.project_id).where(DefectStatus.project_id.in_(ids)).distinct()
    )).scalars().all())
    return [p for p in ids if p not in custom]


async def _assert_org_no_dangling(db: AsyncSession, org_id: str, keep_keys: set[str]) -> None:
    """组织模板删状态前查引用：继承该模板的项目里还有缺陷挂着被删 key → 409。"""
    inheritors = await _inheriting_projects(db, org_id)
    if not inheritors:
        return
    rows = (await db.execute(
        select(Defect.project_id, Defect.status, func.count())
        .where(Defect.project_id.in_(inheritors), Defect.status.notin_(keep_keys))
        .group_by(Defect.project_id, Defect.status)
    )).all()
    if rows:
        detail: dict[str, dict[str, int]] = {}
        for pid, status, n in rows:
            detail.setdefault(str(pid), {})[str(status)] = int(n)
        raise ApiError(
            "status_in_use",
            "这些状态仍被继承本模板的项目里的缺陷在用，先改派再删",
            409,
            {"in_use": detail},
        )


async def save_org_flow(
    db: AsyncSession,
    org_id: str,
    statuses: Iterable[tuple[str, str, bool, bool]],
    edges: Iterable[tuple[str, str]],
) -> DefectFlow:
    """整份替换组织模板（调用方负责 commit）。校验与项目级同一份 `_validate`。"""
    clean_statuses, clean_edges = _validate(statuses, edges)
    await _assert_org_no_dangling(db, org_id, {s.key for s in clean_statuses})
    await db.execute(sa_delete(OrgDefectStatus).where(OrgDefectStatus.org_id == org_id))
    await db.execute(
        sa_delete(OrgDefectStatusTransition).where(OrgDefectStatusTransition.org_id == org_id)
    )
    for pos, s in enumerate(clean_statuses):
        db.add(OrgDefectStatus(org_id=org_id, key=s.key, name=s.name,
                               is_start=s.is_start, is_end=s.is_end, position=pos))
    for frm, to in clean_edges:
        db.add(OrgDefectStatusTransition(org_id=org_id, from_key=frm, to_key=to))
    await db.flush()
    return DefectFlow(statuses=tuple(clean_statuses), edges=_edges_map(clean_edges),
                      customized=False, source="org")


async def reset_org_flow(db: AsyncSession, org_id: str) -> None:
    """删掉组织模板，继承项目回落内置默认图（调用方负责 commit）。"""
    has = (await db.execute(
        select(func.count(OrgDefectStatus.id)).where(OrgDefectStatus.org_id == org_id)
    )).scalar_one()
    if not int(has):
        return
    await _assert_org_no_dangling(db, org_id, set(DEFECT_STATUSES))
    await db.execute(sa_delete(OrgDefectStatus).where(OrgDefectStatus.org_id == org_id))
    await db.execute(
        sa_delete(OrgDefectStatusTransition).where(OrgDefectStatusTransition.org_id == org_id)
    )
