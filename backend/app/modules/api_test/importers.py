"""1E T4 导入解析三源（OpenAPI3 / Swagger2 / Postman）→ §7.1 请求对象。

纯函数、stdlib json、**永不抛**：每源一个 `parse_*(text) -> ParseOutcome`，
一切失败模式（坏 JSON / 缺 paths / 外部 $ref / Postman 嵌套 folder）都收成
人话中文进 `errors[]`。冲突比对与落库不在这里（那是 service 层，见 import_services）。

request 对象是 §7.1 的 S0 子集（与 schemas.RequestObject 逐字段对齐：
method/url/params/headers/body/timeout_ms/assertions）——T5 导出要把paths/components
逆映射回 OpenAPI3，所以 path 的占位语法原样保留、method 大写、body 只有 json/text/form。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

_METHODS = ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")
_METHOD_SET = set(_METHODS)


@dataclass
class ImportItem:
    """一条待导入接口：name/method/path 供冲突比对，request 为 §7.1 形状。"""

    name: str
    method: str
    path: str
    request: dict[str, Any]
    source_ref: str = ""  # 人话溯源：operationId / Postman item 路径 / METHOD path


@dataclass
class ParseOutcome:
    items: list[ImportItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# —————————————————————— 公共小件 ——————————————————————

def _load(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """坏 JSON / 空文 / 顶层非对象 → (None, 人话)。调用方负责把错误进 errors。"""
    if not text or not text.strip():
        return None, "内容为空：粘贴 JSON 文本或提供 URL"
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        return None, f"不是合法 JSON：{e.msg}（第 {e.lineno} 行第 {e.colno} 列）"
    if not isinstance(obj, dict):
        return None, "顶层必须是 JSON 对象（文档根），收到 " + type(obj).__name__
    return obj, None


def normalize_path(path: str) -> str:
    """占位语法归一：`/order/:id` 与 `/order/{id}` 比出同一个键（§11.4.6 冲突比对键）。"""
    segs: list[str] = []
    for seg in path.split("/"):
        if seg.startswith(":") and len(seg) > 1:
            segs.append("{" + seg[1:] + "}")
        else:
            segs.append(seg)
    out = "/".join(segs)
    if len(out) > 1:
        out = out.rstrip("/")
    return out if out.startswith("/") else "/" + out


def _lookup_ref(ref: str, root: dict[str, Any]) -> Any:
    """只认 `#/a/b/c` 形式的本地 JSON Pointer；认不出 → None。"""
    node: Any = root
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node


def _expand(node: Any, root: dict[str, Any], errors: list[str], where: str, *, depth: int = 0) -> Any:
    """example 取值处展开**一层**本地 $ref；外部 ref 如实报「不支持的外部引用」不猜。"""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            if not ref.startswith("#"):
                errors.append(f"{where}：不支持的外部引用 {ref}（只展开本文档内 #/ 本地引用，该字段已忽略）")
                return {}
            if depth >= 1:
                errors.append(f"{where}：本地引用嵌套超过一层 {ref}（只做一层展开，已忽略更深层）")
                return {}
            target = _lookup_ref(ref, root)
            if target is None:
                errors.append(f"{where}：本地引用找不到目标 {ref}（已忽略）")
                return {}
            return _expand(target, root, errors, where, depth=depth + 1)
        return {k: _expand(v, root, errors, where, depth=depth) for k, v in node.items()}
    if isinstance(node, list):
        return [_expand(v, root, errors, where, depth=depth) for v in node]
    return node


def _sample_from_schema(schema: Any) -> Any:
    """从（已展开一层的）schema 收集示例值：只取现成的 example/default，不编值。"""
    if not isinstance(schema, dict):
        return None
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    props = schema.get("properties")
    if isinstance(props, dict) and props:
        obj: dict[str, Any] = {}
        for name, sub in props.items():
            v = _sample_from_schema(sub)
            if v is not None:
                obj[name] = v
        return obj or None
    if isinstance(schema.get("items"), dict):
        v = _sample_from_schema(schema["items"])
        return [v] if v is not None else None
    return None


def _example_of_media(media: Any, root: dict[str, Any], errors: list[str], where: str) -> Any:
    """media 对象（{example?, schema?}）→ 示例值：优先 example，其次 schema.example/properties。"""
    if not isinstance(media, dict):
        return None
    if "example" in media:
        return _expand(media["example"], root, errors, where)
    return _sample_from_schema(_expand(media.get("schema"), root, errors, where))


def _request_obj(method: str, url: str, *, params: list[list[str]], headers: list[list[str]],
                 body: dict[str, Any] | None) -> dict[str, Any]:
    """§7.1 S0 子集的统一出口——三源都汇到这里，形状只有一份。"""
    req: dict[str, Any] = {
        "method": method.upper(), "url": url,
        "params": params, "headers": headers,
        "body": body or {"type": "none"},
        "timeout_ms": 10000, "assertions": [],
    }
    return req


def _pair_list(items: Any, key: str, where: str, errors: list[str]) -> list[list[str]]:
    """parameters/headers 的 [{name,in,value|example}] → [[k,v]]；坏条目报人话。"""
    out: list[list[str]] = []
    if items is None:
        return out
    if not isinstance(items, list):
        errors.append(f"{where}：{key} 应为数组，收到 {type(items).__name__}（已忽略）")
        return out
    for p in items:
        # Postman 用 key，OpenAPI/Swagger 用 name——两处都认
        if isinstance(p, dict) and isinstance(p.get("name") or p.get("key"), str):
            v = p.get("value", p.get("example"))
            if v is None and isinstance(p.get("schema"), dict):
                v = _sample_from_schema(p["schema"])
            out.append([str(p.get("name") or p.get("key")), "" if v is None else str(v)])
        else:
            errors.append(f"{where}：{key} 里有条目缺 name，已忽略")
    return out


# —————————————————————— OpenAPI 3 ——————————————————————

def _openapi_base(doc: dict[str, Any]) -> str:
    servers = doc.get("servers")
    if isinstance(servers, list) and servers and isinstance(servers[0], dict):
        u = str(servers[0].get("url") or "")
        if u:
            return u.rstrip("/")
    return "${base_url}"  # 无 servers：留平台变量位，导入后可编辑（不编造绝对域名）


def _content_body(content: Any, root: dict[str, Any], errors: list[str], where: str) -> dict[str, Any]:
    """OpenAPI/Swagger 的 content map → §7.1 body（json/text/form；示例值取一层展开后的）。"""
    if not isinstance(content, dict):
        return {"type": "none"}
    if "application/json" in content:
        ex = _example_of_media(content["application/json"], root, errors, where)
        return {"type": "json", "content": json.dumps(ex, ensure_ascii=False) if ex is not None else None}
    if "application/x-www-form-urlencoded" in content:
        ex = _example_of_media(content["application/x-www-form-urlencoded"], root, errors, where)
        if isinstance(ex, dict):
            return {"type": "form", "content": "&".join(f"{k}={v}" for k, v in ex.items())}
        return {"type": "form", "content": None}
    for mime, media in content.items():
        if isinstance(media, dict) and (mime.startswith("text/") or mime == "application/xml"):
            ex = _example_of_media(media, root, errors, where)
            return {"type": "text", "content": None if ex is None else str(ex)}
    return {"type": "none"}


def _parse_openapi_like(text: str, *, v3: bool) -> ParseOutcome:
    """OpenAPI3 与 Swagger2 的 paths 部分同构，只差 base 与 requestBody/parameters 形状。"""
    out = ParseOutcome()
    doc, err = _load(text)
    if err is not None or doc is None:  # 双保险成对出现（_load 的契约），分开写会让 mypy 留 None
        out.errors.append(err or "内容无法解析")
        return out
    if v3 and not str(doc.get("openapi", "")).startswith("3"):
        out.errors.append("不是 OpenAPI3 文档：缺 openapi: 3.x 版本字段")
        return out
    if not v3 and str(doc.get("swagger", "")) != "2.0":
        out.errors.append("不是 Swagger2 文档：缺 swagger: \"2.0\" 字段")
        return out
    base = _openapi_base(doc) if v3 else _swagger2_base(doc)
    paths = doc.get("paths")
    if paths is None:
        out.errors.append("文档缺 paths 字段：没有任何接口可导入")
        return out
    if not isinstance(paths, dict):
        out.errors.append("paths 应为对象，收到 " + type(paths).__name__)
        return out
    if not paths:
        out.errors.append("paths 为空对象：文档里一个接口都没有")
        return out
    for raw_path, item in paths.items():
        where = f"paths[{raw_path}]"
        if not isinstance(item, dict):
            out.errors.append(f"{where}：路径项应为对象，已忽略")
            continue
        raw_shared = item.get("parameters")
        shared: list[Any] = raw_shared if isinstance(raw_shared, list) else []
        for method, op in item.items():
            if method.upper() not in _METHOD_SET:
                continue  # parameters/servers/$ref 等非操作键
            if not isinstance(op, dict):
                out.errors.append(f"{where}.{method}：操作应为对象，已忽略")
                continue
            _openapi_op(out, doc, base, str(raw_path), method.upper(), op, shared, v3)
    return out


def _openapi_op(out: ParseOutcome, root: dict[str, Any], base: str, path: str, method: str,
                op: dict[str, Any], shared_params: list[Any], v3: bool) -> None:
    where = f"{method} {path}"
    params: list[list[str]] = []
    headers: list[list[str]] = []
    # 路径级 + 操作级 parameters 合并（Swagger2 的 body/formData 走单独通道）
    body: dict[str, Any] | None = None
    for p in [x for x in shared_params if isinstance(x, dict)] + \
             [x for x in (op.get("parameters") or []) if isinstance(x, dict)]:
        p = _expand(p, root, out.errors, where)
        loc, nm = p.get("in"), p.get("name")
        if loc == "query" and isinstance(nm, str):
            v = p.get("value", p.get("example"))  # Swagger2: value；OpenAPI3: 顶层 example
            if v is None:
                v = _sample_from_schema(p.get("schema") or p.get("items"))
            if v is None:
                v = p.get("default")  # Swagger2 把默认值直接挂在参数上
            params.append([nm, "" if v is None else str(v)])
        elif loc == "header" and isinstance(nm, str):
            v = p.get("value", p.get("example"))
            if v is None:
                v = _sample_from_schema(p.get("schema"))
            if v is None:
                v = p.get("default")
            headers.append([nm, "" if v is None else str(v)])
        elif loc == "body":  # Swagger2 的 body 参数
            ex = _sample_from_schema(_expand(p.get("schema"), root, out.errors, where))
            body = {"type": "json", "content": json.dumps(ex, ensure_ascii=False) if ex is not None else None}
        elif loc == "formData":  # Swagger2 表单：schema 或 参数自带的 name+default 都收
            ex = _sample_from_schema(_expand(p.get("schema"), root, out.errors, where))
            if not isinstance(ex, dict):
                v = p.get("default", p.get("example"))
                ex = {str(nm): v} if v is not None else None
            body = ({"type": "form", "content": "&".join(f"{k}={v}" for k, v in ex.items())}
                    if isinstance(ex, dict) and ex else {"type": "form", "content": None})
    if v3 and isinstance(op.get("requestBody"), dict):
        rb = _expand(op["requestBody"], root, out.errors, where)
        body = _content_body(rb.get("content"), root, out.errors, where)
    name = str(op.get("summary") or op.get("operationId") or f"{method} {path}")
    req = _request_obj(method, base + path, params=params, headers=headers, body=body)
    # T5 导出往返：timeout_ms/assertions 在 OpenAPI 没有概念位，导出端用 x-tp-* 扩展携带，
    # 这里逐字读回——删掉这两行镜像，导出→导入的 §7.1 深比对必红（test_api_export 钉住）。
    tmo = op.get("x-tp-timeout-ms")
    if isinstance(tmo, int) and not isinstance(tmo, bool) and 1 <= tmo <= 120000:
        req["timeout_ms"] = tmo
    assertions = op.get("x-tp-assertions")
    if isinstance(assertions, list) and assertions:
        req["assertions"] = assertions
    out.items.append(ImportItem(
        name=name[:200], method=method, path=path,
        request=req,
        source_ref=str(op.get("operationId") or where),
    ))


def parse_openapi3(text: str) -> ParseOutcome:
    return _parse_openapi_like(text, v3=True)


def parse_swagger2(text: str) -> ParseOutcome:
    return _parse_openapi_like(text, v3=False)


def _swagger2_base(doc: dict[str, Any]) -> str:
    host = str(doc.get("host") or "")
    base_path = str(doc.get("basePath") or "")
    schemes = doc.get("schemes")
    scheme = str(schemes[0]) if isinstance(schemes, list) and schemes else "http"
    if not host:
        return "${base_url}" + (base_path if base_path != "/" else "")
    return f"{scheme}://{host}" + (base_path.rstrip("/") if base_path != "/" else "")


# —————————————————————— Postman（v2.0/v2.1 与 v1，item[] 递归）——————————————————————

def _postman_version(doc: dict[str, Any]) -> str:
    info = doc.get("info")
    schema = info.get("schema", "") if isinstance(info, dict) else ""
    if "v2.1" in str(schema):
        return "v2.1"
    if "v2.0" in str(schema):
        return "v2.0"
    # v1 没有 info.schema（老导出有 id/order 这类顶层键）
    if isinstance(doc.get("item"), list):
        return "v1"
    return "unknown"


def _url_path(raw: str) -> str:
    """完整 URL → 路径部分：去 scheme://host、去 query；{{var}} 主机前缀也剥掉。"""
    rest = raw
    if "://" in rest:
        rest = rest.split("://", 1)[1]
        rest = "/" + rest.split("/", 1)[1] if "/" in rest else "/"
    qpos = rest.find("?")
    if qpos >= 0:
        rest = rest[:qpos]
    # {{baseUrl}}/orders → /orders：占位主机段不进冲突键（真实主机进 §7.1 的 url 字段）
    if rest.startswith("{{"):
        end = rest.find("}}")
        if end >= 0:
            rest = rest[end + 2:]
    return rest if rest.startswith("/") else "/" + rest


def _postman_url(url: Any) -> tuple[str, list[list[str]], str]:
    """Postman url（串或对象）→ (冲突路径, query [[k,v]], 原始串)。{{var}} 原样保留。"""
    raw = ""
    pairs: list[list[str]] = []
    if isinstance(url, str):
        raw = url
    elif isinstance(url, dict):
        raw = str(url.get("raw") or "")
        q = url.get("query")
        if isinstance(q, list):
            pairs = [[str(x.get("key", "")), str(x.get("value", ""))]
                     for x in q if isinstance(x, dict) and x.get("key")]
    if not pairs:
        qs = raw.split("?", 1)[1] if "?" in raw else ""
        pairs = [kv.split("=", 1) + [""] for kv in qs.split("&") if kv] if qs else []
    return _url_path(raw), [[k, v] for k, v in pairs], raw


def _postman_body(body: Any, errors: list[str], where: str) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"type": "none"}
    mode = body.get("mode")
    if mode == "raw":
        raw = str(body.get("raw") or "")
        lang = str((body.get("options") or {}).get("raw", {}).get("language", "")) if isinstance(body.get("options"), dict) else ""
        if lang == "json" or (raw[:1] in "{["):
            try:
                json.loads(raw) if raw else None
                return {"type": "json", "content": raw or None}
            except json.JSONDecodeError:
                errors.append(f"{where}：raw 体标称 JSON 但解析失败，按 text 导入")
        return {"type": "text", "content": raw or None}
    if mode == "urlencoded":
        pairs = body.get("urlencoded")
        cells = [f"{x.get('key')}={x.get('value', '')}" for x in pairs
                 if isinstance(x, dict) and x.get("key")] if isinstance(pairs, list) else []
        return {"type": "form", "content": "&".join(cells) if cells else None}
    if mode == "formdata":
        pairs = body.get("formdata")
        cells = [f"{x.get('key')}={x.get('value', '')}" for x in pairs
                 if isinstance(x, dict) and x.get("key") and x.get("type") != "file"] if isinstance(pairs, list) else []
        if isinstance(pairs, list) and any(isinstance(x, dict) and x.get("type") == "file" for x in pairs):
            errors.append(f"{where}：formdata 含文件字段，一期 body.files 未开，文件字段已忽略")
        return {"type": "form", "content": "&".join(cells) if cells else None}
    if mode in (None, ""):
        return {"type": "none"}
    errors.append(f"{where}：不支持的 body 模式 {mode}（按无体导入）")
    return {"type": "none"}


def _postman_walk(out: ParseOutcome, items: Any, trail: str, root_name: str) -> None:
    """item[] 递归：folder 是带子 item[] 的节点；坏节点报人话进 errors。"""
    if not isinstance(items, list):
        out.errors.append(f"{trail or root_name or '集合'}：item 应为数组，收到 {type(items).__name__}（该层已跳过）")
        return
    for node in items:
        if not isinstance(node, dict):
            out.errors.append(f"{trail or '集合'}：folder 里有条目不是对象，已忽略")
            continue
        name = str(node.get("name") or "(未命名)")
        where = f"{trail}{trail and ' / '}{name}"
        if isinstance(node.get("item"), list):  # folder：递归进去
            _postman_walk(out, node["item"], where, root_name)
            continue
        req = node.get("request")
        if req is None:
            out.errors.append(f"{where}：条目没有 request 字段，已忽略")
            continue
        if isinstance(req, str):
            req = {"method": "GET", "url": req}
        if not isinstance(req, dict):
            out.errors.append(f"{where}：request 应为对象或 URL 串，收到 {type(req).__name__}，已忽略")
            continue
        method = str(req.get("method") or "GET").upper()
        if method not in _METHOD_SET:
            out.errors.append(f"{where}：不支持的 HTTP 方法 {method}，已忽略")
            continue
        path, params, raw_url = _postman_url(req.get("url"))
        headers = _pair_list(req.get("header"), "header", where, out.errors)
        out.items.append(ImportItem(
            name=name[:200], method=method, path=path or "/",
            request=_request_obj(method, raw_url or path, params=params, headers=headers,
                                 body=_postman_body(req.get("body"), out.errors, where)),
            source_ref=f"{root_name} / {where}" if root_name else where,
        ))


def parse_postman(text: str) -> ParseOutcome:
    out = ParseOutcome()
    doc, err = _load(text)
    if err is not None or doc is None:  # 双保险成对出现（_load 的契约），分开写会让 mypy 留 None
        out.errors.append(err or "内容无法解析")
        return out
    version = _postman_version(doc)
    if version == "unknown":
        out.errors.append("不是可识别的 Postman 集合（缺 v2.0/v2.1 的 info.schema，也没有 v1 的 item[]）")
        return out
    raw_info = doc.get("info")
    info: dict[str, Any] = raw_info if isinstance(raw_info, dict) else {}
    root_name = str(info.get("name") or doc.get("name") or "")
    _postman_walk(out, doc.get("item"), "", root_name)
    if not out.items and not out.errors:
        out.errors.append("集合里没有任何带 request 的条目")
    return out
