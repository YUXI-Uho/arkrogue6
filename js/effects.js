/* 藏品效果文本 → 结构化修正项
 * 这套解析器不追求「理解」中文，而是用一组够密的词表 + 规则把藏品里
 * 绝大多数「属性+数值」类效果翻译成可计算的数据；识别不了的部分会进入
 * 「特殊效果」列表，界面上始终可见，不会被静默丢掉。
 *
 * 属性词表与职业枚举全部来自 core/schema.js、core/enums.js，本文件不再自带平行表：
 * 加一个属性只需要改 schema，别名、label、bucket 会自动跟上。
 */
(function (global) {
  'use strict';

  // 注册表是硬依赖：缺了就没法解析，宁可启动即报错也不要静默退化成空词表。
  if (!global.ArkSchema || !global.ArkEnums) {
    throw new Error('js/effects.js 依赖 core/schema.js 与 core/enums.js，请确认 index.html 里这两个 <script> 排在 js/effects.js 之前');
  }

  var S = global.ArkSchema;
  var ENUMS = global.ArkEnums;

  var PROFESSIONS = ENUMS.PROFESSIONS;
  var SUBPROFESSIONS = ENUMS.SUBPROFESSIONS;

  // 分支名按长度降序另存一份，供 detectScope 扫描。
  // 「裂空炮手」包含「炮手」、「本源铁卫」包含「铁卫」，按注册顺序扫会命中短名，
  // 于是「裂空炮手的攻击力+30%」会被记成「炮手」—— 作用域是对的邻居，但不是本人。
  var SUBPROF_BY_LEN = SUBPROFESSIONS.slice().sort(function (a, b) { return b.length - a.length; });

  // 兼容旧接口：app.js 仍在用 R.PROFESSIONS，历史调用方也可能读三张 stats 表。
  // 这里由注册表派生，形状保持 {key, names, label}，避免外部代码改动。
  function statsOfBucket(bucket) {
    return S.STATS.filter(function (s) { return s.bucket === bucket; })
      .map(function (s) { return { key: s.key, names: s.alias.slice(), label: s.label }; });
  }
  var PANEL_STATS = statsOfBucket('panel');
  var COMBAT_STATS = statsOfBucket('combat');
  var RUN_STATS = statsOfBucket('run');

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // 别名表已按长度降序（长名优先：「最大生命值」先于「生命」）
  var NAME_ALT = S.ALIAS_NAMES.map(escapeRe).join('|');
  var GROUP_RE = new RegExp('((?:' + NAME_ALT + ')(?:\\s*[、和及与]\\s*(?:' + NAME_ALT + '))*)', 'g');

  // ---------- 文本预处理 ----------
  function normalize(text) {
    return String(text || '')
      .replace(/<br\s*\/?>/g, '；')
      .replace(/[【】]/g, function (m) { return m === '【' ? '[' : ']'; })
      .replace(/\s+/g, '')
      .replace(/^；+|；+$/g, '');
  }

  // 按 ，；。 切分，但括号内的不切。
  // 返回 { text, sentenceStart }：sentenceStart 表示这是「。」之后的第一段，
  // 供 pendingCond 判断「同句继承」还是「跨句作废」。
  function splitClauses(text) {
    var out = [], buf = '', depth = 0, sentenceStart = true;
    function flush(brk) {
      if (buf.trim()) out.push({ text: buf.trim(), sentenceStart: sentenceStart });
      buf = '';
      sentenceStart = brk === '。';
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '(' || ch === '（') depth++;
      else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
      if (depth === 0 && (ch === '，' || ch === ',' || ch === '；' || ch === ';' || ch === '。')) {
        flush(ch);
        continue;
      }
      buf += ch;
    }
    flush('');
    return out;
  }

  // ---------- 作用域 ----------
  // 判定顺序按「谁受益」而不是「出现了哪个词」。
  // 旧实现只要分句里出现「敌人」就整条判敌方，而 engine.scopeCovers 对 enemy 直接
  // 返回 false，于是「所有我方单位仅阻挡1名敌人时，攻击力+100%」这类
  // 「我方受益、敌人只是条件」的分句被整条静默丢弃。
  var ENEMY_HEAD_RE = /^(?:所有)?(?:敌方单位|敌人|所有敌人)/;

  function detectScope(clause) {
    var m;

    // 1. 以敌方词开头：敌人是主语，也是受益方
    if (ENEMY_HEAD_RE.test(clause)) return { base: 'enemy' };

    // 2. 方括号限定：【先锋】干员 / 【尖兵】
    m = clause.match(/\[([^\[\]]{1,8})\]/);
    if (m) {
      var name = m[1];
      if (ENUMS.isProfession(name)) return { base: 'friendly', professions: [name] };
      if (ENUMS.isSubProfession(name)) return { base: 'friendly', subProfs: [name] };
      return { base: 'friendly', professions: [name] };
    }

    if (/下一个招募或进阶的干员/.test(clause)) return { base: 'friendly', assign: true };
    // 站位必须排在职业之前：「医疗干员攻击范围内的地面干员阻挡数+1」的受益者是地面干员，
    // 先按职业抓「医疗」会把加成挂到医疗身上。
    if (/所有我方近战单位|我方近战单位|近战单位|近战干员|地面干员/.test(clause)) {
      return { base: 'friendly', positions: ['MELEE'] };
    }
    if (/所有我方远程单位|我方远程单位|远程单位|远程干员|高台干员/.test(clause)) {
      return { base: 'friendly', positions: ['RANGED'] };
    }
    if (/召唤物/.test(clause)) return { base: 'friendly', summon: true };

    // 3. 无方括号：「狙击干员」「处决者干员」—— 职业/分支直接写在「干员」前面。
    // 旧代码算出了这个捕获却立刻被方括号分支覆盖，等于白算；这里把它复活。
    m = clause.match(/([^\[\]，、的地]{1,6})干员/);
    if (m) {
      var who = m[1];
      if (ENUMS.isProfession(who)) return { base: 'friendly', professions: [who] };
      if (ENUMS.isSubProfession(who)) return { base: 'friendly', subProfs: [who] };
    }
    // 分支名（尖兵、冲锋手、策士……），长名优先
    for (var i = 0; i < SUBPROF_BY_LEN.length; i++) {
      if (clause.indexOf(SUBPROF_BY_LEN[i]) >= 0) {
        return { base: 'friendly', subProfs: [SUBPROF_BY_LEN[i]] };
      }
    }

    // 4. 「降低目标 X 点法抗」「削弱敌人的防御」：受益方是被削的那个单位，不是我方。
    //    这条必须排在「我方受益证据」之前 —— 否则「攻击时降低目标5点法抗」会因为
    //    继承了上一句的职业作用域而被记成「术师 法术抗性 +5」（175 断杖-新典训）。
    if (/(?:降低|减少|削弱)(?:目标|敌人|敌方|其)/.test(clause)) return { base: 'enemy' };

    // 5. 我方受益证据。注意：这里不再因为同时出现「敌人」就翻转成敌方 ——
    //    「我方干员击倒敌人时」「所有我方单位仅阻挡1名敌人时」都是我方的加成。
    if (/所有我方单位|所有我方干员|所有干员|我方单位|我方干员|我方|全体干员|干员|单位/.test(clause)) {
      return { base: 'friendly', all: true };
    }

    // 6. 敌人是承受者或动作发出者：「敌人受到…」「被阻挡的敌人造成的伤害」
    if (/敌人|敌方/.test(clause) && /受到|造成|发动/.test(clause)) return { base: 'enemy' };

    // 7. 敌人是属性主体（「敌人防御力和法术抗性-40%」「精英敌人的生命+10%」）：
    //    走到这里说明分句里没有任何我方受益证据，按敌方处理。
    if (/敌人|敌方/.test(clause)
      && /(?:防御力|法术抗性|攻击力|生命|重量|移动速度|移速|阻挡)/.test(clause)) {
      return { base: 'enemy' };
    }

    // 7. 只提到敌人、看不出受益方（多为「击倒敌人后」这类条件）：返回 null 让上层
    //    继承 lastScope，不要凭空新建 enemy（那会让后续我方分句全部失配）。
    return null;
  }

  // ---------- 具名主语 ----------
  // 「XX的+属性名」里的 XX 如果是个专名（带引号的单位名、召唤物名、道具名），
  // 那这条修正的受益方是那个单位本身，不是全体干员。旧实现在 detectScope 返回 null 时
  // 兜底成 {base:'friendly', all:true}，于是「猎犬proto的攻击力-50%」被当成我方全体
  // 攻击力腰斩（209）、「猎犬proto的生命和攻击力+20%」被当成全体干员加血加攻（142）。
  // 这里只负责「识别不出受益方时不要把加成送出去」，不负责猜它到底加给谁：
  // 分句原样进 unmatched，界面上仍然看得见，只是不参与计算。
  var NAMED_SUBJECT_RE = /["“「]?([A-Za-z\u4e00-\u9fa5]{1,10})["”」]?的(?:攻击力|生命|防御力|法术抗性|攻击速度|技力)/;
  // 通用受益方（干员/我方/敌人/召唤物…）不是专名，这些照旧走原来的作用域逻辑
  var GENERIC_SUBJECT_RE = /干员|我方|敌人|敌方|单位|全体|所有|每名|自身|召唤物/;

  function isNamedSubjectStat(clause) {
    var m = clause.match(NAMED_SUBJECT_RE);
    if (!m) return false;
    return !GENERIC_SUBJECT_RE.test(m[1]);
  }

  // ---------- 条件 ----------
  function detectCond(clause) {
    var m;
    // 触发类条件：效果只在「击倒/击杀」那一刻生效，不是常驻加成。
    // 由 ctx.proc（界面上的「触发类效果生效」开关）决定，默认不生效。
    if (/击倒(?:一名)?敌人时|击杀敌人时/.test(clause)) return { type: 'proc', label: '击倒敌人时' };
    if ((m = clause.match(/战斗开始(\d+(?:\.\d+)?)秒内/))) return { type: 'early', sec: +m[1], label: '战斗开始' + m[1] + '秒内' };
    if ((m = clause.match(/部署后(\d+(?:\.\d+)?)秒内/))) return { type: 'early', sec: +m[1], label: '部署后' + m[1] + '秒内' };
    if (clause.indexOf('首次部署') >= 0) return { type: 'firstDeploy', label: '首次部署时' };
    if ((m = clause.match(/在场上停留(\d+(?:\.\d+)?)秒后/))) return { type: 'after', sec: +m[1], label: '在场' + m[1] + '秒后' };
    if ((m = clause.match(/技能(?:触发|开启|结束时|结束后)(\d+(?:\.\d+)?)?秒?内?/))) {
      return { type: 'skillWindow', sec: m[1] ? +m[1] : 0, label: '技能触发后' + (m[1] ? m[1] + '秒内' : '') };
    }
    if (/技能未开启时/.test(clause)) return { type: 'skillOff', label: '技能未开启' };
    if ((m = clause.match(/生命值?(?:低于|小于|不高于)(\d+(?:\.\d+)?)%/))) return { type: 'hpBelow', pct: +m[1], label: '生命≤' + m[1] + '%' };
    if ((m = clause.match(/生命值?(?:高于|大于|不低于)(\d+(?:\.\d+)?)%/))) return { type: 'hpAbove', pct: +m[1], label: '生命≥' + m[1] + '%' };
    if ((m = clause.match(/仅阻挡(\d+)名?敌人/))) return { type: 'blockOnly', n: +m[1], label: '仅阻挡' + m[1] + '名敌人' };
    if ((m = clause.match(/拥有屏障时/))) return { type: 'hasShield', label: '拥有屏障时' };
    if ((m = clause.match(/每有(\d+(?:\.\d+)?)点?源石锭/))) return { type: 'perResource', res: 'ingots', per: +m[1], label: '每' + m[1] + '源石锭' };
    if ((m = clause.match(/每有(\d+(?:\.\d+)?)(?:个|点)?零件/))) return { type: 'perResource', res: 'parts', per: +m[1], label: '每' + m[1] + '零件' };
    if ((m = clause.match(/每有(\d+(?:\.\d+)?)点估值/))) return { type: 'perResource', res: 'value', per: +m[1], label: '每' + m[1] + '估值' };
    if ((m = clause.match(/场上每有(?:一|1)?名?\s*\[?([^\[\]、，]{1,4})\]?干员/))) {
      var who = m[1];
      return { type: 'perProfession', who: who, label: '场上每有1名' + who + '干员' };
    }
    if ((m = clause.match(/周围(\d+)格每有一名干员/))) return { type: 'perAlly', label: '周围' + m[1] + '格每名干员' };
    // 「每进入新区域」「每次进入新区域」两种写法都要认：前者是触发短语独立成句，
    // 后者带一个「次」字，旧正则要求「每」紧跟触发词，于是 032 的
    // 「每次进入新区域时，初始行动力+1」既没拿到条件、也没被归一成每区域产出。
    if ((m = clause.match(/每(?:次)?(进入新区域|使用过一次技能|击倒一名敌人|触发一次追猎|完美作战结束后|触发一次)/))) {
      return { type: 'perStack', label: '每' + m[1] };
    }
    // cap 是官方数据的字段名（mods[].cond.cap），engine 只读 cap；
    // n 保留给旧调用方，两个字段写同一个值。
    if ((m = clause.match(/最多(?:叠加)?(\d+)层/))) return { type: 'capLayer', n: +m[1], cap: +m[1], label: '最多' + m[1] + '层' };
    return null;
  }

  // ---------- 条件阈值 ≠ 加成 ----------
  // 条件句里也会出现「属性名 + 数字」，但那串数字是条件阈值而不是加成：
  // 086「所有我方单位仅阻挡1名敌人时」同时命中 blockOnly(1) 与 block +1，
  // 不拦截就会给每名干员白送 1 阻挡。
  // 判定范围是「同一句（。」之内）：条件写在前面的分句（「生命值低于50%时，攻击力+50%」）
  // 和写在后面的分句（「阻挡数+1，仅阻挡1名敌人时」）都要看得见，
  // 但跨句不继承 —— 192 的「每 5 源石锭」不能去守下一句的攻速 +7。
  var COND_STAT_OF = { blockOnly: 'block', hpBelow: 'hp', hpAbove: 'hp', perResource: 'ingot' };
  var COND_NUM_FIELDS = ['n', 'pct', 'sec', 'cap', 'per'];

  // 按「人数 / 资源」缩放的驱动条件：这类条件自带倍数，层数上限只能夹住倍数
  var SCALE_COND_TYPES = { perProfession: 1, perAlly: 1, perResource: 1 };

  // 明确的增减动词：出现即说明这串数字是加成，不是条件阈值的复述。
  // 只认汉字动词、不认「+/-」符号：086 与「阻挡数+1」都带符号，
  // 把符号也算进来的话条件守卫会整条失效，086 的 P0 会复发。
  var ADD_VERB_RE = /提升|增加|减少|降低|提高|回复|恢复|额外/;

  function condThresholdOf(cond) {
    for (var i = 0; i < COND_NUM_FIELDS.length; i++) {
      var v = cond[COND_NUM_FIELDS[i]];
      if (typeof v === 'number') return v;
    }
    return null;
  }

  // 逐句预扫条件：「。」之内所有分句的条件都参与守卫判定，
  // 这样后置条件（「阻挡数+1，仅阻挡1名敌人时」）也能守住前一分句。
  // 返回与 clauses 等长的数组，每项是该分句所在句子里出现的条件 [{cond, text}]。
  function collectSentenceConds(clauses) {
    var out = [], cur = [];
    function flush() {
      var found = cur.filter(function (x) { return !!x; });
      for (var k = 0; k < cur.length; k++) out.push(found);
      cur = [];
    }
    for (var i = 0; i < clauses.length; i++) {
      if (i > 0 && clauses[i].sentenceStart) flush();
      var c = detectCond(clauses[i].text);
      cur.push(c ? { cond: c, text: clauses[i].text } : null);
    }
    flush();
    return out;
  }

  // 单条修正项是否是「条件阈值的复述」
  function isEchoOfCond(item, guard) {
    if (item.grp.before) return false;
    for (var i = 0; i < guard.length; i++) {
      var cond = guard[i].cond;
      var th = condThresholdOf(cond);
      if (th == null) continue;
      if (Math.abs(item.grp.value) !== th) continue;
      if (COND_STAT_OF[cond.type] === item.stat.key) return true;
      // 条件句里点名了该属性（任一别名出现）也算阈值复述
      for (var n = 0; n < item.stat.alias.length; n++) {
        if (guard[i].text.indexOf(item.stat.alias[n]) >= 0) return true;
      }
    }
    return false;
  }

  // 整组一起丢 / 一起留：同分句里只要有一条不是阈值复述（数值不等、属性没在条件里
  // 出现过、带明确增减动词），整组都按加成保留。
  // 只按「数值相等」逐条丢会把「生命值低于50%时，攻击力和生命+50%」吃掉一半。
  function isThresholdEcho(items, guard) {
    if (!guard.length) return false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.grp.mult) return false;
      if (it.grp.verb && ADD_VERB_RE.test(it.grp.verb)) return false;
      if (!isEchoOfCond(it, guard)) return false;
    }
    return true;
  }

  // 纯条件/噪声片段，不需要单独报告为「未识别」
  var NOISE_RE = /^(最多叠加\d+层|可叠加|持续\d+秒|持续\d+秒|仅一次|每层.*|且.*|并在.*|使.*|同时.*|若.*|如果.*|拥有.*时.*)$/;

  function isNoise(clause) {
    var c = clause.replace(/^[，、；。]|（[^）]*）|\([^)]*\)$/g, '');
    if (NOISE_RE.test(c)) return true;
    // 只由条件构成、没有数值的片段
    if (!/\d/.test(c)) return true;
    if (/最多叠加\d+层|可叠加|仅一次/.test(c) && c.length <= 12) return true;
    return false;
  }

  // ---------- 数值抽取 ----------
  function matchStatGroup(clause) {
    var results = [];
    GROUP_RE.lastIndex = 0;
    var m;
    while ((m = GROUP_RE.exec(clause))) {
      var group = m[1];
      // 「物理与法术闪避」本身就是一条别名，先整体匹配再拆。
      // 直接按「与/和/及」拆会把整名拆成「物理」+「法术闪避」，
      // 于是 105 舞者手链的「10%物理与法术闪避」被记成只有法术闪避。
      var parts = S.ALIAS_TO_STAT[group] ? [group] : group.split(/[、和及与]/).filter(Boolean);
      var after = clause.slice(m.index + group.length);
      // 允许「+」「-」「提升至」「降低」等前缀；前缀单独捕获，供条件守卫判断
      // 「这是加成」还是「这是条件阈值的复述」
      // 第二组允许「降低目标5点法抗」这种动词与数字之间插了宾语的写法。
      var vm = after.match(/^((?:提升至|降低至|提升|增加|减少|降低|回复|永久|额外|再|各|均)?)\s*([+\-−]?\s*\d+(?:\.\d+)?)\s*(%|％)?/)
        || after.match(/^(提升至|降低至|提升|增加|减少|降低|回复|永久|额外|再|各|均)\s*(?:目标|敌人|敌方|该单位|其)\s*([+\-−]?\s*\d+(?:\.\d+)?)\s*(%|％)?/);
      var mult = false;
      if (!vm) {
        // 数字在名字前面：「每秒回复3点生命」「降低目标5点法抗」这类
        var before = clause.slice(0, m.index);
        var pm = before.match(/([+\-−]?\d+(?:\.\d+)?)\s*(%|％|点|层|个|名)?$/);
        if (pm) {
          // 数字前面紧跟着「降低 / 减少 / 削弱」时，这条是减益。
          // 不取负号的话「降低目标5点法术抗性」会变成「法术抗性 +5」（175 断杖-新典训）。
          var negBefore = /(?:降低|减少|削弱)[^，。；]{0,8}$/.test(before);
          var bv = parseFloat(pm[1]);
          if (negBefore && bv > 0) bv = -bv;
          results.push({ names: parts, value: bv, pct: pm[2] === '%', mult: false, verb: negBefore ? '降低' : '', before: true });
        }
        continue;
      }
      mult = /提升至|降低至/.test(vm[1]);
      var v = parseFloat(vm[2].replace(/[−]/g, '-').replace(/\s/g, ''));
      if (isNaN(v)) continue;
      if (/^[-−]/.test(vm[2].trim())) v = -Math.abs(v);
      // 「敌人防御力降低40%」的 40 是减益量；「降低至」由 mult 分支处理，不能在这里取负。
      else if (vm[1] === '降低' || vm[1] === '减少') v = -Math.abs(v);
      results.push({ names: parts, value: v, pct: vm[3] === '%' || vm[3] === '％', mult: mult, verb: vm[1] || '' });
    }
    return results;
  }

  // ---------- 主解析 ----------
  function parseEffect(text, opts) {
    opts = opts || {};
    var out = { mods: [], unmatched: [], guarded: [] };
    var normalized = normalize(text);
    if (!normalized) return out;
    var clauses = splitClauses(normalized);
    // 逐句预扫条件，供条件守卫使用（含后置条件）
    var sentenceConds = collectSentenceConds(clauses);
    var lastScope = null;
    var pendingCond = null;

    for (var i = 0; i < clauses.length; i++) {
      var item = clauses[i];
      var clause = item.text;
      if (!clause) continue;
      var guard = sentenceConds[i] || [];

      // 条件只在同一句内继承：「。」之后重新开始，避免前半句的时限条件污染后半句。
      if (item.sentenceStart) pendingCond = null;

      var scopeHere = detectScope(clause);
      if (scopeHere) lastScope = scopeHere;
      var scope = scopeHere || lastScope;

      var condHere = detectCond(clause);
      if (condHere) {
        if (condHere.type === 'capLayer' && pendingCond && SCALE_COND_TYPES[pendingCond.type]) {
          // 按人数/资源缩放的句式里，「最多叠加 N 层」是**上限**而不是驱动量：
          // 152「场上每有一名【术师】干员…+12%（最多叠加8层）」的驱动量是术师人数，
          // 层数上限只负责夹住倍数。这里若让 capLayer 顶掉 perProfession，
          // 驱动量就变成用户手填的层数，默认 0 层 → 效果静默消失。
          pendingCond = Object.assign({}, pendingCond, { cap: condHere.cap });
        } else {
          pendingCond = condHere;
        }
      }
      var cond = pendingCond;

      // 「每秒回复X点生命」是回复量，不是生命上限
      var regen = clause.match(/每秒(?:回复|恢复)(\d+(?:\.\d+)?)\s*(%|点)?的?(?:最大)?生命/);
      if (regen) {
        // 带 % 的是「按生命上限的比例回复」，进 hpRegenPct；
        // 不带 % 的是固定点数，进 hpRegen。混用会让「每秒回复1%最大生命」
        // 和官方的 hp_recovery_per_sec_by_max_hp_ratio 各记一条（080 演出用香水）。
        var regenKey = regen[2] === '%' ? 'hpRegenPct' : 'hpRegen';
        out.mods.push({
          stat: regenKey, label: S.labelOf(regenKey), bucket: S.bucketOf(regenKey),
          pct: regen[2] === '%', value: parseFloat(regen[1]), mult: false,
          scope: scope || { base: 'friendly', all: true }, cond: cond, text: clause
        });
        continue;
      }

      // 「获得相当于最大生命 N% 的屏障」里的「最大生命」是屏障的换算基数，
      // 不是生命上限加成 —— 不拦就会给干员白送 N% 最大生命（087/119/120/122）。
      if (/屏障/.test(clause) && /相当于|获得|得到/.test(clause)) {
        var sPct = clause.match(/(?:相当于|获得|得到)?\s*(?:最大生命|生命上限)(?:值)?\s*(\d+(?:\.\d+)?)\s*[%％]/);
        var sFlat = clause.match(/(\d+(?:\.\d+)?)\s*点?屏障/);
        var sKey = sPct ? 'shieldPct' : (sFlat ? 'shieldFlat' : null);
        if (sKey) {
          out.mods.push({
            stat: sKey, label: S.labelOf(sKey), bucket: S.bucketOf(sKey),
            pct: !!sPct, value: parseFloat(sPct ? sPct[1] : sFlat[1]), mult: false,
            scope: scope || { base: 'friendly', all: true }, cond: cond, text: clause
          });
        } else if (!isNoise(clause)) {
          out.unmatched.push(clause);
        }
        continue;
      }

      // 「回复10%最大生命」是回血量，不是生命上限加成
      if (/(?:回复|恢复)\s*\d+(?:\.\d+)?\s*(?:%|％|点)?\s*的?(?:最大)?生命/.test(clause)) {
        if (!isNoise(clause)) out.unmatched.push(clause);
        continue;
      }

      // 「造成/受到相当于攻击力300%的伤害」里的攻击力是伤害倍率，不是面板加成
      if ((/造成/.test(clause) && /攻击力/.test(clause))
        || (/攻击力\s*\d+(?:\.\d+)?\s*[%％][^，。；]{0,10}伤害/.test(clause) && /造成|受到/.test(clause))) {
        if (!isNoise(clause)) out.unmatched.push(clause);
        continue;
      }

      // 纯「每有 X 资源 / 每名 X 干员」的缩放短语：只提供条件，不产生属性
      var isScaling = /每有\d+(?:\.\d+)?(?:点|个)?(?:源石锭|零件|估值)/.test(clause)
        || /^每(?:使用|击倒|触发|进入|完美)/.test(clause)
        || /^场上每有/.test(clause);

      var groups = matchStatGroup(clause);

      if (isScaling) {
        if (!groups.length) continue;
        // 缩放短语里出现的属性名（如「源石锭」）不是加成，直接丢弃
        continue;
      }

      if (!groups.length) {
        // 纯条件句，留给后面的分句继承；但 proc（「击倒敌人时」）后面跟的
        // 「获得3秒迷彩」这类是真实效果，只是量化不了，必须进 unmatched 可见。
        if (cond && cond.type !== 'proc' && !isNoise(clause)) continue;
        if (!isNoise(clause) && clause.length >= 3) out.unmatched.push(clause);
        continue;
      }

      // 本分句自己没给出受益方、属性主语又是个专名：这条修正不属于任何干员。
      // 只要 scopeHere 为空就拦（不看 lastScope）—— 上一句的我方作用域不该把
      // 「猎犬proto」的加成认领成全体干员的。
      if (!scopeHere && isNamedSubjectStat(clause)) {
        out.unmatched.push(clause);
        out.guarded.push(clause);
        continue;
      }

      // 先把本分句的修正项摊平，再统一决定「整组丢」还是「整组留」：
      // 逐条丢会出现「攻击力留下、生命被吞」的半截结果。
      var clauseMods = [];
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var seen = {};
        for (var n = 0; n < grp.names.length; n++) {
          var nm = grp.names[n];
          var stat = S.ALIAS_TO_STAT[nm];
          if (!stat) continue;
          if (seen[stat.key]) continue;
          seen[stat.key] = 1;
          clauseMods.push({ stat: stat, grp: grp });
        }
      }

      // 整句都是条件阈值的复述（086 的「仅阻挡1名敌人」、后置条件的「阻挡数+1」）
      if (isThresholdEcho(clauseMods, guard)) continue;

      for (var q = 0; q < clauseMods.length; q++) {
        var mk = clauseMods[q].stat.key;
        var isPct = !!clauseMods[q].grp.pct;
        var sc = scope || { base: 'friendly', all: true };

        // 百分比形式的「源石锭 / 指挥经验」一定是收益率，不是直接给点数。
        // 不归一会同时冒出「指挥经验收益 +20%」和「指挥经验 +20」两条（138 / 141）。
        if (isPct && mk === 'ingot') mk = 'ingotRate';
        if (isPct && mk === 'exp') mk = 'expRate';

        // 「每次进入新区域时，初始行动力+1」给的是每个区域的产出，
        // 归到 ap 会和官方的 apPerZone 各记一条（032 襁褓天马）。
        // 触发短语被切到前一个分句里，所以既要看本分句，也要看继承下来的条件。
        var perZone = /每(?:次)?进入(?:新)?区域/.test(clause)
          || (cond && cond.type === 'perStack' && String(cond.label || '').indexOf('进入新区域') >= 0);
        if (perZone) {
          if (mk === 'ap') mk = 'apPerZone';
          else if (mk === 'ingot') mk = 'ingotPerZone';
        }

        // 固定点数的「受到 N 点物理/法术/真实伤害」是额外伤害，不是百分比减伤属性。
        // physTaken / magicTaken / trueTaken 都是百分比口径，塞固定值进去会读成「+1000%」。
        if (!isPct && (mk === 'physTaken' || mk === 'magicTaken' || mk === 'trueTaken')) mk = 'damage';

        // 敌方作用域下的「生命 / 攻击力 / 防御力 / 法术抗性」说的是敌人，不是干员。
        // 归到 enemy* 属性后，汇总里就是「敌人生命 -5%」，
        // 而不是「生命（对敌）-5%」这种属性名和作用对象各对一半的写法。
        // res 漏掉过一次：181 支柱-新典训的「敌人防御力和法术抗性-40%」因此多出
        // 一条面板口径的「法术抗性（对敌）-40%」，和官方 enemyRes 重复。
        if (sc.base === 'enemy') {
          if (mk === 'hp') mk = 'enemyHp';
          else if (mk === 'atk') mk = 'enemyAtk';
          else if (mk === 'def') mk = 'enemyDef';
          else if (mk === 'res') mk = 'enemyRes';
          // 敌方作主语时方向也要跟着翻：「敌人受到的伤害」是我方打得更痛（脆弱），
          // 「敌人造成的伤害」才是我方受到的伤害。照搬会把 097 / 136 记反。
          else if (mk === 'dmgTakenReduce') mk = 'weak';
          else if (mk === 'dmgReduce') mk = 'dmgTakenReduce';
        }

        out.mods.push({
          stat: mk,
          label: S.labelOf(mk),
          bucket: S.bucketOf(mk),
          pct: isPct,
          value: clauseMods[q].grp.value,
          mult: !!clauseMods[q].grp.mult,
          scope: sc,
          cond: cond,
          text: clause
        });
      }
    }
    return out;
  }

  // ---------- 条件求值 ----------
  // 按人数/资源缩放的条件可以带上层数上限（152 的「最多叠加8层」）：
  // 上限只夹倍数，驱动量仍然是场上人数 / 资源量。
  function capFactor(factor, cond) {
    if (cond && cond.cap) return Math.min(factor, cond.cap);
    return factor;
  }

  function evalCond(cond, ctx) {
    if (!cond) return { ok: true, factor: 1, reason: '' };
    ctx = ctx || {};
    switch (cond.type) {
      case 'early':
        return { ok: (ctx.time || 0) <= cond.sec, factor: 1, reason: cond.label };
      case 'after':
        return { ok: (ctx.time || 0) >= cond.sec, factor: 1, reason: cond.label };
      case 'skillWindow':
        return { ok: !!ctx.skillOn, factor: 1, reason: cond.label };
      case 'skillOff':
        return { ok: !ctx.skillOn, factor: 1, reason: cond.label };
      case 'hpBelow':
        return { ok: (ctx.hpPct == null ? 100 : ctx.hpPct) <= cond.pct, factor: 1, reason: cond.label };
      case 'hpAbove':
        return { ok: (ctx.hpPct == null ? 100 : ctx.hpPct) >= cond.pct, factor: 1, reason: cond.label };
      case 'blockOnly':
        return { ok: (ctx.block == null ? 1 : ctx.block) <= cond.n, factor: 1, reason: cond.label };
      case 'hasShield':
        return { ok: !!ctx.hasShield, factor: 1, reason: cond.label };
      case 'firstDeploy':
        return { ok: ctx.firstDeploy !== false, factor: 1, reason: cond.label };
      case 'perResource':
        var amount = ctx[cond.res] || 0;
        var times = capFactor(Math.floor(amount / cond.per), cond);
        return { ok: times > 0, factor: times, reason: cond.label + '（当前' + times + '层）' };
      case 'perProfession':
        var cnt = capFactor((ctx.profCounts && ctx.profCounts[cond.who]) || 0, cond);
        return { ok: cnt > 0, factor: cnt, reason: cond.label + '（当前' + cnt + '）' };
      case 'perAlly':
        var a = capFactor(ctx.allyCount || 0, cond);
        return { ok: a > 0, factor: a, reason: cond.label + '（当前' + a + '）' };
      case 'perStack':
        var st = ctx.stack || 0;
        return { ok: st > 0, factor: st, reason: cond.label + '（当前' + st + '层）' };
      case 'capLayer':
        return { ok: true, factor: 1, reason: cond.label };
      case 'proc':
        // 触发类效果：界面上的「触发类效果生效」写入 ctx.proc，默认不生效。
        return { ok: !!ctx.proc, factor: 1, reason: cond.label };
      case 'hasRelic':
        // 跨藏品前置：例如 171 波纹之手的攻击力部分要求同时持有【断杖-同调】
        var has = !!(ctx.relics && ctx.relics[cond.relicId]);
        return { ok: has, factor: 1, reason: cond.label + (has ? '' : '（未持有）') };
      case 'perRelicStack':
        // 层数来自另一件藏品的层数：209 猎印「每层探测先锋 +10 法抗」
        var rs = (ctx.relicStacks && ctx.relicStacks[cond.relicId]) || 0;
        rs = capFactor(rs, cond);
        return { ok: rs > 0, factor: rs, reason: cond.label + '（当前 ' + rs + ' 层）' };
      case 'all':
        // 复合条件：全部满足才生效，系数取各条相乘（布尔条件返回 1）
        var okAll = true, facAll = 1, reasons = [];
        (cond.of || []).forEach(function (c) {
          var r = evalCond(c, ctx);
          if (!r.ok) okAll = false;
          facAll *= (r.factor == null ? 1 : r.factor);
          if (r.reason) reasons.push(r.reason);
        });
        return { ok: okAll, factor: facAll, reason: reasons.join('，') };
      default:
        return { ok: true, factor: 1, reason: '' };
    }
  }

  global.RelicEffects = {
    PROFESSIONS: PROFESSIONS,
    SUBPROFESSIONS: SUBPROFESSIONS,
    PANEL_STATS: PANEL_STATS,
    COMBAT_STATS: COMBAT_STATS,
    RUN_STATS: RUN_STATS,
    parseEffect: parseEffect,
    evalCond: evalCond,
    detectScope: detectScope,
    detectCond: detectCond
  };
})(typeof window !== 'undefined' ? window : globalThis);
