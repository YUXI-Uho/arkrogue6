/* ============================================================================
 * core/db/migrate.js — 存档格式转换（v2 内存形状 ↔ v3 表结构）
 * ============================================================================
 * 持久化的东西固定在表里：selection / squads / presets / settings 四张用户表。
 * 但界面在内存里用的还是好用的形状（{id:{stage,stack}} 这种映射），
 * 所以两头各做一次转换，中间不夹带业务规则：
 *
 *   state（内存）  --toArchive-->  表结构（写进浏览器本地存储）
 *   表结构（读回）  --normalize-->  state 形状（交给 applyArchive 校验）
 *
 * 为什么要转：表是无序的（编队靠 ord 列保序）、没有嵌套（ctx 拆成 key/value 行），
 * 直接把内存对象 JSON 化存进去，加一个字段就得改读取侧的所有判断。
 *
 * 版本
 *   v2  旧格式：{schemaVersion:2, relics:{...}, squad:[...], ctx:{...}, presets:[...]}
 *   v3  表格式：{schemaVersion:3, tables:{selection:[], squads:[], presets:[], settings:[]}}
 *   读的时候两种都认，写的时候只写 v3 —— 老存档打开一次就自动升级。
 *
 * ---------------------------------------------------------------------------
 * 对外 API
 *   DBMigrate.VERSION                 当前存档版本（= DBSchema.VERSION）
 *   DBMigrate.detect(raw)             2 | 3 | 0（无法识别）
 *   DBMigrate.normalize(raw)          v2/v3 → {relics, squad, ctx, presets}
 *   DBMigrate.toArchive(state)        {schemaVersion, tables:{...}}（纯函数，不碰 DB）
 *   DBMigrate.install(tables)         把表装进运行时 DB 的四张用户表
 *   DBMigrate.snapshot()              从运行时 DB 读回 {schemaVersion, tables}
 *   DBMigrate.stats(archive)          各表行数，给界面/调试看
 * ==========================================================================*/
(function (global) {
  'use strict';

  var S = global.DBSchema;
  if (!S) {
    throw new Error('core/db/migrate.js 依赖 core/db/schema.js');
  }

  var VERSION = S.VERSION;

  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }
  function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null; }

  function detect(raw) {
    if (!raw || typeof raw !== 'object') return 0;
    if (raw.tables && typeof raw.tables === 'object') return 3;
    if (Array.isArray(raw) || raw.squad || raw.relics) return 2;
    return 0;
  }

  // ---------------- 表 → 内存 ----------------
  function rowsOf(tables, name) {
    var rows = tables && tables[name];
    return Array.isArray(rows) ? rows : [];
  }

  function fromTables(tables) {
    var relics = {};
    rowsOf(tables, 'selection').forEach(function (r) {
      if (!r || !r.relicId) return;
      relics[r.relicId] = { stage: num(r.stage), stack: num(r.stack) };
    });

    // ord 是表的排序依据：没有它就还原不出玩家排的队伍顺序
    var squad = rowsOf(tables, 'squads').slice();
    squad.sort(function (a, b) { return num(a.ord) - num(b.ord); });
    squad = squad.map(function (r) {
      return {
        id: r.id,
        name: r.name,
        profession: r.profession,
        subProfession: r.subProfession,
        position: r.position,
        rarity: num(r.rarity),
        avatar: r.avatar || '',
        panel: obj(r.panel) || {},
        favor: obj(r.favor) || null,
        useFavor: r.useFavor !== false,
        assignTarget: !!r.assignTarget
      };
    });

    var presets = rowsOf(tables, 'presets').map(function (r) {
      return { name: r.name, ts: num(r.ts), ops: Array.isArray(r.ops) ? r.ops : [] };
    });

    var ctx = {};
    rowsOf(tables, 'settings').forEach(function (r) {
      if (!r || !r.key) return;
      ctx[r.key] = r.value;
    });

    return { relics: relics, squad: squad, ctx: ctx, presets: presets };
  }

  // ---------------- 内存 → 表 ----------------
  function toArchive(state) {
    var st = state || {};
    var relics = st.relics || {};
    var squad = Array.isArray(st.squad) ? st.squad : [];
    var presets = Array.isArray(st.presets) ? st.presets : [];
    var ctx = st.ctx || {};

    var selection = Object.keys(relics).map(function (id) {
      var v = relics[id] || {};
      return { relicId: id, stage: num(v.stage), stack: num(v.stack) };
    });

    var squadRows = squad.map(function (o, i) {
      return {
        id: o.id,
        ord: i,
        name: o.name || '',
        profession: o.profession || '',
        subProfession: o.subProfession || '',
        position: o.position || '',
        rarity: num(o.rarity),
        avatar: o.avatar || '',
        panel: o.panel || {},
        favor: o.favor || null,
        useFavor: o.useFavor !== false,
        assignTarget: !!o.assignTarget
      };
    });

    var presetRows = presets.map(function (p) {
      return { name: p.name, ts: num(p.ts), ops: p.ops || [] };
    });

    // 一行一个设置项：加参数不用改表结构
    var settingRows = Object.keys(ctx).map(function (k) {
      return { key: k, value: ctx[k] };
    });

    return {
      schemaVersion: VERSION,
      tables: {
        selection: selection,
        squads: squadRows,
        presets: presetRows,
        settings: settingRows
      }
    };
  }

  // ---------------- 读入：两种格式都认 ----------------
  function normalize(raw) {
    var v = detect(raw);
    if (v === 3) return fromTables(raw.tables);
    if (v === 2) {
      // v2 原样返回，交给 applyArchive 里的仓储校验（它已经能处理脏数据）
      if (Array.isArray(raw)) return { squad: raw };
      return {
        relics: raw.relics || {},
        squad: Array.isArray(raw.squad) ? raw.squad : [],
        ctx: raw.ctx || {},
        presets: Array.isArray(raw.presets) ? raw.presets : []
      };
    }
    return null;
  }

  function stats(archive) {
    var t = (archive && archive.tables) || {};
    var out = {};
    ['selection', 'squads', 'presets', 'settings'].forEach(function (k) {
      out[k] = Array.isArray(t[k]) ? t[k].length : 0;
    });
    return out;
  }

  // ---------------- 表 ↔ 运行时 DB ----------------
  // 四张用户表不是「文档」：读档时装进 DB，存档时从 DB 取。
  // 这样 DB.table('squads') 拿到的是真正落盘的那份数据，可以查询、可以统计；
  // 也让 DDL 的列定义成为唯一真相，而不是「另有一份 JSON 形状」。
  function db() {
    var D = global.DB;
    if (!D || !D.isLoaded()) throw new Error('DBMigrate 需要已装载的 DB（先 DB.load）');
    return D;
  }

  function install(tables) {
    var D = db();
    S.USER_TABLES.forEach(function (name) {
      D.install(name, rowsOf(tables, name).slice());
    });
    return D;
  }

  // 从 DB 里把四张用户表取回来，形状与 toArchive 完全一致
  function snapshot() {
    var D = db();
    var tables = {};
    S.USER_TABLES.forEach(function (name) {
      tables[name] = D.table(name).all();
    });
    return { schemaVersion: VERSION, tables: tables };
  }

  global.DBMigrate = {
    VERSION: VERSION,
    detect: detect,
    normalize: normalize,
    toArchive: toArchive,
    stats: stats,
    install: install,
    snapshot: snapshot
  };
})(typeof window !== 'undefined' ? window : globalThis);
