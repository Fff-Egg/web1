# Feed Watch — Investment Digest

Multi-source feed collection → investment analysis (Claude) → daily evening digest, viewable on a web dashboard. Sources are managed entirely from the UI.

> Built green-field in this repo. The original static HTML tutorial pages are preserved under [`legacy/`](./legacy).

## Stack
- **Frontend**: React 19, Vite, Tailwind, tRPC (react-query)
- **Backend**: Node + Express, tRPC, Drizzle ORM, MySQL
- **Analysis**: Anthropic Claude (2-pass: cheap filter → deep analysis)
- **Auth sources** (Phase 5): Playwright stored sessions

## Architecture (4 modules)
1. **Collector** — provider adapters behind a common interface + a provider registry; results normalized into one `articles` table.
2. **Analysis** — new articles run through a 1st-pass relevance filter (cheap model) then a 2nd-pass structured deep analysis (strong model).
3. **Digest** — daily cron synthesizes that day's relevant analyses into one markdown report.
4. **Dashboard** — source management + daily digest + feed with theme/ticker/impact filters + "why it matters" toggle.

## Layout
```
src/
  server/
    db/          # Drizzle schema, client, migrate, seed
    adapters/    # SourceAdapter interface, provider registry, per-provider adapters
    trpc/        # tRPC routers (sources, …)
    workers/     # collect (Phase 1); analyze, digest (later phases)
    scheduler.ts # background loops
    index.ts     # Express + tRPC server entry
  client/        # React dashboard
drizzle/         # generated SQL migrations
legacy/          # original static HTML site (untouched)
```

## Live demo (GitHub Pages)
A backend-free demo (data stored in the browser's localStorage) is published to
the `gh-pages` branch and served at **https://fff-egg.github.io/web1/**.

One-time setup: repo **Settings → Pages → Source = "Deploy from a branch" →
Branch: `gh-pages` / `(root)`**.

To rebuild & republish the demo:
```bash
npm run deploy:pages    # builds static demo and pushes the gh-pages branch
```

## Setup

### Quick start (no database — demo mode)
The site runs out of the box without MySQL. Without `DATABASE_URL` it uses an
in-memory store (seeded with 세상학개론 / 한국경제); data resets on restart.
```bash
npm install
npm run build          # build the client
npm run server         # serves the whole site on http://localhost:3000
# — or, for live-reload development —
npm run dev            # client (5173) + server (3000)
```

### With MySQL (persistent)
```bash
cp .env.example .env      # set DATABASE_URL, ANTHROPIC_API_KEY, …
npm run db:generate       # generate SQL migration from schema (already committed)
npm run db:migrate        # apply migrations to MySQL
npm run db:seed           # seed initial sources (세상학개론 / 한국경제)
npm run dev
```

### Useful scripts
| script | purpose |
|---|---|
| `npm run dev` | run client + server together |
| `npm run worker:collect` | one-shot collection pass |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle migration + seed |
| `npm run login -- --source=<ref>` | (Phase 5) interactive login → save session |

## Providers
| provider | fetch type | you enter | auth |
|---|---|---|---|
| `substack` | rss + auth | publication URL / handle | paid sub |
| `naver_blog` | rss | blog id | – |
| `x` | x_api / x_auth | `@handle` | sub account |
| `naver_premium` | scrape_auth | channel/content URL | paid sub |
| `fanding` | scrape_auth | creator URL | membership |
| `hankyung` | rss + scrape | section RSS / list URL | – |
| `generic_rss` | rss | RSS URL | – |
| `generic_scrape` | scrape | page URL | – |

## Security
- Credentials live **only** in environment variables (`CRED_<REF>_USER` / `CRED_<REF>_PASS`). The DB stores only a `credentialRef` key name.
- `.env` and `sessions/` are git-ignored and must never be committed.

## Status
- ✅ **Phase 1** — foundation, DB schema + migration, adapter interface + provider registry + RSS adapter, collection worker, seed.
- ✅ **Phase 2** — public-provider adapters (naver_blog, hankyung, generic_rss, substack-rss) + provider preset catalog + Sources management UI (add/toggle/edit/delete, credentialRef field for auth providers).
- ⬜ Phase 3 — analysis pipeline.
- ⬜ Phase 4 — digest cron + Daily Digest / Feed views.
- ⬜ Phase 5 — authenticated sources (login script, sessions, substack paid, naver_premium, fanding, x).
