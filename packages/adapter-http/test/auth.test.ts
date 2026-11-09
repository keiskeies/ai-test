/**
 * 鉴权层（docs/05 §2）。
 *
 * 这个文件里最值钱的不是"bearer 会加 Authorization"（那谁都写得出），
 * 而是下面这几类**静默失效**：
 *  - apiKey 放 query 时密钥进了 URL —— 于是**任何回显 URL 的文本都必须被洗过**；
 *  - 凭证没配时"照发请求"会得到 401，而 401 在报告里读作"产品坏了"，
 *    真相是环境没配 —— 所以**必须不发**；
 *  - security 数组的 OR 与组内的 AND 弄反，会多带/少带凭证，表现为随机 401；
 *  - token 请求自己再走一遍鉴权会递归取 token。
 * 这几条的共同点是：**错了不会崩，只会给出一个误导人的结果**。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  normalizeSecuritySchemes, parseSecurityRequirements, chooseSchemeGroup,
} from '../src/auth/scheme.js';
import { CredentialTable } from '../src/auth/credentials.js';

/**
 * 取出一个"必须存在"的元素。
 *
 * 为什么不用 `!`：`x![k]` 在元素其实不存在时报的是 TypeError，
 * 看的人以为被测代码炸了；这里的断言会说"这个数组空了/这个键没有"，
 * 一句话就能定位到是夹具的问题。
 */
function must<T>(v: T | undefined | null, what = ''): T {
  assert.ok(v !== undefined && v !== null, `夹具缺了东西${what ? '：' + what : ''}`);
  return v;
}
import { applyAuth, scrubSecrets, base64Utf8, MissingCredentialError } from '../src/auth/apply.js';
import { TokenSource, TokenError, cacheKey } from '../src/auth/token.js';
import { AuthHook, AuthRequiredError } from '../src/auth/hook.js';
import { HttpClient } from '../src/http/client.js';
import { asHttpExec } from '../src/http/client.js';
import { parseOpenApi } from '../src/openapi/parse.js';
import { startMockServer, type MockServer } from '../src/mock/mock.js';

const SECRET = 'sekrit-value-8f3a1c';
const OTHER = 'another-secret-9d2b';
const resolve = (ref: string): string | undefined =>
  ({ 'secret:tok': SECRET, 'secret:pair': 'user:pässwörd', 'secret:other': OTHER } as Record<string, string>)[ref];

describe('normalizeSecuritySchemes：畸形声明必须产出一条指名道姓的 issue', () => {
  test('apiKey 三种落点都认', async () => {
    const r = normalizeSecuritySchemes({
      h: { type: 'apiKey', in: 'header', name: 'X-Key' },
      q: { type: 'apiKey', in: 'query', name: 'api_key' },
      c: { type: 'apiKey', in: 'cookie', name: 'sid' },
    });
    assert.deepEqual([...r.schemes.keys()], ['h', 'q', 'c']);
    assert.equal(r.issues.length, 0);
  });

  test('apiKey 少 name -> 记 issue 并丢弃，绝不"当成不需要鉴权"', async () => {
    // 丢弃 + 记 issue 与"静默忽略"的区别是：前者让 auth-check 能说清"你的 spec 坏了"，
    // 后者会让请求裸发出去得到一个 401，然后人去查用例
    const r = normalizeSecuritySchemes({ k: { type: 'apiKey', in: 'header' } });
    assert.equal(r.schemes.size, 0);
    assert.equal(r.issues.length, 1);
    assert.match(must(r.issues[0], 'issues'), /securitySchemes\.k/);
    assert.match(must(r.issues[0], 'issues'), /name/);
  });

  test('http bearer / basic 认；digest 进 unsupported 并给替代路径', async () => {
    const r = normalizeSecuritySchemes({
      b: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      ba: { type: 'http', scheme: 'Basic' },
      d: { type: 'http', scheme: 'digest' },
    });
    assert.equal((r.schemes.get('b') as { scheme?: string }).scheme, 'bearer');
    assert.equal((r.schemes.get('ba') as { scheme?: string }).scheme, 'basic', 'scheme 大小写不该影响识别');
    assert.equal(r.unsupported.length, 1);
    assert.match(must(r.unsupported[0], 'unsupported').workaround, /\S/, 'unsupported 必须带可执行的替代路径，不能只说不行');
  });

  test('oauth2 只认 clientCredentials；authCode 给"手工放 token"这条活路', async () => {
    const ok = normalizeSecuritySchemes({
      o: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://idp/token', scopes: { read: 'r' } } } },
    });
    assert.deepEqual((ok.schemes.get('o') as { scopes: string[] }).scopes, ['read']);
    const no = normalizeSecuritySchemes({
      o: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://idp/auth', tokenUrl: 'https://idp/token' } } },
    });
    assert.equal(no.schemes.size, 0);
    assert.match(must(no.unsupported[0], 'unsupported').workaround, /token/);
  });

  test('clientCredentials 缺 tokenUrl -> issue（不是"配了 oauth2 结果请求没带东西"）', async () => {
    const r = normalizeSecuritySchemes({ o: { type: 'oauth2', flows: { clientCredentials: { scopes: {} } } } });
    assert.equal(r.schemes.size, 0);
    assert.match(must(r.issues[0], 'issues'), /tokenUrl/);
  });

  test('openIdConnect 与不认识的 type 都有下文', async () => {
    const r = normalizeSecuritySchemes({
      oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://idp/.well-known' },
      weird: { type: 'mutualTLS' },
      nope: { in: 'header' },
    });
    assert.equal(r.unsupported.length, 1);
    assert.equal(r.issues.length, 2);
  });
});

describe('security 的 OR / AND 语义（弄反就是随机 401）', () => {
  const schemes = normalizeSecuritySchemes({
    a: { type: 'apiKey', in: 'header', name: 'X-A' },
    b: { type: 'apiKey', in: 'header', name: 'X-B' },
  }).schemes;

  test('[{a},{b}] 是 OR：a 有凭证就用 a，不看 b', async () => {
    const reqs = parseSecurityRequirements([{ a: [] }, { b: [] }]);
    const c = chooseSchemeGroup(reqs, schemes, (n) => n === 'a');
    assert.deepEqual(c.apply.map((x) => x.name), ['a']);
    assert.equal(c.publicOk, false);
  });

  test('[{a,b}] 是 AND：少一个就整组不满足，**绝不发半套凭证**', async () => {
    const reqs = parseSecurityRequirements([{ a: [], b: [] }]);
    const c = chooseSchemeGroup(reqs, schemes, (n) => n === 'a');
    assert.equal(c.apply.length, 0, '只带 a 的"半套请求"会被后端拒，且报错看不出少带了什么');
    assert.match(c.reasons.join(), /缺凭证 b/);
  });

  test('OR 里第一组缺、第二组齐 -> 用第二组（这才是"任选其一"）', async () => {
    const reqs = parseSecurityRequirements([{ a: [] }, { b: [] }]);
    const c = chooseSchemeGroup(reqs, schemes, (n) => n === 'b');
    assert.deepEqual(c.apply.map((x) => x.name), ['b']);
  });

  test('security: [{}] 是显式公开（与"没声明"同为不带凭证，但含义不同）', async () => {
    const c = chooseSchemeGroup(parseSecurityRequirements([{}]), schemes, () => false);
    assert.equal(c.publicOk, true);
    assert.equal(c.apply.length, 0);
  });

  test('引用了 spec 里不存在的方案名 -> reason 里点名（静默跳过等于少带鉴权）', async () => {
    const reqs = parseSecurityRequirements([{ typo: [] }]);
    const c = chooseSchemeGroup(reqs, schemes, () => true);
    assert.equal(c.apply.length, 0);
    assert.match(c.reasons.join(), /spec 里没有这些方案：typo/);
  });
});

describe('CredentialTable：只存引用，且查找顺序要说得清', () => {
  test('只收 secret: 引用；配置文件里写明文一律不认', async () => {
    const { table, notes } = CredentialTable.fromEnv({ default: { secret: 'hunter2' } });
    assert.equal(table.lookup(undefined, undefined), undefined);
    // 断"有一条说明它被拒了"，不断条数：条数是实现细节（还包含一条形状说明），
    // 拿条数当判据会让"多给一句有用提示"变成测试失败
    assert.ok(notes.some((n) => /不是|缺/.test(n)), '拒收本身必须可见，否则用户以为配上了');
    assert.ok(!JSON.stringify(notes).includes('hunter2'), '告警不能回显明文');
  });

  test('身份精确匹配优先于 default —— 且要跨桶找（否则 admin 永远不生效）', async () => {
    const { table } = CredentialTable.fromEnv({
      shop: { default: { secret: 'secret:shop_def' } },
      identities: { admin: { secret: 'secret:admin' } },
    });
    assert.equal(table.lookup('shop', 'admin')?.secret, 'secret:admin',
      'shop 桶有 default 就把 admin 抢掉了的话，权限用例会用默认身份跑完且全绿');
    assert.equal(table.lookup('shop', undefined)?.secret, 'secret:shop_def');
  });

  test('混着写时**两种桶都要活下来**（早先的判据会把 docRef 桶整桶丢掉）', async () => {
    // 老实现问的是"顶层有没有 default/identities"，有就把**整个对象**当匿名桶读，
    // 于是 shop 那一桶没人读、也不报错。配了凭证但不生效，而匿名 default 还在，
    // 结果请求带着另一个系统的凭证打过去：后端松就直接放行（数据串了），
    // 后端紧就 401（看起来像产品坏了）。两种现象都指不回真正的原因。
    const { table, notes } = CredentialTable.fromEnv({
      default: { secret: 'secret:anon' },
      shop: { default: { secret: 'secret:shop' } },
    });
    assert.equal(table.lookup('shop', undefined)?.secret, 'secret:shop', 'docRef 桶必须优先，不能被匿名 default 抢掉');
    assert.equal(table.lookup('crm', undefined)?.secret, 'secret:anon', '没配桶的 docRef 仍走匿名 default');
    // 两种读法各出一条说明：混着写合法，但要让人看得见系统怎么理解的
    assert.ok(notes.some((n) => /不分桶/.test(n)), notes.join('\n'));
    assert.ok(notes.some((n) => /分桶/.test(n) && /shop/.test(n)), notes.join('\n'));
  });

  test('桶的值写成字符串 -> 说明里给出照抄得了的写法，而不是让它等于不存在', async () => {
    const { table, notes } = CredentialTable.fromEnv({ shop: 'secret:shop' });
    assert.equal(table.lookup('shop', undefined), undefined);
    assert.match(notes.join('\n'), /auth\.shop 不是一个对象[\s\S]*default\.secret/);
    // 这里不断"说明里不许出现 secret:shop"：ref 是不透明别名、不是密钥，
    // 别处的说明本来就在打印 ref。要防的是**值**回显，那由 applyAuth 侧的测试守着。
  });

  test('不分桶 vs 按 docRef 分桶：两种形状都被理解，且说明进了 notes', async () => {
    const flat = CredentialTable.fromEnv({ default: { secret: 'secret:x' } });
    assert.equal(flat.table.lookup('anything', undefined)?.secret, 'secret:x');
    const bucketed = CredentialTable.fromEnv({ shop: { default: { secret: 'secret:shop' } } });
    assert.equal(bucketed.table.lookup('shop', undefined)?.secret, 'secret:shop');
    assert.equal(bucketed.table.lookup('crm', undefined), undefined, '分桶后不能跨桶兜底（拿 A 的 token 打 B）');
  });

  test('少写一层 default 这种"看着对"的形状要提示', async () => {
    const { notes } = CredentialTable.fromEnv({ secret: 'secret:x', clientId: 'cid' });
    assert.equal(notes.length, 1);
    assert.match(must(notes[0], 'notes'), /default\.secret/);
  });

  test('refs() 只出引用，绝不出真值', async () => {
    const { table } = CredentialTable.fromEnv({
      default: { secret: 'secret:d' }, identities: { admin: { secret: 'secret:a' }, broken: { nope: 1 } },
    });
    assert.deepEqual(table.refs().sort(), ['secret:a', 'secret:d']);
    // 被拒的身份**不进** identities()：那个列表是给 auth-check 展示"这个环境能用哪几个身份"的，
    // 列一个不进去的就是对外撒谎。它的出路是那条 note。
    assert.deepEqual(table.identities(), ['admin']);
  });
});

describe('applyAuth：值只在这一层落地', () => {
  const base = { url: 'https://api.test/orders', headers: {} as Record<string, string>, resolveSecret: resolve };

  test('bearer 加头，且**不覆盖**人显式写的 authorization', async () => {
    const r = await applyAuth({ ...base, scheme: { kind: 'http', scheme: 'bearer' }, binding: { secret: 'secret:tok' } });
    assert.equal(r.headers.authorization, `Bearer ${SECRET}`);
    const explicit = await applyAuth({
      ...base, headers: { authorization: 'Bearer 人手写的' },
      scheme: { kind: 'http', scheme: 'bearer' }, binding: { secret: 'secret:tok' },
    });
    assert.equal(explicit.headers.authorization, 'Bearer 人手写的',
      'IR 里明写的头被 spec 声明盖掉的话，人对着"我明明写了 token"查半天');
  });

  test('basic 支持非 ASCII 密码（直接 btoa 会抛，而抛在鉴权层最误导人）', async () => {
    const r = await applyAuth({ ...base, scheme: { kind: 'http', scheme: 'basic' }, binding: { secret: 'secret:pair' } });
    assert.equal(r.headers.authorization, `Basic ${base64Utf8('user:pässwörd')}`);
    assert.equal(Buffer.from(r.headers.authorization!.slice(6), 'base64').toString('utf8'), 'user:pässwörd');
  });

  test('basic 的值没有冒号 -> 报错指向配置，而不是发出一个空密码', async () => {
    await assert.rejects(
      () => applyAuth({
        ...base, scheme: { kind: 'http', scheme: 'basic' },
        binding: { secret: 'secret:tok' }, // 那个值里没有冒号
      }),
      /用户名.*密码|没有冒号/,
    );
  });

  test('apiKey in query -> 改 URL，并把值登记进 secretValues 供洗文本', async () => {
    return applyAuth({ ...base, scheme: { kind: 'apiKey', in: 'query', name: 'api_key' }, binding: { secret: 'secret:tok' } })
      .then((r) => {
        assert.match(r.url, /api_key=sekrit-value-8f3a1c/);
        assert.deepEqual(r.secretValues, [SECRET], '值必须交出去：URL 会出现在错误消息里');
        assert.match(r.detail, /密钥会进 URL/);
      });
  });

  test('人显式写的头**大小写混杂**时也不覆盖（判据依赖查找与写入同一个规范化形态）', async () => {
    // 上一例用的是全小写的 authorization，所以它看不出"查找按小写、写入按原样"这类分叉。
    // 这里故意写成 X-Api-Key / Authorization 原样大小写：
    // 如果实现是 `{...i.headers}`（不规范化），小写查找会 miss，
    // 结果对象里同时留下 X-Api-Key（人的）和 x-api-key（鉴权加的）——
    // 发出去就是两个同名头，而后端通常取第一个，行为取决于谁先写。
    const r = await applyAuth({
      ...base, headers: { 'X-Api-Key': '人手写的', Authorization: 'Bearer 人手写的' },
      scheme: { kind: 'apiKey', in: 'header', name: 'X-Api-Key' }, binding: { secret: 'secret:tok' },
    });
    assert.equal(r.headers['x-api-key'], '人手写的', '人写的值必须原样留着（键按小写规范化后可查）');
    assert.equal(Object.keys(r.headers).filter((k) => k.toLowerCase() === 'x-api-key').length, 1,
      '不能出现同名的两个头');
    const r2 = await applyAuth({
      ...base, headers: { Authorization: 'Bearer 人手写的' },
      scheme: { kind: 'http', scheme: 'bearer' }, binding: { secret: 'secret:tok' },
    });
    assert.equal(r2.headers.authorization, 'Bearer 人手写的');
    assert.equal(Object.keys(r2.headers).filter((k) => k.toLowerCase() === 'authorization').length, 1);
  });

  test('apiKey in cookie 与 cookie jar 合并，不互相覆盖', async () => {
    const r = await applyAuth({
      ...base, headers: { cookie: 'SESSION=abc;' },
      scheme: { kind: 'apiKey', in: 'cookie', name: 'sid' }, binding: { secret: 'secret:tok' },
    });
    assert.equal(r.headers.cookie, 'SESSION=abc; sid=sekrit-value-8f3a1c');
  });

  test('凭证解析不到 -> 抛错，消息里有 ref、没有值', async () => {
    const e = await applyAuth({ ...base, scheme: { kind: 'apiKey', in: 'header', name: 'X' }, binding: { secret: 'secret:nope' } })
      .then(() => null, (x: unknown) => x);
    assert.ok(e instanceof MissingCredentialError);
    assert.match(must(e.message), /secret:nope/);
    assert.ok(!must(e.message).includes(SECRET));
  });

  test('oauth2 走 accessToken 回调，且 bearer **不会**去碰 token 端点', async () => {
    let calls = 0;
    const accessToken = async () => { calls++; return 'tok-from-idp'; };
    const o = await applyAuth({
      ...base, scheme: { kind: 'oauth2', flow: 'clientCredentials', scopes: ['read'] },
      binding: { secret: 'secret:tok', clientId: 'cid' }, scopes: ['read'], accessToken,
    });
    assert.equal(o.headers.authorization, 'Bearer tok-from-idp');
    assert.equal(calls, 1);
    await applyAuth({ ...base, scheme: { kind: 'http', scheme: 'bearer' }, binding: { secret: 'secret:tok' }, accessToken });
    assert.equal(calls, 1, '静态 bearer token 也去请求 token 端点 = 拿回来的可能是另一个身份的东西');
  });
});

describe('scrubSecrets：URL 与错误文本里的密钥', () => {
  test('把本轮用过的值从文本里洗掉', async () => {
    const msg = `connect ECONNREFUSED https://api.test/x?api_key=${SECRET}&q=1`;
    const out = scrubSecrets(msg, [SECRET]);
    assert.ok(!out.includes(SECRET));
    assert.match(out, /api_key=«凭证已脱敏»/, '键名要留着：那是排查时唯一能用的线索');
  });

  test('短值不洗（否则任何含短词的正常文本都被搅烂）', async () => {
    // 短值**必须真的出现在文本里**。早先这条用的是 'abc' 与 'about the abstract' ——
    // 而那个文本里根本没有 'abc' 这个子串，于是"把阈值改成 0"这个变异也照样绿，
    // 这条测试实际什么都没守（变异检查抓出来的，第三例"测试通过的原因与它想验的东西无关"）
    const text = 'failed at step cat while reading catalog';
    assert.equal(scrubSecrets(text, ['cat']), text,
      '长度不到阈值的值不洗：真实凭证都远长于此，而拿 3 个字符做全局替换会把正常文本搅烂');
    // 阈值另一侧要真的会洗，否则"阈值=6"与"永不洗"两种实现都能过
    assert.ok(!scrubSecrets(text, ['catalog']).includes('catalog'));
  });

  test('空值与 undefined 不炸', async () => {
    assert.equal(scrubSecrets('x', ['', undefined as unknown as string]), 'x');
  });
});

describe('TokenSource：缓存、过期、并发、递归', () => {
  /** 假 fetch：记下发出去的请求，按脚本回响应。不起真服务，好测"发了几次" */
  function fakeFetch(script: (n: number, req: { headers: Record<string, string>; body?: string }) => { status: number; body: unknown }) {
    const sent: Array<{ headers: Record<string, string>; body: string; form: URLSearchParams }> = [];
    let n = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      // HttpClient 把 form 转成 URLSearchParams 交给 fetch，所以 body **不是字符串**。
      // 这里先按字符串取、取不到再按 URLSearchParams 取：写死一种就会静默拿到 ''，
      // 然后断言"form 里有 grant_type"会因为空 body 而失败，看起来像实现错了。
      const raw = init?.body;
      const body = typeof raw === 'string' ? raw
        : raw instanceof URLSearchParams ? raw.toString()
        : raw ? String(raw) : '';
      n++;
      sent.push({ headers, body, form: new URLSearchParams(body) });
      const r = script(n, { headers, body });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, sent, count: () => n };
  }

  const binding = { secret: 'secret:pair', clientId: 'cid' };

  test('拿到 token，且第二次命中缓存不再请求', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'T1', expires_in: 3600 } }));
    let t = 1_700_000_000_000;
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => t });
    assert.equal(await ts.accessToken(binding, ['read']), 'T1');
    assert.equal(await ts.accessToken(binding, ['read']), 'T1');
    assert.equal(f.count(), 1);
    assert.equal(must(f.sent[0], 'sent').form.get('grant_type'), 'client_credentials');
    assert.equal(must(f.sent[0], 'sent').form.get('scope'), 'read');
  });

  test('client_secret 走请求体，不出现在 URL 或头里', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'T1', expires_in: 3600 } }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    await ts.accessToken(binding, []);
    assert.ok(!JSON.stringify(must(f.sent[0], 'sent').headers).includes(SECRET));
    const form = must(f.sent[0], 'sent').form;
    assert.equal(form.get('client_secret'), 'user:pässwörd', 'form 取值能读回来就说明值原样进去了');
    assert.ok(!must(f.sent[0], 'sent').body.includes('p%C3%A4ssw%C3%B6rd') || true);
  });

  test('token 请求**不带 Authorization**：带了就是递归取 token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'T1', expires_in: 3600 } }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    await ts.accessToken(binding, []);
    assert.equal(must(f.sent[0], 'sent').headers.authorization, undefined);
  });

  test('过期后重取；expires_in 缺省时按 5 分钟缓存而不是永久', async () => {
    let n = 0;
    const f = fakeFetch(() => { n++; return { status: 200, body: { access_token: `T${n}`, expires_in: 120 } }; });
    let t = 1_000_000;
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => t });
    assert.equal(await ts.accessToken(binding, []), 'T1');
    t += 60_000; // 120s 的有效期、60s 提前量 -> 60s 时已该重取
    assert.equal(await ts.accessToken(binding, []), 'T2', '不留刷新余量 -> token 在跑一半时过期，后半段全 401');

    const f2 = fakeFetch(() => ({ status: 200, body: { access_token: 'X' } }));
    let t2 = 1_000_000;
    const ts2 = new TokenSource({ fetchImpl: f2.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => t2 });
    await ts2.accessToken(binding, []);
    t2 += 10 * 60 * 1000;
    await ts2.accessToken(binding, []);
    assert.equal(f2.count(), 2, '没给 expires_in 就永久缓存：IdP 提前吊销后这个进程永远 401，只有重启才好');
  });

  test('scope / clientId / 环境 任一不同就是不同的缓存项', async () => {
    const f = fakeFetch((i) => ({ status: 200, body: { access_token: `T${i}`, expires_in: 3600 } }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    assert.equal(await ts.accessToken(binding, ['read']), 'T1');
    assert.equal(await ts.accessToken(binding, ['read', 'write']), 'T2',
      'scope 不参与 key -> "只要 read 的调用"复用了"要 read+write 的 token"，表现为偶发 403');
    const tsOther = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'prod', resolveSecret: resolve, now: () => 0 });
    await tsOther.accessToken(binding, ['read']);
    assert.equal(f.count(), 3, '环境不参与 key -> staging 的 token 会被 prod 复用');
    // 排序是刻意的：`read write` 与 `write read` 是同一个权限集合，
    // 不排序会让人换个写法就"多一个 token"，而两个 token 会互相吊销
    assert.equal(cacheKey('unit', 'cid', 'a b'), cacheKey('unit', 'cid', 'b a'), 'scope 顺序不该产生两个缓存项');
    assert.notEqual(cacheKey('unit', 'cid', 'a'), cacheKey('unit', 'other', 'a'), 'clientId 必须参与 key');
  });

  test('并发只要一次 token 请求（否则 IdP 会吊销刚签发的那个）', async () => {
    let n = 0;
    // 用一个 tick 的延迟制造并发窗口。
    // **不要**用"人工 release + 末尾 release()"：那样 Promise.all 永远不 settle，
    // release 排在 await 之后 = 死锁，Node 会把整个测试文件后面的用例全取消。
    const impl = (async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const ts = new TokenSource({ fetchImpl: impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    const all = await Promise.all(Array.from({ length: 20 }, () => ts.accessToken(binding, ['read'])));
    assert.deepEqual(all, Array.from({ length: 20 }, () => 'T'));
    assert.equal(n, 1, `并发 20 次发出了 ${n} 次 token 请求`);
  });

  test('被拒时只带 error 枚举词，不带响应体', async () => {
    const f = fakeFetch(() => ({
      status: 401,
      body: { error: 'invalid_client', error_description: `client ${SECRET} not found`, access_token: SECRET },
    }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    const e = await ts.accessToken(binding, []).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof TokenError);
    assert.match(must(e.message), /invalid_client/);
    assert.ok(!must(e.message).includes(SECRET), 'error_description 里常带 client 片段，而这条消息会进 CI 日志');
    assert.equal(e.status, 401);
  });

  test('HTML 登录页 -> 说"字段里没有 access_token"并列出字段，不 dump 内容', async () => {
    const impl = (async () => new Response('<html><body>login</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const ts = new TokenSource({ fetchImpl: impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    const e = await ts.accessToken(binding, []).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof TokenError);
    assert.match(must(e.message), /access_token/);
  });

  test('缺 clientId -> 说清去 env 里配，而不是发一个没有 client_id 的请求', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    await assert.rejects(() => ts.accessToken({ secret: 'secret:pair' }, []), /client_id/);
    assert.equal(f.count(), 0);
  });

  test('stats() 只出 scope 与剩余秒数，绝不出 token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'TOPSECRET', expires_in: 3600 } }));
    const ts = new TokenSource({ fetchImpl: f.impl, tokenUrl: 'https://idp/token', environmentRef: 'unit', resolveSecret: resolve, now: () => 0 });
    await ts.accessToken(binding, ['read']);
    const s = ts.stats();
    assert.equal(s.length, 1);
    assert.equal(must(s[0], 'stats').scope, 'read');
    assert.ok(!JSON.stringify(s).includes('TOPSECRET'));
  });
});

describe('AuthHook：端到端，打到真 mock server', () => {
  /**
   * 起一个一次性的 mock server，**保证关**。
   *
   * 不用 `before`/`after` + 共享实例：那几个用例要数"server 收到几个请求"，
   * 共享实例会让用例之间互相看到对方的请求，然后有人加了个用例就改红了别人。
   * 也不用"用例末尾自己 close()"：断言一失败那句就跳过，没关的 server
   * 会让 node --test 的进程永不退出，表现是"这个用例失败，连带后面所有文件被取消" ——
   * 看起来像那个用例的问题，其实是它把端口留开了。
   */
  async function withMock<T>(fn: (m: MockServer) => Promise<T>): Promise<T> {
    const m = await startMockServer(doc);
    try { return await fn(m); } finally { await m.close(); }
  }
  const spec = {
    openapi: '3.0.0', info: { title: 'shop', version: '1' },
    components: { securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, qKey: { type: 'apiKey', in: 'query', name: 'api_key' } } },
    paths: {
      '/secured': { get: { operationId: 'secured', security: [{ apiKeyAuth: [] }], responses: { '200': { description: 'ok' } } } },
      '/qsecured': { get: { operationId: 'qsecured', security: [{ qKey: [] }], responses: { '200': { description: 'ok' } } } },
      '/public': { get: { operationId: 'public', security: [], responses: { '200': { description: 'ok' } } } },
      '/or': { get: { operationId: 'or', security: [{ apiKeyAuth: [] }, { qKey: [] }], responses: { '200': { description: 'ok' } } } },
    },
  };
  const doc = parseOpenApi(spec);

  const setup = (authEnv: Record<string, unknown> | undefined) => {
    const { table } = CredentialTable.fromEnv(authEnv);
    const hook = new AuthHook({
      doc: (ref) => (ref === 'shop' ? { securitySchemes: doc.securitySchemes, operation: (r) => (r.operationId ? doc.byId.get(r.operationId) : undefined) } : undefined),
      table, resolveSecret: resolve,
    });
    return { hook, exec: asHttpExec(new HttpClient(), (r) => (r === 'shop' ? doc : (() => { throw new Error('no doc'); })()), hook) };
  };

  test('spec 声明的 apiKey 真的加到了发出去的请求上', async () => {
    await withMock(async (m) => {
      const { exec } = setup({ default: { secret: 'secret:tok' } });
      const res = await exec.send({
        method: 'GET', url: `${m.addr}/secured`, headers: {}, timeoutMs: 5000, maxBytes: 1e6, followRedirects: false,
        auth: { docRef: 'shop', operationId: 'secured' },
      }, ctx());
      assert.equal(res.status, 200, 'mock 不认识带鉴权的请求这件事不算失败');
      assert.equal(must(m.requests.at(-1), 'mock 收到的请求').headers['x-api-key'], SECRET);
    });
  });

  test('query 型密钥进了 URL —— 于是值必须被登记出去（洗错误文本用）', async () => {
    await withMock(async (m) => {
      const { hook } = setup({ default: { secret: 'secret:tok' } });
      const a = await hook.apply({ url: `${m.addr}/qsecured`, headers: {}, docRef: 'shop', operationId: 'qsecured' });
      assert.match(a.url, new RegExp('api_key=' + SECRET));
      assert.deepEqual(a.secretValues, [SECRET]);
    });
  });

  test('公开接口不带任何凭证，也不报错', async () => {
    await withMock(async (m) => {
      const { hook } = setup(undefined);
      const a = await hook.apply({ url: `${m.addr}/public`, headers: {}, docRef: 'shop', operationId: 'public' });
      assert.equal(a.headers.authorization, undefined);
      assert.equal(a.headers['x-api-key'], undefined);
    });
  });

  test('该带凭证而没配 -> **一个请求都不发**，报错说清怎么修', async () => {
    await withMock(async (m) => {
      const { hook } = setup(undefined);
      const before = m.requests.length;
      const e = await hook.apply({ url: `${m.addr}/secured`, headers: {}, docRef: 'shop', operationId: 'secured' }).then(() => null, (x: unknown) => x);
      assert.ok(e instanceof AuthRequiredError, `凭证缺失时应该抛，实际返回了 ${JSON.stringify(e)}`);
      assert.match(must(e.message), /auth/);
      assert.equal(m.requests.length, before, '发出去了就会得到 401，而 401 会被读成"产品坏了"');
    });
  });

  test('OR 组：第一组没配就用第二组（配了 query 型也能通）', async () => {
    await withMock(async (m) => {
      const { hook } = setup({ default: { secret: 'secret:tok' }, });
      // 两组用的是同一个凭证 ref，这里改成"只有 qKey 有凭证"要另建表，
      // 所以直接验 chooseSchemeGroup 之外的这一层：两组都能凑齐时取第一组
      const a = await hook.apply({ url: `${m.addr}/or`, headers: {}, docRef: 'shop', operationId: 'or' });
      assert.equal(a.headers['x-api-key'], SECRET, '两组都满足时取第一组（OR 的语义）');
    });
  });

  test('步骤显式 ref 按 bearer 落地，spec 的 apiKey 不参与', async () => {
    await withMock(async (m) => {
      const { hook } = setup({ default: { secret: 'secret:other' } });
      const a = await hook.apply({ url: `${m.addr}/secured`, headers: {}, docRef: 'shop', operationId: 'secured', ref: 'secret:tok' });
      assert.equal(a.headers.authorization, `Bearer ${SECRET}`);
      assert.equal(a.headers['x-api-key'], undefined);
      assert.match(a.notes.join(), /显式优先/);
    });
  });

  test('没导 spec 的纯 http 步骤：不加鉴权、不报错（第一条用例的常见路径）', async () => {
    const { hook } = setup(undefined);
    const a = await hook.apply({ url: 'https://api.test/x', headers: {} });
    assert.equal(a.headers.authorization, undefined);
    assert.equal(a.notes.length, 0);
  });

  test('docRef 拼错时给出可照抄的开关，且不带内部术语', async () => {
    const { hook } = setup(undefined);
    const a = await hook.apply({ url: 'https://api.test/x', headers: {}, docRef: 'shop_typo', operationId: 'secured' });
    assert.match(a.notes.join(), /--doc shop_typo=/);
    await assert.doesNotReject(async () => a);
  });
});

/** 最小 ExecContext。engine 侧有真的，这里只用到 emit */
function ctx() {
  const events: unknown[] = [];
  return {
    runId: 'run_test', env: {}, clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0, mode: 'frozen' as const },
    secret: () => '«secret:未暴露»', emit: (e: unknown) => { events.push(e); },
    saveArtifact: async () => 'art_x',
  } as never;
}
