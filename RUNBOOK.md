# 运维手册（下次开机照着做）

服务器：ECS `<实例ID>` · 华北2（北京）· 公网 IP `<公网IP>`
本地代码：`<项目目录>`（**代码以本地为准，服务器只是部署副本**）

---

## 1. 下次开机先看这三样

| 要看什么 | 在哪看 |
| --- | --- |
| 实例是否在运行 | 控制台 `https://ecs.console.aliyun.com/server`，实例状态「运行中」 |
| 公网 IP 有没有变 | 实例列表里的「公网 IP」一栏（关机再开会变，见第 5 节） |
| 额度还剩多少 | 「我的权益」或 ECS 概览的「练手包剩余额度」 |

## 2. 登录服务器

**方式 A：网页终端（不用装任何东西）**
控制台 → 实例 → **远程连接 → Workbench**。

**方式 B：本地 SSH（推荐）**

```powershell
ssh root@<公网IP>
```

密码是之前设的 root 密码。嫌每次输密码麻烦，配一次公钥：

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\is6" -N '""'
Get-Content "$env:USERPROFILE\.ssh\is6.pub"
```

把输出的那行贴到服务器（Workbench 里）：

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo 'ssh-ed25519 AAAA...' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

之后：

```powershell
ssh -i "$env:USERPROFILE\.ssh\is6" root@<公网IP>
```

## 3. 确认网站和后端都活着

```bash
systemctl is-active nginx is6-api          # 两个都要 active
curl -s -o /dev/null -w "site %{http_code}\n" http://127.0.0.1/
curl -s http://127.0.0.1:3000/healthz      # 后端
curl -s http://127.0.0.1/api/meta          # 经 Nginx 转发的后端
```

浏览器再打开 `http://<公网IP>`。

## 4. 改完代码怎么发布

```powershell
cd <项目目录>

# 前端（静态站）
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\pack-and-ship.ps1 -Server root@<公网IP>

# 后端（server/ 或 data/*.json 改了才需要）
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\ship-api.ps1 -Server root@<公网IP>
```

两条都会先备份（`/var/www/is6.bak`），出问题可回滚。

## 5. 省钱：不用的时机关掉

**注意：普通「关机」不一定停钱。** 阿里云按量付费实例，只有开「**节省停机模式**」关机才不收 vCPU/内存费；云盘（40G）无论如何都收。

| 做法 | 省多少 | 代价 |
| --- | --- | --- |
| 节省停机模式关机 | 停收 CPU/内存（约 ¥88/月 → ¥0） | **公网 IP 会被释放，再开机会变**，网站地址跟着变 |
| 关机 + 绑定 EIP 保留 IP | 同上，但 IP 不变 | EIP 约 ¥0.02/小时 ≈ ¥15/月 |
| 做自定义镜像后**释放实例** | 全部停收（只剩镜像/快照几元/月） | 下次要用镜像重建，IP 变，约 5 分钟 |
| 一直开着 | — | ≈ ¥88/月（0.12316 × 730h） |

### 推荐节奏

- **几天不用**：节省停机模式关机 → 下次开机看新 IP。
- **几周不用**：先做**自定义镜像**（控制台 → 实例 → 更多 → 云盘和镜像 → 创建自定义镜像），再释放实例；下次用镜像创建，数据还在。
- **长期不用**：同上，镜像 + 释放。

⚠️ 你的练手包 **2026-11-30 到期**，到期后按量扣真实余额，务必提前处理（续费 / 换 99 元/年 / 释放）。

## 6. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| ssh 超时 | 安全组没放 22，或换了 IP | 控制台确认 IP 与安全组 |
| 网页打不开但 ssh 能上 | nginx 挂了 / 80 没放行 | `systemctl status nginx`、查安全组 |
| 502 Bad Gateway | `is6-api` 挂了 | `systemctl restart is6-api && journalctl -u is6-api -n 50` |
| 页面是旧版 | Service Worker 缓存 | Ctrl+F5 |
| 磁盘满 | 日志/备份 | `df -h`、清 `/var/www/is6.bak` |
