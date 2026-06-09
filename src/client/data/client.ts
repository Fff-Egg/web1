import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../server/trpc/routers/index.js";
import type { Provider, FetchType, SourceConfig, AnalysisConfig, Impact } from "../../server/db/schema.js";
import { DEFAULT_ANALYSIS_CONFIG } from "../../shared/analysis.js";

export type { AnalysisConfig };

export interface FeedFilter {
  impact?: Impact;
  ticker?: string;
  theme?: string;
}

export interface FeedItem {
  id: number;
  title: string | null;
  url: string | null;
  author: string | null;
  publishedAt: string | Date | null;
  sourceLabel: string | null;
  provider: string;
  summary: string | null;
  implications: string | null;
  tickers: string[] | null;
  themes: string[] | null;
  impact: Impact | null;
}

/**
 * Client data layer. The same dashboard runs in two modes:
 *  - tRPC mode (default): talks to the Express + tRPC backend.
 *  - static demo mode (VITE_STATIC_DEMO=true): no backend; data lives in the
 *    browser's localStorage. Used for the GitHub Pages public demo.
 */

export interface SourceRow {
  id: number;
  provider: Provider;
  fetchType: FetchType;
  identifier: string;
  label: string | null;
  enabled: boolean;
  config: SourceConfig | null;
  sessionStatus: "valid" | "expired" | "missing" | null;
  lastError: string | null;
  createdAt: string | Date;
}

export interface CreateInput {
  provider: Provider;
  identifier: string;
  label?: string;
  config?: SourceConfig;
}

export interface UpdateInput {
  id: number;
  label?: string;
  enabled?: boolean;
  identifier?: string;
  config?: SourceConfig;
}

export interface DataApi {
  mode: "trpc" | "static";
  health(): Promise<{ ok: boolean; ts: number }>;
  status(): Promise<{ persisted: boolean }>;
  listSources(): Promise<SourceRow[]>;
  createSource(input: CreateInput): Promise<{ id: number }>;
  updateSource(input: UpdateInput): Promise<void>;
  toggleSource(id: number, enabled: boolean): Promise<void>;
  removeSource(id: number): Promise<void>;
  getAnalysisConfig(): Promise<AnalysisConfig>;
  updateAnalysisConfig(cfg: AnalysisConfig): Promise<void>;
  listFeed(filter?: FeedFilter): Promise<FeedItem[]>;
  listDigestDates(): Promise<DigestDate[]>;
  getDigest(date?: string): Promise<DigestFull | null>;
  listSessions(): Promise<SessionInfo[]>;
  listPending(): Promise<PendingArticle[]>;
  saveManualAnalysis(input: ManualAnalysisInput): Promise<void>;
  skipPending(articleId: number): Promise<void>;
}

export interface PendingArticle {
  id: number;
  title: string | null;
  url: string | null;
  body: string | null;
  publishedAt: string | Date | null;
  sourceLabel: string | null;
  provider: string;
}

export interface ManualAnalysisInput {
  articleId: number;
  summary: string;
  implications: string;
  tickers: string[];
  themes: string[];
  impact: Impact;
}

export interface SessionInfo {
  id: number;
  hasSession: boolean;
}

export interface DigestDate {
  date: string;
  createdAt: string | Date;
}
export interface DigestFull {
  date: string;
  markdown: string;
  meta?: Record<string, unknown> | null;
}

const STATIC = import.meta.env.VITE_STATIC_DEMO === "true";

// ─── tRPC-backed implementation ─────────────────────────────────────
function makeTrpcApi(): DataApi {
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "/trpc", transformer: superjson })],
  });
  return {
    mode: "trpc",
    health: () => client.health.query(),
    status: () => client.sources.status.query(),
    listSources: () => client.sources.list.query() as Promise<SourceRow[]>,
    createSource: (input) => client.sources.create.mutate(input),
    updateSource: async (input) => {
      await client.sources.update.mutate(input);
    },
    toggleSource: async (id, enabled) => {
      await client.sources.toggle.mutate({ id, enabled });
    },
    removeSource: async (id) => {
      await client.sources.remove.mutate({ id });
    },
    getAnalysisConfig: () => client.settings.getAnalysisConfig.query(),
    updateAnalysisConfig: async (cfg) => {
      await client.settings.updateAnalysisConfig.mutate(cfg);
    },
    listFeed: (filter) => client.feed.list.query(filter ?? {}) as Promise<FeedItem[]>,
    listDigestDates: () => client.digest.dates.query() as Promise<DigestDate[]>,
    getDigest: (date) => client.digest.get.query({ date }) as Promise<DigestFull | null>,
    listSessions: () => client.sources.sessions.query() as Promise<SessionInfo[]>,
    listPending: () => client.manual.pending.query() as Promise<PendingArticle[]>,
    saveManualAnalysis: async (input) => {
      await client.manual.save.mutate(input);
    },
    skipPending: async (articleId) => {
      await client.manual.skip.mutate({ articleId });
    },
  };
}

// ─── localStorage-backed implementation (static demo) ───────────────
const KEY = "feedwatch.sources.v1";

function makeStaticApi(): DataApi {
  const load = (): SourceRow[] => {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as SourceRow[];
      } catch {
        /* fall through to seed */
      }
    }
    const seeded = seedRows();
    localStorage.setItem(KEY, JSON.stringify(seeded));
    return seeded;
  };
  const save = (rows: SourceRow[]) => localStorage.setItem(KEY, JSON.stringify(rows));
  const nextId = (rows: SourceRow[]) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  return {
    mode: "static",
    async health() {
      return { ok: true, ts: Date.now() };
    },
    async status() {
      return { persisted: false };
    },
    async listSources() {
      return load().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },
    async createSource(input) {
      const rows = load();
      const id = nextId(rows);
      rows.push({
        id,
        provider: input.provider,
        fetchType: presetFetchType(input.provider),
        identifier: input.identifier,
        label: input.label ?? null,
        enabled: true,
        config: input.config ?? {},
        sessionStatus: null,
        lastError: null,
        createdAt: new Date().toISOString(),
      });
      save(rows);
      return { id };
    },
    async updateSource({ id, ...patch }) {
      const rows = load();
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      save(rows);
    },
    async toggleSource(id, enabled) {
      const rows = load();
      const r = rows.find((x) => x.id === id);
      if (r) r.enabled = enabled;
      save(rows);
    },
    async removeSource(id) {
      save(load().filter((x) => x.id !== id));
    },
    async getAnalysisConfig() {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        try {
          return { ...DEFAULT_ANALYSIS_CONFIG, ...(JSON.parse(raw) as AnalysisConfig) };
        } catch {
          /* fall through */
        }
      }
      return { ...DEFAULT_ANALYSIS_CONFIG };
    },
    async updateAnalysisConfig(cfg) {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    },
    async listFeed() {
      // Static demo: manually-saved analyses first, then example cards.
      return [...loadSavedFeed(), ...SAMPLE_FEED];
    },
    async listDigestDates() {
      return [{ date: SAMPLE_DIGEST.date, createdAt: new Date().toISOString() }];
    },
    async getDigest() {
      return SAMPLE_DIGEST;
    },
    async listSessions() {
      // Static demo has no server-side sessions.
      return load().map((s) => ({ id: s.id, hasSession: false }));
    },
    async listPending() {
      return loadPending();
    },
    async saveManualAnalysis(input) {
      const pending = loadPending();
      const art = pending.find((p) => p.id === input.articleId);
      const saved = loadSavedFeed();
      saved.unshift({
        id: input.articleId,
        title: art?.title ?? null,
        url: art?.url ?? null,
        author: null,
        publishedAt: art?.publishedAt ?? new Date().toISOString(),
        sourceLabel: art?.sourceLabel ?? null,
        provider: art?.provider ?? "generic_rss",
        summary: input.summary,
        implications: input.implications,
        tickers: input.tickers,
        themes: input.themes,
        impact: input.impact,
      });
      localStorage.setItem(SAVED_FEED_KEY, JSON.stringify(saved));
      savePending(pending.filter((p) => p.id !== input.articleId));
    },
    async skipPending(articleId) {
      savePending(loadPending().filter((p) => p.id !== articleId));
    },
  };
}

const PENDING_KEY = "feedwatch.pending.v1";
const SAVED_FEED_KEY = "feedwatch.savedfeed.v1";

function loadPending(): PendingArticle[] {
  const raw = localStorage.getItem(PENDING_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as PendingArticle[];
    } catch {
      /* reseed */
    }
  }
  const seeded = SAMPLE_PENDING;
  localStorage.setItem(PENDING_KEY, JSON.stringify(seeded));
  return seeded;
}
function savePending(rows: PendingArticle[]) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(rows));
}
function loadSavedFeed(): FeedItem[] {
  const raw = localStorage.getItem(SAVED_FEED_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as FeedItem[];
    } catch {
      /* ignore */
    }
  }
  return [];
}

const SAMPLE_PENDING: PendingArticle[] = [
  {
    id: 101,
    title: "(예시) 한국은행, 기준금리 동결 결정… 추가 인하 신중론",
    url: "https://example.com/pending-1",
    body: "한국은행 금융통화위원회가 기준금리를 동결했다. 위원 다수는 물가 안정세를 확인하면서도 가계부채와 환율 변동성을 이유로 추가 인하에 신중한 입장을 보였다. 시장은 다음 분기 인하 가능성을 절반 정도로 보고 있다…",
    publishedAt: new Date().toISOString(),
    sourceLabel: "한국경제",
    provider: "hankyung",
  },
  {
    id: 102,
    title: "(예시) 세상학개론: 반도체 사이클, 지금 어디쯤인가",
    url: "https://example.com/pending-2",
    body: "이번 글에서는 메모리 반도체 가격 반등과 AI 가속기 수요를 바탕으로 현재 반도체 사이클의 위치를 점검한다. 공급 측 감산 효과가 가격에 반영되기 시작했고, 데이터센터 투자가 수요를 견인하는 구조가 당분간 이어질 것으로 본다…",
    publishedAt: new Date().toISOString(),
    sourceLabel: "세상학개론",
    provider: "fanding",
  },
];

const CFG_KEY = "feedwatch.analysis.v1";

const SAMPLE_FEED: FeedItem[] = [
  {
    id: 1,
    title: "(예시) 엔비디아, 차세대 데이터센터 GPU 수요 가이던스 상향",
    url: "https://example.com/sample-1",
    author: null,
    publishedAt: new Date().toISOString(),
    sourceLabel: "예시 소스",
    provider: "generic_rss",
    summary: "데이터센터향 GPU 수요가 예상을 상회한다는 내용. 공급은 여전히 타이트.",
    implications: "AI 인프라 투자 사이클이 지속된다는 내 논제를 강화. 관련 밸류체인에 우호적.",
    tickers: ["NVDA"],
    themes: ["AI 반도체"],
    impact: "bullish",
  },
  {
    id: 2,
    title: "(예시) 금리 동결 시그널, 성장주 밸류에이션에 우호적",
    url: "https://example.com/sample-2",
    author: null,
    publishedAt: new Date().toISOString(),
    sourceLabel: "예시 소스",
    provider: "hankyung",
    summary: "중앙은행이 추가 인상에 신중. 시장은 동결을 기대.",
    implications: "성장주 비중이 높은 내 포트폴리오에 중립~소폭 우호적.",
    tickers: [],
    themes: ["매크로", "금리"],
    impact: "neutral",
  },
];

const SAMPLE_DIGEST: DigestFull = {
  date: new Date().toLocaleDateString("en-CA"),
  markdown: `# 일일 다이제스트 (예시)

## 오늘의 핵심 3가지
- AI 데이터센터 GPU 수요 가이던스 상향 — 인프라 사이클 지속 신호.
- 중앙은행 금리 동결 시그널 — 성장주 밸류에이션에 우호적.
- 환율 변동성 확대 — 수출주 단기 변수.

## 종목·테마별 업데이트
- **AI 반도체 (상승)**: 데이터센터 수요 강세.
- **매크로·금리 (중립)**: 동결 기대.

## 주목할 신규 글
- [엔비디아, 차세대 데이터센터 GPU 수요 가이던스 상향](https://example.com/sample-1) — 출처: 예시 소스 (상승)
- [금리 동결 시그널, 성장주에 우호적](https://example.com/sample-2) — 출처: 한국경제 (중립)

> 예시 데이터입니다. 실서버에서 ANTHROPIC_API_KEY로 분석이 돌면 실제 출처·링크가 채워집니다.`,
};

function seedRows(): SourceRow[] {
  const now = Date.now();
  const mk = (i: number, p: Provider, ft: FetchType, id: string, label: string): SourceRow => ({
    id: i,
    provider: p,
    fetchType: ft,
    identifier: id,
    label,
    enabled: true,
    config: {},
    sessionStatus: null,
    lastError: null,
    createdAt: new Date(now - (2 - i) * 1000).toISOString(),
  });
  return [
    mk(1, "fanding", "scrape_auth", "https://fanding.kr/@sesang101/", "세상학개론"),
    mk(2, "hankyung", "rss", "https://www.hankyung.com/", "한국경제"),
  ];
}

// Lightweight preset lookup to avoid importing server-only code paths here.
import { PROVIDER_PRESETS } from "../../shared/providers.js";
function presetFetchType(p: Provider): FetchType {
  return PROVIDER_PRESETS[p].fetchType;
}

export const api: DataApi = STATIC ? makeStaticApi() : makeTrpcApi();
