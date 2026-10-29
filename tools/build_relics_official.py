# -*- coding: utf-8 -*-
"""用官方游戏数据（roguelike_topic_table.json）重建藏品效果。

为什么这么做：官方藏品条目里带着结构化的 buffs / blackboard（属性字段、倍率、职业选择器、
命名 buff id），比从中文文案里正则抠数字可靠得多。例如：

    rogue_6_relic_legacy_66  折戟-锋刃
    buffs = [{key:"char_attribute_mul",
              blackboard:[{key:"selector.profession", valueStr:"warrior"}, {key:"atk", value:0.25}]}]
    → 近卫 攻击力 +25%

转换规则是一张显式表（STAT_MAP / named_rule / OVERRIDES），而不是猜中文；
表格覆盖不到的（战术道具、节点事件、随机产出等）不在数据里编造数值，
由界面用官方 usage 文案原样列进「特殊效果」。

输入：
  raw/roguelike_topic_table.json   details.rogue_6.{relics,items}
  data/relics_wiki.json            PRTS 文案与元数据（分类/稀有度/描述/条件/备注/四阶段文案）
输出：
  data/relics.json（v2：stages[].mods 来自官方 buffs；parsed_by 标明来源）
  浏览器不再直接读这份 JSON —— 它先由 tools/build_db.py 拆成
  relics / relic_stages 两张表装进 data/is6db.js。加 --legacy-js 可额外
  吐一份 window.RELIC_DATA 的旧格式文件，仅供调试比对。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
DATA = os.path.join(ROOT, "data")

STAGE_SUFFIX = [("", "结构化"), ("_a", "半结构化"), ("_b", "非结构化"), ("_c", "混沌化")]

PROF_MAP = {
    "pioneer": "先锋", "warrior": "近卫", "tank": "重装", "sniper": "狙击",
    "caster": "术师", "medic": "医疗", "support": "辅助", "special": "特种",
    "PIONEER": "先锋", "WARRIOR": "近卫", "TANK": "重装", "SNIPER": "狙击",
    "CASTER": "术师", "MEDIC": "医疗", "SUPPORT": "辅助", "SPECIAL": "特种",
}

# 官方 subProfessionId → 中文分支名。
# 这张表不是手写的：由 raw/character_table.json 的 subProfessionId 与
# raw/branch_map.json 的中文分支名按角色反查、取众数得到（见 tools/ 里的推导脚本）。
# 手写版曾把 fighter 记成「武者」（实为斗士）、closerange 记成「散射手」（实为重射手）、
# wandermedic 记成「疗养师」（实为行医），并且完全缺 musha / shotprotector / reaperrange /
# skybreaker —— 结果是 `selector.sub_profession` 限定的藏品要么挂错分支，要么一个分支都不命中。
SUBPROF_MAP = {
    "pioneer": "尖兵", "charger": "冲锋手", "counsellor": "策士", "tactician": "战术家", "bearer": "执旗手",
    "agent": "情报官", "fearless": "无畏者", "musha": "武者", "artsfghter": "术战者", "sword": "剑豪",
    "fighter": "斗士", "reaper": "收割者", "instructor": "教官", "lord": "领主", "primguard": "本源近卫",
    "hammer": "撼地者", "crusher": "重剑手", "centurion": "强攻手", "librator": "解放者", "mercenary": "佣兵",
    "protector": "铁卫", "shotprotector": "哨戒铁卫", "unyield": "不屈者", "guardian": "守护者", "duelist": "决战者",
    "artsprotector": "驭法铁卫", "primprotector": "本源铁卫", "fortress": "要塞", "fastshot": "速射手", "longrange": "神射手",
    "aoesniper": "炮手", "reaperrange": "散射手", "siegesniper": "攻城手", "closerange": "重射手", "hunter": "猎手",
    "loopshooter": "回环射手", "bombarder": "投掷手", "corecaster": "中坚术师", "splashcaster": "扩散术师", "blastcaster": "轰击术师",
    "chain": "链术师", "mystic": "秘术师", "funnel": "驭械术师", "phalanx": "阵法术师", "primcaster": "本源术师",
    "soulcaster": "塑灵术师", "physician": "医师", "ringhealer": "群愈师", "healer": "疗养师", "wandermedic": "行医",
    "incantationmedic": "咒愈师", "chainhealer": "链愈师", "slower": "凝滞师", "summoner": "召唤师", "bard": "吟游者",
    "craftsman": "工匠", "blessing": "护佑者", "underminer": "削弱者", "supportiveranger": "游击手", "ritualist": "巫役",
    "executor": "处决者", "stalker": "伏击客", "merchant": "行商", "hookmaster": "钩索师", "pusher": "推击手",
    "geek": "怪杰", "dollkeeper": "傀儡师", "traper": "陷阱师", "alchemist": "炼金师", "skywalker": "巡空者",
    "skybreaker": "裂空炮手", "watchman": "守望者",
}

BUILDABLE_MAP = {"melee": "MELEE", "ranged": "RANGED"}

# 属性字段 → (统计 key, 分类)
# 只登记「能直接落到某个统计项」的字段；倍率语义的（damage_scale / atk_scale 等）
# 在 named_rule 里按 buff 名单独换算，因为同样是 damage_scale，
# 「造成伤害提升」和「敌人受到的元素伤害提升」方向完全相反。
STAT_MAP = {
    "atk": ("atk", "panel"),
    "def": ("def", "panel"),
    "max_hp": ("hp", "panel"),
    "attack_speed": ("aspd", "panel"),
    "cost": ("cost", "panel"),
    "block_cnt": ("block", "panel"),
    "magic_resistance": ("res", "panel"),
    "respawn_time": ("redeploy", "panel"),
    "sp_recovery_per_sec": ("spRecover", "panel"),
    "init_sp": ("initSp", "panel"),
    # 不登记裸 "sp" 字段：官方 blackboard 里的 sp 有「回技力 / 技力上限 / 需求」多种语义，
    # 统一由 named_rule 按 buff 命名分派（spOnAttack / spOnKill / spOnSkillEnd / initSp）。
    # 旧映射 ("sp", "panel") 与 core/schema.js 里 sp 的 run 分类冲突，命中即错桶。
    "hp_recovery_per_sec": ("hpRegen", "combat"),
    "hp_recovery_per_sec_by_max_hp_ratio": ("hpRegenPct", "combat"),
    "heal_scale": ("heal", "combat"),
    # damage_scale = 造成伤害的倍率 → dmgReduce（造成伤害提升）。
    # 旧值 dmgDealt 从来没在 core/schema.js 注册过，命中一次就会被引擎静默丢弃。
    "damage_scale": ("dmgReduce", "combat"),
    "atk_scale": ("atkScale", "combat"),
    "damage": ("damage", "combat"),
    # damage_resistance 是「受到的伤害降低」，不是「造成的伤害提升」，
    # 旧映射写成 dmgReduce 会把减伤渲染成增伤。统一在 named_rule 里取负号。
    "ep_damage_resistance": ("elementalRes", "combat"),
    "ep_damage_scale": ("elemental", "combat"),
    "mass_level": ("weight", "combat"),
    "move_speed": ("moveSpeed", "combat"),
    "one_minus_status_resistance": ("statusTime", "combat"),
}

REWARD_MAP = {
    "rogue_6_squad_capacity": ("carry", "run"),
    "rogue_6_population": ("hope", "run"),   # 游戏内部 id 叫 population，实际是「希望」
    "rogue_6_hpmax": ("targetHpMax", "run"),
    "rogue_6_hp": ("targetHp", "run"),
    "rogue_6_gold": ("ingot", "run"),
    "rogue_6_shield": ("shield", "run"),
    "rogue_6_exp": ("exp", "run"),
    "rogue_6_ap": ("ap", "run"),
    "rogue_6_max_weight": ("maxWeight", "run"),
}

RES_MAP = {"rogue_6_gold": "ingots", "rogue_6_shield": "shield"}


def load():
    with open(os.path.join(RAW, "roguelike_topic_table.json"), encoding="utf-8") as f:
        top = json.load(f)
    r6 = top["details"]["rogue_6"]
    with open(os.path.join(DATA, "relics_wiki.json"), encoding="utf-8") as f:
        wiki = json.load(f)
    return r6["relics"], r6["items"], wiki


def bb(buff):
    vals, strs = {}, {}
    for e in buff.get("blackboard") or []:
        k = e.get("key")
        if e.get("valueStr") is not None:
            strs[k] = e["valueStr"]
        else:
            vals[k] = e.get("value")
    return vals, strs


def scope_from(strs):
    scope = {"all": True}
    if "selector.profession" in strs:
        items = [x for x in strs["selector.profession"].split("|") if x]
        profs = [PROF_MAP[x] for x in items if x in PROF_MAP]
        if profs:
            scope = {"professions": profs}
        elif "token" in items:
            scope = {"summon": True}
    if "selector.sub_profession" in strs:
        # 认不出的 subProfessionId 必须丢掉，不能原样留着：
        # 留着的话 scope.subProfs 里会混进 "musha" 这种 id，
        # engine.scopeCovers 拿它跟干员的中文分支名比，永远不相等，
        # 于是这条修正在界面上「已解析」却谁也不生效。
        subs = []
        for x in strs["selector.sub_profession"].split("|"):
            cn = SUBPROF_MAP.get(x.strip())
            if cn:
                subs.append(cn)
        if subs:
            scope = {"subProfs": subs}
    if "selector.buildable" in strs:
        pos = BUILDABLE_MAP.get(strs["selector.buildable"])
        if pos:
            scope["positions"] = [pos]
    if "selector.enemy" in strs or "selector.enemy_level_type" in strs or "selector.side" in strs:
        scope = {"base": "enemy"}
    return scope


def layer_cap(buffs):
    for b in buffs:
        if b["key"].startswith("layer_") or b["key"] in ("layer_after_battle_data",):
            vals, _ = bb(b)
            if "max" in vals:
                return vals["max"]
    return None


# ---------------- 命名 buff（global_buff_normal / char_ability_new 等）----------------
# 官方 buff 的语义只写在 `blackboard` 里 name == "key" 的那个字符串上，
# 同一个 `global_buff_normal` 外壳可以是闪避、是脆弱、是屏障，也可以是给屏障加伤。
# 因此这里按「buff 命名 id」而不是按「外壳 key」分派。

ENEMY = {"base": "enemy"}

# IS6 的四种元素损伤，官方 buff 名里用 [dark] / [fire] / [sanity] / [water] 标记。
ELEMENT_NAMES = {"dark": "凋亡", "fire": "灼燃", "sanity": "神经", "water": "侵蚀"}


def _cond_early(sec, label):
    return {"type": "early", "sec": sec, "label": label}


def _cond_after(sec, label):
    return {"type": "after", "sec": sec, "label": label}


def _cond_skill(sec=0):
    return {"type": "skillWindow", "sec": sec,
            "label": ("技能开启后%d秒内" % round(sec)) if sec else "技能开启时"}


def _cond_stack(label, cap):
    c = {"type": "perStack", "label": label}
    if cap:
        c["cap"] = int(cap) if float(cap).is_integer() else cap
    return c


def _cond_hp_below(pct, label):
    return {"type": "hpBelow", "pct": pct, "label": label}


def _cond_hp_above(pct, label):
    return {"type": "hpAbove", "pct": pct, "label": label}


def _cond_proc(label):
    # 触发类（击倒/闪避/被击倒）：界面上的「触发类效果生效」开关决定，默认不生效。
    return {"type": "proc", "label": label}


def _cond_always(label):
    # 条件无法用现有开关表达（按距离/按库存空位…）：如实标注，按「已满足」计入。
    return {"type": "capLayer", "label": label}


def _cond_per_ally(label):
    return {"type": "perAlly", "label": label}


def _cond_per_res(res, per, label, cap=None):
    cond = {"type": "perResource", "res": res, "per": per, "label": label}
    if cap:
        cond["cap"] = cap
    return cond


def _cond_has_relic(relic_id, label):
    return {"type": "hasRelic", "relicId": relic_id, "label": label}


def _cond_per_relic_stack(relic_id, label, cap=None):
    cond = {"type": "perRelicStack", "relicId": relic_id, "label": label}
    if cap:
        cond["cap"] = cap
    return cond


def _cond_all(conds, label=None):
    conds = [c for c in conds if c]
    if not label:
        label = "，".join(c.get("label", "") for c in conds)
    return {"type": "all", "of": conds, "label": label}


def named_rule(name, vals, strs, scope):
    """按 buff 的命名 id 决定语义。返回 mods 列表（空列表 = 交给 special 展示）。"""
    out = []

    def add(stat, bucket, pct, value, sc=None, cond=None, group=None):
        if value is None:
            return
        # 0 值是官方数据里的「占位」（rogue_2_attr_up[limited] 的 atk=0.0），
        # 留着会在汇总区渲染出「攻击力 +0%」。
        if abs(float(value)) < 1e-9:
            return
        item = {"stat": stat, "bucket": bucket, "pct": bool(pct),
                "value": round(float(value), 4), "scope": sc or scope, "cond": cond}
        # group 是「互斥分支」的标签：同一件藏品把同一种效果按元素/分支写了多条，
        # 界面上要分行显示而不是求和（134 的四种元素损伤爆发倍率互不相加）。
        if group:
            item["group"] = group
        out.append(item)

    enemy = ENEMY

    # ---------------- 闪避 ----------------
    # 官方用 evade[physical] / evade[magical] / evade[non_pure] 三个命名区分闪避类型，
    # 值在 prob 里（0.15 = 15%）。这三条以前整条落进「特殊效果」。
    evade_stat = {"evade[physical]": "dodgePhys",
                  "evade[magical]": "dodgeMagic",
                  "evade[non_pure]": "dodgeAll"}
    if name in evade_stat:
        if "prob" in vals:
            add(evade_stat[name], "combat", True, vals["prob"] * 100)
        return out

    # ---------------- 技力 ----------------
    if name.startswith("modify_sp["):
        tag = name[len("modify_sp["):-1]
        if "sp" in vals:
            if tag == "born":
                add("initSp", "panel", False, vals["sp"])
            else:
                # attack_or_damage / warrior / take_damage / take_ep_damage
                # 都是「攻击或受击时回技力」，统一进 spOnAttack。
                add("spOnAttack", "combat", False, vals["sp"])
        return out

    if name.startswith("modify_sp_recover") and "sp_recovery_per_sec" in vals:
        add("spRecover", "panel", False, vals["sp_recovery_per_sec"])
        return out

    if name in ("rogue_6_sp_skill_end", "rogue_6_caster_book_2") and "sp" in vals:
        add("spOnSkillEnd", "combat", False, vals["sp"])
        return out

    if name == "rogue_6_char_kill_target[sp]" and "sp" in vals:
        add("spOnKill", "combat", False, vals["sp"])
        return out

    if name == "rogue_6_char_kill_target[hp]" and "hp_ratio" in vals:
        add("hpOnKill", "combat", True, vals["hp_ratio"] * 100)
        return out

    if name == "rogue_6_char_kill_target[attack_speed]" and "attack_speed" in vals:
        add("aspd", "panel", False, vals["attack_speed"], None, _cond_proc("击倒敌人时"))
        return out

    # ---------------- 元素伤害 / 脆弱 ----------------
    # damage_scale 是「倍率」，2.0 = 提升至 200% = +100%。
    if name == "enemy_take_element_damage_up[fix]":
        if "damage_scale" in vals:
            add("elemental", "combat", True, (vals["damage_scale"] - 1) * 100, enemy)
        return out

    if name.startswith("enemy_damage_scale"):
        if "ep_damage_scale" in vals:
            add("elemental", "combat", True, (vals["ep_damage_scale"] - 1) * 100, enemy)
        elif "damage_scale" in vals:
            v = vals["damage_scale"]
            stat = ("physTaken" if "[phy]" in name
                    else "magicTaken" if "[mag]" in name else "trueTaken")
            add(stat, "combat", True, (v - 1) * 100, enemy)
        return out

    if name.startswith("enemy_weak"):
        if "damage_scale" in vals:
            add("weak", "combat", True, (vals["damage_scale"] - 1) * 100, enemy)
        return out

    if name.startswith("rogue_6_enemy_ep_break_fix"):
        # 凋亡/灼燃/神经/侵蚀损伤的「爆发效果增强」：倍率作用在元素伤害上，
        # 附带的能力值削减分别落在敌人法抗 / 防御上。
        # 四种元素互斥（同一个敌人只吃自己那一种），必须带 group 分行显示：
        # 否则汇总卡会把 150% / 280% / 100% 加成「元素伤害/损伤 +530%」。
        tag = name[name.index("[") + 1:-1] if "[" in name else ""
        group = ELEMENT_NAMES.get(tag, tag or None)
        if "damage_scale" in vals:
            add("elemental", "combat", True, (vals["damage_scale"] - 1) * 100, enemy, group=group)
        if "magic_resistance" in vals:
            add("enemyRes", "enemy", False, vals["magic_resistance"], enemy, group=group)
        if "def" in vals:
            add("enemyDef", "enemy", False, vals["def"], enemy, group=group)
        if "damage" in vals:
            add("damage", "combat", False, vals["damage"], enemy, group=group)
        return out

    if name == "element_resistance" and "ep_damage_resistance" in vals:
        add("elementalRes", "combat", True, vals["ep_damage_resistance"] * 100)
        return out

    # ---------------- 伤害倍率 ----------------
    if name == "rogue_6_char_shield_damage_scale" and "damage_scale" in vals:
        add("dmgReduce", "combat", True, (vals["damage_scale"] - 1) * 100, None,
            {"type": "hasShield", "label": "拥有屏障时"})
        return out

    if name == "rogue_6_damage_scale_in_range" and "damage_scale" in vals:
        add("dmgReduce", "combat", True, (vals["damage_scale"] - 1) * 100)
        return out

    if name in ("rogue_1_damage_scale_by_distance", "rogue_6_damage_scale_by_distance"):
        if "damage_scale" in vals:
            add("dmgReduce", "combat", True, vals["damage_scale"] * 100, None,
                _cond_always("按距离最高"))
        return out

    if name == "rogue_6_char_first_damage" and "damage_scale" in vals:
        add("firstHit", "combat", True, (vals["damage_scale"] - 1) * 100)
        return out

    if name == "rogue_6_enemy_blocked_damage_scale" and "damage_resistance" in vals:
        # 减伤方向：damage_resistance=0.3 是「受到的伤害 -30%」，
        # 直接照搬会变成「受到伤害 +30%」。
        add("dmgTakenReduce", "combat", True, -vals["damage_resistance"] * 100, None,
            _cond_always("被阻挡的敌人"))
        return out

    if name == "rogue_2_enroll_3_difficulty_18" and "damage_resistance" in vals:
        # 「精英和领袖敌人登场30秒内受到的物理和法术伤害-50%」：
        # 这条 damage_resistance 挂在敌人身上，是「敌人受到」而不是「我方受到」，
        # 所以走 physTaken / magicTaken，不能走 dmgTakenReduce（那是我方受伤）。
        cond = _cond_early(vals.get("duration", 30), "精英/领袖登场30秒内")
        for stat in ("physTaken", "magicTaken"):
            add(stat, "combat", True, -vals["damage_resistance"] * 100, enemy, cond)
        return out

    # ---------------- 攻击 / 防御 / 攻速 ----------------
    if name == "atk_up_on_skill_start" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None,
            _cond_skill(vals.get("duration", 0)))
        return out

    if name == "atk_up_on_skill_start[stacked]" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None,
            _cond_stack("每次使用技能", vals.get("max_stack_cnt")))
        return out

    if name == "atk_up_when_atk_in_ammo_skill_state" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None,
            _cond_stack("弹药类技能中每次造成伤害", vals.get("max_stack_cnt")))
        return out

    if name == "rogue_1_attack_up_after_skill" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None,
            _cond_stack("技能未开启时每秒", vals.get("max_stack_cnt")))
        return out

    if name == "ammo_skill_start_attri_up" and "attack_speed" in vals:
        add("aspd", "panel", False, vals["attack_speed"], None,
            _cond_skill(vals.get("duration", 0)))
        return out

    if name == "rogue_5_attr_up[evade]":
        if "attack_speed" in vals:
            add("aspd", "panel", False, vals["attack_speed"], None, _cond_proc("闪避后15秒内"))
        return out

    if name == "rogue_2_attr_up_2[evade]":
        if "atk" in vals:
            add("atk", "panel", True, vals["atk"] * 100, None, _cond_proc("闪避后15秒内"))
        return out

    if name == "rogue_2_attr_up[limited]":
        cond = _cond_early(vals.get("duration", 0),
                           "部署后%d秒内" % round(vals.get("duration", 0)))
        for f in ("atk", "def", "max_hp"):
            if vals.get(f):
                stat, bucket = STAT_MAP[f]
                add(stat, bucket, True, vals[f] * 100, None, cond)
        if vals.get("attack_speed"):
            add("aspd", "panel", False, vals["attack_speed"], None, cond)
        return out

    if name == "rogue_3_increaseMaxHPWhenHavingShield" and "max_hp" in vals:
        add("hp", "panel", True, vals["max_hp"] * 100, None,
            {"type": "hasShield", "label": "拥有护盾值时"})
        return out

    if name == "rogue_6_relic_after_play_time":
        cond = _cond_early(vals.get("time", 0),
                           "战斗开始%d秒内" % round(vals.get("time", 0)))
        for f in ("atk", "def"):
            if vals.get(f):
                add(f, "panel", True, vals[f] * 100, None, cond)
        return out

    if name == "rogue_6_tank_book":
        # 「部署时和技能结束后攻击力和最大生命+100%，加成在60秒内递减」
        # 递减过程无法逐帧建模，按「全额、限时」处理并标注条件。
        cond = _cond_early(vals.get("duration", 0),
                           "部署/技能结束后%d秒内" % round(vals.get("duration", 0)))
        if vals.get("atk"):
            add("atk", "panel", True, vals["atk"] * 100, None, cond)
        if vals.get("max_hp"):
            add("hp", "panel", True, vals["max_hp"] * 100, None, cond)
        return out

    if name == "rogue_6_sniper_book" and vals.get("atk"):
        # 后半句「每3秒获得3点技力」以持有【残弩-神准】为前提，
        # 不建模跨藏品前置，只量化无条件生效的攻击力部分。
        add("atk", "panel", True, vals["atk"] * 100, None,
            _cond_skill(vals.get("duration", 0)))
        return out

    if name == "rogue_6_caster_book" and vals.get("sp"):
        # 「每对一个单位造成伤害就回复2点技力值」；atk 部分以持有【断杖-同调】为前提，略去。
        add("spOnAttack", "combat", False, vals["sp"])
        return out

    if name == "rogue_3_rangedATKUp" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None, _cond_per_ally("周围4格每名干员"))
        return out

    if name == "rogue_2_atk_up_in_range" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100)
        return out

    if name == "rogue_6_char_invisible_aura" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100)
        return out

    if name == "rogue_6_fly_aura" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None, _cond_per_ally("每名起飞单位"))
        return out

    if name == "rogue_6_land_aura" and "def" in vals:
        add("def", "panel", True, vals["def"] * 100, None, _cond_per_ally("每名未起飞单位"))
        return out

    if name == "rogue_4_finalDefense[end_tile]":
        if vals.get("max_hp"):
            add("hp", "panel", True, vals["max_hp"] * 100)
        if vals.get("block_cnt"):
            add("block", "panel", False, vals["block_cnt"])
        return out

    if name == "rogue_6_relic_inventory":
        cond = _cond_per_res("parts", 1, "每1零件")
        if vals.get("atk"):
            add("atk", "panel", True, vals["atk"] * 100, None, cond)
        if vals.get("max_hp"):
            add("hp", "panel", True, vals["max_hp"] * 100, None, cond)
        return out

    if name == "rogue_6_relic_inventory_value" and vals.get("max_hp"):
        per = vals.get("value", 5)
        cap = vals.get("cnt_max")
        label = "每%s点估值" % round(per)
        if cap:
            label += "（最多 %d 档 / +%g%%）" % (cap, vals["max_hp"] * 100 * cap)
        add("hp", "panel", True, vals["max_hp"] * 100, None, _cond_per_res("value", per, label, cap))
        return out

    if name == "rogue_6_relic_inventory_cost" and "value" in vals:
        add("cost", "panel", False, vals["value"], None, _cond_always("零件箱空栏≥4"))
        return out

    if name == "rogue_6_medic_book_2" and "block_cnt" in vals:
        add("block", "panel", False, vals["block_cnt"])
        return out

    if name == "rogue_6_char_skill_add_cost" and "cost" in vals:
        # 「开启技能立刻获得 3 点部署费用」是回费，不是把干员部署费用抬高 3 费。
        add("dpOnSkill", "run", False, vals["cost"], None, _cond_skill(0))
        return out

    if name == "rogue_6_warrior_book_2" and "prob" in vals:
        # 「受到攻击范围外敌人的攻击时有 75% 概率闪避」—— 概率闪避，进 dodgeAll。
        add("dodgeAll", "combat", True, vals["prob"] * 100)
        return out

    if name == "rogue_6_sniper_book_2" and "atk_scale" in vals:
        # 「攻击力提升至140%」= 攻击力 +40%，落在面板攻击力上；
        # 记成 atkScale 会和文案解析出的「攻击力 140%（提升至）」各记一条。
        add("atk", "panel", True, (vals["atk_scale"] - 1) * 100)
        return out

    if name.startswith("passive_hp_ratio_to_attr_add[atk]"):
        cond = _cond_hp_below(round(vals.get("min_hp_ratio", 0) * 100),
                              "生命≤%d%%时" % round(vals.get("min_hp_ratio", 0) * 100))
        if vals.get("min_atk"):
            add("atk", "panel", True, vals["min_atk"] * 100, None, cond)
        return out

    if name == "rogue_2_hp_ratio_to_attr_add[attack_speed]":
        cond = _cond_hp_below(round(vals.get("min_hp_ratio", 0) * 100),
                              "生命≤%d%%时" % round(vals.get("min_hp_ratio", 0) * 100))
        if vals.get("min_attack_speed"):
            add("aspd", "panel", False, vals["min_attack_speed"], None, cond)
        return out

    if name == "rogue_6_hp_ratio_to_attr_add[sp_recover]":
        cond = _cond_hp_below(round(vals.get("min_hp_ratio", 0) * 100),
                              "生命≤%d%%时" % round(vals.get("min_hp_ratio", 0) * 100))
        if vals.get("min_sp_recovery_per_sec"):
            add("spRecover", "panel", False, vals["min_sp_recovery_per_sec"], None, cond)
        return out

    if name == "AtkUp[BlockJustOne]" and "atk" in vals:
        add("atk", "panel", True, vals["atk"] * 100, None,
            {"type": "blockOnly", "n": 1, "label": "仅阻挡1名敌人"})
        return out

    if name == "rogue_2_projectile_on_killed[stun]" and "stun" in vals:
        add("stun", "combat", False, vals["stun"], None, _cond_proc("被击倒时"))
        return out

    if name == "rogue_3_levitate[whenManulSkill]" and "levitate_duration" in vals:
        add("levitate", "combat", False, vals["levitate_duration"], enemy, _cond_skill(0))
        return out

    if name == "stun_on_reach_exit" and "stun" in vals:
        add("stun", "combat", False, vals["stun"], enemy)
        return out

    if name == "damage_on_reach_exit" and "damage" in vals:
        add("damage", "combat", False, vals["damage"], enemy)
        return out

    if name.startswith("periodic_damage"):
        if "damage" in vals:
            add("damage", "combat", False, vals["damage"], enemy,
                _cond_always("敌人处于晕眩/冻结/束缚时每秒"))
        return out

    if name.startswith("enemy_get_damage"):
        if "value" in vals:
            add("damage", "combat", False, vals["value"], enemy,
                _cond_always("敌人进入/解除浮空时"))
        return out

    if name.startswith("enemy_silence"):
        if "silence" in vals:
            add("silence", "combat", False, vals["silence"], enemy)
        return out

    # ---------------- 屏障 ----------------
    if name == "rogue_6_char_first_shield":
        if vals.get("scale"):
            add("shieldPct", "combat", True, vals["scale"] * 100, None,
                {"type": "firstDeploy", "label": "首个干员部署时"})
        if vals.get("atk_scale"):
            add("atkScale", "combat", True, vals["atk_scale"] * 100, None,
                {"type": "hasShield", "label": "拥有屏障时"})
        return out

    if name == "rogue_6_char_shield_locate" and "scale" in vals:
        add("shieldPct", "combat", True, vals["scale"] * 100, None,
            {"type": "firstDeploy", "label": "部署时"})
        return out

    if name == "rogue_6_char_shield_no_damage" and "scale" in vals:
        add("shieldPct", "combat", True, vals["scale"] * 100, None,
            _cond_after(vals.get("interval", 5),
                        "%d秒未受伤后" % round(vals.get("interval", 5))))
        return out

    if name == "rogue_6_shield_hp_ratio" and "hp_ratio" in vals:
        add("shieldPct", "combat", True, vals["hp_ratio"] * 100, None,
            _cond_hp_below(round(vals["hp_ratio"] * 100),
                           "生命≤%d%%时（仅一次）" % round(vals["hp_ratio"] * 100)))
        return out

    if name == "rogue_6_shield_when_attack" and "add_shield" in vals:
        add("shieldFlat", "combat", False, vals["add_shield"])
        return out

    if name == "rogue_3_bornShield[via_MaxHp]" and "born_hp_ratio" in vals:
        add("shieldPct", "combat", True, vals["born_hp_ratio"] * 100, None,
            {"type": "firstDeploy", "label": "部署时"})
        return out

    if name == "rogue_6_relic_cargo_17" and "hp_ratio" in vals:
        add("dmgCap", "combat", True, vals["hp_ratio"] * 100)
        return out

    # ---------------- 攻击倍率（一次性附加伤害） ----------------
    if name == "rogue_6_take_off_damage" and "atk_scale" in vals:
        add("atkScale", "combat", True, vals["atk_scale"] * 100, enemy,
            _cond_always("干员起飞时"))
        return out

    if name == "rogue_6_land_damage":
        if vals.get("atk_scale"):
            add("atkScale", "combat", True, vals["atk_scale"] * 100, enemy,
                _cond_always("干员降落时"))
        if vals.get("stun"):
            add("stun", "combat", False, vals["stun"], enemy, _cond_always("干员降落时"))
        return out

    if name == "rogue_6_character_connect" and "atk_scale" in vals:
        add("atkScale", "combat", True, vals["atk_scale"] * 100, enemy,
            _cond_always("敌人触碰连接终端时每0.5秒"))
        if vals.get("sluggish"):
            add("moveSpeed", "combat", True, -vals["sluggish"] * 100, enemy)
        return out

    if name == "rogue_6_random_damage_on_born" and "atk_scale" in vals:
        add("atkScale", "combat", True, vals["atk_scale"] * 100, enemy,
            _cond_always("部署时对随机1名敌人"))
        return out

    if name == "add_remaining_ammo_by_max_ratio" and "ammo_add_ratio" in vals:
        add("ammo", "combat", True, vals["ammo_add_ratio"] * 100)
        return out

    if name in ("rogue_6_special_book_magic", "rogue_6_special_book_physics"):
        # 秘术师/神射手/猎手：进入攻击范围时吃一次 300% 攻击的伤害 + 50% 脆弱。
        if vals.get("damage_scale"):
            add("weak", "combat", True, (vals["damage_scale"] - 1) * 100, enemy,
                _cond_always("进入攻击范围时"))
        if vals.get("atk_scale"):
            add("atkScale", "combat", True, vals["atk_scale"] * 100, enemy,
                _cond_always("进入攻击范围时"))
        return out

    # ---------------- 敌方 ----------------
    if name in ("enemy_def_down", "enemy_max_hp_down", "enemy_atk_down"):
        field = {"enemy_def_down": "def",
                 "enemy_max_hp_down": "max_hp",
                 "enemy_atk_down": "atk"}[name]
        v = vals.get(field)
        if v is not None:
            # 负值是「减」的百分比，正值是倍率（1.3 → +30%）
            pct = v * 100 if v < 0 else (v - 1) * 100
            stat = {"def": "enemyDef", "max_hp": "enemyHp", "atk": "enemyAtk"}[field]
            add(stat, "enemy", True, pct, enemy)
        return out

    if name == "enemy_lighter" and "mass_level" in vals:
        add("weight", "combat", False, vals["mass_level"], enemy)
        return out

    if name == "rogue_6_enemy_hp_savage" and "max_hp" in vals:
        add("enemyHp", "enemy", True, (vals["max_hp"] - 1) * 100, enemy,
            _cond_always("与「居民」作战时"))
        return out

    if name == "rogue_6_start_3" and "max_hp" in vals:
        add("enemyHp", "enemy", True, (vals["max_hp"] - 1) * 100, enemy,
            _cond_always("前两个区域"))
        return out

    if name == "enemy_move_speed_down" and "move_speed" in vals:
        add("moveSpeed", "combat", True, (vals["move_speed"] - 1) * 100, enemy)
        return out

    if name == "attr_up_on_trigger[def&mag_resist]":
        cond = _cond_after(vals.get("interval", 0),
                           "在场%d秒后" % round(vals.get("interval", 0)))
        if "def" in vals:
            add("def", "panel", False, vals["def"], None, cond)
        if "magic_resistance" in vals:
            add("res", "panel", False, vals["magic_resistance"], None, cond)
        return out

    if name == "rogue_3_relic_book_7":
        # 「场上每有一名术师，敌人受到的法术伤害 +12%（最多 +96%）」：
        # 驱动量是场上术师人数，不是手填层数，因此用 perProfession 而不是 perStack。
        f = vals.get("damage_scale_factor")
        if f:
            cap = None
            if vals.get("max_value"):
                cap = int(round((vals["max_value"] - 1) / f))
            add("magicTaken", "combat", True, f * 100, enemy,
                {"type": "perProfession", "who": "术师",
                 "label": "场上每有1名术师干员", "cap": cap})
        return out

    if name == "rogue6_relic_fight_63" and "atk" in vals:
        n = vals.get("max_stack_cnt")
        label = "每击倒一名敌人"
        if n:
            label += "（最多 %d 层 / +%g%%）" % (n, vals["atk"] * 100 * n)
        add("atk", "panel", True, vals["atk"] * 100, None, _cond_stack(label, n))
        return out

    if name == "heal_scale" and "heal_scale" in vals:
        add("heal", "combat", True, (vals["heal_scale"] - 1) * 100)
        return out

    if name in ("hp_recovery_per_sec[mul]", "hp_recovery_per_sec_by_max_hp_ratio[mul]"):
        # 这两个字段存的是「增量」：0.2 表示 +20%（和 heal_scale 的倍率语义不同）
        f = "hp_recovery_per_sec" if "hp_recovery_per_sec" in vals else "hp_recovery_per_sec_by_max_hp_ratio"
        if f in vals:
            add("hpRegenPct" if "ratio" in f else "hpRegen", "combat", True, vals[f] * 100)
        return out

    return out


def convert_buff(key, vals, strs, ctx):
    """把一条 buff 转成 mods。返回 [] 表示「转不了」，由调用方收进 special。"""
    scope = scope_from(strs)
    cap = ctx.get("layer_cap")

    if key == "char_attribute_mul":
        out = []
        for f, v in vals.items():
            if f in STAT_MAP:
                stat, bucket = STAT_MAP[f]
                out.append({"stat": stat, "bucket": bucket, "pct": True,
                            "value": round(v * 100, 4), "scope": scope, "cond": None})
        return out

    if key == "char_attribute_add":
        out = []
        for f, v in vals.items():
            if f in STAT_MAP:
                stat, bucket = STAT_MAP[f]
                # 这个字段存的是比例（0.01 = 每秒 1% 最大生命）
                if f == "hp_recovery_per_sec_by_max_hp_ratio":
                    out.append({"stat": stat, "bucket": bucket, "pct": True,
                                "value": round(v * 100, 4), "scope": scope, "cond": None})
                    continue
                out.append({"stat": stat, "bucket": bucket, "pct": False,
                            "value": v, "scope": scope, "cond": None})
        return out

    if key in ("layer_char_attribute_add", "layer_char_attribute_mul"):
        if "stack_by_res" in strs:
            cond = {"type": "perResource", "res": RES_MAP.get(strs["stack_by_res"], strs["stack_by_res"]),
                    "per": vals.get("stack_by_res_cnt", 1)}
        else:
            cond = {"type": "perStack", "label": "每层", "cap": cap}
        out = []
        for f, v in vals.items():
            if f not in STAT_MAP or f == "stack_by_res_cnt":
                continue
            stat, bucket = STAT_MAP[f]
            pct = key.endswith("_mul")
            out.append({"stat": stat, "bucket": bucket, "pct": pct,
                        "value": round(v * 100, 4) if pct else v, "scope": scope, "cond": cond})
        return out

    if key == "layer_char_random_target_attribute":
        cond = {"type": "perStack", "label": "每层", "cap": cap, "min": 1}
        out = []
        for f, v in vals.items():
            if f.startswith("multiplier@"):
                f2 = f.split("@", 1)[1]
                if f2 in STAT_MAP:
                    stat, bucket = STAT_MAP[f2]
                    out.append({"stat": stat, "bucket": bucket, "pct": True,
                                "value": round(v * 100, 4), "scope": {"assign": True}, "cond": cond})
        return out

    if key == "char_random_target_attribute":
        # 「战斗开始时使随机一名干员本局内攻击力+100%，生命+100%」
        # 受益方是「被点名的那一名」，不是全体，因此挂 assign 作用域，
        # 由界面上的「指定干员」标记决定它落到谁头上。
        out = []
        for f, v in vals.items():
            if f.startswith("multiplier@"):
                f2 = f.split("@", 1)[1]
                if f2 in STAT_MAP:
                    stat, bucket = STAT_MAP[f2]
                    out.append({"stat": stat, "bucket": bucket, "pct": True,
                                "value": round(v * 100, 4), "scope": {"assign": True},
                                "cond": None})
        return out

    if key == "char_attribute_final_scaler":
        out = []
        for f, v in vals.items():
            if f in STAT_MAP:
                stat, bucket = STAT_MAP[f]
                out.append({"stat": stat, "bucket": bucket, "pct": True,
                            "value": round(v * 100 if v < 0 else (v - 1) * 100, 4), "scope": scope, "cond": None})
        return out

    if key == "char_skill_cost_mul" and "scale" in vals:
        return [{"stat": "spCost", "bucket": "panel", "pct": True,
                 "value": round((vals["scale"] - 1) * 100, 4), "scope": scope, "cond": None}]

    if key == "deck_card_buff":
        # 「首次部署费用-75%」写在 cost_scale 里（0.25 = 打二五折）；
        # buildable_type 是「近战位可以放高台」这类部署规则，没有对应统计项。
        if "cost_scale" in vals:
            return [{"stat": "cost", "bucket": "panel", "pct": True,
                     "value": round((vals["cost_scale"] - 1) * 100, 4),
                     "scope": scope, "cond": {"type": "firstDeploy", "label": "首次部署时"}}]
        return []

    if key == "level_char_limit_add" and "value" in vals:
        return [{"stat": "deploy", "bucket": "run", "pct": False, "value": vals["value"],
                 "scope": {"all": True}, "cond": None}]

    if key == "level_init_cost_add" and "value" in vals:
        return [{"stat": "initCost", "bucket": "run", "pct": False, "value": vals["value"],
                 "scope": {"all": True}, "cond": None}]

    if key == "immediate_reward":
        rid, cnt = strs.get("id"), vals.get("count", 0)
        # count 为 0 的奖励是「占位」而非真实效果（224/236/237/238 就是这种），
        # 产出来会变成「目标生命 +0」这种假修正项，污染汇总区，直接跳过。
        if rid in REWARD_MAP and cnt:
            stat, bucket = REWARD_MAP[rid]
            return [{"stat": stat, "bucket": bucket, "pct": False, "value": cnt,
                     "scope": {"all": True}, "cond": None}]
        return []

    if key == "zone_into_reward":
        rid, cnt = strs.get("id"), vals.get("count", 0)
        if rid in REWARD_MAP and cnt:
            stat, bucket = REWARD_MAP[rid]
            return [{"stat": stat + "PerZone", "bucket": "run", "pct": False, "value": cnt,
                     "scope": {"all": True}, "cond": None}]
        return []

    if key == "up_reward":
        rid, up = strs.get("id"), vals.get("up", 0)
        if rid in REWARD_MAP and up:
            stat, _ = REWARD_MAP[rid]
            return [{"stat": stat + "Rate", "bucket": "run", "pct": True,
                     "value": round(up * 100, 4), "scope": {"all": True}, "cond": None}]
        return []

    if key == "global_buff_stack_base_one" and "damage_scale" in vals:
        name = strs.get("key", "")
        stat = "physTaken" if "[phy]" in name else "magicTaken" if "[mag]" in name else "trueTaken"
        return [{"stat": stat, "bucket": "combat", "pct": True,
                 "value": round((vals["damage_scale"] - 1) * 100, 4),
                 "scope": {"base": "enemy"}, "cond": None}]

    if key == "enemy_attribute_add" and "one_minus_status_resistance" in vals:
        return [{"stat": "statusTime", "bucket": "combat", "pct": True,
                 "value": round(vals["one_minus_status_resistance"] * 100, 4),
                 "scope": {"base": "enemy"}, "cond": None}]

    # char_ability_new / char_ability_new_at_root 与 global_buff_normal 同构：
    # 语义都在 blackboard 的 "key" 字符串上（AtkUp[BlockJustOne]、
    # rogue_6_warrior_book_2、rogue_6_special_book_magic…）。
    # 旧实现只把 global_buff_normal 送进 named_rule，于是「仅阻挡1名敌人时攻击力+100%」
    # 「75%概率闪避」这些明明有结构化字段的效果全被当成无法量化。
    if key in ("global_buff_normal", "global_buff_stack", "global_buff_layer",
               "char_ability_new", "char_ability_new_at_root"):
        name = strs.get("key", "")
        if key == "global_buff_stack" and "sp_recovery_per_sec" in vals:
            return [{"stat": "spRecover", "bucket": "panel", "pct": False,
                     "value": vals["sp_recovery_per_sec"], "scope": scope, "cond": None}]
        return named_rule(name, vals, strs, scope)

    return []


SCOPE_UNION_FIELDS = ("professions", "subProfs", "positions")
SCOPE_FLAG_FIELDS = ("base", "summon", "assign")


def _cond_key(cond):
    return json.dumps(cond, sort_keys=True, ensure_ascii=False) if cond else ""


def _scope_mergeable(a, b):
    """两个作用域能否合并成「并集」。

    带 base / summon / assign 的（敌方、召唤物、指定干员）只有取值完全相同才并；
    取值不同说明受益方根本不是一个群体，并起来会张冠李戴。
    """
    a = a or {}
    b = b or {}
    for f in SCOPE_FLAG_FIELDS:
        if bool(a.get(f)) != bool(b.get(f)):
            return False
        if a.get(f) and b.get(f) and a.get(f) != b.get(f):
            return False
    return True


def _scope_union(a, b):
    a = a or {}
    b = b or {}
    if a.get("all") or b.get("all"):
        return {"all": True}
    out = dict(a)
    for f in SCOPE_UNION_FIELDS:
        if f in b:
            out[f] = sorted(set(out.get(f) or []) | set(b[f]))
    return out


def dedupe_mods(mods):
    """合并「同一条效果被官方拆成多个 selector 分支」造成的重复项。

    例：剿袭之手（173）对秘术师写一条 weak=50/atkScale=300，对神射手+猎手又写一条
    完全相同的一条。两条作用域互斥，逐条相加会在队伍汇总里翻倍（脆弱 100%）。
    这里把「属性 + 百分比/固定 + 数值 + 条件」都相同的项并成一条，作用域取并集。
    """
    out = []
    index = {}
    for m in mods:
        key = (m["stat"], bool(m["pct"]), round(float(m["value"]), 4),
               _cond_key(m.get("cond")), m.get("group") or "")
        prev = index.get(key)
        if prev is not None and _scope_mergeable(prev.get("scope"), m.get("scope")):
            prev["scope"] = _scope_union(prev.get("scope"), m.get("scope"))
            continue
        index[key] = m
        out.append(m)
    return out


# ---------------------------------------------------------------------------
# 显式覆盖表
# ---------------------------------------------------------------------------
# 有些藏品的官方 buff 里只有「进阶票 / 指定干员」的引用（next_recruit_upgrade_char_buff、
# immediate_reward ticket），真正的数值写在 charBuffData 的另一个表里；还有些官方数值的
# 语义容易被读错（例如 160 的「获得部署费用」）。这些藏品直接按官方 usage 文案写成
# 确定的修正项，逐条可对文案核对，不再依赖运行时正则。
#
# scope.assign = 只对「一次性藏品指定此人」勾选的干员生效。
ASSIGN = {"base": "friendly", "assign": True}


def _assign(prof=None):
    sc = dict(ASSIGN)
    if prof:
        sc["professions"] = [prof]
    return sc


OVERRIDES = {
    # 160 钝爪-先机：先锋开技能立刻获得 3 点部署费用
    "rogue_6_relic_book_1": [
        {"stat": "dpOnSkill", "bucket": "run", "pct": False, "value": 3,
         "scope": {"professions": ["先锋"]}, "cond": _cond_skill(0)}
    ],
    # 174 钝爪-新典训：每次开技能攻击力 +10%，最多 +60%（6 层）
    "rogue_6_relic_assign_1": [
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 10,
         "scope": _assign("先锋"), "cond": _cond_stack("每次开启技能（最多6层 / +60%）", 6)}
    ],
    # 175 断杖-新典训：攻击时降低目标 5 点法抗，最多 25（5 层）
    "rogue_6_relic_assign_2": [
        {"stat": "enemyRes", "bucket": "enemy", "pct": False, "value": -5,
         "scope": _assign("术师"), "cond": _cond_stack("每次命中（最多5层 / -25）", 5)}
    ],
    # 177 铁卫-新典训：受到攻击时回复 2 技力
    "rogue_6_relic_assign_4": [
        {"stat": "spOnAttack", "bucket": "combat", "pct": False, "value": 2,
         "scope": _assign("重装"), "cond": _cond_proc("受到攻击时")}
    ],
    # 178 残弩-新典训：攻击时无视目标 50% 防御
    "rogue_6_relic_assign_5": [
        {"stat": "defIgnore", "bucket": "combat", "pct": True, "value": 50,
         "scope": _assign("狙击"), "cond": None}
    ],
    # 180 锈刃-新典训：再部署时间 -50%
    "rogue_6_relic_assign_7": [
        {"stat": "redeploy", "bucket": "panel", "pct": True, "value": -50,
         "scope": _assign("特种"), "cond": None}
    ],
    # 181 支柱-新典训：攻击范围内的敌人防御/法抗 -40%
    "rogue_6_relic_assign_8": [
        {"stat": "enemyDef", "bucket": "enemy", "pct": True, "value": -40,
         "scope": _assign("辅助"), "cond": None},
        {"stat": "enemyRes", "bucket": "enemy", "pct": True, "value": -40,
         "scope": _assign("辅助"), "cond": None}
    ],
    # 182-188 一次性藏品：只对指定干员生效
    "rogue_6_relic_assign_9": [
        {"stat": "aspd", "bucket": "panel", "pct": False, "value": 50,
         "scope": _assign(), "cond": None}
    ],
    "rogue_6_relic_assign_10": [
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 100,
         "scope": _assign(), "cond": None},
        {"stat": "aspd", "bucket": "panel", "pct": False, "value": 50,
         "scope": _assign(), "cond": None}
    ],
    "rogue_6_relic_assign_11": [
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 50,
         "scope": _assign(), "cond": _cond_proc("首次部署时")}
    ],
    "rogue_6_relic_assign_12": [
        {"stat": "aspd", "bucket": "panel", "pct": False, "value": -50,
         "scope": _assign(), "cond": None},
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 120,
         "scope": _assign(), "cond": None}
    ],
    "rogue_6_relic_assign_13": [
        {"stat": "spCost", "bucket": "panel", "pct": True, "value": -20,
         "scope": _assign(), "cond": None}
    ],
    "rogue_6_relic_assign_15": [
        {"stat": "spRecover", "bucket": "panel", "pct": False, "value": 0.8,
         "scope": _assign(), "cond": None}
    ],
    # 171 波纹之手：三个分支每造成一次伤害回复 2 技力；
    # 持有【断杖-同调】时，造成伤害后 3 秒内攻击力 +20%（最多 5 层 = +100%）
    "rogue_6_relic_hand_5": [
        {"stat": "spOnAttack", "bucket": "combat", "pct": False, "value": 2,
         "scope": {"base": "friendly", "subProfs": ["轰击术师", "链术师", "驭械术师"]},
         "cond": _cond_all([_cond_proc("造成伤害时")], "造成伤害时")},
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 20,
         "scope": {"base": "friendly", "subProfs": ["轰击术师", "链术师", "驭械术师"]},
         "cond": _cond_all([_cond_has_relic("164", "拥有【断杖-同调】"),
                            _cond_stack("造成伤害后3秒内（最多5层 / +100%）", 5)],
                           "拥有【断杖-同调】时，造成伤害后 3 秒内每层 +20%（最多 5 层 / +100%）")}
    ],
    # 173 剿袭之手：秘术师（法术）/ 神射手·猎手（物理）——敌人进入攻击范围时
    # 受一次 300% 攻击力伤害 + 50% 脆弱 3 秒
    "rogue_6_relic_hand_7": [
        {"stat": "weak", "bucket": "combat", "pct": True, "value": 50,
         "scope": {"base": "enemy", "subProfs": ["秘术师", "神射手", "猎手"]},
         "cond": _cond_all([_cond_proc("敌人进入攻击范围时")], "敌人进入攻击范围时（脆弱 3 秒）")},
        {"stat": "atkScale", "bucket": "combat", "pct": True, "value": 300,
         "scope": {"base": "enemy", "subProfs": ["秘术师", "神射手", "猎手"]},
         "cond": _cond_all([_cond_proc("敌人进入攻击范围时")], "敌人进入攻击范围时（300% 伤害）")}
    ],
    # 167 开拓之手：尖兵/冲锋手/策士费用 -6、技力需求 -50%；
    # 持有【钝爪-先机】时，开启技能给其他场上干员回 2 技力
    "rogue_6_relic_hand_1": [
        {"stat": "cost", "bucket": "panel", "pct": False, "value": -6,
         "scope": {"subProfs": ["尖兵", "冲锋手", "策士"]}, "cond": None},
        {"stat": "spCost", "bucket": "panel", "pct": True, "value": -50,
         "scope": {"subProfs": ["尖兵", "冲锋手", "策士"]}, "cond": None},
        {"stat": "spOnSkillEnd", "bucket": "combat", "pct": False, "value": 2,
         "scope": {"subProfs": ["尖兵", "冲锋手", "策士"]},
         "cond": _cond_all([_cond_has_relic("160", "拥有【钝爪-先机】")],
                           "拥有【钝爪-先机】时：开技能给其他场上干员回 2 技力")}
    ],
    # 168 诛戮之手：武者/无畏者/术战者伤害提升至 200%；
    # 持有【折戟-避锋】时，击倒敌人后下次再部署时间与部署费用 -50%
    "rogue_6_relic_hand_2": [
        {"stat": "dmgReduce", "bucket": "combat", "pct": True, "value": 100,
         "scope": {"subProfs": ["武者", "无畏者", "术战者"]}, "cond": None},
        {"stat": "redeploy", "bucket": "panel", "pct": True, "value": -50,
         "scope": {"subProfs": ["武者", "无畏者", "术战者"]},
         "cond": _cond_all([_cond_has_relic("161", "拥有【折戟-避锋】"), _cond_proc("击倒敌人后")],
                           "拥有【折戟-避锋】时：击倒敌人后 -50%")},
        {"stat": "cost", "bucket": "panel", "pct": True, "value": -50,
         "scope": {"subProfs": ["武者", "无畏者", "术战者"]},
         "cond": _cond_all([_cond_has_relic("161", "拥有【折戟-避锋】"), _cond_proc("击倒敌人后")],
                           "拥有【折戟-避锋】时：击倒敌人后 -50%")}
    ],
    # 169 坚御之手：铁卫/哨戒铁卫/不屈者部署与技能结束后攻防生命 +100%（60 秒内递减）；
    # 持有【铁卫-轻行】时，生命高于 50% 时阻挡 +3
    "rogue_6_relic_hand_3": [
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 100,
         "scope": {"subProfs": ["铁卫", "哨戒铁卫", "不屈者"]},
         "cond": _cond_early(60, "部署/技能结束后 60 秒内")},
        {"stat": "hp", "bucket": "panel", "pct": True, "value": 100,
         "scope": {"subProfs": ["铁卫", "哨戒铁卫", "不屈者"]},
         "cond": _cond_early(60, "部署/技能结束后 60 秒内")},
        {"stat": "block", "bucket": "panel", "pct": False, "value": 3,
         "scope": {"subProfs": ["铁卫", "哨戒铁卫", "不屈者"]},
         "cond": _cond_all([_cond_has_relic("162", "拥有【铁卫-轻行】"), _cond_hp_above(50, "生命≥50%")],
                           "拥有【铁卫-轻行】且生命≥50% 时：阻挡 +3")}
    ],
    # 170 慑空之手：炮手/散射手/裂空炮手开技能攻击 +150%（5 秒）；
    # 持有【残弩-神准】时，每 3 秒获得 3 点技力（= +1/秒）
    "rogue_6_relic_hand_4": [
        {"stat": "atk", "bucket": "panel", "pct": True, "value": 150,
         "scope": {"subProfs": ["炮手", "散射手", "裂空炮手"]},
         "cond": _cond_skill(5)},
        {"stat": "spRecover", "bucket": "panel", "pct": False, "value": 1,
         "scope": {"subProfs": ["炮手", "散射手", "裂空炮手"]},
         "cond": _cond_all([_cond_has_relic("163", "拥有【残弩-神准】")],
                           "拥有【残弩-神准】时：每 3 秒获得 3 点技力（+1/秒）")}
    ],
    # 124 染血辞典：生命低于 10% 时获得最大生命 100% 的屏障（一次）
    "rogue_6_relic_fight_12": [
        {"stat": "shieldPct", "bucket": "combat", "pct": True, "value": 100,
         "scope": {"all": True},
         "cond": _cond_all([_cond_hp_below(10, "生命<10% 时（仅一次）")],
                           "生命<10% 时获得 100% 生命上限屏障")}
    ],
    # 209 猎印：猎犬proto 攻击 -50%（对敌），每层【探测先锋】我方法抗 +10
    "rogue_6_relic_cargo_12": [
        {"stat": "enemyAtk", "bucket": "enemy", "pct": True, "value": -50,
         "scope": {"base": "enemy"}, "cond": None},
        {"stat": "res", "bucket": "panel", "pct": False, "value": 10,
         "scope": {"all": True},
         "cond": _cond_per_relic_stack("142", "每层【探测先锋】")}
    ],
}


def apply_overrides(base_id, mods):
    if base_id in OVERRIDES:
        return [dict(m, src="official") for m in OVERRIDES[base_id]]
    return mods


# ---------------------------------------------------------------------------
# 用官方 usage 文案收紧作用域
# ---------------------------------------------------------------------------
# 官方 selector 常常写成「八个职业全选」（WARRIOR|SNIPER|…），但文案把范围收在
# 「地面干员 / 高台干员」上；另一些藏品官方 buff 干脆没写 selector，文案却明确
# 写了「所有【先锋】干员」。这里按文案把作用域收紧，避免「高台藏品加到近战身上」。
ALL_PROFS = {"先锋", "近卫", "重装", "狙击", "术师", "医疗", "辅助", "特种"}
PROF_WORDS = ["先锋", "近卫", "重装", "狙击", "术师", "医疗", "辅助", "特种"]
POS_WORDS = [
    ("地面干员", "MELEE"), ("近战干员", "MELEE"), ("近战单位", "MELEE"), ("近战位", "MELEE"),
    ("高台干员", "RANGED"), ("远程干员", "RANGED"), ("远程单位", "RANGED"), ("远程位", "RANGED"),
]


def apply_text_scope(mods, text):
    if not text:
        return mods
    prof = None
    import re as _re
    m = _re.search(r"所有[【\[]?([^】\]]{1,4})[】\]]?干员", text)
    if m and m.group(1) in PROF_WORDS:
        prof = m.group(1)
    pos = None
    for word, p in POS_WORDS:
        if word in text:
            pos = p
            break
    if not prof and not pos:
        return mods
    for mod in mods:
        sc = dict(mod.get("scope") or {})
        if sc.get("base") == "enemy" or sc.get("assign") or sc.get("subProfs"):
            continue
        if prof:
            cur = sc.get("professions") or []
            # 只在「全体」或「八个职业全选」时收紧，不覆盖已明确写的职业
            if not cur or set(cur) >= ALL_PROFS:
                sc = {"professions": [prof]}
                if mod["scope"].get("positions"):
                    sc["positions"] = mod["scope"]["positions"]
        if pos and not sc.get("positions"):
            sc["positions"] = [pos]
        mod["scope"] = sc
    return mods


def parse_buffs(buffs):
    cap = layer_cap(buffs)
    ctx = {"layer_cap": cap}
    mods, specials = [], []
    shield_stacks = 0
    for b in buffs:
        key = b.get("key")
        vals, strs = bb(b)
        if key == "global_buff_normal" and strs.get("key") == "damage_block[stack]":
            shield_stacks += 1
            continue
        got = convert_buff(key, vals, strs, ctx)
        if got:
            for g in got:
                # 同样的「每次进入区域」奖励会在多个区域各写一条，去重只保留一条
                if g["stat"].endswith("PerZone"):
                    exist = next((m for m in mods if m["stat"] == g["stat"]), None)
                    if exist:
                        exist["value"] = max(exist["value"], g["value"])
                        continue
                mods.append(g)
        # 没有转换规则的 buff 不再写成 "[buff_key field=1.0]" 这种调试串：
        # 界面的「特殊效果」由文案解析出的可读句子负责，这里只保留计数信息。
        # 因此 specials 恒为空列表（字段保留，供将来接入可读描述）。
    if shield_stacks:
        mods.append({"stat": "shield", "bucket": "run", "pct": False,
                     "value": shield_stacks, "scope": {"all": True}, "cond": None})
    mods = dedupe_mods(mods)
    for m in mods:
        m["src"] = "official"
    return mods, specials


def main():
    relics, items, wiki = load()
    out = []
    stat = {"relics": 0, "stages": 0, "mods": 0, "no_mod": 0, "missing_usage": 0}

    for w in wiki:
        base_id = w["icon"]
        stages = []
        for idx, (suf, stage_name) in enumerate(STAGE_SUFFIX):
            rid = base_id + suf
            if rid not in relics:
                continue
            it = items.get(rid) or {}
            mods, specials = parse_buffs(relics[rid].get("buffs") or [])
            mods = apply_overrides(base_id, mods)
            text = (it.get("usage") or "").strip()
            if not text:
                stat["missing_usage"] += 1
                for t in w.get("tiers") or []:
                    if t.get("stage") == stage_name or (not t.get("stage") and idx == 0):
                        text = t.get("text", "")
                        break
            mods = apply_text_scope(mods, text)
            stages.append({
                "idx": idx,
                "name": stage_name,
                "text": text,
                "mods": mods,
                "special": specials,
                "parsed_by": "official" if mods else "",
            })
            stat["stages"] += 1
            stat["mods"] += len(mods)

        if not stages:
            stages = [{"idx": 0, "name": "", "text": w.get("effect", ""), "mods": [],
                       "special": [], "parsed_by": ""}]

        out.append({
            "id": w["id"],
            "name": w["name"],
            "category": w["category"],
            "rarity": w["rarity"],
            "icon": base_id,
            "flags": w.get("flags", []),
            "desc": w.get("desc", ""),
            "condition": w.get("condition", ""),
            "note": w.get("note", ""),
            "obtain": w.get("obtain", ""),
            "stages": stages,
        })
        if not any(s["mods"] for s in stages):
            stat["no_mod"] += 1
        stat["relics"] += 1

    with open(os.path.join(DATA, "relics.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    # 旧格式只用于调试比对：界面读的是 data/is6db.js 里的 relics + relic_stages
    if "--legacy-js" in sys.argv:
        with open(os.path.join(DATA, "relics.js"), "w", encoding="utf-8") as f:
            f.write("/* 自动生成：tools/build_relics_official.py --legacy-js。仅调试用，index.html 不加载。 */\n")
            f.write("window.RELIC_DATA = ")
            json.dump({"theme": "沉沦者的黑流树海",
                       "source": "game data: roguelike_topic_table.json (rogue_6)",
                       "relics": out}, f, ensure_ascii=False, separators=(",", ":"))
            f.write(";\n")
        print("wrote data/relics.js（legacy，index.html 不加载）")

    print("藏品 %(relics)d｜阶段 %(stages)d｜官方结构化修正项 %(mods)d｜仍需文案兜底 %(no_mod)d｜缺 usage %(missing_usage)d" % stat,
          flush=True)


if __name__ == "__main__":
    main()
