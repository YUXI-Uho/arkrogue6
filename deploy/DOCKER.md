# 用 Docker 部署

镜像只含浏览器真正要请求的文件（约 6MB），基础镜像 `nginx:1.27-alpine`，最终镜像约 **55–60MB**。
容器内存上限 128MB，在你那台 2C2G 的练手包上很宽裕。

```
deploy/
  Dockerfile                 构建镜像（构建上下文 = 仓库根目录）
  nginx.container.conf       容器内站点配置（gzip / 缓存 / 安全头）
  security-headers.conf      安全响应头（容器与裸机共用）
  docker-compose.yml         单容器编排
  build-and-ship.ps1         本地构建 → 传上去 → 重启（幂等发布）
```

---

## 方案 A：本地构建，只把镜像传上去（推荐）

服务器不需要装编译环境，也不吃 CPU；上传走公网**入方向，不计流量**。

```powershell
# 1. 先确认 Docker Desktop 的引擎在跑（右下角小鲸鱼是绿色）
docker version

# 2. 构建
docker build -f deploy/Dockerfile -t is6-web:latest .

# 3. 一条命令发布（自动 save → scp → load → 重启）
.\deploy\build-and-ship.ps1 -Server root@<公网IP>
```

第一次服务器上要先有 Docker：

```bash
# Alibaba Cloud Linux 3 / CentOS 系
sudo dnf install -y dnf-utils
sudo dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker

# 拉镜像加速（地址在 容器镜像服务 ACR → 镜像工具 → 镜像加速器）
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://<你的专属前缀>.mirror.aliyuncs.com"] }
EOF
sudo systemctl restart docker
```

> 只 load 本地镜像的话，其实连加速器都不用配（`docker load` 不联网）。

## 方案 B：服务器上直接构建

适合以后想用 git 一键更新：

```bash
git clone <仓库> /opt/is6 && cd /opt/is6
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

代价：服务器要拉基础镜像（约 50MB 入方向）、构建时吃 1 个核几秒。

---

## 日常操作

```bash
docker ps --filter name=is6-web          # 看状态
docker logs --tail 50 is6-web            # 日志
curl -I http://127.0.0.1/                # 本机自检
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1/data/is6db.js | grep -i content-encoding
docker inspect --format '{{.State.Health.Status}}' is6-web   # healthy
```

更新版本（方案 A）：

```powershell
.\deploy\build-and-ship.ps1 -Server root@<IP>     # 自动带时间戳 tag
```

## HTTPS 怎么办

容器内只跑 80。两种做法：

1. **前面挂个 Caddy 容器**（自动申请证书，最省事）：
   ```bash
   docker run -d --name caddy -p 80:80 -p 443:443 \
     -v caddy_data:/data --network host \
     caddy caddy reverse-proxy --from is6.example.com --to 127.0.0.1:8080
   ```
   同时把 `docker-compose.yml` 的端口改成 `"8080:80"`。
2. **宿主机 nginx 反代 443**，容器只监听 127.0.0.1：
   端口改成 `"127.0.0.1:8080:80"`，证书交给宿主 nginx/certbot。

> 大陆地域用域名必须备案；先 `http://IP` 玩不受影响。

## 体积与流量

| 项 | 数值 |
| --- | --- |
| 镜像 | 约 55–60MB（含 nginx 基础层） |
| 站点文件 | 6.2MB（其中 `data/is6db.js` 1.55MB） |
| gzip 后首访 | 约 318KB |
| 20GB/月 流量可支撑 | 约 6 万次首访 |

## 已验证 / 未验证

- `docker compose -f deploy/docker-compose.yml config` 解析通过（结构、端口、内存限制都合法）。
- Dockerfile 里每个 `COPY` 源都逐个核对存在。
- **未实际 build**：当前环境的沙箱挡掉了 Docker Desktop 引擎（`%LOCALAPPDATA%\Docker\log` 与 WSL 访问被拒）。
  你本地引擎起来后跑一次 `docker build` 即可确认；如果报错把输出贴给我。
