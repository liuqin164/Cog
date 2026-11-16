/**
 * The observatory's soul-write token (#283).
 *
 * The token lives beside the memory database at `<dataDir>/observatory-token`, mode 0600, and is
 * minted once by the installer. It is the second lock behind the loopback and Host checks: a web
 * page the owner visits cannot read it, so it cannot forge a soul save even if it reaches the port.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OBSERVATORY_TOKEN_FILE = 'observatory-token';
export const OBSERVATORY_TOKEN_HEADER = 'x-observatory-token';

export function observatoryTokenPath(dataDir: string): string {
  return join(dataDir, OBSERVATORY_TOKEN_FILE);
}

function readTokenFile(path: string): string | undefined {
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** The token already on disk, or undefined for an install that predates it. */
export function readObservatoryToken(dataDir: string): string | undefined {
  return readTokenFile(observatoryTokenPath(dataDir));
}

/** Mint the token once. A re-run keeps the existing one: the page may already hold it. */
export function ensureObservatoryToken(dataDir: string): string {
  const path = observatoryTokenPath(dataDir);
  const existing = readTokenFile(path);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = readTokenFile(path);
      if (raced) return raced;
    }
    throw error;
  }
}

export function observatoryTokensMatch(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
