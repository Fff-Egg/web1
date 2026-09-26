# Feed Watch repository guidance

## Read first
- Start with `docs/OVERVIEW.md`; use `CLAUDE.md` only for detailed historical handoff notes.
- This is a React/Vite SPA and an Express/tRPC server in one TypeScript repository.
- Railway currently deploys `claude/focused-planck-m3wgbz`; do not merge or retarget production without checking Railway first.

## Safety
- Never commit `.env`, API keys, X/Telegram credentials, or anything under `sessions/`.
- The owner requested public access on 2026-09-26: dashboard, tRPC routes, and `/api/health` require no login. Legacy `APP_USERNAME` / `APP_PASSWORD` variables are ignored.
- The K-Fear and US-entry constants are backed by small-sample parity/anchor checks. Do not tune them without an explicit backtest request and updated tests/docs.
- External collectors are intentionally tolerant: one source failing must not discard successful sources.

## Verification
Run these before publishing code changes:

```bash
npm test
npm run typecheck
npm run build
```

For database changes, add a forward-only SQL migration under `drizzle/`; do not rewrite an applied migration.
