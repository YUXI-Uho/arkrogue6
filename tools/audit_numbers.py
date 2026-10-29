# -*- coding: utf-8 -*-
"""数字对账：文案里出现的每个数字，是否都能在结构化修正项里找到落点。

对不上的分三类：
  MISS   数值没有对应修正项（可能是真漏了，也可能是纯行为描述）
  COND   只出现在条件/时长里（如「3 秒」「最多 5 层」），属正常
  NONE   文案里的数字完全没有被引用

用法：python tools/audit_numbers.py [--all]
"""
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")


def cond_numbers(cond):
    out = set()
    if not cond:
        return out
    for k in ("sec", "per", "cap", "n", "pct", "min", "value"):
        if isinstance(cond.get(k), (int, float)):
            out.add(round(float(cond[k]), 4))
    # 条件文案里写到的数字（「持续 3 秒」「最多 5 层」）也算被记录
    for n in NUM_RE.findall(cond.get("label") or ""):
        out.add(round(float(n), 4))
    for c in cond.get("of") or []:
        out |= cond_numbers(c)
    return out


def main():
    show_all = "--all" in sys.argv
    relics = json.load(open(os.path.join(ROOT, "data", "relics.json"), encoding="utf-8"))
    rows = []
    for r in relics:
        for st in r["stages"]:
            text = st.get("text") or ""
            mods = st.get("mods") or []
            if not text or not mods:
                continue
            nums = set(round(float(x), 4) for x in NUM_RE.findall(text))
            if not nums:
                continue
            hit = set()
            for m in mods:
                v = abs(float(m.get("value") or 0))
                hit.add(round(v, 4))
                # 「提升至 140%」在数据里记成 +40%（增量），对账时两种口径都认
                hit.add(round(100 - v, 4))
                hit.add(round(100 + v, 4))
                hit |= cond_numbers(m.get("cond"))
            missing = sorted(n for n in nums if n not in hit)
            if missing:
                rows.append((r["id"], r["name"], st["name"], text, missing,
                             [m["stat"] for m in mods]))
    print("文案有数字但未对上的藏品阶段：%d" % len(rows))
    for rid, name, stage, text, missing, stats in rows:
        if not show_all and len(rows) > 0:
            pass
        print("\n%s %s%s | %s" % (rid, name, ("·" + stage) if stage else "", text[:78]))
        print("   未对上: %s | 已有: %s" % (missing, stats))


if __name__ == "__main__":
    main()
