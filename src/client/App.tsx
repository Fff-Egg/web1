import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./data/client.js";
import { SourcesPage } from "./pages/SourcesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { FeedPage } from "./pages/FeedPage.js";

type Tab = "sources" | "feed" | "digest" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "feed", label: "Feed" },
  { id: "digest", label: "Daily Digest" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("sources");
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Feed Watch — Investment Digest</h1>
        <p className="text-sm text-slate-500">
          {api.mode === "static" ? "static demo" : "server"}{" "}
          {health.data?.ok ? "online" : "…"}
        </p>
      </header>

      {status.data && !status.data.persisted && (
        <div className="mb-4 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {api.mode === "static" ? (
            <>데모 모드: 데이터는 이 브라우저(localStorage)에만 저장됩니다. 추가/삭제/토글을 자유롭게 시도해 보세요.</>
          ) : (
            <>데모 모드: <code>DATABASE_URL</code> 미설정 — 데이터가 메모리에만 저장됩니다.</>
          )}
        </div>
      )}

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
      {tab === "feed" && <FeedPage />}
      {tab === "settings" && <SettingsPage />}
      {tab === "digest" && (
        <p className="text-slate-500">Daily Digest 뷰는 다음 단계에서 제공됩니다.</p>
      )}
    </div>
  );
}
