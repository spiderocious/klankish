import { describe, expect, it } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generateRefreshToken,
  hashPassword,
  hashToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './crypto.js';

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('Correct Horse Battery Staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'Correct Horse Battery Staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces a different hash each time (unique salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same')).toBe(true);
    expect(await verifyPassword(b, 'same')).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // Must read as "wrong password", never as a 500 that flags an interesting account.
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('', 'x')).toBe(false);
  });
});

describe('access tokens', () => {
  it('signs and verifies, preserving claims', async () => {
    const token = await signAccessToken({ userId: 'u_1', role: 'admin', sessionId: 'ss_1' });
    const claims = await verifyAccessToken(token);
    expect(claims?.sub).toBe('u_1');
    expect(claims?.role).toBe('admin');
    expect(claims?.sid).toBe('ss_1');
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({ userId: 'u_1', role: 'user', sessionId: 'ss_1' });
    const [h, p, s] = token.split('.');
    // Flip the payload to claim super_admin; the signature must no longer verify.
    const forged = `${h}.${Buffer.from('{"sub":"u_1","role":"super_admin","sid":"ss_1"}').toString('base64url')}.${s}`;
    expect(await verifyAccessToken(forged)).toBe(null);
    expect(await verifyAccessToken(`${token}x`)).toBe(null);
    expect(await verifyAccessToken('garbage')).toBe(null);
  });
});

describe('refresh tokens and api keys', () => {
  it('generates unique opaque refresh tokens', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateRefreshToken()));
    expect(seen.size).toBe(500);
  });

  it('hashes tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toHaveLength(64);
  });

  it('builds an api key whose prefix is embedded in the key', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix.startsWith('klk_')).toBe(true);
    expect(hash).toBe(hashToken(key));
  });
});

describe('safeEqual', () => {
  it('compares correctly regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false); // must not throw on length mismatch
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('secret encryption', () => {
  it('round-trips', () => {
    const plain = 'sk_live_verysecret_value_123';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('uses a fresh IV each time, so identical plaintexts differ', () => {
    // IV reuse under GCM is catastrophic, so this is the property worth asserting.
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('refuses to decrypt tampered ciphertext', () => {
    // The whole reason for GCM over CBC: tampering fails loudly instead of yielding garbage
    // that then gets sent to someone else's API.
    const enc = encryptSecret('original');
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('refuses to decrypt with a wrong auth tag', () => {
    const enc = encryptSecret('original');
    const badTag = { ...enc, authTag: Buffer.alloc(16, 1) };
    expect(() => decryptSecret(badTag)).toThrow();
  });

  it('handles unicode and long values', () => {
    const emoji = 'passwörd-🔐-日本語';
    expect(decryptSecret(encryptSecret(emoji))).toBe(emoji);
    const long = 'x'.repeat(10_000);
    expect(decryptSecret(encryptSecret(long))).toBe(long);
  });
});
