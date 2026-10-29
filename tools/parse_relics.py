# -*- coding: utf-8 -*-
"""把 PRTS 的收藏品 wikitext 解析成结构化 JSON。

输入: raw/relics_rogue6.wiki  (来自 https://prts.wiki/index.php?title=沉沦者的黑流树海/拟造物质编目&action=raw)
输出: data/relics_wiki.json（PRTS 文案与元数据，中间产物，由 build_relics_official.py 读取）
      注意：不再生成 data/relics_wiki.js —— 全库无人引用，纯死产物。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "raw", "relics_rogue6.wiki")
OUT_JSON = os.path.join(ROOT, "data", "relics_wiki.json")

CATEGORY_RE = re.compile(r"^==\s*No\.(\d{3})-(\d{3})\s*(.+?)==\s*$", re.M)


def find_templates(text):
    """返回所有 {{收藏品 ... }} 模板的 (start, end) 区间，括号配对。"""
    out = []
    for m in re.finditer(r"\{\{收藏品\s*\n", text):
        i = m.start()
        depth = 0
        j = i
        while j < len(text) - 1:
            if text.startswith("{{", j):
                depth += 1
                j += 2
                continue
            if text.startswith("}}", j):
                depth -= 1
                j += 2
                if depth == 0:
                    break
                continue
            j += 1
        out.append((i, j))
    return out


def split_params(body):
    """按顶层 |key=value 切分模板参数（值内可能含 {{...}} 与换行）。"""
    params = {}
    key = None
    buf = []
    depth = 0
    i = 0
    n = len(body)

    def flush():
        if key is not None:
            params[key] = "".join(buf).strip()

    while i < n:
        two = body[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            buf.append(two)
            i += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            buf.append(two)
            i += 2
            continue
        ch = body[i]
        if ch == "|" and depth <= 0:
            # 顶层分隔符
            nxt = body[i + 1:i + 40]
            m = re.match(r"\s*([^\n=|]{1,12})=", nxt)
            if m:
                flush()
                key = m.group(1).strip()
                buf = []
                i += 1 + m.end()
                continue
        buf.append(ch)
        i += 1
    flush()
    return params


def clean(v):
    if v is None:
        return ""
    v = v.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    v = re.sub(r"<!--.*?-->", "", v, flags=re.S)
    v = re.sub(r"<nowiki\s*/>", "", v)
    v = re.sub(r"<[^>]+>", "", v)          # 去掉 div/span 等标签
    v = v.replace("'''", "").replace("''", "")
    v = re.sub(r"\{\{color\|[^|]*\|([^}]*)\}\}", r"\1", v)
    v = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", v)
    v = v.replace("&nbsp;", " ")
    return v.strip()


def rarity_from_icon(icon):
    return icon


def main():
    with open(SRC, encoding="utf-8") as f:
        text = f.read()

    cats = [(m.start(), m.group(3).strip(), int(m.group(1)), int(m.group(2)))
            for m in CATEGORY_RE.finditer(text)]

    def category_of(pos):
        cur = "未分类"
        for start, name, _a, _b in cats:
            if start <= pos:
                cur = name
            else:
                break
        return cur

    relics = []
    for start, end in find_templates(text):
        body = text[start + len("{{收藏品"):end - 2]
        p = split_params(body)
        rid = p.get("ID", "").strip()
        if not re.fullmatch(r"\d{3}", rid):
            continue
        name_raw = p.get("名称", "")
        name = name_raw.split("|")[-1].strip() if "|" in name_raw else name_raw.strip()
        # 名称里偶尔带 "(收藏品)" 说明后缀
        name = re.sub(r"^[^|]*?\(收藏品\)\|", "", name)
        effect = clean(p.get("效果", ""))
        flags = []
        badge = p.get("角标", "")
        if "stack" in badge:
            flags.append("stack")
        if "notrade" in badge:
            flags.append("notrade")
        if "oneoff" in badge:
            flags.append("oneoff")
        if "dlc1" in badge:
            flags.append("dlc1")
        if "type_doghunt" in badge:
            flags.append("doghunt")
        # 四段式：结构化/半结构化/非结构化/混沌化
        tiers = []
        for line in effect.split("\n"):
            m = re.match(r"【(结构化|半结构化|非结构化|混沌化)】(.*)$", line.strip())
            if m:
                tiers.append({"stage": m.group(1), "text": m.group(2).strip()})
            elif line.strip():
                tiers.append({"stage": "", "text": line.strip()})
        relics.append({
            "id": rid,
            "name": name,
            "category": category_of(start),
            "rarity": int(p.get("稀有度", "0") or 0),
            "icon": p.get("iconId", "").strip(),
            "effect": effect,
            "tiers": tiers,
            "desc": clean(p.get("描述", "")),
            "condition": clean(p.get("条件", "")),
            "note": clean(p.get("备注", "")),
            "obtain": clean(p.get("获取", "")),
            "flags": flags,
        })

    relics.sort(key=lambda r: r["id"])
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(relics, f, ensure_ascii=False, indent=1)

    tiers_cnt = sum(1 for r in relics if any(t["stage"] for t in r["tiers"]))
    print("relics: %d, 四段式: %d" % (len(relics), tiers_cnt))
    cats_cnt = {}
    for r in relics:
        cats_cnt[r["category"]] = cats_cnt.get(r["category"], 0) + 1
    for k, v in cats_cnt.items():
        print("  %-8s %d" % (k, v))


if __name__ == "__main__":
    main()
