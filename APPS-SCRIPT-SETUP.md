# Bank-sync relay — Gmail pickup (Phase 3B)

This sets up a Google Apps Script that watches one Gmail label and relays each
message in it to the Worker from `SERVER-SETUP.md`. Do this **last** — after
you've deployed the Worker (Phase 2) and registered your device from inside
Rial itself (Settings → Automatic import → Register this device), so there's
somewhere for these messages to actually go.

Everything below is written for someone who has never touched Apps Script.
Steps marked **YOU DO THIS** are interactive — a browser UI, or output only
you can see.

---

## 1. Create the Gmail label and filter — **YOU DO THIS**

1. Open Gmail → the gear icon → **See all settings** → **Filters and Blocked Addresses**.
2. **Create a new filter.** Set whatever criteria actually match your bank's
   alerts (sender address, subject keywords — you know your own bank's
   sender, this guide won't ask you for it).
3. Click **Create filter**, then check **Apply the label:** and choose
   **New label…** → name it exactly `Rial`.
4. Click **Create filter**.

From now on, matching mail gets the `Rial` label automatically. The script
below only ever looks at threads carrying that one label — never your inbox,
never any other label. (Section 6 has you test this safely before pointing
the filter at your real bank.)

---

## 2. Create the Apps Script project — **YOU DO THIS**

1. Go to <https://script.google.com> and sign in with the same Google account
   as the Gmail you just labelled.
2. Click **New project**.
3. Rename it (top left, "Untitled project") to something like `Rial bank sync`.
4. Delete the placeholder code in the editor (the default `myFunction(){}`).
5. Open `apps-script/Code.gs` from this repo, copy its entire contents, and
   paste it into the editor.
6. Click the save icon (or Ctrl+S / Cmd+S).

---

## 3. Set the two Script Properties — **YOU DO THIS**

The script reads its Worker URL and shared secret from Script Properties —
never from the code itself, so they're never at risk of ending up in a repo
or a copy-paste of the script.

1. In the editor's left sidebar, click **Project Settings** (the gear icon).
2. Scroll to **Script Properties** → **Add script property**.
3. Add two properties:
   - `WORKER_URL` → your Worker's URL from `SERVER-SETUP.md` step 5, e.g.
     `https://rial-relay.<your-subdomain>.workers.dev` (no trailing slash).
   - `INGEST_SECRET` → the exact same value you gave to
     `wrangler secret put INGEST_SECRET` in `SERVER-SETUP.md` step 4.
4. Click **Save script properties**.

---

## 4. Authorize the script — **YOU DO THIS**

1. Back in the editor, use the function dropdown (next to "Run" / "Debug") and
   select **testConnection**.
2. Click **Run**. Google will ask you to authorize the script.

### About the "Google hasn't verified this app" warning

You'll see a screen saying Google hasn't verified this app, with a scary-looking
**Advanced** link to get past it. This is completely normal and expected for a
personal script you wrote yourself that hasn't gone through Google's formal
review process (which is meant for apps published to the public, not
single-user scripts) — it is **not** a sign anything is wrong.

To proceed:
1. Click **Advanced** (bottom left of the warning).
2. Click **Go to Rial bank sync (unsafe)** — "unsafe" here just means
   "unreviewed by Google," not that anything is actually wrong.
3. Review the permissions screen. It will ask for **broad** Gmail access
   (something like "Read, compose, and send emails from your Gmail account") —
   this is the only permission level Apps Script's Gmail integration offers;
   there's no way to grant a script "read just this one label" at the Google
   account level. The narrowing happens entirely in `Code.gs`'s own logic —
   every Gmail call in it is scoped to the `Rial` label via
   `GmailApp.search('label:"Rial" ...')`, which you can read yourself; nothing
   stops you from verifying this before trusting it with your account.
4. Click **Allow**.

---

## 5. Test safely — before any real bank mail — **YOU DO THIS**

Do these two checks in order. Neither one touches real bank mail.

### a. Confirm the Worker connection

With `testConnection` still selected in the function dropdown, click **Run**
again if you haven't already. Then **View → Logs** (or Ctrl+Enter). You should
see:
```
OK — the Worker accepted a test message (HTTP 201). Wiring is correct.
```
If instead it says it couldn't reach the Worker, or the Worker rejected the
message, re-check the two Script Properties from step 3 — the exact URL and
the exact secret.

### b. Confirm the label pickup with an ordinary email — not bank mail

1. Pick any harmless email already in your inbox (a newsletter, a receipt from
   an online order — anything that is **not** a real bank alert).
2. Manually apply the `Rial` label to it.
3. In the editor, select **processRialMessages** from the function dropdown
   and click **Run**.
4. **View → Logs** — you should see a line like
   `Rial sync: 1 thread(s) sent (1 message(s)), 0 thread(s) had a failure...`
5. Confirm a blob actually landed on the server:
   ```
   npx wrangler d1 execute rial-relay-db --remote --command "SELECT COUNT(*) as c FROM blobs;"
   ```
   (run from `server/` — should show at least 1).
6. **Remove the `Rial` label** from that test email in Gmail (it'll have also
   picked up a `Rial/Sent` label — remove that too, or just leave it, it's
   harmless). This was only ever a wiring test; it doesn't need to stay
   labelled.

Only once both checks pass should you point the filter from step 1 at your
actual bank's sender address.

---

## 6. Create the time-driven trigger

**Option A — one function call (recommended):** select **createTrigger** from
the function dropdown and click **Run** once. **View → Logs** should confirm
`Trigger created: processRialMessages will run every 10 minutes.` It's safe to
re-run this later — it replaces any trigger it previously made rather than
stacking duplicates.

**Option B — by hand:**
1. Left sidebar → the alarm-clock icon (**Triggers**).
2. **Add Trigger** (bottom right).
3. Function: `processRialMessages`. Deployment: `Head`. Event source:
   **Time-driven**. Type: **Minutes timer**. Every: **10 minutes**.
4. **Save**.

Either way, from now on the script checks for new `Rial`-labelled mail every
10 minutes on its own — you don't need the editor open.

---

## Quotas, batching, and partial failures

- Each run fetches at most 50 threads and stops early if it's been running
  for 5 minutes, to stay well inside Apps Script's 6-minute execution limit —
  whatever it didn't get to is simply left unlabelled, so the next run's
  search picks it up automatically. Nothing is lost, just deferred.
- A thread is only labelled `Rial/Sent` once **every** message in it got a 2xx
  response from the Worker. If a message doesn't (network hiccup, the Worker
  is briefly down, quota exceeded, whatever), that thread stays unlabelled
  and is retried whole on the next run.
- **Known edge case:** the Worker rejects any single message over 256&nbsp;KB
  (`MAX_BODY_BYTES` in `server/wrangler.toml`) rather than truncating it. An
  oversized message will fail every single retry forever until you either
  raise that limit and redeploy the Worker, or manually apply `Rial/Sent` to
  its thread yourself to stop the retries.
- At every-10-minutes, that's roughly 144 runs/day — each run when there's
  nothing new is one quick Gmail search and no `UrlFetchApp` calls at all, far
  under any Apps Script quota.

## Logging

`processRialMessages` and `testConnection` only ever log **counts and HTTP
status codes** — thread counts, message counts, response codes. Neither this
script nor the Worker it talks to ever logs a subject, sender, or message
body. You can verify this yourself: every `Logger.log(...)` call in
`Code.gs` is a short, literal audit away.

## Honest note on exposure

Gmail already holds these emails in plaintext — that's what Gmail is. Running
this script adds **no new exposure at Google's end**: it reads mail Google
already had, using an API Google already offers. What changes is everything
downstream of Gmail: the Worker this script talks to never sees plaintext,
never sees the sender, never sees the subject — only ciphertext, from the
moment `/ingest` receives it (see `SERVER-SETUP.md`'s threat model).

## Revoking access / deleting this entirely

- **Revoke Gmail access without deleting the script:** go to
  <https://myaccount.google.com/permissions>, find "Rial bank sync" (or
  whatever you named it), and remove access.
- **Delete the trigger** (stop it running, keep the code): Triggers icon in
  the editor → the three-dot menu next to the trigger → **Delete trigger**.
- **Delete the whole project:** in the editor, **Project Settings** → scroll
  down → **Delete project** (or from <https://script.google.com>, the three-dot
  menu next to the project in your project list → **Remove**).
- None of this touches the `Rial` / `Rial/Sent` Gmail labels or the mail
  under them — remove those separately in Gmail if you want them gone too.
- To also tear down the server side, see `SERVER-SETUP.md`'s teardown section.
