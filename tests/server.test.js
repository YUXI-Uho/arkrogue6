/* 后端自测：node tests/server.test.js
 *
 * 盯的是「前端与后端是不是同一套东西」这件事：
 *   1. 数据源：后端必须读 data/is6db.json（表产物），指纹与前端一致
 *   2. 面板字段：schema 里声明的每个可结算字段，后端都要原样透传（防漂移）
 *   3. 内置干员：按 id / 名字解析，信赖开关生效
 *   4. 校验层：白名单、夹范围、数量上限
 *
 * 前两条是回归重点：以前 server 自己维护 PANEL_KEYS / PANEL_RANGE 两份清单，
 * 新增属性时前端会算、后端会静默丢，而且没有任何测试会发现。
 */
const assert = require('assert');

const engine = require('../server/engine');
const { validateCalc, LIMITS } = require('../server/validate');
const ARTIFACT = require('../data/is6db.json');

const S = globalThis.ArkSchema;
const OP = globalThis.OperatorRepo;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

/* 无藏品时的基准面板：每个字段给一个「非默认」值，才能看出后端有没有真的读进去 */
const PANEL = {
  hp: 3000, atk: 500, def: 300, res: 10, aspd: 100, interval: 1.2,
  block: 2, cost: 20, spRecover: 1.5, initSp: 5, redeploy: 70
};

console.log('=== 1. 数据源：读的是表产物，不是中间产物 ===');
const meta = engine.meta();
eq(meta.dataHash, ARTIFACT.meta.dataHash, '数据指纹与 data/is6db.json 一致');
eq(meta.tableVersion, ARTIFACT.meta.schemaVersion, '表结构版本来自产物 meta');
eq(meta.schemaVersion, S.version, 'schemaVersion 是属性注册表版本');
eq(meta.relics, ARTIFACT.meta.counts.relics, '藏品数与产物 meta.counts 一致');
eq(meta.operators, ARTIFACT.meta.counts.operators, '干员数与产物 meta.counts 一致');
eq(meta.ranges, ARTIFACT.meta.counts.ranges, '攻击范围数与产物一致');
ok(!!meta.builtAt && !!meta.gameVersion, 'meta 带构建时间与游戏版本');

console.log('=== 2. 面板字段：schema 声明多少个，后端就要认多少个 ===');
const noRelics = engine.calc({ relics: [], operators: [{ name: '自定义', panel: PANEL }] });
const base = noRelics.operators[0].base;
const final = noRelics.operators[0].final;

const finalKeys = Object.keys(final).sort();
eq(finalKeys.join(','), S.SETTLED_KEYS.slice().sort().join(','),
  'final 的字段集合 == ArkSchema.SETTLED_KEYS');

for (const k of S.SETTLED_KEYS) {
  // interval 由攻速推导（基础 × 100 ÷ 最终攻速），攻速 100 时应等于基准值
  const want = PANEL[k];
  ok(Math.abs(final[k] - want) < 1e-9, `面板字段 ${k} 透传（${final[k]} == ${want}）`);
}
ok(!('foo' in base), '未注册字段不进 base');
ok(!('foo' in final), '未注册字段不进 final');
ok(!('spCost' in final), 'settles:false 的字段不进 final（spCost）');

console.log('=== 3. 内置干员 ===');
const row = OP.getByName('玛恩纳');
ok(!!row, '仓储能按名字取到内置干员');
const byName = engine.calc({ relics: [], operators: [{ name: '玛恩纳' }] }).operators[0];
const byId = engine.calc({ relics: [], operators: [{ id: row.id }] }).operators[0];
eq(byName.id, row.id, '按名字解析时回填 id');
eq(byId.base.atk, byName.base.atk, '按 id 与按名字解析结果一致');
eq(byName.base.atk, row.atk + row.favorAtk, '满信赖时攻击力 = 面板 + 信赖');

const noFavor = engine.calc({
  relics: [], operators: [{ name: '玛恩纳', useFavor: false }]
}).operators[0];
eq(noFavor.base.atk, row.atk, 'useFavor:false 时不叠加信赖');

console.log('=== 4. 藏品结算 ===');
const withRelic = engine.calc({
  relics: [{ id: '145', stage: 0, stack: 0 }],
  operators: [{ name: '自定义', panel: PANEL }]
});
ok(withRelic.counts.mods > 0, '选中藏品后产生修正项', withRelic.counts.mods);
ok(withRelic.operators[0].final.atk > PANEL.atk, '145 提升攻击力',
  PANEL.atk + ' → ' + withRelic.operators[0].final.atk);
ok(Object.keys(withRelic.summary.panel).length > 0, '汇总里有面板加成');

const unknownRelic = engine.calc({ relics: [{ id: 'no-such-relic' }], operators: [] });
eq(unknownRelic.counts.mods, 0, '未知藏品 id 被忽略，不产生修正项');

console.log('=== 5. 校验层 ===');
ok(!validateCalc(null).ok, 'null body 被拒');
ok(!validateCalc([]).ok, '数组 body 被拒');
eq(validateCalc({ relics: 'x' }).status, 400, 'relics 非数组 → 400');
eq(validateCalc({ operators: 'x' }).status, 400, 'operators 非数组 → 400');
eq(validateCalc({ operators: [{ name: 'a' }] }).ok, true, '只给名字是合法请求');
eq(validateCalc({ operators: [{}] }).status, 400, '既无 id/name 又无 panel → 400');

const tooManyRelics = validateCalc({ relics: new Array(LIMITS.maxRelics + 1).fill({ id: '145' }) });
eq(tooManyRelics.status, 413, '藏品超上限 → 413');
const tooManyOps = validateCalc({ operators: new Array(LIMITS.maxOperators + 1).fill({ name: 'a' }) });
eq(tooManyOps.status, 413, '干员超上限 → 413');

const dup = validateCalc({ relics: [{ id: '145' }, { id: '145' }] });
eq(dup.value.relics.length, 1, '重复藏品去重');

const clamped = validateCalc({
  operators: [{ name: 'x', panel: { atk: 1e9, res: 999, block: -5, cost: 'abc' } }]
}).value.operators[0].panel;
eq(clamped.atk, 1e6, '攻击力夹到上限');
eq(clamped.res, 100, '法抗夹到 100');
eq(clamped.block, 0, '阻挡数夹到 0');
eq(clamped.cost, 0, '非数字回落 0');

const onlySchema = validateCalc({
  operators: [{ name: 'x', panel: Object.assign({ foo: 1, bar: 2 }, PANEL) }]
}).value.operators[0].panel;
ok(!('foo' in onlySchema) && !('bar' in onlySchema), '面板只保留 schema 字段');
eq(Object.keys(onlySchema).sort().join(','), S.SETTLED_KEYS.slice().sort().join(','),
  '校验后的面板字段 == ArkSchema.SETTLED_KEYS');

const ranged = validateCalc({ operators: [{ name: 'x', position: 'RANGED' }] }).value.operators[0];
eq(ranged.position, '远程位', 'position 归一化');

const ctx = validateCalc({ ctx: { time: 99999, hpPct: -1, profCounts: { 术师: 99 } } }).value.ctx;
eq(ctx.time, 3600, '战斗时间夹到 3600');
eq(ctx.hpPct, 0, '生命百分比夹到 0');
eq(ctx.profCounts['术师'], 20, '职业人数夹到 20');

console.log('=== 6. 缺陷回归 ===');

// P1-1 未知干员名：以前静默变成 0 面板，现在是显式的 400
let threw = null;
try {
  engine.calc({ operators: [{ name: '不存在的干员' }] });
} catch (e) {
  threw = e;
}
ok(threw && threw.status === 400 && threw.code === 'unknown_operator',
  '未知干员名 → 400 unknown_operator');

// 名字带尾随空格/全角空格：归一化后仍能匹配内置数据
const spaced = engine.calc({ operators: [{ name: '玛恩纳 ' }] });
ok(spaced.operators[0].resolved === true && spaced.operators[0].final.atk > 0,
  '尾随空格被归一化，仍匹配内置干员（攻击力 ' + spaced.operators[0].final.atk + '）');
const fullWidth = engine.calc({ operators: [{ name: '玛恩纳\u3000' }] });
ok(fullWidth.operators[0].resolved === true, '全角空格同样被归一化');

// 同名但显式给了 panel：必须用 panel（自定义），不能被内置数据顶掉
const customNamed = engine.calc({
  operators: [{ name: '玛恩纳', panel: { hp: 1000, atk: 123, def: 0, res: 0 } }]
});
eq(customNamed.operators[0].final.atk, 123, '给了 panel 就按自定义算，不被同名内置干员覆盖');
eq(customNamed.operators[0].id, null, '自定义干员没有内置 id');

// P1-2 counts 语义：requested / applied / ignored 分开
const mixed = engine.calc({
  relics: [{ id: '145' }, { id: 'no-such-relic' }],
  operators: []
}).counts;
eq(mixed.requested, 2, 'counts.requested = 请求数');
eq(mixed.applied, 1, 'counts.applied = 真正生效数');
eq(mixed.ignored.join(','), 'no-such-relic', 'counts.ignored 列出未知 id');

// P1-3 同一藏品不同档位：以前静默取第一个，现在 400
eq(validateCalc({ relics: [{ id: '006', stage: 0 }, { id: '006', stage: 3 }] }).status, 400,
  '同 id 不同档位 → 400');
eq(validateCalc({ relics: [{ id: '006', stage: 1 }, { id: '006', stage: 1 }] }).ok, true,
  '完全相同的重复才去重');

// P2-6 职业人数白名单（用 JSON.parse 才能造出真正的 __proto__ 键）
const dirty = JSON.parse('{"ctx":{"profCounts":{"\u672f\u5e08":2,"__proto__":5,"constructor":7,"\u4e0d\u5b58\u5728":3}}}');
const clean = validateCalc(dirty).value.ctx.profCounts;
eq(Object.keys(clean).sort().join(','), '术师', '职业人数只收八大职业，脏键被丢');
eq(clean['术师'], 2, '合法职业正常保留');

// P2-4 明细超过 40 条时有截断标记（数据未触发则跳过）
const bulk = engine.calc({
  relics: ARTIFACT.tables.relics.slice(0, 120).map(r => ({ id: r.id, stage: 0, stack: 0 })),
  operators: []
});
const atk = bulk.summary.panel.atk;
if (atk && atk.itemsTotal > 40) {
  eq(atk.items.length, 40, '明细截到 40 条');
  eq(atk.itemsTruncated, true, '截断时 itemsTruncated=true');
} else {
  ok(true, '本次数据未触发 40 条截断（跳过）');
}

console.log();
if (fail) {
  console.log(`后端测试：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}
console.log(`后端测试：通过 ${pass} 项，失败 0 项`);
