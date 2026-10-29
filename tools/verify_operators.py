# -*- coding: utf-8 -*-
"""交叉校验：把 subagent 抓的 PRTS 逐页数据（draft A/B）和 character_table 生成的库对比。"""
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FIELDS = ["hp", "atk", "def", "res", "interval", "cost", "block", "redeploy"]


def load(name):
    p = os.path.join(ROOT, "data", name)
    if not os.path.exists(p):
        p = os.path.join(ROOT, "raw", name)
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    doc = load("operators.json")
    # data/operators.json 是 {operators, ranges}；兼容旧格式（纯数组）
    ops = doc.get("operators") if isinstance(doc, dict) else doc
    main_db = {o["name"]: o for o in (ops or [])}
    drafts = load("operators_draft_A.json") + load("operators_draft_B.json")
    if not drafts:
        print("没有 draft 数据，跳过")
        return
    bad = 0
    for d in drafts:
        if "error" in d:
            print("  ! %s 抓取失败: %s" % (d.get("name"), d["error"]))
            continue
        m = main_db.get(d["name"])
        if not m:
            print("  ? %s 不在主库里" % d["name"])
            continue
        diffs = []
        for f in FIELDS:
            if f in d and abs(float(d[f]) - float(m[f])) > 0.001:
                diffs.append("%s: PRTS=%s 库=%s" % (f, d[f], m[f]))
        for f, key in (("hp", "hp"), ("atk", "atk"), ("def", "def")):
            if d.get("favor") and abs(float(d["favor"][key]) - float(m["favor"][key])) > 0.001:
                diffs.append("信赖%s: PRTS=%s 库=%s" % (key, d["favor"][key], m["favor"][key]))
        if diffs:
            bad += 1
            print("  ✗ %s: %s" % (d["name"], "; ".join(diffs)))
        else:
            print("  ✓ %s 一致" % d["name"])
    print("\n对比 %d 条，不一致 %d 条" % (len(drafts), bad))


if __name__ == "__main__":
    main()
