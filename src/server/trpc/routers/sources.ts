import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db } from "../../db/client.js";
import { sources, PROVIDERS, FETCH_TYPES } from "../../db/schema.js";
import { listProviders } from "../../adapters/index.js";
import { PROVIDER_LIST, PROVIDER_PRESETS } from "../../../shared/providers.js";

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
 * sources router — UI-driven CRUD for feed sources. This is the backbone of
 * "I can add/remove/toggle sources from the dashboard" (Section 1).
 */
export const sourcesRouter = router({
  list: publicProcedure.query(async () => {
    return db.select().from(sources).orderBy(desc(sources.createdAt));
  }),

  /** Providers that actually have a registered adapter. */
  providers: publicProcedure.query(() => listProviders()),

  /** Full provider catalog (presets) for the UI dropdown. */
  presets: publicProcedure.query(() => PROVIDER_LIST),

  create: publicProcedure
    .input(
      z.object({
        provider: providerEnum,
        // fetchType is derived from the provider preset unless explicitly given.
        fetchType: fetchTypeEnum.optional(),
        identifier: z.string().min(1),
        label: z.string().optional(),
        enabled: z.boolean().default(true),
        config: configSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const preset = PROVIDER_PRESETS[input.provider];
      const [res] = await db.insert(sources).values({
        provider: input.provider,
        fetchType: input.fetchType ?? preset.fetchType,
        identifier: input.identifier,
        label: input.label,
        enabled: input.enabled,
        config: input.config ?? {},
      });
      return { id: res.insertId };
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
      const { id, ...patch } = input;
      await db.update(sources).set(patch).where(eq(sources.id, id));
      return { ok: true };
    }),

  toggle: publicProcedure
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.update(sources).set({ enabled: input.enabled }).where(eq(sources.id, input.id));
      return { ok: true };
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await db.delete(sources).where(eq(sources.id, input.id));
      return { ok: true };
    }),
});
