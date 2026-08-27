/* test.mjs — headless logic tests for Rial.
   Loads the <script> out of index.html, evaluates it in a vm sandbox with
   minimal DOM/storage stubs, then asserts on the pure finance/date/money logic.
   Run:  node test.mjs
   NOTE: this covers logic, not rendering. Visual/PWA checks are manual (see README). */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (name, a, b, tol = 1) => ok(name, Math.abs(a - b) <= tol, `got ${a} want ~${b}`);

/* ---- 1. extract + syntax-check the script ---- */
const html = fs.readFileSync(path.join(__dir, "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!m) { console.error("could not find app <script> in index.html"); process.exit(1); }
let src = m[1];
const extracted = path.join(__dir, ".app.extracted.js");
fs.writeFileSync(extracted, src);
try {
  execSync(`node --check "${extracted}"`, { stdio: "pipe" });
  ok("index.html script parses (node --check)", true);
} catch (e) {
  ok("index.html script parses (node --check)", false, String(e.stderr || e));
  process.exit(1);
}

/* ---- 2. sandbox stubs ---- */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const mkEl = () => ({
  style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {},
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
  appendChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  click() {}, focus() {}, setSelectionRange() {},
  set innerHTML(v) {}, get innerHTML() { return ""; },
  textContent: "", value: "", offsetWidth: 0, hidden: false,
});
const document = {
  getElementById: () => mkEl(), querySelector: () => mkEl(), querySelectorAll: () => [],
  createElement: () => mkEl(), addEventListener() {},
  body: mkEl(), documentElement: { setAttribute() {}, style: { setProperty() {} } },
};
const navigator = { language: "en-OM" };
const ctx = {
  console, document, navigator, localStorage,
  window: {}, globalThis: null,
  addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => "#0b0d10" }),
  requestAnimationFrame: () => 0, setTimeout, clearTimeout, setInterval, clearInterval,
  performance, Intl, Blob, URL, TextEncoder, TextDecoder, fetch: undefined,
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);

// strip the auto-boot call (now `boot().catch(...)`); expose internals for assertions
src = src.replace(/\nboot\(\)[\s\S]*$/, "\n");
src += `\n;globalThis.__T = { U, F, S, DB, newDraft, displayAmount, SCREENS, keypadHTML, settingsHTML, sparkSVG,
  parseCSV, guessDate, csvParseRow, autoMap, isDuplicate, parseSMSBlock, splitBlocks, buildICS, icsSignature,
  advanceDue, rollRecurring, DEFAULT_SMS_PATTERNS, liveNotifs, notifCount, planEnvelopes, planPayments, planWishlist, planGoals };`;
new vm.Script(src, { filename: "app.js" }).runInContext(ctx);
const T = ctx.__T;
const { U, F, S, DB, newDraft, displayAmount, SCREENS, keypadHTML, settingsHTML } = T;

await DB.open();
ok("DB falls back to localStorage when no IndexedDB", DB.fallback === true);

/* ---- 3. money math (integer baisa) ---- */
eq("toBaisa '12.450'", U.toBaisa("12.450"), 12450);
eq("toBaisa '0.5'", U.toBaisa("0.5"), 500);
eq("toBaisa number 12.45", U.toBaisa(12.45), 12450);
eq("toBaisa 'OMR 3.200'", U.toBaisa("OMR 3.200"), 3200);
eq("toBaisa junk", U.toBaisa("abc"), 0);
eq("fmt 12450", U.fmt(12450), "12.450");
eq("fmt 12405 (mid zero)", U.fmt(12405), "12.405");
eq("fmt negative", U.fmt(-5000), "-5.000");
eq("fmt plus flag", U.fmt(1200, { plus: true }), "+1.200");
eq("fmt 0", U.fmt(0), "0.000");
eq("fmtFull", U.fmtFull(12450), "OMR 12.450");
// no floating point drift over many adds
let acc = 0; for (let i = 0; i < 1000; i++) acc += U.toBaisa("0.001");
eq("1000 x 0.001 OMR == 1.000 exactly", acc, 1000);

/* ---- 4. date / month math (Asia/Muscat) ---- */
ok("ymd format YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(U.ymd()));
ok("monthKey format YYYY-MM", /^\d{4}-\d{2}$/.test(U.monthKey()));
eq("daysInMonth 2026-02", U.daysInMonth("2026-02"), 28);
eq("daysInMonth 2024-02 (leap)", U.daysInMonth("2024-02"), 29);
eq("daysInMonth 2026-08", U.daysInMonth("2026-08"), 31);
eq("daysInMonth 2026-04", U.daysInMonth("2026-04"), 30);
ok("daysLeftInMonth in range", U.daysLeftInMonth() >= 1 && U.daysLeftInMonth() <= 31);
eq("parseYMD round-trips through ymd", U.ymd(new Date(U.parseYMD("2026-03-15"))), "2026-03-15");
// month boundary: a tx dated last day of month vs first day of next
const endAug = U.parseYMD("2026-08-31"), startSep = U.parseYMD("2026-09-01");
eq("Aug 31 -> monthKey 2026-08", U.monthKey(new Date(endAug)), "2026-08");
eq("Sep 1 -> monthKey 2026-09", U.monthKey(new Date(startSep)), "2026-09");
ok("isWeekend Fri 2026-08-28", U.isWeekend(U.parseYMD("2026-08-28")));
ok("isWeekend Sat 2026-08-29", U.isWeekend(U.parseYMD("2026-08-29")));
ok("weekday Sun 2026-08-30 not weekend", !U.isWeekend(U.parseYMD("2026-08-30")));

/* ---- 5. finance engine ---- */
const MK = U.monthKey();
S.cats = [
  { id: "c1", name: "Food", icon: "🍽", isIncome: false, uses: 5 },
  { id: "c2", name: "Transport", icon: "🚗", isIncome: false, uses: 1 },
  { id: "c3", name: "Salary", icon: "💰", isIncome: true, uses: 0 },
];
S.recurring = [
  { id: "r1", name: "Rent", amount: 200000, cadence: "monthly", nextDue: U.todayTs() + 2 * 86400000, category: "Other", active: true },
  { id: "r2", name: "Gym", amount: 20000, cadence: "monthly", nextDue: U.todayTs() + 20 * 86400000, category: "Boxing/Fitness", active: true },
  { id: "r3", name: "Old", amount: 9999, cadence: "monthly", nextDue: U.todayTs(), category: "Other", active: false },
];
S.wishlist = [];
S.goals = [];
S.settings = { monthlyIncome: 900000, savingsTargetPct: 10, salaryDay: 25, streak: 3, soundOn: false, theme: "midnight", lastBackup: null };
S.tx = [
  { id: "t1", ts: U.todayTs(), month: MK, amount: 900000, type: "income", category: "Salary" },
  { id: "t2", ts: U.todayTs(), month: MK, amount: 12300, type: "expense", category: "Food" },
  { id: "t3", ts: U.todayTs(), month: MK, amount: 5000, type: "expense", category: "Transport" },
  { id: "t4", ts: U.parseYMD("2026-07-15"), month: "2026-07", amount: 40000, type: "expense", category: "Food" },
];

eq("incomeThisMonth", F.incomeThisMonth(MK), 900000);
eq("spentThisMonth (excludes last month)", F.spentThisMonth(MK), 17300);
eq("netThisMonth", F.netThisMonth(MK), 900000 - 17300);
eq("fixedCommitments (active monthly only)", F.fixedCommitments(), 220000);
eq("savingsTarget 10% of 900.000", F.savingsTarget(), 90000);
{
  const sts = F.safeToSpendToday();
  const expectRemain = 900000 - 220000 - 90000 - 17300; // 572700
  eq("safeToSpend remainingBudget", sts.remainingBudget, expectRemain);
  eq("safeToSpend perDay = remaining / daysLeft", sts.perDay, Math.round(expectRemain / U.daysLeftInMonth()));
}
// weekly / yearly / custom cadence normalisation
S.recurring.push({ id: "r4", name: "PhoneWk", amount: 3000, cadence: "weekly", nextDue: U.todayTs(), category: "Other", active: true });
S.recurring.push({ id: "r5", name: "Domain", amount: 12000, cadence: "yearly", nextDue: U.todayTs(), category: "Other", active: true });
near("weekly cadence -> monthly (3.000*52/12)", F.fixedCommitments(), 220000 + Math.round(3000 * 52 / 12) + Math.round(12000 / 12), 0);
S.recurring = S.recurring.slice(0, 3);

// upcoming(7): rent (in 2d) yes, gym (in 20d) no, inactive no
{
  const up = F.upcoming(7);
  eq("upcoming(7) count", up.length, 1);
  eq("upcoming(7) is Rent", up[0].name, "Rent");
}

// round-up simulation: 12.300 -> next 0.5 is 12.500 (200); 5.000 -> already on 0.5 (0)
eq("roundupSaved this month", F.roundupSaved(MK), 200);

// last30 shape
{
  const l = F.last30();
  eq("last30 length", l.length, 30);
  ok("last30 last entry is today", l[29].key === U.ymd());
  ok("last30 sums today's spend", l[29].spent === 17300);
}

/* ---- 6. draft / keypad amount building ---- */
{
  const d = newDraft();
  eq("newDraft default type", d.type, "expense");
  eq("newDraft picks most-used expense category", d.category, "Food");
  eq("displayAmount clamps to 3 decimals", displayAmount("12.45999"), "12.459");
  eq("displayAmount integer passthrough", displayAmount("120"), "120");
}

/* ---- 7. export / import round-trip ---- */
{
  await DB.put("transactions", { id: "z1", ts: U.todayTs(), month: MK, amount: 1000, type: "expense", category: "Food" });
  await DB.setMeta("monthlyIncome", 777000);
  const dump = await DB.exportAll();
  ok("export has app tag", dump.app === "rial");
  ok("export carries transactions", dump.data.transactions.some((t) => t.id === "z1"));
  ok("export carries meta.monthlyIncome", dump.meta.monthlyIncome === 777000);
  await DB.clear("transactions");
  eq("cleared", (await DB.getAll("transactions")).length, 0);
  await DB.importAll(dump);
  ok("import restored transaction", (await DB.getAll("transactions")).some((t) => t.id === "z1"));
  ok("import restored meta", (await DB.meta("monthlyIncome")) === 777000);
  let threw = false;
  try { await DB.importAll({ app: "notrial" }); } catch { threw = true; }
  ok("import rejects non-Rial file", threw);
}

/* ---- 7b. envelope / Monthly Plan math ---- */
{
  const mk = U.monthKey();
  S.plans = [{ id: "p1", month: mk, salaryAmount: 900000, fundedGoals: [{ goalId: "g1", amount: 100000 }] }];
  S.envelopes = [
    { id: "e1", month: mk, category: "Food", allocated: 200000, sort: 0 },
    { id: "e2", month: mk, category: "Transport", allocated: 60000, sort: 1 },
  ];
  S.goals = [{ id: "g1", name: "Camera", target: 300000, saved: 100000, color: "#fff" }];
  S.tx = [
    { id: "t1", ts: U.todayTs(), month: mk, amount: 900000, type: "income", category: "Salary" },
    { id: "t2", ts: U.todayTs(), month: mk, amount: 50000, type: "expense", category: "Food" },
    { id: "t3", ts: U.todayTs(), month: mk, amount: 100000, type: "transfer", category: "Savings: Camera" },
  ];
  eq("allocatedTotal", F.allocatedTotal(mk), 260000);
  eq("envelopeSpent Food", F.envelopeSpent("Food", mk), 50000);
  eq("monthTransfers", F.monthTransfers(mk), 100000);
  // unallocated = 900000 - 260000 alloc - 100000 transfer = 540000
  eq("unallocated", F.unallocated(mk), 540000);
  {
    const p = F.envelopePace("Food", 200000, mk);
    eq("Food envelope left", p.left, 150000);
    ok("Food pace state is a known value", ["green", "amber", "red", "empty"].includes(p.state));
  }
  {
    const empty = F.envelopePace("Transport", 60000, mk); // spent 0
    eq("Transport (unspent) left", empty.left, 60000);
  }
  {
    const sts = F.safeToSpendToday();
    ok("STS is envelope-aware when a plan exists", sts.envelopeAware === true);
    // flexLeft = (200000-50000) + (60000-0) = 210000 ; unalloc 540000 ; total 750000
    eq("STS envelope remainingBudget", sts.remainingBudget, 750000);
  }
  eq("goalPct", Math.round(F.goalPct(S.goals[0])), 33);
}

/* ---- 7c. recurring rollover -> pending ---- */
{
  await DB.clear("transactions");
  const overdue = U.todayTs() - 40 * 86400000;
  S.recurring = [{ id: "rr1", name: "Rent", amount: 200000, cadence: "monthly", nextDue: overdue, category: "Other", type: "expense", active: true }];
  S.pending = [];
  await T.rollRecurring();
  const all = await DB.getAll("transactions");
  const pend = all.filter((t) => t.pending);
  ok("rollover created >=1 pending tx", pend.length >= 1);
  ok("pending tx marked source=recurring", pend.every((t) => t.source === "recurring"));
  ok("recurring nextDue advanced into the future", S.recurring[0].nextDue > U.todayTs());
  // idempotent: second roll adds nothing (nextDue now future)
  const before = (await DB.getAll("transactions")).length;
  await T.rollRecurring();
  eq("rollover is idempotent", (await DB.getAll("transactions")).length, before);
  await DB.clear("transactions");
}
eq("advanceDue monthly", U.ymd(new Date(T.advanceDue(U.parseYMD("2026-01-31"), "monthly"))).slice(0, 7), "2026-03"); // JS rolls Jan31+1mo -> Mar 3
eq("advanceDue weekly", U.ymd(new Date(T.advanceDue(U.parseYMD("2026-08-01"), "weekly"))), "2026-08-08");
eq("advanceDue yearly", U.ymd(new Date(T.advanceDue(U.parseYMD("2026-08-01"), "yearly"))), "2027-08-01");
eq("advanceDue custom 10d", U.ymd(new Date(T.advanceDue(U.parseYMD("2026-08-01"), "custom", 10))), "2026-08-11");

/* ---- 7d. CSV parser ---- */
{
  const csv = `Date,Description,Amount\n2026-08-01,"LULU HYPERMARKET, QURUM",-4.500\n2026-08-02,SALARY CREDIT,900.000\n02/08/2026,"Coffee ""Shop""",-1.200\n`;
  const rows = T.parseCSV(csv);
  eq("parseCSV row count (header + 3)", rows.length, 4);
  eq("parseCSV handles quoted comma", rows[1][1], "LULU HYPERMARKET, QURUM");
  eq("parseCSV handles escaped quote", rows[3][1], 'Coffee "Shop"');
  const map = T.autoMap(rows[0].map((h) => h.trim()));
  eq("autoMap finds date col", map.date, 0);
  eq("autoMap finds amount col", map.amount, 2);
  eq("autoMap finds desc col", map.desc, 1);
  const r1 = T.csvParseRow(rows[1], map);
  eq("csv row: negative -> expense", r1.type, "expense");
  eq("csv row: amount baisa", r1.amount, 4500);
  eq("csv row: date normalised", r1.ymd, "2026-08-01");
  const r2 = T.csvParseRow(rows[2], map);
  eq("csv row: positive + 'salary' -> income", r2.type, "income");
  eq("csv row: income amount", r2.amount, 900000);
  eq("guessDate dd/mm/yyyy", T.guessDate("02/08/2026"), "2026-08-02");
  eq("guessDate 26-Aug-2026", T.guessDate("26-Aug-2026"), "2026-08-26");
  // dedupe
  S.tx = [{ id: "x", ts: U.parseYMD("2026-08-01"), amount: 4500, type: "expense", note: "LULU HYPERMARKET, QURUM" }];
  ok("isDuplicate catches same date+amount+desc", T.isDuplicate(r1) === true);
  ok("isDuplicate rejects different amount", T.isDuplicate({ ...r1, amount: 9999 }) === false);
}

/* ---- 7e. SMS parser ---- */
{
  const pats = T.DEFAULT_SMS_PATTERNS;
  const a = T.parseSMSBlock("Purchase of OMR 4.500 at LULU HYPERMARKET on 26-08-2026. Avl bal OMR 210.000", pats);
  ok("SMS debit parsed", !!a && a.type === "expense");
  eq("SMS debit amount", a.amount, 4500);
  ok("SMS merchant extracted", /LULU/i.test(a.note));
  const b = T.parseSMSBlock("Your account has been credited with OMR 900.000 - salary on 25-08-2026", pats);
  ok("SMS credit parsed as income", !!b && b.type === "income");
  eq("SMS credit amount", b.amount, 900000);
  const c = T.parseSMSBlock("random text no money here", pats);
  ok("SMS: unparseable returns null", c === null);
  const blocks = T.splitBlocks("SMS one OMR 1.000\n\nSMS two OMR 2.000");
  eq("splitBlocks splits on blank line", blocks.length, 2);
}

/* ---- 7f. ICS export ---- */
{
  S.recurring = [{ id: "r1", name: "Rent", amount: 200000, cadence: "monthly", nextDue: U.parseYMD("2026-09-01"), category: "Other", active: true }];
  S.wishlist = [{ id: "w1", name: "Camera", price: 300000, addedTs: U.todayTs(), unlockTs: U.parseYMD("2026-09-20"), bought: false }];
  S.settings.salaryDay = 25;
  const ics = T.buildICS();
  ok("ICS has VCALENDAR wrapper", ics.startsWith("BEGIN:VCALENDAR") && ics.trim().endsWith("END:VCALENDAR"));
  ok("ICS uses CRLF line endings", ics.includes("\r\n"));
  eq("ICS BEGIN/END VEVENT balanced", (ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  eq("ICS BEGIN/END VALARM balanced", (ics.match(/BEGIN:VALARM/g) || []).length, (ics.match(/END:VALARM/g) || []).length);
  ok("ICS has recurring payment event", ics.includes("Pay: Rent"));
  ok("ICS has wishlist unlock event", ics.includes("Wishlist unlocked: Camera"));
  ok("ICS has salary split RRULE", /RRULE:FREQ=MONTHLY;BYMONTHDAY=25/.test(ics));
  ok("ICS alarm 1 day before at 9am (-PT15H)", ics.includes("TRIGGER:-PT15H"));
  const sig1 = T.icsSignature();
  S.recurring[0].nextDue += 86400000;
  ok("icsSignature changes when a due date changes", T.icsSignature() !== sig1);
}

/* ---- 8. screen render smoke tests (no throw, returns HTML) ---- */
for (const name of ["home", "tx", "plan", "insights"]) {
  let html2 = "", threw = false;
  try { html2 = SCREENS[name](); } catch (e) { threw = true; html2 = String(e && e.stack || e); }
  ok(`SCREENS.${name}() renders without throwing`, !threw && typeof html2 === "string" && html2.length > 20, html2.slice(0, 200));
}
for (const fn of ["planEnvelopes", "planPayments", "planWishlist", "planGoals"]) {
  let out = "", threw = false;
  try { out = T[fn](); } catch (e) { threw = true; out = String(e && e.stack || e); }
  ok(`${fn}() renders without throwing`, !threw && out.length > 10, out.slice(0, 200));
}
ok("liveNotifs() returns an array", Array.isArray(T.liveNotifs()));
ok("notifCount() is a number", typeof T.notifCount() === "number");
{
  const d = newDraft(); S.__draft = d;
  // keypadHTML reads module-scoped `draft`; set it via the exported newDraft path isn't enough,
  // so just verify settingsHTML + sparkSVG here.
  let threw = false, out = "";
  try { out = settingsHTML(); } catch (e) { threw = true; out = String(e); }
  ok("settingsHTML() renders", !threw && out.includes("Backup"), out.slice(0, 160));
}
{
  const svg = ctx.__T.sparkSVG(F.last30());
  ok("sparkSVG returns <svg> with polyline", svg.includes("<svg") && svg.includes("polyline"));
}

/* ---- done ---- */
fs.rmSync(extracted);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
