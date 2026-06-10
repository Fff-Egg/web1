import {
  mysqlTable,
  bigint,
  varchar,
  text,
  mediumtext,
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
  "telegram",
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
  "telegram",
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
  /** Telegram: highest message id already collected (batch cursor). */
  lastMessageId?: number;
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
    body: mediumtext("body"),
    author: varchar("author", { length: 255 }),
    publishedAt: timestamp("published_at"),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    /** Soft-delete (trash) — non-null = hidden from Feed and re-analysis. */
    deletedAt: timestamp("deleted_at"),
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
    /** Low-importance / personal — sorted into a separate review bucket, off the main feed. */
    lowPriority: boolean("low_priority").notNull().default(false),
    /** Saved "read later" — appears in the saved bucket and always feeds the digest. */
    saved: boolean("saved").notNull().default(false),
    summary: text("summary"),
    implications: text("implications"),
    /** Full multi-section analysis report (markdown), per the user's framework. */
    fullText: mediumtext("full_text"),
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
 * digests — saved synthesized reports. Each has a name (title) and a covered
 * period [periodStart, periodEnd]. Soft-deletable (trash).
 */
export const digests = mysqlTable("digests", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }),
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }),
  markdown: mediumtext("markdown").notNull(),
  meta: json("meta").$type<Record<string, unknown>>(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
  /** 1차 판단 지침: 어떤 글을 '관련 있음'으로 뽑을지. (cheap per-article filter) */
  relevanceCriteria?: string;
  /** 중요도 판별: 어떤 글을 '낮은 중요도/개인적'으로 보고 검토 버킷으로 뺄지. */
  importanceCriteria?: string;
  /** 요약 지침: 뽑힌 글을 Feed에 어떻게 요약해 보여줄지. */
  summaryInstructions?: string;
  /** 2차 다이제스트 지침: 하루 1회, 뽑힌 글들이 어떻게 연결되고 왜 중요한지 종합. */
  digestInstructions?: string;
  /** Optional per-article deep-analysis prompt (only used when DEEP_ANALYSIS=1). */
  instructions: string;
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
