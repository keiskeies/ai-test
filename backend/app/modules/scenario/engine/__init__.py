"""执行引擎（1B）：沙箱、上下文、handler 注册表、runner。

本包不做 __init__ 聚合导出：引擎依赖 handler 注册表，聚合导入会让「只校验
step_graph」的场景保存路径白加载执行依赖。
"""
