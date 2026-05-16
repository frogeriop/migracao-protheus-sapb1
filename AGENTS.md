# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
ERP data migration tool (Protheus → SAP Business One) built as a **Next.js 16** app (TypeScript, React 19). The UI is in Brazilian Portuguese. See `README.md` for the standard Next.js getting-started guide.

### Running the dev server
The app runs on **port 3003** (`npm run dev` maps to `next dev -p 3003`). Follow `.agents/workflows/start-service.md` for the canonical startup flow: check `lsof -i :3003` first, then start if not already running.

### Lint / Build / Test
| Task | Command | Notes |
|------|---------|-------|
| Lint | `npx eslint .` | Pre-existing warnings/errors exist in the codebase (mainly `no-explicit-any` and `no-require-imports`). |
| Build | `npm run build` | Currently fails due to a missing `@/lib/config-helper` module referenced in 2 API routes (`check-data/route.ts`, `dump-entities/route.ts`). Dev mode still works because Next.js compiles lazily. |
| Test | N/A | No test framework or test files are configured. |

### External dependencies
The app connects to three external services configured in `config.json` (root):
- **Protheus** – SQL Server (port 1433) for source data extraction
- **SAP B1 Service Layer** – HTTPS REST API for migration target
- **Supabase** – Hosted PostgreSQL for staging/transformation

These are remote services and are **not** required to start the dev server or navigate the UI. API routes that call them will fail at runtime if the external services are unreachable, but the frontend renders normally.

### Key caveats
- No `.env` files; all credentials live in `config.json`.
- No automated tests exist.
- PM2 scripts (`pm2:start`, `pm2:stop`, `pm2:restart`) are defined in `package.json` but PM2 is not a required dependency.
