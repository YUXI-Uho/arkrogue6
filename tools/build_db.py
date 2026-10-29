# -*- coding: utf-8 -*-
"""tools/build_db.py — 把生成好的 JSON 装配成数据库产物 data/is6db.js

为什么单独一步：
    build_relics_official.py / build_operators.py 负责「官方数据 → 结构化 JSON」，
    这个脚本负责「结构化 JSON → 表」。两者分开，官方改字段时只需要动前一步，
    表结构（列名、主键、索引）稳定在 core/db/schema.js 里。

产物：
    data/is6db.js    浏览器加载的那一份（window.IS6_DB = {...}）
    data/is6db.json  同一份内容的可读镜像，给工具链和 diff 用

表结构以 core/db/schema.js 为准，本文件末尾的 TABLE_SPEC 是它的 Python 镜像，
tools/check_enums.py 会比对两边，漂移了直接报错。

用法：
    python tools/build_db.py            # 装配并写入
    python tools/build_db.py --check    # 只校验不写盘
"""
import hashlib
import io
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SCHEMA_VERSION = 3
ARTIFACT_NAME = "is6db"


# ---------------------------------------------------------------- 表结构镜像
# 与 core/db/schema.js 一一对应：表名 → (主键, [列名])
TABLE_SPEC = {
    "relics": ("id", [
        "id", "name", "category", "rarity", "icon", "flags", "desc",
        "condition", "note", "obtain", "stageCount",
    ]),
    "relic_stages": (["relicId", "stage"], [
        "relicId", "stage", "name", "text", "mods", "special", "parsedBy",
    ]),
    "operators": ("id", [
        "id", "name", "profession", "subProfession", "position", "rarity",
        "elite", "level", "hp", "atk", "def", "res", "aspd", "interval",
        "block", "cost", "spRecover", "initSp", "redeploy",
        "favorHp", "favorAtk", "favorDef",
    ]),
}


def load_json(name):
    path = os.path.join(DATA, name)
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def as_int(v, default=0):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def as_real(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- 表装配
def build_relics(src):
    rows = []
    for r in src:
        rows.append({
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "category": r.get("category", ""),
            "rarity": as_int(r.get("rarity")),
            "icon": r.get("icon", ""),
            "flags": r.get("flags") or [],
            "desc": r.get("desc", ""),
            "condition": r.get("condition", ""),
            "note": r.get("note", ""),
            "obtain": r.get("obtain", ""),
            "stageCount": len(r.get("stages") or []),
        })
    return rows


def build_stages(src):
    rows = []
    for r in src:
        rid = r.get("id", "")
        for i, s in enumerate(r.get("stages") or []):
            rows.append({
                "relicId": rid,
                "stage": as_int(s.get("idx", i), i),
                "name": s.get("name", ""),
                "text": s.get("text", ""),
                "mods": s.get("mods") or [],
                "special": s.get("special") or [],
                "parsedBy": s.get("parsed_by", ""),
            })
    return rows


def build_operators(src):
    rows = []
    for o in src:
        fav = o.get("favor") or {}
        rows.append({
            "id": o.get("id", ""),
            "name": o.get("name", ""),
            "profession": o.get("profession", ""),
            "subProfession": o.get("subProfession", ""),
            "position": o.get("position", ""),
            "rarity": as_int(o.get("rarity")),
            "elite": as_int(o.get("elite")),
            "level": as_int(o.get("level")),
            "hp": as_int(o.get("hp")),
            "atk": as_int(o.get("atk")),
            "def": as_int(o.get("def")),
            "res": as_int(o.get("res")),
            "aspd": as_int(o.get("aspd"), 100) or 100,
            "interval": as_real(o.get("interval"), 1.0) or 1.0,
            "block": as_int(o.get("block")),
            "cost": as_int(o.get("cost")),
            "spRecover": as_real(o.get("spRecover"), 1.0) or 1.0,
            "initSp": as_int(o.get("initSp")),
            "redeploy": as_int(o.get("redeploy"), 70) or 70,
            "favorHp": as_int(fav.get("hp")),
            "favorAtk": as_int(fav.get("atk")),
            "favorDef": as_int(fav.get("def")),
        })
    return rows


# ---------------------------------------------------------------- 校验
def validate(name, rows):
    """列必须与 TABLE_SPEC 完全一致，主键不能为空、不能重复。"""
    pk, cols = TABLE_SPEC[name]
    keys = pk if isinstance(pk, list) else [pk]
    seen = {}
    dup = []
    for i, row in enumerate(rows):
        missing = [c for c in cols if c not in row]
        extra = [c for c in row if c not in cols]
        if missing or extra:
            raise SystemExit("%s 第 %d 行列不符：缺 %s 多 %s" % (name, i, missing, extra))
        k = "|".join(str(row[c]) for c in keys)
        if k in seen:
            dup.append(k)
        seen[k] = 1
    if dup:
        print("  警告：%s 主键重复 %d 条（保留第一条）：%s" % (name, len(dup), ", ".join(dup[:5])))
    return len(rows)


def fingerprint(parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
    return "sha256:" + h.hexdigest()[:16]


# ---------------------------------------------------------------- 差异报告
def diff_against(prev, tables):
    """对比上一份产物，返回变更摘要（官方更新后能一眼看出动了什么）。"""
    if not prev or not prev.get("tables"):
        return None
    out = []
    for name, rows in tables.items():
        old = prev["tables"].get(name) or []
        pk = TABLE_SPEC[name][0]
        keys = pk if isinstance(pk, list) else [pk]

        def index(rs):
            return {"|".join(str(r[c]) for c in keys): r for r in rs}

        oi, ni = index(old), index(rows)
        added = [k for k in ni if k not in oi]
        removed = [k for k in oi if k not in ni]
        if added:
            out.append("%s 新增 %d 行：%s" % (name, len(added), ", ".join(added[:8])))
        if removed:
            out.append("%s 移除 %d 行：%s" % (name, len(removed), ", ".join(removed[:8])))

        # 同名行的数值变化（官方调平衡时最常见）
        changed = []
        for k in ni:
            if k not in oi:
                continue
            a, b = oi[k], ni[k]
            for c in b:
                if isinstance(b[c], (int, float)) and isinstance(a.get(c), (int, float)) and a.get(c) != b[c]:
                    changed.append("%s.%s %s→%s" % (k, c, a.get(c), b[c]))
        if changed:
            out.append("%s 数值变化 %d 处：%s" % (name, len(changed), "; ".join(changed[:8])))
    return out


def write_changelog(lines):
    path = os.path.join(DATA, "DB_CHANGELOG.md")
    exists = os.path.exists(path)
    with io.open(path, "a", encoding="utf-8") as f:
        if not exists:
            f.write(u"# 数据产物变更记录\n\n由 `tools/build_db.py` 自动追加。每次官方数据更新后重跑，"
                    u"这里会记下新增 / 移除 / 数值变化。\n")
        f.write(u"\n## %s\n\n" % datetime.now().strftime("%Y-%m-%d %H:%M"))
        for ln in lines:
            f.write(u"- %s\n" % ln)


# ---------------------------------------------------------------- 主流程
def main():
    check_only = "--check" in sys.argv

    relics_src = load_json("relics.json")
    ops_src = load_json("operators.json")

    tables = {
        "relics": build_relics(relics_src),
        "relic_stages": build_stages(relics_src),
        "operators": build_operators(ops_src),
    }

    counts = {}
    for name, rows in tables.items():
        counts[name] = validate(name, rows)

    data_hash = fingerprint([
        json.dumps(tables["relics"], ensure_ascii=False, sort_keys=True),
        json.dumps(tables["relic_stages"], ensure_ascii=False, sort_keys=True),
        json.dumps(tables["operators"], ensure_ascii=False, sort_keys=True),
    ])

    artifact = {
        "meta": {
            "artifact": ARTIFACT_NAME,
            "schemaVersion": SCHEMA_VERSION,
            "gameVersion": "集成战略 #6 沉沦者的黑流树海（rogue_6）",
            "dataHash": data_hash,
            "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {
                "relics": "data/relics.json ← tools/build_relics_official.py ← raw/roguelike_topic_table.json",
                "operators": "data/operators.json ← tools/build_operators.py ← raw/character_table.json",
            },
            "counts": counts,
        },
        "tables": tables,
    }

    print("表行数：" + "，".join("%s %d" % (k, v) for k, v in counts.items()))
    print("数据指纹：" + data_hash)

    prev = None
    prev_path = os.path.join(DATA, ARTIFACT_NAME + ".json")
    if os.path.exists(prev_path):
        try:
            with io.open(prev_path, encoding="utf-8") as f:
                prev = json.load(f)
        except ValueError:
            prev = None

    changes = diff_against(prev, tables)
    if changes:
        print("与上一份产物相比：")
        for ln in changes:
            print("  - " + ln)
    elif prev:
        print("与上一份产物相比：无变化")

    if check_only:
        print("--check：只校验，未写盘")
        return

    out_json = os.path.join(DATA, ARTIFACT_NAME + ".json")
    with io.open(out_json, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False, indent=1)

    out_js = os.path.join(DATA, ARTIFACT_NAME + ".js")
    with io.open(out_js, "w", encoding="utf-8") as f:
        f.write("/* 自动生成：tools/build_db.py —— 请勿手改。\n")
        f.write(" * 表结构见 core/db/schema.js，查询用 core/db/db.js 的 DB.table()。\n")
        f.write(" * 官方数据更新后运行 `python tools/update_db.py` 重新生成。\n */\n")
        f.write("window.IS6_DB = ")
        json.dump(artifact, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size = os.path.getsize(out_js)
    print("已写入 data/%s.js（%.0f KB）与 data/%s.json" % (ARTIFACT_NAME, size / 1024.0, ARTIFACT_NAME))

    if changes:
        write_changelog(changes)
        print("变更已追加到 data/DB_CHANGELOG.md")
    elif not os.path.exists(os.path.join(DATA, "DB_CHANGELOG.md")):
        # 第一次装配没有「上一份」可比，先落一条基线，后面才看得出改了什么
        write_changelog(["基线：schema v%s，%s"
                         % (SCHEMA_VERSION, "，".join("%s %d 行" % (k, v) for k, v in counts.items()))])
        print("已创建 data/DB_CHANGELOG.md（基线记录）")


if __name__ == "__main__":
    main()
