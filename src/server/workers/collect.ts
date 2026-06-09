import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { sources, articles } from "../db/schema.js";
import type { Source } from "../db/schema.js";
import { getAdapter, SessionRequiredError } from "../adapters/index.js";

/**
 * Collection worker. Iterates every enabled source, resolves the adapter for
 * its provider, fetches normalized articles, and upserts them into `articles`
 * (the (source_id, external_id) unique constraint dedupes).
 *
 * Runs as a one-shot via `npm run worker:collect`, or on an interval from the
 * server (see src/server/index.ts).
 */
export async function collectAll(): Promise<{ inserted: number; errors: number }> {
  if (!hasDb) {
    console.warn("[collect] no DATABASE_URL — skipping (in-memory dev mode).");
    return { inserted: 0, errors: 0 };
  }
  const enabled = await db.select().from(sources).where(eq(sources.enabled, true));
  let inserted = 0;
  let errors = 0;

  for (const source of enabled) {
    try {
      inserted += await collectSource(source);
      await db
        .update(sources)
        .set({ lastFetchedAt: new Date(), lastError: null })
        .where(eq(sources.id, source.id));
    } catch (err) {
      errors++;
      await handleSourceError(source, err);
    }
  }

  return { inserted, errors };
}

export async function collectSource(source: Source): Promise<number> {
  const adapter = getAdapter(source.provider);
  if (!adapter) {
    throw new Error(`No adapter for provider "${source.provider}"`);
  }

  const items = await adapter.fetch(source);
  if (items.length === 0) return 0;

  let inserted = 0;
  for (const item of items) {
    // insertIgnore-style: rely on the unique index to skip duplicates
    const res = await db
      .insert(articles)
      .values({
        sourceId: source.id,
        externalId: item.externalId,
        url: item.url ?? null,
        title: item.title ?? null,
        body: item.body ?? null,
        author: item.author ?? null,
        publishedAt: item.publishedAt ?? null,
      })
      .onDuplicateKeyUpdate({ set: { sourceId: source.id } }); // no-op touch
    // mysql2 returns affectedRows: 1 for insert, 2 for update, 0 for unchanged dup
    const affected = (res as unknown as { rowsAffected?: number }[])[0]?.rowsAffected;
    if (affected === 1) inserted++;
  }
  return inserted;
}

async function handleSourceError(source: Source, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[collect] source ${source.id} (${source.provider}) failed:`, message);

  const patch: Partial<Source> = { lastError: message };
  if (err instanceof SessionRequiredError) {
    // Auth expired/missing — flag the session, don't auto re-login.
    patch.sessionStatus = "expired";
  }
  await db.update(sources).set(patch).where(eq(sources.id, source.id));
}

// Allow running directly: `npm run worker:collect`
if (import.meta.url === `file://${process.argv[1]}`) {
  collectAll()
    .then((r) => {
      console.log(`[collect] done: inserted=${r.inserted} errors=${r.errors}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
