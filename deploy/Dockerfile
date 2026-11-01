# syntax=docker/dockerfile:1
# 构建（在仓库根目录）：
#   docker build -f deploy/Dockerfile -t is6-web:latest .
# 构建上下文必须是仓库根，因为要 COPY 站点文件；root/.dockerignore 已排除 raw/tools/tests。
FROM nginx:1.27-alpine

# 干掉镜像自带的欢迎页与默认站点
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf

# 只拷浏览器真正会请求的文件（data/ 里另外 4MB 的构建中间产物不进镜像）
COPY index.html 404.html robots.txt manifest.json sw.js /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY core/   /usr/share/nginx/html/core/
COPY js/     /usr/share/nginx/html/js/
COPY data/is6db.js /usr/share/nginx/html/data/is6db.js

COPY deploy/nginx.container.conf  /etc/nginx/conf.d/is6.conf
COPY deploy/security-headers.conf /etc/nginx/security-headers.conf

RUN nginx -t

EXPOSE 80
# 容器内自检：1 分钟内起不来就会被 compose/健康检查标红
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
