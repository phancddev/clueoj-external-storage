import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';

export type Role = 'viewer' | 'operator' | 'storage-admin' | 'auditor';

export interface StorageJWTPayload extends JWTPayload {
  sub: string;
  role: Role;
  scopes: string[];
  kind: 'operator' | 'service';
  auth_version?: number;
}

const enc = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signOperatorToken(
  secret: string,
  sub: string,
  role: Role,
  ttlSeconds = 3600,
  audience = 'clueoj-storage-dashboard',
  authVersion = 1,
): Promise<string> {
  return new SignJWT({
    sub, role, scopes: operatorScopes(role), kind: 'operator', auth_version: authVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('clueoj-storage')
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc(secret));
}

export async function signServiceToken(
  secret: string,
  sub: string,
  audience: string,
  scopes: string[],
  ttlSeconds = 300,
): Promise<string> {
  return new SignJWT({ sub, role: 'storage-admin', scopes, kind: 'service' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('clueoj-storage')
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc(secret));
}

export async function verifyToken(
  token: string,
  secret: string,
  expectedAudience?: string,
  expectedKind?: StorageJWTPayload['kind'],
): Promise<StorageJWTPayload> {
  const { payload } = await jwtVerify(token, enc(secret), {
    issuer: 'clueoj-storage',
    audience: expectedAudience,
  });
  const typed = payload as unknown as StorageJWTPayload;
  if (expectedKind && typed.kind !== expectedKind) throw new Error(`Expected ${expectedKind} token`);
  return typed;
}

function operatorScopes(role: Role): string[] {
  switch (role) {
    case 'viewer': return ['read'];
    case 'operator': return ['read', 'mutate'];
    case 'storage-admin': return ['read', 'mutate', 'admin'];
    case 'auditor': return ['read', 'audit'];
  }
}

export function hasScope(payload: StorageJWTPayload, scope: string): boolean {
  return payload.scopes.includes(scope) || payload.scopes.includes('admin');
}

export function requireRole(payload: StorageJWTPayload, ...roles: Role[]): boolean {
  return roles.includes(payload.role);
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
