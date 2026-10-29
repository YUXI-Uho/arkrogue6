# -*- coding: utf-8 -*-
"""藏品数据自检：用官方 usage 文案反查结构化 mods 的对象/作用域是否对得上。

检查项：
  A. 文案点名了职业（先锋/近卫/…），但 mods 没有职业作用域
  B. mods 有职业作用域，但文案点的是另一个职业
  C. 文案是「敌方/敌人」，mods 却是我方面板
  D. 文案是「初始部署费用」，mods 却是干员 cost
  E. 文案提到伤害，但没有伤害类修正项
  F. mods 出现 0 值
  G. 文案提到近战/远程/地面/高台，但 mods 没有位置作用域
用法：python tools/audit_relics.py
"""
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROFS = ["先锋", "近卫", "重装", "狙击", "术师", "医疗", "辅助", "特种"]
DMG = {"physTaken", "magicTaken", "trueTaken", "dmgReduce", "atkScale", "damage", "weak", "firstHit", "elemental"}


def main():
    relics = json.load(open(os.path.join(ROOT, "data", "relics.json"), encoding="utf-8"))
    issues = []
    infos = []

    for r in relics:
        for st in r["stages"]:
            text = st.get("text") or ""
            mods = st.get("mods") or []
            if not mods:
                continue
            tag = "%s %s" % (r["id"], r["name"])
            if len(r["stages"]) > 1:
                tag += "·" + st["name"]

            plain = re.sub(r"[【\[][^】\]]*[】\]]", "", text)
            mentioned = [p for p in PROFS if p in plain]
            scoped = set()
            for m in mods:
                for p in (m.get("scope") or {}).get("professions", []) or []:
                    scoped.add(p)
                # 分支作用域（尖兵/轰击术师…）也算作用域收紧
                for p in (m.get("scope") or {}).get("subProfs", []) or []:
                    scoped.add(p)
                # 「场上每有一名 X 干员」是缩放条件，不是作用对象
                c = m.get("cond") or {}
                if c.get("type") == "perProfession":
                    scoped.add(c.get("who"))

            # A
            if mentioned and not scoped:
                issues.append(("A 缺职业作用域", tag, text[:50], [m["stat"] for m in mods]))
            # B
            if mentioned and scoped and not (set(mentioned) & scoped):
                # 「轰击术师」里含「术师」，按子串覆盖处理
                covered = any(any(p in sc for sc in scoped) for p in mentioned)
                if not covered:
                    issues.append(("B 职业不符", tag, text[:50], "文案=%s 数据=%s" % (mentioned, list(scoped))))
            # C：只有「我方」和「敌方」同时被点名、且没有对应的敌方项时才可疑。
            # 「仅阻挡 1 名敌人时」「击倒敌人时」「攻击…的敌人时」都是条件，不是对象。
            enemy_word = ("敌方" in text or "敌人" in text)
            self_word = ("我方" in text or "干员" in text)
            has_enemy_mod = any((m.get("scope") or {}).get("base") == "enemy" or m.get("bucket") == "enemy" for m in mods)
            cond_only = any(k in text for k in ("时", "后", "每击倒", "进入", "出现"))
            dmg_phrase = "造成的伤害" in text or "首次造成的伤害" in text
            if enemy_word and self_word and not has_enemy_mod and not cond_only and not dmg_phrase:
                issues.append(("C 敌我疑似混淆", tag, text[:50], [m["stat"] for m in mods]))
            # D
            if ("初始部署费用" in text or "初始费用" in text) and any(m["stat"] == "cost" for m in mods):
                issues.append(("D 初始费用当成本", tag, text[:50], [m["stat"] for m in mods]))
            # E（信息项）：「伤害」只是条件（受击回技力、屏障触发）时不算缺口
            if ("伤害" in text) and not any(m["stat"] in DMG for m in mods):
                infos.append(("E 信息：文案提到伤害但无伤害类修正", tag, text[:50], [m["stat"] for m in mods]))
            # F
            if any(abs(float(m.get("value") or 0)) < 1e-9 for m in mods):
                issues.append(("F 零值", tag, text[:50], [m["stat"] for m in mods if abs(float(m.get("value") or 0)) < 1e-9]))
            # G
            friendly_mods = [m for m in mods if (m.get("scope") or {}).get("base") != "enemy"
                             and m.get("bucket") != "enemy"]
            if any(k in text for k in ("近战", "地面干员")) and friendly_mods and not any(
                    (m.get("scope") or {}).get("positions") for m in friendly_mods):
                issues.append(("G 缺位置作用域(近战)", tag, text[:50], [m["stat"] for m in friendly_mods]))
            if any(k in text for k in ("远程", "高台干员")) and friendly_mods and not any(
                    (m.get("scope") or {}).get("positions") for m in friendly_mods):
                issues.append(("G 缺位置作用域(远程)", tag, text[:50], [m["stat"] for m in friendly_mods]))

    order = sorted({i[0] for i in issues})
    print("总问题数 %d（另 %d 条信息项）" % (len(issues), len(infos)))
    for kind in order:
        rows = [i for i in issues if i[0] == kind]
        print("\n== %s （%d）==" % (kind, len(rows)))
        for _, tag, text, detail in rows:
            print("  %-22s %s" % (tag, text))
            print("       %s" % (detail,))


if __name__ == "__main__":
    main()
