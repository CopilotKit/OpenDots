# Starts the fully local OpenDots stack: Ollama (local model) + OpenDots, then
# opens it in your browser. Double-click "Start OpenDots.cmd" to run this.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$url = 'http://127.0.0.1:5173'

function Test-Up($address) {
  try { Invoke-WebRequest $address -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

try {
  # Already running (e.g. started earlier): just open it.
  if (Test-Up $url) {
    Write-Host 'OpenDots is already running. Opening it...'
    Start-Process $url
    exit 0
  }

  if (-not (Test-Up 'http://127.0.0.1:11434/api/version')) {
    Write-Host 'Starting Ollama...'
    # 16K context keeps models on the 16 GB GPU (32K overflowed and ran ~4x slower).
    $env:OLLAMA_CONTEXT_LENGTH = '16384'
    Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" -ArgumentList serve -WindowStyle Hidden
    Start-Sleep 4
  }

  if (-not (Test-Path node_modules)) { npm ci }
  if (-not (Test-Path localtools\.venv)) {
    Write-Warning 'localtools\.venv is missing; local tools will be unavailable. See docs/LOCAL.md.'
  }

  # Open the browser once the app answers (not before), from a helper process.
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    "for (`$i = 0; `$i -lt 90; `$i++) { try { Invoke-WebRequest '$url' -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process '$url'; break } catch { Start-Sleep 1 } }"
  )
  Write-Host "Starting OpenDots at $url (keep this window open; close it to stop OpenDots)..."
  # No auto-restart: editing files must never interrupt a running Dot.
  npm run local
  if ($LASTEXITCODE -ne 0) { throw "OpenDots stopped with exit code $LASTEXITCODE." }
} catch {
  Write-Host ''
  Write-Host "OpenDots could not start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'If another copy is already running, close its window first.'
  Read-Host 'Press Enter to close'
}
