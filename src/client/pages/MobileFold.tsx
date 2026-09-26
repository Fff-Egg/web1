import { useEffect, useState, type ReactNode } from "react";

/**
 * 모바일에서만 긴 보조 내용을 접어 핵심 수치를 먼저 보여준다.
 * 데스크톱(sm+)에서는 화면 크기를 감지해 항상 열린 상태로 표시한다.
 */
export function MobileFold({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 640px)").matches : true,
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <details
      open={desktop || mobileOpen}
      onToggle={(event) => {
        if (!desktop) setMobileOpen(event.currentTarget.open);
      }}
      className={`mobile-fold group ${className}`}
    >
      <summary className="mobile-fold-summary flex min-h-11 cursor-pointer list-none items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-600 sm:hidden">
        <span>{label}</span>
        <span aria-hidden="true" className="mobile-fold-chevron ml-2 text-base text-slate-400 transition-transform">
          ⌄
        </span>
      </summary>
      <div className="mobile-fold-content">{children}</div>
    </details>
  );
}
