/**
 * 静态根与证据成员的解析 —— **白名单本身要有测试**，否则它只是看起来严。
 *
 * 这一格的风险不是"功能不对"，是"多发了一个文件"。而多发的表现是**什么都没发生**：
 * 页面正常、用例正常，只有攻击面宽了一格。所以这里每一条负面用例
 * （"这个 URL 必须解析不出文件"）都比正面用例重要。
 *
 * 顺带说明为什么这些是纯函数测试而不是起真服务端：
 * 判据全在字符串层面，起端口的价值到 `files.test.ts` 之外那一层才出现
 * （见 `server.test.ts`）。把"哪一格能读"这件事测在纯函数上，
 * 报错才会指向判据而不是指向 HTTP。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveEvidence, resolveStatic, type StaticRoot } from '../src/files.js';

// 与 defaultStaticRoots 给 /app/ 那一格的实际集合同形（含 .html）：
// 夹具比生产窄的话，「长前缀赢」测的就是一个生产里不存在的形状
const CODE = new Set(['.js', '.mjs', '.json', '.html']);
const HTML_ONLY = new Set(['.html']);

/** 仓库布局的简化版：三棵代码根 + 一个只发 html 的前端根（挂在 `/` 上） */
const ROOTS: StaticRoot[] = [
  { urlPrefix: '/', dir: '/repo/packages/web/static', extensions: HTML_ONLY, why: '前端入口' },
  { urlPrefix: '/app/', dir: '/repo/packages/web/dist', extensions: CODE, why: '前端模块' },
  { urlPrefix: '/pkg/ir/', dir: '/repo/packages/ir/dist', extensions: new Set(['.js']), why: 'IR 本体' },
];

const got = (p: string): string | undefined => resolveStatic(p, ROOTS)?.absolute;

describe('静态根白名单', () => {
  test('正常路径命中，且落在自己那一棵根里', () => {
    assert.equal(got('/app/app.js'), join('/repo/packages/web/dist/app.js'));
    assert.equal(got('/pkg/ir/index.js'), join('/repo/packages/ir/dist/index.js'));
    assert.equal(got('/'), join('/repo/packages/web/static/index.html'));
  });

  test('长前缀赢：/app/ 在 "/" 也匹配时不许被短前缀接走', () => {
    // 两棵根都发 .html，所以这一格**只能**靠前缀长度判。排序错了的话，
    // /app/index.html 会被 "/" 那棵根接走，从另一棵树里读出同名的另一份文件 ——
    // 表现是"页面加载了一份旧的前端"，而不是任何一条错误
    assert.equal(got('/app/index.html'), join('/repo/packages/web/dist/index.html'));
  });

  test('短前缀只在长前缀那格**判不出**时才兜底（ Fallthrough 的方向）', () => {
    // ir 那格只发 .js，所以 /pkg/ir/x.html 在它那一格判不出；
    // 这时候**不许**掉到 "/" 那格去读 web/static/x.html —— 那是跨根借文件，
    // 等于"每棵根的扩展名白名单"整体失效
    assert.equal(got('/pkg/ir/x.html'), undefined);
    // 而 "/" 自己能命中的（它本来就发 html）要正常命中，别把兜底一刀切成死
    assert.equal(got('/index.html'), join('/repo/packages/web/static/index.html'));
  });

  test('目录请求只在"这一格本来就发 html"时才落 index', () => {
    // 只发 .js 的根不许凭空多出一个"目录能开"的假入口
    assert.equal(got('/pkg/ir/'), undefined, '只发 .js 的根凭空多了个 index 入口');
    // 发 html 的根，目录请求落 index 是它真实需要的能力
    assert.equal(got('/app/'), join('/repo/packages/web/dist/index.html'));
    // 不带尾斜杠的 `/app` **不匹配** `/app/` 这个前缀，于是落到 "/" 那格，
    // 而 `app` 没有扩展名 → 不发。这里**不给它做自动重定向**：
    // 真实入口是 "/"（index.html 由它发），`/app` 不是一个会被输入的地址；
    // 凭空加 301 反而多一条要测的分支。断成 undefined 是为了把这个决定钉住，
    // 而不是让它"看起来能用"。
    assert.equal(got('/app'), undefined);
  });

  test('越界写法一律解析不出，且**没有一种能逃出所在根**', () => {
    const escapes = [
      '/app/../atest.json',
      '/app/%2e%2e/atest.json',
      '/app/..%2F..%2Fpackage.json',
      '/app/..\\..\\atest.json',
      '/app/....//atest.json',
      '/app/x/../../atest.json',
      '/app/.%2e/atest.json',
      '/app/%252e%252e/atest.json',
    ];
    for (const p of escapes) {
      const abs = got(p);
      // 允许两种结局：解析不出（undefined），或折进根内。
      // **不允许**的是落到根外 —— 这才是判据，而不是"某个具体写法过不了"。
      if (abs !== undefined) {
        assert.ok(abs.startsWith('/repo/packages/web/dist'), `${p} 逃到了根外：${abs}`);
      }
    }
  });

  test('隐藏文件一律不发（.git、.env、.npmrc 都在根附近）', () => {
    for (const p of ['/app/.env', '/app/.git/config', '/app/%2eenv', '/.git/config']) {
      assert.equal(got(p), undefined, `${p} 不该被服务`);
    }
  });

  test('扩展名不在根白名单里就不发，哪怕文件真的存在', () => {
    // ir 那一格只发 .js：它目录里的 .json（package.json、tsconfig 产物）不发
    assert.equal(got('/pkg/ir/package.json'), undefined);
    // 前端根只发 html：它能"存在"一个 .json 也不发
    assert.equal(got('/config.json'), undefined);
  });

  test('decodeURIComponent 抛异常的形状不炸，只当不命中', () => {
    assert.equal(got('/app/%E0%A4%A'), undefined);
  });

  test('空扩展名（无后缀路径）不发', () => {
    assert.equal(got('/app/app'), undefined);
  });
});

describe('证据包成员白名单', () => {
  const EV = '/repo/evidence';
  const A64 = 'a'.repeat(64);

  test('五个成员与 artifacts/<64hex> 能取', () => {
    for (const m of ['trace.jsonl', 'junit.xml', 'manifest.json', 'summary.txt', 'report.html']) {
      assert.equal(resolveEvidence(EV, 'run-1', m), join(EV, 'run-1', m));
    }
    assert.equal(resolveEvidence(EV, 'run-1', `artifacts/${A64}`), join(EV, 'run-1', 'artifacts', A64));
  });

  test('白名单外的成员一律不给，包括**看起来无害**的那些', () => {
    for (const m of ['', 'index.html', 'artifacts', `artifacts/${A64}.json`, `artifacts/../manifest.json`,
      'artifacts/../..', 'sub/report.html', 'report.html.json', 'REPORT.HTML']) {
      assert.equal(resolveEvidence(EV, 'run-1', m), undefined, `${m} 不该被读到`);
    }
  });

  test('反斜杠与多余斜杠不改变判定（Windows 手打的写法也要判得住）', () => {
    // 正例：反斜杠形态的 artifacts 路径要等价于正斜杠那条
    assert.equal(resolveEvidence(EV, 'run-1', 'artifacts\\' + A64), join(EV, 'run-1', 'artifacts', A64));
    // 正例：开头的多余斜杠只是空段，落点与不带斜杠时**是同一个文件**。
    // 这一条要显式钉住，否则下一个读到 `if (clean.includes('..'))` 的人会以为
    // "带斜杠的都得拒"，然后顺手把带斜杠的正常请求也拒了
    assert.equal(resolveEvidence(EV, 'run-1', '/manifest.json'), join(EV, 'run-1', 'manifest.json'));
    // 反例：`sub/../report.html` **不给**，即使它折起来正好是白名单里那个名字。
    // 判据是"成员名精确等于白名单某项"，而含 .. 的那一支在判据里就先被拒 ——
    // 这个顺序是刻意的：**能算出目标**不等于**该给**。放宽这一条的话，
    // 白名单就从"成员名的集合"退化成"折叠后看起来像集合成员"，那是黑名单形状。
    for (const m of ['sub/../report.html', '..\\manifest.json', '..\\..\\atest.json', 'a/./report.html', 'artifacts/../..']) {
      assert.equal(resolveEvidence(EV, 'run-1', m), undefined, `${m} 不该被读到`);
    }
  });

  test('runId：整段点与分隔符一律不给，但"以点开头"不是罪名', () => {
    // 整段点（`..` 那一族）会跳目录，所以按**整个名字**判；写侧 safeRunId 同判据。
    // `...` 也拒：它不是 POSIX 保留段，但和 `..` 一样是"合法字符组成的可疑名字"，
    // 而证据目录里没有任何真实 run 会叫这个名，放过它没有收益。
    // '/etc' 与 'a\b' 这种带分隔符的过不了字符集，本来就该拒。
    for (const id of ['.', '..', '...', 'a/b', 'a\\b', '', '$(who)', '/etc', 'a b']) {
      assert.equal(resolveEvidence(EV, id, 'manifest.json'), undefined, `runId=${JSON.stringify(id)} 不该被接受`);
    }
    // **反面**：`.hidden` 这种要放过。它 join 出来还在证据目录里面，不构成越界；
    // 而判它非法会让那次 run 的产物在界面上变成"不存在" —— 存在却说读不出，
    // 是本仓最反感的那类错法（同 listRuns 对坏 manifest 的处置口径）。
    assert.equal(resolveEvidence(EV, '.hidden', 'manifest.json'), join(EV, '.hidden', 'manifest.json'));
    // 真实目录名的样子：safeRunId 的输出形态（字母数字点横线下划线）
    assert.equal(resolveEvidence(EV, 'run_lz8k3f.1', 'report.html'), join(EV, 'run_lz8k3f.1', 'report.html'));
    // 写侧修法产出的那个名字也要能读回来 —— 两侧判据不一致的话，
    // 修完写侧会让这些 run 在界面上凭空消失
    assert.equal(resolveEvidence(EV, '_..', 'manifest.json'), join(EV, '_..', 'manifest.json'));
  });
});
