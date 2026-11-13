/**
 * 密钥取值那一格的**口径**：什么算"没配到"。
 *
 * ## 为什么单独一个文件，而不是并回 e2e
 * `e2e.test.ts` 里已经有一条钉"缺密钥要在跑之前告警、并说出该设哪个变量"。
 * 那条覆盖的是**变量压根不存在**那一格。这里钉的是另外两格，它们都在
 * `secretResolverFromEnv` 的内部判据上，走命令行反而看不清：
 *  1. **变量存在但是空串**。CI 里 `set -a; . ./.env` 摊开一个空赋值就是这个形状，
 *     而"存在"与"配好了"不是一件事。
 *  2. **ref 本身不构成可用引用**（`$secret.` 这种写漏了名字的）。
 *
 * ## 这一处从前是手写的，而手写的那份与 `secretFromEnv` 只差空串这一格
 * 现在接到了那一份上（`wiring.ts` 里那段注释记着实测到的差别在哪：
 * 不在"发不发鉴权头"，两条路最后都抛 `MissingCredentialError`；
 * 在**报错的来路** —— 旧那份不调 `onMissing`，于是屏幕上没有
 * 「· secret:xxx → 设环境变量 ATEST_SECRET_XXX」这一行，
 * 而通用那句"凭证解析不到值"**连变量名都没提**）。
 * 所以下面每一条都同时问两件事：**返回什么**，以及**有没有被记进缺失清单**。
 * 只看返回值会漏掉真正的修法差别 —— 而这正是这一处改动做的事。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { secretEnvKey } from '@atest/ir';
import { SECRET_PLACEHOLDER } from '@atest/engine';

import { secretResolverFromEnv } from '../src/wiring.js';

/** 占位符的前缀。判"是不是占位符"用的是前缀而不是全等，见 apply.ts 里那句 `startsWith('«')` */
const isPlaceholder = (v: string): boolean => v.startsWith('«');

test('变量存在但是空串 = 没配到：交回占位符，**并且记进缺失清单**', () => {
  const missing: string[] = [];
  const r = secretResolverFromEnv({ ATEST_SECRET_DB_PW: '' }, (x) => { missing.push(x); });
  const v = r('secret:db_pw');
  assert.ok(isPlaceholder(v), `空串被当成取到了，返回的是 ${JSON.stringify(v)}`);
  // 这一条才是这次改动的实质：少了它，屏幕上就没有"该设哪个变量"那一行
  assert.deepEqual(missing, ['secret:db_pw'], '空串没记进缺失清单（报错只剩"解析不到值"，不说去哪设）');
});

test('压根没有这个变量：同样交回占位符并记账（与空串同一条口径）', () => {
  const missing: string[] = [];
  const r = secretResolverFromEnv({}, (x) => { missing.push(x); });
  assert.ok(isPlaceholder(r('secret:db_pw')));
  assert.deepEqual(missing, ['secret:db_pw']);
});

test('真值原样返回，且**不**记进缺失清单', () => {
  const missing: string[] = [];
  const r = secretResolverFromEnv({ ATEST_SECRET_DB_PW: 'pw-with- spaces ' }, (x) => { missing.push(x); });
  // 值**不裁剪**：密码里的空格是内容，裁掉会得到一个"配了而后端说不认"的凭证
  assert.equal(r('secret:db_pw'), 'pw-with- spaces ');
  assert.deepEqual(missing, []);
});

test('写漏了 ref 名字（`$secret.`）时**不去查空变量名**，也不报一个不存在的变量', () => {
  const missing: string[] = [];
  // 这一格里藏着那个老缺陷：归一失败时**不能**拿空 key 去查 env，
  // 也**不能**让人去设一个设了也不生效的变量名
  const r = secretResolverFromEnv({ ATEST_SECRET_: 'poison' }, (x) => { missing.push(x); });
  const v = r('$secret.');
  assert.ok(isPlaceholder(v), `不构成可用引用的 ref 竟然取到了值：${JSON.stringify(v)}`);
  // 记账仍然要做（它确实是"没配到"），但报出去的是**原样那个 ref**，
  // 而不是拼出来的 `ATEST_SECRET_`（那个名字设了也不会被读到）
  assert.deepEqual(missing, ['$secret.']);
  assert.equal(secretEnvKey('$secret.'), '', '归一失败时拼出了非空的变量名 —— 报错会指向一个设了也不生效的变量');
});

test('三种 IR 写法归一到同一个变量名（报错指的名字与取值的名字同源）', () => {
  const key = secretEnvKey('secret:db_pw');
  assert.equal(key, 'ATEST_SECRET_DB_PW');
  const env = { [key]: 'v' };
  for (const written of ['secret:db_pw', '$secret.db_pw', '$.secret.db_pw', 'secret.db_pw']) {
    const missing: string[] = [];
    const r = secretResolverFromEnv(env, (x) => { missing.push(x); });
    assert.equal(r(written), 'v', `${written} 取不到值 —— 报错会让人去设另一个名字的变量`);
    assert.deepEqual(missing, [], `${written} 明明取到了却记进缺失清单`);
  }
});

test('占位符用的是引擎那一个常量，不是 CLI 自造的（脱敏规则认前缀）', () => {
  const r = secretResolverFromEnv({});
  const v = r('secret:db_pw');
  /*
   * 钉的是**全等**而不是"带前缀「«」"。原因很具体：磁盘脱敏规则里有一条是
   * "看起来像占位符的值不再重复脱敏"，而 apply.ts 判的也是 `startsWith('«')`。
   * CLI 自己造一个 `«unresolved»` 也能过"带前缀"这条性质，但那样 trace.jsonl 里
   * 就多出第三种密钥形态，而脱敏那侧只认引擎那一个 —— 于是新形态的值**不再被脱敏**，
   * 它进的是每个有 CI 读权限的人的磁盘。所以要比常量本身。
   */
  assert.equal(v, SECRET_PLACEHOLDER, `自造的占位符 ${JSON.stringify(v)} 会让 trace.jsonl 里出现第三种密钥形态`);
});
