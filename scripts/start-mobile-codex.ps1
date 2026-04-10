$workspace = Split-Path -Parent $PSScriptRoot
$repo = if ($env:MOBILE_CODEX_UPSTREAM_DIR) {
  $env:MOBILE_CODEX_UPSTREAM_DIR
} else {
  Join-Path $workspace 'vendor\claudecodeui-1.25.2'
}

if (-not (Test-Path $repo)) {
  throw "Upstream checkout not found: $repo"
}

$node = if ($env:MOBILE_CODEX_NODE) {
  $env:MOBILE_CODEX_NODE
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    throw 'Node.js 22 LTS not found on PATH. Set MOBILE_CODEX_NODE if needed.'
  }
  $nodeCmd.Path
}

$npm = if ($env:MOBILE_CODEX_NPM) {
  $env:MOBILE_CODEX_NPM
} else {
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCmd) {
    $npmCmd.Path
  } else {
    $null
  }
}

$nodeModules = Join-Path $repo 'node_modules'
$distIndex = Join-Path $repo 'dist\index.html'
if (-not (Test-Path $nodeModules)) {
  throw "Upstream dependencies are not installed: $nodeModules. Run 'npm install' inside $repo first."
}

if (-not (Test-Path $distIndex)) {
  if (-not $npm) {
    throw "npm not found on PATH. Set MOBILE_CODEX_NPM if needed before building frontend assets."
  }

  Push-Location $repo
  try {
    & $npm 'run' 'build'
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$logDir = Join-Path $workspace 'tmp\logs'
$stdoutLog = Join-Path $logDir 'mobile-codex-app.stdout.log'
$stderrLog = Join-Path $logDir 'mobile-codex-app.stderr.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path $stdoutLog -Value ("`n==== START {0} ====`n" -f (Get-Date -Format s))
Add-Content -Path $stderrLog -Value ("`n==== START {0} ====`n" -f (Get-Date -Format s))

$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
$env:CODEX_ONLY_HARDENED_MODE = 'true'
$env:VITE_CODEX_ONLY_HARDENED_MODE = 'true'

Set-Location $repo
& $node 'server/index.js' 1>> $stdoutLog 2>> $stderrLog
