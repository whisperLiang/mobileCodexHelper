$workspace = Split-Path -Parent $PSScriptRoot
$upstream = if ($env:MOBILE_CODEX_UPSTREAM_DIR) {
  $env:MOBILE_CODEX_UPSTREAM_DIR
} else {
  Join-Path $workspace 'vendor\claudecodeui-1.25.2'
}

$nodeCommand = if ($env:MOBILE_CODEX_NODE) {
  (Get-Item $env:MOBILE_CODEX_NODE -ErrorAction Stop).FullName
} else {
  $nodeFromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeFromPath) { $nodeFromPath.Path } else { $null }
}

$wingetNginx = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\*nginx*\nginx-*\nginx.exe') -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1

$nginxCommand = if ($env:MOBILE_CODEX_NGINX) {
  (Get-Item $env:MOBILE_CODEX_NGINX -ErrorAction Stop).FullName
} else {
  $fromPath = Get-Command nginx -ErrorAction SilentlyContinue
  if ($fromPath) {
    $fromPath.Path
  } elseif ($wingetNginx) {
    $wingetNginx.FullName
  } else {
    $null
  }
}

$tailscalePath = if ($env:MOBILE_CODEX_TAILSCALE) {
  $env:MOBILE_CODEX_TAILSCALE
} else {
  'C:\Program Files\Tailscale\tailscale.exe'
}

[PSCustomObject]@{
  Workspace = $workspace
  UpstreamExists = (Test-Path $upstream)
  UpstreamPath = $upstream
  Node = $nodeCommand
  Nginx = $nginxCommand
  Tailscale = if (Test-Path $tailscalePath) { $tailscalePath } else { $null }
  Python = (Get-Command python -ErrorAction SilentlyContinue).Path
} | Format-List
