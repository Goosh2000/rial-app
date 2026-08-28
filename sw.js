/* Rial service worker — offline-first, fail-open.
 *
 * Design rules (so a bad cache can never wedge the app):
 *  - CACHE name carries a version. Bump SW_VERSION on every index.html change.
 *  - activate() deletes every cache that isn't the current one.
 *  - Same-origin requests are NETWORK-FIRST: the network copy always wins when
 *    online; the cache is only a fallback for offline. A stale page cannot stick.
 *  - Navigations that fail fall back to the cached shell, then to a plain message
 *    (never a blank screen).
 *  - Precache is best-effort: one missing asset does not fail the install.
 *  - The page can force a full reset via postMessage({type:'CLEAR_CACHES'}).
 *
 * To wipe an old worker on a device: see "Reset app" in Settings, or in Safari:
 * Settings → Safari → Advanced → Website Data → remove this site.
 */
const SW_VERSION = "20";  // v20: streaks count real calendar days (gap detection, firstUseDate, neutral no-plan days)
const CACHE = "rial-cache-v" + SW_VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // best-effort: never let a single 404 abort the install
    await Promise.all(SHELL.map(async (url) => {
      try { await c.add(new Request(url, { cache: "reload" })); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  const t = e.data && e.data.type;
  if (t === "SKIP_WAITING") self.skipWaiting();
  if (t === "CLEAR_CACHES") {
    e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  }
});

// cross-origin assets we cache-first + keep offline: OCR engine, and theme web fonts
const isCacheableVendor = (url) =>
  /tesseract|tessdata|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(url);

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Vendor assets (cross-origin): cache-first, then network, cache forever.
  if (isCacheableVendor(url.href)) {
    e.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res && res.ok) (await caches.open(CACHE)).put(request, res.clone());
        return res;
      } catch (err) {
        return cached || new Response("", { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return; // let the browser handle other cross-origin

  // Same-origin: network-first, cache fallback (fail open).
  e.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res && res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
        return new Response(
          "<!doctype html><meta charset=utf-8><body style='background:#0b0d10;color:#f4f6f8;font:16px system-ui;padding:24px'>" +
          "Rial is offline and no cached copy is available yet. Reconnect once, then it will work offline.",
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return new Response("", { status: 504 });
    }
  })());
});
