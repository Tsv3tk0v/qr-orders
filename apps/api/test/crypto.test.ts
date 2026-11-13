import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  base32Decode, base32Encode, decrypt, encrypt, hashPassword, totpCode, verifyPassword, verifyTotp,
} from '../src/auth/crypto';

describe('крипто', () => {
  it('TOTP по RFC 6238 (тестов вектор)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('base32 в двете посоки', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('кодът не важи два пъти, прозорец ±1', () => {
    const s = base32Encode(randomBytes(20));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(s, totpCode(s, step), null, now)).toBe(step);
    expect(verifyTotp(s, totpCode(s, step), step, now)).toBeNull();
    expect(verifyTotp(s, totpCode(s, step + 1), step, now)).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, step + 2), null, now)).toBeNull();
    expect(verifyTotp(s, 'abcdef', null, now)).toBeNull();
  });

  it('криптиране и пароли', async () => {
    const key = randomBytes(32);
    expect(decrypt(encrypt('тайна', key), key)).toBe('тайна');
    expect(() => decrypt(encrypt('тайна', key), randomBytes(32))).toThrow();
    const h = await hashPassword('дълга-парола-1');
    expect(await verifyPassword('дълга-парола-1', h)).toBe(true);
    expect(await verifyPassword('друга', h)).toBe(false);
  });
});
