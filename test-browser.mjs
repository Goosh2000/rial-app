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
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.url()} — HTTP ${r.status()}`); });

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
    await page.screenshot({ path: path.join(__dir, `screenshot-theme-${id}.png`) });
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
