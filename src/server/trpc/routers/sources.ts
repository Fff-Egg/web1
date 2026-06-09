import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { PROVIDERS, FETCH_TYPES } from "../../db/schema.js";
import { listProviders } from "../../adapters/index.js";
import { PROVIDER_LIST, PROVIDER_PRESETS } from "../../../shared/providers.js";
import { sourcesRepo } from "../../repo/sources.js";
import { hasDb } from "../../db/client.js";
import { hasSession } from "../../auth/session.js";

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
  status: publicProcedure.query(() => ({ persisted: hasDb })),

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
});
