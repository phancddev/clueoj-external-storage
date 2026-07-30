import { describe, it, expect } from 'vitest';
import { signOperatorToken, signServiceToken, verifyToken, hasScope, type Role } from '../src/auth.js';

const SECRET = 'test-secret-key-for-vitest';

describe('auth', () => {
  describe('signOperatorToken', () => {
    it('signs and verifies operator token', async () => {
      const token = await signOperatorToken(SECRET, 'admin', 'storage-admin', 3600);
      const payload = await verifyToken(token, SECRET, 'clueoj-storage-dashboard');
      expect(payload.sub).toBe('admin');
      expect(payload.role).toBe('storage-admin');
      expect(payload.kind).toBe('operator');
      expect(payload.auth_version).toBe(1);
      expect(payload.iss).toBe('clueoj-storage');
    });

    it('assigns correct scopes per role', async () => {
      const roles: Role[] = ['viewer', 'operator', 'storage-admin', 'auditor'];
      for (const role of roles) {
        const token = await signOperatorToken(SECRET, 'user', role, 60);
        const payload = await verifyToken(token, SECRET, 'clueoj-storage-dashboard');
        switch (role) {
          case 'viewer':
            expect(payload.scopes).toEqual(['read']);
            break;
          case 'operator':
            expect(payload.scopes).toEqual(['read', 'mutate']);
            break;
          case 'storage-admin':
            expect(payload.scopes).toEqual(['read', 'mutate', 'admin']);
            break;
          case 'auditor':
            expect(payload.scopes).toEqual(['read', 'audit']);
            break;
        }
      }
    });
  });

  describe('signServiceToken', () => {
    it('signs and verifies service token with audience', async () => {
      const token = await signServiceToken(SECRET, 'clueoj-service', 'clueoj-storage', ['read', 'mutate'], 300);
      const payload = await verifyToken(token, SECRET, 'clueoj-storage');
      expect(payload.sub).toBe('clueoj-service');
      expect(payload.kind).toBe('service');
      expect(payload.aud).toBe('clueoj-storage');
      expect(payload.scopes).toContain('mutate');
    });

    it('rejects wrong audience', async () => {
      const token = await signServiceToken(SECRET, 'svc', 'expected-aud', ['read'], 60);
      await expect(verifyToken(token, SECRET, 'wrong-aud')).rejects.toThrow();
    });
  });

  describe('hasScope', () => {
    it('grants access if scope present', async () => {
      const token = await signOperatorToken(SECRET, 'u', 'operator', 60);
      const payload = await verifyToken(token, SECRET, 'clueoj-storage-dashboard');
      expect(hasScope(payload, 'read')).toBe(true);
      expect(hasScope(payload, 'mutate')).toBe(true);
      expect(hasScope(payload, 'admin')).toBe(false);
    });

    it('admin scope grants all', async () => {
      const token = await signOperatorToken(SECRET, 'u', 'storage-admin', 60);
      const payload = await verifyToken(token, SECRET, 'clueoj-storage-dashboard');
      expect(hasScope(payload, 'read')).toBe(true);
      expect(hasScope(payload, 'mutate')).toBe(true);
      expect(hasScope(payload, 'admin')).toBe(true);
      expect(hasScope(payload, 'audit')).toBe(true);
    });
  });

  describe('verifyToken', () => {
    it('carries the database auth version used for immediate session revocation', async () => {
      const token = await signOperatorToken(SECRET, 'admin', 'storage-admin', 60, 'clueoj-storage-dashboard', 7);
      const payload = await verifyToken(token, SECRET, 'clueoj-storage-dashboard', 'operator');
      expect(payload.auth_version).toBe(7);
    });

    it('rejects invalid token', async () => {
      await expect(verifyToken('invalid.token.here', SECRET)).rejects.toThrow();
    });

    it('rejects wrong secret', async () => {
      const token = await signOperatorToken(SECRET, 'u', 'viewer', 60);
      await expect(verifyToken(token, 'wrong-secret', 'clueoj-storage-dashboard')).rejects.toThrow();
    });

    it('rejects expired token', async () => {
      const token = await signOperatorToken(SECRET, 'u', 'viewer', 1);
      await new Promise((r) => setTimeout(r, 1200));
      await expect(verifyToken(token, SECRET, 'clueoj-storage-dashboard')).rejects.toThrow();
    });
  });
});
