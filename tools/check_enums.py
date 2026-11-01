#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""枚举 / 属性注册表一致性校验。

背景：职业、分支、属性这三类「枚举」在仓库里同时存在于 JS 与 Python 两侧
    core/enums.js            PROFESSIONS / SUBPROFESSIONS
    core/schema.js           STATS（属性注册表）
    tools/build_relics_official.py   PROF_MAP / SUBPROF_MAP / STAT_MAP
    data/relics.json         各藏品 mods[].stat（数据侧实际用到的属性）
手工维护两份必然漂移，本脚本把它们对齐检查。

用法：
    python tools/check_enums.py           # 校验，有漂移则 exit 1
    python tools/check_enums.py -v        # 顺带打印清单

检查项：
    1. 职业：JS 的 PROFESSIONS 与 Python 的 PROF_MAP 取值集合一致
    2. 分支：JS 的 SUBPROFESSIONS 与 Python 的 SUBPROF_MAP 取值集合一致
    3. 属性：data/relics.json 里出现的每个 stat 都必须在 core/schema.js 注册
       （否则引擎会静默丢弃该修正项 —— 这是历史上真实踩过的坑）
    4. 属性：core/schema.js 里 bucket='panel' 且 settles!=False 的 key，
       必须能被 engine 结算（通过 js/engine.js 里出现 final.<key> 判断，弱校验）
    5. 表结构：core/db/schema.js 与 tools/build_db.py 的表名/主键/列一致
    6. 产物：data/is6db.json 的列、行数、主键与 meta.counts 自洽
    7. 入口：index.html 的资源标签版本串一致、文件都在
    8. 后端：server/ 读同一份表产物，面板字段从 schema 派生（不许再抄一份）
    9. 覆盖表：data/overrides/relics.json 存在且没被写回构建脚本的字面量
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv

problems = []
warnings = []


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def js_string_array(src, var_name):
    """从 JS 源码里抓 `var NAME = ['a','b', ...]` 的字符串元素。"""
    m = re.search(r"var\s+%s\s*=\s*\[(.*?)\]" % re.escape(var_name), src, re.S)
    if not m:
        return None
    return re.findall(r"'([^']*)'", m.group(1))


def py_dict_values(src, var_name):
    m = re.search(r"^%s\s*=\s*\{(.*?)^\}" % re.escape(var_name), src, re.S | re.M)
    if not m:
        return None
    body = m.group(1)
    return re.findall(r":\s*\"([^\"]+)\"", body)


def js_stat_keys(src):
    """从 core/schema.js 的 STATS 里抓 key 与 bucket/settles。

    逐条切分而不是整体正则：每个条目形如
        { key: 'hp', label: '生命', bucket: B.PANEL, ...,
          alias: [...] },
    以 `{ key: '` 为切点，每段就是一条记录的正文。
    """
    stats = []
    # 先剥掉 // 行注释：schema.js 里 spCost 上方有一行注释写着 "settles:false"，
    # 不剥离的话它会被算进上一条（redeploy）的正文，导致 redeploy 被误判为不可结算。
    clean = re.sub(r"//[^\n]*", "", src)
    chunks = re.split(r"\{\s*key:\s*'", clean)
    for chunk in chunks[1:]:
        key = chunk.split("'", 1)[0]
        body = chunk[:600]          # 一条记录不会超过这个长度
        bucket = re.search(r"bucket:\s*B\.(\w+)", body)
        settles = re.search(r"settles:\s*(true|false)", body)
        stats.append({
            "key": key,
            "bucket": bucket.group(1).lower() if bucket else "?",
            "settles": (settles.group(1) != "false") if settles else True,
        })
    return stats


def diff(label, js_set, py_set):
    only_js = sorted(js_set - py_set)
    only_py = sorted(py_set - js_set)
    if only_js:
        problems.append("%s：只在 core/enums.js 里有 → %s" % (label, "、".join(only_js)))
    if only_py:
        problems.append("%s：只在 tools/ 里有 → %s" % (label, "、".join(only_py)))
    if VERBOSE and not only_js and not only_py:
        print("  [ok] %s 一致（%d 项）" % (label, len(js_set)))


# ---------------------------------------------------------------- 表结构
def strip_js_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def brace_block(src, open_idx):
    """从 open_idx 处的 '{' 开始做花括号配对，返回完整块（含两端花括号）。"""
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx:i + 1]
    return src[open_idx:]


def parse_table_block(blk):
    kind = re.search(r"kind:\s*'(\w+)'", blk)
    pkm = re.search(r"pk:\s*('(\w+)'|\[([^\]]*)\])", blk)
    if not pkm:
        return {"kind": None, "pk": [], "columns": []}
    pk = [pkm.group(2)] if pkm.group(2) else re.findall(r"'([^']+)'", pkm.group(3))
    colm = re.search(r"columns:\s*\{(.*?)\n\s*\}", blk, re.S)
    cols = re.findall(r"(\w+):\s*'(text|int|real|bool|json)'", colm.group(1)) if colm else []
    return {"kind": kind.group(1) if kind else None,
            "pk": pk,
            "columns": [c for c, _ in cols]}


def js_tables(src):
    """解析 core/db/schema.js 的 TABLES 字面量 → {表名: {kind, pk, columns}}。

    顶层表定义缩进 4 空格（`    relics: {`），据此切分再做花括号配对，
    不用整段正则去猜嵌套 —— 列定义里本来就有花括号外的引号和注释。
    """
    clean = strip_js_comments(src)
    m = re.search(r"var\s+TABLES\s*=\s*\{", clean)
    if not m:
        return {}
    body = clean[m.start():]
    out = {}
    for tm in re.finditer(r"^    (\w+):\s*\{", body, re.M):
        open_idx = body.index("{", tm.end() - 1)
        out[tm.group(1)] = parse_table_block(brace_block(body, open_idx))
    return out


def check_schema():
    """表结构只能有一份：core/db/schema.js。

    以前 build_db.py 里抄了一份 TABLE_SPEC 镜像，这里逐列比对两边。
    现在镜像没了（build_db 直接在 Node 里读 schema.js），比对项也随之撤掉 ——
    留下来的只有「别再抄回来」和「产物确实是按 schema 装配的」两条。
    """
    print("== 5. 表结构单一来源 ==")
    js_src = read("core/db/schema.js")
    py_src = read("tools/build_db.py")

    if re.search(r"^TABLE_SPEC\s*=\s*\{", py_src, re.M):
        problems.append("tools/build_db.py 又硬编码了 TABLE_SPEC 字面量，应改调 load_table_spec()")
    if "load_table_spec(" not in py_src:
        problems.append("tools/build_db.py 没有从 core/db/schema.js 读表结构")
    if re.search(r"^SCHEMA_VERSION\s*=\s*\d+", py_src, re.M):
        problems.append("tools/build_db.py 又硬编码了 SCHEMA_VERSION，版本号只在 schema.js 的 VERSION 里写")

    tables = js_tables(js_src)
    if not tables:
        problems.append("core/db/schema.js 里解析不到 TABLES（正则可能失效）")
        return
    game = sorted(n for n, d in tables.items() if d["kind"] == "game")

    # 产物里的表必须与 schema 的 game 表一一对应，列顺序也要一致：
    # 列顺序变了 dataHash 就变，靠这条能发现「改了 schema 但没重建」。
    art = json.load(io.open(os.path.join(DATA, "is6db.json"), encoding="utf-8"))
    built = art.get("tables") or {}
    if sorted(built) != game:
        problems.append("产物表清单与 schema 不一致：产物=%s，schema=%s"
                        % ("、".join(sorted(built)), "、".join(game)))
    for name in game:
        if name not in built or not built[name]:
            continue
        cols = list(built[name][0].keys())
        if cols != tables[name]["columns"]:
            problems.append("%s 列与 schema 不符（产物可能没重建）：产物=%s，schema=%s"
                            % (name, ",".join(cols), ",".join(tables[name]["columns"])))
        elif VERBOSE:
            print("  [ok] %s  %d 列  主键 %s"
                  % (name, len(cols), "+".join(tables[name]["pk"])))

    # 产物里的 schemaVersion 必须来自 schema.js，不能是另一处手写常量
    js_ver = re.search(r"var\s+VERSION\s*=\s*(\d+)", js_src)
    if js_ver and str(art.get("meta", {}).get("schemaVersion")) != js_ver.group(1):
        problems.append("产物 schemaVersion=%s，schema.js VERSION=%s（没重建？）"
                        % (art.get("meta", {}).get("schemaVersion"), js_ver.group(1)))

    # 存档版本 == 表结构版本：两处各写一份必然漂移，这里钉住
    mig = read("core/db/migrate.js")
    if "VERSION = S.VERSION" not in mig:
        warnings.append("core/db/migrate.js 未直接复用 DBSchema.VERSION，请确认版本号来源一致")


def check_artifact():
    """data/is6db.json 与 TABLE_SPEC / meta.counts 自洽，且不比源数据旧。"""
    print("== 6. 产物自洽 ==")
    art_path = os.path.join(DATA, "is6db.json")
    if not os.path.exists(art_path):
        problems.append("data/is6db.json 不存在，请运行 python tools/update_db.py")
        return
    with open(art_path, encoding="utf-8") as f:
        art = json.load(f)

    meta = art.get("meta") or {}
    tables = art.get("tables") or {}
    # 列定义取自 schema.js —— build_db.py 里已经没有镜像可读了
    schema = js_tables(read("core/db/schema.js"))
    spec = {n: (d["pk"], d["columns"]) for n, d in schema.items() if d["kind"] == "game"}

    js_ver = re.search(r"var\s+VERSION\s*=\s*(\d+)", read("core/db/schema.js"))
    if js_ver and meta.get("schemaVersion") != int(js_ver.group(1)):
        problems.append("产物版本 %s 与 schema.js VERSION %s 不一致，请重新生成"
                        % (meta.get("schemaVersion"), js_ver.group(1)))

    if not re.match(r"^sha256:[0-9a-f]{16}$", str(meta.get("dataHash", ""))):
        problems.append("产物缺少数据指纹 dataHash（应为 sha256:16 位十六进制）")

    counts = meta.get("counts") or {}
    for name, (pk, cols) in spec.items():
        rows = tables.get(name)
        if not isinstance(rows, list):
            problems.append("产物缺少表 %s" % name)
            continue
        if counts.get(name) != len(rows):
            problems.append("%s 行数：meta 声明 %s，实际 %d"
                            % (name, counts.get(name), len(rows)))
        bad = [r for r in rows if sorted(r) != sorted(cols)]
        if bad:
            problems.append("%s 有 %d 行的列与 TABLE_SPEC 不符（首个：%s）"
                            % (name, len(bad), "、".join(sorted(bad[0]))))
        keys = [tuple(str(r.get(k, "")) for k in pk) for r in rows]
        if len(set(keys)) != len(keys):
            problems.append("%s 存在重复主键（%d 行 / %d 个主键）"
                            % (name, len(keys), len(set(keys))))
        if VERBOSE:
            print("  [ok] %s  %d 行" % (name, len(rows)))

    # 源数据比产物新 → 忘了重新装配
    src_files = ["relics.json", "operators.json"]
    for src in src_files:
        p = os.path.join(DATA, src)
        if os.path.exists(p) and os.path.getmtime(p) > os.path.getmtime(art_path) + 1:
            warnings.append("data/%s 比 is6db.json 新，产物可能过期（python tools/update_db.py）" % src)



def check_assets():
    """index.html 引用的资源必须都存在，且带同一个 ?v= 版本串。

    部署后最常见的两种事故都在这里：
      - 忘了上传某个文件 → 运行时 404，界面白屏或少了模块
      - 部分文件被 CDN 缓存住 → 新旧代码混跑，症状千奇百怪
    所以入口里的每个标签都必须版本串一致，且文件都在磁盘上。
    """
    print("== 7. 入口资源 ==")
    html = read("index.html")
    # 所有 <script src> 与 <link href> 都算：图标、manifest、样式表一样会被 CDN 缓存
    pairs = re.findall(r'<script[^>]+src="([^"]+)"|<link[^>]+href="([^"]+)"', html)
    refs = [a or b for a, b in pairs]
    if not refs:
        problems.append("index.html 里解析不到任何 script / stylesheet 引用（正则可能失效）")
        return

    versions = {}
    missing = []
    for ref in refs:
        path, _, qs = ref.partition("?")
        m = re.search(r"(?:^|&)v=([^&]+)", qs)
        key = m.group(1) if m else "(无版本串)"
        versions.setdefault(key, []).append(path)
        if not os.path.exists(os.path.join(ROOT, path)):
            missing.append(path)

    if missing:
        problems.append("index.html 引用的文件不存在 → %s" % "、".join(sorted(set(missing))))
    if "(无版本串)" in versions:
        problems.append("以下资源没带 ?v= 版本串，部署后可能被缓存住 → %s"
                        % "、".join(versions["(无版本串)"]))
    real = [k for k in versions if k != "(无版本串)"]
    if len(real) > 1:
        detail = "；".join("%s ← %s" % (k, "、".join(v)) for k, v in versions.items()
                          if k != "(无版本串)")
        problems.append("index.html 里存在多个版本串，会新旧混跑 → %s" % detail)

    # 界面脚本与测试桩的加载清单必须一致，否则测试通过但线上挂
    smoke = read("tests/app.smoke.js")
    fm = re.search(r"const FILES = \[(.*?)\];", smoke, re.S)
    if fm:
        tested = re.findall(r"'([^']+)'", fm.group(1))
        declared = [r.partition("?")[0] for r in refs if r.endswith(".js") or ".js?" in r]
        if tested != declared:
            only_html = [f for f in declared if f not in tested]
            only_test = [f for f in tested if f not in declared]
            problems.append("tests/app.smoke.js 的加载顺序与 index.html 不一致"
                            + ("（只在 index.html：%s）" % "、".join(only_html) if only_html else "")
                            + ("（只在测试：%s）" % "、".join(only_test) if only_test else ""))

    if VERBOSE:
        print("  [ok] %d 个资源引用，版本串 %s，文件全部存在"
              % (len(refs), "、".join(real) if real else "缺失"))


def check_server():
    """后端必须与前端读同一份表产物，且面板字段从 schema 派生。

    这两条都是真实踩过的坑：
      - server/engine.js 自己写了一份 PANEL_KEYS 数组、server/validate.js 又写了一份
        PANEL_RANGE，和 core/schema.js 三份并存。新增属性时前端会算、后端静默丢，
        而本脚本当时只比 JS↔Python，看不见 server/。
      - 数据侧直接 require data/relics.json + operators.json（中间产物），
        只重装表、没重跑 build_operators.py 时，前后端会算出不同结果。
    """
    print("== 8. 后端数据源 ==")
    eng = strip_js_comments(read("server/engine.js"))
    val = strip_js_comments(read("server/validate.js"))

    if re.search(r"PANEL_KEYS\s*=\s*\[", eng):
        problems.append("server/engine.js 硬编码了 PANEL_KEYS 数组，应改为复用 core/schema.js")
    if "is6db.json" not in eng:
        problems.append("server/engine.js 没有读 data/is6db.json（应与前端同一份表产物）")
    for src in ("relics.json", "operators.json"):
        if src in eng:
            problems.append("server/engine.js 直接引用了 data/%s（中间产物），应改读表产物" % src)
    if "SETTLED_KEYS" not in val and "PANEL_KEYS" not in val:
        problems.append("server/validate.js 的面板字段没有从 ArkSchema 派生")
    if VERBOSE and not problems:
        print("  [ok] 后端读表产物，面板字段来自 ArkSchema")


def check_overrides():
    """覆盖表必须是数据文件，不能又长回 Python 字面量。

    抽出去的理由不是「好看」：OVERRIDES 是唯一一处「人写数值」的地方，
    埋在 1000 行的构建脚本中间，改一条要读代码、缩进错了整份构建就崩。
    抽成 JSON 后 diff 干净、非程序员也能改，但很容易在下次改动时图省事又写回去。
    """
    print("== 9. 藏品覆盖表 ==")
    path = "data/overrides/relics.json"
    if not os.path.exists(os.path.join(ROOT, path)):
        problems.append("缺少 %s（21 条人工覆盖在这里）" % path)
        return
    try:
        with io.open(os.path.join(ROOT, path), encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:                      # noqa: BLE001 —— 就是要报任何解析错
        problems.append("%s 解析失败：%s" % (path, e))
        return
    if not isinstance(data, dict) or not data:
        problems.append("%s 顶层应为非空对象 {藏品 id: [修正项]}" % path)
        return
    bad = [k for k, v in data.items() if not isinstance(v, list) or not v]
    if bad:
        problems.append("%s 里这些 id 的值不是非空数组：%s" % (path, "、".join(bad[:5])))

    src = read("tools/build_relics_official.py")
    if re.search(r"^OVERRIDES\s*=\s*\{", src, re.M):
        problems.append("tools/build_relics_official.py 又硬编码了 OVERRIDES 字面量，应改读 %s" % path)
    if "load_overrides" not in src:
        problems.append("tools/build_relics_official.py 没有走 load_overrides 读覆盖表")
    if VERBOSE and not problems:
        print("  [ok] 覆盖表 %d 条，构建脚本从 JSON 读" % len(data))


def check_cache_direction():
    """中间产物是缓存，不能变成源。

    数据流是 raw/ → relics.json / operators.json → is6db.js → 界面。
    一旦有人让 build_relics_official.py 去「读上一版 relics.json 做增量」，
    缓存就同时是输入和输出，改错一次就再也回不到干净状态 —— 这条守着方向。
    """
    print("== 10. 中间产物是缓存 ==")
    pairs = [("tools/build_relics_official.py", "relics.json"),
             ("tools/build_operators.py", "operators.json")]
    for script, cache in pairs:
        src = read(script)
        bad = []
        for i, line in enumerate(src.split("\n"), 1):
            if cache not in line or line.lstrip().startswith("#"):
                continue
            if "overrides" in line:              # data/overrides/relics.json 是另一回事
                continue
            # 只认「这一行真的在开文件」：文档字符串、print、路径拼接都不算
            if not re.search(r"\b(open|load|load_json|loads)\s*\(", line):
                continue
            if '"w"' in line or "'w'" in line:    # 写模式
                continue
            bad.append(i)
        if bad:
            problems.append("%s 第 %s 行疑似读中间产物 %s —— 缓存只能是输出"
                            % (script, "、".join(str(n) for n in bad[:3]), cache))
        elif VERBOSE:
            print("  [ok] %s 只写 %s" % (script, cache))

    # 旧格式产物（--legacy-js）是调试用的一次性文件，不该留在 data/ 里被误认成数据
    for stale in ("relics.js", "operators.js"):
        if os.path.exists(os.path.join(DATA, stale)):
            problems.append("data/%s 是 --legacy-js 的调试产物，删掉它（界面不加载）" % stale)

    if not os.path.exists(os.path.join(DATA, "README.md")):
        problems.append("缺少 data/README.md：中间产物与产物的区别得写在它旁边，"
                        "不然下一个人只能靠猜")
    elif VERBOSE and not problems:
        print("  [ok] data/ 下无旧格式残留，说明文档在")


def main():
    enums_js = read("core/enums.js")
    schema_js = read("core/schema.js")
    relics_build = read("tools/build_relics_official.py")
    ops_build = read("tools/build_operators.py")

    print("== 1/2. 职业与分支 ==")
    js_prof = js_string_array(enums_js, "PROFESSIONS")
    js_sub = js_string_array(enums_js, "SUBPROFESSIONS")
    py_prof_a = py_dict_values(relics_build, "PROF_MAP") or []
    py_prof_b = py_dict_values(ops_build, "PROFESSION_CN") or []
    py_sub = py_dict_values(relics_build, "SUBPROF_MAP") or []

    if js_prof is None:
        problems.append("core/enums.js 里找不到 PROFESSIONS")
    if js_sub is None:
        problems.append("core/enums.js 里找不到 SUBPROFESSIONS")

    if js_prof is not None:
        py_prof = set(py_prof_a) | set(py_prof_b)
        diff("职业", set(js_prof), py_prof)
        # PROF_MAP 里键有大小写两套，取值集合应当只有 8 个
        if len(set(py_prof_a)) not in (0, 8):
            warnings.append("PROF_MAP 的中文取值有 %d 种（预期 8 种）" % len(set(py_prof_a)))

    if js_sub is not None and py_sub:
        # 分支是「包含」关系而不是相等：Python 侧只是官方数据里用到的子集，
        # JS 侧要覆盖全部（文案解析需要认识所有分支名）。
        # 因此只有「Python 有、JS 没有」才是问题。
        missing_sub = sorted(set(py_sub) - set(js_sub))
        if missing_sub:
            problems.append("分支：tools/ 里有、core/enums.js 缺 → %s" % "、".join(missing_sub))
        if VERBOSE:
            print("  [ok] 分支：Python 侧 %d 项全部被 JS 覆盖（JS 共 %d 项）"
                  % (len(set(py_sub)), len(set(js_sub))))
    elif js_sub is not None:
        warnings.append("tools/build_relics_official.py 里找不到 SUBPROF_MAP，跳过分支校验")

    print("== 3. 数据侧属性是否都已注册 ==")
    data_path = os.path.join(ROOT, "data", "relics.json")
    used = set()
    if os.path.exists(data_path):
        with open(data_path, encoding="utf-8") as f:
            root = json.load(f)
        # relics.json 可能是裸数组，也可能是 {theme, relics:[...]} 包装
        relic_list = root.get("relics", []) if isinstance(root, dict) else root
        for r in relic_list:
            for st in r.get("stages", []):
                for mod in st.get("mods", []):
                    if mod.get("stat"):
                        used.add(mod["stat"])
    else:
        warnings.append("data/relics.json 不存在，跳过数据侧校验")

    stats = js_stat_keys(schema_js)
    registered = {s["key"] for s in stats}
    if not registered:
        problems.append("core/schema.js 里解析不到任何 STATS.key（正则可能失效）")
    missing = sorted(used - registered)
    if missing:
        problems.append("数据里有、schema 里没注册（会被引擎静默丢弃）→ %s" % "、".join(missing))
    unused = sorted(registered - used)
    if VERBOSE:
        print("  数据侧使用 %d 个属性，schema 注册 %d 个" % (len(used), len(registered)))
        if unused:
            print("  schema 里注册但数据暂未使用：%s" % "、".join(unused))

    print("== 4. 声明可结算的属性是否有结算分支 ==")
    engine_js = read("js/engine.js")
    # 引擎里 hp/atk/def 是通过 ['hp','atk','def'].forEach(... final[k] = ...) 批量算的，
    # 单独查 final.hp 会误报。这里把「被 forEach 遍历且循环体写 final[k]」的 key 也认作有结算。
    loop_keys = set()
    if re.search(r"final\[k\]", engine_js):
        for lst in re.findall(r"\[([^\[\]]*)\]\.forEach", engine_js):
            loop_keys |= set(re.findall(r"'([^']+)'", lst))

    for s in stats:
        if s["bucket"] != "panel" or not s["settles"]:
            continue
        key = re.escape(s["key"])
        # 必须是「赋值」而不是「引用」：delta.redeploy = final.redeploy - redeployB
        # 里的 final.redeploy 只是读取，不能算作有结算分支。
        pattern = r"final(?:\.%s\s*=[^=]|\[['\"]%s['\"]\]\s*=[^=])" % (key, key)
        if re.search(pattern, engine_js) or s["key"] in loop_keys:
            continue
        problems.append("schema 声明 %s 可结算，但 js/engine.js 里找不到 `final.%s =` 赋值"
                        % (s["key"], s["key"]))

    check_schema()
    check_artifact()
    check_assets()
    check_server()
    check_overrides()
    check_cache_direction()

    print()
    if warnings:
        for w in warnings:
            print("  [warn] %s" % w)
    if problems:
        print("发现 %d 处不一致：" % len(problems))
        for p in problems:
            print("  ✗ %s" % p)
        return 1
    print("枚举与属性注册表一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
