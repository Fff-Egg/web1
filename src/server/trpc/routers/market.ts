import { router, publicProcedure } from "../trpc.js";
import { getStoredSnapshot, refreshMarketSnapshot } from "../../market/index.js";

/**
 * market router — 시황분석 dashboard.
 *
 * `latest` returns the last stored daily snapshot (collected once a day by the
 * scheduler). `refresh` forces a fresh collection on demand (the "지금 갱신"
 * button), useful when the snapshot is missing/stale.
 */
export const marketRouter = router({
  latest: publicProcedure.query(() => getStoredSnapshot()),
  refresh: publicProcedure.mutation(() => refreshMarketSnapshot()),
});
