/**
 * LocatorSpec 的单条规则 → 一个可在浏览器里执行的查询。**纯函数**，单独成文件
 * 就是为了能脱离浏览器测它。
 *
 * 为什么这一层必须是纯的：定位阶梯是本模块**唯一一处"错了不会报错、只会认错元素"**
 * 的地方。translate 把 `role+name` 翻成一条 XPath 时，翻错的形态是
 * "在真浏览器上稳稳命中另一个元素，然后用例绿"（docs/00 §8：陈旧命中比 miss 更危险）。
 * 纯函数才能把"各种 by 各给一个 fixture、断言翻出来的查询长什么样"写成测试；
 * 混进连接代码里就只能靠真浏览器端到端跑，而端到端跑绿恰恰证明不了"命中的是哪个"。
 *
 * 四条纪律：
 *  1. **值一律转义后再拼**。CSS 走 `"…"` + `\` 转义；XPath 走 xpathStr。
 *     不转义就没有注入：值里一个 `'` 配上 `or 1=1` 就改写了查询本身，
 *     于是"命中的元素"不再由定位器决定。**注意这防的是改写查询，不是防 JS**
 *     —— JS 注入面由求值方式关掉（见下第 4 条），不靠字符串检查。
 *  2. **不认识的 by 抛 UnsupportedLocator，不退回 css**。退回 css 会让
 *     "这个平台不支持该定位法"伪装成"元素找不到"，而这两种归因在 triage 里是不同队列。
 *  3. **nth 明确不实现**（原因写在 translate 里，是 XPath 索引语义的坑，不是工作量）。
 *  4. **没有 JS 注入面**：用户手写 xpath / css 都通过 `Runtime.callFunctionOn` 的
 *     **arguments** 传进被测页，页面里执行的是本模块写死的那几句
 *     （`document.querySelector(参数)` / `document.evaluate(参数, …)`），
 *     用户内容从头到尾只是数据，不进表达式。
 */
import type { LocatorRule } from '@atest/ir';

export type LocatableBy = 'testid' | 'role+name' | 'label' | 'placeholder' | 'text' | 'textContains' | 'css' | 'xpath';

/** 不在这张表里的 by 一律 UnsupportedLocator —— 见文件头第 2 条 */
export const WEB_LOCATOR_BY: readonly LocatableBy[] = ['testid', 'role+name', 'label', 'placeholder', 'text', 'textContains', 'css', 'xpath'];

/** 阶梯级别（engine 的 StepResult.rung，1..9，越小越便宜可信；docs/06 §2 那张表） */
const RUNG: Record<LocatableBy, number> = {
  testid: 1, 'role+name': 2, label: 3, placeholder: 4, text: 5, textContains: 6, css: 7, xpath: 8,
};
/**
 * 各级别的置信度。**它是 confidenceGate 判据的输入**（engine 那边
 * `confidence < gate => healed`），所以调它等于改"哪些定位法算未毕业"，
 * 不是改一个展示用的装饰值 —— 下面那张表与它必须同源，有测试钉住。
 */
const CONF: Record<LocatableBy, number> = {
  testid: 1, 'role+name': 0.95, label: 0.9, placeholder: 0.88, text: 0.85, textContains: 0.8, css: 0.75, xpath: 0.7,
};

/**
 * 各级别在**默认门限 0.85** 下算不算毕业。导出来是给测试自校验用：
 * 有人调 CONF 却忘了想"css 从此算毕业了"，那条测试会红 —— 它**已经抓到过一次**：
 * 我第一版把 textContains（0.8）标成毕业，表与判据当场对不上。
 *
 * 边界：engine 用的是 `confidence < gate`，所以**恰好等于 0.85 算毕业**，
 * `text` 正落在这条线上（单独有测试钉住）。
 * 不毕业的三种：`textContains` 是模糊匹配，会命中提示语而不是控件，且 i18n 下一律漂
 * （docs/06 §5）；`css` / `xpath` 是手写选择器，会"当场通过然后腐烂"（docs/06 §2）——
 * 让它们每次靠这条路过都被**看见一次**，正是"未毕业"这个状态的存在意义。
 */
export const LADDER_GRADUATABLE: Readonly<Record<string, boolean>> = {
  testid: true, 'role+name': true, label: true, placeholder: true, text: true, textContains: false, css: false, xpath: false,
};

/** 认不得的 by（别的端的、或需要模型参与的）。调用方据此报"这个定位法 Web 端不支持" */
export class UnsupportedLocator extends Error {
  constructor(readonly by: string, hint: string) {
    super(`Web 端不支持定位法 "${by}"：${hint}。Web 端支持：${WEB_LOCATOR_BY.join(' / ')}`);
    this.name = 'UnsupportedLocator';
  }
}

/** 规则本身写不全（比如 role+name 缺 name）。与"不支持"分开：那是 IR 该拦的 */
export class BadLocator extends Error {
  constructor(message: string) { super(message); this.name = 'BadLocator'; }
}

export type Located =
  | { strategy: 'css'; selector: string }
  | { strategy: 'xpath'; selector: string };

/** 属性选择器形式的数据属性名。只允许 CSS 标识符字符 —— 它是拼进选择器的 */
const TESTID_ATTR_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** 角色名同理（值另过 xpathStr；这里只是把词法收窄，别让拼错的角色名一路跑到浏览器） */
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * XPath 里的字符串字面量。
 * XPath 1.0 **没有转义机制**，含 `'` 的值只能拆成 `concat('a',"'",'b')` ——
 * 这就是这函数看着绕的唯一理由。
 */
export function xpathStr(v: string): string {
  if (!v.includes("'")) return `'${v}'`;
  return `concat(${v.split("'").map((p) => `'${p}'`).join(`,"'",`)})`;
}

/** CSS 属性值：包双引号，`\` 与 `"` 转义。同 xpathStr，防改写选择器而非防 JS */
export function cssAttrValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 属性等值形式的定位器（testid / placeholder） */
function attrSelector(attr: string, value: string): Located {
  return { strategy: 'css', selector: `[${attr}=${cssAttrValue(value)}]` };
}

/**
 * 单条规则 → 一个查询。
 * @param testidAttr 数据属性名（docs/06 §2："能推动被测前端加 testid，定位成本降一个数量级"）
 */
export function translate(rule: LocatorRule, testidAttr = 'data-testid'): Located {
  const v = rule.value;
  switch (rule.by) {
    case 'testid': {
      if (!v) throw new BadLocator('testid 定位器需要 value');
      if (!TESTID_ATTR_RE.test(testidAttr)) throw new BadLocator(`testid 属性名 "${testidAttr}" 不是合法的 CSS 标识符`);
      return attrSelector(testidAttr, v);
    }
    case 'placeholder': {
      if (!v) throw new BadLocator('placeholder 定位器需要 value');
      return attrSelector('placeholder', v);
    }
    case 'css': {
      if (!v) throw new BadLocator('css 定位器需要 value');
      return { strategy: 'css', selector: v };
    }
    case 'xpath': {
      if (!v || !v.trim()) throw new BadLocator('xpath 定位器的 value 不能为空');
      return { strategy: 'xpath', selector: v };
    }
    case 'text':
    case 'textContains': {
      if (!v) throw new BadLocator(`${rule.by} 定位器需要 value`);
      const pred = rule.by === 'text' ? `normalize-space()=${xpathStr(v)}` : `contains(normalize-space(),${xpathStr(v)})`;
      /*
       * 只找**文本叶子**。这条谓词我写反过一次，是真浏览器测出来的：
       * 第一版写的是 `[not(normalize-space(text())!='')]`，读作"直接文本为空"，
       * 于是 `<button>提交订单</button>` **0 命中**（它有自己的文本节点），
       * 而 `<body>` 这类"只有元素子节点"的容器反而命中 —— 与想要的正好相反。
       * 症状是 text 定位法一个都命中不了，然后阶梯安静降级到手写 css。
       *
       * 正确形态是"没有任何带文本的后代"：`<button>提交</button>` 命中，
       * `<div><span>提交</span></div>` 里的 div 不命中（否则会同时命中祖先与叶子，
       * 变成多命中 => 严格模式下全部拒掉）。
       */
      return { strategy: 'xpath', selector: `//*[${pred}][not(.//*[normalize-space()!=''])]` };
    }
    case 'role+name': {
      const role = rule.role;
      if (!role) throw new BadLocator('role+name 定位器需要 role（Web 端按 ARIA role 属性匹配）');
      if (!ROLE_RE.test(role)) throw new BadLocator(`ARIA 角色名 "${role}" 不合法`);
      if (!rule.name) throw new BadLocator('role+name 定位器需要 name（可访问名）');
      /*
       * 只按**显式** `role` 属性 + `aria-label` 筛。为什么不在这里算可访问名：
       * 计算顺序（aria-labelledby > aria-label > <label for> > alt > 文本）只有浏览器会算，
       * 而 XPath 里没有这个函数 —— 硬翻会翻出一个"看着像其实不等价"的近似式。
       * 所以本模块只出**便宜的初筛**，真正的 role/name 判定交给
       * ui.ts 的 AX 树（Accessibility.getFullAXTree 的 role/name 是浏览器算的，
       * 有测试钉住中文 name）。初筛为空时阶梯自然降级，不是静默通过。
       */
      return { strategy: 'xpath', selector: `//*[@role=${xpathStr(role)}][${namePredicate(rule.name, rule.nameMatch ?? 'exact')}]` };
    }
    case 'label': {
      if (!v) throw new BadLocator('label 定位器需要 value');
      const nm = xpathStr(v);
      /*
       * 四条路都留着，因为**真实前端四种都在用**：`<label for>`、`<label>` 包住控件
       * （HTML 规范认可的隐式关联）、`aria-label`、`aria-labelledby` 指向别的节点。
       * 只做 for + 包裹的话，用 aria-label 的组件库里 label 定位**一个都命中不了**，
       * 而阶梯会安静降级到 css —— 那就不叫"label 定位可用"了。
       *
       * 第 1 条用的是 `@id = //label[…]/@for` 这种**节点集比较**：
       * XPath 1.0 的 `id()` 只接受字面量 ID，不接受节点集，没法"先取 for 的值再查元素"；
       * 而比较运算里一侧是节点集时是**存在性**语义（集合中任一节点的 string-value 相等即真），
       * 正好等价。⚠ 这条是我照规范写的，**由 test/ui-locator.test.ts 的真浏览器夹具钉住**：
       * 规范读错在这里的表现不是报错，而是"label 定位永远 miss 然后安静降级"，
       * 所以别只信这段注释。
       *
       * 第 2 条限定在 input/textarea/select/button：不限定则 label 包住一整块表单时
       * 会命中第一个子控件 —— 又是"命中了，但命中的不是那个"。
       */
      const byLabel = `label[normalize-space()=${nm}]`;
      return {
        strategy: 'xpath',
        selector: `//*[@id=//${byLabel}/@for]`
          + ` | //${byLabel}//*[self::input or self::textarea or self::select or self::button]`
          + ` | //*[@aria-label][${namePredicate(v, 'exact')}]`
          + ` | //*[@aria-labelledby][${labelledByText(v)}]`,
      };
    }
    case 'nth':
      /*
       * **不实现 nth，而且宁可抛错也不给一个"看起来能用"的实现。**
       * XPath 的索引语义有两个坑：
       *  - `//div/c[1]` 与 `(//div/c)[1]` 结果不同（前者每个 div 各取第一个，
       *    后者对整体取第一个），而 IR 里 nth 的意图是后者；
       *  - 索引从 1 开始，写成 `[0]` **不报错** —— 它在节点集上合法地命中"无"或
       *    另一个节点。于是 index 差一不会 miss，而是**点到隔壁行**。
       * 修它需要括号包裹 + index+1，但 docs/06 §2 还要 nth 带
       * "唯一性校验 + 打分差值"（每行都 0.97 分时静默选错），那属于定位器编译层
       * （docs/02 §6）。在 adapter 里凑一个半对版本，症状恰好是本项目最怕的那一种。
       * 现在阶梯停在 nth 并点名原因：可见地失败。
       */
      throw new UnsupportedLocator('nth', '需要括号包裹 + 唯一性校验 + 打分差值，属于定位器编译层（docs/06 §2），未实现');
    default:
      throw new UnsupportedLocator(String(rule.by),
        rule.by === 'compiled-selector' ? '编译产物需先由定位器编译器落成具体规则（docs/02 §6）'
          : rule.by === 'anchor' ? '锚点定位需要相邻元素求解，未实现'
            : rule.by === 'template' ? '像素模板定位未实现'
              : '属于其他端或不支持的策略');
  }
}

/** aria-labelledby 指着的元素里有目标文本（只支持同文档 id 引用；跨文档引用不支持） */
function labelledByText(v: string): string {
  return `contains(concat(' ',normalize-space(@aria-labelledby),' '),concat(' ',${xpathStr(v)},' '))`;
}

/**
 * nameMatch → XPath 谓词（作用在 `@aria-label` 上）。
 * **regex 不走 XPath**（XPath 1.0 没有正则），返回 `true()` 让 JS 侧按 RegExp 过滤 ——
 * 那里是宿主侧构造 RegExp，不参与页面 JS 的解析，与"把用户字符串拼进表达式"是两回事。
 */
function namePredicate(name: string, by: NonNullable<LocatorRule['nameMatch']>): string {
  const nm = xpathStr(name);
  switch (by) {
    // normalize-space 是为了让 `name: "保存"` 命中 `aria-label=" 保存 "`：
    // HTML 属性值里的多余空白是人手写的常态，按字面相等判会 miss
    case 'exact': return `normalize-space(@aria-label)=${nm}`;
    case 'contains': return `contains(@aria-label,${nm})`;
    case 'starts': return `starts-with(@aria-label,${nm})`;
    case 'ends': return `substring(@aria-label,string-length(@aria-label)-string-length(${nm})+1)=${nm}`;
    case 'regex': return 'true()';
  }
}

/**
 * 阶梯序列：primary + fallbacks（docs/02 §6 的"便宜 → 贵"）。
 * **不去重**：重复出现说明作者确实写了两遍，而去重会让"阶梯第几级命中"这个 rung
 * 与 IR 里的位置对不上 —— rung 是 flaky 看板的一列，对不上就等于那一列在骗人。
 */
export function ladder(primary: LocatorRule | undefined, fallbacks: LocatorRule[]): LocatorRule[] {
  return primary ? [primary, ...fallbacks] : [...fallbacks];
}

export function rungOf(by: string): number {
  return RUNG[by as LocatableBy] ?? 9;
}
export function confidenceOf(by: string): number {
  return CONF[by as LocatableBy] ?? 0.5;
}
