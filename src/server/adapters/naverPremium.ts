import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchAuthList } from "./authList.js";

/**
 * naver_premium — paid Naver Premium Content. Renders the channel URL with the
 * stored login session, collects post links, and pulls the newest bodies.
 * Log in once via `npm run login -- --source=<id>`.
 */
export const naverPremiumAdapter: SourceAdapter = {
  provider: "naver_premium",
  label: "네이버 프리미엄콘텐츠",
  requiresAuth: true,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    return fetchAuthList(source, { loginUrlHints: ["nidlogin", "nid.naver.com"] });
  },
};
