#!/usr/bin/env node
/**
 * 架构分层检查（M0 的核心交付物）
 *
 * 为什么自研而不用 ESLint：
 *  1. 这条规则是架构约束而非代码风格约束，需要显式声明、可单测、报错能指向设计文档。
 *  2. 零依赖 —— 本机无外网（docs/README 已记录），少一个依赖就少一次装不上的风险。
 *
 * 规则来源：docs/01 §8.2 与 docs/04 M0
 *   packages/ir 与 packages/engine 禁止 import 任何 node 内置模块。
 *   理由：引擎必须能在浏览器里跑「只读校验」，否则 GUI 就得维护第二套校验逻辑，
 *   GUI 与执行器开始分叉 —— 这是 Postman↔Newman / Apifox GUI↔CLI / MeterSphere
 *   UI↔CI runner 全都踩过的坑（docs/00 §6.6）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** node 内置模块（含 node: 前缀与裸名）。用正则而非 import('node:module').builtinModules，
 *  避免将来有人把这条规则的实现本身变成规则违例的口子。 */
const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'test',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);
/**
 * 内置模块的**子路径同样禁止**（`fs/promises`、`crypto/random` …）。
 *
 * 原先有一张 SUBPATH_OK 白名单放行 fs/promises、stream/web 之类，理由是
 * 「这些是 Web 也有的 API」。但它用在受禁包里就是个直通口子：
 * `import 'fs'` 被拦、`import { readFile } from 'fs/promises'` 放行 ——
 * 两者能力完全相同，规则却只拦前者。要区分「浏览器也有的 API」应该按
 * **符号**管（那是 src/env.d.ts 那份 API 白名单的活），不能按模块路径管。
 */
function isBuiltinSpec(spec) {
  if (spec.startsWith('node:')) return true;
  const { bare, builtin } = specOf(spec);
  return BUILTIN.has(bare) || BUILTIN.has(builtin) || BUILTIN.has(builtin.split('/')[0]);
}

/** 受本规则约束的包 → 允许的例外。新增包必须在此显式声明，否则不受保护。 */
const LAYER_RULES = [
  {
    pkg: 'packages/ir',
    forbidNodeBuiltins: true,
    forbidPackages: ['engine', 'store', 'llm', 'server', 'web', 'cli', 'adapter-http', 'adapter-web'],
    reason: 'IR 必须是纯数据 + 纯函数，浏览器/Node/CI 三处共用（docs/02, docs/09 §1）',
    // 测试目录例外：node:test / node:assert 是内置的，装不上第三方测试框架正好用它们。
    // 例外必须**显式声明**在这里 —— 否则「测试能 import node:test」会让人以为规则有洞。
    exempt: '/test/',
  },
  {
    pkg: 'packages/engine',
    forbidNodeBuiltins: true,
    forbidPackages: ['store', 'llm', 'server', 'web', 'cli', 'adapter-http', 'adapter-web'],
    reason: '引擎禁止副作用：副作用全在 adapter，这是「一个执行引擎、GUI 只是它的一个视图」的唯一保证（docs/01 §8.2）',
    exempt: '/test/',
  },
  {
    pkg: 'packages/adapter-http',
    // adapter 是**唯一**被允许碰 node/网络的层，所以这里不禁内置模块。
    // 反过来讲：一旦 adapter 之外出现 fetch/fs，引擎就再也跑不进浏览器与 Worker 了。
    forbidNodeBuiltins: false,
    forbidPackages: ['store', 'llm', 'server', 'web', 'cli'],
    reason: '本层是**网络**副作用的唯一归属地（放行 node:net/http 等），引擎的纯净全靠副作用集中在这里；依赖方向上它只依赖 ir + engine 的接口，不得反向认识服务端/UI/LLM（docs/01 §1，docs/04 M2）',
    exempt: '/test/',
  },
  {
    pkg: 'packages/adapter-web',
    // 与 adapter-http 同层：这一层的职责就是**浏览器**副作用（起进程、发 CDP），
    // 所以放行 node:child_process/fs。引擎侧只留 UiExec 端口 ——
    // "引擎无副作用"靠的是端口在引擎、实现在这里，而不是靠自觉。
    forbidNodeBuiltins: false,
    forbidPackages: ['store', 'llm', 'server', 'web', 'cli', 'adapter-http', 'adapter-web'],
    reason: '本层是**浏览器**副作用的唯一归属地（起进程 + CDP）。它不得认识服务端/UI/LLM，'
      + '也**不得依赖 adapter-http**：跨 adapter 共用 HTTP 客户端会让 Web 端的请求绕过'
      + ' 引擎侧那套 SSRF/密钥纪律（docs/05 §4）。需要发请求时走引擎的 http 步骤，不是在这里 import',
    exempt: '/test/',
  },
  {
    pkg: 'packages/store',
    // 与 adapter-http 同理：这层的职责就是磁盘（内容寻址证据 + evidence.zip），
    // 所以允许 node:fs / node:crypto。**引擎侧只留 ArtifactStore 端口**，
    // 那条"引擎无副作用"的约束靠的是端口在这里、实现在这里，而不是靠大家自觉。
    forbidNodeBuiltins: false,
    forbidPackages: ['llm', 'server', 'web', 'cli', 'adapter-http'],
    reason: '本层的职责就是**磁盘**（内容寻址证据 + evidence.zip），所以放行 node:fs/crypto；引擎侧只留 ArtifactStore 端口。依赖方向上它只认 ir + engine 的数据形状，不得认识服务端/UI/CLI，也不得依赖某个具体 adapter（docs/01 §1）',
    exempt: '/test/',
  },
  {
    pkg: 'packages/cli',
    // CLI 是最外面那层：它可以认识所有下层，但没有更低层可认识了。
    // 这里规则的意义不在"禁 node"（它必须碰磁盘与进程），而在**依赖面的形状**：
    // CLI 是第一个被允许同时依赖 store 与 adapter-http 的包 ——
    // 装配一次运行需要把「证据存储 + http adapter + 引擎」三者拼起来，
    // 而这个装配逻辑必须与 run 命令在同一处，否则 GUI/服务端/CI 各装一套，
    // "本地绿而 CI 红"就有了藏身处。也正因为它是唯一的全知层，
    // 反过来（store/adapter 依赖 cli）必须由它们各自的规则拦住。
    forbidNodeBuiltins: false,
    forbidPackages: ['server', 'web'],
    reason: 'CLI 必然碰**磁盘与进程**（读 IR 文件、写证据包、按退出码向 CI 汇报），所以放行 node 内置模块；副作用集中在这一层正是引擎能保持纯净的前提。它也是唯一被允许同时装配 engine+adapter-http+store 的层。不得认识服务端/UI：那会让"能不开服务端就在本地跑"这条失效（docs/01 §1、docs/04 M6）',
    exempt: '/test/',
  },
];

const IMPORT_RE = [
  // import ... from 'x' / export ... from 'x' / import 'x'
  /(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  // 动态 import 与 require —— 绕过静态检查的常见口子，一并堵
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * 行号：给开发者直接可点击的位置。
 * IMPORT_RE 的第一个模式以 `(?:^|\n)` 开头，所以 m.index 落在**换行符上**，
 * 直接用会让每条报错的行号都少 1 —— 报错指到上一行，比不报行号更误人。
 * 因此先跳过前导空白再数行。
 */
function lineOf(text, index) {
  const ws = text.slice(index).search(/\S/);
  const at = ws < 0 ? index : index + ws;
  return text.slice(0, at).split('\n').length;
}

function sourcesOf(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourcesOf(p));
    else if (/\.(ts|tsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function specOf(spec) {
  if (spec.startsWith('node:')) return { builtin: spec.slice(5), bare: spec.slice(5) };
  const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return { builtin: spec.includes('/') ? spec : bare, bare };
}

/**
 * 核心检查。**导出是为了能被测试**：一条没人测过的检查规则，等于一条写错了
 * 也没人知道的规则 —— 而这条规则承担的是「引擎能在浏览器里跑」整个论断。
 * 一个静默失效的 lint 比没有 lint 更糟：它让「有保护」变成错觉。
 *
 * @param {{pkg: string, text: string}[]} sources 已读出的源文件
 * @param {typeof LAYER_RULES} rules
 */
export function checkSources(sources, rules = LAYER_RULES) {
  const violations = [];
  for (const rule of rules) {
    for (const { pkg, text } of sources) {
      if (pkg !== rule.pkg && !pkg.startsWith(rule.pkg + '/')) continue;
      // 例外只豁免「node 内置模块」一条；依赖方向在测试里同样不许反着来
      const exemptBuiltins = Boolean(rule.exempt) && pkg.includes(rule.exempt);
      for (const re of IMPORT_RE) {
        for (const m of text.matchAll(re)) {
          const spec = m[1];
          const { bare } = specOf(spec);
          if (rule.forbidNodeBuiltins && isBuiltinSpec(spec) && !exemptBuiltins) {
            violations.push({ where: `${pkg}:${lineOf(text, m.index)}`, what: `import '${spec}'`, why: `禁止 node 内置模块。${rule.reason}` });
          }
          if (rule.forbidPackages.includes(bare.replace(/^@[^/]+\//, ''))) {
            violations.push({ where: `${pkg}:${lineOf(text, m.index)}`, what: `import '${spec}'`, why: `禁止依赖上层包（依赖方向必须单向向下，docs/01 §1）。${rule.reason}` });
          }
        }
      }
    }
  }
  return violations;
}

/** 供测试引用：内置模块清单与豁免表都是行为的一部分，别靠记忆 */
export { BUILTIN, LAYER_RULES };

/**
 * 磁盘上存在但**没有任何规则覆盖**的包。
 *
 * 这一条不是洁癖：LAYER_RULES 里同时把 adapter-http 列为「别人不许依赖它」，
 * 却没把它列为「它自己受检」，于是它 import 服务端包可以安静通过好一阵。
 * 「新增包必须显式声明才受保护」如果只写在注释里，就等于没写。
 */
export function uncoveredPackages(dirs, rules = LAYER_RULES) {
  const covered = new Set(rules.map((r) => r.pkg));
  return dirs.filter((d) => !covered.has(d));
}

/** CLI 入口：只在**被直接执行**时跑，被 import 时保持安静 */
function main() {
  const sources = [];
  for (const rule of LAYER_RULES) {
    let files;
    try {
      files = sourcesOf(join(ROOT, rule.pkg));
    } catch {
      continue; // 规则指向的包还没建，跳过（M0 逐步建的正常状态）
    }
    for (const f of files) sources.push({ pkg: relative(ROOT, f).split(sep).join('/'), text: readFileSync(f, 'utf8') });
  }

  // 反向检查：磁盘上有包但没规则 -> 报错，而不是安静地不检查它
  const pkgsDir = join(ROOT, 'packages');
  let onDisk = [];
  try {
    onDisk = readdirSync(pkgsDir)
      .filter((n) => !n.startsWith('.') && n !== 'node_modules')
      .filter((n) => statSync(join(pkgsDir, n)).isDirectory())
      .map((n) => `packages/${n}`);
  } catch {
    /* 还没有 packages 目录，跳过 */
  }
  const naked = uncoveredPackages(onDisk);
  if (naked.length) {
    console.error(`\n✗ 这些包没有架构分层规则，等于不受保护：${naked.join('、')}`);
    console.error('  请在 tooling/lint-layers.mjs 的 LAYER_RULES 里显式声明它允许依赖什么。\n  不确定就先写最严的（forbidPackages 列全所有上层包）。\n');
    process.exit(1);
  }
  const violations = checkSources(sources);
  if (violations.length) {
    console.error(`\n✗ 架构分层检查未通过（${violations.length} 处）\n`);
    for (const v of violations) console.error(`  ${v.where}\n      ${v.what}\n      ${v.why}\n`);
    console.error('  设计依据见 docs/01 §8.2 与 docs/04 M0。若确需例外，请改 tooling/lint-layers.mjs 的 LAYER_RULES 并在 PR 里说明理由。\n');
    process.exit(1);
  }
  console.log('✓ 架构分层检查通过（ir/engine 无 node 内置依赖，依赖方向单向向下）');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
