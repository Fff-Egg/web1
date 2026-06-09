import { chromium } from "playwright";
import { storageStateFor } from "./session.js";
import { SessionRequiredError } from "../adapters/types.js";

/**
 * Render a page using a source's stored login session and extract text.
 * Throws SessionRequiredError if there is no session, or if the page looks
 * like a login wall (session expired) — the worker then flags it for re-login
 * instead of auto-relogging in.
 */
export async function fetchWithSession(opts: {
  sourceId: number;
  url: string;
  bodySelector?: string;
  /** substrings in the final URL that indicate we got bounced to a login page */
  loginUrlHints?: string[];
}): Promise<string> {
  const statePath = storageStateFor(opts.sourceId);
  if (!statePath) {
    throw new SessionRequiredError(
      `source-${opts.sourceId}`,
      "로그인 세션이 없습니다. `npm run login -- --source=<id>` 로 먼저 로그인하세요.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const finalUrl = page.url();
    const hints = opts.loginUrlHints ?? ["login", "signin", "sign-in", "nidlogin"];
    if (hints.some((h) => finalUrl.toLowerCase().includes(h))) {
      throw new SessionRequiredError(
        `source-${opts.sourceId}`,
        "세션이 만료된 것 같습니다 (로그인 페이지로 이동됨). 다시 로그인하세요.",
      );
    }

    if (opts.bodySelector) {
      const el = page.locator(opts.bodySelector).first();
      if (await el.count()) return (await el.innerText()).trim();
    }
    // Fallback: main/article text, else full body text.
    const main = page.locator("article, main").first();
    if (await main.count()) return (await main.innerText()).trim();
    return (await page.locator("body").innerText()).trim();
  } finally {
    await browser.close();
  }
}

export interface PostLink {
  url: string;
  title: string;
}

/**
 * Render a list/channel page with the source's session and collect post links.
 * `linkSelector` (from source config) can pin the anchors; otherwise we take
 * anchors inside main/article. Dedupes by URL and keeps anchors with text.
 */
export async function listLinksWithSession(opts: {
  sourceId: number;
  url: string;
  linkSelector?: string;
  limit?: number;
}): Promise<PostLink[]> {
  const statePath = storageStateFor(opts.sourceId);
  if (!statePath) {
    throw new SessionRequiredError(
      `source-${opts.sourceId}`,
      "로그인 세션이 없습니다. `npm run login -- --source=<id>` 로 먼저 로그인하세요.",
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const selector = opts.linkSelector ?? "article a[href], main a[href]";
    const anchors = await page.locator(selector).evaluateAll((els) =>
      els.map((a) => ({
        url: (a as HTMLAnchorElement).href,
        title: (a.textContent ?? "").trim(),
      })),
    );

    const seen = new Set<string>();
    const out: PostLink[] = [];
    for (const a of anchors) {
      if (!a.url || !a.title || seen.has(a.url)) continue;
      seen.add(a.url);
      out.push(a);
      if (out.length >= (opts.limit ?? 20)) break;
    }
    return out;
  } finally {
    await browser.close();
  }
}

export interface SessionItem {
  url: string | null;
  text: string;
}

/**
 * Render a page with the session and extract repeated items (e.g. tweets):
 * for each `itemSelector` element, its innerText and an optional inner link.
 */
export async function extractItemsWithSession(opts: {
  sourceId: number;
  url: string;
  itemSelector: string;
  linkSelector?: string;
  limit?: number;
}): Promise<SessionItem[]> {
  const statePath = storageStateFor(opts.sourceId);
  if (!statePath) {
    throw new SessionRequiredError(
      `source-${opts.sourceId}`,
      "로그인 세션이 없습니다. `npm run login -- --source=<id>` 로 먼저 로그인하세요.",
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000); // let dynamic content render

    const linkSel = opts.linkSelector ?? "a[href]";
    const items = await page.locator(opts.itemSelector).evaluateAll(
      (els, linkSelector) =>
        els.map((el) => {
          const link = el.querySelector(linkSelector) as HTMLAnchorElement | null;
          return { url: link?.href ?? null, text: (el.textContent ?? "").trim() };
        }),
      linkSel,
    );

    const seen = new Set<string>();
    const out: SessionItem[] = [];
    for (const it of items) {
      if (!it.text) continue;
      const key = it.url ?? it.text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
      if (out.length >= (opts.limit ?? 20)) break;
    }
    return out;
  } finally {
    await browser.close();
  }
}
