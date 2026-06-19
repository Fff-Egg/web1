import WebSocket from "ws";
import type { BreadthQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * TradingView breadth (S5FI / NDFI) via the public chart-history WebSocket.
 *
 * These symbols come from a barchart EOD feed and are NOT served by the
 * scanner.tradingview.com REST endpoint (it returns 0 rows), but the chart
 * WebSocket exposes ~1 year of daily bars to anonymous sessions. The handshake
 * REQUIRES an `Origin: https://www.tradingview.com` header (a plain WS connect
 * is refused with a non-101 status), so we use the `ws` library rather than the
 * global WebSocket (which can't set request headers).
 *
 * We pull the daily series for the charts and derive the "current" quote
 * (value + day-over-day change) from the last two bars, so the number on the
 * card and the line on the chart always agree.
 *
 * Wire protocol: messages are framed as `~m~<len>~m~<json>`; heartbeats look
 * like `~m~<len>~m~~h~<n>` and must be echoed back verbatim.
 */
const WS_URL = "wss://data.tradingview.com/socket.io/websocket?from=chart%2F";

const BARS = 400; // ~1.5 trading years; sliced to 1y after.

function frame(m: string, p: unknown[]): string {
  const j = JSON.stringify({ m, p });
  return `~m~${j.length}~m~${j}`;
}

/** Split a raw socket message into its individual `~m~<len>~m~` payloads. */
function payloads(raw: string): string[] {
  const out: string[] = [];
  const re = /~m~(\d+)~m~/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const len = Number(match[1]);
    const start = re.lastIndex;
    out.push(raw.slice(start, start + len));
    re.lastIndex = start + len;
  }
  return out;
}

export interface BreadthSeries {
  quote: BreadthQuote | null;
  history: SeriesPoint[];
}

export interface BreadthResult {
  s5fi: BreadthSeries;
  ndfi: BreadthSeries;
  /** CBOE Volatility Index (VIX). */
  vix: BreadthSeries;
}

interface Bar {
  v: number[]; // [time(s), open, high, low, close, volume]
}

/** Turn raw TradingView bars into a daily close series + a derived quote. */
function toSeries(bars: Bar[] | undefined): BreadthSeries {
  if (!bars || bars.length === 0) return { quote: null, history: [] };
  const history = sliceLastYear(
    bars
      .filter((b) => Array.isArray(b.v) && typeof b.v[0] === "number" && typeof b.v[4] === "number")
      .map((b) => ({ t: b.v[0] * 1000, v: Math.round(b.v[4] * 100) / 100 })),
  );
  let quote: BreadthQuote | null = null;
  if (history.length > 0) {
    const last = history[history.length - 1].v;
    const prev = history.length > 1 ? history[history.length - 2].v : null;
    quote = {
      value: last,
      change: prev !== null ? Math.round((last - prev) * 100) / 100 : null,
      changePct: prev ? Math.round(((last - prev) / prev) * 10000) / 100 : null,
    };
  }
  return { quote, history };
}

/**
 * Fetch daily bars for ONE symbol. An anonymous chart session is limited to a
 * single series ("exceed limit of series in the session"), so each symbol gets
 * its own short-lived connection; the caller runs them in parallel.
 */
function fetchBars(symbol: string, timeoutMs: number): Promise<Bar[]> {
  return new Promise((resolve) => {
    let bars: Bar[] = [];
    let settled = false;

    const ws = new WebSocket(WS_URL, {
      headers: { Origin: "https://www.tradingview.com", "User-Agent": "Mozilla/5.0" },
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(bars);
    };
    const timer = setTimeout(finish, timeoutMs);

    ws.on("open", () => {
      const cs = `cs_${Math.random().toString(36).slice(2, 12)}`;
      ws.send(frame("set_auth_token", ["unauthorized_user_token"]));
      ws.send(frame("chart_create_session", [cs, ""]));
      ws.send(frame("resolve_symbol", [cs, "sym1", `={"symbol":"${symbol}","adjustment":"splits"}`]));
      ws.send(frame("create_series", [cs, "s1", "s1", "sym1", "1D", BARS, ""]));
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw.includes("~h~")) {
        ws.send(raw);
        return;
      }
      for (const part of payloads(raw)) {
        if (!part || part.startsWith("~h~")) continue;
        try {
          const o = JSON.parse(part) as { m?: string; p?: unknown[] };
          if (o.m !== "timescale_update" || !o.p) continue;
          const upd = o.p[1] as Record<string, { s?: Bar[] }>;
          if (upd.s1?.s && upd.s1.s.length) {
            bars = upd.s1.s;
            finish();
          }
        } catch {
          /* control frame */
        }
      }
    });

    ws.on("error", finish);
    ws.on("close", finish);
  });
}

export async function fetchBreadth(timeoutMs = 22_000): Promise<BreadthResult> {
  const [s5, nd, vix] = await Promise.all([
    fetchBars("INDEX:S5FI", timeoutMs),
    fetchBars("INDEX:NDFI", timeoutMs),
    fetchBars("CBOE:VIX", timeoutMs),
  ]);
  return { s5fi: toSeries(s5), ndfi: toSeries(nd), vix: toSeries(vix) };
}
