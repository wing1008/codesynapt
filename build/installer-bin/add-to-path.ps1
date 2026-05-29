# Add a directory to the current user's PATH (idempotent).
# Called by NSIS installer's customInstall hook.
param([Parameter(Mandatory=$true)][string]$Path)

$cur = [Environment]::GetEnvironmentVariable("Path", "User")
if ([string]::IsNullOrEmpty($cur)) {
  [Environment]::SetEnvironmentVariable("Path", $Path, "User")
  Write-Output "added (PATH was empty): $Path"
  exit 0
}
# Split, dedupe, check if already present
$parts = $cur -split ';' | Where-Object { $_ -ne '' }
if ($parts -contains $Path) {
  Write-Output "already present: $Path"
  exit 0
}
$new = ($parts + $Path) -join ';'
[Environment]::SetEnvironmentVariable("Path", $new, "User")
Write-Output "added: $Path"
