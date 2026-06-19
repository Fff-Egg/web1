import WebSocket from "ws";
import type { BreadthQuote } from "../../shared/market.js";

/**
 * TradingView breadth quotes (S5FI / NDFI) via the public quote WebSocket.
 *
 * These symbols come from a barchart EOD feed and are NOT served by the
 * scanner.tradingview.com REST endpoint (it returns 0 rows), but the quote
 * WebSocket exposes them to anonymous sessions. The handshake REQUIRES an
 * `Origin: https://www.tradingview.com` header (a plain WS connect is refused
 * with a non-101 status), so we use the `ws` library rather than the global
 * WebSocket (which can't set request headers).
 *
 * Wire protocol: messages are framed as `~m~<len>~m~<json>`; heartbeats look
 * like `~m~<len>~m~~h~<n>` and must be echoed back verbatim.
 */
const WS_URL = "wss://data.tradingview.com/socket.io/websocket?from=screener%2F";

/** S&P 500 / Nasdaq 100 "stocks above 50-day average" breadth indices. */
const SYMBOLS = ["INDEX:S5FI", "INDEX:NDFI"] as const;

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

export interface BreadthResult {
  s5fi: BreadthQuote | null;
  ndfi: BreadthQuote | null;
}

export function fetchBreadth(timeoutMs = 20_000): Promise<BreadthResult> {
  return new Promise((resolve) => {
    const quotes: Record<string, BreadthQuote> = {};
    let settled = false;

    const ws = new WebSocket(WS_URL, {
      headers: {
        Origin: "https://www.tradingview.com",
        "User-Agent": "Mozilla/5.0",
      },
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
      resolve({
        s5fi: quotes["INDEX:S5FI"] ?? null,
        ndfi: quotes["INDEX:NDFI"] ?? null,
      });
    };

    const timer = setTimeout(finish, timeoutMs);

    ws.on("open", () => {
      const session = `qs_${Math.random().toString(36).slice(2, 12)}`;
      ws.send(frame("set_auth_token", ["unauthorized_user_token"]));
      ws.send(frame("quote_create_session", [session]));
      ws.send(frame("quote_set_fields", [session, "lp", "ch", "chp"]));
      for (const sym of SYMBOLS) ws.send(frame("quote_add_symbols", [session, sym]));
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      // Echo heartbeats so the server keeps the connection alive.
      if (raw.includes("~h~")) {
        ws.send(raw);
        return;
      }
      for (const part of payloads(raw)) {
        if (!part || part.startsWith("~h~")) continue;
        try {
          const o = JSON.parse(part) as { m?: string; p?: unknown[] };
          if (o.m !== "qsd" || !o.p) continue;
          const q = o.p[1] as { n?: string; v?: { lp?: number; ch?: number; chp?: number } };
          if (!q?.n || !q.v || typeof q.v.lp !== "number") continue;
          quotes[q.n] = {
            value: Math.round(q.v.lp * 100) / 100,
            change: typeof q.v.ch === "number" ? Math.round(q.v.ch * 100) / 100 : null,
            changePct: typeof q.v.chp === "number" ? Math.round(q.v.chp * 100) / 100 : null,
          };
        } catch {
          /* non-JSON control frame */
        }
      }
      // Resolve as soon as both symbols have arrived.
      if (quotes["INDEX:S5FI"] && quotes["INDEX:NDFI"]) finish();
    });

    ws.on("error", finish);
    ws.on("close", finish);
  });
}
