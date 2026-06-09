import { useState } from "react";
import { trpc } from "./trpc.js";
import { SourcesPage } from "./pages/SourcesPage.js";

type Tab = "sources" | "digest" | "feed";

const TABS: { id: Tab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "digest", label: "Daily Digest" },
  { id: "feed", label: "Feed" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("sources");
  const health = trpc.health.useQuery();

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Feed Watch — Investment Digest</h1>
        <p className="text-sm text-slate-500">
          server {health.data?.ok ? "online" : "…"}
        </p>
      </header>

      <nav className="mb-6 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "px-4 py-2 text-sm font-medium -mb-px border-b-2 " +
              (tab === t.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "sources" && <SourcesPage />}
      {tab === "digest" && (
        <p className="text-slate-500">Daily Digest 뷰는 Phase 4에서 제공됩니다.</p>
      )}
      {tab === "feed" && (
        <p className="text-slate-500">Feed 뷰는 Phase 4에서 제공됩니다.</p>
      )}
    </div>
  );
}
