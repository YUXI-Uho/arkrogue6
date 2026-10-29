/* 计算引擎：藏品修正项 → 干员最终面板 / 队伍加成汇总
 * 属性清单来自 core/schema.js（唯一事实来源），本文件不再自带 key 列表。
 */
(function (global) {
  'use strict';
  var R = global.RelicEffects;

  if (!global.ArkSchema) {
    throw new Error('js/engine.js 依赖 core/schema.js，请确认 index.html 里 core/schema.js 排在 js/engine.js 之前');
  }
  var S = global.ArkSchema;

  var cache = Object.create(null);

  // 取某件藏品在某个「拟造阶段」下的效果文本
  function effectTextFor(relic, stageIndex) {
    if (relic.stages && relic.stages.length) {
      var st = relic.stages[Math.min(stageIndex || 0, relic.stages.length - 1)];
      return st.text || '';
    }
    return relic.effect || '';
  }

  function tierLabels(relic) {
    if (relic.stages && relic.stages.length > 1) {
      return relic.stages.map(function (s) { return s.name || ''; });
    }
    return [];
  }

  // 层数上限可能藏在复合条件（type:'all'）里，要递归找
  function condCap(cond) {
    if (!cond) return 0;
    if (cond.cap) return cond.cap;
    if (cond.type === 'all' && cond.of) {
      for (var i = 0; i < cond.of.length; i++) {
        var c = condCap(cond.of[i]);
        if (c) return c;
      }
    }
    return 0;
  }

  function stackCap(relic) {
    // 官方数据里层数上限写在条件里（字段名 cap）
    if (relic.stages) {
      for (var i = 0; i < relic.stages.length; i++) {
        var mods = relic.stages[i].mods || [];
        for (var j = 0; j < mods.length; j++) {
          var capHere = condCap(mods[j].cond);
          if (capHere) return capHere;
        }
      }
    }
    var m = (relic.effect || '').match(/最多(?:叠加)?(\d+)层/);
    if (m) return +m[1];
    // 阶段文案里也会写上限（196《拳经三问》「最多叠加40层」），旧实现只看 effect/note
    if (relic.stages) {
      for (var k = 0; k < relic.stages.length; k++) {
        var tm = (relic.stages[k].text || '').match(/最多(?:叠加)?(\d+)层/);
        if (tm) return +tm[1];
      }
    }
    m = (relic.note || '').match(/最多(?:叠加)?(\d+)/);
    if (m) return +m[1];
    return relic.flags && relic.flags.indexOf('stack') >= 0 ? 99 : 0;
  }

  // 夹层数时用的真实上限。
  // stackCap 返回 0 有两种含义：数据里没写上限，或这件藏品本来就不叠层。
  // 旧代码用 `cap || 999` 兜底，等于把「不可叠加」放开成 999 层，只靠 UI 拦。
  function maxStackOf(relic, cap) {
    if (cap > 0) return cap;
    return relic.flags && relic.flags.indexOf('stack') >= 0 ? 99 : 1;
  }

  // 「按层乘算」的通用判定：只看文案句式，不认藏品 id。
  //   「最多叠加 N 层」              → 明确层数上限
  //   「每<次|场|个|名|使用|…>…，…+N%」 → 每次/每个累加一次
  // 旧实现用一张按藏品 id 写死的白名单（193/197/208/218），数据重生成后
  // id 一变就静默失效；改成文案判定后，只要数据里还写着累加句式就仍然生效。
  var PER_LAYER_TEXT_RE = /最多(?:叠加)?\d+层|每(?:次|场|个|名|使用|击倒|完美作战|去过|进入|探索)[^，。；]{0,10}[，,][^。；]{0,24}?\d+(?:\.\d+)?%/;

  // 「按场上人数缩放」的句式：驱动量是人数（detectCond 已产出 perProfession / perAlly），
  // 不是用户手填的层数。152「场上每有一名【术师】干员，…+12%（最多叠加8层）」里的
  // 「最多叠加8层」只是上限；打上 perLayer 会把驱动量换成一个默认 0 的层数框，
  // 效果从「无条件生效（高估）」变成「默认完全不生效且无提示」。
  var PER_PERSON_TEXT_RE = /场上每有(?:一|1)?名|每有一名干员|周围\d+格每有一名干员/;
  var SCALE_COND_TYPES = { perProfession: 1, perAlly: 1 };

  // 解析并缓存：{ mods, unmatched, source }
  // 官方 buffs 已经给出结构化修正项时直接用；没有才退回中文文案解析
  // 缓存键只含 id + 阶段：层数是运行时乘算（perStack 的 factor），不进键。
  function parseRelic(relic, stageIndex) {
    var idx = Math.min(stageIndex || 0, Math.max(0, (relic.stages ? relic.stages.length : 1) - 1));
    var key = relic.id + '#' + idx;
    if (cache[key]) return cache[key];

    var stage = relic.stages ? relic.stages[idx] : null;
    var text = stage ? (stage.text || '') : (relic.effect || '');
    var parsed;
    if (stage && stage.mods && stage.mods.length) {
      // 官方结构化结果为主；文案能补出官方没覆盖的属性时再补上（按「属性+百分比/固定」去重）
      // 复制一份再打标记，避免把 perLayer / src 写到 data 里的原始对象上。
      // 顺带丢掉 value === 0 的项：官方数据里 immediate_reward 的 count=0 是「占位」
      // 而非真实效果（224/236/237/238），留着会在汇总区渲染出「目标生命 +0」。
      var mods = stage.mods
        .filter(function (m) { return m && m.value !== 0; })
        .map(function (m) { return Object.assign({}, m); });
      var have = {};
      mods.forEach(function (m) { have[m.stat + (m.pct ? '%' : '')] = 1; });
      var textParse = R.parseEffect(text);
      var extra = textParse.mods;
      var added = 0;
      // 费用类不进「文案补漏」：中文里的「获得 3 点部署费用」「首次部署费用-75%」
      // 和「初始部署费用+10」极易被解析成同一个 cost，补进去就会算到干员头上。
      // 这类以官方 buff 为准，官方没给就宁可缺，也不能错。
      var ECONOMY = { cost: 1, initCost: 1, spCost: 1, dpOnSkill: 1 };
      extra.forEach(function (m) {
        var k = m.stat + (m.pct ? '%' : '');
        if (have[k] || ECONOMY[m.stat]) return;
        have[k] = 1;
        m.src = 'text';
        mods.push(m);
        added++;
      });
      // 只收「受益方是具名单位、被解析器主动弃用」的分句（209 的「猎犬proto的攻击力-50%」）：
      // 官方结构化数据已覆盖的部分不必再重复列一遍，否则每件官方藏品都会多出一堆特殊效果。
      // 官方 mods 全被过滤掉（占位型 count=0）时，不能还标成「官方结构化」，
      // 否则界面上会同时出现「官方结构化」和「特殊/未量化」两个矛盾标签。
      var src = added ? 'official+text' : (mods.length ? 'official' : 'none');
      parsed = { mods: mods, unmatched: textParse.guarded.slice(), source: src, text: text };
    } else {
      var p = R.parseEffect(text);
      parsed = { mods: p.mods, unmatched: p.unmatched, source: 'text', text: text };
      if (stage && stage.special) parsed.unmatched = stage.special.concat(parsed.unmatched);
    }

    // 文案带累加句式，且该修正项没有别的硬条件（无条件，或只写了层数上限）→ 每层乘算。
    // 有其它条件的（如 208 的「与居民作战时，敌人生命-40%」）不标记；
    // 按场上人数缩放的（perProfession / perAlly）也不标记 —— 驱动量是人数，不是手填层数。
    // 只对「文案解析出来的」修正项生效：官方 blackboard 已经用 max_stack_cnt 给出
    // 精确的 perStack 条件，再拿中文句式二次判定会把「补充30%的弹药」这种
    // 一次性效果（110/111）误标成叠层，界面上就会多出一个毫无意义的层数框。
    if (PER_LAYER_TEXT_RE.test(text)) {
      var personScaled = PER_PERSON_TEXT_RE.test(text);
      parsed.mods.forEach(function (m) {
        if (m.src === 'official') return;
        if (m.cond && SCALE_COND_TYPES[m.cond.type]) return;
        // 整段文案就是按人数缩放的，无条件的项也不能换成层数框（否则默认 0 层 = 静默失效）
        if (!m.cond && personScaled) return;
        if (!m.cond || m.cond.type === 'capLayer') m.perLayer = true;
      });
    }

    cache[key] = parsed;
    return parsed;
  }

  function normalizePhase(op) {
    var p = op.position || '';
    if (/近战/.test(p)) return 'MELEE';
    if (/远程/.test(p)) return 'RANGED';
    return p;
  }

  // 作用域是否覆盖该干员
  function scopeCovers(scope, op) {
    if (!scope) return true;
    if (scope.base === 'enemy') return false;
    if (scope.summon && !op.summon) return false;
    if (scope.assign && !op.assignTarget) return false;
    if (scope.professions && scope.professions.length) {
      if (scope.professions.indexOf(op.profession) < 0) return false;
    }
    if (scope.subProfs && scope.subProfs.length) {
      if (scope.subProfs.indexOf(op.subProfile || op.subProfession) < 0) return false;
    }
    if (scope.positions && scope.positions.length) {
      if (scope.positions.indexOf(normalizePhase(op)) < 0) return false;
    }
    return true;
  }

  function scopeLabel(scope) {
    if (!scope) return '全体我方';
    if (scope.base === 'enemy') return '敌方';
    if (scope.assign) return '指定干员';
    if (scope.professions && scope.professions.length) return scope.professions.join('/') + '干员';
    if (scope.subProfs && scope.subProfs.length) return scope.subProfs.join('/');
    if (scope.positions && scope.positions.length) {
      return scope.positions[0] === 'MELEE' ? '近战位' : '远程位';
    }
    return '全体我方';
  }

  // 收集选中藏品的全部修正项
  // selection: [{id, stage, stack}]
  function buildModifiers(selection, relicIndex) {
    var out = [];
    // 本次选择里各藏品的层数，供跨藏品条件读取（209 按【探测先锋】层数加抗性）
    var stackMap = {};
    var heldMap = {};
    (selection || []).forEach(function (s0) {
      if (!s0) return;
      heldMap[s0.id] = true;
      if (s0.stack) stackMap[s0.id] = s0.stack;
    });
    (selection || []).forEach(function (sel) {
      var relic = relicIndex[sel.id];
      if (!relic) return;
      var parsed = parseRelic(relic, sel.stage || 0);
      var stack = Math.max(0, Math.min(sel.stack || 0, maxStackOf(relic, stackCap(relic))));
      var stageName = tierLabels(relic)[sel.stage || 0] || '';
      parsed.mods.forEach(function (m) {
        var cond = m.cond;
        if (m.perLayer) {
          // 每层乘算：层数上限若原本写在 capLayer 里，搬到新条件上，stackCap 仍读得到。
          cond = { type: 'perStack', label: '每层' };
          if (m.cond && m.cond.cap) cond.cap = m.cond.cap;
        }
        out.push({
          relicId: relic.id,
          relicName: relic.name,
          rarity: relic.rarity,
          category: relic.category,
          stageName: stageName,
          stack: stack,
          stat: m.stat,
          label: m.label,
          bucket: m.bucket,
          pct: m.pct,
          value: m.value,
          mult: m.mult,
          group: m.group,
          scope: m.scope,
          cond: cond,
          text: m.text,
          relicStacks: stackMap,
          relics: heldMap
        });
      });
      if (!parsed.mods.length && !parsed.unmatched.length) {
        // 纯战术/结局类藏品：没有任何数值项，也没有可读残句 —— 也给一条，
        // 否则「选了却完全没出现在汇总里」，看起来像没生效。
        out.push({
          relicId: relic.id, relicName: relic.name, rarity: relic.rarity, category: relic.category,
          stageName: stageName, stack: stack, bucket: 'special',
          text: (parsed.text || relic.name)
        });
      }
      parsed.unmatched.forEach(function (u) {
        out.push({
          relicId: relic.id,
          relicName: relic.name,
          rarity: relic.rarity,
          category: relic.category,
          stageName: stageName,
          stack: stack,
          bucket: 'special',
          text: u
        });
      });
    });
    return out;
  }

  // 面板属性清单：指向注册表的同一个数组，保持对外接口不变
  var PANEL_KEYS = S.PANEL_KEYS;

  function emptyAcc() {
    var acc = {};
    // 只初始化能真正结算的 key：settles:false 的属性（spCost）走 unapplied，
    // 预置空桶会让「明细里有、面板里没有」的假象重新出现。
    S.SETTLED_KEYS.forEach(function (k) { acc[k] = { flat: 0, pct: 0, list: [] }; });
    return acc;
  }

  // 单个干员计算
  // op: {name, profession, subProfession, position, panel:{hp,atk,def,res,aspd,block,cost,interval,spRecover,...}}
  function computeOperator(op, mods, ctx) {
    ctx = ctx || {};
    var acc = emptyAcc();
    var combat = [];
    var inactive = [];
    var unapplied = [];

    mods.forEach(function (m) {
      if (m.bucket === 'panel') {
        if (!scopeCovers(m.scope, op)) return;
        var e = R.evalCond(m.cond, Object.assign({}, ctx, { block: ctx.block != null ? ctx.block : op.panel.block, stack: m.stack, relicStacks: m.relicStacks || ctx.relicStacks, relics: m.relics || ctx.relics }));
        var factor = e.factor || 1;
        var value = m.value * factor;
        var pct = !!m.pct;
        if (m.mult) {
          // 「提升至140%」→ 相当于 +40%
          value = (m.value / 100 - 1) * 100 * factor;
          pct = true;
        }
        // 注册表声明不可结算的属性（spCost）没有对应的面板字段：
        // 进 unapplied 并给出原因，不要推进 acc 假装已生效。
        if (S.settles(m.stat) === false) {
          unapplied.push({
            relicId: m.relicId, relicName: m.relicName, stageName: m.stageName,
            stat: m.stat, label: m.label, value: value, pct: pct,
            reason: '该属性无法落到干员面板（数据表无对应字段）',
            scopeLabel: scopeLabel(m.scope), text: m.text,
            rarity: m.rarity, category: m.category
          });
          return;
        }
        var rec = {
          relicId: m.relicId, relicName: m.relicName, stageName: m.stageName,
          stat: m.stat, label: m.label, pct: pct, value: value,
          reason: e.reason, ok: e.ok, scopeLabel: scopeLabel(m.scope), text: m.text,
          rarity: m.rarity, category: m.category
        };
        if (!e.ok) { inactive.push(rec); return; }
        if (!acc[m.stat]) return;
        if (pct) acc[m.stat].pct += value;
        else acc[m.stat].flat += value;
        acc[m.stat].list.push(rec);
      } else if (m.bucket === 'combat') {
        // 战斗类也要看作用域：146「所有【近卫】攻击后回 2 技力」不该出现在狙击卡的明细里
        if (m.scope && m.scope.base !== 'enemy' && !scopeCovers(m.scope, op)) return;
        var e2 = R.evalCond(m.cond, Object.assign({}, ctx, { stack: m.stack, relicStacks: m.relicStacks || ctx.relicStacks, relics: m.relics || ctx.relics }));
        var v2 = m.value * (e2.factor || 1);
        combat.push({
          relicId: m.relicId, relicName: m.relicName, stat: m.stat, label: m.label,
          pct: m.pct, value: v2, enemy: m.scope && m.scope.base === 'enemy', group: m.group,
          scopeLabel: scopeLabel(m.scope), ok: e2.ok, reason: e2.reason, text: m.text
        });
        // 战斗类条目不在 acc 里，条件不满足时明细区根本看不到它（152 默认 0 名术师
        // 时效果会凭空消失）。补一条 inactive，与面板类一样能回答「为什么没生效」。
        if (!e2.ok) {
          inactive.push({
            relicId: m.relicId, relicName: m.relicName, stageName: m.stageName,
            stat: m.stat, label: m.label, pct: m.pct, value: v2,
            reason: e2.reason, ok: false, scopeLabel: scopeLabel(m.scope), text: m.text,
            rarity: m.rarity, category: m.category
          });
        }
      }
    });

    var base = op.panel;
    var final = {};
    var delta = {};

    ['hp', 'atk', 'def'].forEach(function (k) {
      var b = +base[k] || 0;
      var v = Math.floor((b + acc[k].flat) * (1 + acc[k].pct / 100));
      final[k] = v;
      delta[k] = v - b;
    });

    var resB = +base.res || 0;
    var resV = resB + acc.res.flat + Math.round(resB * acc.res.pct / 100);
    final.res = Math.max(0, Math.min(100, Math.round(resV)));
    delta.res = final.res - resB;

    var aspdB = +base.aspd || 100;
    final.aspd = Math.round(aspdB + acc.aspd.flat + aspdB * acc.aspd.pct / 100);
    delta.aspd = final.aspd - aspdB;

    var blockB = +base.block || 0;
    final.block = Math.max(0, Math.round(blockB + acc.block.flat + blockB * acc.block.pct / 100));
    delta.block = final.block - blockB;

    var costB = +base.cost || 0;
    final.cost = Math.max(0, Math.floor((costB + acc.cost.flat) * (1 + acc.cost.pct / 100)));
    delta.cost = final.cost - costB;

    var redeployB = +base.redeploy || 0;
    final.redeploy = Math.max(0, Math.floor((redeployB + acc.redeploy.flat) * (1 + acc.redeploy.pct / 100)));
    delta.redeploy = final.redeploy - redeployB;

    var spRecB = +base.spRecover || 1;
    final.spRecover = +(spRecB + acc.spRecover.flat + spRecB * acc.spRecover.pct / 100).toFixed(2);
    delta.spRecover = +(final.spRecover - spRecB).toFixed(2);

    var initB = +base.initSp || 0;
    final.initSp = Math.round(initB + acc.initSp.flat);
    delta.initSp = final.initSp - initB;

    var intervalB = +base.interval || 0;
    var denom = 100 + (final.aspd - 100);
    if (intervalB > 0 && denom > 0) {
      final.interval = +(intervalB * 100 / denom).toFixed(3);
    } else {
      // 攻速被压到 0 时公式会除零得 Infinity；此时攻击间隔无意义，记 0 并在明细留痕
      final.interval = 0;
      if (intervalB > 0) {
        acc.interval.list.push({
          relicId: '', relicName: '（系统）', stageName: '',
          stat: 'interval', label: S.labelOf('interval'), pct: false, value: 0,
          reason: '攻速修正后攻击间隔无法计算（分母为 0）', ok: false,
          scopeLabel: '全体我方', text: ''
        });
      }
    }
    delta.interval = +(final.interval - intervalB).toFixed(3);

    return {
      op: op,
      base: base,
      final: final,
      delta: delta,
      acc: acc,
      combat: combat,
      inactive: inactive,
      unapplied: unapplied
    };
  }

  // 队伍 / 探索层汇总：不针对具体干员，只看「选了这些藏品一共给了什么」
  // 返回 { panel, combat, run, special, unapplied }，四类互斥：
  // 旧实现把 panel 和 run 塞进同一个对象，UI 上「可携带干员/希望/源石锭」
  // 会同时出现在「面板加成」和「探索/运营」两张卡片里。
  function summarize(mods, ctx) {
    var panel = {};   // stat -> {flat, pct, items}
    var combat = {};
    var run = {};
    var special = [];
    var unapplied = [];

    S.SETTLED_KEYS.forEach(function (k) { panel[k] = { flat: 0, pct: 0, items: [] }; });

    mods.forEach(function (m) {
      if (m.bucket === 'special') { special.push(m); return; }
      var e = R.evalCond(m.cond, Object.assign({}, ctx, { stack: m.stack, relicStacks: m.relicStacks || ctx.relicStacks, relics: m.relics || ctx.relics }));
      var factor = e.factor || 1;
      var value = m.value * factor;

      if (S.settles(m.stat) === false) {
        unapplied.push({
          relicId: m.relicId, relicName: m.relicName, stageName: m.stageName,
          stat: m.stat, label: m.label, value: value, pct: m.pct,
          reason: '该属性无法落到干员面板（数据表无对应字段）',
          scope: scopeLabel(m.scope), ok: e.ok, text: m.text, rarity: m.rarity
        });
        return;
      }

      // 「面板类属性、但作用对象是敌方」的项（208 的「敌人生命-40%」）改投战斗卡：
      // 它不会落到任何干员面板上（scopeCovers 对 enemy 直接返回 false），
      // 塞进 panel 只会让 UI 渲染成「生命（敌方）-40%」这种分类错位。
      var enemyPanel = m.bucket === 'panel' && m.scope && m.scope.base === 'enemy';

      if ((m.bucket === 'panel' && !enemyPanel) || m.bucket === 'run') {
        var target = m.bucket === 'run' ? run : panel;
        var rec = target[m.stat] || (target[m.stat] = { flat: 0, pct: 0, items: [] });
        rec.items.push({
          relicId: m.relicId, relicName: m.relicName, stageName: m.stageName,
          value: value, pct: m.pct, scope: scopeLabel(m.scope), ok: e.ok,
          reason: e.reason, text: m.text, rarity: m.rarity
        });
        if (!e.ok) return;
        if (m.pct) rec.pct += value; else rec.flat += value;
      } else if (m.bucket === 'combat' || m.bucket === 'enemy' || enemyPanel) {
        var c = combat[m.stat] || (combat[m.stat] = { value: 0, items: [] });
        c.items.push({
          relicId: m.relicId, relicName: m.relicName, value: value, pct: m.pct,
          // 属性名本身已经带「敌人」前缀（enemyHp 等）时不再追加「（对敌）」，
          // 否则会渲染成「敌人生命（对敌）」。
          enemy: !!(m.scope && m.scope.base === 'enemy') && !/^enemy/.test(m.stat),
          group: m.group,
          scope: scopeLabel(m.scope),
          ok: e.ok, reason: e.reason, text: m.text
        });
        if (e.ok) c.value += value;
      }
    });

    return { panel: panel, combat: combat, run: run, special: special, unapplied: unapplied };
  }

  // -------------------------------------------------------------------------
  // 伤害估算（官方公式）
  // -------------------------------------------------------------------------
  // 明日方舟的伤害结算顺序：
  //   物理：max(攻击力×倍率 − 防御力, 攻击力×倍率×5%)
  //   法术：max(攻击力×倍率×(1 − 法抗/100), 攻击力×倍率×5%)
  //   真实：攻击力×倍率
  // 之后统一乘「造成伤害提升 + 敌人脆弱 + 对应伤害类型易伤」。
  // 无视防御按百分比折减防御力（178 残弩-新典训：无视 50%）。
  function sumStat(mods, stat, ctx, op) {
    var total = 0;
    (mods || []).forEach(function (m) {
      if (m.stat !== stat) return;
      // 指定干员 / 职业作用域的修正项只对得上的干员生效；
      // 没传 op 时（队伍级估算）跳过 assign，避免把「指定一人」算成全队。
      if (m.scope && m.scope.assign && !op) return;
      if (op && m.scope && !scopeCovers(m.scope, op)) return;
      var e = R.evalCond(m.cond, Object.assign({}, ctx, { stack: m.stack, relicStacks: m.relicStacks || ctx.relicStacks, relics: m.relics || ctx.relics }));
      if (!e.ok) return;
      total += m.value * (e.factor || 1);
    });
    return total;
  }

  function estimateDamage(input, mods, ctx, op) {
    ctx = ctx || {};
    input = input || {};
    var atk = Math.max(0, +input.atk || 0);
    var scale = +input.scale > 0 ? +input.scale : 1;
    var raw = atk * scale;

    var dealt = sumStat(mods, 'dmgReduce', ctx, op);        // 造成伤害提升
    var weak = sumStat(mods, 'weak', ctx, op);              // 敌人脆弱
    var defIgnore = Math.min(100, Math.max(0, sumStat(mods, 'defIgnore', ctx, op)));
    var physTaken = sumStat(mods, 'physTaken', ctx, op);
    var magicTaken = sumStat(mods, 'magicTaken', ctx, op);
    var trueTaken = sumStat(mods, 'trueTaken', ctx, op);

    var enemyDef = Math.max(0, +input.def || 0);
    var effDef = enemyDef * (1 - defIgnore / 100);
    var enemyRes = Math.min(100, Math.max(0, +input.res || 0));

    var physBase = Math.max(raw - effDef, raw * 0.05);
    var magicBase = Math.max(raw * (1 - enemyRes / 100), raw * 0.05);

    var bonusPhys = dealt + weak + physTaken;
    var bonusMagic = dealt + weak + magicTaken;
    var bonusTrue = dealt + weak + trueTaken;

    return {
      raw: raw,
      phys: Math.round(physBase * (1 + bonusPhys / 100) * 10) / 10,
      magic: Math.round(magicBase * (1 + bonusMagic / 100) * 10) / 10,
      trueDmg: Math.round(raw * (1 + bonusTrue / 100) * 10) / 10,
      detail: {
        atk: atk, scale: scale, raw: Math.round(raw * 10) / 10,
        enemyDef: enemyDef, effDef: Math.round(effDef * 10) / 10, defIgnore: defIgnore,
        enemyRes: enemyRes, dealt: dealt, weak: weak,
        physTaken: physTaken, magicTaken: magicTaken, trueTaken: trueTaken,
        bonusPhys: Math.round(bonusPhys * 10) / 10,
        bonusMagic: Math.round(bonusMagic * 10) / 10,
        bonusTrue: Math.round(bonusTrue * 10) / 10
      }
    };
  }

  global.RelicEngine = {
    effectTextFor: effectTextFor,
    tierLabels: tierLabels,
    stackCap: stackCap,
    maxStackOf: maxStackOf,
    parseRelic: parseRelic,
    buildModifiers: buildModifiers,
    computeOperator: computeOperator,
    summarize: summarize,
    estimateDamage: estimateDamage,
    sumStat: sumStat,
    scopeCovers: scopeCovers,
    scopeLabel: scopeLabel,
    normalizePhase: normalizePhase,
    PANEL_KEYS: PANEL_KEYS
  };
})(typeof window !== 'undefined' ? window : globalThis);
