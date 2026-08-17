# Banana Digital — Client Portal + CRM

Client portal and CRM for Banana Digital London. Replaces a single-file HTML
prototype whose state lived in `window.storage` — per-browser, so the agency and
the client never saw the same data.

Plan of record: `~/.claude/plans/lets-build-it-properly-cheeky-swing.md`

## Stack

| | |
|---|---|
| Frontend | Vite + React 19 + TanStack Router/Query + Zustand + shadcn/ui + Tailwind v4 |
| Backend | Hono on Node 20, Drizzle ORM |
| Database | Postgres 18 with Row Level Security |
| Host | VPS4 (`ssh vps4` → `yota@161.97.76.197:2222`) |

## Local setup

Postgres is not exposed publicly on VPS4, so development reaches it through an
SSH tunnel. Three terminals:

```bash
npm run db:tunnel   # localhost:55432 -> vps4:5432   (leave running)
npm run dev:api     # Hono on :4300
npm run dev         # Vite on :5173, proxies /api -> :4300
```

Copy `.env.example` to `.env` and fill in the two database URLs.

```bash
npm run build        # tsc -b (app + node + server) && vite build
npm run lint
npm test             # vitest, browser mode via playwright
npm run db:generate  # emit a migration from schema changes
npm run db:migrate   # apply migrations as bd_owner
```

## Non-negotiables

These are the invariants the design depends on. Breaking one does not fail
loudly — it silently removes a guarantee.

**`bd_app` is the only runtime role.** It is a non-owner, non-superuser with
`rolbypassrls = false`. Row Level Security policies are binding *because* of
that. If a permissions error tempts you to point `DATABASE_URL` at `bd_owner`,
the fix is a `GRANT`, never a role swap.

**Tenant data is only queried inside `withTenant()`.** It opens a transaction
and applies the RLS session variables with `SET LOCAL`, which is what makes this
safe under connection pooling. A query outside a transaction has no session
variables and — by design — returns nothing rather than everything.

**`drizzle-kit push` is banned outside local scratch work.** It reconciles by
dropping columns. Use `db:generate` → review the emitted SQL → `db:migrate`.

**Every tenant table carries `client_id` directly**, child tables included. A
policy that has to join upward to find its tenant is slower and easier to get
subtly wrong.

**Her design tokens are verbatim.** The palette, fonts, and textures in
`src/styles/theme.css` come from her prototype. The art direction is the brand
asset; do not "improve" the values.

## Status

- [x] Phase 1 — Foundation: scaffold, brand tokens, database roles
- [ ] Phase 2 — Auth, seats, tenancy (RLS + isolation tests)
- [ ] Phase 3 — CRM core: clients, contacts, deals pipeline
- [ ] Phase 4 — Client portal: links, files, notice board, tasks
- [ ] Phase 5 — Content engine: unified Ideas Bank + Calendar
- [ ] Phase 6 — Media: uploads, thumbnails, feed preview, moodboard
- [ ] Phase 7 — Deploy to VPS4

> **The sign-in form is scaffolding and accepts any credentials.** It mints a
> fake session client-side. Phase 2 replaces it with Better Auth; the isolation
> suite is the gate that proves it is gone. Do not deploy before then.
