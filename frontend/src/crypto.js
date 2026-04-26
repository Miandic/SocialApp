/**
 * E2EE layer — all cryptographic operations for Diffract.
 *
 * Key scheme:
 *   Identity key pair: X25519 (ECDH)
 *   Message encryption: AES-256-GCM
 *   Key derivation: HKDF-SHA-256
 *
 * Session keys (one per remote device) are cached in memory and persisted
 * in IndexedDB so they survive page reloads without hitting the server again.
 *
 * Persistence layout (IndexedDB "diffract-crypto", store "keys"):
 *   "identity"  → { publicKeyJwk, privateKeyJwk }
 *   "device_id" → string UUID
 *   "session:<remote_device_id>" → base64-encoded 32-byte shared secret
 */

// ─── IndexedDB bootstrap ──────────────────────────────────────────────────────

const DB_NAME = "diffract-crypto";
const DB_VERSION = 1;
const STORE = "keys";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => {
      if (req.error?.name === "VersionError") {
        // Stale DB from a previous schema — wipe and start fresh.
        // The user will need to re-register their device.
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = () => openDb().then(resolve, reject);
        del.onerror = () => reject(del.error);
      } else {
        reject(req.error);
      }
    };
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

export function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

export function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

// ─── Key generation ───────────────────────────────────────────────────────────

async function generateX25519KeyPair() {
  return crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
}

async function exportPublicKeyBase64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufToBase64(raw);
}

async function keyPairToJwk(keyPair) {
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", keyPair.publicKey),
    crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  return { publicKeyJwk, privateKeyJwk };
}

async function jwkToKeyPair(jwks) {
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.importKey("jwk", jwks.publicKeyJwk, { name: "X25519" }, true, []),
    crypto.subtle.importKey("jwk", jwks.privateKeyJwk, { name: "X25519" }, true, [
      "deriveKey",
      "deriveBits",
    ]),
  ]);
  return { publicKey, privateKey };
}

// ─── HKDF key derivation ──────────────────────────────────────────────────────

async function deriveSessionKey(sharedSecretBuf, info = "diffract-msg-v1") {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecretBuf,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// ─── Device identity (singleton per browser) ─────────────────────────────────

let _identityKeyPair = null;

/**
 * Load the identity key pair from IndexedDB, or generate a new one.
 */
export async function loadOrCreateIdentityKeys() {
  const stored = await dbGet("identity");
  if (stored) {
    _identityKeyPair = await jwkToKeyPair(stored);
  } else {
    _identityKeyPair = await generateX25519KeyPair();
    await dbSet("identity", await keyPairToJwk(_identityKeyPair));
  }
  return _identityKeyPair;
}

export async function getIdentityPublicKeyBase64() {
  if (!_identityKeyPair) await loadOrCreateIdentityKeys();
  return exportPublicKeyBase64(_identityKeyPair.publicKey);
}

/** Clear all stored keys — called on logout. */
export async function clearCryptoState() {
  _identityKeyPair = null;
  _sessionCache.clear();

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Pre-key generation (for X3DH / Signal protocol pre-key bundles) ─────────

/**
 * Generate a signed pre-key and 10 one-time pre-keys.
 * Returns everything the server needs in the key bundle.
 *
 * Note: In Phase 1 we generate X25519 keys for pre-keys but use a placeholder
 * signature (SHA-256 of the public key bytes) since Ed25519 signing is not
 * in WebCrypto Level 1.  Full Ed25519 support can be added via a WASM shim.
 */
export async function generatePreKeys() {
  const signedPreKeyPair = await generateX25519KeyPair();
  const signedPreKeyRaw = await crypto.subtle.exportKey("raw", signedPreKeyPair.publicKey);

  // Placeholder signature: SHA-256(public_key_bytes) encoded as base64
  const sigBuf = await crypto.subtle.digest("SHA-256", signedPreKeyRaw);
  const signedPreKey = bufToBase64(signedPreKeyRaw);
  const signedPreKeySignature = bufToBase64(sigBuf);

  // Store signed pre-key private key so we can decrypt messages using it
  const spkJwk = await keyPairToJwk(signedPreKeyPair);
  await dbSet("signed_pre_key", spkJwk);

  // One-time pre-keys: generate and store all private keys
  const otpks = [];
  for (let i = 0; i < 10; i++) {
    const kp = await generateX25519KeyPair();
    const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const pub = bufToBase64(raw);
    const jwk = await keyPairToJwk(kp);
    await dbSet(`otpk:${pub}`, jwk);
    otpks.push(pub);
  }

  return { signedPreKey, signedPreKeySignature, oneTimePreKeys: otpks };
}

// ─── Session management ───────────────────────────────────────────────────────

// In-memory session key cache: remoteDeviceId → CryptoKey (AES-256-GCM)
const _sessionCache = new Map();

/** Derive (or load) an AES session key for a remote device. */
async function getOrDeriveSessionKey(remoteDeviceId, remoteIdentityKeyBase64) {
  if (_sessionCache.has(remoteDeviceId)) {
    return _sessionCache.get(remoteDeviceId);
  }

  // Try to load from IndexedDB
  const stored = await dbGet(`session:${remoteDeviceId}`);
  if (stored) {
    const keyBuf = base64ToBuf(stored);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      keyBuf,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    _sessionCache.set(remoteDeviceId, aesKey);
    return aesKey;
  }

  // No existing session — derive via ECDH
  if (!remoteIdentityKeyBase64) {
    throw new Error(`No session for device ${remoteDeviceId} and no public key supplied`);
  }

  if (!_identityKeyPair) await loadOrCreateIdentityKeys();

  const remoteKeyBuf = base64ToBuf(remoteIdentityKeyBase64);
  const remotePublicKey = await crypto.subtle.importKey(
    "raw",
    remoteKeyBuf,
    { name: "X25519" },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: remotePublicKey },
    _identityKeyPair.privateKey,
    256
  );

  const aesKey = await deriveSessionKey(sharedBits);

  // Persist the raw AES key material so we can reconstruct it next session
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);
  await dbSet(`session:${remoteDeviceId}`, bufToBase64(rawAes));

  _sessionCache.set(remoteDeviceId, aesKey);
  return aesKey;
}

// ─── Message encryption / decryption ─────────────────────────────────────────

/**
 * Encrypt `plaintext` for each recipient device in `keyBundles`.
 *
 * @param {string} plaintext
 * @param {Array<{device_id, identity_key}>} keyBundles
 * @returns {Array<{device_id, encrypted_content, nonce}>}
 */
export async function encryptForDevices(plaintext, keyBundles) {
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const results = [];

  for (const bundle of keyBundles) {
    const sessionKey = await getOrDeriveSessionKey(
      bundle.device_id,
      bundle.identity_key
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sessionKey,
      plaintextBytes
    );

    results.push({
      device_id: bundle.device_id,
      encrypted_content: bufToBase64(cipherBuf),
      nonce: bufToBase64(iv),
    });
  }

  return results;
}

/**
 * Decrypt a message received for this device.
 *
 * @param {string} encryptedContentBase64
 * @param {string} nonceBase64
 * @param {string} senderDeviceId
 * @param {string} senderIdentityKeyBase64  — required on first message from a device
 * @returns {string} plaintext
 */
export async function decryptMessage(
  encryptedContentBase64,
  nonceBase64,
  senderDeviceId,
  senderIdentityKeyBase64
) {
  const sessionKey = await getOrDeriveSessionKey(
    senderDeviceId,
    senderIdentityKeyBase64
  );

  const iv = new Uint8Array(base64ToBuf(nonceBase64));
  const cipherBuf = base64ToBuf(encryptedContentBase64);

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    sessionKey,
    cipherBuf
  );

  return new TextDecoder().decode(plainBuf);
}

/**
 * Pre-load a session key from a key bundle (call this when fetching key bundles,
 * so the first send is not delayed by ECDH).
 */
export async function preloadSession(deviceId, identityKeyBase64) {
  await getOrDeriveSessionKey(deviceId, identityKeyBase64);
}

// ─── Recovery code export / import ───────────────────────────────────────────

/**
 * Export the current identity key pair + device_id as a base64-encoded JSON blob.
 *
 * Why include device_id:
 *   Message ciphertexts are stored in `message_device_ciphertexts` keyed by
 *   device_id. When a new device imports this code and re-registers, it gets a
 *   different device_id. By keeping the old device_id we can still pass it to the
 *   REST API (`?device_id=<old>`) and retrieve the correct ciphertexts.
 *
 * ECDH commutativity guarantees that any session derived as ECDH(priv, B.pub)
 * on the old device produces the same key on the new device (same priv), so
 * decryption will succeed once sessions are re-derived from bundle fetches.
 */
export async function exportIdentityKey() {
  if (!_identityKeyPair) await loadOrCreateIdentityKeys();
  const jwks = await keyPairToJwk(_identityKeyPair);
  const deviceId = await dbGet("device_id");
  return btoa(JSON.stringify({ ...jwks, deviceId: deviceId || null }));
}

/**
 * Import a previously exported identity key, replacing the current one.
 * The `deviceId` embedded in the code is stored as `history_device_id` so the
 * app can fetch old message ciphertexts from the server.
 */
export async function importIdentityKey(base64) {
  const parsed = JSON.parse(atob(base64));
  // Destructure deviceId from the payload; the rest is the JWK key pair.
  const { deviceId, ...jwks } = parsed;
  const keyPair = await jwkToKeyPair(jwks);

  // Persist and activate new identity
  await dbSet("identity", jwks);
  _identityKeyPair = keyPair;

  // Preserve the old device_id under a separate key so history fetches work.
  if (deviceId) await dbSet("history_device_id", deviceId);

  // Clear ALL other derived state (sessions, current device_id, history snapshot).
  // initializeDevice will re-register with the restored identity key.
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const keep = new Set(["identity", "history_device_id"]);
      if (!keep.has(cursor.key)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  _sessionCache.clear();
}

/**
 * Generate a brand-new identity key pair, replacing the old one.
 * Wipes all derived state (sessions, device_id, history_device_id, history snapshot)
 * so the caller can re-register with the new key.
 *
 * After calling this the app MUST revoke all existing server-side devices and
 * call initializeDevice() to register the new key, otherwise old devices will
 * still appear in bundle fetches and senders may encrypt for them.
 */
export async function regenerateIdentityKey() {
  _identityKeyPair = await generateX25519KeyPair();
  await dbSet("identity", await keyPairToJwk(_identityKeyPair));

  // Wipe every other entry — sessions, device ids, history snapshot, pre-keys.
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.key !== "identity") cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  _sessionCache.clear();
}

/**
 * Return a short human-readable fingerprint of the current identity public key.
 * Uses the first 16 characters of the base64url-encoded raw public key (X25519 "x" field).
 * Distinct keys will produce visibly different fingerprints.
 */
export async function getKeyFingerprint() {
  if (!_identityKeyPair) await loadOrCreateIdentityKeys();
  const jwk = await crypto.subtle.exportKey("jwk", _identityKeyPair.publicKey);
  return jwk.x.slice(0, 16);
}

/** Load the stored history device_id (set after importing a recovery code). */
export async function loadHistoryDeviceId() {
  return dbGet("history_device_id");
}

/**
 * Store a decrypted history snapshot from a device-to-device sync.
 *
 * Format: `{ version: 1, chats: { [chatId]: [ {id, sender_id, sender_username,
 *   content, message_type, created_at} ] } }`
 */
export async function storeHistorySnapshot(snapshot) {
  await dbSet("history_snapshot", snapshot);
}

/** Load the history snapshot written by showHistoryDownloadBanner. */
export async function loadHistorySnapshot() {
  return dbGet("history_snapshot");
}

// ─── Device identity storage helpers ─────────────────────────────────────────

export async function storeDeviceId(deviceId) {
  await dbSet("device_id", deviceId);
}

export async function loadDeviceId() {
  return dbGet("device_id");
}

/**
 * Return a human-readable device name based on the user agent.
 */
export function getDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "macOS Browser";
  if (/Windows/.test(ua)) return "Windows Browser";
  if (/Linux/.test(ua)) return "Linux Browser";
  return "Browser";
}
