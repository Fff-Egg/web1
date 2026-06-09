import { registerAdapter } from "./registry.js";
import { genericRssAdapter } from "./genericRss.js";
import { naverBlogAdapter } from "./naverBlog.js";
import { hankyungAdapter } from "./hankyung.js";
import { substackAdapter } from "./substack.js";

/**
 * Register all source adapters here. Importing this module wires up the
 * provider registry. Phase 1–2 ship the rss-based public providers; later
 * phases add fanding, naver_premium, x, generic_scrape (auth/scrape).
 */
registerAdapter(genericRssAdapter);
registerAdapter(naverBlogAdapter);
registerAdapter(hankyungAdapter);
registerAdapter(substackAdapter);

export * from "./registry.js";
export * from "./types.js";
