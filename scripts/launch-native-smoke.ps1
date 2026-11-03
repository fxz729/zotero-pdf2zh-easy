param(
    [Parameter(Mandatory=$true)][string]$Preparation,
    [string]$Zotero = 'D:\Program Files\Zotero\zotero.exe'
)
$ErrorActionPreference = 'Stop'
$receipt = Get-Content -LiteralPath $Preparation -Raw -Encoding UTF8 | ConvertFrom-Json
if ($receipt.test_only -ne $true -or $receipt.provider_credentials_copied -ne $false) { throw 'Not an approved empty smoke-test profile' }
$profile = (Resolve-Path -LiteralPath $receipt.profile).Path
if ($profile -notmatch '\\research\\native-smoke-\d{8}-\d{6}\\profile$' -or $profile.Contains('"')) { throw 'Refusing an unexpected profile path' }
if (-not (Test-Path -LiteralPath $Zotero -PathType Leaf)) { throw 'Zotero executable not found' }
# Use the desktop shell, matching an ordinary app launch rather than inheriting
# the command executor's job. The isolated test window starts minimized.
$shell = New-Object -ComObject Shell.Application
$shell.ShellExecute($Zotero, ('-no-remote -profile "' + $profile + '"'), '', 'open', 7)
'Isolated native Zotero test launch requested; normal profile is untouched.'
