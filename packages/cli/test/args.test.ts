/**
 * 参数解析测试。
 *
 * args.ts 是 CLI **唯一面向人输入**的入口，而"下一个 token 是不是这个开关的值"
 * 这个判断一旦出错，后果分两类，都很坏：
 *  1. 静默错位 —— `--secret --base-url http://x` 里 --secret 吞掉 --base-url，
 *     于是 baseUrl 没配上，而用户明明写了它。报错会指向"环境没配 baseUrl"，
 *     人反复检查自己那条命令，看不出问题在解析器。
 *  2. 拼错的开关被忽略 —— `--straegy boundary` 被跳过，用户以为"没指定 = 用默认"，
 *     实际拿到全量生成。
 * 这两类在"跑一条正常命令"的手测里永远看不见，所以这里逐条断。
 *
 * 测试用**真实的 COMMANDS 表**（从 main.ts 导入）而不是自己造一份 spec：
 * 自造 spec 测的是解析器，真实表还能顺带测出"某个开关从 --help 里漏了"
 * 与"两个命令的同一个开关别名冲突"这类真实缺陷。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatErrors, parseArgv } from '../src/args.js';
import { COMMANDS } from '../src/main.js';

const runCmd = COMMANDS.find((c) => c.name === 'run')!;

test('命令表自洽：每个命令有 summary/usage，开关名不重复（--help 少一个开关=用户不会知道它有）', () => {
  assert.ok(COMMANDS.length >= 4, 'run/lint/gen/agent 都要在表里（M6 交付项）');
  for (const c of COMMANDS) {
    assert.ok(c.name && c.summary && c.usage, `${c.name} 的 help 信息不全`);
    const names = c.flags.flatMap((f) => [f.name, ...(f.alias ? [f.alias] : [])]);
    assert.equal(new Set(names).size, names.length, `${c.name} 的开关/别名有重复：${names.join(',')}`);
    for (const f of c.flags) {
      assert.ok(f.desc, `${c.name} --${f.name} 缺说明`);
      if (f.value) assert.ok(f.metavar, `${c.name} --${f.name} 接受值却没写 metavar（--help 里会显示成 --x=）`);
      assert.ok(!f.name.startsWith('-'), `${c.name} --${f.name} 名字不该带前导 -`);
    }
  }
});

test('位置参数、长名开关、=值形式', () => {
  const { args, errors } = parseArgv(['run', 'a.json', 'b.json', '--env=staging', '--ci'], COMMANDS);
  assert.deepEqual(errors, []);
  assert.equal(args.command, 'run');
  assert.deepEqual(args.positionals, ['a.json', 'b.json']);
  assert.equal(args.flags.env, 'staging');
  assert.equal(args.flags.ci, true);
});

test('可重复开关收集成数组（--doc 与 --env-var 靠这个）', () => {
  const { args, errors } = parseArgv(['run', 'x', '--doc', 'a=1.json', '--doc', 'b=2.json', '--env-var', 'k=1', '--env-var', 'k=2'], COMMANDS);
  assert.deepEqual(errors, []);
  assert.deepEqual(args.multi.doc, ['a=1.json', 'b=2.json']);
  assert.deepEqual(args.multi['env-var'], ['k=1', 'k=2']);
});

test('值里带 = 号时只切第一个（--env-var url=http://h?p=1）', () => {
  const { args, errors } = parseArgv(['run', 'x', '--env-var=url=http://h?p=1'], COMMANDS);
  assert.deepEqual(errors, []);
  assert.equal(args.flags['env-var'], 'url=http://h?p=1');
});

test('空串值：解析层交出原始 "note="，切 k/v 是 buildEnv 的事（分层不能混）', () => {
  // 解析器**不该**理解 k=v 语义 —— 它对每个开关值一视同仁。
  // 把 split 放解析层会导致 --doc a=b.json 也被切、--env-var url=http://h?p=1 更没法弄。
  const { args, errors } = parseArgv(['run', 'x', '--env-var', 'note='], COMMANDS);
  assert.deepEqual(errors, []);
  assert.equal(args.flags['env-var'], 'note=', '解析层原样保留，交给 buildEnv 切成 note -> ""');
  // `--env-var=`（= 形式、值为空）也必须放行：那是"显式给空"，不是"漏了值"
  assert.equal(parseArgv(['run', 'x', '--env-var='], COMMANDS).args.flags['env-var'], '');
});

test('空值只能靠 = 形式给：--env-var 后面紧跟另一个开关时报错而不是吞掉它', () => {
  // 这是本文件最重要的一条。吞掉的后果：--env-var 拿到 "--env"，
  // 而 --env 没了值 -> 报错指向"环境没配"，真相是解析器错位
  const { errors } = parseArgv(['run', 'x', '--env-var', '--env', 'staging'], COMMANDS);
  assert.equal(errors.length, 1, `应当报错，实际：${JSON.stringify(errors)}`);
  assert.equal(errors[0]!.kind, 'missing-value');
  assert.match(errors[0]!.text, /env-var/);
  assert.match(errors[0]!.hint!, /--env/, '报错要点名它误吞的那个开关');
});

test('未知开关报错并给出最接近的候选（拼错的开关被忽略 = 静默改变行为）', () => {
  // 用 gen：--strategy 是 gen 的开关。在 run 上拼 --straegy 本来就该"没有候选"
  // （run 压根没有 strategy 这个概念），拿它验证"会提示"是在验证一个不存在的设计
  const { errors, args } = parseArgv(['gen', '--straegy', 'boundary'], COMMANDS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, 'unknown-flag');
  assert.match(errors[0]!.hint ?? '', /--strategy/, `应提示 strategy，实际：${errors[0]!.hint}`);
  // 而且**不能把它塞进 positionals**：那样它会被当成一个场景文件路径去读，
  // 得到"读不到文件 --strategy"这种二次误导的报错
  assert.ok(!args.positionals.includes('--strategy'));
});

test('单数/复数两种写法都接受，但只存一份规范名（别名要显式声明，不能靠猜）', () => {
  const sing = parseArgv(['gen', '--strategy', 'boundary'], COMMANDS);
  const plur = parseArgv(['gen', '--strategies', 'boundary'], COMMANDS);
  assert.deepEqual(sing.errors, []);
  assert.deepEqual(plur.errors, []);
  // 别名解析后必须落到**规范名**上：命令侧只读 strategy 一处，
  // 读两处（`a.multi.strategy ?? a.multi.strategies`）的那种写法迟早漏一个
  assert.deepEqual(sing.args.multi.strategy, ['boundary']);
  assert.deepEqual(plur.args.multi.strategy, ['boundary'], '复数写法没落到规范名上');
  assert.equal(plur.args.flags.strategy, 'boundary');
  // 拼错时提示的必须是**规范名**，不是别名：否则文档/脚本/报错里三种写法混着出现，
  // 半年后没人知道哪个是正的
  for (const typoArg of ['--straegy', '--strategie']) {
    const typo = parseArgv(['gen', typoArg, 'boundary'], COMMANDS);
    const hint = typo.errors[0]?.hint ?? '';
    assert.match(hint, /--strategy\b/, `${typoArg} 拼错时没给出规范名候选：${hint}`);
    assert.doesNotMatch(hint, /--strategies/, `提示不该指向别名：${hint}`);
  }
});

test('跨命令的开关不会互相提示（run 上没有 --strategy，就不该提示它）', () => {
  const { errors } = parseArgv(['run', 'x', '--straegy', 'b'], COMMANDS);
  assert.equal(errors[0]!.kind, 'unknown-flag');
  assert.doesNotMatch(errors[0]!.hint ?? '', /--strategy/, '提示别的命令的开关会让人在错误的命令上继续试');
});

test('拼错但差得太远时不乱猜（把 --timeout 提示成 --strategy 比不提示更误人）', () => {
  const { errors } = parseArgv(['gen', '--zzzzzzzz', 'x'], COMMANDS);
  assert.equal(errors[0]!.kind, 'unknown-flag');
  assert.doesNotMatch(errors[0]!.hint ?? '', /是不是想写 --(strategy|doc|write)/);
});

test('布尔开关不接受值：--ci=true 要报错（静默忽略值会让人以为能反向关闭）', () => {
  const { errors } = parseArgv(['run', 'x', '--ci=true'], COMMANDS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, 'needs-value');
});

test('-- 之后的东西一律当原始参数，不再解释为开关（留给将来的透传）', () => {
  const { args, errors } = parseArgv(['run', 'x', '--', '--ci'], COMMANDS);
  assert.deepEqual(errors, []);
  assert.deepEqual(args.positionals, ['x']);
  assert.deepEqual(args.rest, ['--ci']);
  assert.equal(args.flags.ci, undefined, '-- 之后的 --ci 不该生效');
});

test('-h 与 --help 在任何位置都置 help（用户先写参数再想不起开关时靠它）', () => {
  for (const h of ['-h', '--help']) {
    const { args } = parseArgv(['run', 'x', h], COMMANDS);
    assert.equal(args.help, true);
  }
});

test('短名开关：-e staging 取走下一个 token', () => {
  const one = parseArgv(['run', 'x', '-e', 'staging'], COMMANDS);
  assert.deepEqual(one.errors, []);
  assert.equal(one.args.flags.env, 'staging');
  // 紧贴值与 = 形式都要认（不同人的手感不同，不认就是"我明明写了"）
  assert.equal(parseArgv(['run', 'x', '-estaging'], COMMANDS).args.flags.env, 'staging');
  assert.equal(parseArgv(['run', 'x', '-e=staging'], COMMANDS).args.flags.env, 'staging');
});

test('短名组合只允许布尔开关 —— 用合成 spec 测（真实表里 run 唯一的短名 -e 是带值的）', () => {
  // 这一条**不能**用 COMMANDS 测：run 上只有 -e 一个别名且它接受值，
  // 于是"两个布尔短名组合"那条分支在真实表上根本走不到。
  // 走不到的分支就等于没被测过，所以这里给它一份最小合成 spec。
  const spec = [{
    name: 'x', summary: 't', usage: 't', flags: [
      { name: 'aa', alias: 'a', desc: 'a' }, { name: 'bb', alias: 'b', desc: 'b' },
      { name: 'val', alias: 'v', value: true, metavar: 'V', desc: 'v' },
    ],
  }];
  const combo = parseArgv(['x', '-ab'], spec);
  assert.deepEqual(combo.errors, []);
  assert.equal(combo.args.flags.aa, true);
  assert.equal(combo.args.flags.bb, true);
  // 未知短名逐个记，不整串吞掉（-ax 要能指出 x 是错的那个）
  const bad = parseArgv(['x', '-az'], spec);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0]!.text, '-z');
  assert.equal(bad.args.flags.aa, true, '组合里前面正确的部分仍应生效');
  // 带值短名在组合中间时，后面的字符会被当成它的值 —— 这是约定，但要一致
  assert.equal(parseArgv(['x', '-vfoo'], spec).args.flags.val, 'foo');
});

test('短名缺值也报错（与长名同一条判据）', () => {
  const { errors } = parseArgv(['run', 'x', '-e', '--ci'], COMMANDS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, 'missing-value');
});

test('- 单独一个 token 是 stdin 记号，不是开关', () => {
  const { args, errors } = parseArgv(['lint', '-'], COMMANDS);
  assert.deepEqual(errors, []);
  assert.deepEqual(args.positionals, ['-']);
});

test('末尾缺值：--env 是最后一个 token 时报错而不是取到 undefined', () => {
  const { errors } = parseArgv(['run', 'x', '--env'], COMMANDS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, 'missing-value');
});

test('未知命令与缺命令都给 USAGE 级别的错', () => {
  assert.equal(parseArgv(['nuke'], COMMANDS).errors[0]!.kind, 'unknown-command');
  assert.equal(parseArgv([], COMMANDS).errors[0]!.kind, 'no-command');
});

test('一个命令里的错误全部收集，不是遇到第一个就返回（改一处再跑又炸一处最难磨人）', () => {
  const { errors } = parseArgv(['run', '--foo', '--env'], COMMANDS);
  assert.equal(errors.length, 2, formatErrors(errors));
});

test('formatErrors 把 kind 翻成人话并带上提示（只打英文 kind 名等于没解释）', () => {
  const text = formatErrors(parseArgv(['gen', '--straategy'], COMMANDS).errors);
  assert.match(text, /未知开关/);
  assert.match(text, /--strategy/, '提示要在文本里');
  // 每种错误都得有中文标签。漏一种就会在界面上出现 "missing-value" 这种内部术语
  for (const argv of [['run', '--env'], ['gen', '--write=1'], ['nuke'], []]) {
    const es = parseArgv(argv, COMMANDS).errors;
    assert.ok(es.length >= 1, `${JSON.stringify(argv)} 本该报错`);
    const t = formatErrors(es);
    assert.doesNotMatch(t, /unknown-flag|missing-value|needs-value|no-command|unknown-command/, `还有人话没翻：${t}`);
    assert.ok(t.length > 0);
  }
});

test('开关的 commands 归属：gen 的 --write 不能被 run 用（防止"看起来能用其实没接"）', () => {
  const { errors } = parseArgv(['run', 'x', '--write'], COMMANDS);
  assert.equal(errors[0]!.kind, 'unknown-flag');
  const ok = parseArgv(['gen', '--doc', 'a=b.json', '--write'], COMMANDS);
  assert.deepEqual(ok.errors, []);
});

test('所有需要值的开关都不会被"下一个是开关"的形态静默吞掉（全表扫一遍）', () => {
  // 逐命令、逐带值开关构造 `[自己, --另一个开关]` 形态 —— 被测的是**第一个**开关，
  // 所以 argv 里排在第一位的必须是被测的那个（早先写成把 tail 放唯一位置，
  // 测的其实是 tail 自己，f 压根没出现在 argv 里，那条断言恒空通过）。
  // 只测 run 也不够：短名/别名那条分支在 args.ts 里是另一段代码。
  let checked = 0;
  for (const c of COMMANDS) {
    for (const f of c.flags.filter((x) => x.value)) {
      const decoy = `--${c.flags.find((x) => x.name !== f.name)?.name ?? 'zzunused'}`;
      const { errors } = parseArgv([c.name, `--${f.name}`, decoy], COMMANDS);
      const mine = errors.filter((e) => e.text === `--${f.name}`);
      assert.equal(mine.length, 1, `${c.name} --${f.name} 后面跟 ${decoy} 时应当场报错，实际：${formatErrors(errors)}`);
      assert.equal(mine[0]!.kind, 'missing-value');
      // 短名那条分支单独走一遍（同一份语义，两段实现）
      if (f.alias) {
        const viaAlias = parseArgv([c.name, `-${f.alias}`, decoy], COMMANDS);
        assert.equal(viaAlias.errors.filter((e) => e.kind === 'missing-value').length, 1,
          `${c.name} -${f.alias} 缺值时没报错（短名分支与长名分支行为不一致）`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 15, `扫到的带值开关太少（${checked}），说明命令表或本测试漏了`);
});
