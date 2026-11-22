"""workbench composition 包。

D39（§6.8 用量统计）：`model_usage` 的 @service 注册挂在这里——同包的
`workbench.services` 已在 main.py 的 _SERVICE_MODULES 在册，import 子模块必然先执行
本文件，注册即随之发生（importlib 幂等：mainline 日后把
"app.modules.workbench.model_usage" 正式补进 _SERVICE_MODULES 也不会二次注册）。
main.py 在并发期归主线独占，本行就是为绕开那次冲突而留的同效钩子。
"""
from app.modules.workbench import model_usage as model_usage  # noqa: F401  (@service 注册副作用)
