import { desc, eq, and } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { sources } from "../db/schema.js";
import type { Source, NewSource, Provider, FetchType, SourceConfig } from "../db/schema.js";

export interface CreateSourceInput {
  provider: Provider;
  fetchType: FetchType;
  identifier: string;
  label?: string;
  enabled?: boolean;
  config?: SourceConfig;
}

export interface UpdateSourceInput {
  id: number;
  label?: string;
  enabled?: boolean;
  identifier?: string;
  config?: SourceConfig;
}

export interface SourcesRepo {
  list(): Promise<Source[]>;
  create(input: CreateSourceInput): Promise<{ id: number }>;
  update(input: UpdateSourceInput): Promise<void>;
  setEnabled(id: number, enabled: boolean): Promise<void>;
  remove(id: number): Promise<void>;
  existsByIdentifier(provider: string, identifier: string): Promise<boolean>;
}

// ─── MySQL implementation ───────────────────────────────────────────
const mysqlRepo: SourcesRepo = {
  list: () => db.select().from(sources).orderBy(desc(sources.createdAt)),
  async create(input) {
    const [res] = await db.insert(sources).values(input as NewSource);
    return { id: res.insertId };
  },
  async update({ id, ...patch }) {
    await db.update(sources).set(patch).where(eq(sources.id, id));
  },
  async setEnabled(id, enabled) {
    await db.update(sources).set({ enabled }).where(eq(sources.id, id));
  },
  async remove(id) {
    await db.delete(sources).where(eq(sources.id, id));
  },
  async existsByIdentifier(provider, identifier) {
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.provider, provider as Provider), eq(sources.identifier, identifier)))
      .limit(1);
    return rows.length > 0;
  },
};

// ─── In-memory implementation (dev mode, no DATABASE_URL) ────────────
function makeMemoryRepo(): SourcesRepo {
  let nextId = 1;
  const rows: Source[] = [];

  const seed = (input: CreateSourceInput) => {
    rows.push({
      id: nextId++,
      provider: input.provider,
      fetchType: input.fetchType,
      identifier: input.identifier,
      label: input.label ?? null,
      enabled: input.enabled ?? true,
      config: input.config ?? {},
      sessionStatus: null,
      lastFetchedAt: null,
      lastError: null,
      createdAt: new Date(),
    } as Source);
  };

  // Same initial seed as db:seed so the demo dashboard isn't empty.
  seed({ provider: "fanding", fetchType: "scrape_auth", identifier: "https://fanding.kr/@sesang101/", label: "세상학개론" });
  seed({ provider: "hankyung", fetchType: "rss", identifier: "https://www.hankyung.com/", label: "한국경제" });

  return {
    async list() {
      return [...rows].sort((a, b) => +b.createdAt - +a.createdAt);
    },
    async create(input) {
      seed(input);
      return { id: nextId - 1 };
    },
    async update({ id, ...patch }) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
    async setEnabled(id, enabled) {
      const r = rows.find((x) => x.id === id);
      if (r) r.enabled = enabled;
    },
    async remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    async existsByIdentifier(provider, identifier) {
      return rows.some((x) => x.provider === provider && x.identifier === identifier);
    },
  };
}

export const sourcesRepo: SourcesRepo = hasDb ? mysqlRepo : makeMemoryRepo();
