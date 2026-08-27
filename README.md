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
| `test.mjs` | headless logic tests: `node test.mjs` |
| `SETUP.md` | how to host it and add it to an iPhone |

## Run locally
Any static server over HTTPS (or `localhost`) so the service worker registers:
```
npx serve .        # or: python -m http.server 8080
```
Then open the URL in a browser. On `file://` the app runs but the SW won't register.

## Test
```
npm install      # once, pulls jsdom (dev only)
npm test         # node test.mjs  +  node test-dom.mjs
```
- `test.mjs` (113 assertions) — pure logic in a `vm` sandbox: money math (integer baisa,
  no float drift), Asia/Muscat month/date boundaries, Safe-to-Spend (flat + envelope-aware),
  recurring-cadence normalisation & rollover, round-up sim, CSV parser + dedupe, SMS regex
  extractor, `.ics` structure/validity, export/import round-trip, every screen renders.
- `test-dom.mjs` (29 assertions) — real `index.html` booted in jsdom, driven through real
  event handlers: onboarding → add transaction via keypad → tab nav → split-salary ritual →
  envelope-aware STS → wishlist 30-day lock → goal + move-to-savings transfer → SMS paste →
  CSV import + duplicate detection → `.ics` build → theme switch → JSON export.

**Not** covered by either: real layout/paint, touch gestures, service-worker offline
behaviour, iOS Badging API, actual Tesseract OCR accuracy, `.ics` import into iOS Calendar —
verify those on a device.

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
