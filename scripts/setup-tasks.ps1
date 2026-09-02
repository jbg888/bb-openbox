# setup-tasks.ps1 — registers two Windows Task Scheduler jobs. Run once from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
#
#   "BB OpenBox Scrape"  full run every 6 hours (00:00, 06:00, 12:00, 18:00 local)
#   "BB OpenBox Probe"   listing-only probe hourly at :30 (for learning when Best Buy updates; remove later)
#
# Both wake the machine if it is asleep. They cannot run if the laptop is fully shut down.

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = (Get-Command node).Source
if (-not $node) { Write-Error "node not found on PATH — install Node.js LTS first"; exit 1 }

$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Full scrape: every 6 hours starting at midnight
$scrapeAction = New-ScheduledTaskAction -Execute $node -Argument "scrape.js" -WorkingDirectory $root
$scrapeTrigger = New-ScheduledTaskTrigger -Once -At "00:00" -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "BB OpenBox Scrape" -Action $scrapeAction -Trigger $scrapeTrigger -Settings $settings -Principal $principal -Force | Out-Null

# Probe: hourly at :30
$probeAction = New-ScheduledTaskAction -Execute $node -Argument "scrape.js --probe" -WorkingDirectory $root
$probeTrigger = New-ScheduledTaskTrigger -Once -At "00:30" -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "BB OpenBox Probe" -Action $probeAction -Trigger $probeTrigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered tasks:"
Get-ScheduledTask -TaskName "BB OpenBox *" | Format-Table TaskName, State
Write-Host "`nLogs: each run's console output is not kept by Task Scheduler. To keep logs, change the Argument to:"
Write-Host '  cmd /c "node scrape.js >> logs\scrape.log 2>&1"'
