/* 计算引擎自测：node tests/engine.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
global.window = global;

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}
// 顺序与 index.html 一致：注册表 → 表结构 → 数据产物 → 查询引擎 → 解析/引擎 → 仓储
load('core/schema.js');
load('core/enums.js');
load('core/db/schema.js');
load('data/is6db.js');
load('core/db/db.js');
load('js/effects.js');
load('js/engine.js');
load('core/repos/relics.repo.js');

const S = window.ArkSchema;

window.DB.load(window.IS6_DB);
window.RelicRepo.init(window.DB);
// 仓储对外只暴露扁平结构（stages 已由 relics + relic_stages 两表拼好），测试直接吃这层
const relics = window.RelicRepo.all();
const R = window.RelicEffects;
const E = window.RelicEngine;
const index = {};
relics.forEach(r => { index[r.id] = r; });

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

console.log('=== 1. 数据完整性 ===');
eq(relics.length, 251, '藏品数量 251');
ok(relics.every(r => r.id && r.name), '每件藏品都有 id 与名称');
const ids = new Set(relics.map(r => r.id));
eq(ids.size, 251, 'id 唯一');

console.log('=== 2. 解析覆盖率 ===');
let withMods = 0, totalMods = 0, buckets = {};
const specialOnly = [];
relics.forEach(r => {
  const p = E.parseRelic(r, 0);
  if (p.mods.length) withMods++; else specialOnly.push(r);
  totalMods += p.mods.length;
  p.mods.forEach(m => { buckets[m.bucket] = (buckets[m.bucket] || 0) + 1; });
});
console.log(`  可量化藏品 ${withMods}/${relics.length}，修正项 ${totalMods} 条，分层 ${JSON.stringify(buckets)}`);
ok(withMods >= 180, '可量化藏品不少于 180 件', withMods);

console.log('=== 3. 典型藏品的解析结果 ===');
function modsOf(id, stage) {
  const r = index[id];
  return E.parseRelic(r, stage || 0).mods;
}
let m = modsOf('143');
eq(m.length, 2, '143 钝爪-屡战 → 2 条');
eq(m[0].stat, 'atk'); eq(m[0].value, 50); eq(m[0].pct, true);
eq(m[0].scope.professions[0], '先锋', '143 限定先锋');
eq(m[1].stat, 'def');

m = modsOf('006');
eq(m.length, 4, '006 皮特水果什锦 → 攻/防/血 + 携带');
eq(m.filter(x => x.stat === 'hp' && x.value === 3 && x.pct).length, 1, '006 生命 +3%');
eq(m.filter(x => x.stat === 'carry' && x.value === 3).length, 1, '006 可携带干员 +3');

m = modsOf('006', 3);
eq(m.filter(x => x.stat === 'atk')[0].value, 7, '006 混沌化 攻击 +7%');

m = modsOf('149');
eq(m.filter(x => x.stat === 'cost')[0].value, -2, '149 部署费用 -2');
eq(m.filter(x => x.stat === 'hp')[0].value, 60, '149 生命 +60%');
eq(m.filter(x => x.stat === 'hp')[0].scope.professions[0], '狙击', '149 限定狙击（作用域继承）');

m = modsOf('002');
eq(m.filter(x => x.stat === 'aspd')[0].value, 1, '002 攻速 +1');

m = modsOf('050');
eq(m.filter(x => x.stat === 'atk')[0].scope.positions[0], 'MELEE', '050 限近战位');

m = modsOf('039');
eq(m.filter(x => x.stat === 'spRecover')[0].value, 0.35, '039 技力恢复 +0.35/s');

m = modsOf('225');
eq(m.filter(x => x.stat === 'redeploy')[0].value, -50, '225 再部署 -50%');

console.log('=== 4. 结算公式 ===');
const op = {
  name: '测试员', profession: '先锋', subProfession: '尖兵', position: '近战位',
  panel: { hp: 2000, atk: 500, def: 300, res: 10, aspd: 100, block: 1, cost: 12, interval: 1.2, spRecover: 1, initSp: 0, redeploy: 70 }
};
const sel = [{ id: '143', stage: 0, stack: 0 }];   // 先锋 攻击+50% 防御+50%
let mods = E.buildModifiers(sel, index);
let res = E.computeOperator(op, mods, {});
eq(res.final.atk, 750, '攻击 500 × 1.5 = 750');
eq(res.final.def, 450, '防御 300 × 1.5 = 450');
eq(res.final.hp, 2000, '生命不变');

// 非先锋不生效
const tank = Object.assign({}, op, { profession: '重装' });
let resT = E.computeOperator(tank, mods, {});
eq(resT.final.atk, 500, '重装不受先锋藏品影响');

// 固定值 + 百分比：先加后乘
const sel2 = [{ id: '149', stage: 0, stack: 0 }];   // 狙击 费用-2 生命+60%
const sniper = Object.assign({}, op, { profession: '狙击', panel: Object.assign({}, op.panel, { hp: 1000, cost: 20 }) });
let r2 = E.computeOperator(sniper, E.buildModifiers(sel2, index), {});
eq(r2.final.hp, 1600, '生命 1000 × 1.6 = 1600');
eq(r2.final.cost, 18, '费用 20 - 2 = 18');

// 攻速 → 攻击间隔
const aspdSel = [{ id: '150', stage: 0, stack: 0 }];  // 狙击 攻速 +70
let r3 = E.computeOperator(sniper, E.buildModifiers(aspdSel, index), {});
eq(r3.final.aspd, 170, '攻速 100 + 70 = 170');
eq(r3.final.interval, 2.3 * 100 / 170 > 0 ? +(1.2 * 100 / 170).toFixed(3) : 0, '间隔 = 1.2×100/170');

console.log('=== 5. 条件判定 ===');
const sel144 = [{ id: '144', stage: 0, stack: 0 }];   // 战斗开始60秒内 先锋 攻防+100%
let c1 = E.computeOperator(op, E.buildModifiers(sel144, index), { time: 30 });
eq(c1.final.atk, 1000, 't=30s 时生效');
let c2 = E.computeOperator(op, E.buildModifiers(sel144, index), { time: 90 });
eq(c2.final.atk, 500, 't=90s 时失效');
ok(c2.inactive.length > 0, '失效项进入 inactive 列表');

// 叠加层数：196 《拳经三问》 每次技能 +5%，最多 40 层
const stackSel = [{ id: '196', stage: 0, stack: 10 }];
let c3 = E.computeOperator(op, E.buildModifiers(stackSel, index), {});
eq(c3.final.atk, 750, '叠 10 层 → +50% 攻击');

// 源石锭换算：192 金酒之杯 每 5 源石锭 攻速 +7
const ingotSel = [{ id: '192', stage: 0, stack: 0 }];
let c4 = E.computeOperator(op, E.buildModifiers(ingotSel, index), { ingots: 25 });
eq(c4.final.aspd, 135, '25 源石锭 → 5 层 × 7 = +35 攻速');

console.log('=== 6. 汇总 ===');
const sum = E.summarize(E.buildModifiers([{ id: '143' }, { id: '149' }, { id: '001' }], index), {});
ok(sum.panel.atk.pct === 50, '汇总面板攻击 +50%');
ok(Object.keys(sum.run).length > 0, '汇总里有探索资源项');

// panel 只装能落到干员面板的属性，run 属性不得混进来（否则 UI 两张卡片重复渲染）
const runKeys = ['carry', 'deploy', 'hope', 'hopeMax', 'ingot', 'shield', 'targetHp', 'targetHpMax', 'exp', 'partCap'];
ok(runKeys.every(k => !(k in sum.panel)), 'panel 里不含 run 属性', Object.keys(sum.panel).join(','));
ok(Object.keys(sum.panel).every(k => S.bucketOf(k) === 'panel' && S.settles(k)), 'panel 里的 key 都是可结算面板属性');
ok('carry' in sum.run, '001 的可携带干员进 run');
ok(Array.isArray(sum.unapplied), 'summarize 返回 unapplied 数组');

console.log('=== 7. 作用域：敌方误判回归 ===');
m = modsOf('086');
let a086 = m.filter(x => x.stat === 'atk')[0];
ok(!!a086 && a086.scope.base !== 'enemy', '086 攻击力作用域不是敌方', a086 && JSON.stringify(a086.scope));
ok(!!a086 && a086.value === 100 && a086.pct === true, '086 攻击力 +100%');
let r086 = E.computeOperator(op, E.buildModifiers([{ id: '086' }], index), {});
eq(r086.final.atk, 1000, '086 攻击力 500 → 1000（加成真的生效）');

m = modsOf('116');
let a116 = m.filter(x => x.stat === 'aspd')[0];
ok(!!a116 && a116.scope.base !== 'enemy', '116 攻速作用域不是敌方', a116 && JSON.stringify(a116.scope));
eq(a116 && a116.value, 100, '116 攻速 +100');

m = modsOf('163');
let a163 = m.filter(x => x.stat === 'atk')[0];
ok(!!a163 && a163.scope.base !== 'enemy', '163 攻击力作用域不是敌方', a163 && JSON.stringify(a163.scope));
ok(!!a163 && a163.scope.professions && a163.scope.professions[0] === '狙击', '163 限定狙击');
// 官方 atk_scale=1.4 已换算成「攻击力 +40%」，文案的「提升至140%」被按 atk% 去重掉，
// 因此这里读不到 mult —— 数值等价，且只有一条。
eq(a163 && a163.value, 40, '163 攻击力 +40%（由 atk_scale 1.4 换算）');
eq(m.filter(x => x.stat === 'atk').length, 1, '163 攻击力只有一条，不重复计入');

m = modsOf('118');
eq(m.filter(x => x.stat === 'hp').length, 0, '118 回复生命不再产出 hp 面板修正');
// 官方 blackboard 里这条是 rogue_6_char_kill_target[hp] hp_ratio=0.1，
// 以前整条落进「特殊效果」，现在量化成「击倒敌人回血 10%」。
const k118 = m.filter(x => x.stat === 'hpOnKill')[0];
ok(!!k118, '118 的「击倒敌人回复10%最大生命」被量化为 hpOnKill', JSON.stringify(m));
eq(k118 && k118.value, 10, '118 hpOnKill 10%');

m = modsOf('173');
eq(m.filter(x => x.stat === 'atk').length, 0, '173 伤害倍率不产出 atk 面板修正');
// char_ability_new 现在也会进 named_rule：法术分支与物理分支各写一条相同数值，
// 去重后应只剩「脆弱 50% + 攻击倍率 300%」各一条，不能翻倍。
const w173 = m.filter(x => x.stat === 'weak');
const s173 = m.filter(x => x.stat === 'atkScale');
eq(w173.length, 1, '173 脆弱只留一条（法术/物理分支已合并）');
eq(w173[0] && w173[0].value, 50, '173 脆弱 +50%');
eq(s173.length, 1, '173 攻击倍率只留一条');
eq(s173[0] && s173[0].value, 300, '173 攻击倍率 300%');

console.log('=== 7b. 敌方口径归一 / 减益方向 / 互斥分支 ===');
// 175 的「攻击时降低目标5点法术抗性」曾被文案补成「术师 法术抗性 +5」：
// 作用域错（我方）、符号错（+）、口径错（res 而不是 enemyRes）。
m = modsOf('175');
eq(m.filter(x => x.stat === 'res').length, 0, '175 不再产出面板 res');
const r175 = m.filter(x => x.stat === 'enemyRes')[0];
ok(!!r175 && r175.value === -5, '175 敌人法抗 -5', JSON.stringify(m));
eq(m.length, 1, '175 只有一条（文案补漏已被官方项去重）');

// 181「敌人防御力和法术抗性-40%」：res 未归一时会多出一条面板口径的「法术抗性（对敌）-40%」
m = modsOf('181');
eq(m.filter(x => x.stat === 'res').length, 0, '181 不再产出面板 res');
eq(m.filter(x => x.stat === 'enemyRes').length, 1, '181 敌人法抗只有一条');
eq(m.filter(x => x.stat === 'enemyDef').length, 1, '181 敌人防御只有一条');

// 解析器：动词在数字前 / 夹着宾语时都要取负号
const negA = R.parseEffect('攻击时降低目标5点法抗').mods[0];
ok(!!negA && negA.stat === 'enemyRes' && negA.value === -5, '「降低目标5点法抗」→ 敌人法抗 -5', JSON.stringify(negA));
const negB = R.parseEffect('敌人防御力降低40%').mods[0];
ok(!!negB && negB.stat === 'enemyDef' && negB.value === -40, '「敌人防御力降低40%」→ 敌人防御 -40%', JSON.stringify(negB));
const posC = R.parseEffect('所有我方单位攻击力+30%').mods[0];
ok(!!posC && posC.stat === 'atk' && posC.value === 30, '普通加成不受取负逻辑影响', JSON.stringify(posC));

// 134 的四种元素损伤互斥：必须带 group 分行，不能加总成「元素伤害 +530%」
const sum134 = E.summarize(E.buildModifiers([{ id: '134' }], index), {});
const e134 = sum134.combat.elemental.items;
eq(e134.length, 3, '134 三种元素损伤各一条');
ok(e134.every(x => !!x.group), '134 元素损伤带 group 标签', JSON.stringify(e134.map(x => x.group)));
eq(new Set(e134.map(x => x.group)).size, 3, '134 三个 group 互不相同（不会被求和）');

console.log('=== 8. 条件与层数 ===');
// pendingCond 只在同一句内继承，「。」之后必须清空
const twoSent = R.parseEffect('战斗开始60秒内，攻击力+10%。所有干员防御力+5%');
eq(twoSent.mods.length, 2, '跨句两条修正项');
eq(twoSent.mods[0].cond && twoSent.mods[0].cond.type, 'early', '前半句带 early 条件');
eq(twoSent.mods[1].cond, null, '后半句不继承前半句的 early 条件');
const sameSent = R.parseEffect('战斗开始60秒内，所有【先锋】攻击力+100%，防御力+100%');
eq(sameSent.mods.length, 2, '144 同句两条');
ok(sameSent.mods.every(x => x.cond && x.cond.type === 'early'), '144 同句两条都带 early');

const capCond = R.detectCond('最多叠加10层');
eq(capCond.cap, 10, 'detectCond 产出 engine 读的 cap 字段');
eq(capCond.n, 10, 'capLayer 保留 n 兼容旧调用方');

console.log('=== 9. spCost 与注册表 ===');
const sel159 = [{ id: '159', stage: 0, stack: 0 }];
const healOp = Object.assign({}, op, { profession: '辅助' });
const r159 = E.computeOperator(healOp, E.buildModifiers(sel159, index), {});
eq(r159.unapplied.filter(x => x.stat === 'spCost').length, 1, '159 的 spCost 进 unapplied');
ok(!r159.acc.spCost || r159.acc.spCost.list.length === 0, 'spCost 不再累加进 acc');
eq(r159.final.cost, 12, 'spCost 不影响面板结算');

eq(E.PANEL_KEYS.length, S.PANEL_KEYS.length, 'PANEL_KEYS 长度一致');
ok(E.PANEL_KEYS.every((k, i) => k === S.PANEL_KEYS[i]), 'PANEL_KEYS 与 ArkSchema 同源');
eq(R.PROFESSIONS.length, 8, 'PROFESSIONS 来自 ArkEnums');
ok(R.PANEL_STATS.every(s => S.bucketOf(s.key) === 'panel'), 'PANEL_STATS 由注册表派生');

console.log('=== 10. 条件句不得被当成加成（086 白送阻挡回归）===');
m = modsOf('086');
eq(m.filter(x => x.stat === 'block').length, 0, '086 不再产出 block 修正项');
ok(m.every(x => x.stat !== 'block'), '086 的条件阈值「仅阻挡1名敌人」没有被当成加成');
const r086b = E.computeOperator(op, E.buildModifiers([{ id: '086' }], index), {});
eq(r086b.base.block, 1, '先锋基础阻挡 1');
eq(r086b.final.block, 1, '先锋选 086 后阻挡数仍是 1');
const blankOp = { name: '空白干员', profession: '', panel: { hp: 1000, atk: 100, def: 100, res: 0, aspd: 100, block: 0, cost: 10, interval: 1, spRecover: 1, initSp: 0, redeploy: 70 } };
eq(E.computeOperator(blankOp, E.buildModifiers([{ id: '086' }], index), {}).final.block, 0, '空白干员选 086 阻挡仍是 0');
// 阈值与加成数值不等的必须保留，守卫不能误伤
eq(modsOf('144').filter(x => x.stat === 'atk' && x.value === 100).length, 1, '144 的 early(60) 与 atk+100% 不等，保留');
eq(modsOf('192').filter(x => x.stat === 'aspd' && x.value === 7).length, 1, '192 的每 5 源石锭与攻速 +7 不等，保留');

console.log('=== 11. 触发类条件（116 击倒敌人时）===');
m = modsOf('116');
eq(m[0].cond && m[0].cond.type, 'proc', '116 识别为 proc 条件');
const noProc = E.computeOperator(op, E.buildModifiers([{ id: '116' }], index), {});
eq(noProc.final.aspd, 100, '未勾选触发类效果时攻速不变');
ok(noProc.inactive.some(x => x.stat === 'aspd' && x.reason === '击倒敌人时'), '默认进 inactive 并给出原因「击倒敌人时」');
const withProc = E.computeOperator(op, E.buildModifiers([{ id: '116' }], index), { proc: true });
eq(withProc.final.aspd, 200, '勾选触发类效果后攻速 +100');
eq(withProc.inactive.length, 0, '勾选后不再有 inactive 项');

console.log('=== 12. 按层乘算：文案判定，不再按 id 白名单 ===');
ok(!/STACK_PER_LAYER/.test(fs.readFileSync(path.join(root, 'js/engine.js'), 'utf8')), 'engine.js 里不再有 STACK_PER_LAYER 硬编码表');
eq(E.parseRelic(index['218'], 0).mods[0].perLayer, true, '218 由「每…，…+N%」句式判定为 perLayer');
eq(E.buildModifiers([{ id: '218', stack: 3 }], index)[0].cond.type, 'perStack', '218 源石锭 +10% 按层乘算');
eq(E.parseRelic(index['193'], 0).mods[0].cond.type, 'perStack', '193 仍是 perStack（官方数据自带）');
eq(E.buildModifiers([{ id: '193', stack: 10 }], index)[0].cond.type, 'perStack', '193 的叠层行为不变');
eq(E.computeOperator(op, E.buildModifiers([{ id: '193', stack: 10 }], index), {}).final.atk, 750, '193 叠 10 层 → 攻击 500×1.5');
eq(E.buildModifiers([{ id: '196', stack: 10 }], index)[0].cond.type, 'perStack', '196 仍是 perStack，没被改坏');
eq(E.buildModifiers([{ id: '197', stack: 10 }], index).filter(x => x.stat === 'hp')[0].cond.type, 'perStack', '197 生命仍按层乘算');
eq(E.buildModifiers([{ id: '208', stack: 5 }], index).filter(x => x.stat === 'aspd')[0].cond.type, 'perStack', '208 攻速仍按层乘算');
ok(!E.parseRelic(index['208'], 0).mods.filter(x => x.stat === 'enemyHp')[0].perLayer, '208 的「与居民作战时敌人生命-40%」不被误标 perLayer');
// 108 / 152 的「最多叠加N层」现在与 193/197 的官方 perStack 口径统一
eq(E.buildModifiers([{ id: '108', stack: 5 }], index)[0].cond.type, 'perStack', '108 最多叠加30层 → 按层乘算');
eq(E.stackCap(index['108']), 30, '108 的层数上限仍读得到（cap 搬到 perStack 上）');

console.log('=== 13. 解析缓存键 ===');
const pc0 = E.parseRelic(index['006'], 0);
const pc3 = E.parseRelic(index['006'], 3);
ok(pc0 !== pc3, '同一藏品不同 stage 返回不同对象（缓存不串）');
ok(JSON.stringify(pc0.mods) !== JSON.stringify(pc3.mods), '不同 stage 的修正项不同');
eq(E.parseRelic(index['006'], 0), pc0, '同一 stage 命中缓存');
const b3 = E.buildModifiers([{ id: '193', stack: 3 }], index)[0];
const b7 = E.buildModifiers([{ id: '193', stack: 7 }], index)[0];
eq(b3.stack, 3, '层数 3 传到了修正项');
eq(b7.stack, 7, '层数 7 传到了修正项');
ok(b3.value === b7.value, '层数不进缓存键：两条修正项数值相同，层数在结算时乘');

console.log('=== 14. 152 断杖-波纹：驱动量是场上术师人数，不是手填层数 ===');
const m152 = E.parseRelic(index['152'], 0).mods[0];
eq(m152.cond && m152.cond.type, 'perProfession', '152 的条件是 perProfession（不是 capLayer）');
eq(m152.cond && m152.cond.who, '术师', '152 的驱动职业是术师');
eq(m152.cond && m152.cond.cap, 8, '「最多叠加8层」作为上限挂在人数条件上');
ok(!m152.perLayer, '152 不再被打上 perLayer（否则会被换成默认 0 层的手填层数）');
const casterOp = Object.assign({}, op, { profession: '术师' });
const r152a = E.computeOperator(casterOp, E.buildModifiers([{ id: '152' }], index), {});
eq(r152a.combat.filter(x => x.stat === 'magicTaken')[0].ok, false, '默认 ctx（0 名术师）下 152 不生效');
ok(r152a.inactive.some(x => x.stat === 'magicTaken' && x.reason.indexOf('术师') >= 0), '默认 ctx 下 152 进 inactive 并给出原因');
const r152b = E.computeOperator(casterOp, E.buildModifiers([{ id: '152' }], index), { profCounts: { '术师': 3 } });
const c152b = r152b.combat.filter(x => x.stat === 'magicTaken')[0];
eq(c152b.ok, true, '3 名术师时 152 生效');
eq(c152b.value, 36, '3 名术师 → 12% × 3 = 36%');
eq(r152b.inactive.length, 0, '生效后没有 inactive 项');
const c152c = E.computeOperator(casterOp, E.buildModifiers([{ id: '152' }], index), { profCounts: { '术师': 12 } }).combat.filter(x => x.stat === 'magicTaken')[0];
eq(c152c.value, 96, '12 名术师被夹到 8 层 → 12% × 8 = 96%');
// 手填层数不再驱动 152：设 8 层但场上没有术师，仍然不生效
const r152d = E.computeOperator(casterOp, E.buildModifiers([{ id: '152', stack: 8 }], index), {});
eq(r152d.combat.filter(x => x.stat === 'magicTaken')[0].ok, false, '手填层数不再驱动 152');

console.log('=== 15. 条件守卫：整组丢 / 后置条件也守得住 ===');
const g1 = R.parseEffect('生命值低于50%时，攻击力和生命+50%');
eq(g1.mods.length, 2, '「生命值低于50%时，攻击力和生命+50%」产出 2 条（不再只丢一半）');
ok(g1.mods.some(x => x.stat === 'atk' && x.value === 50), '同分句里 atk 保留');
ok(g1.mods.some(x => x.stat === 'hp' && x.value === 50), '同分句里 hp 也保留');
const g2 = R.parseEffect('阻挡数+1，仅阻挡1名敌人时');
eq(g2.mods.length, 0, '「阻挡数+1，仅阻挡1名敌人时」不产出 block（条件在后一分句也守得住）');
ok(!g2.mods.some(x => x.stat === 'block'), '后置条件分句不再白送阻挡');
eq(R.parseEffect('生命值低于30%时，最大生命+30%').mods.length, 0, '阈值复述（生命+30% 与 hpBelow30）仍整条丢弃');
eq(modsOf('086').filter(x => x.stat === 'block').length, 0, '086 的守卫效果未被放宽破坏');
eq(E.computeOperator(op, E.buildModifiers([{ id: '086' }], index), {}).final.atk, 1000, '086 的 atk +100% 仍在');

console.log('=== 16. 208 厄运火杆：敌方生命修正进战斗卡 ===');
const sum208 = E.summarize(E.buildModifiers([{ id: '208' }], index), {});
eq(sum208.panel.hp.items.filter(x => x.relicId === '208').length, 0, '208 的 hp 项不再进 panel');
ok(sum208.combat.enemyHp && sum208.combat.enemyHp.items.length === 1, '208 的 hp 项改投 combat，并归一为 enemyHp');
eq(sum208.combat.enemyHp.items[0].value, -40, '208 敌人生命 -40%');
eq(sum208.combat.enemyHp.items[0].enemy, false, 'enemyHp 自带「敌人」语义，不再叠加「（对敌）」标记');
eq(sum208.panel.hp.pct, 0, '208 不再污染面板生命百分比');

console.log('=== 17. perLayer 全库扫描：只剩真正按层累加的藏品 ===');
const perLayerIds = [];
relics.forEach(r => {
  const n = (r.stages && r.stages.length) || 1;
  for (let i = 0; i < n; i++) {
    if (E.parseRelic(r, i).mods.some(x => x.perLayer) && perLayerIds.indexOf(r.id) < 0) perLayerIds.push(r.id);
  }
});
// 108 以前靠「每次造成伤害+2%（最多叠加30层）」的中文句式被标成 perLayer，
// 现在官方 blackboard 直接给出 max_stack_cnt=30 → perStack + cap，比手填层数更准，
// 因此 perLayer 只应剩 218（「每去过一种节点」没有官方层数字段，仍走文案判定）。
eq(perLayerIds.join(','), '218', 'perLayer 只剩 218（每去一种节点+10%）；官方给得出 cap 的走 perStack');
ok(!perLayerIds.includes('152'), '152 已从 perLayer 名单里移除');
ok(!perLayerIds.includes('110'), '110 的「补充30%弹药」是一次性效果，不再被误标 perLayer');
eq((index['108'].stages[0].mods[0].cond || {}).cap, 30, '108 的层数上限来自官方 max_stack_cnt');

console.log('=== 18. 具名单位做主语：加成不得送给全体干员（209 / 142）===');
// 209《猎印》：官方的 enemyAtk -50% 是「猎犬proto」的攻击力，文案补充不该再生成一条我方 atk
const p209 = E.parseRelic(index['209'], 0);
eq(p209.mods.filter(x => x.stat === 'atk').length, 0, '209 不再产出我方 atk 修正项');
const e209 = p209.mods.filter(x => x.stat === 'enemyAtk')[0];
ok(!!e209 && e209.value === -50 && e209.pct === true, '209 的官方 enemyAtk -50% 仍在');
ok(!!e209 && e209.scope.base === 'enemy', '209 的 enemyAtk 作用域仍是敌方');
ok(p209.unmatched.some(t => t.indexOf('猎犬proto的攻击力-50%') >= 0), '209 的「猎犬proto的攻击力-50%」进 unmatched 可见');
ok(p209.mods.some(x => x.stat === 'res' && x.value === 10), '209 的「我方法术抗性+10」仍正常解析');
// 142《探测先锋》：+20% 是「猎犬proto」（召唤物）的，不是全体干员的
const p142 = E.parseRelic(index['142'], 0);
ok(!p142.mods.some(x => x.stat === 'atk' || x.stat === 'hp'), '142 不再产出 atk / hp 修正项');
ok(p142.unmatched.some(t => t.indexOf('猎犬proto') >= 0), '142 的「每层使“猎犬proto”…+20%」进 unmatched 可见');
// 数值验收：先锋选中这两件，面板一分不变（209 只有法术抗性 +10）
const r209b = E.computeOperator(op, E.buildModifiers([{ id: '209', stack: 0 }], index), {});
eq(r209b.final.atk, 500, '先锋选 209 后攻击力不变（不再腰斩）');
eq(r209b.final.res, 10, '209 单独选中时法抗不变（抗性按【探测先锋】层数给）');
const r209c = E.computeOperator(op, E.buildModifiers([{ id: '209' }, { id: '142', stack: 1 }], index), {});
eq(r209c.final.res, 20, '209 +【探测先锋】1 层：法抗 10 → 20');
const r142b = E.computeOperator(op, E.buildModifiers([{ id: '142', stack: 5 }], index), {});
eq(r142b.final.atk, 500, '先锋选 142 后攻击力不变');
eq(r142b.final.hp, 2000, '先锋选 142 后生命不变');
// 守卫边界：通用受益方（干员/我方/敌人）与「非专名」照旧解析，不能被这条守卫误伤
const named = R.parseEffect('猎犬proto的攻击力-50%');
eq(named.mods.length, 0, '「猎犬proto的攻击力-50%」不产出修正项');
eq(named.unmatched.length, 1, '「猎犬proto的攻击力-50%」整句进 unmatched');
eq(R.parseEffect('所有我方单位的攻击力+10%').mods.length, 1, '通用主语「所有我方单位」照旧解析');
eq(R.parseEffect('所有干员的生命+10%').mods.length, 1, '通用主语「所有干员」照旧解析');
eq(R.parseEffect('敌人的防御力-40%').mods.filter(x => x.scope.base === 'enemy').length, 1, '「敌人的防御力-40%」仍判敌方');

console.log('=== 8. 对象/场景回归（费用、作用域） ===');
// 人偶之家 / 微缩舞台模型 / 缠梦古堡模型：初始部署费用是局内初始费用，不是干员部署费用
['056', '057', '058'].forEach(id => {
  const p = E.parseRelic(index[id], 0);
  ok(p.mods.every(x => x.stat === 'initCost'), id + ' 只产出 initCost');
  const r = E.computeOperator(op, E.buildModifiers([{ id }], index), {});
  eq(r.final.cost, 12, id + ' 不改变干员部署费用');
});
const sumInit = E.summarize(E.buildModifiers([{ id: '056' }], index), {});
ok(sumInit.run.initCost && sumInit.run.initCost.flat === 10, '056 的 +10 计入探索/运营的 initCost');

// 钝爪-先机：开技能获得部署费用，不是把先锋费用抬高 3 点
const p160 = E.parseRelic(index['160'], 0);
ok(p160.mods.some(m => m.stat === 'dpOnSkill' && m.value === 3), '160 产出 dpOnSkill +3');
ok(!p160.mods.some(m => m.stat === 'cost'), '160 不再产出 cost');
eq(E.computeOperator(op, E.buildModifiers([{ id: '160' }], index), {}).final.cost, 12, '160 不改变干员部署费用');

// 作用域：146 只加近卫，153 只加医疗
const meleeOp = Object.assign({}, op, { profession: '近卫' });
const sniperOp = Object.assign({}, op, { profession: '狙击' });
const medicOp = Object.assign({}, op, { profession: '医疗' });
eq(E.buildModifiers([{ id: '146' }], index)[0].scope.professions[0], '近卫', '146 限定近卫');
eq(E.computeOperator(meleeOp, E.buildModifiers([{ id: '146' }], index), {}).combat.length, 1, '146 对近卫生效');
eq(E.computeOperator(sniperOp, E.buildModifiers([{ id: '146' }], index), {}).combat.length, 0, '146 对狙击不生效');
eq(E.buildModifiers([{ id: '153' }], index)[0].scope.professions[0], '医疗', '153 限定医疗');

// 作用域：114 地面干员 / 113 高台干员
const p114 = E.parseRelic(index['114'], 0);
ok(p114.mods.every(m => (m.scope.positions || []).indexOf('MELEE') >= 0), '114 只对地面干员');
const p113 = E.parseRelic(index['113'], 0);
ok(p113.mods.every(m => (m.scope.positions || []).indexOf('RANGED') >= 0), '113 只对高台干员');

// 新典训：174 每开一次技能 +10%，最多 6 层
const p174 = E.parseRelic(index['174'], 0);
ok(p174.mods.some(m => m.stat === 'atk' && m.cond && m.cond.type === 'perStack' && m.cond.cap === 6), '174 按层叠加上限 6');
const opAssign = Object.assign({}, op, { assignTarget: true });
eq(E.computeOperator(Object.assign({}, opAssign, { profession: '先锋' }),
  E.buildModifiers([{ id: '174', stack: 3 }], index), {}).final.atk, 650, '174 叠 3 层：500 → 650');

console.log('=== 9. 伤害估算（官方公式） ===');
const dmgMods = E.buildModifiers([{ id: '041' }], index);   // 敌人受到物理伤害 +15%
const d0 = E.estimateDamage({ atk: 1000, scale: 1, def: 200, res: 30 }, [], {});
eq(d0.phys, 800, '无藏品：物理 max(1000-200, 50) = 800');
eq(d0.magic, 700, '无藏品：法术 max(1000×0.7, 50) = 700');
eq(d0.trueDmg, 1000, '无藏品：真实 1000');
const d1 = E.estimateDamage({ atk: 1000, scale: 1, def: 200, res: 30 }, dmgMods, {});
eq(d1.phys, 920, '锈蚀刀片：物理 800×1.15 = 920');
eq(d1.magic, 700, '锈蚀刀片不影响法术');
const d2 = E.estimateDamage({ atk: 1000, scale: 2, def: 1990, res: 0 }, [], {});
eq(d2.phys, 100, '防御极高时保底 5%：2000−1990 < 2000×0.05，取 100');
const d3 = E.estimateDamage({ atk: 1000, scale: 1, def: 200, res: 0 },
  E.buildModifiers([{ id: '178' }], index), {}, Object.assign({}, op, { profession: '狙击', assignTarget: true }));
eq(d3.detail.defIgnore, 50, '178 无视 50% 防御');
eq(d3.phys, 900, '178：防御 200→100，伤害 900');

console.log('=== 10. 细节回归（跨藏品前置 / 上限 / 提升至） ===');
// 124 染血辞典：生命<10% 时获得 100% 生命上限屏障（旧版把 10% 当成屏障值）
const p124 = E.parseRelic(index['124'], 0);
const m124 = p124.mods[0];
eq(m124.value, 100, '124 屏障 = 100% 生命上限');
eq(m124.cond.of[0].type, 'hpBelow', '124 的条件是生命低于阈值');
eq(m124.cond.of[0].pct, 10, '124 阈值 10%');
// 240 祭日之契：再部署 +50%（不是 +150%）
eq(E.parseRelic(index['240'], 0).mods[0].value, 50, '240 再部署 +50%');
eq(E.parseRelic(index['225'], 0).mods[0].value, -50, '225 再部署 -50%');

// 跨藏品前置：没有前置藏品时只登记不生效
const vg = Object.assign({}, op, { profession: '先锋', subProfession: '尖兵' });
const r167no = E.computeOperator(vg, E.buildModifiers([{ id: '167' }], index), {});
ok(r167no.combat.some(x => x.stat === 'spOnSkillEnd' && x.ok === false), '167 无【钝爪-先机】时该条不生效');
const r167yes = E.computeOperator(vg, E.buildModifiers([{ id: '167' }, { id: '160' }], index), {});
ok(r167yes.combat.some(x => x.stat === 'spOnSkillEnd' && x.ok && x.value === 2), '167 有【钝爪-先机】时回 2 技力');
eq(r167yes.final.cost, 6, '167 费用 12 - 6 = 6');

const wu = Object.assign({}, op, { profession: '近卫', subProfession: '武者' });
eq(E.computeOperator(wu, E.buildModifiers([{ id: '168' }, { id: '161' }], index), { proc: true }).final.redeploy, 35,
   '168 +【折戟-避锋】+触发：再部署 70 → 35');
eq(E.computeOperator(wu, E.buildModifiers([{ id: '168' }, { id: '161' }], index), { proc: false }).final.redeploy, 70,
   '168 未触发时再部署不变');

const tc = Object.assign({}, op, { profession: '重装', subProfession: '铁卫' });
eq(E.computeOperator(tc, E.buildModifiers([{ id: '169' }, { id: '162' }], index), { hpPct: 100 }).final.block, 4,
   '169 +【铁卫-轻行】生命≥50%：阻挡 +3（1 → 4）');
eq(E.computeOperator(tc, E.buildModifiers([{ id: '169' }, { id: '162' }], index), { hpPct: 30 }).final.block, 1,
   '169 生命<50% 时阻挡不加');

const sn = Object.assign({}, op, { profession: '狙击', subProfession: '炮手' });
eq(E.computeOperator(sn, E.buildModifiers([{ id: '170' }, { id: '163' }], index), {}).final.spRecover, 2,
   '170 +【残弩-神准】：技力回复 1 → 2');
eq(E.computeOperator(sn, E.buildModifiers([{ id: '170' }], index), {}).final.spRecover, 1,
   '170 无【残弩-神准】：技力回复不变');

// 171 波纹之手：攻击力部分需要【断杖-同调】+ 层数
const cas = Object.assign({}, op, { profession: '术师', subProfession: '链术师' });
eq(E.computeOperator(cas, E.buildModifiers([{ id: '171', stack: 5 }], index), { proc: true }).final.atk, 500,
   '171 无【断杖-同调】：攻击不变');
eq(E.computeOperator(cas, E.buildModifiers([{ id: '171', stack: 5 }, { id: '164' }], index), { proc: true }).final.atk, 1000,
   '171 +【断杖-同调】5 层：攻击 500 → 1000');

// 173 剿袭之手：分支作用域 + 触发条件
const p173 = E.parseRelic(index['173'], 0);
ok(p173.mods.every(m => (m.scope.subProfs || []).length === 3), '173 限定三个分支');
ok(p173.mods.every(m => m.cond && m.cond.type === 'all'), '173 需要触发条件');

// 209 猎印：每层【探测先锋】+10 法抗
eq(E.computeOperator(op, E.buildModifiers([{ id: '209' }, { id: '142', stack: 3 }], index), {}).final.res, 40,
   '209 +【探测先锋】3 层：法抗 10 → 40');

// 216 树海贵宾套餐：每 5 点估值 +3%，封顶 +150%
eq(E.summarize(E.buildModifiers([{ id: '216' }], index), { value: 1000 }).panel.hp.pct, 150, '216 估值 1000 封顶 +150%');
eq(E.summarize(E.buildModifiers([{ id: '216' }], index), { value: 20 }).panel.hp.pct, 12, '216 估值 20 → 4 档 × 3% = 12%');

console.log('');
console.log('通过 %d 项，失败 %d 项', pass, fail);
if (specialOnly.length) {
  console.log('\n=== 无任何可量化效果的藏品（%d 件）===', specialOnly.length);
  specialOnly.slice(0, 40).forEach(r => console.log('  ' + r.id + ' ' + r.name + ' | ' + E.effectTextFor(r, 0).slice(0, 60)));
}
process.exit(fail ? 1 : 0);
