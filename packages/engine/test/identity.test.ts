/**
 * 身份切换与鉴权**意图**的传递（docs/05 §2）。
 *
 * 这个文件原先不存在，而它的缺席正是那个 bug 的成因：
 * `useIdentity` 的解释器分支写了 `return { status: 'pass', summary: '切换身份 X' }`
 * 却什么都不切，跑出来全绿 —— 因为**没有任何测试看过 send 收到了什么**。
 * 只断言步骤状态是测不出这一类的：状态确实是对的（这一步本来就"该"通过），
 * 错的是它对下一步的影响。所以这里的每条核心断言都读 **captured**，
 * 也就是 adapter 实际收到的那一份请求。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { HttpExec } from '../src/index.js';
import { b, getStep, res, run, scen, stubComposeUrl, type RunOverrides, type StepDraft } from './helpers.js';

/**
 * 直接取接口自己的参数类型，**不在测试里重抄一份字段清单**。
 * 重抄的那份会和接口各自漂移：接口加了字段、测试那份没有，
 * 于是"引擎没把新字段交下来"这种真 bug 在测试里根本不可能被发现。
 */
type Sent = Parameters<HttpExec['send']>[0];

/** 记录每次 send 收到的请求。auth 是引擎交下来的**意图**，不是值 */
function fakeHttp(over: Partial<HttpExec> = {}): { http: HttpExec; sent: Sent[] } {
  const sent: Sent[] = [];
  const http: HttpExec = {
    // 不加 `as unknown as HttpExec`：那个 cast 会让"接口签名对不上"编译不过去这件事
    // 变成编译过得去。这个夹具要能替接口守住形状
    send: async (req) => {
      sent.push(req);
      return { status: 200, headers: {}, body: { ok: true }, bodyText: '{"ok":true}', durationMs: 1, bytes: 11, truncated: false };
    },
    /**
     * URL 组成走共享桩（`helpers.ts` 里那份，理由与"它刻意不序列化值"记在那儿）。
     * 本文件测的是**鉴权意图怎么交下来**，不是序列化；但桩仍如实扫占位符，
     * 否则 `unknown`/`missing` 那两个 error 分支会在本文件被绕开 ——
     * 而那两个分支一绕开，"pathParams 拼错名字"这种用例就变成安静地少发参数。
     */
    composeUrl: stubComposeUrl(),
    /**
     * 真实适配器的行为形状：**从 method+path 反查 operation**，查不到时生成稳定别名
     * （docs/05 §1 的别名算法）。夹具刻意保留这个"会自己算出一个值"的性质 ——
     * 写死一个固定 operationId 的话，"引擎有没有把步骤声明的 operationId 交下来"
     * 永远测不出来（断言会拿适配器自己那个值通过，而引擎那一段可以是空的）。
     *
     * 但反过来，光回显也不够：步骤声明了 operationId 时"用解析结果"与
     * "直接用步骤值"**算出来一模一样**，变异就活下来了（本文件第一轮就是这样）。
     * 所以要两种 fixture 各测一头：
     *  - 只写 operationId -> 只有 method/path 必须由适配器给（测 method/path 那一侧）
     *  - 只写 method+path -> 只有 operationId 必须由适配器给（测 operationId 那一侧）
     */
    resolveOperation: async (ref) => ({
      operationId: ref.operationId ?? `alias__${(ref.method ?? 'GET').toLowerCase()}_${(ref.path ?? 'x').replace(/\W+/g, '_')}`,
      method: ref.method ?? 'GET',
      // 与真实 parse.ts 一致：**相对**模板（urlTemplate === path，baseUrl 由环境提供，
      // `OperationSpec.urlTemplate` 那个字段的注释写明了这点）。
      // auth.path 交的也必须是这个相对形态 ——
      // 适配器按 o.path === ref.path 定位 operation，交绝对 URL 会定位不到
      urlTemplate: ref.path ?? '/o',
      requiredBodyFields: [], deprecated: false,

    }),
    ...over,
  };
  return { http, sent };
}

/** openapiCall 步骤的最小写法。docRef 必填（IR 要求），operationId 用 spec 里真实存在的那个名字 */
const oid = (id: string): StepDraft => ({ ...b(id), kind: 'openapiCall', docRef: 'shop.json', operationId: 'getMe' } as StepDraft);
const useId = (id: string, identity: string, extra: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'useIdentity', identity, ...extra } as StepDraft);

/**
 * 本文件统一从这里跑：带上 baseUrl。
 *
 * openapiCall 的地址模板是**相对**的（真实 parse.ts 里 urlTemplate === path，
 * baseUrl 由环境提供），所以没有 baseUrl 时引擎会在发送前就报 EnvMissing ——
 * 步骤根本没走到 send，测试就会以"auth 是 undefined"的形态失败，
 * 看着像鉴权坏了。第一次跑就是这个现象，所以宁可在夹具层面一次性给对。
 */
async function runWith(steps: StepDraft[], extra: Parameters<typeof scen>[1] = {}, over: RunOverrides = {}) {
  return run(scen(steps as never[], extra), { env: { baseUrl: 'http://x' }, ...over });
}

describe('useIdentity：要真的改变后续请求携带的身份', () => {
  test('切换之后的 http 请求带新身份（原先它读 scenario.identity，于是永远带旧的那个）', async () => {
    const { http, sent } = fakeHttp();
    const r = await run(scen([
      getStep('a'),
      useId('sw', 'admin'),
      getStep('b'),
    ]), { adapters: { http } });

    assert.equal(res(r, 'sw').status, 'pass');
    // 光断言"切了"是空的 —— 那句 summary 本来就写着切换成功。
    // 判据必须落在**下一个请求**上，否则这个测试与它要防的 bug 完全无关。
    assert.equal(sent[0]?.auth?.identity, undefined, '第一步之前没切过身份，不该带身份');
    assert.equal(sent[1]?.auth?.identity, 'admin', '切换之后必须带 admin');
  });

  test('openapiCall 也要收到 auth —— 它原先算完就丢，压根没传给 send', async () => {
    const { http, sent } = fakeHttp();
    await runWith([useId('sw', 'admin'), oid('call')], {}, { adapters: { http } });
    assert.ok(sent[0], 'openapiCall 没发出请求');
    assert.equal(sent[0]?.auth?.identity, 'admin');
    // docRef/method/path 是 adapter 去 spec 里查 securityScheme 的钥匙。
    // 少了它们，"按 spec 声明自动加鉴权"整条链路没有输入。
    assert.equal(sent[0]?.auth?.docRef, 'shop.json');
    assert.equal(sent[0]?.auth?.operationId, 'getMe');
  });

  test('三个定位字段（docRef/operationId/method+path）两头都要能通到 adapter', async () => {
    // 只写 method+path 的那一头：**operationId 只能由适配器给出**。
    // 只测"写了 operationId"那一头的话，"用解析结果"与"直接用步骤值"算出来完全一样，
    // 变异活了下来（本文件第一轮就是这样：三条 survived 全是这个形状）。
    const byPath = fakeHttp();
    const rByPath = await runWith([{ ...b('byPath'), kind: 'openapiCall', docRef: 'shop.json', method: 'POST', path: '/orders' } as StepDraft],
      {}, { adapters: { http: byPath.http } });
    // **先确认请求真的发出去了**。不写这一句的话，"步骤在发送前就 error 了"
    // 会显示成 `undefined !== 'POST'`，看不出是没发还是没带字段 —— 白绕一圈
    // （本文件第一次跑就栽在这上面：路径里带了 {id}，被"未填占位符"闸拦下）
    assert.equal(res(rByPath, 'byPath').status, 'pass', res(rByPath, 'byPath').assertionSummary ?? '没发出请求');
    const sentByPath = byPath.sent[0];
    assert.ok(sentByPath, 'byPath 没发出请求');
    assert.equal(sentByPath?.auth?.method, 'POST', 'method 得是解析后的（IR 里它可选，交 undefined 适配器就定位不到）');
    assert.equal(sentByPath?.auth?.path, '/orders');
    assert.match(sentByPath?.auth?.operationId ?? '', /^alias__/, 'operationId 必须由适配器解析出来，而不是留 undefined');

    // 只写 operationId 的那一头：method/path 只能由适配器给出
    const byId = fakeHttp();
    await runWith([oid('byId')], {}, { adapters: { http: byId.http } });
    assert.equal(byId.sent[0]?.auth?.method, 'GET', '步骤没写 method 时要用解析结果，否则适配器按 undefined 查');
    // 真实 parse.ts 里 urlTemplate 就是 path 本身（`buildOperation` 返回的那个
    // `urlTemplate: path`，不另拼 baseUrl），
    // 而适配器按 o.path === ref.path 匹配 —— 所以这里必须断"能对上"，
    // 而不是断它等于某个具体字符串（那是把实现的巧合钉死）
    assert.equal(byId.sent[0]?.auth?.path, '/o');
  });

  test('没切身份的 openapiCall 仍要带 docRef —— "没切身份"不等于"这是公开接口"', async () => {
    const { http, sent } = fakeHttp();
    await runWith([oid('call')], {}, { adapters: { http } });
    // 早先这里是 `identity ? {...} : undefined`，于是绝大多数正常请求
    // （有 security 声明、由凭证表决定用哪个 ref、但不涉及切身份）都变成匿名请求。
    assert.equal(sent[0]?.auth?.identity, undefined);
    assert.equal(sent[0]?.auth?.docRef, 'shop.json', '身份为空时 docRef 还得交下去，否则 adapter 无从查 spec');
  });

  test('步骤上明写的 identity 优先于场景级身份', async () => {
    const { http, sent } = fakeHttp();
    // 场景级身份**必须真的设上**，否则这条测的就只是"步骤身份能用"，
    // 而"优先于"那三个字没有任何判据 —— 这类空测试本仓已经抓过六条了
    const s = scen([getStep('plain'), { ...b('own'), kind: 'http', request: { method: 'GET', url: 'http://x/y' }, identity: 'stepRole' } as StepDraft],
      { identity: 'scnRole' });
    await run(s, { adapters: { http } });
    assert.equal(sent[0]?.auth?.identity, 'scnRole', '没写身份的步骤该用场景级默认身份');
    assert.equal(sent[1]?.auth?.identity, 'stepRole', '写了身份的步骤不能被场景级身份覆盖');
  });

  test('scenario.identity 作为默认身份，对两种请求入口都生效', async () => {
    const { http, sent } = fakeHttp();
    await runWith([getStep('a'), oid('b')], { identity: 'qa' }, { adapters: { http } });
    assert.deepEqual(sent.map((s) => s.auth?.identity), ['qa', 'qa'],
      '两个入口原先各写一份公式，其中一个读的是静态值 —— 分开断言才不会再出现只有一边对');
  });

  test('步骤上明写了 secret 引用时一起交下去（值仍由 adapter 解析）', async () => {
    const { http, sent } = fakeHttp();
    await run(scen([{ ...b('a'), kind: 'http', request: { method: 'GET', url: 'http://x/y' }, auth: 'secret:api_token' } as StepDraft]), {
      adapters: { http },
    });
    assert.equal(sent[0]?.auth?.ref, 'secret:api_token');
    // 引擎侧绝不能出现真值：它是 node-free 的，值一旦进来就能顺着 keyContext 流到磁盘
    assert.ok(!JSON.stringify(sent[0]).includes('Bearer'), '引擎不该拼出 Authorization');
  });
});

describe('身份的作用域：不泄漏、不竞态', () => {
  test('sequence 里的切换不外泄到后续步骤（容器出口复位）', async () => {
    const { http, sent } = fakeHttp();
    await run(scen([
      getStep('before'),
      { ...b('seq'), kind: 'sequence', steps: [useId('sw', 'admin'), getStep('inside')] } as StepDraft,
      getStep('after'),
    ]), { adapters: { http } });
    assert.deepEqual(sent.map((s) => s.auth?.identity), [undefined, 'admin', undefined],
      '序列里切了身份却把后面的步骤一起带跑，结果就完全依赖执行顺序，而顺序是看不见的');
  });

  test('子步骤失败时也要复位（复位写在 finally 里，不是只在正常路径）', async () => {
    const { http, sent } = fakeHttp();
    // fail 步骤会把 sequence 短路掉 —— 这条测的就是"中途 return 还算不算正常退出"
    const r = await run(scen([
      { ...b('seq'), kind: 'sequence', steps: [useId('sw', 'admin'), { ...b('boom'), kind: 'fail', reason: '故意失败' } as StepDraft] } as StepDraft,
      getStep('after'),
    ]), { adapters: { http } });
    assert.equal(res(r, 'seq').status, 'fail');
    assert.equal(sent[0]?.auth?.identity, undefined, '失败路径泄漏身份比正常路径更难查：它只在红过的场景之后出现');
  });

  test('forEach 每次迭代都从场景级身份重新开始', async () => {
    const { http, sent } = fakeHttp();
    await run(scen([
      { ...b('v'), kind: 'set', assign: { list: ['x', 'y'] } } as StepDraft,
      {
        ...b('loop'), kind: 'forEach', items: '$list', as: 'it', maxIterations: 5,
        steps: [useId('sw', 'admin'), getStep('in')],
      } as StepDraft,
      getStep('after'),
    ]), { adapters: { http } });
    assert.equal(sent.length, 3);
    assert.deepEqual(sent.map((s) => s.auth?.identity), ['admin', 'admin', undefined]);
  });

  test('parallel 的分支里有 useIdentity -> 当场 error，且不执行任何分支', async () => {
    const { http, sent } = fakeHttp();
    const r = await run(scen([
      {
        ...b('par'), kind: 'parallel', maxConcurrency: 2,
        steps: [
          { ...b('br1'), kind: 'sequence', steps: [useId('sw', 'admin'), getStep('r1')] } as StepDraft,
          { ...b('br2'), kind: 'sequence', steps: [getStep('r2')] } as StepDraft,
        ],
      } as StepDraft,
    ]), { adapters: { http } });
    assert.equal(res(r, 'par').status, 'error');
    // StepResult 上的字段叫 assertionSummary（Outcome.summary 在 dispatcher 里映射过去）。
    assert.match(res(r, 'par').assertionSummary ?? '', /useIdentity/,
      '报错必须指名那一步，否则用户看到 "parallel 里有 useIdentity" 还得自己去找是哪个分支');
    assert.match(res(r, 'par').assertionSummary ?? '', /br1/);
    // **一个请求都不该发出去**。分支里"切身份的没抢到"是调度决定的，
    // 那就不能先跑一半再报错 —— 半个副作用 + 一个 error 比整体不跑坏得多。
    assert.equal(sent.length, 0, `不该发出任何请求，实际发了 ${sent.length} 个`);
  });

  test('parallel 的静态判定要能钻进嵌套容器（分支里包一层 sequence 也算）', async () => {
    // 只查直接子步骤的话，最常见的写法（分支就是 sequence）正好漏掉，
    // 于是这道闸看起来在、实际拦不住任何东西
    const { http } = fakeHttp();
    const r = await run(scen([
      {
        ...b('par'), kind: 'parallel', maxConcurrency: 1,
        steps: [
          { ...b('br1'), kind: 'sequence', steps: [{ ...b('inner'), kind: 'sequence', steps: [useId('sw', 'admin')] } as StepDraft] } as StepDraft,
        ],
      } as StepDraft,
    ]), { adapters: { http } });
    assert.equal(res(r, 'par').status, 'error', '嵌套一层的 useIdentity 必须也被静态判定抓到');
  });

  test('parallel 不含 useIdentity 时照常跑（闸不能宽到把正常用法一起拒了）', async () => {
    const { http, sent } = fakeHttp();
    const r = await run(scen([
      {
        ...b('par'), kind: 'parallel', maxConcurrency: 2,
        steps: [getStep('r1'), getStep('r2')],
      } as StepDraft,
    ]), { adapters: { http } });
    assert.equal(res(r, 'par').status, 'pass');
    assert.equal(sent.length, 2);
  });
});
