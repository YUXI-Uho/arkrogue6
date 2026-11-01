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
 *   OperatorRepo.getById(id)                后端按 id 解析内置干员时用
 *   OperatorRepo.search(query, filter)      filter: {profession, rarity, subProfession}
 *                                           rarity 支持 6 / '6' / '4-'（4 星及以下）
 *   OperatorRepo.toCalcInput(entry, opts)   编队条目 → 引擎输入
 *   OperatorRepo.makeSquadEntry(entry)      内置干员 → 编队条目
 *   OperatorRepo.makeBlankEntry(squad)      空白干员（squad 用于生成不重名的默认名字）
 *   OperatorRepo.defaultPanel()             空白面板（按 ArkSchema.PANEL_FIELDS 生成）
 *
 * 详情（精英化 / 技能 / 天赋 / 模组 / 攻击范围）
 *   OperatorRepo.detail(idOrName)           合并后的完整干员，缺的键给空数组
 *   OperatorRepo.phasesOf(id)               三档面板，按 elite 升序
 *   OperatorRepo.skillsOf(id)               技能，按 slot 升序
 *   OperatorRepo.talentsOf(id)              天赋，按 idx 升序
 *   OperatorRepo.modulesOf(id)              模组（含三档加成与效果文案）
 *   OperatorRepo.rangeOf(rangeId)           {id, direction, grids:[[row,col]]}
 *   OperatorRepo.panelAt(id, elite)         某个精英化阶段的扁平面板（给「按此阶段填入」用）
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
  var byId = Object.create(null);
  // 详情四张表按干员 id 分组：装载时一次建好，详情页打开时不再扫全表
  var phasesOf = Object.create(null);
  var skillsOf = Object.create(null);
  var talentsOf = Object.create(null);
  var modulesOf = Object.create(null);
  var moduleLevels = Object.create(null);
  var rangeById = Object.create(null);

  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }
  function uid() { return 'op_' + Math.random().toString(36).slice(2, 8); }

  function push(map, key, row) {
    (map[key] || (map[key] = [])).push(row);
  }

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
    byId = Object.create(null);
    phasesOf = Object.create(null);
    skillsOf = Object.create(null);
    talentsOf = Object.create(null);
    modulesOf = Object.create(null);
    moduleLevels = Object.create(null);
    rangeById = Object.create(null);

    list.forEach(function (o) {
      if (!o) return;
      if (o.name) byName[o.name] = o;
      if (o.id) byId[o.id] = o;
    });

    if (D.has('operator_phases')) {
      D.table('operator_phases').all().forEach(function (r) { push(phasesOf, r.id, r); });
      Object.keys(phasesOf).forEach(function (k) {
        phasesOf[k].sort(function (a, b) { return num(a.elite) - num(b.elite); });
      });
    }
    if (D.has('operator_skills')) {
      D.table('operator_skills').all().forEach(function (r) { push(skillsOf, r.id, r); });
      Object.keys(skillsOf).forEach(function (k) {
        skillsOf[k].sort(function (a, b) { return num(a.slot) - num(b.slot); });
      });
    }
    if (D.has('operator_talents')) {
      D.table('operator_talents').all().forEach(function (r) { push(talentsOf, r.id, r); });
      Object.keys(talentsOf).forEach(function (k) {
        talentsOf[k].sort(function (a, b) { return num(a.idx) - num(b.idx); });
      });
    }
    if (D.has('operator_module_levels')) {
      D.table('operator_module_levels').all().forEach(function (r) {
        push(moduleLevels, r.id + '\u0001' + r.moduleId, r);
      });
      Object.keys(moduleLevels).forEach(function (k) {
        moduleLevels[k].sort(function (a, b) { return num(a.level) - num(b.level); });
      });
    }
    if (D.has('operator_modules')) {
      D.table('operator_modules').all().forEach(function (r) {
        var row = {};
        Object.keys(r).forEach(function (k) { row[k] = r[k]; });
        row.levels = moduleLevels[r.id + '\u0001' + r.moduleId] || [];
        push(modulesOf, r.id, row);
      });
    }
    if (D.has('ranges')) {
      D.table('ranges').all().forEach(function (r) { rangeById[r.id] = r; });
    }
    return list.length;
  }

  function all() { return list.slice(); }

  function getByName(name) { return byName[name] || null; }
  function getById(id) { return byId[id] || null; }

  // ---------- 详情 ----------
  // 详情页可以按 id 也可以按名字打开：编队里存的是名字（玩家可改），
  // 图鉴里拿得到 id，两个入口都要能走通。
  function resolve(ref) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref.id ? (byId[ref.id] || null) : null;
    return byId[ref] || byName[ref] || null;
  }

  function phasesOfOp(ref) {
    var o = resolve(ref);
    return o ? (phasesOf[o.id] || []).slice() : [];
  }
  function skillsOfOp(ref) {
    var o = resolve(ref);
    return o ? (skillsOf[o.id] || []).slice() : [];
  }
  function talentsOfOp(ref) {
    var o = resolve(ref);
    return o ? (talentsOf[o.id] || []).slice() : [];
  }
  function modulesOfOp(ref) {
    var o = resolve(ref);
    return o ? (modulesOf[o.id] || []).slice() : [];
  }

  function rangeOf(rangeId) { return rangeById[rangeId] || null; }

  function detail(ref) {
    var o = resolve(ref);
    if (!o) return null;
    var out = {};
    Object.keys(o).forEach(function (k) { out[k] = o[k]; });
    out.phases = phasesOfOp(o);
    out.skills = skillsOfOp(o);
    out.talents = talentsOfOp(o);
    out.modules = modulesOfOp(o);
    out.range = rangeOf(o.rangeId);
    return out;
  }

  // 某个精英化阶段的扁平面板 —— 详情页的「按此阶段填入编队」用它，
  // 让玩家能拿 E1 面板去算，而不用手抄一遍数值。
  function panelAt(ref, elite) {
    var rows = phasesOfOp(ref);
    var hit = null;
    rows.forEach(function (r) { if (num(r.elite) === num(elite)) hit = r; });
    if (!hit) return null;
    return flatPanel(hit);
  }

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

  // 信赖加成两种来源都要认：
  //   operators 表是拍平的列（favorHp/favorAtk/favorDef）
  //   旧格式/预设里是嵌套的 favor:{hp,atk,def}
  // 只读 src.favor 会让「从表里拿到的干员」信赖恒为 0 —— 面板整体偏低且勾选框不显示。
  function favorOf(src) {
    if (src && src.favor && typeof src.favor === 'object') {
      return { hp: num(src.favor.hp), atk: num(src.favor.atk), def: num(src.favor.def) };
    }
    if (src && (src.favorHp != null || src.favorAtk != null || src.favorDef != null)) {
      return { hp: num(src.favorHp), atk: num(src.favorAtk), def: num(src.favorDef) };
    }
    return null;
  }

  // panel 可传：详情页「按此精英化阶段填入」时用该阶段的面板，不传就用最高档
  function makeSquadEntry(entry, panel) {
    var src = entry || {};
    var fav = favorOf(src);
    return {
      id: uid(),
      name: src.name || '未命名',
      profession: src.profession || '',
      subProfession: src.subProfession || '',
      position: src.position || '近战位',
      rarity: num(src.rarity),
      avatar: src.avatar || '',
      panel: panel || flatPanel(src),
      favor: fav || { hp: 0, atk: 0, def: 0 },
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
    getById: getById,
    search: search,
    toCalcInput: toCalcInput,
    makeSquadEntry: makeSquadEntry,
    makeBlankEntry: makeBlankEntry,
    defaultPanel: defaultPanel,
    // 详情
    detail: detail,
    phasesOf: phasesOfOp,
    skillsOf: skillsOfOp,
    talentsOf: talentsOfOp,
    modulesOf: modulesOfOp,
    rangeOf: rangeOf,
    panelAt: panelAt
  };
})(typeof window !== 'undefined' ? window : globalThis);
