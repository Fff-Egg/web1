import { trpc } from "./trpc.js";

/**
 * Phase 1 shell. Phase 2 fills in the Sources management UI; Phase 4 adds the
 * Daily Digest and Feed views.
 */
export function App() {
  const health = trpc.health.useQuery();
  const sources = trpc.sources.list.useQuery();

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Feed Watch — Investment Digest</h1>
        <p className="text-sm text-slate-500">
          Phase 1 foundation · server {health.data?.ok ? "online" : "…"}
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Sources</h2>
        {sources.isLoading && <p className="text-slate-500">Loading…</p>}
        {sources.error && (
          <p className="text-red-600">DB not reachable: {sources.error.message}</p>
        )}
        <ul className="space-y-2">
          {sources.data?.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded border border-slate-200 bg-white px-4 py-2"
            >
              <div>
                <span className="font-medium">{s.label ?? s.identifier}</span>{" "}
                <span className="text-xs text-slate-400">[{s.provider}]</span>
              </div>
              <span
                className={
                  s.enabled ? "text-xs text-green-600" : "text-xs text-slate-400"
                }
              >
                {s.enabled ? "on" : "off"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
