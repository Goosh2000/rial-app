# deploy.ps1 — publish Rial to GitHub Pages.
# Run this AFTER `gh auth login` (see SETUP.md § "Deploy to GitHub Pages").
#
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1              # public repo (free)
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Private     # needs GitHub Pro
#
# Idempotent-ish: if the repo already exists it just pushes and re-checks Pages.
#
# NOTE: GitHub Pages on a PRIVATE repo requires a paid plan (Pro/Team/Enterprise).
# On the free plan use a PUBLIC repo — that only exposes the app shell (which has no
# secrets); all of your financial data lives on your device, never in the repo.

param([switch]$Private)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# locate gh even if it isn't on PATH yet (fresh install)
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  foreach ($p in @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe")) {
    if (Test-Path $p) { $gh = $p; break }
  }
}
if (-not $gh) { throw "GitHub CLI (gh) not found. Install: winget install --id GitHub.cli" }

# must be authenticated
& $gh auth status 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { throw "Not logged in. Run:  gh auth login   (then re-run this script)" }

$user = (& $gh api user --jq .login).Trim()
$repo = "rial-app"
Write-Host "GitHub user: $user"

# create the repo + push (skip creation if it already exists)
& $gh repo view "$user/$repo" 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  $vis = if ($Private) { "--private" } else { "--public" }
  Write-Host "Creating $user/$repo ($vis) ..."
  & $gh repo create $repo $vis --source=. --remote=origin --push
} else {
  Write-Host "$user/$repo already exists — pushing."
  git remote get-url origin 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { git remote add origin "https://github.com/$user/$repo.git" }
  git push -u origin main
}

# enable GitHub Pages from the main branch root (JSON body via --input, most reliable)
Write-Host "Enabling GitHub Pages ..."
$body = '{"source":{"branch":"main","path":"/"}}'
$body | & $gh api -X POST "repos/$user/$repo/pages" --input - 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  # already exists -> update it to point at main/root
  $body | & $gh api -X PUT "repos/$user/$repo/pages" --input - 1>$null 2>$null
}
# also enable via the Pages build workflow permission if needed
& $gh api "repos/$user/$repo/pages" 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "  (couldn't confirm Pages via API — enable it manually: repo Settings -> Pages -> Source: Deploy from a branch -> main / root)"
}

$pagesUrl = "https://$user.github.io/$repo/"
Write-Host ""
Write-Host "Pages URL: $pagesUrl"
Write-Host "Waiting for the first build to go live (can take 1-3 min) ..."

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 10
  try {
    $r = Invoke-WebRequest -Uri "${pagesUrl}index.html" -UseBasicParsing -TimeoutSec 15
    if ($r.StatusCode -eq 200 -and $r.Content -match "Rial") {
      $ok = $true; break
    }
  } catch {}
  Write-Host "  ...still building ($($i*10)s)"
}

Write-Host ""
if ($ok) {
  Write-Host "LIVE  ->  $pagesUrl"
  Write-Host "Open that in Safari on your iPhone, then Share -> Add to Home Screen."
} else {
  Write-Host "Not confirmed live yet. Check build status:"
  Write-Host "  $gh api repos/$user/$repo/pages/builds/latest --jq .status"
  Write-Host "Then open: $pagesUrl"
}
