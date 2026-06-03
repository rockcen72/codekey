param(
  [string]$Prompt,
  [string]$CodexExe
)

$ErrorActionPreference = 'Stop'

if (-not $Prompt) {
  $Prompt = 'Create or update F:\Work\Codekey\.tmp\codekey-hook-probe.txt with text: CodeKey hook probe. Then report the result.'
}

if (-not $CodexExe -and $env:CODEKEY_CODEX_EXE) {
  $CodexExe = $env:CODEKEY_CODEX_EXE
}

function Step($Message) {
  Write-Host ''
  Write-Host ('==> ' + $Message) -ForegroundColor Cyan
}

function Ok($Message) {
  Write-Host ('OK   ' + $Message) -ForegroundColor Green
}

function Warn($Message) {
  Write-Host ('WARN ' + $Message) -ForegroundColor Yellow
}

function Fail($Message) {
  Write-Host ('FAIL ' + $Message) -ForegroundColor Red
}

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptPath '..')).Path
$hookScript = Join-Path $repoRoot 'scripts\codex-permission-hook.cjs'
$repoHooks = Join-Path $repoRoot '.codex\hooks.json'
$probeDir = Join-Path $repoRoot '.tmp'
$probeFile = Join-Path $probeDir 'codekey-hook-probe.txt'
$hookLog = Join-Path $HOME '.codekey-codex-hook.log'

Step 'Repository'
Write-Host ('repoRoot   = ' + $repoRoot)
Write-Host ('hookScript = ' + $hookScript)
Write-Host ('repoHooks  = ' + $repoHooks)
Write-Host ('hookLog    = ' + $hookLog)

if (-not (Test-Path $hookScript)) {
  throw ('Hook script not found: ' + $hookScript)
}
Ok 'Hook script exists'

if (-not (Test-Path $repoHooks)) {
  Warn 'Repo hooks.json not found'
} else {
  Ok 'Repo hooks.json exists'
  $hooksText = Get-Content -Raw -Encoding UTF8 $repoHooks
  if ($hooksText -match '"SessionStart"') {
    Warn 'Repo hooks.json contains SessionStart'
  }
  if ($hooksText -match '"PermissionRequest"') {
    Ok 'Repo hooks.json contains PermissionRequest'
  } else {
    Warn 'Repo hooks.json does not contain PermissionRequest'
  }
}

Step 'Find codex.exe'
if (-not $CodexExe) {
  $extensionRoot = Join-Path $HOME '.vscode\extensions'
  $matches = @()
  if (Test-Path $extensionRoot) {
    $matches = Get-ChildItem -Path $extensionRoot -Recurse -Filter codex.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*openai.chatgpt*' -and $_.FullName -like '*windows-x86_64*' } |
      Sort-Object LastWriteTime -Descending

    if (-not $matches -or $matches.Count -eq 0) {
      $matches = Get-ChildItem -Path $extensionRoot -Recurse -Filter codex.exe -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    }
  }

  if ($matches -and $matches.Count -gt 0) {
    $CodexExe = $matches[0].FullName
  }
}

if (-not $CodexExe -or -not (Test-Path $CodexExe)) {
  Fail 'codex.exe not found. Set CODEKEY_CODEX_EXE and rerun.'
  exit 1
}
Ok ('codex.exe = ' + $CodexExe)

Step 'Codex version'
& $CodexExe --version

Step 'Simulate PermissionRequest hook stdin'
$sampleObj = @{
  session_id = 'codekey-hook-test'
  transcript_path = $null
  cwd = $repoRoot
  hook_event_name = 'PermissionRequest'
  model = 'gpt-5.5'
  permission_mode = 'default'
  turn_id = 'turn-test'
  tool_name = 'Bash'
  tool_input = @{
    command = ('New-Item -ItemType File -Path "' + $probeFile + '" -Force')
    description = 'CodeKey hook local simulation'
  }
}
$sample = $sampleObj | ConvertTo-Json -Depth 8 -Compress
$hookOutput = $sample | node $hookScript
Write-Host $hookOutput

try {
  $parsed = $hookOutput | ConvertFrom-Json
  $eventName = $parsed.hookSpecificOutput.hookEventName
  $behavior = $parsed.hookSpecificOutput.decision.behavior
  if ($eventName -ne 'PermissionRequest') {
    throw ('Unexpected hookEventName: ' + $eventName)
  }
  if ($behavior -ne 'allow' -and $behavior -ne 'deny') {
    throw ('Unexpected decision behavior: ' + $behavior)
  }
  Ok 'Hook script output is valid for PermissionRequest'
} catch {
  Fail ('Hook script output is invalid: ' + $_.Exception.Message)
  exit 1
}

Step 'Check user-level hooks for likely conflicts'
$userHooks = Join-Path $HOME '.codex\hooks.json'
$userConfig = Join-Path $HOME '.codex\config.toml'

if (Test-Path $userHooks) {
  Write-Host ('userHooks = ' + $userHooks)
  $userHooksText = Get-Content -Raw -Encoding UTF8 $userHooks
  if ($userHooksText -match '"SessionStart"') {
    Warn 'User hooks.json contains SessionStart. Check whether it points to codex-permission-hook.cjs.'
  }
} else {
  Write-Host 'userHooks = not found'
}

if (Test-Path $userConfig) {
  Write-Host ('userConfig = ' + $userConfig)
  $userConfigText = Get-Content -Raw -Encoding UTF8 $userConfig
  if ($userConfigText -match 'SessionStart') {
    Warn 'User config.toml contains SessionStart. Check whether it points to codex-permission-hook.cjs.'
  }
} else {
  Write-Host 'userConfig = not found'
}

Step 'Run codex hook probe'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
if (Test-Path $probeFile) {
  Remove-Item -Force $probeFile
}

$codexArgs = @(
  'exec',
  '--dangerously-bypass-hook-trust',
  '--sandbox', 'workspace-write',
  '--ask-for-approval', 'on-request',
  $Prompt
)

Write-Host ('codex args = ' + ($codexArgs -join ' '))
& $CodexExe @codexArgs
$exitCode = $LASTEXITCODE
Write-Host ('codex exit code = ' + $exitCode)

Step 'Probe result'
if (Test-Path $probeFile) {
  Ok ('Probe file exists: ' + $probeFile)
  Get-Content -Raw -Encoding UTF8 $probeFile
} else {
  Warn 'Probe file was not created. This can be expected if Codex did not run a write command.'
}

if (Test-Path $hookLog) {
  Step 'Recent hook log'
  Get-Content -Tail 80 -Encoding UTF8 $hookLog
} else {
  Warn ('Hook log not found: ' + $hookLog)
}

exit $exitCode
