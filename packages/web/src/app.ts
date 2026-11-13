/**
 * 前端主体 —— 一个够小的 hash 路由 + 四个页面。
 *
 * ## 一条贯穿全文件的规矩：**不用 innerHTML**
 *
 * 页面上显示的每一段文字都来自三个不信任源：**用户的 IR**（里面能写任意字符串）、
 * **被测系统的响应**（证据里那些）、**引擎的报错文本**。
 * 用字符串拼 HTML 再塞进 innerHTML 的话，"这段文字里有个 `<script>`"就变成执行，
 * 而防它不能靠"记得转义" —— 那是黑名单，靠每次想全。
 *
 * 所以这里的**唯一**建 DOM 通道是 `h()`/`txt()`：文本一律走 `textContent`，
 * 结构走 `createElement`。**没有 innerHTML 这条通道**（除了 CSS 那一处，
 * 那份 CSS 是我们自己写的常量，不是数据）。这样"某个字符串里有尖括号"
 * 这个失败模式在这份代码里**没有入口**，而不是"目前没被用到"。
 *
 * ## 四页对应 docs/12 §3 的 B1 / B2（局部）/ C1 / C2（局部）
 *
 * docs/12 那句"P0 的 UI 应当故意简陋"是这里克制的全部依据：
 * 场景编辑器只做"JSON + 引擎实时校验"，运行详情直接**链到 evidence 包里那份
 * report.html**（零脚本、自包含、已在 CI 里跑过的那一份），不在前端重画一遍 trace。
 * 重画会造出第二份"一次 run 长什么样"，而那份没有测试。
 */
import { CSS } from './styles.js';
import { checkIr, GRAPH_NOT_AVAILABLE, type CheckResult } from './check.js';
import { checkStatusLines, EMPTY_STATIC_GATE, missingInputHint, SECRET_ROUTE_HINT, staticGateCardTitle } from './check-lines.js';
import { runRow } from './run-lines.js';
import { describeStatus, STATUS_ICON } from './status.js';
import { newJobId, requestCancel, submitRun } from './run-job.js';
import type { LintIssue } from '@atest/engine';
import type { StepStatus } from '@atest/ir';

type Route = { page: 'scenarios' } | { page: 'scenario'; id: string } | { page: 'runs' };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = h.split('/');
  if (head === 'scenario' && rest[0]) return { page: 'scenario', id: decodeURIComponent(rest.join('/')) };
  if (head === 'runs') return { page: 'runs' };
  return { page: 'scenarios' };
}

/* ═══ 建 DOM 的唯一通道 ═══ */
function txt(s: unknown): Text { return document.createTextNode(String(s)); }

interface Attrs {
  class?: string;
  text?: unknown;
  href?: string;
  /** 状态徽章用：值必须来自 IR 的 StepStatus，不能是页面自己编的词 */
  status?: StepStatus;
  level?: 'error' | 'warning';
  kind?: 'error' | 'info';
  pressed?: boolean;
  current?: boolean;
  colspan?: number;
  id?: string;
  on?: Partial<Record<'click' | 'input' | 'change', (e: Event) => void>>;
  /** 允许给单个节点：`children: h(...)` 比 `children: [h(...)]` 少一层括号，
      而少一层括号就少一次我数不清花括号的失败模式（本文件第一版就是这么炸的） */
  children?: Node | readonly (Node | null | undefined | false)[] | null;
}

function h(tag: string, a: Attrs = {}): HTMLElement {
  const el = document.createElement(tag);
  if (a.class !== undefined) el.className = a.class;
  if (a.text !== undefined) el.textContent = String(a.text);
  if (a.href !== undefined) el.setAttribute('href', a.href);
  if (a.status !== undefined) el.setAttribute('data-s', a.status);
  if (a.level !== undefined) el.setAttribute('data-l', a.level);
  if (a.kind !== undefined) el.setAttribute('data-k', a.kind);
  if (a.pressed !== undefined) el.setAttribute('aria-pressed', String(a.pressed));
  if (a.colspan !== undefined) el.setAttribute('colspan', String(a.colspan));
  if (a.id !== undefined) el.id = a.id;
  if (a.current === true) el.setAttribute('aria-current', 'page');
  for (const [ev, fn] of Object.entries(a.on ?? {})) el.addEventListener(ev, fn);
  if (a.children instanceof Node) el.appendChild(a.children);
  else for (const c of a.children ?? []) if (c) el.appendChild(c);
  return el;
}

/** 状态徽章：色（data-s → CSS）+ 图标 + 文字，三重编码一次凑齐 */
function badge(status: StepStatus, extra?: string): HTMLElement {
  const v = describeStatus(status);
  return h('span', { status, class: 'badge', children: [h('span', { class: 'bi', text: STATUS_ICON[status] }), txt(extra ?? v.label)] });
}

function card(title: string, body: Node, head?: Node): HTMLElement {
  return h('section', { class: 'card', children: [
    h('div', { class: 'hd', children: [h('h2', { text: title }), h('span', { class: 'spacer' }), ...(head ? [head] : [])] }),
    h('div', { class: 'bd', children: [body] }),
  ] });
}

const main = document.getElementById('root')!;

/* ═══ 顶栏与骨架 ═══ */
function shell(content: Node): void {
  main.replaceChildren(h('div', { class: 'shell', children: [topbar(), h('div', { class: 'body', children: [nav(), h('main', { class: 'main stack', children: [content] })] })] }));
}

function topbar(): HTMLElement {
  return h('header', { class: 'topbar', children: [
    h('span', { class: 'brand', text: 'atest' }),
    h('span', { class: 'dim', id: 'project-line', text: '项目信息加载中…' }),
    h('span', { class: 'grow' }),
    // 密度切换常驻顶栏，且写进 localStorage 而不是发给服务端（docs/13 §7 U7：
    // 「演示者自己切宽松，不影响别人日常视图」—— 那是个人设置，不是项目设置）
    h('div', { class: 'seg', children: (['compact', 'standard', 'relaxed'] as const).map((d) =>
      h('button', { text: DENSITY_LABEL[d], pressed: density() === d, on: { click: () => { setDensity(d); render(); } } })) }),
    h('button', { class: 'btn', text: theme() === 'dark' ? '亮色' : '暗色', on: { click: () => { setTheme(theme() === 'dark' ? 'light' : 'dark'); render(); } } }),
  ] });
}

const DENSITY_LABEL = { compact: '紧凑', standard: '标准', relaxed: '宽松' } as const;

function nav(): HTMLElement {
  const r = parseHash();
  const link = (href: string, ic: string, label: string, active: boolean): HTMLElement =>
    h('a', { href, current: active, children: [h('span', { class: 'ic', text: ic }), txt(label)] });
  return h('nav', { class: 'nav', children: [
    link('#/scenarios', '▤', '场景库', r.page === 'scenarios' || r.page === 'scenario'),
    link('#/runs', '◷', '运行记录', r.page === 'runs'),
  ] });
}

/* ═══ 偏好：localStorage。取不到就用默认，不弹窗不打断 ═══ */
type Density = keyof typeof DENSITY_LABEL;
function density(): Density {
  const v = localStorage.getItem('atest.density');
  return v === 'standard' || v === 'relaxed' ? v : 'compact';
}
function setDensity(d: Density): void { localStorage.setItem('atest.density', d); applyPrefs(); }
function theme(): 'light' | 'dark' { return localStorage.getItem('atest.theme') === 'dark' ? 'dark' : 'light'; }
function setTheme(t: 'light' | 'dark'): void { localStorage.setItem('atest.theme', t); applyPrefs(); }
function applyPrefs(): void {
  const el = document.documentElement;
  el.setAttribute('data-density', density());
  el.setAttribute('data-theme', theme());
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  try { return { __status: res.status, ...(JSON.parse(text) as object) } as T & { __status: number }; }
  catch { return { __status: res.status, error: text } as unknown as T & { __status: number }; }
}

/** 通过率那类指标旁边**必须有绝对数字**（docs/13 §2：百分比单独出现会被误读） */
function tallyLine(m: Record<string, unknown>): Node {
  const t = (m.tally ?? {}) as Record<string, number>;
  return h('span', { class: 'mono dim', text: Object.entries(t).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}:${v}`).join('  ') || '无 tally' });
}

/* ═══ B1 场景库 ═══ */
async function pageScenarios(): Promise<void> {
  shell(h('div', { class: 'stack', children: [h('p', { class: 'muted', text: '加载中…' })] }));
  const [proj, list] = await Promise.all([
    api<{ irDir?: string; evidenceDir?: string; hasConfig?: boolean; error?: string }>('/api/project'),
    api<{ items?: Array<Record<string, unknown>>; error?: string }>('/api/scenarios'),
  ]);
  const pl = document.getElementById('project-line');
  if (pl) pl.textContent = proj.hasConfig ? `场景目录 ${proj.irDir ?? '?'} · 证据 ${proj.evidenceDir ?? '?'}` : '没找到 atest.json（用默认目录）';

  const items = list.items ?? [];
  const table = h('table', { children: [
    h('thead', { children: h('tr', { children: ['文件', '场景 id', '名称', '端', '步骤', '冻结'].map((x) => h('th', { text: x })) }) }),
    h('tbody', { children: items.length === 0
      ? [h('tr', { children: h('td', { class: 'empty', children: [txt('场景目录里没有 .json 文件。先跑 '), h('code', { text: 'atest init' }), txt(' 与 '), h('code', { text: 'atest gen --doc <名>=<openapi.json> --write' })] }) })]
      : items.map((it) => {
        if (it.broken) return h('tr', { children: [h('td', { class: 'mono', text: String(it.file) }), h('td', { colspan: 5, class: 'err-text', text: `解析失败：${String(it.error)}` })] });
        const targets = (it.targets ?? []) as string[];
        return h('tr', { children: [
          h('td', { class: 'mono dim', text: String(it.file) }),
          // id 是**用户写的字符串**：走 textContent，永远不拼进 HTML
          h('td', { children: h('a', { href: `#/scenario/${encodeURIComponent(String(it.id))}`, children: txt(it.id) }) }),
          h('td', { text: String(it.name ?? '') }),
          h('td', { class: 'mono dim', text: targets.join(' / ') || '—' }),
          h('td', { class: 'num', text: String(it.steps ?? '') }),
          h('td', { children: it.frozen ? badge('pass', '已冻结') : badge('triaged', '未冻结') }),
        ] });
      }) }),
  ] });
  shell(card(`场景库（${items.length}）`, table));
}

/* ═══ B2 场景编辑 + 引擎实时校验 ═══ */
async function pageScenario(id: string): Promise<void> {
  shell(h('div', { class: 'stack', children: [h('p', { class: 'muted', text: '加载中…' })] }));
  const res = await fetch(`/api/scenario?id=${encodeURIComponent(id)}`);
  const text = await res.text();
  if (!res.ok) {
    shell(h('div', { class: 'banner', kind: 'error', text: text }));
    return;
  }
  const area = h('textarea', { class: 'mono', on: {}, children: [] }) as HTMLTextAreaElement;
  area.value = text;
  area.rows = 24;
  area.spellcheck = false;
  const out = h('div', { class: 'stack' });
  const statusLine = h('div', { id: 'status-line', class: 'row' });
  /*
   * 跑动中的状态走**另一行**，不蹭 statusLine。这不是审美：runCheck 是用
   * `statusLine.replaceChildren(...)` 画校验结论的，而它会被"改完文本顺手点一下校验"
   * 这个动作触发 —— 那样做时一条 run 正在跑，于是那次 replaceChildren 会把**取消按钮
   * 连同它那条 job 一起从屏幕上删掉**。载体被另一个功能的正常重绘抹掉，比没有载体更坏：
   * 人看见的是"我点了校验，取消就不见了"。
   */
  const runLine = h('div', { id: 'run-line', class: 'row' });

  const runCheck = async (): Promise<void> => {
    statusLine.replaceChildren(h('span', { class: 'muted', text: '引擎校验中…' }));
    let r: CheckResult;
    try { r = await checkIr(area.value); }
    catch (e) {
      // 引擎抛了 = 我们的 bug。红着说出来，不许兜成"你的 IR 有问题"
      statusLine.replaceChildren();
      out.replaceChildren(h('div', { class: 'banner', kind: 'error', text: `引擎抛了异常（这是本工具的 bug，不是你的用例）：${(e as Error).stack ?? String(e)}` }));
      return;
    }
    statusLine.replaceChildren(...renderStatus(r));
    out.replaceChildren(...renderIssues(r));
  };

  /*
   * 运行 + 取消。判据全在 `run-job.ts`（纯 TS、node 里就能测），这一格只画与接线。
   *
   * **取消按钮在点"运行"的那一刻就挂出来**，而不是等某个"已受理"的信号 ——
   * `POST /api/run` 是阻塞的，客户端拿不到"服务端已登记这条 job"这个时刻
   * （整段理由写在 run-job.ts 的 submitRun 上，那里还钉着一条测试防止有人再加个假回调）。
   * 代价是一条窄竞态：点完运行立刻点取消可能拿到 404，那句 404 的措辞负责说清
   * "要么提交还在路上"。
   *
   * 每次点击各自一个 jobId、各自一个取消按钮 —— 顶部那个"运行"按钮不禁用（沿用第一版的
   * 取舍：允许连着提交两条），所以按钮必须**只对得住自己那一条 job**，否则会以为
   * 取消了新提交的那条、实际停掉的是旧的。
   */
  const runIt = async (): Promise<void> => {
    const jobId = newJobId();
    /*
     * 两个节点都带 id，且 id 里带着 jobId。理由不是"测试方便"：这一格同时可能有
     * 多条 run 在跑（顶部那个"运行"按钮不禁用，沿用第一版的取舍），而节点**没有身份**
     * 的话，"哪个按钮属于哪条 job"就只能靠文字去猜 —— 那句"取消中…"变过一次之后
     * 就再也认不出来了。id 由我们自己的 newJobId 生成，字符集收紧在 JOB_ID_SHAPE 里，
     * 不含引号，而 `h()` 走的是 `el.id = …`（setAttribute 那条路本来也拼不进 HTML）。
     */
    const label = (s: string): string => `job ${jobId} · ${s}`;
    const note = h('span', { id: `job-${jobId}`, class: 'muted mono', text: label('已提交') });
    const cancelBtn = h('button', {
      id: `cancel-${jobId}`, class: 'btn', text: '取消', pressed: false,
      on: {
        click: (e: Event) => {
          const el = e.currentTarget as HTMLButtonElement;
          el.disabled = true;
          el.textContent = '取消中…';
          void requestCancel({ jobId }).then((c) => {
            // 措辞**只用 requestCancel 给的那一句**，不在这里覆盖成"已取消"：
            // 排队中/跑动中/已结束三档里没有任何一档配得上那三个字
            note.textContent = label(c.message);
            el.textContent = c.ok ? '已请求取消' : '取消没生效';
            if (!c.ok) el.disabled = false;           // 没生效就让人能再点一下，别逼人去刷新
          });
        },
      },
    }) as HTMLButtonElement;
    runLine.append(cancelBtn, note);
    const r = await submitRun({ scenario: id, jobId });
    cancelBtn.remove();                               // 结束了，这一格再没有可取消的东西
    note.textContent = label(r.exitCode === undefined ? r.message : `退出码 ${r.exitCode}`);
    note.className = r.ok || r.exitCode !== undefined ? 'muted mono' : 'err-text mono';
    if (r.output) out.prepend(card('CLI 输出', h('pre', { class: 'code', text: r.output })));
  };

  shell(h('div', { class: 'stack', children: [
    card(id, h('div', { class: 'stack', children: [
      statusLine,
      runLine,
      area,
      h('div', { class: 'row', children: [
        h('button', { id: 'check-btn', class: 'btn', text: '校验（本地引擎）', on: { click: () => void runCheck() } }),
        h('button', { id: 'run-btn', class: 'btn primary', text: '运行', on: { click: () => void runIt() } }),
        h('span', { class: 'dim', text: '校验在浏览器里跑 @atest/engine 本体；运行走服务端 → CLI（信号、门禁、证据、租约归还那条已接线的路）。取消只是**请求**：正在跑的那条在下一步开头停下，已发出的请求不追回' }),
      ] }),
    ] }), h('a', { href: '#/scenarios', text: '← 场景库' })),
    out,
  ] }));
  void runCheck();
}

/**
 * 校验状态行。**这一格只画 `check-lines.ts` 给的那些句子**，不在这里拼字符串。
 *
 * 为什么判据性的句子要在纯模块里：浏览器测试在没有 Chrome 的机器上是 skip，
 * 而 node:test 对全跳过的文件给 pass 0 / fail 0 / 退出码 0 —— 那种情况下
 * "这几句话被守着"是假的。句子在 `check-lines.ts`，node 测句子，这里只测接线。
 * 完整理由写在那个文件头上。
 */
function renderStatus(r: CheckResult): Node[] {
  return checkStatusLines(r).map((l) =>
    l.kind === 'badge' ? badge(l.status, l.text)
      : l.kind === 'error' ? h('span', { class: 'err-text mono', text: l.text })
        : h('span', { class: 'mono dim', text: l.text }));
}

function renderIssues(r: CheckResult): Node[] {
  if (!r.parsed) return [card('schema 报错', h('pre', { class: 'code', text: r.parseError ?? '' }))];
  const missing = r.dry?.missingInputs ?? [];
  const nodes: Node[] = [];
  if (missing.length) {
    /*
     * 卡片要说清**上哪儿填**，只点名变量名是不够的。
     *
     * 改前它只有一排 `<code>who</code>`，而这个人此刻站在编辑器前面，手边有
     * 「运行」按钮 —— 他会以为点运行就能补上，而运行**永远不会**带上输入
     * （`runIt` 不传 `inputs`，那一格还没做，已登记 docs/14 §5）。
     * 所以这里给的是**今天真的能用**的那条路（CLI 的 `--input`），而不是含糊一句
     * "请提供参数"。为什么不在这里放一个输入框：`/api/run` 今天把 inputs 拼成
     * CLI 的 `--input k=v` 放进 argv，而 argv 会被 `ps aux` 与 CI 的命令日志收走 ——
     * 那正是本仓对密钥立的那条纪律要挡的形状，界面上多一个"看起来随便填"的框
     * 会把这条路径变成默认路径。修法与这条约束一起登记在 docs/14 §5。
     */
    nodes.push(card('缺少必填输入', h('div', { class: 'stack', children: [
      h('div', { class: 'row', children: missing.map((m) => h('code', { text: m })) }),
      h('div', { class: 'fix', text: missingInputHint(missing) }),
      h('div', { class: 'fix', text: SECRET_ROUTE_HINT }),
    ] })));
  }
  const issueRow = (i: LintIssue): HTMLElement => h('div', {
    class: 'issue', level: i.level,
    children: [
      h('span', { class: 'lv', text: i.level === 'error' ? '✗' : '!' }),
      h('div', { class: 'spacer', children: [
        h('div', { children: [h('span', { class: 'code', text: i.code }), ...(i.stepId ? [txt(` · ${i.stepId}`)] : []), txt(` ${i.message}`)] }),
        ...(i.fix ? [h('div', { class: 'fix', text: `修法：${i.fix}` })] : []),
        ...(i.doc ? [h('div', { class: 'doc', text: `依据：${i.doc}` })] : []),
      ] }),
    ],
  });
  /*
   * 这一格只列 `r.issues`，所以空态那句话**必须点名它问的是哪一查**。
   *
   * 改前写的是「引擎没报任何问题」。而缺必填输入时 `r.issues` 是空的、
   * `r.dry.errors` 里躺着一条 error —— 于是屏幕上"引擎没报任何问题"与上面那张
   * 「缺少必填输入：who」同时出现，**两句里必须有一句在说谎**，而说谎的是卡片这句
   * （`check.ts` 头上写着三查都在引擎里，`dryRun` 也是引擎）。
   *
   * 治法是**把那句收窄到它真的覆盖面**，而不是把 dry 那几条并进来：并的话要
   * "两次 `lintScenario` 逐字一致"当显示层的隐式前提（`checkIr` 与 `dryRun`
   * 各调一次），那条前提没东西守，一旦 ctx 分叉就是**同一件事画两行红字** ——
   * 本仓为那种双报修过不止一次。那条 error 的载体本来就存在（上面那张卡 +
   * 新加的那枚徽章），坏的是这一格的一句话与一枚徽章都没有，不是没有载体。
   */
  const issueBody = r.issues.length === 0
    ? h('p', { class: 'empty', text: EMPTY_STATIC_GATE })
    : h('div', { children: r.issues.map(issueRow) });
  nodes.push(card(staticGateCardTitle(r.issues.length), issueBody));
  nodes.push(h('div', { class: 'banner', kind: 'info', text: GRAPH_NOT_AVAILABLE }));
  nodes.push(card('canonical IR（与 CLI 侧 irShaOf 的输入同一串）', h('pre', { class: 'code', text: r.canonical ?? '' })));
  return nodes;
}

/* ═══ C1 运行列表 ═══ */
async function pageRuns(): Promise<void> {
  shell(h('div', { class: 'stack', children: [h('p', { class: 'muted', text: '加载中…' })] }));
  const r = await api<{ items?: Array<{ dir: string; manifest?: Record<string, unknown>; broken?: boolean; error?: string }> }>('/api/runs');
  const items = r.items ?? [];
  const table = h('table', { children: [
    h('thead', { children: h('tr', { children: ['runId', '场景', '结论', '计数', '耗时', '成本', '报告'].map((x) => h('th', { text: x })) }) }),
    h('tbody', { children: items.length === 0
      ? [h('tr', { children: h('td', { class: 'empty', children: [txt('还没有 run。到场景库挑一条点"运行"，或跑 '), h('code', { text: 'atest run <场景 id> --env <环境>' })] }) })]
      : items.map((it) => {
        if (it.broken) {
          // manifest 读不出**照样占一行**：漏掉那一行等于说"这次 run 不存在"，而真相是"存在、我读不出"
          return h('tr', { children: [h('td', { class: 'mono', text: it.dir }), h('td', { colspan: 6, class: 'err-text', text: `manifest 读不出：${it.error ?? ''}` })] });
        }
        const m = (it.manifest ?? {}) as Record<string, unknown>;
        const sc = (m.scenario ?? {}) as Record<string, unknown>;
        const st = String(m.status ?? 'error') as StepStatus;
        const aborted = m.aborted !== undefined;
        /*
         * 压测的 run 与功能的 run 躺在**同一份列表**里（这是想要的：同一目录、同一条时间线），
         * 但它们的产物**不是同一套**，所以那一行不能照同一个样子画。
         * 判据与那句原因在 `run-lines.ts`（纯函数、node 可测，理由写在那儿的文件头），
         * 这里只负责画 —— 与 `check-lines.ts` / `status.ts` 同一个分工。
         */
        const row = runRow(m);
        return h('tr', { status: st, children: [
          h('td', { class: 'mono dim', text: it.dir }),
          h('td', { children: [
            txt(String(sc.id ?? '?')),
            ...row.tags.map((t) => h('span', { class: 'dim', text: ` (${t})` })),
          ] }),
          // 被中断的 run：manifest.status 可能仍是 pass（那是已完成步骤的结论），
          // 而 aborted 才是"这一次没跑完"。两个都要显示，只显一个就是骗人。
          h('td', { children: [badge(STEP_OK.includes(st) ? st : 'error'), ...(aborted ? [txt(' 已中断')] : [])] }),
          h('td', { children: tallyLine(m) }),
          h('td', { class: 'num mono', text: typeof m.durMs === 'number' ? `${m.durMs}ms` : '—' }),
          h('td', { class: 'num mono', text: typeof m.costUsd === 'number' ? `$${m.costUsd.toFixed(4)}` : '—' }),
          h('td', { children: [
            ...(row.hasReport
              ? [h('a', { href: `/evidence/${encodeURIComponent(it.dir)}/report.html`, text: 'report' })]
              : [h('span', { class: 'dim', text: row.reportWhy })]),
            txt(' · '), h('a', { href: `/evidence/${encodeURIComponent(it.dir)}/summary.txt`, text: 'summary' }),
          ] }),
        ] });
      }) }),
  ] });
  shell(card(`运行记录（${items.length}）`, table));
}

/** manifest.status 允许是任意字符串（它是落盘 JSON），所以进徽章之前要过一次白名单 */
const STEP_OK: readonly string[] = ['pass', 'fail', 'error', 'healed', 'skipped', 'triaged'];

async function render(): Promise<void> {
  const r = parseHash();
  if (r.page === 'scenario') return pageScenario(r.id);
  if (r.page === 'runs') return pageRuns();
  return pageScenarios();
}

/** 样式注入。这是全文件唯一一处碰 head 的地方，而且喂进去的是自己写的常量，不是数据 */
const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

applyPrefs();
addEventListener('hashchange', () => void render());
void render();
