"""IAM HTTP 路由：auth / projects / members / roles。"""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_db
from app.modules.iam import project_services, schemas
from app.modules.iam.deps import get_current_user
from app.modules.iam.models import User

router = APIRouter(tags=["iam"])

Db = Annotated[AsyncSession, Depends(get_db)]
Cur = Annotated[User, Depends(get_current_user)]

# refresh 令牌 Cookie 名；Path 收窄到 /api/v1/auth——刷新/登出之外任何端点都带不上它，
# 减少泄露面。HttpOnly 挡住 XSS 直读；SameSite=Lax 是 CSRF 面与「顶层导航仍能带 Cookie」
# 的折中（刷新只在 fetch 里发生，Lax/Strict 均可，取 Lax 与浏览器默认迁移方向一致）。
REFRESH_COOKIE = "tp_refresh"


def _refresh_cookie_secure() -> bool:
    """Secure 位按环境裁决：demo/开发/测试跑的是明文 http://127.0.0.1（README §1），
    Secure=True 的 Cookie 在明文 http 下**根本存不进浏览器**，登录会静默失效应
    （refresh 永远 401）。所以 dev/test 不挂 Secure，其余环境（staging/prod）挂上。
    反代终结 TLS 的部署必须同时保证对外只有 https，否则这里救不了你。"""
    return get_settings().env not in ("dev", "test")


def _set_refresh_cookie(res: Response, token: str) -> None:
    res.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=get_settings().refresh_ttl_days * 86400,
        path="/api/v1/auth",
        httponly=True,
        samesite="lax",
        secure=_refresh_cookie_secure(),
    )


def _clear_refresh_cookie(res: Response) -> None:
    # 清除必须与设置时 path 完全一致，否则清不掉。
    res.delete_cookie(REFRESH_COOKIE, path="/api/v1/auth", httponly=True, samesite="lax",
                      secure=_refresh_cookie_secure())


@router.post("/auth/login", response_model=schemas.LoginOut)
async def login(payload: schemas.LoginIn, db: Db, res: Response) -> schemas.LoginOut:
    from app.core.security import create_refresh_token
    from app.modules.iam import services

    out = await services.login(db, payload)
    # 刷新令牌只存在于 HttpOnly Cookie，不进 JSON body（见 RefreshOut 注释）。
    _set_refresh_cookie(res, create_refresh_token(out.user.id))
    return out


@router.post("/auth/refresh", response_model=schemas.RefreshOut)
async def refresh(request: Request, db: Db, res: Response) -> schemas.RefreshOut:
    """无状态刷新：验 Cookie 里的 refresh JWT（typ 校验在 decode_refresh_token 里，
    access 令牌到这里必 401），换发新 access 并**轮换** refresh Cookie。
    无状态 ⇒ logout 不能撤销已签发的 refresh（限制全文见 security.create_refresh_token）。"""
    from sqlalchemy import select

    from app.core.errors import ApiError
    from app.core.security import create_access_token, create_refresh_token, decode_refresh_token

    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise ApiError("unauthorized", "未认证", 401)
    user_id = decode_refresh_token(token)  # 无效/过期/typ 不符 → 统一 401 信封
    user = (await db.execute(select(User).where(User.id == str(user_id)))).scalar_one_or_none()
    if user is None or user.status != "active":
        raise ApiError("unauthorized", "账号不可用", 401)
    _set_refresh_cookie(res, create_refresh_token(user.id))
    return schemas.RefreshOut(token=create_access_token(user.id))


@router.post("/auth/logout")
async def logout(res: Response) -> dict[str, bool]:
    """登出：清 refresh Cookie。无状态令牌本体无法吊销（限制见 security.create_refresh_token），
    这里做的是「让本浏览器不再能刷新」，不是服务端撤销。"""
    _clear_refresh_cookie(res)
    return {"ok": True}


@router.get("/auth/me", response_model=schemas.UserOut)
async def me(user: Cur) -> schemas.UserOut:
    return schemas.UserOut.model_validate(user)


@router.get("/roles")
async def roles(db: Db, user: Cur) -> dict[str, Any]:
    return {"items": [r.model_dump() for r in await project_services.list_roles(db)]}


@router.post("/projects", response_model=schemas.ProjectOut, status_code=201)
async def create_project(payload: schemas.ProjectIn, db: Db, user: Cur) -> schemas.ProjectOut:
    return await project_services.create_project(db, user, payload)


@router.get("/projects")
async def list_projects(db: Db, user: Cur, cursor: str | None = None, size: int = 20) -> dict[str, Any]:
    page = await project_services.list_projects(db, user, cursor=cursor, size=size)
    return {"items": [x.model_dump() for x in page.items], "next_cursor": page.next_cursor}


@router.get("/projects/{project_id}", response_model=schemas.ProjectOut)
async def get_project(project_id: str, db: Db, user: Cur) -> schemas.ProjectOut:
    return await project_services.get_project(db, user, project_id)


@router.patch("/projects/{project_id}", response_model=schemas.ProjectOut)
async def update_project(project_id: str, payload: schemas.ProjectUpdateIn, db: Db, user: Cur) -> schemas.ProjectOut:
    return await project_services.update_project(db, user, project_id, payload)


@router.get("/projects/{project_id}/members")
async def list_members(project_id: str, db: Db, user: Cur) -> dict[str, Any]:
    return {"items": [m.model_dump() for m in await project_services.list_members(db, user, project_id)]}


@router.put("/projects/{project_id}/members/{user_id}")
async def set_member(project_id: str, user_id: str, payload: schemas.MemberIn, db: Db, user: Cur) -> dict[str, Any]:
    return (await project_services.set_member(db, user, project_id, user_id, payload)).model_dump()


@router.delete("/projects/{project_id}/members/{user_id}")
async def remove_member(project_id: str, user_id: str, db: Db, user: Cur) -> dict[str, Any]:
    await project_services.remove_member(db, user, project_id, user_id)
    return {"ok": True}
