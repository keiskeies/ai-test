/**
 * 项目约定与发现（`atest init` 写、其余命令读）。
 *
 * 为什么要有这么一层：`gen` 写完用例、`run` 再让人手打一遍路径，
 * 就会有两处路径来源，而这两处迟早不一致（gen 写进 cases/、run 读的是 test/）。
 * 更常见的坏法是不一致也没人发现 —— CI 跑的是空目录，绿。
 *
 * **没有配置文件是完全合法的状态**（这时所有路径都要显式传）。
 * 这条很重要：命令**绝不猜**"没配置就扫遍仓库找 json"，
 * 那样会静默跑出与预期不同的用例集，而 CI 只看得到"绿了"。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CliError, stripJsonComments } from './wiring.js';
import { EXIT } from './exit.js';

export const CONFIG_FILE = 'atest.json';

export interface ProjectConfig {
  /** 配置文件所在目录。所有相对路径以它为基准 */
  root: string;
  irDir: string;
  envDir: string;
  specDir: string;
  evidenceDir: string;
  /** 缺省环境名（`atest run --scenario x` 时不用每次写 --env） */
  defaultEnv?: string;
}

export const DEFAULT_CONFIG: Omit<ProjectConfig, 'root'> = {
  irDir: 'cases',
  envDir: 'env',
  specDir: 'spec',
  evidenceDir: 'evidence',
};

/**
 * 从 start 往上找 atest.json。
 * 往上找是为了"在 cases/ 子目录里也能跑 atest run"——
 * 这是人会做的第一件事，找不到配置文件而报"没有目录"会让人以为工具坏了。
 */
export async function findConfig(start: string): Promise<ProjectConfig | undefined> {
  let dir = resolve(start);
  for (;;) {
    try {
      const text = await readFile(join(dir, CONFIG_FILE), 'utf8');
      return normalizeConfig(JSON.parse(stripJsonComments(text)), dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
        continue;
      }
      // 找到了但读不动/不合法 —— 必须报，不能当"没有配置"继续跑：
      // 静默回落到默认路径，会在错误目录里跑出一堆"通过"
      throw new CliError(`${join(dir, CONFIG_FILE)} 读不了或不是合法 JSON：${(e as Error).message}`, EXIT.ENV);
    }
  }
}

function normalizeConfig(raw: unknown, root: string): ProjectConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${CONFIG_FILE} 必须是 JSON 对象`, EXIT.ENV);
  }
  const o = raw as Record<string, unknown>;
  // 键范围限定在这四个目录键。写成 keyof typeof DEFAULT_CONFIG 会把可选的
  // defaultEnv/ciTags 也放进来，索引类型退化成 union，只能靠断言收场
  const str = (k: 'irDir' | 'envDir' | 'specDir' | 'evidenceDir'): string => {
    const v = o[k];
    if (v === undefined) return DEFAULT_CONFIG[k];
    if (typeof v !== 'string' || !v) throw new CliError(`${CONFIG_FILE} 的 ${k} 要是非空字符串`, EXIT.ENV);
    return v;
  };
  // 相对路径按配置文件所在目录解析。相对 cwd 解析会在子目录里跑出另一套路径
  const rel = (p: string): string => (p.startsWith('/') ? p : resolve(root, p));
  return {
    root,
    irDir: rel(str('irDir')),
    envDir: rel(str('envDir')),
    specDir: rel(str('specDir')),
    evidenceDir: rel(str('evidenceDir')),
    defaultEnv: typeof o.defaultEnv === 'string' ? o.defaultEnv : undefined,
  };
}

export async function writeConfig(root: string, over: Partial<ProjectConfig> = {}): Promise<string> {
  const path = join(root, CONFIG_FILE);
  const body = {
    ...DEFAULT_CONFIG,
    ...(over.irDir ? { irDir: over.irDir } : {}),
    ...(over.envDir ? { envDir: over.envDir } : {}),
    ...(over.specDir ? { specDir: over.specDir } : {}),
    ...(over.evidenceDir ? { evidenceDir: over.evidenceDir } : {}),
    ...(over.defaultEnv ? { defaultEnv: over.defaultEnv } : {}),
  };
  await mkdir(root, { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * 按场景 id 找 IR 文件。
 *
 * **找不到时要说清找了哪个目录**，只说"没找到 scn.x"会让人去怀疑 id 拼错，
 * 而真相通常是目录不对（配置文件没写对，或者用例在别的仓）。
 */
export async function resolveScenarioPath(cfg: ProjectConfig | undefined, idOrPath: string, cwd: string): Promise<string> {
  // 看起来是文件路径（带分隔符或扩展名）就按路径处理
  if (/\.(jsonc?|ya?ml)$/.test(idOrPath) || idOrPath.includes('/') || idOrPath === '-') {
    if (idOrPath === '-') return '-';
    const direct = resolve(cwd, idOrPath);
    try { await readFile(direct, 'utf8'); return direct; } catch { /* 继续按 id 找 */ }
  }
  const roots = cfg ? [cfg.irDir, cfg.root] : [resolve(cwd)];
  const tried: string[] = [];
  for (const rootDir of roots) {
    for (const name of [`${idOrPath}.json`, `${idOrPath}.jsonc`]) {
      const p = join(rootDir, name);
      tried.push(p);
      try { await readFile(p, 'utf8'); return p; } catch { /* 换下一个 */ }
    }
    // 也允许"目录/一个场景一个文件"和"id 写在别处"两种布局里的递归查找
    const hit = await findByScenarioId(rootDir, idOrPath);
    if (hit) return hit;
    tried.push(`${rootDir}/**（按内部 id 递归找过）`);
  }
  throw new CliError(
    `找不到场景 "${idOrPath}"。找过：\n${tried.map((p) => `  · ${p}`).join('\n')}`,
    EXIT.ENV,
    cfg ? undefined : `仓库里没有 ${CONFIG_FILE}。先跑 atest init，或直接把 IR 文件路径传给 run`,
  );
}

/** 递归按**文件内的 scenario.id** 找（文件名与 id 不一致是常态：改名后 id 常留旧的） */
async function findByScenarioId(rootDir: string, id: string): Promise<string | undefined> {
  let names: string[];
  try { names = await readdir(rootDir, { recursive: true }) as string[]; } catch { return undefined; }
  for (const name of names) {
    if (!/\.jsonc?$/.test(name)) continue;
    const p = join(rootDir, name);
    try {
      const raw = JSON.parse(stripJsonComments(await readFile(p, 'utf8'))) as { id?: unknown };
      if (raw?.id === id) return p;
    } catch { /* 不是 IR 文件或有语法错。这里不能因为一个坏文件就让整次查找失败 */ }
  }
  return undefined;
}

/** 环境文件解析：`--env staging` → env/staging.json。没扩展名时补 .json */
export async function resolveEnvFile(cfg: ProjectConfig | undefined, nameOrPath: string, cwd: string): Promise<string> {
  const candidates = [
    resolve(cwd, nameOrPath),
    ...(cfg ? [join(cfg.envDir, nameOrPath), join(cfg.envDir, `${nameOrPath}.json`)] : []),
    resolve(cwd, `${nameOrPath}.json`),
  ];
  for (const p of candidates) {
    try { await readFile(p, 'utf8'); return p; } catch { /* 下一个 */ }
  }
  throw new CliError(
    `找不到环境 "${nameOrPath}"。找过：\n${candidates.map((p) => `  · ${p}`).join('\n')}`,
    EXIT.ENV,
    `环境文件是一个 JSON 对象，形如 {"baseUrl":"https://api.staging.internal"}。没有现成的就先写一个，或用 --env-var baseUrl=... 临时给`,
  );
}
