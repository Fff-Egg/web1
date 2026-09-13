import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Source } from "../db/schema.js";
import type { NormalizedArticle } from "./types.js";
import type { ArticleContentMeta, ContentLink } from "../../shared/articleContent.js";
import { hasSession } from "../auth/session.js";
import { fetchWithSession } from "../auth/browser.js";

export function htmlToText(html: string): string {
  if (!/<(?:html|body|p|div|span|a|br|article|section|h[1-6])(?:\s|>)/i.test(html)) return html.trim();
  const { document } = parseHTML(`<html><body>${html.replace(/<\/(p|div|h[1-6]|li|tr|section)>|<br\s*\/?\s*>/gi, "$&\n")}</body></html>`);
  document.querySelectorAll("script,style,noscript,svg").forEach(el => el.remove());
  return document.body.textContent?.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() ?? "";
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Allow global unicast only; this also rejects mapped IPv4, loopback and ULA.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(?:db8|0|10):/i.test(address);
}

export async function publicTarget(raw: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw Error("접근할 수 없는 주소");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw Error("외부 원문 주소가 아님");
  return { url, ...addresses[0] };
}

/** Bounded public HTTP fetch. Pin the validated DNS result and recheck every redirect. */
export async function fetchArticlePage(raw: string, redirects = 0): Promise<{ html: string; url: string }> {
  if (redirects > 5) throw Error("원문 이동 횟수 초과");
  const { url, address, family } = await publicTarget(raw);
  const result = await new Promise<{ html?: string; redirect?: string }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      headers: { "User-Agent": "FeedWatch/1.0 (article reader)", Accept: "text/html,application/xhtml+xml,text/plain", "Accept-Encoding": "gzip, br, deflate" },
      lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return;
      }
      if (status !== 200) { res.resume(); reject(Error(status === 401 || status === 403 ? "로그인 또는 접근 권한 필요" : `원문 HTTP ${status}`)); return; }
      if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(res.headers["content-type"] ?? "")) { res.resume(); reject(Error("HTML/텍스트 외 첨부 형식")); return; }
      const enc = res.headers["content-encoding"];
      const decoder = enc === "gzip" ? createGunzip() : enc === "br" ? createBrotliDecompress() : enc === "deflate" ? createInflate() : null;
      const input = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = []; let size = 0;
      input.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(Error("원문 페이지 크기 제한 초과")); input.destroy(); return; }
        chunks.push(chunk);
      });
      input.on("error", reject); res.on("error", reject);
      input.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(res.headers["content-type"] ?? "")?.[1]
          ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 8192).toString("ascii"))?.[1] ?? "utf-8";
        try { resolve({ html: new TextDecoder(charset).decode(bytes) }); }
        catch { reject(Error("원문 문자 인코딩을 해석하지 못함")); }
      });
    });
    const timer = setTimeout(() => req.destroy(Error("원문 수집 시간 초과")), 15000);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end();
  });
  return result.redirect ? fetchArticlePage(result.redirect, redirects + 1) : { html: result.html!, url: url.href };
}

export function extractArticle(html: string, url: string, selector?: string): { text: string; title: string; partial: boolean } {
  const { document } = parseHTML(html);
  const title = document.querySelector("meta[property='og:title']")?.getAttribute("content") ?? document.title ?? "";
  const paid = /"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html);
  document.querySelectorAll("script,style,noscript,nav,footer,header,form,button,aside,[hidden],[aria-hidden='true']").forEach(el => el.remove());
  const target = selector ? document.querySelector(selector) : document.querySelector(".se-main-container, #dic_area, #articletxt, #article-body, .article-body, .body.markup");
  let text = target ? htmlToText(target.outerHTML) : "";
  if (!text) {
    // Linkedom never runs scripts or loads page resources.
    Object.defineProperty(document, "documentURI", { value: url, configurable: true });
    const parsed = new Readability(document as unknown as Document, { charThreshold: 120 }).parse();
    text = parsed?.content ? htmlToText(parsed.content) : "";
  }
  if (!text || text.length < 80) throw Error("원문 본문을 추출하지 못함");
  const wall = /(?:구독(?:자|권)|로그인|결제).{0,35}(?:계속 읽|전체 (?:내용|본문)|확인할 수|필요)|(?:subscribe|sign in|log in).{0,40}(?:continue reading|read (?:the rest|more)|unlock)/i.test(text);
  return { text, title, partial: paid || wall };
}

export function outboundLinks(body: string, supplied: string[] = []): string[] {
  const anchors = /<a\b/i.test(body) ? [...parseHTML(body).document.querySelectorAll("a[href]")].map(a => a.getAttribute("href") ?? "") : [];
  return [...new Set([...supplied, ...anchors, ...(body.match(/https?:\/\/[^\s<>"']+/g) ?? [])].map(s => s.replace(/[),.;\]}>]+$/, "")))].filter(raw => {
    try { return ["http:", "https:"].includes(new URL(raw).protocol); } catch { return false; }
  });
}

export async function enrichArticle(item: NormalizedArticle, source: Source, fetchPage = fetchArticlePage): Promise<NormalizedArticle> {
  const original = htmlToText(item.body ?? "");
  const social = source.provider === "x" || source.provider === "telegram";
  const meta: ArticleContentMeta = { version: 1, status: social ? "post" : "unknown", method: social ? "post" : "feed", checkedAt: new Date().toISOString(), links: [], sourceUrls: item.linkedUrls };
  let body = original;
  const read = async (url: string, useSession: boolean) => {
    try {
      let page = await fetchPage(url);
      // Desktop Naver blog is a shell around a public post iframe.
      if (new URL(page.url).hostname.endsWith("blog.naver.com")) {
        const frame = parseHTML(page.html).document.querySelector("iframe#mainFrame")?.getAttribute("src");
        if (frame) page = await fetchPage(new URL(frame, page.url).href);
      }
      const extracted = extractArticle(page.html, page.url, source.config?.bodySelector);
      if (!extracted.partial || !useSession || !hasSession(source.id)) return extracted;
    } catch (err) { if (!useSession || !hasSession(source.id)) throw err; }
    await publicTarget(url);
    const text = await fetchWithSession({ sourceId: source.id, url, bodySelector: source.config?.bodySelector, allowUrl: publicTarget });
    if (!text || text.length < 80) throw Error("로그인 원문 본문을 추출하지 못함");
    return { text, title: item.title ?? "", partial: /구독.{0,20}(?:필요|계속 읽)|subscribe to continue/i.test(text), session: true };
  };
  if (!social && item.url) {
    try {
      const full = await read(item.url, true);
      // A public paywall preview must never overwrite a fuller authenticated/RSS body.
      if (original.includes(full.text)) body = original;
      else if (full.text.includes(original)) body = full.text;
      else body = `${full.text}\n\n[피드 제공 본문 — 원문 추출과 대조용]\n${original}`;
      meta.status = full.partial ? "partial" : "extracted";
      meta.method = "session" in full ? "session" : "page";
      if (full.partial) meta.reason = "접근 가능한 내용만 확보";
    } catch (err) { meta.status = "partial"; meta.reason = err instanceof Error ? err.message : "원문 수집 실패"; }
  } else if (!social) { meta.reason = "원문 주소 없음"; }
  if (social) {
    const urls = outboundLinks(item.body ?? "", item.linkedUrls).filter(url => {
      const host = new URL(url).hostname.toLowerCase();
      return url !== item.url && !(host === "t.co" && item.linkedUrls?.length);
    });
    for (const url of urls) {
      const link: ContentLink = { url, status: "unavailable" };
      try {
        const full = await read(url, false);
        if (full.partial) link.reason = "연결 원문 일부만 확보";
        else link.status = "extracted";
        link.title = full.title;
        body += `\n\n[연결 원문 — 게시글 작성자의 말과 구분]\n제목: ${full.title}\n주소: ${url}\n${full.text}`;
      } catch (err) { link.reason = err instanceof Error ? err.message : "연결 원문 수집 실패"; }
      meta.links.push(link);
    }
    if (meta.links.some(x => x.status === "unavailable")) meta.status = "partial";
  }
  return { ...item, body, contentMeta: meta };
}
