import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import argon2 from 'argon2';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { env } from './env.js';

/**
 * Password hashing, token signing, and secret encryption.
 *
 * All the cryptographic choices live here so they can be reviewed in one place rather than
 * rediscovered across a dozen files.
 */

// ---------------------------------------------------------------------------
// Passwords — argon2id
// ---------------------------------------------------------------------------

/**
 * OWASP 2024 baseline: argon2id, 19 MiB, 2 iterations, 1 degree of parallelism.
 *
 * argon2id rather than bcrypt because it is memory-hard: a GPU or ASIC attacker gains far less
 * than against bcrypt's small fixed memory footprint.
 */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a 500 that tells an
    // attacker they found an interesting account.
    return false;
  }
}

/**
 * A dummy verification, run when no user matched.
 *
 * Without it, a request for a non-existent email returns in ~1ms while a real one takes ~50ms,
 * and that difference alone enumerates your user base. This burns equivalent time.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$J7rMfVBs1yCVh5vJxvVh6vXhxNKfWQkxmVxbsqFWKfo';

export async function burnPasswordTime(): Promise<void> {
  try {
    await argon2.verify(DUMMY_HASH, 'not-the-password');
  } catch {
    // Expected to fail — the point is the elapsed time, not the result.
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const accessKey = encoder.encode(env.JWT_SECRET);

export interface AccessTokenClaims extends JWTPayload {
  readonly sub: string;
  readonly role: string;
  /** Session id, so an access token can be tied to the session that issued it. */
  readonly sid: string;
}

export async function signAccessToken(claims: {
  userId: string;
  role: string;
  sessionId: string;
}): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_S}s`)
    .setJti(randomBytes(12).toString('hex'))
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { algorithms: ['HS256'] });
    const sub = payload.sub;
    const role = payload['role'];
    const sid = payload['sid'];
    if (typeof sub !== 'string' || typeof role !== 'string' || typeof sid !== 'string') {
      return null;
    }
    return { ...payload, sub, role, sid };
  } catch {
    // Expired, tampered, wrong algorithm — all indistinguishable to the caller by design.
    return null;
  }
}

/**
 * Refresh tokens are opaque random bytes, not JWTs.
 *
 * A JWT refresh token cannot be revoked without a denylist, which is a session table by another
 * name. Since rotation-with-reuse-detection needs server state anyway, an opaque token is simpler
 * and leaks nothing if logged.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, not argon2, for tokens.
 *
 * Correct here because a 256-bit random token has no guessable structure — there is nothing for a
 * slow hash to protect against, and refresh happens often enough that argon2's cost would be felt.
 * Passwords are the opposite case, which is why they use argon2 above.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  const prefix = `klk_${randomBytes(4).toString('hex')}`;
  const key = `${prefix}_${secret}`;
  return { key, prefix, hash: hashToken(key) };
}

/** Constant-time comparison, for anywhere a secret is compared (HMAC signatures, tokens). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length. Compare hashes of
  // both so the inputs are always the same size.
  if (bufA.length !== bufB.length) {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    timingSafeEqual(ha, hb);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Secret encryption — AES-256-GCM
// ---------------------------------------------------------------------------

/**
 * GCM rather than CBC: it is authenticated, so a tampered ciphertext fails to decrypt instead of
 * silently producing garbage that then gets sent to someone's API.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM standard
const CURRENT_KEY_VERSION = 1;

function deriveKey(secret: string): Buffer {
  // The configured key may be base64 (the documented form) or an arbitrary passphrase. Hashing to
  // exactly 32 bytes accepts both without a footgun about key length.
  return createHash('sha256').update(secret).digest();
}

const encryptionKey = deriveKey(env.ENCRYPTION_KEY);

export interface EncryptedValue {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

export function encryptSecret(plaintext: string): EncryptedValue {
  // A fresh random IV per encryption. Reusing an IV under GCM is catastrophic — it leaks the
  // XOR of two plaintexts and breaks authentication entirely.
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

/**
 * Decrypt. Throws on a wrong key or tampered ciphertext — deliberately, because continuing with a
 * corrupt secret would send garbage to someone's API.
 */
export function decryptSecret(value: EncryptedValue): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
}

export { CURRENT_KEY_VERSION };

/** HMAC-SHA256 hex signature, for outbound webhooks. */
export function hmacSign(payload: string, secret: string): string {
  return createHash('sha256').update(`${secret}.${payload}`).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
