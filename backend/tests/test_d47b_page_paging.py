"""D47-b 页码分页（MS 的 {current, pageSize, total}）：paginate_page / count_of / _dump 的 total 键。

两层，失效方式不同：

**行为层（真 MySQL，`session` 夹具 + 一次性探针表）**：页切得对不对、越界是不是空页而不是
报错、clamp 是不是真夹住、ORDER BY/LIMIT 有没有被摘干净。计数那条除了行为还要**看真正发往
 MySQL 的 SQL**（`before_cursor_execute` 挂钩子抓）——「ORDER BY 被摘了」这句话在结果集里
永远看不出来（带不带排序数出来一样多），只有线上的 SQL 文本能作证。

**契约层（不碰库）**：`_dump` 的 total 键只在页码分页时出现。这是本步的核心承诺——
键集一页的响应必须与今天**逐字节**一致，凭空多出 `"total": null` 就是给 20+ 个没人评审过的
接口改契约。断言按**完整 dict 相等**写，不按 `in`/`not in` 写：多一个键、少一个键都红。

变异自证（改法与红点的对应）：
- `paginate_page` 开始吐 next_cursor → test_pages_are_disjoint_slices 与
  test_current_past_end_returns_empty_not_error 红（两套「我在哪」的真相不许并存）
- `_dump` 无条件写 total（含 None）→ test_dump_total_key_is_additive_only 红
- `count_of` 不摘 LIMIT/OFFSET → test_count_of_respects_where_and_strips_order_and_limit 红
  （摘没摘 ORDER BY 行为不可观察，所以那半条钉的是抓到的 SQL 文本）
- 钳位 `min(size, 200)` 摘掉 → test_size_and_current_are_clamped 红（250 行只回 200 条）
- `current < 1` 当页号直算（offset 变负）→ test_size_and_current_are_clamped 红
"""
from __future__ import annotations

from sqlalchemy import Column, Integer, MetaData, String, Table, event, insert, select

from app.core.errors import Page, count_of, paginate_page
from app.core.service import _dump

_TABLE = "_page_probe"


def _probe_table() -> Table:
    meta = MetaData()
    return Table(
        _TABLE,
        meta,
        Column("id", String(36), primary_key=True),
        Column("flag", Integer, nullable=False, default=0),
        Column("name", String(32)),
    )


async def _seed(session, rows: list[dict]) -> Table:
    """先 drop 再 create：上一个用例失败没来得及 drop 时，本用例仍从已知数据开始。"""
    t = _probe_table()
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))
    await session.run_sync(lambda sc: t.create(sc.get_bind(), checkfirst=True))
    if rows:
        await session.execute(insert(t).values(rows))
    await session.commit()
    return t


def _capture_sql(session):
    """抓真实发往 MySQL 的语句：count 查询「有没有把 ORDER BY/LIMIT 摘干净」只有线上文本算数。

    event 监听只挂在同步侧——夹具里 session 绑的是 AsyncConnection，得先摸到它的同步
    Engine 再 listen，挂到 AsyncConnection 上 SQLAlchemy 直接拒。
    """
    captured: list[str] = []

    def _hook(conn, cursor, statement, parameters, context, executemany):
        captured.append(statement)

    def _attach(on: bool) -> None:
        bind = session.get_bind()
        sync = getattr(bind, "sync_connection", bind)
        engine = getattr(sync, "engine", sync)
        engine = getattr(engine, "sync_engine", engine)
        if on:
            event.listen(engine, "before_cursor_execute", _hook)
        else:
            event.remove(engine, "before_cursor_execute", _hook)

    return captured, _attach


async def test_count_of_respects_where_and_strips_order_and_limit(session) -> None:
    """WHERE 要跟着数；ORDER BY / LIMIT / OFFSET 都不许进计数 SQL。

    LIMIT 不摘会把「全表有多少」数成「这页有几条」——total 是给页脚说的谎，比不数更糟。
    ORDER BY 摘没摘行为上看不出来（MySQL 容忍子查询里的排序且计数不变），所以这里用
    before_cursor_execute 抓**实际发出的 SQL** 钉文本；LIMIT 则行为、文本两头都钉。
    """
    t = await _seed(session, [{"id": f"c{i}", "flag": i % 2, "name": f"n{i}"} for i in range(6)])
    stmt = select(t.c.id).where(t.c.flag == 1).order_by(t.c.id.desc()).limit(2).offset(1)

    captured, _attach = _capture_sql(session)
    _attach(True)
    try:
        got = await count_of(session, stmt)
    finally:
        _attach(False)

    assert got == 3, f"flag=1 的有 3 行，count_of 数出 {got}（LIMIT/OFFSET 漏进来了？）"
    # 行为面：带不带排序/限量，count 恒等
    assert got == await count_of(session, select(t.c.id).where(t.c.flag == 1))
    assert await count_of(session, select(t.c.id)) == 6
    # 文本面：发出去的那条 count 里没有 ORDER BY、没有 LIMIT，WHERE 还在
    count_sql = next(s for s in captured if "count(" in s.lower())
    assert "ORDER BY" not in count_sql.upper(), count_sql
    assert "LIMIT" not in count_sql.upper(), count_sql
    assert "WHERE" in count_sql.upper(), count_sql
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))


async def test_pages_are_disjoint_slices_with_total_and_no_cursor(session) -> None:
    """第 1/2/3 页是不重叠、保持 ORDER BY 的切片；total 恒等于全集条数；next_cursor 恒为 None。

    next_cursor 必须 None 且被断言钉住：变异自证——谁让 paginate_page 也吐游标，本例当场红。
    游标与页码同时给出 = 对「我在哪」两套真相，前端接哪个都会在另一套失效时错位。
    total 在第 1 页也要是 5 而不是 2：它数的是筛选后的全集，页脚照它画页码，不是本页行数。
    """
    t = await _seed(session, [{"id": f"i{i:02}", "flag": 0, "name": f"n{i}"} for i in range(5)])
    stmt = select(t.c.id).order_by(t.c.id)

    p1 = await paginate_page(session, stmt, current=1, size=2)
    p2 = await paginate_page(session, stmt, current=2, size=2)
    p3 = await paginate_page(session, stmt, current=3, size=2)

    assert [r[0] for r in p1.items] == ["i00", "i01"], p1.items
    assert [r[0] for r in p2.items] == ["i02", "i03"], p2.items
    assert [r[0] for r in p3.items] == ["i04"], "末页不满一页要照实返回，不许凑数也不许报错"
    assert not ({r[0] for r in p1.items} & {r[0] for r in p2.items}), "页与页重叠 = OFFSET 没生效"
    for p in (p1, p2, p3):
        assert p.total == 5 and p.next_cursor is None, p


async def test_total_counts_the_filtered_set_not_the_page(session) -> None:
    """total 是 WHERE 筛完全集的条数，与本页行数、与 current 是第几页都无关。"""
    t = await _seed(session, [{"id": f"f{i}", "flag": i % 2, "name": f"n{i}"} for i in range(8)])
    stmt = select(t.c.id).where(t.c.flag == 1).order_by(t.c.id)
    p1 = await paginate_page(session, stmt, current=1, size=2)
    assert [r[0] for r in p1.items] == ["f1", "f3"]
    assert p1.total == 4, f"flag=1 共 4 行，total 却是 {p1.total}（数成本页/全表了）"
    p2 = await paginate_page(session, stmt, current=2, size=2)
    assert [r[0] for r in p2.items] == ["f5", "f7"] and p2.total == 4, p2


async def test_current_past_end_returns_empty_not_error(session) -> None:
    """跳到没有的页：items 为空、total 照实、不抛错。

    用户点了个空页，页脚仍要说清库里有多少行；报错（或让 SQL 层负 OFFSET 炸成 500）
    都是把「跳过头」这件用户随时会做的事当事故。
    """
    t = await _seed(session, [{"id": f"e{i}", "flag": 0, "name": f"n{i}"} for i in range(3)])
    p = await paginate_page(session, select(t.c.id).order_by(t.c.id), current=99, size=10)
    assert p.items == [] and p.total == 3 and p.next_cursor is None, p
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))


async def test_size_and_current_are_clamped(session) -> None:
    """钳位与 paginate/paginate_desc 逐字同款：size 上限 200、0 当 20；current<1 当第 1 页。

    250 行只回 200 条——这条只有用超过 200 的数据才证得了 `min(size, 200)` 真在生效，
    拿 5 行数据请求 size=999 是测不到钳位的（全返回也恰好「对」）。
    """
    t = await _seed(session, [{"id": f"z{i:03}", "flag": 0, "name": f"n{i}"} for i in range(250)])
    stmt = select(t.c.id).order_by(t.c.id)

    big = await paginate_page(session, stmt, current=1, size=999)
    assert len(big.items) == 200 and big.total == 250, (len(big.items), big.total)
    zero = await paginate_page(session, stmt, current=1, size=0)
    assert len(zero.items) == 20, "size=0 走 `or 20` 兜底，不是 max(1,…) 的 1"
    for cur in (0, -5):
        head = await paginate_page(session, stmt, current=cur, size=3)
        assert [r[0] for r in head.items] == ["z000", "z001", "z002"], f"current={cur} 必须按第 1 页"
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))


async def test_entity_and_joined_selects_both_page(session) -> None:
    """实体 select 出对象、联列 select 出元组——single/rows 两条取行分支都要走到页码分页。

    与 paginate 同款判断（column_descriptions 单实体走 scalars().unique()）：抄它的形状，
    不重排。分支挂掉的一侧会以「items 里全是 Row 包装」或「.unique() 对元组报错」暴露。
    """
    from app.modules.iam.models import User

    for acc in ("d47b_a", "d47b_b", "d47b_c"):
        session.add(User(account=acc, name=acc.upper(), password_hash="x",
                         is_system_admin=False, status="active"))
    await session.commit()

    ent = await paginate_page(session, select(User).order_by(User.account), current=2, size=1)
    assert [u.account for u in ent.items] == ["d47b_b"], "实体 select 要直接给 ORM 对象"
    assert isinstance(ent.items[0], User) and ent.total == 3

    joined = await paginate_page(session,
                                 select(User.account, User.name).order_by(User.account),
                                 current=1, size=2)
    assert [tuple(r) for r in joined.items] == [("d47b_a", "D47B_A"), ("d47b_b", "D47B_B")]
    assert joined.total == 3 and joined.next_cursor is None


def test_dump_total_key_is_additive_only() -> None:
    """_dump 的 total 键只在非 None 时出现；None 的页必须与改动前逐字节一致。

    按完整 dict 相等断言（不是 `in` 检查）：`{"items", "next_cursor"}` 之外多一个键——
    包括 "total": null——都是给 20+ 个键集列表接口单方面改契约，本例必须红。
    total=7 的一侧钉的是页码分页的响应真的带得上 total，否则前端页脚画不出来。
    """
    bare = _dump(Page(items=["x"]))
    assert bare == {"items": ["x"], "next_cursor": None}, bare
    counted = _dump(Page(items=["x"], total=7))
    assert counted == {"items": ["x"], "next_cursor": None, "total": 7}, counted
    # total=0 是合法计数（筛完真的一条没有），不许被 falsy 判断吞掉
    assert _dump(Page(items=[], total=0))["total"] == 0
