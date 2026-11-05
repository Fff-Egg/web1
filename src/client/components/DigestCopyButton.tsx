import { useEffect, useRef, useState } from "react";

/** Copy readable prose, including collapsed references, without HTML or jump controls. */
function digestText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(".ref-back, script, style").forEach((node) => node.remove());
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    const text = Array.from(node.childNodes, read).join("");
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "A" && !node.closest("sup.cite")) {
      const href = node.getAttribute("href");
      if (href && !href.startsWith("#")) {
        try {
          const url = new URL(href, window.location.href);
          if (["http:", "https:"].includes(url.protocol) && text.trim() !== url.href) {
            return `${text} (${url.href})`;
          }
        } catch { /* Keep the label if a stored link is invalid. */ }
      }
    }
    if (node.tagName === "LI") {
      const reference = node.id.match(/^ref-(\d+)$/);
      const parent = node.parentElement;
      const number = parent?.tagName === "OL"
        ? Number(parent.getAttribute("start") ?? 1) + Array.from(parent.children).indexOf(node)
        : null;
      const prefix = reference ? `[${reference[1]}]` : number === null ? "•" : `${number}.`;
      return `\n${prefix} ${text.trim()}\n`;
    }
    if (["TD", "TH"].includes(node.tagName)) return `${text.trim()}\t`;
    if (node.tagName === "TR") return `${text.trim()}\n`;
    if (/^(H[1-6]|P|DIV|SECTION|BLOCKQUOTE|PRE|UL|OL|DETAILS|SUMMARY|TABLE|HR)$/.test(node.tagName)) {
      return `\n\n${text.trim()}\n\n`;
    }
    return text;
  };
  return Array.from(doc.body.childNodes, read).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function DigestCopyButton({ html }: { html: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [manualText, setManualText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(() => () => { clearTimeout(timer.current); attempt.current += 1; }, []);

  const copy = async () => {
    const current = ++attempt.current;
    clearTimeout(timer.current);
    const text = digestText(html);
    setState("copying");
    try {
      await navigator.clipboard.writeText(text);
      if (attempt.current !== current) return;
      setState("copied");
      setManualText("");
      timer.current = setTimeout(() => setState("idle"), 2500);
    } catch {
      if (attempt.current !== current) return;
      setManualText(text);
      setState("failed");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span role="status" className="text-xs text-emerald-700">
          {state === "copied" ? "전체 내용을 복사했습니다." : ""}
        </span>
        <button
          type="button"
          onClick={copy}
          disabled={state === "copying" || !html.trim()}
          title="제목·본문·참조 원문 링크를 한 번에 복사"
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {state === "copying" ? "복사 중…" : state === "copied" ? "✓ 복사 완료" : "📋 전체 복사"}
        </button>
      </div>
      {state === "failed" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p role="alert" className="mb-2 text-sm text-amber-800">자동 복사가 차단되었습니다. 아래 내용을 선택해 복사해 주세요.</p>
          <textarea
            aria-label="다이제스트 전체 내용"
            readOnly
            value={manualText}
            onFocus={(event) => event.currentTarget.select()}
            className="h-48 w-full rounded border border-slate-300 bg-white p-2 text-sm"
          />
        </div>
      )}
    </div>
  );
}
