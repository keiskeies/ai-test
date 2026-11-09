/**
 * `atest auth-check` 的判定（authcheck.ts）+ 命令装配（cmdAuthCheck）。
 *
 * 这里刻意**不用 mock server 发真请求**去验判读逻辑：
 * 判读的全部内容是"给定状态码 → 什么结论"，那是纯函数，
 * 绕一圈真网络只会让"500 算凭证被接受"这条判断被 HTTP 客户端的实现细节盖住。
 * send 是注入的，所以每个状态码都能单独点验。
 *
 * 但鉴权装配那一层**用的是真的**（buildAuthLayer + 真 CredentialTable + 真 AuthHook）：
 * 这条命令的全部价值在于"它说的与真实跑起来做的是同一件事"，
 * 用假装配去测它就等于把这条判据测没了。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { parseOpenApi, type ParsedDoc } from '@atest/adapter-http';

import { authCheckExit, checkAuth, interpret } from '../src/authcheck.js';
import { main } from '../src/main.js';
import { EXIT } from '../src/exit.js';
import { DocRegistry, buildAuthLayer } from '../src/wiring.js';

const SECRET = 'tok-live-8f3a1c';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'shop', version: '1' },
  components: {
    securitySchemes: {
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
  },
  security: [{ apiKeyAuth: [] }],
  paths: {
    '/orders': { get: { operationId: 'listOrders', responses: { '200': { description: 'ok' } } } },
    '/orders/{id}': { delete: { operationId: 'delOrder', responses: { '204': { description: 'ok' } } } },
  },
};

/** 只有 POST 的一份 spec：用来验"没有只读接口时绝不退而去发写请求" */
const WRITE_ONLY = {
  openapi: '3.1.0', info: { title: 'shop', version: '1' },
  components: { securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
  security: [{ apiKeyAuth: [] }],
  paths: { '/orders': { post: { operationId: 'createOrder', responses: { '201': { description: 'ok' } } } } },
};

/**
 * DocRegistry 只吃文件路径（真实用法就是 --doc name=path）。
 * 这里造临时文件而不是改 DocRegistry 开个内存入口：
 * 那条"读不到文件/JSON 不合法"的路径也是被测的一部分
 */
async function registryWith(spec: unknown, name = 'shop'): Promise<{ reg: DocRegistry; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-authcheck-'));
  const p = join(dir, 'openapi.json');
  await writeFile(p, JSON.stringify(spec), 'utf8');
  return { reg: await DocRegistry.load([`${name}=${p}`]), dir };
}

type FakeSend = (req: { method: string; url: string; headers: Record<string, string> }) =>
  Promise<{ status: number; body?: unknown; error?: { kind: string; message: string } }>;

/** 记录被探测的请求，用于断"只发了只读方法""带上了凭证头" */
function fakeSend(result: { status?: number; error?: { kind: string; message: string } } | ((r: { method: string; url: string; headers: Record<string, string> }) => { status?: number; error?: { kind: string; message: string } })): {
  send: FakeSend; calls: Array<{ method: string; url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    send: async (req) => {
      calls.push(req);
      const r = typeof result === 'function' ? result(req) : result;
      return { status: r.status ?? 0, error: r.error };
    },
  };
}

function envWith(auth: unknown): Record<string, unknown> {
  return { baseUrl: 'https://api.test', auth };
}

const DEFAULT_IDS = [{ label: '(默认)' }];

describe('interpret：状态码到结论', () => {
  test('2xx/3xx 是 ok', async () => {
    for (const s of [200, 204, 301]) assert.equal(interpret(s).outcome, 'ok', `${s}`);
  });

  test('401/403 是 rejected，且两者的修法不同', async () => {
    assert.equal(interpret(401).outcome, 'rejected');
    assert.equal(interpret(403).outcome, 'rejected');
    // 403 常见于"凭证有效但角色不够" —— 那恰恰是权限用例期望的结果。
    // 说成"凭证坏了"会让人去换一份本来没错的凭证
    assert.match(interpret(403).hint ?? '', /角色|权限/);
    assert.match(interpret(401).hint ?? '', /环境/);
  });

  test('500 与 404 算凭证被接受 —— 请求进到业务代码说明网关放行了', async () => {
    // 这是本文件最不直观的一条判据。把 500 报成"鉴权有问题"的后果很具体：
    // 用户换一份好凭证，还是 500，然后他以为"新凭证也不对"
    assert.equal(interpret(500).outcome, 'ok');
    assert.equal(interpret(404).outcome, 'ok');
    assert.match(interpret(500).hint ?? '', /另查/, '500 要说明"凭证没问题、但 500 本身得看"，否则像在给红灯开绿灯');
  });
});

describe('checkAuth：结论必须分得开，因为修法分不开', () => {
  test('凭证有效 -> ok，且请求真的带上了 spec 声明的头', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_API: SECRET },
      });
      const r = await checkAuth({ hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS, send: fs.send });
      assert.equal(r.problems, 0, r.rows.map((x) => x.detail).join('\n'));
      assert.equal(authCheckExit(r), EXIT.OK);
      // 判据落在**发出去的请求**上：结论说 ok 而其实没带头，就是这条命令最坏的一种撒谎
      assert.equal(fs.calls[0]?.headers['x-api-key'], SECRET);
      assert.equal(fs.calls[0]?.method, 'GET');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('缺密钥 -> needs-config，且 hint 里给出可照抄的变量名、不含值', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: {}, // 一个都不设
      });
      const r = await checkAuth({ hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS, send: fs.send });
      assert.equal(r.rows[0]?.outcome, 'needs-config');
      assert.match(r.rows[0]?.hint ?? '', /ATEST_SECRET_API/, '修法必须给变量名，否则用户只能猜');
      assert.equal(authCheckExit(r), EXIT.ENV, '缺配置是环境问题(4)，不是"产品坏了"(1)');
      // **一个请求都不该发**：裸发得到 401，而 401 会被读成后端坏了
      assert.equal(fs.calls.length, 0, `不该裸发请求，实际发了 ${fs.calls.length} 个`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('401 -> rejected，与 needs-config 分开（两者的修法毫无重叠）', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_API: SECRET },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS,
        send: fakeSend({ status: 401 }).send,
      });
      assert.equal(r.rows[0]?.outcome, 'rejected');
      assert.equal(r.rows[0]?.statusCode, 401);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('连不上 -> unreachable 且**不算问题**（否则 VPN 没连会让流水线红成鉴权坏了）', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_API: SECRET },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS,
        send: fakeSend({ error: { kind: 'network', message: 'ECONNREFUSED' } }).send,
      });
      assert.equal(r.rows[0]?.outcome, 'unreachable');
      assert.equal(r.problems, 0);
      assert.equal(authCheckExit(r), EXIT.OK);
      // 报错必须明确说"这不是凭证问题"，否则用户还是会去改凭证
      assert.match(r.rows[0]?.hint ?? '', /不是\*?\*?凭证|不是凭证|不是\*\*/);
      assert.match(r.rows[0]?.detail ?? '', /ECONNREFUSED/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('没有只读接口 -> not-probed，**绝不退而去发 POST**', async () => {
    const { reg, dir } = await registryWith(WRITE_ONLY);
    try {
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_API: SECRET },
      });
      const r = await checkAuth({ hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS, send: fs.send });
      assert.equal(r.rows[0]?.outcome, 'not-probed');
      assert.equal(fs.calls.length, 0, '探测发一个 POST 就是在 CI 里下一单');
      assert.match(r.rows[0]?.hint ?? '', /只读|健康检查/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('docRef 要真的传下去：多系统各配各的凭证时不能共用匿名桶', async () => {
    // 凭证表按 (docRef, 身份) 查。authcheck 里 pickTargets 早先漏了 docRef，
    // 于是两份 spec 全查进匿名桶 —— "shop 与 crm 用不同凭证"这种最常见的配置会被验成同一个
    const shopDir = await mkdtemp(join(tmpdir(), 'atest-ac-'));
    try {
      const p1 = join(shopDir, 'shop.json'); const p2 = join(shopDir, 'crm.json');
      await writeFile(p1, JSON.stringify(SPEC), 'utf8');
      await writeFile(p2, JSON.stringify(SPEC), 'utf8');
      const reg = await DocRegistry.load([`shop=${p1}`, `crm=${p2}`]);
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({
        registry: reg,
        env: { baseUrl: 'https://api.test', auth: { shop: { default: { secret: 'secret:s' } }, crm: { default: { secret: 'secret:c' } } } },
        environmentRef: 'unit', now: () => 0,
        envVars: { ATEST_SECRET_S: 'shop-token-1', ATEST_SECRET_C: 'crm-token-2' },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: { baseUrl: 'https://api.test' }, identities: DEFAULT_IDS, send: fs.send,
      });
      assert.equal(r.rows.length, 2, `两份 spec 各一行，实际 ${r.rows.length}`);
      const heads = fs.calls.map((c) => c.headers['x-api-key']).sort();
      assert.deepEqual(heads, ['crm-token-2', 'shop-token-1'], '两份 spec 必须各自用自己那桶的凭证');
    } finally { await rm(shopDir, { recursive: true, force: true }); }
  });

  test('每个身份各探一轮，且身份名进结论', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({
        registry: reg,
        env: envWith({ default: { secret: 'secret:d' }, identities: { admin: { secret: 'secret:a' } } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_D: 'default-tok-1', ATEST_SECRET_A: 'admin-token-2' },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: envWith({}),
        identities: [{ label: '(默认)' }, { label: 'admin', identity: 'admin' }], send: fs.send,
      });
      assert.equal(r.rows.length, 2);
      assert.deepEqual(r.rows.map((x) => x.identity), ['(默认)', 'admin']);
      // 身份不生效的话，两行会带同一个 token 而结论都说"有效" —— 权限问题就这样被盖住
      assert.equal(fs.calls[0]?.headers['x-api-key'], 'default-tok-1');
      assert.equal(fs.calls[1]?.headers['x-api-key'], 'admin-token-2');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('凭证值绝不出现在输出里（api-in-query 形态躲得过通用脱敏）', async () => {
    // 用 **query 型**的 scheme。上一版这里用 header 型，于是密钥压根不进 URL，
    // "把 clean() 改成直通"这个变异照样全绿 —— 测试与它想防的东西无关（变异检查抓出来的）
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-q-'));
    try {
      const p = join(dir, 'openapi.json');
      await writeFile(p, JSON.stringify({
        ...SPEC,
        components: { securitySchemes: { q: { type: 'apiKey', in: 'query', name: 'api_key' } } },
        security: [{ q: [] }],
      }), 'utf8');
      const reg = await DocRegistry.load([`shop=${p}`]);
      const auth = buildAuthLayer({
        registry: reg, env: envWith({ default: { secret: 'secret:api' } }),
        environmentRef: 'unit', now: () => 0, envVars: { ATEST_SECRET_API: SECRET },
      });
      // 让 send 把整条 URL 回显在错误里 —— 真实场景是 undici 的连接错误带完整 URL，
      // 而 `?api_key=abc123` 这种值形态命中不了 redact.ts 的字段名/值形态两条规则
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS,
        send: async (req) => ({ status: 0, error: { kind: 'network', message: `connect failed to ${req.url}` } }),
      });
      const all = JSON.stringify(r);
      // 先确认密钥**确实进了** URL，否则"输出里没有它"又是空转
      assert.ok(all.includes('api_key='), `fixture 没造出 URL 型密钥，这条测试是空的：${all.slice(0, 300)}`);
      assert.ok(!all.includes(SECRET), `输出里出现了凭证值：${all.slice(0, 300)}`);
      assert.match(all, /凭证已脱敏/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('没导任何 spec -> 明确说"无法判断"，不能报成全绿', async () => {
    // "没检查出问题"与"压根没检查"必须是两个结论，否则这条命令自己变成一个假绿灯
    const empty = await DocRegistry.load([]);
    const auth = buildAuthLayer({ registry: empty, env: {}, environmentRef: 'unit', now: () => 0, envVars: {} });
    const r = await checkAuth({
      hook: auth.hook, table: auth.table, registry: empty, env: { baseUrl: 'https://api.test' },
      identities: DEFAULT_IDS, send: fakeSend({ status: 200 }).send,
    });
    assert.equal(r.rows[0]?.outcome, 'not-probed');
    assert.match(r.rows[0]?.detail ?? '', /没有导入|无法判断/);
  });

  test('没有 baseUrl -> not-probed，并给出可照抄的开关', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const fs = fakeSend({ status: 200 });
      const auth = buildAuthLayer({ registry: reg, env: {}, environmentRef: 'unit', now: () => 0, envVars: {} });
      const r = await checkAuth({ hook: auth.hook, table: auth.table, registry: reg, env: {}, identities: DEFAULT_IDS, send: fs.send });
      assert.equal(r.rows[0]?.outcome, 'not-probed');
      assert.match(r.rows[0]?.hint ?? '', /--env-var baseUrl=/);
      assert.equal(fs.calls.length, 0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('身份在这个 doc 上没有自己的凭证 -> 那一行必须说"用的是默认凭证"', async () => {
    // 查找顺序"身份精确 > doc default > 匿名 default"里，回落到 default **本身是对的**
    // （不然每个身份都得配齐才能跑）。危险的是报告侧看不出来：
    // 那一行会写"admin 凭证被接受"，而它验的其实是默认凭证 ——
    // "admin 读不到别人的资源"这类权限判据就这样拿到一个绿灯。
    // fixture 要点：admin 在**另一份 spec** 上有凭证（所以它出现在身份清单里），
    // 而在被探的 shop 上没有 —— 这样 default 是能取到值的，探测会真的发出去并成功，
    // 于是"看着成功但其实用错身份"这个现象才成立（缺密钥的话走的是 needs-config，另一条路）
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-fb-'));
    try {
      const p1 = join(dir, 'shop.json'); const p2 = join(dir, 'crm.json');
      await writeFile(p1, JSON.stringify(SPEC), 'utf8');
      await writeFile(p2, JSON.stringify(SPEC), 'utf8');
      const reg = await DocRegistry.load([`shop=${p1}`, `crm=${p2}`]);
      const auth = buildAuthLayer({
        registry: reg,
        env: {
          baseUrl: 'https://api.test',
          auth: {
            shop: { default: { secret: 'secret:shop_def' } }, // 只有 default
            crm: { default: { secret: 'secret:crm_def' }, identities: { admin: { secret: 'secret:crm_admin' } } },
          },
        },
        environmentRef: 'unit', now: () => 0,
        envVars: {
          ATEST_SECRET_SHOP_DEF: 'shop-default-tok', ATEST_SECRET_CRM_DEF: 'crm-default-tok',
          ATEST_SECRET_CRM_ADMIN: 'crm-admin-token',
        },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: { baseUrl: 'https://api.test' },
        identities: [{ label: 'admin', identity: 'admin' }], sampleLimit: 1,
        send: fakeSend({ status: 200 }).send,
      });
      const shopRow = r.rows.find((x) => x.docRef === 'shop');
      const crmRow = r.rows.find((x) => x.docRef === 'crm');
      assert.ok(shopRow && crmRow, `两份 spec 各一行，实际：${r.rows.map((x) => x.docRef).join(' | ')}`);
      // 同一份 spec 有/没有该身份的凭证，两行**必须不同** ——
      // 相同就说明这条判据只是装饰（本仓反复栽在"两种实现算出同一个结果"上）
      assert.match(shopRow.warning ?? '', /默认凭证|权限验过/, `shop 上的 admin 是回落的，必须可见：${shopRow.detail}`);
      assert.equal(crmRow.warning, undefined, `crm 上的 admin 有自己的凭证，不该告警：${crmRow.warning}`);
      // 回落**不进 problems**：凭证是有效的，只是"哪个身份"没答上。
      // 算成问题会让"只配一个共享凭证"的正常用法在 CI 里恒红
      assert.equal(r.problems, 0, r.rows.map((x) => `${x.docRef}:${x.outcome} ${x.detail}`).join('\n'));
      assert.match(r.summary, /身份回落到默认凭证/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('身份有自己的凭证时**不带**回落告警（否则告警会响成噪音）', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const auth = buildAuthLayer({
        registry: reg,
        env: envWith({ default: { secret: 'secret:d' }, identities: { admin: { secret: 'secret:a' } } }),
        environmentRef: 'unit', now: () => 0,
        envVars: { ATEST_SECRET_D: 'default-tok-1', ATEST_SECRET_A: 'admin-token-2' },
      });
      const r = await checkAuth({
        hook: auth.hook, table: auth.table, registry: reg, env: envWith({}),
        identities: [{ label: 'admin', identity: 'admin' }],
        send: fakeSend({ status: 200 }).send,
      });
      // 消息写死而不是传 warning 本身：它是 string|undefined，assert 的重载不接受，
      // 而且失败时 assert 自己会打出 actual/expected 的差异，值不会丢
      assert.equal(r.rows[0]?.warning, undefined, '身份有自己的凭证时不该有回落告警');
      assert.equal(r.rows[0]?.outcome, 'ok');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('summary 把"有问题"与"未判定"分开数', async () => {
    const { reg, dir } = await registryWith(SPEC);
    try {
      const auth = buildAuthLayer({ registry: reg, env: envWith({ default: { secret: 'secret:api' } }), environmentRef: 'unit', now: () => 0, envVars: {} });
      const r = await checkAuth({ hook: auth.hook, table: auth.table, registry: reg, env: envWith({}), identities: DEFAULT_IDS, send: fakeSend({ status: 200 }).send });
      assert.match(r.summary, /有问题 1/);
      assert.match(r.summary, /未判定/);
      // 未判定不能被写进"有问题"里，也不能被省略 —— 省略就等于报喜不报忧
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// ── 命令级：走 main()，验装配与打印 ────────────────────────────────────────

/** 与 e2e.test.ts 同形：out/err 是**函数**，收下来的文本在 stdout/stderr 里。
 *  早先这里把 out/err 直接写成了数组，于是 main() 调 io.err(...) 时炸在
 *  "io.err is not a function" —— 测试自身的形状错，与被测代码无关 */
function ioCapture(): { stdout: string[]; stderr: string[]; cwd: string; env: Record<string, string | undefined> } {
  const c = { stdout: [] as string[], stderr: [] as string[], cwd: process.cwd(), env: {} as Record<string, string | undefined> };
  return Object.assign(c, {
    out: (s: string) => { c.stdout.push(s); },
    err: (s: string) => { c.stderr.push(s); },
  });
}

describe('cmdAuthCheck：走完整 CLI 路径', () => {
  test('缺 --doc 时按用法错退出，且不猜一个默认 spec', async () => {
    const io = ioCapture();
    const code = await main(['auth-check', '--env', 'staging'], io as never);
    assert.equal(code, EXIT.USAGE);
    assert.match(io.stderr.join('\n'), /--doc/);
  });

  test('缺环境时报用法错：凭证是按环境配的，没有环境就无从谈"对不对"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-cli-'));
    try {
      const p = join(dir, 'openapi.json');
      await writeFile(p, JSON.stringify(SPEC), 'utf8');
      const io = ioCapture();
      const code = await main(['auth-check', '--doc', `shop=${p}`], io as never);
      assert.equal(code, EXIT.USAGE);
      assert.match(io.stderr.join('\n'), /环境/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('--sample 越界要拦住：它是"探几个接口"，不是"扫全站"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-cli-'));
    try {
      const p = join(dir, 'openapi.json');
      await writeFile(p, JSON.stringify(SPEC), 'utf8');
      for (const bad of ['0', '99', 'abc']) {
        const io = ioCapture();
        const code = await main(['auth-check', '--doc', `shop=${p}`, '--env-var', 'baseUrl=https://api.test', '--sample', bad], io as never);
        assert.equal(code, EXIT.USAGE, `--sample ${bad} 不该被接受`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('缺密钥时 stdout 里直接给出该设哪个变量', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-cli-'));
    try {
      const p = join(dir, 'openapi.json');
      await writeFile(p, JSON.stringify({
        ...SPEC,
        components: { securitySchemes: { q: { type: 'apiKey', in: 'query', name: 'api_key' } } },
        security: [{ q: [] }],
      }), 'utf8');
      // 凭证段走**环境文件**：auth 是嵌套结构，--env-var 只能给扁平键（见下一个用例）
      const envPath = join(dir, 'unit.json');
      await writeFile(envPath, JSON.stringify({
        baseUrl: 'https://api.test', auth: { default: { secret: 'secret:missing_me' } },
      }), 'utf8');
      const io = ioCapture();
      io.env = {}; // 一个密钥变量都不设
      const code = await main(['auth-check', '--doc', `shop=${p}`, '--env', envPath], io as never);
      const all = [...io.stdout, ...io.stderr].join('\n');
      assert.equal(code, EXIT.ENV, `缺凭证应报环境缺失。输出：${all.slice(0, 400)}`);
      assert.match(all, /ATEST_SECRET_MISSING_ME/, '必须指名变量名，用户才能一步修好');
      // 报错本身也不能把占位符喷出来（"值是 undefined"这种话会让人去查引擎而不是查变量名）
      assert.ok(!/undefined/.test(all), `输出里有 undefined：\n${all.slice(0, 400)}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('--env-var 写嵌套路径要被拦住：它只会造出一个没人读的扁平键', async () => {
    // 真实踩到的写法：`--env-var auth.default.secret=secret:x`。
    // buildEnv 按字面键存，于是 env 里出现一个名叫 "auth.default.secret" 的键，
    // 而鉴权层读的是 env.auth —— **配了而完全没生效**，
    // 表现是"我明明传了凭证"，与真相隔了一层
    const dir = await mkdtemp(join(tmpdir(), 'atest-ac-cli-'));
    try {
      const p = join(dir, 'openapi.json');
      await writeFile(p, JSON.stringify(SPEC), 'utf8');
      const io = ioCapture();
      io.env = { ATEST_SECRET_X: 'a-real-token-1' };
      const code = await main(
        ['auth-check', '--doc', `shop=${p}`, '--env-var', 'baseUrl=https://api.test',
         '--env-var', 'auth.default.secret=secret:x'],
        io as never,
      );
      const all = [...io.stdout, ...io.stderr].join('\n');
      assert.match(all, /表达不了嵌套/, `要指出 --env-var 表达不了嵌套结构。输出：\n${all.slice(0, 400)}`);
      assert.match(all, /--env \.\/|环境文件/, '拒绝本身不算完，得给出能照抄的替代写法');
      assert.equal(code, EXIT.USAGE, '这是用法错（2），不是环境缺失（4）：一个请求都不该发');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('--help 说清"只走只读方法"与五种结论（这条命令的判据反直觉，必须写在脸上）', async () => {
    const io = ioCapture();
    await main(['auth-check', '--help'], io as never);
    const s = io.stdout.join('\n');
    assert.match(s, /GET\/HEAD/);
    assert.match(s, /500/);
    assert.match(s, /未判定|not-probed/);
  });
});

/** 保命用：确认 fixture 里的 spec 真的能被 parse（不然上面全是空转） */
test('SPEC fixture 本身合法', async () => {
  const d: ParsedDoc = parseOpenApi(SPEC);
  assert.equal(d.operations.length, 2);
  assert.ok(d.operations.find((o) => o.method === 'GET')?.security?.length, 'GET 那条必须声明了 security');
});
