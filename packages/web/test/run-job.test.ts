/**
 * `run-job.ts` 那三条判据的测试（node 里跑，不起浏览器）。
 *
 * ## 为什么这一半不进浏览器
 *
 * 被测的东西是**契约**：id 的形状、四种取消回答各自该说什么、409 不许吞。
 * 它们全是纯 TS + 一个注入的 fetch，放进浏览器测只会让失败归因变模糊
 * （"按钮坏了"与"id 造错了"在同一个红里分不开）。
 * 浏览器那条测试（`browser-run-button.test.ts`）只补一件事：**按钮真的接上了这个模块**。
 *
 * ## 其中一条测的是"镜像不许漂"，而它的做法要说明
 *
 * `JOB_ID_SHAPE` 是服务端那张正则的**副本**（依赖方向不许 web import server，
 * `tooling/lint-layers.mjs` 连测试目录一起管）。副本会漂，而漂了的症状很难看：
 * 前端造出一个服务端不认的 id => 提交被拒，或跑起来了却永远取消不掉。
 *
 * 所以这里**去读服务端的源码**并把两张正则逐字比。为什么不是"把服务端的正则 import 进来比"：
 * 那个 import 会被分层规则拦掉（这是有意的，前端不许认识服务端），而更重要的是
 * **import 来自证等于没证** —— 两边同源就永远相等，漂不了的东西不需要测。
 * 读源码是**独立的一条通道**：服务端改了那张正则，这边立刻红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

import { JOB_ID_SHAPE, newJobId, requestCancel, submitRun } from '../src/run-job.js';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** 假 fetch：按脚本回响应，并记下每一次调用 */
function fakeFetch(script: Array<{ status: number; body: unknown }>): { fetch: any; calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  return {
    calls,
    fetch: async (url: string, init: any) => {
      calls.push({ url, init });
      const s = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return { status: s.status, text: async () => JSON.stringify(s.body) };
    },
  };
}

/* ── jobId ──────────────────────────────────────────────────────────────── */

test('jobId 形状与服务端那张**逐字相同**（读源码，不 import 自证）', async () => {
  const src = await readFile(join(ROOT, 'packages/server/src/index.ts'), 'utf8');
  const m = /const JOB_ID = (\/.+?\/)\s*;/.exec(src);
  assert.ok(m, '在 server/src/index.ts 里找不到 `const JOB_ID = /…/;` —— 它被改名或删了？那就得同步这边');
  assert.equal(JOB_ID_SHAPE.source, new RegExp(m[1]!.slice(1, -1)).source,
    '前端这张与服务端那张**漂了**。漂了的症状很难看：前端造出服务端不认的 id => '
    + '要么提交被拒，要么 run 跑起来了却永远取消不掉（取消那一侧用同一张正则拒绝它）');
});

test('jobId 只用合法字符、长度在上限内、同毫秒内不自撞', () => {
  /*
   * **把 Math.random 钉成常量**再测自撞，而不是"抽 500 次看撞了几个"。
   * 后者我先前就是这么写的（阈值 490），而负控测出来它抓不到"把页内自增那一段删掉"：
   * 只剩随机段时，同一毫秒抽 500 次的期望碰撞数不到 0.1 次，阈值永远够不着 ——
   * 等于用"大概不会撞"证"不会撞"（docs/08 §3 里"形状对了不等于走到位"的姐妹：
   * **概率上没撞上，不等于那段代码在起作用**）。
   * 钉住随机源之后，同毫秒的 id 之间**只剩页内自增**这一个区分量，
   * 它没生效就立刻全撞成同一个字符串。
   */
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push(newJobId(1_700_000_000_000));   // 同一个"此刻"
    assert.deepEqual(new Set(ids).size, ids.length,
      `同一个"此刻"里 ${ids.length} 次调用只造出 ${new Set(ids).size} 个 id：`
      + '页内自增那一段没生效，此时同一毫秒内连点两次运行会拿到同一个 jobId => '
      + '服务端第二下回 409，屏幕上表现为"我点了运行，什么都没发生"');
    for (const id of ids) {
      assert.match(id, JOB_ID_SHAPE, `造出的 id 服务端不认：${id}`);
      assert.ok(id.length <= 64, `超长：${id}`);
    }
  } finally { Math.random = realRandom; }

  // 随机源放回真值：跨毫秒/跨标签页也要不同（这一条只验"别返回同一个字符串"）
  assert.notEqual(newJobId(), newJobId(), '不同时刻也该给出不同的 id');
});

/* ── 提交 ───────────────────────────────────────────────────────────────── */

test('提交时带上 jobId —— 不带的话取消这条路根本没有落点', async () => {
  const f = fakeFetch([{ status: 200, body: { exitCode: 0, output: 'ok', jobId: 'j1' } }]);
  const r = await submitRun({ scenario: 'scn.demo', jobId: 'j1', fetchImpl: f.fetch });
  assert.equal(r.ok, true, r.message);
  assert.equal(f.calls.length, 1);
  const sent = JSON.parse(f.calls[0]!.init.body);
  assert.equal(sent.jobId, 'j1', '请求体里没有 jobId => 服务端那一格 `cancellable:false`，按钮点了也没用');
  assert.equal(sent.scenario, 'scn.demo');
});

test('提交这一格**不提供**"已受理"的时机 —— 因为它不存在（防后来人再加一个假回调）', async () => {
  /*
   * 我先前给 submitRun 写过 `onAccepted`，写在 `await fetch` 之后 —— 那条 API 是阻塞的，
   * 所以那个时机就是"run 已经结束"，挂在那里的取消按钮等于没有。
   * 挪到 await 之前也不行：那一刻请求可能还在路上，名字就是谎话。
   * 所以这一格**只**告诉调用方两件事：请求发出去了没有、run 结束了没有。
   * 取消按钮由 UI 在点"运行"那一刻就挂出来（app.ts），404 的措辞负责那条窄竞态。
   *
   * 这条测的是签名里**没有**那个参数。看起来像没测东西，但它挡的是一个会自然发生的
   * 改动："让按钮早点出现" => 加个 onAccepted => 按钮出现了，而在 run 结束时才出现，
   * 于是看起来像"取消没生效"。
   */
  const f = fakeFetch([{ status: 200, body: { exitCode: 0 } }]);
  const calls: string[] = [];
  const r = await submitRun({
    scenario: 's', jobId: 'j', fetchImpl: f.fetch,
    ...( { onAccepted: () => calls.push('x') } as Record<string, unknown> ),   // 传了也没人调
  } as Parameters<typeof submitRun>[0]);
  assert.deepEqual(calls, [], '如果这条红了：有人又加了一个"已受理"回调，而阻塞式 API 给不出这个时机');
  assert.equal(r.exitCode, 0);
});

test('409 要说得出"没提交成功"，且**不许悄悄换个 id 再跑一遍**', async () => {
  const f = fakeFetch([{ status: 409, body: { error: 'jobId j1 正在被另一个 run 占用' } }]);
  const r = await submitRun({ scenario: 's', jobId: 'j1', fetchImpl: f.fetch });
  assert.equal(r.ok, false);
  assert.match(r.message, /没能提交/);
  assert.match(r.message, /占用/);
  // 正题：一次失败就一次请求。重试 = 替用户又跑了一遍场景（里面可能有 POST/下单/删除）
  assert.equal(f.calls.length, 1, '被拒之后又发了一次请求，那是第二遍副作用');
});

test('退出码非 0 不算 ok，但 message 仍给得出码（"跑完了、结果是红的"要能显示）', async () => {
  const f = fakeFetch([{ status: 201, body: { exitCode: 1, output: '有断言失败' } }]);
  const r = await submitRun({ scenario: 's', jobId: 'j', fetchImpl: f.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output, '有断言失败');
});

test('连不上服务端要说"连不上"，不能显示成"跑失败了"', async () => {
  const r = await submitRun({
    scenario: 's', jobId: 'j',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /连不上服务端/);
  assert.equal(r.exitCode, undefined, '连不上时**没有**退出码。给个 0 或 1 都是编出来的结论');
});

/* ── 取消 ───────────────────────────────────────────────────────────────── */

test('取消走 query 而不是路径段，且 jobId 编码过', async () => {
  const f = fakeFetch([{ status: 200, body: { actedOn: true, state: 'running' } }]);
  await requestCancel({ jobId: 'a.b-c_1', fetchImpl: f.fetch });
  assert.equal(f.calls[0]!.url, '/api/cancel?jobId=a.b-c_1');
  assert.equal(f.calls[0]!.init.method, 'POST');
  // 带分隔符的 id 过不了 JOB_ID_SHAPE，但**编码这一手不能省**：这一格将来可能被别的调用方复用
  const f2 = fakeFetch([{ status: 400, body: { error: '形状不合法' } }]);
  const r2 = await requestCancel({ jobId: 'a/b', fetchImpl: f2.fetch });
  assert.match(f2.calls[0]!.url, /jobId=a%2Fb$/, '没编码 => 那个斜杠会变成路径的一部分');
  assert.equal(r2.ok, false);
});

test('排队中的取消：话说成"一个请求都不发"，而不是"会被中断"', async () => {
  const f = fakeFetch([{ status: 200, body: { actedOn: true, state: 'queued' } }]);
  const r = await requestCancel({ jobId: 'j', fetchImpl: f.fetch });
  assert.equal(r.actedOn, true);
  assert.match(r.message, /还没开工.*一个请求都不会发/, r.message);
});

test('跑动中的取消：说"下一步开头停下、已发出不追回"，**不说已取消**', async () => {
  const f = fakeFetch([{ status: 200, body: { actedOn: true, state: 'running' } }]);
  const r = await requestCancel({ jobId: 'j', fetchImpl: f.fetch });
  assert.match(r.message, /下一步开头/);
  assert.match(r.message, /不追回/);
  // 这一条是本模块的立身之本。"已取消"是三档里**没有任何一档**为真的一句话：
  // 排队中=压根不会跑、跑动中=下一步才停、已结束=没东西可停
  assert.doesNotMatch(r.message, /已取消/, `"${r.message}" 里那句"已取消"是三档里没有任何一档为真的断言`);
});

test('已结束： actedOn=false 也要回一句人话，不能报错', async () => {
  const f = fakeFetch([{ status: 200, body: { actedOn: false, state: 'done', alreadyCancelled: false } }]);
  const r = await requestCancel({ jobId: 'j', fetchImpl: f.fetch });
  assert.equal(r.ok, true, '慢一拍点按钮是常态，报成错误会让人去按第二下');
  assert.equal(r.actedOn, false);
  assert.match(r.message, /已经跑完/);
});

test('重复点取消看得见（第二下与"取消没生效"必须分得开）', async () => {
  const f = fakeFetch([{ status: 200, body: { actedOn: true, state: 'running', alreadyCancelled: true } }]);
  const r = await requestCancel({ jobId: 'j', fetchImpl: f.fetch });
  assert.match(r.message, /之前已经点过一次/);
});

test('404 不说"或它已经结束了"（那是假归因）', async () => {
  const f = fakeFetch([{ status: 404, body: { error: '没有登记过 jobId j（从未提交，或结束后被后续 job 挤出了表）' } }]);
  const r = await requestCancel({ jobId: 'j', fetchImpl: f.fetch });
  assert.equal(r.ok, false);
  assert.match(r.message, /从未提交/);
  assert.doesNotMatch(r.message, /已经(结束|跑完).*job|这个 job 已经结束/,
    '把"没登记过"说成"已结束"，人会以为自己的提交成功了');
});

test('取消请求发不出去 ≠ 取消失败（前者是网络，后者是判定）', async () => {
  const r = await requestCancel({ jobId: 'j', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.ok, false);
  assert.equal(r.actedOn, false);
  assert.match(r.message, /没送出去/);
});
