/**
 * 「运行一条场景」在前端这一侧的契约 —— **刻意不含 DOM**。
 *
 * ## 为什么单独一个文件
 *
 * 这一格里有三条判据，而它们与"画成什么按钮"无关：
 *  1. **jobId 的形状**。服务端按 `JOB_ID` 收紧（`server/src/index.ts`），
 *     前端造的 id 要**服务端认**才算数 —— 不认的话症状是"提交被拒"或
 *     "跑起来了但取消那头永远 400"（见 `mutate/cancel-http.json` 的 C9）。
 *  2. **取消的语义是「请求」不是「已完成」**。正在跑的那条会在**下一步开头**停下，
 *     已经发出去的请求不追回（追回等于"半个 POST"）。所以这里回的是
 *     "送达了 + 当时是什么状态"，措辞由这个事实限定，不许写「已取消」。
 *  3. **提交被拒（409）不能吞掉**。吞掉的表现是"我点了运行，什么都没发生"。
 *
 * 判据写在代码里，就得能不进浏览器被测到：这里一个 DOM 类型都不出现，
 * `fetch` 走注入（默认用全局那个）。`run-job.test.ts` 因此在 node 里跑，
 * 不必起 Chrome —— 而起 Chrome 那条（`browser-run-button.test.ts`）只补一件事：
 * **按钮真的接上了这个模块**。两者各测一半，缺一个就留一半。
 */

/** 服务端 `JOB_ID` 的镜像。**不 import 服务端**（`tooling/lint-layers.mjs` 拦住方向），
 *  一致性由 `run-job.test.ts` 里那句"与源码里那张正则逐字相同"钉住 —— 那是读源码，
 *  不是抄一份自证（抄的那份会漂，本仓记过一整族这种漂）。 */
export const JOB_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let seq = 0;

/**
 * 造一个 jobId。**由前端造**不是省事，是被这条 API 的形状逼的：
 * `POST /api/run` 阻塞到 run 结束才回，服务端自己造的 id 在 run 结束前送不出来，
 * 而取消恰恰是"还没结束时"才需要的动作（理由同段注释在 `server/src/index.ts`）。
 *
 * 三段拼起来：时间戳（跨进程有序，便于人眼看"哪个先提交"）+ 本标签页内自增
 * （同一毫秒内两次点击不撞）+ 一段随机（跨标签页不撞）。
 * **这里用随机是对的**：它不是密钥、不进磁盘、不参与判定，只要"两个人不会撞上"。
 * （刻意不用 `crypto.randomUUID()`：那个只在**安全上下文**里暴露，
 *   而这一格的失败模式很坏 —— 生成 id 抛异常会让**运行按钮**整个点不动，
 *   不只是取消不可用。宁可要一个丑但总会成功的 id。）
 */
export function newJobId(now: number = Date.now()): string {
  seq += 1;
  const rand = Math.floor(Math.random() * 1_679_616).toString(36);   // 36^4，够打散同一毫秒的多个标签页
  const id = `w${now.toString(36)}-${seq.toString(36)}-${rand}`;
  // 自检：形状错了宁可在**造的时候**炸，也不要跑到服务端换回一个 400 ——
  // 那时"我的 id 不合法"会显示成一句服务端报错，人只会以为是网络问题
  if (!JOB_ID_SHAPE.test(id)) throw new Error(`内部错误：造出的 jobId 不合法（${id}）`);
  return id;
}

/** 一次提交的结果。**每个分支都带一句能直接给人看的话** —— 措辞是这一格的产物，不是装饰 */
export interface SubmitResult {
  ok: boolean;
  jobId: string;
  /** 给人看的那一句。失败时是"为什么没跑"，成功时是结论 */
  message: string;
  exitCode?: number;
  output?: string;
}

interface FetchLike { (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text(): Promise<string> }> }

const jsonOf = async (res: { text(): Promise<string> }): Promise<Record<string, unknown>> => {
  const t = await res.text();
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { raw: t }; }
};

/**
 * 提交并等它跑完（这条 API 是同步的：阻塞到 run 结束才回）。
 *
 * ## 为什么这里**没有** `onAccepted` 这类回调（我先前写了，然后删了）
 *
 * `POST /api/run` 是**阻塞**的：响应到达之时就是 run 结束之时。所以客户端
 * **没有任何时刻**能知道"服务端已经收下这条 job 了" —— 能知道的只有两件事：
 * 请求发出去了（也许到了），以及 run 结束了。
 * 我先前那个 `onAccepted` 是在 `await fetch` **之后**回调的，那等于
 * "run 结束了才告诉你该挂取消按钮"，是个装饰。而在 await **之前**回调，
 * 名字就变成谎话：那一刻请求可能还在路上。
 *
 * 于是取消按钮只能**在点"运行"的那一刻就挂出来**（UI 侧做，见 app.ts），
 * 代价是一条真实的窄竞态：点完运行**立刻**点取消，服务端可能还没把 job 登记进表
 * （`/api/run` 是先读完请求体才 `jobs.add`），于是拿到 404。
 * 所以下面那个 404 的措辞里带着"请求可能还在路上"这一档 —— 少了它，
 * 那次竞态会被说成"你根本没提交过"，而真相是"你提交了，只是我快了一步"。
 */
export async function submitRun(o: {
  scenario: string; jobId: string;
  env?: string; inputs?: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<SubmitResult> {
  const f: FetchLike = o.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: { status: number; text(): Promise<string> };
  try {
    res = await f('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenario: o.scenario, jobId: o.jobId,
        ...(o.env ? { env: o.env } : {}),
        ...(o.inputs ? { inputs: o.inputs } : {}),
      }),
    });
  } catch (e) {
    // fetch 抛 = 服务端没起/断了。这一句要区别于"跑失败了"：后者有退出码，前者什么都没有
    return { ok: false, jobId: o.jobId, message: `连不上服务端：${(e as Error).message}` };
  }
  const body = await jsonOf(res);
  if (res.status === 409) {
    // 不重试、不换 id 悄悄再提交：那等于**替用户又跑了一遍**（docs/02 §5 的不可逆动作纪律）
    return { ok: false, jobId: o.jobId, message: `这个 job 没能提交：${String(body.error ?? 'jobId 正被另一个 run 占用')}` };
  }
  const code = typeof body.exitCode === 'number' ? body.exitCode : undefined;
  if (code === undefined) return { ok: false, jobId: o.jobId, message: `提交失败（HTTP ${res.status}）：${String(body.error ?? body.raw ?? '')}` };
  return {
    ok: code === 0, jobId: o.jobId, exitCode: code,
    output: typeof body.output === 'string' ? body.output : undefined,
    message: `退出码 ${code}`,
  };
}

/** 取消的结果。**四档话说清**，因为它们的下一步动作完全不同 */
export interface CancelResult {
  ok: boolean;
  /** 这一刀有没有作用对象（排队中算有 —— 它因此压根不开工） */
  actedOn: boolean;
  message: string;
}

/**
 * 请求取消。**这个函数与这句提示都不说「已取消」**：正在跑的那条是在下一步开头停下，
 * 已发出的请求不追回；排队的那条是一个请求都不发；已结束的那条没东西可取消。
 * 把三档压成一句「已取消」，人就以为点了就等于停了 —— 而那正是这整条链不成立的时刻。
 */
export async function requestCancel(o: { jobId: string; fetchImpl?: FetchLike }): Promise<CancelResult> {
  const f: FetchLike = o.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: { status: number; text(): Promise<string> };
  try {
    // jobId 走 **query** 而不是路径段：服务端那一格不接受调用方给的路径片段（同一处判据）
    res = await f(`/api/cancel?jobId=${encodeURIComponent(o.jobId)}`, { method: 'POST' });
  } catch (e) {
    return { ok: false, actedOn: false, message: `取消请求没送出去：${(e as Error).message}` };
  }
  const body = await jsonOf(res);
  if (res.status === 404) {
    /*
     * 这一句**不说"或它已经结束了"**：没登记过与已结束是两件事，混在一起会让人以为
     * 自己那次提交成功了（真相常常是没提交成功或 id 拼错）。服务端同一条口径。
     *
     * 但前端这一侧要**多带一档**，而且这一档在界面上是真会出现的：
     * 点完"运行"立刻点"取消"时，`/api/run` 可能还没读完请求体（它是先读体才登记 job），
     * 于是这一格回 404。此时说"你从未提交过"是**假话** —— 人确实提交了，只是我快了一步。
     */
    return { ok: false, actedOn: false, message: `服务端还不认这个 job：要么提交还在路上（稍等再点一次），要么它从未提交成功 / 结束后被后续 job 挤出了表（${o.jobId}）` };
  }
  if (res.status !== 200) return { ok: false, actedOn: false, message: `取消失败（HTTP ${res.status}）：${String(body.error ?? body.raw ?? '')}` };
  const actedOn = body.actedOn === true;
  const state = String(body.state ?? '?');
  const again = body.alreadyCancelled === true ? '（之前已经点过一次取消）' : '';
  if (!actedOn) return { ok: true, actedOn: false, message: `它已经跑完了，没有东西因为这一下停下${again}` };
  // 排队中 vs 正在跑：**下一步动作不同**（前者压根不会开始，后者会把手上的那一步做完）
  const tail = state === 'queued'
    ? '它还没开工，一个请求都不会发'
    : '它会在**下一步开头**停下；已经发出去的请求不追回，已完成的步骤照常出证据';
  return { ok: true, actedOn: true, message: `取消已送达${again}：${tail}` };
}
