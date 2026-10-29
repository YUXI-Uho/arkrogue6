# -*- coding: utf-8 -*-
"""下载游戏官方肉鸽数据表，并导出 IS6 藏品的原始结构样本，供人工确认字段。"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122"}
MIRRORS = [
    "https://gcore.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
    "https://fastly.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
    "https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/",
]
NAME = "roguelike_topic_table.json"


def main():
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, NAME)
    if not (os.path.exists(path) and os.path.getsize(path) > 1000):
        for base in MIRRORS:
            try:
                print("尝试 %s" % base.split("/")[2], flush=True)
                resp = urllib.request.urlopen(urllib.request.Request(base + NAME, headers=UA), timeout=120)
                total = int(resp.headers.get("Content-Length") or 0)
                got = 0
                with open(path + ".part", "wb") as f:
                    while True:
                        chunk = resp.read(262144)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if total and got % (1024 * 1024) < 262144:
                            print("  %.1f / %.1f MB" % (got / 1e6, total / 1e6), flush=True)
                os.replace(path + ".part", path)
                print("下载完成 %d bytes" % got, flush=True)
                break
            except Exception as e:
                print("  失败: %s" % e, flush=True)
    else:
        print("已有缓存 %d bytes" % os.path.getsize(path), flush=True)

    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    details = data.get("details", {})
    print("themes:", list(details.keys()), flush=True)
    r6 = details.get("rogue_6", {})
    print("rogue_6 keys:", list(r6.keys()), flush=True)
    relics = r6.get("relics", {})
    print("relics:", len(relics), flush=True)

    out = os.path.join(RAW, "roguelike_sample.txt")
    with open(out, "w", encoding="utf-8") as f:
        items = list(relics.items())
        for key, val in items[:6]:
            f.write("### %s\n" % key)
            f.write(json.dumps(val, ensure_ascii=False, indent=1))
            f.write("\n\n")
        # 找几个典型的「属性加成」藏品看看标记
        for key, val in items:
            desc = val.get("description", "")
            if "ba.vup" in desc or "ba.vdown" in desc:
                f.write("### TAGGED %s\n" % key)
                f.write(json.dumps(val, ensure_ascii=False, indent=1))
                f.write("\n\n")
                break
    print("样本写入 raw/roguelike_sample.txt", flush=True)
    # 统计标记使用情况
    tagged = sum(1 for v in relics.values() if "ba.vup" in (v.get("description") or ""))
    print("含 vup 标记的藏品: %d / %d" % (tagged, len(relics)), flush=True)


if __name__ == "__main__":
    main()
