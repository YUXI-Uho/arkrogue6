<#
.SYNOPSIS
  本地构建镜像 → 导出 tar → 传到服务器 → 载入并重启容器。

.EXAMPLE
  .\deploy\build-and-ship.ps1 -Server root@47.94.x.x

.EXAMPLE
  # 已经构建过，只传现有镜像
  .\deploy\build-and-ship.ps1 -Server root@47.94.x.x -SkipBuild
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,   # 形如 root@1.2.3.4
  [string]$Version = (Get-Date -Format "yyyyMMddHHmm"),
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
  $tag = "is6-web:$Version"

  if (-not $SkipBuild) {
    Write-Host "==> docker build $tag" -ForegroundColor Cyan
    docker build -f deploy/Dockerfile -t $tag -t is6-web:latest .
    if ($LASTEXITCODE -ne 0) { throw "docker build 失败" }
  }

  $tar = Join-Path $env:TEMP "is6-web-$Version.tar"
  Write-Host "==> docker save -> $tar" -ForegroundColor Cyan
  docker save $tag -o $tar
  if ($LASTEXITCODE -ne 0) { throw "docker save 失败" }
  "{0:N1} MB" -f ((Get-Item $tar).Length / 1MB) | Write-Host

  Write-Host "==> scp 到 $Server" -ForegroundColor Cyan
  scp $tar "${Server}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw "scp 失败" }

  Write-Host "==> 远端 load + 重启容器" -ForegroundColor Cyan
  $remote = @"
docker load -i /tmp/is6-web-$Version.tar &&
docker rm -f is6-web 2>/dev/null;
docker run -d --name is6-web --restart unless-stopped -p 80:80 --memory 128m $tag &&
rm -f /tmp/is6-web-$Version.tar
"@
  ssh $Server $remote
  if ($LASTEXITCODE -ne 0) { throw "远端执行失败" }

  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  $host_ = ($Server -split "@")[-1]
  Write-Host "完成 → http://$host_/" -ForegroundColor Green
}
finally {
  Pop-Location
}
