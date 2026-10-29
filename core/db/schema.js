/* ============================================================================
 * core/db/schema.js — 表结构定义（数据库的唯一事实来源）
 * ============================================================================
 * 这个文件只描述「有哪些表、每张表有哪些列、主键是什么、按哪几列建索引」，
 * 不含任何数据、也不做读写。数据由 tools/build_db.py 装配成 data/is6db.js，
 * 运行时的查询由 core/db/db.js 负责。
 *
 * 为什么要有这一层：
 *   以前数据是 window.RELIC_DATA.relics 这种嵌套数组，字段名散落在生成器、
 *   仓储层和测试里，官方一改字段就得全库 grep。现在列名只在这里写一次，
 *   Python 侧的 tools/build_db.py 按同一份列定义装配，check_enums.py 负责
 *   比对两边有没有漂移。
 *
 * 两类表：
 *   game  只读，随官方数据更新而整体重建
 *         relics / relic_stages / operators / operator_phases / operator_skills /
 *         operator_talents / operator_modules / operator_module_levels / ranges
 *   user  读写，来自玩家操作，持久化在浏览器本地
 *         selection / squads / presets / settings
 *
 * 列类型（仅用于装配期校验，运行时是 JS 值，不做强制转换）
 *   text / int / real / bool / json
 *
 * ---------------------------------------------------------------------------
 * 对外 API
 *   DBSchema.VERSION                当前表结构版本（= 存档版本）
 *   DBSchema.TABLES                 {表名: 表定义}
 *   DBSchema.NAMES                  string[]  全部表名
 *   DBSchema.GAME_TABLES            string[]  只读表
 *   DBSchema.USER_TABLES            string[]  用户表
 *   DBSchema.get(name)              表定义 | null
 *   DBSchema.pkOf(name, row)        主键值（复合主键拼成一个字符串）
 *   DBSchema.isKnown(name)          bool
 *   DBSchema.blankRow(name)         按列定义生成空行（用户表新增行用）
 * ==========================================================================*/
(function (global) {
  'use strict';

  // 改这里 = 改存档版本。加列不算破坏性变更（读取侧会补默认值），
  // 删列 / 改语义才需要升版本并在 core/db/migrate.js 里加一条迁移。
  // 注意：只有 user 表（selection / squads / presets / settings）参与存档，
  // game 表随官方数据整体重建，增减它们不影响存档格式，不用升版本。
  var VERSION = 3;

  var TABLES = {
    // ---------------- 只读：藏品 ----------------
    relics: {
      kind: 'game',
      title: '藏品',
      pk: 'id',
      columns: {
        id: 'text',
        name: 'text',
        category: 'text',
        rarity: 'int',
        icon: 'text',
        flags: 'json',        // ['stack'] 之类
        desc: 'text',
        condition: 'text',    // 获取条件
        note: 'text',
        obtain: 'text',
        stageCount: 'int'     // 档位数量，配合 relic_stages 用
      },
      indexes: ['category', 'rarity']
    },

    // ---------------- 只读：藏品档位（一件藏品多行） ----------------
    // 从 relics 里拆出来，是因为「结构化 / 半结构化 / 非结构化 / 混沌化」
    // 各自有独立的文案与修正项，本质是一对多关系，塞在 JSON 数组里没法按档位查。
    relic_stages: {
      kind: 'game',
      title: '藏品档位',
      pk: ['relicId', 'stage'],
      columns: {
        relicId: 'text',
        stage: 'int',
        name: 'text',
        text: 'text',
        mods: 'json',         // [{stat, bucket, pct, value, scope, cond, src, group}]
        special: 'json',
        parsedBy: 'text'      // official | official+text | text | ''
      },
      indexes: ['relicId']
    },

    // ---------------- 只读：干员 ----------------
    // 面板从嵌套的 panel 对象拆成独立列：面板字段由 core/schema.js 的
    // PANEL_FIELDS 定义，列名与之一一对应，加字段时两边一起改（check_enums 会查）。
    // 这里的 hp/atk/... 是「最高精英化 + 满级 + 不含信赖」那一档，供计算直接取用；
    // 三档面板在 operator_phases 里，详情页按阶段切换。
    operators: {
      kind: 'game',
      title: '干员',
      pk: 'id',
      columns: {
        id: 'text',
        name: 'text',
        profession: 'text',
        subProfession: 'text',
        position: 'text',
        rarity: 'int',
        elite: 'int',
        level: 'int',
        hp: 'int',
        atk: 'int',
        def: 'int',
        res: 'int',
        aspd: 'int',
        interval: 'real',
        block: 'int',
        cost: 'int',
        spRecover: 'real',
        initSp: 'int',
        redeploy: 'int',
        favorHp: 'int',
        favorAtk: 'int',
        favorDef: 'int',
        // ---- 以下只给详情页 / 检索用，计算链路不读 ----
        displayNumber: 'text',   // 图鉴编号
        appellation: 'text',     // 英文名
        obtain: 'text',          // 获取途径
        tags: 'json',            // ['输出','支援']
        trait: 'text',           // 职业特性文案
        rangeId: 'text',         // 最高阶段攻击范围 id → ranges
        potential: 'json'        // 潜能描述（5 条）
      },
      indexes: ['name', 'profession', 'rarity']
    },

    // ---------------- 只读：精英化阶段面板（一名干员多行） ----------------
    // E0 / E1 / E2 各一行，取该阶段满级那一帧。计算默认用 operators 表的最高档，
    // 详情页则靠这张表展示成长曲线，也方便以后做「按精英化阶段换算」。
    operator_phases: {
      kind: 'game',
      title: '干员精英化面板',
      pk: ['id', 'elite'],
      columns: {
        id: 'text',
        elite: 'int',
        level: 'int',
        hp: 'int',
        atk: 'int',
        def: 'int',
        res: 'int',
        aspd: 'int',
        interval: 'real',
        cost: 'int',
        block: 'int',
        redeploy: 'int',
        rangeId: 'text'
      },
      indexes: ['id']
    },

    // ---------------- 只读：干员技能（一名干员最多 3 行） ----------------
    // 数值取专三（10 级表的最后一档），另留一份 7 级 SP 消耗用于对比。
    // 文案里的 {key:0%} 占位符已在生成阶段按 blackboard 填好。
    operator_skills: {
      kind: 'game',
      title: '干员技能',
      pk: ['id', 'slot'],
      columns: {
        id: 'text',
        slot: 'int',
        skillId: 'text',
        name: 'text',
        chargeType: 'text',      // 自动回复 / 攻击回复 / 受击回复
        activation: 'text',      // 自动触发 / 手动触发 / 被动
        duration: 'real',
        spCost: 'int',
        initSp: 'int',
        spCost7: 'int',
        initSp7: 'int',
        desc: 'text',
        rangeId: 'text',
        maxLevel: 'int',
        unlockElite: 'int'       // 槽位 1/2/3 = E0/E1/E2
      },
      indexes: ['id', 'skillId']
    },

    // ---------------- 只读：干员天赋 ----------------
    // 每个天赋槽位只留「最高阶段 + 无潜能要求」那一版，潜能版本不重复入库。
    operator_talents: {
      kind: 'game',
      title: '干员天赋',
      pk: ['id', 'idx'],
      columns: {
        id: 'text',
        idx: 'int',
        name: 'text',
        desc: 'text',
        unlockElite: 'int',
        unlockLevel: 'int'
      },
      indexes: ['id']
    },

    // ---------------- 只读：干员模组 ----------------
    // 模组本身（名称/类型/解锁条件）与三档加成拆成两张表：档位是可枚举的，
    // 塞进 JSON 数组就没法按等级查，也没法和 operators 的列对齐做校验。
    operator_modules: {
      kind: 'game',
      title: '干员模组',
      pk: ['id', 'moduleId'],
      columns: {
        id: 'text',
        moduleId: 'text',
        name: 'text',
        type: 'text',            // INITIAL / ADVANCED / UNIQUE
        typeName: 'text',
        unlockElite: 'int',
        unlockLevel: 'int'
      },
      indexes: ['id']
    },

    operator_module_levels: {
      kind: 'game',
      title: '模组档位',
      pk: ['id', 'moduleId', 'level'],
      columns: {
        id: 'text',
        moduleId: 'text',
        level: 'int',
        hp: 'int',
        atk: 'int',
        def: 'int',
        res: 'int',
        aspd: 'int',
        interval: 'real',
        cost: 'int',
        block: 'int',
        redeploy: 'int',
        desc: 'text'             // 与上一档相同则留空，读取侧回退到最近的非空档
      },
      indexes: ['id', 'moduleId']
    },

    // ---------------- 只读：攻击范围 ----------------
    // 73 种范围全表只有几 KB，直接存格子坐标，界面上画成网格。
    ranges: {
      kind: 'game',
      title: '攻击范围',
      pk: 'id',
      columns: {
        id: 'text',
        direction: 'int',
        grids: 'json'            // [[row, col], ...]
      },
      indexes: []
    },

    // ---------------- 用户：已选藏品 ----------------
    selection: {
      kind: 'user',
      title: '已选藏品',
      pk: 'relicId',
      columns: {
        relicId: 'text',
        stage: 'int',
        stack: 'int'
      }
    },

    // ---------------- 用户：编队 ----------------
    // ord 是必需的：表是无序的，没有这一列就还原不出玩家排的队伍顺序。
    squads: {
      kind: 'user',
      title: '编队',
      pk: 'id',
      columns: {
        id: 'text',
        ord: 'int',
        name: 'text',
        profession: 'text',
        subProfession: 'text',
        position: 'text',
        rarity: 'int',
        avatar: 'text',
        panel: 'json',
        favor: 'json',
        useFavor: 'bool',
        assignTarget: 'bool'
      }
    },

    // ---------------- 用户：常用编队 ----------------
    presets: {
      kind: 'user',
      title: '常用编队',
      pk: 'name',
      columns: {
        name: 'text',
        ts: 'int',
        ops: 'json'
      }
    },

    // ---------------- 用户：设置（战斗状态 / 伤害估算输入） ----------------
    // 一行一个设置项，加参数不用改表结构。
    settings: {
      kind: 'user',
      title: '设置',
      pk: 'key',
      columns: {
        key: 'text',
        value: 'json'
      }
    }
  };

  // 每张表都补齐 indexes（没写的当空数组）：消费方不必到处判空，
  // 也免得「漏写 indexes」和「故意不建索引」两种情况长得一样。
  Object.keys(TABLES).forEach(function (n) {
    if (!Array.isArray(TABLES[n].indexes)) TABLES[n].indexes = [];
  });

  var NAMES = Object.keys(TABLES);
  var GAME_TABLES = NAMES.filter(function (n) { return TABLES[n].kind === 'game'; });
  var USER_TABLES = NAMES.filter(function (n) { return TABLES[n].kind === 'user'; });

  function get(name) { return TABLES[name] || null; }
  function isKnown(name) { return !!TABLES[name]; }

  // 复合主键用不可见分隔符拼接：relicId 是文本、stage 是数字，用 '|' 会和 id 撞。
  var SEP = '\u0001';

  function pkOf(name, row) {
    var def = TABLES[name];
    if (!def || !row) return '';
    if (Array.isArray(def.pk)) {
      var out = [];
      for (var i = 0; i < def.pk.length; i++) out.push(String(row[def.pk[i]]));
      return out.join(SEP);
    }
    return String(row[def.pk]);
  }

  // 空行的默认值按类型给：int/real → 0，bool → false，json → null，text → ''
  function blankRow(name) {
    var def = TABLES[name];
    var row = {};
    if (!def) return row;
    Object.keys(def.columns).forEach(function (col) {
      var t = def.columns[col];
      row[col] = t === 'int' || t === 'real' ? 0 : t === 'bool' ? false : t === 'json' ? null : '';
    });
    return row;
  }

  global.DBSchema = {
    VERSION: VERSION,
    TABLES: TABLES,
    NAMES: NAMES,
    GAME_TABLES: GAME_TABLES,
    USER_TABLES: USER_TABLES,
    get: get,
    isKnown: isKnown,
    pkOf: pkOf,
    blankRow: blankRow
  };
})(typeof window !== 'undefined' ? window : globalThis);
