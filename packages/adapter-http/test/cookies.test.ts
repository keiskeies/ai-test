/**
 * 会话 cookie（docs/05 §2「会话」那一行的执行侧）。
 *
 * ## 这一族为什么单独一份，而不塞进 auth.test.ts
 * 鉴权那一族测的是"这一次请求该带什么凭证"，是**无状态**的判断；
 * 这一族测的是"上一条响应改变下一条请求"，是**有状态**的判断。
 * 有状态的东西的坏法完全不同：它不会让当前这一步报错，
 * 它会让**下一步**带着不该带（或漏带）的东西出去，
 * 于是报告里红/绿的位置与真正的缺陷位置**不在同一步**上。
 *
 * ## 这份文件里最值钱的不是"cookie 会带上"
 * 是下面这几条**反向**与**归因**的判据，它们的共同点是"错了不会崩，只会给出误导人的结果"：
 *  - 过期的 cookie 还在发（后端语义是登出，用例却在测一个早该不存在的身份）；
 *  - `Secure` 的 cookie 在 http 下也发（作者以为标了就安全）；
 *  - `Domain=example.com` 存下之后对 `notexample.com` 也放行（跨主机泄露会话）；
 *  - 人在 IR 里显式写的 `Cookie` 头被 jar 里的同名值盖掉（用另一个身份跑完整个场景）；
 *  - 多条 `Set-Cookie` 被按逗号拆开（`Expires` 里有逗号）。
 * 每一条都是**看起来能用**的实现，而只有正向用例（登录后第二个请求带上了 sid）时，
 * 上面这五条**一条都测不到**。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CookieJar, parseSetCookie, setCookiesOf, domainMatches, pathMatches, defaultPath, expiryOf, normalizeDomain,
} from '../src/http/cookies.js';
import { HttpClient } from '../src/http/client.js';
import { TokenSource } from '../src/auth/token.js';
import { asHttpExec } from '../src/http/client.js';
import { runScenario, deterministicClock, type AdapterRegistry } from '@atest/engine';
import { defineScenario, type ScenarioDraft } from '@atest/ir';

/** 冻住的时钟。不冻的话"过期"这类断言要么 sleep 真实时间，要么靠运气 */
const T0 = 1_700_000_000_000;
const jar = (now: () => number = () => T0): CookieJar => new CookieJar({ now });

const HOST = 'https://api.example.com';

describe('parseSetCookie：切分的哪一半对、哪一半错', () => {
  test('基本形态与属性名小写化', () => {
    const a = must(parseSetCookie('sid=abc; Path=/api; HttpOnly; Secure'), '基本形态没解析出来');
    assert.equal(a.name, 'sid');
    assert.equal(a.value, 'abc');
    assert.equal(a.attrs['path'], '/api');
    assert.ok('httponly' in a.attrs && 'secure' in a.attrs, '布尔属性（无值）丢了');
  });

  test('值里的等号不能被当成属性分隔（base64 的 == padding 会把值截断）', () => {
    const a = must(parseSetCookie('tok=eyJhOiIxIn0=; Path=/'), '带 padding 的值没解析出来');
    assert.equal(a.value, 'eyJhOiIxIn0=');
  });

  test('畸形输入返回 undefined 而不是抛：一条坏 Set-Cookie 不该让整次 run 炸', () => {
    for (const bad of ['', '=novalue', 'novalue', '   ', ';']) {
      assert.equal(parseSetCookie(bad), undefined, `畸形串被收进来了：${JSON.stringify(bad)}`);
    }
  });

  test('同名属性重复时取第一个（RFC 6265 §5.2 对多个 Expires 的规定）', () => {
    const a = must(parseSetCookie('a=1; Path=/x; Path=/y'), '重复属性没解析出来');
    assert.equal(a.attrs['path'], '/x');
  });
});

describe('域与路径匹配：松一档就是跨主机泄露会话', () => {
  test('host-only 只接受完全相同的主机', () => {
    assert.equal(domainMatches('api.example.com', 'api.example.com', true), true);
    assert.equal(domainMatches('api.example.com', 'evil-example.com', true), false);
    // 这一条最要紧：host-only 的 cookie 发给子域是**错**的（浏览器就不发）
    assert.equal(domainMatches('api.example.com', 'sub.api.example.com', true), false,
      'host-only 的 cookie 被发给了子域');
  });

  test('host-only 拿得到自己的域 —— 这一格从前是空的，于是最常见的那一档永远匹配不上', () => {
    /*
     * 这条测试是**修 bug 那条**，不是补充说明。
     * 我第一版把 `StoredCookie.domain` 写成 `string | undefined` 并用 undefined 表示
     * host-only，于是匹配函数拿到 undefined 只能返回 false ——
     * **每一条不写 Domain 的 Set-Cookie 都发不回去**，而那是后端最常见的写法。
     * 症状还特别像别的毛病："存了 1 条而没发出去"读起来像路径或域不匹配。
     * 所以这里钉的是**形状**：host-only 也必须有可比对的域。
     */
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc']); // 不带任何属性 = host-only + 默认 path
    assert.equal(j.dump()[0]?.domain, 'api.example.com', 'host-only 的 cookie 没记下归属主机');
    assert.equal(j.dump()[0]?.hostOnly, true);
    assert.equal(j.headerFor(`${HOST}/me`), 'sid=abc', 'host-only 这一档压根发不出去');
  });

  test('Domain 型接受自己与**点边界**的后缀，不接受看着像的后缀', () => {
    assert.equal(domainMatches('example.com', 'example.com', false), true);
    assert.equal(domainMatches('example.com', 'sub.example.com', false), true);
    assert.equal(domainMatches('example.com', 'notexample.com', false), false,
      '后缀匹配没看点边界：notexample.com 拿到了 example.com 的会话');
    assert.equal(domainMatches('example.com', 'api.example.com.evil.io', false), false);
  });

  test('域大小写与末尾点规范化', () => {
    assert.equal(normalizeDomain('.API.Example.COM'), 'api.example.com');
    assert.equal(normalizeDomain(''), undefined);
    assert.equal(domainMatches('example.com.', 'example.com', false), true,
      'host 末尾的点（FQDN 写法）没被规范化，同一主机匹配不上自己');
  });

  test('服务端不能把 cookie 塞给无关域名（响应说了不算）', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['evil=v; Path=/; Domain=evil.org']);
    assert.equal(j.dump().length, 0, '一个响应把会话投递给了无关主机');
    assert.equal(j.headerFor('https://evil.org/x'), undefined);
  });

  test('单标签 Domain（`Domain=com`）被拒 —— 那是"接管整条 TLD"的写法', () => {
    /*
     * 反直觉的一半是：**光靠后缀匹配挡不住它**。
     * `domainMatches('com', 'api.example.com', false)` 是 true（每个 *.com 主机都是它的
     * 点边界后缀，本机实测过），所以必须有这条独立的"至少含一个点"的规则。
     * 而它只挡得住**单标签**那一类；两段的公域后缀（`Domain=co.uk`）仍然挡不住，
     * 那要公域后缀表。已登记 docs/14 §5，不在这儿假装做完。
     */
    const j = jar();
    j.store(`${HOST}/login`, ['tld=v; Path=/; Domain=com', 'dotted=v2; Path=/; Domain=example.com']);
    assert.deepEqual(j.dump().map((c) => c.name), ['dotted'],
      '单标签 Domain 被收下了，而点分的那个才是该收的');
  });

  test('路径前缀匹配：/api 不匹配 /apifoo', () => {
    assert.equal(pathMatches('/api', '/api'), true);
    assert.equal(pathMatches('/api', '/api/x'), true);
    assert.equal(pathMatches('/api', '/apifoo'), false, '前缀匹配没补斜杠：一条 cookie 覆盖了整个站');
    assert.equal(pathMatches('/', '/anything'), true);
  });

  test('默认 path 是「那个 URL 的目录」，不是 /', () => {
    assert.equal(defaultPath('/v1/orders/7'), '/v1/orders');
    assert.equal(defaultPath('/login'), '/');
    assert.equal(defaultPath('/'), '/');
  });
});

describe('过期：两种删除写法都要认', () => {
  test('Max-Age 覆盖 Expires，且负数=立刻过期', () => {
    const a = must(parseSetCookie('a=1; Max-Age=-5; Expires=Wed, 09 Jun 2031 10:18:14 GMT'), '没解析出来');
    assert.equal(expiryOf(a, T0), T0 - 5000, 'Max-Age 没覆盖 Expires（RFC 规定它覆盖，含负数）');
  });

  test('Max-Age 是非数字时当"没有这个属性"，而不是 NaN 一路比下去', () => {
    const a = must(parseSetCookie('a=1; Max-Age=abc'), '没解析出来');
    assert.equal(expiryOf(a, T0), 'session', 'NaN 参与过期比较会把 cookie 当成永不过期或立刻过期，取决于比较方向');
  });

  test('Expires 解析不出来时是会话 cookie，不是"永久"', () => {
    const a = must(parseSetCookie('a=1; Expires=明天'), '没解析出来');
    assert.equal(expiryOf(a, T0), 'session');
  });
});

describe('CookieJar：存与发的配对，重点是**不许发**的那些', () => {
  test('存下来并对同主机同路径发回去（正向地板）', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc; Path=/']);
    assert.equal(j.headerFor(`${HOST}/me`), 'sid=abc');
  });

  test('三条 Set-Cookie 各自成条，Expires 里的逗号不拆开属性', () => {
    const j = jar();
    j.store(`${HOST}/login`, [
      'sid=abc; Path=/; HttpOnly',
      'theme=dark; Path=/',
      'JSESSIONID=xyz; Path=/; Expires=Wed, 09 Jun 2031 10:18:14 GMT',
    ]);
    const h = must(j.headerFor(`${HOST}/me`), '三条都没发出去');
    assert.deepEqual(h.split('; ').sort(), ['JSESSIONID=xyz', 'sid=abc', 'theme=dark'],
      '多条 cookie 的形态被合并规则破坏了');
    assert.equal(j.dump().length, 3, '存的条数不对 —— 按逗号切的话会存出一堆带属性的假名字');
    for (const c of j.dump()) assert.ok(!c.value.includes(';') && !c.value.includes(','), `${c.name} 的值里混进了属性：${c.value}`);
  });

  test('Max-Age=0 是删除：旧值必须消失', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc; Path=/']);
    j.store(`${HOST}/logout`, ['sid=; Path=/; Max-Age=0']);
    assert.equal(j.headerFor(`${HOST}/me`), undefined, '登出之后还在带旧会话');
    assert.equal(j.dump().length, 0);
  });

  test('过去时刻的 Expires 也是删除（后端另一种常见写法，只认 Max-Age 就会漏）', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc; Path=/']);
    j.store(`${HOST}/logout`, ['sid=; Path=/; Expires=Wed, 09 Jun 2021 10:18:14 GMT']);
    assert.equal(j.headerFor(`${HOST}/me`), undefined, '只认 Max-Age=0 的话，这条"服务端明确作废"的会话会一直带下去');
    assert.equal(j.dump().length, 0);
  });

  test('空值 Set-Cookie 也是删除（最朴素的登出写法，没带任何过期属性）', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc; Path=/']);
    j.store(`${HOST}/logout`, ['sid=; Path=/']);
    assert.equal(j.headerFor(`${HOST}/me`), undefined);
  });

  test('删除那条 cookie **带占位值**时也算删除（`sid=deleted; Max-Age=0` 这一族）', () => {
    /*
     * 上面那三条"删除"用例的值**全是空的**，而真实后端常发的是
     * `JSESSIONID=deleted; Path=/; Max-Age=0`（Tomcat/PHP 都这样，值只是个占位符）。
     * 空值那一族被 `if (!a.value) continue` 兜住，所以**这一族**验的是另一个判据；
     * 两条各挡一道，长得像而钉的不是同一件事，正是本仓"两条测试像而不同事"那一族。
     * （`if (expired) continue` 本身由下面那条「**压根不进存储**」钉 ——
     * 那条不是顺手写的，是先写下 M4/M5 两条变异、跑出 37/37 全绿，
     * 才发现这一半压根没人验，回头补的。）
     */
    const j = jar();
    j.store(`${HOST}/login`, ['sid=real-session; Path=/']);
    j.store(`${HOST}/logout`, ['sid=deleted; Path=/; Max-Age=0']);
    assert.equal(j.headerFor(`${HOST}/me`), undefined,
      '带占位值的删除 cookie 被当成一次**新登录**存了下来（`expired` 那一判失效）');
    assert.equal(j.dump().length, 0);
  });

  test('过期的 cookie **压根不进存储**（不看发不发，只看存没存）', () => {
    /*
     * 上面四条"删除"用例全部先调 `headerFor` 再看 `dump`，而 `headerFor` 读的时候
     * 顺手把过期项清了 —— 于是**存的那一半压根没人验**：把 `store` 里
     * `if (expired) continue` 整句删掉（或把 `expired` 算成恒 false），
     * 上面四条**一条都不红**（实测：`.scratch/measure-cookie-cases.py`，
     * 37 tests / 37 pass / 0 fail，两条变异都"没跑成抓到"）。
     * 原因是两道防御互相冒充：`headerFor` 里那句剪枝挡的是"存下之后时间才走到"，
     * `store` 里这一句挡的是"**服务端此刻明确说这条作废**"，两者成因不同、
     * 而可观测结果在 `headerFor` 这一侧恰好重合。
     *
     * 为什么"存着但不发"仍然是要修的：`dump()` 是这一层唯一的诊断口，
     * 它存在的理由就是区分「**没存下来**」与「**存了而没发**」（域/路径/Secure 不匹配），
     * 这两种的修法完全不同。服务端已经说作废的那条要还躺在存储里，
     * 拿 `dump()` 查"为什么没带上会话"的人就会得到**后一种**结论，
     * 然后去改域或路径 —— 而真相是这条压根不该存在。
     * 所以这一条**故意不调 `headerFor`**：调了就又被那道剪枝兜住，回到没人验的状态。
     */
    const j = jar();
    j.store(`${HOST}/logout`, [
      'sid=deleted; Path=/; Max-Age=0',
      'old=stale; Path=/; Expires=Wed, 09 Jun 2021 10:18:14 GMT',
      'tok=; Path=/; Max-Age=-10',
    ]);
    assert.deepEqual(j.dump().map((c) => c.name), [],
      '带过期属性的 cookie 被存进了 jar（`store` 那一半的判据没人验）');
  });

  test('同 (name, domain, path) 才互相覆盖；path 不同就共存且长的先出现', () => {
    const j = jar();
    j.store(`${HOST}/a/x`, ['sid=broad; Path=/']);
    j.store(`${HOST}/a/y`, ['sid=narrow; Path=/a']);
    const h = must(j.headerFor(`${HOST}/a/y`), '两条都没发');
    // path 更具体的在前：后端通常取第一个匹配值，顺序错会静默用错一条
    assert.equal(h.split('; ')[0], 'sid=narrow', '同名 cookie 的优先级反了（应 path 长的优先）');
    assert.equal(j.dump().length, 2, 'path 不同的同名 cookie 被当成同一条覆盖掉了');
  });

  test('过期就停发，并且顺手从存储里掉出去', () => {
    let now = T0;
    const j = jar(() => now);
    j.store(`${HOST}/login`, ['sid=abc; Path=/; Max-Age=60']);
    assert.equal(j.headerFor(`${HOST}/me`), 'sid=abc');
    now = T0 + 61_000;
    assert.equal(j.headerFor(`${HOST}/me`), undefined, '过期之后还在发');
    assert.equal(j.dump().length, 0, '过期项只是"发的时候跳过"，dump 里看着还在 —— 查问题的人会以为它还在发');
  });

  test('Secure 的 cookie 只在 https 下发', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=abc; Path=/; Secure']);
    assert.equal(j.headerFor('http://api.example.com/me'), undefined,
      '标了 Secure 的会话被发到了 http —— 明文上网，而作者以为标了就安全');
    assert.equal(j.headerFor(`${HOST}/me`), 'sid=abc');
  });

  test('Domain 属性存的 cookie 发给子域，host-only 的不发', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['wide=v1; Path=/; Domain=example.com', 'narrow=v2; Path=/']);
    assert.equal(j.headerFor('https://sub.example.com/x'), 'wide=v1',
      'Domain 型 cookie 没发给子域（跨子域场景一定失败，docs/05 §2 明写这一条）');
    // **不同名之间没有顺序可言**（RFC 不规定，后端也不靠它），所以这里比集合。
    // 顺序只在**同名**时有意义，那条单独钉在上面「path 长的先出现」那一格里 ——
    // 把两种顺序混在一个断言里，改排序就会红一条与本意无关的测试。
    assert.deepEqual(pairs(j.headerFor(`${HOST}/x`)), new Set(['wide=v1', 'narrow=v2']));
  });

  test('路径不匹配时不发', () => {
    const j = jar();
    j.store(`${HOST}/admin/login`, ['sid=abc']); // 默认 path = /admin
    assert.equal(j.headerFor(`${HOST}/public`), undefined, 'cookie 越出了它自己的目录');
    assert.equal(j.headerFor(`${HOST}/admin/panel`), 'sid=abc');
  });

  test('人在请求上显式写的 Cookie 头**赢**，jar 只补同名以外的', () => {
    const j = jar();
    j.store(`${HOST}/login`, ['sid=from-jar; Path=/', 'theme=dark; Path=/']);
    const h = must(j.headerFor(`${HOST}/me`, 'sid=written-by-hand'), '合并结果为空');
    assert.ok(h.includes('sid=written-by-hand'), '显式写的 sid 被 jar 盖掉了 —— 整条场景会用另一个身份跑');
    assert.ok(!h.includes('sid=from-jar'), '同名出现了两次，后端取哪个取决于它的解析器');
    assert.ok(h.includes('theme=dark'), '不同名的那条被一起丢掉了');
    // 刻意**不**断言"显式写的那个排在最前"：不同名之间没有顺序语义（上面那条
    // Domain 用例里说明了为什么），而这里同名只剩一个，位置影响不到任何判据。
    // 断一个没人读的顺序，等于给将来的重构埋一条假红。
    assert.equal(pairs(h).size, 2, `合并后的条数不对：${h}`);
  });

  test('解析不出 URL：不存也不发，而不是编一个默认主机', () => {
    const j = jar();
    j.store('not a url', ['sid=abc; Path=/']);
    assert.equal(j.dump().length, 0, '存进了一条永远匹配不上的记录');
    assert.equal(j.headerFor('not a url', 'a=1'), 'a=1', 'URL 解析失败时把显式写的头也弄丢了');
  });

  test('两个 jar 之间不串（一次 run 一个会话，不靠模块级状态）', () => {
    const a = jar(); const b = jar();
    a.store(`${HOST}/login`, ['sid=abc; Path=/']);
    assert.equal(b.headerFor(`${HOST}/me`), undefined,
      'jar 之间串了 —— 常驻服务里上一条用例的身份会带进下一条用例，而且只要顺序不变就一直绿');
  });
});

describe('setCookiesOf：只走 getSetCookie，不读被合并的那串', () => {
  test('多条时拿到原始数组，而不是一整串逗号', () => {
    const h = new Headers();
    h.append('set-cookie', 'a=1; Path=/; Expires=Wed, 09 Jun 2031 10:18:14 GMT');
    h.append('set-cookie', 'b=2; Path=/');
    assert.deepEqual(setCookiesOf(h), ['a=1; Path=/; Expires=Wed, 09 Jun 2031 10:18:14 GMT', 'b=2; Path=/']);
    // 这条是**前提哨兵**：上面的断言之所以有意义，是因为 getSetCookie 与合并串**不同**。
    // 哪天 fetch 实现改成两者相同，这里会红，而不是让整份测试静默变成同义反复。
    assert.notEqual(h.get('set-cookie'), setCookiesOf(h).join('\n'));
  });

  test('没有 getSetCookie 时返回空数组，**不**退回切合并串', () => {
    const fake = { get: () => 'a=1; Path=/, b=2; Path=/' } as unknown as Headers;
    assert.deepEqual(setCookiesOf(fake), [],
      '退回切合并串 = 把一个必然错的东西当兜底。错着存下来的会话比没有会话危险');
  });
});

/* ================= 端到端：真 server + 真 client + 真引擎 ================= */

interface Seen { path: string; cookie?: string }

/** 起一个会种 cookie 的本地服务。返回收到的请求与地址 */
async function startServer(onRequest?: (req: { path: string; cookie?: string }) => string[]): Promise<{ addr: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = createServer((req, res) => {
    const cookie = req.headers.cookie;
    seen.push({ path: req.url ?? '', cookie });
    const extra = onRequest?.({ path: req.url ?? '', cookie });
    if (extra?.length) res.setHeader('Set-Cookie', extra);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, sawCookie: cookie ?? null }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { addr, seen, close: async () => { await new Promise<void>((r) => srv.close(() => r())); } };
}

const scen = (body: unknown[]): ScenarioDraft => ({
  schemaVersion: '1', id: 'scn.cookie', name: '会话', env: { environmentRef: 'unit' }, body,
} as ScenarioDraft);

describe('端到端：会话真的跨过了一次请求边界', () => {
  test('登录后第二个请求带上 sid —— 这就是改前那个 cookie: undefined', async () => {
    const { addr, seen, close } = await startServer((r) =>
      r.path === '/login' ? ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'] : []);
    try {
      const client = new HttpClient({ cookies: new CookieJar({ now: () => T0 }) });
      const adapters: AdapterRegistry = { http: asHttpExec(client) };
      const r = await runScenario({
        scenario: defineScenario(scen([
          { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
          { id: 'me', kind: 'http', request: { method: 'GET', url: '/me' } },
        ])),
        adapters, clock: deterministicClock(1), env: { baseUrl: addr },
      });
      assert.equal(r.status, 'pass', r.summary);
      assert.equal(seen.length, 2, '请求条数不对，后面的断言全都没意义');
      assert.equal(seen[0]!.cookie, undefined, '登录请求自己带上了 cookie');
      // 比集合不比串：两条不同名 cookie 之间没有顺序语义（见上面 CookieJar 那格的说明）
      assert.deepEqual(pairs(seen[1]!.cookie), new Set(['sid=abc123', 'theme=dark']),
        '第二个请求没带上会话（或带的条数不对）—— 这一条就是本特性的地板');
    } finally { await close(); }
  });

  test('不传 jar 时**照旧不带**（会话是显式开启的，不是默认行为）', async () => {
    const { addr, seen, close } = await startServer((r) => (r.path === '/login' ? ['sid=abc123; Path=/'] : []));
    try {
      const adapters: AdapterRegistry = { http: asHttpExec(new HttpClient()) };
      await runScenario({
        scenario: defineScenario(scen([
          { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
          { id: 'me', kind: 'http', request: { method: 'GET', url: '/me' } },
        ])),
        adapters, clock: deterministicClock(1), env: { baseUrl: addr },
      });
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.cookie, undefined, '没配 jar 却带上了会话 —— 那等于默认共享会话');
    } finally { await close(); }
  });

  test('登出之后第三个请求不再带 sid（跨请求的**删除**也要生效）', async () => {
    const { addr, seen, close } = await startServer((r) => {
      if (r.path === '/login') return ['sid=abc123; Path=/'];
      if (r.path === '/logout') return ['sid=; Path=/; Max-Age=0'];
      return [];
    });
    try {
      const adapters: AdapterRegistry = { http: asHttpExec(new HttpClient({ cookies: new CookieJar({ now: () => T0 }) })) };
      await runScenario({
        scenario: defineScenario(scen([
          { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
          { id: 'out', kind: 'http', request: { method: 'POST', url: '/logout' } },
          { id: 'me', kind: 'http', request: { method: 'GET', url: '/me' } },
        ])),
        adapters, clock: deterministicClock(1), env: { baseUrl: addr },
      });
      assert.equal(seen.length, 3, '请求条数不对');
      assert.equal(seen[1]!.cookie, 'sid=abc123', '登出请求本身应当带着会话（后端要知道登出谁）');
      assert.equal(seen[2]!.cookie, undefined, '登出之后还带着旧会话 —— 后面每条用例都在测一个已作废的身份');
    } finally { await close(); }
  });

  test('IR 里显式写的 Cookie 头压过 jar 里的同名值', async () => {
    const { addr, seen, close } = await startServer((r) => (r.path === '/login' ? ['sid=from-jar; Path=/'] : []));
    try {
      const adapters: AdapterRegistry = { http: asHttpExec(new HttpClient({ cookies: new CookieJar({ now: () => T0 }) })) };
      await runScenario({
        scenario: defineScenario(scen([
          { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
          { id: 'me', kind: 'http', request: { method: 'GET', url: '/me', headers: { cookie: 'sid=written-by-hand' } } },
        ])),
        adapters, clock: deterministicClock(1), env: { baseUrl: addr },
      });
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.cookie, 'sid=written-by-hand',
        '人明写的 sid 被 jar 盖掉了：整条场景会用另一个身份跑完，而报告里看不出来');
    } finally { await close(); }
  });

  test('跟随重定向时，cookie 归**链尾那台主机**，不记到发起那台头上', async () => {
    /*
     * 这一条用的是 `localhost` 与 `127.0.0.1` 两个主机名打**同一个** server ——
     * cookie 的归属只看 host（不看端口、不看协议之外的部分），所以一个进程就能造出
     * "两台主机"，而不必真起两个服务。
     *
     * 要挡的是 `store(r.url, …)` 这种写法：`followRedirects: true` 时 fetch 在内部
     * 跟完了整条链，本层看到的响应其实属于**链尾那个主机**。按发起地址归属，
     * 就等于把 B 给的会话存到 A 名下，之后每个发往 A 的请求都带上它 ——
     * 跨主机泄露会话，而不是"归属稍微不准"。
     */
    const seen: Array<{ path: string; cookie?: string; host?: string }> = [];
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      seen.push({ path: req.url ?? '', cookie: req.headers.cookie, host: req.headers.host });
      if (req.url === '/from') {
        // 重定向到**另一个主机名**（同一个端口，不同 host）
        const port = (srv.address() as { port: number }).port;
        res.writeHead(302, { location: `http://127.0.0.1:${port}/chain-end` });
        res.end();
        return;
      }
      if (req.url === '/chain-end') {
        res.setHeader('Set-Cookie', 'tail=fromChainEnd; Path=/');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const adapters: AdapterRegistry = { http: asHttpExec(new HttpClient({ cookies: new CookieJar({ now: () => T0 }) })) };
      const r = await runScenario({
        scenario: defineScenario(scen([
          { id: 'r', kind: 'http', request: { method: 'GET', url: '/from' }, followRedirects: true },
          { id: 'me', kind: 'http', request: { method: 'GET', url: '/me' } },
        ])),
        adapters, clock: deterministicClock(1), env: { baseUrl: `http://localhost:${port}` },
      });
      assert.equal(r.status, 'pass', r.summary);
      // 前提哨兵：链真的跟到了另一个主机名，否则下面那条"没带上"是因为压根没拿到 cookie
      assert.ok(seen.some((s) => s.path === '/chain-end' && String(s.host).startsWith('127.0.0.1:')),
        `重定向没跨到另一个主机名，这条测试就没在测它声称的东西：${JSON.stringify(seen)}`);
      const mine = seen.filter((s) => s.path === '/me');
      assert.equal(mine.length, 1, '第二个请求条数不对');
      assert.equal(mine[0]!.cookie, undefined,
        '链尾那台主机的 cookie 被记到了发起那台头上 —— 之后每个发往发起主机的请求都带上它');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
  test('两个 HttpClient 各自一个 jar，互不影响（常驻服务里的会话隔离靠这个）', async () => {
    const { addr, seen, close } = await startServer((r) => (r.path === '/login' ? ['sid=abc123; Path=/'] : []));
    try {
      const body = [
        { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
      ];
      const runOne = async (): Promise<void> => {
        const adapters: AdapterRegistry = { http: asHttpExec(new HttpClient({ cookies: new CookieJar({ now: () => T0 }) })) };
        await runScenario({ scenario: defineScenario(scen(body)), adapters, clock: deterministicClock(1), env: { baseUrl: addr } });
      };
      await runOne();
      seen.length = 0;
      await runOne();
      assert.equal(seen.length, 1, '第二次的请求条数不对');
      assert.equal(seen[0]!.cookie, undefined, '第二次 run 带上了第一次 run 的会话');
    } finally { await close(); }
  });
});

/** 取"必须存在"的东西，缺失时报的是**夹具缺了**而不是 TypeError */
function must<T>(v: T | undefined | null, what = ''): T {
  assert.ok(v !== undefined && v !== null, `夹具缺了东西${what ? '：' + what : ''}`);
  return v;
}

/**
 * `Cookie` 头 -> 集合。
 *
 * 为什么要这个而不是 `assert.equal(h, 'a=1; b=2')`：**不同名 cookie 之间没有顺序语义**
 * （RFC 6265 §5.4 只规定同名时 path 长的在前），把顺序写进断言就等于
 * 给一次无害的重构埋一条假红。顺序有意义的那一格（同名优先级）单独用
 * `split('; ')[0]` 断，那里断的是**同一名的两条谁在前**。
 */
function pairs(h: string | undefined): Set<string> {
  return new Set((h ?? '').split('; ').filter(Boolean));
}

/* ================= 边界：哪条出网路径**不该**带会话 ================= */

describe('TokenSource 的那个 client 不带 jar —— 边界要有载体，不能只写在注释里', () => {
  /*
   * 全仓有**两个** `new HttpClient`：装配给用例的那个（带 jar）与 `auth/token.ts` 里
   * `TokenSource` 自己建的那个（**不带**）。后者是刻意的：token 交换是与 API 会话
   * 不同的另一场协议对话，把跑用例攒下来的会话 cookie 发给 IdP 的 token 端点，
   * 等于把 A 主机的凭证投递给 B 主机。
   *
   * ⚠ 这三段的存在理由：**我曾在水合处（`client.ts` / `apply.ts` / docs/14）写成
   * "jar 在唯一出网点 ⇒ 没有一条出网路径能绕过它"**。那句是假的，
   * 而假的程度刚好足够骗到下一个读代码的人 —— 它听起来像一条结构性保证，
   * 而只要 grep 一次 `new HttpClient` 就能看见第二个实例。
   * **一句 over-claim 的代价不是"文档不准"，是别人拿它当前提去做设计**。
   * 所以这一格的作用是把边界从"注释声明"降级成"会红的断言"。
   */
  test('TokenSource 内部的 client 没有 jar（读的是构造，不是"我没看见 cookie"）', () => {
    const ts = new TokenSource({
      tokenUrl: 'https://idp.invalid/token', environmentRef: 'unit',
      resolveSecret: () => 'client-secret-value', now: () => 0,
    });
    // 这里**刻意读私有字段**。为什么不用"发一个请求看服务端收到什么"：
    // token 端点与 API 会话通常**不同主机**，而不同主机时域匹配本来就会把 cookie 挡掉 ——
    // 那种测法红了分不清是"没配 jar"还是"域没匹配上"，绿了也证明不了前者。
    // 读构造是唯一能单独回答"这个实例有没有 jar"的办法。
    const inner = (ts as unknown as { client: HttpClient }).client;
    assert.ok(inner instanceof HttpClient, '夹具失效：TokenSource 里那个字段不叫 client 了，这条要跟着改');
    assert.equal(inner.cookies, undefined,
      'TokenSource 的 client 带上了 jar —— 会话 cookie 会被发给 IdP 的 token 端点');
    // 对照：带 jar 的那个 client 确实有。少了这半句，上面那条在"cookies 字段被删掉"时也会绿
    assert.ok(new HttpClient({ cookies: new CookieJar({ now: () => 0 }) }).cookies !== undefined,
      '对照失败：cookies 字段压根没挂到实例上，那上面那条断言就是同义反复');
  });

  test('同一台主机上：带 jar 的 client 带会话，不带 jar 的**一个字符都不带**', async () => {
    /*
     * 上一条钉的是构造，这一条钉**后果**，而且**故意把两边放在同一台主机**上 ——
     * 同主机就没有"域没匹配上"这个借口，红/绿只可能来自"有没有 jar"这一件事。
     */
    const { addr, seen, close } = await startServer((r) => (r.path === '/login' ? ['sid=abc123; Path=/'] : []));
    try {
      const jarred = new HttpClient({ cookies: new CookieJar({ now: () => T0 }) });
      await jarred.send({ method: 'POST', url: `${addr}/login` });
      assert.equal(jarred.cookies?.dump().length, 1, '夹具失效：jar 没存下会话，那后面"没带"就没有意义');

      const bare = new HttpClient(); // 与 token.ts 里那句构造同形
      await bare.send({ method: 'GET', url: `${addr}/me` });
      const tokenReq = seen.find((s) => s.path === '/me');
      assert.ok(tokenReq, '夹具失效：服务端没收到那个请求');
      assert.equal(tokenReq.cookie, undefined,
        '不带 jar 的 client 也带上了会话 —— 那"token 请求不带会话"就不是构造保证的了');

      // 前提哨兵：同一台主机、同一个 jar，带 jar 的那个 client **确实**会带上
      await jarred.send({ method: 'GET', url: `${addr}/me` });
      assert.equal(seen.filter((s) => s.path === '/me').pop()?.cookie, 'sid=abc123',
        '前提不成立：带 jar 也没带上，那上一条的 undefined 说明不了任何事');
    } finally { await close(); }
  });
});
