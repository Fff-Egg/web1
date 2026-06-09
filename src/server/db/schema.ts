import {
  mysqlTable,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  json,
  mysqlEnum,
  uniqueIndex,
  index,
  date,
} from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

/**
 * Provider identifiers — the kind of source. Each provider has a dedicated
 * adapter (see src/server/adapters). The UI lets the user pick a provider
 * and then supply only the identifier (handle/URL/blog id).
 */
export const PROVIDERS = [
  "substack",
  "naver_blog",
  "x",
  "naver_premium",
  "fanding",
  "hankyung",
  "generic_rss",
  "generic_scrape",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * How a source is fetched. Drives which code path the adapter takes and
 * whether a stored login session is required.
 */
export const FETCH_TYPES = [
  "rss",
  "x_api",
  "x_auth",
  "scrape",
  "scrape_auth",
] as const;
export type FetchType = (typeof FETCH_TYPES)[number];

export const IMPACTS = ["bullish", "bearish", "neutral"] as const;
export type Impact = (typeof IMPACTS)[number];

/**
 * sources — a user-managed feed instance. The user adds these from the UI.
 * `config` holds provider-specific settings (selectors, polling, etc.) and,
 * for authenticated providers, ONLY a `credentialRef` key name — never the
 * credentials themselves (those live in environment variables).
 */
export const sources = mysqlTable(
  "sources",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    provider: varchar("provider", { length: 32 }).$type<Provider>().notNull(),
    fetchType: varchar("fetch_type", { length: 16 }).$type<FetchType>().notNull(),
    // handle / URL / blog id the user typed in
    identifier: varchar("identifier", { length: 512 }).notNull(),
    label: varchar("label", { length: 255 }),
    enabled: boolean("enabled").notNull().default(true),
    // provider-specific JSON config. For auth sources: { credentialRef, selectors, ... }
    config: json("config").$type<SourceConfig>(),
    // session status for authenticated sources: valid | expired | missing | null
    sessionStatus: varchar("session_status", { length: 16 }).$type<SessionStatus | null>(),
    lastFetchedAt: timestamp("last_fetched_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    providerIdx: index("sources_provider_idx").on(t.provider),
    enabledIdx: index("sources_enabled_idx").on(t.enabled),
  }),
);

export type SessionStatus = "valid" | "expired" | "missing";

export interface SourceConfig {
  /** Env-var key name that resolves to CRED_<ref>_USER / CRED_<ref>_PASS. */
  credentialRef?: string;
  /** CSS selector for article body when scraping. */
  bodySelector?: string;
  /** CSS selector for post links on a list/channel page (auth list providers). */
  listSelector?: string;
  /** Override RSS url (otherwise derived from identifier). */
  rssUrl?: string;
  /** Per-source polling interval override (minutes). */
  pollIntervalMin?: number;
  /** Max items to pull per fetch (rate-limit friendliness). */
  maxItems?: number;
  [key: string]: unknown;
}

/**
 * articles — normalized, deduplicated items from every provider.
 * (source_id, external_id) is unique to prevent re-ingesting the same item.
 */
export const articles = mysqlTable(
  "articles",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    sourceId: bigint("source_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // stable id from the provider (guid, tweet id, url hash, …) for dedupe
    externalId: varchar("external_id", { length: 512 }).notNull(),
    url: varchar("url", { length: 1024 }),
    title: text("title"),
    body: text("body"),
    author: varchar("author", { length: 255 }),
    publishedAt: timestamp("published_at"),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
  (t) => ({
    sourceExternalUnq: uniqueIndex("articles_source_external_unq").on(
      t.sourceId,
      t.externalId,
    ),
    publishedIdx: index("articles_published_idx").on(t.publishedAt),
  }),
);

/**
 * analyses — Claude output for an article. 1st-pass filter writes only
 * `relevant`; 2nd-pass deep analysis fills the structured fields.
 */
export const analyses = mysqlTable(
  "analyses",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    articleId: bigint("article_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    relevant: boolean("relevant").notNull().default(false),
    summary: text("summary"),
    implications: text("implications"),
    tickers: json("tickers").$type<string[]>(),
    themes: json("themes").$type<string[]>(),
    impact: mysqlEnum("impact", IMPACTS),
    model: varchar("model", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    articleIdx: uniqueIndex("analyses_article_unq").on(t.articleId),
    relevantIdx: index("analyses_relevant_idx").on(t.relevant),
  }),
);

/**
 * digests — one synthesized markdown report per day.
 */
export const digests = mysqlTable("digests", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  date: date("date", { mode: "string" }).notNull(),
  markdown: text("markdown").notNull(),
  meta: json("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  dateUnq: uniqueIndex("digests_date_unq").on(t.date),
}));

/**
 * settings — singleton-ish key/value config edited from the dashboard.
 * The analysis instructions ("지침") live here under key="analysis" so the
 * user can change how articles are analyzed without touching code.
 */
export const settings = mysqlTable("settings", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  key: varchar("key", { length: 64 }).notNull(),
  value: json("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  keyUnq: uniqueIndex("settings_key_unq").on(t.key),
}));

/** Shape stored under settings key="analysis". */
export interface AnalysisConfig {
  /** Free-form instructions = the system prompt that drives deep analysis. */
  instructions: string;
  /** Optional criteria for the cheap 1st-pass relevance filter. Falls back to `instructions`. */
  relevanceCriteria?: string;
  /** Optional model overrides (else FILTER_MODEL / ANALYSIS_MODEL env). */
  filterModel?: string;
  analysisModel?: string;
}

// ─── Relations ──────────────────────────────────────────────────────
export const sourcesRelations = relations(sources, ({ many }) => ({
  articles: many(articles),
}));

export const articlesRelations = relations(articles, ({ one }) => ({
  source: one(sources, {
    fields: [articles.sourceId],
    references: [sources.id],
  }),
  analysis: one(analyses, {
    fields: [articles.id],
    references: [analyses.articleId],
  }),
}));

export const analysesRelations = relations(analyses, ({ one }) => ({
  article: one(articles, {
    fields: [analyses.articleId],
    references: [articles.id],
  }),
}));

// ─── Inferred types ─────────────────────────────────────────────────
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type Analysis = typeof analyses.$inferSelect;
export type NewAnalysis = typeof analyses.$inferInsert;
export type Digest = typeof digests.$inferSelect;
export type NewDigest = typeof digests.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
