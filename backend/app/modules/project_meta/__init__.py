"""项目级元数据域（D192）：模板 / 自定义字段 / 跨域取号。

模板与字段同时服务缺陷、功能用例、接口、UI、测试计划（MS TemplateScene 五值）；
取号器被缺陷/用例/计划共用。定义归本域，值表归各业务域（`defect_custom_field` 等）。
零横向 import：本域不 import 任何领域模块；引用检查走表名反射（defect / defect_custom_field）。
"""
