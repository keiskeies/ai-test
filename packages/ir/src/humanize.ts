/**
 * zod 报错的人话化（docs/08 §3 登记的那一步）。
 *
 * **要解决的问题**：作者写错一个字段，看到的是 `body.0 → Invalid input`
 * —— 没有字段名、没有合法值。步骤 schema 是 `z.union`（39 个成员，
 * 见 steps.ts:423），zod 对 union 失败只给**一条** `invalid_union`，
 * 真信息全在 `issue.errors`（每个分支一组 issue）里，而旧实现直接丢了它。
 * 后果实测过：`retryOn: ['status5xx']` 的报错里
 * **既没有 retryOn 也没有 network/timeout**（engine/test/retry.test.ts:293 记着
 * 这条测试当年怎么把我的注释证伪的）。
 *
 * **为什么在 humanize 里反推判别键，而不是把 StepSchema 换成 discriminatedUnion**：
 * 那是正解但做不到 —— steps.ts:419 说"用 union 是为了避开 zod v4 对递归成员的
 * 类型不变性限制"，本轮**重验了这句，它是真的**：
 *  `z.discriminatedUnion('kind', [..., z.lazy(...)])` **运行时能跑**（能报出
 *  "Invalid discriminator value. Expected 'leaf' | 'seq'"），但**编译期**报
 *  `_zod.propValues` 是 `PropValues | undefined`（`z.lazy` 把判别值信息擦了），
 *  并且 `z.infer` 出来的联合**失去窄化**（`if (s.kind==='leaf') return s.v` 编不过）。
 * 也就是说换 schema 要用一堆 `as` 换一条错误文案，不值。
 *
 * **反推的判据**（`pickBranch`）：所有分支**共同**在某个 depth-1 键上因
 * 字面量/枚举不匹配而失败 => 那个键就是事实上的判别键（这正是
 * discriminatedUnion 的语义，只是这里从 issue 里事后恢复）。
 * 要求"至少一半分支抱怨它"是为了不让"几个分支恰好都缺同一个字段"
 * 被误当成判别键 —— 那种情况候选会不唯一，宁可退化也不猜。
 *
 * **两条"宁可不说也不瞎说"的底线**（都在测试里钉着）：
 *  - 候选分支恰好 1 个才下钻。多个候选时**不挑第一个** ——
 *    挑第一个就等于在编造"你到底想写哪种步骤"，
 *    而那正是本仓反复记的"看起来有防护，实际漏一个"的报错版。
 *  - 没有判别键共识时，退到"issue 最少的那一支"（写得越接近合法就报得越少），
 *    但**只在最小值唯一时**下钻；并列最小 = 两支一样接近 = 猜。
 *    兜底文案如实说"说不清"，**不把各分支的噪音倒给人**
 *    （173 条近似重复的 issue 不叫"信息丰富"，叫没人会读完）。
 */
import type { ZodError, ZodIssue } from 'zod';

/*
 * zod v4 把 `issue.path` 定成 `PropertyKey[]`（含 symbol），所以本文件内部
 * 一律先 `String()` 再拼。显示上无损：数组下标 0 与 '0' 拼出来都是 `body.0`，
 * 而带着 symbol 去 join('.') 会在运行时炸。
 */
const seg = (p: readonly PropertyKey[]): string[] => p.map((x) => String(x));

export interface HumanizedIssue {
  path: string;
  message: string;
}

/** zod v4 在 union 失败时给的 issue：`code=invalid_union`，`errors` 是**每分支一组** */
type BranchGroups = ZodIssue[][];

function branchesOf(i: ZodIssue): BranchGroups | undefined {
  const e = (i as { errors?: unknown }).errors;
  // `[]` 也算 Array.isArray 且 every 真空成立，所以**显式排掉空数组**：
  // 否则下游 Math.min(...[]) 与"与全部 0 种形态都不匹配"这种胡话会冒出来
  if (!Array.isArray(e) || e.length === 0 || !e.every((b) => Array.isArray(b))) return undefined;
  return e as BranchGroups;
}

/** 判别性质的失败：字面量/枚举值不对。discriminatedUnion 与 union 反推都用它 */
const TAG_CODES = new Set(['invalid_value', 'invalid_literal']);

const isTagFail = (i: ZodIssue, key: string): boolean =>
  TAG_CODES.has(i.code) && i.path.length === 1 && String(i.path[0]) === key;

/**
 * 从各分支的 issue 里认出判别键，并给出"没在判别键上失败"的候选分支。
 * `key`  undefined = 认不出来（分支间没有共同的判别性质抱怨）。
 * `candidates` 只在 key 认出来时有值。
 */
function pickBranch(branches: BranchGroups): { key?: string; candidates?: ZodIssue[][] } {
  const counts = new Map<string, number>();
  for (const b of branches) {
    const keys = new Set<string>();
    for (const i of b) {
      if (TAG_CODES.has(i.code) && i.path.length === 1 && typeof i.path[0] === 'string') keys.add(i.path[0]);
    }
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const half = branches.length / 2;
  // **含"所有分支都抱怨"**（= branches.length）：含义是输入连判别值本身都不合法
  // （写错或没写），这正是 discriminatedUnion 会报 Invalid discriminator value。
  // 第一版我把这种排除掉了，结果 kind 拼错/没写这两类**全落进兜底** ——
  // 而那恰恰是新手最常犯、最需要一句话的错误。
  const cands = [...counts].filter(([, c]) => c >= half).map(([k]) => k);
  if (cands.length !== 1) return {};
  const key = cands[0]!;
  return { key, candidates: branches.filter((b) => !b.some((i) => isTagFail(i, key))) };
}

/** 判别键上所有分支声明的合法值并集（用于"kind 只能是 …"那句） */
function tagValues(branches: BranchGroups, key: string): string[] {
  const vals = new Set<string>();
  for (const b of branches) {
    for (const i of b) if (isTagFail(i, key)) (i as { values?: unknown[] }).values?.forEach((v) => vals.add(String(v)));
  }
  return [...vals];
}

/**
 * 把一条 zod issue 写成人话。**只在这条是叶子（不是 union）时调用**。
 *
 * 为什么不全信 zod 的 message：`Invalid input` 是它的默认文案，
 * 而 `expected`/`received`/`values`/`keys` 这些**结构化字段里才有真信息**。
 */
function describe(i: ZodIssue): string {
  /*
   * 出错位置的名字。**数组元素要特殊处理**：数组里第 n 项不合法的 path 是
   * `retry.retryOn.0`，直接取最后一段会得到 `at = "0"`，
   * 于是文案变成「"0" 不是合法值」—— 人读不出这是哪个字段出了问题。
   * 取倒数第二段（真正的字段名）+ 序号（**给人看是 1 基**）。
   */
  const last = i.path.length ? String(i.path[i.path.length - 1] ?? '') : '';
  const isIndex = /^\d+$/.test(last);
  const at = isIndex
    ? (i.path.length > 1 ? String(i.path[i.path.length - 2] ?? '') : '')
    : last;
  /*
   * 一个变量装完整的位置短语，模板里只用 `${subject} 不是…` 这一种拼法。
   * （先前拆成 where + ordinal 两段再各自加空格，结果一边多出空格一边漏掉空格 ——
   *  文案的间距也该只有一个来源。）
   */
  const subject = isIndex && at ? `"${at}" 的第 ${Number(last) + 1} 项` : at ? `"${at}"` : '该处';
  if (i.code === 'invalid_type') {
    const expected = (i as { expected?: string }).expected;
    const received = (i as { received?: string }).received;
    if (expected) {
      // **缺字段**与**类型错**得分开：zod 两者都给 invalid_type，
      // 而 received==='undefined' 表示"压根没写"。
      // 说"收到 undefined"是废话，说"缺失"才 actionable。
      return received === 'undefined' || received === undefined
        ? `缺少 ${subject}：需要 ${expected}`
        : `${subject} 类型不对：需要 ${expected}，收到 ${received}`;
    }
  }
  if (TAG_CODES.has(i.code)) {
    const vals = (i as { values?: unknown[] }).values;
    // discriminatedUnion 的判别错误**没有** values 字段，但 message 里
    // 已经写着 "Expected 'a' | 'b' | …" —— 那种原样给出，别硬翻成可能错的格式
    if (Array.isArray(vals) && vals.length) return `${subject} 不是合法值。可取：${vals.map((v) => JSON.stringify(v)).join(' | ')}`;
    return i.message;
  }
  if (i.code === 'unrecognized_keys') {
    const keys = (i as { keys?: string[] }).keys;
    if (keys?.length) return `多出不认识的键：${keys.map((k) => `"${k}"`).join('、')}`;
  }
  if (i.code === 'too_small' || i.code === 'too_big') {
    const g = i as unknown as { minimum?: number; maximum?: number; inclusive?: boolean; unit?: string };
    const n = i.code === 'too_small' ? g.minimum : g.maximum;
    if (n !== undefined) return `${i.code === 'too_small' ? '太小' : '太大'}：需要${i.code === 'too_small' ? ' ≥ ' : ' ≤ '}${n}${g.unit ? `（${g.unit}）` : ''}`;
  }
  return i.message;
}

/**
 * 主入口。**只多算、不少说**：非 union 的 issue 走原来那条路（只是文案更准），
 * union 的 issue 才尝试下钻。
 */
export function humanize(err: ZodError): HumanizedIssue[] {
  const out: HumanizedIssue[] = [];
  const join = (p: string[]) => (p.length ? p.join('.') : '(root)');

  const walk = (issues: ZodIssue[], prefix: string[]): void => {
    for (const i of issues) {
      const here = [...prefix, ...seg(i.path)];
      const branches = branchesOf(i);
      if (!branches) {
        out.push({ path: join(here), message: describe(i) });
        continue;
      }
      const { key, candidates } = pickBranch(branches);
      if (key && candidates) {
        if (candidates.length === 1 && candidates[0]!.length) {
          // 唯一候选：它就是作者想写的那一种，下钻
          walk(candidates[0]!, here);
          continue;
        }
        if (candidates.length === 0) {
          // 每个分支都在判别键上失败 = 判别值本身写错/没写
          const vals = tagValues(branches, key);
          out.push({
            path: join([...here, key]),
            message: `"${key}" 不是合法值。可取：${vals.length ? vals.join(' | ') : '（各分支未声明可选值）'}`,
          });
          continue;
        }
        // 多个候选：说不清是哪一种，**如实说不清**
        out.push({
          path: join(here),
          message: `与 ${candidates.length} 种允许的形态都可能对得上，无法确定是哪一种（各自要求的字段不同）`,
        });
        continue;
      }
      /*
       * 没有判别键共识 => "issue 最少的那一支"作为**最近形状**的启发。
       * 只在最小值唯一时用：并列最小意味着两支一样接近，那时下钻等于猜。
       */
      const min = Math.min(...branches.map((b) => b.length));
      const closest = branches.filter((b) => b.length === min && b.length > 0);
      if (closest.length === 1) {
        walk(closest[0]!, here);
        continue;
      }
      out.push({
        path: join(here),
        message: `与全部 ${branches.length} 种允许的形态都不匹配，无法指出具体字段`,
      });
    }
  };

  walk(err.issues as ZodIssue[], []);
  return out;
}
