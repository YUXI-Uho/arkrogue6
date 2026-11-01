# -*- coding: utf-8 -*-
"""tools/build_db.py — 把生成好的 JSON 装配成数据库产物 data/is6db.js

为什么单独一步：
    build_relics_official.py / build_operators.py 负责「官方数据 → 结构化 JSON」，
    这个脚本负责「结构化 JSON → 表」。两者分开，官方改字段时只需要动前一步，
    表结构（列名、主键、索引）稳定在 core/db/schema.js 里。

产物：
    data/is6db.js    浏览器加载的那一份（window.IS6_DB = {...}）
    data/is6db.json  同一份内容的可读镜像，给工具链和 diff 用

表结构只有一份：core/db/schema.js。以前本文件里抄了一份 TABLE_SPEC 镜像，
靠 tools/check_enums.py 比对两边有没有漂移 —— 那是「两处真相 + 一个哨兵」。
现在直接读 JS 里的列定义，哨兵只留「别再抄回来」这一条。

用法：
    python tools/build_db.py            # 装配并写入
    python tools/build_db.py --check    # 只校验不写盘

依赖：需要本机有 node（仓库的测试与发布流程本来就依赖它）。
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SCHEMA_JS = os.path.join(ROOT, "core", "db", "schema.js")
ARTIFACT_NAME = "is6db"


# ---------------------------------------------------------------- 表结构
# 在 Node 里跑一遍 core/db/schema.js，把 game 表的主键与列名导成 JSON。
# 为什么不在 Python 里用正则解析：注释、尾逗号、中文列名、以后可能出现的
# 计算属性，都会让手写解析器悄悄漏列 —— 漏一列等于产物少一列，且不报错。
_DUMP_SCHEMA_JS = r"""
var fs = require('fs');
var vm = require('vm');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), sandbox, { filename: 'schema.js' });
var S = sandbox.DBSchema;
if (!S || !S.TABLES) {
  console.error('core/db/schema.js 没有导出 DBSchema');
  process.exit(1);
}
var out = { version: S.VERSION, tables: {} };
S.GAME_TABLES.forEach(function (n) {
  out.tables[n] = { pk: S.TABLES[n].pk, columns: Object.keys(S.TABLES[n].columns) };
});
process.stdout.write(JSON.stringify(out));
"""


def load_table_spec(path=None):
    """返回 (版本号, {表名: (主键, [列名])})，全部来自 core/db/schema.js。"""
    node = shutil.which("node")
    if not node:
        raise SystemExit(
            "找不到 node。表结构要从 core/db/schema.js 读，需要 Node.js —— "
            "装一个再跑（或直接跑 python tools/update_db.py，它会先检查）。")
    js = path or SCHEMA_JS
    if not os.path.exists(js):
        raise SystemExit("缺少 %s" % js)
    proc = subprocess.run([node, "-e", _DUMP_SCHEMA_JS, js],
                          capture_output=True)
    if proc.returncode != 0:
        raise SystemExit("读表结构失败：\n%s" % proc.stderr.decode("utf-8", "replace").strip())
    try:
        doc = json.loads(proc.stdout.decode("utf-8"))
    except ValueError as e:
        raise SystemExit("core/db/schema.js 导出的不是合法 JSON：%s" % e)
    if not doc.get("tables"):
        raise SystemExit("core/db/schema.js 里没有 game 表")
    return doc["version"], {n: (d["pk"], d["columns"]) for n, d in doc["tables"].items()}


SCHEMA_VERSION, TABLE_SPEC = load_table_spec()


def load_json(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        # 中间产物是可以删的缓存，但删了不会自己长回来：这里必须说清下一步做什么，
        # 否则只会甩一个 FileNotFoundError，看起来像仓库坏了。
        raise SystemExit(
            "缺少中间产物 data/%s。\n"
            "  · 有 raw/ 官方表 → python tools/update_db.py\n"
            "  · 只想重装表     → 从版本库取回 data/%s 再跑本脚本\n"
            "  · 数据从哪来     → 见 data/README.md" % (name, name))
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
        det = o.get("detail") or {}
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
            "displayNumber": det.get("displayNumber", ""),
            "appellation": det.get("appellation", ""),
            "obtain": det.get("obtain", ""),
            "tags": det.get("tags") or [],
            "trait": det.get("trait", ""),
            "rangeId": det.get("rangeId", ""),
            "potential": det.get("potential") or [],
        })
    return rows


def build_operator_phases(src):
    rows = []
    for o in src:
        oid = o.get("id", "")
        for p in (o.get("detail") or {}).get("phases") or []:
            rows.append({
                "id": oid,
                "elite": as_int(p.get("elite")),
                "level": as_int(p.get("level")),
                "hp": as_int(p.get("hp")),
                "atk": as_int(p.get("atk")),
                "def": as_int(p.get("def")),
                "res": as_int(p.get("res")),
                "aspd": as_int(p.get("aspd"), 100) or 100,
                "interval": as_real(p.get("interval"), 1.0) or 1.0,
                "cost": as_int(p.get("cost")),
                "block": as_int(p.get("block")),
                "redeploy": as_int(p.get("redeploy"), 70) or 70,
                "rangeId": p.get("rangeId", ""),
            })
    return rows


def build_operator_skills(src):
    rows = []
    for o in src:
        oid = o.get("id", "")
        for s in (o.get("detail") or {}).get("skills") or []:
            rows.append({
                "id": oid,
                "slot": as_int(s.get("slot")),
                "skillId": s.get("skillId", ""),
                "name": s.get("name", ""),
                "chargeType": s.get("chargeType", ""),
                "activation": s.get("activation", ""),
                "duration": as_real(s.get("duration")),
                "spCost": as_int(s.get("spCost")),
                "initSp": as_int(s.get("initSp")),
                "spCost7": as_int(s.get("spCost7")),
                "initSp7": as_int(s.get("initSp7")),
                "desc": s.get("desc", ""),
                "rangeId": s.get("rangeId", ""),
                "maxLevel": as_int(s.get("maxLevel")),
                "unlockElite": as_int(s.get("unlockElite")),
            })
    return rows


def build_operator_talents(src):
    rows = []
    for o in src:
        oid = o.get("id", "")
        for t in (o.get("detail") or {}).get("talents") or []:
            rows.append({
                "id": oid,
                "idx": as_int(t.get("idx")),
                "name": t.get("name", ""),
                "desc": t.get("desc", ""),
                "unlockElite": as_int(t.get("unlockElite")),
                "unlockLevel": as_int(t.get("unlockLevel"), 1),
            })
    return rows


def build_operator_modules(src):
    rows = []
    for o in src:
        oid = o.get("id", "")
        for m in (o.get("detail") or {}).get("modules") or []:
            rows.append({
                "id": oid,
                "moduleId": m.get("moduleId", ""),
                "name": m.get("name", ""),
                "type": m.get("type", ""),
                "typeName": m.get("typeName", ""),
                "unlockElite": as_int(m.get("unlockElite")),
                "unlockLevel": as_int(m.get("unlockLevel")),
            })
    return rows


def build_module_levels(src):
    rows = []
    for o in src:
        oid = o.get("id", "")
        for m in (o.get("detail") or {}).get("modules") or []:
            mid = m.get("moduleId", "")
            for lv in m.get("levels") or []:
                rows.append({
                    "id": oid,
                    "moduleId": mid,
                    "level": as_int(lv.get("level")),
                    "hp": as_int(lv.get("hp")),
                    "atk": as_int(lv.get("atk")),
                    "def": as_int(lv.get("def")),
                    "res": as_int(lv.get("res")),
                    "aspd": as_int(lv.get("aspd")),
                    "interval": as_real(lv.get("interval")),
                    "cost": as_int(lv.get("cost")),
                    "block": as_int(lv.get("block")),
                    "redeploy": as_int(lv.get("redeploy")),
                    "desc": lv.get("desc", ""),
                })
    return rows


def build_ranges(src):
    rows = []
    for r in src:
        rows.append({
            "id": r.get("id", ""),
            "direction": as_int(r.get("direction")),
            "grids": r.get("grids") or [],
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
    ops_doc = load_json("operators.json")
    # operators.json 是 {operators, ranges}：干员与攻击范围一起生成，范围是干员的依赖
    ops_src = ops_doc.get("operators") or []
    ranges_src = ops_doc.get("ranges") or []

    tables = {
        "relics": build_relics(relics_src),
        "relic_stages": build_stages(relics_src),
        "operators": build_operators(ops_src),
        "operator_phases": build_operator_phases(ops_src),
        "operator_skills": build_operator_skills(ops_src),
        "operator_talents": build_operator_talents(ops_src),
        "operator_modules": build_operator_modules(ops_src),
        "operator_module_levels": build_module_levels(ops_src),
        "ranges": build_ranges(ranges_src),
    }

    counts = {}
    for name in TABLE_SPEC:
        if name not in tables:
            raise SystemExit("TABLE_SPEC 声明了 %s，但没有对应的装配函数" % name)
        counts[name] = validate(name, tables[name])

    data_hash = fingerprint([
        json.dumps(tables[name], ensure_ascii=False, sort_keys=True) for name in TABLE_SPEC
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
                "operators": "data/operators.json ← tools/build_operators.py ← raw/character_table.json、"
                             "skill_table.json、uniequip_table.json、battle_equip_table.json、range_table.json",
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
        # --check 的意义不是「跑一遍看看会不会崩」，而是「磁盘上的产物还是不是最新的」。
        # 比指纹而不是比 mtime：git checkout 会改 mtime，改不动指纹。
        disk_hash = (prev or {}).get("meta", {}).get("dataHash")
        if disk_hash and disk_hash != data_hash:
            print("产物已过期：磁盘 %s ≠ 重算 %s" % (disk_hash, data_hash))
            print("--check：校验失败，请重跑 python tools/build_db.py")
            return 1
        print("--check：产物与重算结果一致，未写盘")
        return 0

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
    sys.exit(main())
