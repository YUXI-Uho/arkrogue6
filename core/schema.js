/* ============================================================================
 * core/schema.js — 属性注册表（唯一事实来源 / Single Source of Truth）
 * ============================================================================
 * 契约 v2.0.0
 *
 * 设计目标：消灭此前散落在 6 处的平行属性表
 *   effects.js  PANEL_STATS / COMBAT_STATS / RUN_STATS
 *   engine.js   PANEL_KEYS
 *   app.js      PANEL_FIELDS / RESULT_ROWS / STAT_LABELS
 * 全部改为从本文件派生。新增一个属性 = 只改这里一处。
 *
 * ---------------------------------------------------------------------------
 * 字段定义（每个 stat 一条）
 * ---------------------------------------------------------------------------
 *   key       string  内部键名，与 data/relics.json 里 mods[].stat 完全一致
 *   label     string  中文显示名
 *   bucket    string  'panel' | 'combat' | 'run' | 'enemy'
 *                     panel  = 能落到干员最终面板（攻击/防御/生命…）
 *                     combat = 战斗内效果，不进面板，进「战斗类加成」
 *                     run    = 探索/运营资源，进「探索 / 运营」
 *                     enemy  = 对敌减益
 *   alias     string[] 文案解析用的中文别名（长度优先匹配，长的优先）
 *   editable  bool    是否出现在「空白干员」的手动面板输入里
 *   result    bool    是否出现在干员卡的「基础/最终/变化」结果表
 *   settles   bool    是否能真正结算到 final 值（false = 只登记不结算）
 *   decimals  number  显示小数位（0 = 整数）
 *   order     number  展示顺序，越小越靠前
 *
 * ---------------------------------------------------------------------------
 * 对外 API（其他模块只准用这些，禁止再自己抄一份表）
 * ---------------------------------------------------------------------------
 *   ArkSchema.version            '2.0.0'
 *   ArkSchema.STATS              Stat[]                 全量注册表（已按 order 排序）
 *   ArkSchema.PANEL_KEYS         string[]               bucket==='panel' 的 key
 *   ArkSchema.SETTLED_KEYS       string[]               能结算到 final 的 key
 *   ArkSchema.PANEL_FIELDS       {key,label}[]          手动输入字段
 *   ArkSchema.RESULT_ROWS        {key,label}[]          结果表行
 *   ArkSchema.STAT_LABELS        {key:label}            全部中文名
 *   ArkSchema.ALIAS_TO_STAT      {别名: Stat}           文案解析用
 *   ArkSchema.ALIAS_NAMES        string[]               别名，按长度降序
 *   ArkSchema.statOf(key)        Stat | null
 *   ArkSchema.labelOf(key)       string                 找不到时回退 key
 *   ArkSchema.bucketOf(key)      string | null
 *   ArkSchema.settles(key)       bool                   未知 key 视为 true
 *   ArkSchema.decimalsOf(key)    number
 *   ArkSchema.groupByBucket()    {panel:[],combat:[],run:[],enemy:[]}
 *
 * ---------------------------------------------------------------------------
 * 变更约定
 * ---------------------------------------------------------------------------
 *  - 新增属性：只往 STATS 里加一条，不要改任何派生数组。
 *  - 改 bucket：只改 bucket 字段，派生数组自动跟随。
 *  - 不能结算的属性（如 spCost）：settles:false，引擎会把它归入
 *    「未生效/特殊效果」而不是静默丢弃。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var VERSION = '2.0.0';

  // bucket 常量，避免各处手写字符串
  var B = { PANEL: 'panel', COMBAT: 'combat', RUN: 'run', ENEMY: 'enemy' };

  var STATS = [
    // ---------------- panel：能落到干员最终面板 ----------------
    { key: 'hp', label: '生命', bucket: B.PANEL, order: 10, editable: true, result: true,
      alias: ['最大生命值', '最大生命', '生命上限', '生命值', '生命'] },
    { key: 'atk', label: '攻击力', bucket: B.PANEL, order: 20, editable: true, result: true,
      alias: ['攻击力'] },
    { key: 'def', label: '防御力', bucket: B.PANEL, order: 30, editable: true, result: true,
      alias: ['防御力'] },
    { key: 'res', label: '法术抗性', bucket: B.PANEL, order: 40, editable: true, result: true,
      alias: ['法术抗性', '法抗'] },
    { key: 'aspd', label: '攻击速度', bucket: B.PANEL, order: 50, editable: true, result: true,
      alias: ['攻击速度', '攻速'] },
    { key: 'interval', label: '攻击间隔', bucket: B.PANEL, order: 60, editable: true, result: true,
      decimals: 3, alias: ['攻击间隔'] },
    { key: 'block', label: '阻挡数', bucket: B.PANEL, order: 70, editable: true, result: true,
      alias: ['阻挡数', '阻挡'] },
    { key: 'cost', label: '部署费用', bucket: B.PANEL, order: 80, editable: true, result: true,
      alias: ['部署费用', '费用'] },
    { key: 'spRecover', label: '技力回复', bucket: B.PANEL, order: 90, editable: true, result: true,
      decimals: 2, alias: ['技力恢复速度', '技力回复速度', '技力恢复', '技力回复'] },
    { key: 'initSp', label: '初始技力', bucket: B.PANEL, order: 100, editable: true, result: true,
      alias: ['初始技力'] },
    { key: 'redeploy', label: '再部署', bucket: B.PANEL, order: 110, editable: true, result: true,
      alias: ['再部署时间'] },
    // 技能技力消耗：干员数据表里没有这个字段，无法结算到面板。
    // settles:false → 引擎归入「未生效」清单并给出原因，不再假装已生效。
    { key: 'spCost', label: '技力消耗', bucket: B.PANEL, order: 120, editable: false, result: false,
      settles: false, alias: ['技力需求', '技力消耗'] },

    // ---------------- combat：战斗内效果 ----------------
    { key: 'physTaken', label: '敌人受到物理伤害', bucket: B.COMBAT, order: 210, alias: ['受到的物理伤害', '物理伤害'] },
    { key: 'magicTaken', label: '敌人受到法术伤害', bucket: B.COMBAT, order: 220, alias: ['受到的法术伤害', '法术伤害'] },
    { key: 'trueTaken', label: '敌人受到真实伤害', bucket: B.COMBAT, order: 230, alias: ['受到的真实伤害', '真实伤害'] },
    { key: 'dmgReduce', label: '造成伤害提升', bucket: B.COMBAT, order: 240, alias: ['造成的伤害'] },
    { key: 'dmgTakenReduce', label: '受到伤害', bucket: B.COMBAT, order: 250, alias: ['受到的伤害'] },
    { key: 'heal', label: '受到治疗', bucket: B.COMBAT, order: 260,
      alias: ['受到的治疗和生命回复效果', '受到的治疗', '治疗效果', '治疗和生命回复效果'] },
    { key: 'hpRegen', label: '每秒生命回复', bucket: B.COMBAT, order: 270, alias: ['每秒回复生命', '生命回复'] },
    { key: 'hpRegenPct', label: '每秒生命回复(按上限)', bucket: B.COMBAT, order: 280 },
    { key: 'elemental', label: '元素伤害/损伤', bucket: B.COMBAT, order: 290, alias: ['元素损伤', '元素伤害'] },
    { key: 'elementalRes', label: '元素损伤减免', bucket: B.COMBAT, order: 300 },
    { key: 'statusTime', label: '异常状态时间', bucket: B.COMBAT, order: 310 },
    { key: 'dodgePhys', label: '物理闪避', bucket: B.COMBAT, order: 320, alias: ['物理闪避'] },
    { key: 'dodgeMagic', label: '法术闪避', bucket: B.COMBAT, order: 330, alias: ['法术闪避'] },
    { key: 'dodgeAll', label: '物理/法术闪避', bucket: B.COMBAT, order: 340, alias: ['物理与法术闪避'] },
    { key: 'spOnAttack', label: '攻击/受击回技力', bucket: B.COMBAT, order: 350 },
    { key: 'spOnSkillEnd', label: '技能结束回技力', bucket: B.COMBAT, order: 360 },
    { key: 'spOnKill', label: '击倒敌人回技力', bucket: B.COMBAT, order: 362 },
    { key: 'hpOnKill', label: '击倒敌人回血(按上限)', bucket: B.COMBAT, order: 364 },
    // 「脆弱」：敌人受到的伤害提高。和 dmgReduce（我方造成的伤害提升）方向相反，别混用。
    // label 不带「敌人」二字：战斗卡渲染时会按作用域追加「（对敌）」，
    // 写全了会显示成「敌人易伤(脆弱)（对敌）」。
    { key: 'weak', label: '易伤(脆弱)', bucket: B.COMBAT, order: 366 },
    // 屏障：官方 buff 分两种写法，按生命上限比例（scale / born_hp_ratio / hp_ratio）
    // 与固定值（add_shield）。两者语义不同，合成一条会把 100 点当成 100% 生命。
    { key: 'shieldPct', label: '屏障(按生命上限)', bucket: B.COMBAT, order: 368 },
    { key: 'shieldFlat', label: '屏障(固定值)', bucket: B.COMBAT, order: 369 },
    { key: 'firstHit', label: '首次伤害', bucket: B.COMBAT, order: 370 },
    { key: 'stun', label: '晕眩时间(秒)', bucket: B.COMBAT, order: 372, decimals: 1 },
    { key: 'silence', label: '沉默时间(秒)', bucket: B.COMBAT, order: 374, decimals: 1 },
    { key: 'levitate', label: '浮空时间(秒)', bucket: B.COMBAT, order: 376, decimals: 1 },
    { key: 'ammo', label: '弹药补充(按上限)', bucket: B.COMBAT, order: 378 },
    { key: 'atkScale', label: '攻击倍率', bucket: B.COMBAT, order: 380 },
    // 「攻击时无视目标 X% 的防御」——不是面板属性，只在伤害估算里生效
    { key: 'defIgnore', label: '无视防御', bucket: B.COMBAT, order: 384 },
    { key: 'dmgCap', label: '单次受伤上限(按生命)', bucket: B.COMBAT, order: 382 },
    { key: 'damage', label: '额外伤害', bucket: B.COMBAT, order: 390 },
    { key: 'weight', label: '敌人重量', bucket: B.COMBAT, order: 400, alias: ['重量'] },
    { key: 'moveSpeed', label: '敌人移动速度', bucket: B.COMBAT, order: 410, alias: ['移动速度', '移速'] },

    // ---------------- enemy：对敌减益 ----------------
    { key: 'enemyHp', label: '敌人生命', bucket: B.ENEMY, order: 500 },
    { key: 'enemyAtk', label: '敌人攻击力', bucket: B.ENEMY, order: 510 },
    { key: 'enemyDef', label: '敌人防御力', bucket: B.ENEMY, order: 520 },
    { key: 'enemyRes', label: '敌人法术抗性', bucket: B.ENEMY, order: 530 },

    // ---------------- run：探索 / 运营 ----------------
    // v1 里 '希望上限' 同时挂在 hope 与 hopeMax 上，靠「先注册者胜出」决定归属，
    // 结果 '希望上限+2' 被解析成 hope，语义是错的。这里把别名拆干净：
    // '希望上限' 只属于 hopeMax，'希望' 只属于 hope。
    { key: 'hope', label: '希望', bucket: B.RUN, order: 610, alias: ['希望'] },
    { key: 'hopeMax', label: '希望上限', bucket: B.RUN, order: 620, alias: ['希望上限'] },
    { key: 'ingot', label: '源石锭', bucket: B.RUN, order: 630, alias: ['源石锭'] },
    { key: 'shield', label: '护盾值', bucket: B.RUN, order: 640, alias: ['护盾值', '护盾'] },
    { key: 'targetHpMax', label: '目标生命上限', bucket: B.RUN, order: 650, alias: ['目标生命上限'] },
    { key: 'targetHp', label: '目标生命', bucket: B.RUN, order: 660, alias: ['目标生命'] },
    { key: 'carry', label: '可携带干员', bucket: B.RUN, order: 670, alias: ['可携带干员'] },
    { key: 'deploy', label: '可同时部署人数', bucket: B.RUN, order: 680, alias: ['可同时部署人数'] },
    { key: 'exp', label: '指挥经验', bucket: B.RUN, order: 690, alias: ['指挥经验'] },
    // 这几个是「局内资源」而不是干员面板属性，别名必须比面板属性更长，
    // 否则文案里的「初始部署费用+10」会被 cost 的别名「部署费用」吃掉，
    // 变成给每名干员的部署费用 +10（人偶之家 / 微缩舞台模型 / 缠梦古堡模型）。
    { key: 'initCost', label: '初始部署费用', bucket: B.RUN, order: 710, alias: ['初始部署费用', '初始费用'] },
    // 「开启技能立刻获得 X 点部署费用」是回费，不是把干员部署费用抬高。
    // 2026-10 修正：这条以前被当成 cost +3（钝爪-先机），会让所有先锋变贵 3 费。
    { key: 'dpOnSkill', label: '技能开启获得部署费用', bucket: B.RUN, order: 715, alias: ['获得部署费用', '获得费用'] },
    { key: 'ingotRate', label: '战斗源石锭收益', bucket: B.RUN, order: 720, alias: ['战斗掉落的源石锭', '战斗获得的源石锭', '掉落的源石锭'] },
    { key: 'ingotPerZone', label: '每区域源石锭', bucket: B.RUN, order: 730 },
    { key: 'expRate', label: '指挥经验收益', bucket: B.RUN, order: 740, alias: ['战斗获得的指挥经验', '获得的指挥经验'] },
    { key: 'ap', label: '行动力', bucket: B.RUN, order: 750, alias: ['行动力'] },
    { key: 'apPerZone', label: '每区域行动力', bucket: B.RUN, order: 760 },
    // 「零件箱容量 / 零件仓库容量」和官方 id rogue_6_max_weight 指的是同一件事
    // （IS6 的负载上限就是零件箱格数）。旧实现把文案记成 partCap、官方记成 maxWeight，
    // 198 薄行囊因此同时出现「零件箱容量 +4」和「最大负载 +4」两条。
    { key: 'maxWeight', label: '最大负载(零件箱容量)', bucket: B.RUN, order: 770,
      alias: ['零件箱容量', '零件仓库容量', '最大负载', '负载'] },
    { key: 'sp', label: '技力', bucket: B.RUN, order: 780 }
  ];

  // ---------- 规范化：补齐默认字段 + 排序 ----------
  STATS.forEach(function (s) {
    if (!s.alias) s.alias = [];
    if (s.editable == null) s.editable = false;
    if (s.result == null) s.result = false;
    if (s.settles == null) s.settles = true;
    if (s.decimals == null) s.decimals = 0;
    if (s.order == null) s.order = 9999;
  });
  STATS.sort(function (a, b) { return a.order - b.order; });

  var byKey = Object.create(null);
  STATS.forEach(function (s) { byKey[s.key] = s; });

  // ---------- 派生：别名表（长名优先）----------
  // 长度必须按「别名本身」记录，不能记在 stat 上 —— v1 把 len 记在 stat 上，
  // 导致同一 stat 的后一个短别名会把 len 覆盖掉，长名优先规则随之失效。
  var aliasMap = Object.create(null);
  var aliasLen = Object.create(null);
  STATS.forEach(function (s) {
    s.alias.forEach(function (name) {
      if (aliasLen[name] == null || aliasLen[name] < name.length) {
        aliasMap[name] = s;
        aliasLen[name] = name.length;
      }
    });
  });

  var aliasNames = Object.keys(aliasMap).sort(function (a, b) { return b.length - a.length; });

  // ---------- 派生：各类视图 ----------
  function pick(list, field) {
    return list.filter(function (s) { return s[field]; })
      .map(function (s) { return { key: s.key, label: s.label }; });
  }

  var PANEL_KEYS = STATS.filter(function (s) { return s.bucket === B.PANEL; })
    .map(function (s) { return s.key; });
  var SETTLED_KEYS = STATS.filter(function (s) { return s.bucket === B.PANEL && s.settles; })
    .map(function (s) { return s.key; });
  var PANEL_FIELDS = pick(STATS, 'editable');
  var RESULT_ROWS = pick(STATS, 'result');

  var STAT_LABELS = Object.create(null);
  STATS.forEach(function (s) { STAT_LABELS[s.key] = s.label; });

  function statOf(key) { return byKey[key] || null; }
  function labelOf(key) { var s = byKey[key]; return s ? s.label : String(key); }
  function bucketOf(key) { var s = byKey[key]; return s ? s.bucket : null; }
  function settles(key) { var s = byKey[key]; return s ? s.settles !== false : true; }
  function decimalsOf(key) { var s = byKey[key]; return s ? s.decimals : 0; }

  function groupByBucket() {
    var out = { panel: [], combat: [], run: [], enemy: [] };
    STATS.forEach(function (s) {
      if (out[s.bucket]) out[s.bucket].push(s);
    });
    return out;
  }

  global.ArkSchema = {
    version: VERSION,
    BUCKETS: B,
    STATS: STATS,
    PANEL_KEYS: PANEL_KEYS,
    SETTLED_KEYS: SETTLED_KEYS,
    PANEL_FIELDS: PANEL_FIELDS,
    RESULT_ROWS: RESULT_ROWS,
    STAT_LABELS: STAT_LABELS,
    ALIAS_TO_STAT: aliasMap,
    ALIAS_NAMES: aliasNames,
    statOf: statOf,
    labelOf: labelOf,
    bucketOf: bucketOf,
    settles: settles,
    decimalsOf: decimalsOf,
    groupByBucket: groupByBucket
  };
})(typeof window !== 'undefined' ? window : globalThis);
