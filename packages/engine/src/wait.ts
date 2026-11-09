/**
 * 等待执行（docs/02 §3）。**等待是条件，不是时长** —— 这是调研认定的第二空白点：
 * 现有平台的「等待」全都是固定延时，每个 delay:3000 都是一颗未来的 flake。
 */
import type { WaitPredicate, WaitCondition } from '@atest/ir';
import { describePredicate } from '@atest/ir';
import { queryOne } from './jsonpath.js';
import type { AdapterRegistry, Clock, ExecContext } from './adapters.js';

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
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<{ confidence: number; handle: string }> }).resolve(c.target, d.ctx);
      const present = Boolean(r.handle) && r.confidence > 0.5;
      return c.state === 'gone' ? !present : present;
    }
    case 'template': {
      const a = d.adapters.device ?? d.adapters.ui;
      if (!a || !('resolve' in a)) throw new Error('template 条件需要 device/ui adapter');
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<{ confidence: number }> }).resolve(c.target, d.ctx);
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
