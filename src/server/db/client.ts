import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and configure your MySQL connection.",
  );
}

// A small pool is plenty for the workers + API server in this app.
export const pool = mysql.createPool({
  uri: url,
  connectionLimit: 5,
  // dates come back as strings unless we keep them native; drizzle handles mapping
});

export const db = drizzle(pool, { schema, mode: "default" });
export type DB = typeof db;
export { schema };
