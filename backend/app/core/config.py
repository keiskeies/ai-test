"""应用配置：环境变量前缀 TP_，.env 可选。

# 路径口径（1C 实测缺陷）：配置里的**相对**路径一律相对**仓库根**，不相对启动目录。
# 理由不是审美。三份 demo 手册教的起法都是 `cd backend; uvicorn app.server:app`
# （README-1a-demo.md:68 / README-1b-demo.md:74 / README-s0-demo.md:51），而
# `artifacts_dir` 与 `env_file` 写的都是仓库根相对的写法（`backend/data/artifacts`、
# `.env`）——同一个配置在 CWD=backend 下会指到 `backend/backend/data/artifacts`，
# 在 CWD=仓库根下 `.env` 又静默读不到（读不到不报错，只是所有键回落代码默认值）。
# 制品 ref 在库里存的是相对根的路径，所以 server 与 worker 只要启动目录不同，
# 就是「worker 写字节、server 读不到」——这不是磁盘整洁问题，是执行链正确性问题。
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# app/core/config.py → parents[2] = backend/；REPO_ROOT 再上一级。用 __file__ 反推，
# 与启动目录彻底无关（这是本模块唯一的路径锚点，别处不要再自己拼）。
BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent


def resolve_repo_path(value: str | Path) -> Path:
    """配置值 → 绝对路径。绝对值原样尊重（生产把制品指到数据盘是正路），
    相对值按仓库根解析——**永不**按当前工作目录解析。"""
    p = Path(value)
    return p.resolve() if p.is_absolute() else (REPO_ROOT / p).resolve()


class Settings(BaseSettings):
    # env_file 必须是绝对路径：相对写法等于「从哪个目录启动就读哪个 .env」，
    # 读不到时 pydantic 不报错，只把 TP_SECRET_KEY 这些静默换成代码默认值。
    model_config = SettingsConfigDict(
        env_prefix="TP_",
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "dev"
    db_url: str = "mysql+asyncmy://root:root@127.0.0.1:3306/testpilot?charset=utf8mb4"
    redis_url: str = "redis://127.0.0.1:6379/0"
    secret_key: str = "insecure-dev-secret-key-change-me"
    # Fernet 主密钥：留空时由 secret_key 派生（仅开发方便；生产必须显式注入）
    fernet_key: str = ""
    bootstrap_account: str = "admin"
    bootstrap_password: str = ""
    model_seed_base_url: str = "http://127.0.0.1:9000/v1"
    model_seed_name: str = "fundgpt-coder-next"
    model_seed_api_key: str = ""
    artifacts_dir: str = "backend/data/artifacts"
    # §8.8 的 64KB 线：单条 detail 超阈值的大字段外置为制品文件，DB 只存 ref+head
    artifact_max_bytes: int = 65536
    agent_max_tool_calls: int = 25
    # §3.4 认证线：access 2h + refresh 7d。默认值直接写蓝图口径。
    jwt_ttl_hours: int = 2
    refresh_ttl_days: int = 7
    # R42：执行链默认走 Celery worker（D5）。inline 只供 pytest 与「不开 worker 的单机演示」，
    # 跑的是同一份引擎；把它当默认交付会让「真走 worker」变成空话。broker 不可达一律
    # 503 executor_unavailable，不静默降级。
    exec_mode: Literal["celery", "inline"] = "celery"
    # §8.2：场景执行全局超时默认（场景未单独配置时用它）
    max_runtime_default_ms: int = 1_800_000
    # ── 1C UI 执行（§6.3）────────────────────────────────────────────────
    # 默认无头是 D4 裁决的落地：worker 是否在桌面会话里跑不由平台决定，所以界面
    # 完全不出现「有头」字样，只留这条配置——给一个点了没反应的按钮就是假按钮。
    ui_headless: bool = True
    # §6.3：信号量限并发默认 4。UI 用例各占一个 page，超并发只会互相抢 CPU。
    ui_concurrency: int = 4
    # 单条命令默认超时，对齐 §7.2 示例的 10000；命令自己带 timeout_ms 时以命令为准。
    ui_command_timeout_ms: int = 10_000
    # 整条 UI 用例的默认上限。一条 UI 用例比一次 HTTP 慢两个量级，5 分钟是
    # 「跑得完又能及早掐断」的位置，不是从 max_runtime_default_ms 抄下来的。
    ui_default_max_runtime_ms: int = 300_000
    # 离线退路（前置取证 3 实测：channel="chrome"/"msedge" 在本机可用）。
    # 留空 = 用 playwright 自带 chromium；装不上浏览器的主机填 chrome 或 msedge。
    ui_browser_channel: str = ""
    # ── 1D ADB 测试（§5.4 / §6.4，前置取证 4 实测本机 adb 不在 PATH）────────────
    # 留空 = 依次找 PATH 里的 adb、Android SDK 常见路径；找不到 → 设备服务返
    # **人话错误**（给安装指引），不装死、不假在线。假设备 fixture 测试也走这条
    # 解析（它们注入自己的 fake adb 路径），所以「二进制缺位」必须像 1C 那样响亮。
    adb_path: str = ""
    # 单步默认超时：与 adb_core.run_adb 的 timeout_ms 默认同值（步骤 config 里带
    # timeout_ms 者以步骤为准）——集中一处，端点不各自手抄 10000。
    adb_command_timeout_ms: int = 10_000
    # 整条 ADB 用例默认上限（ui_default_max_runtime_ms 同量级：设备操作慢于 HTTP、
    # 快于场景；run_record.max_runtime_ms 为空时用它兜底）。
    adb_default_max_runtime_ms: int = 300_000

    @property
    def task_queue(self) -> str:
        """Celery 队列名按 env 分道（D10 / R118 的根治，1D T0）。

        来历：pytest 的 golden、e2e、verify_worker 与「演示用的常驻 worker」以前共用
        Redis DB6 的**默认队列**——谁先起谁就能领走别人的任务：演示 worker 领走 golden
        投的 run，在**另一套库**上跑一个测试根本不认识的场景，测试这边永远 queued 到超时
        （R118 实测 `last=queued`；R127 收尾取证时又踩一次）。手册里那句「跑门禁前先确认
        没有常驻 worker」是止痛药不是治疗——人会忘，队列名不会。

        口径：投递方（send_task 的 queue=）与消费方（worker 的 task_default_queue）都
        **从自己的 settings.env 推导**，同一条纯函数。dev/test/e2e/verify 四道各领各的：
        手起的 dev 演示 worker 从此**物理上看不见** test/e2e 投的任务，而不是靠没人抢。
        """
        return "tp." + self.env


@lru_cache
def get_settings() -> Settings:
    return Settings()
