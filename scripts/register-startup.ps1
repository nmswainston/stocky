# Registers (or removes) a Scheduled Task that runs the stocky
# supervisor at logon. Run from anywhere; paths resolve relative to
# this script's location.
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1 -Remove

param([switch]$Remove)

$taskName = 'Stocky Supervisor'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'"
    exit 0
}

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) {
    Write-Error "tsx not found at $tsx, run npm install first"
    exit 1
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$tsx`" src/supervisor.ts" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Write-Host "Registered scheduled task '$taskName': supervisor starts at logon."
Write-Host "It is not running yet; start it now with: npm run up"
Write-Host "Or start the task immediately: Start-ScheduledTask -TaskName '$taskName'"
