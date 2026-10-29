#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/release.py — 一次发布：改版本串 → 跑全部校验 → 列出要上传的文件

为什么要有这一步：
    部署后最难受的故障是「代码更新了、data/is6db.js 还是旧版」。手工改 13 个
    ?v= 既容易漏也容易改错，所以把「bump + 校验 + 清单」收进一条命令。

用法：
    python tools/release.py                 # 版本串自动 +1（按日期 a→b→c），校验并出清单
    python tools/release.py --version 20261101a
    python tools/release.py --dry-run       # 只校验，不改 index.html
    python tools/release.py --skip-tests    # 只 bump + 静态校验（赶时间用，不建议）

退出码：0 成功；1 任一校验失败（失败时 index.html 会被还原，不会留下半成品）
"""
import io
import os
import re
import subprocess
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")

# 上线要传的文件（相对仓库根）。刻意不包含 raw/ tools/ tests/ review/ AUDIT.md：
# 那些是内部产物，公开出去既泄露抓取缓存也白白多传 33 MB。
SHIP_DIRS = ["assets", "core", "js"]
SHIP_FILES = ["index.html", "404.html", "robots.txt", "manifest.json", "sw.js"]
SHIP_DATA = ["data/is6db.js"]


def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8") as f:
        f.write(s)


def versions_in(html):
    return re.findall(r'[?&]v=([^&"\']+)', html)


def bump(cur):
    """按日期递增：20261029a → 20261029b；跨天则 20261101a。"""
    today = datetime.now().strftime("%Y%m%d")
    if cur and cur.startswith(today) and len(cur) == len(today) + 1:
        seq = cur[-1]
        if seq.isalpha() and seq.lower() != "z":
            return today + chr(ord(seq) + 1)
        raise SystemExit("今天的序号已经用完了（%s），请用 --version 手工指定" % cur)
    return today + "a"


def run(cmd, label):
    print("\n>>> " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit("✗ %s 失败（退出码 %d）" % (label, r.returncode))
    print("  ✓ " + label)


def collect_files():
    out = []
    for f in SHIP_FILES + SHIP_DATA:
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            out.append(f)
        elif f not in ("404.html", "robots.txt", "manifest.json", "sw.js"):
            raise SystemExit("✗ 缺少要上线的文件：%s" % f)
    for d in SHIP_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            raise SystemExit("✗ 缺少目录：%s" % d)
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name)
            if os.path.isfile(p) and not name.startswith("."):
                out.append(d + "/" + name)
    return out


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    skip_tests = "--skip-tests" in argv
    forced = None
    if "--version" in argv:
        i = argv.index("--version")
        if i + 1 >= len(argv):
            raise SystemExit("--version 后面要跟一个版本串，例如 20261101a")
        forced = argv[i + 1]

    html = read(INDEX)
    found = versions_in(html)
    if not found:
        raise SystemExit("✗ index.html 里找不到 ?v= 版本串，先手工加一处再跑")
    uniq = sorted(set(found))
    if len(uniq) > 1:
        raise SystemExit("✗ index.html 里已经有多个版本串（%s），先手工统一" % "、".join(uniq))

    cur = uniq[0]
    new = forced or bump(cur)
    print("版本串：%s → %s（%d 处）" % (cur, new, len(found)))

    # 先跑校验：版本串改坏了就没必要写盘
    run([sys.executable, os.path.join("tools", "build_db.py"), "--check"], "数据产物自洽")
    if not dry:
        write(INDEX, html.replace("?v=" + cur, "?v=" + new))
        print("已写入 index.html（%d 处 ?v=%s）" % (len(found), new))

    try:
        run([sys.executable, os.path.join("tools", "check_enums.py")], "枚举 / 表结构 / 入口资源")
        if not skip_tests:
            for t in ("engine.test.js", "db.test.js", "app.smoke.js"):
                run(["node", os.path.join("tests", t)], "tests/" + t)
    except SystemExit:
        if not dry:
            write(INDEX, html)          # 还原，不留半成品
            print("已还原 index.html（校验失败，版本串回退到 %s）" % cur)
        raise

    files = collect_files()
    total = sum(os.path.getsize(os.path.join(ROOT, f)) for f in files)
    lines = [
        "# 上线文件清单",
        "",
        "由 `tools/release.py` 生成，版本串 **%s**。" % new,
        "",
        "只传下面这些文件，**不要**把 `raw/`（33 MB 官方原始表）、`tools/`、`tests/`、",
        "`review/`、`AUDIT.md` 一起传上去 —— 那是内部产物，公开出去既泄露抓取缓存也白白占带宽。",
        "",
        "```",
    ]
    for f in files:
        kb = os.path.getsize(os.path.join(ROOT, f)) / 1024.0
        lines.append("%-40s %8.1f KB" % (f, kb))
    lines += [
        "```",
        "",
        "合计 %d 个文件，%.1f MB。" % (len(files), total / 1024.0 / 1024.0),
        "",
        "## 响应头",
        "",
        "- Netlify / Cloudflare Pages：把 `deploy/_headers` 复制到站点根目录（文件名保持 `_headers`）",
        "- Vercel：把 `deploy/vercel.json` 复制到仓库根目录",
        "- nginx：把 `deploy/nginx.conf.snippet` 粘进 `server { }`",
        "",
        "## 自检",
        "",
        "传完打开站点，点右上角「公式说明」，拉到底部核对「资源版本」是否为 `%s`。" % new,
    ]
    out = os.path.join(ROOT, "deploy", "FILES.txt")
    write(out, "\n".join(lines) + "\n")
    print("\n已写入 deploy/FILES.txt（%d 个文件 / %.1f MB）" % (len(files), total / 1024.0 / 1024.0))
    print("发布完成。版本串：%s" % new)


if __name__ == "__main__":
    main()
