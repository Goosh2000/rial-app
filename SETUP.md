# Rial — setup & install

Rial is a single-page PWA. No backend, no account. All data lives in your iPhone's
Safari storage (IndexedDB). **Export a backup regularly — it is the only copy.**

---

## 1. Put it online — GitHub Pages (free, permanent, your account)

The repo is already initialised and committed locally (`git log` shows one commit).
You just need to authenticate GitHub CLI once, then run the deploy script.

### 1a. Authenticate GitHub CLI (`gh auth login`) — one time

`gh` (v2.98) is installed. In a terminal run:

```
gh auth login
```

Answer the prompts:
1. **What account do you want to log into?** → `GitHub.com`
2. **What is your preferred protocol for Git operations?** → `HTTPS`
3. **Authenticate Git with your GitHub credentials?** → `Yes`
4. **How would you like to authenticate?** → `Login with a web browser`
5. It shows a **one-time code** (e.g. `AB12-CD34`) and opens <https://github.com/login/device>.
   Paste the code there, approve, come back to the terminal.

Verify:
```
gh auth status        # should say "Logged in to github.com as <you>"
```

> If `gh` isn't on your PATH yet (fresh install), open a **new** terminal, or use the full
> path: `& "C:\Program Files\GitHub CLI\gh.exe" auth login`.

### 1b. Deploy

```
cd "C:\Users\Windows 10 Pro\projects\rial-app"
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

The script: creates `github.com/<you>/rial-app` (**public** — see note), pushes, enables
Pages from `main` / root, then polls the live URL until it returns HTTP 200 and prints:

```
LIVE  ->  https://<you>.github.io/rial-app/
```

> **Public vs private:** GitHub Pages on a *private* repo needs a paid plan. On the free
> plan the repo must be **public** — which only exposes the app *code* (no secrets in it);
> every byte of your financial data stays on your device and never touches the repo.
> To use a private repo (paid): `.\deploy.ps1 -Private`.

### Netlify Drop (only if the 401 you saw was a fluke you want to retry)

Drag the **whole `rial-app` folder** onto <https://app.netlify.com/drop>. The earlier 401
means that Drop site was unpublished / password-protected — use "Publish deploy" in the
Netlify dashboard, or just use GitHub Pages above.

> A service worker needs **HTTPS**. GitHub Pages and Netlify both provide it. Opening
> `index.html` from a `file://` path runs the app but won't register the service worker.

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

## 2b. If the app ever shows a blank/old screen (service worker)

The service worker (`sw.js`) is **network-first and fail-open**: when you're online it
always fetches the fresh page and only falls back to cache when offline. Each release
bumps `SW_VERSION`, and activating a new worker deletes every old cache. So a stale page
should never "stick" — but if you ever suspect it has:

**In the app:** Settings → Troubleshooting → **Clear cache & reload**. (Your data is untouched.)

**Manually on iPhone:** Settings → Safari → Advanced → Website Data → swipe-delete the
`github.io` entry → reopen the app. (This also clears IndexedDB, so **export a backup first**.)

**On desktop Chrome/Edge (for testing):** DevTools → Application → Service Workers →
*Unregister*, then Application → Storage → *Clear site data*.

**When you deploy an update:** bump `SW_VERSION` in `sw.js` (e.g. `"3"` → `"4"`) before
pushing. Existing installs pick it up on next launch and auto-reload once.

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
