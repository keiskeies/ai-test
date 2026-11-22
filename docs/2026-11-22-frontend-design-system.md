# 前端设计系统（2026-11-22 改版）

> 本条记录「为什么这样设计」与「改哪里会被门禁拦住」。视觉规范的上游仍是
> `docs/2026-11-13-ai-test-platform-design.md` §11.6 / §11.7；本轮把它从文档落到代码。

## 一、问题（改版前实测）

| 维度 | 实测 |
|---|---|
| 滚动 | 整页滚动（工作台文档高 9911px），侧栏菜单 1068px、`overflow:visible`——侧栏与页头随内容滚走，底部菜单永远在首屏之外 |
| 内滚 | 3 处 `calc(100vh - N)` 魔数（会话页 -330、画布 -104、详情 -120） |
| 主题 | 只有浅色；`tp.*` 是静态 hex，内联进组件后深色下不变 |
| 图标 | 39 个文件用 antd 图标，语义错位（工作台=人、任务中心=文档、ADB=品牌标） |
| 字号 | 292 处内联 `fontSize: 12`，无阶梯 |
| 徽标 | 35 处 antd 预设 Tag 色（#f6ffed 系）与灰绿底撞色 |
| 圆角 | 2/4/6/8/10/12 并存，无角色映射 |

## 二、三层结构

### 1. Token（`src/theme.ts` + `src/styles.css`）

- **尺寸**：`metrics`（顶栏 56 / 侧栏 208 / 折叠 56 / 页边距 24 / 页头 56 / 控件 32），
  只在 theme.ts 声明，CSS 侧 `--tp-metric-*` 同值，漂移测试对表。
- **色**：`tp`（浅色）/ `tpDark`（深色）**同形**（`tpDark: typeof tp` 编译期钉住）；
  `tokensFor(mode)` 取具体值。`tpv` 是同形的变量形态（`var(--tp-…)`），**DOM 内联一律用它**。
  约定：React style/className → `tpv.*`；ECharts / Monaco / 需要算术的颜色 → `tp.*` 或
  `tokensFor(mode)`（canvas 不认 CSS 变量）。
- **Tag 三段色**：`tp.tag.<preset>.{fg,bg,bd}`，CSS 把 `.ant-tag-<preset>` 映射过去——
  35 处 `color="green"` 调用点不用改，色相统一为「浅底 + 深字 + 同相描边」。
- **阶梯**：`tp.radius`（2/4/6/8/10/12/999）、`tp.fontSize`（11/12/13/14/16/20/24）。
- CSS 类：`.tp-text-xs/sm/md/base`、`.tp-secondary/.tp-tertiary`、`.tp-num`、`.tp-mono`、
  `.tp-card`、`.tp-tablecard`、`.tp-filterbar`。

### 2. 骨架（ProLayout，`src/layout/shell.tsx`）

> **2026-11-22 收口：壳层整体改用官方 `@ant-design/pro-components` 的 ProLayout。**
> `layout="mix" + splitMenus={false}`：全宽顶栏（logo/项目切换/搜索/主题/用户）
> + 左侧整棵菜单；菜单滚动、展开折叠、固定头部/侧栏、响应式都是框架内建能力。
> 官方底部折叠钮关闭（`collapsedButtonRender={false}`），用顶栏最左按钮。
> 侧栏/头部背景接到我们的 CSS 变量；顶栏由半透明模糊钉回实色容器底。
> 页头改用 ProComponents `PageHeader`（保留 `.tp-page-head` / `.tp-page-title` 契约）。

### 2.1 旧骨架说明（保留作背景）

```
.tp-app (100dvh)
├─ .tp-topbar 56        固定：logo / 项目切换 / 搜索(⌘K) / 主题 / 用户
└─ .tp-shell (flex:1, min-height:0)
   ├─ .tp-sidebar 208|56  内部滚动；底部折叠钮
   └─ .tp-main-content   唯一滚动容器（内边距 24、max-width 1600 居中）
```

- **滚动权只给两处**：侧栏自己滚、内容区自己滚；页面本身不滚。
- **页头 `PageHead` 吸顶**（面包屑 / 标题 / 描述 / 动作），`.tp-page-head` 与 `.tp-page-title`
  类名保留（e2e 与单测依赖）。
- **禁止新增 `calc(100vh - N)`**：撑满用 flex + 每层 `min-height:0`。

### 3. 组件收口

- `ui/PageHead.tsx`（ProComponents `PageHeader` 适配层，`layout/ProjectGate` 再导出）、
  `ui/StateView.tsx`、`ui/Toolbar.tsx`、`ui/icons.tsx`（Lucide 同名导出）、
  `shared/roleName.ts`。
- **列表统一 `ui/AdminTable.tsx`（ProTable 适配层）**：默认关搜索/内置工具栏、无内建分页、
  统一白卡与中密度；**render 签名差异在适配层收口**（ProTable 是 `(dom, record)`，
  antd 是 `(value, record)`，不转会把进度环算成 NaN、把 null 改成 "-"）。
  接口页的列设置交给 `options.setting`，偏好落 `localStorage["tp.ptable.api"]`，
  自建 `applyColumnPrefs`/列设置弹层已退场；未换的只有「后端下发字段+操作符」的高级搜索——
  那是业务协议，不是布局轮子。详情页/导入预览里的嵌套表保留 antd `Table`（compact 场景）。

## 三、深浅主题

- 偏好三态：跟随系统（默认）/ 浅色 / 深色；`localStorage["tp_theme"]`，顶栏按钮循环。
- **首帧不闪**：`index.html` 内联脚本先写 `<html data-theme>`，与
  `ui/themeMode.ts#resolveInitialMode` 同一口径（两处实现，改动需同步）。
- antd 用 `antdThemeFor(mode)` 显式全量映射（**不用 darkAlgorithm**：它会改写品牌色与层次）；
  Monaco 切 `vs / vs-dark`；ECharts 按 `tokensFor(mode)` 重算并随 mode 重绘。
- 深色对比度实测：正文 14.2:1、辅助 4.68:1、Tag ≥6.17:1（AA 通过）。

### 3.1 双主题颜色逐项适配（2026-11-22 二轮）

方法：对**每种常用底**（layout 底、卡片白/深底、选中态、Tag 浅底）解对比度，正文/辅助
文字 ≥4.5:1（大字 ≥3.0），装饰性描边 ≥1.28:1；求解脚本在 `web/.tmp/solve*.mjs`
（亮度线性化 + 沿「底 → 锚点色」连线二分）。全部改在 token 层，调用点零改动。

- **浅景 text-3**：`#8A949E → #6B7680 → #667079`。前两版在深一档的底（layout #F6F8F7、
  选中态）上掉到 4.5 以下；现值在全部浅底 4.56–5.05:1。深色 text-3 `#8C99A4` 原本已过，未动。
- **浅景分层线**：`split #DCE1E6`、`border #CDD5DB`、`borderHover #B9C2CA`——
  保证分隔线在白卡与 layout 底都可见（≥1.28）但不抢内容。
- **功能色单源化**：`func.error → #B03A33`、`func.warning → #9A6404`（在**自己的浅徽标底**
  上 ≥4.5）。`antdTheme` 里 `colorError` 曾另抄 `#C0483F`，已收回引用 `tp.func.error`——
  同一红只允许一个出处。
- **Tag 前景/描边重解**：浅景 gold/orange/volcano/red 前景加深到 `#9A6404/#9A4B00/
  #98362F/#B03A33`（原值 2.6–4.3 不过线）；两套 `tag.*.bd` 全部沿底色同色相推出
  （浅景绿 `#C5DCD4` 系、深景绿 `#1C3F33` 系），描边可见且不与前景抢层级。
- **深色 Alert**：antd 深色下仍用浅粉底 `#FFF3F0` 配近白文字（1.11:1）。Alert 读全局
  `colorErrorBg/colorErrorBorder/…` 组件 token，在 `antdThemeFor(dark)` 里用 **tag 同相位
  色板**覆盖（error→volcano、success→green、warning→gold、info→blue），不新增色值。
- **空表占位行**：antd 给 `tr.ant-table-placeholder > td` 刷 `colorTextDisabled`（=text-4，
  在表底 1.9:1），且 Table **没有**对应组件 token（`placeholderColor` 在 5.29 不存在）——
  用 CSS 规则钉回 `--tp-text-3`（见 `styles.css` 的 `.tp-tablecard …` 规则）。
- **头像环**：`.tp-avatar` 描边改用 `--tp-primary-200`（原 border 色在深底上看不见）。
- **真 bug：场景页运行状态点**：`RUN_DOT` 硬编码浅景 hex（`#D3564F/#1D7257/#8B8E94`），
  深色底上近乎隐形 → 改 `tpv.func.*`，顺手把手抄棘轮 39 → 34。

## 四、图标与密度

- 图标：`@ant-design/icons` → `ui/icons`（Lucide，默认 1em / stroke 1.75），调用点名不变。
- 表格：主列表 `size="middle"`（行 48 / 表头 40），外层 `className="tp-tablecard"`
  （白卡 + 细边 + 8 圆角），嵌套/预览表保留 `small`。
- 页头 desc：一页一句话说明数据口径（如运行记录「四类触发方式的执行存档」）。

## 五、验证

```bash
cd web
pnpm exec tsc -b
pnpm exec eslint src
pnpm exec vitest run                 # 1858 用例全绿
pnpm exec vite build --mode e2e
npx vite preview --port 5173         # 另起后端后：
node scripts/visual-snapshot.mjs http://localhost:5173 .tmp/snap   # 14 页 × 2 主题截图 + 布局读数
node scripts/dark-audit.mjs http://localhost:5173                 # 深色亮底巡检，0 处即通过
```

契约测试：`theme.drift.test.ts`（CSS var ↔ theme.ts，浅/深两块 + 呼吸光环分量）、
`theme.tokens.test.ts`（手抄棘轮，102 → 39 → 34）、`emoji.redline.test.ts`
（注释剥离已修 CRLF 盲区）、`ui/themeMode.test.tsx`（跟随系统 / 显式覆盖 / 首帧落盘）。

颜色专项巡检：`node .tmp/coloraudit.mjs`（14 页 × 浅/深两主题，逐元素读 computed
color/background/border 算对比度，28 组全过）——阈值即 §3.1 的那两条线。

## 六、列表页布局的三个坑（2026-11-22 截图复核后修）

1. **右列整块换行**：`<Col flex="auto">` 的 flex-basis 是 auto = 表格内容的 max-content；
   208px 树列 + 宽表 > 行宽时，antd `Row` 的 `flex-wrap: wrap` 把右列折到下一行、横跨全宽
   （表现为：工具栏占满屏宽、树卡片浮在上方孤零零）。修法：`flex="1 1 0"` + `min-width:0`。
2. **树卡片被拉长**：`Row` 默认 `align-items: stretch`，左列 Card 被拉到与右列等高，一两个
   节点也占 200+px。修法：`Row align="top"`。
3. **名称列被压扁**：无横向滚动时，固定列宽之和超过列宽，antd 把剩余列（名称）压到 60px，
   「查询订单」折成两行。修法：主表列宽收紧到能在 1440 右列放下（名称 200、方法 80、
   模块 100、副作用列 90–150），路径用 `ellipsis` + `title`。
   尝试过 `scroll.x` + `fixed` 左右固定列（蓝图书面做法），但 rc-table 会多渲染一行
   measure row，既有测试按「tbody 第几个 checkbox」勾选的断言全部错位——在测试契约改写
   之前先不用固定列。

工具栏一行放不下时的降级：次级动作（刷新/导入/导出）收成图标钮 + tooltip，视图选择器
150、搜索 180、环境 170；`筛选配置未取到` 仍保留可见文字（故障不许只藏在 tooltip 里）。

## 6.5 滚动条与溢出（2026-11-22 二次修复）

- **滚动条闪动**：`html { scrollbar-gutter: stable }` 预留槽位，内容高度在视口附近抖动
  （tooltip/popover 进出、ProTable 工具栏挂载）时不再出现「滚动条忽隐忽现 + 横向位移」。
- **滚动条太粗**：Windows Chrome 默认 17px。全局改为 10px 细滚动条（`scrollbar-width: thin`
  + `::-webkit-scrollbar`），thumb 用 `--tp-border`、圆角胶囊、透明轨道。注意体感宽度由
  `scrollbar-width: thin` 决定（Chrome 一旦声明它就忽略 webkit 宽度），所以不要再写 6px 死规则。
- **hover 出现超长滚动条**：两个来源——
  ① 工作台把账号下 **200 个项目卡全渲染**，页面实测 10038px（现在默认 12 个 +「显示全部」，
     实测 1568px）；
  ② 浮层贴近视口右/下缘时把文档撑宽撑高。`overflow-x: clip`（不产生滚动容器、不影响 sticky）
     + `.ant-tooltip/.ant-popover/.ant-dropdown/.ant-select-dropdown { max-width: calc(100vw - 16px) }`。
- **页头吸顶重影**：`.tp-page-head` 原来的底部渐隐会让正文透出来，改实色 `--tp-bg-layout`。

## 七、已知残余

1. 手抄 Token 棘轮基线 34：画布节点与调试面板深色代码块的少量字面量，归 D48-d 待裁色包。
2. 接口页在 1440px 且**筛选配置/已存视图两个端点同时失败**时（本次 e2e 后端就缺 filter-meta），
   两个故障入口会把工具栏挤到第二行；端点正常时为单行。
3. 场景回收站视图多出「删除人/删除时间」两列，1440 下其余列会被等比压缩（未做横向滚动）。
4. antd 的 `<Empty>` 还留在表格占位与少量下拉里（测试把 `.ant-empty-description` 当把手），
   已用全局 CSS 统一观感；后续可逐页换 `StateView`。
5. 本轮未跑 Playwright e2e（需要完整后端与夹具）；已用 build + preview + 双主题截图与
   `dark-audit` 覆盖视觉面，交互契约由 1858 条单测兜底。
