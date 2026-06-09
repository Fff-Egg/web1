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
      // Static demo has no backend/Claude — show example cards so the UI is visible.
      return SAMPLE_FEED;
    },
  };
}

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
