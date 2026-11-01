# data/ 里都是什么

一句话：**只有 `overrides/` 是人写的，其余全部是产物。** 手改产物会在下次重建时消失。

| 文件 | 性质 | 能删吗 | 谁生成 |
|---|---|---|---|
| `is6db.js` | **表产物**，`index.html` 实际加载的那份 | 能，重跑 `python tools/build_db.py` | `tools/build_db.py` |
| `is6db.json` | 同一份内容的 JSON 镜像，给工具链和 diff 用 | 能，同上 | `tools/build_db.py` |
| `relics.json` | **中间产物**：藏品结构（含档位与修正项） | 能，但要重跑 `tools/build_relics_official.py` | `tools/build_relics_official.py` |
| `operators.json` | **中间产物**：干员 + 攻击范围 | 能，但要重跑 `tools/build_operators.py` | `tools/build_operators.py` |
| `overrides/relics.json` | **人工覆盖表**（21 条带条件的数值修正） | **不能**，删了这些藏品就少数值 | 人 |
| `relics_wiki.json` | 抓取缓存，只在文案兜底时读 | 能，重新抓一次即可 | 抓取脚本（`.gitignore` 里） |
| `DB_CHANGELOG.md` | 每次装配的差异记录 | 能，历史记录而已 | `tools/build_db.py` 追加 |

## 依赖方向（别搞反）

```
raw/*.json ──► relics.json / operators.json ──► is6db.js / is6db.json ──► 界面
                    ▲
        overrides/relics.json（人手写的数值）
```

`tools/build_db.py` 只读中间产物，不读 `raw/`；`tools/build_*.py` 只读 `raw/` 和覆盖表，不读 `is6db.*`。
这个方向由 `tools/check_enums.py` 第 10 项守着 —— 缓存一旦被当成源读，改起来就再也说不清哪份是真数据。

## 关于「干净 clone 能不能从零重建」

**能重建到表产物，不能重建到中间产物。** 原因很实在：`raw/` 是 53MB 的官方表，
在 `.gitignore` 里，没有进版本库。

| 场景 | 命令 | 结果 |
|---|---|---|
| 只改了 `overrides/` 或代码 | `python tools/update_db.py --skip-build` | 用现有中间产物重装表 ✅ |
| 换了一批 `raw/` | `python tools/update_db.py` | 中间产物 + 表全部重建 ✅ |
| 干净 clone（无 `raw/`） | `python tools/update_db.py` | 藏品构建会失败（缺 `raw/roguelike_topic_table.json`）❌ |

所以中间产物**留在版本库里**，不是因为它们是源，而是因为它们是从 `raw/` 到界面的唯一可复现路径。
真要从零重建，先按 `README.md`「数据来源」一节把 `raw/` 拉下来。
