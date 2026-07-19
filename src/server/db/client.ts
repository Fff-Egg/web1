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

// Bind drizzle's generics to this schema. `ReturnType<typeof drizzle>` loses
// that overload information in newer Drizzle versions and mis-types $client.
const createDb = (pool: mysql.Pool) => drizzle(pool, { schema, mode: "default" });
type Database = ReturnType<typeof createDb>;

let _db: Database | null = null;
let _pool: mysql.Pool | null = null;

if (url) {
  // Pin both sides to UTC: mysql2 serializes/parses dates as UTC (timezone:"Z")
  // and each session's time_zone is UTC, so TIMESTAMP window comparisons
  // (digest/feed date ranges) line up with the JS Date bounds we pass.
  _pool = mysql.createPool({ uri: url, connectionLimit: 5, timezone: "Z" });
  _pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  _db = createDb(_pool);
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

export const db = _db as Database;
export const pool = _pool;
export { schema };
