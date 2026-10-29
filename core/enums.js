/* ============================================================================
 * core/enums.js — 枚举注册表（职业 / 分支 / 稀有度 / 分类 / 编队上限）
 * ============================================================================
 * 契约 v2.0.0
 *
 * 为什么单独一份：这些枚举原本同时存在于
 *   js/effects.js:9-21   PROFESSIONS / SUBPROFESSIONS
 *   js/app.js:14         CATEGORIES
 *   js/app.js:135        RARITY_LABEL
 *   tools/build_relics_official.py:31-89  PROF_MAP / SUBPROF_MAP / BUILDABLE_MAP
 * 手工维护两份（JS 与 Python），改一处必漏另一处。
 *
 * 本文件是 JS 侧唯一来源；Python 侧通过 tools/ 里同一份清单校验
 * （见 tools/check_enums.py）。改动时两边都要过 check。
 *
 * 对外 API
 *   ArkEnums.PROFESSIONS      string[]   八大职业
 *   ArkEnums.SUBPROFESSIONS   string[]   分支名
 *   ArkEnums.POSITIONS        [key,label][]  近战位/远程位
 *   ArkEnums.RARITIES         {0,1,2} -> 中文
 *   ArkEnums.CATEGORIES       string[]   藏品分类
 *   ArkEnums.MAX_SQUAD        number     编队上限（对齐官方 12 人）
 *   ArkEnums.PROF_SHORT       {职业: 单字}  紧凑显示用
 *   ArkEnums.isProfession(n)  bool
 *   ArkEnums.isSubProfession(n) bool
 * ==========================================================================*/
(function (global) {
  'use strict';

  var PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];

  // 分支名清单。前 60 项是历史顺序（保持不动，避免改变文案解析的命中优先级），
  // 末尾补齐的是从 raw/character_table.json 的 subProfessionId 反查出来的、
  // 之前漏掉的 13 个分支 —— 缺了它们，官方藏品里
  // `selector.sub_profession=musha|fearless|artsfghter` 这类限定就只剩两个分支生效，
  // 武者/斗士/要塞/巫役…会静默拿不到本该属于它们的加成。
  var SUBPROFESSIONS = [
    '尖兵', '冲锋手', '策士', '情报官', '执旗手',
    '无畏者', '武者', '术战者', '剑豪', '收割者', '教官', '领主', '本源近卫', '撼地者', '重剑手',
    '铁卫', '哨戒铁卫', '不屈者', '守护者', '决战者', '驭法铁卫', '本源铁卫',
    '速射手', '神射手', '炮手', '散射手', '攻城手', '重射手', '猎手', '回环射手',
    '中坚术师', '扩散术师', '轰击术师', '链术师', '秘术师', '驭械术师', '阵法术师', '本源术师',
    '医师', '群愈师', '疗养师', '行医', '咒愈师', '链愈师',
    '辅助师', '召唤师', '吟游者', '工匠', '护佑者', '削弱者',
    '处决者', '伏击客', '行商', '钩索师', '推击手', '怪杰', '傀儡师', '陷阱师', '炼金师', '巡空者',
    // ---- 补齐（按 subProfessionId 反查）----
    '斗士', '投掷手', '强攻手', '要塞', '解放者', '佣兵',
    '巫役', '裂空炮手', '凝滞师', '塑灵术师', '游击手', '战术家', '守望者'
  ];

  var POSITIONS = [['近战位', '近战位'], ['远程位', '远程位']];

  var RARITIES = { 0: '普通', 1: '稀有', 2: '高稀有度' };

  var CATEGORIES = [
    '全部', '多元奇物', '生存助力', '斗争之物', '专业工具',
    '巧用收藏', '支援道具', '叙事珍奇', '泰拉之密'
  ];

  // 官方编队上限：12 人
  var MAX_SQUAD = 12;

  var PROF_SHORT = {
    '先锋': '先', '近卫': '近', '重装': '重', '狙击': '狙',
    '术师': '术', '医疗': '医', '辅助': '辅', '特种': '特'
  };

  var profSet = Object.create(null);
  PROFESSIONS.forEach(function (p) { profSet[p] = 1; });
  var subSet = Object.create(null);
  SUBPROFESSIONS.forEach(function (p) { subSet[p] = 1; });

  global.ArkEnums = {
    PROFESSIONS: PROFESSIONS,
    SUBPROFESSIONS: SUBPROFESSIONS,
    POSITIONS: POSITIONS,
    RARITIES: RARITIES,
    CATEGORIES: CATEGORIES,
    MAX_SQUAD: MAX_SQUAD,
    PROF_SHORT: PROF_SHORT,
    isProfession: function (n) { return !!profSet[n]; },
    isSubProfession: function (n) { return !!subSet[n]; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
