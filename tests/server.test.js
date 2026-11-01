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

console.log();
if (fail) {
  console.log(`后端测试：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}
console.log(`后端测试：通过 ${pass} 项，失败 0 项`);
