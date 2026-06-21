import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { listResearch, refreshResearch } from "../../research/index.js";

/**
 * research router — 리포트 board (증권사 리포트 솔팅).
 *
 * `list` returns the board for a 작성일 (default = latest collected), with coverage
 * counts + TP-상향 tier-ups computed server-side. `refresh` force-collects from
 * 한경 컨센서스 now and returns the fresh board (the "지금 수집" button).
 */
export const researchRouter = router({
  list: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(({ input }) => listResearch(input?.date)),
  refresh: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .mutation(({ input }) => refreshResearch(input?.date)),
});
