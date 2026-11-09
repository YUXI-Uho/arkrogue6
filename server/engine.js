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

/* 与 validate.js 同规则：全角空格 / 零宽字符 / 首尾空白都清掉。
 * calc 也可能被直接调用（测试、脚本），所以这里再归一化一次。 */
function normName(v) {
  if (typeof v !== 'string') return '';
  let t = v;
  if (typeof t.normalize === 'function') t = t.normalize('NFKC');
  return t.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
}

function resolveOperator(input) {
  const rawId = input.id ? String(input.id).trim() : '';

  // 1) 给了 id：以 id 为准（id 是数据表主键，不会误伤）
  if (rawId) {
    const row = OperatorRepo.getById(rawId);
    if (row) return { op: builtinOperator(row, input), resolved: true };
    if (!input.panel) return { op: null, resolved: false };
    return { op: customOperator(input), resolved: true };
  }

  // 2) 没给 id 但给了 panel：就是自定义干员，名字只用来显示。
  //    （有个同名内置干员也不能覆盖用户填的面板，否则「空白干员改个名字」会被悄悄换成官方数据）
  if (input.panel) return { op: customOperator(input), resolved: true };

  // 3) 只有名字：查内置；查不到就是写错了。
  //    以前这里会静默造一个全 0 面板，用户看到「攻击力 0」还以为算对了。
  const row = OperatorRepo.getByName(normName(input.name));
  return row ? { op: builtinOperator(row, input), resolved: true } : { op: null, resolved: false };
}

function compactItems(items, limit) {
  const total = items.length;
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
  return { items: out, total, truncated: total > limit };
}

const ITEM_LIMIT = 40;

function calc(payload) {
  const relics = payload.relics || [];
  const selection = relics.map(r => ({ id: r.id, stage: r.stage | 0, stack: r.stack | 0 }));
  const ctx = payload.ctx || {};

  const mods = E.buildModifiers(selection, RELIC_INDEX);

  // 计数只统计「真的生效了」的藏品：未知 id 不再混进 relics 里冒充生效
  const applied = [];
  const ignored = [];
  for (const sel of selection) {
    (RelicRepo.getById(sel.id) ? applied : ignored).push(sel.id);
  }

  const ops = [];
  const warnings = [];
  const unresolved = new Set();
  (payload.operators || []).forEach((input, index) => {
    const r = resolveOperator(input);
    if (r.resolved) {
      ops.push(r.op);
    } else {
      unresolved.add(index);
      ops.push(null);
      warnings.push({ index, name: input.name || '', reason: 'unknown_operator' });
    }
  });

  // 全是未知干员：这是输入错误，直接 400，而不是回一堆 0
  if (ops.length && unresolved.size === ops.length) {
    const err = new Error('这些干员查不到内置数据，也没有提供 panel');
    err.status = 400;
    err.code = 'unknown_operator';
    err.details = warnings;
    throw err;
  }

  const results = ops.map((op, index) => {
    if (!op) {
      return {
        id: null,
        name: (warnings.find(w => w.index === index) || {}).name || '',
        resolved: false,
        base: null,
        final: null,
        delta: null,
        inactive: [],
        unapplied: []
      };
    }
    const r = E.computeOperator(op, mods, ctx);
    const ina = compactItems(r.inactive, ITEM_LIMIT);
    const una = compactItems(r.unapplied, ITEM_LIMIT);
    return {
      id: op.id,
      name: op.name,
      resolved: true,
      base: r.base,
      final: r.final,
      delta: r.delta,
      inactive: ina.items,
      inactiveTotal: ina.total,
      inactiveTruncated: ina.truncated,
      unapplied: una.items,
      unappliedTotal: una.total,
      unappliedTruncated: una.truncated
    };
  });

  const sum = E.summarize(mods, ctx);
  const summary = { panel: {}, combat: {}, run: {}, special: [], unapplied: [] };
  for (const bucket of ['panel', 'combat', 'run']) {
    for (const key of Object.keys(sum[bucket])) {
      const rec = sum[bucket][key];
      if (!rec || (!rec.flat && !rec.pct && !rec.items.length)) continue;
      const it = compactItems(rec.items, ITEM_LIMIT);
      summary[bucket][key] = {
        flat: rec.flat,
        pct: rec.pct,
        items: it.items,
        itemsTotal: it.total,
        itemsTruncated: it.truncated
      };
    }
  }
  summary.special = (sum.special || []).slice(0, 120).map(m => ({
    relicId: m.relicId, relicName: m.relicName, text: m.text
  }));
  const sumUna = compactItems(sum.unapplied, ITEM_LIMIT);
  summary.unapplied = sumUna.items;
  summary.unappliedTotal = sumUna.total;
  summary.unappliedTruncated = sumUna.truncated;

  const firstOp = ops.find(Boolean) || null;
  const damage = payload.damage
    ? E.estimateDamage(payload.damage, mods, ctx, firstOp)
    : null;

  return {
    ok: true,
    counts: {
      requested: selection.length,
      applied: applied.length,
      ignored,
      relics: applied.length,
      operators: ops.length,
      mods: mods.length
    },
    warnings,
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
