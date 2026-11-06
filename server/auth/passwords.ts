import crypto from 'node:crypto';

/**
 * Password hashing for sign-in without an identity provider: scrypt (N=2^14, r=8, p=1) with a
 * random 16-byte salt, stored as `scrypt$N$r$p$salt$hash` (base64url).
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Checks a password. Without a stored hash it still runs scrypt, so unknown accounts take as long as wrong passwords. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored || '').split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const [n, r, p] = valid ? parts.slice(1, 4).map(Number) : [N, R, P];
  const salt = valid ? Buffer.from(parts[4], 'base64url') : crypto.randomBytes(16);
  const expected = valid ? Buffer.from(parts[5], 'base64url') : crypto.randomBytes(KEYLEN);
  if (!Number.isInteger(n) || n > 2 ** 20 || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return valid && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Counts attempts per key in a sliding window (sign-in, MCP calls). In memory: one server process. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** True when the key is at its limit (without recording anything). */
  blocked(key: string, now = Date.now()): boolean {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.limit;
  }

  /** Records an attempt. Returns false when the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
