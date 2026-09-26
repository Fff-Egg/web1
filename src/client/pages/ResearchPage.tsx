import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { ResearchList } from "../data/client.js";
import { REPORT_CATEGORIES } from "../../shared/research.js";

/**
 * 리포트 — daily 증권사 리포트 board (한경 컨센서스).
 * 카테고리별로 묶고, 최근 5영업일 커버리지로 **주요종목**(5회↑), 직전 대비 **TP상향종목**을
 * 맨 위로 티어업. 작성일 선택 + '지금 수집'(즉시 재수집).
 */
export function ResearchPage() {
  const qc = useQueryClient();
  const [date, setDate] = useState<string | undefined>(undefined);
  const board = useQuery({
    queryKey: ["research", date ?? "latest"],
    queryFn: () => api.researchList(date),
  });
  const refresh = useMutation({
    mutationFn: () => api.researchRefresh(date),
    onSuccess: (data) => {
      qc.setQueryData(["research", date ?? "latest"], data);
      qc.invalidateQueries({ queryKey: ["research"] });
    },
  });

  const data = board.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">증권사 리포트</h2>
          <p className="text-sm text-slate-500">
            네이버 + 한경 컨센서스 · 기업·산업 · {data?.collectedAt ? `수집 ${fmtTime(data.collectedAt)}` : "하루 1회 자동 수집"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && data.dates.length > 0 && (
            <select
              value={data.date ?? ""}
              onChange={(e) => setDate(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
            >
              {data.dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {refresh.isPending ? "수집 중…" : "지금 수집"}
          </button>
        </div>
      </div>

      {board.isLoading && <Placeholder text="불러오는 중…" />}
      {data?.error && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{data.error}</div>
      )}
      {!board.isLoading && data && data.reports.length === 0 && (
        <Placeholder text="아직 수집된 리포트가 없습니다. '지금 수집'을 눌러 가져오세요." />
      )}

      {data && data.reports.length > 0 && (
        <>
          <TierSummary data={data} />
          {orderedCategories(data).map((cat) => {
            const rows = data.reports.filter((r) => r.category === cat);
            if (rows.length === 0) return null;
            return (
              <section key={cat}>
                <h3 className="mb-2 mt-1 text-sm font-semibold text-slate-700">
                  {cat} <span className="text-xs font-normal text-slate-400">{rows.length}건</span>
                </h3>
                <div className="space-y-2">
                  {rows.map((r) => (
                    <ReportCard key={r.id} r={r} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

type Report = ResearchList["reports"][number];

function ReportCard({ r }: { r: Report }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={r.source === "hankyung" ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}>
          {sourceLabel(r.source)}
        </Badge>
        {r.tpRaised && <Badge className="bg-rose-100 text-rose-700">TP상향</Badge>}
        {r.isMajor && <Badge className="bg-indigo-100 text-indigo-700">주요 {r.coverageCount}회</Badge>}
        {!r.isMajor && r.coverageCount > 1 && (
          <Badge className="bg-slate-100 text-slate-500">{r.coverageCount}회/5일</Badge>
        )}
        {r.stockName && (
          <span className="text-sm font-semibold text-slate-800">
            {r.stockName}
            {r.stockCode && <span className="ml-1 text-xs font-normal text-slate-400">{r.stockCode}</span>}
          </span>
        )}
      </div>

      <div className="mt-1 text-sm text-slate-800">
        {r.pdfUrl ? (
          <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="hover:underline">
            {r.title}
          </a>
        ) : (
          r.title
        )}
      </div>

      {r.summary && <p className="mt-1 text-xs leading-relaxed text-slate-500">{r.summary}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {r.broker && <span>{r.broker}</span>}
        {r.opinion && <span className="text-slate-600">{r.opinion}</span>}
        {r.targetPrice && (
          <span>
            목표가 <span className="font-medium text-slate-700">{r.targetPrice}</span>
          </span>
        )}
        {r.marketCap != null && (
          <span>
            시총 <span className="font-medium text-slate-700">{fmtCap(r.marketCap)}</span>
          </span>
        )}
        {r.pdfUrl && (
          <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-700">
            PDF ↗
          </a>
        )}
      </div>
    </div>
  );
}

/** A compact roll-up of today's tier-ups at the top. */
function TierSummary({ data }: { data: ResearchList }) {
  const tpUp = data.reports.filter((r) => r.tpRaised);
  const major = data.reports.filter((r) => r.isMajor && !r.tpRaised);
  if (tpUp.length === 0 && major.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="mb-1 font-medium text-slate-700">오늘의 티어업</div>
      <div className="space-y-1">
        {tpUp.length > 0 && (
          <div>
            <span className="mr-1 rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700">TP상향</span>
            <span className="text-slate-700">{uniqNames(tpUp).join(", ")}</span>
          </div>
        )}
        {major.length > 0 && (
          <div>
            <span className="mr-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">주요</span>
            <span className="text-slate-700">{uniqNames(major).join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">
      {text}
    </div>
  );
}

/** Known categories first (in canonical order), then any others present. */
function orderedCategories(data: ResearchList): string[] {
  const present = [...new Set(data.reports.map((r) => r.category))];
  const known = REPORT_CATEGORIES.filter((c) => present.includes(c));
  const extra = present.filter((c) => !REPORT_CATEGORIES.includes(c as never));
  return [...known, ...extra];
}

function uniqNames(rows: Report[]): string[] {
  return [...new Set(rows.map((r) => r.stockName || r.title))];
}

function sourceLabel(s: string): string {
  return s === "hankyung" ? "한경" : s === "naver" ? "네이버" : s;
}

/** 시총(원) → "513.5조" / "8,234억". */
function fmtCap(won: number): string {
  if (won >= 1e12) return `${(won / 1e12).toFixed(1)}조`;
  return `${Math.round(won / 1e8).toLocaleString("ko-KR")}억`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
