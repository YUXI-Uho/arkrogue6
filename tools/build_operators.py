# -*- coding: utf-8 -*-
"""构建内置干员数据库。

数据来源：
  1. 游戏数据表 character_table.json（Kengxxiao/ArknightsGameData，zh_CN）
     → 精英化满级面板、信赖加成、职业、星级、攻击间隔、费用、阻挡
  2. PRTS 明日方舟 Wiki 每个干员页面的 {{CharinfoV2}} → 中文「分支」名
     （游戏数据里只有 subProfessionId 英文 id，没有中文分支名）

输出：data/operators.json
      （浏览器不再直接读这份 JSON —— 它先由 tools/build_db.py 装配成
       data/is6db.js 的表。加 --legacy-js 可额外吐一份 window.OPERATOR_DATA
       的旧格式文件，仅供调试比对。）
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

lock = threading.Lock()
progress = {"done": 0, "total": 0}


def log(msg):
    print(msg, flush=True)


def download(name):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, name)
    if os.path.exists(path) and os.path.getsize(path) > 10000:
        return path
    last_err = None
    for base in CDN_MIRRORS:
        try:
            req = urllib.request.Request(base + name, headers=UA)
            resp = urllib.request.urlopen(req, timeout=60)
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            with open(path + ".part", "wb") as f:
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total and got % (2 * 1024 * 1024) < 262144:
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


def pick_phase(op):
    phases = op.get("phases") or []
    best = None
    for idx, ph in enumerate(phases):
        frames = ph.get("attributesKeyFrames") or []
        if frames:
            best = (idx, ph, frames[-1])
    return best


def build():
    ct_path = download("character_table.json")
    with open(ct_path, encoding="utf-8") as f:
        table = json.load(f)

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
            favor = {"hp": fd.get("maxHp", 0), "atk": fd.get("atk", 0), "def": fd.get("def", 0)}
        tier = c.get("rarity", "TIER_0")
        # character_table 里 TIER_n 就是 n 星（Lancet-2 = TIER_1 = 1 星）
        stars = int(tier.split("_")[-1]) if tier.startswith("TIER_") else 1
        ops.append({
            "id": cid,
            "name": c["name"],
            "profession": PROFESSION_CN[c["profession"]],
            "subProfession": "",
            "position": "近战位" if c.get("position") == "MELEE" else "远程位",
            "rarity": stars,
            "elite": phase_idx,
            "level": frame.get("level", 0),
            "hp": d.get("maxHp", 0),
            "atk": d.get("atk", 0),
            "def": d.get("def", 0),
            "res": d.get("magicResistance", 0),
            "interval": d.get("baseAttackTime", 1.0),
            "cost": d.get("cost", 0),
            "block": d.get("blockCnt", 1),
            "redeploy": d.get("respawnTime", 70),
            "favor": favor,
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

    out_json = os.path.join(ROOT, "data", "operators.json")
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(ops, f, ensure_ascii=False, indent=1)
    print("wrote data/operators.json (%d operators)" % len(ops))

    # 旧格式只用于调试比对：界面读的是 data/is6db.js 里的 operators 表
    if "--legacy-js" in sys.argv:
        with open(os.path.join(ROOT, "data", "operators.js"), "w", encoding="utf-8") as f:
            f.write("/* 自动生成：tools/build_operators.py --legacy-js。仅调试用，index.html 不加载。 */\n")
            f.write("window.OPERATOR_DATA = ")
            json.dump(ops, f, ensure_ascii=False, separators=(",", ":"))
            f.write(";\n")
        print("wrote data/operators.js（legacy，index.html 不加载）")


if __name__ == "__main__":
    build()
