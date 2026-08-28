#Requires -Version 5.1
<#
.SYNOPSIS
  Fill .env from OSP secrets if needed, then run God's Eye View on localhost:4173.
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Osp = "C:\Users\gasan\Projects\omni_spaceflight"
Set-Location $Root

function Read-SecretFile([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing secret file: $Path" }
  $text = (Get-Content -Raw -LiteralPath $Path).Trim()
  if (
    ($text.StartsWith('"') -and $text.EndsWith('"')) -or
    ($text.StartsWith("'") -and $text.EndsWith("'"))
  ) {
    $text = $text.Substring(1, $text.Length - 2)
  }
  return $text.Trim()
}

$node = (node -v) -replace "^v", ""
$major = [int]($node.Split(".")[0])
$minor = [int]($node.Split(".")[1])
$ok = ($major -eq 24 -and $minor -ge 14) -or ($major -eq 26)
if (-not $ok) {
  throw "Need Node 24.14.x or 26.x; found v$node"
}

if (-not (Test-Path (Join-Path $Root ".env"))) {
  if (-not (Test-Path (Join-Path $Root ".env.example"))) {
    throw "No .env.example to copy"
  }
  Copy-Item (Join-Path $Root ".env.example") (Join-Path $Root ".env")
}

$envPath = Join-Path $Root ".env"
$envText = Get-Content -Raw -LiteralPath $envPath
$gmaps = Read-SecretFile (Join-Path $Osp "secrets\google_maps_api_key")
$cesium = Read-SecretFile (Join-Path $Osp "secrets\cesium_ion.token")
$opensky = Get-Content -Raw -LiteralPath (Join-Path $Osp "secrets\opensky_credentials.json") | ConvertFrom-Json

function Set-DotEnvValue([string]$Text, [string]$Key, [string]$Value) {
  $pattern = "(?m)^$Key=.*$"
  if ($Text -match $pattern) {
    return [regex]::Replace($Text, $pattern, "$Key=$Value", 1)
  }
  return $Text.TrimEnd() + "`n$Key=$Value`n"
}

$envText = Set-DotEnvValue $envText "GOOGLE_MAPS_API_KEY" $gmaps
$envText = Set-DotEnvValue $envText "CESIUM_ION_TOKEN" $cesium
$envText = Set-DotEnvValue $envText "OPENSKY_CLIENT_ID" $opensky.clientId
$envText = Set-DotEnvValue $envText "OPENSKY_CLIENT_SECRET" $opensky.clientSecret
$envText = Set-DotEnvValue $envText "OPENSKY_AUTH_MODE" "oauth"
$envText = Set-DotEnvValue $envText "PORT" "4173"
$envText = Set-DotEnvValue $envText "HOST" "localhost"
Set-Content -LiteralPath $envPath -Value $envText -NoNewline -Encoding utf8

if (-not (Test-Path (Join-Path $Root "node_modules\vite"))) {
  Write-Host "npm install (PUPPETEER_SKIP_DOWNLOAD=1)"
  $env:PUPPETEER_SKIP_DOWNLOAD = "true"
  npm.cmd install
}

Write-Host "God's Eye View → http://127.0.0.1:4173  (World Track stays on :5173)"
npm.cmd run dev -- --host localhost --port 4173
