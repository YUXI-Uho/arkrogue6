/* ============================================================================
 * core/db/db.js — 运行时数据库引擎
 * ============================================================================
 * 把 data/is6db.js 里的表数据装进内存，提供「按主键取、按索引取、按条件筛」
 * 三种查询。没有 SQL、没有事务：这是单机只读库，数据量 300 KB 级，全量驻留
 * 内存就是最快的方案。
 *
 * 用法
 *   DB.load(window.IS6_DB)           装载产物（只在启动时调一次）
 *   DB.table('relics').get('001')    按主键
 *   DB.table('operators').by('profession', '近卫')
 *   DB.table('relic_stages').where(function (r) { return r.relicId === '001'; })
 *   DB.meta()                        产物的 meta（版本 / 指纹 / 行数）
 *   DB.check()                       行数与 meta 对账，返回 {ok, issues}
 *
 * 设计取舍
 *   - 主键表：装载时一次性建好，get 是 O(1)
 *   - 二级索引：第一次 by() 时才建，建完缓存；只读数据不会失效
 *   - 复合主键：按 DBSchema.pkOf 拼成字符串（relicId + stage）
 *   - 主键冲突不抛异常，保留第一条并记进 issues，由 check() 统一报出来 ——
 *     官方数据里偶尔会有重复 id，启动就崩不如让界面照常打开并提示。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var S = global.DBSchema;
  if (!S) {
    throw new Error('core/db/db.js 依赖 core/db/schema.js，请检查 index.html 的脚本顺序');
  }

  var meta = null;
  var tables = Object.create(null);
  var issues = [];
  var loaded = false;

  // ---------------- 表 ----------------
  function Table(name, def, rows) {
    this.name = name;
    this.def = def;
    this.rows = rows || [];
    this._pk = Object.create(null);
    this._idx = Object.create(null);
    var self = this;
    this.rows.forEach(function (row) {
      var k = S.pkOf(name, row);
      if (self._pk[k]) {
        issues.push(name + ' 主键重复：' + k.replace(/\u0001/g, '+') + '（保留第一条）');
        return;
      }
      self._pk[k] = row;
    });
  }

  Table.prototype.columns = function () { return Object.keys(this.def.columns); };

  Table.prototype.count = function () { return this.rows.length; };

  Table.prototype.all = function () { return this.rows.slice(); };

  // pk 可以是标量，也可以是复合主键的数组
  Table.prototype.get = function (pk) {
    var key = Array.isArray(pk) ? pk.join('\u0001') : String(pk);
    return this._pk[key] || null;
  };

  Table.prototype.where = function (fn) {
    return this.rows.filter(function (r, i) { return fn(r, i); });
  };

  // 二级索引：首次调用时建，之后走缓存
  Table.prototype.by = function (col, value) {
    var map = this._idx[col];
    if (!map) {
      map = Object.create(null);
      this.rows.forEach(function (r) {
        var v = String(r[col]);
        (map[v] || (map[v] = [])).push(r);
      });
      this._idx[col] = map;
    }
    return map[String(value)] || [];
  };

  Table.prototype.stats = function () {
    var indexed = Object.keys(this._idx);
    return { name: this.name, rows: this.rows.length, pk: this.def.pk, indexed: indexed };
  };

  // ---------------- 装载 ----------------
  function load(artifact) {
    if (!artifact || typeof artifact !== 'object' || !artifact.tables) {
      throw new Error('DB.load 需要 {meta, tables} 形状的产物（data/is6db.js）');
    }
    meta = artifact.meta || {};
    issues = [];
    tables = Object.create(null);
    loaded = false;

    // 产物比代码新 → 直接报错。宁可启动失败，也不要用旧代码读新字段。
    var ver = +meta.schemaVersion;
    if (isFinite(ver) && ver > S.VERSION) {
      throw new Error('数据产物版本 ' + ver + ' 高于当前代码支持的 ' + S.VERSION + '，请更新代码或重新生成 data/is6db.js');
    }
    if (isFinite(ver) && ver < S.VERSION) {
      issues.push('数据产物版本 ' + ver + ' 低于当前 ' + S.VERSION + '，请运行 tools/build_db.py 重新生成');
    }

    S.NAMES.forEach(function (name) {
      var def = S.TABLES[name];
      var rows = artifact.tables[name];
      if (def.kind === 'user') {
        // 用户表不在产物里，运行时由 core/db/migrate.js 装配
        tables[name] = new Table(name, def, []);
        return;
      }
      if (!Array.isArray(rows)) {
        issues.push('产物缺少表 ' + name);
        rows = [];
      }
      tables[name] = new Table(name, def, rows);
    });

    loaded = true;
    return api;
  }

  function table(name) {
    if (!loaded) throw new Error('DB 尚未装载，请先 DB.load(window.IS6_DB)');
    var t = tables[name];
    if (!t) throw new Error('未知的表：' + name);
    return t;
  }

  function has(name) { return !!tables[name]; }

  function metaOf() { return meta || {}; }

  function stats() {
    var out = {};
    Object.keys(tables).forEach(function (n) {
      if (tables[n].rows.length) out[n] = tables[n].rows.length;
    });
    return out;
  }

  // 行数与产物 meta.counts 对账：生成器算错或文件被截断时能立刻发现
  function check() {
    var out = issues.slice();
    var counts = (meta && meta.counts) || {};
    Object.keys(counts).forEach(function (name) {
      var t = tables[name];
      if (!t) { out.push('meta 声明了 ' + name + '，但产物里没有这张表'); return; }
      if (t.rows.length !== counts[name]) {
        out.push(name + ' 行数不符：meta 声明 ' + counts[name] + '，实际 ' + t.rows.length);
      }
    });
    return { ok: out.length === 0, issues: out, counts: stats() };
  }

  // 用户表在运行时被替换：存档读入后由 core/db/migrate.js 调用。
  // 有了它，DB.table('squads') 拿到的才是「上一次落盘的那份数据」，
  // 而不是一张永远空着的表 —— 否则这四张表只是文档，不是数据库。
  function install(name, rows) {
    var def = S.get(name);
    if (!def) throw new Error('未知的表：' + name);
    if (def.kind !== 'user') throw new Error(name + ' 是只读表，不能 install');
    tables[name] = new Table(name, def, rows || []);
    return tables[name];
  }

  var api = {
    load: load,
    table: table,
    has: has,
    meta: metaOf,
    stats: stats,
    check: check,
    isLoaded: function () { return loaded; },
    install: install
  };

  global.DB = api;
})(typeof window !== 'undefined' ? window : globalThis);
