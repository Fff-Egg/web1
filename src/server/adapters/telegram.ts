import { eq } from "drizzle-orm";
import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { SessionRequiredError } from "./types.js";
import { db } from "../db/client.js";
import { sources } from "../db/schema.js";
import { getTelegram, hasTelegram } from "../telegram/client.js";

/** Normalize @name / t.me/name / https://t.me/name → name. */
function channelRef(identifier: string): string {
  return identifier
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "");
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
    const ref = channelRef(source.identifier);
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

    return [
      {
        externalId: `${ref}:${cursor}-${maxId}`,
        url: `https://t.me/${ref}/${maxId}`,
        title: `텔레그램 ${source.label ?? ref} — 메시지 ${fresh.length}건`,
        body,
        author: source.label ?? ref,
        publishedAt: last.date ? new Date(last.date * 1000) : null,
      },
    ];
  },
};
