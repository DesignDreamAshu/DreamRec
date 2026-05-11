$ErrorActionPreference = "Stop"

$patterns = @(
  '(?i)api[_-]?key\s*[:=]\s*["''][^"'']+["'']',
  '(?i)secret\s*[:=]\s*["''][^"'']+["'']',
  '(?i)token\s*[:=]\s*["''][^"'']+["'']',
  '(?i)password\s*[:=]\s*["''][^"'']+["'']',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
  '(?i)aws_access_key_id',
  '(?i)aws_secret_access_key',
  '(?i)client_secret'
)

$staged = git diff --cached --name-only --diff-filter=ACM
if (-not $staged) { exit 0 }

$blocked = @()
foreach ($file in $staged) {
  if ($file -match '^(\.git/|node_modules/|dist/|build/)') { continue }
  if ($file -eq 'scripts/secret-scan.ps1' -or $file -like '.githooks/*') { continue }
  if (-not (Test-Path -LiteralPath $file)) { continue }

  $content = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
  if (-not $content) { continue }

  foreach ($p in $patterns) {
    if ($content -match $p) {
      $blocked += "$file matched /$p/"
      break
    }
  }
}

if ($blocked.Count -gt 0) {
  Write-Host "[DreamRec] Commit blocked: potential secrets detected:" -ForegroundColor Red
  $blocked | ForEach-Object { Write-Host " - $_" -ForegroundColor Yellow }
  Write-Host "Review files and remove secrets (or move to env vars) before commit." -ForegroundColor Red
  exit 1
}

exit 0
