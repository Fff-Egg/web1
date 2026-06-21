import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./data/client.js";
import { SourcesPage } from "./pages/SourcesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { FeedPage } from "./pages/FeedPage.js";
import { ArchivePage } from "./pages/ArchivePage.js";
import { DigestPage } from "./pages/DigestPage.js";
import { ManualPage } from "./pages/ManualPage.js";
import { TrashPage } from "./pages/TrashPage.js";
import { MarketPage } from "./pages/MarketPage.js";
import { ResearchPage } from "./pages/ResearchPage.js";

type Tab = "market" | "digest" | "feed" | "archive" | "analyze" | "sources" | "trash" | "settings" | "research";

const TABS: { id: Tab; label: string }[] = [
  { id: "market", label: "시황분석" },
  { id: "digest", label: "Daily Digest" },
  { id: "feed", label: "Feed" },
  { id: "archive", label: "보관함" },
  { id: "analyze", label: "분석(수동)" },
  { id: "sources", label: "Sources" },
  { id: "trash", label: "휴지통" },
  { id: "settings", label: "Settings" },
  { id: "research", label: "리포트" },
];

const TAB_KEY = "feedwatch.activeTab";

export function App() {
  // Remember the last tab across refreshes; default to Feed. A digest deep link
  // (?article=<id>, opened in a new tab) lands on 보관함, where telegram (and
  // other saved originals) are read.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("article")) {
      return "archive";
    }
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(TAB_KEY) : null;
    return saved && TABS.some((t) => t.id === saved) ? (saved as Tab) : "feed";
  });
  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <header className="mb-4 sm:mb-6">
        <h1 className="text-xl font-bold sm:text-2xl">Feed Watch — Investment Digest</h1>
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

      {/* Mobile: a horizontal scroll strip (8 tabs overflow a phone) instead of
          spilling off-screen. -mx pulls it to the screen edges so chips aren't clipped.
          overflow-y-hidden + touch-pan-x keep the swipe strictly horizontal (otherwise
          overflow-x:auto promotes overflow-y to auto and the strip jiggles vertically). */}
      <nav className="no-scrollbar mb-4 -mx-4 flex gap-1 overflow-x-auto overflow-y-hidden touch-pan-x border-b border-slate-200 px-4 sm:mx-0 sm:mb-6 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "shrink-0 whitespace-nowrap px-3 py-2 text-sm font-medium -mb-px border-b-2 sm:px-4 " +
              (tab === t.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "market" && <MarketPage />}
      {tab === "digest" && <DigestPage />}
      {tab === "feed" && <FeedPage />}
      {tab === "archive" && <ArchivePage />}
      {tab === "analyze" && <ManualPage />}
      {tab === "sources" && <SourcesPage />}
      {tab === "trash" && <TrashPage />}
      {tab === "settings" && <SettingsPage />}
      {tab === "research" && <ResearchPage />}
    </div>
  );
}
