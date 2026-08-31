# MIME-SPEC — bank-sync MIME decoder

`mime.js` is the single source of truth. `build-mime.js` inlines it into `index.html`
between `/* MIME:START */` … `/* MIME:END */`; `test-mime.mjs` tests the module directly.
Edit `mime.js`, then run `node build-mime.js` (CI runs `--check`).

It exists because `BankSyncClient.syncNow()` (index.html) decrypts a raw RFC822 email —
Apps Script relays the whole message, not just the SMS-like alert text buried inside it —
and `SmsParser` must never see MIME headers, boundaries, or HTML source. `mime.js` runs
**before** `SmsParser` in that pipeline, on-device, on every synced message.

## API

```js
MimeDecoder.decode(rawMessage) -> { text, date, messageId }
```

- `text` — the best available human-readable body. `text/plain` if any part has one,
  else `text/html` stripped down to text, else the raw body as a last resort. Never
  contains a header line.
- `date` — the raw `Date:` header value, or `null`. A **fallback** date source only —
  `SmsParser` prefers a date it finds in the body itself; this is passed as `ctx.now`
  so an undated message still gets a real send-time instead of "whenever sync ran."
- `messageId` — the raw `Message-Id:` header value, or `null`. Carried onto each
  parsed entry (`entry.messageId`) for future dedupe use; not displayed anywhere.

If the input has no header line that matches `Header: value` at all, it's treated as
already-plain text and returned as-is (no envelope to strip) — this is what lets a
bare non-MIME string (e.g. Apps Script's `testConnection()` payload) pass through
unharmed instead of being swallowed as "an empty body."

## Hard rules

| Rule | Where |
|---|---|
| **Every header is dropped** except `Date` and `Message-Id` — Received, Delivered-To, DKIM-Signature, boundary lines, none of it ever reaches `text`. | `decode` |
| Walks `multipart/alternative`, `multipart/related`, `multipart/mixed` alike — nesting isn't special-cased, every leaf is a candidate regardless of depth. | `walkPart` |
| **Prefers `text/plain`** over `text/html` if both exist anywhere in the tree; a non-text leaf (image, PDF, ...) is dropped entirely, never decoded. | `selectBestPart` |
| Decodes `quoted-printable` (soft line breaks, `=XX` escapes) and `base64`, charset-aware for UTF-8 (default) and the Latin-1 family (`iso-8859-1` / `windows-1252` / `us-ascii`); anything else falls back to UTF-8 best-effort. | `decodeQuotedPrintable`, `decodeBase64`, `bytesToText` |
| HTML is stripped, not just tag-scrubbed: `<script>`/`<style>`/comments removed, entities decoded, `</tr>` / `</p>` / `</div>` / heading closes / `<br>` become newlines and `</td>` becomes a tab — so a multi-row table survives as one line per row, tab-separated, instead of one run-on wall of words. This is what the Phase 4 pattern learner needs to detect repeating rows. | `htmlToText` |
| Both `quoted-printable` and `base64`'s **encoded form** is pure 7-bit ASCII, so the one outer UTF-8 decode of the decrypted ciphertext (in `BankSyncClient`) is lossless up to this point — `mime.js` rebuilds the true byte sequence from the encoded text itself and decodes *that* with the part's own declared charset. | `decodeQuotedPrintable`, `decodeBase64` |

## Known limitation

A leaf part with `Content-Transfer-Encoding: 7bit`/`8bit`/none, in a charset other than
UTF-8, cannot be recovered correctly — the outer decode has already interpreted its
bytes as UTF-8 by the time `mime.js` sees them, and there is no encoded form left to
rebuild from (unlike quoted-printable/base64, whose *encoded* representation is ASCII
and survives that outer decode intact). This never affects `quoted-printable`/`base64`
parts, and virtually all modern bank mail is UTF-8 or plain ASCII either way.
