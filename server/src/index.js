/* Rial bank-sync relay — Cloudflare Worker.
 *
 * This Worker does no parsing and no inspection. It encrypts whatever
 * /ingest receives to the registered device's public key and stores
 * ciphertext only. It never logs a request body, header value, or any
 * value derived from one — including in error paths — so every catch
 * block below returns a bare, generic error with nothing interpolated
 * from the request.
 *
 * Endpoints:
 *   POST /register  — create the (single) device identity. First call wins;
 *                      a second call is rejected — use /rotate instead.
 *   POST /rotate     — replace the device token and/or public key. Requires
 *                      the CURRENT device token as a Bearer credential.
 *   POST /ingest     — Apps Script → here. Requires the X-Ingest-Secret
 *                      header. Encrypts the body to the device's public key
 *                      and stores the ciphertext row.
 *   GET  /blobs      — the device pulls undelivered ciphertext rows.
 *                      Requires the device token as a Bearer credential.
 *   POST /ack        — the device marks rows delivered by id. Requires the
 *                      device token as a Bearer credential.
 *   POST /unregister — deletes the device identity AND every blob row for
 *                      it. Requires the device token as a Bearer credential.
 *                      This is what a Settings "disable and delete
 *                      everything" action calls.
 *
 * Two independent secrets exist by design: INGEST_SECRET (only Apps Script
 * ever holds it) and the device token (only Rial ever holds it). Neither
 * endpoint accepts the other's credential, so compromising one does not
 * grant the other. See SERVER-SETUP.md for the full threat model.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Ingest-Secret",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...corsHeaders(env) } });
}
function empty(env, status) {
  return new Response(null, { status, headers: corsHeaders(env) });
}

/* Constant-time-ish string compare — avoids a trivial early-exit timing
 * signal on shared secrets. Not a cryptographic primitive, just cheap
 * insurance for a single-user service. */
function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a || "");
  const eb = new TextEncoder().encode(b || "");
  const len = Math.max(ea.length, eb.length, 32);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function sha256B64(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToB64(new Uint8Array(digest));
}

/* Fixed-window counter in D1. Keyed on a one-way hash of the client IP —
 * the raw address is never persisted. */
async function rateLimited(env, bucket, ip, limit, windowSeconds) {
  const key = bucket + ":" + (await sha256B64(ip || "unknown"));
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limit WHERE bucket_key = ?").bind(key).first();
  if (!row || row.window_start !== windowStart) {
    await env.DB.prepare(
      "INSERT INTO rate_limit (bucket_key, window_start, count) VALUES (?, ?, 1) " +
      "ON CONFLICT(bucket_key) DO UPDATE SET window_start = excluded.window_start, count = 1"
    ).bind(key, windowStart).run();
    return false;
  }
  if (row.count >= limit) return true;
  await env.DB.prepare("UPDATE rate_limit SET count = count + 1 WHERE bucket_key = ?").bind(key).run();
  return false;
}

async function getDevice(env) {
  return await env.DB.prepare("SELECT * FROM device WHERE id = 1").first();
}
function bearerToken(request) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") || "");
  return m ? m[1] : null;
}

/* Reads the body without trusting Content-Length alone, and without ever
 * echoing its contents anywhere (including in the rejection path). */
async function readCappedBody(request, maxBytes) {
  const len = request.headers.get("content-length");
  if (len && Number(len) > maxBytes) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  return buf;
}

async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(env, { error: "bad_request" }, 400); }
  const { deviceToken, publicKeySpki } = body || {};
  if (typeof deviceToken !== "string" || !deviceToken || typeof publicKeySpki !== "string" || !publicKeySpki) {
    return json(env, { error: "bad_request" }, 400);
  }
  if (await getDevice(env)) return json(env, { error: "already_registered" }, 409);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO device (id, device_token, public_key_spki, created_at, updated_at) VALUES (1, ?, ?, ?, ?)"
  ).bind(deviceToken, publicKeySpki, now, now).run();
  return json(env, { ok: true }, 201);
}

async function handleRotate(request, env) {
  const token = bearerToken(request);
  const existing = await getDevice(env);
  if (!existing || !token || !timingSafeEqual(token, existing.device_token)) {
    return json(env, { error: "unauthorized" }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json(env, { error: "bad_request" }, 400); }
  const { newDeviceToken, newPublicKeySpki } = body || {};
  if (!newDeviceToken && !newPublicKeySpki) return json(env, { error: "bad_request" }, 400);
  const nextToken = typeof newDeviceToken === "string" && newDeviceToken ? newDeviceToken : existing.device_token;
  const nextKey = typeof newPublicKeySpki === "string" && newPublicKeySpki ? newPublicKeySpki : existing.public_key_spki;
  await env.DB.prepare("UPDATE device SET device_token = ?, public_key_spki = ?, updated_at = ? WHERE id = 1")
    .bind(nextToken, nextKey, Date.now()).run();
  return json(env, { ok: true });
}

async function handleIngest(request, env, ip) {
  const secretHeader = request.headers.get("X-Ingest-Secret") || "";
  if (!env.INGEST_SECRET || !timingSafeEqual(secretHeader, env.INGEST_SECRET)) {
    return json(env, { error: "unauthorized" }, 401);
  }
  if (await rateLimited(env, "ingest", ip, Number(env.INGEST_RATE_LIMIT), Number(env.INGEST_RATE_WINDOW_SECONDS))) {
    return json(env, { error: "rate_limited" }, 429);
  }
  const device = await getDevice(env);
  if (!device) return json(env, { error: "no_device_registered" }, 503);

  const raw = await readCappedBody(request, Number(env.MAX_BODY_BYTES));
  if (raw === null) return json(env, { error: "too_large" }, 413);
  if (raw.byteLength === 0) return json(env, { error: "bad_request" }, 400);

  try {
    const publicKey = await crypto.subtle.importKey(
      "spki", b64ToBytes(device.public_key_spki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
    );
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, raw));
    const rawAesKey = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));
    const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey));

    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO blobs (id, device_token, received_at, wrapped_key, iv, ciphertext, size_bytes, delivered_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
    ).bind(id, device.device_token, Date.now(), bytesToB64(wrappedKey), bytesToB64(iv), bytesToB64(ciphertext), raw.byteLength).run();

    return json(env, { ok: true, id }, 201);
  } catch {
    return json(env, { error: "encrypt_failed" }, 500);
  }
}

async function handleBlobs(request, env) {
  const token = bearerToken(request);
  const device = await getDevice(env);
  if (!device || !token || !timingSafeEqual(token, device.device_token)) {
    return json(env, { error: "unauthorized" }, 401);
  }
  const { results } = await env.DB.prepare(
    "SELECT id, received_at, wrapped_key, iv, ciphertext, size_bytes FROM blobs " +
    "WHERE device_token = ? AND delivered_at IS NULL ORDER BY received_at ASC LIMIT 200"
  ).bind(device.device_token).all();
  return json(env, {
    blobs: results.map((r) => ({
      id: r.id, receivedAt: r.received_at, wrappedKey: r.wrapped_key, iv: r.iv, ciphertext: r.ciphertext, sizeBytes: r.size_bytes,
    })),
  });
}

async function handleAck(request, env) {
  const token = bearerToken(request);
  const device = await getDevice(env);
  if (!device || !token || !timingSafeEqual(token, device.device_token)) {
    return json(env, { error: "unauthorized" }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json(env, { error: "bad_request" }, 400); }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 200) : [];
  if (!ids.length) return json(env, { error: "bad_request" }, 400);
  const now = Date.now();
  const stmt = env.DB.prepare("UPDATE blobs SET delivered_at = ? WHERE id = ? AND device_token = ?");
  await env.DB.batch(ids.map((id) => stmt.bind(now, id, device.device_token)));
  return json(env, { ok: true });
}

async function handleUnregister(request, env) {
  const token = bearerToken(request);
  const device = await getDevice(env);
  if (!device || !token || !timingSafeEqual(token, device.device_token)) {
    return json(env, { error: "unauthorized" }, 401);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blobs WHERE device_token = ?").bind(device.device_token),
    env.DB.prepare("DELETE FROM device WHERE id = 1"),
  ]);
  return json(env, { ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return empty(env, 204);
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "";

    try {
      if (url.pathname === "/register" && request.method === "POST") {
        if (await rateLimited(env, "register", ip, Number(env.REGISTER_RATE_LIMIT), Number(env.REGISTER_RATE_WINDOW_SECONDS))) {
          return json(env, { error: "rate_limited" }, 429);
        }
        return await handleRegister(request, env);
      }
      if (url.pathname === "/rotate" && request.method === "POST") return await handleRotate(request, env);
      if (url.pathname === "/ingest" && request.method === "POST") return await handleIngest(request, env, ip);
      if (url.pathname === "/blobs" && request.method === "GET") return await handleBlobs(request, env);
      if (url.pathname === "/ack" && request.method === "POST") return await handleAck(request, env);
      if (url.pathname === "/unregister" && request.method === "POST") return await handleUnregister(request, env);
      return json(env, { error: "not_found" }, 404);
    } catch {
      // Never log here: an exception can originate from parsing attacker-
      // or user-supplied input, and error messages can echo fragments of it.
      return json(env, { error: "internal_error" }, 500);
    }
  },

  async scheduled(_event, env) {
    const now = Date.now();
    const deliveredCutoff = now - Number(env.DELIVERED_GRACE_SECONDS) * 1000;
    const undeliveredCutoff = now - Number(env.UNDELIVERED_MAX_AGE_SECONDS) * 1000;
    await env.DB.prepare("DELETE FROM blobs WHERE delivered_at IS NOT NULL AND delivered_at < ?").bind(deliveredCutoff).run();
    await env.DB.prepare("DELETE FROM blobs WHERE delivered_at IS NULL AND received_at < ?").bind(undeliveredCutoff).run();
    await env.DB.prepare("DELETE FROM rate_limit WHERE window_start < ?").bind(Math.floor(now / 1000) - 3600).run();
  },
};
