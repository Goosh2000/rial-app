# Bank-sync relay — server setup (Phase 2)

This sets up the free Cloudflare Worker + D1 database that Rial's bank-sync feature
(Settings → Bank sync, Phase 1) will eventually talk to. **It does no parsing.** It
receives whatever Apps Script (Phase 3) sends to `/ingest`, encrypts it to your
device's public key, and stores ciphertext only. It has no domain, no email routing,
and costs nothing on Cloudflare's free tier.

Everything below runs from `server/` inside this repo. Steps marked **YOU RUN THIS**
are interactive — a browser window opens, or output only you can see is produced —
and cannot be done for you.

---

## 0. Prerequisites

- Node.js (already installed, since you're running this repo's own tooling).
- A free Cloudflare account. If you don't have one: go to
  <https://dash.cloudflare.com/sign-up> — no credit card is required for the Workers
  Free plan or D1's free tier.

Nothing here needs a domain. You'll get a `*.workers.dev` URL.

---

## 1. Log in to Cloudflare — **YOU RUN THIS**

```
cd "C:\Users\Windows 10 Pro\projects\rial-app\server"
npx wrangler login
```

This opens a browser tab asking you to authorize Wrangler (Cloudflare's CLI) against
your Cloudflare account. Approve it, then come back to the terminal — it'll print
"Successfully logged in."

Verify:
```
npx wrangler whoami
```

---

## 2. Create the D1 database — **YOU RUN THIS**

```
npx wrangler d1 create rial-relay-db
```

This prints a block that includes a `database_id` (a UUID), e.g.:

```
[[d1_databases]]
binding = "DB"
database_name = "rial-relay-db"
database_id = "5f2a1e3c-....-...."
```

Open `server/wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the
`database_id` value you were just given. This is not a secret — it's fine to commit.

---

## 3. Apply the schema

```
npx wrangler d1 execute rial-relay-db --remote --file=./migrations/0001_init.sql
```

This creates three tables on the real (remote) database: `device` (your single
device identity — public key + token), `blobs` (ciphertext rows), and `rate_limit`
(abuse protection bookkeeping). None of them can hold plaintext, a sender, or a
subject line — see `server/src/index.js` for what's actually written to each column.

---

## 4. Set the ingest shared secret — **YOU RUN THIS**

This is the credential Apps Script (Phase 3) will use to prove a request to
`/ingest` is really coming from your Gmail automation, and it is a **separate**
credential from your device's own token — stealing one must never grant the other.

A secret was generated for you and shown separately in the conversation that asked
for this setup — **it is not in this file or anywhere in the repo.** Copy it now,
then run:

```
npx wrangler secret put INGEST_SECRET
```

Wrangler will prompt:
```
Enter a secret value:
```
Paste the value and press Enter. It's stored encrypted in Cloudflare, injected into
the Worker as `env.INGEST_SECRET` at runtime, and never appears in your source tree,
your shell history (Wrangler reads it from the hidden prompt, not a CLI argument), or
any log this Worker writes.

If you ever need to change it later, just run `wrangler secret put INGEST_SECRET`
again with a new value — the old one stops working immediately, and you'll need to
update Apps Script's Script Property to match (Phase 3).

---

## 5. Deploy — **YOU RUN THIS**

```
npx wrangler deploy
```

The last line of output is your live Worker URL:
```
https://rial-relay.<your-subdomain>.workers.dev
```

`<your-subdomain>` is assigned by Cloudflare to your account and can't be predicted
ahead of time — that's why this doc can't just print the final URL for you. Save it;
Phase 3's Apps Script setup will need it.

---

## 6. Verify it's actually working

These use throwaway, invented data — never real bank content — just to prove the
pipe is encrypting and storing correctly, and that the two secrets really are
independent. Run from `server/`, with `YOUR_URL` replaced by the URL from step 5 and
`YOUR_INGEST_SECRET` replaced by the value from step 4:

**a. `/ingest` refuses a request with no secret:**
```
curl -i -X POST YOUR_URL/ingest -d "test"
```
Expect `401`.

**b. Register a throwaway device identity** (this is *not* Rial's real key — just
enough to prove the pipeline end-to-end before Rial itself is wired up to call this
in a later phase):
```
node -e "
const c = require('crypto').webcrypto;
(async () => {
  const kp = await c.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}, false, ['encrypt','decrypt']);
  const spki = Buffer.from(await c.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  const token = c.getRandomValues(new Uint8Array(32));
  console.log(JSON.stringify({ deviceToken: Buffer.from(token).toString('base64url'), publicKeySpki: spki }));
})();
" > device.json
type device.json
```
Then:
```
curl -i -X POST YOUR_URL/register -H "content-type: application/json" -d "@device.json"
```
Expect `201`. Running it a second time should now give `409` (a device already
exists — this is intentional; see the threat model below).

**c. Send a synthetic "bank email" through `/ingest`:**
```
curl -i -X POST YOUR_URL/ingest -H "X-Ingest-Secret: YOUR_INGEST_SECRET" -d "Card of a/c XXXXXX1234 used for OMR 12.500 at TEST MERCHANT on 30/08/2026 14:22:10"
```
Expect `201` with an `id`.

**d. Confirm the stored row is unreadable ciphertext, then decrypt it locally** the
same way Rial's client will:
```
node -e "
const c = require('crypto').webcrypto;
const dev = require('./device.json');
(async () => {
  const res = await fetch('YOUR_URL/blobs', { headers: { Authorization: 'Bearer ' + dev.deviceToken } });
  const { blobs } = await res.json();
  const row = blobs[0];
  console.log('stored row (should be unreadable):', JSON.stringify(row).slice(0, 200));
})();
"
```
The printed row must not contain the words 'TEST MERCHANT', '12.500', or the account
digits anywhere — only base64 ciphertext. Delete `device.json` once you're done
(`del device.json`); it holds a throwaway private key that never leaves this step.

Clean up the throwaway registration when you're done testing, so Rial's real key can
register later:
```
npx wrangler d1 execute rial-relay-db --remote --command "DELETE FROM device; DELETE FROM blobs;"
```

---

## Threat model — what this server can and can't see

- **Cloudflare can see:** that a request arrived at your Worker, its size, its
  timestamp, and your account's own usage metrics. It cannot see the email content —
  the Worker encrypts it before the first `INSERT`.
- **Google already sees** the bank emails, because they're sitting in your Gmail —
  this relay adds no new exposure there. What it changes is that **nothing readable
  ever leaves Gmail**: Apps Script (Phase 3) sends the raw text to this Worker, which
  encrypts it immediately.
- **Neither can see:** anything stored in the `blobs` table. `wrapped_key`, `iv`, and
  `ciphertext` are opaque without your device's private key, which is
  non-extractable and never leaves your device (Phase 1).
- **If you lose your device:** undelivered blobs become permanently unreadable —
  there is no server-side recovery, by design. (Phase 1's Settings UI already warns
  about this for the local key; the same applies here once the pipeline is live.)
- **Two independent secrets:** `INGEST_SECRET` (Apps Script → `/ingest`) and the
  device token (Rial → `/blobs`, `/ack`, `/rotate`, `/unregister`). A leaked ingest
  secret lets an attacker submit garbage ciphertext blobs (annoying, and rate-limited)
  but not read or redirect anything, since the Worker still only ever encrypts to
  whichever public key is already on file. A leaked device token lets an attacker
  read/ack blobs, rotate the identity, or even unregister it — exactly as sensitive
  as it sounds, which is why it's generated on-device, never in a backup, and
  rotatable independently of the key (Settings → Automatic import → Rotate token).
- **First `/register`** has no credential to check against (there's nothing to
  compare yet) — it's "whoever calls it first, wins," protected only by your
  `*.workers.dev` URL being unpublished and unguessable until you deploy and use it.
  Register promptly after deploying, and treat `/rotate` (which *does* require the
  current token) as the real ongoing protection afterward.

## Turning it off / deleting everything

Day to day, use Rial itself: Settings → Automatic import → **Disable and delete
everything** calls `/unregister`, which deletes the device row and every blob for it
in one step, then clears the key/token locally. Your transactions are never touched.

To tear down the Cloudflare side entirely instead:
```
npx wrangler delete                          # deletes the Worker
npx wrangler d1 delete rial-relay-db         # deletes the database and every row in it
```
Both ask for interactive confirmation. You can also do either from the Cloudflare
dashboard (Workers & Pages / D1) if you'd rather click through it.

## What's built so far

Phase 2 (this doc) is the server. Phase 3A wired Rial's own Settings screen
(Automatic import) to call `/register`, `/blobs`, `/ack`, `/rotate`, and
`/unregister` — sync runs on app open and via a "Sync now" button, decrypts on
device, and drops results into the same review queue as a pasted SMS. Nothing is
auto-applied yet. Apps Script (Phase 3B, `APPS-SCRIPT-SETUP.md`) is what actually
feeds real bank emails into `/ingest` — set that up last, only after you've
registered your device from within Rial.
