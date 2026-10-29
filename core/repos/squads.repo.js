/* ============================================================================
 * core/repos/squads.repo.js — 编队仓储层
 * ============================================================================
 * 编队的所有「业务规则」集中在这里：人数上限、判重、存档序列化与校验。
 * 界面层只负责把结果画出来，不再自己数人数、自己比名字。
 *
 * 判重有两条口径，不要混用：
 *   add() / canAdd()   按 name 判重 —— 防止重复添加同一个干员
 *   deserialize()      按 id(uid) 判重 —— 同名不同形态是合法的，改名不该丢人
 *
 * 对外 API
 *   SquadRepo.MAX                          编队上限（= ArkEnums.MAX_SQUAD，12）
 *   SquadRepo.canAdd(squad, entry)         → {ok, reason}
 *   SquadRepo.add(squad, entry)            → {ok, reason}
 *   SquadRepo.removeAt(squad, idx)         → {ok, reason, removed}
 *   SquadRepo.normalizeEntry(raw)          → entry | null（脏数据入口）
 *   SquadRepo.deserialize(input)           → {ok:true, squad, dropped} | {ok:false, reason}
 *                                            input 可以是 JSON 字符串、数组或 {squad:[...]}
 *                                            坏条目丢弃并计数，绝不抛异常
 * ==========================================================================*/
(function (global) {
  'use strict';

  var S = global.ArkSchema;
  var EN = global.ArkEnums;
  // schema / enums 是硬依赖（index.html 保证先加载）：缺了就直接报错，
  // 不再用字面量表兜底 —— 平行表迟早会被误当成第二份事实来源。
  if (!S || !EN) {
    throw new Error('core/repos/squads.repo.js 依赖 core/schema.js 与 core/enums.js，请检查 index.html 的脚本顺序');
  }

  var MAX = EN.MAX_SQUAD;
  // 存档版本由 core/db/schema.js 统一管（= DBMigrate.VERSION）。
  // 这里只留一个「拒绝比自己新的存档」的守卫，版本号跟表结构保持一致，
  // 免得出现「表结构是 v3、编队说自己是 v2」的错位。
  var SCHEMA_VERSION = (global.DBSchema && global.DBSchema.VERSION) || 2;

  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }
  function uid() { return 'op_' + Math.random().toString(36).slice(2, 8); }
  function isNum(v) { return v != null && v !== '' && isFinite(+v); }

  // ---------- 增删 ----------
  function canAdd(squad, entry) {
    squad = squad || [];
    if (!entry || typeof entry !== 'object') return { ok: false, reason: '干员数据无效' };
    if (!entry.name) return { ok: false, reason: '干员缺少名字' };
    if (squad.length >= MAX) return { ok: false, reason: '编队已满（最多 ' + MAX + ' 人）' };
    for (var i = 0; i < squad.length; i++) {
      if (squad[i] && squad[i].name === entry.name) {
        return { ok: false, reason: '「' + entry.name + '」已经在编队里了' };
      }
    }
    return { ok: true, reason: '' };
  }

  function add(squad, entry) {
    var r = canAdd(squad, entry);
    if (!r.ok) return r;
    squad.push(entry);
    return { ok: true, reason: '' };
  }

  function removeAt(squad, idx) {
    if (!squad || idx < 0 || idx >= squad.length) {
      return { ok: false, reason: '下标越界', removed: null };
    }
    var removed = squad.splice(idx, 1)[0];
    return { ok: true, reason: '', removed: removed || null };
  }

  // ---------- 校验 ----------
  // 属性表只有 core/schema.js 一份，这里直接引用，不再抄字面量
  var PANEL_KEYS = S.PANEL_KEYS;

  // 空名不判坏数据：界面允许把名字框清空，存档读回来时必须还是同一条干员，
  // 否则「界面上编得出来的状态」会在重载时连同面板一起消失。
  // 兜底值与 js/app.js 的 FALLBACK_NAME 保持一致。
  var FALLBACK_NAME = '未命名干员';

  // 头像只允许「本站相对路径」与 data:image/，其余一律丢掉。
  // 存档是可以从别处粘进来的 JSON：放任它带 http(s):// 外链，等于让别人的
  // 编队文件在打开页面时给第三方打点（拿到 IP / 来源页），也可能拖垮加载。
  var AVATAR_OK = /^(?:\.{0,2}\/|assets\/|img\/|data:image\/(?:png|jpe?g|webp|gif|avif);base64,)/i;

  function safeAvatar(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s || s.length > 200000) return '';        // 超长（塞了张巨图）直接丢
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^data:image\//i.test(s)) return '';  // http: / javascript: / blob: …
    if (s.slice(0, 2) === '//') return '';          // 协议相对的外链
    return AVATAR_OK.test(s) ? s : '';
  }

  // 一条编队数据的最小必要条件：panel 是对象 + hp/atk/def 是数字（名字缺失只兜底，不丢弃）
  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) name = FALLBACK_NAME;

    var p = raw.panel;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (!isNum(p.hp) || !isNum(p.atk) || !isNum(p.def)) return null;

    var panel = {};
    PANEL_KEYS.forEach(function (k) { panel[k] = num(p[k]); });
    if (!panel.aspd) panel.aspd = 100;
    if (!panel.spRecover) panel.spRecover = 1;
    if (!panel.interval) panel.interval = 1.0;
    if (!panel.redeploy) panel.redeploy = 70;

    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid(),
      name: name,
      profession: typeof raw.profession === 'string' ? raw.profession : '',
      subProfession: typeof raw.subProfession === 'string' ? raw.subProfession : '',
      position: typeof raw.position === 'string' && raw.position ? raw.position : '近战位',
      rarity: num(raw.rarity),
      avatar: safeAvatar(raw.avatar),
      panel: panel,
      favor: (raw.favor && typeof raw.favor === 'object')
        ? { hp: num(raw.favor.hp), atk: num(raw.favor.atk), def: num(raw.favor.def) }
        : null,
      useFavor: raw.useFavor !== false,
      assignTarget: !!raw.assignTarget,
      summon: !!raw.summon
    };
  }

  function deserialize(input) {
    var obj = input;

    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch (e) {
        return { ok: false, reason: 'JSON 解析失败：' + e.message };
      }
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, reason: '存档内容不是对象' };
    }

    var ver = obj.schemaVersion;
    if (ver != null && isFinite(+ver) && +ver > SCHEMA_VERSION) {
      return { ok: false, reason: '存档版本 ' + ver + ' 高于当前支持的 ' + SCHEMA_VERSION };
    }

    var arr = Array.isArray(obj) ? obj : obj.squad;
    if (!Array.isArray(arr)) {
      return { ok: false, reason: '存档里没有 squad 数组' };
    }

    var out = [];
    var seen = Object.create(null);
    var dropped = 0;

    arr.forEach(function (raw) {
      var e = normalizeEntry(raw);
      if (!e) { dropped++; return; }
      // 按 id 判重：界面上能编出来的状态（两个同名干员），存档读回来一定不丢人。
      // 只有存档里根本没有 id 的老数据，才退回按名字判重。
      var key = (raw && typeof raw.id === 'string' && raw.id) ? 'id:' + raw.id : 'name:' + e.name;
      if (seen[key]) { dropped++; return; }   // 判重，保留先出现的
      seen[key] = 1;
      out.push(e);
    });

    if (out.length > MAX) {
      dropped += out.length - MAX;
      out = out.slice(0, MAX);
    }

    return { ok: true, squad: out, dropped: dropped };
  }

  global.SquadRepo = {
    MAX: MAX,
    SCHEMA_VERSION: SCHEMA_VERSION,
    canAdd: canAdd,
    add: add,
    removeAt: removeAt,
    normalizeEntry: normalizeEntry,
    deserialize: deserialize
  };
})(typeof window !== 'undefined' ? window : globalThis);
