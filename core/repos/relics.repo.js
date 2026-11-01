/* ============================================================================
 * core/repos/relics.repo.js — 藏品仓储层
 * ============================================================================
 * 数据来自 core/db/db.js 的 relics / relic_stages 两张表。表里是规范化的：
 *   藏品一行（id / name / category / rarity / … / stageCount）
 *   档位多行（relicId + stage 复合主键）
 * 这一层负责把两张表 join 回引擎要的嵌套形状 {…, stages:[…]}，并缓存 join 结果，
 * 引擎和界面都不用关心表是怎么拆的。
 *
 * 界面层只通过本模块读藏品、做筛选、做选择态转换，禁止再直接摸 window.IS6_DB。
 *
 * 对外 API
 *   RelicRepo.init(db)                 传入 DB（默认 window.DB）
 *   RelicRepo.all()                    全量（副本）
 *   RelicRepo.getById(id)              含 stages 的完整对象
 *   RelicRepo.index()                  {id: relic}，给 engine.buildModifiers 用
 *   RelicRepo.filter(opts)             opts: {search, category, rarity,
 *                                            onlySelected, onlyMatched, selectedMap,
 *                                            onlyRelevant, operators}
 *   RelicRepo.affectsAny(relic, ops)   这件藏品会不会作用到这支队伍（宁多勿少）
 *   RelicRepo.toSelection(stateRelics) {id:{stage,stack}} → [{id,stage,stack}]
 *   RelicRepo.sanitizeSelection(raw)   导入/存档校验：丢掉未知 id、夹紧数值
 * ==========================================================================*/
(function (global) {
  'use strict';

  var list = [];
  var byId = Object.create(null);
  var hayCache = Object.create(null);

  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }

  function init(db) {
    var D = db || global.DB;
    if (!D || !D.isLoaded()) {
      throw new Error('RelicRepo.init 需要已装载的 DB（core/db/db.js）');
    }
    var relicRows = D.table('relics').all();
    var stageRows = D.table('relic_stages').all();

    // 档位按 relicId 归拢，同一件藏品内按 stage 升序（表是无序的）
    var stagesOf = Object.create(null);
    stageRows.forEach(function (s) {
      (stagesOf[s.relicId] || (stagesOf[s.relicId] = [])).push(s);
    });
    Object.keys(stagesOf).forEach(function (rid) {
      stagesOf[rid].sort(function (a, b) { return a.stage - b.stage; });
    });

    list = relicRows.map(function (r) {
      // join：表里拆开的两部分在这里合回引擎认识的形状
      var joined = {};
      Object.keys(r).forEach(function (k) { joined[k] = r[k]; });
      joined.stages = (stagesOf[r.id] || []).map(function (s) {
        return { idx: s.stage, name: s.name, text: s.text, mods: s.mods || [],
                 special: s.special || [], parsed_by: s.parsedBy || '' };
      });
      return joined;
    });

    byId = Object.create(null);
    hayCache = Object.create(null);
    list.forEach(function (r) {
      if (r && r.id) byId[r.id] = r;
    });
    return list.length;
  }

  function all() { return list.slice(); }
  function getById(id) { return byId[id] || null; }
  function index() { return byId; }

  // 搜索用的拼接串缓存：251 件藏品每次按键都拼一遍太浪费
  function haystack(r) {
    if (hayCache[r.id] != null) return hayCache[r.id];
    var parts = [r.id, r.name, r.effect || '', r.desc || '', r.category || ''];
    (r.stages || []).forEach(function (s) {
      parts.push(s.name || '', s.text || '');
    });
    var h = parts.join(' ').toLowerCase();
    hayCache[r.id] = h;
    return h;
  }

  // 「可计算」= 引擎能解析出至少一条修正项
  function hasMods(r) {
    var E = global.RelicEngine;
    if (!E) return true;
    return E.parseRelic(r, 0).mods.length > 0;
  }

  // 「这件藏品会不会作用到本队」——给「只看影响本队」用。
  // 判据宁多勿少：条件类、跨藏品前置、敌方作用域、纯特殊效果，一律保留。
  // 误留只是多一件要划过去，误藏会让玩家以为藏品没生效。
  function affectsAny(r, ops) {
    var E = global.RelicEngine;
    if (!E || !ops || !ops.length) return true;
    var parsed = E.parseRelic(r, 0);
    if (!parsed.mods.length) return true;            // 招募/掉落/结局类：仍然要能记录
    for (var i = 0; i < parsed.mods.length; i++) {
      var m = parsed.mods[i];
      if (m.bucket === 'special') return true;
      if (m.scope && m.scope.base === 'enemy') return true;
      if (m.cond) {
        var c = m.cond;
        if (c.type === 'hasRelic') return true;
        // 复合条件里可能嵌着 hasRelic，展开一层看
        if (c.type === 'all' && c.of) {
          for (var k = 0; k < c.of.length; k++) {
            if (c.of[k] && c.of[k].type === 'hasRelic') return true;
          }
        }
      }
      for (var j = 0; j < ops.length; j++) {
        if (E.scopeCovers(m.scope, ops[j])) return true;
      }
    }
    return false;
  }

  function filter(opts) {
    opts = opts || {};
    var q = String(opts.search || '').trim().toLowerCase();
    var cat = opts.category || '全部';
    var rarity = (opts.rarity == null) ? '' : String(opts.rarity);
    var sel = opts.selectedMap || {};
    var ops = opts.operators || [];

    return list.filter(function (r) {
      if (!r) return false;
      if (cat !== '全部' && r.category !== cat) return false;
      if (rarity !== '' && String(r.rarity) !== rarity) return false;
      if (opts.onlySelected && !sel[r.id]) return false;
      if (opts.onlyMatched && !hasMods(r)) return false;
      // 已选中的藏品永远不隐藏：否则玩家取消不了它
      if (opts.onlyRelevant && !sel[r.id] && !affectsAny(r, ops)) return false;
      if (q && haystack(r).indexOf(q) < 0) return false;
      return true;
    });
  }

  // 选择态 → 引擎输入；未知 id 直接丢掉（导入脏数据时不留炸弹）
  function toSelection(stateRelics) {
    var map = stateRelics || {};
    var out = [];
    Object.keys(map).forEach(function (id) {
      if (!byId[id]) return;
      var v = map[id] || {};
      out.push({ id: id, stage: num(v.stage), stack: num(v.stack) });
    });
    return out;
  }

  function sanitizeSelection(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      if (!byId[id]) return;
      var v = raw[id] || {};
      out[id] = {
        stage: Math.max(0, Math.floor(num(v.stage))),
        stack: Math.max(0, Math.floor(num(v.stack)))
      };
    });
    return out;
  }

  global.RelicRepo = {
    init: init,
    all: all,
    getById: getById,
    index: index,
    filter: filter,
    affectsAny: affectsAny,
    toSelection: toSelection,
    sanitizeSelection: sanitizeSelection
  };
})(typeof window !== 'undefined' ? window : globalThis);
