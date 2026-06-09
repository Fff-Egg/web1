import { registerAdapter } from "./registry.js";
import { genericRssAdapter } from "./genericRss.js";

/**
 * Register all source adapters here. Importing this module wires up the
 * provider registry. Phase 1 ships generic_rss; later phases add
 * naver_blog, hankyung, substack, fanding, naver_premium, x, generic_scrape.
 */
registerAdapter(genericRssAdapter);

export * from "./registry.js";
export * from "./types.js";
