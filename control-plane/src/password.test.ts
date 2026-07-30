import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_HASH, hashPassword, normalizeUsername, validatePassword, verifyPassword,
} from './password.js';

describe('dashboard password security', () => {
  it('hashes with a random salt and verifies only the matching password', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).not.toBe(second);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
  });

  it('fails closed for malformed or unsupported hashes', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$v2$1$1$1$bad$bad')).resolves.toBe(false);
  });

  it('provides a valid dummy hash for constant-cost unknown-user checks', async () => {
    await expect(verifyPassword('not-the-dummy-password', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('normalizes usernames and rejects unsafe names', () => {
    expect(normalizeUsername(' Admin.User ')).toBe('admin.user');
    expect(normalizeUsername('../admin')).toBeNull();
    expect(normalizeUsername('ab')).toBeNull();
  });

  it('enforces password length limits', () => {
    expect(() => validatePassword('short')).toThrow(/at least 12/);
    expect(() => validatePassword('a'.repeat(12))).not.toThrow();
    expect(() => validatePassword('a'.repeat(1025))).toThrow(/at most 1024/);
  });
});
