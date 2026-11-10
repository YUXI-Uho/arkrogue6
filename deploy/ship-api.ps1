<#
.SYNOPSIS
  Package and ship the API (server/ + core/db + repos + engine + is6db.json) to /opt/is6-api.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\ship-api.ps1 -Server root@1.2.3.4

.NOTES
  Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as GBK
  unless the file has a UTF-8 BOM, and non-ASCII output breaks -f formatting.

  The remote script is built as an array of lines (not a here-string):
  PS 5.1 chokes on LF-only here-strings written by some editors.
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$ApiRoot = "/opt/is6-api",
  [int]$Port = 22
)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ("is6-api-" + [guid]::NewGuid().ToString("n"))

try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item (Join-Path $proj "server") $stage -Recurse
  Copy-Item (Join-Path $proj "package.json") $stage

  # Backend deps = the require() list in server/engine.js
  New-Item -ItemType Directory -Path (Join-Path $stage "core") | Out-Null
  foreach ($f in @("schema.js", "enums.js")) {
    Copy-Item (Join-Path $proj "core\$f") (Join-Path $stage "core")
  }
  foreach ($d in @("db", "repos")) {
    Copy-Item (Join-Path $proj "core\$d") (Join-Path $stage "core") -Recurse
  }
  New-Item -ItemType Directory -Path (Join-Path $stage "js") | Out-Null
  foreach ($f in @("effects.js", "engine.js")) {
    Copy-Item (Join-Path $proj "js\$f") (Join-Path $stage "js")
  }
  New-Item -ItemType Directory -Path (Join-Path $stage "data") | Out-Null
  Copy-Item (Join-Path $proj "data\is6db.json") (Join-Path $stage "data")
  New-Item -ItemType Directory -Path (Join-Path $stage "deploy") | Out-Null
  Copy-Item (Join-Path $proj "deploy\is6-api.service") (Join-Path $stage "deploy")

  $zip = Join-Path $env:TEMP "is6-api.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "[1/3] api package: $mb MB" -ForegroundColor Cyan

  Write-Host "[2/3] upload" -ForegroundColor Cyan
  scp -P $Port $zip "${Server}:/tmp/is6-api.zip"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }

  Write-Host "[3/3] install + restart service" -ForegroundColor Cyan
  $remoteLines = @(
    "id -u is6 >/dev/null 2>&1 || useradd -r -s /sbin/nologin is6 || exit 1",
    "mkdir -p $ApiRoot",
    "rm -rf $ApiRoot/*",
    "unzip -oq /tmp/is6-api.zip -d $ApiRoot",
    'rc=$?',
    'if [ $rc -gt 1 ]; then echo "unzip failed: $rc"; exit 2; fi',
    "cp $ApiRoot/deploy/is6-api.service /etc/systemd/system/is6-api.service || exit 3",
    "chown -R is6:is6 $ApiRoot || exit 4",
    "systemctl daemon-reload || exit 5",
    "systemctl enable is6-api >/dev/null 2>&1",
    "systemctl restart is6-api || exit 6",
    "sleep 1",
    "systemctl is-active is6-api",
    "curl -s http://127.0.0.1:3000/healthz",
    "echo",
    "rm -f /tmp/is6-api.zip"
  )
  $remote = $remoteLines -join "`n"

  ssh -p $Port $Server $remote
  if ($LASTEXITCODE -ne 0) { throw "remote command failed" }
  Write-Host "done" -ForegroundColor Green
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
