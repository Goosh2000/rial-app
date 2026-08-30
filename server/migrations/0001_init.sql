-- Rial bank-sync relay — D1 schema.
-- Ciphertext-only storage. No plaintext, sender, subject, or message content
-- is ever written here — see server/src/index.js and SERVER-SETUP.md.

-- Singleton row: this relay serves exactly one device identity at a time.
-- /register creates it once; /rotate is the only way to change it afterwards.
CREATE TABLE device (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  device_token     TEXT NOT NULL,
  public_key_spki  TEXT NOT NULL,   -- base64 SPKI of the device's RSA-OAEP public key
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- One row per encrypted message. Every payload field is ciphertext/opaque.
CREATE TABLE blobs (
  id             TEXT PRIMARY KEY,
  device_token   TEXT NOT NULL,
  received_at    INTEGER NOT NULL,
  wrapped_key    TEXT NOT NULL,     -- base64 RSA-OAEP-wrapped AES-256 content key
  iv             TEXT NOT NULL,     -- base64 AES-GCM IV
  ciphertext     TEXT NOT NULL,     -- base64 AES-GCM ciphertext of the raw email
  size_bytes     INTEGER NOT NULL,  -- size of the plaintext that was encrypted, for the size cap/diagnostics only
  delivered_at   INTEGER            -- NULL until the device acks it; purged some time after
);
CREATE INDEX idx_blobs_device_token ON blobs(device_token);
CREATE INDEX idx_blobs_delivered_at ON blobs(delivered_at);
CREATE INDEX idx_blobs_received_at ON blobs(received_at);

-- Fixed-window rate limiting. bucket_key embeds a one-way hash of the client
-- IP, never the raw address.
CREATE TABLE rate_limit (
  bucket_key    TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
