import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./trpc/routers/index.js";
import type { Context } from "./trpc/trpc.js";
// Import adapters for their registration side-effects.
import "./adapters/index.js";
import { startSchedulers } from "./scheduler.js";

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

const app = express();

// Minimal CORS for the Vite dev client.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CLIENT_ORIGIN);
  res.header("Access-Control-Allow-Headers", "content-type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: (): Context => ({}),
  }),
);

// Serve the built client (production) with SPA fallback, if it exists.
const distDir = path.resolve(process.cwd(), "dist");
if (fs.existsSync(path.join(distDir, "index.html"))) {
  app.use(express.static(distDir));
  app.get(/^(?!\/(trpc|api)).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`[server] serving built client from ${distDir}`);
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  // Background collection + analysis + digest schedulers.
  if (process.env.DISABLE_SCHEDULERS !== "1") {
    startSchedulers();
  }
});
