# Translate Tube: connect the extension to Claude Code on Windows.
#
# Lets Translate Tube use your Claude plan through the official Claude Code
# app. It installs Claude Code if it is missing, asks you to sign in if
# needed, and registers a small helper that Chrome and Edge start only when
# Translate Tube asks Claude something. Nothing runs in the background.
#
# Safe to run again. To remove: run it with -Remove.

param([string]$ExtensionId = '__EXTENSION_ID__', [switch]$Remove)

$ErrorActionPreference = 'Stop'
$NoBom = New-Object System.Text.UTF8Encoding $false
$ProgressPreference = 'SilentlyContinue'
$Name = 'com.translatetube.claude'
$Dir = Join-Path $env:LOCALAPPDATA 'TranslateTube\claude-helper'
$Keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$Name"
)

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK: $text" -ForegroundColor Green }
function Stop-WithMessage($text) {
  Write-Host "`n!! $text" -ForegroundColor Yellow
  Write-Host "   Fix this, then paste the setup command again." -ForegroundColor Yellow
  throw 'Setup stopped.'
}
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              (Join-Path $HOME '.local\bin')
}

if ($Remove) {
  Say 'Removing the Claude helper'
  foreach ($k in $Keys) { if (Test-Path $k) { Remove-Item $k -Force } }
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  Ok 'Removed. Claude Code was left installed.'
  return
}

# ---- 1. Claude Code ----------------------------------------------------------
Say 'Checking Claude Code'
Update-Path
function Find-Claude {
  $local = Join-Path $HOME '.local\bin\claude.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}
$claude = Find-Claude
if (-not $claude) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue) -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    # Claude Code on Windows uses Git for Windows.
    Write-Host '   Installing Git for Windows...'
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    Update-Path
  }
  Write-Host '   Installing Claude Code with the official installer...'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Update-Path
  $claude = Find-Claude
  if (-not $claude) { Stop-WithMessage 'Claude Code could not be installed. See https://docs.claude.com/en/docs/claude-code/setup' }
}
Ok (& $claude --version)

# ---- 2. Signed in --------------------------------------------------------------
Say 'Checking the Claude sign-in'
if (-not (Test-Path (Join-Path $HOME '.claude\.credentials.json')) -and -not $env:CLAUDE_CODE_OAUTH_TOKEN) {
  Write-Host '   A browser window opens: sign in with the Claude account that has your plan.' -ForegroundColor Yellow
  & $claude auth login
}
Ok 'Signed in'

# ---- 3. The helper -------------------------------------------------------------
Say 'Registering the helper for Chrome and Edge'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$hostScript = Join-Path $Dir 'claude-host.ps1'
[IO.File]::WriteAllText($hostScript, @'
__HOST_SCRIPT__
'@, $NoBom)
$cmd = Join-Path $Dir 'claude-host.cmd'
Set-Content -Path $cmd -Value "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$hostScript`"" -Encoding ASCII
$manifest = Join-Path $Dir "$Name.json"
$json = @{
  name = $Name
  description = 'Translate Tube helper for Claude Code'
  path = $cmd
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
# The browser reads this file; it must be plain UTF-8 without a byte-order mark.
[IO.File]::WriteAllText($manifest, $json, $NoBom)
foreach ($k in $Keys) {
  New-Item -Path $k -Force | Out-Null
  Set-Item -Path $k -Value $manifest
}
Ok "Installed in $Dir"
Write-Host "`nDone. Go back to Translate Tube: it finds Claude by itself.`n" -ForegroundColor Green
