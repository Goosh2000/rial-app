# Rial

Private, offline-first personal finance PWA for one person. OMR currency, no backend,
no login. Data lives on-device in IndexedDB (localStorage fallback) with JSON backup/restore.

## Files
| file | purpose |
|---|---|
| `index.html` | the entire app — all CSS + JS inline |
| `manifest.json` | PWA manifest (install to Home Screen) |
| `sw.js` | service worker — offline shell + OCR-asset caching |
| `icon-*.png` | app icons (generated) |
| `build-icons.js` | regenerates icons — pure Node, no deps: `node build-icons.js` |
| `test*.mjs` | test suites (see **Test** below) |
| `deploy.ps1` | one-shot GitHub Pages deploy (run after `gh auth login`) |
| `SETUP.md` | deploy + install on iPhone, clearing a stale service worker |
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
npm test         # test.mjs  +  test-dom.mjs  +  test-browser.mjs   (163 assertions)
```
- **`test.mjs`** (113) — pure logic in a `vm` sandbox: money math (integer baisa, no float
  drift), Asia/Muscat month/date boundaries, Safe-to-Spend (flat + envelope-aware),
  recurring-cadence normalisation & rollover, round-up sim, CSV parser + dedupe, SMS regex
  extractor, `.ics` structure/validity, export/import round-trip, every screen renders.
- **`test-dom.mjs`** (30) — real `index.html` in jsdom, driven through real event handlers:
  onboarding → keypad add → tab nav → split-salary → envelope-aware STS → wishlist 30-day
  lock → goal + move-to-savings transfer → SMS paste → CSV import + dedupe → `.ics` build →
  theme switch → JSON export. Includes a regression check that `#onb` computes to
  `display:none` when hidden.
- **`test-browser.mjs`** (20) — the app served over HTTP and loaded in real headless Chrome
  (auto-detected; Edge fallback; skips if neither installed). Asserts **no full-screen
  overlay covers the app** (`elementFromPoint` at 3 heights), the dashboard/tabs/keypad
  actually paint, the service worker registers, the page still renders after a hard reload
  and **offline**, and there are zero console/page errors or failed requests. Writes
  `screenshot-*.png` for each screen.

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
| 8 | CSV import (column mapper + remembered mapping + dedupe) · SMS paste-parser (editable regex) | ✅ |
| 9 | Screenshot OCR — Tesseract.js, lazy-loaded from CDN once then SW-cached, on-device, mandatory review | ✅ |
| 10 | Monthly Plan — split-salary ritual (goals first, then envelope sliders), pace indicators, envelope moves | ✅ |
| 11 | Notifications — `.ics` export (payments/wishlist/salary + alarms), staleness check, app-badge, in-app center | ✅ |

### Known limitations / notes
- **Badging API** updates only while the app or its SW is running — it reflects state "as of last open". iOS can't refresh it in the background.
- **OCR** needs one network fetch (jsDelivr) on first use to grab the engine; cached by the SW afterwards. Accuracy on bank UIs is ~70–85% — the review card is mandatory, OCR never auto-saves.
- **No background notifications** are possible from an iOS web app without a push server (out of scope). The `.ics` + Shortcuts-automation path is the serverless substitute.
- Recurring cadence "monthly" from day 29–31 follows JS date rules (e.g. Jan 31 + 1 month → Mar 3). Use day ≤ 28 for predictable monthly billing.
