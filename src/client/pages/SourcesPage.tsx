import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { PROVIDER_LIST } from "../../shared/providers.js";
import type { Provider } from "../../server/db/schema.js";

const AUTH_PROVIDERS = new Set(PROVIDER_LIST.filter((p) => p.requiresAuth).map((p) => p.provider));

export function SourcesPage() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sources"] });
    qc.invalidateQueries({ queryKey: ["sessions"] });
  };

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.listSources() });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.listSessions() });
  const create = useMutation({ mutationFn: api.createSource, onSuccess: invalidate });
  const toggle = useMutation({
    mutationFn: (v: { id: number; enabled: boolean }) => api.toggleSource(v.id, v.enabled),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeSource(id),
    onSuccess: invalidate,
  });
  const update = useMutation({ mutationFn: api.updateSource, onSuccess: invalidate });

  const [provider, setProvider] = useState<Provider>("generic_rss");
  const [identifier, setIdentifier] = useState("");
  const [label, setLabel] = useState("");

  const preset = useMemo(
    () => PROVIDER_LIST.find((p) => p.provider === provider),
    [provider],
  );
  const sessionById = useMemo(() => {
    const m = new Map<number, boolean>();
    sessions.data?.forEach((s) => m.set(s.id, s.hasSession));
    return m;
  }, [sessions.data]);

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    create.mutate(
      { provider, identifier: identifier.trim(), label: label.trim() || undefined },
      {
        onSuccess: () => {
          setIdentifier("");
          setLabel("");
        },
      },
    );
  };

  return (
    <div className="space-y-8">
      {/* ── Add form ── */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold">소스 추가</h2>
        <form onSubmit={onAdd} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">프로바이더</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
              >
                {PROVIDER_LIST.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">라벨 (선택)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="표시 이름"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">식별자</span>
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={preset?.placeholder}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            />
            {preset && <p className="mt-1 text-xs text-slate-500">{preset.hint}</p>}
          </label>

          {preset?.requiresAuth && (
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
              🔒 로그인이 필요한 소스입니다. <strong>먼저 추가</strong>한 뒤, 목록의 해당 소스에서
              안내되는 <code>로그인</code> 명령을 실행하면 브라우저가 떠서 <strong>내 아이디·비번으로
              직접 로그인</strong>합니다. 비밀번호는 저장되지 않고, 로그인된 세션만 보관됩니다.
            </div>
          )}

          <button
            type="submit"
            disabled={create.isPending || !identifier.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? "추가 중…" : "추가"}
          </button>
          {create.error && (
            <p className="text-sm text-red-600">에러: {(create.error as Error).message}</p>
          )}
        </form>
      </section>

      {/* ── List ── */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">
          소스 목록 {sources.data ? `(${sources.data.length})` : ""}
        </h2>
        {sources.isLoading && <p className="text-slate-500">로딩…</p>}
        {sources.error && (
          <p className="text-red-600">불러오기 실패: {(sources.error as Error).message}</p>
        )}
        <ul className="space-y-2">
          {sources.data?.map((s) => {
            const needsAuth = AUTH_PROVIDERS.has(s.provider);
            const loggedIn = sessionById.get(s.id) ?? false;
            return (
              <li
                key={s.id}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.label ?? s.identifier}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        {s.provider}
                      </span>
                      {needsAuth && (
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-xs " +
                            (loggedIn
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700")
                          }
                        >
                          {loggedIn ? "로그인됨 ✓" : "로그인 필요"}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-slate-400">{s.identifier}</div>
                    {s.lastError && (
                      <div className="truncate text-xs text-red-500">⚠ {s.lastError}</div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const next = window.prompt("라벨 수정", s.label ?? "");
                        if (next !== null) update.mutate({ id: s.id, label: next });
                      }}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      편집
                    </button>
                    <button
                      onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                      className={
                        "rounded px-2 py-1 text-xs font-medium " +
                        (s.enabled
                          ? "bg-green-100 text-green-700"
                          : "bg-slate-100 text-slate-500")
                      }
                    >
                      {s.enabled ? "on" : "off"}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`삭제: ${s.label ?? s.identifier}?`))
                          remove.mutate(s.id);
                      }}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      삭제
                    </button>
                  </div>
                </div>

                {needsAuth && !loggedIn && (
                  <div className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    로그인하려면 서버에서 실행:{" "}
                    <code className="rounded bg-slate-200 px-1">
                      npm run login -- --source={s.id}
                    </code>{" "}
                    → 브라우저에서 내 아이디·비번으로 로그인 후 Enter.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
