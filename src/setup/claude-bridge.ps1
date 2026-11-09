# Translate Tube: set up the Claude bridge on Windows.
#
# Lets Translate Tube use your Claude Pro/Max plan. It installs what is
# missing and starts OCP (github.com/dtzp555-max/ocp, MIT), a small local
# program that runs the official Claude Code app for each request. OCP only
# listens on this computer (127.0.0.1:3456) and never reads your login.
#
# Steps: Node.js (if missing) -> Claude Code (if missing) -> Claude sign-in
# (if needed) -> OCP into %LOCALAPPDATA%\TranslateTube -> start now and at
# every Windows sign-in, hidden.
#
# Safe to run again: finished steps are skipped.
# To remove: run it with -Remove (Settings has a "Copy removal command" button).

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$OcpVersion = '3.43.0'
$Port = 3456
$Root = Join-Path $env:LOCALAPPDATA 'TranslateTube'
$OcpDir = Join-Path $Root 'claude-bridge'
$Startup = [Environment]::GetFolderPath('Startup')
$Shortcut = Join-Path $Startup 'Translate Tube Claude bridge.lnk'

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
function Stop-Bridge {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force }
  }
}

if ($Remove) {
  Say 'Removing the Claude bridge'
  Stop-Bridge
  if (Test-Path $Shortcut) { Remove-Item $Shortcut -Force }
  if (Test-Path $OcpDir) { Remove-Item $OcpDir -Recurse -Force }
  Ok 'Removed. Node.js and Claude Code were left installed.'
  return
}

# ---- 1. Node.js 22.13 or newer -------------------------------------------
Say 'Checking Node.js'
Update-Path
function Get-NodeVersion {
  try { return [version]((node --version) -replace '^v', '') } catch { return $null }
}
function Test-NodeOk($v) {
  # OCP needs node:sqlite without a flag: 22.13+ or 23.4+.
  return $v -and (($v.Major -eq 22 -and $v.Minor -ge 13) -or ($v.Major -eq 23 -and $v.Minor -ge 4) -or $v.Major -ge 24)
}
$node = Get-NodeVersion
if (-not (Test-NodeOk $node)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'Node.js 22 or newer is needed. Install the LTS version from https://nodejs.org'
  }
  Write-Host '   Installing Node.js LTS (Windows may ask for permission)...'
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Update-Path
  $node = Get-NodeVersion
  if (-not (Test-NodeOk $node)) {
    Stop-WithMessage 'Node.js could not be installed. Install the LTS version from https://nodejs.org'
  }
}
Ok "Node.js $node"

# ---- 2. Claude Code --------------------------------------------------------
Say 'Checking Claude Code'
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
  if (-not $claude) {
    Stop-WithMessage 'Claude Code could not be installed. See https://docs.claude.com/en/docs/claude-code/setup'
  }
}
Ok (& $claude --version)

# ---- 3. Signed in to Claude -----------------------------------------------
Say 'Checking the Claude sign-in'
$creds = Join-Path $HOME '.claude\.credentials.json'
if (-not (Test-Path $creds) -and -not $env:CLAUDE_CODE_OAUTH_TOKEN) {
  Write-Host '   A browser window opens: sign in with the Claude account that has your Pro or Max plan.' -ForegroundColor Yellow
  & $claude auth login
}
Ok 'Done (Translate Tube shows it if the sign-in is missing)'

# ---- 4. OCP ----------------------------------------------------------------
Say "Installing the bridge (OCP $OcpVersion)"
$versionFile = Join-Path $OcpDir '.translate-tube-version'
if ((Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq $OcpVersion)) {
  Ok 'Already installed'
} else {
  Stop-Bridge
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $zip = Join-Path $env:TEMP "ocp-$OcpVersion.zip"
  $tmp = Join-Path $env:TEMP "ocp-$OcpVersion"
  Invoke-WebRequest "https://github.com/dtzp555-max/ocp/archive/refs/tags/v$OcpVersion.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path $OcpDir) { Remove-Item $OcpDir -Recurse -Force }
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $OcpDir
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Push-Location $OcpDir
  try {
    $env:OCP_SKIP_AUTH_TEST = '1'
    node setup.mjs --no-start | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "The bridge setup failed. Run `"node setup.mjs`" in $OcpDir to see why." }
  } finally { Pop-Location }
  Set-Content $versionFile $OcpVersion
  Ok "Installed in $OcpDir"
}

# ---- 5. Start now and at every sign-in, without a window -------------------
Say 'Starting the bridge'
$launcher = Join-Path $OcpDir 'start_ocp.cmd'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Shortcut)
$lnk.TargetPath = (Get-Command powershell.exe).Source
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -Command `"& '$launcher'`""
$lnk.WorkingDirectory = $OcpDir
$lnk.WindowStyle = 7
$lnk.Description = 'Claude bridge for Translate Tube'
$lnk.Save()
Ok 'Starts by itself when you sign in to Windows'

$running = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $running) {
  Start-Process -FilePath $lnk.TargetPath -ArgumentList $lnk.Arguments -WorkingDirectory $OcpDir -WindowStyle Hidden
}
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; $up = $true } catch { }
}
if (-not $up) {
  Stop-WithMessage "The bridge did not start. Double-click $launcher to see the error."
}
Ok "Running at http://127.0.0.1:$Port"
Write-Host "`nDone. Go back to Translate Tube: it finds the bridge by itself.`n" -ForegroundColor Green
