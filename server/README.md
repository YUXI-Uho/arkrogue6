# server/ — IS6 计算后端

零第三方依赖（只用 Node 内置模块），**计算逻辑直接复用** `core/schema.js` + `js/effects.js` + `js/engine.js`，
数据也读**前端那一份表产物** `data/is6db.json`（经 `core/db` + `core/repos`），
所以前后端只有一份实现、一份数据，不可能出现「两边算得不一样」。

## 接口

### `GET /healthz`
```json
{ "ok": true, "uptime": 42 }
```

### `GET /api/meta`
```json
{
  "ok": true,
  "relics": 251,
  "operators": 452,
  "schemaVersion": "2.0.0",
  "tableVersion": 3,
  "dataHash": "sha256:f4c7b55f4e4582bb",
  "builtAt": "2026-10-29T10:46:53Z",
  "gameVersion": "集成战略 #6 沉沦者的黑流树海（rogue_6）",
  "ranges": 55
}
```

`schemaVersion` 是属性注册表版本（`core/schema.js`），`tableVersion` 是产物/表结构版本，
`dataHash` 与前端「公式说明」里显示的是同一个指纹 —— 对不上就说明两边不是同一份数据。

### `POST /api/calc`

请求（`Content-Type: application/json`，body ≤ 64KB）：

```json
{
  "relics": [{ "id": "145", "stage": 0, "stack": 0 }],
  "operators": [
    { "name": "玛恩纳" },
    { "name": "自定义干员", "profession": "近卫", "subProfession": "解放者", "position": "近战位",
      "panel": { "hp": 3000, "atk": 500, "def": 300, "res": 10, "aspd": 100,
                 "block": 1, "cost": 20, "interval": 1.2, "spRecover": 1, "initSp": 0, "redeploy": 70 },
      "assignTarget": false }
  ],
  "ctx": { "time": 0, "hpPct": 100, "ingots": 0, "parts": 0, "value": 0, "allyCount": 0,
           "skillOn": false, "hasShield": false, "firstDeploy": true, "proc": false,
           "profCounts": { "术师": 1 } },
  "damage": { "atk": 635, "scale": 1, "def": 200, "res": 30 }
}
```

- `operators[]` 只给 `name` 或 `id` 时用内置数据（可选 `useFavor:false` 关掉满信赖）；
- 给 `panel` 则按自定义干员处理（数值会被夹到合法范围）；
- `ctx` / `damage` 可省略。

响应（节选）：

```json
{
  "ok": true,
  "counts": { "relics": 2, "operators": 1, "mods": 5 },
  "operators": [{
    "id": "char_4064_mlynar", "name": "玛恩纳",
    "base": { "hp": 3906, "atk": 385, "...": 0 },
    "final": { "atk": 635, "...": 0 },
    "delta": { "atk": 250, "...": 0 },
    "inactive": [], "unapplied": []
  }],
  "summary": { "panel": { "atk": { "flat": 0, "pct": 65, "items": [] } }, "combat": {}, "run": {}, "special": [] },
  "damage": { "phys": 435, "magic": 444.5, "trueDmg": 635, "detail": { "...": 0 } }
}
```

## 限制与防护

| 项 | 值 |
| --- | --- |
| 请求体 | 64KB（超过 → 413） |
| 藏品数 | ≤ 300（去重） |
| 干员数 | ≤ 12 |
| 频率 | 每 IP 120 次/分钟（429 + Retry-After） |
| 监听 | 仅 `127.0.0.1`，由 Nginx 反代 |
| 运行用户 | `is6`（systemd 沙箱：只读文件系统、私有 /tmp、内存上限 256M） |

## 本地跑

```bash
node server/index.js            # http://127.0.0.1:3000
curl -s http://127.0.0.1:3000/healthz
node tests/server.test.js       # 后端自测（数据源指纹 / 面板字段透传 / 校验夹紧）
```

启动时会做两件事，任一步失败直接退出（算错比不启动更难排查）：

1. `DB.load` 校验产物 `schemaVersion` 不高于代码；
2. `DB.check()` 拿行数与产物 `meta.counts` 对账。

## 部署

```powershell
.\deploy\ship-api.ps1 -Server root@<IP>     # 装到 /opt/is6-api + systemd
```

Nginx 侧需要把 `deploy/nginx.server.conf` 里的 `location /api/` 段落生效（新版本已包含）。
