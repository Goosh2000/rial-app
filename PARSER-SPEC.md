# PARSER-SPEC — bank-SMS parser

`parser.js` is the single source of truth. `build-parser.js` inlines it into `index.html`
between `/* PARSER:START */` … `/* PARSER:END */`; `test-parser.mjs` tests the module directly.
Edit `parser.js`, then run `node build-parser.js` (CI runs `--check`).

## API

```js
SmsParser.parseBatch(text, ctx) -> Entry[]     // splits a paste into messages, parses each
SmsParser.parseOne(text, ctx)   -> Entry|null  // null ONLY for empty input
```

```js
ctx = {
  accountLast4: string[] | Set,      // last-4s of accounts YOU own — drives transfer_internal
  rules:        {match, category}[], // merchant substring -> category (falls back to DEFAULT_MERCHANT_RULES)
  patterns:     Pattern[],           // editable in Settings › SMS formats (falls back to DEFAULT_PATTERNS)
  now:          number,              // epoch ms, used for messages with no date (keeps tests deterministic)
}
```

```js
Entry = {
  ok: true, matched: <patternId | "review">, raw: <original text, account numbers redacted>,
  type: "income" | "expense" | "transfer_internal" | "transfer_out" | "transfer_in" | "review",
  amount: <integer baisa>,            // OMR × 1000, never a float
  ymd: "YYYY-MM-DD" | null, time: "HH:MM:SS" | null, ts: <epoch ms, for sorting>,
  dateAssumed: boolean,               // true when the SMS carried no date and `now` was used
  merchant: string|null, counterparty: string|null, category: string|null,
  fromLast4: string|null, toLast4: string|null, source: string|null,
  dedupeKey: string,
}
```

## Hard rules

| Rule | Where |
|---|---|
| **Amounts** are OMR/3dp → integer **baisa** via string math (`whole×1000 + frac`), never `parseFloat`. | `toBaisa` |
| **Dates** are `DD/MM/YYYY` — **day first**, never US. Month > 12 is rejected. | `parseDMY` |
| **Only the last 4 digits** of any account token are ever kept. The rest is discarded at parse time and the masked/bare number is scrubbed from the stored `raw` text (`••••1234`). | `last4`, `redactAccountNumbers` |
| No time on a message → `ts` is set to 23:59:59 that day, so it **sorts last** within the day. | `makeTs` |
| Counterparty masking characters (`#`, `X`, `*`) are kept **verbatim** for display. | `cleanName` (only trims trailing punctuation/space) |
| **Unknown text is never dropped** — it returns `type: "review"` with the raw text and any amount that could be extracted. | `parseOne` tail |
| **Dedupe:** `type | amount | last4 | ts | name`. The app stores this as `importKey`; re-pasting the same batch imports nothing. | `dedupeKey` |
| Every parsed entry goes to the **review screen** before saving — the parser never commits anything. | `index.html` `openReview` |

## The transfer-type rule (highest-risk logic)

`resolveTransferType(fromLast4, toLast4, ownSet)`:

| source last4 | dest last4 | result |
|---|---|---|
| mine | mine | `transfer_internal` — nets to zero, **never** spending, never touches an envelope or Safe-to-Spend, shown muted as "Moved" |
| mine | not mine / absent | `transfer_out` — real money leaving (a real expense) |
| not mine | mine | `transfer_in` — real money arriving (real income) |
| neither | neither | `review` — can't attribute either end |

A pattern with `type: "transfer_auto"` is resolved through this function; every other pattern
carries a fixed `type`. Unit-tested for all four branches plus "the internal-transfer SMS, but
I only registered the source account → `transfer_out`".

## Pattern format

`DEFAULT_PATTERNS` (and the editable copy in Settings) is an array of:

```js
{
  id: "card_pos",
  name: "Card / POS purchase",
  re: "Card of a\\/c\\s+([0-9X#*]+)\\s+used for OMR\\s+([\\d,]+\\.\\d{1,3})\\s+at\\s+(.+?)\\s+on\\s+(\\d{2}\\/\\d{2}\\/\\d{4})(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?",
  type: "expense",                 // income | expense | transfer_out | transfer_in | transfer_auto
  groups: { fromAcct: 1, amount: 2, merchant: 3, date: 4, time: 5 },
}
```

`re` is a regex **source string** (compiled case-insensitive). `groups` maps a field name to a
capture-group index; recognised fields: `amount`, `date`, `time`, `merchant`, `counterparty`,
`fromAcct`, `toAcct`, `source`. A pattern whose regex fails to compile is skipped, not fatal.

### The 5 built-in patterns

| id | matches | type |
|---|---|---|
| `salary_credit` | `… OMR 644.000 Credited to your Account 26/08/2026.` | `income` (category `salary`) |
| `sent_to_person` | `You have sent OMR 57.000 to AHME#####MOOD from your a/c …0017 on 26/08/2026 19:42:00` | `transfer_out` |
| `received_from_person` | `You have received OMR 2.030 from AHMED ALI` | `transfer_in` |
| `internal_transfer` | `OMR 420.000 is debited from your A/C …0017 and credited to your A/C …0033 on …` | `transfer_auto` → resolved |
| `card_pos` | `Card of a/c …0017 used for OMR 10.120 at DOMINOS MANAILAH AL KH on 26/08/2026` | `expense` |

## Merchant → category

`categorize(merchant, rules)` returns the `category` of the first rule whose `match` substring
(case-insensitive) appears in the merchant string, else `null`. When the user re-categorises a
reviewed row they're offered "Remember MERCHANT → category", which appends a rule to
`merchantRules` (in Settings and in the backup export).
