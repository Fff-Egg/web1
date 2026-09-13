import "dotenv/config";
import { and, or, eq, isNull } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { sources, articles } from "../db/schema.js";
import type { Source } from "../db/schema.js";
import { getAdapter, SessionRequiredError } from "../adapters/index.js";
import { enrichArticle } from "../adapters/fullText.js";

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
  const pending: typeof items = [];
  for (const item of items) {
    // Skip if a same-URL article already exists for this source — even if it was
    // deleted. Prevents sources with unstable feed GUIDs (some RSS bridges) from
    // re-creating (and thus resurrecting deleted) items on each collection.
    {
      const [existing] = await db
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.sourceId, source.id), or(eq(articles.externalId, item.externalId), item.url ? eq(articles.url, item.url) : undefined)))
        .limit(1);
      if (existing) continue;
    }
    // insertIgnore-style: rely on the unique index to skip duplicates
    const res = await db
      .insert(articles)
      .values({
        sourceId: source.id,
        externalId: item.externalId,
        url: item.url ?? null,
        title: item.title ?? null,
        // Save the provider body before any slow linked-page fetch. If the
        // process restarts, analysis can resume enrichment from this row.
        body: item.body ?? null,
        sourceBody: item.body ?? null,
        contentMeta: { version: 1, status: "unknown", method: "feed", pending: true,
          checkedAt: new Date().toISOString(), links: [], sourceUrls: item.linkedUrls },
        author: item.author ?? null,
        publishedAt: item.publishedAt ?? null,
      })
      .onDuplicateKeyUpdate({ set: { sourceId: source.id } }); // no-op touch
    // mysql2 returns affectedRows: 1 for insert, 2 for update, 0 for unchanged dup
    if (res[0].affectedRows === 1) {
      inserted++;
      pending.push(item);
    }
  }
  // Persist the whole fetched batch (including hidden/expanded links) before
  // any slow enrichment; cursor-based sources can then resume from the DB.
  for (const item of pending) {
    const enriched = await enrichArticle(item, source);
    await db.update(articles).set({ body: enriched.body ?? null, contentMeta: enriched.contentMeta, readingCache: null })
      .where(and(eq(articles.sourceId, source.id), eq(articles.externalId, item.externalId), isNull(articles.deletedAt)));
  }
  return inserted;
}

export async function handleSourceError(source: Source, err: unknown): Promise<void> {
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
