$ErrorActionPreference = 'Stop'
$jevRoot = Split-Path -Parent $PSScriptRoot
try {
    $jevHealth = Invoke-RestMethod 'http://127.0.0.1:8017/health' -TimeoutSec 2
    if ($jevHealth.ready -and $jevHealth.model -eq 'guanxuyu/visual-jev-4b-answer-sft') {
        Write-Output 'Visual JEV is already running.'
        exit 0
    }
} catch { }
$jevListener = Get-NetTCPConnection -LocalPort 8017 -State Listen -ErrorAction SilentlyContinue
if ($jevListener) { throw 'Port 8017 is occupied by another service.' }
Start-Process -FilePath (Join-Path $PSScriptRoot '.venv/Scripts/python.exe') -ArgumentList 'localtools/visual_jev_server.py' -WorkingDirectory $jevRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $jevRoot 'data/jev-runtime.log') -RedirectStandardError (Join-Path $jevRoot 'data/jev-runtime-error.log')
Write-Output 'Visual JEV is starting. Check http://127.0.0.1:8017/health for readiness; startup errors are in data/jev-runtime-error.log.'
