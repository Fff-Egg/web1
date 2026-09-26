import { initTRPC } from "@trpc/server";
import superjson from "superjson";

/**
 * tRPC initialization. superjson transformer lets Date/JSON values cross the
 * wire intact. Context is intentionally minimal for now (single-user app).
 */
export interface Context {
  // room for auth/user later
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
