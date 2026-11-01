<#
.SYNOPSIS
  Build a clean deploy package, upload it, unpack on server and reload nginx.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\pack-and-ship.ps1 -Server root@1.2.3.4

.EXAMPLE
  .\deploy\pack-and-ship.ps1 -Server root@1.2.3.4 -Port 2222 -Retries 5

.NOTES
  Messages are ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as GBK
  unless the file has a UTF-8 BOM, and non-ASCII output breaks -f formatting.

  If ssh times out right after scp succeeded (common: cloud anti-bruteforce
  drops port 22 for a while), the zip is already on the server. The script
  prints the exact commands to finish the deploy from Workbench.
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$WebRoot = "/var/www/is6",
  [int]$Port = 22,
  [int]$Retries = 3
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
  Write-Host "[1/4] package built: $mb MB" -ForegroundColor Cyan

  Write-Host "[2/4] uploading to $Server (port $Port)" -ForegroundColor Cyan
  scp -P $Port $zip "${Server}:/tmp/is6.zip"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }

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
curl -s -o /dev/null -w "local check: %{http_code}\n" http://127.0.0.1/
"@

  $ok = $false
  for ($i = 1; $i -le $Retries; $i++) {
    Write-Host "[3/4] unpack + reload (attempt $i/$Retries)" -ForegroundColor Cyan
    ssh -p $Port $Server $remote
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    if ($i -lt $Retries) {
      $wait = 5 * $i
      Write-Host "      ssh failed, retrying in $wait s (port 22 may be rate-limited)" -ForegroundColor Yellow
      Start-Sleep -Seconds $wait
    }
  }

  if (-not $ok) {
    Write-Host ""
    Write-Host "[4/4] ssh unreachable, but the zip IS already uploaded." -ForegroundColor Yellow
    Write-Host "      Finish the deploy from Alibaba Cloud Workbench (browser terminal):" -ForegroundColor Yellow
    Write-Host ""
    Write-Host '      cd /var/www && rm -rf is6.bak && cp -a is6 is6.bak' -ForegroundColor White
    Write-Host '      rm -rf is6/* && unzip -oq /tmp/is6.zip -d is6' -ForegroundColor White
    Write-Host '      chown -R nginx:nginx is6 && nginx -t && systemctl reload nginx' -ForegroundColor White
    Write-Host ''
    Write-Host "      Then check: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/" -ForegroundColor White
    exit 1
  }

  $hostOnly = ($Server -split "@")[-1]
  Write-Host "[4/4] done -> http://$hostOnly/" -ForegroundColor Green
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
