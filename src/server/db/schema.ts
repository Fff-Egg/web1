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
  int,
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
 * 논지 지도(Thesis Map) — a signal's effect on a thread's thesis.
 * support 강화 / weaken 약화 / refute 반증 / neutral 중립.
 */
export const VERDICTS = ["support", "weaken", "refute", "neutral"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Evidence tier — how hard the signal is.
 * confirmed 확정(사실) / mgmt 경영진주장 / inference 추론 / speculation 추측.
 */
export const TIERS = ["confirmed", "mgmt", "inference", "speculation"] as const;
export type Tier = (typeof TIERS)[number];

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
    /** Body/title could not be collected well enough to judge. Kept in a
     * persistent manual-review bucket and excluded from the digest. */
    needsSourceReview: boolean("needs_source_review").notNull().default(false),
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
    sourceReviewIdx: index("analyses_source_review_idx").on(t.needsSourceReview),
  }),
);

/**
 * threads — 논지 지도(Thesis Map). The user's investment theses (e.g. NAND/HBF,
 * HBM/DRAM, 광인터커넥트…). Each holds a one-line thesis the system tracks signals
 * against. `code` is a short badge label (A~E). Archived threads stay for history.
 */
export const threads = mysqlTable("threads", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  /** Short badge code (A, B, …) shown on feed cards. Optional. */
  code: varchar("code", { length: 16 }),
  name: varchar("name", { length: 255 }).notNull(),
  /** One-line thesis/proposition this thread tracks. */
  thesis: varchar("thesis", { length: 512 }),
  /** Longer background context (optional). */
  context: text("context"),
  archived: boolean("archived").notNull().default(false),
  /** Manual display order (lower first); ties break on code/name. */
  sort: int("sort").notNull().default(0), // matches migration 0010 (int)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * signals — one article's read on one thread (or, when thread_id is NULL, a
 * "new thesis candidate" inbox row whose proposed name lives in `candidate`).
 * Confidence is NOT stored — it's aggregated by the system from verdict counts.
 * unique(article_id, thread_id) keeps re-analysis idempotent (NULLs are distinct
 * in MySQL, so an article may propose several candidates).
 */
export const signals = mysqlTable(
  "signals",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    articleId: bigint("article_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    /** NULL = unassigned candidate (inbox); else the thread it scores. */
    threadId: bigint("thread_id", { mode: "number", unsigned: true }).references(
      () => threads.id,
      { onDelete: "cascade" },
    ),
    /** Proposed new-thread name when threadId is NULL (inbox candidate). */
    candidate: varchar("candidate", { length: 255 }),
    verdict: varchar("verdict", { length: 16 }).$type<Verdict>().notNull(),
    tier: varchar("tier", { length: 16 }).$type<Tier>().notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    articleThreadUnq: uniqueIndex("signals_article_thread_unq").on(t.articleId, t.threadId),
    threadIdx: index("signals_thread_idx").on(t.threadId, t.createdAt),
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
 * filter_feedback — user interactions used to tune the 1st-pass filter.
 * Negative = trashed by the user (중요↓); positive = promoted from review or
 * restored from trash (중요↑). The auto 21:00 feed sweep does NOT write here,
 * so system cleanup never pollutes the learning signal. A daily job folds new
 * rows into a cumulative memo (settings key="filterGuidance"). No FK on
 * article_id so a row survives a permanent purge of its article.
 */
export type FeedbackAction = "trash" | "promote" | "restore";

export const filterFeedback = mysqlTable(
  "filter_feedback",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    articleId: bigint("article_id", { mode: "number", unsigned: true }),
    signal: varchar("signal", { length: 8 }).$type<"positive" | "negative">().notNull(),
    action: varchar("action", { length: 16 }).$type<FeedbackAction>().notNull(),
    title: text("title"),
    summary: text("summary"),
    source: varchar("source", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    signalIdx: index("filter_feedback_signal_idx").on(t.signal, t.createdAt),
  }),
);

/**
 * research_reports — daily broker research reports (증권사 리포트), collected from
 * 한경 컨센서스 (consensus.hankyung.com). One row per report. `external_id` (the
 * report's PDF idx, or a date|broker|title hash) is unique to dedupe re-collection.
 * Coverage counting + TP-상향 tier-up are computed at read time from these rows.
 */
export const researchReports = mysqlTable(
  "research_reports",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    /** 작성일, YYYY-MM-DD. */
    reportDate: varchar("report_date", { length: 10 }).notNull(),
    /** 분류: 기업/산업/시황/경제/채권/파생/기타. */
    category: varchar("category", { length: 24 }).notNull(),
    /** 헤드라인(제목). */
    title: text("title").notNull(),
    /** 주요 내용 — 리포트 본문 LLM 한 줄 요약. */
    summary: text("summary"),
    /** 현재 시가총액(원), 네이버 종목 페이지. */
    marketCap: bigint("market_cap", { mode: "number" }),
    stockName: varchar("stock_name", { length: 120 }),
    stockCode: varchar("stock_code", { length: 16 }),
    /** 적정가격(TP), 원문 표시 문자열. */
    targetPrice: varchar("target_price", { length: 48 }),
    /** 적정가격 숫자(원) — TP 상향 판정용. */
    targetPriceNum: bigint("target_price_num", { mode: "number" }),
    /** 투자의견. */
    opinion: varchar("opinion", { length: 48 }),
    /** 증권사/제공출처. */
    broker: varchar("broker", { length: 120 }),
    pdfUrl: varchar("pdf_url", { length: 1024 }),
    source: varchar("source", { length: 16 }).notNull().default("hankyung"),
    externalId: varchar("external_id", { length: 200 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    externalUnq: uniqueIndex("research_external_unq").on(t.externalId),
    dateIdx: index("research_date_idx").on(t.reportDate),
    codeIdx: index("research_code_idx").on(t.stockCode),
  }),
);

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
  /** Optional digest map/compression model. Defaults to filterModel/FILTER_MODEL. */
  digestMapModel?: string;
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

export const threadsRelations = relations(threads, ({ many }) => ({
  signals: many(signals),
}));

export const signalsRelations = relations(signals, ({ one }) => ({
  thread: one(threads, {
    fields: [signals.threadId],
    references: [threads.id],
  }),
  article: one(articles, {
    fields: [signals.articleId],
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
export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type FilterFeedback = typeof filterFeedback.$inferSelect;
export type NewFilterFeedback = typeof filterFeedback.$inferInsert;
export type ResearchReport = typeof researchReports.$inferSelect;
export type NewResearchReport = typeof researchReports.$inferInsert;

/**
 * Cumulative "learned memo" distilled from feedback, stored under settings
 * key="filterGuidance". The 21:00 job folds NEW feedback (id > lastFeedbackId)
 * into `text` via the LLM, so learning accumulates across days instead of being
 * rebuilt from scratch. Injected into the 1st-pass filter prompt.
 */
export interface FilterGuidance {
  text: string;
  /** Highest filter_feedback.id already folded into `text` (cursor). */
  lastFeedbackId: number;
  /** Total feedback rows folded in so far (for display). */
  count: number;
  updatedAt?: string;
}
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
