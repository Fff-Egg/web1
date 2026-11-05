import fs from "node:fs";
import path from "node:path";

/**
 * Stored login sessions (Playwright storageState). We persist only the
 * logged-in session cookies/localStorage — NEVER the password. Sessions are
 * keyed by source id so each authenticated source has its own login.
 *
 * The `sessions/` directory is git-ignored and must never be committed.
 */
export const SESSIONS_DIR = path.resolve(process.cwd(), "sessions");

export function sessionPath(sourceId: number): string {
  return path.join(SESSIONS_DIR, `source-${sourceId}.json`);
}

export function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function hasSession(sourceId: number): boolean {
  return fs.existsSync(sessionPath(sourceId));
}

/** Path to pass to Playwright `newContext({ storageState })`, or null if none. */
export function storageStateFor(sourceId: number): string | null {
  const p = sessionPath(sourceId);
  return fs.existsSync(p) ? p : null;
}

export function deleteSession(sourceId: number): void {
  const p = sessionPath(sourceId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
