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
let _htmlTheme = "midnight";
const document = {
  getElementById: (id) => ((id === "wrapWrap" || id === "questComplete") ? null : id === "onb" ? { ...mkEl(), hidden: true } : mkEl()),
  querySelector: () => mkEl(), querySelectorAll: () => [],
  createElement: () => mkEl(), addEventListener() {},
  body: mkEl(), head: mkEl(),
  documentElement: {
    setAttribute: (k, v) => { if (k === "data-theme") _htmlTheme = v; },
    getAttribute: (k) => (k === "data-theme" ? _htmlTheme : null),
    style: { setProperty() {} },
  },
};
const navigator = { language: "en-OM" };
let _prefersDark = false;                       // tests flip this for "system" mode
const ctx = {
  console, document, navigator, localStorage,
  window: {}, globalThis: null,
  location: { origin: "https://goosh2000.github.io", pathname: "/rial-app/", search: "", hash: "" },
  history: { replaceState() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: (q) => ({ matches: /dark/.test(q) ? _prefersDark : !_prefersDark, media: q, addEventListener() {}, addListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "#0b0d10" }),
  requestAnimationFrame: () => 0, setTimeout, clearTimeout, setInterval, clearInterval,
  performance, Intl, Blob, URL, TextEncoder, TextDecoder, fetch: undefined,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  CompressionStream: typeof CompressionStream === "function" ? CompressionStream : undefined,
  DecompressionStream: typeof DecompressionStream === "function" ? DecompressionStream : undefined,
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);

// strip the auto-boot call (now `boot().catch(...)`); expose internals for assertions
src = src.replace(/\nboot\(\)[\s\S]*$/, "\n");
src += `\n;globalThis.__T = { U, F, S, DB, newDraft, displayAmount, SCREENS, keypadHTML, settingsHTML, sparkSVG,
  parseCSV, guessDate, csvParseRow, autoMap, isDuplicate, buildICS, icsSignature,
  advanceDue, rollRecurring, liveNotifs, notifCount, planEnvelopes, planPayments, planWishlist, planGoals,
  SmsParser, parserCtx, toReviewEntry, markDuplicates, catNameFor,
  primaryAccount, accountById, accountByLast4, accountLast4Set, acctLabel, allowanceInfoHTML, accountsHTML,
  parseHM, fmtHM, windowActive, scheduledThemeAt, nextBoundaryAfter, manualExpired, currentThemeId,
  evaluateSchedule, applyTheme, THEMES, THEME_DEFAULT, THEME_TOKEN_KEYS, themeName, themeBg, validTheme, scheduleHTML,
  QR, validateSharedTheme, encodeThemeLink, decodeThemeLink, serializeThemeForShare, buildShareLink,
  isStrictColor, isStrictShadow, isStrictLength, safeStr, ThemeLinkError, THEME_LINK,
  b64urlEncodeBytes, b64urlDecodeBytes, rebuildThemeReg, isBuiltInTheme,
  gameActive, xpForLevel, levelFor, todaysQuests, QUEST_POOL, questCtx, themeMusic,
  updateStreak, streakDisplay, DeviceKeys, bankSyncHTML, BankSyncClient,
  get THEME_REG(){ return THEME_REG; }, get THEME_IDS(){ return THEME_IDS; } };`;
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
S.accounts = [
  { id: "a-main", label: "Main", last4: "0017", type: "current", isPrimary: true, openingBalance: 0 },
  { id: "a-sav", label: "Savings", last4: "0033", type: "savings", isPrimary: false, openingBalance: 100000 },
];
S.settings = { monthlyIncome: 900000, savingsTargetPct: 10, salaryDay: 25, streak: 3, soundOn: false, theme: "midnight", lastBackup: null, allowanceFloor: 0, merchantRules: [], smsParserPatterns: null };
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

/* ---- 7e. SMS parser (also covered exhaustively in test-parser.mjs) ---- */
{
  const ctx = { accountLast4: ["0017", "0033"], now: new Date(2026, 7, 28, 12).getTime() };
  const a = T.SmsParser.parseOne("Card of a/c 0303XXXXXXXX0017 used for OMR 10.120 at DOMINOS MANAILAH AL KH on 26/08/2026", ctx);
  ok("SMS card purchase -> expense", a.type === "expense" && a.amount === 10120 && a.fromLast4 === "0017");
  const b = T.SmsParser.parseOne("OMR 420.000 is debited from your A/C 0303XXXXXXXX0017 and credited to your A/C 0303XXXXXXXX0033 on 26/08/2026 19:44:31.", ctx);
  eq("SMS both-mine transfer -> transfer_internal", b.type, "transfer_internal");
  const c = T.SmsParser.parseOne("random text no money here", ctx);
  ok("SMS unknown -> review entry, not null", c && c.type === "review");
  const batch = T.SmsParser.parseBatch("Salary OMR 644.000 Credited to your Account 26/08/2026.\n\nDear Customer, You have received OMR 2.030 from AHMED ALI", ctx);
  eq("SMS batch splits on blank line", batch.length, 2);
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

/* ---- 7g0. theme-file engine ---- */
{
  const ids = T.THEME_IDS;
  ok("THEMES registry loaded from generated region", ids.length >= 5, JSON.stringify(ids));
  for (const id of ["midnight", "paper", "desert", "depth", "monarch"])
    ok(`THEMES has "${id}"`, ids.includes(id));
  eq("THEME_DEFAULT is midnight", T.THEME_DEFAULT, "midnight");
  eq("THEME_IDS starts with the default", ids[0], "midnight");
  eq("themeName('monarch')", T.themeName("monarch"), "Monarch");
  eq("THEMES.monarch.scheme", T.THEMES.monarch.scheme, "dark");
  eq("THEMES.paper.scheme", T.THEMES.paper.scheme, "light");
  ok("themeBg('monarch') is a hex colour", /^#[0-9a-f]{6}$/i.test(T.themeBg("monarch")));
  ok("monarch declares a Google Fonts import", T.THEMES.monarch.fontImports.some((u) => /fonts\.googleapis\.com/.test(u)));
  eq("validTheme falls back to default for unknown id", T.validTheme("nope"), "midnight");
  // generated CSS + decorative CSS actually landed in index.html
  ok("index.html has :root[data-theme=\"monarch\"] palette", /:root\[data-theme="monarch"\]\{[^}]*--bg:\s*#0a0e1a/.test(html));
  ok("index.html has monarch decorative CSS", /\[data-theme="monarch"\] \.card\{/.test(html));
  ok("index.html has THEMES-JS generated block", /THEMES-JS:START[\s\S]*const THEMES = \{[\s\S]*"monarch"[\s\S]*THEMES-JS:END/.test(html));
}

/* ---- 7g0a. theme-declared music + gamification module ---- */
{
  const m = T.THEMES.monarch;
  ok("monarch declares music", m.music && typeof m.music === "object");
  eq("monarch music.src", m.music.src, "assets/theme-music.mp3");
  eq("monarch music.startAt", m.music.startAt, 33);
  eq("monarch music.loop", m.music.loop, true);
  eq("monarch opts into the gamification module", m.module, "gamification");
  eq("midnight has no music", T.THEMES.midnight.music, null);
  eq("midnight has no module", T.THEMES.midnight.module, null);
  ok("generated block carries music src + module", /assets\/theme-music\.mp3/.test(html) && /"module":\s*"gamification"/.test(html));

  // gameActive() follows the active theme's registry entry
  T.applyTheme("monarch");
  ok("gameActive() true under Monarch", T.gameActive());
  T.applyTheme("midnight");
  ok("gameActive() false under Midnight", !T.gameActive());
  T.applyTheme("monarch");

  // XP curve: L2=100, L3=300, L4=600, L5=1000
  eq("xpForLevel(2)", T.xpForLevel(2), 100);
  eq("xpForLevel(3)", T.xpForLevel(3), 300);
  eq("xpForLevel(5)", T.xpForLevel(5), 1000);
  eq("levelFor(0).level", T.levelFor(0).level, 1);
  eq("levelFor(99).level", T.levelFor(99).level, 1);
  eq("levelFor(100).level", T.levelFor(100).level, 2);
  eq("levelFor(350).level", T.levelFor(350).level, 3);
  eq("levelFor(150) progress into L2", T.levelFor(150).into, 50);
  ok("levelFor(150) pct is 0-100", T.levelFor(150).pct >= 0 && T.levelFor(150).pct <= 100);

  // daily quests: deterministic per date, always 3, all from the pool
  const q1 = T.todaysQuests("2026-08-28"), q2 = T.todaysQuests("2026-08-28");
  eq("todaysQuests count", q1.length, 3);
  eq("todaysQuests deterministic per day", q1.map((q) => q.id).join(","), q2.map((q) => q.id).join(","));
  const other = T.todaysQuests("2026-09-15").map((q) => q.id).join(",");
  ok("todaysQuests varies across days", other !== q1.map((q) => q.id).join(",") || T.QUEST_POOL.length <= 3);
  ok("every quest id is from the pool", q1.every((q) => T.QUEST_POOL.some((p) => p.id === q.id)));
  ok("every quest awards positive XP", q1.every((q) => q.xp > 0));

  // ---- PART 0 regression: quests key off a condition verified TODAY ----
  const pool = Object.fromEntries(T.QUEST_POOL.map((q) => [q.id, q]));
  const streakQ = pool.streak, underQ = pool.under;
  // 1. overspending today leaves the streak quest INCOMPLETE (was: complete on streak>0)
  ok("streak quest: not complete on a day you overspent",
     streakQ.check({ allowanceConfigured: true, allowanceToday: 5000, spentToday: 58000, expensesToday: 3 }) === false);
  ok("under quest: not complete on a day you overspent",
     underQ.check({ allowanceConfigured: true, allowanceToday: 5000, spentToday: 58000, expensesToday: 3 }) === false);
  // 2. a genuinely under-allowance day completes it
  ok("streak quest: completes on an at-or-under-allowance day",
     streakQ.check({ allowanceConfigured: true, allowanceToday: 5000, spentToday: 4200, expensesToday: 2 }) === true);
  ok("under quest: completes when you spent something and stayed under",
     underQ.check({ allowanceConfigured: true, allowanceToday: 5000, spentToday: 4200, expensesToday: 2 }) === true);
  ok("streak quest: a no-spend day still counts", streakQ.check({ allowanceConfigured: true, allowanceToday: 5000, spentToday: 0, expensesToday: 0 }) === true);
  // 3. no plan configured -> UNAVAILABLE (avail=false), never auto-completed, no XP
  ok("streak quest has an availability gate", typeof streakQ.avail === "function");
  ok("streak quest: unavailable when no allowance is configured", streakQ.avail({ allowanceConfigured: false }) === false);
  ok("under quest: unavailable when no allowance is configured", underQ.avail({ allowanceConfigured: false }) === false);
  ok("streak quest: available once an allowance exists", streakQ.avail({ allowanceConfigured: true }) === true);
  ok("quests with no allowance dependency have no avail gate",
     [pool.log, pool.fund, pool.note, pool.nospend].every((q) => !q.avail));
  ok("the old hardcoded streakToday flag is gone", !/streakToday/.test(html));

  // dailyAllowance().configured mirrors whether income/plan exists
  T.S.settings.monthlyIncome = 0; T.S.plans = []; T.S.tx = [];
  ok("dailyAllowance: configured=false with no income/plan/income-tx", T.F.dailyAllowance().configured === false);
  T.S.settings.monthlyIncome = 900000;
  ok("dailyAllowance: configured=true once monthly income is set", T.F.dailyAllowance().configured === true);
  T.S.settings.monthlyIncome = 0;

  // ---- PART 1: streaks count REAL calendar days ----
  {
    const day = (offset) => T.U.ymd(new Date(Date.now() + offset * 86400000));
    const setMeta = async (o) => { for (const k in o) await T.DB.setMeta(k, o[k]); };
    // build a month's worth of tx: small daily spend so every day is well within allowance
    const cleanHistory = (fromOffset, toOffset, dailyAmt) => {
      T.S.tx = [];
      for (let o = fromOffset; o <= toOffset; o++)
        T.S.tx.push({ id: "t" + o, ts: T.U.parseYMD(day(o)), month: day(o).slice(0, 7), amount: dailyAmt, type: "expense", category: "Other" });
    };

    T.S.settings.monthlyIncome = 900000; T.S.plans = []; T.S.envelopes = [];

    // dayResult: within allowance -> ok, over -> over, no plan -> neutral
    cleanHistory(-8, -1, 300);
    ok("dayResult: a within-allowance day is 'ok'", T.F.dayResult(day(-3)) === "ok");
    T.S.tx.push({ id: "big", ts: T.U.parseYMD(day(-3)), month: day(-3).slice(0, 7), amount: 900000, type: "expense", category: "Other" });
    ok("dayResult: an over-allowance day is 'over'", T.F.dayResult(day(-3)) === "over");
    T.S.settings.monthlyIncome = 0;
    ok("dayResult: a day with no plan is 'neutral'", T.F.dayResult(day(-3)) === "neutral");
    T.S.settings.monthlyIncome = 900000;

    // 1. a five-day gap with clean history advances by exactly the days elapsed
    cleanHistory(-10, -1, 250);
    await setMeta({ firstUseDate: day(-30), streakDate: day(-6), streak: 4, allowanceStreak: 4, streakEverScored: true });
    await T.updateStreak();
    eq("5-day clean gap: streak advances by the 5 elapsed days", T.S.settings.streak, 9);

    // 2. a five-day gap containing one overspend resets, then advances from there
    cleanHistory(-10, -1, 250);
    T.S.tx.push({ id: "boom", ts: T.U.parseYMD(day(-3)), month: day(-3).slice(0, 7), amount: 900000, type: "expense", category: "Other" });
    await setMeta({ firstUseDate: day(-30), streakDate: day(-6), streak: 4, allowanceStreak: 4, streakEverScored: true });
    await T.updateStreak();
    eq("5-day gap with an overspend: resets, then counts days -2 and -1", T.S.settings.streak, 2);

    // 3. a no-plan period is neutral — the streak is unchanged, not incremented for nothing
    cleanHistory(-10, -1, 250);
    T.S.settings.monthlyIncome = 0;
    await setMeta({ firstUseDate: day(-30), streakDate: day(-6), streak: 7, allowanceStreak: 7, streakEverScored: true });
    await T.updateStreak();
    eq("no-plan gap: streak held at 7 (never advanced for unmeasurable days)", T.S.settings.streak, 7);
    T.S.settings.monthlyIncome = 900000;

    // 4. nothing before firstUseDate is ever counted
    cleanHistory(-10, -1, 250);
    await setMeta({ firstUseDate: day(-2), streakDate: null, streak: 0, allowanceStreak: 0, streakEverScored: false });
    await T.updateStreak();
    eq("firstUseDate honoured: only days -2 and -1 scored, not the earlier clean history", T.S.settings.streak, 2);

    // 5. no day is ever scored twice — a second call the same day is a no-op
    const before = T.S.settings.streak;
    await T.updateStreak();
    eq("same-day re-evaluation is a no-op", T.S.settings.streak, before);

    // streakDisplay: 'not tracked yet' until a real day has been scored
    T.S.settings.streakEverScored = false;
    ok("streakDisplay: 'not tracked yet' before any day is scored", T.streakDisplay().tracked === false && /not tracked/i.test(T.streakDisplay().text));
    T.S.settings.streakEverScored = true; T.S.settings.streak = 5;
    ok("streakDisplay: shows the number once days have been scored", T.streakDisplay().tracked === true && T.streakDisplay().text === "5");

    ok("boot() evaluates the streak on open (gap detection)", /await updateStreak\(\)/.test(html.slice(html.indexOf("async function boot"))));
    ok("the old perDay >= 0 streak rule is gone", !/streak = sts\.perDay >= 0/.test(html));
    T.S.tx = []; T.S.settings.monthlyIncome = 0;
  }

  // music controller: never touches the network before a tap
  eq("themeMusic starts un-started", T.themeMusic.started, false);
  eq("themeMusic.spec() resolves for Monarch", T.themeMusic.spec().src, "assets/theme-music.mp3");
}

/* ---- 7g0a2. music / module never survive a share link ---- */
{
  const withMusic = { v: 1, id: "x", name: "X", scheme: "dark", tokens: { bg: "#111" }, music: { src: "assets/x.mp3" } };
  ok("shared theme with a music field is rejected", !T.validateSharedTheme(withMusic).ok);
  const withModule = { v: 1, id: "x", name: "X", scheme: "dark", tokens: { bg: "#111" }, module: "gamification" };
  ok("shared theme with a module field is rejected", !T.validateSharedTheme(withModule).ok);
  const p = T.serializeThemeForShare("monarch");
  ok("serialized Monarch drops music", !("music" in p));
  ok("serialized Monarch drops module", !("module" in p));
}

/* ---- 7g0a3. build-themes.js rejects malformed music / module ---- */
{
  const themesDir = path.join(__dir, "themes");
  const badPath = path.join(themesDir, "_zbad.theme.json");
  // theme validation runs before the --check sync comparison, so a bad file always dies here
  const buildRejects = (obj) => {
    fs.writeFileSync(badPath, JSON.stringify({ id: "_zbad", name: "Bad", scheme: "dark", ...obj }));
    try { execSync(`node "${path.join(__dir, "build-themes.js")}" --check`, { stdio: "pipe" }); return false; }
    catch { return true; }
    finally { fs.unlinkSync(badPath); }
  };
  ok("rejects music.src with a traversal", buildRejects({ music: { src: "../secret.mp3" } }));
  ok("rejects music.src with a bad extension", buildRejects({ music: { src: "assets/x.txt" } }));
  ok("rejects negative music.startAt", buildRejects({ music: { src: "a.mp3", startAt: -5 } }));
  ok("rejects music.startAt that is not a number", buildRejects({ music: { src: "a.mp3", startAt: "33" } }));
  ok("rejects an unknown module", buildRejects({ module: "cheat-codes" }));
}

/* ---- 7g0b. index.html is in sync with themes/*.theme.json ---- */
try {
  execSync(`node "${path.join(__dir, "build-themes.js")}" --check`, { stdio: "pipe" });
  ok("build-themes.js --check: index.html is in sync with theme files", true);
} catch (e) {
  ok("build-themes.js --check: index.html is in sync with theme files", false, String(e.stdout || e.stderr || e));
}

/* ---- 7g0c. QR encoder (round-trips through jsQR) ---- */
{
  const jsQR = (await import("jsqr")).default;
  const raster = (qr, scale = 5, border = 4) => {
    const dim = (qr.size + border * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x])
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const p = (((y + border) * scale + sy) * dim + ((x + border) * scale + sx)) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
    return { data, dim };
  };
  for (const s of ["HELLO", "https://goosh2000.github.io/rial-app/#theme=d" + "Ab1C".repeat(120)]) {
    const qr = T.QR.encode(s, T.QR.ECL.L);
    eq(`QR size formula (v${qr.version})`, qr.size, 21 + 4 * (qr.version - 1));
    ok("QR finder pattern present", qr.modules[0][0] && qr.modules[6][6] && !qr.modules[1][1]);
    const { data, dim } = raster(qr);
    const dec = jsQR(data, dim, dim);
    ok(`QR round-trips a ${s.length}-char string through jsQR`, dec && dec.data === s, dec ? dec.data.slice(0, 30) : "null");
  }
  eq("QR is deterministic", T.QR.matrixString(T.QR.encode("x", T.QR.ECL.M)), T.QR.matrixString(T.QR.encode("x", T.QR.ECL.M)));
  ok("QR.toSVG returns an <svg>", /^<svg[\s\S]+<\/svg>$/.test(T.QR.toSVG(T.QR.encode("x", T.QR.ECL.L))));
}

/* ---- 7g0d. theme link: strict validators ---- */
{
  const C = T.isStrictColor;
  ok("color: #4d9dff", C("#4d9dff"));
  ok("color: #abc", C("#abc"));
  ok("color: #12345678", C("#12345678"));
  ok("color: rgb(10,20,30)", C("rgb(10,20,30)"));
  ok("color: rgba(0,0,0,.35)", C("rgba(0,0,0,.35)"));
  ok("color: hsl(210,50%,40%)", C("hsl(210, 50%, 40%)"));
  ok("color: named 'blue'", C("blue"));
  ok("color: 'transparent'", C("transparent"));
  ok("REJECT color-mix()", !C("color-mix(in srgb, red 50%, blue)"));
  ok("REJECT var()", !C("var(--x)"));
  ok("REJECT calc()", !C("calc(1px + 2px)"));
  ok("REJECT 'red;evil'", !C("red;evil"));
  ok("REJECT url()", !C("url(https://x/y.png)"));
  ok("REJECT '#gg'", !C("#gg"));
  ok("REJECT bare number", !C("123"));
  ok("REJECT expression()", !C("expression(alert(1))"));

  const SH = T.isStrictShadow;
  ok("shadow: base midnight", SH("0 8px 30px rgba(0,0,0,.35)"));
  ok("shadow: base paper", SH("0 8px 24px rgba(20,30,50,.08)"));
  ok("shadow: monarch 2-layer", SH("0 0 22px rgba(75,180,255,.14), 0 10px 34px rgba(0,0,0,.62)"));
  ok("shadow: inset", SH("inset 0 0 0 1px rgba(0,0,0,.1)"));
  ok("REJECT shadow with url()", !SH("0 0 10px url(x)"));
  ok("REJECT shadow with ;}", !SH("0 0 0 red;}"));
  ok("REJECT shadow: 6 layers", !SH("0 0 red,0 0 red,0 0 red,0 0 red,0 0 red,0 0 red"));

  ok("length: 20px", T.isStrictLength("20px"));
  ok("length: 0", T.isStrictLength("0"));
  ok("REJECT length: 20px;evil", !T.isStrictLength("20px;evil"));
  ok("REJECT length: calc(1px)", !T.isStrictLength("calc(1px)"));
}

/* ---- 7g0e. validateSharedTheme: valid + malicious payloads ---- */
{
  const good = { v: 1, id: "sunset", name: "Sunset", author: "Nadia", scheme: "dark",
    tokens: { bg: "#1a0f14", accent: "#ff7a45", text: "#fdeee6", "text-dim": "#c9a99a", shadow: "0 8px 30px rgba(0,0,0,.4)", "r-lg": "12px" }, font: "Rajdhani" };
  {
    const r = T.validateSharedTheme(good);
    ok("valid theme passes", r.ok, r.error);
    ok("validated theme keeps only known fields", r.ok && !("evil" in r.theme) && r.theme.font === "Rajdhani");
  }
  const bad = [
    ["script in a colour value", { ...good, tokens: { ...good.tokens, accent: "#fff;} body{display:none} .x{" } }],
    ["external url() in a colour", { ...good, tokens: { ...good.tokens, bg: "url(https://evil.example/x.png)" } }],
    ["< in the name", { ...good, name: "Pwn</style><script>x" }],
    ["javascript: in a value", { ...good, tokens: { ...good.tokens, text: "javascript:alert(1)" } }],
    ["expression() in a value", { ...good, tokens: { ...good.tokens, accent: "expression(alert(1))" } }],
    ["color-mix() in a value", { ...good, tokens: { ...good.tokens, accent: "color-mix(in srgb,red,blue)" } }],
    ["unknown top-level key (decorativeCss)", { ...good, decorativeCss: "body{display:none}" }],
    ["unknown top-level key (fontImports)", { ...good, fontImports: ["https://evil/x.css"] }],
    ["unknown top-level key (music)", { ...good, music: "https://evil/x.mp3" }],
    ["unknown token key", { ...good, tokens: { ...good.tokens, hackToken: "#fff" } }],
    ["font name with markup", { ...good, font: "Rajdhani</style>" }],
    ["font name path traversal", { ...good, font: "../../etc/passwd" }],
    ["bad scheme", { ...good, scheme: "auto" }],
    ["id with spaces", { ...good, id: "My Theme" }],
    ["id path traversal", { ...good, id: "../etc" }],
    ["wrong payload version", { ...good, v: 2 }],
    ["oversized name", { ...good, name: "x".repeat(120) }],
    ["oversized token value", { ...good, tokens: { ...good.tokens, bg: "#" + "a".repeat(5000) } }],
    ["empty palette", { ...good, tokens: {} }],
    ["tokens is an array", { ...good, tokens: ["#fff"] }],
    ["null", null],
    ["a bare string", "not a theme"],
  ];
  for (const [label, payload] of bad) {
    const r = T.validateSharedTheme(payload);
    ok(`REJECT: ${label}`, r && r.ok === false && typeof r.error === "string", JSON.stringify(r));
  }
}

/* ---- 7g0f. encode/decode round-trip + decoder robustness ---- */
{
  const theme = { v: 1, id: "aurora", name: "Aurora", scheme: "dark",
    tokens: { bg: "#04121a", accent: "#38e8ff", text: "#e7f6fb", "text-dim": "#9fc4d2" } };
  const encoded = await T.encodeThemeLink(theme);
  ok("encoded payload is url-safe", /^[dr][A-Za-z0-9_-]+$/.test(encoded));
  const back = await T.decodeThemeLink(encoded);
  const v = T.validateSharedTheme(back);
  ok("link round-trips: decode + validate", v.ok, v.error);
  ok("link round-trips: same tokens", v.ok && JSON.stringify(v.theme.tokens) === JSON.stringify(theme.tokens));
  ok("link round-trips: same name/scheme/id", v.ok && v.theme.name === "Aurora" && v.theme.scheme === "dark" && v.theme.id === "aurora");

  // decoder must fail cleanly on garbage
  const rej = async (label, payload) => {
    let threw = null; try { await T.decodeThemeLink(payload); } catch (e) { threw = e; }
    ok(`decode REJECTS ${label}`, threw instanceof T.ThemeLinkError, threw ? threw.message : "did not throw");
  };
  await rej("malformed base64", "d!!!!not base64!!!!");
  await rej("unknown marker", "z" + T.b64urlEncodeBytes(new TextEncoder().encode("{}")));
  await rej("non-JSON body", "r" + T.b64urlEncodeBytes(new TextEncoder().encode("<<<not json>>>")));
  await rej("oversized payload string", "r" + "A".repeat(T.THEME_LINK.MAX_LINK_CHARS + 10));
  await rej("empty", "");

  // an oversized-but-valid-base64 raw JSON blob -> rejected on decoded byte size
  const huge = "r" + T.b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify({ v: 1, pad: "x".repeat(6000) })));
  await rej("oversized decoded JSON", huge);
}

/* ---- 7g0g. serialize current theme + build link ---- */
{
  const p = T.serializeThemeForShare("monarch");
  eq("serialize monarch: 16 tokens", Object.keys(p.tokens).length, 16);
  eq("serialize monarch: font", p.font, "Orbitron");
  ok("serialize monarch: passes its own validator", T.validateSharedTheme(p).ok);
  const link = await T.buildShareLink("midnight");
  ok("buildShareLink returns a #theme= fragment url", /\/rial-app\/#theme=[dr][A-Za-z0-9_-]+$/.test(link.url));
  ok("buildShareLink round-trips", (await T.decodeThemeLink(link.encoded)).id === "midnight");
}

/* ---- 7p. accounts + transaction types + daily allowance ---- */
{
  const A_MAIN = "am", A_SAV = "as";
  S.accounts = [
    { id: A_MAIN, label: "Main", last4: "0017", type: "current", isPrimary: true, openingBalance: 0 },
    { id: A_SAV, label: "Savings", last4: "0033", type: "savings", isPrimary: false, openingBalance: 0 },
  ];
  const MKA = U.monthKey();
  S.recurring = []; S.envelopes = []; S.plans = []; S.goals = [];
  S.settings = { ...S.settings, monthlyIncome: 600000, allowanceFloor: 0, savingsTargetPct: 0 };
  S.tx = [
    { id: "x1", ts: U.todayTs(), month: MKA, amount: 500000, type: "income", category: "Salary", accountId: A_MAIN },
    { id: "x2", ts: U.todayTs(), month: MKA, amount: 40000, type: "expense", category: "Food", accountId: A_MAIN },
    { id: "x3", ts: U.todayTs(), month: MKA, amount: 30000, type: "transfer_out", counterparty: "Ali", accountId: A_MAIN },
    { id: "x4", ts: U.todayTs(), month: MKA, amount: 10000, type: "transfer_in", counterparty: "Sara", accountId: A_MAIN },
    { id: "x5", ts: U.todayTs(), month: MKA, amount: 200000, type: "transfer_internal", fromAccountId: A_MAIN, toAccountId: A_SAV },
  ];

  // type predicates
  ok("isSpend: expense + transfer_out yes; internal + transfer_in no",
     F.isSpend({ type: "expense" }) && F.isSpend({ type: "transfer_out" }) && !F.isSpend({ type: "transfer_internal" }) && !F.isSpend({ type: "transfer_in" }));
  ok("isIncome: income + transfer_in yes; internal no",
     F.isIncome({ type: "income" }) && F.isIncome({ type: "transfer_in" }) && !F.isIncome({ type: "transfer_internal" }));

  // THE explicit test: the 200.000 internal transfer moves both balances, changes spending by ZERO
  eq("spentThisMonth counts only real outflows (40 + 30)", F.spentThisMonth(MKA), 70000);
  eq("incomeThisMonth counts income + transfer_in (500 + 10)", F.incomeThisMonth(MKA), 510000);
  eq("Main balance: +500 -40 -30 +10 -200 = 240.000", F.accountBalance(A_MAIN), 240000);
  eq("Savings balance: +200.000", F.accountBalance(A_SAV), 200000);
  eq("combined balance unaffected by the internal transfer", F.combinedBalance(), 440000);
  // remove the internal transfer -> spending unchanged, balances shift back
  const noInternal = S.tx.filter(t => t.id !== "x5");
  const withAll = F.spentThisMonth(MKA);
  S.tx = noInternal;
  eq("removing the internal transfer changes spentThisMonth by ZERO", F.spentThisMonth(MKA), withAll);
  eq("without internal transfer, Main balance = 440.000", F.accountBalance(A_MAIN), 440000);
  S.tx.push({ id: "x5", ts: U.todayTs(), month: MKA, amount: 200000, type: "transfer_internal", fromAccountId: A_MAIN, toAccountId: A_SAV });
  // internal transfer never in envelope drawdown / category insights
  S.envelopes = [{ id: "e1", month: MKA, category: "Food", allocated: 100000, sort: 0 }];
  eq("envelopeSpent(Food) sees only the 40.000 real expense", F.envelopeSpent("Food", MKA), 40000);
  S.envelopes = [];

  // --- daily allowance: rolling correction ---
  // income 600, no commitments/goals/envelopes -> pool 600 / daysInMonth
  const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
  {
    S.tx = [];
    S.settings.monthlyIncome = 600000;
    const jan = at(2026, 1, 1);
    const al = F.dailyAllowance(jan);
    eq("day 1 of a 31-day month: base = 600/31 rounded", al.base, Math.round(600000 / 31));
    eq("nothing spent -> carryover 0", al.carryover, 0);
    ok("allowance is never negative", al.today >= 0);
  }
  {
    // simulate: it's the 10th, and I've overspent by a lot in the first 9 days
    S.settings.monthlyIncome = 600000;   // base ~ 19354/day
    const base = Math.round(600000 / 31);
    S.tx = [{ id: "o1", ts: at(2026, 1, 5).getTime(), month: "2026-01", amount: base * 9 + 120000, type: "expense", category: "Food", accountId: "am" }];
    const al = F.dailyAllowance(at(2026, 1, 10));
    ok("large overspend: carryover is positive (behind)", al.carryover > 0);
    ok("large overspend: correction reduces today's allowance", al.correction > 0 && al.today < al.base);
    ok("large overspend: today's allowance is NEVER negative or zero as advice", al.today >= al.floor && al.today >= 0);
    ok("large overspend: spread over min(7, days left)", al.spreadDays === Math.min(7, al.daysLeft));
    ok("large overspend: message explains the correction", typeof al.message === "string" && /allowance is/.test(al.message));
  }
  {
    // impossible case: overspend so large the remaining days can't absorb it above the floor
    S.settings.monthlyIncome = 600000;
    S.settings.allowanceFloor = 15000;
    S.tx = [{ id: "o2", ts: at(2026, 1, 28).getTime(), month: "2026-01", amount: 2000000, type: "expense", category: "Food", accountId: "am" }];
    const al = F.dailyAllowance(at(2026, 1, 29));   // 3 days left, huge overage
    ok("impossible case flagged", al.impossible === true);
    ok("impossible case: honest message, not a fake allowance", /can't absorb it|something has to give/i.test(al.message));
    ok("impossible case: offers options", Array.isArray(al.options) && al.options.length >= 2);
    ok("impossible case: displayed allowance never below the floor", al.today >= al.floor);
    S.settings.allowanceFloor = 0;
  }
  {
    // underspending rolls forward -> allowance rises
    S.settings.monthlyIncome = 600000;
    const base = Math.round(600000 / 31);
    S.tx = [{ id: "u1", ts: at(2026, 1, 3).getTime(), month: "2026-01", amount: 5000, type: "expense", category: "Food", accountId: "am" }];
    const al = F.dailyAllowance(at(2026, 1, 10));   // spent almost nothing in 9 days
    ok("underspend: carryover is negative (ahead)", al.carryover < 0);
    ok("underspend: today's allowance rises above base", al.today > al.base);
    ok("underspend: message is encouraging, not scolding", /under/i.test(al.message) && !/over/i.test(al.message));
  }
  {
    // transfer_internal is excluded from 'spent today'
    S.settings.monthlyIncome = 600000;
    const t = new Date();
    S.tx = [
      { id: "s1", ts: Date.now(), month: U.monthKey(), amount: 8000, type: "expense", category: "Food", accountId: "am" },
      { id: "s2", ts: Date.now(), month: U.monthKey(), amount: 300000, type: "transfer_internal", fromAccountId: "am", toAccountId: "as" },
    ];
    const al = F.dailyAllowance(t);
    eq("dailyAllowance spentToday excludes the internal transfer", al.spentToday, 8000);
  }
  S.tx = []; S.settings.allowanceFloor = 0;
}

/* ---- 7g0h. user-theme registry (rebuildThemeReg) ---- */
{
  const before = T.THEME_IDS.length;
  S.settings.userThemes = [
    { v: 1, id: "friendtheme", name: "Friend's", scheme: "dark", tokens: { bg: "#101018", accent: "#c0ffee" } },
    { v: 1, id: "midnight", name: "Evil Override", scheme: "dark", tokens: { bg: "#000000" } },  // tries to shadow built-in
    { v: 1, id: "broken", name: "Bad", scheme: "dark", tokens: { accent: "url(x)" } },           // invalid -> dropped
  ];
  T.rebuildThemeReg();
  ok("valid user theme joins the registry", !!T.THEME_REG.friendtheme && T.THEME_REG.friendtheme.custom === true);
  ok("user theme CANNOT shadow a built-in", T.THEME_REG.midnight.name === "Midnight");
  ok("invalid user theme is dropped from the registry", !T.THEME_REG.broken);
  ok("invalid user theme is pruned from storage", S.settings.userThemes.every(t => t.id !== "broken"));
  ok("built-in id in userThemes is pruned too", S.settings.userThemes.every(t => t.id !== "midnight"));
  eq("THEME_IDS grew by exactly 1", T.THEME_IDS.length, before + 1);
  ok("themeName resolves a user theme", T.themeName("friendtheme") === "Friend's");
  ok("isBuiltInTheme: friendtheme false, midnight true", !T.isBuiltInTheme("friendtheme") && T.isBuiltInTheme("midnight"));
  S.settings.userThemes = []; T.rebuildThemeReg();
}

/* ---- 7g. theme auto-scheduler ---- */
{
  const at = (h, m = 0) => new Date(2026, 7, 27, h, m, 0); // Aug 27 2026 local

  eq("parseHM '18:30'", T.parseHM("18:30"), 18 * 60 + 30);
  eq("parseHM '06:00'", T.parseHM("06:00"), 360);
  eq("parseHM bad", T.parseHM("9:99"), null);
  eq("fmtHM 1110", T.fmtHM(1110), "18:30");
  eq("fmtHM wraps -60 -> 23:00", T.fmtHM(-60), "23:00");

  // normal window 09:00-17:00 (end exclusive)
  ok("windowActive normal @12:00", T.windowActive({ start: "09:00", end: "17:00" }, 12 * 60));
  ok("windowActive normal @08:59 false", !T.windowActive({ start: "09:00", end: "17:00" }, 8 * 60 + 59));
  ok("windowActive normal @17:00 false (exclusive end)", !T.windowActive({ start: "09:00", end: "17:00" }, 17 * 60));
  // wrap-past-midnight window 18:00-06:00
  const wrap = { start: "18:00", end: "06:00" };
  ok("wrap window @23:00", T.windowActive(wrap, 23 * 60));
  ok("wrap window @03:00", T.windowActive(wrap, 3 * 60));
  ok("wrap window @18:00 (inclusive start)", T.windowActive(wrap, 18 * 60));
  ok("wrap window @06:00 false (exclusive end)", !T.windowActive(wrap, 6 * 60));
  ok("wrap window @12:00 false", !T.windowActive(wrap, 12 * 60));

  // scheduledThemeAt across the day
  S.settings.themeSchedule = {
    mode: "windows", base: "desert",
    windows: [{ start: "18:00", end: "06:00", theme: "depth" }, { start: "06:00", end: "12:00", theme: "paper" }],
    systemLight: "paper", systemDark: "midnight",
  };
  eq("sched @20:00 -> depth (night window)", T.scheduledThemeAt(at(20)), "depth");
  eq("sched @02:00 -> depth (wraps midnight)", T.scheduledThemeAt(at(2)), "depth");
  eq("sched @08:00 -> paper (morning window)", T.scheduledThemeAt(at(8)), "paper");
  eq("sched @14:00 -> desert (gap -> base)", T.scheduledThemeAt(at(14)), "desert");
  eq("sched @18:00 -> depth (boundary)", T.scheduledThemeAt(at(18)), "depth");

  // next boundary
  eq("nextBoundary @20:00 -> 06:00 tomorrow", new Date(T.nextBoundaryAfter(at(20))).getHours(), 6);
  {
    const nb = new Date(T.nextBoundaryAfter(at(20)));
    ok("nextBoundary @20:00 is next calendar day", nb.getDate() === 28);
  }
  eq("nextBoundary @08:00 -> 12:00 today (hour)", new Date(T.nextBoundaryAfter(at(8))).getHours(), 12);
  eq("nextBoundary @13:00 -> 18:00 today (hour)", new Date(T.nextBoundaryAfter(at(13))).getHours(), 18);
  eq("nextBoundary @05:00 -> 06:00 today (hour)", new Date(T.nextBoundaryAfter(at(5))).getHours(), 6);

  // "system" mode
  S.settings.themeSchedule = { mode: "system", systemLight: "paper", systemDark: "midnight", windows: [], base: "midnight" };
  _prefersDark = false;
  eq("system mode, light -> paper", T.scheduledThemeAt(at(3)), "paper");
  _prefersDark = true;
  eq("system mode, dark -> midnight", T.scheduledThemeAt(at(3)), "midnight");
  eq("system mode: nextBoundary is null (event-driven)", T.nextBoundaryAfter(at(3)), null);
  _prefersDark = false;

  // "off" mode
  S.settings.themeSchedule = { mode: "off", windows: [], base: "midnight", systemLight: "paper", systemDark: "midnight" };
  eq("off mode -> scheduledThemeAt null", T.scheduledThemeAt(at(20)), null);

  // manual override expiry
  ok("manualExpired: future until -> not expired", !T.manualExpired({ theme: "depth", until: at(20).getTime() + 3600000 }, at(20).getTime()));
  ok("manualExpired: past until -> expired", T.manualExpired({ theme: "depth", until: at(20).getTime() - 1 }, at(20).getTime()));
  ok("manualExpired: null until -> never expires", !T.manualExpired({ theme: "depth", until: null }, at(20).getTime()));

  // evaluateSchedule applies the scheduled theme; a live manual override blocks it
  // (applyThemeSmooth defers the swap ~200ms behind the crossfade, so await it)
  const settle = () => new Promise((r) => setTimeout(r, 280));
  T.applyTheme("midnight");
  S.settings.themeSchedule = {
    mode: "windows", base: "midnight",
    windows: [{ start: "18:00", end: "06:00", theme: "depth" }], systemLight: "paper", systemDark: "midnight",
  };
  S.settings.themeManual = null;
  T.evaluateSchedule(at(21)); await settle();
  eq("evaluateSchedule @21:00 switches to depth", T.currentThemeId(), "depth");
  T.applyTheme("midnight");
  S.settings.themeManual = { theme: "paper", until: at(21).getTime() + 3600000 };
  T.evaluateSchedule(at(21)); await settle();
  eq("evaluateSchedule respects a live manual override (stays midnight)", T.currentThemeId(), "midnight");
  S.settings.themeManual = { theme: "paper", until: at(21).getTime() - 1 };  // expired
  T.evaluateSchedule(at(21)); await settle();
  eq("evaluateSchedule resumes schedule after override expires", T.currentThemeId(), "depth");
  S.settings.themeManual = null;

  ok("scheduleHTML renders for windows mode", /SCHEDULE/.test(T.scheduleHTML()) && /Add window/.test(T.scheduleHTML()));
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

/* ---- bank-sync Phase 1: device keys (no crypto.subtle/indexedDB in this sandbox) ---- */
{
  ok("DeviceKeys.isSupported() is false without WebCrypto/IndexedDB", T.DeviceKeys.isSupported() === false);
  const st = await T.DeviceKeys.status();
  ok("DeviceKeys.status() reports disabled with no crypto available", st.enabled === false);
  let threw = false, out = "";
  try { out = T.bankSyncHTML({}); } catch (e) { threw = true; out = String(e && e.stack || e); }
  ok("bankSyncHTML() renders the unsupported state without throwing", !threw && out.includes("Automatic import") && out.includes("Not available"), out.slice(0, 200));
}

/* ---- bank-sync Phase 3A: client sync layer fails gracefully with no fetch/crypto ---- */
{
  const sync = await T.BankSyncClient.syncNow();
  ok("BankSyncClient.syncNow() never throws and reports unsupported here", sync.ok === false && sync.error === "unsupported");
  const reg = await T.BankSyncClient.register("https://example.invalid");
  ok("BankSyncClient.register() fails gracefully with no local key, never touching fetch", reg.ok === false && /device key/i.test(reg.error));
}
{
  const svg = ctx.__T.sparkSVG(F.last30());
  ok("sparkSVG returns <svg> with polyline", svg.includes("<svg") && svg.includes("polyline"));
}

/* ---- done ---- */
fs.rmSync(extracted);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
