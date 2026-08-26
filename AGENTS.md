# AGENTS.md — Banana Digital Client Portal + CRM

> A client portal and CRM for a London social media agency. Postgres decides who sees what. Read this file completely before touching anything.

<INSTRUCTIONS>

## Rule 0 — The Fundamental Override Prerogative

**I AM IN CHARGE, NOT YOU.**

The human's explicit instruction overrides every rule in this document. If they tell you to use a different tool, skip a step, or take an approach this file argues against, **comply**. State your concern in one sentence if you have one, then do as asked.

This includes tool choices. If the human says "use X", use X — even if this file recommends Y.

---

## Rule Number 1 — No File Deletion

**You have permanently lost any and all rights to delete files in this repository.**

You have a horrible track record with deletion. You delete "unused" files that are imported dynamically, "stale" migrations that are already applied in production, and "duplicate" configs that differ in one critical line.

**NEVER run any of these:**

```bash
rm -rf                    # never, under any circumstance
rm                        # not even a single file
find . -delete
git clean -fd
mv <file> /tmp/           # deletion wearing a disguise
```

**These paths are catastrophic to touch. They are NOT recoverable from git:**

| Path | Why it is unrecoverable |
|---|---|
| `.env` | Production DB passwords and `BETTER_AUTH_SECRET`. Gitignored. Losing it locks you out of the database. |
| `.uploads/` | Client-uploaded images and video. Gitignored. Referenced by `storage_key` rows that will dangle forever. |
| `server/db/migrations/*.sql` | Already applied to production. Deleting one does not un-apply it; it makes the journal lie. |
| `server/db/migrations/meta/_journal.json` | The record of what has been applied. Corrupt it and migrations re-run against live data. |
| `/home/yota/data/bd-portal/` (VPS4) | Production uploads and backups. |
| `/srv/http/bd-portal/` (VPS4) | The served frontend. |

If you believe a file must go, **say so and stop**. The human deletes it.

---

## Irreversible Git and Filesystem Actions — DO NOT EVER BREAK GLASS

1. **Forbidden commands.** Never run any of these without an explicit, in-conversation instruction naming the command:

```bash
git reset --hard
git checkout -- .
git restore .
git clean -fd
git push --force
git push --force-with-lease
git rebase          # interactive rebase is unavailable in this environment anyway
git filter-branch
DROP TABLE          # or DROP DATABASE, TRUNCATE without a WHERE-scoped plan
drizzle-kit push    # see Rule: migrations
```

2. **No guessing.** If you are unsure whether an action is reversible, **it is irreversible**. Treat it as forbidden.

3. **Safer alternatives first.** `git stash` over `git checkout --`. A new migration over editing an applied one. `git revert` over `git reset --hard`.

4. **Mandatory explicit plan.** Before any risky action, state in the conversation: what you will run, what it affects, and what the recovery path is. Then wait.

5. **Document the confirmation.** When the human approves, quote their approval before acting.

---

## Git Branch Policy

- Default branch: `master`. The remote is `origin`
  (`github.com/0xHenriq/bd-portal`), and it is **private**. This file used to
  say there was no remote; that stopped being true and the note was wrong for
  several sessions.
- Commit when the human asks, or when completing a phase of work. Pushing to
  `origin` is the offsite copy of the code, so push once a phase is green.
  `.env` is gitignored and has never been committed — check that it still is
  not before any push, because the remote being private is not a licence to
  put production secrets in it.
- End every commit message with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

- Commit messages explain **why**, and name what was verified. "fix: X" with no evidence is a bad commit here.

---

## Database Safety Rules — CONSTITUTIONAL

The database is shared with production. **There is no separate development database.** `DATABASE_URL` in your local `.env` points through an SSH tunnel at the live `bd_portal` on VPS4.

**Every query you run locally hits production data.**

1. **NEVER point `DATABASE_URL` at `bd_owner`.** The runtime role is `bd_app`: a non-owner, non-superuser with `rolbypassrls = false`. Row Level Security policies are binding **because of that**. If a permissions error tempts you to swap the role, the fix is a `GRANT`, never a role swap. `server/db/guard.ts` refuses to boot if this is violated — do not disable it.

2. **NEVER run `drizzle-kit push`.** It reconciles schema by **dropping columns**. Use `npm run db:generate` → read the emitted SQL → `npm run db:migrate`.

3. **NEVER edit an applied migration.** Write a new one. `0002_rls.sql` and friends are already in production.

4. **NEVER run raw `UPDATE`/`DELETE` without a `WHERE`.** State the row count you expect before running it.

5. **Hand-written migrations must be registered** in `server/db/migrations/meta/_journal.json`, or `db:migrate` silently skips them. Drizzle does NOT generate RLS policies — every policy is hand-written.

6. **A new tenant table is not finished when the migration is written.** It must be added to THREE places or it is silently unprotected:
   - the RLS migration (`ENABLE ROW LEVEL SECURITY` + policies)
   - the table list in `server/db/guard.ts`, or the boot guard never checks it
   - `TENANT_TABLES` and the class lists in `server/__tests__/fixtures.ts`, or the isolation suite passes vacuously

   Seed rows for it in the fixture too. A table with no fixture rows makes every isolation assertion trivially true.

---

## Multi-Agent Coordination

**N/A — this is a single-agent project.** There is no Agent Mail, no file reservation protocol, no Beads. If `git status` shows changes you did not make, they are the human's. Ask; do not "clean up".

---

## Toolchain: TypeScript + npm

### Version

| Thing | Version | Enforced by |
|---|---|---|
| Node | **20.20.2** | `.nvmrc`; VPS4 systemd unit uses the absolute nvm path |
| TypeScript | 5.x, strict | `tsconfig.*.json` |
| Postgres | **18.3** | VPS4, and `bd_portal_test` for the isolation suite |
| React | 19 | — |

**Node 18 will not work.** Vite 8 requires ≥20. The system Node on VPS4 is 18.20.8, which is why the systemd unit hardcodes `/home/yota/.nvm/versions/node/v20.20.2/bin/node` — **systemd does not source `~/.nvm`**.

### Key Dependencies

| Package | Purpose |
|---|---|
| `hono` + `@hono/node-server` | API server |
| `drizzle-orm` + `drizzle-kit` | Schema, queries, migrations |
| `pg` | Postgres driver; the pool `withTenant` runs transactions on |
| `better-auth` | Sessions, the single organization, members, invitations |
| `@tanstack/react-router` | File-based routing, route guards |
| `@tanstack/react-query` | Server state, optimistic mutations |
| `sharp` | Image thumbnails (400px webp) |
| `pino` | Structured logs |
| `zod` | Request validation |
| `@dnd-kit/*` | Pipeline board drag-and-drop |
| `tsx` | **Runtime dependency, not dev** — Node 20 cannot execute TypeScript, and `npm start` runs the server through tsx |

### Forbidden Dependencies

| Dependency | Why it is FORBIDDEN |
|---|---|
| `bcrypt`, `argon2`, any hashing lib | Better Auth owns password hashing. A second scheme means accounts that cannot log in. |
| Any ORM other than Drizzle | Schema and RLS session variables assume Drizzle transactions. |
| `moment` | `date-fns` is present. Do not add a second date library. |
| A second HTTP client | `fetch` via `src/lib/api.ts` on the client. Do not reach for `axios` (it is a leftover transitive dep). |
| Object storage SDKs (`@aws-sdk/*`, etc.) | VPS4 has 416 GB free. `LocalDiskDriver` is the deliberate choice; see `server/lib/storage.ts`. |

### Safety Boundary

- **No `eval()`, `new Function()`, or `innerHTML`.**
- User-supplied URLs **MUST** go through `safeHref()` (`src/lib/safe-href.ts`) before becoming an `href`. It permits http/https only. `javascript:`, `data:`, `vbscript:` and `file:` are refused, and there are tests for each.

### Logging & Console Output

- Server: `pino` via `server/logger.ts`. **No `console.log` in `server/`** — lint enforces `no-console`. CLI scripts in `scripts/` may print, with an `eslint-disable-next-line no-console` and a reason.
- Client: no `console.log` in committed code.

### Build & Verification

```bash
npm run build          # tsc -b (app + node + server projects) && vite build
npm run lint           # eslint, zero warnings tolerated
npm test               # component tests, Playwright browser mode
npm run test:isolation # server tests: tenancy, contracts, patch schemas
```

**All four MUST pass before you commit.**

### Third-Party Library Usage

If you are not 100% sure how a third-party library works, **search online for current documentation**. Do not hallucinate API signatures. Better Auth's CLI entrypoint in particular has changed between releases — verify before running it.

---

## Code Editing Discipline

### No Script-Based Changes

Never apply regex bulk transforms across files. Every edit is deliberate and reviewed. `sed -i` on a single, verified string is acceptable; `sed -i` across a glob is not.

### No File Proliferation

**The bar for creating a new file is incredibly high.**

Forbidden: `api_v2.ts`, `schema.backup.ts`, `content-improved.tsx`, `index.old.tsx`. If a file needs replacing, replace it.

Shared constants and non-component exports go in their own module — a `.tsx` file that exports both a component and a constant trips `react-refresh/only-export-components`. See `src/features/content/vocabulary.ts` and `src/lib/safe-href.ts` for the pattern.

---

## Backwards Compatibility

**This is a BROWNFIELD project. Backwards compatibility is CRITICAL.**

The patterns below are established, load-bearing, and were each paid for with a real bug. **Match them exactly.** Before writing code in an area, read 3+ existing files in the same directory. The bar for deviating is astronomically high.

---

## Compiler / Linter Checks (CRITICAL)

```bash
npx tsc -b                              # whole project: app, node config, server
npx tsc -p tsconfig.server.json --noEmit  # server only, faster loop
npm run lint
npm run format:check
```

If you see errors, **carefully understand and resolve each one**. Never suppress with `@ts-ignore` or a blanket eslint-disable.

---

## Testing

### Testing Policy

Every change to tenancy, auth, or request validation **MUST** ship with a test. Tests cover the happy path, the edge case, and the failure.

**This is a brownfield codebase — test patterns already exist.** Before writing any test, read 2+ existing tests in the same area and match their style, fixtures, and assertions exactly.

### Mutation Testing Is Mandatory For Security Rules

**A test that cannot fail protects nothing.** After writing or changing a test that guards tenancy, RLS, or validation, **break the rule deliberately and confirm the test fails**, then restore it.

This is not ceremony. It has caught real defects in this repo:

| Mutation | Result |
|---|---|
| Replace the staff-only `deals` policy with a naive `client_id`-only one | 3 tests fail |
| Remove `missing_ok` from the SQL helpers | 9 tests fail |
| Revert the content child-visibility policies | 2 tests fail |
| Restore `taskSchema.partial()` in a PATCH schema | 1 test fails |
| Rename a deal stage server-side | 1 test fails |

The fail-closed tests once passed for the *wrong reason* — pooled connections retain a custom GUC once `set_config` has defined it, so `current_setting` stopped raising. Anonymous actors now get a fresh connection. **Verify by mutation, not by reading.**

### Test Commands

```bash
npm test                                    # all component tests (browser mode)
npm run test:isolation                      # all server tests
npx vitest run --config vitest.server.config.ts server/__tests__/isolation.test.ts
npm run test:coverage
```

### Test Categories

| Suite | File | Focus |
|---|---|---|
| Tenancy isolation | `server/__tests__/isolation.test.ts` | Cross-tenant, class confusion, fail-closed |
| API/client contract | `server/__tests__/contract.test.ts` | Deal stages match on both sides; money arithmetic |
| Patch schemas | `server/__tests__/patch-schemas.test.ts` | PATCH bodies invent no fields; duplicate resets; schedule invariants |
| Media | `server/__tests__/media.test.ts` | Magic-number sniffing, range arithmetic, download headers, size messages, `imageTypeForKey` |
| URL safety | `src/lib/safe-href.test.ts` | `javascript:`/`data:` refused; `//evil.com` is not an internal path |
| Components | `src/**/*.test.tsx` | Sign-in, config drawer, search palette, client logo, hashtag editor |

The contract suite also binds the two copies of hashtag normalisation and the `canSeePortal` predicate. See invariant 17.

Current counts: **106 component tests, 183 server tests.** If a change drops either number, you deleted a test.

### The Isolation Suite Covers Three Distinct Failure Modes

They fail independently. Do not collapse them:

1. **Cross-tenant** — A's user reading B's rows.
2. **Class confusion** — A's user reading A's *own* staff-only rows. A `client_id`-only policy passes (1) and fails this.
3. **Fail-closed** — no session variables at all: zero rows, **not an error**.

### Test Database

`bd_portal_test` on VPS4, reached through the same tunnel. The suite truncates it freely. `TEST_DATABASE_URL` must **never** point at `bd_portal`.

That rule is now **enforced, not requested**: `fixtures.ts` parses both test URLs and refuses to run unless the database name ends in `_test`. It used to only check the variables were set, which is not the same thing — production and the test database differ by one word in the same connection string, on the same host, through the same tunnel. A stray `TEST_DATABASE_URL=$DATABASE_URL` in a shell would have truncated every tenant table on a live agency's database, and `truncate` does not fail the way `set-password` once did. Do not weaken that check.

```bash
DATABASE_URL_OWNER="$TEST_DATABASE_URL_OWNER" npx tsx scripts/migrate.ts  # migrate the test DB
```

### CI/CD

**None.** There is no CI. You are the gate. Run all four commands under "Build & Verification" before every commit.

---

## Banana Digital Client Portal — This Project

**This is the project you are working on.**

### What It Does

A London social media agency (Banana Digital) runs its client relationships here. Staff manage clients, a deals pipeline, and a content calendar. Each client gets a branded portal where they see their own links, files, notice board, to-dos, and — critically — **approve the content the agency proposes**.

It replaces a single-file HTML prototype whose state lived in `window.storage`, so the agency and the client never saw the same data.

### Architecture

```
  Browser (React 19 SPA)
        |
        |  same-origin /api  (cookie session, httpOnly)
        v
  +------------------+       Caddy :8100 in production
  |  Vite dev :5173  |  -->  serves dist/, proxies /api -> :4300
  +------------------+
        |
        v
  +----------------------------------------------------+
  |  Hono API :4300                                     |
  |    withSession  -> resolves user + isStaff          |
  |    withTenant   -> BEGIN; set_config(app.user_id,   |
  |                    app.is_staff); ...; COMMIT       |
  +----------------------------------------------------+
        |
        |  connects ONLY as bd_app (non-owner, no BYPASSRLS)
        v
  +----------------------------------------------------+
  |  Postgres 18 — Row Level Security is the authority  |
  |    staff-only | client-visible | + column gate      |
  +----------------------------------------------------+
        |
        v
  Local disk: /home/yota/data/bd-portal/uploads
  Streamed back through /api/media/* (never a static path)
```

### Workspace Structure

```
server/
  index.ts               Hono app, route mounting, /healthz, graceful shutdown
  env.ts                 Zod-validated env; refuses to boot on bad config
  logger.ts              pino; redacts cookies and passwords
  auth/
    index.ts             Better Auth config: org plugin, rate limits, cookies
    access.ts            Roles + isStaffRole() — THE staff/client authority
    org.ts               The single organization's id, memoized
  db/
    index.ts             Pool, withTenant(), withoutTenant()
    schema.ts            All application tables
    auth-schema.ts       Better Auth generated tables — DO NOT hand-edit
    guard.ts             Boot assertion: refuses to start unless RLS binds
    migrations/          Numbered SQL + meta/_journal.json
  lib/
    resolve-client.ts    Which workspace a request is for (staff vs client)
    audit.ts             audit() + recordActivity(), both take the tx
    storage.ts           StorageDriver; LocalDiskDriver; path-escape guard
    media.ts             sharp thumbnails, ffmpeg posters, magic-number sniffing,
                         document sniffing (PDF/OOXML/CSV), 1 GB ceiling
    seed-workspace.ts    Her 10 links (TikTok/Instagram/Facebook first) /
                         5 file slots / 4 onboarding to-dos
    hashtags.ts          normaliseHashtags/parseHashtagInput. MIRRORED in
                         src/lib/hashtags.ts — see invariant 17
  middleware/
    session.ts           withSession, requireAuth, requireStaff
    rate-limit.ts        In-process fixed-window limiter
  routes/                clients, deals, invoices, portal, content, media,
                         next-steps, seats, invitations
  __tests__/             isolation, contract, patch-schemas, media, fixtures

src/
  lib/api.ts             API client + shared types + money helpers + derived
                         state (paymentState, invoiceState, outstandingPence)
  lib/upload.ts          XHR multipart upload with progress. Browser-only, and
                         SEPARATE from api.ts because the server project
                         typechecks api.ts and has no DOM lib.
  lib/safe-href.ts       safeHref() for external URLs, internalPath() for
                         in-app ones. Both refuse `//evil.com`.
  lib/hashtags.ts        The browser copy of the normaliser. Must stay
                         byte-identical in behaviour to the server one.
  lib/copy-text.ts       THE way this app copies to the clipboard.
                         navigator.clipboard does NOT exist over plain HTTP.
  lib/route-guards.ts    requireStaffRoute()
  hooks/use-current-user.ts   /api/me — the single authority on isStaff
  components/upload-button.tsx  THE way this app opens a file picker. A native
                         <label for>, never a scripted .click().
  components/client-logo.tsx    The client's mark, with initials on their brand
                         colour as the fallback. The mark ITSELF is the upload
                         target when canEdit.
  features/
    portal/use-workspace.ts   Persisted workspace selection (shared, derived)
    content/                  Ideas Bank, Calendar, Feed, Moodboard,
                              moodboard-preview (strip, reused),
                              hashtag-editor.tsx (chips, 30-tag counter).
                              review-queue.tsx exports NEXTSTEPS — the file
                              kept its old name so no import path moved.
    invoices/panel.tsx        Invoices + receipts. ONE panel for both audiences.
    clients/ pipeline/ dashboard/ auth/
  routes/                TanStack file-based routes

scripts/
  migrate.ts             Applies migrations as bd_owner
  bootstrap.ts           Creates the org + first owner (sign-up is disabled)
  set-password.ts        Rotates a password; revokes that user's sessions
  db-tunnel.sh           localhost:55432 -> vps4:5432, auto-reconnecting
  deploy.sh              rsync + build + publish + restart
  backup.sh              Nightly pg_dump + uploads snapshot
  restore-check.sh       Restores the newest dump and asserts it has rows
```

### Core Types Quick Reference

| Type | Purpose | Defined in |
|---|---|---|
| `clients` | A client account. `portalEnabled` opens their workspace; `archivedAt` retires it without deleting anything; `logoKey` is their mark. | `server/db/schema.ts` |
| `client_access` | Which workspaces a client-role user may see. The root of the visibility graph. | `server/db/schema.ts` |
| `content_items` | **Both** the Ideas Bank and the Calendar. Unscheduled = idea; dated = calendar. `caption` is the post copy; `hashtags` is a normalised `text[]`. | `server/db/schema.ts` |
| `content_assets` | Uploaded media for an item. First asset (by `sortOrder`) fills the feed cell. | `server/db/schema.ts` |
| `content_approvals` | Append-only decision record. No UPDATE/DELETE policy exists. | `server/db/schema.ts` |
| `tasks` | To-dos, with `visibleToClient` separating internal work and `dueDate` for deadlines. | `server/db/schema.ts` |
| `invoices` | A demand for money. Many per deal — a retainer is billed in stages. Client sees it only once `issuedOn` is set. | `server/db/schema.ts` |
| `invoice_payments` | Money received. **Each row IS a receipt.** No UPDATE policy. | `server/db/schema.ts` |
| `NextStep` | A post awaiting a decision, or a dated open to-do. The panel that leads every page. | `server/routes/next-steps.ts` |
| `TenantContext` | `{ userId, isStaff }` — what `withTenant` writes into the transaction. | `server/db/index.ts` |
| `StorageDriver` | Put/read/remove for uploaded bytes. | `server/lib/storage.ts` |

### Key Design Decisions

- **Postgres RLS is the authority on visibility, not application code.** A forgotten `where` clause returns nothing instead of leaking.
- **`FORCE ROW LEVEL SECURITY` is deliberately NOT used.** It would apply policies to `bd_owner`, breaking migrations and seeds, and its failure mode is a confusing empty result. Replaced by `server/db/guard.ts`, which refuses to boot and says why.
- **`organization` = the agency, not each client.** Keeps "10 seats" a literal `count(*) from member`.
- **`content_items` is one table serving three views.** The prototype's two disconnected stores meant approving an idea did nothing to the calendar.
- **Media streams through the app.** Caddy has no `secure_link` equivalent, so a signed URL would have nothing validating it.
- **Local disk over object storage.** 416 GB free on VPS4.
- **Derived state is never stored.** `overdue`, `paid` and `part paid` are computed from the payments and today's date; a deal's `overdue` likewise. Storing them would need something running at midnight to keep them honest, and a status that silently goes stale is worse than no status. Only what she DECIDES is persisted: `draft`/`sent`/`void`, `none`/`awaiting`/`paid`.
- **Invoices, not a flag on the deal.** She bills a retainer in stages, so one deal carries many invoices and an invoice can be half settled. `deals.payment_status` remains as lightweight per-deal marking, but **invoices are the book** — anything totalling "owed" reads from them.
- **`navigator.clipboard` is never called directly.** It exists only in a SECURE CONTEXT, and this application is served over plain HTTP. It works in dev, which is localhost, which is exactly how that reaches a deploy. Use `src/lib/copy-text.ts`.
- **A payment row IS the receipt.** A separate receipts table would hold the same facts twice. The row carries its own number and that is what the client quotes back.
- **Clients are archived, never deleted.** A client is the parent of their contacts, deals, content and its assets, files, invoices, receipts, tasks and notes, all `ON DELETE CASCADE`, plus uploaded bytes that a database restore does not bring back. `archived_at` retires them from her screens instead, and Restore is one click. **Unpaid invoices stay visible on purpose** — tidying a client away must never hide money owed.
- **Hashtags are an array, not a blob of text.** Thirty tags in a textarea cannot be counted, and Instagram rejects a post at thirty-one. Normalised on the way in: no hashes, no punctuation, deduped case-insensitively. Case is PRESERVED — the capitals are what make a long tag readable.
- **Undated work sorts LAST in Next Steps.** `null` sorts before everything in a naive comparator, which would put a post with no schedule above one due tomorrow and make the panel actively misleading.
- **The upload picker uses a native `<label for>`.** A scripted `.click()` on a hidden input fails silently on Safari and iOS, and cost a full day. There is no JavaScript in that path now.

### Non-Negotiable Invariants

| # | Invariant | Rationale |
|---|---|---|
| 1 | The app connects **only** as `bd_app` | Non-owner, no BYPASSRLS — this is what makes policies bind |
| 2 | Every tenant query runs inside `withTenant()` | `SET LOCAL` is transaction-scoped; outside one there are no session variables |
| 3 | Every tenant table carries `client_id` **directly** | A policy that joins upward to find its tenant is slower and easier to get wrong |
| 4 | `app_is_staff()` compares to the literal `'true'` — **never a cast** | Postgres accepts `yes`/`y`/`on`/`t`/`1` as booleans |
| 5 | Session variables are read with `missing_ok` | `current_setting` **raises** when unset; it does not return NULL |
| 6 | PATCH schemas are written separately and carry **no defaults** | `.partial()` does not strip `.default()` |
| 7 | Money is integer pence until display | Float sums drift; rounding to pounds misstates a contract |
| 8 | Child rows inherit their parent's visibility | `client_id` alone leaks a hidden item's assets and comments |
| 9 | `visible_to_client` is **sticky** once granted | A status reset must not yank a thread from a client mid-conversation |
| 10 | Her design tokens are verbatim | The art direction in `src/styles/theme.css` is the brand asset. NEW tokens beside it are fine; edits to the existing crate palette are not |
| 11 | `invoices.amount_pence` is an **integer**, not numeric | A new table is the one place invariant 7 can be honoured exactly. `deals.value` stays `numeric(12,2)` for history; convert at the boundary, never mix units in one sum |
| 12 | `issued_on` is the client-visibility gate on invoices, **not** the status | A draft must never reach the client, and a later void must not retroactively hide a document they already hold |
| 13 | A rule is judged on the row as it will BE, not on what the request mentions | Checking only the fields present in a PATCH leaves the other direction wide open. See Failure Mode 15 |
| 14 | File inputs are `sr-only`, never `hidden` | `display:none` inputs do not reliably open a picker; the failure is completely silent |
| 15 | Every staff-facing list that joins `clients` filters `isNull(clients.archivedAt)` | RLS deliberately still shows STAFF an archived client, or Restore could not read the row it restores. The filter cannot come from the policy — it must be in the query |
| 16 | Browser APIs are feature-detected before use, never assumed | The site is plain HTTP, so every secure-context API is absent in production and present in dev. `navigator.clipboard` already shipped broken once |
| 17 | Logic duplicated across the client/server boundary is bound by a test in `contract.test.ts` | The server cannot import from `src` and the browser should not import from `server`, so some logic exists twice. Two copies that drift produce a UI that disagrees with what was saved. Both hashtag normalisers run over the same inputs there |
| 18 | A query key rename is finished only when the OLD key has no references left | Keys are strings; the compiler cannot see them. Renaming one already left two mutations invalidating a key nothing read |

### Performance Requirements

Standard. One agency, tens of clients, hundreds of content rows. Filtering happens client-side over one payload on purpose. Do not add pagination or caching layers without evidence of a problem.

### API Surface

All under `/api`, same-origin, cookie-authenticated.

| Route | Access | Notes |
|---|---|---|
| `/api/auth/*` | public | Better Auth. Sign-up is **disabled**. |
| `/api/me` | authed | The single authority on `isStaff` |
| `/api/clients`, `/api/deals` | **staff only** | 403 for clients, including their own client |
| `/api/invoices` | authed | Staff see all (and every client's, unfiltered — that is what a payment view needs); a client sees only their own **issued** ones. Writes are staff only. |
| `/api/invoices/:id/payments` | staff only | Records a payment and issues a receipt number. Overpayment is refused |
| `/api/portal`, `/api/content`, `/api/media` | authed | `?client=<uuid>` honoured for staff, **ignored** for clients |
| `/api/next-steps`, `/api/next-steps/:clientId` | authed | Posts awaiting a decision plus dated open to-dos, soonest first. One loader serves both — do not add a second query |
| `/api/clients/:id/archive`, `/restore` | staff only | Archive is a timestamp, never a DELETE. It closes the portal and drops the client from `/api/clients`, `/api/deals` and `/api/next-steps` — but **not** from `/api/invoices`: tidying a client away must never hide money owed. Any new list that joins `clients` for staff needs `isNull(clients.archivedAt)`, because RLS deliberately still shows staff the row |
| `/api/media/clients/:id/logo` | authed | Reads the key off the row, never from the URL; RLS decides who sees it |
| `/api/seats` | staff only | Seat cap of 10, counting members + pending invitations |
| `/api/invitations/:id` | public | Rate limited; the invitation id is the credential |
| `/healthz` | public | Asserts DB **and** uploads, not just a socket |

Status codes: `401` unauthenticated, `403` wrong role, `404` invisible-or-absent (**deliberately indistinguishable**), `409` state conflict, `413` too large, `415` wrong file type, `429` rate limited.

---

## Operational Tooling

### The SSH Tunnel (`npm run db:tunnel`)

**What it does.** Forwards VPS4's Postgres (bound to `127.0.0.1:5432` there) to `localhost:55432`. Postgres is not publicly exposed; this is how local development reaches it.

**When to use.** Always. Nothing that touches the database works without it.

**Workflow.**

```bash
npm run db:tunnel   # leave running in its own terminal
npm run dev:api     # Hono on :4300
npm run dev         # Vite on :5173
```

**Common pitfalls.**
- The tunnel dies on any network blip. It now auto-reconnects, but if the API refuses to boot with `ECONNREFUSED 127.0.0.1:55432`, **the tunnel is down — this is not an application bug**.
- The boot guard refusing to start is correct behaviour. Do not "fix" it by disabling the guard.

### Browser Verification (`chrome-devtools-axi`)

**What it does.** Drives a real Chrome for verifying UI behaviour.

**When to use.** After **any** UI change. Type-checking proves nothing about what a user sees. Multiple real bugs in this repo were invisible to code reading and obvious in the browser.

**Workflow.**

```bash
chrome-devtools-axi open "http://localhost:5173/portal"
chrome-devtools-axi snapshot            # accessibility tree with uids
chrome-devtools-axi fill @<uid> "text"
chrome-devtools-axi click @<uid>
chrome-devtools-axi eval "(function(){ return document.title })()"
chrome-devtools-axi screenshot /path/to/shot.png
chrome-devtools-axi console --type error
```

**Common pitfalls.**
- **uids go stale.** Take one snapshot and use uids from *that* snapshot. Grepping a fresh snapshot for each uid gives mismatched ids and silent no-op clicks.
- `eval` needs a single expression — wrap multi-statement code in an IIFE.
- Synthetic pointer events do **not** drive dnd-kit; the harness cannot emit the intermediate moves it tracks.
- The headed window **does not resize**, so mobile layout cannot be verified here. Say so rather than claiming it works.

### Deploy (`npm run deploy`)

**What it does.** rsyncs source to VPS4, installs and builds **on the host**, publishes `dist/` to `/srv/http/bd-portal`, applies migrations, restarts the service, and waits for health.

**When to use.** Any change the human wants live.

**Common pitfalls.**
- **Native modules must build on the host.** `sharp` from macOS will not load on Linux. Never rsync `node_modules`.
- `.env` is excluded on purpose. Production secrets live only on the server.
- Caddy cannot traverse `/home/yota` (mode 0750) — that is why `dist/` is published to `/srv/http/bd-portal`. Serving from the home directory returns **403**.
- **The URL must not change.** `http://161.97.76.197:8100` is shared with a real person.

### Backups

```bash
ssh vps4 /home/yota/apps/bd-portal/scripts/backup.sh          # nightly via systemd timer
ssh vps4 sudo /home/yota/apps/bd-portal/scripts/restore-check.sh   # monthly
```

**Pitfall that already bit:** `postgres` cannot read dumps inside `/home/yota` (0750). The restore check stages the dump in `/tmp` first. It once reported "restored but empty" because `pg_restore`'s stderr was discarded — **never swallow errors in a verification script**.

**The backups live on the same disk as the data.** They survive a mistake, not
a disk failure. Copy the newest pair off the box after any session that
mattered:

```bash
mkdir -p ~/Documents/bd-portal-backups
scp vps4:/home/yota/data/bd-portal/backups/bd_portal-<stamp>.dump      ~/Documents/bd-portal-backups/
scp vps4:/home/yota/data/bd-portal/backups/uploads-<stamp>.tar.zst     ~/Documents/bd-portal-backups/
# and confirm the copy is not truncated
ssh vps4 md5sum /home/yota/data/bd-portal/backups/bd_portal-<stamp>.dump
md5 -q ~/Documents/bd-portal-backups/bd_portal-<stamp>.dump
```

### Rollback — how to actually go back

Three separate things can be rolled back, and they are **not** interchangeable.
Restoring one without the others gives a portal whose rows point at files that
are not there, or files nothing references.

| What went wrong | How to go back |
|---|---|
| Bad code shipped | `git revert <sha>` then `npm run deploy`. Never `reset --hard` on a pushed commit. |
| Bad data written | Restore from the newest dump *taken before it* — procedure below. |
| Uploaded files lost | `tar --zstd -xf uploads-<stamp>.tar.zst` into `/home/yota/data/bd-portal/`. |

Restoring the database is **destructive and manual on purpose** — there is no
script for it, because a script that can overwrite production is a loaded gun
sitting in the repository. Take a fresh dump first, so the state you are
abandoning is itself recoverable:

```bash
ssh vps4 /home/yota/apps/bd-portal/scripts/backup.sh   # 1. snapshot NOW, before anything
ssh vps4 sudo /home/yota/apps/bd-portal/scripts/restore-check.sh  # 2. prove the target dump is good
# 3. only then, with the row counts from step 2 in front of you, restore for real
```

Always run step 2 first. It restores into a throwaway database and prints the
row counts, which is how you find out the dump you were about to trust is empty
*before* you have overwritten anything.

### The Ingress (Caddy on VPS4)

**What it does.** Caddy listens on `:8100`, serves the built SPA from
`/srv/http/bd-portal`, and proxies `/api` and `/healthz` to the Node process on
`127.0.0.1:4300`. **It is part of the application** and it has caused a full
day of debugging that looked like an application bug and was not.

**When to look here.** When a request never reaches the server at all. If
`journalctl` shows NO log line for the thing the user says is broken, the
application never saw it — suspect the browser or the ingress, not the code.

```bash
ssh vps4 'sudo cat /etc/caddy/Caddyfile'          # read it
ssh vps4 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh vps4 'sudo systemctl reload caddy'            # apply; never restart blindly
curl -s -D - -o /dev/null http://161.97.76.197:8100/portal | grep -i cache-control
```

**Common pitfalls.**
- **`:80` on that box is a different site.** `http://161.97.76.197` with no port
  serves an unrelated application. Every URL given to a human MUST include
  `:8100`, or they land somewhere else and no password will ever work.
- **A path matcher matches the REQUEST path, not what `try_files` rewrote to.**
  `header /index.html Cache-Control "no-cache"` matched literally nothing,
  because a browser asks for `/`, `/portal`, `/clients` — never `/index.html`.
  The SPA shell was cached for hours and deploys were invisible to the user.
  Verify a header by fetching a real route, never by reasoning about the config.
- Back the file up before editing it and `validate` before reloading.

### Tool Selection Matrix

| Scenario | Tool | Why |
|---|---|---|
| Verify a UI change | `chrome-devtools-axi` | tsc cannot see a blank page or an invisible button |
| Verify an API change | `curl` against `:4300` | Faster, and isolates server from client |
| Verify a tenancy rule | `npm run test:isolation` + mutation | Only a failing mutation proves the test works |
| Change the schema | `db:generate` → review SQL → `db:migrate` | `push` drops columns |
| Change an RLS policy | Hand-written migration + journal entry | Drizzle does not generate policies |
| Inspect production data | `psql "$DATABASE_URL_OWNER"` via the tunnel | `bd_app` cannot see across tenants without session vars |
| A request never reaches the server | `journalctl` first, then the Caddy config | No log line means the app never saw it — the fault is in front of it |
| Verify a change reached the user | `curl -D -` on a real route | A deployed file is not a served file; caching sits in between |
| Exercise a route without touching production | Boot a second instance on `:4399` against `bd_portal_test` | The only safe way to drive the real API end to end |

---

## Session Lifecycle

### Session Protocol

```bash
# 1. Bring the environment up
npm run db:tunnel &                   # or a separate terminal
npm run dev:api &
npm run dev &

# 2. Confirm it is actually healthy before assuming anything
curl -s http://127.0.0.1:4300/healthz

# 3. Read before writing — this is a brownfield codebase
#    3+ existing files in the area you are about to change

# 4. Work: edit, then verify in the browser or with curl

# 5. Quality gates
npx tsc -b && npm run lint && npm test && npm run test:isolation
```

### Landing the Plane

Every session **MUST** end with all applicable steps:

1. **Run every gate.** `npx tsc -b`, `npm run lint`, `npm test`, `npm run test:isolation`. All four green.
2. **Mutation-test any new security test.** Break the rule, watch it fail, restore.
3. **Commit** with a message that says why, and what was verified.
4. **Deploy if the human asked.** `npm run deploy`, then confirm `/healthz` on the live URL.
5. **Report honestly.** State what you verified, what you could not verify and why, and what you deliberately left undone. Never imply a check you did not run.

---

## Known LLM Failure Modes

These are **observed** on this codebase, not hypothetical. Each one shipped a real bug.

### Failure Mode 1: Trusting `.partial()` to strip defaults

**The bad behavior:** Writing a PATCH schema as `createSchema.partial()`.

**What happened:** `PATCH /portal/tasks/:id` with body `{"done":true}` parsed to `{done:true, visibleToClient:true}`. Ticking off "INTERNAL: chase unpaid invoice" **published it to the client**.

**The correct behavior:** Write update schemas separately, with **no defaults**. `server/__tests__/patch-schemas.test.ts` enforces this. Defaults belong to creates.

### Failure Mode 2: Interpolating Drizzle columns into correlated subqueries

**The bad behavior:** ``sql`select count(*) from ${tasks} where ${tasks.clientId} = ${clients.id}` ``

**What happened:** Drizzle renders those **unqualified**, so `"id"` bound to `tasks.id`. The comparison was always false and every dashboard count read **zero** — no error, no warning.

**The correct behavior:** Write correlated subqueries with explicit aliases: `from tasks tk where tk.client_id = clients.id`.

### Failure Mode 3: Casting the staff flag

**The bad behavior:** `nullif(current_setting('app.is_staff', true), '')::boolean`

**What happened:** Postgres accepts `yes`, `y`, `on`, `t`, `1` as booleans. `app.is_staff = 'yes'` granted **full staff escalation**.

**The correct behavior:** `current_setting('app.is_staff', true) = 'true'`. Exact comparison. **NEVER reintroduce a cast here.**

### Failure Mode 4: Writing staff-only tables from a client context

**The bad behavior:** A client approving content, with the handler updating `content_items` and inserting into `activities` under the client's own tenant context.

**What happened:** RLS rejected it and **rolled the whole transaction back** — the approval row silently never appeared.

**The correct behavior:** Establish authority under the caller's own context (an item they cannot see is *not found*), then run the bookkeeping under `withTenant({ userId, isStaff: true })`. See `POST /api/content/:id/decision`. **Do not** grant clients write access to those tables.

### Failure Mode 5: Query keys that do not match

**The bad behavior:** A page keyed on `['portal', selected ?? 'default']` while panels wrote `['portal', clientId]`.

**What happened:** Optimistic updates landed on a cache entry that did not exist. Checkboxes did not move until a refetch. Separately, approving a post left the panel reading "2 posts need your review" — indistinguishable from failure.

**The correct behavior:** Address by prefix (`setQueriesData({ queryKey: ['portal'] }, …)`), and invalidate **every** key a mutation affects — including `['next-steps']` and `['clients']`.

This has already bitten once. Renaming the review-queue key from `['awaiting']` to `['next-steps']` left two mutations invalidating the old name, which nothing read any more: approving a post and ticking off a to-do both left the Next Steps panel showing work that was already done. When you rename a query key, grep for the OLD one — the compiler cannot, because it is a string.

### Failure Mode 6: State that lives in one component and is guessed elsewhere

**The bad behavior:** The workspace selection living in the Homepage's local state while the Ideas Bank and Calendar sent no client at all.

**What happened:** Selecting "Verdant Botanicals" and clicking to the Ideas Bank showed **Acme Skincare's** content with nothing on screen to say so. You could schedule or approve against the wrong client.

**The correct behavior:** Shared, persisted, **derived** state — `src/features/portal/use-workspace.ts`. Include the workspace in query keys.

### Failure Mode 7: Assuming instead of reproducing

**The bad behavior:** Declaring something fixed because the code looks right.

**What happened:** Repeatedly, tests passed for the wrong reason. Fail-closed tests passed whether or not `missing_ok` was present, because pooled connections retain the GUC.

**The correct behavior:** **Reproduce the bug first, fix it, then reproduce the fix.** For security rules, mutation-test.

### Failure Mode 8: Suppressing the error that explains the failure

**The bad behavior:** `pg_restore ... 2>/dev/null`.

**What happened:** The restore check reported "the dump restored but is empty". The real message was `Permission denied` — `postgres` cannot read `/home/yota`. Debugging took far longer than it should have.

**The correct behavior:** Never discard stderr in a verification script.

### Failure Mode 9: Over-clever TypeScript

**The bad behavior:** `c: Parameters<Parameters<typeof routes.get>[1]>[0]` to type a Hono context.

**What happened:** Resolved to `never`; a cascade of confusing errors. Written twice, in two different files.

**The correct behavior:** `import { type Context } from 'hono'`.

### Failure Mode 10: Date and money shortcuts

**The bad behavior:** `new Date().toISOString().slice(0,10)` for a calendar date; float arithmetic for currency.

**What happened:** The ISO conversion goes through UTC, so east of Greenwich an evening click lands on the **previous day**. Float sums drifted (`4299.599999999999`), and rounding rendered £2,400.50 as "£2,401".

**The correct behavior:** Build dates from local parts (`isoDate()` in `calendar.tsx`). Use `toPence`/`sumPence`/`formatPence`.

### Failure Mode 11: Tailwind classes that silently do nothing

**The bad behavior:** `-rotate-15` (not on Tailwind's scale); `group-hover:opacity-100` with no `group` ancestor.

**What happened:** The peel mark never rotated. The calendar's add button sat at `opacity: 0` **permanently** — unreachable by mouse.

**The correct behavior:** Use arbitrary values (`-rotate-[15deg]`) for off-scale numbers, and verify hover affordances **in the browser**.

### Failure Mode 12: Building for the happy path only

**The bad behavior:** Rendering the empty state when a query fails; skeletons with no error branch.

**What happened:** "No clients yet. Add the first one." when the request had failed — a lie the user would act on. The client detail page skeleton-ed **forever** on a 404.

**The correct behavior:** Branch on `isError` **before** `isEmpty`. Use `QueryError`. Give the user a way out.

**The same bug, second form:** a stat tile rendered its VALUE inside the loading
branch but its HINT outside it, so before the queries returned the dashboard
read "Nothing outstanding" over an empty array — a confident, wrong answer to
the one number on that screen worth acting on. Everything derived from a query
belongs inside the loading branch, not just the headline number.

---

### Failure Mode 13: Writing to a tenant table without a tenant context

**The bad behavior:** `await db.insert(invitationGrants).values(...)` — a bare
`db` call against a table that carries RLS.

**What happened:** `POST /api/seats/invite` created the invitation through
Better Auth, committed it, then hit `42501` staging the workspace grants. A
bare `db` call has no session variables at all, which is indistinguishable from
an anonymous request, so `app_is_staff()` is false and the `WITH CHECK` refuses
the row. She saw "Internal server error", a seat was consumed, the invitee got a
working link, and accepting it granted them nothing. Every client invitation was
broken; nobody noticed because there is no UI for that endpoint.

**The correct behavior:** `db` directly is ONLY for tables with no policies —
the Better Auth tables and `system_meta`. Everything else goes through
`withTenant()`. This is invariant 2 and it is not a style preference.

---

### Failure Mode 14: Affordances that depend on JavaScript

**The bad behavior:** a `hidden` file input plus `ref.current.click()`.

**What happened:** Tailwind's `hidden` is `display:none`, and a `display:none`
file input does not reliably open its picker from a programmatic click —
Safari and iOS ignore it. No picker, no request, no error, and NOTHING in
`journalctl` because nothing ever reached the server. It read as "uploads are
broken" for two weeks. Changing `hidden` to `sr-only` narrowed it without
removing it.

**The correct behavior:** use `src/components/upload-button.tsx`. It is a native
`<label for>`, which every browser honours with no script at all. When an
affordance can be native, make it native — it then survives a stale bundle, a
blocked script, and a browser nobody tested.

---

### Failure Mode 15: Judging a rule on the request instead of the resulting row

**The bad behavior:** `if (patch.scheduledAt === null) clearTheTime()`.

**What happened:** the rule "a time cannot exist without a date" only fired when
a request explicitly said `scheduledAt: null`. Sending just a time to an undated
idea stored "18:30, no date" — a row the calendar cannot place, whose time
resurfaces at a slot nobody chose the day the post is finally scheduled. The
hole was in the direction nobody thought to check.

**The correct behavior:** compute what the row will BE (`patch.x !== undefined ?
patch.x : before.x`), then apply the rule to that. Extract it as a pure function
so it can be asserted rather than read. See `scheduleOverrides` and
`timeForNewItem` in `server/routes/content.ts`.

---

### Failure Mode 16: Announcing a refactor without checking every call site

**The bad behavior:** a commit message reading "all three call sites now share
this" when there were four.

**What happened:** three upload sites were converted to the shared button and
the content detail dialog was missed — the one place she uploads video to a
post, left on exactly the broken pattern the change existed to remove. The
commit claimed the problem was solved.

**The correct behavior:** grep for the pattern before writing the claim, and
again after. `grep -rn "type='file'" src/` takes two seconds and is the
difference between a true and a false commit message.

---

### Failure Mode 17: Assuming a standard-library function implements the standard

**The bad behavior:** `filename*=UTF-8''${encodeURIComponent(name)}`.

**What happened:** `encodeURIComponent` deliberately leaves `!*'()` unescaped,
and the apostrophe is the DELIMITER in `UTF-8'<lang>'<value>`. "Sofia's
Agreement.pdf" produced a header a strict parser may truncate at that quote.
Near-miss, not a miss: the function is 95% of RFC 5987 and the missing 5% is the
delimiter itself.

**The correct behavior:** when emitting a wire format, read what the format
requires and check the encoder against it. Test with input containing the
awkward characters — an apostrophe in a client's filename is not an edge case
for a London agency.

---

### Failure Mode 18: Renaming a query key and leaving the old one behind

**The bad behavior:** You rename a TanStack Query key — `['awaiting']` becomes `['next-steps']` — update the `useQuery` that reads it, run the type-checker, and ship. Every `invalidateQueries` call still names the old key. Nothing errors, because a query key is a string and the compiler cannot see it. The panel simply stops refreshing: she approves a post and it stays in the list, ticks off a to-do and its deadline keeps counting down. The one panel whose job is to say what is outstanding now lies about it, and it looks like a stale cache rather than a bug you introduced.

**The correct behavior:** After renaming a key, `grep` for the OLD string across `src/` and confirm zero results. Then ask which mutations *should* invalidate the new key — not just the ones that used to. Tasks feed the Next Steps panel and never invalidated it at all, which no rename would have revealed.

---

### Failure Mode 19: Comparing a form value against stored state to detect a change

**The bad behavior:** You write `onBlur={(e) => { if (e.target.value !== row.field) patch(...) }}` and call it dirty-checking. The input's `defaultValue` is `row.field ?? someFallback`. Every row has `null` there, so the control displays the fallback, the fallback is not `null`, and the two are "different" the instant the field loses focus. Tabbing through the form writes a value the human never chose — silently, to a live database, with an activity-log entry claiming they did it.

**The correct behavior:** Gate on a real interaction, not on a value comparison. Record an explicit touched flag in `onChange` and only save on blur if it is set. For `<input type="color">` specifically, do NOT save in `onChange` alone: Chrome fires it continuously while a colour is dragged, so one pick becomes a dozen PATCHes and a dozen activity rows.

---

### Failure Mode 20: Two props that silently contradict each other

**The bad behavior:** A component takes `markOnly` and `canEdit`. `markOnly` returns early — before the branch that renders the upload control — so passing both gives a control that cannot be used, with no warning, no type error and nothing in the console. You then pass both at a call site and report the feature as delivered.

**The correct behavior:** When you add a prop that short-circuits rendering, check every other prop it now silences. Either make them compose or make the combination impossible in the type. Then write the test for the combination — `markOnly` plus `canEdit` renders a file input — because the compiler will never catch this class of defect.

---

### Failure Mode 21: Hiding a thing from one list and calling it removed

**The bad behavior:** You implement "archive" as a timestamp plus a filter on the one list you were looking at, verify that list, and report it done. The archived client stays on the pipeline board, in the dashboard's next steps, and anywhere else that joins `clients`. The feature's NAME promises removal and it delivers removal from a single screen — which is worse than not building it, because she now believes those clients are gone.

**The correct behavior:** Before claiming a state change is applied, enumerate every read path that touches the entity — `grep` for the table name across `server/routes/` — and decide for EACH one whether the new state applies. Write down the exceptions and why (here: invoices, deliberately, because money owed must not vanish). Then verify against a running server rather than by reading the code you just wrote.

---

## Appendix A: Environment Variables

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Runtime connection | **MUST** be `bd_app`. The guard refuses to boot otherwise. |
| `DATABASE_URL_OWNER` | Migrations only | `bd_owner`. The app never connects with this. |
| `TEST_DATABASE_URL` / `_OWNER` | Isolation suite | `bd_portal_test`. **Never** point at `bd_portal`. |
| `PORT` | API port | 4300 |
| `NODE_ENV` | `development` \| `production` \| `test` | Production serves `dist/` from Node if Caddy is absent |
| `LOG_LEVEL` | pino level | `info` in production |
| `COOKIE_SECURE` | `Secure` flag on session cookies | **`false` today — the site is HTTP.** Flip to `true` the moment it is HTTPS, or every login silently fails. |
| `MAX_SEATS` | Seat cap | 10 |
| `UPLOAD_DIR` | Where bytes land | `./.uploads` locally, `/home/yota/data/bd-portal/uploads` on VPS4 |
| `APP_URL` | Public origin | Better Auth derives callbacks and trusted origins from it |
| `BETTER_AUTH_SECRET` | Session signing key | **Required in production.** Rotating it logs everyone out. |

## Appendix B: Quick Reference

| I want to… | Command |
|---|---|
| Start everything | `npm run db:tunnel` + `npm run dev:api` + `npm run dev` |
| Add a table or column | `npm run db:generate` → read the SQL → `npm run db:migrate` |
| Add an RLS policy | Write `server/db/migrations/00NN_*.sql`, add it to `meta/_journal.json`, `npm run db:migrate` |
| Migrate the test DB | `DATABASE_URL_OWNER="$TEST_DATABASE_URL_OWNER" npx tsx scripts/migrate.ts` |
| Create the first account | `npm run bootstrap -- --email … --password …` |
| Rotate a password | `npm run set-password -- --email … --password …` |
| Check tenancy still holds | `npm run test:isolation` |
| Add a tenant table | migration + RLS policy + `guard.ts` list + `fixtures.ts` lists + fixture rows |
| Add a staff-facing list that joins `clients` | Add `isNull(clients.archivedAt)` — invariant 15 |
| Rename a query key | Change it, then `grep -rn "'oldKey'" src/` and expect zero — invariant 18 |
| Copy text to the clipboard | `copyText()` from `src/lib/copy-text.ts`. NEVER `navigator.clipboard` |
| Open a file picker | `<UploadButton>`, or a native `<label htmlFor>`. NEVER a scripted `.click()` |
| Retire a client | Archive it. There is no delete, and there must not be one |
| Drive the API without touching production | boot a second instance on `:4399` against `bd_portal_test` |
| Find out why a request "did nothing" | `ssh vps4 journalctl --user -u bd-portal -n 50` — no line means it never arrived |
| Deploy | `npm run deploy` |
| Read production logs | `ssh vps4 journalctl --user -u bd-portal -n 50` |
| Restart production | `ssh vps4 systemctl --user restart bd-portal.service` |
| Check production health | `curl http://161.97.76.197:8100/healthz` |

## Appendix C: Current Known Limitations

State these plainly when relevant. Do not paper over them.

- **The site is HTTP.** Passwords cross the wire in plaintext. `COOKIE_SECURE=false` follows from this.
- **No self-service password change.** Rotation requires `scripts/set-password.ts` on the server.
- **No email.** Invitations are copyable links; nothing notifies a client that content awaits them except the in-app review queue.
- **Backups sit on the same disk as the data.** They survive a mistake, not a disk failure. Copy the newest pair off the box after any session that mattered — see Backups above.
- **Mobile layout is unverified.** The browser harness cannot resize, and it cannot switch engine either: **nothing here has been verified on Safari or iOS**, which is where the upload picker failed. Say so rather than implying coverage.
- **No per-client timezone.** `content_items.scheduled_time` is a bare wall-clock time and means her local reckoning. Correct for a London agency today; it is the thing to revisit before an international client.
- **No platform model.** `content_type` is a FORMAT (video/reel/story/graphic/carousel), not a channel. There is no Instagram-vs-TikTok distinction and one caption and one hashtag set serve all destinations — the 30-tag warning names Instagram because that is the strictest, not because the post is bound to it. The Feed Preview is a hardcoded 3x3 Instagram grid.
- **Approvals do not bind to an asset version.** `content_assets.version` and `content_approvals.version` are always 1. A client approves, the creative is replaced, and the approval row still says approved.
- **`review_links` is schema only.** The table and its policy exist; there are no routes. Stakeholders outside the 10 seats cannot review anything.
- **The seat cap counts client users.** `MAX_SEATS` is 10 across staff AND every client's users, because clients are modelled as members of the agency org.
- **`audit_log` is write-only.** Every mutation writes one; nothing reads them back. There is no screen and no export.
- **The Ideas Bank create form has no caption, hashtags or upload — deliberately.** It is quick capture for a backlog that includes pitches which never happen, and a caption box at that stage invites writing final copy for a post that may not exist. The calendar dialog takes all three. Do not "fix" this without asking.
- **Archiving does not touch invoices.** An archived client keeps their unpaid invoices in the payments view, by design (see Key Design Decisions). Nothing warns her at archive time that a client still owes money.
- **No scheduled or outbound anything.** No weekly digest, no reminder, no notification. Every panel is pull, not push, so an item only chases someone if they open the page.

</INSTRUCTIONS>
