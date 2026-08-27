# deploy.ps1 - publish Rial to GitHub Pages.
# Run this AFTER `gh auth login` (see SETUP.md "Deploy to GitHub Pages").
#
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1              # public repo (free)
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Private     # needs GitHub Pro
#
# NOTE: GitHub Pages on a PRIVATE repo requires a paid plan. On the free plan use a
# PUBLIC repo - that exposes only the app code (no secrets); your financial data
# lives on your device, never in the repo.

param([switch]$Private)

# PS 5.1: keep going on non-zero exits from native commands; we check $LASTEXITCODE.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# locate gh even if it isn't on PATH yet (fresh install)
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  foreach ($p in @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe")) {
    if (Test-Path $p) { $gh = $p; break }
  }
}
if (-not $gh) { Fail "GitHub CLI (gh) not found. Install: winget install --id GitHub.cli" }

& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Not logged in. Run: gh auth login  (then re-run this script)" }

$user = (& $gh api user --jq .login 2>$null | Out-String).Trim()
if (-not $user) { Fail "Could not read your GitHub username (gh api user)." }
$repo = "rial-app"
Write-Host "GitHub user: $user"

# does the repo already exist?
& $gh repo view "$user/$repo" 2>&1 | Out-Null
$repoExists = ($LASTEXITCODE -eq 0)

if (-not $repoExists) {
  $vis = "--public"; if ($Private) { $vis = "--private" }
  Write-Host "Creating $user/$repo ($vis) and pushing ..."
  & $gh repo create $repo $vis --source=. --remote=origin --push
  if ($LASTEXITCODE -ne 0) { Fail "gh repo create failed (see output above)." }
}
else {
  Write-Host "$user/$repo already exists - pushing latest commits."
  & git remote get-url origin 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & git remote add origin "https://github.com/$user/$repo.git" }
  & git push -u origin main
  if ($LASTEXITCODE -ne 0) { Fail "git push failed." }
}

# enable GitHub Pages: branch main, path / (JSON body via --input)
Write-Host "Enabling GitHub Pages ..."
$body = '{"source":{"branch":"main","path":"/"}}'
$body | & $gh api -X POST "repos/$user/$repo/pages" --input - 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  $body | & $gh api -X PUT "repos/$user/$repo/pages" --input - 2>&1 | Out-Null
}
& $gh api "repos/$user/$repo/pages" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "  Could not confirm Pages via API. Enable manually if needed:"
  Write-Host "  repo Settings > Pages > Source: Deploy from a branch > main / (root)"
}

$pagesUrl = "https://$user.github.io/$repo/"
Write-Host ""
Write-Host "Pages URL: $pagesUrl"
Write-Host "Waiting for the first build (can take 1-3 min) ..."

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 10
  try {
    $r = Invoke-WebRequest -Uri "${pagesUrl}index.html" -UseBasicParsing -TimeoutSec 15
    if ($r.StatusCode -eq 200 -and $r.Content -match "Rial") { $ok = $true; break }
  }
  catch {}
  Write-Host ("  ...still building ({0}s)" -f ($i * 10))
}

Write-Host ""
if ($ok) {
  Write-Host "LIVE  ->  $pagesUrl"
  Write-Host "Open that in Safari on your iPhone, then Share > Add to Home Screen."
}
else {
  Write-Host "Pushed OK, but Pages not confirmed live yet. Check with:"
  Write-Host "  gh api repos/$user/$repo/pages/builds/latest --jq .status"
  Write-Host "Then open: $pagesUrl"
}
