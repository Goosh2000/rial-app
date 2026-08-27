# Rial — setup & install

Rial is a single-page PWA. No backend, no account. All data lives in your iPhone's
Safari storage (IndexedDB). **Export a backup regularly — it is the only copy.**

---

## 1. Put it online (pick one — both free)

### Option A — Netlify Drop (fastest, ~1 min)
1. Go to <https://app.netlify.com/drop>
2. Drag the **whole `rial-app` folder** onto the page.
3. Netlify gives you a URL like `https://rial-xyz.netlify.app`. Open it on your iPhone.

### Option B — GitHub Pages (free, permanent, your account)
1. Create a repo, e.g. `rial-app`, and push these files to the root:
   ```
   index.html  manifest.json  sw.js
   icon-180.png  icon-192.png  icon-512.png  icon-512-maskable.png
   ```
   (The `build-icons.js`, `test.mjs`, `*.md` files are dev-only — harmless to include.)
2. Repo → **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` / `/root` → Save.
3. Wait ~1 min. Your app is at `https://<your-username>.github.io/rial-app/`.

> A service worker requires **HTTPS**. Netlify and GitHub Pages both give you HTTPS automatically. Opening `index.html` from a `file://` path will *not* register the service worker (the app still works, just not fully offline until hosted).

### Regenerating icons
Only needed if you change the icon design in `build-icons.js`:
```
node build-icons.js
```

---

## 2. Add to iPhone Home Screen

1. Open the URL in **Safari** (not Chrome — only Safari can install PWAs on iOS).
2. Tap the **Share** button (square with an up-arrow).
3. Scroll down → **Add to Home Screen** → **Add**.
4. Launch it from the new "Rial" icon. It opens full-screen with no Safari chrome.
5. Run through the 4-step onboarding (or skip it).

**iOS version:** you need iOS 16.4 or newer for the app-icon badge to work. Everything
else works on iOS 15+.

---

## 3. Daily habit — "Morning check-in" Shortcut

iOS web apps can't send their own notifications without a push server (out of scope for v1).
Instead, make opening Rial a daily automation:

1. Open the **Shortcuts** app → **Automation** tab → **+** → **Create Personal Automation**.
2. Choose **Time of Day** → pick your time (e.g. 08:00) → **Daily** → Next.
3. **Add Action** → search **Open URLs** (or "Open App" won't work for PWAs — use Open URLs).
4. Paste your Rial URL (the Netlify / GitHub Pages one).
5. Next → turn **Ask Before Running** *off* → Done.

Now your phone opens Rial every morning so you actually look at your money.

---

## 4. Real reminders — Calendar export (`.ics`)

**Settings → Reminders → Export calendar (.ics)** downloads a file containing:
- recurring payment due dates — alarm **09:00 the day before**
- wishlist unlock dates — alarm that morning
- a monthly **"Split your salary"** reminder on your salary day

On your iPhone, open the downloaded file → **Add All** → the events land in Apple Calendar
and fire **native notifications with no server**. Re-export whenever you add/change recurring
items or wishlist entries — the app flags the export as "stale" in Settings and in the
notification bell when that happens.

> Tip: put these on a dedicated calendar (e.g. "Rial") so you can hide/refresh them easily.
> Re-importing the same file updates existing events rather than duplicating them.

---

## 5. Backups (important)

- Settings → **Export JSON** → save the file to Files / iCloud Drive / email it to yourself.
- Do this every week or two. The app reminds you after 14 days.
- **Clearing Safari website data, "Offload App"-style cleanups, or deleting the Home Screen
  icon can wipe the database.** The JSON export is your safety net.
- To restore or move to a new phone: install the app, then Settings → **Import JSON**.

---

## 6. Privacy

- No network requests except: loading the app itself, and (once) downloading the Tesseract.js
  OCR engine from a CDN, which is then cached for offline use.
- Your financial data, photos, and screenshots **never leave the device**.
- No analytics, no tracking, no accounts.
