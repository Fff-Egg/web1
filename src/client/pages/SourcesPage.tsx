import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { PROVIDER_LIST } from "../../shared/providers.js";
import type { Provider } from "../../server/db/schema.js";

export function SourcesPage() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["sources"] });

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.listSources() });
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
  const [credentialRef, setCredentialRef] = useState("");

  const preset = useMemo(
    () => PROVIDER_LIST.find((p) => p.provider === provider),
    [provider],
  );

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    create.mutate(
      {
        provider,
        identifier: identifier.trim(),
        label: label.trim() || undefined,
        config:
          preset?.requiresAuth && credentialRef.trim()
            ? { credentialRef: credentialRef.trim() }
            : undefined,
      },
      {
        onSuccess: () => {
          setIdentifier("");
          setLabel("");
          setCredentialRef("");
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
                    {!p.implemented ? " (예정)" : ""}
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
            <div className="rounded border border-amber-200 bg-amber-50 p-3">
              <label className="block">
                <span className="text-sm font-medium text-amber-800">
                  credentialRef (자격증명 키 이름)
                </span>
                <input
                  value={credentialRef}
                  onChange={(e) => setCredentialRef(e.target.value)}
                  placeholder="예: X_MAIN  →  CRED_X_MAIN_USER / CRED_X_MAIN_PASS"
                  className="mt-1 w-full rounded border border-amber-300 px-3 py-2 font-mono text-sm"
                />
              </label>
              <p className="mt-1 text-xs text-amber-700">
                비밀번호는 입력하지 않습니다. 환경변수에 <code>CRED_&lt;REF&gt;_USER</code> /
                <code>CRED_&lt;REF&gt;_PASS</code>로 두고, 첫 로그인은{" "}
                <code>npm run login -- --source=&lt;REF&gt;</code>로 세션을 저장하세요. (Phase 5)
              </p>
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
          {sources.data?.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.label ?? s.identifier}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    {s.provider}
                  </span>
                  {s.sessionStatus && (
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-xs " +
                        (s.sessionStatus === "valid"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700")
                      }
                    >
                      세션: {s.sessionStatus}
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
                    (s.enabled ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500")
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
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
