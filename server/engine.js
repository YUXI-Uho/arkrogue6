'use strict';
/* 计算核心：与浏览器共用同一套 core/ + js/ 实现，并且读**同一份表产物**。
 *
 * 以前的实现直接 require data/relics.json + data/operators.json（中间产物），
 * 和前端读的 data/is6db.js 是两条链路：只重装表、没重跑 build_operators.py 时，
 * 两边会算出不同结果，而后端连版本号都不校验。现在统一走 DB + 仓储层：
 *
 *   data/is6db.json → DB.load → OperatorRepo / RelicRepo → engine
 *
 * 顺带得到两个保证：
 *   - 产物 schemaVersion 高于代码时直接抛错（DB.load 里的护栏，后端不再例外）；
 *   - 面板字段只有 core/schema.js 一份，server 不再自己维护 PANEL_KEYS。
 *
 * 依赖顺序与 index.html 的 <script> 顺序一致：schema → enums → db/schema → 引擎 → db → 仓储。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'core/schema.js'));
require(path.join(ROOT, 'core/enums.js'));
require(path.join(ROOT, 'core/db/schema.js'));
require(path.join(ROOT, 'js/effects.js'));
require(path.join(ROOT, 'js/engine.js'));
require(path.join(ROOT, 'core/db/db.js'));
require(path.join(ROOT, 'core/repos/operators.repo.js'));
require(path.join(ROOT, 'core/repos/relics.repo.js'));

const E = globalThis.RelicEngine;
const S = globalThis.ArkSchema;
const DB = globalThis.DB;
const OperatorRepo = globalThis.OperatorRepo;
const RelicRepo = globalThis.RelicRepo;

const ARTIFACT = require(path.join(ROOT, 'data/is6db.json'));

/* 装载失败就不启动：后端算错比不启动更难排查。 */
try {
  DB.load(ARTIFACT);
  OperatorRepo.init(DB);
  RelicRepo.init(DB);
} catch (err) {
  console.error('[is6-api] 数据产物装载失败：' + (err && err.message ? err.message : err));
  throw err;
}

const SELF_CHECK = DB.check();
if (!SELF_CHECK.ok) {
  console.error('[is6-api] 产物自检未通过：\n  - ' + SELF_CHECK.issues.join('\n  - '));
  throw new Error('data/is6db.json 与 meta.counts 不一致，请运行 python tools/update_db.py');
}

const RELIC_INDEX = RelicRepo.index();
const META = DB.meta();

/* 内置干员：走仓储的 makeSquadEntry → toCalcInput，信赖/默认值/字段清单全部复用前端那一套 */
function builtinOperator(row, input) {
  const entry = OperatorRepo.makeSquadEntry(row);
  entry.useFavor = input.useFavor !== false;
  entry.assignTarget = !!input.assignTarget;
  const op = OperatorRepo.toCalcInput(entry);
  op.id = row.id;
  return op;
}

/* 自定义干员：面板已在 validate 里按 schema 白名单夹过范围 */
function customOperator(input) {
  const op = OperatorRepo.toCalcInput({
    name: String(input.name || '自定义干员').slice(0, 40),
    profession: input.profession || '近卫',
    subProfession: input.subProfession || '',
    position: input.position || '近战位',
    panel: input.panel,
    useFavor: false,
    assignTarget: !!input.assignTarget
  });
  op.id = null;
  return op;
}

function resolveOperator(input) {
  const row = (input.id && OperatorRepo.getById(input.id)) ||
    (input.name && OperatorRepo.getByName(input.name)) || null;
  return row ? builtinOperator(row, input) : customOperator(input);
}

function compactItems(items, limit) {
  const out = [];
  for (const it of items) {
    if (out.length >= limit) break;
    out.push({
      relicId: it.relicId,
      relicName: it.relicName,
      stat: it.stat,
      label: it.label,
      value: it.value,
      pct: !!it.pct,
      scope: it.scope,
      ok: it.ok !== false,
      reason: it.reason || ''
    });
  }
  return out;
}

const ITEM_LIMIT = 40;

function calc(payload) {
  const relics = payload.relics || [];
  const selection = relics.map(r => ({ id: r.id, stage: r.stage | 0, stack: r.stack | 0 }));
  const ctx = payload.ctx || {};

  const mods = E.buildModifiers(selection, RELIC_INDEX);

  const ops = (payload.operators || []).map(resolveOperator);
  const results = ops.map(op => {
    const r = E.computeOperator(op, mods, ctx);
    return {
      id: op.id,
      name: op.name,
      base: r.base,
      final: r.final,
      delta: r.delta,
      inactive: compactItems(r.inactive, ITEM_LIMIT),
      unapplied: compactItems(r.unapplied, ITEM_LIMIT)
    };
  });

  const sum = E.summarize(mods, ctx);
  const summary = { panel: {}, combat: {}, run: {}, special: [], unapplied: [] };
  for (const bucket of ['panel', 'combat', 'run']) {
    for (const key of Object.keys(sum[bucket])) {
      const rec = sum[bucket][key];
      if (!rec || (!rec.flat && !rec.pct && !rec.items.length)) continue;
      summary[bucket][key] = {
        flat: rec.flat,
        pct: rec.pct,
        items: compactItems(rec.items, ITEM_LIMIT)
      };
    }
  }
  summary.special = (sum.special || []).slice(0, 120).map(m => ({
    relicId: m.relicId, relicName: m.relicName, text: m.text
  }));
  summary.unapplied = compactItems(sum.unapplied, ITEM_LIMIT);

  const damage = payload.damage
    ? E.estimateDamage(payload.damage, mods, ctx, ops[0])
    : null;

  return {
    ok: true,
    counts: { relics: selection.length, operators: ops.length, mods: mods.length },
    operators: results,
    summary,
    damage
  };
}

module.exports = {
  calc,
  meta() {
    return {
      relics: RelicRepo.all().length,
      operators: OperatorRepo.all().length,
      // schemaVersion 是属性注册表版本（core/schema.js），tableVersion 是产物/表结构版本，
      // 两者含义不同，以前只回一个字符串，调用方分不清是哪一层。
      schemaVersion: S.version,
      tableVersion: META.schemaVersion,
      dataHash: META.dataHash,
      builtAt: META.builtAt,
      gameVersion: META.gameVersion,
      ranges: DB.table('ranges').count()
    };
  }
};
