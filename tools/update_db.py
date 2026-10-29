# -*- coding: utf-8 -*-
"""tools/update_db.py — 官方数据更新后的一键重生成入口

流程：
    1. tools/build_relics_official.py   官方藏品 buffs → data/relics.json
    2. tools/build_operators.py         官方干员表 → data/operators.json
    3. tools/build_db.py                两张 JSON → data/is6db.js（表产物）
    4. tools/check_enums.py             表结构 / 属性注册表一致性
    5. node tests/engine.test.js        （可选，--test 时跑）

用法：
    python tools/update_db.py            # 重生成数据 + 校验
    python tools/update_db.py --test     # 额外跑一遍测试
    python tools/update_db.py --skip-build   # 只用现有 JSON 重装表

注意：第 1、2 步读的是 raw/ 下的官方表，raw 没更新就不会有新数据。
raw 的获取见 tools/fetch_roguelike.py 与 README 的「数据来源」。
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(script, *args):
    cmd = [sys.executable, os.path.join(ROOT, "tools", script)] + list(args)
    print("\n>>> python tools/" + script)
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit("%s 失败（退出码 %d）" % (script, r.returncode))


def main():
    skip_build = "--skip-build" in sys.argv
    run_tests = "--test" in sys.argv

    if not skip_build:
        run("build_relics_official.py")
        run("build_operators.py")

    run("build_db.py")
    run("check_enums.py")

    if run_tests:
        for t in ("engine.test.js", "db.test.js", "app.smoke.js"):
            path = os.path.join(ROOT, "tests", t)
            if not os.path.exists(path):
                continue
            print("\n>>> node tests/" + t)
            r = subprocess.run(["node", path], cwd=ROOT)
            if r.returncode != 0:
                raise SystemExit("tests/%s 失败" % t)

    print("\n完成。打开 index.html 即可看到新数据。")


if __name__ == "__main__":
    main()
