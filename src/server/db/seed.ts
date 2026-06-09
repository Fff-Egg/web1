import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, pool } from "./client.js";
import { sources } from "./schema.js";
import type { NewSource } from "./schema.js";

/**
 * Initial seed sources. Both are editable/deletable from the UI.
 * Add idempotently (skip if a source with the same provider+identifier exists).
 */
const SEED: NewSource[] = [
  {
    provider: "fanding",
    fetchType: "scrape_auth",
    identifier: "https://fanding.kr/@sesang101/",
    label: "세상학개론",
    enabled: true,
    // Membership-only posts need a session; user fills in credentialRef from the UI.
    config: {},
  },
  {
    provider: "hankyung",
    fetchType: "rss",
    identifier: "https://www.hankyung.com/",
    label: "한국경제",
    enabled: true,
    config: {},
  },
];

async function main() {
  for (const seed of SEED) {
    const existing = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.provider, seed.provider), eq(sources.identifier, seed.identifier)))
      .limit(1);

    if (existing.length > 0) {
      console.log(`[seed] skip (exists): ${seed.provider} ${seed.identifier}`);
      continue;
    }
    await db.insert(sources).values(seed);
    console.log(`[seed] inserted: ${seed.provider} ${seed.identifier}`);
  }
  await pool?.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool?.end();
  process.exit(1);
});
