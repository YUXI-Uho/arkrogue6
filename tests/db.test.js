/* 数据层自测：node tests/db.test.js
 *
 * 只测三层，不碰界面：
 *   1. core/db/schema.js   表结构（列名 / 主键 / 类型）是不是唯一真相
 *   2. data/is6db.js       产物里的列、行数、指纹与表结构对不对得上
 *   3. core/db/migrate.js  存档 v2 ↔ v3 往返不丢东西
 *
 * 这三件事一旦漂了，界面层是看不出来的（照样能跑，只是悄悄丢数据），
 * 所以必须由测试盯着。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
global.window = global;

function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel });
}

load('core/db/schema.js');
load('data/is6db.js');
load('core/db/db.js');
load('core/db/migrate.js');

const S = window.DBSchema;
const DB = window.DB;
const M = window.DBMigrate;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function deep(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  ok(A === B, msg, A + ' !== ' + B);
}

// ---------------------------------------------------------------- 1. 表结构
console.log('=== 1. 表结构定义 ===');
ok(S.VERSION >= 3, 'DBSchema.VERSION = ' + S.VERSION);
eq(S.NAMES.length, 13, '共 13 张表');
eq(S.GAME_TABLES.length, 9, '官方数据表 9 张（藏品 2 + 干员 6 + 攻击范围 1）');
eq(S.USER_TABLES.length, 4, '用户表 4 张（selection / squads / presets / settings）');
ok(S.GAME_TABLES.concat(S.USER_TABLES).length === S.NAMES.length, '两张清单不重不漏');

S.NAMES.forEach(name => {
  const d = S.get(name);
  ok(d && d.kind && d.pk && d.columns, name + ' 定义了 kind / pk / columns');
  const pkCols = Array.isArray(d.pk) ? d.pk : [d.pk];
  ok(pkCols.every(c => d.columns[c]), name + ' 的主键列都在 columns 里');
  ok(Object.keys(d.columns).every(c => /^(text|int|real|bool|json)$/.test(d.columns[c])),
     name + ' 的列类型都是受支持的五种');
  ok(Array.isArray(d.indexes), name + ' 声明了 indexes（可为空数组）');
  ok(d.indexes.every(c => d.columns[c]), name + ' 的索引列都在 columns 里');
});
ok(S.get('relic_stages').pk.length === 2, 'relic_stages 是复合主键');
ok(!S.isKnown('no_such_table'), '未知表名返回 false');
ok(S.pkOf('relic_stages', { relicId: '001', stage: 2 }) === '001\u00012',
   '复合主键用 \\u0001 拼接');
ok(S.blankRow('operators').hp === 0 && S.blankRow('squads').panel === null &&
   S.blankRow('squads').useFavor === false,
   'blankRow 按列类型给默认值（int→0，json→null，bool→false）');

// ---------------------------------------------------------------- 2. 产物
console.log('=== 2. 数据产物 ===');
const art = window.IS6_DB;
ok(!!art && !!art.meta && !!art.tables, 'data/is6db.js 暴露 {meta, tables}');
eq(art.meta.schemaVersion, S.VERSION, '产物版本与代码版本一致');
ok(/^sha256:[0-9a-f]{16}$/.test(art.meta.dataHash), '带数据指纹：' + art.meta.dataHash);
ok(!!art.meta.gameVersion, '记录了对应的官方版本：' + art.meta.gameVersion);
ok(!!art.meta.builtAt, '记录了生成时间：' + art.meta.builtAt);

DB.load(art);
ok(DB.isLoaded(), 'DB.load 之后 isLoaded() = true');
const chk = DB.check();
ok(chk.ok, '行数与 meta.counts 对账通过', (chk.issues || []).join(' / '));

// 产物只该带 game 表，user 表由 migrate 在运行时装配
S.USER_TABLES.forEach(n => eq(DB.table(n).count(), 0, n + ' 是用户表，产物里应为空'));

// 列对齐：产物每一行的键集合必须等于 DDL 的列集合
S.GAME_TABLES.forEach(name => {
  const def = S.get(name);
  const cols = Object.keys(def.columns).sort().join(',');
  const rows = DB.table(name).all();
  const bad = rows.filter(r => Object.keys(r).sort().join(',') !== cols);
  ok(bad.length === 0, name + ' 每行的列与 DDL 完全一致（' + rows.length + ' 行）',
     bad.length ? '首个不符：' + Object.keys(bad[0]).join(',') : '');

  // 产物的重复主键由上面的 DB.check 报错；这里确认运行时有效行没有重复
  eq(rows.length, new Set(rows.map(r => S.pkOf(name, r))).size, name + ' 主键无重复');
});

// 行数下限：官方数据只会变多不会凭空缩水，掉太多说明生成器坏了
ok(DB.table('relics').count() >= 251, '藏品 ≥ 251（实际 ' + DB.table('relics').count() + '）');
ok(DB.table('relic_stages').count() >= 251, '藏品档位 ≥ 251（实际 ' + DB.table('relic_stages').count() + '）');
ok(DB.table('operators').count() >= 450, '干员 ≥ 450（实际 ' + DB.table('operators').count() + '）');

// ---- 干员详情五张表：行数下限 + 与主表的外键完整性 ----
ok(DB.table('operator_phases').count() >= 1300,
   '精英化面板 ≥ 1300（实际 ' + DB.table('operator_phases').count() + '）');
ok(DB.table('operator_skills').count() >= 990,
   '技能 ≥ 990（实际 ' + DB.table('operator_skills').count() + '）');
ok(DB.table('operator_talents').count() >= 600,
   '天赋 ≥ 600（实际 ' + DB.table('operator_talents').count() + '，已剔除空占位槽）');
ok(DB.table('operator_modules').count() >= 890,
   '模组 ≥ 890（实际 ' + DB.table('operator_modules').count() + '）');
ok(DB.table('operator_module_levels').count() >= 1500,
   '模组档位 ≥ 1500（实际 ' + DB.table('operator_module_levels').count() + '）');
ok(DB.table('ranges').count() >= 50, '攻击范围 ≥ 50（实际 ' + DB.table('ranges').count() + '）');

const opIds = new Set(DB.table('operators').all().map(o => o.id));
['operator_phases', 'operator_skills', 'operator_talents', 'operator_modules'].forEach(name => {
  const orphan = DB.table(name).all().filter(r => !opIds.has(r.id));
  ok(orphan.length === 0, name + ' 没有指向不存在干员的行',
     orphan.length ? '首个：' + orphan[0].id : '');
});

const phaseIds = new Set(DB.table('operator_phases').all().map(r => r.id));
const noPhase = [...opIds].filter(id => !phaseIds.has(id));
ok(noPhase.length === 0, '每名干员都至少有一档精英化面板',
   noPhase.length ? noPhase.slice(0, 3).join(',') : '');

const modIds = new Set(DB.table('operator_modules').all().map(r => r.id + '\u0001' + r.moduleId));
const orphanLevel = DB.table('operator_module_levels').all()
  .filter(r => !modIds.has(r.id + '\u0001' + r.moduleId));
ok(orphanLevel.length === 0, '模组档位都能找到所属模组');

// 攻击范围：干员 / 阶段 / 技能引用的 id 必须都在 ranges 表里
const rangeIds = new Set(DB.table('ranges').all().map(r => r.id));
const refs = []
  .concat(DB.table('operators').all().map(r => r.rangeId))
  .concat(DB.table('operator_phases').all().map(r => r.rangeId))
  .concat(DB.table('operator_skills').all().map(r => r.rangeId))
  .filter(Boolean);
const missingRange = [...new Set(refs)].filter(id => !rangeIds.has(id));
ok(missingRange.length === 0, '引用的攻击范围都在 ranges 表里',
   missingRange.slice(0, 5).join(','));
ok(DB.table('ranges').all().every(r => Array.isArray(r.grids) &&
   r.grids.every(g => Array.isArray(g) && g.length === 2)),
   '攻击范围的 grids 是 [[row, col], ...]');

// 干员表的最高档面板必须等于 operator_phases 里同 elite 的那一行
const opRows = DB.table('operators').all();
const phaseIdx = {};
DB.table('operator_phases').all().forEach(p => { phaseIdx[p.id + '\u0001' + p.elite] = p; });
const mismatch = opRows.filter(o => {
  const p = phaseIdx[o.id + '\u0001' + o.elite];
  return p && (p.hp !== o.hp || p.atk !== o.atk || p.def !== o.def || p.cost !== o.cost);
});
ok(mismatch.length === 0, '干员表的 hp/atk/def/cost 与最高档阶段面板一致',
   mismatch.length ? mismatch[0].name : '');

// ---------------------------------------------------------------- 3. 查询
console.log('=== 3. 查询 ===');
const relics = DB.table('relics');
const one = relics.get('001');
ok(!!one && one.id === '001', '按主键取藏品 001：' + (one && one.name));
eq(relics.get('no-such-id'), null, '不存在的主键返回 null');

const stages = DB.table('relic_stages');
const st = stages.get(['001', 0]);
ok(!!st && st.relicId === '001' && st.stage === 0, '复合主键取 001 的第 0 档');
eq(stages.get(['001', 99]), null, '越界档位返回 null');

const all001 = stages.where(r => r.relicId === '001').map(r => r.stage).sort((a, b) => a - b);
ok(all001.length >= 1 && all001[0] === 0, 'where 按 relicId 筛出 ' + all001.length + ' 档');

const byCat = relics.by('category', one.category);
ok(byCat.length > 0 && byCat.every(r => r.category === one.category),
   'by(category) 索引命中 ' + byCat.length + ' 条，且全部同类');
ok(relics.by('category', one.category) === byCat, '二级索引缓存复用（同一数组引用）');

const ops = DB.table('operators');
const byProf = ops.by('profession', '近卫');
ok(byProf.length > 0 && byProf.every(o => o.profession === '近卫'),
   'by(profession) 索引命中近卫 ' + byProf.length + ' 名');

// 干员面板被拍平成列，不再有嵌套 panel
const anyOp = ops.all()[0];
ok(typeof anyOp.hp === 'number' && typeof anyOp.atk === 'number' && !('panel' in anyOp),
   '干员面板已拍平成 hp/atk/def/res 列');
ok(typeof anyOp.favorHp === 'number' && typeof anyOp.favorAtk === 'number',
   '信赖加成拆成 favorHp / favorAtk / favorDef 三列');

// ---------------------------------------------------------------- 4. 版本护栏
console.log('=== 4. 版本护栏 ===');
let threw = false;
try {
  DB.load({ meta: { schemaVersion: S.VERSION + 1, counts: {} }, tables: {} });
} catch (e) { threw = /高于当前代码支持/.test(e.message); }
ok(threw, '产物版本高于代码时直接抛错，不用旧代码读新字段');

// 低版本只记 issue，不阻断启动（旧产物 + 新代码仍能打开界面）
DB.load({ meta: { schemaVersion: S.VERSION - 1, counts: {} }, tables: {} });
const lowChk = DB.check();
ok(!lowChk.ok && lowChk.issues.some(s => /请运行 tools\/build_db.py/.test(s)),
   '产物版本偏低时给出「重新生成」提示');

DB.load(art);   // 复位成正常产物，后面的用例继续用

const duplicateArtifact = { meta: { schemaVersion: S.VERSION, counts: { relics: 2 } }, tables: {} };
S.GAME_TABLES.forEach(name => { duplicateArtifact.tables[name] = []; });
duplicateArtifact.tables.relics = [
  { id: 'duplicate', category: 'first' },
  { id: 'duplicate', category: 'second' }
];
DB.load(duplicateArtifact);
const deduped = DB.table('relics');
eq(deduped.count(), 1, '重复主键只保留一行');
eq(deduped.all()[0].category, 'first', '重复主键保留第一条');
eq(deduped.by('category', 'second').length, 0, '二级索引不包含重复行');
ok(!DB.check().ok, '重复主键仍使产物自检失败');
DB.load(art);

// ---------------------------------------------------------------- 5. 存档往返
console.log('=== 5. 存档往返（v3） ===');
const state = {
  relics: {
    '001': { stage: 0, stack: 0 },
    '003': { stage: 2, stack: 3 }
  },
  squad: [
    { id: 'op_a', name: '甲', profession: '近卫', subProfession: '领主', position: '近战',
      rarity: 6, avatar: 'a.png', panel: { hp: 3000, atk: 800, def: 400, res: 10, interval: 1.2, cost: 20, block: 2 },
      favor: { hp: 200, atk: 30, def: 20 }, useFavor: false, assignTarget: true },
    { id: 'op_b', name: '乙', profession: '狙击', subProfession: '速射', position: '远程',
      rarity: 4, avatar: '', panel: { hp: 1200, atk: 400, def: 100 }, favor: null,
      useFavor: true, assignTarget: false }
  ],
  ctx: { time: 45, hpPct: 80, ingots: 12, parts: 3, value: 5, allyCount: 6, skillOn: true,
         hasShield: false, firstDeploy: true, proc: false, profCounts: { 近卫: 2, 狙击: 1 } },
  presets: [{ name: '开局', ts: 1700000000000, ops: [{ name: '甲', panel: { hp: 1, atk: 1, def: 1 } }] }]
};

const archive = M.toArchive(state);
eq(archive.schemaVersion, M.VERSION, '写出去的是当前版本');
eq(M.detect(archive), 3, 'detect 认得出 v3');
deep(Object.keys(archive.tables).sort(), ['presets', 'selection', 'settings', 'squads'],
  '归档正好是四张用户表');
eq(archive.tables.squads[0].ord, 0, '编队写了 ord 列');
eq(archive.tables.squads[1].ord, 1, 'ord 按数组顺序递增');
eq(archive.tables.settings.length, Object.keys(state.ctx).length, '每个战斗状态项一行');

// 写出去的行必须能被 DDL 接住：不多列、不少列
Object.keys(archive.tables).forEach(name => {
  const def = S.get(name);
  const cols = Object.keys(def.columns).sort().join(',');
  const bad = archive.tables[name].filter(r => Object.keys(r).sort().join(',') !== cols);
  ok(bad.length === 0, name + ' 的行与 DDL 列一致',
     bad.length ? '首个不符：' + Object.keys(bad[0]).join(',') : '');
});

const back = M.normalize(JSON.parse(JSON.stringify(archive)));
deep(back.relics, state.relics, '藏品选择往返一致（含档位与层数）');
eq(back.squad.length, 2, '编队人数往返一致');
eq(back.squad[0].id, 'op_a', '编队顺序靠 ord 还原，第一条仍是 op_a');
eq(back.squad[1].id, 'op_b', '第二条仍是 op_b');
eq(back.squad[0].useFavor, false, 'useFavor=false 往返不丢');
eq(back.squad[0].assignTarget, true, 'assignTarget=true 往返不丢');
deep(back.squad[0].panel, state.squad[0].panel, '面板数值往返一致');
deep(back.squad[0].favor, state.squad[0].favor, '信赖加成往返一致');
eq(back.squad[1].favor, null, 'favor=null 往返仍是 null');
deep(back.ctx, state.ctx, '战斗状态（含布尔与职业人数）往返一致');
eq(back.presets.length, 1, '预设往返一致');
eq(back.presets[0].name, '开局', '预设名字往返一致');
deep(back.presets[0].ops, state.presets[0].ops, '预设内容往返一致');

// 顺序是最容易被表结构吃掉的东西，单独再压一次
const many = { squad: Array.from({ length: 12 }, (_, i) => ({ id: 'op_' + i, name: '干员' + i })) };
const manyBack = M.normalize(M.toArchive(many));
deep(manyBack.squad.map(o => o.id), many.squad.map(o => o.id), '12 人编队顺序原样还原');

// ---------------------------------------------------------------- 6. v2 兼容
console.log('=== 6. 旧格式（v2）兼容 ===');
const v2 = {
  schemaVersion: 2,
  relics: { '001': { stage: 1, stack: 2 } },
  squad: [{ name: '旧干员', panel: { hp: 100 } }],
  ctx: { time: 20 },
  presets: [{ name: '旧预设', ops: [] }]
};
eq(M.detect(v2), 2, 'detect 认得出 v2');
const v2back = M.normalize(v2);
deep(v2back.relics, v2.relics, 'v2 藏品原样读出');
eq(v2back.squad.length, 1, 'v2 编队原样读出');
eq(v2back.ctx.time, 20, 'v2 战斗状态原样读出');
eq(v2back.presets.length, 1, 'v2 预设原样读出');

const bare = [{ name: '裸数组干员', panel: { hp: 1 } }];
eq(M.detect(bare), 2, '裸数组被当成 v2');
deep(M.normalize(bare), { squad: bare }, '裸数组只还原编队，其余交给界面清空');

eq(M.detect(null), 0, 'null 无法识别');
eq(M.detect({ foo: 1 }), 0, '无版本特征的对象无法识别');
eq(M.normalize({ foo: 1 }), null, '无法识别时 normalize 返回 null');

// v2 存档升级一次之后就变成 v3：读旧写新，不回写旧格式
const upgraded = M.toArchive(M.normalize(v2));
eq(upgraded.schemaVersion, 3, '旧存档读入后写回即 v3');
eq(upgraded.tables.squads[0].name, '旧干员', '升级过程不丢干员');

// ---------------------------------------------------------------- 7. 统计
console.log('=== 7. 统计 ===');
const st7 = M.stats(archive);
eq(st7.selection, 2, 'stats.selection = 2');
eq(st7.squads, 2, 'stats.squads = 2');
eq(st7.presets, 1, 'stats.presets = 1');
eq(st7.settings, Object.keys(state.ctx).length, 'stats.settings = ' + st7.settings);
const dbStats = DB.stats();
ok(dbStats.relics === DB.table('relics').count() && !('selection' in dbStats),
   'DB.stats 只统计有数据的表');

// ---------------------------------------------------------------- 8. 用户表进运行时
console.log('=== 8. 用户表进运行时 DB ===');
eq(DB.table('squads').count(), 0, '装载产物后用户表是空的（还没读存档）');
M.install(archive.tables);
eq(DB.table('squads').count(), 2, 'install 之后 squads 有 2 行');
eq(DB.table('selection').count(), 2, 'install 之后 selection 有 2 行');
eq(DB.table('settings').get('time').value, 45, 'settings 按 key 主键查到 time=45');
eq(DB.table('selection').get('003').stack, 3, 'selection 按 relicId 查到层数');
eq(DB.table('squads').get('op_b').name, '乙', 'squads 按 id 查到干员');
eq(DB.table('squads').by('profession', '近卫').length, 1, 'squads 的二级索引可用');

const snap = M.snapshot();
eq(snap.schemaVersion, M.VERSION, 'snapshot 带版本号');
deep(snap.tables.squads, archive.tables.squads, 'snapshot 与 install 的行完全一致');
deep(snap.tables.selection, archive.tables.selection, 'selection 往返一致');
deep(M.normalize(snap), back, '从 DB 取回再 normalize，与从 JSON 取回等价');

// 只读表不允许从运行时写入：那会破坏「产物 = 官方数据」的前提
let roThrew = false;
try { DB.install('relics', []); } catch (e) { roThrew = /只读表/.test(e.message); }
ok(roThrew, 'DB.install 拒绝往只读表里写');

// install 之后再对账，只读表的行数不能受影响
ok(DB.check().ok, 'install 用户表后 DB.check() 仍然通过');
eq(DB.table('relics').count(), 251, '只读表行数未被 install 影响');

M.install({});   // 复位成空，别影响后续用例
eq(DB.table('squads').count(), 0, 'install 空表可以清空用户表');

console.log('');
console.log('数据层测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
