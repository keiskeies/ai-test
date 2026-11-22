"""1E T5 导出备份：接口集 → OpenAPI3 文档（§7.1 request 的逆映射）+ 落库查询服务面。

选 OpenAPI3 而不是私有 JSON（计划原文）：导出文件必须能被 T4 的解析器原样吃回，
私有格式 = 自证无门。所以本文件与 importers._parse_openapi_like 严格互逆——
- servers[0].url = 从 request.url 剥掉接口路径得到的基址（多接口取多数派，同键拼回）；
- params/headers → parameters 的 query/header 项（example 原样带值，importers 逐字读回）；
- body 的 json/form/text → requestBody 经 **components/schemas + 一层本地 $ref** 携带
  example（正是 importers._expand 认的形状，components 段是往返的一部分而不是装饰）；
- timeout_ms / assertions 在 OpenAPI 没有落点，走 `x-tp-timeout-ms` / `x-tp-assertions`
  扩展携带，importers._openapi_op 有对应的读回（没有那一处镜像，深比对必红）。

**未覆盖场景如实报**：
① Postman 导出**不做**（蓝图只说「导出备份」未定格式；单格式+往返自证 > 两格式都没自证）；
② 没有 request 的草稿接口不进文档，note 里点名；
③ url 与展示路径不同构（url 不以路径结尾）的接口：基址前缀能对上就以 url 为准拆路径
  （url 无损、展示路径有偏差），对不上就按文档基址改写 url——两种都逐条进 notes；
④ form 体是无转义 k=v&k=v 串，值里含 & 拆不回去，该接口整体如实报、不硬编；
⑤ JSON 体导出按规范序列化（json.dumps ensure_ascii=False，与 importers 同形），
  原文与规范串不等时逐条报——语义不变，字节可能整理空白。
"""
from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.api_test import importers, schemas
from app.modules.api_test.models import ApiDefinition
from app.shared.visibility import visible_clause

_PATH_PARAM_RE = re.compile(r"\{([^}/{}]+)\}")


def _canon(obj: Any) -> str:
    """与 importers 出口同一把尺：json.dumps(ensure_ascii=False)，往返字节才可能对得上。"""
    return json.dumps(obj, ensure_ascii=False)


def _split_base(url: str, path: str) -> str | None:
    """url 以接口路径结尾 → 剥出基址（importers 拼 url 时就是 base+path，逆运算即剥后缀）。

    基址不许带尾斜杠：servers[0].url 会被 `_openapi_base` rstrip('/')，带尾斜杠的基址
    拼回去差一个斜杠 = 静默有损，宁可不认（该条目走「接不进基址」的如实报分支）。
    """
    npath = importers.normalize_path(path)
    for suf in (path, npath):
        if suf.startswith("/") and url.endswith(suf):
            cand = url[: len(url) - len(suf)]
            if not cand.endswith("/"):
                return cand
    return None


def _form_pairs(content: str) -> list[tuple[str, str]] | None:
    """无转义 k=v&k=v 拆分（限制见模块头④）；值含 & 或键重复拆不回去 → None 如实报。"""
    pairs: list[tuple[str, str]] = []
    for seg in content.split("&"):
        if not seg:
            return None
        k, eq, v = seg.partition("=")
        if not eq or not k:
            return None
        pairs.append((k, v))
    if len({k for k, _ in pairs}) != len(pairs):  # 重复键：example 是对象，合并即有损
        return None
    return pairs


def _schema_key(method: str, path: str, used: set[str]) -> str:
    raw = re.sub(r"[^A-Za-z0-9.\-_]", "_", method + importers.normalize_path(path).replace("/", "_"))
    key, i = raw, 2
    while key in used:
        key, i = raw + "_" + str(i), i + 1
    used.add(key)
    return key


def _content_entry(body: dict[str, Any], skey: str, notes: list[str], where: str) -> tuple[str, dict[str, Any] | None]:
    """§7.1 body → (mime, components 里的 schema 条目) 三态：
    ("none", None)=无体不挂 requestBody；(mime, schema)=有体；("skip", None)=未导出（notes 已报）。"""
    btype = body.get("type", "none")
    raw = body.get("content")
    if not isinstance(raw, str):
        raw = None
    if btype == "json":
        if raw is None:
            return "application/json", {"title": skey, "type": "object"}
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            notes.append(f"{where}：json 体不是合法 JSON（不该发生），按 text 导出")
            return "text/plain", {"title": skey, "type": "string", "example": raw}
        if obj is None:
            notes.append(f"{where}：json 体是裸 null，components 的 example 表达不了 null，"
                         "往返后 body.content 将变为空（如实报）")
        elif _canon(obj) != raw:
            notes.append(f"{where}：json 体按规范序列化导出（语义不变，空白/键序可能整理）")
        return "application/json", {"title": skey, "example": obj}
    if btype == "form":
        if raw is None:
            return "application/x-www-form-urlencoded", {"title": skey, "type": "object"}
        if raw == "":
            return "application/x-www-form-urlencoded", {"title": skey, "example": {}}
        pairs = _form_pairs(raw)
        if pairs is None:
            notes.append(f"{where}：form 体含无法拆回 k=v&k=v 的值（如值内含 &），"
                         "该接口未导出（如实报，不硬编）")
            return "skip", None
        return "application/x-www-form-urlencoded", {"title": skey, "example": dict(pairs)}
    if btype == "text":
        if raw is None:
            return "text/plain", {"title": skey, "type": "string"}
        return "text/plain", {"title": skey, "example": raw}
    if btype != "none":
        notes.append(f"{where}：未知 body 类型 {btype}，按无体导出")
    return "none", None


def _operation(name: str, method: str, epath: str, req: dict[str, Any], skey: str,
               schema_out: dict[str, Any], notes: list[str], where: str) -> dict[str, Any] | None:
    """一个 §7.1 request → 一个 OpenAPI operation；None = 该条未导出（notes 已报）。"""
    params: list[dict[str, Any]] = [
        {"name": pn, "in": "path", "required": True, "schema": {"type": "string"}}
        for pn in _PATH_PARAM_RE.findall(epath)
    ]
    for pair in req.get("params") or []:
        params.append({"name": str(pair[0]), "in": "query", "example": str(pair[1])})
    for pair in req.get("headers") or []:
        params.append({"name": str(pair[0]), "in": "header", "example": str(pair[1])})
    raw_body = req.get("body")
    body: dict[str, Any] = raw_body if isinstance(raw_body, dict) else {}
    # 三态：("none", None)=无体不挂 requestBody；(mime, schema)=有体；("skip", None)=未导出
    mime, schema = _content_entry(body, skey, notes, where)
    if mime == "skip":
        return None
    op: dict[str, Any] = {
        "summary": name,  # importers 的名称首选 summary → 重导入名称不变
        "parameters": params,
        "responses": {"200": {"description": "导出占位：平台资产里没有响应结构可导"}},
    }
    if mime != "none" and schema is not None:
        # $ref 走 components（importers._expand 认的一层本地引用）——往返自证就吃这个形状
        schema_out[skey] = schema
        op["requestBody"] = {"content": {mime: {"$ref": "#/components/schemas/" + skey}}}
    tmo = req.get("timeout_ms")
    # x-tp-* 扩展：OpenAPI 没有这两个概念位，importers._openapi_op 逐字读回（互逆点）。
    op["x-tp-timeout-ms"] = tmo if isinstance(tmo, int) and not isinstance(tmo, bool) else 10000
    if isinstance(req.get("assertions"), list) and req["assertions"]:
        op["x-tp-assertions"] = req["assertions"]
    return op


def build_openapi_doc(entries: list[tuple[str, str, str, dict[str, Any]]]) -> tuple[dict[str, Any], list[str]]:
    """[(name, method, path, request §7.1)] → (OpenAPI3 文档, 人话 notes)。纯函数。"""
    notes: list[str] = []
    cands = [c for c in (_split_base(str(req.get("url") or ""), path)
                         for _n, _m, path, req in entries) if c]
    # 单文档只有一个 servers[0]：基址取多数派（并列取字典序，导出必须可复现）。
    base = sorted(Counter(cands).items(), key=lambda kv: (-kv[1], kv[0]))[0][0] if cands else "${base_url}"
    paths: dict[str, dict[str, Any]] = {}
    schemas_map: dict[str, Any] = {}
    used: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for name, method, path, req in entries:
        m = method.upper()
        url = str(req.get("url") or "")
        npath = importers.normalize_path(path)
        where = f"{m} {path}（{name}）"
        if url.startswith(base) and url[len(base):].startswith("/"):
            epath = url[len(base):]  # 基址是 url 前缀：路径键取后缀，base+epath 逐字还原 url
            if importers.normalize_path(epath) != npath:
                notes.append(f"{where}：展示路径与实际 URL 后缀不同构，导出以 URL 为准")
        else:
            epath = npath
            notes.append(f"{where}：实际 URL 接不进导出基址 {base}，导入后 url 将改写为 "
                         + base + npath + "（OpenAPI 单文档只有一个 servers[0]）")
        key = (m, importers.normalize_path(epath))
        if key in seen:
            notes.append(f"{where}：与已导出接口撞 method+归一路径 键，跳过重复条目")
            continue
        seen.add(key)
        skey = _schema_key(m, epath, used)
        op = _operation(name, m, epath, req, skey, schemas_map, notes, where)
        if op is None:
            continue
        paths.setdefault(epath, {})[m.lower()] = op
    if not paths:
        notes.append("paths 为空：没有任何接口进入文档（全为草稿、全部撞键或全部如实报未导出）")
    doc = {
        "openapi": "3.0.1",
        "info": {"title": "TestPilot 接口导出", "version": "1.0",
                 "description": "1E T5 导出备份：可被平台「导入」（OpenAPI3 源）原样吃回（往返自证）"},
        "servers": [{"url": base}],
        "paths": paths,
        "components": {"schemas": schemas_map},
    }
    return doc, notes


@service(
    perm="api:def:read",
    effect="read",
    name="api_export",
    description="导出备份（1E T5）：勾选/全量接口 → OpenAPI3 文档（§7.1 逆映射，可被导入向导"
                "原样吃回——往返自证）；读类动作故 perm 以 :read 结尾（POST 不影响 READONLY glob）；"
                "Postman 导出不做（未覆盖如实报）",
    http={"method": "POST", "path": "/api-export", "tags": ["api_test"], "status": 200},
    tool=False,
)
async def api_export(payload: schemas.ApiExportIn, ctx) -> schemas.ApiExportOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:read")
    assert ctx.db is not None
    stmt = select(ApiDefinition).where(
        ApiDefinition.project_id == payload.project_id,
        visible_clause(ApiDefinition, ctx),
        ApiDefinition.status != "recycled",
    )
    if payload.definition_ids is not None:
        if len(set(payload.definition_ids)) != len(payload.definition_ids):
            raise ApiError("validation_failed", "definition_ids 含重复 id", 422)
        stmt = stmt.where(ApiDefinition.id.in_(payload.definition_ids))
    rows = (await ctx.db.execute(stmt.order_by(ApiDefinition.id))).scalars().all()
    if payload.definition_ids is not None:
        missing = sorted(set(payload.definition_ids) - {r.id for r in rows})
        if missing:
            raise ApiError("not_found", "接口不存在、已回收或不可见：" + ", ".join(missing), 404,
                           {"definition_ids": missing})
    entries: list[tuple[str, str, str, dict[str, Any]]] = []
    notes: list[str] = []
    for r in rows:
        if not isinstance(r.request, dict):
            notes.append("「" + r.name + "」没有请求（草稿），未导出（如实报）")
            continue
        entries.append((r.name, r.method, r.path, r.request))
    doc, doc_notes = build_openapi_doc(entries)
    return schemas.ApiExportOut(openapi=doc, exported=len(entries), notes=notes + doc_notes)
