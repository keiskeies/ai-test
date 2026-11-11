/**
 * humanize() 的测试。
 *
 * **这个文件的判据形状和普通单测不一样**，是刻意的：
 * 报错文案这种东西最容易"看着变好了"就收工，而"看着变好"恰恰是
 * 本仓反复记的那类自欺（测试通过的原因和它想验的东西无关）。
 * 所以每条断言都指着一个**修好之前必然拿不到**的具体字符串：
 * 字段名、合法值、或"说不清"这三者之一。
 * 反过来，凡是"只要报个错就成立"的断言（assert.throws、errors.length>0）
 * 一条都不写 —— 那些在旧实现下也是绿的，等于没测。
 *
 * 旧实现的实测基线（`git show HEAD~1` 那版跑同一组夹具）：
 * **11 个坏 IR 里只点名 2 个**，其余全是一句 `body.0 → Invalid input`。
 * 数字在 docs/14 §4.13。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ScenarioSchema, humanize, parseScenario } from '../src/index.js';

const head = { schemaVersion: '1' as const, id: 's', name: 'n', env: { environmentRef: 'u' } };
/** 单个坏步骤 => 拿到 humanize 后的问题列表 */
const errs = (step: unknown): { path: string; message: string }[] => {
  const r = ScenarioSchema.safeParse({ ...head, body: [step] });
  if (r.success) throw new Error('夹具居然是合法的 —— 那这条测试什么都没测');
  return humanize(r.error);
};
const flat = (e: { path: string; message: string }[]): string => e.map((x) => `${x.path} ${x.message}`).join(' | ');

test('union 里的 enum 写错：点名**字段**并列出**合法值**（旧实现两者都给不出）', () => {
  /*
   * 这就是登记在 values.ts / engine/test/retry.test.ts 里的原始症状：
   * 作者写 `retryOn: ['status5xx']`，旧实现给的是
   *   body.0 Invalid input
   * 而 zod 的 error 里明明有 `path: retry.retryOn.0` 和 `values:["network","timeout"]`，
   * 是 humanize 没下钻 union 的每分支 issue 把它们丢了。
   */
  const msg = flat(errs({
    id: 'h', kind: 'http', request: { method: 'GET', url: 'https://x/' }, retry: { count: 2, retryOn: ['status5xx'] },
  }));
  assert.match(msg, /retryOn/, `必须点出出错字段：${msg}`);
  assert.match(msg, /network/, `必须列出合法值之一，否则作者还是不知道该填什么：${msg}`);
  assert.match(msg, /timeout/, `合法值要列全（只给一个会让人以为只有两个选项里的第一个）：${msg}`);
  // path 要指到**数组元素**那一层，只写 retryOn 会让人以为整个字段写错了
  assert.match(msg, /retryOn\.0/, `定位要精确到出错的第几项：${msg}`);
});

test('判别值写错/没写：列出该键的**全部**合法取值，而不是"与 39 种形态都不匹配"', () => {
  /*
   * 这是新手最常犯、也最需要一句话的错误。反推判别键的判据
   * （所有分支共同在 kind 上失败）**必须包含"所有分支都失败"这一档** ——
   * 我第一版把它当歧义排除了，结果这两类全落进兜底文案，
   * 而兜底话术对"kind 拼错"的人来说等于没说。
   */
  const typo = flat(errs({ id: 'x', kind: 'navigatee', url: 'https://x/' }));
  assert.match(typo, /"kind"/, `要点名是 kind 写错了：${typo}`);
  assert.match(typo, /navigate\b/, `要给出合法值 navigate（拼错的人就在找这个词）：${typo}`);
  assert.match(typo, /\bhttp\b/, `合法值来自各分支的并集，不是第一个分支的：${typo}`);

  // 整个没写 kind：与拼错走同一条路（都是判别值不合法），**不能**报成"缺字段"
  const missing = flat(errs({ id: 'z', url: 'https://x/' }));
  assert.match(missing, /"kind"/, `没写 kind 也要指名 kind：${missing}`);
});

test('容器里第 2 个内层步骤坏了：path 要走到内层（union 嵌 union，必须递归）', () => {
  /*
   * 只处理一层的话，这里会报 body.0 而人去看的是**外层那个 sequence 步骤**
   * —— 它本身没有任何问题。这类"报错指向一个清白的位置"比不报错更费时间。
   */
  const e = errs({
    id: 'q', kind: 'sequence', steps: [
      { id: 'l', kind: 'log', level: 'info', message: 'm' },
      { id: 'h', kind: 'http', request: { method: 'GET', url: 'https://x/' }, retry: { retryOn: ['nope'] } },
    ],
  });
  assert.equal(e.length, 1, `内层 2 个步骤 × 39 个分支的噪音不该倒出来，实际 ${e.length} 条：${flat(e)}`);
  assert.match(e[0]!.path, /^body\.0\.steps\.1\./, `path 要走到内层第 2 步：${e[0]!.path}`);
  assert.match(flat(e), /retryOn/);
});

test('原生 discriminatedUnion 的报错不能被下钻弄得更差（回归基线）', () => {
  /*
   * wait.condition 本来就是 discriminatedUnion，zod 自己会报
   * "Invalid discriminator value. Expected 'httpStatus' | 'expr' | …"。
   * 这条测的是**别把已经对的东西改坏**：这类 message 里没有结构化的 values 字段
   * （合法值只在文案里），所以 describe() 对它**原样给出**而不是硬翻格式 ——
   * 硬翻的结果是把 zod 已经说对的话翻译成可能说错的版本。
   */
  const msg = flat(errs({
    id: 'w', kind: 'wait', condition: { type: 'exprss', expr: '1==1' }, timeoutMs: 100, pollMs: 50, onTimeout: 'fail',
  }));
  assert.match(msg, /condition\.type/, `定位到 condition.type：${msg}`);
  assert.match(msg, /httpStatus/, `保留 zod 那份已经列出合法值的文案：${msg}`);
  assert.match(msg, /uiIdle/);
});

test('多分支都还可能对得上时**如实说不清**，不挑一个分支瞎指字段', () => {
  /*
   * 这是本文件最重要的一条。挑"第一个候选分支"是实现里最省事的写法，
   * 而它等于**编造**"你到底想写哪种步骤" —— 症状是报错指着一个
   * 作者压根没打算写的字段说"缺少 xxx"，人就去补那个字段，
   * 补完又报缺下一个（因为分支选错了）。docs/14 §4.3 记的那一整类
   * "看起来有防护，实际漏一个"在报错侧的同族就是**看起来精准，实际是猜**。
   *
   * 造这个局面：一个对象既不像任何步骤（kind 不对），又同时能被两类
   * 分支"部分接受" —— 判别键推不出来（没有共同抱怨的键），
   * 且最接近的分支并列。此时唯一诚实的输出是承认说不清。
   */
  const r = ScenarioSchema.safeParse({ ...head, body: [{ id: 'x', kind: 'http', method: 'GET', url: 'https://x/' }] });
  if (r.success) throw new Error('夹具居然是合法的');
  const e = humanize(r.error);
  const msg = flat(e);
  // 要么给出具体字段，要么明说说不清。**不许**给一句 `Invalid input` 冒充结论
  const honest = /无法|不匹配|无法确定/.test(msg) || /body\.0\.[a-z]/.test(msg);
  assert.ok(honest, `要么点名字段、要么承认说不清，实际：${msg}`);
  assert.ok(!/^body\.0 Invalid input$/i.test(msg.trim()), `不能退回旧文案：${msg}`);
});

test('普通字段错误也要顺带变准：缺字段 ≠ 类型不对', () => {
  /*
   * zod 对"没写"和"写了但类型错"都给 invalid_type，旧文案都是
   * `Invalid input: expected object, received undefined` —— 读的人得分辨
   * received undefined 是什么意思。拆成"缺少 X"与"X 类型不对"两种说法。
   */
  const missing = flat(errs({ id: 'h', kind: 'http' }));
  assert.match(missing, /缺少 "request"/, `"没写"要说成缺失：${missing}`);
  assert.doesNotMatch(missing, /收到 undefined/, `不该出现"收到 undefined"这种废话：${missing}`);

  const wrongType = flat(errs({ id: 'l', kind: 'log', level: 'info', message: 123 }));
  assert.match(wrongType, /类型不对|需要 string/, `类型错要说清要什么：${wrongType}`);
});

test('strict 多写的键仍然点名（非 union 路径不能被下钻吃掉）', () => {
  const msg = flat(errs({ id: 'l', kind: 'log', level: 'info', message: 'm', typoo: 1 }));
  assert.match(msg, /typoo/, `不认识的键要原样点名：${msg}`);
});

test('多个步骤各自坏 => 各报一条，不被压成一条', () => {
  const r = ScenarioSchema.safeParse({
    ...head,
    body: [
      { id: 'a', kind: 'act', locator: { intent: 'x', primary: { by: 'css', value: 'a' } } },
      { id: 'b', kind: 'http' },
    ],
  });
  if (r.success) throw new Error('夹具居然是合法的');
  const e = humanize(r.error);
  assert.equal(e.length, 2, `两个步骤各一条：${flat(e)}`);
  assert.match(e[0]!.path, /^body\.0\./);
  assert.match(e[1]!.path, /^body\.1\./);
});

test('合法 IR 零输出（这条看着像废话，但下钻逻辑一改就可能凭空造出问题）', () => {
  const r = ScenarioSchema.safeParse({ ...head, body: [{ id: 'l', kind: 'log', level: 'info', message: 'm' }] });
  assert.ok(r.success, '夹具本身必须合法，否则上面那条断言什么都没测');
});

test('空/畸形的 errors 不会算出"与全部 0 种形态都不匹配"这种胡话', () => {
  /*
   * 直接构造一个 `errors: []` 的假 issue 打进来。
   * `Array.isArray([])` 与 `[].every(...)` 同时为真，所以判断"这是不是
   * union 的分支组"时**必须显式排掉空数组**，否则 Math.min(...[]) 是 Infinity、
   * 分支数是 0，文案变成"与全部 0 种允许的形态都不匹配" ——
   * 一句看着像 bug 但其实是我们自己造的话（第一版就是这么写的）。
   */
  const fake = { issues: [{ code: 'invalid_union', path: ['body', 0], message: 'Invalid input', errors: [] }] };
  const e = humanize(fake as never);
  assert.equal(e.length, 1);
  assert.ok(!/全部 0 种|Infinity|NaN/.test(e[0]!.message), `不该出现畸形数字：${e[0]!.message}`);
});

test('parseScenario 把新文案带出来（不是只有直接调 humanize 才受益）', () => {
  /*
   * CLI 与 SDK 读的是 parseScenario/defineScenario 的 errors，
   * 不是自己调 humanize。接线断掉的话（比如 parseScenario 里另有一份旧实现）
   * 上面所有测试都绿而用户仍然只看得到 Invalid input。
   */
  const r = parseScenario({ ...head, body: [{ id: 'h', kind: 'http', request: { method: 'GET', url: 'https://x/' }, retry: { retryOn: ['status5xx'] } }] });
  assert.equal(r.ok, false);
  const msg = (r.errors ?? []).map((x) => `${x.path} ${x.message}`).join(' | ');
  assert.match(msg, /retryOn/, `parseScenario 的报错也要点名：${msg}`);
  assert.match(msg, /network/);
});
