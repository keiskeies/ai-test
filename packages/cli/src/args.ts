/**
 * 极简参数解析（代替 commander —— 本机无外网，装不上，见 docs/README）。
 *
 * docs/01 §4 写的是"Commander + @clack/prompts"。这里手写 ~120 行的替代实现，
 * 并把那条偏差记在 docs/04 §M6：**不是**"顺手自己写了个轮子"，
 * 而是离线环境下的唯一选择；将来能装包时应换回去，
 * 所以解析逻辑与命令实现**完全分开**（本文件不 import 任何命令代码，
 * 也不 import node 内置模块 —— 纯函数才能这么测）。
 *
 * 为什么它值得单独一个文件 + 单独一份测试：
 * 参数解析是 CLI 唯一**面向人输入**的入口，而 `--secret` 这类开关的
 * "下一个 token 是它的值吗"判断错一下，后果是密钥被当成位置参数打印出来。
 * 这类 bug 在 happy path 手测里永远看不见。
 */

export interface ParsedArgs {
  command: string;
  /** 命令后的第一个开关之前的裸参数（`atest run a.json b.json` → ['a.json','b.json']） */
  positionals: string[];
  /** 布尔开关与 `--k=v` 形式。值为字符串，由命令侧解释 */
  flags: Record<string, string | boolean>;
  /** 可重复开关收集成数组：`--strategy a --strategy b` → ['a','b'] */
  multi: Record<string, string[]>;
  /** 命令后的第一个 `--` 之后的原始参数（留给将来 `atest run -- --node-flags`） */
  rest: string[];
  /** 未知开关。**必须报出来而不是忽略**：`--straegy` 拼错后被忽略，
   *  用户会以为"没指定策略 = 用默认策略"，实际拿到的是全量生成 */
  unknown: string[];
  help: boolean;
}

export interface FlagSpec {
  /** 开关名（不含 --）。短名写在这条里就行，比如 'env' 配 alias 'e' */
  name: string;
  alias?: string;
  /** 是否需要值。缺省 false（纯开关）。需要值而没给值 → 记进 missingValue */
  value?: boolean;
  /** 可重复 */
  repeatable?: boolean;
  /** 出现在哪些命令上。空数组 = 所有命令 */
  commands?: string[];
  desc: string;
  /** 值示例（--help 里显示，也用于错误提示） */
  metavar?: string;
}

export interface ParseError {
  kind: 'unknown-flag' | 'missing-value' | 'needs-value' | 'no-command' | 'unknown-command';
  text: string;
  hint?: string;
}

export interface ParseResult {
  args: ParsedArgs;
  errors: ParseError[];
  /** 命中的命令名，用于 --help 只打印这个命令的开关 */
  spec: CommandSpec | undefined;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** 位置参数说明，用于 --help */
  usage: string;
  flags: FlagSpec[];
  detail?: string;
}

/** 命令后的第一个"开关之前"的裸参数收集到哪一步 */
export function parseArgv(argv: string[], commands: CommandSpec[]): ParseResult {
  const empty: ParsedArgs = {
    command: '', positionals: [], flags: {}, multi: {}, rest: [], unknown: [], help: false,
  };
  const cmdName = argv[0];
  if (!cmdName) return { args: empty, errors: [{ kind: 'no-command', text: '' }], spec: undefined };
  const spec = commands.find((c) => c.name === cmdName);
  if (!spec) {
    return { args: { ...empty, command: cmdName }, errors: [{ kind: 'unknown-command', text: cmdName }], spec: undefined };
  }

  const byName = new Map<string, FlagSpec>();
  // 提示用的候选**只含规范名**。别名照样接受（byName 里有），但拼错时
  // 提示的必须是文档里那一个名字：`--strategie` 提示成 `--strategies`
  // 虽然也能跑，却会让文档、脚本、--help 三种写法在同一条报错里混着出现，
  // 半年后没人知道哪个是正的。
  const canonical: string[] = [];
  for (const f of spec.flags) {
    byName.set(f.name, f);
    if (f.alias) byName.set(f.alias, f);
    canonical.push(f.name);
  }

  const args: ParsedArgs = { ...empty, command: cmdName, flags: {}, multi: {}, positionals: [], unknown: [], rest: [] };
  const errors: ParseError[] = [];
  let noMoreFlags = false;

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!;
    if (noMoreFlags) { args.rest.push(tok); continue; }
    if (tok === '--') { noMoreFlags = true; continue; }
    if (tok === '-h' || tok === '--help') { args.help = true; continue; }
    // 单个 `-` 是 stdin 的惯用记法，不是开关
    if (tok === '-') { args.positionals.push(tok); continue; }

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const rawName = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq < 0 ? undefined : tok.slice(eq + 1);
      const f = byName.get(rawName);
      if (!f) {
        args.unknown.push(tok);
        // 已知 `--k=v` 但写成了 `--k v`，是最常见的一次错误。
        // 报错时必须把"你以为要写的样子"打出来，否则人会去翻源码。
        const guess = nearest(rawName, canonical);
        errors.push({
          kind: 'unknown-flag', text: tok,
          hint: guess ? `是不是想写 --${guess}？` : `可用开关见 atest ${cmdName} --help`,
        });
        continue;
      }
      if (!f.value) {
        if (inline !== undefined) {
          errors.push({ kind: 'needs-value', text: tok, hint: `--${f.name} 是开关，不接受值（要传值的是 --<别的>）` });
          continue;
        }
        assignFlag(args, f, true);
        continue;
      }
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) {
        errors.push({ kind: 'missing-value', text: `--${f.name}`, hint: `用法：--${f.name}=${f.metavar ?? '<值>'}` });
        continue;
      }
      // **值以 -- 开头**时必须报错，不能当值吞掉：
      // `atest run a.json --secret --base-url http://x` 里 --secret 漏了值，
      // 吞掉的话 --secret 拿到 "--base-url"、baseUrl 变成没配，
      // 于是"我明明传了 baseUrl"而它没生效 —— 这种错位报错完全看不出来
      if (v.startsWith('--') && !/^--$/.test(v)) {
        errors.push({
          kind: 'missing-value', text: `--${f.name}`,
          hint: `它后面紧跟的是另一个开关 ${v}，所以 --${f.name} 其实没有值（不猜，避免静默错位）`,
        });
        continue;
      }
      assignFlag(args, f, v);
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      // 短名。`-ab` 组合只允许布尔开关；带值的短名只能出现在末尾（`-e staging`）
      // 或紧贴值（`-estaging` / `-e=staging`）。
      for (let k = 0; k < tok.length - 1; k++) {
        const ch = tok[k + 1]!;
        const f = byName.get(ch);
        if (!f) {
          args.unknown.push(`-${ch}`);
          errors.push({ kind: 'unknown-flag', text: `-${ch}`, hint: `atest ${cmdName} --help` });
          continue;
        }
        if (!f.value) {
          // 组合开关里出现带值短名（`-ae staging`）时，a 已消费，e 在下一轮处理
          assignFlag(args, f, true);
          continue;
        }
        const inlineTail = tok.slice(k + 2).replace(/^=/, '');
        const isLastInToken = k === tok.length - 2;
        let v: string | undefined = inlineTail;
        if (v === '' && isLastInToken) {
          const next = argv[++i];
          // 与长名同理：值不能是另一个开关，否则静默错位
          if (next !== undefined && next.startsWith('--')) {
            errors.push({ kind: 'missing-value', text: `-${ch}`, hint: `它后面紧跟的是另一个开关 ${next}` });
            break;
          }
          v = next;
        }
        if (v === undefined || v === '') {
          errors.push({ kind: 'missing-value', text: `-${ch}`, hint: `用法：-${ch}=${f.metavar ?? '<值>'}` });
          break;
        }
        assignFlag(args, f, v);
        break; // 带值短名之后本 token 不再有别的开关（`-efoo` 的值就是 foo）
      }
      continue;
    }

    args.positionals.push(tok);
  }

  return { args, errors, spec };
}

function assignFlag(args: ParsedArgs, f: FlagSpec, v: string | boolean): void {
  if (f.repeatable && typeof v === 'string') {
    (args.multi[f.name] ??= []).push(v);
    args.flags[f.name] = v; // 也留最后一份，方便"只关心最后一个"的命令侧写法
    return;
  }
  args.flags[f.name] = v;
}

/** Levenshtein 最近匹配（只为报错友好，不猜用户意图去执行） */
function nearest(input: string, candidates: string[]): string | undefined {
  if (!input || !candidates.length) return undefined;
  let best: { name: string; d: number } | undefined;
  for (const c of candidates) {
    const d = editDist(input, c);
    // 门槛：差 2 个字符以内。放开到 3 会把 --strategy 提示成 --timeout，反而误导
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name;
}

function editDist(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const ERROR_LABEL: Record<ParseError['kind'], string> = {
  'unknown-flag': '未知开关',
  'missing-value': '缺少值',
  'needs-value': '该开关不接受值',
  'no-command': '没指定命令',
  'unknown-command': '没有这个命令',
};

/** 把解析错误拼成人可读报错（含提示） */
export function formatErrors(errors: ParseError[]): string {
  return errors
    .map((e) => {
      const head = e.text ? `${e.text}：${ERROR_LABEL[e.kind]}` : ERROR_LABEL[e.kind];
      return e.hint ? `${head}。${e.hint}` : head;
    })
    .join('\n');
}
