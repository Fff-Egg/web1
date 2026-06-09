import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL;

/**
 * When DATABASE_URL is set we connect to MySQL. When it is NOT set the app
 * still boots in an in-memory dev mode (see repo/ layer) so the site is fully
 * usable without provisioning a database. This is what lets `npm run dev`
 * show a working dashboard out of the box.
 */
export const hasDb = Boolean(url);

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;

if (url) {
  _pool = mysql.createPool({ uri: url, connectionLimit: 5 });
  _db = drizzle(_pool, { schema, mode: "default" });
} else {
  console.warn(
    "[db] DATABASE_URL not set — running in in-memory dev mode (data is not persisted).",
  );
}

/** Throws if accessed without a configured DB. Use `hasDb` to guard. */
export function requireDb() {
  if (!_db) {
    throw new Error("DATABASE_URL is not set — no MySQL connection available.");
  }
  return _db;
}

export const db = _db as ReturnType<typeof drizzle>;
export const pool = _pool;
export { schema };
