# 代码审查报告 · 2026-10-28

范围：`index.html` / `js/app.js`(989) / `js/engine.js`(333) / `js/effects.js`(375) / `data/*` / `tools/*`
基线：`tests/engine.test.js` 36/36 通过，`tests/app.smoke.js` 全通过。
结论：**功能是通的，但结构耦合点比你感觉的更多，且有 1 个会直接算错的解析缺陷。**

---

## 一、你提的三个结构问题

### 1.1 「干员数据层和藏品数据层分开」——文件已经分开了，耦合不在文件

`data/relics.js` 和 `data/operators.js` 本来就是两个文件。真正的问题是**同一份知识被复制了 6 遍**，而且 UI 直接伸手进数据结构：

| 位置 | 内容 | 问题 |
| --- | --- | --- |
| `effects.js:24-68` | `PANEL_STATS` / `COMBAT_STATS` / `RUN_STATS` | 属性注册表（key + 中文别名 + label） |
| `engine.js:172` | `PANEL_KEYS` | 同一批 key 再抄一遍 |
| `app.js:252-264` | `PANEL_FIELDS` | 第三遍（带显示 label） |
| `app.js:266-278` | `RESULT_ROWS` | 第四遍 |
| `app.js:470-485` | `STAT_LABELS` | 第五遍（又是 label） |
| `tools/build_relics_official.py:31-89` | `PROF_MAP` / `SUBPROF_MAP` / `STAT_MAP` / `REWARD_MAP` | 第六遍，还跨了语言 |

后果是实测出来的：`spCost` 在 `PANEL_KEYS`、`STAT_LABELS`、`effects.js:32` 里都存在，但 `PANEL_FIELDS`、`RESULT_ROWS`、`defaultPanel()` 里没有 —— 这不是有人忘了，而是**没有单一事实来源，加一个属性必然漏掉几处**。

第二层耦合是**同一个干员有 3 种表示**：

```
OPERATOR_DATA[i]        扁平：{hp, atk, def, ..., favor}
      ↓ app.js:707 addBuiltin() 复制 + 展开
squad[i]                {panel:{...}, favor, useFavor, assignTarget}
      ↓ app.js:74 toOp() 应用信赖 + 补默认值
engine 的 op             {panel, profession, subProfession, position, summon, assignTarget}
```

其中 `toOp()`（app.js:74-86）做的是**领域逻辑**（信赖叠加、攻速兜底 100），却住在 UI 文件里。这就是你觉得"耦合"的根源：数据层没有边界，UI 顺手就做了数据层的事。

第三层是**仓库层缺失**：`app.js:7-12` 直接读 `window.RELIC_DATA.relics` / `window.OPERATOR_DATA`，并在模块加载时建 `RELIC_INDEX` / `OP_INDEX`。没有 `relicRepo` / `operatorRepo` 这一层，所以换数据源（比如以后接 PRTS 在线查询）必须改 UI。

**建议的目标形态**（不实施）：

```
core/
  schema.js       单一属性注册表：{key, label, bucket, panelSettable, format, unit}
                  PANEL_FIELDS / RESULT_ROWS / PANEL_KEYS / STAT_LABELS 全部由它派生
  enums.js        职业 / 分支 / 稀有度（由 tools 生成，python 和 js 共用一份 json）
data/
  operators.repo.js   load() / getById() / search(q) / toCalcInput(entry, opts)
  relics.repo.js      load() / getById() / stagesOf() / toCalcInput(selection)
  squads.repo.js      编队 CRUD + 12 人上限 + 序列化版本号
calc/
  core.js         纯函数：calcOperator(basePanel, mods, ctx) / calcSummary(mods, ctx)
  parse.js        effects.js 原样搬入
ui/
  *.js            只负责 DOM，禁止出现数值计算与领域默认值
```

### 1.2 编队交互——现状确实低，而且卡在一个数据依赖上

现状（`app.js:802-862`）：

- 输入框 + 下拉，**默认只列六星**（`app.js:808` `if (!q) return (o.rarity||0) >= 6`）→ 452 人里默认只看得见 145 人，剩下 307 人必须猜到关键词才能搜出来
- 结果**硬截断 12 条**（`app.js:828`），没有"加载更多"
- **没有图片**：全仓库 `assets/` 只有 `style.css`，零张图
- **没有去重**：`addBuiltin()` 可以把玛恩纳加 5 次
- **没有 12 人上限**：`state.squad` 无长度约束
- 只能按名字/职业/分支搜，**不能按星级筛、不能浏览**

关键阻塞点：**藏品数据里有 `icon` 字段**（如 `"rogue_6_relic_legacy_22"`），但 `app.js` 从头到尾没用过（grep `icon` = 0 命中）；**干员数据里连 icon 字段都没有**（`OPERATOR_DATA` 字段：id/name/profession/subProfession/position/rarity/elite/level/hp/atk/def/res/interval/cost/block/redeploy/favor）。

所以"点击图片选择/再点取消"这个交互，前提是补一轮数据抓取：

- 藏品：251 个 icon id 已有，只需下载图片（约 251 张，可拼 sprite）
- 干员：需要新增 `avatar` / `portrait` 字段，从 PRTS 或游戏资源抓 452 张

这会直接冲击现在的"双击 index.html、离线、零依赖"定位：452 张头像按每张 20-40KB 算约 9-18MB。三个可选折中：

| 方案 | 体积 | 说明 |
| --- | --- | --- |
| A. 纯文字卡片 + 职业色块 + 星级 | 0 | 保留离线单文件，交互改成网格多选，视觉靠色和排版 |
| B. 雪碧图 + CSS 裁切 | 3-6MB | 452 张压成 1-2 张 sprite，一次性加载 |
| C. 在线 URL + 本地占位 | 0 | 破坏离线定位，首屏依赖网络 |

我倾向 **B**：`icon` 字段已经在数据里了，说明这条路本来就是设计意图，只是没走完。

交互规格建议（与你说的对齐）：网格平铺 → 单击选中（卡片高亮 + 打勾角标）→ 再次单击取消 → 顶部显示 `已选 8/12` → 满 12 人后未选卡片置灰并给提示 → 支持按职业/星级/分支筛选 + 名字搜索 → 支持拖拽排序。藏品侧同理（现在是整卡点击只做"选中"，不支持取消，`app.js:169-178` 里 `if (!cb.checked)` 意味着再点一次没反应）。

### 1.3 计算层独立 / 要不要上 C++

先说结论：**`engine.js` 其实已经是干净的纯函数层了**（333 行，零 DOM 依赖，`typeof window !== 'undefined' ? window : globalThis` 双端可跑，测试也是直接在 node 里跑的）。它的问题不是"没独立"，而是**接口形状被 UI 污染**：`computeOperator(op, mods, ctx)` 里的 `op` 是 UI 组装出来的，`toOp()` 还在 app.js。

所以"抽独立计算层"的正确做法是**移动边界，不是换语言**：

```js
// 现在
computeOperator(uiOp, mods, ctx)   // uiOp 由 app.js 的 toOp 生成

// 目标：纯 JSON 进、纯 JSON 出，中间不碰任何 UI 概念
calcOperator({ base: {hp,atk,def,...}, traits: {profession,subProfession,position}, mods, ctx })
  → { base, final, delta, breakdown, inactive }
```

这个接口一旦定死，**用 C++ 还是 Rust 还是 JS 都只是实现细节**，前端不需要知道。

关于 C++（WASM）：技术上可行（emscripten），但**当前不划算**，理由三条：

1. **瓶颈不在这里**。333 行算术，一次全量计算是微秒级。真正的卡顿来自 `app.js` 每敲一个字符触发 **3 次全量 `calc()`**（`renderSquad:287` + `updateResult:398` + `renderSummary:497`），每次都重算 251 件藏品 × 全部干员，再全量重建 DOM。换 C++ 只是把 3 次微秒级计算变成 3 次微秒级计算。
2. **难移植的不是算术，是解析**。`effects.js` 375 行是中文正则 + 词表 + 条件继承状态机，这才是维护成本所在，用 C++ 重写等于把最脆弱的部分再写一遍。
3. **数据搬运成本高于计算成本**。239KB 藏品 + 174KB 干员进 WASM 需要序列化/反序列化，这部分开销会吃掉全部收益。

我的建议：**保持 JS，但把 `calc/` 做成版本化纯接口（输入输出都声明 schema 版本号）**。将来真要做移动端/命令行/服务端批量算，再把这个 300 行的纯函数换实现，接口不用动。这是成本最低、且不堵死后路的选择。

---

## 二、源代码问题清单

### P0 · 会算错 / 会丢数据

**① `detectScope` 把"敌人"一律判成敌方作用域 → 4 件藏品核心加成直接丢失**

`effects.js:118-120`：

```js
if (/所有敌方单位|所有敌人|敌方单位|敌人/.test(clause)) return { base: 'enemy' };
```

只要分句里出现"敌人"两个字，整条就被打成敌方作用域，**不管敌人是加成的承受者还是条件的一部分**。而 `engine.js:86` 的 `scopeCovers` 对 `enemy` 直接返回 `false`，于是这些加成对任何干员都不生效，也不会进 `inactive` 列表 —— 静默消失。

实测（`node` 直接跑 `parseEffect` 复现）：

| id | 名称 | 文案 | 解析结果 | 后果 |
| --- | --- | --- | --- | --- |
| 086 | 荣耀绶带 | 所有我方单位仅阻挡1名敌人时，攻击力+100% | `atk 100%` scope=**enemy** | 攻击力+100% 完全丢失 |
| 116 | "撕咬的渴望" | 我方干员击倒敌人时，攻击速度+100，持续2秒 | `aspd 100` scope=**enemy** | 攻速+100 完全丢失 |
| 163 | 残弩-神准 | 狙击干员攻击面前直线上的敌人时，攻击力提升至140% | `atk 140%` scope=**enemy** | 攻击力+40% 完全丢失 |
| 118 | 渴血钳兽 | 我方干员击倒敌人时，回复10%最大生命 | `hp 10%` scope=enemy | 双重错：作用域错 + 把"回复"当"生命上限" |
| 173 | 剿袭之手 | 敌人进入…攻击范围内时，受到一次攻击力300%的…伤害 | `atk 300%` scope=enemy | 把伤害倍率当面板攻击力（被错误作用域"意外救下"） |

风险面：**29 个阶段**走文案解析且文案含"敌人/敌方"。其中 092/093/096/097 这类"敌人受到伤害"是判对的（靠上一分句的 enemy 作用域继承），但上面 5 个是实打实算错。

**② `spCost` 悬空**（已确认，方案 A）
`engine.js:172` 声明、`app.js:473` 有 label，但 `computeOperator`(182-273) 无结算分支、`RESULT_ROWS` 无行、`defaultPanel()` 无字段 → 159 支柱-勤奋 / 167 开拓之手 两条修正项进 `acc.spCost.list`，明细显示"已生效"，表格纹丝不动，汇总区却显示"技力消耗 -40%"。

**③ 汇总区重复渲染探索类属性**
`engine.js:289` 把 `bucket === 'panel'` 和 `'run'` 都塞进同一个 `panel` 对象，`app.js:529` 又遍历整个 `s.panel` 渲染"面板加成"卡片 → `carry` / `deploy` / `hope` / `ingot` / `shield` 等**同时出现在"面板加成（按作用域）"和"探索 / 运营"两张卡片里**。实测 `summarize()` 返回的 `panel` 与 `run` 都含 `carry`。

**④ 导入 / 本地存档无校验 → 白屏**
`app.js:680-685` 直接 `state.squad = d.squad`，然后 `renderAll()` → `renderSquad:338` 读 `op.panel[f.key]`。导入一份缺 `panel` 的 JSON（或旧版本存档）会抛 `TypeError`，整个界面停在半渲染状态。`load()` 的 try/catch 只包了读，没包渲染。

### P1 · 结构与维护性

**⑤ 六张平行的属性表**（见 1.1），加属性必漏。
**⑥ 三种干员表示**（见 1.1），改字段要改三处。
**⑦ `state.custom` 是死状态**：`app.js:22/50/61/682/700` 五处引用全是读写存档，**渲染逻辑从未使用**。`addBlank()` 往 `state.squad` 里塞，不是 `custom`。可以删。
**⑧ `data/relics_wiki.js`(128KB) 是死产物**：`index.html` 未引入，`js/`、`tools/` 也无引用。每次构建都白写一份。
**⑨ `app.js:494` 行首有 UTF-8 BOM**（`EF BB BF`）。JS 里无害，但说明编辑器动过这行；若哪天落进字符串字面量就会炸。
**⑩ `STACK_PER_LAYER` 硬编码藏品 id**（`engine.js:114-119`：193/197/208/218）。数据重生成后 id 一变动就静默失效，应该改成数据里带标记。
**⑪ 枚举跨语言重复**：`tools/build_relics_official.py:31-89` 的 `PROF_MAP`/`SUBPROF_MAP` 与 `effects.js:9-21` 的 `PROFESSIONS`/`SUBPROFESSIONS` 是两份手工维护的同一份知识。

### P2 · 性能

**⑫ 每次按键 3 次全量计算**：`renderSquad:287` → `calc()`；`updateResult:398` → `calc()`；`renderSummary:497` → `calc()`。改一个面板数字 = 3 × (251 件藏品 buildModifiers + 全部干员 computeOperator + summarize)。改藏品层数同理。
**⑬ 藏品列表全量重建无防抖**：`app.js:973` 每次 `input` 都 `renderRelicList()`，`innerHTML=''` 重建最多 251 张卡片。
**⑭ 每个按键同步写 localStorage**：`save()` 在几乎每个 oninput 里调，`JSON.stringify` 整个 squad + presets。

### P3 · 当前数据未触发，但已埋雷

**⑮ `pendingCond` 跨句泄漏**：`effects.js:241,250-251`，条件一旦出现就永久保留给后续所有分句（包括 `。` 之后）。实测当前数据 0 例（因为条件都写在同一句里），但只要出现"战斗开始60秒内，攻击力+10%。所有干员生命+5%"就会误伤后半句。
**⑯ `interval` 累加但不结算**：`engine.js:206` 会把 `interval` 修正项累加进 `acc`，但 `final.interval` 只由攻速推导（261 行），`acc.interval` 永远被丢弃。当前数据 0 条，属潜在。
**⑰ `stackCap` 返回 0 被当 999**：`engine.js:130` `Math.min(sel.stack||0, cap||999)` —— 不可叠加的藏品（cap=0）在逻辑层获得 999 层上限，只靠 UI 兜。
**⑱ 攻速降为 0 时除零**：`engine.js:261` `intervalB * 100 / (100 + (final.aspd - 100))`，若 aspd 修正合计为 -100，分母为 0 → `Infinity` → 显示 `-`。当前 19 条 aspd 修正全为正，未触发。
**⑲ `detectCond` 的层数上限字段名不一致**：`effects.js:179` 产出 `{type:'capLayer', n:10}`，`engine.js:30` 却读 `cond.cap`（官方数据里确实叫 `cap`，7 处）。文案路径的层数上限只能靠 `engine.js:34` 的正则兜底。
**⑳ `effects.js:122` 与 `196-202` 是死代码**：`parseValue()` 定义后从未调用；`detectScope` 里第一次 `clause.match(...)` 的结果被下面 `if (/\[/)` 分支覆盖，白算。

---

## 三、如果只做三件事

1. **修 `detectScope`**（P0①）：把"敌人"的判定从"出现即敌方"改成"敌人是加成承受者"。最省事且稳的写法是先判断"我方/所有干员/干员"前缀，只有分句以敌人开头或以"敌方单位"开头时才判 enemy。这一条能救回 4 件藏品的核心效果。
2. **建 `core/schema.js` 单一属性表**（P1⑤）：让 `PANEL_FIELDS`/`RESULT_ROWS`/`PANEL_KEYS`/`STAT_LABELS` 全部派生。这一步做完，`spCost` 这类"改一半"的问题从机制上不会再出现。
3. **`calc()` 结果缓存 + 分层重算**（P2⑫）：`mods` 只在藏品变化时重算，干员面板只在对应干员变化时重算，DOM 只更新变化的卡片。

---

## 四、验证方式

```powershell
node tests/engine.test.js      # 36 项断言
node tests/app.smoke.js        # 界面冒烟
python tools/verify_operators.py
```

本次审查用到的临时脚本（未落盘）复现了：敌方作用域误判 5 例、汇总重复渲染、`summarize().panel` 混入 run 属性、`spCost` 无结算分支。
