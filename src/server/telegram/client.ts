import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

/**
 * Telegram (MTProto user session). We read public channels the logged-in
 * account is subscribed to. Configure via env:
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH  (from https://my.telegram.org)
 *   TELEGRAM_SESSION                     (string session — run `npm run telegram:login` once)
 */
export function hasTelegram(): boolean {
  return Boolean(
    process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION,
  );
}

let _client: TelegramClient | null = null;
let _connecting: Promise<TelegramClient> | null = null;

/** Lazily connect a single shared client and keep it alive across fetches. */
export async function getTelegram(): Promise<TelegramClient> {
  if (_client) return _client;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const session = process.env.TELEGRAM_SESSION;
    if (!apiId || !apiHash || !session) {
      throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set");
    }
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    _client = client;
    return client;
  })();
  return _connecting;
}
