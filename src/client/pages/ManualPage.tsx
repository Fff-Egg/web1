import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { PendingArticle } from "../data/client.js";
import { buildManualPrompt, parseAnalysisJson } from "../../shared/analysis.js";
import { PROVIDER_PRESETS } from "../../shared/providers.js";

/** Order groups are shown in; any unlisted provider falls to the end. */
const GROUP_ORDER = [
  "naver_blog",
  "x",
  "hankyung",
  "generic_rss",
  "substack",
  "naver_premium",
  "fanding",
] as const;

function providerLabel(provider: string): string {
  return PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]?.label ?? provider;
}

/**
 * Manual analysis (for Claude Max users, no API key):
 *  1) Copy the article + instructions block, paste into claude.ai
 *  2) Paste Claude's JSON answer back here, Save → it lands in Feed/Digest.
 */
export function ManualPage() {
  const cfg = useQuery({ queryKey: ["analysisConfig"], queryFn: () => api.getAnalysisConfig() });
  const pending = useQuery({ queryKey: ["pending"], queryFn: () => api.listPending() });

  // Group pending articles by source type (네이버 블로그 / X / 한경 / RSS …).
  const groups = useMemo(() => {
    const byProvider = new Map<string, PendingArticle[]>();
    for (const art of pending.data ?? []) {
      const arr = byProvider.get(art.provider) ?? [];
      arr.push(art);
      byProvider.set(art.provider, arr);
    }
    const ordered: { provider: string; items: PendingArticle[] }[] = [];
    for (const p of GROUP_ORDER) {
      const items = byProvider.get(p);
      if (items) {
        ordered.push({ provider: p, items });
        byProvider.delete(p);
      }
    }
    for (const [provider, items] of byProvider) ordered.push({ provider, items });
    return ordered;
  }, [pending.data]);

  return (
    <div className="space-y-6">
      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <strong>수동 분석 모드</strong> — API 키 없이 Claude Max로 분석합니다. 각 글의{" "}
        <em>복사</em>를 눌러 claude.ai에 붙여넣고, 돌아온 JSON 답변을 아래 칸에 붙여넣어 저장하세요.
      </div>

      {pending.isLoading && <p className="text-slate-500">로딩…</p>}
      {pending.error && <p className="text-red-600">{(pending.error as Error).message}</p>}
      {pending.data && pending.data.length === 0 && (
        <p className="text-slate-500">분석할 새 글이 없습니다. (소스에서 글이 수집되면 여기에 쌓입니다)</p>
      )}

      {groups.map((g) => (
        <section key={g.provider}>
          <h3 className="mb-2 flex items-center gap-2 border-b border-slate-200 pb-1 text-sm font-semibold text-slate-700">
            <span>{providerLabel(g.provider)}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-600">
              {g.items.length}
            </span>
          </h3>
          <ul className="space-y-3">
            {g.items.map((art) => (
              <ManualCard key={art.id} article={art} instructions={cfg.data?.instructions ?? ""} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ManualCard({ article, instructions }: { article: PendingArticle; instructions: string }) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pending"] });
    qc.invalidateQueries({ queryKey: ["feed"] });
  };
  const save = useMutation({ mutationFn: api.saveManualAnalysis, onSuccess: invalidate });
  const skip = useMutation({ mutationFn: (id: number) => api.skipPending(id), onSuccess: invalidate });

  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const promptText = buildManualPrompt(instructions, {
    title: article.title,
    url: article.url,
    source: article.sourceLabel,
    body: article.body,
  });

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — select fallback handled by the textarea below
      setCopied(false);
    }
  };

  const onSave = () => {
    const parsed = parseAnalysisJson(answer);
    if (!parsed) {
      setParseError("JSON을 읽지 못했습니다. Claude 답변(JSON)을 그대로 붙여넣었는지 확인하세요.");
      return;
    }
    setParseError(null);
    save.mutate({ articleId: article.id, ...parsed });
  };

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{article.title ?? "(제목 없음)"}</div>
          <div className="text-xs text-slate-400">{article.sourceLabel ?? article.provider}</div>
        </div>
        {article.url && (
          <a href={article.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-blue-600 hover:underline">
            원문 ↗
          </a>
        )}
      </div>

      {article.body && (
        <p className="mt-2 line-clamp-2 text-sm text-slate-500">{article.body.slice(0, 160)}…</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={onCopy}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          📋 Claude에 붙여넣을 내용 복사
        </button>
        {copied && <span className="text-xs text-green-600">복사됨 ✓ → claude.ai에 붙여넣기</span>}
        <button onClick={() => skip.mutate(article.id)} className="text-xs text-slate-400 hover:text-slate-700">
          건너뛰기
        </button>
      </div>

      <details className="mt-2 text-xs text-slate-500">
        <summary className="cursor-pointer">붙여넣을 내용 미리보기</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2">{promptText}</pre>
      </details>

      <div className="mt-3">
        <label className="text-sm font-medium text-slate-700">Claude 답변(JSON) 붙여넣기</label>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={4}
          placeholder='{ "summary": "...", "implications": "...", "tickers": [], "themes": [], "impact": "neutral" }'
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={save.isPending || !answer.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {save.isPending ? "저장 중…" : "저장"}
          </button>
          {save.isSuccess && <span className="text-xs text-green-600">저장됨 ✓</span>}
          {parseError && <span className="text-xs text-red-600">{parseError}</span>}
          {save.error && <span className="text-xs text-red-600">{(save.error as Error).message}</span>}
        </div>
      </div>
    </li>
  );
}
