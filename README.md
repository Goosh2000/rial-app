# Rial

Private, offline-first personal finance PWA for one person. OMR currency, no login.
Data lives on-device in IndexedDB (localStorage fallback) with JSON backup/restore.
An optional, self-hosted, zero-knowledge relay (Settings → Automatic import) can feed
bank alert emails in automatically — see `SERVER-SETUP.md` / `APPS-SCRIPT-SETUP.md` — but
the app is fully functional, offline-first, with none of that ever set up.

**Live:** https://goosh2000.github.io/rial-app/ · **Repo:** https://github.com/Goosh2000/rial-app

## Files
| file | purpose |
|---|---|
| `index.html` | the entire app — all CSS + JS inline (theme regions are generated) |
| `manifest.json` | PWA manifest (install to Home Screen) |
| `sw.js` | service worker — offline shell + OCR/web-font caching |
| `themes/*.theme.json` | theme source of truth — `base` is locked; see **THEME-SPEC.md** |
| `build-themes.js` | compiles `themes/*` into `index.html` — `node build-themes.js` (`--check` = CI) |
| `THEME-SPEC.md` | theme file format + token contract |
| `parser.js` | **bank-SMS parser** — single source of truth, CJS module, tested directly by `test-parser.mjs` |
| `build-parser.js` | inlines `parser.js` into `index.html` — `node build-parser.js` (`--check` = CI) |
| `PARSER-SPEC.md` | SMS parser contract: patterns, transfer-type rule, last4-only guarantee |
| `mime.js` | **MIME decoder** — strips a synced raw email down to readable text before the SMS parser ever sees it |
| `build-mime.js` | inlines `mime.js` into `index.html` — `node build-mime.js` (`--check` = CI) |
| `MIME-SPEC.md` | MIME decoder contract: header stripping, multipart walk, transfer-encoding/charset handling |
| `icon-*.png` | app icons (generated) |
| `build-icons.js` | regenerates icons — pure Node, no deps: `node build-icons.js` |
| `test*.mjs` | test suites (see **Test** below) — dev deps: `jsdom`, `puppeteer-core`, `jsqr` |
| `verify-live.mjs` | loads the deployed URL in headless Chrome and checks it renders clean |
| `deploy.ps1` | one-shot GitHub Pages deploy (run after `gh auth login`) |
| `SETUP.md` | deploy + install on iPhone, clearing a stale service worker |
| `server/` | optional Cloudflare Worker + D1 relay for automatic import — ciphertext only, see **SERVER-SETUP.md** |
| `apps-script/Code.gs` | optional Gmail pickup for automatic import — see **APPS-SCRIPT-SETUP.md** |
| `package.json` / `node_modules/` | **dev tooling only** — the app ships without them |

## Run locally
Any static server over HTTPS (or `localhost`) so the service worker registers:
```
npx serve .        # or: python -m http.server 8080
```
Then open the URL in a browser. On `file://` the app runs but the SW won't register.

## Test
```
npm install      # once — pulls jsdom + puppeteer-core (dev only, not shipped)
npm test         # build-themes/-parser --check  +  test-parser + test + test-dom + test-browser   (~490 assertions)
```
- **`test-parser.mjs`** (69) — `parser.js` in isolation: the 5 real bank-SMS fixtures with
  exact assertions (type, baisa amount, day-first date, last4 mapping), the **transfer-type
  rule** (all four branches + "internal SMS but I only own the source → `transfer_out`"),
  integer-baisa money (1000 × 0.001 == exactly 1.000), unknown format → review entry (never
  dropped/crashed), multi-message paste + stable dedupe keys, masking chars kept verbatim,
  **only last4 ever kept — the full/masked account token is scrubbed from the stored raw text**.
- **`test.mjs`** (270) — pure logic in a `vm` sandbox: money math (integer baisa, no float
  drift), Asia/Muscat month/date boundaries, Safe-to-Spend (flat + envelope-aware),
  recurring-cadence normalisation & rollover, round-up sim, CSV parser + dedupe, `parser.js`
  wiring, **multi-account balances + transaction-type predicates** (the 200.000 internal
  transfer moves both balances and changes spending by **zero** — never in envelopes or
  insights), **self-correcting daily allowance** (rolling 7-day correction, never negative,
  honest "impossible" message when the overage can't be absorbed above the floor),
  `.ics` structure/validity, export/import round-trip, every screen renders,
  **theme scheduler**, **theme-file engine**, **QR encoder** (round-trips through `jsQR`),
  **theme-link validation** — one valid theme + 20+ malicious payloads (script in a colour,
  external `url()`, `<script>` in the name, `javascript:`, `expression()`, `color-mix()`,
  unknown keys, path-traversal ids/fonts, oversized) each rejected cleanly, encode/decode
  round-trip + decoder robustness, user-theme registry (can't shadow a built-in).
- **`test-dom.mjs`** (109) — real `index.html` in jsdom, driven through real event handlers:
  onboarding (incl. account registration) → keypad add → tab nav → split-salary →
  envelope-aware STS → wishlist 30-day lock → goal + move-to-savings transfer → **paste all
  5 bank-SMS fixtures → review screen → save → assert each type/amount/account/category, the
  internal transfer nets to zero spending, balances move correctly, re-paste imports zero,
  unknown SMS → a review row (Save disabled), and a grep of the whole persisted store proves
  no account number longer than a 4-digit last4 exists anywhere** → **accounts card + daily
  allowance line on the dashboard** → CSV import + dedupe → `.ics` build →
  theme scheduler (deferral, manual override + resume, wrap-past-midnight) →
  **theme link round-trip through the import preview (never auto-applies), imported theme
  stored / applied / deletable, and 7 malicious/oversized/malformed links each leave the app
  byte-for-byte unchanged with the fragment cleared** → JSON export.
- **`test-browser.mjs`** (45) — the app served over HTTP and loaded in real headless Chrome
  (auto-detected; Edge fallback; skips if neither installed). Asserts **no full-screen
  overlay covers the app**, the dashboard/tabs/keypad paint, **all 5 themes' body/dim text
  meet WCAG-AA contrast**, **Monarch loads its Google Font + gets the System-window notch +
  sharp radii**, **a scheduled switch actually applies with the crossfade**, **the Share-QR
  renders and a real QR reader (`jsQR`) decodes it back to the exact share link**, **opening
  a `#theme=` URL shows the preview without auto-applying, then Import stores + applies it**,
  the schedule editor renders, the SW registers, the page still renders after a hard reload and
  **offline**, zero console/page errors. Writes `screenshot-theme-*.png` for each theme.

**Not** covered: touch-gesture feel, iOS Badging API, live Tesseract OCR accuracy, `.ics`
import into Apple Calendar — verify those on a device.

## Crash safety
- A crash-guard at the very top of the script turns any uncaught error / unhandled
  rejection into **visible red text on the page** — a JS error can never produce a silent
  black screen again. `boot()` has its own `.catch` into the same overlay.
- The service worker is **network-first + fail-open** with versioned caches; Settings →
  Troubleshooting → "Clear cache & reload" nukes SW + caches without touching data.

## Build status — all MVP features implemented

| # | Feature | State |
|---|---|---|
| — | Skeleton: storage, router, bottom nav, 4 themes, onboarding, backup, PWA | ✅ |
| 1 | Dashboard — Safe-to-Spend (envelope-aware), in/out/net, 30-day sparkline, 7-day due, streak, Friday card, bell | ✅ |
| 2 | Transactions — keypad add, day-grouped list, search/filter, long-press edit/delete, pending confirmations | ✅ |
| 3 | Recurring payments — cadences, auto-log-as-pending rollover, one-tap confirm, subscription audit + cost-per-use | ✅ |
| 4 | Wishlist — 30-day cooling timer, unlock check vs Safe-to-Spend, saving pace, work-hours, photo | ✅ |
| 5 | Savings goals — progress bars, move-to-savings transfer, round-up sweep, goal-reached chime | ✅ |
| 6 | Insights — this vs last month, biggest expenses, burn rate, weekday/weekend | ✅ |
| 7 | Monthly Wrapped — swipeable story cards, auto-opens first 3 days of a month | ✅ |
| 8 | CSV import (column mapper + remembered mapping + dedupe) · **real bank-SMS parser** (`parser.js`, multi-message paste, editable pattern object, merchant→category learning, mandatory review) | ✅ |
| 9 | Screenshot OCR — Tesseract.js, lazy-loaded from CDN once then SW-cached, on-device, mandatory review | ✅ |
| 10 | Monthly Plan — split-salary ritual (goals first, then envelope sliders), pace indicators, envelope moves | ✅ |
| 11 | Notifications — `.ics` export (payments/wishlist/salary + alarms), staleness check, app-badge, in-app center | ✅ |
| +  | **Theme engine** — themes are `themes/*.theme.json` data files (`base` locked, full token contract in **THEME-SPEC.md**); `build-themes.js` compiles palette + optional font + decorative CSS into `index.html`. `THEMES` registry drives the scheduler, settings picker and tests. Build fails on WCAG contrast regressions. | ✅ |
| +  | **Monarch theme** — Solo-Leveling "System window" feel, original CSS only: near-black navy + electric-blue glow, glowing 1px borders, corner-notch bevel, Orbitron headings (SW-cached), subtle scanlines, panel-materialize animation. Passes the same contrast bar (17:1 / 9.2:1). | ✅ |
| +  | **Theme auto-scheduler** — Settings › Theme › Schedule: Off / Match system / Time windows (wrap past midnight OK). Crossfades, never mid-interaction. Manual pick wins until the next boundary with a "resume schedule" banner. `themeSchedule`/`themeManual` meta, in backup. Reads themes from the loaded registry. | ✅ |
| +  | **Multi-account** — `accounts` store `{id,label,last4,type,isPrimary,openingBalance}`; **only the last 4 digits are ever stored** (stripped at parse time). Dashboard shows per-account balances + a combined total; manual entry and the SMS review route to an account, defaulting to primary. Registered in onboarding + Settings › Accounts. | ✅ |
| +  | **Transaction types** — `income` · `expense` · `transfer_internal` (between my own accounts — nets to zero, never spending, never touches an envelope or Safe-to-Spend, shown muted as "Moved") · `transfer_out` / `transfer_in` (to/from another person — real money). Detection rule (unit-tested, highest-risk logic): **both last4 mine → internal; source only → transfer_out; dest only → transfer_in**. | ✅ |
| +  | **Self-correcting daily allowance** — `(income − commitments − goal contributions − unspent envelope obligations) ÷ days in month`, then a **rolling 7-day correction** ("Yesterday you went over by 12.400 — allowance is 8.600 for the next week instead of 10.400"). Under-spend rolls forward too. Never shows a negative/zero allowance; when the overage can't be absorbed above a user floor it says so honestly and offers options. Excludes `transfer_internal` entirely. One line on the dashboard, detail overlay behind it. | ✅ |
| +  | **Theme link/QR sharing** — Settings › Theme › Copy share link / Show QR. Encodes the active palette (+ whitelisted font name) into a compressed `#theme=` **fragment** (never a server). Import shows a validated preview (mini-render, "audio not included", "custom effects not included") with explicit Import/Cancel — **never auto-applies**. Strict schema: unknown keys, non-strict colours, `url()`/`<>`/`javascript:`/`color-mix()` etc. reject the whole link and leave the app untouched. Inline QR encoder, no external service. Imported themes stored in `userThemes` (in backup), deletable, can't overwrite a built-in. See **THEME-SPEC.md § Link sharing**. | ✅ |

### Known limitations / notes
- **Badging API** updates only while the app or its SW is running — it reflects state "as of last open". iOS can't refresh it in the background.
- **OCR** needs one network fetch (jsDelivr) on first use to grab the engine; cached by the SW afterwards. Accuracy on bank UIs is ~70–85% — the review card is mandatory, OCR never auto-saves.
- **No background notifications** are possible from an iOS web app without a push server (out of scope). The `.ics` + Shortcuts-automation path is the serverless substitute.
- Recurring cadence "monthly" from day 29–31 follows JS date rules (e.g. Jan 31 + 1 month → Mar 3). Use day ≤ 28 for predictable monthly billing.
