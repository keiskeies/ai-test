// e2e 共用件：造数据走 API，UI 只验 UI；AntD 下拉的 a11y 隐藏 listbox 会骗过 role=option。
import { expect, request as pwRequest } from "@playwright/test";
import { E2E_DB_URL } from "./dbEnv.mjs";

export const BASE = "http://127.0.0.1:8321/api/v1";
export const ADMIN = { account: "admin", password: "E2e@Pass123" };

/** 建一个专属项目并把登录态注进浏览器：每个用例自己的数据，互不污染。 */
export async function seedProject(page, label) {
  const ctx = await pwRequest.newContext({ baseURL: BASE + "/" });
  const lr = await ctx.post("auth/login", { data: ADMIN });
  expect(lr.ok()).toBeTruthy();
  const token = (await lr.json()).token;
  const pr = await ctx.post("projects", {
    data: { name: label + "-" + Date.now().toString(36) },
    headers: { Authorization: "Bearer " + token },
  });
  expect(pr.ok()).toBeTruthy();
  const project = await pr.json();
  await ctx.dispose();
  await page.addInitScript(([t, pj]) => {
    localStorage.setItem("tp_token", t);
    localStorage.setItem("tp_project", JSON.stringify(pj));
  }, [token, project]);
  return { token, projectId: project.id, project };
}

/** 带身份直连后端核对事实（UI 显示绿了不算，库里得真有一条）。 */
export async function asUser(token, method, path, opts = {}) {
  if (!["get", "post", "patch", "delete", "put"].includes(method)) throw new Error("unsupported method: " + method);
  const ctx = await pwRequest.newContext({
    baseURL: BASE + "/", extraHTTPHeaders: { Authorization: "Bearer " + token },
  });
  // newContext() 返回的就是请求上下文本身，没有再下一层的 .request
  const r = await ctx[method](path, opts);
  const body = await r.json().catch(() => null);
  await ctx.dispose();
  return { status: r.status(), ok: r.ok(), body };
}

/**
 * 选 AntD Select 的项：只点浮层里真正可见的那一项。
 * rc-select 在输入框内部还藏了一份 role=listbox 的无障碍副本，
 * getByRole("option") 会先命中那份隐藏节点并一直等可见。
 */
export async function pickOption(page, name) {
  // 连着开两个下拉时，上一个仍在退场动画里（class 是 slide-up-leave，并不带 hidden），
  // 严格模式下会撞到两个浮层 → 取最后打开的那个
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last();
  await expect(dropdown).toBeVisible();
  await dropdown.locator(".ant-select-item-option").filter({ hasText: name }).first().click();
}

/**
 * ISO（带或不带偏移）→ 东八区墙钟 `YYYY-MM-DD HH:mm:ss`。
 *
 * **故意在 e2e 里独立实现，不 import src/shared/timefmt**：被测件和预期值不能共用
 * 同一条换算路径，否则换算整个写错时两边一起错、断言照样绿（ledger R68 就是这么漏的：
 * 当时页面 `slice(0,19)` 截断画 UTC 钟点，而断言是形状正则 `/^\d{4}-\d{2} \d{2}:\d{2}:\d{2}$/`，
 * 早 8 小时完全测不出来）。这里钉死具体钟点，UTC 03:24 与东八区 11:24 只能选一个。
 * Asia/Shanghai 自 1991 年起无夏令时，固定 +08:00 与 Intl 的 timeZone 换算等价。
 */
export function wallClock(iso) {
  const s = String(iso).trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s + "Z");
  if (Number.isNaN(d.getTime())) throw new Error("bad iso: " + iso);
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    + ` ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * 以「项目内另一种角色」的身份进入浏览器：管理员建项目 → 建用户 → 挂角色 → 用新身份登录。
 * 返回的 project 是按该身份重新 GET 过的，因此 my_perms 就是他真实的生效权限——
 * 按钮显隐的用例必须拿服务端下发的那份，而不是前端猜的。
 */
export async function seedMember(page, label, role, account) {
  const ctx = await pwRequest.newContext({ baseURL: BASE + "/" });
  const lr = await ctx.post("auth/login", { data: ADMIN });
  expect(lr.ok()).toBeTruthy();
  const adminToken = (await lr.json()).token;
  const H = { Authorization: "Bearer " + adminToken };

  const pr = await ctx.post("projects", {
    data: { name: label + "-" + Date.now().toString(36) }, headers: H,
  });
  expect(pr.ok()).toBeTruthy();
  const projectId = (await pr.json()).id;

  const acct = account + "_" + Date.now().toString(36).slice(-5);
  const ur = await ctx.post("system/users", {
    data: { account: acct, name: "成员" + role, password: "Member@123" }, headers: H,
  });
  expect(ur.ok()).toBeTruthy();
  const userId = (await ur.json()).id;

  const mr = await ctx.put("projects/" + projectId + "/members/" + userId, {
    data: { role_code: role },
    headers: { ...H, "Content-Type": "application/json" },
  });
  expect(mr.ok(), "挂角色失败: " + JSON.stringify(await mr.json())).toBeTruthy();

  const lr2 = await ctx.post("auth/login", { data: { account: acct, password: "Member@123" } });
  expect(lr2.ok()).toBeTruthy();
  const token = (await lr2.json()).token;
  const H2 = { Authorization: "Bearer " + token };
  // 该身份视角下的项目（含服务端下发的 my_perms）
  const prj = await ctx.get("projects/" + projectId, { headers: H2 });
  expect(prj.ok()).toBeTruthy();
  const project = await prj.json();
  await ctx.dispose();

  await page.addInitScript(([tk, pj]) => {
    localStorage.setItem("tp_token", tk);
    localStorage.setItem("tp_project", JSON.stringify(pj));
  }, [token, project]);
  return { token, projectId, project, userId, account: acct };
}


/**
 * 直插一条 run_record（+ 可选步骤行与 SCREENSHOT 制品文件）。
 *
 * 为什么存在：1C 的 UI **执行**（T7-T10）由另一条线并行开发，T11 的列表/报告测试
 * 不能依赖一条还不存在的执行链——与后端 tests 里「fixture 数据一律经 models 直插」
 * 同一约定（test_report_center.py 头注）。制品文件按后端默认 artifacts_dir 落盘，
 * 下载端点按魔数嗅 content-type，所以这里写的是真 PNG 字节，不是文本占位。
 *
 * 走 python+pymysql 子进程：web 包不带 MySQL 驱动（前端零新依赖），而 playwright
 * 本就依赖这个 venv（playwright.config.ts 的 PY）。
 */
export function insertRunDirect(row) {
  const here = import.meta.dirname;
  const backendDir = path.resolve(here, "..", "..", "backend");
  const py = process.env.TP_PYTHON ?? path.join(backendDir, ".venv", "Scripts", "python.exe");
  const db = E2E_DB_URL;
  const spec = JSON.stringify({ ...row, db });
  const out = execFileSync(py, ["-c", INSERT_RUN_PY, spec], {
    cwd: backendDir, encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

import { execFileSync } from "node:child_process";
import path from "node:path";

const INSERT_RUN_PY = `
import base64, json, os, sys, uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit
import pymysql

spec = json.loads(sys.argv[1])
u = urlsplit(spec["db"].replace("+asyncmy", "+asyncmy"))  # keep netloc parse
run_id = str(uuid.uuid4())
now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
stats = {"total": 1, "pass": 1, "fail": 0, "skip": 0, "error": 0}
graph = {"version": 1, "nodes": [{"key": "u1", "kind": spec["subject_type"],
                                  "name": spec["subject_name"]}],
         "results": {"u1": "pass"}}
conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                       password=u.password, database=u.path.lstrip("/"), autocommit=True)
with conn.cursor() as cur:
    cur.execute(
        "INSERT INTO run_record (id, project_id, subject_type, subject_id, subject_name,"
        " \`trigger\`, status, created_by, started_at, finished_at, created_at, updated_at,"
        " stats, summary_graph, cancel_requested)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,NULL,%s,%s,%s,%s,%s,%s,0)",
        (run_id, spec["project_id"], spec["subject_type"], "subj-" + run_id[:8],
         spec["subject_name"], spec.get("trigger", "manual"), spec.get("status", "passed"),
         now, now, now, now, json.dumps(stats), json.dumps(graph)))
    name = None
    if spec.get("screenshot"):
        # 1x1 真 PNG（魔数完整）：报告页 <img> 必须能真解码（naturalWidth>0），
        # 文本占位会把「src 拼错也绿」的失败模式放进来——计划纪律 1 明确禁止。
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
            "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        name = "shot-" + uuid.uuid4().hex[:8] + ".png"
        ref = run_id + "/" + name
        # 与服务进程**同一个锚点** artifact_root()（config 的 repo-root 解析）：
        # 手拼 os.getcwd()+artifacts_dir 在 cwd=backend 时会写进 backend/backend/，
        # 库里 ref 不变但服务端按仓库根解析 → 报告页 404「制品不存在」。
        from app.modules.execution.artifacts import artifact_root
        root = str(artifact_root())
        d = os.path.join(root, run_id)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as f:
            f.write(png)
        cur.execute(
            "INSERT INTO run_step_result (id, run_id, step_key, row_no, kind, status,"
            " parent_step_key, subject_name, attempts, elapsed_ms, created_at, updated_at)"
            " VALUES (%s,%s,'u1',0,'ui_case','pass',NULL,%s,1,12,%s,%s)",
            (str(uuid.uuid4()), run_id, spec["subject_name"], now, now))
        cur.execute(
            "INSERT INTO run_artifact (id, run_id, step_key, kind, ref, bytes, created_at)"
            " VALUES (%s,%s,'u1','SCREENSHOT',%s,%s,%s)",
            (str(uuid.uuid4()), run_id, ref, len(png), now))
conn.close()
print(json.dumps({"run_id": run_id, "artifact_name": name}))
`;
