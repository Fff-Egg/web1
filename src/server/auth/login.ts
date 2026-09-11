import "dotenv/config";
import readline from "node:readline";
import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { sources } from "../db/schema.js";
import { ensureSessionsDir, sessionPath } from "./session.js";
import { loginUrlFor } from "./providers.js";

/**
 * Interactive login: opens a real (headed) browser at the provider's login
 * page, you log in yourself with your ID/password (+2FA/captcha), then we save
 * the session. The password is never seen or stored by this app.
 *
 *   npm run login -- --source=<sourceId>
 *
 * Requires a machine with a display and `npx playwright install chromium`.
 */
async function main() {
  const arg = process.argv.find((a) => a.startsWith("--source="));
  const sourceId = arg ? Number(arg.split("=")[1]) : NaN;
  if (!Number.isFinite(sourceId)) {
    console.error("Usage: npm run login -- --source=<sourceId>");
    process.exit(1);
  }
  if (!hasDb) {
    console.error("DATABASE_URL is required to look up the source.");
    process.exit(1);
  }

  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    console.error(`No source with id=${sourceId}`);
    process.exit(1);
  }

  const url = loginUrlFor(source.provider) ?? source.identifier;
  console.log(`\n[login] provider=${source.provider} (${source.label ?? source.identifier})`);
  if (source.provider === "x") {
    console.log(
      "[login] ⚠ X 계정 자동화는 정지 위험이 있습니다. 가능하면 X API 사용을 권장합니다.",
    );
  }

  ensureSessionsDir();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  console.log(`\n브라우저에서 직접 로그인하세요 (아이디/비번/2FA).`);
  console.log(`로그인이 끝나면 이 터미널에서 Enter 를 누르세요...`);
  await waitForEnter();

  await context.storageState({ path: sessionPath(sourceId) });
  await browser.close();

  await db
    .update(sources)
    .set({ sessionStatus: "valid", lastError: null })
    .where(eq(sources.id, sourceId));

  console.log(`\n[login] 세션 저장 완료 → ${sessionPath(sourceId)}`);
  process.exit(0);
}

function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question("", () => { rl.close(); resolve(); }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
