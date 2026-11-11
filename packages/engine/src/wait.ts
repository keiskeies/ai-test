/**
 * 等待执行（docs/02 §3）。**等待是条件，不是时长** —— 这是调研认定的第二空白点：
 * 现有平台的「等待」全都是固定延时，每个 delay:3000 都是一颗未来的 flake。
 */
import type { WaitPredicate, WaitCondition } from '@atest/ir';
import { describePredicate } from '@atest/ir';
import { queryOne } from './jsonpath.js';
import { locatorGate, chargeResolve, LocatorBudgetError } from './resolve.js';
import type { AdapterRegistry, Clock, ExecContext, ResolveResult } from './adapters.js';

export interface WaitDeps {
  predicate: WaitPredicate;
  timeoutMs?: number;
  pollMs?: number;
  backoff?: 'none' | 'linear' | 'exponential';
  clock: Clock;
  evalExpr: (e: string) => boolean;
  resolveRef: (ref: string) => unknown;
  adapters: AdapterRegistry;
  ctx: ExecContext;
  /**
   * 成本入账口（解释器的 addCost）。**必填**：给了默认值（` () => {}`），
   * "忘了接"就编译得过，于是一次 10s/500ms 的 uiPredicate 等待把
   * `maxCostUsdPerResolve` 那次 resolve 的钱重复花 20 次而**总账上一个数都不变** ——
   * 场景级 `maxCostUsd` 熔断读的就是这本账，账不动熔断就永不触发，
   * 而报告照样写"成本 $0.0000"。缺失时宁可编译不过。
   */
  addCost: (n: number) => void;
}

export interface WaitResult {
  satisfied: boolean;
  waitedMs: number;
  polls: number;
  describe: string;
}

export async function waitUntil(d: WaitDeps): Promise<WaitResult> {
  const timeout = d.timeoutMs ?? 10_000;
  const basePoll = d.pollMs ?? 500;
  const t0 = d.clock.mono();
  const describe = describePredicate(d.predicate);
  let polls = 0;
  let interval = basePoll;

  for (;;) {
    polls++;
    let ok = false;
    try {
      ok = await evalPredicate(d.predicate, d);
    } catch (e) {
      /*
       * **定位超预算必须掀翻整个等待循环**，不能被下面那句"当成还没满足"吞掉。
       *
       * 这是本文件里唯一一处"异常类型选错就放大损失"的地方：超支在语义上长得像
       * "条件没成立"（都是"这一步还没成"），所以用一个普通 Error 会让它
       * 被当成普通求值错误 -> 继续轮询 -> **每轮再花一次同样的钱**。
       * 一个 10s / pollMs=500 的 uiPredicate 等待 = 20 次付费定位。
       * 一个本来只超预算 $0.001 的等待，变成超 $0.02。
       *
       * 抛出后由 runStep 的 catch 收成 fail + case-stale（不是 error，
       * 因为 error 走退出码 5、而 CI_HINT 教 CI 重试一次 = 再花一遍）。
       */
      if (e instanceof LocatorBudgetError) throw e;
      // 条件求值本身报错（变量未定义/adapter 缺失）不能当成「还没满足」干等到超时 ——
      // 那会把一个配置错误伪装成一次超时，是最难查的一类 flake
      return { satisfied: false, waitedMs: d.clock.mono() - t0, polls, describe: `${describe}（求值报错：${(e as Error).message}）` };
    }
    if (ok) return { satisfied: true, waitedMs: d.clock.mono() - t0, polls, describe };

    const elapsed = d.clock.mono() - t0;
    if (elapsed >= timeout) return { satisfied: false, waitedMs: elapsed, polls, describe };
    // 不睡过超时点：否则 10s 超时会睡到 10.5s，慢套件就是这么变慢的
    const sleepMs = Math.min(interval, timeout - elapsed);
    await d.clock.sleep(sleepMs);
    interval = d.backoff === 'exponential' ? Math.min(interval * 1.6, 5_000) : d.backoff === 'linear' ? Math.min(interval + basePoll, 5_000) : basePoll;
  }
}

async function evalPredicate(p: WaitPredicate, d: WaitDeps): Promise<boolean> {
  const o = p as Record<string, unknown>;
  if ('allOf' in o) for (const c of o.allOf as WaitPredicate[]) if (!(await evalPredicate(c, d))) return false;
  if ('allOf' in o) return true;
  if ('anyOf' in o) { for (const c of o.anyOf as WaitPredicate[]) if (await evalPredicate(c, d)) return true; return false; }
  if ('noneOf' in o) { for (const c of o.noneOf as WaitPredicate[]) if (await evalPredicate(c, d)) return false; return true; }
  return evalCondition(p as WaitCondition, d);
}

async function evalCondition(c: WaitCondition, d: WaitDeps): Promise<boolean> {
  switch (c.type) {
    case 'expr':
      return d.evalExpr(c.expr);
    case 'httpStatus': {
      const v = d.resolveRef(c.ref) as { status?: number } | number | undefined;
      const status = typeof v === 'object' && v !== null ? v.status : v;
      return typeof status === 'number' && c.in.includes(status);
    }
    case 'dbRow': {
      if (!d.adapters.db) throw new Error('dbRow 条件需要 db adapter');
      const rows = await d.adapters.db.query(c.datasource, c.sql, {}, d.ctx);
      if (c.expect === 'noRow') return rows.length === 0;
      if (c.expect === 'scalarTruth') {
        const first = rows[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : undefined;
        return Boolean(first);
      }
      return rows.length > 0;
    }
    case 'uiPredicate': {
      const a = d.adapters.ui ?? d.adapters.device;
      if (!a || !('resolve' in a)) throw new Error('uiPredicate 条件需要 ui/device adapter');
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, d.ctx);
      /*
       * **每轮都记一次账、每轮都审一次预算**。
       *
       * 这两句是本轮真正要接的那条线：等待循环是 `maxCostUsdPerResolve`
       * 唯一能被**重复触发**的地方 —— 一个走视觉档的 uiPredicate，
       * 每次 poll 都是一次完整定位。以前这里既不记账也不审，
       * 于是"单次定位上限"这个闸门在最容易烧钱的路径上恰好不存在。
       * （判据本身在 resolve.ts 的 chargeResolve，与解释器同一个函数 ——
       *  两条路径各自实现一份判断，就是本仓反复出现的"两边数不一样"。）
       */
      chargeResolve(r.costUsd ?? 0, c.target, d.addCost, { resolvedBy: r.resolvedBy, rung: r.rung });
      /*
       * **「在不在」有两个方向，阈值不能共用一个数**（这里原先两边都用写死的 0.5）。
       *
       * 0.5 恰好是 `confidenceGate` 的 schema **下限**，也就是最宽松的那个值 ——
       * 而 `c.target` 就是整份 `LocatorSpec`（steps.ts 里 uiPredicate 的 target 字段），
       * 人写的门限一路传到这里，然后被丢掉。
       *
       * 分方向不是因为麻烦，是因为**两个方向上"宽松"的含义相反**：
       *  - 问"在不在"（visible/attached/enabled）：按人声明的门限判，与解释器同一判据。
       *    收紧只会让等待更久或超时，方向安全。
       *  - 问"走了没"（gone）：如果也按门限判"在"，0.6 的弱匹配会被判成"已经不在了"
       *    => **等待提前成功**。toast/Loading 消失这类用例最要的正是这种假绿，
       *    所以这里反过来取最保守的一档：**adapter 报了任何匹配就算还在**。
       *    代价是最坏情况多等到超时（红，看得见），比悄悄绿了便宜。
       */
      const matched = Boolean(r.handle);
      return c.state === 'gone' ? !matched : matched && r.confidence >= locatorGate(c.target);
    }
    case 'template': {
      const a = d.adapters.device ?? d.adapters.ui;
      if (!a || !('resolve' in a)) throw new Error('template 条件需要 device/ui adapter');
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, d.ctx);
      /*
       * 模板匹配同样按次计费（图像比对/视觉模型都在这一档），
       * 所以同样记账 + 审预算，理由同 uiPredicate 那一处。
       */
      chargeResolve(r.costUsd ?? 0, c.target, d.addCost, { resolvedBy: r.resolvedBy, rung: r.rung });
      return c.expect === 'hit' ? r.confidence >= c.minConfidence : r.confidence < c.minConfidence;
    }
    case 'uiIdle': {
      // 「空闲」判定要连续两次快照一致 —— 单次相同可能只是恰好落在两帧之间
      const a = d.adapters.ui ?? d.adapters.device;
      if (!a || !('snapshot' in a)) throw new Error('uiIdle 条件需要 ui/device adapter');
      const first = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(d.ctx);
      await d.clock.sleep(c.quietMs);
      const second = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(d.ctx);
      return first.sha === second.sha;
    }
    case 'response':
      // 响应监听由 ui adapter 内部维护（引擎不碰网络）
      return d.evalExpr(`__responses != null && count(filter(__responses, "url =~ '${c.urlPattern}'")) > 0`);
    default:
      throw new Error(`未知等待条件类型 ${(c as { type: string }).type}`);
  }
}

/** 让 IR 作者能在断言里复用同一套求值 */
export { evalCondition };
export const _unusedQueryOne = queryOne;
