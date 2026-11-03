param([Parameter(Mandatory=$true)][string]$Preparation)
$ErrorActionPreference = 'Stop'
$receipt = Get-Content -LiteralPath $Preparation -Raw -Encoding UTF8 | ConvertFrom-Json
$profile = (Resolve-Path -LiteralPath $receipt.profile).Path
if ($receipt.test_only -ne $true -or $profile -notmatch '\\research\\native-smoke-\d{8}-\d{6}\\profile$') { throw 'Refusing a non-test profile' }
$owned = @(Get-CimInstance Win32_Process -Filter "Name='zotero.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) })
foreach ($entry in $owned) {
    $targetProcess = Get-Process -Id $entry.ProcessId -ErrorAction Stop
    $requested = $targetProcess.CloseMainWindow()
    if ($requested) { [void]$targetProcess.WaitForExit(10000) }
    [pscustomobject]@{ testProcessId=$entry.ProcessId; normalCloseRequested=$requested; exited=$targetProcess.HasExited }
}
if (-not $owned.Count) { 'No disposable Zotero profile is running.' }
# Never force-kill Zotero or match the user's normal profile by application name alone.
