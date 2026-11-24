# Translate Tube helper for Claude Code. Chrome or Edge starts it for each
# request (native messaging), passes one JSON message on stdin, and reads one
# JSON answer from stdout. It runs the official Claude Code app ("claude -p")
# with the model the extension asks for, and nothing else.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Read-Message {
  $in = [Console]::OpenStandardInput()
  $len = New-Object byte[] 4
  $got = 0
  while ($got -lt 4) { $n = $in.Read($len, $got, 4 - $got); if ($n -le 0) { return $null }; $got += $n }
  $size = [BitConverter]::ToInt32($len, 0)
  $buf = New-Object byte[] $size
  $got = 0
  while ($got -lt $size) { $n = $in.Read($buf, $got, $size - $got); if ($n -le 0) { break }; $got += $n }
  return ($utf8.GetString($buf, 0, $got) | ConvertFrom-Json)
}

function Send-Message($obj) {
  $bytes = $utf8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5))
  $out = [Console]::OpenStandardOutput()
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Find-Claude {
  $local = Join-Path $HOME '.local\bin\claude.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command claude.exe, claude -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

try {
  $msg = Read-Message
  $claude = Find-Claude
  if (-not $claude) { Send-Message @{ ok = $false; code = 'no-claude'; error = 'Claude Code is not installed.' }; exit }

  if ($msg.type -eq 'ping') {
    $signedIn = (Test-Path (Join-Path $HOME '.claude\.credentials.json')) -or [bool]$env:CLAUDE_CODE_OAUTH_TOKEN
    Send-Message @{ ok = $true; version = ((& $claude --version) -join ' ').Trim(); signedIn = $signedIn }
    exit
  }

  if ($msg.type -eq 'complete') {
    # Run in an empty folder so no project settings or notes are picked up.
    $work = Join-Path $env:TEMP 'translate-tube-claude'
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Push-Location $work
    # Windows PowerShell stops on any line Claude writes to stderr unless told not to.
    $ErrorActionPreference = 'Continue'
    try {
      $text = "$($msg.system)`n`n$($msg.prompt)"
      $raw = ($text | & $claude -p --model $msg.model --output-format json 2>&1 | ForEach-Object { "$_" }) -join "`n"
    } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
    $start = $raw.IndexOf('{')
    if ($start -lt 0) { Send-Message @{ ok = $false; code = 'failed'; error = $raw.Trim() }; exit }
    $res = $raw.Substring($start) | ConvertFrom-Json
    if ($res.is_error) { Send-Message @{ ok = $false; code = 'failed'; error = [string]$res.result }; exit }
    Send-Message @{ ok = $true; text = [string]$res.result }
    exit
  }

  Send-Message @{ ok = $false; code = 'bad-request'; error = "Unknown request: $($msg.type)" }
} catch {
  Send-Message @{ ok = $false; code = 'failed'; error = $_.Exception.Message }
}
