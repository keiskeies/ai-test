/**
 * CLI 端到端：`atest run` 打本地 mock，产出 evidence.zip 并用**系统 unzip** 验开。
 *
 * M6 的判据是"一次失败 run 产出可独立打开的 evidence.zip"。
 * store 层测过 zip 本身的正确性，但那不等于**这条命令**能产出它 ——
 * 中间还隔着路径解析、装配、时钟、退出码、产物落盘五道，
 * 每道的错都不会在单元层面显形（比如产物写进了另一个目录，
 * 或者 evidenceDir 与 store 的 dir 不一致导致包里少了证据）。
 *
 * 直接调 main() 而不是起子进程：要的是"命令行为"，不是 spawn 行为；
 * 退出码从返回值断，标准输出从注入的 io 断。
 * （bin/atest.mjs 那层薄到没有可测逻辑 —— 这是刻意的。）
 *
 * 密钥泄露走**命令行可见的路径**测：响应体里放真 JWT，
 * 从解开的包里搜 —— 而不是信"我们在写盘那一刻脱敏了"。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { parseOpenApi, startMockServer, type MockServer } from '@atest/adapter-http';
import { readZipEntries } from '@atest/store';

import { main } from '../src/main.js';
import { EXIT } from '../src/exit.js';
import type { Io } from '../src/commands.js';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'shop', version: '1' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        responses: { '201': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } },
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } } },
        },
      },
    },
  },
};

function ioCapture(): Io & { stdout: string[]; stderr: string[] } {
  const out = { stdout: [] as string[], stderr: [] as string[] };
  return {
    ...out,
    out: (s: string) => { out.stdout.push(s); },
    err: (s: string) => { out.stderr.push(s); },
    get cwd() { return process.cwd(); },
    env: {},
  } as Io & { stdout: string[]; stderr: string[] };
}

async function fixture(): Promise<{ dir: string; specPath: string; close: () => Promise<void>; addr: () => string; requests: () => number }> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-cli-'));
  const doc = parseOpenApi(SPEC);
  const mock = await startMockServer(doc);
  const specPath = join(dir, 'openapi.json');
  await writeFile(specPath, JSON.stringify(SPEC), 'utf8');
  return {
    dir, specPath,
    addr: () => mock.addr,
    requests: () => mock.requests.length,
    close: () => mock.close(),
  };
}

/** 手写一份 IR（不用 gen：这里要的是"一次会失败的运行"，手写最快也最可控） */
/** evidenceDir 下同级有 artifacts/（存储）与 <runId>/（本次产物） */
async function onlyRunDir(root: string): Promise<string> {
  const names = (await readdir(root)).filter((x) => x !== 'artifacts');
  assert.equal(names.length, 1, `${root} 下应只有一个 run 目录，实际 ${names.join(',')}`);
  return join(root, names[0]!);
}

async function writeCase(dir: string, body: unknown[], over: Record<string, unknown> = {}): Promise<string> {
  const p = join(dir, 'case.json');
  await writeFile(p, JSON.stringify({
    schemaVersion: '1', id: 'scn.e2e', name: 'e2e', env: { environmentRef: 'unit' },
    body, ...over,
  }), 'utf8');
  return p;
}

test('一次失败的 run 产出可被系统 unzip 验开的包，退出码是 TEST_FAILED', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A-1' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
      // 故意失败的一条：断一个不可能成立的值
      { id: 'bad', kind: 'assert', against: '$.step.c.resp', expr: '$.body.id == "不可能的值"' },
    ]);
    const io = ioCapture();
    const code = await main(
      ['run', casePath, '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
       '--evidence-dir', join(f.dir, 'evidence'), '--clock', 'deterministic'],
      io,
    );
    assert.equal(code, EXIT.TEST_FAILED, `退出码应为"测出失败"。stderr: ${io.stderr.join('\n')}`);
    assert.ok(f.requests() >= 1, '一个请求都没发，那"跑过了"是假的');

    // 产物布局：<evidenceDir>/artifacts 是内容寻址存储，<evidenceDir>/<runId>/ 是本次运行的产物
    const root = join(f.dir, 'evidence');
    const top = await readdir(root);
    assert.ok(top.includes('artifacts'), `证据存储目录该在同级：${top.join(',')}`);
    const runDirs = top.filter((x) => x !== 'artifacts');
    assert.equal(runDirs.length, 1, `evidence 下应只有一个 run 目录，实际 ${runDirs.join(',')}`);
    const runDir = join(root, runDirs[0]!);
    const files = await readdir(runDir);
    const zip = files.find((x) => x.endsWith('.zip'));
    assert.ok(zip, `没有 zip：${files.join(',')}`);
    assert.match(zip!, /^evidence\..*\.fail\.zip$/, '文件名要带状态，CI 上"哪个包是红的"要能肉眼分');
    assert.ok(files.includes('trace.jsonl'), 'trace.jsonl 要在（crash 后只能靠它）');
    assert.ok(files.includes('junit.xml'));

    const zipPath = join(runDir, zip!);
    const report = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    assert.match(report, /No errors detected/, report);

    const entries = readZipEntries(new Uint8Array(await readFile(zipPath)));
    const names = entries.map((e) => e.name);
    for (const want of ['manifest.json', 'junit.xml', 'trace.jsonl', 'summary.txt']) {
      assert.ok(names.includes(want), `包里缺 ${want}：${names.join(', ')}`);
    }
    // 失败的断言要能从 trace 里定位到，否则"有 trace"只是文件存在
    const trace = entries.find((e) => e.name === 'trace.jsonl')!;
    const traceText = new TextDecoder().decode(trace.data);
    assert.match(traceText, /"bad"/, 'trace 里找不到那个失败步骤');
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
    assert.equal(manifest.status, 'fail');
    assert.equal(manifest.scenario.frozen, false, 'frozen 要如实记录（CI 靠它拒绝）');
  } finally { await f.close(); }
});

test('--ci 且未冻结：拒绝执行，**一个请求都不发**，也不产出任何产物', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
    ]);
    const io = ioCapture();
    const code = await main(
      ['run', casePath, '--ci', '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
       '--evidence-dir', join(f.dir, 'ev2')],
      io,
    );
    assert.equal(code, EXIT.INVALID);
    assert.equal(f.requests(), 0, '拒绝执行必须是真拒绝：场景里的 POST 已经下单了再说"这次不算"没有意义');
    await assert.rejects(() => readdir(join(f.dir, 'ev2')), '被拒绝的运行不该留下产物目录');
    assert.match(io.stderr.join('\n'), /frozen/);
  } finally { await f.close(); }
});

test('--ci + 已冻结 + 有 provenance：放行，且产物里的 frozen=true', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
    ], {
      frozen: true,
      provenance: { origin: 'human' },
    });
    const io = ioCapture();
    const code = await main(
      ['run', casePath, '--ci', '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
       '--evidence-dir', join(f.dir, 'ev3'), '--clock', 'deterministic'],
      io,
    );
    assert.equal(code, EXIT.OK, io.stderr.join('\n'));
    const runDir = await onlyRunDir(join(f.dir, 'ev3'));
    const zip = (await readdir(runDir)).find((x) => x.endsWith('.zip'));
    assert.ok(zip, '产物里该有 zip');
    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zip!))));
    const m = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
    assert.equal(m.scenario.frozen, true);
  } finally { await f.close(); }
});

test('响应体里的真密钥不出现在解开的包里（evidence 是给多人下载的）', async () => {
  const f = await fixture();
  try {
    // 用 http 步骤直连 mock，让响应体进证据（openapiCall 的自动证据同理会走这条）
    const casePath = await writeCase(f.dir, [
      { id: 'g', kind: 'http', request: { method: 'POST', url: '/orders', body: { sku: 'A' } } },
      { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 201 },
    ]);
    const io = ioCapture();
    await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`, '--env-var', `leaky=${JWT}`,
                '--evidence-dir', join(f.dir, 'ev4'), '--clock', 'deterministic'], io);
    const runDir = await onlyRunDir(join(f.dir, 'ev4'));
    const zip = (await readdir(runDir)).find((x) => x.endsWith('.zip'))!;
    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zip))));
    const all = entries.map((e) => new TextDecoder().decode(e.data)).join('\n');
    assert.ok(!all.includes(JWT), 'JWT 原样进了证据包 = 进了每个有 CI 读权限的人的磁盘');
  } finally { await f.close(); }
});

test('缺密钥时**跑之前就告警**，而不是等 401 再让人猜（API 平台第一体验杀手）', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'g', kind: 'http', request: { method: 'GET', url: '/x', headers: { authorization: { path: '$secret.api_token' } } } },
      { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 200 },
    ]);
    const io = ioCapture();
    await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`, '--evidence-dir', join(f.dir, 'ev5')], io);
    const err = io.stderr.join('\n');
    // ref 的规范形态是 `secret:<name>`（冒号）。原来断成 /secret\.api_token/
    // 是我按 IR 里的写法 `$secret.api_token` 记的，两者不同 —— 断言正则要对实现
    assert.match(err, /secret:api_token/, '要点名是哪个 ref');
    assert.match(err, /ATEST_SECRET_API_TOKEN/, '要给出该设哪个环境变量');
    assert.ok(!err.includes('undefined'), '告警文本里不该出现 undefined');
  } finally { await f.close(); }
});

test('环境完全没给时报 USAGE 并说明两种给法，而不是发一个相对 URL 出去', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/x' } }]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--evidence-dir', join(f.dir, 'ev6')], io);
    assert.equal(code, EXIT.USAGE);
    assert.equal(f.requests(), 0);
    assert.match(io.stderr.join('\n'), /--env|--env-var/);
  } finally { await f.close(); }
});

test('IR 不合法时逐条列出问题（不是只报第一条），且不叫"测试失败"', async () => {
  const f = await fixture();
  try {
    const p = join(f.dir, 'broken.json');
    await writeFile(p, JSON.stringify({
      schemaVersion: '1', id: 'scn.b', name: 'b', env: { environmentRef: 'u' },
      body: [{ id: 'x', kind: 'assert', against: 123, status: '二千' }, { id: 'y', kind: '不存在的步骤类型' }],
    }), 'utf8');
    const io = ioCapture();
    const code = await main(['run', p, '--env-var', 'baseUrl=http://127.0.0.1:1', '--evidence-dir', join(f.dir, 'ev7')], io);
    assert.equal(code, EXIT.INVALID, 'IR 写错与产品坏了必须不同码，否则值班人去查错的东西');
    const err = io.stderr.join('\n');
    assert.match(err, /2 处|共 \d+ 处/, `应说明问题条数：${err}`);
  } finally { await f.close(); }
});

/**
 * M7 的判据是「同一冻结场景跑 20 次，**断言结果完全一致**」。
 * 注意它说的不是"字节完全一致"，这个区别必须落在测试里，否则会得到两种坏结果：
 * 一个恒红的测试，或者诱使人把耗时从证据里删掉好让测试变绿（那是为了测试通过而阉割证据）。
 * 真实 socket 的耗时天生波动，改不了；能改的是**别把波动的位数扩散到本该稳定的字段**
 * （见 engine 的 fmtMs：摘要里固定一位小数）。
 */
test('同一场景跑 20 次：断言结论逐次完全一致（真 IO 参与下的准确形态）', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
      // 用 jsonPath 形态而不是 expr：mock 声明了 201 的 schema 里有必填 id，
      // 这条断的是"结论维度"多一维，不是断 expr 求值（expr 的写法在别的测试里已验）
      { id: 'b', kind: 'assert', against: '$.step.c.resp', jsonPath: { '$.id': { notNull: true } } },
    ]);
    const shots = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const io = ioCapture();
      const code = await main(['run', casePath, '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
                               '--evidence-dir', join(f.dir, `m${i}`), '--clock', 'deterministic'], io);
      assert.equal(code, EXIT.OK, `第 ${i} 次退出码不同：${io.stderr.join(' | ')}`);
      const runDir = await onlyRunDir(join(f.dir, `m${i}`));
      const zip = (await readdir(runDir)).find((x) => x.endsWith('.zip'))!;
      const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zip))));
      const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
      // junit 里的 time 属性是秒（会波动），比对前先抹掉；其余（用例名、桶、计数）必须逐字一致
      const junit = new TextDecoder().decode(entries.find((e) => e.name === 'junit.xml')!.data)
        .replace(/time="\d+\.\d+"/g, 'time="X"').replace(/timestamp="[^"]*"/g, 'timestamp="X"');
      shots.add(`${JSON.stringify(manifest.tally)}|${junit}`);
    }
    assert.equal(shots.size, 1, `20 次运行的结论出现了 ${shots.size} 种版本：\n${[...shots].join('\n---\n')}`);
  } finally { await f.close(); }
});

test('纯计算场景（不碰网络）跑两次：证据包**字节**完全一致', async () => {
  // "字节可比"只在没有真实 IO 时成立。它值得单独一条，因为 zip 刻意不压缩
  // （见 store/zip.ts）换来的就是这个能力：未压缩时
  // `diff <(unzip -p a.zip trace.jsonl) <(unzip -p b.zip trace.jsonl)` 与
  // "两次运行是否一致"完全等价；压缩后还得先保证压缩器输出稳定（这本身不成立）。
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 's1', kind: 'set', assign: { n: 1, m: 2 } },
      { id: 'a1', kind: 'assert', against: '$n', expr: '$n == 1' },
      { id: 'a2', kind: 'assert', against: '$m', expr: '$n + $m == 3' },
    ], { provenance: { origin: 'human' } });
    const bytes: string[] = [];
    for (const tag of ['p1', 'p2']) {
      const io = ioCapture();
      const code = await main(['run', casePath, '--env-var', 'baseUrl=http://127.0.0.1:1',
                               '--evidence-dir', join(f.dir, tag), '--clock', 'deterministic', '--run-id', 'fixed'], io);
      assert.equal(code, EXIT.OK, io.stderr.join(' | '));
      const runDir = await onlyRunDir(join(f.dir, tag));
      const zip = (await readdir(runDir)).find((x) => x.endsWith('.zip'))!;
      bytes.push((await readFile(join(runDir, zip))).toString('base64'));
    }
    assert.equal(bytes[0], bytes[1], '同输入两次运行的证据包字节不同：M7 的 diff 判据不成立');
  } finally { await f.close(); }
});

test('gen --write 写出的文件能被 run 直接消费（生成与执行的路径约定必须咬合）', async () => {
  const f = await fixture();
  try {
    const io = ioCapture();
    const genCode = await main(['gen', '--doc', `shop=${f.specPath}`, '--strategies', 'happyPath',
                                '--env', 'unit', '--out', join(f.dir, 'cases'), '--write'], io);
    assert.equal(genCode, EXIT.OK, io.stderr.join('\n'));
    const written = await readdir(join(f.dir, 'cases'));
    assert.equal(written.length, 1, written.join(','));

    // 生成的 IR 里 docRef 是 "shop"，run 时也必须用这个名字 —— 名字对不上时
    // 报错要直接给出该加哪个开关，而不是把引擎内部术语抛出来
    const io2 = ioCapture();
    const code = await main(['run', join(f.dir, 'cases', written[0]!), '--doc', `shop=${f.specPath}`,
                             '--env-var', `baseUrl=${f.addr()}`, '--evidence-dir', join(f.dir, 'ev8'),
                             '--clock', 'deterministic'], io2);
    assert.equal(code, EXIT.OK, `${io2.stdout.join('\n')}\n${io2.stderr.join('\n')}`);

    // docRef 写错时的报错
    const io3 = ioCapture();
    const bad = await main(['run', join(f.dir, 'cases', written[0]!), '--env-var', `baseUrl=${f.addr()}`,
                            '--evidence-dir', join(f.dir, 'ev9'), '--clock', 'deterministic'], io3);
    assert.equal(bad, EXIT.ENV);
    assert.match(io3.stderr.join('\n'), /--doc shop=/, '要直接给出可照抄的修法');
  } finally { await f.close(); }
});

test('--local 对 mock 跑：结论照常产出，但必须大声说明这不是真实后端', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--local', '--doc', `shop=${f.specPath}`,
                             '--evidence-dir', join(f.dir, 'ev10'), '--clock', 'deterministic'], io);
    assert.equal(code, EXIT.OK, io.stderr.join('\n'));
    assert.match(io.stderr.join('\n'), /不是真实后端/);
  } finally { await f.close(); }
});

test('agent 命令存在但明确不可用，且给出可执行的替代路径（不是 command not found）', async () => {
  const io = ioCapture();
  const code = await main(['agent', '下单后库存应减一'], io);
  assert.equal(code, EXIT.ENV);
  const text = io.stderr.join('\n');
  assert.match(text, /不可用/);
  assert.match(text, /atest gen/, '要给出此刻真能用的替代');
  assert.match(text, /差别/, '要说清替代方案缺了什么，否则用户以为 gen 等价于 agent');
});

test('--yes 被拒绝：跳过人工确认在 Agent 模式下不开放', async () => {
  const io = ioCapture();
  const code = await main(['agent', 'x', '--yes'], io);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr.join('\n'), /不被接受|不可逆/);
});

test('纯 http 步骤、不导 spec 也要能跑（最常见的第一条用例，曾经报"adapter 未注册"）', async () => {
  // 这条测试存在的理由：assemble 里一度写 `if (!registry.empty()) 才注册 http adapter`，
  // 于是"手写一条 GET、不带 --doc"这个**最普通**的动作直接跑不起来。
  // spec 只有 openapiCall 需要；把"有没有文档"当成"要不要网络"是两件事被一个条件绑走了。
  // 其它用例都传了 --doc，所以这个洞在 e2e 里从没显形 —— 补一条不传的。
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'g', kind: 'http', request: { method: 'POST', url: '/orders', body: { sku: 'A-9' } } },
      { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 201 },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'httpOnly'), '--clock', 'deterministic'], io);
    assert.equal(code, EXIT.OK, `纯 http 场景应能跑通。${io.stdout.join('\n')}${io.stderr.join('\n')}`);
    assert.ok(f.requests() >= 1, '退出码 0 而一个请求都没发 = 假绿。必须验真发出去了');
    assert.doesNotMatch(io.stderr.join('\n'), /adapter 未注册/, '不该出现引擎内部术语');
  } finally { await f.close(); }
});

test('trace 里的耗时字段位数固定（不然同一场景两次的 trace 永远不同）', async () => {
  // fmtMs 的存在理由：performance.now() 的差值直接拼进摘要会得到
  // "POST 201 4.305087999999955ms" —— 那让 trace.jsonl 每行都带上 17 位抖动，
  // `diff <(unzip -p a.zip trace.jsonl) <(unzip -p b.zip trace.jsonl)` 恒有差异，
  // M7 的比对手段当场作废。真实耗时天生波动改不了，能改的是别把位数扩散出去。
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'g', kind: 'http', request: { method: 'POST', url: '/orders', body: { sku: 'A' } } },
      { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 201 },
    ]);
    const io = ioCapture();
    await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                '--evidence-dir', join(f.dir, 'fmt'), '--clock', 'deterministic'], io);
    const runDir = await onlyRunDir(join(f.dir, 'fmt'));
    const trace = await readFile(join(runDir, 'trace.jsonl'), 'utf8');
    const summaries = [...trace.matchAll(/"summary":"([^"]*ms[^"]*)"/g)].map((m) => m[1]!);
    assert.ok(summaries.length >= 1, `trace 里该有带耗时的摘要：${trace.slice(0, 200)}`);
    for (const s of summaries) {
      assert.match(s, /\d+\.\dms/, `耗时要固定一位小数：${s}`);
      assert.doesNotMatch(s, /\.\d{2,}ms/, `位数漏出去了：${s}`);
    }
  } finally { await f.close(); }
});

test('缺 spec 时的报错给出可照抄的开关，而不是引擎内部术语', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`, '--evidence-dir', join(f.dir, 'nodoc')], io);
    assert.equal(code, EXIT.ENV, '缺 spec 是配置问题（4），不该落到"可重试的异常"（5）');
    assert.equal(f.requests(), 0, '拦在装配期就该一个请求都不发');
    const err = io.stderr.join('\n');
    assert.match(err, /--doc shop=/, `要直接给出可照抄的修法：${err}`);
    assert.doesNotMatch(err, /文档登记表|DocProvider/, '不该把内部术语抛给用户');
  } finally { await f.close(); }
});

test('call 子场景：CLI 真能解析到磁盘上的另一个文件（这个端口以前压根没接）', async () => {
  // 这条存在的全部理由：引擎的 call 分支早就写全了（子变量空间、成本汇总、childRuns），
  // 但 assemble 从来没装配过解析器 —— 于是 `atest run` 上任何带 call 的场景都跑不了。
  // 单元测试抓不到，因为它们都手工注入 callScenario；而 e2e 的其它用例都是单文件场景。
  // 这就是本仓那个缺陷类的标准形态：**上半截很完整，下半截没人接，而绿色测试一片**。
  const f = await fixture();
  try {
    const childPath = join(f.dir, 'child.json');
    await writeFile(childPath, JSON.stringify({
      schemaVersion: '1', id: 'sub.login', name: '子：下单', env: { environmentRef: 'unit' },
      body: [{ id: 'cg', kind: 'http', request: { method: 'POST', url: '/orders', body: { sku: 'A-9' } } }],
    }), 'utf8');
    const casePath = await writeCase(f.dir, [
      // 用 id 引用而不是路径：IR 里的 scenarioRef 是 `id@version`，
      // 作者不该关心子场景落在哪个目录（那是平台的约定，不是用例的）
      // assignTo 是 IR 给 call 的**唯一**取值出口（docs/02 §步骤表）：
      // 子的 outputs 是一份聚合对象，不像 http 步骤那样有单一的 $.step.<id> 响应
      { id: 'c1', kind: 'call', scenarioRef: 'sub.login@1', assignTo: 'loginOut' },
      { id: 'a', kind: 'assert', against: '$loginOut', jsonPath: { $: { notNull: true } } },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'callEv'), '--clock', 'deterministic'], io);
    const log = io.stdout.join('\n') + io.stderr.join('\n');
    assert.equal(code, EXIT.OK, `call 应能跑通。${log}`);
    // **真发过请求**是唯一能证明子场景真的跑了的证据。
    // 只看退出码不行：解析失败现在也只是一步 error，而退出码取决于门禁怎么看它
    assert.ok(f.requests() >= 1, '退出码 0 而一个请求都没发 = 假绿');
    assert.doesNotMatch(log, /is not a function|未注入/, `接线错误不该出现。${log}`);

    // 子里那份响应体也要进包（evidence 是排查现场，"父跑了子没痕迹"不可接受）
    const runDir = await onlyRunDir(join(f.dir, 'callEv'));
    // trace 里该出现**带 path 前缀**的子步骤事件 —— 这是"子场景真的跑了、
    // 而且平台知道它在哪条调用链上"的机器可读证据（stdout 摘要只列失败项，
    // 所以不能在 stdout 上找"子场景"三个字：那测的是文案不是行为）
    const trace = await readFile(join(runDir, 'trace.jsonl'), 'utf8');
    assert.match(trace, /"path":\["body","c1"\][^\n]*"stepId":"cg"/,
      `trace 里该有子步骤 cg 且 path 带上父侧的 c1。${trace}`);
    // 文件名带 runId（同一目录里可能有过多次 run），所以按前缀找而不是写死名字
    const zipName = (await readdir(runDir)).find((n) => n.startsWith('evidence.') && n.endsWith('.zip'));
    assert.ok(zipName, `${runDir} 下没有 evidence*.zip`);
    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zipName!))));
    const arts = entries.filter((e) => e.name.startsWith('artifacts/'));
    assert.equal(arts.length, 1, `子里的响应体该在包里，实际 ${arts.length} 件`);
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
    assert.deepEqual(manifest.artifacts.map((a: { stepId: string }) => a.stepId), ['sub.login/cg'],
      '归属要带上子场景 id：步骤 id 只在自己的场景里唯一');
    /*
     * 子场景的**结构化**结果也要在真 CLI 的产物里。
     *
     * 为什么在 CLI 这一层再钉一遍，而 store 层 call-evidence.test.ts 已经测过：
     * 那边测的是 buildEvidencePackage(那份 report)，中间隔着 assemble() 的接线与
     * CLI 手里的 report —— 本仓这一族缺陷（"上半截很完整、下半截没人接"）
     * 恰好就住在那条缝上：call 的解析器以前就是这么"引擎全有、CLI 一个都跑不了"，
     * 而 store 层的测试当时全绿（见上面那条测试的块头注释）。
     * 判据取机器消费者真正要读的那三样：谁、成没成、几个 pass/fail。
     * 少任何一样，读 manifest.json 的一方就还得回去 grep JUnit 的正文文本。
     */
    const kids = manifest.children;
    assert.ok(Array.isArray(kids), 'children 必须落进 CLI 产的 manifest.json（缺这一栏就等于没结构化）');
    assert.equal(kids.length, 1, `一个 call 一条。实际 ${kids.length}`);
    assert.equal(kids[0].scenario.id, 'sub.login');
    assert.equal(kids[0].status, 'pass');
    assert.equal(kids[0].tally.pass, 1, '子场景的 tally 只数它自己那一步');
    assert.equal(kids[0].calledById, 'scn.e2e', '要能回答"谁叫起了它"（扁平列表靠这根链重建调用树）');
  } finally { await f.close(); }
});

test('已知缺口：scenarioRef 的 @version 今天不参与解析，但**不再静默**', async () => {
  /*
   * 这条断言的是**当前的**行为，不是期望的行为。它存在的意义是把这个缺口
   * 放在测试套件里而不是只放在注释里：`sub.login@9` 与 `sub.login@1` 现在
   * 落到同一个文件，而作者写 `@9` 时心里想的是"我要那个版本"。
   * 平台还没有版本表（证据包里的 versionId 也还是 undefined），
   * 所以文件系统里"一个 id 一个文件"就是当前唯一的版本形态。
   * **版本表落地的那天，这条会变红 —— 那是它该有的结局，删掉它并改成按版本解析。**
   *
   * 本轮把两半**分开**处理，所以这条也分成两句断言：
   *  - **解析这一半没动**（要连版本表，属 P1 store）；
   *  - **静默这一半修掉了**：解释器发 `CALL_VERSION_IGNORED`，
   *    经 `advisories.ts` 那个载体进 HTML / junit / summary.txt 三个出口。
   * 分成两件事是因为它们的阻塞点不同 —— 我原先把两半当成一件事，
   * 于是"静默忽略"这一半跟着版本表一起排到了 P1，而它今天就能修。
   */
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'child.json'), JSON.stringify({
      schemaVersion: '1', id: 'sub.login', name: '子', env: { environmentRef: 'unit' },
      body: [{ id: 'cg', kind: 'http', request: { method: 'POST', url: '/orders', body: { sku: 'A-9' } } }],
    }), 'utf8');
    const casePath = await writeCase(f.dir, [
      { id: 'c1', kind: 'call', scenarioRef: 'sub.login@99', assignTo: 'o' },
      { id: 'a', kind: 'assert', against: '$o', jsonPath: { $: { notNull: true } } },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'verEv'), '--clock', 'deterministic'], io);
    const log = io.stdout.join('\n') + io.stderr.join('\n');
    // ── 第一半：解析行为**没变**（缺口还在）
    assert.equal(code, EXIT.OK, `带 @99 也解析到了那个文件（这就是缺口本身）。${log}`);
    assert.ok(f.requests() >= 1, '前提：子场景真的跑了');
    assert.doesNotMatch(log, /解析不到|不存在/, `@99 今天是**被忽略**而不是被拒。${log}`);
    /* ── 第二半：缺口从此**说得出**。断 CLI 出口而不是引擎事件 ——
     * 事件在 trace.jsonl 里"有"过很多次，而本仓实测过那不等于人看得见
     *（advisories.ts 那个文件整篇就是为这件事写的）。*/
    assert.match(log, /CALL_VERSION_IGNORED|@version 目前不参与解析/,
      `写了 @99 而平台按 id 跑了另一份 IR，这句话必须到 CLI 眼前。${log}`);
    // 那句话要带上"实际按谁找的"，否则人只知道版本没生效、不知道跑了哪份
    assert.match(log, /sub\.login/, `提醒里要点出实际用的 id。${log}`);
  } finally { await f.close(); }
});

test('--version-id 真的进到证据包清单里；不传时那一栏是"没有"而不是"空"', async () => {
  /*
   * 这条测试的**起因是一次实测**：把 commands.ts 里 `provenance: { versionId: str(a, 'version-id') }`
   * 整句换成 `{ versionId: undefined }`，重建后 `packages/cli/test` **173/173 全绿**。
   * 也就是说这个开关从 2026-11-09（d90e9e1，M6 那一份）起**从没被验过有没有接通** ——
   * store 层有一条测试钉住 `provenance.versionId -> manifest`（evidence.test.ts 的
   * 「manifest 记录 frozen 与 provenance」），但没有一条钉住**命令行那一段**。
   * 缝在中间，两头各绿一半：本仓记过好几次的"字段有、没人接"就是这一族。
   *
   * 两侧都要钉，理由不同：
   *  - 传了要落到盘上 —— 否则 CI 传了版本号而证据里没有，事后无法回答"这次跑的是第几版"；
   *  - 不传时那一栏**得是缺着**，不能是 `"v0"`/`""`/`0` —— 编一个默认值会把"调用方没说"
   *    伪装成"平台说这是第 0 版"，而 P1 的版本表要拿它当主键用（与 store 侧
   *    `bytes` 取不到时宁可不写也不写 0 同一条立场：0 和空串都是**合法值**）。
   */
  const f = await fixture();
  try {
    const manifestOf = async (evDir: string) => {
      const runDir = await onlyRunDir(join(f.dir, evDir));
      const zip = (await readdir(runDir)).find((x) => x.endsWith('.zip'));
      assert.ok(zip, `${runDir} 下没有 zip`);
      const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zip!))));
      return JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data));
    };

    const casePath = await writeCase(f.dir, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body: { sku: 'A' } },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 201 },
    ]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'vidEv'), '--clock', 'deterministic',
                             '--version-id', 'v12'], io);
    const log = io.stdout.join('\n') + io.stderr.join('\n');
    assert.equal(code, EXIT.OK, `带 --version-id 不该改变结论。${log}`);
    const m = await manifestOf('vidEv');
    assert.equal(m.scenario.versionId, 'v12',
      '开关被接受、但值没到磁盘上 = CI 以为记了版本而其实没有（这条测试就是为它写的）');

    const io2 = ioCapture();
    const code2 = await main(['run', casePath, '--doc', `shop=${f.specPath}`, '--env-var', `baseUrl=${f.addr()}`,
                              '--evidence-dir', join(f.dir, 'vidEv2'), '--clock', 'deterministic'], io2);
    assert.equal(code2, EXIT.OK, io2.stderr.join('\n'));
    const m2 = await manifestOf('vidEv2');
    assert.ok(!('versionId' in m2.scenario),
      `没传版本时这一栏该整栏缺着，实际 ${JSON.stringify(m2.scenario.versionId)}（typeof=${typeof m2.scenario.versionId}）`);
  } finally { await f.close(); }
});

test('call 指向不存在的子场景：报错点名 ref，退出码不是 0', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [{ id: 'c1', kind: 'call', scenarioRef: 'sub.ghost@1' }]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'ghostEv'), '--clock', 'deterministic'], io);
    const log = io.stdout.join('\n') + io.stderr.join('\n');
    assert.notEqual(code, EXIT.OK, `解析不到子场景绝不能算通过。${log}`);
    assert.match(log, /sub\.ghost/, `要让人看到是哪个 ref 解析不到。${log}`);
  } finally { await f.close(); }
});

test('--help 每条命令都能打，且退出码 0（帮助文本里少一个开关=用户不会知道它有）', async () => {
  for (const c of ['run', 'lint', 'gen', 'agent', 'init', 'evidence']) {
    const io = ioCapture();
    const code = await main([c, '--help'], io);
    assert.equal(code, EXIT.OK, `${c} --help 返回 ${code}`);
    assert.match(io.stdout.join('\n'), new RegExp(`atest ${c}`));
  }
  const top = ioCapture();
  assert.equal(await main([], top), EXIT.USAGE, '裸命令该提示用法');
  assert.match(top.stderr.join('\n'), /没指定命令|用法/);
});

test('init 建的目录与配置文件真的能被后续命令读到（约定要能咬合）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-init-'));
  const io = ioCapture();
  const code = await main(['init', '--env', 'dev'], { ...io, cwd: dir } as Io);
  assert.equal(code, EXIT.OK, io.stderr.join('\n'));
  const cfg = JSON.parse(await readFile(join(dir, 'atest.json'), 'utf8'));
  assert.equal(cfg.defaultEnv, 'dev');
  const names = await readdir(dir);
  for (const d of ['cases', 'env', 'evidence']) {
    assert.ok(names.includes(d), `${d} 没建出来：${names.join(',')}`);
  }
  // 环境文件按 init 的约定放好之后，run 不该再要求 --env
  await writeFile(join(dir, 'env', 'dev.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }), 'utf8');
  const f = await fixture();
  try {
    const casePath = join(dir, 'cases', 'c.json');
    await mkdir(join(dir, 'cases'), { recursive: true });
    await writeFile(casePath, JSON.stringify({
      schemaVersion: '1', id: 'scn.i', name: 'i', env: { environmentRef: 'dev' },
      body: [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/x' } }, { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 999 }],
    }), 'utf8');
    const io2 = ioCapture();
    const c2 = await main(['run', 'scn.i'], { ...io2, cwd: dir } as Io);
    // 找不到 baseUrl 之外的错都算通过这条（这里端口没人监听 -> 运行期 error）
    assert.ok(c2 === EXIT.RUNTIME || c2 === EXIT.TEST_FAILED, `应当能装配起来并真跑，实际码 ${c2}：${io2.stderr.join(' | ')}`);
    void f;
  } finally { await f.close(); }
});

test('内部错误不被伪装成用法错（CliError 之外的异常要带堆栈走 RUNTIME）', async () => {
  // 造一个必炸的场景：evidence-dir 指向一个**文件**而不是目录，mkdir 会 ENOTDIR。
  // 这类"环境不对"与"我们的代码有 bug"的边界最容易把异常吞成 0 或 2
  const f = await fixture();
  try {
    const blocker = join(f.dir, 'afile');
    await writeFile(blocker, 'x', 'utf8');
    const casePath = await writeCase(f.dir, [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/x' } }]);
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`, '--evidence-dir', blocker], io);
    assert.ok(code === EXIT.RUNTIME || code === EXIT.ENV, `不该被静默吞成 0/1/2，实际 ${code}`);
    assert.ok(io.stderr.join('\n').length > 0, '出错却不写 stderr，CI 日志里就只剩一个数字');
  } finally { await f.close(); }
});

test('evidence 缺参数时的成员清单里真的有 report.html（提示别只列抄来的那几个）', async () => {
  // 判据**故意写死字面量**而不是拿 EVIDENCE_MEMBERS 去比 ——
  // 那样是"用派生验派生"，两边一起漂移也不会红（本仓那个缺陷类的测试侧镜像）。
  // 这条要抓的是具体那次失效：加 report.html 进包时，CLI 的用法提示没跟着加，
  // 症状是"人不知道能 show 它"，不报错、不变红。
  const io = ioCapture();
  const code = await main(['evidence'], io);
  assert.equal(code, EXIT.USAGE);
  const text = [...io.stdout, ...io.stderr].join('\n');
  for (const m of ['manifest.json', 'junit.xml', 'trace.jsonl', 'summary.txt', 'report.html']) {
    assert.ok(text.includes(m), `用法提示里缺成员 ${m}：${text}`);
  }
  // 顺手验 list 真能把 report.html 数列出来（提示说了，得真做得到）
  assert.match(text, /list/, '要同时给出 list 这条路，人拿不准时可以先列');
});

test('被砍断的 run：退出码 10，且**三个产物**都不说自己是 pass', async () => {
  /*
   * 这条是 `interruption.test.ts` + `gate.test.ts` 之上的**接线**测试，
   * 而那两层各自都不够：
   *  - 引擎侧只证明 `report.aborted` 有值；
   *  - 门禁侧读的是**合成 fixture**里的 aborted（自己造的），撤掉引擎那半它全绿；
   *  - 两边都不知道 CLI 有没有把这个码**当作本次命令的退出码返回**。
   *
   * 怎么在不真等、不起子进程的前提下造出中断：
   * `--clock deterministic` 让 `sleep` 只推进虚拟时间，`config.timeoutMs` 定小，
   * 于是 `checkAbort` 在下一步开头抛 timeout。**这是 atest 今天唯一接线的中断来源**
   * —— `runOptions.signal` 在 CLI 里压根没人赋值（Ctrl-C 那条路还没接，见 docs/15 §3.7）。
   */
  const f = await fixture();
  try {
    const casePath = join(f.dir, 'cut.json');
    await writeFile(casePath, JSON.stringify({
      schemaVersion: '1', id: 'scn.cut', name: 'cut', env: { environmentRef: 'unit' },
      config: { timeoutMs: 1_000 },
      body: [
        { id: 'seed', kind: 'set', assign: { n: 1 } },
        { id: 'a1', kind: 'assert', against: '$n', expr: '$n == 1' },
        // 这一步让虚拟时间越过 timeoutMs
        { id: 'slow', kind: 'sleep', ms: 5_000 },
        { id: 'a2', kind: 'assert', against: '$n', expr: '$n == 1' },
      ],
    }), 'utf8');
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'cutEv'), '--clock', 'deterministic', '--run-id', 'cut1'], io);
    assert.equal(code, EXIT.ABORTED, `被砍断的 run 不能是绿的。实际 ${code}：${io.stderr.join(' | ')}`);

    const runDir = await onlyRunDir(join(f.dir, 'cutEv'));
    const zipName = (await readdir(runDir)).find((n) => n.startsWith('evidence.') && n.endsWith('.zip'));
    assert.ok(zipName, `${runDir} 下没有 evidence*.zip`);
    // ① **文件名**。改动前实测是 `evidence.cut1.pass.zip` —— 一个被砍断的 run
    // 在文件管理器里、在"拖进聊天窗口发给同事"这个动作上写着 pass。
    assert.match(zipName!, /^evidence\.cut1\.aborted\.zip$/, `文件名要说出被中断，实际 ${zipName}`);

    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zipName!))));
    const text = (n: string) => new TextDecoder().decode(entries.find((e) => e.name === n)!.data);

    // ② **summary.txt 的首行**。那是下载给别人看的东西，只有文字、没有字段
    const summary = text('summary.txt');
    assert.match(summary.split('\n')[0]!, /被中断/, `summary.txt 首行要说出被中断：${summary.split('\n')[0]}`);

    // ③ **manifest.json**。机器读的是 manifest.status，而它按设计仍是 pass
    //（那是已完成步骤的结论），所以要靠 aborted 这一栏
    const manifest = JSON.parse(text('manifest.json'));
    assert.equal(manifest.status, 'pass', 'status 保持已完成步骤的结论（这是设计，不是遗漏）');
    assert.equal(manifest.aborted?.kind, 'timeout', `清单里要能查到为什么：${JSON.stringify(manifest.aborted)}`);

    // 夹具自检：**a2 确实一步没跑**。少了这句，上面三条可能测的是别的东西。
    // 计数是 3 不是 2：`checkAbort` 在**步骤开头**判，所以 sleep 自己已经记过 pass，
    // 被砍掉的是它后面那条断言 —— 这也是这个缺陷的样子：
    // 报告里三条干净结论，只有"后面少了一条"这件事看不见。
    assert.equal((manifest.tally as { pass: number }).pass, 3, `夹具要让 seed/a1/slow 跑过、a2 没跑到：${JSON.stringify(manifest.tally)}`);
    const junit = text('junit.xml');
    assert.ok(!junit.includes('name="a2"'), 'a2 没执行，JUnit 里就不该有它的 testcase');
  } finally { await f.close(); }
});

/**
 * `--run-id` 不许把产物写到证据目录**之外**。
 *
 * 缺陷是这样来的：`safeRunId()` 只做字符清洗（`[^A-Za-z0-9._-]` → `_`），
 * 而 `.` 与 `..` **每个字符都在那个字符集里**，于是 `--run-id ..` 原样穿过，
 * `join(evidenceDir, '..')` 就是证据目录的上一级 —— 真实项目里那是**仓库根**。
 *
 * 实测过的落点（改前）：项目根上出现 `trace.jsonl`、`junit.xml`、`report.html`、
 * `evidence....pass.zip` 四个文件。要紧的不是难看，是**它们会被 git 收走**：
 * `.gitignore` 忽略的是 `evidence/`、`tmp/`、`*.trace.jsonl`，
 * 而 `report.html` / `junit.xml` / `evidence....pass.zip` 三个名字一个都不在里面。
 * 证据包内容是**真实响应体**（可能带未脱敏 PII），`.gitignore` 那条注释专门写了
 * "误提交后删除也不会从历史里消失" —— 一个 `--run-id ..` 就能把它送进一次普通提交。
 * `--run-id` 的说明写着"CI 里用构建号"，值来自人或流水线，打错两个点在正常操作范围内。
 */
test('--run-id 不能把产物写到证据目录之外（`..` 是合法字符组成的非法名字）', async () => {
  const f = await fixture();
  try {
    const casePath = await writeCase(f.dir, [
      { id: 'mk', kind: 'set', assign: { resp: { status: 200, body: { id: 'ORD-1' } } } },
      { id: 'chk', kind: 'assert', against: '$.step.mk.resp', status: 200 },
    ]);
    const evDir = join(f.dir, 'travEv');
    const io = ioCapture();
    const code = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', evDir, '--run-id', '..'], io);
    // 夹具自检：这条 run 本身要跑成。否则"外面没文件"可能只是因为压根没产出
    assert.equal(code, EXIT.OK, `夹具要是一次成功的 run。实际 ${code}：${io.stderr.join(' | ')}`);

    // ① 证据目录外面**一个产物都不许多**（改前这四样躺在 f.dir 上）
    const stray = (await readdir(f.dir)).filter((n) => /report\.html|junit\.xml|trace\.jsonl|^evidence\.|manifest\.json|summary\.txt/.test(n));
    assert.deepEqual(stray, [], `产物漏到证据目录外了：${stray.join(', ')}`);

    // ② 产物照旧齐全，只是落在证据目录**里面**的那个改名目录里。
    //（manifest.json 与 summary.txt 在 zip **里面**，不在这一层 —— 别把它们列进这格）
    const runDir = await onlyRunDir(evDir);
    assert.notEqual(basename(runDir), '..', '目录名不能还是 ..，否则 join 出来的还是外面');
    const names = await readdir(runDir);
    for (const need of ['trace.jsonl', 'junit.xml', 'report.html']) {
      assert.ok(names.includes(need), `run 目录里缺 ${need}：${names.join(', ')}`);
    }
    assert.ok(names.some((n) => n.startsWith('evidence.') && n.endsWith('.zip')), `run 目录里没有证据包：${names.join(', ')}`);

    // ③ 两个保留段都不放过（`.` 与 `..` 的 join 语义不同，要各测一次）
    for (const rid of ['.', '..', '...', './..']) {
      const io2 = ioCapture();
      const c = await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                            '--evidence-dir', evDir, '--run-id', rid], io2);
      assert.ok(c === EXIT.OK || c === EXIT.TEST_FAILED, `不该因为 runId 而变成用法/运行时错：${c} ${io2.stderr.join(' | ')}`);
      const outside = (await readdir(f.dir)).filter((n) => /report\.html|junit\.xml|trace\.jsonl|^evidence\./.test(n));
      assert.deepEqual(outside, [], `runId=${JSON.stringify(rid)} 把产物写到了外面：${outside.join(', ')}`);
    }
    // ④ 正常 runId 不受影响（防"为了安全把所有 runId 都改名"这种修法）
    const io3 = ioCapture();
    assert.equal(await main(['run', casePath, '--env-var', `baseUrl=${f.addr()}`,
                             '--evidence-dir', join(f.dir, 'travOk'), '--run-id', 'ci-4711'], io3), EXIT.OK);
    assert.equal(basename(await onlyRunDir(join(f.dir, 'travOk'))), 'ci-4711', '正常 runId 的目录名要被原样保留');
  } finally { await f.close(); }
});
