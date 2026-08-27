/* test-dom.mjs — DOM integration test using jsdom (dev dependency only; not shipped).
   Boots the real index.html, drives the UI through real event handlers, and checks
   that storage + rendering + navigation actually work end to end.
   Run:  node test-dom.mjs
   Not covered: service worker, real layout/paint, iOS APIs, OCR, file downloads. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const __dir = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("  FAIL " + n + (extra ? " -> " + extra : ""))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, tries = 60) => {
  for (let i = 0; i < tries; i++) { try { if (fn()) return true; } catch {} await sleep(25); }
  ok("timeout waiting for: " + label, false); return false;
};

const html = fs.readFileSync(path.join(__dir, "index.html"), "utf8");
const vc = new VirtualConsole();
const errors = [];
// jsdom can't do <a download> — it reports the click as a navigation attempt. Not an app bug.
const IGNORE = /Not implemented: navigation/;
vc.on("jsdomError", (e) => { if (!IGNORE.test(e.message)) errors.push(e.message); });
vc.sendTo({ error: (...a) => { const s = a.join(" "); if (!IGNORE.test(s)) errors.push(s); }, warn(){}, log(){}, info(){}, debug(){} });

const dom = new JSDOM(html, {
  url: "https://localhost/index.html",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const win = dom.window, doc = win.document;
win.URL.createObjectURL = () => "blob:stub";
win.URL.revokeObjectURL = () => {};

const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (el) => el && el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const setVal = (el, v) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); el.dispatchEvent(new win.Event("change", { bubbles: true })); };

(async () => {
  await until(() => $("#onb") && !$("#onb").hidden, "onboarding visible");
  ok("no jsdom errors during boot", errors.length === 0, errors.join(" | "));
  ok("onboarding shows on first run", $("#onb") && !$("#onb").hidden);

  // Step 1 -> 2
  click([...$$("#onb button")].find((b) => /Next/i.test(b.textContent)));
  await until(() => $("#onbIncome"), "income step");
  setVal($("#onbIncome"), "900");
  setVal($("#onbSalaryDay"), "25");
  click([...$$("#onb button")].find((b) => /Next/i.test(b.textContent)));
  await until(() => $("#onbSavePct"), "savings step");
  setVal($("#onbSavePct"), "15");
  click([...$$("#onb button")].find((b) => /Next/i.test(b.textContent)));
  await until(() => [...$$("#onb button")].some((b) => /Finish/i.test(b.textContent)), "envelopes step");
  click([...$$("#onb button")].find((b) => /Finish/i.test(b.textContent)));

  await until(() => $("#onb").hidden, "onboarding dismissed");
  ok("onboarding completes and hides", $("#onb").hidden);
  {
    // regression: `#onb{display:flex}` must not defeat the `hidden` attribute (black-screen bug)
    const disp = win.getComputedStyle($("#onb")).display;
    ok("#onb computed display is 'none' when hidden (not covering the app)", disp === "none", `display=${disp}`);
  }
  ok("home hero 'Safe to spend today' rendered", /Safe to spend today/i.test($("#view").textContent));

  // localStorage persisted the income
  ok("monthlyIncome saved to storage", win.localStorage.getItem("rial:meta:monthlyIncome") === "900000");

  // Add a transaction: 5.000 OMR, first category
  click($("#addBtn"));
  await until(() => $("#sheet.open #keypad"), "keypad sheet open");
  click([...$$("#sheet [data-k]")].find((b) => b.dataset.k === "5"));
  click([...$$("#sheet [data-k]")].find((b) => b.dataset.k === "."));
  click([...$$("#sheet [data-k]")].find((b) => b.dataset.k === "0"));
  click([...$$("#sheet [data-k]")].find((b) => b.dataset.k === "0"));
  click([...$$("#sheet [data-k]")].find((b) => b.dataset.k === "0"));
  ok("keypad shows 5.000", $("#kpVal").textContent === "5.000", $("#kpVal").textContent);
  click($("#sheet [data-cat]"));
  click($("#kpSave"));

  await until(() => !$("#sheet").classList.contains("open"), "sheet closed after save");
  ok("1 transaction stored", JSON.parse(win.localStorage.getItem("rial:transactions") || "[]").length === 1);

  // Transactions tab shows it
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "tx"));
  await until(() => /Transactions/i.test($("#view h1")?.textContent || ""), "tx screen");
  ok("transaction appears in list with amount", /5\.000/.test($("#view").textContent));

  // Home reflects spend
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "home"));
  await until(() => /Safe to spend/i.test($("#view").textContent), "home again");
  ok("home 'Out' total includes the 5.000", /5\.000/.test($("#view").textContent));

  // Plan tab + sub-tab switching
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "plan"));
  await until(() => $$("[data-plansub]").length === 4, "plan sub-tabs");
  click([...$$("[data-plansub]")].find((b) => b.dataset.plansub === "wishlist"));
  await until(() => /Wishlist is empty|Add to wishlist/i.test($("#view").textContent), "wishlist sub view");
  ok("Plan → Wishlist sub-tab renders", /wishlist/i.test($("#view").textContent));
  click([...$$("[data-plansub]")].find((b) => b.dataset.plansub === "payments"));
  await until(() => /recurring/i.test($("#view").textContent), "payments sub view");
  ok("Plan → Payments sub-tab renders", /recurring/i.test($("#view").textContent));

  // Add a recurring payment through the sheet
  click([...$$("#view [data-act]")].find((b) => b.dataset.act === "add-recur"));
  await until(() => $("#rcName"), "recurring sheet");
  setVal($("#rcName"), "Netflix");
  setVal($("#rcAmt"), "4.990");
  click($("#rcSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:recurring") || "[]").length === 1, "recurring saved");
  ok("recurring payment saved", JSON.parse(win.localStorage.getItem("rial:recurring"))[0].name === "Netflix");

  // --- Split salary ritual -> envelopes + envelope-aware Safe-to-Spend ---
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "plan"));
  await until(() => $$("[data-plansub]").length === 4, "plan tabs");
  click([...$$("[data-plansub]")].find((b) => b.dataset.plansub === "envelopes"));
  await until(() => [...$$("#view [data-act]")].some((b) => b.dataset.act === "split-salary"), "split button");
  click([...$$("#view [data-act]")].find((b) => b.dataset.act === "split-salary"));
  await until(() => $("#spSalary"), "split screen");
  setVal($("#spSalary"), "900");
  const envRanges = $$("#full [data-env-idx]");
  ok("split screen lists envelope sliders", envRanges.length >= 1);
  setVal(envRanges[0], "200");
  if (envRanges[1]) setVal(envRanges[1], "150");
  click($("#spSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:plans") || "[]").length === 1, "plan saved");
  ok("Monthly Plan persisted", JSON.parse(win.localStorage.getItem("rial:plans"))[0].salaryAmount === 900000);
  ok("envelopes created for the month", JSON.parse(win.localStorage.getItem("rial:envelopes") || "[]").length >= 1);
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "home"));
  await until(() => /Safe to spend/i.test($("#view").textContent), "home");
  ok("Safe-to-Spend is now envelope-aware", /envelope-aware/i.test($("#view").textContent));

  // --- Wishlist item (30-day lock) ---
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "plan"));
  await until(() => $$("[data-plansub]").length === 4, "plan tabs");
  click([...$$("[data-plansub]")].find((b) => b.dataset.plansub === "wishlist"));
  await until(() => [...$$("#view [data-act]")].some((b) => b.dataset.act === "add-wish"), "add wish btn");
  click([...$$("#view [data-act]")].find((b) => b.dataset.act === "add-wish"));
  await until(() => $("#wName"), "wish sheet");
  setVal($("#wName"), "Camera lens");
  setVal($("#wPrice"), "120");
  click($("#wSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:wishlist") || "[]").length === 1, "wish saved");
  {
    const w = JSON.parse(win.localStorage.getItem("rial:wishlist"))[0];
    ok("wishlist item locked ~30 days", Math.abs(w.unlockTs - w.addedTs - 30 * 86400000) < 2000);
  }
  await until(() => /days until it unlocks/i.test($("#view").textContent), "wishlist countdown rendered");
  ok("wishlist card shows countdown", /days until it unlocks/i.test($("#view").textContent));

  // --- Goal + move to savings (records a transfer) ---
  click([...$$("[data-plansub]")].find((b) => b.dataset.plansub === "goals"));
  await until(() => [...$$("#view [data-act]")].some((b) => b.dataset.act === "add-goal"), "add goal btn");
  click([...$$("#view [data-act]")].find((b) => b.dataset.act === "add-goal"));
  await until(() => $("#gName"), "goal sheet");
  setVal($("#gName"), "Emergency fund");
  setVal($("#gTarget"), "500");
  click($("#gSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:goals") || "[]").length === 1, "goal saved");
  await until(() => [...$$("#view [data-act]")].some((b) => b.dataset.act === "move-savings"), "move-savings btn rendered");
  const txBefore = JSON.parse(win.localStorage.getItem("rial:transactions")).length;
  click([...$$("#view [data-act]")].find((b) => b.dataset.act === "move-savings"));
  await until(() => $("#msAmt"), "move-savings sheet");
  setVal($("#msAmt"), "25");
  click($("#msSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:transactions")).length === txBefore + 1, "transfer recorded");
  {
    const txs = JSON.parse(win.localStorage.getItem("rial:transactions"));
    ok("move-to-savings creates a transfer tx", txs.some((t) => t.type === "transfer" && t.amount === 25000));
    const g = JSON.parse(win.localStorage.getItem("rial:goals"))[0];
    ok("goal.saved increased by the transfer", g.saved === 25000);
  }

  // --- SMS paste parser ---
  win.eval('openOverlay("sms")');
  await until(() => $("#smsText"), "sms overlay");
  setVal($("#smsText"), "Purchase of OMR 3.750 at CARREFOUR on 20-08-2026");
  click($("#smsParse"));
  await until(() => $("#smsSave"), "sms review");
  ok("SMS parser pre-fills amount", $('[data-rv="0"][data-f="amt"]').value === "3.75");
  const txN = JSON.parse(win.localStorage.getItem("rial:transactions")).length;
  click($("#smsSave"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:transactions")).length === txN + 1, "sms tx saved");
  ok("SMS review saves a transaction (source=sms)",
     JSON.parse(win.localStorage.getItem("rial:transactions")).some((t) => t.source === "sms" && t.amount === 3750));

  // --- CSV import with dedupe ---
  win.eval('openOverlay("csv")');
  await until(() => $("#csvPaste"), "csv overlay");
  setVal($("#csvPaste"), "Date,Description,Amount\n2026-08-15,BOOKSTORE,-9.900\n2026-08-16,PHARMACY,-2.100\n");
  click($("#csvLoad"));
  await until(() => $("#csvPreview"), "csv map step");
  click($("#csvPreview"));
  await until(() => $("#csvCommit"), "csv review step");
  const csvN = JSON.parse(win.localStorage.getItem("rial:transactions")).length;
  click($("#csvCommit"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:transactions")).length === csvN + 2, "csv rows imported");
  ok("CSV import adds 2 transactions (source=csv)",
     JSON.parse(win.localStorage.getItem("rial:transactions")).filter((t) => t.source === "csv").length === 2);
  // re-import same file -> all flagged duplicate, none added by default
  win.eval('openOverlay("csv")');
  await until(() => $("#csvPaste"), "csv overlay 2");
  setVal($("#csvPaste"), "Date,Description,Amount\n2026-08-15,BOOKSTORE,-9.900\n2026-08-16,PHARMACY,-2.100\n");
  click($("#csvLoad"));
  await until(() => $("#csvPreview"), "csv map 2");
  click($("#csvPreview"));
  await until(() => $("#csvReview").textContent.length > 0, "csv review 2");
  ok("re-import marks both rows as duplicates", /2 look like duplicates/.test($("#csvReview").textContent));
  win.eval("closeFull()");

  // --- .ics export produces a calendar ---
  const ics = win.eval("buildICS()");
  ok(".ics export includes the recurring + wishlist + salary events",
     /BEGIN:VCALENDAR/.test(ics) && /Pay: Netflix/.test(ics) && /Wishlist unlocked: Camera lens/.test(ics) && /Split your salary/.test(ics));

  // Theme switch via settings
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "home"));
  await until(() => $("#bell"), "bell present");
  // open settings through notif center is indirect; call openOverlay via a Settings button in Plan? use bell -> then close. Instead drive theme through data-open on plan stub is gone.
  win.eval('openOverlay("settings")');
  await until(() => $("#full.open [data-theme-set]"), "settings open");
  click([...$$("[data-theme-set]")].find((b) => b.dataset.themeSet === "paper"));
  await until(() => doc.documentElement.getAttribute("data-theme") === "paper", "theme applied");
  ok("theme switches to Paper", doc.documentElement.getAttribute("data-theme") === "paper");
  ok("theme persisted", win.localStorage.getItem("rial:meta:theme") === '"paper"');

  // --- Theme auto-scheduler ---
  win.matchMedia = win.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, addListener() {}, removeEventListener() {} }));
  const themeAt = (expr) => win.eval(`(function(){ ${expr}; return document.documentElement.getAttribute('data-theme'); })()`);
  // configure a windows schedule: 18:00-06:00 Midnight, 06:00-12:00 Paper, otherwise Desert
  win.eval(`saveSchedule({ mode:"windows", base:"desert",
    windows:[{start:"18:00",end:"06:00",theme:"midnight"},{start:"06:00",end:"12:00",theme:"paper"}] })`);
  win.eval("closeFull()"); await sleep(360);   // leave settings so switches aren't deferred
  win.eval("S.settings.themeManual = null; applyTheme('desert')");

  win.eval("evaluateSchedule(new Date(2026,7,27,20,0,0))"); await sleep(320);
  ok("scheduler: 20:00 -> midnight (night window)", doc.documentElement.getAttribute("data-theme") === "midnight");

  win.eval("evaluateSchedule(new Date(2026,7,27,8,0,0))"); await sleep(320);
  ok("scheduler: 08:00 -> paper (morning window)", doc.documentElement.getAttribute("data-theme") === "paper");

  win.eval("evaluateSchedule(new Date(2026,7,27,14,0,0))"); await sleep(320);
  ok("scheduler: 14:00 -> desert (gap uses base)", doc.documentElement.getAttribute("data-theme") === "desert");

  // wrap-past-midnight: 02:00 falls in the 18:00-06:00 window
  win.eval("applyTheme('paper'); evaluateSchedule(new Date(2026,7,28,2,0,0))"); await sleep(320);
  ok("scheduler: 02:00 -> midnight (window wraps past midnight)", doc.documentElement.getAttribute("data-theme") === "midnight");

  // deferral: a scheduled switch must NOT fire while a modal is open, then applies on close
  win.eval("applyTheme('desert'); openFull('<div>busy</div>')");
  win.eval("evaluateSchedule(new Date(2026,7,27,20,0,0))"); await sleep(320);
  ok("scheduler: switch deferred while modal open", doc.documentElement.getAttribute("data-theme") === "desert");
  ok("scheduler: pending switch is queued", win.eval("pendingScheduledTheme") === "midnight");
  win.eval("closeFull()"); await sleep(650);
  ok("scheduler: queued switch applies after modal closes", doc.documentElement.getAttribute("data-theme") === "midnight");

  // manual override wins until resume
  win.eval('applyTheme("desert")');
  win.eval('pickThemeManually("paper")'); await sleep(320);
  ok("manual pick applies immediately", doc.documentElement.getAttribute("data-theme") === "paper");
  ok("manual override recorded with a boundary time",
     typeof JSON.parse(win.localStorage.getItem("rial:meta:themeManual") || "null")?.until === "number");
  // pin the override boundary relative to the simulated clock so the test is deterministic
  win.eval("S.settings.themeManual.until = new Date(2026,7,27,23,0,0).getTime()");
  win.eval("evaluateSchedule(new Date(2026,7,27,20,0,0))"); await sleep(320);   // 20:00 < 23:00 boundary
  ok("scheduler: manual override blocks the scheduled switch", doc.documentElement.getAttribute("data-theme") === "paper");
  win.eval("evaluateSchedule(new Date(2026,7,28,0,0,0))"); await sleep(320);    // now past the 23:00 boundary
  ok("scheduler: override expires at its boundary, schedule resumes", doc.documentElement.getAttribute("data-theme") === "midnight");
  ok("scheduler: expired override cleared from storage", win.localStorage.getItem("rial:meta:themeManual") === "null");

  win.eval('pickThemeManually("paper")'); await sleep(200);
  win.eval("resumeSchedule()"); await sleep(320);
  ok("resume schedule: manual override cleared", win.localStorage.getItem("rial:meta:themeManual") === "null");

  // settings shows the manual-override banner
  win.eval('applyTheme("midnight")');
  win.eval('saveSchedule({mode:"windows"})'); await sleep(60);
  win.eval('pickThemeManually("desert")'); await sleep(220);
  win.eval('openOverlay("settings")');
  await until(() => $("#full.open"), "settings reopened");
  ok("settings shows 'Resume schedule' when overridden", !!$("#schedResume"));
  ok("settings banner names the manual theme", /Manual:\s*Desert/i.test($(".sched-note")?.textContent || ""));
  win.eval("resumeSchedule()"); await sleep(200);
  win.eval("saveSchedule({mode:'off'}); closeFull()"); await sleep(360);

  // Export backup builds valid JSON (stub blob)
  let exported = null;
  win.Blob = class { constructor(parts){ exported = parts[0]; } };
  win.eval("doExport()");
  await until(() => exported, "export produced content");
  const dump = JSON.parse(exported);
  ok("export JSON is a Rial backup", dump.app === "rial" && dump.data.transactions.length >= 4 && dump.meta.monthlyIncome === 900000);
  ok("export includes theme schedule state", "themeSchedule" in dump.meta && "themeManual" in dump.meta);

  ok("no jsdom errors accumulated", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();
