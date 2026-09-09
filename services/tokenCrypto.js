// Field-level encryption for long-lived credentials that must be stored
// reversibly (unlike passwords, which are one-way bcrypt hashes elsewhere in
// this app). Introduced for the Google Calendar integration's refresh token
// (2026-08-02) — the first such use case in this codebase.
//
// AES-256-GCM: a random 12-byte IV per encryption call, plus the GCM auth tag,
// are stored alongside the ciphertext (none of these are secret on their own —
// only the key, from GOOGLE_TOKEN_ENCRYPTION_KEY, needs to stay confidential).
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY is not set — cannot encrypt/decrypt stored tokens.');
  }
  // Accept either a 64-char hex string or a base64 string, as long as it
  // decodes to exactly 32 bytes (AES-256's key size).
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64).');
  }
  return key;
}

// Returns "iv:authTag:ciphertext", each hex-encoded.
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = String(payload).split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted payload — expected "iv:authTag:ciphertext".');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
