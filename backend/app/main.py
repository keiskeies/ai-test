"""TestPilot 后端应用组装入口。"""
from __future__ import annotations

import importlib
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.errors import install_error_handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.core.db import get_sessionmaker
    from app.core.eventbus import init_bus
    from app.modules.iam.bootstrap import run_bootstrap
    from app.modules.iam.registry_sync import sync_perm_points
    from app.modules.model_cfg.seed import schedule_startup_probe, seed_default_model

    init_bus()

    async with get_sessionmaker()() as db:
        result = await run_bootstrap(db)
        if result["printed_password"]:
            print("[bootstrap] 已创建系统管理员 admin，初始密码（仅打印一次，请立即修改）：" + result["printed_password"])
        await sync_perm_points(db)
        await seed_default_model(db)
    # 1E T8 §6.8「首次启动跑能力探测」：后台跑，网关不可达静默跳过，不阻塞启动
    schedule_startup_probe()
    yield


# 导入以触发 @service 注册（新增服务模块在此追加模块名）。
# 用 import_module 而不是函数体内的一串 `import app.modules.x`：后者会把局部名
# `app` 绑成 app 这个**包模块**，于是下面 `app = FastAPI(...)` 之前，mypy 眼里的
# app 已经是 Module——报出 8 条「Module has no attribute include_router」。
# 更糟的是读代码的人：函数体内那 20 行 import 与后面的 app 变量共用一个名字，
# 谁都不敢动顺序。模块名清单还让「漏 import = 路由静默 404」这件事一眼可查。
_SERVICE_MODULES = (
    "app.modules.api_test.case_services",
    # 1E T4 导入向导（§11.4.6）：preview/commit 两个 @service；importers.py 是纯函数不出路由。
    "app.modules.api_test.import_services",
    "app.modules.api_test.export_services",  # 1E T5 导出备份（api_export → OpenAPI3 往返自证）
    "app.modules.api_test.module_services",
    "app.modules.api_test.services",
    "app.modules.audit.services",
    "app.modules.env.services",
    "app.modules.env.group_services",
    "app.modules.execution.artifacts",
    "app.modules.execution.report_services",
    "app.modules.execution.services",
    "app.modules.iam.project_services",
    # D269：组织层（组织 CRUD / 成员 / 项目归属）。口径见 org_services 文件头。
    "app.modules.iam.org_services",
    "app.modules.iam.services",
    "app.modules.iam.user_services",
    # D37（1G）：自定义角色服务面（§11.4.21 从模板复制 + 权限菜单树裁剪 + 引用检测删除）。
    "app.modules.iam.role_services",
    "app.modules.model_cfg.services",
    # D265（二期）：MCP 服务登记/探测/启停（治理位仅系统管理员）。
    "app.modules.mcp.services",
    # D266（二期）：Skills 目录同步/启停/查看（治理位仅系统管理员）。
    "app.modules.skill.services",
    # D74（1G）：场景导出备份（scenario_export → 只读快照；HTTP 面照 api_export 的路径风格）。
    "app.modules.scenario.export_services",
    "app.modules.scenario.module_services",
    "app.modules.scenario.services",
    # composition 层：三路搜索正向读领域模型（契约 1 的正解）
    "app.modules.search.services",
    # D47-a（1G）：个人视图 CRUD + 高级搜索能力元数据。同住 search 的理由见该模块 docstring
    # （视图存的就是一份搜索条件；CRUD 只读写 saved_view 自己，不碰领域模型）。
    "app.modules.search.view_services",
    # D183（批次 B 第一刀，步 1）：测试计划本体 CRUD + 归档。
    "app.modules.testplan.services",
    # 1C：ui_test 的服务面。顺序无关（@service 只登记），但必须全 import——
    # 漏一个就是「路由不存在 404」而不是报错，测试只会看到 404，很容易误判成权限问题。
    "app.modules.ui_test.case_services",
    "app.modules.ui_test.debug_services",
    "app.modules.ui_test.element_services",
    "app.modules.ui_test.module_services",
    # 1D：adb_test 的服务面（§11.4.14 设备卡片墙 + R99 第四棵模块树）。心跳是 celery
    # 周期任务不住这里（app/worker.py 的任务体内 import）。
    "app.modules.adb_test.case_services",
    "app.modules.adb_test.debug_services",
    "app.modules.adb_test.device_services",
    "app.modules.adb_test.module_services",
    # 1E T2：notify 的服务面（§11.4.26 渠道 CRUD + 测试发送）。发送器是纯出站 I/O，
    # 只有这里 import 到服务层；自动通知的终态钩子归 T3（core 钩子注册表形状）。
    "app.modules.notify.service",
    # D191：缺陷域服务面（D190 裁定的 25 条可做端点：核心 CRUD/回收站/关联/评论/关注/导出）。
    "app.modules.defect.services",
    # D192：项目级元数据（模板 / 自定义字段 / 取号）；缺陷创建依赖它的两个内部服务。
    "app.modules.project_meta.services",
    # D193：功能用例本体 + 第 5 份模块树（模板/取号经 REGISTRY 调 project_meta）。
    "app.modules.functional.services",
    # D194：用例评审（评审/评审模块树/评审内用例与结论历史）。
    "app.modules.review.services",
    # D195：文件库/附件（元数据与链接；上传/下载走独立 router）。
    "app.modules.filelib.services",
    # D196：任务中心（run_record 观测、排队位次、停止与重跑；无新表）。
    "app.modules.taskcenter.services",
    # D198：个人中心 / API Key（自助资料、最近项目、我的资产、密钥）。
    "app.modules.iam.personal_services",
    # D199：项目应用开关 + 误报库。
    "app.modules.project_settings.services",
    # D201：API Mock（服务/规则；公开路由走独立 router）。
    "app.modules.mock.services",
    # D202：分享链接（公开只读路由走独立 router）。
    "app.modules.share.services",
    # D203：平台运维登记面（服务集成 / 资源池 / 插件 / 系统信息）。
    "app.modules.platform_ops.services",
    # 1E T1：schedule 的服务面（§11.4.17 定时任务 CRUD + 草稿 cron 预览）。读表调度器
    # 住 app/beat.py（beat 进程 import），fire 任务体住 app/worker.py——都不进本清单。
    "app.modules.schedule.service",
    # composition 层：工作台统计聚合（与 search 同族）
    "app.modules.workbench.services",
    # 1F T0：agent 元工具层（R146 手写注册，非 @service）——import 即 register_metatools()，
    # 与装饰器同一进程同一 REGISTRY；handler 骨架期抛 NotImplementedError（T1/T2 回填）。
    "app.modules.agent.metatools",
)

# readyz 单个依赖探测的超时线：探针总预算要远小于 compose/k8s 探针默认 timeoutSeconds
# （默认 5s），两个依赖串行各 2s 加请求开销仍在窗口内；卡死的依赖判 fail 而不是拖死探针。
READY_PROBE_TIMEOUT_S = 2.0


def create_app() -> FastAPI:
    for _name in _SERVICE_MODULES:
        importlib.import_module(_name)
    from app.core.service import (
        set_audit_writer,
        set_perms_resolver,
        set_report_notify_hook,
        set_run_finalized_hook,
    )
    from app.modules.audit import services as audit_services
    from app.modules.iam.project_services import perms_for_user
    from app.modules.notify import hooks as notify_hooks

    set_perms_resolver(perms_for_user)
    set_audit_writer(audit_services.record)
    # 1E T3：run 终态 → 通知（core 钩子注册表，set_audit_writer 同款形状——
    # core 只调钩子不认识 notify，契约 1 由 lint-imports 守着）。
    set_run_finalized_hook(notify_hooks.on_run_finalized)
    # D229：定时计划报告 → 通知渠道（同一套 core 钩子形状：core 只调钩子不认识 notify）。
    set_report_notify_hook(notify_hooks.on_report_notified)

    app = FastAPI(
        title="TestPilot",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    install_error_handlers(app)

    from app.core.db import get_db
    from app.core.service import build_router
    from app.modules.agent.routes import router as agent_router
    from app.modules.filelib.routes import build_file_router
    from app.modules.functional.routes import build_functional_router
    from app.modules.iam.deps import get_current_user
    from app.modules.iam.models import User
    from app.modules.iam.routes import router as iam_router
    from app.modules.mock.routes import build_mock_router
    from app.modules.scenario.routes import build_scenario_router
    from app.modules.share.routes import build_share_router

    app.include_router(iam_router, prefix="/api/v1")
    app.include_router(agent_router, prefix="/api/v1")
    # 场景 run SSE：依赖由装配层注入（契约 1：scenario 不许 import iam 的 get_current_user）
    app.include_router(
        build_scenario_router(get_db_dep=get_db, get_user_dep=get_current_user,
                              user_model=User), prefix="/api/v1"
    )
    # 文件上传/下载：multipart 与流式返回走不了注册表投影，依赖由装配层注入。
    app.include_router(
        build_file_router(get_db_dep=get_db, get_user_dep=get_current_user, user_model=User),
        prefix="/api/v1",
    )
    # 功能用例 Excel 导入/导出：multipart + 文件流同样走不了注册表投影（D205）。
    app.include_router(
        build_functional_router(get_db_dep=get_db, get_user_dep=get_current_user, user_model=User),
        prefix="/api/v1",
    )
    # Mock 公开入口不在 /api/v1 下：外部调用方要的是短 URL /mock/{service_id}/...
    app.include_router(build_mock_router(get_db_dep=get_db))
    # 分享公开读取：不需要用户，但要能读到目标数据
    app.include_router(build_share_router(get_db_dep=get_db), prefix="/api/v1")
    app.include_router(
        build_router(get_db_dep=get_db, get_user_dep=get_current_user, user_model=User), prefix="/api/v1"
    )

    @app.get("/api/v1/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # §6.10 readyz（MySQL/Redis/Qdrant 依赖探测）。**刻意与 healthz 同形走裸路由，不走
    # @service**：@service 的五合一注册面意味着权限位、审计写入、Agent 工具面——而探针
    # 三条都违逆：compose/k8s 探针不带 JWT（免鉴权是硬要求）；探针是高频调用，进审计表
    # 就是把健康检查刷成审计洪水；「你就绪了吗」也不该是 LLM 可调的工具。三者拆不开，
    # 所以和 healthz 一样裸着。
    # 每个探测带超时（asyncio.wait_for）：健康检查自己挂死比没有健康检查更糟——
    # 探针的语义是「限时给结论」，不是「等依赖恢复」，卡死的依赖必须被判 fail。
    # 任一依赖 fail → 抛 ApiError 走全局信封（{code,message,details}，与全仓错误体
    # 同形，不发明第二套），503 让 compose/k8s 探针直接可用；逐依赖状态在 details.deps。
    @app.get("/api/v1/readyz")
    async def readyz() -> dict[str, object]:
        import asyncio

        from sqlalchemy import text

        from app.core.db import get_sessionmaker
        from app.core.errors import ApiError
        from app.core.eventbus import get_bus

        deps: dict[str, str] = {}

        async def _mysql() -> None:
            # 轻量真探测：SELECT 1 走连接池（pool_pre_ping 之外再真发一帧），不碰业务表。
            async with get_sessionmaker()() as db:
                await db.execute(text("SELECT 1"))

        async def _redis() -> None:
            # 探 get_bus() 包装的那条真连接（进程运行时用的就是它），PING 为证。
            await get_bus().client.ping()

        for _name, _probe in (("mysql", _mysql), ("redis", _redis)):
            try:
                await asyncio.wait_for(_probe(), timeout=READY_PROBE_TIMEOUT_S)
                deps[_name] = "ok"
            except Exception:
                # 探测失败/超时都只说明「这个依赖此刻不可用」，不是本端点的 bug，
                # 不向上抛栈——逐依赖状态位才是探针要输出的事实。
                deps[_name] = "fail"

        # Qdrant：全仓后端代码 grep 零客户端、零配置（qdrant 字样只出现在
        # docker-compose.yml 的基建服务名与蓝图文档里，core/config.py 无对应项）。
        # 蓝图 §9.10 定一期降级为纯关键词路，向量路直到 1F 计划 D34 都无批次点名。
        # 探测一个不存在的东西只能造假 ok——诚实标 skipped；1F 真接入时连同探测实现
        # 与 tests/test_readyz.py 里钉这条形状的用例一起改。
        deps["qdrant"] = "skipped"

        failed = sorted(k for k, v in deps.items() if v == "fail")
        if failed:
            raise ApiError("not_ready", "依赖未就绪：" + "、".join(failed), 503, {"deps": deps})
        return {"status": "ok", "deps": deps}

    return app
