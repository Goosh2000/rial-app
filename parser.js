/* parser.js — Rial bank-SMS parser.
 *
 * SmsParser.parseBatch(text, ctx)  ->  Entry[]   (splits a paste into messages)
 * SmsParser.parseOne(text, ctx)    ->  Entry | null   (null only for empty input)
 *
 *   ctx = {
 *     accountLast4: string[] | Set,   // last-4s of accounts YOU own (drives transfer_internal)
 *     rules:        {match,category}[],// merchant substring -> category
 *     patterns:     Pattern[],         // editable in Settings; falls back to DEFAULT_PATTERNS
 *     now:          number,            // epoch ms, for messages with no date (testable)
 *   }
 *
 * Entry = {
 *   ok:true, matched:<patternId>, raw:<redacted original text>,
 *   type: "income"|"expense"|"transfer_internal"|"transfer_out"|"transfer_in"|"review",
 *   amount:<integer baisa>,          // OMR x 1000, never a float
 *   ymd:"YYYY-MM-DD"|null, time:"HH:MM:SS"|null, ts:<epoch ms, for sorting>,
 *   dateAssumed:boolean,
 *   merchant:string|null, counterparty:string|null, category:string|null,
 *   fromLast4:string|null, toLast4:string|null,
 *   source:string|null,
 *   dedupeKey:string,
 * }
 *
 * RULES THAT MATTER:
 *  - Amounts are OMR/3dp parsed into integer baisa via string math (no float rounding).
 *  - Dates are DD/MM/YYYY — day first, never US.
 *  - Only the LAST 4 digits of any account token are ever kept. The rest is discarded
 *    at parse time and scrubbed from the stored `raw` text too.
 *  - Unknown text is NEVER dropped: it comes back as type:"review" with the raw text.
 *  - transfer_internal detection: BOTH ends' last4 registered -> internal (nets to zero,
 *    never spending). Only source registered -> transfer_out. Only dest -> transfer_in.
 */
"use strict";

const SmsParser = (() => {

  /* --- money: string -> integer baisa (OMR x 1000), no floating point --- */
  function toBaisa(s) {
    const m = String(s).replace(/,/g, "").match(/(\d+)(?:\.(\d{1,3}))?/);
    if (!m) return 0;
    const whole = parseInt(m[1], 10);
    const frac = (m[2] || "").padEnd(3, "0").slice(0, 3);
    return whole * 1000 + parseInt(frac, 10);
  }

  /* --- dates: DD/MM/YYYY (day first) --- */
  function parseDMY(s) {
    const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d, ymd: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
  }
  function makeTs(dmy, time) {
    if (!dmy) return null;
    if (time) {
      const [hh, mm, ss] = time.split(":").map(Number);
      return new Date(dmy.y, dmy.m - 1, dmy.d, hh, mm, ss || 0).getTime();
    }
    // no time -> end of day, so it sorts last within that day
    return new Date(dmy.y, dmy.m - 1, dmy.d, 23, 59, 59).getTime();
  }

  /* --- account tokens: keep ONLY the trailing 4 digits, discard everything else --- */
  function last4(token) {
    if (token == null) return null;
    const digits = String(token).replace(/\D/g, "");   // transient; never stored
    return digits.length >= 4 ? digits.slice(-4) : null;
  }
  /* scrub masked/!masked account numbers out of free text before we store it */
  function redactAccountNumbers(text) {
    return String(text)
      // masked bank tokens: digits + X/#/* + 4 trailing digits  ->  ••••1234
      .replace(/\b[0-9]{2,}[X#*]{2,}[0-9]{4}\b/gi, (t) => "••••" + t.slice(-4))
      // any bare run of 8+ digits (a full number that slipped through) -> ••••1234
      .replace(/\b\d{8,}\b/g, (t) => "••••" + t.slice(-4));
  }

  /* --- merchant -> category --- */
  const DEFAULT_MERCHANT_RULES = [
    { match: "DOMINOS", category: "food" },
    { match: "PIZZA", category: "food" },
    { match: "KFC", category: "food" },
    { match: "MCDONALD", category: "food" },
    { match: "LULU", category: "food" },
    { match: "CARREFOUR", category: "food" },
    { match: "SPAR", category: "food" },
    { match: "NESTO", category: "food" },
    { match: "STARBUCKS", category: "food" },
    { match: "COFFEE", category: "food" },
    { match: "SUPERMARKET", category: "food" },
    { match: "PHARMACY", category: "other" },
    { match: "OOREDOO", category: "subscriptions" },
    { match: "OMANTEL", category: "subscriptions" },
    { match: "NETFLIX", category: "subscriptions" },
    { match: "SPOTIFY", category: "subscriptions" },
    { match: "SHELL", category: "transport" },
    { match: "OOMCO", category: "transport" },
    { match: "AL MAHA", category: "transport" },
    { match: "PETROL", category: "transport" },
    { match: "CAREEM", category: "transport" },
    { match: "UBER", category: "transport" },
    { match: "MARSOOL", category: "transport" },
    { match: "TALABAT", category: "food" },
    { match: "AMAZON", category: "other" },
    { match: "NOON", category: "other" },
  ];
  function categorize(merchant, rules) {
    if (!merchant) return null;
    const up = String(merchant).toUpperCase();
    for (const r of (rules || DEFAULT_MERCHANT_RULES)) {
      if (r && r.match && up.includes(String(r.match).toUpperCase())) return r.category;
    }
    return null;
  }

  /* --- transfer type from the two ends (THE critical rule) --- */
  function resolveTransferType(fromL4, toL4, ownSet) {
    const own = ownSet instanceof Set ? ownSet : new Set(ownSet || []);
    const fromMine = !!fromL4 && own.has(fromL4);
    const toMine = !!toL4 && own.has(toL4);
    if (fromMine && toMine) return "transfer_internal";  // both mine -> nets to zero, NOT spending
    if (fromMine && !toMine) return "transfer_out";       // I sent money away
    if (!fromMine && toMine) return "transfer_in";        // money arrived from elsewhere
    return "review";                                      // can't attribute either end
  }

  /* --- built-in patterns. `groups` maps a field to a capture-group index. --- */
  const DEFAULT_PATTERNS = [
    {
      id: "salary_credit",
      name: "Salary / credit to account",
      re: "^\\s*(.+?)\\s+OMR\\s+([\\d,]+\\.\\d{1,3})\\s+Credited to your Account\\s+(\\d{2}\\/\\d{2}\\/\\d{4})",
      type: "income",
      groups: { source: 1, amount: 2, date: 3 },
    },
    {
      id: "sent_to_person",
      name: "Sent to someone",
      re: "You have sent OMR\\s+([\\d,]+\\.\\d{1,3})\\s+to\\s+(.+?)\\s+from your a\\/c\\s+([0-9X#*]+)\\s+on\\s+(\\d{2}\\/\\d{2}\\/\\d{4})(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?",
      type: "transfer_out",
      groups: { amount: 1, counterparty: 2, fromAcct: 3, date: 4, time: 5 },
    },
    {
      id: "received_from_person",
      name: "Received from someone",
      re: "You have received OMR\\s+([\\d,]+\\.\\d{1,3})\\s+from\\s+(.+?)(?:\\s+on\\s+(\\d{2}\\/\\d{2}\\/\\d{4}))?(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?\\s*\\.?\\s*$",
      type: "transfer_in",
      groups: { amount: 1, counterparty: 2, date: 3, time: 4 },
    },
    {
      id: "internal_transfer",
      name: "Debited from one A/C, credited to another",
      re: "OMR\\s+([\\d,]+\\.\\d{1,3})\\s+is debited from your A\\/C\\s+([0-9X#*]+)\\s+and credited to your A\\/C\\s+([0-9X#*]+)\\s+on\\s+(\\d{2}\\/\\d{2}\\/\\d{4})(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?",
      type: "transfer_auto",   // resolved via resolveTransferType
      groups: { amount: 1, fromAcct: 2, toAcct: 3, date: 4, time: 5 },
    },
    {
      id: "card_pos",
      name: "Card / POS purchase",
      re: "Card of a\\/c\\s+([0-9X#*]+)\\s+used for OMR\\s+([\\d,]+\\.\\d{1,3})\\s+at\\s+(.+?)\\s+on\\s+(\\d{2}\\/\\d{2}\\/\\d{4})(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?",
      type: "expense",
      groups: { fromAcct: 1, amount: 2, merchant: 3, date: 4, time: 5 },
    },
  ];

  function cleanName(s) {
    return String(s || "").trim().replace(/\s+/g, " ").replace(/[.,;]+$/, "");
  }

  function dedupeKey(e) {
    const acct = e.fromLast4 || e.toLast4 || "";
    const stamp = e.ts != null ? e.ts : (e.ymd || "");
    return [e.type, e.amount, acct, stamp, cleanName(e.merchant || e.counterparty || "")].join("|");
  }

  /* --- parse a single message block --- */
  function parseOne(raw, ctx) {
    ctx = ctx || {};
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return null;

    const own = ctx.accountLast4 instanceof Set ? ctx.accountLast4 : new Set(ctx.accountLast4 || []);
    const rules = ctx.rules || DEFAULT_MERCHANT_RULES;
    const patterns = (ctx.patterns && ctx.patterns.length) ? ctx.patterns : DEFAULT_PATTERNS;
    const now = ctx.now || Date.now();
    const nowYmd = (() => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

    for (const p of patterns) {
      let re;
      try { re = new RegExp(p.re, "i"); } catch { continue; }
      const m = text.match(re);
      if (!m) continue;
      const g = p.groups || {};
      const pick = (k) => (g[k] != null && m[g[k]] != null) ? m[g[k]] : null;

      const amount = toBaisa(pick("amount") || "0");
      const dmy = pick("date") ? parseDMY(pick("date")) : null;
      const time = pick("time") || null;
      const fromLast4 = pick("fromAcct") ? last4(pick("fromAcct")) : null;
      const toLast4 = pick("toAcct") ? last4(pick("toAcct")) : null;
      const merchant = pick("merchant") ? cleanName(pick("merchant")) : null;
      const counterparty = pick("counterparty") ? cleanName(pick("counterparty")) : null;
      const source = pick("source") ? cleanName(pick("source")) : null;

      let type = p.type;
      if (type === "transfer_auto") type = resolveTransferType(fromLast4, toLast4, own);

      let category = null;
      if (type === "expense") category = categorize(merchant, rules);
      if (type === "income" && source && /salary/i.test(source)) category = "salary";

      const ymd = dmy ? dmy.ymd : nowYmd;
      const dateAssumed = !dmy;
      const ts = dmy ? makeTs(dmy, time) : new Date(now).setHours(23, 59, 59, 0);

      const entry = {
        ok: true, matched: p.id, raw: redactAccountNumbers(text),
        type, amount, ymd, time: time, ts, dateAssumed,
        merchant, counterparty,
        category: type === "income" ? (category || (source && /salary/i.test(source) ? "salary" : null)) : category,
        fromLast4, toLast4,
        source: source || (p.type === "income" ? "Salary" : null),
      };
      entry.dedupeKey = dedupeKey(entry);
      // a matched internal-looking transfer that resolved to "review" (neither end mine) still surfaces
      return entry;
    }

    // nothing matched — never drop it. Pull an amount if we can see one.
    const amt = text.match(/OMR\s+([\d,]+\.\d{1,3})/i) || text.match(/([\d,]+\.\d{3})/);
    const dmy = parseDMY(text);
    const entry = {
      ok: true, matched: "review", raw: redactAccountNumbers(text),
      type: "review",
      amount: amt ? toBaisa(amt[1]) : 0,
      ymd: dmy ? dmy.ymd : nowYmd, time: null, ts: dmy ? makeTs(dmy, null) : new Date(now).setHours(23, 59, 59, 0),
      dateAssumed: !dmy,
      merchant: null, counterparty: null, category: null,
      fromLast4: null, toLast4: null, source: null,
    };
    entry.dedupeKey = dedupeKey(entry);
    return entry;
  }

  /* --- split a paste into message blocks and parse each --- */
  function splitBlocks(text) {
    return String(text || "")
      .split(/\n\s*\n|\r\n\s*\r\n/)                 // blank line = message boundary
      .flatMap((b) => b.split(/(?=Dear Customer,)/)) // some banks concat on one line
      .map((b) => b.trim())
      .filter((b) => b.length > 3);
  }
  function parseBatch(text, ctx) {
    return splitBlocks(text).map((b) => parseOne(b, ctx)).filter(Boolean);
  }

  return {
    parseOne, parseBatch, splitBlocks,
    resolveTransferType, categorize, dedupeKey,
    toBaisa, parseDMY, makeTs, last4, redactAccountNumbers, cleanName,
    DEFAULT_PATTERNS, DEFAULT_MERCHANT_RULES,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SmsParser;
