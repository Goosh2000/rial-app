/* test-parser.mjs — fixture tests for parser.js (the highest-risk logic).
   Run: node test-parser.mjs */
import P from "./parser.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("  FAIL " + n + (extra ? "  -> " + extra : ""))); };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ctx: I own accounts ending 0017 and 0033
const CTX = { accountLast4: ["0017", "0033"], now: new Date(2026, 7, 27, 12, 0, 0).getTime() };

/* ---------- 1. the five real fixtures ---------- */

{
  const e = P.parseOne("Salary OMR 644.000 Credited to your Account 26/08/2026.", CTX);
  eq("F1 type", e.type, "income");
  eq("F1 amount (baisa)", e.amount, 644000);
  eq("F1 category", e.category, "salary");
  eq("F1 date", e.ymd, "2026-08-26");
  eq("F1 source", e.source, "Salary");
  eq("F1 matched pattern", e.matched, "salary_credit");
}

{
  const e = P.parseOne("Dear Customer, You have sent OMR 57.000 to AHME#####MOOD from your a/c 0303XXXXXXXX0017 on 26/08/2026 19:42:00 using Mobile", CTX);
  eq("F2 type", e.type, "transfer_out");
  eq("F2 amount", e.amount, 57000);
  eq("F2 counterparty (masking kept)", e.counterparty, "AHME#####MOOD");
  eq("F2 fromLast4", e.fromLast4, "0017");
  eq("F2 date", e.ymd, "2026-08-26");
  eq("F2 time", e.time, "19:42:00");
  ok("F2 ts is 2026-08-26 19:42:00 local", new Date(e.ts).getHours() === 19 && new Date(e.ts).getMinutes() === 42);
}

{
  const e = P.parseOne("Dear Customer, You have received OMR 2.030 from AHMED ALI", CTX);
  eq("F3 type", e.type, "transfer_in");
  eq("F3 amount", e.amount, 2030);
  eq("F3 counterparty", e.counterparty, "AHMED ALI");
  ok("F3 has no explicit date -> dateAssumed", e.dateAssumed === true);
}

{
  const e = P.parseOne("OMR 420.000 is debited from your A/C 0303XXXXXXXX0017 and credited to your A/C 0303XXXXXXXX0033 on 26/08/2026 19:44:31.", CTX);
  eq("F4 type (both mine)", e.type, "transfer_internal");
  eq("F4 amount", e.amount, 420000);
  eq("F4 fromLast4", e.fromLast4, "0017");
  eq("F4 toLast4", e.toLast4, "0033");
  eq("F4 date", e.ymd, "2026-08-26");
  eq("F4 time", e.time, "19:44:31");
  eq("F4 has no category (never spending)", e.category, null);
}

{
  const e = P.parseOne("Card of a/c 0303XXXXXXXX0017 used for OMR 10.120 at DOMINOS MANAILAH AL KH on 26/08/2026", CTX);
  eq("F5 type", e.type, "expense");
  eq("F5 amount", e.amount, 10120);
  eq("F5 merchant", e.merchant, "DOMINOS MANAILAH AL KH");
  eq("F5 fromLast4", e.fromLast4, "0017");
  eq("F5 date", e.ymd, "2026-08-26");
  eq("F5 category via DOMINOS->food rule", e.category, "food");
}

/* ---------- 2. the transfer-type rule (highest risk) ---------- */
{
  const R = P.resolveTransferType;
  eq("both ends mine -> transfer_internal", R("0017", "0033", ["0017", "0033"]), "transfer_internal");
  eq("only source mine -> transfer_out", R("0017", "9999", ["0017", "0033"]), "transfer_out");
  eq("only dest mine -> transfer_in", R("9999", "0033", ["0017", "0033"]), "transfer_in");
  eq("neither mine -> review", R("1111", "2222", ["0017", "0033"]), "review");
  eq("source mine, no dest -> transfer_out", R("0017", null, ["0017"]), "transfer_out");

  // the same internal-transfer SMS, but I only own 0017 -> it's money leaving to someone else
  const e = P.parseOne("OMR 420.000 is debited from your A/C 0303XXXXXXXX0017 and credited to your A/C 0303XXXXXXXX0033 on 26/08/2026 19:44:31.",
    { accountLast4: ["0017"], now: CTX.now });
  eq("internal SMS with only source registered -> transfer_out", e.type, "transfer_out");
}

/* ---------- 3. money is integer baisa, never float ---------- */
{
  eq("toBaisa 644.000", P.toBaisa("644.000"), 644000);
  eq("toBaisa 10.120", P.toBaisa("10.120"), 10120);
  eq("toBaisa 2.030", P.toBaisa("2.030"), 2030);
  eq("toBaisa 1,234.500 (thousands sep)", P.toBaisa("1,234.500"), 1234500);
  eq("toBaisa 0.001", P.toBaisa("0.001"), 1);
  eq("toBaisa 5 (no decimals)", P.toBaisa("5"), 5000);
  let acc = 0; for (let i = 0; i < 1000; i++) acc += P.toBaisa("0.001");
  eq("1000 x 0.001 == exactly 1.000", acc, 1000);
}

/* ---------- 4. DD/MM/YYYY is day-first, never US ---------- */
{
  const d = P.parseDMY("03/11/2026");   // 3 Nov, NOT 11 Mar
  eq("parseDMY 03/11/2026 -> ymd", d.ymd, "2026-11-03");
  eq("parseDMY day", d.d, 3);
  eq("parseDMY month", d.m, 11);
  ok("parseDMY rejects month 13", P.parseDMY("01/13/2026") === null);
}

/* ---------- 5. only last-4 is ever kept ---------- */
{
  eq("last4 of masked token", P.last4("0303XXXXXXXX0017"), "0017");
  eq("last4 of bare last4", P.last4("0033"), "0033");
  eq("last4 of full-looking number", P.last4("030312345678900017"), "0017");
  const e = P.parseOne("Card of a/c 0303XXXXXXXX0017 used for OMR 10.120 at SHOP on 26/08/2026", CTX);
  ok("parsed entry stores only last4, not the token", e.fromLast4 === "0017" && !/0303XXXXXXXX/.test(JSON.stringify(e)));
  ok("raw text is scrubbed of the account token", !/0303XXXXXXXX0017/.test(e.raw) && /••••0017/.test(e.raw));
  // a full unmasked number in the text is scrubbed too
  const e2 = P.parseOne("Transfer of OMR 5.000 ref account 03031234567890123 something odd", CTX);
  ok("bare long number scrubbed from review raw", !/03031234567890123/.test(e2.raw));
}

/* ---------- 6. unknown format -> review entry, never dropped, never crash ---------- */
{
  const e = P.parseOne("Yr bill OMR 3.500 is overdue pls pay via app - RandomBank", CTX);
  ok("unknown -> not null", !!e);
  eq("unknown -> type review", e.type, "review");
  eq("unknown -> amount still extracted", e.amount, 3500);
  ok("unknown -> raw text preserved", /overdue/.test(e.raw));
  const junk = P.parseOne("totally unrelated text no money", CTX);
  eq("junk with no amount -> review, amount 0", junk.type, "review");
  eq("junk amount", junk.amount, 0);
  ok("empty string -> null (filtered out)", P.parseOne("   ", CTX) === null);
}

/* ---------- 7. multi-message paste + dedupe ---------- */
{
  const batch = [
    "Salary OMR 644.000 Credited to your Account 26/08/2026.",
    "",
    "Dear Customer, You have sent OMR 57.000 to AHME#####MOOD from your a/c 0303XXXXXXXX0017 on 26/08/2026 19:42:00 using Mobile",
    "",
    "Card of a/c 0303XXXXXXXX0017 used for OMR 10.120 at DOMINOS MANAILAH AL KH on 26/08/2026",
  ].join("\n");
  const r = P.parseBatch(batch, CTX);
  eq("batch parses 3 entries", r.length, 3);
  eq("batch entry 1", r[0].type, "income");
  eq("batch entry 2", r[1].type, "transfer_out");
  eq("batch entry 3", r[2].type, "expense");

  // paste the same batch again -> dedupe keys identical
  const r2 = P.parseBatch(batch, CTX);
  const keys1 = r.map((e) => e.dedupeKey).sort();
  const keys2 = r2.map((e) => e.dedupeKey).sort();
  ok("re-paste produces identical dedupe keys", JSON.stringify(keys1) === JSON.stringify(keys2));
  ok("dedupe keys are unique within a batch", new Set(keys1).size === 3);
}

/* ---------- 8. counterparty masking preserved; merchant category learnable ---------- */
{
  const e = P.parseOne("Dear Customer, You have sent OMR 1.500 to X###Y from your a/c 0303XXXXXXXX0017 on 26/08/2026 08:00:00 using Mobile", CTX);
  eq("masking chars kept verbatim", e.counterparty, "X###Y");
  eq("custom rule applied", P.categorize("BIG BOXING GYM", [{ match: "BOXING", category: "fitness" }]), "fitness");
  eq("unknown merchant -> null category", P.categorize("SOME RANDOM PLACE", []), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
