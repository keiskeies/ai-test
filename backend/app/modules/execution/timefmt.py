"""执行域共用小件：表名 join 与时间格式化。

单独成文件的理由和 execution 其它部分一样：契约 4 不许 import 别的领域模块，
而 run_record_list（运行记录页）与 report_*（报告中心）两半都要用同一个
app_user 表名 join 与同一个 ISO 口径。放任何一半里都会让另一半反过来 import 它，
所以抽成第三个小文件，两边正向依赖它。
"""
from __future__ import annotations

from sqlalchemy.sql import column, table

# 表名 join（不 import iam.models）：契约 4 要求执行核的依赖闭包最小
APP_USER = table("app_user", column("id"), column("name"))


def iso_dt(dt) -> str | None:
    """naive UTC datetime → ISO 字符串；None 透传（前端画「-」）。"""
    return dt.isoformat() if dt is not None else None
