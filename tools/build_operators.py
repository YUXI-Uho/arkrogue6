# -*- coding: utf-8 -*-
"""构建内置干员数据库。

数据来源（全部来自游戏数据表 Kengxxiao/ArknightsGameData，zh_CN）：
  character_table.json   精英化三阶段面板、信赖加成、职业/分支、星级、特性、
                         技能槽位、天赋、潜能、标签、攻击范围 id
  skill_table.json       技能名称、SP 类型、持续、每级文案（含黑盒数值占位符）
  uniequip_table.json    模组名称 / 类型 / 解锁条件
  battle_equip_table.json 模组三档的属性加成与效果文案
  range_table.json       攻击范围的格子坐标
  PRTS 明日方舟 Wiki     每个干员页面的 {{CharinfoV2}} → 中文「分支」名
                         （游戏数据里只有 subProfessionId 英文 id）

输出：data/operators.json
      一条干员 = 扁平面板（给计算用）+ 嵌套的 phases / skills / talents /
      modules / potential（给详情页用）。浏览器不直接读这份 JSON —— 它先由
      tools/build_db.py 拆成 operators / operator_phases / operator_skills /
      operator_talents / operator_modules / ranges 六张表。
      加 --legacy-js 可额外吐一份 window.OPERATOR_DATA 的旧格式文件，仅供调试比对。
"""
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
CDN_MIRRORS = [
    "https://gcore.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
    "https://fastly.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
    "https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9"}

# 少数干员在游戏数据里是英文名，PRTS 页面用中文名
PRTS_ALIAS = {"Mechanist": "机械师"}

PROFESSION_CN = {
    "PIONEER": "先锋", "WARRIOR": "近卫", "TANK": "重装", "SNIPER": "狙击",
    "CASTER": "术师", "MEDIC": "医疗", "SUPPORT": "辅助", "SPECIAL": "特种",
}

# 技能回复类型 / 触发类型的中文名（游戏数据里只有大写枚举）
SP_TYPE_CN = {
    "INCREASE_WITH_TIME": "自动回复",
    "INCREASE_WHEN_ATTACK": "攻击回复",
    "INCREASE_WHEN_TAKEN_DAMAGE": "受击回复",
}
SKILL_TYPE_CN = {"AUTO": "自动触发", "MANUAL": "手动触发", "PASSIVE": "被动"}
PHASE_IDX = {"PHASE_0": 0, "PHASE_1": 1, "PHASE_2": 2}

# 模组属性键 → 面板字段（只有这 8 个键会出现）
MOD_ATTR = {
    "max_hp": "hp", "atk": "atk", "def": "def", "magic_resistance": "res",
    "attack_speed": "aspd", "base_attack_time": "interval",
    "cost": "cost", "block_cnt": "block", "respawn_time": "redeploy",
}

# 技能文案里的 {key:0%} 占位符；以及 <@ba.kw>…</> 这类富文本标签
PLACEHOLDER = re.compile(r"\{([^{}:]+)(?::([^{}]*))?\}")
RICH_TAG = re.compile(r"<[@$]ba\.[A-Za-z0-9_.]+>|</>")

lock = threading.Lock()
progress = {"done": 0, "total": 0}


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- 下载 / 抓取
def download(name):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, name)
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    last_err = None
    for base in CDN_MIRRORS:
        try:
            req = urllib.request.Request(base + name, headers=UA)
            resp = urllib.request.urlopen(req, timeout=120)
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            with open(path + ".part", "wb") as f:
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total and got % (4 * 1024 * 1024) < 262144:
                        log("  %s: %.1f / %.1f MB" % (name, got / 1e6, total / 1e6))
            os.replace(path + ".part", path)
            log("downloaded %s (%d bytes) from %s" % (name, got, base.split("/")[2]))
            return path
        except Exception as e:
            last_err = e
            log("  mirror failed: %s (%s)" % (base.split("/")[2], e))
    raise last_err


def http_text(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception as e:
            if i == retries - 1:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def fetch_branch(name, results):
    """抓 PRTS 干员页，取 |分支="""
    title = urllib.parse.quote(name, safe="")
    url = "https://prts.wiki/index.php?title=%s&action=raw" % title
    txt = http_text(url)
    m = re.search(r"^\|分支=(.+?)\s*$", txt, re.M) if txt else None
    prof = re.search(r"^\|职业=(.+?)\s*$", txt, re.M) if txt else None
    with lock:
        results[name] = ({"branch": m.group(1).strip() if m else "", "prof": prof.group(1).strip() if prof else ""}
                         if txt else None)
        progress["done"] += 1
        if progress["done"] % 25 == 0 or progress["done"] == progress["total"]:
            log("  branch progress %d/%d" % (progress["done"], progress["total"]))


# ---------------------------------------------------------------- 文案渲染
def fmt_value(v, fmt):
    """按 {key:0%} / {key:0.0} / {key} 的格式串还原成可读数字。"""
    if not fmt:
        if abs(v - round(v)) < 1e-9:
            return "%d" % round(v)
        return ("%.3f" % v).rstrip("0").rstrip(".")
    pct = fmt.endswith("%")
    body = fmt[:-1] if pct else fmt
    dec = len(body.split(".")[1]) if "." in body else 0
    if pct:
        v = v * 100
    return ("%.*f" % (dec, v)) + ("%" if pct else "")


def render_desc(text, blackboard, extra=None):
    """技能文案是模板：{atk_scale:0%} 这类占位符要按 blackboard 填值，
    <@ba.vup>…</> 是客户端富文本着色标签，直接去掉。
    extra 用于补 blackboard 里没有的键（例如 {duration} 取技能自身的持续）。"""
    if not text:
        return ""
    bb = {}
    for item in (blackboard or []):
        k = str(item.get("key") or "").lower()
        if k:
            bb[k] = item
    for k, v in (extra or {}).items():
        bb.setdefault(str(k).lower(), {"value": v})

    def rep(m):
        raw = m.group(1).strip()
        item = bb.get(raw.lower())
        negate = False
        # 官方文案里写成 {-def:0%} / {-attack@atk:0%}：负号是「对这个值取负」的算子，
        # 不是字面量。模板自己可能还带一个 '-'（防御力<vdown>-{-def}</>），
        # 所以这里必须把数值取反后交给格式化，不能简单加前缀 —— 否则会拼出 ---70%。
        if item is None and raw[:1] in ("-", "+"):
            negate = raw[0] == "-"
            item = bb.get(raw[1:].strip().lower())
        if item is None:
            return m.group(0)
        if item.get("valueStr"):
            return ("-" if negate else "") + str(item["valueStr"])
        try:
            v = float(item.get("value"))
        except (TypeError, ValueError):
            return m.group(0)
        if negate:
            v = -v
        return fmt_value(v, m.group(2))

    out = PLACEHOLDER.sub(rep, text)
    out = RICH_TAG.sub("", out)
    return out.replace("\\n", "\n").strip()


# ---------------------------------------------------------------- 面板
def pick_phase(op):
    phases = op.get("phases") or []
    best = None
    for idx, ph in enumerate(phases):
        frames = ph.get("attributesKeyFrames") or []
        if frames:
            best = (idx, ph, frames[-1])
    return best


def phase_rows(op):
    """每个精英化阶段一行，取该阶段满级那一帧。"""
    out = []
    for idx, ph in enumerate(op.get("phases") or []):
        frames = ph.get("attributesKeyFrames") or []
        if not frames:
            continue
        f = frames[-1]
        d = f.get("data") or {}
        out.append({
            "elite": idx,
            "level": f.get("level", 0),
            "hp": int(round(d.get("maxHp", 0))),
            "atk": int(round(d.get("atk", 0))),
            "def": int(round(d.get("def", 0))),
            "res": int(round(d.get("magicResistance", 0))),
            "aspd": int(round(d.get("attackSpeed", 100))) or 100,
            "interval": round(float(d.get("baseAttackTime", 1.0) or 1.0), 3),
            "cost": int(round(d.get("cost", 0))),
            "block": int(round(d.get("blockCnt", 1))),
            "redeploy": int(round(d.get("respawnTime", 70))) or 70,
            "rangeId": ph.get("rangeId") or "",
        })
    return out


def skill_rows(op, skill_table):
    """技能槽位 → 一行。等级取 M3（10 级表的最后一档），同时留一份 7 级。"""
    out = []
    for slot, sk in enumerate(op.get("skills") or [], 1):
        sid = sk.get("skillId")
        s = skill_table.get(sid) if sid else None
        if not s:
            continue
        levels = s.get("levels") or []
        if not levels:
            continue
        top = levels[-1]
        lv7 = levels[6] if len(levels) >= 7 else top
        sp = top.get("spData") or {}
        sp7 = lv7.get("spData") or {}
        out.append({
            "slot": slot,
            "skillId": sid,
            "name": top.get("name") or "",
            "chargeType": SP_TYPE_CN.get(sp.get("spType"), sp.get("spType") or ""),
            "activation": SKILL_TYPE_CN.get(top.get("skillType"), top.get("skillType") or ""),
            "duration": round(float(top.get("duration") or 0), 2),
            "spCost": int(round(sp.get("spCost") or 0)),
            "initSp": int(round(sp.get("initSp") or 0)),
            "spCost7": int(round(sp7.get("spCost") or 0)),
            "initSp7": int(round(sp7.get("initSp") or 0)),
            "desc": render_desc(top.get("description"), top.get("blackboard"),
                                {"duration": top.get("duration") or 0}),
            "rangeId": top.get("rangeId") or "",
            "maxLevel": len(levels),
            # 槽位 1/2/3 分别在 E0/E1/E2 解锁，这是全干员统一的规则
            "unlockElite": slot - 1,
        })
    return out


def trait_text(c):
    """职业特性：文案在 c.description，数值在 c.trait.candidates[].blackboard 里。
    取「最高阶段 + 无潜能要求」那一版，有 overrideDescripton 就用它（少数干员会整句替换）。"""
    cands = (c.get("trait") or {}).get("candidates") or []
    best = None
    for cand in cands:
        cond = cand.get("unlockCondition") or {}
        if (cand.get("requiredPotentialRank") or 0) > 0:
            continue
        ph = PHASE_IDX.get(cond.get("phase"), 0)
        if best is None or ph >= best[0]:
            best = (ph, cand)
    txt = c.get("description") or ""
    bb = None
    if best:
        bb = best[1].get("blackboard")
        if best[1].get("overrideDescripton"):
            txt = best[1]["overrideDescripton"]
    return render_desc(txt, bb)


def talent_rows(op):
    """每个天赋槽位取「最高阶段 + 无潜能要求」的那一版，避免潜能版本重复。"""
    out = []
    for idx, t in enumerate(op.get("talents") or [], 1):
        cands = t.get("candidates") or []
        if not cands:
            continue
        def rank(c):
            cond = c.get("unlockCondition") or {}
            ph = PHASE_IDX.get(cond.get("phase"), 0)
            pot = c.get("requiredPotentialRank") or 0
            return (ph, -pot)
        best = max(cands, key=rank)
        name = best.get("name") or ""
        desc = render_desc(best.get("description"), best.get("blackboard"))
        # 官方数据里有「占位槽」：名字和文案都是空的，收进来会在详情页渲染成空白块
        if not name and not desc:
            continue
        cond = best.get("unlockCondition") or {}
        out.append({
            "idx": idx,
            "name": name,
            "desc": desc,
            "unlockElite": PHASE_IDX.get(cond.get("phase"), 0),
            "unlockLevel": int(round(cond.get("level") or 1)),
        })
    return out


def module_rows(cid, uniequip, battle_equip):
    """模组：名称/类型/解锁条件来自 uniequip_table，三档属性与效果来自 battle_equip_table。"""
    ids = (uniequip.get("charEquip") or {}).get(cid) or []
    equip = uniequip.get("equipDict") or {}
    out = []
    for mid in ids:
        meta = equip.get(mid)
        if not meta:
            continue
        levels = []
        prev_desc = None
        for ph in ((battle_equip.get(mid) or {}).get("phases") or []):
            delta = {}
            for bb in (ph.get("attributeBlackboard") or []):
                key = MOD_ATTR.get(bb.get("key"))
                if key:
                    delta[key] = bb.get("value")
            effects = []
            for part in (ph.get("parts") or []):
                for bundle in ("overrideTraitDataBundle", "addOrOverrideTalentDataBundle"):
                    for cand in ((part.get(bundle) or {}).get("candidates") or []):
                        txt = render_desc(cand.get("additionalDescription"), cand.get("blackboard"))
                        if txt and txt not in effects:
                            effects.append(txt)
            desc = "\n".join(effects)
            # 三档文案多数只差数字、甚至完全相同：与上一档一样就留空，
            # 读取侧回退到最近的非空档（见 OperatorRepo.moduleAt）。产物小一半。
            same = (desc == prev_desc)
            prev_desc = desc
            levels.append({
                "level": int(ph.get("equipLevel") or 0),
                "hp": int(round(delta.get("hp") or 0)),
                "atk": int(round(delta.get("atk") or 0)),
                "def": int(round(delta.get("def") or 0)),
                "res": int(round(delta.get("res") or 0)),
                "aspd": int(round(delta.get("aspd") or 0)),
                "interval": round(float(delta.get("interval") or 0), 3),
                "cost": int(round(delta.get("cost") or 0)),
                "block": int(round(delta.get("block") or 0)),
                "redeploy": int(round(delta.get("redeploy") or 0)),
                "desc": "" if same else desc,
            })
        levels.sort(key=lambda r: r["level"])
        out.append({
            "moduleId": mid,
            "name": meta.get("uniEquipName") or "",
            "type": meta.get("type") or "",
            "typeName": meta.get("typeName1") or "",
            "unlockElite": PHASE_IDX.get(meta.get("unlockEvolvePhase"), 0),
            "unlockLevel": int(round(meta.get("unlockLevel") or 0)),
            "levels": levels,
        })
    return out


def collect_ranges(ops, range_table):
    """只导出真正被引用到的范围 id，格子坐标直接存。"""
    used = set()
    for o in ops:
        d = o.get("detail") or {}
        if d.get("rangeId"):
            used.add(d["rangeId"])
        for p in d.get("phases") or []:
            if p.get("rangeId"):
                used.add(p["rangeId"])
        for s in d.get("skills") or []:
            if s.get("rangeId"):
                used.add(s["rangeId"])
    rows = []
    for rid in sorted(used):
        r = range_table.get(rid)
        if not r:
            continue
        rows.append({
            "id": rid,
            "direction": int(r.get("direction") or 0),
            "grids": [[int(g.get("row", 0)), int(g.get("col", 0))] for g in (r.get("grids") or [])],
        })
    return rows


# ---------------------------------------------------------------- 主流程
def build():
    with open(download("character_table.json"), encoding="utf-8") as f:
        table = json.load(f)
    with open(download("skill_table.json"), encoding="utf-8") as f:
        skill_table = json.load(f)
    with open(download("uniequip_table.json"), encoding="utf-8") as f:
        uniequip = json.load(f)
    with open(download("battle_equip_table.json"), encoding="utf-8") as f:
        battle_equip = json.load(f)
    with open(download("range_table.json"), encoding="utf-8") as f:
        range_table = json.load(f)

    ops = []
    for cid, c in table.items():
        if not cid.startswith("char_"):
            continue
        if not c.get("name"):
            continue
        if c.get("profession") not in PROFESSION_CN:
            continue
        picked = pick_phase(c)
        if not picked:
            continue
        phase_idx, phase, frame = picked
        d = frame.get("data") or {}
        favor = {"hp": 0, "atk": 0, "def": 0}
        fk = c.get("favorKeyFrames") or []
        if fk:
            fd = fk[-1].get("data") or {}
            favor = {"hp": int(round(fd.get("maxHp", 0))),
                     "atk": int(round(fd.get("atk", 0))),
                     "def": int(round(fd.get("def", 0)))}
        tier = c.get("rarity", "TIER_0")
        # character_table 里 TIER_n 就是 n 星（Lancet-2 = TIER_1 = 1 星）
        stars = int(tier.split("_")[-1]) if tier.startswith("TIER_") else 1

        rich = {
            "charId": cid,
            "subProfessionId": c.get("subProfessionId") or "",
            "displayNumber": c.get("displayNumber") or "",
            "appellation": c.get("appellation") or "",
            "obtain": c.get("itemObtainApproach") or "",
            "tags": list(c.get("tagList") or []),
            "trait": trait_text(c),
            "rangeId": phase.get("rangeId") or "",
            "potential": [p.get("description") for p in (c.get("potentialRanks") or [])
                          if p.get("description")],
            "phases": phase_rows(c),
            "skills": skill_rows(c, skill_table),
            "talents": talent_rows(c),
            "modules": module_rows(cid, uniequip, battle_equip),
        }

        ops.append({
            "id": cid,
            "name": c["name"],
            "profession": PROFESSION_CN[c["profession"]],
            "subProfession": "",
            "position": "近战位" if c.get("position") == "MELEE" else "远程位",
            "rarity": stars,
            "elite": phase_idx,
            "level": frame.get("level", 0),
            "hp": int(round(d.get("maxHp", 0))),
            "atk": int(round(d.get("atk", 0))),
            "def": int(round(d.get("def", 0))),
            "res": int(round(d.get("magicResistance", 0))),
            "aspd": int(round(d.get("attackSpeed", 100))) or 100,
            "interval": round(float(d.get("baseAttackTime", 1.0) or 1.0), 3),
            "cost": int(round(d.get("cost", 0))),
            "block": int(round(d.get("blockCnt", 1))),
            "redeploy": int(round(d.get("respawnTime", 70))) or 70,
            "favor": favor,
            # ---- 以下只给详情页用，计算链路不读 ----
            "detail": rich,
        })

    ops.sort(key=lambda o: (-o["rarity"], o["name"]))
    print("operators from table: %d" % len(ops))

    # 分支：抓 PRTS（可复用 raw/branch_map.json 缓存）
    cache_path = os.path.join(RAW, "branch_map.json")
    branch_map = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            branch_map = json.load(f)

    def page_key(n):
        return PRTS_ALIAS.get(n, n)
    todo = [page_key(o["name"]) for o in ops if page_key(o["name"]) not in branch_map]
    if todo:
        print("fetching branches for %d operators from PRTS ..." % len(todo), flush=True)
        progress["total"] = len(todo)
        results = {}
        with ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(lambda n: fetch_branch(n, results), todo))
        for k, v in results.items():
            branch_map[k] = v
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(branch_map, f, ensure_ascii=False)

    missing = 0
    for o in ops:
        b = branch_map.get(page_key(o["name"]))
        if b and b.get("branch"):
            o["subProfession"] = b["branch"]
        else:
            missing += 1
    print("branch missing: %d" % missing)

    # PRTS 抓不到的那几个（集成战略专属干员没有独立页面）用游戏数据里的分支名兜底：
    # uniequip_table.subProfDict[subProfessionId].subProfessionName 就是中文分支名
    sub_prof = uniequip.get("subProfDict") or {}
    filled = 0
    for o in ops:
        if o["subProfession"]:
            continue
        sp = sub_prof.get(o["detail"].get("subProfessionId") or "") or {}
        name = sp.get("subProfessionName") or ""
        if name:
            o["subProfession"] = name
            filled += 1
    if filled:
        print("subProfession 用 subProfDict 兜底 %d 名" % filled)

    # 同名异格/不同版本只保留面板更高的一条，避免选择框里出现同名项
    seen_names = {}
    dedup = []
    for o in ops:
        k = o["name"]
        if k not in seen_names:
            seen_names[k] = len(dedup)
            dedup.append(o)
        else:
            i = seen_names[k]
            if (o["hp"] or 0) > (dedup[i]["hp"] or 0):
                dedup[i] = o
    log("dedupe: %d -> %d" % (len(ops), len(dedup)))
    ops = dedup

    # 统计，便于发现解析退化（技能/天赋/模组抓空时立刻能看出来）
    n_skill = sum(len(o["detail"]["skills"]) for o in ops)
    n_talent = sum(len(o["detail"]["talents"]) for o in ops)
    n_mod = sum(len(o["detail"]["modules"]) for o in ops)
    n_no_skill = sum(1 for o in ops if not o["detail"]["skills"])
    print("技能 %d 条，天赋 %d 条，模组 %d 个，无技能干员 %d 名"
          % (n_skill, n_talent, n_mod, n_no_skill))

    ranges = collect_ranges(ops, range_table)
    print("攻击范围 %d 种" % len(ranges))

    out_json = os.path.join(ROOT, "data", "operators.json")
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"operators": ops, "ranges": ranges}, f, ensure_ascii=False, indent=1)
    print("wrote data/operators.json (%d operators)" % len(ops))

    # 旧格式只用于调试比对：界面读的是 data/is6db.js 里的 operators 表
    if "--legacy-js" in sys.argv:
        with open(os.path.join(ROOT, "data", "operators.js"), "w", encoding="utf-8") as f:
            f.write("/* 自动生成：tools/build_operators.py --legacy-js。仅调试用，index.html 不加载。 */\n")
            f.write("window.OPERATOR_DATA = ")
            json.dump([{k: v for k, v in o.items() if k != "detail"} for o in ops],
                      f, ensure_ascii=False, separators=(",", ":"))
            f.write(";\n")
        print("wrote data/operators.js（legacy，index.html 不加载）")


if __name__ == "__main__":
    build()
