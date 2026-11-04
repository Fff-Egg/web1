import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./data/client.js";
import { SourcesPage } from "./pages/SourcesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { FeedPage } from "./pages/FeedPage.js";
import { ArchivePage } from "./pages/ArchivePage.js";
import { DigestPage } from "./pages/DigestPage.js";
import { ManualPage } from "./pages/ManualPage.js";
import { MarketPage } from "./pages/MarketPage.js";
import { ThesisMapPage } from "./pages/ThesisMapPage.js";

type Tab = "market" | "digest" | "feed" | "archive" | "analyze" | "sources" | "settings" | "thesis";

const TABS: { id: Tab; label: string }[] = [
  { id: "market", label: "시황분석" },
  { id: "digest", label: "Daily Digest" },
  { id: "feed", label: "Feed" },
  { id: "archive", label: "보관함" },
  { id: "analyze", label: "분석(수동)" },
  { id: "sources", label: "Sources" },
  { id: "settings", label: "Settings" },
  { id: "thesis", label: "논지 지도" },
];

export function App() {
  // Every load starts on 시황분석. A digest deep link (?article=<id>, opened in a
  // new tab) lands on 보관함 instead, where telegram (and other saved originals)
  // are read.
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("article")
      ? "archive"
      : "market",
  );
  // Drop the ?article param once routed: ArchivePage captures it in its initial
  // state, and leaving it in the URL would hijack every refresh back to 보관함.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.has("article")) {
      u.searchParams.delete("article");
      window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    }
  }, []);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  // Shares the Settings retry panel's query: one request, refreshed every minute.
  const retryStatus = useQuery({ queryKey: ["analysisRetryStatus"], queryFn: () => api.getAnalysisRetryStatus(), refetchInterval: 60_000 });
  const creditPause = retryStatus.data?.globalPause?.reason === "balance" ? retryStatus.data.globalPause : null;

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-6">
      <header className="mb-3 sm:mb-6">
        <h1 className="text-lg font-bold leading-tight sm:text-2xl">Feed Watch — Investment Digest</h1>
        <p className="text-sm text-slate-500">
          {api.mode === "static" ? "static demo" : "server"}{" "}
          {health.data?.ok ? "online" : "…"}
        </p>
      </header>

      {creditPause && (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <strong>API 크레딧(잔액) 소진</strong> — 자동 글 분석을 멈췄습니다. 수집은 계속됩니다.
          {" "}{new Date(creditPause.until).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}에 다시 확인하며,
          Claude 월 크레딧은 다음 결제 주기에 들어옵니다. 잔액은 Claude Console → Billing에서 확인하세요.
          충전했다면 Settings → 재시도 관리에서 대기를 해제할 수 있습니다.
        </div>
      )}
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
      <nav className="no-scrollbar mb-4 -mx-3 flex gap-1 overflow-x-auto overflow-y-hidden touch-pan-x border-b border-slate-200 px-3 sm:mx-0 sm:mb-6 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium sm:px-4 " +
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
      {tab === "settings" && <SettingsPage />}
      {tab === "thesis" && <ThesisMapPage />}
    </div>
  );
}
