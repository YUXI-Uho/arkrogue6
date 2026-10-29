# 结构分析（2026-10-28）

分析对象：`E:\User\dp_harness\明日方舟tools`（纯前端离线计算器 + Python 数据管线）。
方法：按文件读依赖与导出，统计交叉引用，核对分层方向、契约字段与测试边界。

---

## 0. 结论速览

**分层是真的分了**：数据 / 计算 / 界面三层单向依赖，属性表已收敛到 `core/schema.js` 一处，
`check_enums.py` 会拦住「数据里出现未注册属性」这类漂移。

**剩下的风险不在「文件没分开」，而在三处隐式契约**：

1. `ctx`（战斗状态）有 15 个键，散在 app / effects / 存档 / 测试四处，没有任何注册表；
2. 一个「修正项 mod」对象上混着数据层字段与引擎运行时字段（两层语义压在一个对象里）；
3. 构建脚本 `build_relics_official.py` 1297 行，把「规则表 + 覆盖表 + 作用域收紧 + 输出」揉在一个文件。

---

## 1. 运行时结构（约 3.5k 行）

| 文件 | 行数 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `core/schema.js` | 250 | 属性注册表：key/label/别名/bucket/可结算/小数位/顺序 | 无 |
| `core/enums.js` | 85 | 职业、分支、稀有度、分类、编队上限 12 | 无 |
| `js/effects.js` | 593 | 中文文案 → 修正项；`evalCond` 求值 18 种条件 | schema, enums |
| `js/engine.js` | 559 | `buildModifiers → computeOperator / summarize / estimateDamage` | schema, effects |
| `core/repos/*.repo.js` | 474 | 数据访问 + 业务规则（12 人上限、去重、存档校验） | schema, data |
| `js/app.js` | 1497 | 状态、两级缓存、DOM（10 个分区、约 70 个函数） | 以上全部 |
| `index.html` | 208 | 10 个 `<script>`，顺序即依赖 | — |

```
                 data/relics.js（251 件 / 290 阶段；结构化阶段合计 329 条修正项）
                 data/operators.js (452 名)
                        │ init()            │ init()
                        ▼                   ▼
   core/schema.js ──► core/repos/*.repo.js ──► js/app.js ──► DOM
   core/enums.js  ─┐        ▲                    ▲
                   │        │                    │
                   └──► js/effects.js ──► js/engine.js
                        (中文→mods)      (mods→final / summary / damage)
```

**依赖方向检查**：无环，`app → repos/engine/effects/schema`，`engine → effects → schema`，
`app` 不直接碰 `window.RELIC_DATA`（只在 `init()` 注入一次，实测各 1 处），
`engine` 不碰 DOM、不碰 localStorage。这部分是干净的。

**规模分布**：`app.js` 占运行时 43%，是唯一的「胖文件」；但它已按 10 个注释分区
（分页/存档/缓存/藏品列表/干员卡/汇总/伤害/网格/弹窗/战斗状态/预设/初始化），
函数平均约 20 行，属于可接受的长文件，不是意大利面。

---

## 2. 数据管线（约 2.1k 行 + 18MB 缓存）

```
PRTS wikitext ──parse_relics.py──► data/relics_wiki.json（分类/稀有度/描述/四段文案）
game data ─────fetch_roguelike.py─► raw/roguelike_topic_table.json（18MB）
                                        │
                          build_relics_official.py（1297 行）
                          ├─ 官方 buffs → 修正项（~100 条命名规则）
                          ├─ OVERRIDES 显式表（新典训 / 一次性 / 手指类）
                          ├─ apply_text_scope（用官方 usage 收紧作用域）
                          └─ 输出 data/relics.json + relics.js（180KB）
character_table.json ──build_operators.py──► data/operators.js（452 名，扁平结构）
                                        │
          ┌─────────────────────────────┴──────────────────────────┐
          ▼                                                        ▼
  check_enums.py（属性/枚举/结算分支三向一致）        audit_relics.py / audit_numbers.py
                                                   verify_operators.py（24 名交叉校验）
```

**设计要点（做对的地方）**：效果数值在**构建期**从官方 `buffs/blackboard` 解析，运行期只做纯函数计算；
解析不出来的才退回中文规则，并在数据里留 `src` 标记，界面能显示来源。
这让「算错」的可能性从「正则匹配错」降到了「规则表写错」，而规则表可以逐条对照文案审。

**构建期 vs 运行期的边界是清晰的**：`data/*.js` 只含数据，不含逻辑；`relics.json` 里的 `mods`
是纯声明（stat/pct/value/scope/cond），没有任何函数。

---

## 3. 真正的接口：三个契约

### 3.1 mod（修正项）

数据层（构建脚本产出，8 个字段）：

```
stat    属性 key（必须在 schema 注册）
bucket  panel | combat | run | enemy
pct     true=百分比，false=固定值
value   数值（百分比已换算成 15 = 15%）
scope   见 3.2
cond    见 3.3
src     official | text（来源标记）
mult    可选，「提升至 140%」的原始倍率标记
```

引擎在 `buildModifiers` 时又追加 9 个运行时字段：`relicId / relicName / rarity / category /
stageName / stack / label / text / relicStacks / relics`。

**这是当前最明显的结构债**：同名字段混了两层语义。`relics`（持有集合）与 `relicStacks`
挂上去是为了让跨藏品条件不依赖界面传参（209/171 需要），但它们属于「求解上下文」，
不属于「效果声明」。后果：缓存键、序列化、单测断言都会碰到内部字段。

### 3.2 scope（6 种形态，同一字段不同形状）

```
{all:true}                   全体我方
{professions:[…]}            职业
{subProfs:[…]}               分支（尖兵/轰击术师…）
{positions:[MELEE|RANGED]}   近战位/远程位
{base:'enemy'}               敌方
{summon:true}                召唤物
{assign:true}                一次性藏品指定干员
```

六种形态共用一个字段、靠「有没有这个键」区分，`scopeCovers` 里是 6 个 if。
功能上没问题，但类型上是联合类型没被表达出来，新增一种（比如「按部署顺序」）只能继续加 if。

### 3.3 cond（18 种条件）与 ctx（15 个键）

```
cond 类型：early after skillWindow skillOff hpBelow hpAbove blockOnly hasShield
           firstDeploy perResource perProfession perAlly perStack capLayer proc
           hasRelic perRelicStack all
ctx  键：  time hpPct ingots parts value allyCount skillOn hasShield firstDeploy
           proc profCounts relics relicStacks stack(逐条) block(逐条)
```

**ctx 是唯一没有注册表的东西**：默认值在 `app.defaultCtx()`，构造在 `app.buildCtx()`，
读取在 `effects.evalCond()`，存档合并在 `app.mergeCtx()`，测试里手写 `{...}`。
新增一个输入（这次加「零件估值」就是）要改 4 处，漏一处就是「填了没反应」。

---

## 4. 发现清单

### P0-1　ctx 没有注册表（15 键 × 4 处）

- 证据：`app.js` 的 `defaultCtx` / `buildCtx` / `mergeCtx`，`effects.js` 的 `evalCond`，`tests/*.js` 手写 ctx。
- 影响：新增条件/输入时静默漏接；引擎单测与界面行为可能不一致（单测传 `{}`，界面传 13 键）。
- 改法：`core/context.js` 注册表 `{key, default, label, kind:'number|bool|map', scope:'global'}`，
  `defaultCtx()` 与 `mergeCtx()` 由它派生，`buildCtx()` 只做「表单 → 注册表」的映射。
  成本约半天，风险低（有 193 条单测兜底）。

### P0-2　mod 对象两层语义压在一起

- 证据：`engine.buildModifiers` 往数据对象上追加 9 个字段；`relicStacks/relics` 是求解上下文却挂在效果上。
- 影响：缓存键膨胀（`JSON.stringify(ctx)` 含 relics 与 relicStacks）；序列化/断言容易误伤；
  数据层字段被运行时改写（目前靠 `Object.assign({}, m)` 复制规避）。
- 改法：分两层 —— `mod`（纯声明，可直接 JSON）+ `resolved = {mod, source, ctx}`，
  或者在 `buildModifiers` 返回 `{mods, ctx}`，让 engine 内部闭包持有上下文。
  成本 1 天，牵动 engine/app/测试，需整轮回归。

### P0-3　构建脚本 1297 行单体

- 证据：`build_relics_official.py` = 规则表（约 100 条 `if name == …`）+ OVERRIDES + scope 收紧 + 输出。
- 影响：加一条规则要在大函数里找位置；规则与数据转换混在一起，难以单测（目前靠产物 + 审计脚本）。
- 改法：拆 `rules/attributes.py`（char_attribute_*）、`rules/named.py`（global_buff_normal 家族）、
  `rules/layers.py`、`overrides.py`、`scope_text.py`，主文件只做「读表 → 跑规则 → 写产物」。
  成本 1 天，纯搬家 + 产物哈希对比（产物不变即安全）。

### P1-1　DOM 桩反向约束生产代码

- 证据：`tests/app.smoke.js` 的桩只实现 `getElementById`，于是 `app.js` 全部按 id 取节点，
  注释里也写明「不用 querySelectorAll」。
- 影响：动态列表只能整段重建；事件委托/局部更新写起来别扭；新人容易踩。
- 改法：桩补 `querySelector(All)`（或换 linkedom），再逐步引入局部更新。

### P1-2　列表全量重建

- 证据：`renderRelicList` 每次勾选重建 251 张卡（已有滚动位置保持）；
  `renderSquad` 每次结构变化重建 ≤12 张卡。
- 影响：低配机上连续勾选有可见卡顿；但缓存层（两级）避免了重复计算，单纯是 DOM 成本。
- 改法：先做「卡片 diff（按 data-id 复用节点）」，再考虑虚拟列表。成本 1–2 天，收益取决于设备。

### P1-3　兼容 shim 未清理

- 证据：`app.js` 顶部 `var R = window.RelicEffects;` 全文 0 次使用（死导入）；
  `effects` 仍导出 `PANEL_STATS/COMBAT_STATS/RUN_STATS`（由 schema 派生）与 `R.PROFESSIONS`；
  `engine` 仍导出 `PANEL_KEYS`。
- 影响：小，纯噪音；但会误导「还有第二份属性表」。
- 改法：标 `@deprecated` 或删；`check_enums.py` 可加一条「禁止新增平行表」的静态检查。

### P2-1　脚本顺序手写

`index.html` 10 个 `<script>`，靠注释 + 运行时 guard 报错。file:// 下不能用 ES module（CORS），
所以这是**约束下的合理选择**；可加 `boot.js` 统一校验依赖并给出更可读的报错，成本 0.5 小时。

### P2-2　缓存键是 JSON 字符串

`selectionKey + JSON.stringify(ctx) + squadKey` 拼接。ctx 里现在含 `relics/relicStacks`，
键会更长；比较是字符串全等，成本可控但会随状态膨胀。可换「版本号 + 脏标记」。

### P2-3　构建不可字节级复现校验

`raw/` 是抓取缓存，重建依赖网络与上游变更。建议给构建脚本加 `--check`：
重建到临时目录，和现有 `data/*.json` 比哈希，不一致就打印 diff 概要。

---

## 5. 建议的重构顺序

| 顺序 | 动作 | 成本 | 收益 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | `core/context.js` 注册表 | 0.5 天 | 消灭 15 键漂移，新增输入只改一处 | 低（193 单测兜底） |
| 2 | 构建脚本拆包 | 1 天 | 规则可读、可单测、可逐家族审 | 低（产物哈希不变即安全） |
| 3 | mod 两层拆分 | 1 天 | 缓存键瘦身、序列化干净、语义清晰 | 中（动 engine/app/测试） |
| 4 | 渲染 diff | 1–2 天 | 低配机手感 | 中（动 DOM 层） |
| 5 | 桩升级 + 删 shim | 0.5 天 | 解除 UI 写法限制、去噪音 | 低 |

> 如果要继续加功能（新主题、OCR 导入、DPS 模式），建议先做 1 和 3：
> 它们决定了「加一个属性/一个输入/一个条件」要改几处。

---

## 6. 不建议做的

- **C++/WASM 重写计算层**：engine 是纯函数、约 550 行，瓶颈在 DOM 重建与中文解析，
  不在算术；移植会把「规则表」这份最值钱的东西变成不可读的二进制。
- **改成 ES Module + 打包**：当前唯一收益是 import 关系显式化，代价是失去「双击 index.html 即用」，
  与交付形态冲突。若要做，先确认用户能接受 `npm run build` 或本地服务器。
- **全量虚拟列表**：251 项 + 12 卡，diff 复用足够；虚拟列表会把「卡片高度不固定」的简单问题复杂化。
