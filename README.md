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
npm run build          # tsc -b (app + node + server) && vite build
npm run lint
npm test               # component tests, browser mode via playwright
npm run test:isolation # tenancy isolation, against bd_portal_test
npm run db:generate    # emit a migration from schema changes
npm run db:migrate     # apply migrations as bd_owner
npm run bootstrap -- --email … --password …   # create the org + first owner
```

First run:

```bash
npm run db:migrate
npm run bootstrap -- --email you@example.com --password "at-least-10-chars" --name "Your Name"
```

Sign-up is disabled — seats are invited. Bootstrap is the only path that
creates an account without an invitation.

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

**`app_is_staff()` compares against the literal string `'true'`, not a cast.**
Postgres accepts `yes`, `y`, `on`, `t` and `1` as booleans, so the original
`::boolean` cast escalated a client to staff on any of them — confirmed by
reading the agency's deal row. Never reintroduce a cast here.

**Child rows inherit their parent's visibility.** A policy on `content_assets`
or `content_comments` that checks only `client_id` lets a client read the assets
and comments of a content item they cannot see. The policies subquery
`content_items`, which RLS filters for them, so visibility composes on its own.

**Isolation is tested by mutation, not by assertion alone.** The suite in
`server/__tests__/isolation.test.ts` has been verified by deliberately breaking
each rule it protects: a naive `client_id`-only `deals` policy fails 3 tests,
removing `missing_ok` from the helpers fails 9, and reverting the child-
visibility policies fails 2. A test that cannot fail is not protecting
anything — re-verify this way after touching any policy migration.

**Money is integer pence until the moment it is displayed.** Deal values are
`numeric(12,2)` carried as strings; use `toPence`/`sumPence`/`formatPence` from
`src/lib/api.ts`. Summing them as floats drifted (1800.10 + 2400.20 + 99.30 =
4299.599999999999), and rounding to whole pounds rendered £2,400.50 as "£2,401" —
a deal value that does not match the contract.

**A failed query must never render the empty state.** "No clients yet — add the
first one" when the request actually failed is a lie she would act on. Use
`QueryError` (`src/components/layout/query-error.tsx`) and branch on `isError`
before `isEmpty`.

**Never interpolate Drizzle columns into a correlated subquery.**
`sql\`… where ${tasks.clientId} = ${clients.id}\`` renders both sides
UNQUALIFIED, so inside the subquery `"id"` binds to the inner table. The
comparison is silently always false and every count reads zero. Write those
subqueries with explicit aliases (`from tasks tk where tk.client_id =
clients.id`).

**Her design tokens are verbatim.** The palette, fonts, and textures in
`src/styles/theme.css` come from her prototype. The art direction is the brand
asset; do not "improve" the values.

## Status

- [x] Phase 1 — Foundation: scaffold, brand tokens, database roles
- [x] Phase 2 — Auth, seats, tenancy (RLS + isolation tests)
- [x] Phase 3 — CRM core: clients, contacts, deals pipeline
- [ ] Phase 4 — Client portal: links, files, notice board, tasks
- [ ] Phase 5 — Content engine: unified Ideas Bank + Calendar
- [ ] Phase 6 — Media: uploads, thumbnails, feed preview, moodboard
- [ ] Phase 7 — Deploy to VPS4

Auth is real as of Phase 2: Better Auth with httpOnly cookie sessions, a single
Banana Digital organization, 10 seats, and invite-only access. Phases 3–6 build
the CRM and portal features on top.
