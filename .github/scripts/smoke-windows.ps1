# Starts a packaged gitdesk and waits for main to log that its window loaded.
# Usage: smoke-windows.ps1 <path to gitdesk.exe>
param([Parameter(Mandatory)] [string] $App)
$ErrorActionPreference = 'Stop'

$log = Join-Path $env:APPDATA 'gitdesk\logs\main.log'
Remove-Item $log -ErrorAction SilentlyContinue

$process = Start-Process -FilePath $App -PassThru
try {
  for ($i = 0; $i -lt 60; $i++) {
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'window ready' -Quiet)) {
      Write-Output 'gitdesk started and loaded its window.'
      exit 0
    }
    if ($process.HasExited) { break }
    Start-Sleep -Seconds 1
  }
  Write-Output "::error::gitdesk did not log 'window ready' within 60 seconds."
  if (Test-Path $log) { Get-Content $log } else { Write-Output "(no log file at $log)" }
  exit 1
} finally {
  # Ending the main process closes its renderer and helper processes too.
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
