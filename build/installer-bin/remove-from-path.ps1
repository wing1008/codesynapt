# Remove a directory from the current user's PATH (idempotent).
# Called by NSIS uninstaller's customUnInstall hook.
param([Parameter(Mandatory=$true)][string]$Path)

$cur = [Environment]::GetEnvironmentVariable("Path", "User")
if ([string]::IsNullOrEmpty($cur)) {
  Write-Output "PATH was empty — nothing to remove"
  exit 0
}
$parts = $cur -split ';' | Where-Object { $_ -ne '' -and $_ -ne $Path }
$new = $parts -join ';'
[Environment]::SetEnvironmentVariable("Path", $new, "User")
Write-Output "removed: $Path"
