# Registers (or removes) a Scheduled Task that runs the stocky
# supervisor at logon. Run from anywhere; paths resolve relative to
# this script's location.
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
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

# node runs through the VBS wrapper so no console window appears;
# closing that window would kill the supervisor.
$wrapper = Join-Path $PSScriptRoot 'run-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action = New-ScheduledTaskAction -Execute $wscript `
    -Argument "`"$wrapper`" `"$node`" `"$tsx`" src/supervisor.ts" `
    -WorkingDirectory $repo
# Scoping the trigger to the current user lets this register without
# elevation; a bare -AtLogOn (any user) requires admin rights.
$user = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
} catch {
    Write-Error "Failed to register scheduled task '$taskName': $($_.Exception.Message)"
    exit 1
}
Write-Host "Registered scheduled task '$taskName': supervisor starts at logon."
Write-Host "It is not running yet; start it now with: npm run up"
Write-Host "Or start the task immediately: Start-ScheduledTask -TaskName '$taskName'"
