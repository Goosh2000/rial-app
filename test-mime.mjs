/* test-mime.mjs — fixture tests for mime.js, using synthetic MIME messages
   only (never a real bank email). Run: node test-mime.mjs */
import M from "./mime.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("  FAIL " + n + (extra ? "  -> " + extra : ""))); };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const CRLF = (s) => s.replace(/\n/g, "\r\n");

/* ---------- 1. plain text, no encoding, no explicit multipart ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Received: by 2002:a05:6402:1234::1 with SMTP id abc123csp999
Date: Mon, 31 Aug 2026 09:15:00 +0400
From: Bank Alerts <alerts@examplebank.test>
To: nationer123@gmail.com
Subject: Transaction Alert
Message-Id: <plain-msg-1@examplebank.test>
DKIM-Signature: v=1; a=rsa-sha256; d=examplebank.test; s=sel1; h=from:to; bh=abc=; b=xyz=
Content-Type: text/plain; charset="UTF-8"

Card of a/c XXXXXX1234 used for OMR 12.500 at SYNTHETIC SHOP on 31/08/2026 09:15:00`
  );
  const d = M.decode(raw);
  eq("F1 plain: extracted text", d.text, "Card of a/c XXXXXX1234 used for OMR 12.500 at SYNTHETIC SHOP on 31/08/2026 09:15:00");
  eq("F1 plain: Date header captured", d.date, "Mon, 31 Aug 2026 09:15:00 +0400");
  eq("F1 plain: Message-Id captured", d.messageId, "<plain-msg-1@examplebank.test>");
  ok("F1 plain: no Delivered-To leaked", !/Delivered-To/i.test(d.text));
  ok("F1 plain: no Received leaked", !/Received:/i.test(d.text));
  ok("F1 plain: no DKIM leaked", !/DKIM/i.test(d.text));
  ok("F1 plain: no Subject header leaked", !/Subject:/i.test(d.text));
}

/* ---------- 2. quoted-printable, HTML only, with a soft line break and an escaped '=' ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Received: by mail.example with ESMTP id qp1
Date: Mon, 31 Aug 2026 10:00:00 +0400
Message-Id: <qp-msg-1@examplebank.test>
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<html><body><p>Card of a/c XXXXXX5678 used for OMR 21.500 at TEST SH=
OP=3DMAIN BRANCH on 31/08/2026</p></body></html>`
  );
  const d = M.decode(raw);
  eq("F2 quoted-printable HTML: soft break stitched + '=3D' decoded", d.text,
    "Card of a/c XXXXXX5678 used for OMR 21.500 at TEST SHOP=MAIN BRANCH on 31/08/2026");
  ok("F2: no Received leaked", !/Received:/i.test(d.text));
  ok("F2: no HTML tags leaked", !/<[a-z]/i.test(d.text));
}

/* ---------- 3. multipart/alternative — plain preferred over html ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Date: Mon, 31 Aug 2026 11:00:00 +0400
Message-Id: <alt-msg-1@examplebank.test>
Content-Type: multipart/alternative; boundary="BOUNDARY1"

--BOUNDARY1
Content-Type: text/plain; charset="UTF-8"

Salary OMR 644.000 Credited to your Account 31/08/2026.
--BOUNDARY1
Content-Type: text/html; charset="UTF-8"

<html><body><p>Salary <b>OMR 644.000</b> Credited to your Account 31/08/2026.</p></body></html>
--BOUNDARY1--
`
  );
  const d = M.decode(raw);
  eq("F3 multipart/alternative: prefers text/plain verbatim (not the HTML rendering)", d.text,
    "Salary OMR 644.000 Credited to your Account 31/08/2026.");
  ok("F3: no <b> tag leaked (proves it didn't fall through to the HTML part)", !d.text.includes("<b>"));
}

/* ---------- 4. base64-encoded plain text part ---------- */
{
  const original = "You have received OMR 2.030 from SYNTHETIC SENDER on 31/08/2026 10:00:00";
  const b64 = Buffer.from(original, "utf8").toString("base64");
  // wrap at 60 chars like a real MTA would, to prove line-wrapping doesn't matter
  const wrapped = b64.match(/.{1,60}/g).join("\r\n");
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Date: Mon, 31 Aug 2026 12:00:00 +0400
Message-Id: <b64-msg-1@examplebank.test>
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: base64

`) + wrapped + "\r\n";
  const d = M.decode(raw);
  eq("F4 base64: decodes to the exact original text", d.text, original);
}

/* ---------- 5. nested multipart/mixed > multipart/related > (html + inline image) ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Date: Mon, 31 Aug 2026 13:00:00 +0400
Message-Id: <nested-msg-1@examplebank.test>
Content-Type: multipart/mixed; boundary="OUTER"

--OUTER
Content-Type: multipart/related; boundary="INNER"

--INNER
Content-Type: text/html; charset="UTF-8"

<html><body><p>Card of a/c XXXXXX9012 used for OMR 8.750 at NESTED SHOP on 31/08/2026</p></body></html>
--INNER
Content-Type: image/png
Content-Transfer-Encoding: base64

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=
--INNER--

--OUTER--
`
  );
  const d = M.decode(raw);
  eq("F5 nested multipart: extracts the HTML part's text", d.text,
    "Card of a/c XXXXXX9012 used for OMR 8.750 at NESTED SHOP on 31/08/2026");
  ok("F5: the inline image's base64 garbage never leaks into the text", !d.text.includes("iVBORw0KGgo"));
}

/* ---------- 6. a multi-row HTML table stays one row per line for Part B ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Date: Mon, 31 Aug 2026 14:00:00 +0400
Message-Id: <table-msg-1@examplebank.test>
Content-Type: text/html; charset="UTF-8"

<html><body><table>
<tr><td>31/08/2026</td><td>OMR 5.000</td><td>SHOP A</td></tr>
<tr><td>30/08/2026</td><td>OMR 9.250</td><td>SHOP B</td></tr>
</table></body></html>`
  );
  const d = M.decode(raw);
  const lines = d.text.split("\n");
  eq("F6 table: two rows survive as two lines", lines.length, 2);
  ok("F6 table: row 1 has tab-separated cells", lines[0] === "31/08/2026\tOMR 5.000\tSHOP A");
  ok("F6 table: row 2 has tab-separated cells", lines[1] === "30/08/2026\tOMR 9.250\tSHOP B");
}

/* ---------- 7. missing Content-Type header entirely (legacy plain mail) ---------- */
{
  const raw = CRLF(
`Delivered-To: nationer123@gmail.com
Date: Mon, 31 Aug 2026 15:00:00 +0400

Card of a/c XXXXXX3456 used for OMR 3.000 at LEGACY SHOP on 31/08/2026`
  );
  const d = M.decode(raw);
  eq("F7 no Content-Type header: defaults to plain text, still works", d.text,
    "Card of a/c XXXXXX3456 used for OMR 3.000 at LEGACY SHOP on 31/08/2026");
  eq("F7: no Message-Id header -> null", d.messageId, null);
}

/* ---------- done ---------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
