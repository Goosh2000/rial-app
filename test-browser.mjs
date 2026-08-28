/* test-browser.mjs — real headless Chrome smoke test (dev only).
   Serves the folder over HTTP and loads it in the installed Chrome via puppeteer-core.
   Catches console errors, page errors, failed requests, and confirms the app actually
   paints (no black screen). Also exercises the service worker + a hard reload.
   Run:  node test-browser.mjs
*/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const CHROME =
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((p) => fs.existsSync(p));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
};

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("  FAIL " + n + (extra ? "  -> " + extra : ""))); };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.join(__dir, rel);
  if (!file.startsWith(__dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

(async () => {
  if (!CHROME) { console.error("No Chrome/Edge found — skipping browser test"); process.exit(0); }
  await new Promise((r) => server.listen(PORT, r));
  const base = `http://localhost:${PORT}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location();
    const line = msg.text() + (loc && loc.url ? "  [" + loc.url + "]" : "");
    if (/favicon\.ico/.test(line)) return; // browser auto-probe, not an app error
    consoleErrors.push(line);
  });
  page.on("pageerror", (err) => pageErrors.push(err.message + "\n" + (err.stack || "")));
  // theme web-fonts (Google Fonts) degrade to a fallback stack by design — not app failures
  // blob: URLs are in-memory; an aborted blob load (revoked object URL / audio src swap) is not a network failure
  const ignoreReq = (u) => /favicon\.ico|fonts\.googleapis\.com|fonts\.gstatic\.com|^blob:/.test(u);
  page.on("requestfailed", (r) => { if (!ignoreReq(r.url())) failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !ignoreReq(r.url())) failedRequests.push(`${r.url()} — HTTP ${r.status()}`); });

  // ---- first load ----
  await page.goto(`${base}/index.html`, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800)); // let boot() settle

  const crash = await page.evaluate(() => {
    const el = document.getElementById("__crash");
    return el ? el.textContent : null;
  });
  ok("no crash overlay shown", crash === null, crash ? crash.slice(0, 400) : "");

  const view = await page.evaluate(() => {
    const v = document.getElementById("view");
    const onb = document.getElementById("onb");
    return {
      viewHtmlLen: v ? v.innerHTML.length : -1,
      onbVisible: onb ? !onb.hidden : false,
      bodyText: document.body.innerText.slice(0, 200),
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });
  ok("first-run onboarding is visible", view.onbVisible, JSON.stringify(view));
  ok("body has a painted (non-transparent) background", view.bg && view.bg !== "rgba(0, 0, 0, 0)", view.bg);

  await page.screenshot({ path: path.join(__dir, "screenshot-onboarding.png") });

  // ---- drive onboarding + confirm dashboard paints ----
  await page.evaluate(async () => {
    // skip onboarding straight through
    const clickByText = (re) => {
      const b = [...document.querySelectorAll("#onb button")].find((x) => re.test(x.textContent));
      if (b) b.click();
    };
    clickByText(/Skip/);
  });
  await new Promise((r) => setTimeout(r, 400));
  const home = await page.evaluate(() => ({
    onbHidden: document.getElementById("onb").hidden,
    hasSafeToSpend: /safe to spend/i.test(document.getElementById("view").innerText),
    tabCount: document.querySelectorAll("nav#tabs [data-tab]").length,
  }));
  ok("onboarding dismissed via Skip", home.onbHidden);
  ok("dashboard renders 'Safe to spend'", home.hasSafeToSpend);
  ok("bottom nav has 4 tabs", home.tabCount === 4);
  await page.screenshot({ path: path.join(__dir, "screenshot-home.png") });

  // is the home content actually VISIBLE (not just present in the DOM)?
  const vis = await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
      return { y:r.y|0, w:r.width|0, h:r.height|0, disp:c.display, vis:c.visibility, op:c.opacity, z:c.zIndex, tf:c.transform }; };
    const view = document.getElementById("view");
    const card = view.querySelector(".card");
    const hitName = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) return null;
      // walk up to a meaningful ancestor id
      let n = e; while (n && n !== document.body) { if (n.id) return n.id; n = n.parentElement; } return e.tagName; };
    return {
      card: card ? rect(card) : null,
      cardText: card ? card.innerText.slice(0, 40) : null,
      hitTop: hitName(innerWidth / 2, innerHeight * 0.25),
      hitMid: hitName(innerWidth / 2, innerHeight * 0.5),
      hitLow: hitName(innerWidth / 2, innerHeight * 0.8),
      onb: rect(document.getElementById("onb")),
      full: rect(document.getElementById("full")),
    };
  });
  ok("home .card is on-screen with size", vis.card && vis.card.w > 100 && vis.card.h > 20 && vis.card.y < 844, JSON.stringify(vis.card));

  // THE black-screen check: is a full-screen overlay covering the app?
  const covering = [vis.hitTop, vis.hitMid, vis.hitLow].filter((h) => ["onb", "full", "__crash"].includes(h));
  ok("no full-screen overlay is covering the app", covering.length === 0,
     `hit points -> top:${vis.hitTop} mid:${vis.hitMid} low:${vis.hitLow}  onb:${JSON.stringify(vis.onb)}`);
  ok("#onb is display:none after onboarding", vis.onb.disp === "none", JSON.stringify(vis.onb));
  ok("hit points land inside the app UI", ["view", "app", "tabs"].includes(vis.hitMid), `mid hit = ${vis.hitMid}`);

  // ---- visual sweep of every tab + the add sheet ----
  for (const tab of ["tx", "plan", "insights"]) {
    await page.evaluate((t) => document.querySelector(`nav#tabs [data-tab="${t}"]`).click(), tab);
    await new Promise((r) => setTimeout(r, 300));
    const painted = await page.evaluate(() => {
      const e = document.elementFromPoint(innerWidth / 2, innerHeight * 0.4);
      let n = e; while (n && n !== document.body) { if (n.id === "onb" || n.id === "full") return false; n = n.parentElement; }
      return document.getElementById("view").innerText.length > 20;
    });
    ok(`tab "${tab}" paints content`, painted);
    await page.screenshot({ path: path.join(__dir, `screenshot-${tab}.png`) });
  }
  await page.evaluate(() => document.getElementById("addBtn").click());
  await new Promise((r) => setTimeout(r, 350));
  const sheetOpen = await page.evaluate(() => document.getElementById("sheet").classList.contains("open") && !!document.getElementById("keypad"));
  ok("add-transaction keypad sheet opens", sheetOpen);
  await page.screenshot({ path: path.join(__dir, "screenshot-keypad.png") });
  await page.evaluate(() => document.getElementById("scrim").click());
  await page.evaluate(() => document.querySelector('nav#tabs [data-tab="home"]').click());
  await new Promise((r) => setTimeout(r, 200));

  // ---- Settings is reachable: persistent gear in the header on every tab ----
  {
    const gear = await page.evaluate(() => {
      const perTab = {};
      for (const t of ["home", "tx", "plan", "insights"]) {
        document.querySelector(`nav#tabs [data-tab="${t}"]`).click();
        const g = document.getElementById("settingsBtn");
        const r = g ? g.getBoundingClientRect() : null;
        perTab[t] = { present: !!g, aria: g ? g.getAttribute("aria-label") : null, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
      }
      return perTab;
    });
    for (const t of ["home", "tx", "plan", "insights"]) {
      ok(`Settings gear present + labelled on "${t}"`, gear[t].present && /setting/i.test(gear[t].aria || ""), JSON.stringify(gear[t]));
      ok(`Settings gear has a >=44px touch target on "${t}"`, gear[t].w >= 44 && gear[t].h >= 44, JSON.stringify(gear[t]));
    }
    await page.evaluate(() => document.querySelector('nav#tabs [data-tab="insights"]').click());
    await new Promise((r) => setTimeout(r, 150));
    await page.evaluate(() => document.getElementById("settingsBtn").click());
    await new Promise((r) => setTimeout(r, 300));
    const opened = await page.evaluate(() => ({
      open: !!document.querySelector("#full.open"),
      isSettings: /Settings/i.test(document.querySelector("#full h1")?.textContent || "") && !!document.querySelector("#full [data-theme-set]"),
    }));
    ok("tapping the gear opens the Settings panel", opened.open && opened.isSettings, JSON.stringify(opened));
    await page.evaluate(() => { try { closeFull(); } catch (_) {} document.querySelector('nav#tabs [data-tab="home"]').click(); });
    await new Promise((r) => setTimeout(r, 200));
  }

  // ---- every theme renders with readable contrast ----
  const themeIds = await page.evaluate(() => (typeof THEME_IDS !== "undefined" ? THEME_IDS : []));
  ok("THEME_IDS registry exposed", themeIds.length >= 4, JSON.stringify(themeIds));
  for (const id of themeIds) {
    await page.evaluate((t) => applyTheme(t), id);
    await new Promise((r) => setTimeout(r, 120));
    const t = await page.evaluate(() => {
      const rgb = (varName) => {                       // resolve a CSS custom prop to real rgb
        const p = document.createElement("span");
        p.style.cssText = "position:absolute;opacity:0;color:var(" + varName + ")";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
        return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
      const bg = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const cText = contrast(bg, rgb("--text"));
      const cDim = contrast(bg, rgb("--text-dim"));
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        textOK: cText >= 4.5, dimOK: cDim >= 3,
        cText: +cText.toFixed(2), cDim: +cDim.toFixed(2),
      };
    });
    ok(`theme "${id}": body text contrast >= 4.5 (${t.cText})`, t.textOK, JSON.stringify(t));
    ok(`theme "${id}": dim text contrast >= 3 (${t.cDim})`, t.dimOK, JSON.stringify(t));

    if (id === "monarch") {
      await new Promise((r) => setTimeout(r, 400));
      const m = await page.evaluate(() => {
        const card = document.querySelector("#view .card");
        return {
          fontLinkInjected: !!document.querySelector('link[data-theme-font*="fonts.googleapis.com"]'),
          headingVar: getComputedStyle(document.documentElement).getPropertyValue("--font-heading").trim(),
          headingUsesOrbitron: /Orbitron/i.test(getComputedStyle(document.querySelector(".pagehead h1")).fontFamily),
          cardHasNotch: card ? getComputedStyle(card).clipPath !== "none" : false,
          rLg: getComputedStyle(document.documentElement).getPropertyValue("--r-lg").trim(),
        };
      });
      ok("monarch: Google-Fonts <link> injected on activate", m.fontLinkInjected, JSON.stringify(m));
      ok("monarch: --font-heading overridden to Orbitron stack", /Orbitron/i.test(m.headingVar), m.headingVar);
      ok("monarch: headings resolve to the Orbitron stack", m.headingUsesOrbitron, JSON.stringify(m));
      ok("monarch: cards get the System-window corner notch (clip-path)", m.cardHasNotch, JSON.stringify(m));
      ok("monarch: sharp radii from the theme file (--r-lg 5px)", m.rLg === "5px", m.rLg);

      // gamification module + theme music (only live under a theme that declares them)
      await page.evaluate(() => go("home"));
      await new Promise((r) => setTimeout(r, 1100));            // let the count-up settle
      const gm = await page.evaluate(() => {
        const num = document.querySelector('#view .hero .big [data-count]');
        const target = num ? parseFloat(num.getAttribute("data-count")) : NaN;
        return {
          panel: !!document.querySelector("#view .game-panel"),
          quests: document.querySelectorAll("#view .game-panel .quest").length,
          xpbar: !!document.querySelector("#view .game-panel .xpbar > i"),
          musicBtn: !!document.getElementById("musicToggle"),
          audioNoSrc: (() => { const a = document.getElementById("themeAudio"); return !!a && !a.getAttribute("src"); })(),
          countSettled: num ? num.textContent === U.fmt(Math.round(target)) : false,
        };
      });
      ok("monarch: gamification panel on the dashboard", gm.panel, JSON.stringify(gm));
      ok("monarch: three daily quests", gm.quests === 3, JSON.stringify(gm));
      ok("monarch: XP bar rendered", gm.xpbar, JSON.stringify(gm));
      ok("monarch: tap-to-play music toggle in the header", gm.musicBtn, JSON.stringify(gm));
      ok("monarch: <audio> carries no src until tapped (no network hit)", gm.audioNoSrc, JSON.stringify(gm));
      ok("monarch: count-up lands on the real value", gm.countSettled, JSON.stringify(gm));
    }
    await page.screenshot({ path: path.join(__dir, `screenshot-theme-${id}.png`) });
  }

  // ---- Monarch: user-picked music file, stored as a Blob in IndexedDB ----
  {
    await page.evaluate(async () => { await pickThemeManually("monarch"); });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => openOverlay("settings"));
    await new Promise((r) => setTimeout(r, 200));
    const ui = await page.evaluate(() => {
      const lbl = document.querySelector('label.filepick[for="musicFilePick"]');
      const inp = document.getElementById("musicFilePick");
      const cs = inp ? getComputedStyle(inp) : null;
      return {
        isLabel: !!lbl && lbl.tagName === "LABEL",
        inputPresent: !!inp,
        inputNotDisplayNone: cs ? cs.display !== "none" : false,
        inputVisuallyHidden: cs ? (cs.position === "absolute" && parseFloat(cs.opacity) === 0) : false,
        acceptBroad: inp ? (/audio\/\*/.test(inp.accept) && /\.mp3/.test(inp.accept) && /\.m4a/.test(inp.accept) && /\.wav/.test(inp.accept)) : false,
        labelFocusable: lbl ? lbl.getAttribute("tabindex") === "0" : false,
        labelTarget: lbl ? Math.round(lbl.getBoundingClientRect().height) : 0,
        warns: /only in this browser/i.test(document.getElementById("full").textContent),
        diag: /Theme music:/i.test(document.getElementById("full").textContent),
        removeBtn: !!document.getElementById("btnRemoveMusic"),
      };
    });
    ok("music: 'Choose music file' is a real <label for> (iOS-safe)", ui.isLabel && ui.inputPresent, JSON.stringify(ui));
    ok("music: file input is NOT display:none", ui.inputNotDisplayNone, JSON.stringify(ui));
    ok("music: file input is visually hidden via CSS, kept in layout", ui.inputVisuallyHidden, JSON.stringify(ui));
    ok("music: accept covers audio/* + .mp3/.m4a/.wav", ui.acceptBroad, JSON.stringify(ui));
    ok("music: label is keyboard-focusable with a >=44px target", ui.labelFocusable && ui.labelTarget >= 44, JSON.stringify(ui));
    ok("music: Settings warns the file is browser-only", ui.warns, JSON.stringify(ui));
    ok("music: Troubleshooting shows a music diagnostic", ui.diag, JSON.stringify(ui));
    ok("music: no 'Remove' button before a file is chosen", !ui.removeBtn, JSON.stringify(ui));

    // a file with an EMPTY type (as AirDrop/email MP3s often are) must still be accepted
    const emptyType = await page.evaluate(async () => {
      const buf = await fetch("assets/theme-music.mp3").then((r) => r.arrayBuffer());
      const file = new File([buf], "airdropped.mp3", { type: "" });   // no MIME
      const res = await themeMusic.setLocalFile(file);
      return { res, name: await DB.meta("musicFileName", null), decodeOk: themeMusic.decodeOk, hasLocal: themeMusic.hasLocal() };
    });
    ok("music: a file with empty MIME type is accepted (validated by decode, not MIME)", emptyType.res !== false && emptyType.name === "airdropped.mp3" && emptyType.hasLocal, JSON.stringify(emptyType));
    ok("music: decode check reports the file as playable", emptyType.decodeOk === true, JSON.stringify(emptyType));

    // a non-audio blob must FAIL the decode check, be reported, and never be handed to the player
    const bogus = await page.evaluate(async () => {
      const file = new File([new Uint8Array(4096).fill(65)], "not-audio.mp3", { type: "audio/mpeg" });
      const res = await themeMusic.setLocalFile(file);
      const src = themeMusic._srcNow();
      openOverlay("settings");
      await new Promise((r) => setTimeout(r, 150));
      return {
        res, decodeOk: themeMusic.decodeOk, broken: themeMusic.localBroken,
        srcSkipsBlob: !/^blob:/.test(src || ""),
        uiWarns: /won't decode|can'?t decode|cannot decode/i.test(document.getElementById("full").textContent),
        diag: (document.getElementById("full").textContent.match(/Theme music:[^\n]*/) || [""])[0],
      };
    });
    ok("music: an undecodable file is reported, not silently accepted", bogus.res === false && bogus.decodeOk === false && bogus.broken, JSON.stringify(bogus));
    ok("music: the broken blob is never handed to the audio element", bogus.srcSkipsBlob, JSON.stringify(bogus));
    ok("music: Settings names the decode failure + diagnostic shows CANNOT decode", bogus.uiWarns && /CANNOT decode/i.test(bogus.diag), JSON.stringify(bogus));
    await page.evaluate(() => { try { closeFull(); } catch (_) {} });

    // restore a good file for the rest of the flow
    const stored = await page.evaluate(async () => {
      const buf = await fetch("assets/theme-music.mp3").then((r) => r.arrayBuffer());
      const file = new File([buf], "my song.mp3", { type: "audio/mpeg" });
      const okSet = await themeMusic.setLocalFile(file);
      const blob = await DB.meta("musicFile", null);
      return {
        okSet,
        name: await DB.meta("musicFileName", null),
        size: await DB.meta("musicFileSize", 0),
        hasLocal: themeMusic.hasLocal(),
        blobIsBlob: blob instanceof Blob && blob.size > 1000,
      };
    });
    ok("music: setLocalFile stores the Blob + name + size in IndexedDB", stored.okSet && stored.blobIsBlob && stored.name === "my song.mp3" && stored.size > 1000, JSON.stringify(stored));
    ok("music: hasLocal() true once a file is stored", stored.hasLocal, JSON.stringify(stored));

    // the tap path must be synchronous up to .play() — toggle() is not async and holds the Blob in memory
    const syncPath = await page.evaluate(() => ({
      notAsync: themeMusic.toggle.constructor.name !== "AsyncFunction",
      blobInMemory: !!themeMusic.localBlob,
    }));
    ok("music: toggle() is synchronous up to play() (no await eats the iOS gesture)", syncPath.notAsync && syncPath.blobInMemory, JSON.stringify(syncPath));

    // it plays from a blob: URL and honours the theme's startAt (33s)
    const played = await page.evaluate(async () => {
      await themeMusic.toggle();
      await new Promise((r) => setTimeout(r, 1800));
      const a = document.getElementById("themeAudio");
      return { src: a.getAttribute("src"), isBlob: /^blob:/.test(a.src), paused: a.paused, t: +a.currentTime.toFixed(1) };
    });
    ok("music: local file plays via a blob: URL", played.isBlob && !played.paused, JSON.stringify(played));
    ok("music: playback honours theme startAt (~33s)", played.t >= 30 && played.t < 60, JSON.stringify(played));

    // settings now shows the file name + a Remove button
    await page.evaluate(() => openOverlay("settings"));
    await new Promise((r) => setTimeout(r, 200));
    const withFile = await page.evaluate(() => ({
      text: document.getElementById("full").textContent,
      removeBtn: !!document.getElementById("btnRemoveMusic"),
    }));
    ok("music: Settings shows the chosen file name", /my song\.mp3/.test(withFile.text), withFile.text.slice(0, 200));
    ok("music: Settings offers 'Remove music file'", withFile.removeBtn);

    // survives a full reload (persisted in IndexedDB), and the Blob is re-loaded into memory + re-decode-checked
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 900));
    await page.evaluate(async () => { await pickThemeManually("monarch"); });
    await page.waitForFunction(() => themeMusic.decodeOk !== null && !!themeMusic.localBlob, { timeout: 8000 }).catch(() => {});
    const afterReload = await page.evaluate(() => ({
      name: S.settings.musicFileName,
      size: S.settings.musicFileSize,
      hasLocal: themeMusic.hasLocal(),
      blobInMemory: !!themeMusic.localBlob,
      decodeOk: themeMusic.decodeOk,
      playable: themeMusic.playable(),
      btnVisible: (() => { const b = document.getElementById("musicToggle"); return !!b && !b.hidden; })(),
    }));
    ok("music: picked file persists across a reload (name + size)", afterReload.name === "my song.mp3" && afterReload.size > 1000 && afterReload.hasLocal, JSON.stringify(afterReload));
    ok("music: Blob re-loaded into memory + re-verified after reload", afterReload.blobInMemory && afterReload.decodeOk === true, JSON.stringify(afterReload));
    ok("music: control is available after reload", afterReload.playable && afterReload.btnVisible, JSON.stringify(afterReload));

    // Remove music file -> back to the declared-src fallback
    const removed = await page.evaluate(async () => {
      await themeMusic.removeLocalFile();
      await refresh();
      return {
        name: await DB.meta("musicFileName", null),
        blob: await DB.meta("musicFile", null),
        hasLocal: themeMusic.hasLocal(),
      };
    });
    ok("music: Remove clears the Blob + name from IndexedDB", removed.name === null && !removed.blob && !removed.hasLocal, JSON.stringify(removed));
    await page.evaluate(() => { try { closeFull(); } catch (_) {} });
  }

  await page.evaluate(() => applyTheme("midnight"));

  // ---- auto-scheduler: a scheduled switch actually applies (with crossfade) ----
  const sched = await page.evaluate(async () => {
    window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, addListener() {}, removeEventListener() {} }));
    applyTheme("paper");
    await saveSchedule({ mode: "windows", base: "midnight", windows: [{ start: "18:00", end: "06:00", theme: "depth" }] });
    S.settings.themeManual = null;
    const fadeBefore = getComputedStyle(document.getElementById("themeFade")).opacity;
    evaluateSchedule(new Date(2026, 7, 27, 21, 0, 0));            // 21:00 -> depth window
    await new Promise((r) => setTimeout(r, 100));
    const fadeMid = parseFloat(getComputedStyle(document.getElementById("themeFade")).opacity);
    await new Promise((r) => setTimeout(r, 400));
    return { after: document.documentElement.getAttribute("data-theme"),
             fadeBefore: parseFloat(fadeBefore), fadeMid,
             fadeAfter: parseFloat(getComputedStyle(document.getElementById("themeFade")).opacity) };
  });
  ok("scheduler switches theme in real browser (paper -> depth at 21:00)", sched.after === "depth", JSON.stringify(sched));
  ok("crossfade overlay animates then clears", sched.fadeBefore === 0 && sched.fadeMid > 0 && sched.fadeAfter === 0, JSON.stringify(sched));

  // schedule editor UI renders (screenshot for eyeballing)
  await page.evaluate(async () => {
    await saveSchedule({ mode: "windows", base: "paper", windows: [
      { start: "18:00", end: "06:00", theme: "midnight" }, { start: "06:00", end: "12:00", theme: "paper" }] });
    S.settings.themeManual = { theme: "desert", until: Date.now() + 3600000 };
    applyTheme("desert");
    openOverlay("settings");
  });
  await new Promise((r) => setTimeout(r, 250));
  const schedUI = await page.evaluate(() => ({
    hasSeg: document.querySelectorAll("[data-sched-mode]").length === 3,
    winRows: document.querySelectorAll(".sched-win").length,
    hasResume: !!document.getElementById("schedResume"),
    noteText: (document.querySelector(".sched-note") || {}).textContent || "",
  }));
  ok("schedule editor: 3 modes + 2 window rows + resume banner", schedUI.hasSeg && schedUI.winRows === 2 && schedUI.hasResume, JSON.stringify(schedUI));
  ok("schedule banner reads 'Manual: Desert'", /Manual:\s*Desert/.test(schedUI.noteText), schedUI.noteText);
  await page.screenshot({ path: path.join(__dir, "screenshot-schedule.png") });
  await page.evaluate(async () => { closeFull(); await saveSchedule({ mode: "off" }); S.settings.themeManual = null; applyTheme("midnight"); });
  await new Promise((r) => setTimeout(r, 350));

  // ---- theme link sharing: QR renders + a real scanner decodes it ----
  await page.evaluate(() => applyTheme("monarch"));
  const jsQRsrc = fs.readFileSync(path.join(__dir, "node_modules", "jsqr", "dist", "jsQR.js"), "utf8");
  await page.evaluate(jsQRsrc);   // expose window.jsQR
  const qrResult = await page.evaluate(async () => {
    const link = await buildShareLink("monarch");
    await showThemeQr();
    await new Promise((r) => setTimeout(r, 150));
    const svg = document.querySelector("#full svg");
    if (!svg) return { rendered: false, link: link.url };
    // rasterise the SVG to a canvas and scan it
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/svg+xml;base64," + btoa(xml); });
    const S = 8;               // px per QR module — generous for the scanner
    const cv = document.createElement("canvas");
    const vb = svg.getAttribute("viewBox").split(" ").map(Number);
    cv.width = vb[2] * S; cv.height = vb[3] * S;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    const id = cx.getImageData(0, 0, cv.width, cv.height);
    const dec = window.jsQR(id.data, cv.width, cv.height);
    return { rendered: true, link: link.url, decoded: dec ? dec.data : null };
  });
  ok("Show QR renders an <svg> QR code", qrResult.rendered);
  ok("a real QR scanner decodes the share link from the rendered QR", qrResult.decoded === qrResult.link,
     `decoded=${(qrResult.decoded || "null").slice(0, 50)}`);
  await page.screenshot({ path: path.join(__dir, "screenshot-theme-share.png") });
  await page.evaluate(() => closeFull());

  // ---- import flow via the real #theme= fragment + full reload (never auto-applies) ----
  const shareUrl = qrResult.link;
  await page.goto("about:blank");
  await page.goto(shareUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1600));   // boot + queued preview
  const imp = await page.evaluate(async () => ({
    fragmentCleared: !/theme=/.test(location.hash),
    previewShown: !!document.getElementById("tiImport"),
    theme: document.documentElement.getAttribute("data-theme"),
    stored: (await DB.meta("userThemes", [])).length,
  }));
  ok("opening a #theme= link clears the fragment", imp.fragmentCleared);
  ok("opening a #theme= link shows the preview (not auto-applied)", imp.previewShown && imp.theme !== "monarch-shared" && imp.stored === 0, JSON.stringify(imp));
  await page.screenshot({ path: path.join(__dir, "screenshot-theme-import.png") });
  const imported = await page.evaluate(async () => {
    document.getElementById("tiImport").click();
    await new Promise((r) => setTimeout(r, 500));
    return { theme: document.documentElement.getAttribute("data-theme"),
             stored: (await DB.meta("userThemes", [])).length };
  });
  ok("clicking Import stores + applies the shared theme", imported.stored === 1 && imported.theme === "monarch-shared", JSON.stringify(imported));
  await page.evaluate(async () => { await DB.setMeta("userThemes", []); location.hash = ""; });
  await page.goto(base + "/index.html", { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));

  // ---- service worker ----
  const sw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.getRegistration();
    return { supported: true, hasReg: !!reg, scope: reg?.scope || null };
  });
  ok("service worker registered", sw.supported && sw.hasReg, JSON.stringify(sw));

  // ---- hard reload: must still render from cache/network, no black screen ----
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const afterReload = await page.evaluate(() => ({
    crash: !!document.getElementById("__crash"),
    viewLen: document.getElementById("view").innerHTML.length,
    text: document.body.innerText.slice(0, 80),
  }));
  ok("renders after reload (SW-served), no crash", !afterReload.crash && afterReload.viewLen > 100, JSON.stringify(afterReload));

  // ---- offline reload: SW must fail open to cached shell ----
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const offline = await page.evaluate(() => ({
    crash: !!document.getElementById("__crash"),
    viewLen: document.getElementById("view") ? document.getElementById("view").innerHTML.length : -1,
  }));
  ok("works offline (SW serves cached shell)", !offline.crash && offline.viewLen > 100, JSON.stringify(offline));
  await page.setOfflineMode(false);

  // ---- URL parameters for iOS Shortcuts (?sms= / ?view=add) ----
  {
    const sms = "Salary OMR 644.000 Credited to your Account 26/08/2026.";
    await page.goto(base + "/index.html?sms=" + encodeURIComponent(sms), { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 900));
    const r = await page.evaluate(() => {
      const rv = document.getElementById("smsReview");
      return {
        overlayOpen: !!document.querySelector("#full.open"),
        reviewText: rv ? rv.textContent.slice(0, 200) : null,
        rows: document.querySelectorAll("#smsReview .rvrow").length,
        search: location.search,
        crash: !!document.getElementById("__crash"),
      };
    });
    ok("?sms= opens the pre-filled review screen", r.overlayOpen && r.rows === 1 && /644/.test(r.reviewText || ""), JSON.stringify(r));
    ok("?sms= is cleared from the URL (refresh won't re-import)", r.search === "", JSON.stringify(r));
    ok("?sms= does not crash the app", !r.crash);

    // oversized param is ignored without breaking the app
    await page.goto(base + "/index.html?sms=" + "x".repeat(6000), { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 700));
    const big = await page.evaluate(() => ({
      overlayOpen: !!document.querySelector("#full.open"),
      viewLen: document.getElementById("view").innerHTML.length,
      search: location.search,
    }));
    ok("oversized ?sms= is ignored, app still renders", !big.overlayOpen && big.viewLen > 100 && big.search === "", JSON.stringify(big));

    // ?view=add opens the keypad
    await page.goto(base + "/index.html?view=add", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));
    const add = await page.evaluate(() => ({
      keypadOpen: !!document.querySelector("#sheet.open #keypad"),
      search: location.search,
    }));
    ok("?view=add opens the add-transaction keypad", add.keypadOpen && add.search === "", JSON.stringify(add));
    await page.goto(base + "/index.html", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 400));
  }

  // ---- report collected errors ----
  if (failedRequests.length) console.log("  [network non-200]\n   " + failedRequests.join("\n   "));
  const realFailed = failedRequests.filter((u) => !/favicon/.test(u));
  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join("\n---\n").slice(0, 800));
  ok("no console errors", consoleErrors.length === 0, consoleErrors.join("\n").slice(0, 800));
  ok("no failed network requests", realFailed.length === 0, realFailed.join("\n"));

  await browser.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log("screenshots: screenshot-onboarding.png, screenshot-home.png");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
