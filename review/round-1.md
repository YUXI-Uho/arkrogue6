# 第 1 轮审查

## 总分 7.4 / 10

| 维度 | 分数 | 一句话理由 |
| --- | --- | --- |
| 正确性 | 6.5 | 五个 P0 里四个真修好了，但修 086 时把条件句「仅阻挡1名敌人」当成了「阻挡数+1」，给所有干员白送 1 阻挡；196 的层数在界面上根本无法设置 |
| 结构分层 | 8.0 | schema / enums / repos / calc / ui 五层是真的落地了，不是摆设；扣分点是 UI 仍在读 `relic.flags` / `stackCap` 判断该不该画控件 |
| 耦合度 | 8.0 | 依赖严格单向（schema→data→effects/engine→repos→app），app.js 只在 `init()` 摸了一次全局数据；扣分点是 engine 仍靠 id 硬编码表做业务判断 |
| 兼容性 | 8.0 | `file://` 干净（无 fetch / 无 ES module / 无动态 import），66 项引擎断言 + 冒烟全过，旧存档能降级读；扣分点是改名去重会让存档在重载时静默丢人 |
| 便利性 | 7.0 | 452 人网格 + 三重筛选 + 点击切换是真提升；但选完一个人网格滚回顶部、空白干员只能加一个、196 类藏品设不了层数 |
| 可维护性 | 8.0 | 加属性 = 改 `core/schema.js` 一行；加藏品 = 只动数据。残留两处 id 硬编码与一张兜底平行表 |
| 测试 | 7.5 | 断言是真断言（数值、作用域、`unapplied` 都验到了），不是"跑通即过"；但没有任何一条覆盖 UI 路径（层数输入、改名判重、086 的副作用） |

---

## 已验证通过的项

以下每一条我都**自己跑过**才写进来，不是抄自述。

1. **`tests/engine.test.js` 66 项 / 0 失败，`tests/app.smoke.js` 全通过**（两条命令原样执行，exit code 0）。
2. **P0① 086 攻击力真的回来了**：`086` 解析为 `atk 100% scope={base:friendly,all:true} cond=blockOnly(1)`，先锋 500 → **final.atk 1000**。
3. **P0① 116 / 163 真的回来了**：116 → `aspd +100`、scope friendly（狙击 100→200）；163 → `atk mult 140%`、scope `professions:['狙击']`，狙击 600 → **840**。
4. **P0① 118 / 173 不再产生假修正项**：两者 `parseRelic().mods` 里都没有 `hp` / `atk`，且都进了 `unmatched`（界面可见），不是静默丢弃。
5. **敌方作用域没有误伤**：092/093/096/097 仍为 `scope=enemy`（靠上句继承），098/099 仍以「所有敌方单位」开头判敌方。全库扫描「文案含敌人/敌方但判成我方且是 panel 属性」只有 3 条：086 的 block（下面列的新 bug）与 168 的 redeploy/cost（168 本来就是给我方无畏者的，正确）。
6. **P0② spCost**：159 支柱-勤奋 → `unapplied=[{stat:'spCost',value:-40}]`，`acc` 里**没有** `spCost` 键（`emptyAcc` 只初始化 `SETTLED_KEYS`），`final.cost` 不变。
7. **P0③ summarize 拆分**：选 001/006/143/159 → `panel` 只有 hp/atk/def，`run` 只有 carry，`panel∩run = []`。UI 侧「面板加成」与「探索 / 运营」两张卡不再重复。
8. **P1⑤ 属性表单一来源**：`app.js` 只剩 `S.PANEL_FIELDS` / `S.RESULT_ROWS` 两行派生，`effects.js` 的 `PANEL_STATS/COMBAT_STATS/RUN_STATS` 由 `statsOfBucket()` 现算，`engine.js:203` 直接指 `S.PANEL_KEYS`。grep 全库无第二份字面量表（仅 `squads.repo.js:60` 一处兜底，见下）。
9. **P1⑥ 仓储层是真被用的**：`app.js` 里 20 处 `OP.` / `Relics.` / `Squad.` 调用；直接读全局数据的只有 `app.js:20-21` 的 `init()`，符合"只在入口注入数据"的边界。
10. **P3⑮ pendingCond 跨句**：`parseEffect('战斗开始60秒内，攻击力+10%。所有干员防御力+5%')` → 第 2 条 `cond=null`，不继承 `early`；同句仍继承。
11. **P3⑲ / P3⑰ / P3⑱**：`detectCond('最多叠加10层')` 同时给 `cap` 与 `n`；`maxStackOf` 对 cap=0 且无 stack 标记返回 1（159 设 5 层被夹到 1）；攻速分母 ≤0 时 `final.interval=0` 而不是 Infinity。
12. **P3⑳ 死代码**：`parseValue` 全库 0 命中；`detectScope` 里原先被覆盖的「X干员」捕获已复活并被使用（163 就靠它）。
13. **P1⑦ / P1⑨ / 清空**：`state.custom` 全库 0 命中；8 个 JS 文件首字节均为 `2f 2a 20`（`/* `），无 BOM；「清空」同时清 relics/squad/presets/ctx 并显式失效三个缓存键。
14. **B③ 网格**：452 人平铺、点击加入 / 再点移除、`已选 n/12`、满员后未选卡 `locked` 置灰并 toast、职业 / 星级（`4-` 语义正确）/ 名字筛选、`avatar` 字段已预留（有则 `<img>`，无则职业色块）。
15. **B④ 藏品二次点击取消**：整卡点击可切换，点名称链接只弹详情不切换（`isInteractive` 生效）。
16. **B⑦ 坏数据不崩**：缺 `panel` 的干员、未知藏品 id、坏预设都会被丢弃并计数，冒烟测试里启动即带坏存档也不抛异常。
17. **B⑨ 缓存失效真的对**（我专门验了四种路径）：
    - 改阶段 006 0→3：攻击 592 → 615（+7% 生效）；
    - 改层数 193 0→10：攻击 615 → 902（+50% 生效）；
    - 改层数后再改战斗时间（触发全量重算）：仍是 902，**没有被旧缓存覆盖**；
    - 改干员面板 515→800：立刻 1350，再改 ctx 全量重算仍是 1350。
    原因：`squadKey()` 把 `toCalcInput()` 的整块 panel 序列化进 key，`selectionKey()` 带 `stage:stack`。
18. **字段映射没搞错**：452 名干员逐个比对 `block/res/interval/cost/redeploy`，`toCalcInput` 与原数据**零处不一致**（`block` 没写成 `blocks`）。
19. **`unapplied` 两处都渲染且不重复**：干员卡明细里是「未计入面板（无法量化到数值）」一组，汇总区是独立的「未计入面板（数值不可结算）」卡片，同一屏内没有重复项。

---

## 未修好 / 修错的问题

| 严重度 | 问题 | 位置 | 证据（复现方式或输出） |
| --- | --- | --- | --- |
| **P0** | **修 086 时把条件句当成了加成**：`所有我方单位仅阻挡1名敌人时` 这一分句同时产出了 `block +1`，于是勾选 086 后**每名干员阻挡数 +1**。攻击 +100% 是对的，但面板被污染，而且语义上「阻挡 1 名」的干员现在被算成阻挡 2 名 | `js/effects.js:185-212`（`matchStatGroup`：`阻挡` 命中别名后，后面紧跟的 `1名敌人` 被当成数值）；结算在 `js/engine.js:288` | `parseRelic('086').mods` = `[block 1, atk 100%]`；UI 实测（空白干员 base block 0）选 086 后 `阻挡数 0 → 1 / +1`；引擎实测先锋 base 1 → final 2。这是本轮**新引入**的错误，旧代码因为整条被判 enemy 反而"意外"挡住了它 |
| **P1** | **196《拳经三问》的层数在界面上根本设不了**（108 传芳雕版、152 断杖-波纹 同病）：外层判断只认「有分层」或「有 stack 标记」，忽略了 `cap > 0`，控制条整块不渲染；196 的修正项是 `cond: perStack`，层数恒为 0 → **永远不生效** | `js/app.js:380`（外层 `if (labels.length \|\| (flags含stack && sel))`）与 `js/app.js:396`（内层才判 `cap > 0`），两层条件不一致 | `stackCap(196)=40`、`flags=[]`、`tiers=0` → 选中后 `relic-controls` 数量 = 0、层数输入数量 = 0；`computeOperator(stack:0)` 攻击 100→100。全库共 3 件（108/152/196）。`engine.test.js:127-130` 用 `stack:10` 直接调引擎所以测不出来 |
| **P1** | **改名可以绕过按名去重，重载时静默丢人**：名字输入框直接写 `op.name` 不校验；存档落盘后 `deserialize` 按 name 去重、保留先出现的，后一个被丢掉 | `js/app.js:443`（`nameIn.oninput` 只 `save()`）；`core/repos/squads.repo.js:129`（`if (seen[e.name]) { dropped++; return; }`） | 编队 [推进之王, 能天使] → 把第一个改名成「能天使」→ 存档 `['能天使','能天使']` → `SquadRepo.deserialize(saved)` → `ok:true, 人数 1, 丢弃 1`。用户只会看到一句"已忽略 1 条损坏的编队数据"，那条干员的所有面板改动都没了 |
| **P1** | **自述不实：P1⑩ `STACK_PER_LAYER` 硬编码没有修**。只是把数组改名成 `STACK_PER_LAYER_RULES` 并加了一段"id 一变就失配"的注释，本质仍是 193/197/208/218 四个 id 硬编码在引擎里 | `js/engine.js:138-150` | 读代码即可：`STACK_PER_LAYER_RULES` 仍是 `{id:'193'...}` 形式，没有任何数据侧标记（如 `relic.flags.push('perLayer')`）。数据重生成后依旧静默失效，与 AUDIT P1⑩ 的要求（"应该改成数据里带标记"）不符 |
| **P2** | **116 从"静默丢失"变成"无条件常驻"**：`我方干员击倒敌人时，攻击速度+100，持续2秒` 没有识别出任何条件（`cond=null`），于是 +100 攻速变成永久生效。面板计算器上这是明显高估 | `js/effects.js:141-170`（`detectCond` 无「击倒敌人时」这一支） | `parseRelic('116').mods[0].cond === null`；狙击 aspd 100 → 200，且 `inactive` 为空。同类还有 163（"攻击面前直线上的敌人时"也无条件），但 163 的加成是常态数值，影响小 |
| **P2** | **空白干员只能加一个**：`addBlank()` 复用 `Squad.add`，名字恒为「新干员」→ 第二次被按名判重拒绝。旧版可以加多个空白干员 | `js/app.js:880-884` + `core/repos/squads.repo.js:36-40` | 连点两次「空白干员」：卡片数 1 → 1，toast「「新干员」已经在编队里了」 |
| **P2** | **网格每次点选都滚回顶部**：`renderPicker` 先 `grid.innerHTML=''` 再重建，没有像藏品列表那样保存 `scrollTop` | `js/app.js:809`（对比 `js/app.js:316`/`415` 的 `keepScroll`） | `#opGrid` 是 `max-height:340px; overflow-y:auto`（`assets/style.css:354-360`），452 张卡片必然要滚动；点一个人 → `afterSquadChange` → `renderPicker` → 滚动位置归零。选 6 人就要重新滚 6 次 |
| **P3** | `defaultPanel()` 的 `if (p.block == null) p.block = 1` 是死代码：`PANEL_FIELDS` 已先把 `block` 置 0，`null` 判断永不成立 | `core/repos/operators.repo.js:85-91` | 空白干员面板 `block = 0`（UI 实测阻挡数基础值 0），注释声称的"兜底 1"没有发生 |
| **P3** | `squads.repo.js` 里又抄了一份 12 个 key 的 `PANEL_KEYS` 兜底数组，正是本轮要消灭的那种"平行表" | `core/repos/squads.repo.js:60-61` | `var PANEL_KEYS = (S && S.PANEL_KEYS) \|\| ['hp','atk',...]`。schema 永远先加载，兜底永不触发，但下次有人加属性时这张表会被误当成来源 |
| **P3** | `core/enums.js` 头部声称"Python 侧通过 `tools/check_enums.py` 校验"，该文件不存在 | `core/enums.js:14` | `ls tools/` → 只有 build_operators / build_relics_official / fetch_roguelike / parse_relics / verify_operators |
| **P3** | 汇总「未计入面板」卡片每条塞两个 `<li>`（值 + 原因），DOM 结构上原因行和条目平级，读起来像多了一条数据 | `js/app.js:724-731` | 渲染结果文本：`支柱-勤奋 → 技力消耗 -40% 该属性无法落到干员面板（数据表无对应字段）` |

---

## 新引入的问题

1. **086 的 `block +1`**（见上表 P0）——本轮唯一一处"算错数"，而且是修 P0① 的直接副作用：作用域一旦从 enemy 放开，条件句里的伪修正项就落到了面板上。这类风险不止 086：`matchStatGroup` 对**任何**含"属性名+数字"的条件句都会产出修正项，目前全库只有 1 例，属于运气好。
2. **按名去重带来的两个退化**：空白干员只能一个（P2）+ 改名绕过导致重载丢人（P1）。去重规则放在 `add()` 里是对的，但改名这条入口没有走同一套校验，等于给"判重"开了后门。
3. **网格滚动位置丢失**（P2）——藏品列表特意做了 `keepScroll`，网格没有，属于同一份代码里两套标准。

不是问题、但值得记一笔的：`toCalcInput` 会把 `spCost: 0` 塞进 panel（`PANEL_KEYS` 含 spCost），引擎不看它，无害；`SquadRepo.serialize()` 定义了却没人用（`saveNow` / `archiveObject` 各自手拼对象），属于新写的死 API。

---

## 做得好的地方

1. **`core/schema.js` 是真·单一事实来源**：`bucket/settles/decimals/order` 四个维度一次定义，`PANEL_FIELDS`/`RESULT_ROWS`/`SETTLED_KEYS`/`ALIAS_NAMES` 全部派生；`settles:false` 直接把"改一半"的问题从机制上堵死，spCost 这轮的修法就是它的红利。
2. **仓储层的边界是真的**：`app.js` 只在 `init()` 注入数据，`toCalcInput`（信赖叠加、攻速兜底）从 UI 搬进了 repo，`deserialize` 是唯一的脏数据入口并且真的不抛异常。
3. **测试是"验对"不是"跑通"**：66 条断言里有 `final.atk === 1000`、`scope.professions[0] === '狙击'`、`panel 里不含 run 属性`、`acc.spCost 不存在` 这类硬断言，能挡住回退。

---

## 下一轮建议优先修的三件事

1. **堵住"条件句被当成加成"这一类解析漏洞**（P0）：在 `parseEffect` 里对已经匹配到 `detectCond` 的分句做一次"数值 == 条件阈值则跳过"的守卫，先救 086 的 `block +1`；顺手给 `engine.test.js` 补一条"选 086 后 `final.block` 不变"的断言。
2. **把"判重"收敛成一条规则**（P1）：改名校验走 `SquadRepo`（或改成按 id 去重、允许同名），`addBlank` 生成递增名字；保证"界面上能编出来的状态，存档再读回来一定不丢人"。
3. **恢复 108/152/196 的层数控件 + 网格保滚动**（P1/P2）：`app.js:380` 的外层判断改成 `labels.length || hasFlag || cap > 0`，`renderPicker` 照抄 `renderRelicList` 的 `keepScroll`。这两处都是"已写好的能力差一行条件没接上"，性价比最高。

（另外：如果时间允许，把 116 的"击倒敌人时"做成 `ctx` 开关，别让 +100 攻速默认常驻。）
