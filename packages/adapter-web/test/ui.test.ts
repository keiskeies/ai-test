/**
 * UiExec 端口的**真浏览器**测试（夹具与跳过策略见 browser.ts）。
 *
 * 为什么不用假 adapter：假 adapter 只能证明"我按接口想象写了两遍"。
 * 这里每一条都必须在真 Chrome 上跑，因为要验的是**浏览器的行为**：
 * XPath 引擎怎么解析我生成的查询、elementFromPoint 怎么判遮挡、
 * insertText 送中文丢不丢字、AX 树的层级与 name 是什么。
 *
 * 每条测试的断言都刻意避开"只要非空就算过"那种写法：
 * 定位类一律断**命中的是哪一个**（id 或文本），因为定位错误的表现是
 * "稳稳命中另一个元素然后绿"。
 */
import assert from 'node:assert/strict';

import { createWebAdapter } from '../src/ui.js';
import type { ExecContext } from '@atest/engine';
import type { LocatorSpec, UiAssertPayload } from '@atest/ir';

import { browserBin, browserTest, fixtureUrl } from './browser.js';

/** 最小 ExecContext。stepId 显式给，因为**证据归属**就靠它（见 capture 那条） */
function ctxWith(over: Partial<ExecContext> = {}): { ctx: ExecContext; saved: Array<{ kind: string; stepId: string; bytes: number }> } {
  const saved: Array<{ kind: string; stepId: string; bytes: number }> = [];
  const ctx = {
    target: 'web', runId: 'r1', stepId: 's1', env: {},
    secret: () => { throw new Error('这条测试不该取密钥'); },
    clock: { now: () => 0, mono: () => 0, sleep: async () => {}, random: () => 0.5, mode: 'frozen' as const },
    emit: () => {},
    saveArtifact: async (kind: string, data: Uint8Array | string, stepId: string) => {
      saved.push({ kind, stepId, bytes: typeof data === 'string' ? data.length : data.byteLength });
      return 'a'.repeat(64);
    },
    capabilities: () => undefined,
    ...over,
  } as unknown as ExecContext;
  return { ctx, saved };
}

const spec = (s: Partial<LocatorSpec> & { primary: LocatorSpec['primary'] }): LocatorSpec =>
  ({ intent: '测试夹具', fallbacks: [], confidenceGate: 0.85, maxCostUsdPerResolve: 0.02, replayable: true, ...s }) as LocatorSpec;

/** 每起一次 adapter 就是一次真浏览器：这些测试**串行**跑，各自收尾，
 *  任何一条中途抛错也不能把 Chrome 留在机器上（僵尸进程是这层最难查的残留） */
async function withPage<T>(html: string, fn: (a: Awaited<ReturnType<typeof createWebAdapter>>, ctx: ExecContext) => Promise<T>): Promise<T> {
  const a = await createWebAdapter({ bin: browserBin() });
  const { ctx } = ctxWith();
  try {
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl(html), waitUntil: 'load' }, null, ctx);
    return await fn(a, ctx);
  } finally {
    await a.close();
  }
}

browserTest('navigate 之后 url/text 断言读得到真页面（主链的第一段）', async () => {
  await withPage('<h1 id=t>订单合计 12.00</h1>', async (a, ctx) => {
    // 期望值写的是**夹具地址的形状**而不是某个端口：端口每次随机，
    // 而这里要验的是"url 真的从页面里读出来了"
    const url = await a.ui.assertUi({ assertKind: 'url', expected: '127.0.0.1' } as UiAssertPayload, ctx);
    assert.equal(url.passed, true, `url 断言应命中：${JSON.stringify(url)}`);
    const t = await a.ui.assertUi({ assertKind: 'text', contains: '订单合计 12.00' } as UiAssertPayload, ctx);
    assert.equal(t.passed, true, `中文文本断言应命中：${JSON.stringify(t)}`);
    // **反向**一条：不存在的文案必须判不过。只测正向的话，
    // "pageText 永远返回空串 + includes('') === true"那种实现也能全绿
    const miss = await a.ui.assertUi({ assertKind: 'text', contains: '不存在的文案XYZ' } as UiAssertPayload, ctx);
    assert.equal(miss.passed, false, '不存在的文案必须判不过');
  });
});

browserTest('非 http(s) 的导航被拒（javascript: 是执行语义，不是导航语义）', async () => {
  const a = await createWebAdapter({ bin: browserBin() });
  const { ctx } = ctxWith();
  try {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/hosts']) {
      await assert.rejects(() => a.ui.perform({ op: 'navigate', url, waitUntil: 'load' }, null, ctx),
        /只接受 http\(s\)/, `${url} 应被拒`);
    }
    // **正向对照**：白名单不能把正常地址一起挡掉，否则"安全"与"能用"只能选一个
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl('<p>ok</p>'), waitUntil: 'load' }, null, ctx);
    const t = await a.ui.assertUi({ assertKind: 'text', contains: 'ok' } as UiAssertPayload, ctx);
    assert.equal(t.passed, true, `http(s) 之外的合法夹具导航应正常：${JSON.stringify(t)}`);
  } finally {
    await a.close();
  }
});

browserTest('resolve 走阶梯：便宜的 testid 命中时报 testid，缺 testid 时降级到 text', async () => {
  await withPage('<button id=b1 data-testid="submit-btn">提交订单</button>', async (a, ctx) => {
    const hit = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'submit-btn', scope: 'page', nameMatch: 'exact' } }), ctx);
    assert.equal(hit.resolvedBy, 'testid');
    assert.equal(hit.rung, 1);
    assert.equal(hit.confidence, 1);
    assert.equal(hit.nonReplayable, false, '查询式定位都可回放（只有纯坐标才是 nonReplayable）');

    // 阶梯：primary 故意指向不存在的东西，必须**降级并报告实际用了哪一级**
    const healed = await a.ui.resolve(spec({
      primary: { by: 'testid', value: 'nope-not-here', scope: 'page', nameMatch: 'exact' },
      fallbacks: [{ by: 'text', value: '提交订单', scope: 'page', nameMatch: 'exact' }],
    }), ctx);
    assert.equal(healed.resolvedBy, 'text', `应降级到 text：${JSON.stringify(healed)}`);
    assert.equal(healed.rung, 5);
    assert.ok(healed.confidence < 1);
  });
});

browserTest('多命中**不算命中**（静默取第一个就是"点了隔壁行"）', async () => {
  await withPage('<ul><li>行</li><li>行</li><li>行</li></ul>', async (a, ctx) => {
    await assert.rejects(
      () => a.ui.resolve(spec({ primary: { by: 'text', value: '行', scope: 'page', nameMatch: 'exact' } }), ctx),
      (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /3 命中/, `要说清命中了几个：${m}`);
        assert.match(m, /index/, `要指路怎么写消歧：${m}`);
        return true;
      },
    );
    // 写了 index 就必须命中那一个。命中的是谁，由下一条测试那种"点下去看副作用"
    // 的方式验；这里验的是**越界的 index 不会安静退回第一个**
    const second = await a.ui.resolve(spec({ primary: { by: 'text', value: '行', index: 1, scope: 'page', nameMatch: 'exact' } }), ctx);
    assert.ok(second.handle, 'index 指定的那条应能解析');
    await assert.rejects(
      () => a.ui.resolve(spec({ primary: { by: 'text', value: '行', index: 9, scope: 'page', nameMatch: 'exact' } }), ctx),
      /越界/, 'index 越界必须报错，不能退化成"取第一个"',
    );
  });
});

browserTest('点击真的作用在**解析出来的那一个**元素上（点错也绿的缺陷类的正面防线）', async () => {
  await withPage(
    '<button data-testid="a" onclick="document.title=\'A\'">甲</button>'
    + '<button data-testid="b" onclick="document.title=\'B\'">乙</button>',
    async (a, ctx) => {
      const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'b', scope: 'page', nameMatch: 'exact' } }), ctx);
      await a.ui.perform({ op: 'click' }, h, ctx);
      const title = await a.ui.assertUi({ assertKind: 'title', expected: 'B' } as UiAssertPayload, ctx);
      assert.equal(title.passed, true, `点到的应是 b（title=B），实际 ${JSON.stringify(title)}`);
    },
  );
});

browserTest('被遮罩盖住的元素**立刻报错**，不是干等 30s', async () => {
  const t0 = Date.now();
  await withPage(
    '<button data-testid="x">被盖住的</button>'
    + '<div style="position:fixed;inset:0;background:#fff"></div>',
    async (a, ctx) => {
      const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'x', scope: 'page', nameMatch: 'exact' } }), ctx);
      await assert.rejects(() => a.ui.perform({ op: 'click' }, h, ctx), (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /不可交互/, `报错要说是可交互性问题：${m}`);
        assert.match(m, /遮住/, `要指认是被遮挡：${m}`);
        return true;
      });
      // **这条时间断言是这条测试的一半**：docs/06 §2 要的就是"别干等 30s"。
      // 只断"报错"的话，一个"等满超时再报错"的实现也能过
      assert.ok(Date.now() - t0 < 10_000, `可交互性检查不该等到超时：用了 ${Date.now() - t0}ms`);
    },
  );
});

browserTest('fill 真的把中文写进输入框，并且触发 input 事件', async () => {
  await withPage(
    '<input data-testid="q"><p id=log></p>'
    + '<script>const q=document.querySelector(\'[data-testid=q]\');'
    + 'q.addEventListener(\'input\',()=>{document.querySelector(\'#log\').textContent=\'typed:\'+q.value;});</script>',
    async (a, ctx) => {
      const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'q', scope: 'page', nameMatch: 'exact' } }), ctx);
      await a.ui.perform({ op: 'fill', value: '中文关键词' }, h, ctx);
      // 两条一起断：**值对**不等于事件发了，**事件发了**不等于值对。
      // 只断值会漏掉"JS 直接赋值、被测前端的联想/校验压根没跑"那种实现
      const log = await a.ui.assertUi({ assertKind: 'text', contains: 'typed:中文关键词' } as UiAssertPayload, ctx);
      assert.equal(log.passed, true, `input 事件应带上新值触发（中文不能丢字）：${JSON.stringify(log)}`);
    },
  );
});

browserTest('select 选了不存在的值要报错，而不是"赋值成功"然后绿', async () => {
  await withPage('<select data-testid="s"><option value="a">甲</option></select>', async (a, ctx) => {
    const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 's', scope: 'page', nameMatch: 'exact' } }), ctx);
    await assert.rejects(() => a.ui.perform({ op: 'select', value: 'zzz' }, h, ctx), /回读不一致|不在选项里/);
    await a.ui.perform({ op: 'select', value: 'a' }, h, ctx); // 正常值不该报
  });
});

browserTest('text 定位只命中**文本叶子**：祖先不算命中（否则多命中会全被拒）', async () => {
  /*
   * 这条是被真浏览器**逼出来**的：第一版把"叶子"写成了
   * `[not(normalize-space(text())!='')]`，读作"直接文本为空"，于是
   * `<button>提交订单</button>` 0 命中、`<body>` 反而命中 —— 与想要的相反。
   * 症状是 text 定位法整个失效，然后阶梯安静降级到手写 css（假能用）。
   *
   * 判据用嵌套结构而不是单个元素：单元素测不出"祖先是否也算命中"。
   * `<div><span>提交订单</span></div>` 里 div 的 normalize-space() 也是"提交订单"，
   * 两个都算命中的话就是 2 命中 => 严格模式下**一个都用不了**。
   */
  await withPage('<div id=outer><span id=inner>提交订单</span></div>', async (a, ctx) => {
    const hit = await a.ui.resolve(spec({ primary: { by: 'text', value: '提交订单', scope: 'page', nameMatch: 'exact' } }), ctx);
    assert.equal(hit.resolvedBy, 'text');
    // 命中的必须是 span：点错到 div 上不一定失败，但点击落点就与用例声明无关了
    const clicked = await a.ui.perform({ op: 'click' }, hit, ctx).then(() => 'ok').catch((e: Error) => e.message);
    assert.equal(clicked, 'ok', `叶子元素应可点击：${clicked}`);
    // 反向对照：写 index 让"两个都命中"这种情况**变得可见**
    await assert.rejects(
      () => a.ui.resolve(spec({ primary: { by: 'text', value: '提交订单', index: 1, scope: 'page', nameMatch: 'exact' } }), ctx),
      /越界/, '只应命中 1 个（叶子）；若祖先也算命中，这里会解析成功而不是越界',
    );
  });
});

browserTest('会话里**第一个**查询是 XPath 时，句柄也必须可用（nodeId 0 那个坑）', async () => {
  /*
   * 这条测的是一个"局部对、整体错"的形状：queryCss 会先 getDocument 登记 DOM 节点，
   * queryXPath 原先不会。于是**只用 testid 定位的场景一直是对的**，
   * 而第一个查询是 text/role+name/label 的场景拿到 nodeId 0 ——
   * resolve 照样返回句柄（阶梯只看命中数），坏消息推迟到 click，
   * 报错还是"节点已失效"（把查询层的问题说成"中途导航了"）。
   *
   * 所以这条刻意**不做任何前置查询**，直接 XPath → 拿句柄 → 用句柄做一次真实求值。
   * 只断"命中数 == 1"是抓不到的：0 号 id 也算一次命中。
   */
  await withPage('<p id=v>唯一文本</p>', async (a, ctx) => {
    const hit = await a.ui.resolve(spec({ primary: { by: 'text', value: '唯一文本', scope: 'page', nameMatch: 'exact' } }), ctx);
    assert.equal(hit.resolvedBy, 'text');
    // 句柄要能撑住一次点击。点击的第一步就是可交互性检查（对真节点求值），
    // 拿着 0 号 id 时它报的正是"节点已失效" —— 那就是要拦的症状
    await a.ui.perform({ op: 'click' }, hit, ctx);
    assert.equal(hit.rung, 5, 'text 是阶梯第 5 级（证明这个句柄真来自 XPath 查询）');
  });
});

browserTest('capture 把截图按**这一步的 stepId**存起来；没有 stepId 时拒绝而不是编一个', async () => {
  await withPage('<h1>x</h1>', async (a, _ctx) => {
    const { ctx, saved } = ctxWith({ stepId: 'cap7' });
    await a.ui.perform({ op: 'snapshot' }, null, ctx);
    assert.deepEqual(saved, [{ kind: 'screenshot', stepId: 'cap7', bytes: saved[0]!.bytes }]);
    assert.ok(saved[0]!.bytes > 500, `截图该有真实字节数，不是空串：${saved[0]!.bytes}`);

    const noStep = ctxWith({ stepId: undefined });
    await assert.rejects(() => a.ui.perform({ op: 'snapshot' }, null, noStep.ctx), /stepId/,
      '没有步骤坐标时必须报错（自己编 id 会把证据记到别的步骤名下）');
    assert.deepEqual(noStep.saved, [], '报错前不该已经存了一份');
  });
});

browserTest('snapshot 的 kind 是 aria，且层级与中文 name 来自浏览器算出的 AX 树', async () => {
  await withPage('<nav aria-label="主导航"><a href="#" aria-label="订单列表">订单</a></nav>', async (a, ctx) => {
    const s1 = await a.ui.snapshot(ctx);
    assert.equal(s1.kind, 'aria');
    assert.match(s1.data, /navigation "主导航"/, `AX 树里该有中文 name：${s1.data.slice(0, 200)}`);
    // **缩进**是这条的一半：getFullAXTree 是扁平表，按数组顺序输出会丢层级，
    // 于是"链接在导航里"和"链接在页脚里"在模型眼里长得一样
    // 层级是 RootWebArea > navigation > link，所以 link 在**第 2 层 = 4 空格**
    // （第一版写的是"至少 2 空格"，那会被 navigation 自己那行满足，等于没断层级）
    assert.match(s1.data, /\n {4}- link "订单列表"/, `链接应缩进在 navigation 之下：${s1.data}`);
    assert.match(s1.sha, /^[0-9a-f]{64}$/);
    // uiIdle 靠 sha 比较，所以同一页面两次快照必须**同 sha**（否则页面静止也判不静默）
    const s2 = await a.ui.snapshot(ctx);
    assert.equal(s2.sha, s1.sha, '同一页面两次快照 sha 应一致（uiIdle 判据）');
  });
});

browserTest('导航使旧句柄失效，而不是复用 nodeId 点到另一个元素', async () => {
  const a = await createWebAdapter({ bin: browserBin() });
  const { ctx } = ctxWith();
  try {
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl('<button data-testid="k">旧页</button>'), waitUntil: 'load' }, null, ctx);
    const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'k', scope: 'page', nameMatch: 'exact' } }), ctx);
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl('<button data-testid="k">新页</button>'), waitUntil: 'load' }, null, ctx);
    await assert.rejects(() => a.ui.perform({ op: 'click' }, h, ctx), /失效/,
      '导航后旧句柄必须报错。装作还能用 = 可能点到 Chrome 复用同一个 nodeId 的另一个元素');
  } finally {
    await a.close();
  }
});

browserTest('弹窗被接受并记录（不注册 handler 的话整个 renderer 会挂住）', async () => {
  await withPage('<button data-testid="d" onclick="alert(\'请确认\')">弹</button>', async (a, ctx) => {
    const h = await a.ui.resolve(spec({ primary: { by: 'testid', value: 'd', scope: 'page', nameMatch: 'exact' } }), ctx);
    await a.ui.perform({ op: 'click' }, h, ctx);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(a.dialogs.length, 1, `弹窗应被记录：${JSON.stringify(a.dialogs)}`);
    assert.match(a.dialogs[0]!.message, /请确认/);
    assert.equal(a.dialogs[0]!.accepted, true);
    // 走到这里就说明没挂住：alert 是**同步阻塞**的，不处理就永远返回不了
  });
});

browserTest('ariaYaml / attribute 明确报错，不用更弱的匹配器冒充', async () => {
  await withPage('<h1>x</h1>', async (a, ctx) => {
    // 这两档一旦"能用但判据更弱"，报绿的意义就没了 —— 所以宁可 error
    await assert.rejects(() => a.ui.assertUi({ assertKind: 'ariaYaml', ariaYaml: '- heading "x"' } as UiAssertPayload, ctx),
      /不支持断言 "ariaYaml"/);
    await assert.rejects(() => a.ui.assertUi({ assertKind: 'attribute', target: 'x', expected: 'y' } as UiAssertPayload, ctx),
      /不支持断言 "attribute"/);
  });
});

browserTest('两个实例的 cookie/localStorage 互不可见（docs/06 §1 的头号问题）', async () => {
  /*
   * 这一条测的是"A 登录、B 意外继承 A 的会话 => 假绿"。
   * 断法是**在 A 里写 cookie 与 localStorage，再看 B 看不看得到**。
   *
   * 为什么不用"两个 context id 不同"当判据：存在"id 不同但共享存储"的实现
   * （比如两处都退回默认 profile），那种实现下 id 断言全绿而隔离根本没有。
   * 也不用"两个 dialogs 数组不是同一个对象"那种断言 —— 它恒真，什么都没测。
   *
   * 必须走 http 源：`data:` / `about:blank` 是 opaque origin，
   * 那里的 localStorage 访问直接抛 SecurityError，测不出任何东西。
   */
  const url = await fixtureUrl('<p>隔离夹具</p>');
  const READ = `({ ls: (()=>{ try { return localStorage.getItem('atest_marker') ?? ''; } catch (e) { return 'err:'+e.name; } })(),
                 ck: document.cookie })`;
  const a1 = await createWebAdapter({ bin: browserBin() });
  const a2 = await createWebAdapter({ bin: browserBin() });
  try {
    const { ctx } = ctxWith();
    await a1.ui.perform({ op: 'navigate', url, waitUntil: 'load' }, null, ctx);

    // 直接经 adapter 的 eval 读写（端口本身没有 eval —— IR 的 script 步骤
    // 将来要走它，所以它在 adapter 上是正当接口，不是测试后门）
    // 必须是**单个表达式**（IIFE）：多语句串在 Runtime.evaluate 里会被当表达式解析，
    // 抛 SyntaxError。这里原先写的就是多语句，拿到的是 undefined ——
    // 而 session 当时把异常吞成了裸 undefined，所以看不出是没跑成还是值是 undefined
    const wrote = await a1.eval(`(() => {
      document.cookie = 'atest_marker=FROM_A; path=/';
      try { localStorage.setItem('atest_marker', 'FROM_A'); } catch (e) { return 'ls-blocked:' + e.name; }
      return 'ok';
    })()`);
    /*
     * **正向对照，而且是这条测试的一半**：A 自己必须读得到刚写的标记。
     * 少了这一步，"B 读不到"可能只是因为压根没写进去（storage 被禁、
     * 脚本没跑、cookie 被拒），那这条测试就会永远绿 —— 而它宣称的是隔离。
     */
    assert.equal(String(wrote), 'ok', `夹具脚本应执行成功（localStorage 不该被禁）：${JSON.stringify(wrote)}`);
    const inA = await a1.eval(READ) as { ls: string; ck: string };
    assert.ok(inA.ls.includes('FROM_A') || inA.ck.includes('FROM_A'),
      `A 自己应能读回刚写的标记（否则这条测试没有判据）：${JSON.stringify(inA)}`);

    await a2.ui.perform({ op: 'navigate', url, waitUntil: 'load' }, null, ctx);
    const inB = await a2.eval(READ) as { ls: string; ck: string };
    assert.ok(!inB.ls.includes('FROM_A'), `B 读到了 A 的 localStorage => 会话会串档：${inB.ls}`);
    assert.ok(!inB.ck.includes('FROM_A'), `B 读到了 A 的 cookie => 会话会串档：${inB.ck}`);
  } finally {
    await a2.close();
    await a1.close();
  }
});
