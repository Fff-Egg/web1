import type { FeedItem } from "../data/client.js";

/** Read deleted material without restoring it or making another LLM request. */
export function TrashFeedCard({
  item,
  checked,
  disabled,
  onToggle,
  onRestore,
  onPurge,
}: {
  item: FeedItem;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const title = item.title ?? "(제목 없음)";
  const bucket = item.needsSourceReview ? "원문 확인" : item.lowPriority ? "검토 대상" : "중요";
  const originalUrl = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;

  return (
    <li className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label={`선택: ${title}`}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="mt-1 h-4 w-4 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-medium">{title}</h4>
          <p className="mt-1 text-xs text-slate-500">
            {item.sourceLabel ?? item.provider} · 삭제 전 분류: {bucket}
            {item.saved ? " · ⭐저장" : ""}
          </p>
        </div>
      </div>

      {item.summary ? (
        <p className="whitespace-pre-wrap break-words text-sm text-slate-600">{item.summary}</p>
      ) : (
        <p className="text-xs text-slate-400">저장된 요약이 없습니다. 원문을 확인해 주세요.</p>
      )}
      {item.body && (
        <details className="text-sm text-slate-600">
          <summary className="cursor-pointer text-slate-500">수집된 본문 펼치기</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{item.body}</p>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {originalUrl && (
          <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            원문 보기 ↗
          </a>
        )}
        <button disabled={disabled} onClick={onRestore} className="rounded bg-blue-600 px-3 py-1 font-medium text-white disabled:opacity-50">
          복원
        </button>
        <button disabled={disabled} onClick={onPurge} className="ml-auto text-red-600 hover:underline disabled:opacity-50">
          영구삭제
        </button>
      </div>
    </li>
  );
}
