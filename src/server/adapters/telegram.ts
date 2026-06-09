import { eq } from "drizzle-orm";
import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { SessionRequiredError } from "./types.js";
import { db } from "../db/client.js";
import { sources } from "../db/schema.js";
import { getTelegram, hasTelegram, ensureEntities } from "../telegram/client.js";

/**
 * Normalize an identifier to either a public username (string) or a numeric
 * channel id (number, for private channels):
 *   @name / t.me/name → "name"
 *   -1001234567890    → -1001234567890 (number)
 */
function parseRef(identifier: string): string | number {
  const s = identifier
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "");
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

/**
 * telegram — bundles NEW messages from a channel/chat since the last fetch into
 * ONE batched article (chat isn't feed-like). Tracks a per-source cursor
 * (config.lastMessageId). Reads via the logged-in user session (public channels
 * you're subscribed to). No login = SessionRequiredError.
 */
export const telegramAdapter: SourceAdapter = {
  provider: "telegram",
  label: "Telegram",
  requiresAuth: true,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    if (!hasTelegram()) {
      throw new SessionRequiredError(
        "telegram",
        "텔레그램 세션 미설정 — TELEGRAM_API_ID/HASH/SESSION 필요 (npm run telegram:login)",
      );
    }
    const client = await getTelegram();
    await ensureEntities(client); // needed to resolve private channels by id
    const ref = parseRef(source.identifier);
    const cursor = source.config?.lastMessageId ?? 0;
    const limit = source.config?.maxItems ?? 50;

    const msgs = await client.getMessages(ref, { limit, minId: cursor });
    const fresh = msgs
      .filter((m) => m.id > cursor && Boolean(m.message))
      .sort((a, b) => a.id - b.id);
    if (fresh.length === 0) return [];

    const maxId = fresh[fresh.length - 1].id;
    const last = fresh[fresh.length - 1];
    const body = fresh
      .map((m) => {
        const hhmm = m.date ? new Date(m.date * 1000).toISOString().slice(11, 16) : "--:--";
        return `[${hhmm}] ${m.message}`;
      })
      .join("\n");

    // Persist the cursor so the next fetch only grabs newer messages.
    await db
      .update(sources)
      .set({ config: { ...(source.config ?? {}), lastMessageId: maxId } })
      .where(eq(sources.id, source.id));

    const refStr = String(ref);
    const name = source.label ?? refStr;
    return [
      {
        externalId: `${refStr}:${cursor}-${maxId}`,
        // Public channels get a deep link; private channels have no public URL.
        url: typeof ref === "string" ? `https://t.me/${ref}/${maxId}` : null,
        title: `텔레그램 ${name} — 메시지 ${fresh.length}건`,
        body,
        author: name,
        publishedAt: last.date ? new Date(last.date * 1000) : null,
      },
    ];
  },
};
