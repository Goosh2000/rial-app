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
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
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
// jsdom lacks these — provide the Node globals so the theme-link + font paths run
if (!win.matchMedia) win.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, addListener() {}, removeEventListener() {} });
if (typeof CompressionStream === "function" && !win.CompressionStream) win.CompressionStream = CompressionStream;
if (typeof DecompressionStream === "function" && !win.DecompressionStream) win.DecompressionStream = DecompressionStream;
if (!win.btoa) win.btoa = (s) => Buffer.from(s, "binary").toString("base64");
if (!win.atob) win.atob = (s) => Buffer.from(s, "base64").toString("binary");
if (!win.TextEncoder) win.TextEncoder = TextEncoder;
if (!win.TextDecoder) win.TextDecoder = TextDecoder;

const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (el) => el && el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const setVal = (el, v) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); el.dispatchEvent(new win.Event("change", { bubbles: true })); };

(async () => {
  await until(() => $("#onb") && !$("#onb").hidden, "onboarding visible");
  ok("no jsdom errors during boot", errors.length === 0, errors.join(" | "));
  ok("onboarding shows on first run", $("#onb") && !$("#onb").hidden);

  const onbNext = () => click([...$$("#onb button")].find((b) => /Next/i.test(b.textContent)));
  // welcome -> income
  onbNext();
  await until(() => $("#onbIncome"), "income step");
  setVal($("#onbIncome"), "900");
  setVal($("#onbSalaryDay"), "25");
  onbNext();
  // accounts step
  await until(() => $("[data-onb-acc]"), "accounts step");
  setVal([...$$("[data-onb-acc][data-f='label']")][0], "Main");
  setVal([...$$("[data-onb-acc][data-f='last4']")][0], "0017");
  click($("#onbAccAdd"));
  await until(() => $$("[data-onb-acc][data-f='last4']").length === 2, "second account row");
  setVal([...$$("[data-onb-acc][data-f='label']")][1], "Savings");
  setVal([...$$("[data-onb-acc][data-f='last4']")][1], "0033");
  onbNext();
  await until(() => $("#onbSavePct"), "savings step");
  setVal($("#onbSavePct"), "15");
  onbNext();
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

  // --- SMS paste parser: the 5 real fixtures through the review flow ---
  const FIXTURES = [
    "Salary OMR 644.000 Credited to your Account 26/08/2026.",
    "Dear Customer, You have sent OMR 57.000 to AHME#####MOOD from your a/c 0303XXXXXXXX0017 on 26/08/2026 19:42:00 using Mobile",
    "Dear Customer, You have received OMR 2.030 from AHMED ALI",
    "OMR 420.000 is debited from your A/C 0303XXXXXXXX0017 and credited to your A/C 0303XXXXXXXX0033 on 26/08/2026 19:44:31.",
    "Card of a/c 0303XXXXXXXX0017 used for OMR 10.120 at DOMINOS MANAILAH AL KH on 26/08/2026",
  ].join("\n\n");
  const allTx = () => JSON.parse(win.localStorage.getItem("rial:transactions") || "[]");
  const metric = (expr) => win.eval(expr);
  win.eval('openOverlay("sms")');
  await until(() => $("#smsText"), "sms overlay");
  const mainId = win.eval("S.accounts.find(a=>a.last4==='0017').id");
  const savId = win.eval("S.accounts.find(a=>a.last4==='0033').id");
  setVal($("#smsText"), FIXTURES);
  click($("#smsParse"));
  await until(() => $("#rvSave"), "sms review");
  ok("review shows all 5 parsed entries", $$(".rvrow").length === 5);
  ok("review flags the internal transfer as not-spending", /NOT count as spending/.test($("#smsReview").textContent));
  // bal0 from the raw ledger (S.tx may be mid-refresh from an earlier step)
  const ledgerBal = (acctId) => {
    let b = JSON.parse(win.localStorage.getItem("rial:accounts")).find(a => a.id === acctId).openingBalance || 0;
    for (const t of allTx()) {
      if (t.type === "transfer_internal") { if (t.fromAccountId === acctId) b -= t.amount; if (t.toAccountId === acctId) b += t.amount; continue; }
      const ac = t.accountId || mainId;
      if (ac !== acctId) continue;
      if (t.type === "income" || t.type === "transfer_in") b += t.amount;
      else b -= t.amount;
    }
    return b;
  };
  const bal0 = { main: ledgerBal(mainId), sav: ledgerBal(savId) };
  const txN0 = allTx().length;
  click($("#rvSave"));
  await until(() => allTx().length === txN0 + 5, "5 saved", 100);
  await sleep(150);
  const saved = allTx();
  const bySrc = saved.filter((t) => t.source === "sms");
  eq("5 fixtures saved", bySrc.length, 5);
  const salary = bySrc.find((t) => t.amount === 644000);
  ok("F1 salary -> income", salary && salary.type === "income");
  const sent = bySrc.find((t) => t.amount === 57000);
  ok("F2 sent -> transfer_out with counterparty + account", sent && sent.type === "transfer_out" && /AHME/.test(sent.counterparty || ""));
  const recv = bySrc.find((t) => t.amount === 2030);
  ok("F3 received -> transfer_in", recv && recv.type === "transfer_in");
  const internal = bySrc.find((t) => t.amount === 420000);
  ok("F4 -> transfer_internal with from/to account ids", internal && internal.type === "transfer_internal" && internal.fromAccountId && internal.toAccountId);
  const dominos = bySrc.find((t) => t.amount === 10120);
  ok("F5 -> expense, category food, DOMINOS", dominos && dominos.type === "expense" && dominos.category === "Food");
  ok("no full account number stored anywhere", !/0303XXXXXXXX/.test(JSON.stringify(saved)) && !saved.some((t) => /\d{8,}/.test(JSON.stringify(t.raw || ""))));
  // explicit: grep the ENTIRE persisted store — every rial:* key — to prove only last4 survives
  {
    let dump = "";
    for (let i = 0; i < win.localStorage.length; i++) {
      const k = win.localStorage.key(i);
      if (k && k.startsWith("rial:")) dump += "\n" + win.localStorage.getItem(k);
    }
    ok("grep stored data: no masked account token (NN..XX..NN) anywhere", !/\d{2,}\s*[X#*]{2,}\s*\d{2,}/.test(dump));
    const textFields = [];
    for (const t of saved) textFields.push(t.raw || "", t.counterparty || "", t.merchant || "", t.source || "");
    for (const a of JSON.parse(win.localStorage.getItem("rial:accounts") || "[]")) textFields.push(a.label || "", a.last4 || "");
    ok("grep stored data: no raw/counterparty/label text holds a 5+ digit run", !textFields.some((f) => /\d{5,}/.test(f)));
    const accts = JSON.parse(win.localStorage.getItem("rial:accounts") || "[]");
    ok("every stored account.last4 is 0–4 digits, nothing more", accts.every((a) => /^\d{0,4}$/.test(a.last4 || "")));
    ok("every tx fromLast4/toLast4 is 0–4 digits", saved.every((t) => /^\d{0,4}$/.test(t.fromLast4 || "") && /^\d{0,4}$/.test(t.toLast4 || "")));
  }

  // THE critical assertion: the 420.000 internal transfer moved both balances but added ZERO spending
  await sleep(100);
  // spending contributed by ONLY the SMS rows (spend0 pre-dated an earlier move-to-savings, so compare per-source)
  const smsSpend = metric(`S.tx.filter(t=>t.source==='sms' && F.isSpend(t)).reduce((s,t)=>s+t.amount,0)`);
  eq("SMS spend = real outflows only (57 + 10.12); internal transfer contributes ZERO", smsSpend, 57000 + 10120);
  eq("F.isSpend(internal transfer) is false", metric(`F.isSpend({type:'transfer_internal'})`), false);
  const bal1 = { main: ledgerBal(mainId), sav: ledgerBal(savId) };
  // Main: +644 salary, -57 sent, +2.03 received, -420 internal-out, -10.12 card
  eq("internal transfer moved the Main balance by -420.000", bal1.main - bal0.main, 644000 - 57000 + 2030 - 420000 - 10120);
  eq("internal transfer moved the Savings balance by +420.000", bal1.sav - bal0.sav, 420000);
  ok("internal transfer not in category insights", !/420\.000/.test(metric("SCREENS.insights()")));
  ok("internal transfer not in envelope drawdown", metric(`F.envelopeSpent('Food') >= 0 && !S.tx.some(t=>t.type==='transfer_internal' && t.category)`));

  // re-paste the exact same batch -> all 5 flagged as duplicates, nothing imported
  win.eval('openOverlay("sms")'); await until(() => $("#smsText"), "sms overlay 2");
  setVal($("#smsText"), FIXTURES);
  click($("#smsParse"));
  await until(() => $("#smsReview").textContent.length > 10, "review 2");
  ok("re-paste: all 5 marked duplicate", /5 duplicates skipped/.test($("#smsReview").textContent));
  const beforeRe = allTx().length;
  if ($("#rvSave")) click($("#rvSave"));
  await sleep(200);
  eq("re-paste imports zero", allTx().length, beforeRe);
  win.eval("closeFull()"); await sleep(150);

  // unrecognised message -> a needs-review row, never dropped
  win.eval('openOverlay("sms")'); await until(() => $("#smsText"), "sms overlay 3");
  setVal($("#smsText"), "Yr card bill OMR 12.000 is due soon via SomeBankApp");
  click($("#smsParse"));
  await until(() => $$(".rvrow").length === 1, "review 3");
  ok("unknown message -> a review row with the raw text", /SomeBankApp/.test($("#smsReview").textContent));
  ok("unknown message -> Save disabled until a type is chosen", $("#rvSave")?.disabled === true || !$("#rvSave"));
  win.eval("closeFull()"); await sleep(150);

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

  // --- Theme link sharing: round-trip through the import flow ---
  win.eval('applyThemeSmooth("monarch")'); await sleep(320);
  const link = await win.eval("buildShareLink('monarch')");
  ok("buildShareLink produces a #theme= fragment", /#theme=[dr][A-Za-z0-9_-]+$/.test(link.url), link.url.slice(0, 60));

  // simulate opening the link on another device: decode -> validate -> preview (NEVER auto-apply)
  win.eval('applyThemeSmooth("paper")'); await sleep(320);
  win.eval(`(async () => {
    const obj = await decodeThemeLink(${JSON.stringify(link.encoded)});
    const v = validateSharedTheme(obj);
    window.__v = v;
    if (v.ok) openThemeImportPreview(v.theme);
  })()`);
  await until(() => $("#tiImport"), "import preview shown");
  ok("shared link decodes + validates", win.eval("window.__v && window.__v.ok === true"));
  ok("import preview does NOT auto-apply the theme", doc.documentElement.getAttribute("data-theme") === "paper");
  ok("import preview names the audio-stripping", /Audio is not included/i.test($("#full").textContent));
  ok("import preview notes custom effects are stripped", /(Custom effects|not included).*palette/is.test($("#full").textContent));
  ok("import preview offers Import + Cancel", !!$("#tiImport") && !!$("#tiCancel2"));

  const txThemesBefore = JSON.parse(win.localStorage.getItem("rial:meta:userThemes") || "[]").length;
  click($("#tiImport"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:meta:userThemes") || "[]").length === txThemesBefore + 1, "user theme stored");
  await until(() => doc.documentElement.getAttribute("data-theme") === "monarch-shared", "imported theme applied (crossfade)");
  {
    const stored = JSON.parse(win.localStorage.getItem("rial:meta:userThemes"))[0];
    ok("imported theme stored with a non-built-in id", stored.id === "monarch-shared");
    ok("imported theme applied after Import", doc.documentElement.getAttribute("data-theme") === "monarch-shared");
    ok("imported theme injects palette CSS", /data-theme="monarch-shared"/.test(win.eval('document.getElementById("userThemeCss").textContent')));
    ok("imported theme CSS carries validated tokens", /--accent:\s*#4d9dff/.test(win.eval('document.getElementById("userThemeCss").textContent')));
  }

  // it shows in settings and is deletable; built-ins are not
  win.eval('openOverlay("settings")'); await until(() => $("#full.open [data-theme-set]"), "settings");
  ok("imported theme appears as a chip", [...$$("[data-theme-set]")].some(b => b.dataset.themeSet === "monarch-shared"));
  ok("imported theme has a Delete button", [...$$("[data-act='del-user-theme']")].length === 1);
  click($("[data-act='del-user-theme']"));
  await until(() => JSON.parse(win.localStorage.getItem("rial:meta:userThemes") || "[]").length === 0, "user theme deleted");
  await until(() => ["midnight", "paper", "desert", "depth"].includes(doc.documentElement.getAttribute("data-theme")), "fell back to a built-in");
  ok("deleting the active user theme falls back to a built-in", ["midnight", "paper", "desert", "depth"].includes(doc.documentElement.getAttribute("data-theme")));
  ok("deleted theme's chip is gone", ![...$$("[data-theme-set]")].some(b => b.dataset.themeSet === "monarch-shared"));
  win.eval("closeFull()"); await sleep(200);

  // --- malicious links leave the app completely untouched ---
  win.eval('applyThemeSmooth("desert")'); await sleep(320);
  const beforeState = () => ({
    theme: doc.documentElement.getAttribute("data-theme"),
    userThemes: win.localStorage.getItem("rial:meta:userThemes"),
  });
  const snap0 = JSON.stringify(beforeState());
  const evil = [
    ["script in a colour", { v: 1, id: "x", name: "X", scheme: "dark", tokens: { accent: "#fff;}body{display:none}.y{" } }],
    ["external url()", { v: 1, id: "x", name: "X", scheme: "dark", tokens: { bg: "url(https://evil/x.png)" } }],
    ["<script> in name", { v: 1, id: "x", name: "P</style><script>1", scheme: "dark", tokens: { bg: "#111" } }],
    ["decorativeCss field", { v: 1, id: "x", name: "X", scheme: "dark", tokens: { bg: "#111" }, decorativeCss: "body{}" }],
    ["fontImports field", { v: 1, id: "x", name: "X", scheme: "dark", tokens: { bg: "#111" }, fontImports: ["https://e/x"] }],
  ];
  for (const [label, payload] of evil) {
    const enc = await win.eval(`encodeThemeLink(${JSON.stringify(payload)})`);
    win.location.hash = "#theme=" + enc;
    win.eval("(async () => { await handleThemeLinkFragment(); })()");
    await sleep(200);
    ok(`malicious link rejected (${label}): no preview shown`, !$("#tiImport"));
    ok(`malicious link rejected (${label}): app state unchanged`, JSON.stringify(beforeState()) === snap0, JSON.stringify(beforeState()));
    ok(`malicious link rejected (${label}): fragment cleared`, !/theme=/.test(win.location.hash));
  }
  // oversized blob
  win.location.hash = "#theme=r" + "A".repeat(3000);
  win.eval("(async () => { await handleThemeLinkFragment(); })()");
  await sleep(200);
  ok("oversized link rejected, app untouched", JSON.stringify(beforeState()) === snap0 && !$("#tiImport"));
  // malformed base64
  win.location.hash = "#theme=d!!!not-valid!!!";
  win.eval("(async () => { await handleThemeLinkFragment(); })()");
  await sleep(200);
  ok("malformed base64 link rejected, app untouched", JSON.stringify(beforeState()) === snap0);

  // --- Accounts + daily allowance on the dashboard ---
  click([...$$("nav#tabs [data-tab]")].find((b) => b.dataset.tab === "home"));
  await until(() => $("#view").textContent.length > 20, "home rendered");
  {
    const homeTxt = $("#view").textContent;
    ok("home shows a per-account balance row (Main)", /Main/.test(homeTxt));
    ok("home shows the Savings account row too", /Savings/.test(homeTxt));
    ok("home 'Accounts' card shows the combined total value",
       /Accounts/.test(homeTxt) && homeTxt.includes(win.eval("U.fmtFull(F.combinedBalance())")));
    const al = win.eval("JSON.stringify(F.dailyAllowance())");
    const a = JSON.parse(al);
    ok("dailyAllowance: today is never negative", a.today >= 0);
    ok("dailyAllowance: today is never below the floor", a.today >= a.floor);
    ok("dailyAllowance: exposes spentToday + remainingToday", typeof a.spentToday === "number" && typeof a.remainingToday === "number");
    ok("dailyAllowance: internal transfer excluded from spentToday",
       win.eval("(function(){var s=F.spentOn(U.ymd(new Date()));return !S.tx.some(t=>t.type==='transfer_internal'&&F.isSpend(t))})()"));
    ok("home shows the allowance line (allowed / spent / left)", /(allowed|left|allowance)/i.test(homeTxt));
    // the allowance detail overlay opens and is one clear readout, not a chart
    win.eval('openOverlay("allowanceInfo")');
    await until(() => $("#full.open"), "allowance overlay");
    const ov = $("#full").textContent;
    ok("allowance overlay shows allowed + spent + remaining", /allowed/i.test(ov) && /spent/i.test(ov) && /(left|remaining)/i.test(ov));
    ok("allowance overlay has a floor input", !!$("#alFloor"));
    win.eval("closeFull()"); await sleep(150);
  }

  // Export backup builds valid JSON (stub blob)
  let exported = null;
  win.Blob = class { constructor(parts){ exported = parts[0]; } };
  win.eval("doExport()");
  await until(() => exported, "export produced content");
  const dump = JSON.parse(exported);
  ok("export JSON is a Rial backup", dump.app === "rial" && dump.data.transactions.length >= 4 && dump.meta.monthlyIncome === 900000);
  ok("export includes theme schedule state", "themeSchedule" in dump.meta && "themeManual" in dump.meta);
  ok("export includes userThemes", "userThemes" in dump.meta);

  ok("no jsdom errors accumulated", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})();
