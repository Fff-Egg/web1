import { registerAdapter } from "./registry.js";
import { genericRssAdapter } from "./genericRss.js";
import { naverBlogAdapter } from "./naverBlog.js";
import { hankyungAdapter } from "./hankyung.js";
import { substackAdapter } from "./substack.js";
import { naverPremiumAdapter } from "./naverPremium.js";
import { fandingAdapter } from "./fanding.js";
import { xAdapter } from "./x.js";

/**
 * Register all source adapters here. Importing this module wires up the
 * provider registry. Public rss providers + authenticated (session) providers:
 * substack (paid enrich), naver_premium, fanding, x.
 */
registerAdapter(genericRssAdapter);
registerAdapter(naverBlogAdapter);
registerAdapter(hankyungAdapter);
registerAdapter(substackAdapter);
registerAdapter(naverPremiumAdapter);
registerAdapter(fandingAdapter);
registerAdapter(xAdapter);

export * from "./registry.js";
export * from "./types.js";
