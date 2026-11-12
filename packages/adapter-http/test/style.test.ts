/**
 * style × explode 序列化测试。
 *
 * 断言值**逐格照抄 OAS 3.0 规范的 style 示例表**（id=3 / role=admin, firstName=Alex 那两组）。
 * 这种纯映射代码自己跟自己约定没有意义：如果实现和测试都按同一份误解写，
 * 测试全绿而发出去的请求全是错的 —— 而"错"的表现形式是后端把缺参数当默认值处理，
 * 用例照样 200 照样绿。只有外部权威表能发现它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import nodeQs from 'node:querystring';
import { styleParam, buildQuery, fillPath, defaultStyle, DEFAULT_EXPLODE, StyleError, PARAM_STYLES, type ParamStyle, type Serialized } from '../src/openapi/style.js';

/** 规范表里 query 那几行的期望是"查询串片段"，这里统一从 pairs/raw 还原成它。 */
function q(name: string, value: unknown, style: ParamStyle, explode: boolean): string {
  return buildQuery([{ name, value, style, explode }]).slice(1);
}
/** path 那几行的期望是"路径片段"（含前导 /）。 */
function p(name: string, value: unknown, style: ParamStyle, explode: boolean): string {
  const { url, missing } = fillPath(`/x/{id}`, new Map<string, unknown>([[name, value]]), () => ({ style, explode }));
  assert.deepEqual(missing, []);
  return url.slice(2); // 去掉 /x
}

describe('规范默认值', () => {
  test('style 默认随位置：query/cookie=form，path/header=simple', () => {
    assert.equal(defaultStyle('query'), 'form');
    assert.equal(defaultStyle('cookie'), 'form');
    assert.equal(defaultStyle('path'), 'simple');
    assert.equal(defaultStyle('header'), 'simple');
  });

  test('explode 默认 **true**（这条最容易记反）', () => {
    assert.equal(DEFAULT_EXPLODE, true);
    // 记成 false 的话，数组查询参数会静默变成逗号形式
    assert.equal(q('id', [3, 4, 5], 'form', undefined as unknown as boolean), 'id=3&id=4&id=5');
  });
});

describe('query：style=form（规范表 5.1）', () => {
  test('array + explode=true -> id=3&id=4&id=5', () => {
    assert.equal(q('id', [3, 4, 5], 'form', true), 'id=3&id=4&id=5');
  });
  test('array + explode=false -> id=3,4,5', () => {
    assert.equal(q('id', [3, 4, 5], 'form', false), 'id=3,4,5');
  });
  test('object + explode=true -> 拆成独立键，且顺序按对象键序', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'form', true), 'role=admin&firstName=Alex&age=42');
  });
  test('object + explode=false -> id=role,admin,firstName,Alex,age,42', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'form', false), 'id=role,admin,firstName,Alex,age,42');
  });
  test('标量 -> id=5', () => {
    assert.equal(q('id', 5, 'form', true), 'id=5');
  });
});

describe('query：spaceDelimited / pipeDelimited（规范表 5.3/5.4）', () => {
  test('space + explode=false -> id=3%204%205（是 %20 不是 +）', () => {
    // URLSearchParams 会把空格编成 '+'，而规范要求 %20。
    // 这是本文件唯一"不能用标准库一把梭"的地方。
    assert.equal(q('id', [3, 4, 5], 'spaceDelimited', false), 'id=3%204%205');
    assert.ok(!q('id', [3, 4, 5], 'spaceDelimited', false).includes('+'));
  });
  test('pipe + explode=false -> id=3|4|5', () => {
    assert.equal(q('id', [3, 4, 5], 'pipeDelimited', false), 'id=3|4|5');
  });
  test('space/pipe + explode=true -> 退化成重复键', () => {
    assert.equal(q('id', [3, 4, 5], 'spaceDelimited', true), 'id=3&id=4&id=5');
    assert.equal(q('id', [3, 4, 5], 'pipeDelimited', true), 'id=3&id=4&id=5');
  });
  test('space/pipe 用在对象上报错，不猜一种形式', () => {
    assert.throws(() => q('id', { a: 1 }, 'pipeDelimited', false), StyleError);
  });
});

describe('query：style=deepObject（规范表 5.5）', () => {
  test('object + explode=true -> id[role]=admin&id[firstName]=Alex', () => {
    assert.equal(q('id', { role: 'admin', firstName: 'Alex', age: 42 }, 'deepObject', true), 'id[role]=admin&id[firstName]=Alex&id[age]=42');
  });
  test('deepObject 只适用对象，数组报错', () => {
    assert.throws(() => q('id', [1, 2], 'deepObject', true), /deepObject 只适用于对象/);
  });
});

describe('path：simple / label / matrix（规范表 6.x）', () => {
  const obj = { role: 'admin', firstName: 'Alex', age: 42 };
  test('simple：数组两种 explode 同结果 3,4,5', () => {
    assert.equal(p('id', [3, 4, 5], 'simple', true), '/3,4,5');
    assert.equal(p('id', [3, 4, 5], 'simple', false), '/3,4,5');
  });
  // 注意 explode 在 simple+object 下**确实改变结果**：true 保留 `k=v`，false 只留值
  test('simple：object explode=true -> /role=admin,firstName=Alex,age=42', () => {
    assert.equal(p('id', obj, 'simple', true), '/role=admin,firstName=Alex,age=42');
  });
  test('simple：object explode=false -> /role,admin,firstName,Alex,age,42', () => {
    assert.equal(p('id', obj, 'simple', false), '/role,admin,firstName,Alex,age,42');
  });
  test('label：array -> /.3.4.5；object explode=true -> /.role=admin.firstName=Alex.age=42', () => {
    assert.equal(p('id', [3, 4, 5], 'label', true), '/.3.4.5');
    assert.equal(p('id', obj, 'label', true), '/.role=admin.firstName=Alex.age=42');
    assert.equal(p('id', obj, 'label', false), '/.role,admin,firstName,Alex,age,42');
  });
  test('matrix：array explode=true -> /;id=3;id=4;id=5；false -> /;id=3,4,5', () => {
    assert.equal(p('id', [3, 4, 5], 'matrix', true), '/;id=3;id=4;id=5');
    assert.equal(p('id', [3, 4, 5], 'matrix', false), '/;id=3,4,5');
  });
  test('matrix：object explode=true -> /;role=admin;firstName=Alex；false -> /;id=role,admin,...', () => {
    assert.equal(p('id', obj, 'matrix', true), '/;role=admin;firstName=Alex;age=42');
    assert.equal(p('id', obj, 'matrix', false), '/;id=role,admin,firstName,Alex,age,42');
  });
});

describe('编码边界', () => {
  test('查询值里的特殊字符被逐值编码（不是先拼串再整体编）', () => {
    assert.equal(buildQuery([{ name: 'q', value: 'a&b=c' }]).slice(1), 'q=a%26b%3Dc');
    assert.equal(buildQuery([{ name: 'q', value: '中文 名' }]).slice(1), 'q=%E4%B8%AD%E6%96%87%20%E5%90%8D');
  });
  test('path 值里的 / 被编码，不会凭空多一段路径', () => {
    const { url } = fillPath('/f/{name}', new Map([['name', 'a/b']]));
    assert.equal(url, '/f/a%2Fb');
  });
  test('path 值里的中文被编码', () => {
    assert.equal(fillPath('/u/{n}', new Map([['n', '张三']])).url, '/u/%E5%BC%A0%E4%B8%89');
  });
  test('值里有 = 时，查询串的键仍可正确还原', () => {
    const qs = buildQuery([{ name: 'k', value: 'a=b' }]).slice(1);
    assert.equal([...new URLSearchParams(qs)].length, 1);
    assert.equal(new URLSearchParams(qs).get('k'), 'a=b');
  });

  test('值里有 + 时，服务端解回来仍是 +（查询串里 + 表示空格）', () => {
    /*
     * 断言写成**往返**而不是"等于某个字节串"：要保的性质是"发出去的值 = 用户写的值"，
     * 而判定它的是**真解析器**（`URLSearchParams` 与 `node:querystring.parse` 是两种实现，
     * 两个都过才算数）。只钉字节串的话，测试与实现会按同一份误解各写一遍。
     *
     * 改前发出的是 `q=a+b`，两个解析器都读回 `'a b'` —— 于是这条测试在改前是红的，
     * 而它抓的缺陷形态是"用例绿而查的不是那个值"（查 `C++` 的用例打到 `C  ` 上，
     * 后端回 200，没人知道）。
     */
    for (const v of ['a+b', 'C++', '2024+01+05', 'p+ass+word']) {
      const qs = buildQuery([{ name: 'q', value: v }]).slice(1);
      assert.ok(!qs.includes('+'), `查询串里留着裸 +（${qs}），任何 form 解析器都会把它读成空格`);
      assert.equal(new URLSearchParams(qs).get('q'), v, `URLSearchParams 解回的不是原值（${qs}）`);
      assert.equal(nodeQs.parse(qs).q, v, `node:querystring 解回的不是原值（${qs}）`);
    }
  });

  test('path 片段里的 + 保持字面量（只有查询串才把 + 当空格）', () => {
    /*
     * 这一条和上一条是一对，**少了它就等于把上一条修过了头**。
     * `+` 是 RFC 3986 的 sub-delim，在 path 段里是合法字面量，规范也没要求编码它；
     * 若把 encQ 那一条误当成"全局不许有 +"，path 侧会跟着一起变，
     * 而上面那整段照抄规范表的 style 示例就会开始对不上表。
     */
    assert.equal(fillPath('/u/{n}', new Map([['n', 'a+b']])).url, '/u/a+b');
  });

  test('spaceDelimited / pipeDelimited 的元素逐个编码，分隔符仍是字面量', () => {
    /*
     * `Serialized.raw` 的注释写着"已按规范编码好"，而改前它**没有**编码元素：
     * `['a&b','c']` 在 pipeDelimited 下发成 `q=a&b|c`，服务端解成
     * `{q:'a', 'b|c':''}` —— 一个参数劈成两个，第二个键是垃圾，而用例照样 2xx。
     * 判据仍是往返 + 分隔符形态两头都要住：
     *  ① 解回来必须还是**一个**参数、值里分隔符与特殊字符都在；
     *  ② 规范表期望的 `id=3%204%205` / `id=3|4|5` 不许被编坏（分隔符编掉就退化成
     *     单值逗号形式，那是上面规范表那几条抓不到的另一种错）。
     */
    const pipe = buildQuery([{ name: 'id', value: ['a&b', 'c=d', 'e f'], style: 'pipeDelimited', explode: false }]).slice(1);
    const back = [...new URLSearchParams(pipe).entries()];
    assert.equal(back.length, 1, `一个参数被劈成 ${back.length} 个：${pipe}`);
    assert.equal(back[0]?.[0], 'id');
    assert.equal(back[0]?.[1], 'a&b|c=d|e f', `值在往返中变形：${pipe}`);

    // 规范表那一格（OAS 3.0 spaceDelimited + explode=false -> id=3%204%205）
    assert.equal(q('id', [3, 4, 5], 'spaceDelimited', false), 'id=3%204%205');
    assert.equal(q('id', [3, 4, 5], 'pipeDelimited', false), 'id=3|4|5');
  });
});

describe('fillPath 的失败模式', () => {
  test('缺参数：保留 {id} 并列出缺失名（静默留下 {id} 会得到一个查不出原因的 404）', () => {
    const r = fillPath('/o/{id}/x/{x}', new Map([['id', 1]]));
    assert.equal(r.url, '/o/1/x/{x}');
    assert.deepEqual(r.missing, ['x']);
  });
  test('null 值也算缺失（发 `?x=` 与不发这个参数语义不同）', () => {
    assert.deepEqual(fillPath('/o/{id}', new Map([['id', null]])).missing, ['id']);
  });
  test('多个参数、重复占位（同一参数出现两次）都填上', () => {
    const r = fillPath('/u/{id}/x/{id}', new Map([['id', 7]]));
    assert.equal(r.url, '/u/7/x/7');
    assert.deepEqual(r.missing, []);
  });
  test('无占位符的模板原样返回，且不产生 ?', () => {
    assert.equal(fillPath('/health', new Map()).url, '/health');
    assert.equal(buildQuery([]), '');
  });
});

describe('未知 style：报错而不是返回 undefined', () => {
  /*
   * 这一组守的是**返回值的完整性**，而不是某个具体编码结果。改前的形状：
   * `styleParam` 声明返回 `Serialized`（没有 `| undefined`），而函数体是三个 switch，
   * 每个只列自己关心的那几格 —— 未知 style 配**标量**会落到 `default` 抛错，
   * 配**数组或对象**则一路走到函数尾，**返回 undefined**。
   * 类型上没人拦（`ParamSpec.style` 是裸 `string`，`parse.ts` 只验"是不是字符串"），
   * 于是 spec 里写错的 style（`form` 小写、`space-delimited` 带连字符，都是常见笔误）
   * 最后变成 `TypeError: Cannot read properties of undefined (reading 'raw')`，
   * 一句和"你 spec 写错了"毫无关系的报错。
   *
   * ⚠ 断言不能只写"抛 StyleError"就完事 —— 那正好是**只有标量那一支本来就会过**的写法
   * （改前标量也抛 StyleError，只是话说的不对）。所以这里把**三种值形态 × 一批非法
   * style 名整个扫一遍**，并且分开验两件事：① 抛的是 StyleError 而不是返回 undefined；
   * ② 报错文案点名的是"不是任何一种 style"，而不是那句在撒谎的"只适用于数组/对象"。
   */
  const BAD_STYLES = ['foo', 'Form', 'form ', 'space-delimited', 'pipe_delimited', 'deep_object', '', 'Simple'];
  const VALUES: Array<[string, unknown]> = [['标量', 'x'], ['数字', 7], ['数组', [1, 2]], ['空数组', []], ['对象', { a: 1 }], ['数组套对象', [{ a: 1 }]]];

  test('非法 style × 每种值形态都抛 StyleError（改前：数组/对象那几格返回 undefined）', () => {
    for (const [vt, value] of VALUES) {
      for (const style of BAD_STYLES) {
        let r: unknown;
        let threw: unknown;
        try {
          r = styleParam({ name: 'q', value, in: 'query', style: style as never });
        } catch (e) {
          threw = e;
        }
        assert.ok(threw !== undefined, `style=${JSON.stringify(style)} 值=${vt}：没抛异常，返回了 ${JSON.stringify(r)} —— 上游会拿到 undefined 然后在别处炸`);
        assert.ok(threw instanceof StyleError, `style=${JSON.stringify(style)} 值=${vt}：抛的是 ${(threw as Error).constructor.name}，不是 StyleError`);
        // 文案要说真话：改前标量那一支抛的是"只适用于数组/对象"，而 foo 对谁都不适用
        assert.match((threw as Error).message, /不是 OpenAPI 3 定义的任何一种/, `style=${JSON.stringify(style)} 值=${vt} 的报错文案没说明"这不是一个 style"：${(threw as Error).message}`);
      }
    }
  });

  test('合法 style × 每种值形态：要么给出 Serialized，要么抛 StyleError（**不许有第三种**）', () => {
    /*
     * 这条是上面那条的**另一半**，也是真正守"switch 没有洞"的那条。
     * 判据取自 `PARAM_STYLES` 而不是另抄一份名单 —— 抄一份的话，将来加一种 style
     * 而忘了在这里加，这条测试仍会全绿而洞又开回来。
     *
     * 三种"不合格"的出口分开判：undefined（函数尾掉下去）、null、以及
     * 形状不对的对象（pairs/text 缺一个都算）。上游读的是 `.raw` / `.pairs` / `.text`，
     * 少哪个字段都是同一类 TypeError。
     */
    let combos = 0;
    for (const style of PARAM_STYLES) {
      for (const explode of [true, false]) {
        for (const pos of ['query', 'path', 'header', 'cookie'] as const) {
          for (const [vt, value] of VALUES) {
            combos++;
            let r: Serialized | undefined;
            let threw: unknown;
            try {
              r = styleParam({ name: 'q', value, in: pos, style, explode });
            } catch (e) {
              threw = e;
            }
            const where = `style=${style} explode=${explode} in=${pos} 值=${vt}`;
            if (threw !== undefined) {
              // 非法组合只允许这一种报错形态（deepObject 用于数组等），文案得点名参数名
              assert.ok(threw instanceof StyleError, `${where}：抛的是 ${(threw as Error).constructor.name}`);
              assert.match((threw as Error).message, /"q"/, `${where}：报错没点名是哪个参数`);
              continue;
            }
            assert.notEqual(r, undefined, `${where}：返回 undefined（switch 有洞）`);
            assert.ok(Array.isArray(r!.pairs), `${where}：pairs 不是数组`);
            assert.equal(typeof r!.text, 'string', `${where}：text 不是字符串`);
            assert.ok(r!.raw === undefined || typeof r!.raw === 'string', `${where}：raw 既不是字符串也不是 undefined`);
            /*
             * ⚠ 这里原本还断言了"必须多少产出一点东西"（pairs 非空 / text 非空 / raw 存在
             * 三者至少其一），**而那条断言是错的、实现是对的**：空数组在
             * `form` + explode=true 下产出 `pairs: []` —— 没有值就没有参数，
             * 这正是想要的行为（`?tag=` 空值与"不带 tag 这个参数"语义不同，
             * 上面 fillPath 那组里 `null 值也算缺失` 一条守的就是这条区别）。
             * 我把它写成缺陷，等于要求平台为一个空集合编出一个参数来。
             * 所以这一格只判**形状**（是不是 Serialized 那个形状），产出多少不在这里判。
             */
          }
        }
      }
    }
    assert.ok(combos > 100, `扫过的组合只有 ${combos} 个，大概是外层循环漏了（这条测试的意义就在覆盖面）`);
  });
});

describe('确定性', () => {
  test('同一输入两次序列化字节完全一致（mock 匹配与 trace diff 依赖它）', () => {
    const items = [
      { name: 'a', value: [1, 2, 3] },
      { name: 'b', value: { x: 1, y: 2 } },
      { name: 'c', value: 'z' },
    ];
    const one = buildQuery(items);
    for (let i = 0; i < 10; i++) assert.equal(buildQuery(items), one);
  });
});
