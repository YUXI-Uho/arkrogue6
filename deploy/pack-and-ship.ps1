<#
.SYNOPSIS
  Build a clean deploy package, upload it, unpack on server and reload nginx.
  Only ships files the browser needs (~6 MB).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\pack-and-ship.ps1 -Server root@1.2.3.4

.NOTES
  Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as GBK
  unless the file has a UTF-8 BOM, and non-ASCII output breaks -f formatting.
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$WebRoot = "/var/www/is6"
)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ("is6-stage-" + [guid]::NewGuid().ToString("n"))

try {
  New-Item -ItemType Directory -Path $stage | Out-Null

  $files = @("index.html", "404.html", "robots.txt", "manifest.json", "sw.js", "LICENSE")
  foreach ($f in $files) {
    Copy-Item (Join-Path $proj $f) $stage
  }
  foreach ($d in @("assets", "core", "js")) {
    Copy-Item (Join-Path $proj $d) $stage -Recurse
  }
  New-Item -ItemType Directory -Path (Join-Path $stage "data") | Out-Null
  Copy-Item (Join-Path $proj "data\is6db.js") (Join-Path $stage "data")

  New-Item -ItemType Directory -Path (Join-Path $stage "deploy") | Out-Null
  Copy-Item (Join-Path $proj "deploy\nginx.server.conf") (Join-Path $stage "deploy")
  Copy-Item (Join-Path $proj "deploy\security-headers.conf") (Join-Path $stage "deploy")

  $zip = Join-Path $env:TEMP "is6.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "[1/3] package built: $mb MB" -ForegroundColor Cyan

  Write-Host "[2/3] uploading to $Server" -ForegroundColor Cyan
  scp $zip "${Server}:/tmp/is6.zip"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }

  Write-Host "[3/3] unpack + reload nginx" -ForegroundColor Cyan
  $remote = @"
# No 'set -e': Compress-Archive writes backslash paths, so unzip exits 1 (warning only)
# and set -e would abort before chown/nginx reload.
rm -rf ${WebRoot}.bak
cp -a ${WebRoot} ${WebRoot}.bak || exit 1
rm -rf ${WebRoot}/*
unzip -oq /tmp/is6.zip -d ${WebRoot}
rc=`$?
if [ `$rc -gt 1 ]; then echo "unzip failed: `$rc"; exit 2; fi
chown -R nginx:nginx ${WebRoot} || exit 3
nginx -t || exit 4
systemctl reload nginx || exit 5
rm -f /tmp/is6.zip
echo "--- deployed ---"
ls ${WebRoot}
curl -s -o /dev/null -w "local check: %{http_code}\n" http://127.0.0.1/
"@
  ssh $Server $remote
  if ($LASTEXITCODE -ne 0) { throw "remote command failed" }

  $hostOnly = ($Server -split "@")[-1]
  Write-Host "done -> http://$hostOnly/" -ForegroundColor Green
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
