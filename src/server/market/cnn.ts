import type { FearGreed } from "../../shared/market.js";

/**
 * CNN Fear & Greed Index via the unofficial dataviz JSON endpoint.
 *
 * The endpoint rejects bots (HTTP 418 "I'm a teapot") unless it gets a
 * browser-like UA *and* a CNN Origin/Referer — both are required.
 */
const URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://edition.cnn.com",
  Referer: "https://edition.cnn.com/",
};

interface CnnPayload {
  fear_and_greed?: {
    score?: number;
    rating?: string;
    timestamp?: string;
    previous_close?: number;
    previous_1_week?: number;
    previous_1_month?: number;
    previous_1_year?: number;
  };
}

export async function fetchFearGreed(timeoutMs = 20_000): Promise<FearGreed> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(URL, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`CNN F&G HTTP ${res.status}`);
    const json = (await res.json()) as CnnPayload;
    const fg = json.fear_and_greed;
    if (!fg || typeof fg.score !== "number") throw new Error("CNN F&G: unexpected payload");
    const round = (n: number | undefined) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);
    return {
      score: Math.round(fg.score * 10) / 10,
      rating: fg.rating ?? "",
      prevClose: round(fg.previous_close),
      week: round(fg.previous_1_week),
      month: round(fg.previous_1_month),
      year: round(fg.previous_1_year),
      asOf: fg.timestamp ?? null,
    };
  } finally {
    clearTimeout(t);
  }
}
