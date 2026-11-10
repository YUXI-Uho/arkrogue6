'use strict';
/* 输入校验：后端一旦接受外部输入，就必须假设对方是恶意的。
 * 原则：只白名单字段、全部夹范围、长度/数量有上限，绝不让客户端决定内存与计算量。
 *
 * 面板字段**不再在这里列一遍**：以前 server/validate.js 的 PANEL_RANGE 和
 * server/engine.js 的 PANEL_KEYS 各写了一份，和 core/schema.js 三份并存，
 * 新增属性时后端会静默丢字段。现在 key 从 ArkSchema 派生，本文件只保留「范围策略」
 * （这是安全边界，不是数据定义），check_enums.py 会盯着这一点。
 */
if (!globalThis.ArkSchema) require('../core/schema.js');
const S = globalThis.ArkSchema;

const LIMITS = {
  maxRelics: 300,
  maxOperators: 12,
  maxBody: 64 * 1024,
  idLen: 48,
  nameLen: 40,
  profLen: 12
};

/* 只给「范围与默认 0~1e6 不同」的字段写覆盖，其余按默认夹。
 * 这些数字是服务端保护阈值，不是游戏规则，所以留在这一层。 */
const PANEL_BOUNDS = {
  res: [0, 100],
  aspd: [0, 1000],
  block: [0, 10],
  cost: [0, 99],
  interval: [0, 10],
  spRecover: [0, 10],
  initSp: [0, 99],
  redeploy: [0, 999]
};

const DEFAULT_BOUNDS = [0, 1e6];

function boundsOf(key) {
  return PANEL_BOUNDS[key] || DEFAULT_BOUNDS;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/* 干员名归一化：全角空格、零宽字符、首尾空白都清掉。
 * 以前「玛恩纳 」这种输入查不到内置数据，会静默降级成 0 面板。 */
function normName(v) {
  if (typeof v !== 'string') return '';
  var s = v;
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  return s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
}

function bad(status, error) {
  return { ok: false, status, error };
}

function validateCalc(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad(400, 'body 必须是 JSON 对象');
  }

  const relics = body.relics;
  if (relics != null && !Array.isArray(relics)) return bad(400, 'relics 必须是数组');
  if (relics && relics.length > LIMITS.maxRelics) {
    return bad(413, 'relics 超过上限 ' + LIMITS.maxRelics);
  }

  const outRelics = [];
  // id -> "stage|stack"。完全相同的重复直接去重；
  // 同 id 不同档位/层数说明客户端状态自相矛盾，必须报出来，不能静默取第一个。
  const seen = new Map();
  for (const r of relics || []) {
    if (!r || typeof r !== 'object') return bad(400, 'relics 元素必须是对象');
    const id = str(r.id, LIMITS.idLen);
    if (!id) return bad(400, 'relics[].id 必填');
    const stage = clampNum(r.stage, 0, 3, 0);
    const stack = clampNum(r.stack, 0, 999, 0);
    const sig = stage + '|' + stack;
    if (seen.has(id)) {
      if (seen.get(id) !== sig) {
        return bad(400, '同一藏品出现了不同的档位/层数：' + id + '（' + seen.get(id) + ' vs ' + sig + '）');
      }
      continue;
    }
    seen.set(id, sig);
    outRelics.push({ id, stage, stack });
  }

  const ops = body.operators;
  if (ops != null && !Array.isArray(ops)) return bad(400, 'operators 必须是数组');
  if (ops && ops.length > LIMITS.maxOperators) {
    return bad(413, 'operators 超过上限 ' + LIMITS.maxOperators);
  }

  const outOps = [];
  for (const o of ops || []) {
    if (!o || typeof o !== 'object') return bad(400, 'operators 元素必须是对象');
    const item = {
      id: o.id ? str(o.id, LIMITS.idLen) : '',
      name: o.name ? str(normName(o.name), LIMITS.nameLen) : '',
      profession: o.profession ? str(o.profession, LIMITS.profLen) : '',
      subProfession: o.subProfession ? str(o.subProfession, LIMITS.profLen) : '',
      position: o.position === 'RANGED' || o.position === '远程位' ? '远程位' : '近战位',
      useFavor: o.useFavor !== false,
      assignTarget: !!o.assignTarget
    };
    if (!item.id && !item.name && !o.panel) {
      return bad(400, 'operators[] 需要 id / name / panel 之一');
    }
    if (o.panel != null) {
      if (typeof o.panel !== 'object' || Array.isArray(o.panel)) return bad(400, 'operators[].panel 必须是对象');
      const panel = {};
      // 白名单 = schema 里「能结算到面板」的字段；不在表里的键一律丢掉
      for (const k of S.SETTLED_KEYS) {
        const [min, max] = boundsOf(k);
        panel[k] = clampNum(o.panel[k], min, max, 0);
      }
      item.panel = panel;
    }
    outOps.push(item);
  }

  if (body.ctx != null && (typeof body.ctx !== 'object' || Array.isArray(body.ctx))) {
    return bad(400, 'ctx 必须是对象');
  }
  const c = body.ctx || {};
  // 职业人数只认八大职业：以前任何键都会写进对象（__proto__ / constructor 也进得来），
  // 虽然值被夹成数字、没造成原型污染，但对象会变脏、也掩盖了客户端 bug。
  const PROFESSIONS = (globalThis.ArkEnums && globalThis.ArkEnums.PROFESSIONS) || null;
  const profCounts = {};
  if (c.profCounts && typeof c.profCounts === 'object') {
    for (const k of Object.keys(c.profCounts).slice(0, 24)) {
      const key = str(k, LIMITS.profLen);
      if (PROFESSIONS && PROFESSIONS.indexOf(key) < 0) continue;
      profCounts[key] = clampNum(c.profCounts[k], 0, 20, 0);
    }
  }
  const ctx = {
    time: clampNum(c.time, 0, 3600, 0),
    hpPct: clampNum(c.hpPct, 0, 100, 100),
    ingots: clampNum(c.ingots, 0, 99999, 0),
    parts: clampNum(c.parts, 0, 999, 0),
    value: clampNum(c.value, 0, 99999, 0),
    allyCount: clampNum(c.allyCount, 0, 20, 0),
    skillOn: !!c.skillOn,
    hasShield: !!c.hasShield,
    firstDeploy: c.firstDeploy !== false,
    proc: !!c.proc,
    profCounts
  };

  let damage = null;
  if (body.damage != null && (typeof body.damage !== 'object' || Array.isArray(body.damage))) {
    return bad(400, 'damage 必须是对象');
  }
  if (body.damage) {
    damage = {
      atk: clampNum(body.damage.atk, 0, 1e6, 0),
      scale: clampNum(body.damage.scale, 0, 100, 1),
      def: clampNum(body.damage.def, 0, 1e6, 0),
      res: clampNum(body.damage.res, 0, 100, 0)
    };
  }

  return { ok: true, value: { relics: outRelics, operators: outOps, ctx, damage } };
}

module.exports = { validateCalc, LIMITS, PANEL_BOUNDS };
