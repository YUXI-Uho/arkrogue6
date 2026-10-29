/* ============================================================================
 * core/repos/operators.repo.js — 干员仓储层
 * ============================================================================
 * 职责：把「三种干员表示」收敛到这一层
 *   OPERATOR_DATA[i]  扁平：{hp, atk, def, ..., favor}
 *        ↓ makeSquadEntry()  内置干员 → 编队条目（复制面板 + 信赖 + uid）
 *   squad[i]          {panel:{...}, favor, useFavor, assignTarget}
 *        ↓ toCalcInput()     编队条目 → 引擎输入（叠加信赖、补默认值）
 *   engine 的 op      {name, profession, subProfession, position, panel, ...}
 *
 * 界面层只准通过本模块取干员、做转换，禁止再直接读 window.IS6_DB。
 *
 * 对外 API
 *   OperatorRepo.init(db)                   传入 DB（默认 window.DB），读 operators 表
 *   OperatorRepo.all()                      全量（副本）
 *   OperatorRepo.getByName(name)
 *   OperatorRepo.search(query, filter)      filter: {profession, rarity, subProfession}
 *                                           rarity 支持 6 / '6' / '4-'（4 星及以下）
 *   OperatorRepo.toCalcInput(entry, opts)   编队条目 → 引擎输入
 *   OperatorRepo.makeSquadEntry(entry)      内置干员 → 编队条目
 *   OperatorRepo.makeBlankEntry(squad)      空白干员（squad 用于生成不重名的默认名字）
 *   OperatorRepo.defaultPanel()             空白面板（按 ArkSchema.PANEL_FIELDS 生成）
 * ==========================================================================*/
(function (global) {
  'use strict';

  var S = global.ArkSchema;
  var EN = global.ArkEnums;
  if (!S || !EN) {
    throw new Error('core/repos/operators.repo.js 依赖 core/schema.js 与 core/enums.js');
  }

  var list = [];
  var byName = Object.create(null);

  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }
  function uid() { return 'op_' + Math.random().toString(36).slice(2, 8); }

  // ---------- 数据装载 ----------
  function init(db) {
    var D = db || global.DB;
    if (!D || !D.isLoaded()) {
      throw new Error('OperatorRepo.init 需要已装载的 DB（core/db/db.js）');
    }
    // operators 表是扁平的：面板字段直接就是列（hp / atk / def …），
    // flatPanel() 按 PANEL_FIELDS 逐列取值，不需要再拆嵌套。
    list = D.table('operators').all();
    byName = Object.create(null);
    list.forEach(function (o) {
      if (o && o.name) byName[o.name] = o;
    });
    return list.length;
  }

  function all() { return list.slice(); }

  function getByName(name) { return byName[name] || null; }

  // ---------- 检索 ----------
  // rarity 语义：'' / null 不过滤；6 精确；'4-' 表示 4 星及以下
  function rarityHit(r, want) {
    if (want == null || want === '') return true;
    var s = String(want);
    if (s.charAt(s.length - 1) === '-') return (r || 0) <= (+s.slice(0, -1) || 0);
    return (r || 0) === +s;
  }

  function search(query, filter) {
    filter = filter || {};
    var q = String(query || '').trim().toLowerCase();
    var hits = list.filter(function (o) {
      if (!o) return false;
      if (filter.profession && o.profession !== filter.profession) return false;
      if (filter.subProfession && o.subProfession !== filter.subProfession) return false;
      if (!rarityHit(o.rarity, filter.rarity)) return false;
      if (!q) return true;
      var hay = (o.name + ' ' + (o.profession || '') + ' ' + (o.subProfession || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    // 稳定排序：星级高的在前，同星级按名字
    hits.sort(function (a, b) {
      return (b.rarity || 0) - (a.rarity || 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return hits;
  }

  // ---------- 表示转换 ----------
  function defaultPanel() {
    var p = {};
    S.PANEL_FIELDS.forEach(function (f) { p[f.key] = 0; });
    // 这几个字段为 0 会让引擎算出 0 间隔 / 0 技力回复这类无意义值；
    // 干员本身至少阻挡 1 名敌人，所以按「先全 0、再显式覆盖默认值」的写法给。
    // （旧写法 `if (p.block == null)` 永远不成立，因为上面已经把它置 0 了。）
    var defaults = { block: 1, aspd: 100, spRecover: 1, interval: 1.0, redeploy: 70 };
    Object.keys(defaults).forEach(function (k) { p[k] = defaults[k]; });
    return p;
  }

  // 扁平干员数据 → 面板对象
  function flatPanel(src) {
    var p = {};
    S.PANEL_FIELDS.forEach(function (f) { p[f.key] = num(src[f.key]); });
    if (!p.aspd) p.aspd = 100;
    if (!p.spRecover) p.spRecover = 1;
    if (!p.interval) p.interval = 1.0;
    if (!p.redeploy) p.redeploy = 70;
    return p;
  }

  // 编队条目 → 引擎输入。领域逻辑（信赖叠加、攻速兜底）住在这里，不再留在 UI。
  function toCalcInput(entry, opts) {
    var e = entry || {};
    var src = (e.panel && typeof e.panel === 'object') ? e.panel : flatPanel(e);
    var p = {};
    S.PANEL_KEYS.forEach(function (k) { p[k] = num(src[k]); });

    if (e.useFavor !== false && e.favor) {
      p.hp = num(p.hp) + num(e.favor.hp);
      p.atk = num(p.atk) + num(e.favor.atk);
      p.def = num(p.def) + num(e.favor.def);
    }
    if (!p.aspd) p.aspd = 100;

    return {
      name: e.name || '未命名',
      profession: e.profession || '',
      subProfession: e.subProfession || '',
      position: e.position || '近战位',
      panel: p,
      assignTarget: !!e.assignTarget,
      summon: !!e.summon
    };
  }

  function makeSquadEntry(entry) {
    var src = entry || {};
    return {
      id: uid(),
      name: src.name || '未命名',
      profession: src.profession || '',
      subProfession: src.subProfession || '',
      position: src.position || '近战位',
      rarity: num(src.rarity),
      avatar: src.avatar || '',
      panel: flatPanel(src),
      favor: src.favor ? { hp: num(src.favor.hp), atk: num(src.favor.atk), def: num(src.favor.def) }
        : { hp: 0, atk: 0, def: 0 },
      useFavor: true,
      assignTarget: false,
      summon: !!src.summon
    };
  }

  // 空白干员的名字必须能重复添加：新干员 / 新干员 2 / 新干员 3…
  // 取「当前编队里没被占用的最小序号」，否则第二次会被 SquadRepo 的按名判重拒绝。
  function blankName(squad) {
    var taken = Object.create(null);
    (squad || []).forEach(function (o) {
      if (o && o.name) taken[o.name] = 1;
    });
    if (!taken['新干员']) return '新干员';
    for (var i = 2; i < 1000; i++) {
      if (!taken['新干员 ' + i]) return '新干员 ' + i;
    }
    return '新干员 ' + Date.now();
  }

  function makeBlankEntry(squad) {
    return {
      id: uid(),
      name: blankName(squad),
      profession: '近卫',
      subProfession: '',
      position: '近战位',
      rarity: 0,
      avatar: '',
      panel: defaultPanel(),
      favor: null,
      useFavor: false,
      assignTarget: false,
      summon: false
    };
  }

  global.OperatorRepo = {
    init: init,
    all: all,
    getByName: getByName,
    search: search,
    toCalcInput: toCalcInput,
    makeSquadEntry: makeSquadEntry,
    makeBlankEntry: makeBlankEntry,
    defaultPanel: defaultPanel
  };
})(typeof window !== 'undefined' ? window : globalThis);
