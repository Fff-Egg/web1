import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getStoredSnapshot, refreshMarketSnapshot, setCustomSymbol } from "../../market/index.js";

/**
 * market router — 시황분석 dashboard.
 *
 * `latest` returns the last stored daily snapshot (collected once a day by the
 * scheduler). `refresh` forces a fresh collection on demand (the "지금 갱신"
 * button). `setSymbol` changes the user-configurable chart slot's TradingView
 * symbol and re-collects just that symbol.
 */
export const marketRouter = router({
  latest: publicProcedure.query(() => getStoredSnapshot()),
  refresh: publicProcedure.mutation(() => refreshMarketSnapshot()),
  setSymbol: publicProcedure
    .input(z.object({ symbol: z.string().min(1).max(40) }))
    .mutation(({ input }) => setCustomSymbol(input.symbol)),
});
