import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { PROVIDERS, FETCH_TYPES, sources } from "../../db/schema.js";
import { listProviders } from "../../adapters/index.js";
import { PROVIDER_LIST, PROVIDER_PRESETS } from "../../../shared/providers.js";
import { sourcesRepo } from "../../repo/sources.js";
import { db, hasDb } from "../../db/client.js";
import { hasSession } from "../../auth/session.js";
import { collectSource, handleSourceError } from "../../workers/collect.js";
import { hasXSession } from "../../x/client.js";

const providerEnum = z.enum(PROVIDERS);
const fetchTypeEnum = z.enum(FETCH_TYPES);

const configSchema = z
  .object({
    credentialRef: z.string().optional(),
    bodySelector: z.string().optional(),
    rssUrl: z.string().optional(),
    pollIntervalMin: z.number().optional(),
    maxItems: z.number().optional(),
  })
  .passthrough();

/**
 * sources router — UI-driven CRUD for feed sources. Backed by the repo layer,
 * which uses MySQL when DATABASE_URL is set and an in-memory store otherwise
 * (so the dashboard works without a database).
 */
export const sourcesRouter = router({
  /** Whether data is persisted (MySQL) or running in in-memory dev mode. */
  status: publicProcedure.query(() => ({ persisted: hasDb, xSession: hasXSession() })),

  list: publicProcedure.query(() => sourcesRepo.list()),

  /** Which sources have a saved login session on disk (for the session badge). */
  sessions: publicProcedure.query(async () => {
    const all = await sourcesRepo.list();
    return all.map((s) => ({ id: s.id, hasSession: hasSession(s.id) }));
  }),

  /** Providers that actually have a registered adapter. */
  providers: publicProcedure.query(() => listProviders()),

  /** Full provider catalog (presets) for the UI dropdown. */
  presets: publicProcedure.query(() => PROVIDER_LIST),

  create: publicProcedure
    .input(
      z.object({
        provider: providerEnum,
        fetchType: fetchTypeEnum.optional(),
        identifier: z.string().min(1),
        label: z.string().optional(),
        enabled: z.boolean().default(true),
        config: configSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const preset = PROVIDER_PRESETS[input.provider];
      return sourcesRepo.create({
        provider: input.provider,
        fetchType: input.fetchType ?? preset.fetchType,
        identifier: input.identifier,
        label: input.label,
        enabled: input.enabled,
        config: input.config ?? {},
      });
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.number(),
        label: z.string().optional(),
        enabled: z.boolean().optional(),
        identifier: z.string().optional(),
        config: configSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await sourcesRepo.update(input);
      return { ok: true };
    }),

  toggle: publicProcedure
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await sourcesRepo.setEnabled(input.id, input.enabled);
      return { ok: true };
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await sourcesRepo.remove(input.id);
      return { ok: true };
    }),

  /** Fetch one source right now — for verifying a new bridge/cookie setup.
   *  Returns the inserted count or the error text (also persisted to lastError). */
  collectNow: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }): Promise<{ ok: boolean; inserted: number; error: string | null }> => {
      if (!hasDb) return { ok: false, inserted: 0, error: "DATABASE_URL 필요 (데모 모드에선 수집 불가)" };
      const [src] = await db.select().from(sources).where(eq(sources.id, input.id)).limit(1);
      if (!src) return { ok: false, inserted: 0, error: "소스를 찾을 수 없습니다" };
      try {
        const inserted = await collectSource(src);
        await db
          .update(sources)
          .set({ lastFetchedAt: new Date(), lastError: null })
          .where(eq(sources.id, src.id));
        return { ok: true, inserted, error: null };
      } catch (err) {
        await handleSourceError(src, err); // persists lastError (+ session flag)
        return { ok: false, inserted: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }),
});
