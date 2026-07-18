import crypto from 'crypto';
import { config } from './config';

// ============================================================
// OPTIONAL at-rest encryption for tenant tokens (P2-12).
// AES-256-GCM with ENCRYPTION_KEY (32 bytes: 64 hex chars or base64).
// If ENCRYPTION_KEY is unset, encrypt/decrypt pass values through
// unchanged so existing plaintext setups keep working.
//
// Ciphertext format: enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>
// decrypt() passes through anything not in that format, so a DB with
// a mix of plaintext and encrypted tokens still works.
//
// ⚠️ Losing ENCRYPTION_KEY makes every encrypted token permanently
// unreadable — see README before enabling.
// ============================================================

const PREFIX = 'enc:v1:';

function loadKey(): Buffer | null {
  const raw = config.encryptionKey;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  console.error('[crypto] ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64) — encryption DISABLED');
  return null;
}

const key = loadKey();

export function encryptionEnabled(): boolean {
  return key !== null;
}

export function encrypt(plaintext: string): string {
  if (!key || !plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored; // plaintext passthrough
  if (!key) {
    console.error('[crypto] found encrypted value but ENCRYPTION_KEY is unset — cannot decrypt');
    return stored;
  }
  try {
    const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto] decrypt failed (wrong key?)', e);
    return stored;
  }
}
