import { providerLabel } from "../../shared/providers.js";

export interface SourceCount {
  provider: string;
  count: number;
}

/**
 * Horizontal source-type filter chips ("전체 / 네이버 블로그 / X / 한경 / RSS …").
 * `active === null` means "전체" (no filter). Hidden when there's ≤1 source type.
 */
export function SourceTabs({
  counts,
  active,
  onChange,
}: {
  counts: SourceCount[];
  active: string | null;
  onChange: (provider: string | null) => void;
}) {
  if (counts.length <= 1) return null;
  const total = counts.reduce((n, c) => n + c.count, 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip label="전체" count={total} active={active === null} onClick={() => onChange(null)} />
      {counts.map((c) => (
        <Chip
          key={c.provider}
          label={providerLabel(c.provider)}
          count={c.count}
          active={active === c.provider}
          onClick={() => onChange(c.provider)}
        />
      ))}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-full px-3 py-1 text-xs font-medium transition " +
        (active
          ? "bg-slate-900 text-white"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
      }
    >
      {label} <span className={active ? "text-slate-300" : "text-slate-400"}>{count}</span>
    </button>
  );
}

/** Tally a list of items by their `provider`, preserving a preferred order. */
export function tallyByProvider<T extends { provider: string }>(
  items: T[],
  order: readonly string[],
): SourceCount[] {
  const byProvider = new Map<string, number>();
  for (const it of items) byProvider.set(it.provider, (byProvider.get(it.provider) ?? 0) + 1);
  const ordered: SourceCount[] = [];
  for (const p of order) {
    const count = byProvider.get(p);
    if (count) {
      ordered.push({ provider: p, count });
      byProvider.delete(p);
    }
  }
  for (const [provider, count] of byProvider) ordered.push({ provider, count });
  return ordered;
}

/** Shared display order for source-type tabs/groups. */
export const SOURCE_ORDER = [
  "naver_blog",
  "x",
  "hankyung",
  "generic_rss",
  "substack",
  "naver_premium",
  "fanding",
] as const;
