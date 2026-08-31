/* mime.js — Rial MIME decoder.
 *
 * MimeDecoder.decode(rawMessage) -> { text, date, messageId }
 *
 *   rawMessage: the full raw RFC822 source of one email (as relayed by Apps
 *               Script through the Worker and decrypted on-device — see
 *               BankSyncClient.syncNow() in index.html).
 *
 *   text:       the best available human-readable body — text/plain if any
 *               part has it, else text/html stripped down to text, else the
 *               raw body as a last resort. NEVER includes any header.
 *   date:       the raw `Date:` header value, or null. A fallback date
 *               source only — bank messages almost always carry their own
 *               date in-body, which SmsParser prefers.
 *   messageId:  the raw `Message-Id:` header value, or null.
 *
 * RULES THAT MATTER:
 *  - Every header except Date and Message-Id is discarded before this
 *    module returns anything — Received, Delivered-To, DKIM-Signature,
 *    boundary lines, none of it ever reaches the caller.
 *  - Walks multipart/alternative, multipart/related and multipart/mixed
 *    alike (nesting is not special-cased — every leaf part found anywhere
 *    in the tree is a candidate); prefers a text/plain leaf, falls back to
 *    text/html, ignores every non-text leaf (images, PDFs, etc.) entirely.
 *  - Decodes quoted-printable and base64 transfer encodings. Charset-aware
 *    for UTF-8 (the default) and the Latin-1-family fallbacks
 *    (iso-8859-1 / windows-1252 / us-ascii); anything else is decoded as
 *    UTF-8 best-effort.
 *  - HTML parts are stripped to text: <script>/<style>/comments removed,
 *    entities decoded, row/line-breaking tags (</tr>, </p>, </div>, <br>,
 *    heading closes) become newlines and </td> becomes a tab, so a
 *    multi-row table survives as one line per row instead of one wall of
 *    words — required for Part B's multi-transaction detection to have
 *    anything to work with.
 */
"use strict";

const MimeDecoder = (() => {

  function splitHeaders(raw) {
    const s = String(raw == null ? "" : raw);
    const idx = s.search(/\r?\n\r?\n/);
    if (idx === -1) return { headerBlock: s, body: "" };
    const m = s.slice(idx).match(/^\r?\n\r?\n/);
    return { headerBlock: s.slice(0, idx), body: s.slice(idx + m[0].length) };
  }

  /* RFC 2822 header folding: a continuation line starts with space/tab */
  function unfoldHeaders(headerBlock) {
    return String(headerBlock || "").replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  }

  function parseHeaders(headerBlock) {
    const lines = unfoldHeaders(headerBlock).split("\n").filter(Boolean);
    const headers = {};
    for (const line of lines) {
      const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
      if (!m) continue;
      const name = m[1].toLowerCase();
      headers[name] = headers[name] != null ? headers[name] + ", " + m[2] : m[2];
    }
    return headers;
  }

  function parseContentType(value) {
    if (!value) return { type: "text/plain", params: {} };
    const segs = String(value).split(";").map((s) => s.trim()).filter(Boolean);
    const type = (segs[0] || "text/plain").toLowerCase();
    const params = {};
    for (let i = 1; i < segs.length; i++) {
      const m = segs[i].match(/^([a-zA-Z0-9-]+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
      if (m) params[m[1].toLowerCase()] = (m[2] != null ? m[2] : m[3]).replace(/;$/, "");
    }
    return { type, params };
  }

  function bytesToText(bytes, charset) {
    const cs = String(charset || "utf-8").toLowerCase().replace(/"/g, "").trim();
    if (["iso-8859-1", "latin1", "windows-1252", "us-ascii", "ascii"].includes(cs)) {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return s;
    }
    try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
    catch { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return s; }
  }

  /* The caller already has this as a JS string (the whole raw email went
   * through one outer UTF-8 decode of the ciphertext-derived bytes). Both
   * quoted-printable and base64's ENCODED form are pure 7-bit ASCII, so that
   * outer decode is lossless for them — we just need to rebuild the ORIGINAL
   * byte sequence from the encoded text and decode it with the part's own
   * declared charset. */
  function decodeQuotedPrintable(text, charset) {
    const s = String(text || "").replace(/=\r?\n/g, ""); // soft line breaks
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i) & 0xff);
      }
    }
    return bytesToText(bytes, charset);
  }
  function decodeBase64(text, charset) {
    const clean = String(text || "").replace(/[^A-Za-z0-9+/=]/g, "");
    if (!clean) return "";
    let binary;
    try { binary = atob(clean); } catch { return ""; }
    const bytes = new Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytesToText(bytes, charset);
  }

  function splitMultipart(body, boundary) {
    const marker = "--" + boundary;
    const segments = String(body || "").split(marker);
    const parts = [];
    for (let i = 1; i < segments.length; i++) {
      let seg = segments[i];
      if (seg.slice(0, 2) === "--") break;              // final boundary reached
      seg = seg.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (seg.trim()) parts.push(seg);
    }
    return parts;
  }

  /* Returns every text/plain or text/html LEAF found anywhere in the tree,
   * in document order. Non-text leaves (images, PDFs, ...) are dropped
   * entirely — never decoded, never returned. */
  function walkPart(headers, body) {
    const ct = parseContentType(headers["content-type"]);
    if (ct.type.indexOf("multipart/") === 0 && ct.params.boundary) {
      let leaves = [];
      for (const raw of splitMultipart(body, ct.params.boundary)) {
        const { headerBlock, body: partBody } = splitHeaders(raw);
        leaves = leaves.concat(walkPart(parseHeaders(headerBlock), partBody));
      }
      return leaves;
    }
    if (ct.type.indexOf("text/") !== 0) return [];        // not text — ignore entirely
    const cte = String(headers["content-transfer-encoding"] || "7bit").toLowerCase().trim();
    let text;
    if (cte === "quoted-printable") text = decodeQuotedPrintable(body, ct.params.charset);
    else if (cte === "base64") text = decodeBase64(body, ct.params.charset);
    else text = body;                                     // 7bit/8bit/binary — already text
    return [{ type: ct.type, text }];
  }

  function selectBestPart(leaves) {
    return leaves.find((l) => l.type === "text/plain")
        || leaves.find((l) => l.type === "text/html")
        || leaves[0] || null;
  }

  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
    mdash: "—", ndash: "–", hellip: "…", copy: "©",
  };
  function decodeEntities(s) {
    return String(s || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (code[0] === "#") {
        const isHex = code[1] === "x" || code[1] === "X";
        const cp = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return NAMED_ENTITIES[code] !== undefined ? NAMED_ENTITIES[code] : m;
    });
  }

  function htmlToText(html) {
    let s = String(html || "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<\/(tr|p|div|li|h[1-6])>/gi, "\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/td>/gi, "\t");
    s = s.replace(/<[^>]+>/g, "");
    s = decodeEntities(s);
    s = s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, (m) => (m.includes("\t") ? "\t" : " "));
    s = s.split("\n").map((l) => l.replace(/^[ \t]+|[ \t]+$/g, "")).filter((l) => l.length).join("\n");
    return s.trim();
  }

  function decode(raw) {
    const s = String(raw == null ? "" : raw);
    const { headerBlock, body } = splitHeaders(s);
    const headers = parseHeaders(headerBlock);
    if (!Object.keys(headers).length) {
      // No line matched a "Header: value" shape at all — this isn't an
      // RFC822 message (no blank-line envelope was found either, since
      // splitHeaders would then have put everything in headerBlock). There's
      // no envelope to strip, so it's already just text.
      return { text: s.replace(/\r\n/g, "\n").trim(), date: null, messageId: null };
    }
    const leaves = walkPart(headers, body).filter((l) => l.type === "text/plain" || l.type === "text/html");
    const chosen = selectBestPart(leaves);
    let text;
    if (chosen) text = chosen.type === "text/html" ? htmlToText(chosen.text) : chosen.text.replace(/\r\n/g, "\n").trim();
    else text = String(body || "").replace(/\r\n/g, "\n").trim();   // no recognisable MIME structure at all
    return { text, date: headers["date"] || null, messageId: headers["message-id"] || null };
  }

  return { decode, htmlToText, decodeQuotedPrintable, decodeBase64, parseContentType, splitHeaders, parseHeaders };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MimeDecoder;
