import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

/**
 * Applies the generated SQL migrations in ./drizzle to the database.
 * Run after `npm run db:generate`.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const connection = await mysql.createConnection(url);
  const db = drizzle(connection);
  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
