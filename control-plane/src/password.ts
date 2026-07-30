import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 128 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelization, maxmem: MAX_MEMORY },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export function normalizeUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized) ? normalized : null;
}

export function validatePassword(password: string): void {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  if (password.length > 1024) throw new Error('Password must be at most 1024 characters');
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return [
    'scrypt',
    VERSION,
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, version, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, keyRaw, extra] = encoded.split('$');
    if (algorithm !== 'scrypt' || version !== VERSION || extra !== undefined) return false;
    const cost = Number(costRaw);
    const blockSize = Number(blockSizeRaw);
    const parallelization = Number(parallelizationRaw);
    if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) return false;
    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(keyRaw, 'base64url');
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
    const actual = await deriveKey(password, salt, cost, blockSize, parallelization);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const dummySalt = Buffer.alloc(SALT_LENGTH, 0x5a);
const dummyKey = scryptSync('clueoj-dashboard-dummy-password', dummySalt, KEY_LENGTH, {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: MAX_MEMORY,
});

export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  VERSION,
  String(COST),
  String(BLOCK_SIZE),
  String(PARALLELIZATION),
  dummySalt.toString('base64url'),
  dummyKey.toString('base64url'),
].join('$');
