import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchAuthList } from "./authList.js";

/**
 * fanding — creator page (e.g. https://fanding.kr/@sesang101/). Member-only
 * posts need a session; public posts work too. Renders the creator page with
 * the saved session, collects post links, and pulls the newest bodies.
 * Log in once via `npm run login -- --source=<id>`.
 */
export const fandingAdapter: SourceAdapter = {
  provider: "fanding",
  label: "Fanding",
  requiresAuth: true,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    return fetchAuthList(source, { loginUrlHints: ["login", "signin"] });
  },
};
