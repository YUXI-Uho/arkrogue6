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
eq(S.NAMES.length, 7, '共 7 张表');
eq(S.GAME_TABLES.length, 3, '官方数据表 3 张（relics / relic_stages / operators）');
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

  // 主键唯一性由 Table 构造时的 _pk 保证，这里反向确认没有丢行
  eq(rows.length, new Set(rows.map(r => S.pkOf(name, r))).size, name + ' 主键无重复');
});

// 行数下限：官方数据只会变多不会凭空缩水，掉太多说明生成器坏了
ok(DB.table('relics').count() >= 251, '藏品 ≥ 251（实际 ' + DB.table('relics').count() + '）');
ok(DB.table('relic_stages').count() >= 251, '藏品档位 ≥ 251（实际 ' + DB.table('relic_stages').count() + '）');
ok(DB.table('operators').count() >= 450, '干员 ≥ 450（实际 ' + DB.table('operators').count() + '）');

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