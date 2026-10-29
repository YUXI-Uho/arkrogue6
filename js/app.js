/* 界面逻辑
 * 分工：数值计算在 js/engine.js，数据访问与业务规则在 core/repos/*，
 * 表结构与查询在 core/db/*，属性/枚举的唯一定义在 core/schema.js 与 core/enums.js。
 * 本文件只做三件事：读状态 → 调仓储/引擎 → 画 DOM。
 */
(function () {
  'use strict';
  var R = window.RelicEffects;
  var E = window.RelicEngine;
  var S = window.ArkSchema;
  var EN = window.ArkEnums;
  var OP = window.OperatorRepo;
  var Relics = window.RelicRepo;
  var Squad = window.SquadRepo;
  var DB = window.DB;
  var Migrate = window.DBMigrate;

  if (!R || !E || !S || !EN || !OP || !Relics || !Squad || !DB || !Migrate) {
    throw new Error('js/app.js 依赖 core/schema.js、core/enums.js、core/db/*.js、js/effects.js、js/engine.js 与 core/repos/*.js，请检查 index.html 的脚本顺序');
  }

  // 装载数据库产物 → 仓储层从表里取数。
  // 这里不抛错：顶层抛错会让整个文件中断，连错误提示都渲染不出来，用户只看到白屏。
  // 记下原因，等 DOM 就绪后在页面上画一块可读的说明。
  var bootError = null;
  try {
    if (!window.IS6_DB) {
      throw new Error('数据产物 data/is6db.js 没有加载成功（文件缺失，或 ?v= 版本串与其它资源不一致导致 404）');
    }
    DB.load(window.IS6_DB);
    OP.init(DB);
    Relics.init(DB);
  } catch (e) {
    bootError = e;
  }

  // 枚举与属性表全部来自注册表，本文件不再自带任何平行表
  var CATEGORIES = EN.CATEGORIES;
  var PROFESSIONS = EN.PROFESSIONS;
  var RARITIES = EN.RARITIES;
  var MAX_SQUAD = EN.MAX_SQUAD;
  var PANEL_FIELDS = S.PANEL_FIELDS;
  var RESULT_ROWS = S.RESULT_ROWS;

  var LS_KEY = 'is6calc.v1';
  var BAK_KEY = 'is6calc.v1.bak';   // 上一次写成功的存档，主键读不出来时回退用
  var SAVE_DELAY = 200;      // 存档防抖
  var SEARCH_DELAY = 150;    // 藏品搜索防抖

  // 右侧分页：编队 / 汇总 / 战斗状态各占一页，不再纵向堆成一条长列表。
  // 角标承担「不切页也知道别处有什么」的信息量。
  var TABS = [
    { key: 'squad', btn: 'tabSquad', pane: 'paneSquad', badge: 'tabSquadBadge' },
    { key: 'summary', btn: 'tabSummary', pane: 'paneSummary', badge: 'tabSummaryBadge' },
    { key: 'ctx', btn: 'tabCtx', pane: 'paneCtx', badge: 'tabCtxBadge' }
  ];
  var TAB_KEY = 'is6calc.tab';
  var FOLD_KEY = 'is6calc.relicFold';

  // 空名的兜底值：与 core/repos/squads.repo.js 的读取侧保持一致，
  // 保证「界面上编得出来的状态，存档一定读得回来」。
  var FALLBACK_NAME = '未命名干员';
  // 需要用户手填层数的条件类型；perProfession / perAlly / perResource
  // 的驱动量在「战斗状态」栏，不该再画一个默认 0 的层数框。
  var MANUAL_STACK_COND = { perStack: 1, capLayer: 1, perLayer: 1 };

  function defaultCtx() {
    return {
      time: 0, hpPct: 100, ingots: 0, parts: 0, allyCount: 0,
      skillOn: false, hasShield: false, firstDeploy: true,
      // 伤害估算输入（汇总页顶部那张卡）
      dmgAtk: 1000, dmgScale: 1, dmgDef: 0, dmgRes: 0,
      value: 0,
      // 触发类效果（击倒/击杀敌人等瞬时触发）默认不生效，由战斗状态区的勾选框控制
      proc: false,
      profCounts: {}
    };
  }

  var state = {
    relics: {},          // id -> {stage, stack}
    squad: [],
    ctx: defaultCtx(),
    presets: [],
    ui: {
      // 藏品侧
      search: '', cat: '全部', rarity: '', onlySelected: false, onlyMatched: false,
      // 编队网格侧
      pickerOpen: false, pickerProf: '', pickerStar: '', pickerSearch: '',
      // 分页与卡片密度
      tab: 'squad', editAll: false, onlyChanged: false
    }
  };

  // ---------- 小工具 ----------
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function num(v) { return (v === '' || v == null || isNaN(v)) ? 0 : +v; }

  // 按注册表声明的小数位格式化（interval 3 位、spRecover 2 位…）
  function fmt(v, dec) {
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    if (!dec) return String(Math.round(v));
    var s = v.toFixed(dec).replace(/\.?0+$/, '');
    return s === '' || s === '-' ? '0' : s;
  }
  // 明细/汇总里的自适应格式：整数原样，小数保留两位
  function fmtAuto(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  }
  function signed(v, dec) { return (v > 0 ? '+' : '') + fmt(v, dec); }
  // 官方结构化修正项没有 label 字段，统一回退到注册表的中文名
  function statLabel(item) { return item.label || S.labelOf(item.stat); }
  // 明细/汇总里的数值：正数带 +，负数保留 -，百分比补 %
  function fmtDelta(v, pct) {
    var s = (v > 0 ? '+' : '') + fmtAuto(v);
    return pct ? s + '%' : s;
  }

  function debounce(fn, ms) {
    var t = null;
    function wrapped() {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    }
    wrapped.flush = function () {
      if (!t) return;
      clearTimeout(t);
      t = null;
      fn();
    };
    return wrapped;
  }

  var toastTimer = null;
  function toast(msg) {
    var box = document.getElementById('toast');
    if (!box) return;
    box.textContent = msg;
    box.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      box.classList.remove('show');
      toastTimer = null;
    }, 2200);
  }

  function indexOfName(name) {
    for (var i = 0; i < state.squad.length; i++) {
      if (state.squad[i] && state.squad[i].name === name) return i;
    }
    return -1;
  }

  // ---------- 分页 ----------
  function setTab(key) {
    var hit = TABS[0];
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) hit = TABS[i];
    state.ui.tab = hit.key;
    // 只切 display，不重建 DOM —— 输入框焦点与滚动位置都留在原页
    TABS.forEach(function (t) {
      var b = document.getElementById(t.btn);
      var p = document.getElementById(t.pane);
      var on = t.key === hit.key;
      if (b) {
        if (on) b.classList.add('on'); else b.classList.remove('on');
        // 读屏靠 aria-selected 判断当前页，class 对它是不可见的
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('tabindex', on ? '0' : '-1');
      }
      if (p) { if (on) p.classList.add('on'); else p.classList.remove('on'); }
    });
    try { localStorage.setItem(TAB_KEY, hit.key); } catch (e) { /* 隐私模式忽略 */ }
  }

  function setBadge(id, text, warn) {
    var n = document.getElementById(id);
    if (!n) return;
    n.textContent = text;
    if (warn) n.classList.add('warn'); else n.classList.remove('warn');
  }

  // 与默认值不同的参数个数：提醒「结果正在受非默认战斗状态影响」
  function ctxCustomCount() {
    var d = defaultCtx(), c = state.ctx, n = 0;
    ['time', 'hpPct', 'ingots', 'parts', 'allyCount'].forEach(function (k) {
      if (num(c[k]) !== d[k]) n++;
    });
    if (!!c.skillOn !== d.skillOn) n++;
    if (!!c.hasShield !== d.hasShield) n++;
    if ((c.firstDeploy !== false) !== d.firstDeploy) n++;
    if (!!c.proc !== d.proc) n++;
    var pc = c.profCounts || {};
    Object.keys(pc).forEach(function (k) { if (num(pc[k]) > 0) n++; });
    return n;
  }

  // 汇总的项数统计：生效 / 因条件未满足而未生效
  function sumStats(sum) {
    var ok = 0, unmet = 0;
    ['panel', 'combat', 'run'].forEach(function (b) {
      Object.keys(sum[b] || {}).forEach(function (k) {
        ((sum[b][k] || {}).items || []).forEach(function (it) {
          if (!it) return;
          if (it.ok === false) unmet++; else ok++;
        });
      });
    });
    return { ok: ok, unmet: unmet };
  }

  function renderBadges(sum) {
    setBadge('tabSquadBadge', state.squad.length + '/' + MAX_SQUAD, state.squad.length >= MAX_SQUAD);

    var s = sum || getSummary();
    var st = sumStats(s);
    setBadge('tabSummaryBadge', st.ok ? st.ok + ' 项生效' : '无加成', false);

    var d = ctxCustomCount();
    setBadge('tabCtxBadge', d ? d + ' 项自定义' : '默认', d > 0);

    var meta = document.getElementById('tabsMeta');
    if (meta) {
      meta.innerHTML = '';
      meta.appendChild(el('span', null, '藏品 '));
      meta.appendChild(el('b', null, String(Object.keys(state.relics).length)));
      meta.appendChild(el('span', null, ' 件 · 编队 '));
      meta.appendChild(el('b', null, state.squad.length + '/' + MAX_SQUAD));
    }
  }

  // 战斗状态页的收尾摘要：既填住下半部分的空白，也回答「现在有几项没吃到」
  function renderCtxImpact(sum) {
    var box = document.getElementById('ctxImpact');
    if (!box) return;
    var st = sumStats(sum || getSummary());
    box.innerHTML = '';
    box.appendChild(el('span', null, '当前战斗状态下：'));
    box.appendChild(el('b', null, st.ok + ' 项加成生效'));
    box.appendChild(el('span', st.unmet ? 'bad' : null,
      st.unmet ? '· ' + st.unmet + ' 项因条件未满足而未生效' : '· 没有被条件挡下的加成'));
    var go = el('button', 'tiny', '查看汇总');
    go.onclick = function () { setTab('summary'); };
    box.appendChild(go);
  }

  // 每个参数组的「影响 N 条」：告诉用户这一格到底有没有藏品在读
  var CTX_NEED = [
    ['needTime', ['early', 'after']],
    ['needHp', ['hpBelow', 'hpAbove']],
    ['needRes', ['perResource']],
    ['needAlly', ['perAlly']],
    ['needProf', ['perProfession']],
    ['needState', ['skillWindow', 'skillOff', 'hasShield', 'firstDeploy', 'proc']]
  ];

  function renderCtxNeed(mods) {
    var counts = {};
    CTX_NEED.forEach(function (pair) { counts[pair[0]] = 0; });

    function mark(t) {
      CTX_NEED.forEach(function (pair) {
        if (pair[1].indexOf(t) >= 0) counts[pair[0]]++;
      });
    }
    (mods || []).forEach(function (m) {
      var c = m && m.cond;
      if (!c) return;
      // 复合条件要展开数，否则「技能中且生命<50%」两边都不计数
      if (c.type === 'all' && c.of) c.of.forEach(function (sub) { if (sub && sub.type) mark(sub.type); });
      else if (c.type) mark(c.type);
    });

    CTX_NEED.forEach(function (pair) {
      var n = document.getElementById(pair[0]);
      if (!n) return;
      var v = counts[pair[0]];
      n.textContent = v ? '影响 ' + v + ' 条' : '';
      if (v) n.classList.add('hot'); else n.classList.remove('hot');
    });
  }

  // 条件类加成的现状：不只列「没吃到的」，而是把所有带条件的项按状态列出来。
  // 只列未生效的话，用户看不出「这一页到底在管哪些藏品」。
  function renderCtxUnmet(sum) {
    var box = document.getElementById('ctxUnmet');
    if (!box) return;
    box.innerHTML = '';
    var s = sum || getSummary();
    var rows = [];
    ['panel', 'combat', 'run'].forEach(function (b) {
      Object.keys(s[b] || {}).forEach(function (k) {
        ((s[b][k] || {}).items || []).forEach(function (it) {
          // reason 有内容 = 这条带条件；无条件项不在这页出现
          if (it && it.reason) rows.push({ stat: k, it: it });
        });
      });
    });
    if (!rows.length) {
      box.appendChild(el('p', 'ctx-unmet-empty',
        '当前选中的藏品都不读战斗状态 —— 这一页没有可调的参数。选一些带条件的藏品（如「技能开启时」「生命低于 50%」）再来。'));
      return;
    }
    // 未生效的排前面：需要动手调的就是这些
    rows.sort(function (a, b) {
      var x = a.it.ok === false ? 0 : 1, y = b.it.ok === false ? 0 : 1;
      return x - y;
    });
    var off = rows.filter(function (r) { return r.it.ok === false; }).length;

    var head = el('div', 'ctx-unmet-head');
    head.appendChild(el('span', null, '条件类加成现状'));
    head.appendChild(el('span', 'hint',
      rows.length + ' 条带条件 · 其中 ' + off + ' 条当前未生效'));
    box.appendChild(head);

    var ul = el('ul');
    rows.slice(0, 60).forEach(function (r) {
      var li = el('li', r.it.ok === false ? 'off' : 'on');
      var row = el('div', 'row');
      row.appendChild(el('span', 'dot', r.it.ok === false ? '○' : '●'));
      row.appendChild(el('span', 'k', r.it.relicName + ' → ' + S.labelOf(r.stat) +
        (r.it.enemy ? '（对敌）' : '')));
      row.appendChild(el('span', 'v', fmtDelta(r.it.value, r.it.pct)));
      li.appendChild(row);
      // 条件写第二行：挤在一行里会把藏品名压成「波…」
      li.appendChild(el('span', 'why', r.it.reason));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  // ---------- 存档 ----------
  // 存档 / 导出共用同一个归档对象，避免两处各拼一份、字段走偏
  //
  // 写入策略（部署给多人用之后，存档就是用户唯一的资产，不能静默丢）：
  //   1. 先把盘上这一版挪到备份键，再写主键 —— 主键坏了还能回退一步
  //   2. 写失败（配额满 / 隐私模式）必须让用户看见，不能 catch 完就完
  //   3. 同一个 key 只有一个备份，不做历史版本，避免把配额吃满
  var writeWarned = false;      // 失败提示一个会话只弹一次，别在防抖里刷屏
  var lastWritten = null;       // 本页最后一次写成功的 JSON，用来识别「别人写的」

  function saveNow() {
    var json;
    try {
      json = JSON.stringify(archiveObject());
    } catch (e) {
      warnWrite('存档序列化失败，本次改动没有保存：' + (e && e.message));
      return false;
    }

    var prev = null;
    try { prev = localStorage.getItem(LS_KEY); } catch (e) { /* 读都读不了，直接写 */ }
    if (prev && prev !== json) {
      try { localStorage.setItem(BAK_KEY, prev); } catch (e) { /* 备份失败不阻断主写入 */ }
    }

    try {
      localStorage.setItem(LS_KEY, json);
      lastWritten = json;
      writeWarned = false;
      return true;
    } catch (e) {
      var quota = e && (e.name === 'QuotaExceededError' ||
                        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
      warnWrite(quota
        ? '本地存储已满，这次改动没存下来。请先点「导出」备份，再清理不用的常用编队。'
        : '浏览器拒绝写入本地存储（可能是无痕模式），本次改动只在当前页面有效。');
      return false;
    }
  }

  function warnWrite(msg) {
    if (writeWarned) return;
    writeWarned = true;
    toast(msg);
    if (window.console && console.warn) console.warn('[存档] ' + msg);
  }

  var save = debounce(saveNow, SAVE_DELAY);

  // 只接受白名单字段，避免脏存档把 ctx 变成任意结构
  function mergeCtx(raw) {
    if (!raw || typeof raw !== 'object') return;
    var base = defaultCtx();
    Object.keys(base).forEach(function (k) {
      if (raw[k] == null) return;
      if (k === 'profCounts') {
        if (typeof raw[k] === 'object' && !Array.isArray(raw[k])) {
          var counts = {};
          PROFESSIONS.forEach(function (p) { counts[p] = num(raw[k][p]); });
          base.profCounts = counts;
        }
      } else if (typeof base[k] === 'boolean') {
        base[k] = !!raw[k];
      } else {
        base[k] = num(raw[k]);
      }
    });
    state.ctx = base;
  }

  function sanitizePresets(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    raw.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var src = Array.isArray(p.ops) ? p.ops : [];
      var r = Squad.deserialize({ squad: src });
      if (!r.ok) return;
      if (src.length && !r.squad.length) return;   // 一条都没剩下 → 整个预设丢弃
      out.push({
        name: String(p.name || '编队 ' + (out.length + 1)),
        ops: r.squad,
        ts: num(p.ts)
      });
    });
    return out;
  }

  // 存档 / 导入的统一入口：坏数据丢弃并计数，绝不把半截数据塞进 state。
  // v2（旧格式）与 v3（表结构）都认，统一经 DBMigrate 还原成内存形状再校验。
  function applyArchive(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '存档内容不是对象' };

    var fromVersion = Migrate.detect(raw);
    var bare = Array.isArray(raw);              // 裸数组 = 只有编队，其余清空
    var d = Migrate.normalize(raw);
    if (!d) return { ok: false, reason: '无法识别的存档格式' };

    var r = Squad.deserialize(d);
    if (!r.ok) return r;

    state.squad = r.squad;
    if (bare) {
      state.relics = {};
      state.ctx = defaultCtx();
      state.presets = [];
    } else {
      // 只覆盖存档里确实存在的部分，避免半份 JSON 把其它状态清掉
      if (d.relics) state.relics = Relics.sanitizeSelection(d.relics);
      if (d.ctx) mergeCtx(d.ctx);
      if (Array.isArray(d.presets)) state.presets = sanitizePresets(d.presets);
    }
    // 校验通过之后才让运行时 DB 跟上：失败时 DB 不该留着一份脏数据。
    // 用「从 state 重建」而不是直接灌 raw，是为了让 v2 旧存档也统一成清洗后的结果。
    Migrate.install(Migrate.toArchive(state).tables);
    return { ok: true, dropped: r.dropped, fromVersion: fromVersion };
  }

  function clearState() {
    state.squad = [];
    state.relics = {};
    state.ctx = defaultCtx();
    state.presets = [];
  }

  // 读主键；主键坏了就退回备份键。备份也救不回来才清空。
  function readStored() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return { raw: null, unavailable: true }; }
    if (raw) return { raw: raw, from: 'main' };
    try { raw = localStorage.getItem(BAK_KEY); } catch (e) { /* 没有备份 */ }
    if (raw) return { raw: raw, from: 'backup' };
    return { raw: null, from: null };
  }

  function load() {
    var got = readStored();
    if (got.unavailable) return { dropped: 0, unavailable: true };
    if (!got.raw) return { dropped: 0 };

    var d = null, parseOk = true;
    try {
      d = JSON.parse(got.raw);
    } catch (e) { parseOk = false; }

    var r = parseOk ? applyArchive(d) : { ok: false };
    if (!r.ok && got.from === 'main') {
      // 主键坏了：先别清空，退回上一次写成功的备份试一把
      var bak = null;
      try { bak = localStorage.getItem(BAK_KEY); } catch (e) { /* 没有备份 */ }
      if (bak && bak !== got.raw) {
        var bd = null;
        try { bd = JSON.parse(bak); } catch (e) { bd = null; }
        var br = bd ? applyArchive(bd) : { ok: false };
        if (br.ok) {
          lastWritten = bak;
          return { dropped: br.dropped, recovered: true, fromVersion: br.fromVersion };
        }
      }
    }

    if (!r.ok) {
      // 读不出来就回到空状态，不要让界面停在半渲染
      clearState();
      return { dropped: 0, corrupted: true };
    }
    // v2 旧存档会被就地升级成 v3 表结构：第一次打开时提示一次，之后不再提
    return { dropped: r.dropped, upgraded: r.fromVersion === 2, fromBackup: got.from === 'backup' };
  }

  // ---------- 状态 → 计算（两级缓存） ----------
  // mods 只在「藏品选择」变化时重算；results 在 mods / 战斗状态 / 干员面板变化时重算；
  // summary 只依赖 mods + ctx，与编队无关，所以改面板数字不必重算汇总。
  var cache = { modsKey: null, mods: null, resKey: null, results: null, sumKey: null, summary: null };

  function selectionList() {
    return Relics.toSelection(state.relics);
  }

  function selectionKey() {
    var list = selectionList();
    list.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return list.map(function (s) { return s.id + ':' + s.stage + ':' + s.stack; }).join(',');
  }

  function buildCtx() {
    var c = state.ctx;
    return {
      time: num(c.time), hpPct: num(c.hpPct), ingots: num(c.ingots),
      parts: num(c.parts), allyCount: num(c.allyCount),
      skillOn: !!c.skillOn, hasShield: !!c.hasShield,
      firstDeploy: c.firstDeploy !== false,
      proc: !!c.proc,
      profCounts: c.profCounts || {},
      // 跨藏品条件用：当前选中的藏品 + 各自层数（209 按【探测先锋】层数加抗性）
      relics: state.relics,
      relicStacks: (function () {
        var map = {};
        Object.keys(state.relics || {}).forEach(function (id) {
          var v = state.relics[id];
          if (v && v.stack) map[id] = v.stack;
        });
        return map;
      })(),
      value: num(c.value)
    };
  }

  function squadKey() {
    return JSON.stringify(state.squad.map(function (o) { return OP.toCalcInput(o); }));
  }

  function getMods() {
    var key = selectionKey();
    if (cache.modsKey !== key) {
      cache.mods = E.buildModifiers(selectionList(), Relics.index());
      cache.modsKey = key;
      cache.resKey = null;
      cache.sumKey = null;
    }
    return cache.mods;
  }

  function getResults() {
    var mods = getMods();
    var ctx = buildCtx();
    var key = cache.modsKey + '|' + JSON.stringify(ctx) + '|' + squadKey();
    if (cache.resKey !== key) {
      cache.results = state.squad.map(function (o) {
        return E.computeOperator(OP.toCalcInput(o), mods, ctx);
      });
      cache.resKey = key;
    }
    return cache.results;
  }

  function getSummary() {
    var mods = getMods();
    var ctx = buildCtx();
    var key = cache.modsKey + '|' + JSON.stringify(ctx);
    if (cache.sumKey !== key) {
      cache.summary = E.summarize(mods, ctx);
      cache.sumKey = key;
    }
    return cache.summary;
  }

  // ---------- 藏品列表 ----------
  function renderCats() {
    var box = document.getElementById('catFilter');
    box.innerHTML = '';
    CATEGORIES.forEach(function (c) {
      var b = el('button', 'chip' + (state.ui.cat === c ? ' on' : ''), c);
      b.onclick = function () { state.ui.cat = c; renderCats(); renderRelicList(); };
      box.appendChild(b);
    });
  }

  function toggleRelic(id, on) {
    if (on) {
      if (!state.relics[id]) state.relics[id] = { stage: 0, stack: 0 };
    } else {
      delete state.relics[id];
    }
    save();
    renderRelicList();
    renderSquad();
    renderSummary();
  }

  // 整卡点击的排除名单：控件与名称链接不参与「切换选中」
  function isInteractive(t) {
    var tag = String((t && t.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'option' ||
        tag === 'button' || tag === 'label' || tag === 'textarea' || tag === 'a') return true;
    return String((t && t.className) || '').indexOf('relic-name') >= 0;
  }

  function renderRelicList() {
    var list = document.getElementById('relicList');
    var keepScroll = list.scrollTop || 0;
    list.innerHTML = '';

    var rows = Relics.filter({
      search: state.ui.search,
      category: state.ui.cat,
      rarity: state.ui.rarity,
      onlySelected: state.ui.onlySelected,
      onlyMatched: state.ui.onlyMatched,
      selectedMap: state.relics
    });

    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var sel = state.relics[r.id];
      var card = el('div', 'relic' + (sel ? ' selected' : ''));
      card.dataset.id = r.id;

      var head = el('div', 'relic-head');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!sel;
      cb.onchange = function () { toggleRelic(r.id, cb.checked); };

      // 整卡点击 = 切换选中（选中 ↔ 取消），控件与名称链接除外
      card.onclick = function (ev) {
        var t = (ev && ev.target) || {};
        if (isInteractive(t)) return;
        toggleRelic(r.id, !cb.checked);
      };
      head.appendChild(cb);

      var title = el('div', 'relic-title');
      var nameRow = el('div');
      var nm = el('span', 'relic-name', r.name);
      nm.title = '查看完整说明';
      nm.onclick = function () { showRelicModal(r); };
      nameRow.appendChild(nm);
      title.appendChild(nameRow);

      var meta = el('div', 'relic-meta');
      meta.appendChild(el('span', 'tag r' + r.rarity, RARITIES[r.rarity] || '普通'));
      meta.appendChild(el('span', 'tag', r.category));
      meta.appendChild(el('span', 'tag', 'No.' + r.id));
      if ((r.flags || []).indexOf('stack') >= 0) meta.appendChild(el('span', 'tag warn', '可叠加'));
      var parsed = E.parseRelic(r, sel ? sel.stage : 0);
      if (parsed.source === 'official' || parsed.source === 'official+text') {
        meta.appendChild(el('span', 'tag ok', '官方结构化'));
      } else if (parsed.mods.length) {
        meta.appendChild(el('span', 'tag warn', '文案解析'));
      }
      if (!parsed.mods.length) meta.appendChild(el('span', 'tag warn', '特殊/未量化'));
      title.appendChild(meta);
      head.appendChild(title);
      card.appendChild(head);

      var body = el('div', 'relic-body');
      var eff = E.effectTextFor(r, sel ? sel.stage : 0);
      var effEl = el('div', 'effect' + (parsed.mods.length ? '' : ' special'), eff);
      body.appendChild(effEl);
      card.appendChild(body);

      var labels = E.tierLabels(r);
      var cap = E.stackCap(r);
      // 层数输入框只在「需要手填层」时才画：条件类型是 perStack / capLayer / perLayer，
      // 或这件藏品带 stack 标记。perProfession / perAlly / perResource 由「战斗状态」栏驱动
      // （如 152「场上每有一名【术师】干员」），画层数框会让人以为要手填。
      // 未选中时整块不画，避免卡片多出一段 6px 的空白。
      var hasStackFlag = (r.flags || []).indexOf('stack') >= 0;
      var needsStack = hasStackFlag;
      parsed.mods.forEach(function (m) {
        if (m.perLayer || (m.cond && MANUAL_STACK_COND[m.cond.type])) needsStack = true;
      });
      if (sel && (labels.length || needsStack)) {
        var ctrl = el('div', 'relic-controls');
        if (labels.length) {
          // 只挂一个 select 的话，卡片上会孤零零显示「结构化」，看不出这是个档位选择
          var stLab = el('label', 'check', '档位');
          stLab.title = '这件藏品的档位 / 分支';
          var st = document.createElement('select');
          labels.forEach(function (lb, i) {
            var o = document.createElement('option');
            o.value = i; o.textContent = lb;
            st.appendChild(o);
          });
          st.value = sel.stage || 0;
          st.onchange = function () {
            state.relics[r.id].stage = +st.value;
            save(); renderRelicList(); renderSquad(); renderSummary();
          };
          stLab.appendChild(st);
          ctrl.appendChild(stLab);
        }
        if (needsStack) {
          var lab = el('label', 'check', '层数');
          var si = document.createElement('input');
          si.type = 'number'; si.className = 'stack'; si.min = '0';
          si.max = String(cap || 99);
          si.value = String(sel.stack || 0);
          si.oninput = function () {
            state.relics[r.id].stack = num(si.value);
            save(); renderSquad(); renderSummary();
          };
          lab.appendChild(si);
          ctrl.appendChild(lab);
        }
        card.appendChild(ctrl);
      }
      frag.appendChild(card);
    });

    list.appendChild(frag);
    list.scrollTop = keepScroll;
    document.getElementById('relicCount').textContent = Object.keys(state.relics).length;
    if (!rows.length) {
      list.appendChild(el('p', 'empty', '没有匹配的藏品，换个关键词试试。'));
    }
  }

  // ---------- 编队卡片 ----------
  function renderSquad() {
    var box = document.getElementById('squadList');
    box.innerHTML = '';
    var results = getResults();
    renderSquadMeta();
    renderStrip();
    renderDmgFromOp();

    if (!state.squad.length) {
      box.appendChild(el('p', 'empty', '还没有干员。点上面任意空槽位或「添加干员」从全部 ' +
        OP.all().length + ' 名干员里选，或点「空白干员」手动填面板。'));
      return;
    }

    state.squad.forEach(function (op, idx) {
      var res = results[idx];
      var card = el('div', 'op-card');
      card.dataset.idx = String(idx);

      // 头部
      var head = el('div', 'op-head');
      var nameIn = document.createElement('input');
      nameIn.className = 'name'; nameIn.value = op.name || '未命名';
      // 改名不拦（同名不同形态是合法的），只做轻提示；
      // 存档按 id 判重，所以改出同名也不会在重载时丢人。
      var dupWarned = '';
      nameIn.oninput = function () {
        // 输入过程中允许临时为空（不打断打字），空名的兜底在失焦与读取侧完成
        op.name = nameIn.value;
        var v = nameIn.value.trim();
        var dup = !!v && state.squad.some(function (x) { return x !== op && x.name === v; });
        if (dup && dupWarned !== v) {
          dupWarned = v;
          toast('编队里已有同名干员「' + v + '」，两人会各自保留');
        }
        if (!dup) dupWarned = '';
        save();
      };
      // 失焦兜底：空名 / 纯空格回填「未命名干员」。
      // 不这么做的话空名会被仓储的读取侧当成坏数据，重载时整条干员连同面板一起消失。
      nameIn.onblur = function () {
        if (String(op.name || '').trim()) return;
        op.name = FALLBACK_NAME;
        nameIn.value = FALLBACK_NAME;
        save();
      };
      head.appendChild(nameIn);

      var profSel = document.createElement('select');
      PROFESSIONS.forEach(function (p) {
        var o = document.createElement('option'); o.value = p; o.textContent = p;
        profSel.appendChild(o);
      });
      profSel.value = op.profession || '近卫';
      profSel.onchange = function () { op.profession = profSel.value; save(); renderSquad(); };
      head.appendChild(profSel);

      var posSel = document.createElement('select');
      EN.POSITIONS.forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1];
        posSel.appendChild(o);
      });
      posSel.value = /远程/.test(op.position || '') ? '远程位' : '近战位';
      posSel.onchange = function () { op.position = posSel.value; save(); renderSquad(); };
      head.appendChild(posSel);

      // 图鉴详情：技能 / 天赋 / 模组 / 三档面板都在库里，编队卡上给个入口
      var info = el('button', 'ghost tiny', '详情');
      info.onclick = function () { showOperatorModal(op.name); };
      head.appendChild(info);

      var del = el('button', 'del tiny', '删除');
      del.onclick = function () {
        Squad.removeAt(state.squad, idx);
        afterSquadChange();
      };
      head.appendChild(del);
      card.appendChild(head);

      // 面板编辑区默认收起：内置干员的面板一般不用改，12 张卡全展开会把编队页撑成
      // 一条几千像素的长列表。空白干员必须展开，否则用户不知道该填哪里。
      // op.__open 记住用户手动的展开状态（不进存档，仓储只挑白名单字段）。
      var edit = document.createElement('details');
      edit.className = 'op-edit';
      edit.open = state.ui.editAll || !!op.__open || !op.favor;
      var editSum = document.createElement('summary');
      editSum.textContent = '面板 / 分支 / 选项';
      edit.appendChild(editSum);
      edit.addEventListener('toggle', function () { op.__open = edit.open; });

      // 面板输入
      var grid = el('div', 'op-grid');
      grid.dataset.role = 'panel';
      PANEL_FIELDS.forEach(function (f) {
        var lab = el('label', null, f.label);
        var inp = document.createElement('input');
        inp.type = 'number';
        inp.value = fmt(num(op.panel[f.key]), S.decimalsOf(f.key));
        inp.oninput = function () {
          op.panel[f.key] = num(inp.value);
          save();
          updateResult(card, op);
        };
        lab.appendChild(inp);
        grid.appendChild(lab);
      });
      edit.appendChild(grid);

      // 分支 / 信赖 / 标记
      var extra = el('div', 'relic-controls');
      var subLab = el('label', 'check', '分支');
      var subIn = document.createElement('input');
      subIn.type = 'text';
      subIn.value = op.subProfession || '';
      subIn.style.width = '96px';
      subIn.placeholder = '如 解放者';
      subIn.oninput = function () { op.subProfession = subIn.value.trim(); save(); updateResult(card, op); };
      subLab.appendChild(subIn);
      extra.appendChild(subLab);

      if (op.favor && (op.favor.hp || op.favor.atk || op.favor.def)) {
        var favLab = el('label', 'check');
        var favCb = document.createElement('input');
        favCb.type = 'checkbox';
        favCb.checked = op.useFavor !== false;
        favCb.onchange = function () { op.useFavor = favCb.checked; save(); renderSquad(); };
        favLab.appendChild(favCb);
        favLab.appendChild(document.createTextNode(
          '满信赖 +' + op.favor.atk + '攻 / +' + op.favor.hp + '血' + (op.favor.def ? ' / +' + op.favor.def + '防' : '')
        ));
        extra.appendChild(favLab);
      }

      var assignLab = el('label', 'check');
      var assignCb = document.createElement('input');
      assignCb.type = 'checkbox';
      assignCb.checked = !!op.assignTarget;
      assignCb.onchange = function () { op.assignTarget = assignCb.checked; save(); renderSquad(); };
      assignLab.appendChild(assignCb);
      assignLab.appendChild(document.createTextNode('一次性藏品指定此人'));
      extra.appendChild(assignLab);
      edit.appendChild(extra);
      card.appendChild(edit);

      // 结果
      var resBox = el('div', 'result');
      resBox.dataset.role = 'result';
      card.appendChild(resBox);
      fillResult(resBox, res, op);

      box.appendChild(card);
    });
  }

  // 只重算当前这一张卡，不用整队重算
  function updateResult(card, op) {
    var resBox = card.querySelector('[data-role="result"]');
    if (!resBox) return;
    fillResult(resBox, E.computeOperator(OP.toCalcInput(op), getMods(), buildCtx()), op);
  }

  function fillResult(box, res, op) {
    box.innerHTML = '';
    if (!res) return;
    var table = el('table', 'res-table');
    var thead = el('thead');
    var htr = el('tr');
    ['属性', '基础', '最终', '变化'].forEach(function (t) { htr.appendChild(el('th', null, t)); });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tb = el('tbody');
    var hiddenRows = 0;
    RESULT_ROWS.forEach(function (row) {
      var dec = S.decimalsOf(row.key);
      var d = num(res.delta[row.key]);
      // 「只看变化」：没被加成碰到的属性行省掉，12 张卡才扫得过来
      if (state.ui.onlyChanged && d === 0) { hiddenRows++; return; }
      var tr = el('tr');
      tr.appendChild(el('td', null, row.label));
      tr.appendChild(el('td', null, fmt(num(res.base[row.key]), dec)));
      tr.appendChild(el('td', null, fmt(num(res.final[row.key]), dec)));
      var cls = d > 0 ? 'up' : d < 0 ? 'down' : 'zero';
      tr.appendChild(el('td', cls, d === 0 ? '—' : signed(d, dec)));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);
    if (hiddenRows) {
      box.appendChild(el('p', 'hidden-note',
        '已隐藏 ' + hiddenRows + ' 项无变化的属性' + (hiddenRows === RESULT_ROWS.length ? '（当前没有加成落到面板）' : '')));
    }

    // 明细
    var active = [];
    Object.keys(res.acc || {}).forEach(function (k) {
      res.acc[k].list.forEach(function (item) { active.push(item); });
    });
    var inactive = res.inactive || [];
    var unapplied = res.unapplied || [];

    var btn = el('button', 'detail-toggle', '加成明细 ▾');
    var detail = el('div', 'detail');
    btn.onclick = function () {
      detail.classList.toggle('open');
      btn.textContent = detail.classList.contains('open') ? '加成明细 ▴' : '加成明细 ▾';
    };
    if (!active.length && !inactive.length && !unapplied.length) {
      btn.textContent = '加成明细（暂无生效加成）';
      btn.disabled = true;
    }
    box.appendChild(btn);
    box.appendChild(detail);

    if (active.length) {
      detail.appendChild(el('h4', null, '已生效'));
      var ul = el('ul');
      active.forEach(function (a) {
        var li = el('li');
        li.appendChild(el('span', 'val', fmtDelta(a.value, a.pct)));
        li.appendChild(el('span', null, a.relicName + (a.stageName ? '·' + a.stageName : '') + ' → ' + statLabel(a) + '（' + a.scopeLabel + '）'));
        ul.appendChild(li);
      });
      detail.appendChild(ul);
    }
    if (inactive.length) {
      detail.appendChild(el('h4', null, '条件未满足 / 未生效'));
      var ul2 = el('ul');
      inactive.forEach(function (a) {
        var li = el('li', 'off');
        li.appendChild(el('span', 'val', fmtDelta(a.value, a.pct)));
        li.appendChild(el('span', null, a.relicName + ' → ' + statLabel(a) + '（' + (a.reason || '条件') + '）'));
        ul2.appendChild(li);
      });
      detail.appendChild(ul2);
    }
    // spCost 这类「能解析、但面板里没有对应字段」的项，单独列出来，
    // 不再出现「明细说已生效、表格纹丝不动」的假象。
    if (unapplied.length) {
      detail.appendChild(el('h4', null, '未计入面板（无法量化到数值）'));
      var ul3 = el('ul');
      unapplied.forEach(function (a) {
        var li = el('li', 'unapplied');
        li.appendChild(el('span', 'val', fmtDelta(a.value, a.pct)));
        li.appendChild(el('span', null, a.relicName + (a.stageName ? '·' + a.stageName : '') +
          ' → ' + statLabel(a) + '（' + (a.reason || '无法结算') + '）'));
        ul3.appendChild(li);
      });
      detail.appendChild(ul3);
    }
  }

  // ---------- 汇总 ----------
  function sumCard(title) {
    var c = el('div', 'sum-card');
    c.appendChild(el('h3', null, title));
    return c;
  }

  // ---------- 汇总：编队面板对照 ----------
  // 汇总页原来只有几张矮卡片，下半屏全空。这张表把「全队现在什么面板」
  // 一次摊开，横向铺满；每格是「最终值 + 变化量」，和干员卡里的小表同口径。
  var TABLE_ROWS = [
    ['hp', '生命'], ['atk', '攻击力'], ['def', '防御力'],
    ['res', '法术抗性'], ['aspd', '攻击速度'], ['cost', '部署费用']
  ];

  function renderSquadTable() {
    var card = el('div', 'sum-card squad-table');
    card.appendChild(el('h3', null, '编队面板对照'));
    if (!state.squad.length) {
      card.appendChild(el('div', 'empty', '编队为空，先到「编队」页加人。'));
      return card;
    }
    var results = getResults();
    var table = el('table', 'op-table');
    var thead = el('thead');
    var htr = el('tr');
    htr.appendChild(el('th', null, '干员'));
    htr.appendChild(el('th', null, '职业'));
    TABLE_ROWS.forEach(function (r) { htr.appendChild(el('th', null, r[1])); });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tb = el('tbody');
    state.squad.forEach(function (op, i) {
      var res = results[i];
      if (!res) return;
      var tr = el('tr');
      tr.appendChild(el('td', 'nm', op.name || FALLBACK_NAME));
      tr.appendChild(el('td', 'muted', op.profession || ''));
      TABLE_ROWS.forEach(function (r) {
        var dec = S.decimalsOf(r[0]);
        var d = num(res.delta[r[0]]);
        var td = el('td', 'num');
        td.appendChild(el('span', 'f', fmt(num(res.final[r[0]]), dec)));
        if (d !== 0) td.appendChild(el('span', d > 0 ? 'up' : 'down', signed(d, dec)));
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
    return card;
  }

  // ---------- 伤害估算 ----------
  var DMG_FIELDS = [['dmgAtk', 'atk'], ['dmgScale', 'scale'], ['dmgDef', 'def'], ['dmgRes', 'res']];

  function syncDmgInputs() {
    DMG_FIELDS.forEach(function (pair) {
      var elx = document.getElementById(pair[0]);
      if (elx) elx.value = state.ctx[pair[0]];
    });
  }

  // 「用编队干员的面板」下拉：把某人的最终攻击力直接填进攻击力输入框，
  // 省掉「切到编队页抄一个数」这一步。
  function renderDmgFromOp() {
    var sel = document.getElementById('dmgFromOp');
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '';
    var head = document.createElement('option');
    head.value = '';
    head.textContent = '用编队干员的面板…';
    sel.appendChild(head);
    var results = getResults();
    state.squad.forEach(function (op, i) {
      var atk = results[i] && results[i].final ? results[i].final.atk
        : (op.panel && op.panel.atk);
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = (op.name || FALLBACK_NAME) + '（攻 ' + fmt(num(atk)) + '）';
      sel.appendChild(o);
    });
    var keepOk = keep !== '' && Number(keep) < state.squad.length;
    sel.value = keepOk ? keep : '';
  }

  function renderDmg() {
    var box = document.getElementById('dmgOut');
    if (!box) return;
    var c = state.ctx;
    var r = E.estimateDamage(
      { atk: c.dmgAtk, scale: c.dmgScale, def: c.dmgDef, res: c.dmgRes },
      getMods(), buildCtx()
    );
    box.innerHTML = '';
    [['物理', r.phys], ['法术', r.magic], ['真实', r.trueDmg]].forEach(function (kv) {
      var item = el('div', 'dmg-item');
      item.appendChild(el('span', 'dmg-k', kv[0]));
      item.appendChild(el('span', 'dmg-v', fmt(kv[1])));
      box.appendChild(item);
    });
    var d = r.detail;
    var parts = ['攻击 ' + fmt(d.atk) + '×' + fmt(d.scale) + ' = ' + fmt(d.raw)];
    if (d.enemyDef) parts.push('防御 ' + fmt(d.enemyDef) + (d.defIgnore ? '（无视 ' + fmt(d.defIgnore) + '% → ' + fmt(d.effDef) + '）' : ''));
    if (d.enemyRes) parts.push('法抗 ' + fmt(d.enemyRes) + '%');
    if (d.dealt) parts.push('造成伤害 +' + fmt(d.dealt) + '%');
    if (d.weak) parts.push('脆弱 +' + fmt(d.weak) + '%');
    if (d.physTaken) parts.push('物伤易伤 +' + fmt(d.physTaken) + '%');
    if (d.magicTaken) parts.push('法伤易伤 +' + fmt(d.magicTaken) + '%');
    if (d.trueTaken) parts.push('真伤易伤 +' + fmt(d.trueTaken) + '%');
    box.appendChild(el('div', 'dmg-note', parts.join('；')));
  }

  function renderSummary() {
    var box = document.getElementById('summaryBody');
    box.innerHTML = '';
    var s = getSummary();
    var mods = getMods();

    // 按「属性 + 作用域」聚合，避免把「先锋+50%」和「狙击+60%」加成一个数。
    // 条件未满足的项（ok === false）不计入合计，但单独计数 —— 全吞掉的话
    // 用户只会看到一张空卡，看不出「有加成、只是当前战斗状态没满足」。
    // 每个分组保留 items：点开一行就能看到这条合计由哪几件藏品贡献。
    function groupOf(items, labelFn) {
      var groups = {}, order = [], unmet = 0;
      items.forEach(function (it) {
        if (!it) return;
        if (it.ok === false) { unmet++; return; }
        var lab = labelFn(it);
        var key = lab + '|' + (it.pct ? 'pct' : 'flat');
        if (!groups[key]) { groups[key] = { label: lab, pct: !!it.pct, sum: 0, items: [] }; order.push(key); }
        groups[key].sum += it.value;
        groups[key].items.push(it);
      });
      return { groups: order.map(function (k) { return groups[k]; }), unmet: unmet };
    }

    function fill(card, grouped, limit) {
      var groups = grouped.groups;
      if (!groups.length) {
        card.appendChild(el('div', 'empty', '无'));
      } else {
        var ul = el('ul');
        groups.slice(0, limit).forEach(function (g) {
          var li = el('li', 'g-line');
          var head = el('div', 'g-head');
          head.appendChild(el('span', 'k', g.label));
          head.appendChild(el('span', 'v', fmtDelta(g.sum, g.pct)));
          li.appendChild(head);
          if (g.items.length) {
            var det = el('ul', 'g-detail');
            g.items.forEach(function (it) {
              var d = el('li');
              d.appendChild(el('span', 'k',
                it.relicName + (it.stageName ? ' · ' + it.stageName : '')));
              d.appendChild(el('span', 'v', fmtDelta(it.value, it.pct)));
              det.appendChild(d);
            });
            li.appendChild(det);
            li.title = '点击展开：' + g.items.length + ' 件藏品贡献';
            li.onclick = function () { li.classList.toggle('open'); };
          }
          ul.appendChild(li);
        });
        card.appendChild(ul);
        if (groups.length > limit) card.appendChild(el('div', 'empty', '还有 ' + (groups.length - limit) + ' 条未显示'));
      }
      // 弱化提示，不进合计
      if (grouped.unmet) {
        card.appendChild(el('div', 'unmet', '另有 ' + grouped.unmet + ' 项条件未满足（当前战斗状态）'));
      }
    }

    // 面板加成：只遍历 s.panel（引擎已把 run 拆出去了）
    var c1 = sumCard('面板加成（按作用域）');
    var panelItems = [];
    Object.keys(s.panel).forEach(function (k) {
      (s.panel[k].items || []).forEach(function (it) {
        panelItems.push(Object.assign({ stat: k }, it));
      });
    });
    // group 是「互斥分支」标签（如四种元素损伤），同一属性下要分行而不是求和
    function statLabelWithGroup(it) {
      return S.labelOf(it.stat) + (it.group ? '·' + it.group : '');
    }
    fill(c1, groupOf(panelItems, function (it) {
      return statLabelWithGroup(it) + '（' + it.scope + '）';
    }), 14);
    box.appendChild(c1);

    // 战斗加成
    var c2 = sumCard('战斗类加成');
    var combatItems = [];
    Object.keys(s.combat).forEach(function (k) {
      (s.combat[k].items || []).forEach(function (it) {
        combatItems.push(Object.assign({ stat: k }, it));
      });
    });
    fill(c2, groupOf(combatItems, function (it) {
      return statLabelWithGroup(it) + (it.enemy ? '（对敌）' : '');
    }), 12);
    box.appendChild(c2);

    // 探索资源：只遍历 s.run
    var c3 = sumCard('探索 / 运营');
    var runItems = [];
    Object.keys(s.run).forEach(function (k) {
      (s.run[k].items || []).forEach(function (it) {
        runItems.push(Object.assign({ stat: k }, it));
      });
    });
    fill(c3, groupOf(runItems, function (it) {
      return statLabelWithGroup(it) + '（' + it.scope + '）';
    }), 12);
    box.appendChild(c3);

    // 特殊效果（文案无法量化）
    var c4 = sumCard('特殊效果（不改变数值）');
    c4.appendChild(el('div', 'sum-note',
      '这些藏品不落面板、也不进战斗修正：招募/掉落/节点/结局条件、战术道具等，只能人工判断。'));
    var ul4 = el('ul');
    var seen = {};
    var any4 = false;
    (s.special || []).forEach(function (m) {
      var key = m.relicId + '|' + m.text;
      if (seen[key]) return;
      seen[key] = 1;
      var li = el('li');
      li.appendChild(el('span', 'k', m.relicName));
      li.appendChild(el('span', 'v', m.text));
      ul4.appendChild(li);
      any4 = true;
    });
    if (any4) c4.appendChild(ul4); else c4.appendChild(el('div', 'empty', '无'));
    box.appendChild(c4);

    // 未计入面板（能解析、但注册表声明不可结算，如技力消耗）
    var c5 = sumCard('未计入面板（数值不可结算）');
    var ul5 = el('ul');
    var any5 = false;
    (s.unapplied || []).forEach(function (a) {
      // 一条 = 一个 <li>，原因作为第二行（.why），不再和条目平级
      var li = el('li', 'u-item');
      var head = el('div', 'u-head');
      head.appendChild(el('span', 'k', a.relicName + ' → ' + statLabel(a)));
      head.appendChild(el('span', 'v', fmtDelta(a.value, a.pct)));
      li.appendChild(head);
      li.appendChild(el('span', 'why', a.reason || '无法结算'));
      ul5.appendChild(li);
      any5 = true;
    });
    if (any5) c5.appendChild(ul5); else c5.appendChild(el('div', 'empty', '无'));
    box.appendChild(c5);

    // 统计
    var c6 = sumCard('解析统计');
    var total = 0, official = 0, byText = 0, specialOnly = 0;
    Object.keys(state.relics).forEach(function (id) {
      var r = Relics.getById(id);
      if (!r) return;
      total++;
      var p = E.parseRelic(r, state.relics[id].stage || 0);
      if (!p.mods.length) specialOnly++;
      else if (p.source === 'official' || p.source === 'official+text') official++;
      else byText++;
    });
    var ul6 = el('ul');
    [['已选藏品', total + ' 件'], ['官方结构化', official + ' 件'], ['文案解析', byText + ' 件'],
     ['仅特殊效果', specialOnly + ' 件'],
     ['修正项', mods.filter(function (m) { return m.bucket !== 'special'; }).length + ' 条'],
     ['编队', state.squad.length + ' / ' + MAX_SQUAD + ' 人']]
      .forEach(function (kv) {
        var li = el('li');
        li.appendChild(el('span', 'k', kv[0]));
        li.appendChild(el('span', 'v', kv[1]));
        ul6.appendChild(li);
      });
    c6.appendChild(ul6);
    box.appendChild(c6);

    box.appendChild(renderSquadTable());

    // 角标与条件摘要跟着汇总一起刷新：所有会改变结果的路径最终都会走到这里
    renderBadges(s);
    renderCtxImpact(s);
    renderCtxNeed(mods);
    renderCtxUnmet(s);
    renderDmg();
}

  // ---------- 编队槽位条 ----------
  // 12 个固定槽位：空槽是「添加入口」，满槽是「定位到卡片 + 一键移出」。
  // 比顶部那行「已选 5/12」更能说明「还差几个、差在哪个位置」。
  function renderStrip() {
    var box = document.getElementById('squadStrip');
    if (!box) return;
    box.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < MAX_SQUAD; i++) {
      var op = state.squad[i];
      if (!op) {
        var empty = el('div', 'slot empty', '+');
        empty.dataset.slot = String(i);
        empty.title = '第 ' + (i + 1) + ' 位 · 点击添加干员';
        empty.onclick = openPickerForNew;
        frag.appendChild(empty);
        continue;
      }
      frag.appendChild(slotOf(op, i));
    }
    box.appendChild(frag);
  }

  function slotOf(op, idx) {
    var s = el('div', 'slot');
    s.dataset.slot = String(idx);
    if (op.profession) s.dataset.prof = op.profession;
    s.title = (op.name || FALLBACK_NAME) + ' · 点击定位到这张卡';
    s.appendChild(el('span', 'slot-name', op.name || FALLBACK_NAME));
    var sub = op.position ? (/远程/.test(op.position) ? '远程' : '近战') : '';
    s.appendChild(el('span', 'slot-prof', (op.profession || '') + (sub ? ' · ' + sub : '')));

    var x = el('button', 'slot-x', '×');
    x.title = '移出编队';
    x.onclick = function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      Squad.removeAt(state.squad, idx);
      afterSquadChange();
    };
    s.appendChild(x);
    s.onclick = function () { focusCard(idx); };
    return s;
  }

  // 槽位 → 卡片：滚到视野内并闪一下，避免「点了没反应」
  function focusCard(idx) {
    var list = document.getElementById('squadList');
    var kids = (list && list.children) || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (!c || !c.dataset || c.dataset.idx !== String(idx)) continue;
      if (c.scrollIntoView) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      c.classList.add('flash');
      setTimeout(function () { c.classList.remove('flash'); }, 900);
      return;
    }
  }

  function openPickerForNew() {
    if (state.squad.length >= MAX_SQUAD) { toast('编队已满（' + MAX_SQUAD + ' 人），先移出一位'); return; }
    if (!state.ui.pickerOpen) togglePicker(true);
    var box = document.getElementById('opPicker');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var s = document.getElementById('opSearch');
    if (s && s.focus) s.focus();
  }

  // ---------- 编队网格 ----------
  function renderSquadMeta() {
    document.getElementById('squadCount').textContent = state.squad.length;
    var p = document.getElementById('squadProgress');
    if (p) p.textContent = '已选 ' + state.squad.length + '/' + MAX_SQUAD;
  }

  function renderPickerFilters() {
    var profBox = document.getElementById('profFilter');
    profBox.innerHTML = '';
    var all = el('button', 'chip' + (state.ui.pickerProf === '' ? ' on' : ''), '全部职业');
    all.onclick = function () { state.ui.pickerProf = ''; renderPickerFilters(); renderPicker(); };
    profBox.appendChild(all);
    PROFESSIONS.forEach(function (p) {
      var b = el('button', 'chip' + (state.ui.pickerProf === p ? ' on' : ''), p);
      b.onclick = function () {
        state.ui.pickerProf = state.ui.pickerProf === p ? '' : p;
        renderPickerFilters();
        renderPicker();
      };
      profBox.appendChild(b);
    });

    var starBox = document.getElementById('starFilter');
    starBox.innerHTML = '';
    [['', '全部星级'], ['6', '6 星'], ['5', '5 星'], ['4-', '4 星及以下']].forEach(function (kv) {
      var b = el('button', 'chip' + (state.ui.pickerStar === kv[0] ? ' on' : ''), kv[1]);
      b.onclick = function () {
        state.ui.pickerStar = kv[0];
        renderPickerFilters();
        renderPicker();
      };
      starBox.appendChild(b);
    });
  }

  function renderPicker() {
    if (!state.ui.pickerOpen) return;
    var grid = document.getElementById('opGrid');
    if (!grid) return;

    var hits = OP.search(state.ui.pickerSearch, {
      profession: state.ui.pickerProf,
      rarity: state.ui.pickerStar
    });
    var full = state.squad.length >= MAX_SQUAD;

    // 452 张卡片必然要滚动：重建前存、重建后还原，和 renderRelicList 保持一致
    var keepScroll = grid.scrollTop || 0;
    grid.innerHTML = '';
    var frag = document.createDocumentFragment();
    hits.forEach(function (o) {
      var picked = indexOfName(o.name) >= 0;
      var locked = full && !picked;
      var tile = el('div', 'op-tile' + (picked ? ' on' : '') + (locked ? ' locked' : ''));
      tile.dataset.name = o.name;
      tile.dataset.prof = o.profession || '';
      if (locked) tile.title = '编队已满（' + MAX_SQUAD + ' 人）';
      // 卡片是 div 不是 button：不给角色和可访问名，读屏只会念「div」
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-pressed', picked ? 'true' : 'false');
      tile.setAttribute('aria-label',
        o.name + '，' + (o.profession || '未知职业') + '，' + (o.rarity || 0) + ' 星' +
        (o.subProfession ? '，' + o.subProfession : '') +
        (picked ? '，已在编队' : locked ? '，编队已满' : '，未在编队'));
      tile.setAttribute('tabindex', '0');
      tile.onkeydown = function (e) {
        if (e && (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32)) {
          if (e.preventDefault) e.preventDefault();
          togglePick(o);
        }
      };

      // 头像资源还没进仓库：有 avatar 就用图，没有就退回职业色块
      var av = el('div', 'tile-avatar');
      if (o.avatar) {
        var img = document.createElement('img');
        img.src = o.avatar;
        img.alt = o.name;
        av.appendChild(img);
      } else {
        av.textContent = EN.PROF_SHORT[o.profession] || '·';
      }
      tile.appendChild(av);

      var body = el('div', 'tile-body');
      body.appendChild(el('span', 'tile-name', o.name));
      body.appendChild(el('span', 'tile-meta',
        '★' + (o.rarity || 0) + (o.subProfession ? ' · ' + o.subProfession : '')));
      tile.appendChild(body);

      if (picked) tile.appendChild(el('span', 'tile-check', '✓'));

      tile.onclick = function () { togglePick(o); };
      frag.appendChild(tile);
    });
    grid.appendChild(frag);
    grid.scrollTop = keepScroll;

    var cnt = document.getElementById('pickerCount');
    if (cnt) {
      cnt.textContent = '显示 ' + hits.length + ' 人 · 已选 ' + state.squad.length + '/' + MAX_SQUAD;
    }
    if (!hits.length) {
      grid.appendChild(el('p', 'empty', '没有匹配的干员，换个关键词或放宽筛选。'));
    }
  }

  function togglePicker(force) {
    state.ui.pickerOpen = (force == null) ? !state.ui.pickerOpen : !!force;
    var box = document.getElementById('opPicker');
    var btn = document.getElementById('btnTogglePicker');
    if (state.ui.pickerOpen) {
      box.classList.remove('hidden');
      if (btn) btn.textContent = '收起';
      renderPicker();
    } else {
      box.classList.add('hidden');
      if (btn) btn.textContent = '添加干员';
    }
  }

  // 点卡片 = 加入 / 移出（同一个入口，所以「再点一次取消」是天然行为）
  function togglePick(o) {
    var idx = indexOfName(o.name);
    if (idx >= 0) {
      Squad.removeAt(state.squad, idx);
      afterSquadChange();
      return;
    }
    var r = Squad.add(state.squad, OP.makeSquadEntry(o));
    if (!r.ok) { toast(r.reason); return; }
    afterSquadChange();
  }

  function addBlank() {
    // 名字由仓储按「当前编队里没被占用的最小序号」生成，否则第二次会被按名判重拒绝
    var r = Squad.add(state.squad, OP.makeBlankEntry(state.squad));
    if (!r.ok) { toast(r.reason); return; }
    afterSquadChange();
  }

  // 编队结构变化后的统一收尾：存档 + 重画编队/汇总/网格/预设
  function afterSquadChange() {
    save();
    renderSquad();
    renderSummary();
    renderPresets();
    renderPicker();
  }

  // ---------- 弹窗 ----------
  var lastFocus = null;

  // 弹窗里可 Tab 到的元素。DOM 桩没有 querySelectorAll，取不到就返回空数组 ——
  // 焦点陷阱只是增强，拿不到列表时不能把键盘操作整个卡死。
  function focusablesIn(box) {
    if (!box || typeof box.querySelectorAll !== 'function') return [];
    var nodes = box.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, function (n) {
      return !n.disabled;
    });
  }

  function openModal(buildFn) {
    var m = document.getElementById('modal');
    var b = document.getElementById('modalBody');
    b.innerHTML = '';
    buildFn(b);
    m.classList.remove('hidden');
    // 弹窗没有名字的话读屏只会念「对话框」。标题是 buildFn 里画的 h2，回填一次。
    var h2 = b.children.filter(function (c) { return c && c.tagName === 'H2'; })[0];
    if (h2 && h2.textContent) m.setAttribute('aria-label', h2.textContent);
    // 打开时把焦点移进弹窗，关闭时还给原来那个元素 —— 否则键盘 / 读屏用户会迷路
    lastFocus = document.activeElement || null;
    var close = document.getElementById('modalClose');
    if (close && typeof close.focus === 'function') close.focus();
  }
  function closeModal() {
    document.getElementById('modal').classList.add('hidden');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* 元素已被移除，忽略 */ }
    }
    lastFocus = null;
  }

  function showRelicModal(r) {
    openModal(function (b) {
      b.appendChild(el('h2', null, r.name));
      var meta = el('p', null, 'No.' + r.id + ' · ' + r.category + ' · ' + (RARITIES[r.rarity] || '普通') +
        ((r.flags || []).length ? ' · ' + r.flags.join(',') : ''));
      meta.style.color = '#8a9aa6';
      b.appendChild(meta);
      b.appendChild(el('h3', null, '效果'));
      b.appendChild(el('p', null, r.effect));
      if (r.desc) { b.appendChild(el('h3', null, '描述')); b.appendChild(el('p', null, r.desc)); }
      if (r.condition) { b.appendChild(el('h3', null, '解锁条件')); b.appendChild(el('p', null, r.condition)); }
      if (r.obtain) { b.appendChild(el('h3', null, '获取方式')); b.appendChild(el('p', null, r.obtain)); }
      if (r.note) { b.appendChild(el('h3', null, '备注')); b.appendChild(el('p', null, r.note)); }
    });
  }

  // ---------- 干员详情 ----------
  // 图鉴数据（三档面板 / 技能 / 天赋 / 模组 / 攻击范围）都在库里，
  // 这里只负责摆出来；数值计算仍然只认编队里的 panel，详情页不改任何计算口径。
  var ELITE_LABEL = ['精英零', '精英一', '精英二'];

  function tag(txt, cls) { return el('span', 'tag' + (cls ? ' ' + cls : ''), txt); }

  // 攻击范围：把格子坐标画成方阵。(0,0) 是干员自己站的那格。
  function renderRangeGrid(range) {
    var box = el('div', 'range-grid');
    if (!range || !range.grids || !range.grids.length) {
      box.appendChild(el('span', 'muted', '（该范围没有格子数据）'));
      return box;
    }
    var set = Object.create(null);
    var minR = 0, maxR = 0, minC = 0, maxC = 0;
    range.grids.forEach(function (g) {
      var r = num(g[0]), c = num(g[1]);
      set[r + ',' + c] = 1;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    });
    box.style.gridTemplateColumns = 'repeat(' + (maxC - minC + 1) + ', 18px)';
    for (var r = minR; r <= maxR; r++) {
      for (var c = minC; c <= maxC; c++) {
        var cls = 'range-cell';
        if (set[r + ',' + c]) cls += ' on';
        if (r === 0 && c === 0) cls += ' self';
        box.appendChild(el('i', cls));
      }
    }
    return box;
  }

  function showOperatorModal(ref) {
    var d = OP.detail(ref);
    if (!d) { toast('图鉴里没有这名干员，可能是在编队里手动改过名字'); return; }

    openModal(function (b) {
      var title = d.name + '　' + '★'.repeat(d.rarity || 0);
      var h2 = el('h2', null, title);
      // 星号读屏只会念「星号星号」，给它一句人话
      h2.setAttribute('aria-label', d.name + '，' + (d.rarity || 0) + ' 星');
      b.appendChild(h2);
      var meta = el('p', 'op-detail-meta',
        [d.profession, d.subProfession, d.position].filter(Boolean).join(' · ') +
        (d.displayNumber ? ' · No.' + d.displayNumber : '') +
        (d.appellation ? ' · ' + d.appellation : '') +
        (d.obtain ? ' · ' + d.obtain : ''));
      b.appendChild(meta);

      if ((d.tags || []).length) {
        var tagRow = el('div', 'tag-row');
        d.tags.forEach(function (t) { tagRow.appendChild(tag(t)); });
        b.appendChild(tagRow);
      }

      if (d.trait) {
        b.appendChild(el('h3', null, '特性'));
        b.appendChild(el('p', null, d.trait));
      }

      // ---- 精英化三档 ----
      b.appendChild(el('h3', null, '精英化面板'));
      if (!d.phases.length) {
        b.appendChild(el('p', 'muted', '这份数据里没有分阶段面板。'));
      } else {
        var t1 = el('table', 'op-table detail-table');
        var htr = el('tr');
        ['阶段', '等级', '生命', '攻击', '防御', '法抗', '阻挡', '费用', '间隔', ''].forEach(function (h) {
          htr.appendChild(el('th', null, h));
        });
        t1.appendChild(htr);
        d.phases.forEach(function (p) {
          var tr = el('tr');
          tr.appendChild(el('td', 'nm', ELITE_LABEL[p.elite] || ('E' + p.elite)));
          [p.level, p.hp, p.atk, p.def, p.res, p.block, p.cost, p.interval].forEach(function (v, i) {
            tr.appendChild(el('td', 'num', i === 7 ? String(v) : String(v)));
          });
          var td = el('td', 'act');
          var use = el('button', 'tiny', '用此面板');
          use.onclick = function () { applyPhase(d, p.elite); };
          td.appendChild(use);
          tr.appendChild(td);
          t1.appendChild(tr);
        });
        var w1 = el('div', 'table-wrap');
        w1.appendChild(t1);
        b.appendChild(w1);
        b.appendChild(el('p', 'muted',
          '「用此面板」会把该阶段的面板填进编队（已在编队则直接替换）。满信赖加成按干员固定值另算。'));
      }

      // ---- 技能 ----
      b.appendChild(el('h3', null, '技能'));
      d.skills.forEach(function (s) {
        var box = el('div', 'skill');
        var head = el('div', 'skill-head');
        head.appendChild(el('b', null, 'S' + s.slot + ' ' + s.name));
        head.appendChild(tag(s.chargeType || '—'));
        head.appendChild(tag(s.activation || '—'));
        head.appendChild(tag('SP ' + s.spCost + (s.initSp ? ' / 初 ' + s.initSp : '')));
        if (s.duration) head.appendChild(tag('持续 ' + s.duration + 's'));
        // 只在七级与专三不同时才提示，否则同一组数字会重复两遍
        if (s.spCost7 && s.spCost7 !== s.spCost) head.appendChild(tag('七级 ' + s.spCost7, 'dim'));
        box.appendChild(head);
        var desc = el('p', 'skill-desc', s.desc || '');
        box.appendChild(desc);
        if (s.rangeId) {
          var rg = OP.rangeOf(s.rangeId);
          if (rg) box.appendChild(renderRangeGrid(rg));
        }
        b.appendChild(box);
      });
      b.appendChild(el('p', 'muted',
        d.skills.length
          ? '技能数值取专精三级（10 级技能表最后一档）；被动技能的 SP 一栏没有意义。'
          : '这名干员没有技能数据（召唤物、特殊形态或数据表里未登记）。'));

      // ---- 天赋 ----
      if (d.talents.length) {
        b.appendChild(el('h3', null, '天赋'));
        d.talents.forEach(function (t) {
          var box = el('div', 'talent');
          var head = el('div', 'talent-head');
          head.appendChild(el('b', null, t.name || ('天赋 ' + t.idx)));
          head.appendChild(tag(ELITE_LABEL[t.unlockElite] || 'E0', 'dim'));
          box.appendChild(head);
          box.appendChild(el('p', 'skill-desc', t.desc || ''));
          b.appendChild(box);
        });
        b.appendChild(el('p', 'muted',
          '天赋展示的是「最高精英化 + 无潜能要求」那一版；潜能把天赋强化到更高数值的版本没有单列。'));
      }

      // ---- 模组 ----
      if (d.modules.length) {
        b.appendChild(el('h3', null, '模组'));
        d.modules.forEach(function (m) {
          var box = el('div', 'module');
          var head = el('div', 'module-head');
          head.appendChild(el('b', null, m.name));
          if (m.type && m.type !== 'INITIAL') head.appendChild(tag(m.type, 'dim'));
          if (m.unlockElite) head.appendChild(tag('解锁 ' + ELITE_LABEL[m.unlockElite] + ' ' + m.unlockLevel + ' 级', 'dim'));
          box.appendChild(head);
          if (!m.levels.length) {
            box.appendChild(el('p', 'muted', '证章类模组，不提供属性加成。'));
          } else {
            var t2 = el('table', 'op-table detail-table');
            var h2 = el('tr');
            ['档位', '生命', '攻击', '防御', '法抗', '攻速', '费用', '阻挡', '效果'].forEach(function (h) {
              h2.appendChild(el('th', null, h));
            });
            t2.appendChild(h2);
            var lastDesc = '';
            m.levels.forEach(function (lv) {
              var changed = !!lv.desc && lv.desc !== lastDesc;
              if (lv.desc) lastDesc = lv.desc;
              var tr = el('tr');
              tr.appendChild(el('td', 'nm', 'Lv' + lv.level));
              [lv.hp, lv.atk, lv.def, lv.res, lv.aspd, lv.cost, lv.block].forEach(function (v) {
                tr.appendChild(el('td', 'num', v ? '+' + v : '—'));
              });
              // 效果文案逐档重复会让三行长得一模一样，只在变化的那一档写出来
              tr.appendChild(el('td', 'desc', changed ? lv.desc : (lastDesc ? '（同上）' : '—')));
              t2.appendChild(tr);
            });
            var w2 = el('div', 'table-wrap');
            w2.appendChild(t2);
            box.appendChild(w2);
            box.appendChild(el('p', 'muted', '与上一档相同的效果文案不重复显示，沿用上一档。'));
          }
          b.appendChild(box);
        });
      }

      // ---- 攻击范围 ----
      if (d.range) {
        b.appendChild(el('h3', null, '攻击范围（' + ELITE_LABEL[d.elite] + '）'));
        b.appendChild(renderRangeGrid(d.range));
      }

      if ((d.potential || []).length) {
        b.appendChild(el('h3', null, '潜能'));
        var ul = el('ul');
        d.potential.forEach(function (p, i) { ul.appendChild(el('li', null, (i + 1) + '. ' + p)); });
        b.appendChild(ul);
      }
    });
  }

  // 详情页的「用此面板」：已经在编队里就替换面板，否则新增一条
  function applyPhase(d, elite) {
    var panel = OP.panelAt(d.id, elite);
    if (!panel) { toast('这一档没有面板数据'); return; }
    var idx = indexOfName(d.name);
    if (idx >= 0) {
      state.squad[idx].panel = panel;
      toast('已换成' + (ELITE_LABEL[elite] || 'E' + elite) + '面板');
    } else {
      var r = Squad.add(state.squad, OP.makeSquadEntry(d, panel));
      if (!r.ok) { toast(r.reason); return; }
      idx = state.squad.length - 1;
      toast('已按' + (ELITE_LABEL[elite] || 'E' + elite) + '面板加入编队');
    }
    closeModal();
    afterSquadChange();
    // closeModal 把焦点还给「详情」按钮，但那颗按钮刚被 renderSquad 重建掉了，
    // 焦点会掉到 body。这里重新落到新卡片的「详情」上，键盘用户不会迷路。
    focusDetailOf(idx);
  }

  function focusDetailOf(idx) {
    if (typeof document.querySelectorAll !== 'function') return;
    var card = document.querySelectorAll('.op-card')[idx];
    if (!card || typeof card.querySelectorAll !== 'function') return;
    var btns = card.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent === '详情') { btns[i].focus(); return; }
    }
  }

  function showHelp() {
    openModal(function (b) {
      b.appendChild(el('h2', null, '计算口径与公式'));
      b.appendChild(el('p', null, '藏品加成按「先固定、后百分比」结算，与游戏内面板属性的结算顺序一致：'));

      var pre = el('p');
      pre.innerHTML = '最终值 = <code>floor((基础值 + Σ固定加成) × (1 + Σ百分比加成))</code>';
      b.appendChild(pre);

      b.appendChild(el('h3', null, '基础值从哪来'));
      b.appendChild(el('p', null, '内置干员数据取「精英二满级」面板（不含潜能），可选叠加满信赖加成；手动填面板时，请填「未带任何藏品时」的数值。'));

      b.appendChild(el('h3', null, '攻击间隔'));
      b.appendChild(el('p', null, '攻速以 100 为基准。最终攻击间隔 = 基础攻击间隔 × 100 ÷ 最终攻速。'));

      b.appendChild(el('h3', null, '条件类藏品'));
      b.appendChild(el('p', null, '「战斗开始 60 秒内」「生命值低于 30%」「每有 5 源石锭」这类效果需要用到「战斗状态」里的设定；条件不满足时该项会在明细里划掉，不会计入最终值。'));

      b.appendChild(el('h3', null, '没有自动算到的部分'));
      b.appendChild(el('p', null, '防御力/法抗百分比、敌人减益、战术道具、事件类效果等，凡是无法安全换算成面板数值的，都会原样出现在「特殊效果（未能自动量化）」里。'));
      b.appendChild(el('p', null, '「技力消耗」这类干员数据表里没有对应字段的属性，会列在「未计入面板」里并说明原因 —— 它们确实被解析到了，但没法落到面板上。'));

      b.appendChild(el('h3', null, '已知简化'));
      var ul = el('ul');
      ['不含潜能加成（潜能对部署费用/防御等的影响请自行加到基础面板）。',
        '「场上职业人数」需要手动填，默认 0；「按编队填充」会用当前编队各职业人数填一次。',
        '攻速、阻挡、技力回复的百分比加成极少见，按基础值线性处理。',
        '「下一个招募或进阶的干员」类一次性藏品，只对勾了「一次性藏品指定此人」的干员生效。'
      ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
      b.appendChild(ul);

      b.appendChild(el('h3', null, '数据来源'));
      b.appendChild(el('p', null, '藏品效果数值来自游戏数据表 roguelike_topic_table.json 里每件藏品的 buffs/blackboard（结构化：属性、倍率、职业选择器直接读值），文案取官方 usage 字段；解析不到的部分才退回中文文案规则解析，列表里会标「官方结构化」或「文案解析」。'));
      b.appendChild(el('p', null, '干员数据来自 character_table.json（三档精英化面板、天赋、潜能、特性）、skill_table.json（技能数值与文案）、uniequip_table.json 与 battle_equip_table.json（模组）、range_table.json（攻击范围）；中文分支名来自 PRTS。点编队卡上的「详情」可以看这些数据。仅供个人计算参考，以游戏内表现为准。'));
      b.appendChild(el('p', null, '本站为玩家二创工具，与鹰角网络及《明日方舟》官方无关；不收集任何个人信息，编队与藏品选择只存在你自己的浏览器里。'));

      // 数据版本块：用户反馈「某个数值不对」时，先要能确认两边看的是不是同一份数据
      b.appendChild(renderDataMeta());
    });
  }

  // 数据里存的是 UTC（…Z）。直接显示会比本地时钟差几个小时，用户报「某个数值不对」
  // 时对不上自己的时间，所以这里转成本地时区再显示。
  function fmtBuiltAt(s) {
    if (!s) return '-';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '（本地）';
  }

  function renderDataMeta() {
    var m = DB.meta() || {};
    var counts = m.counts || {};
    var rows = [
      ['资源版本', assetVersion()],
      ['数据版本', 'schema v' + m.schemaVersion + (m.gameVersion ? ' · ' + m.gameVersion : '')],
      ['数据指纹', m.dataHash || '-'],
      ['构建时间', fmtBuiltAt(m.builtAt)],
      ['表行数', '藏品 ' + (counts.relics || 0) + ' · 档位 ' + (counts.relic_stages || 0) +
                 ' · 干员 ' + (counts.operators || 0) + ' · 技能 ' + (counts.operator_skills || 0) +
                 ' · 天赋 ' + (counts.operator_talents || 0) +
                 ' · 模组 ' + (counts.operator_modules || 0)],
      ['存档格式', 'v' + Migrate.VERSION + '（编队 / 藏品选择 / 预设 / 设置）']
    ];
    var box = el('div', 'data-meta');
    rows.forEach(function (r) {
      box.appendChild(el('span', null, r[0]));
      box.appendChild(el('span', 'mono data-meta-v', r[1]));
    });
    return box;
  }

  // 落盘的是「表」不是内存对象：selection / squads / presets / settings 四张表，
  // 由 core/db/migrate.js 负责形状转换（编队顺序靠 ord 列，ctx 拆成 key/value 行）。
  //
  // 顺序刻意是 state → 表 → 运行时 DB → JSON：写出去的内容直接来自 DB 的四张表，
  // 而不是另拼一份对象。这样「数据库」不是摆设 —— 导出、分享、存档用的是同一份数据，
  // DB.table('squads') 也随时能查到真正落盘的那一份。
  function archiveObject() {
    var arc = Migrate.toArchive({
      relics: state.relics,
      squad: state.squad,
      ctx: state.ctx,
      presets: state.presets
    });
    Migrate.install(arc.tables);
    return Migrate.snapshot();
  }

  function showImport() {
    openModal(function (b) {
      b.appendChild(el('h2', null, '导入配置'));
      b.appendChild(el('p', null, '把之前「导出」出来的 JSON 粘贴进来，点导入即可恢复藏品与编队。损坏的条目会被跳过。'));
      var ta = document.createElement('textarea');
      b.appendChild(ta);
      var btn = el('button', 'primary', '导入');
      btn.style.marginTop = '10px';
      btn.onclick = function () {
        var d;
        try {
          d = JSON.parse(ta.value);
        } catch (e) {
          alert('JSON 解析失败：' + e.message);
          return;
        }
        var r = applyArchive(d);
        if (!r.ok) { alert('导入失败：' + r.reason); return; }
        var saved = saveNow();
        renderAll();
        closeModal();
        // 写失败时 saveNow 已经弹过原因，这里不再用「已导入」把它盖掉
        if (saved) {
          toast('已导入' + (r.dropped ? '，已忽略 ' + r.dropped + ' 条损坏数据' : ''));
        }
      };
      b.appendChild(btn);
    });
  }

  function showExport() {
    openModal(function (b) {
      b.appendChild(el('h2', null, '导出配置'));
      b.appendChild(el('p', null, '复制下面的 JSON 保存，换设备或清空后可再导入。'));
      var ta = document.createElement('textarea');
      ta.value = JSON.stringify(archiveObject(), null, 2);
      b.appendChild(ta);
      ta.select();
    });
  }

  // ---------- 分享链接 ----------
  // 把配置塞进 URL 的 #cfg= 里，发条链接就能带着编队和藏品走。
  // 用 hash 而不是 query：hash 不会发到服务器，也不参与缓存键。
  //
  // 为什么不用现成的 v3 存档直接编码：那样一个人就占 1.1 KB，12 人编队 base64 之后
  // 接近 14 KB，聊天软件会截断。这里只编码真正要传的字段，面板按 PANEL_FIELDS 的顺序
  // 压成数字数组，12 人编队大约 2 KB。
  var SHARE_MAX = 6000;   // 超过这个长度很多聊天软件会截断，直接劝用户用导出
  var PACK_VERSION = 1;
  var PANEL_ORDER = S.PANEL_FIELDS.map(function (f) { return f.key; });

  function packOp(o) {
    var panel = PANEL_ORDER.map(function (k) { return num(o.panel && o.panel[k]); });
    var favor = o.favor ? [num(o.favor.hp), num(o.favor.atk), num(o.favor.def)] : 0;
    var out = [
      o.name || '', o.profession || '', o.subProfession || '', o.position || '',
      num(o.rarity), panel, favor,
      o.useFavor === false ? 0 : 1,     // 必须显式带上：false 是「不用信赖」，不是默认值
      o.assignTarget ? 1 : 0,
      o.summon ? 1 : 0
    ];
    if (o.avatar) out.push(o.avatar);
    return out;
  }

  function unpackOp(a) {
    if (!Array.isArray(a)) return null;
    var panel = {};
    PANEL_ORDER.forEach(function (k, i) { panel[k] = num((a[5] || [])[i]); });
    var fav = a[6];
    return {
      name: String(a[0] || ''),
      profession: String(a[1] || ''),
      subProfession: String(a[2] || ''),
      position: String(a[3] || '近战位'),
      rarity: num(a[4]),
      panel: panel,
      favor: Array.isArray(fav) ? { hp: num(fav[0]), atk: num(fav[1]), def: num(fav[2]) } : null,
      useFavor: a[7] !== 0,
      assignTarget: !!a[8],
      summon: !!a[9],
      avatar: typeof a[10] === 'string' ? a[10] : ''
    };
  }

  function packConfig() {
    return {
      v: PACK_VERSION,
      r: Object.keys(state.relics).map(function (id) {
        var v = state.relics[id] || {};
        return [id, num(v.stage), num(v.stack)];
      }),
      s: state.squad.map(packOp),
      c: state.ctx,
      p: state.presets.map(function (p) {
        return [String(p.name || ''), num(p.ts), (p.ops || []).map(packOp)];
      })
    };
  }

  // 解出来的是 v2 形状，交给 applyArchive 走它已经测过的校验路径
  function unpackConfig(o) {
    if (!o || o.v !== PACK_VERSION || !Array.isArray(o.s)) return null;
    var relics = {};
    (o.r || []).forEach(function (row) {
      if (Array.isArray(row) && row[0]) {
        relics[row[0]] = { stage: num(row[1]), stack: num(row[2]) };
      }
    });
    return {
      schemaVersion: 2,
      relics: relics,
      squad: o.s.map(unpackOp).filter(Boolean),
      ctx: o.c || {},
      presets: (o.p || []).map(function (row) {
        return {
          name: String(row[0] || '编队'),
          ts: num(row[1]),
          ops: (row[2] || []).map(unpackOp).filter(Boolean)
        };
      })
    };
  }

  function b64urlEncode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function shareUrl() {
    var payload;
    try {
      payload = b64urlEncode(JSON.stringify(packConfig()));
    } catch (e) {
      return { ok: false, reason: '配置序列化失败：' + (e && e.message) };
    }
    if (payload.length > SHARE_MAX) {
      return { ok: false, reason: '配置太大（' + payload.length + ' 字符），聊天软件可能会截断，请改用「导出」' };
    }
    var base = location.href.split('#')[0];
    return { ok: true, url: base + '#cfg=' + payload };
  }

  function showShare() {
    var r = shareUrl();
    if (!r.ok) { toast(r.reason); return; }

    var copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(r.url);
        copied = true;
      }
    } catch (e) { copied = false; }

    openModal(function (b) {
      b.appendChild(el('h2', null, '分享链接'));
      b.appendChild(el('p', null, copied
        ? '链接已复制到剪贴板，发给别人打开就是当前这套配置。'
        : '复制下面的链接发给别人，打开就是当前这套配置。'));
      var ta = document.createElement('textarea');
      ta.value = r.url;
      ta.setAttribute('readonly', 'readonly');
      ta.setAttribute('aria-label', '分享链接');
      b.appendChild(ta);
      ta.select();
    });
  }

  // 打开带 #cfg= 的链接：先还原配置，再把 hash 清掉，
  // 免得用户接着改动之后一刷新又被链接里的旧配置覆盖。
  function applyHashConfig() {
    var h = (typeof location !== 'undefined' && location.hash) || '';
    if (h.indexOf('#cfg=') !== 0) return false;

    var json = null, raw = null;
    try { json = b64urlDecode(h.slice(5)); } catch (e) { json = null; }
    if (json) { try { raw = JSON.parse(json); } catch (e) { raw = null; } }

    var d = raw ? unpackConfig(raw) : null;
    if (!d) { toast('分享链接已损坏或版本不兼容，未载入'); return false; }

    var r = applyArchive(d);
    if (!r.ok) { toast('分享链接里的配置无法识别：' + (r.reason || '格式不符')); return false; }

    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* 老浏览器忽略 */ }
    saveNow();
    toast('已载入分享的配置' + (r.dropped ? '（忽略 ' + r.dropped + ' 条损坏数据）' : ''));
    return true;
  }

  // ---------- 战斗状态 ----------
  function renderCtxInputs() {
    var c = state.ctx;
    document.getElementById('ctxTime').value = c.time;
    document.getElementById('ctxHp').value = c.hpPct;
    document.getElementById('ctxIngot').value = c.ingots;
    document.getElementById('ctxParts').value = c.parts;
    if (document.getElementById('ctxValue')) document.getElementById('ctxValue').value = c.value || 0;
    document.getElementById('ctxAlly').value = c.allyCount;
    document.getElementById('ctxSkill').checked = !!c.skillOn;
    document.getElementById('ctxShield').checked = !!c.hasShield;
    document.getElementById('ctxFirst').checked = c.firstDeploy !== false;
    document.getElementById('ctxProc').checked = !!c.proc;

    var box = document.getElementById('profCounts');
    box.innerHTML = '';
    PROFESSIONS.forEach(function (p) {
      var cur = num((c.profCounts && c.profCounts[p]) || 0);
      var chip = el('div', 'prof-count' + (cur ? ' on' : ''));
      chip.title = p + '：场上人数（按职业缩放的藏品读这个值）';
      chip.appendChild(el('span', 'pc-name', p));

      var minus = el('button', 'pc-btn', '−');
      minus.onclick = function () { stepProf(p, -1); };
      chip.appendChild(minus);
      chip.appendChild(el('span', 'pc-val', String(cur)));
      var plus = el('button', 'pc-btn', '+');
      plus.onclick = function () { stepProf(p, 1); };
      chip.appendChild(plus);
      box.appendChild(chip);
    });
  }

  // 职业人数只可能在 0 ~ 编队上限之间：越界钳住，省得手滑输成 99
  function stepProf(p, d) {
    var cur = num((state.ctx.profCounts || {})[p]);
    var v = Math.max(0, Math.min(MAX_SQUAD, cur + d));
    if (v === cur) return;
    if (!state.ctx.profCounts) state.ctx.profCounts = {};
    state.ctx.profCounts[p] = v;
    save();
    renderCtxInputs();
    renderSquad();
    renderSummary();
  }

  function bindCtx() {
    var map = [
      ['ctxTime', 'time'], ['ctxHp', 'hpPct'], ['ctxIngot', 'ingots'],
      ['ctxParts', 'parts'], ['ctxValue', 'value'], ['ctxAlly', 'allyCount']
    ];
    map.forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener('input', function () {
        state.ctx[pair[1]] = num(this.value);
        save(); renderSquad(); renderSummary();
      });
    });
    [['ctxSkill', 'skillOn'], ['ctxShield', 'hasShield'], ['ctxFirst', 'firstDeploy'],
     ['ctxProc', 'proc']].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener('change', function () {
        state.ctx[pair[1]] = this.checked;
        save(); renderSquad(); renderSummary();
      });
    });
    document.getElementById('btnProfAuto').onclick = function () {
      var counts = {};
      state.squad.forEach(function (o) {
        if (o.profession) counts[o.profession] = (counts[o.profession] || 0) + 1;
      });
      state.ctx.profCounts = counts;
      save(); renderCtxInputs(); renderSquad(); renderSummary();
    };
  }

  function renderAll() {
    renderCats();
    renderCtxInputs();
    renderRelicList();
    renderSquad();
    renderSummary();
    syncDmgInputs();
    renderPresets();
    renderPickerFilters();
    renderPicker();
  }

  // ---------- 常用编队 ----------
  function cloneSquad() {
    return JSON.parse(JSON.stringify(state.squad));
  }

  function renderPresets() {
    var cntEl = document.getElementById('presetCount');
    if (cntEl) cntEl.textContent = state.presets.length;
    var box = document.getElementById('presetList');
    if (!box) return;
    box.innerHTML = '';
    if (!state.presets.length) {
      box.appendChild(el('span', 'preset-empty', '还没有保存的编队：调好队伍后点「保存当前编队」。'));
      return;
    }
    state.presets.forEach(function (p, i) {
      var chip = el('div', 'preset');
      chip.appendChild(el('span', 'nm', p.name));
      chip.appendChild(el('span', 'cnt', (p.ops || []).length + ' 人'));
      var load = el('button', 'tiny', '载入');
      load.onclick = function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); loadPreset(i); };
      var over = el('button', 'tiny', '覆盖');
      over.onclick = function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); overwritePreset(i); };
      var del = el('button', 'tiny', '删');
      del.onclick = function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); deletePreset(i); };
      chip.appendChild(load); chip.appendChild(over); chip.appendChild(del);
      box.appendChild(chip);
    });
  }

  function loadPreset(i) {
    var p = state.presets[i];
    if (!p) return;
    state.squad = (p.ops || []).map(function (o) {
      var c = JSON.parse(JSON.stringify(o));
      c.id = 'op_' + Math.random().toString(36).slice(2, 8);
      return c;
    });
    afterSquadChange();
  }

  function overwritePreset(i) {
    var p = state.presets[i];
    if (!p) return;
    p.ops = cloneSquad();
    p.ts = Date.now();
    save(); renderPresets();
  }

  function deletePreset(i) {
    state.presets.splice(i, 1);
    save(); renderPresets();
  }

  function saveCurrentSquad() {
    if (!state.squad.length) { toast('编队还是空的，先加几个干员。'); return; }
    var nameIn = document.getElementById('presetName');
    var name = ((nameIn && nameIn.value) || '').trim();
    if (!name) name = '编队 ' + (state.presets.length + 1);
    var idx = -1;
    for (var i = 0; i < state.presets.length; i++) {
      if (state.presets[i].name === name) { idx = i; break; }
    }
    var payload = { name: name, ops: cloneSquad(), ts: Date.now() };
    if (idx >= 0) state.presets[idx] = payload;
    else state.presets.push(payload);
    if (nameIn) nameIn.value = '';
    save(); renderPresets();
    toast('已保存编队「' + name + '」');
  }

  // ---------- 初始化 ----------
  // 启动失败时的兜底页：白屏是最糟的失败形态，至少要让用户知道该刷新还是该反馈。
  function renderFatal(e) {
    var msg = (e && e.message) || String(e);
    if (window.console && console.error) console.error('[启动失败]', e);
    if (!document.body) return;

    var box = document.createElement('div');
    box.className = 'fatal';
    var h = document.createElement('h2');
    h.textContent = '数据没能载入';
    var p1 = document.createElement('p');
    p1.className = 'fatal-msg';
    p1.textContent = msg;
    var p2 = document.createElement('p');
    p2.textContent = '常见原因：data/is6db.js 没跟着一起上传、浏览器缓存了旧版本、或者站点部署在子目录下而路径对不上。先按 Ctrl+F5（Mac 是 Cmd+Shift+R）强制刷新一次；仍然不行，请把上面这行文字反馈给作者。';
    box.appendChild(h);
    box.appendChild(p1);
    box.appendChild(p2);

    document.body.innerHTML = '';
    document.body.appendChild(box);
  }

  // 版本串从 script 标签自身读，不在 JS 里再写一份，避免两处漂移
  function assetVersion() {
    try {
      var tags = document.getElementsByTagName('script');
      for (var i = 0; i < tags.length; i++) {
        var m = /[?&]v=([^&]+)/.exec(tags[i].src || '');
        if (m) return m[1];
      }
    } catch (e) { /* 无 DOM 环境（测试桩）直接跳过 */ }
    return '未知';
  }

  function init() {
    if (bootError) { renderFatal(bootError); return; }

    var info = load();
    bindCtx();
    renderAll();

    // 分页：恢复上次停留的页，默认落在「编队」
    TABS.forEach(function (t) {
      var b = document.getElementById(t.btn);
      if (b) b.onclick = function () { setTab(t.key); };
    });
    var savedTab = null;
    try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { savedTab = null; }
    setTab(savedTab || 'squad');

    // 左栏折叠：收起后右侧能全宽排干员卡
    var layout = document.getElementById('layout');
    function foldRelics(on) {
      if (!layout) return;
      if (on) layout.classList.add('folded'); else layout.classList.remove('folded');
      try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    document.getElementById('btnFoldRelics').onclick = function () { foldRelics(true); };
    document.getElementById('btnUnfoldRelics').onclick = function () { foldRelics(false); };
    var wasFolded = false;
    try { wasFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch (e) { wasFolded = false; }
    foldRelics(wasFolded);

    // 批量展开 / 收起所有干员的面板编辑区
    var btnEdit = document.getElementById('btnToggleEdit');
    btnEdit.onclick = function () {
      state.ui.editAll = !state.ui.editAll;
      // 清掉逐卡记忆，让全局开关说了算（空白干员仍会因缺面板而展开）
      state.squad.forEach(function (o) { o.__open = state.ui.editAll; });
      btnEdit.textContent = state.ui.editAll ? '收起面板' : '展开面板';
      renderSquad();
    };

    document.getElementById('btnTogglePicker').onclick = function () { togglePicker(); };
    document.getElementById('btnAddBlank').onclick = addBlank;

    // 网格搜索走防抖：452 张卡片全量重建比藏品列表更贵
    var opSearch = document.getElementById('opSearch');
    var onOpSearch = debounce(function () {
      state.ui.pickerSearch = opSearch.value;
      renderPicker();
    }, SEARCH_DELAY);
    opSearch.addEventListener('input', onOpSearch);

    var si = document.getElementById('search');
    var onRelicSearch = debounce(function () {
      state.ui.search = si.value;
      renderRelicList();
    }, SEARCH_DELAY);
    si.addEventListener('input', onRelicSearch);

    document.getElementById('onlySelected').addEventListener('change', function () {
      state.ui.onlySelected = this.checked; renderRelicList();
    });
    document.getElementById('onlyChanged').addEventListener('change', function () {
      state.ui.onlyChanged = this.checked;
      renderSquad();
    });
    document.getElementById('onlyMatched').addEventListener('change', function () {
      state.ui.onlyMatched = this.checked; renderRelicList();
    });
    document.getElementById('rarityFilter').addEventListener('change', function () {
      state.ui.rarity = this.value; renderRelicList();
    });

    document.getElementById('btnSaveSquad').onclick = saveCurrentSquad;

    // 伤害估算输入
    DMG_FIELDS.forEach(function (pair) {
      var elx = document.getElementById(pair[0]);
      if (!elx) return;
      elx.addEventListener('input', function () {
        state.ctx[pair[0]] = num(elx.value);
        save();
        renderDmg();
      });
    });
    // 「用编队干员的面板」：把某人的最终攻击力填进攻击力输入框
    var dmgSel = document.getElementById('dmgFromOp');
    if (dmgSel) {
      dmgSel.addEventListener('change', function () {
        if (dmgSel.value === '') return;
        var i = +dmgSel.value;
        var results = getResults();
        var atk = results[i] && results[i].final ? results[i].final.atk : 0;
        if (!atk) { toast('这名干员还没有攻击力数据，先填一下面板'); return; }
        state.ctx.dmgAtk = Math.round(num(atk));
        save();
        syncDmgInputs();
        renderDmg();
      });
    }

    document.getElementById('btnHelp').onclick = showHelp;
    document.getElementById('btnShare').onclick = showShare;
    document.getElementById('btnImport').onclick = showImport;
    document.getElementById('btnExport').onclick = showExport;

    // 「清空」= 清空全部（藏品 + 编队 + 预设 + 战斗状态），二次确认
    document.getElementById('btnReset').onclick = function () {
      if (!confirm('清空全部内容？藏品选择、编队、常用编队和战斗状态都会被删除，且无法撤销。')) return;
      state.relics = {};
      state.squad = [];
      state.presets = [];
      state.ctx = defaultCtx();
      cache.modsKey = null; cache.resKey = null; cache.sumKey = null;
      var saved = saveNow();
      renderAll();
      // 写失败时 warnWrite 已经说明原因（存储满 / 无痕模式），这里不要再盖掉它 ——
      // 否则用户看到「已清空」却不知道刷新后数据会回来
      if (saved) toast('已清空');
    };

    document.getElementById('modalClose').onclick = closeModal;
    document.getElementById('modal').onclick = function (e) {
      if (e.target.id === 'modal') closeModal();
    };

    // 关页面前把防抖中的存档落盘
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', function () { save.flush(); });
    }

    // Esc 关弹窗：只能点 × 或点背景的话，键盘用户就被关在弹窗里了
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', function (e) {
        if (!e) return;
        var m = document.getElementById('modal');
        var open = m && !m.classList.contains('hidden');
        if (!open) return;

        if (e.key === 'Escape' || e.keyCode === 27) {
          closeModal();
          if (e.preventDefault) e.preventDefault();
          return;
        }

        // 焦点陷阱：没有它，Tab 会在第 4 下就跑到弹窗背后的 700 多个元素里，
        // 用户既不知道自己出了弹窗，也回不来。
        if (e.key !== 'Tab' && e.keyCode !== 9) return;
        var box = document.querySelector ? document.querySelector('.modal-box') : null;
        var f = focusablesIn(box);
        if (f.length < 2) return;
        var first = f[0], last = f[f.length - 1];
        var active = document.activeElement;
        var inside = box.contains && box.contains(active);
        if (e.shiftKey) {
          if (active === first || !inside) { e.preventDefault(); last.focus(); }
        } else if (active === last || !inside) {
          e.preventDefault(); first.focus();
        }
      });
    }

    // 另一个标签页写了同一个 key：本页不知道，下一次保存会把它盖掉。
    // 不做自动合并（两个标签页的改动没有共同祖先，合并只会更乱），
    // 但要明确告诉用户「谁赢了」，并保证被盖掉的那版还在备份键里。
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (e) {
        if (e.key !== LS_KEY || !e.newValue) return;
        if (e.newValue === lastWritten) return;   // 就是本页写的，回声忽略
        toast('另一个标签页保存了新存档。本页再改动会覆盖它（旧版本已留在备份里）。');
      });
    }

    // 产物自检：行数与 meta 声明对不上时，界面照常打开，但要在控制台留痕，
    // 并在界面上提一次 —— 用户看到的数字可能不准，这件事不能只写在控制台里。
    var dbCheck = DB.check();
    if (!dbCheck.ok) {
      if (window.console && console.warn) console.warn('[DB] 数据产物校验未通过：', dbCheck.issues);
      toast('数据产物自检未通过（' + dbCheck.issues.length + ' 项），计算结果可能不准，详见控制台');
      return;
    }

    // 四条提示可能同时成立（恢复/升级/丢弃/读不到），拼成一句，别让后一条盖掉前一条
    var dropMsg = info.dropped ? '已忽略 ' + info.dropped + ' 条损坏的编队数据' : '';
    if (info.unavailable) {
      toast('浏览器禁止读取本地存储（可能是无痕模式），本次改动不会保存');
    } else if (info.corrupted) {
      toast('本地存档已损坏，已重置为空状态' + (dropMsg ? '；' + dropMsg : ''));
    } else if (info.recovered) {
      toast('主存档读不出来，已从上一版备份恢复' + (dropMsg ? '；' + dropMsg : ''));
    } else if (info.upgraded) {
      toast('已把旧存档升级为表结构 v' + Migrate.VERSION + '，数据未丢失' +
        (dropMsg ? '；' + dropMsg : ''));
    } else if (info.fromBackup) {
      toast('主存档不存在，已载入上一版备份');
    } else if (dropMsg) {
      toast(dropMsg);
    }

    // 分享链接优先级最高：链接里的配置就是要看的那一份，放在最后覆盖前面的提示
    if (applyHashConfig()) renderAll();

    // 离线缓存：只在 http(s) 下注册（file:// 不支持 Service Worker）
    if ('serviceWorker' in navigator &&
        (location.protocol === 'http:' || location.protocol === 'https:')) {
      try {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 注册失败不影响使用 */ });
      } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
