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
| `$DATA_DIR/` (VPS4) | Production uploads and backups. |
| `$WEB_DIR/` (VPS4) | The served frontend. |

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

   `task_comments` and `client_credentials` (migrations 0021 and 0022) are the worked example: both are in the RLS migration, the guard list, all three fixture class lists, and both have rows for BOTH clients — including a reply on an INTERNAL to-do, which is the row that makes the parent-visibility test fail when the parent clause is removed.

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

**Node 18 will not work.** Vite 8 requires ≥20. The system Node on VPS4 is 18.20.8, which is why the systemd unit hardcodes `$NVM_DIR/versions/node/v20.20.2/bin/node` — **systemd does not source `~/.nvm`**.

### Key Dependencies

| Package | Purpose |
|---|---|
| `hono` + `@hono/node-server` | API server |
| `drizzle-orm` + `drizzle-kit` | Schema, queries, migrations |
| `pg` | Postgres driver; the pool `withTenant` runs transactions on |
| `better-auth` | Sessions, the single organization, members, invitations |
| `@tanstack/react-router` | File-based routing, route guards |
| `@tanstack/react-query` | Server state, optimistic mutations |
| `sharp` | Image thumbnails (400px webp), SVG rasterising, TIFF decoding |
| `libheif-js` | HEIC decoding — an iPhone photo. WebAssembly, so there is nothing to rebuild on the host; sharp's bundled libheif has the AV1 decoder for AVIF and no HEVC one, and VPS4's ffmpeg 6.1 cannot open a HEIF at all |
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
| Secrets | `server/__tests__/secrets.test.ts` | The password hub's AES-256-GCM: round trip, tamper detection, wrong key, refusing to run unconfigured. Pure — no database, no server |
| URL safety | `src/lib/safe-href.test.ts` | `javascript:`/`data:` refused; `//evil.com` is not an internal path |
| Components | `src/**/*.test.tsx` | Sign-in, config drawer, search palette, client logo, hashtag editor |

The contract suite also binds the two copies of hashtag normalisation and the `canSeePortal` predicate. See invariant 17.

Current counts: **108 component tests, 340 server tests.** If a change drops either number, you deleted a test — or a suite stopped running. Both have happened; see Failure Mode 25.

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
  Local disk: $DATA_DIR/uploads
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
                         document sniffing (PDF/OOXML/CSV), 1 GB ceiling.
                         HEIC/TIFF/SVG are accepted and CONVERTED on ingest —
                         see CONVERTED_IMAGE_MIME
    seed-workspace.ts    Her 10 links (TikTok/Instagram/Facebook first) /
                         5 file slots / 4 onboarding to-dos
    hashtags.ts          normaliseHashtags/parseHashtagInput. MIRRORED in
                         src/lib/hashtags.ts — see invariant 17
    secrets.ts           AES-256-GCM for the password hub. Its OWN module with
                         no imports, so a test can reach it without booting an
                         HTTP server — same rule as redact.ts
  middleware/
    session.ts           withSession, requireAuth, requireStaff
    rate-limit.ts        In-process fixed-window limiter
  routes/                clients, deals, invoices, portal, content, media,
                         next-steps, seats, invitations
    shares.ts            Mint/list/revoke share links. STAFF ONLY. Mounted at
                         /api/shares — the paths inside are relative to that
                         mount, because mounting at /api once made its
                         `use('*', requireStaff)` apply to the WHOLE API and
                         locked every client out of their own portal.
    review.ts            The PUBLIC share-link surface. No auth middleware at
                         all, by design. May never use withTenant — a test
                         asserts the file does not contain the string.
    stripe.ts            The Stripe webhook. Unauthenticated by necessity; the
                         signature over the RAW body is its authentication.
  lib/stripe.ts          The Stripe client, or null when unconfigured.
  lib/review-tokens.ts   Mint/hash a share token; isLinkUsable (server copy).
  lib/redact.ts          redactPath(). Its OWN module with no imports, because
                         importing server/index.ts to test a pure function
                         boots an HTTP server — see Failure Mode 25.
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
                         navigator.clipboard can reject even on HTTPS.
  lib/route-guards.ts    requireStaffRoute()
  hooks/use-current-user.ts   /api/me — the single authority on isStaff
  components/upload-button.tsx  THE way this app opens a file picker. A native
                         <label for>, never a scripted .click().
  components/client-logo.tsx    The client's mark, with initials on their brand
                         colour as the fallback. The mark ITSELF is the upload
                         target when canEdit.
  features/
    share/index.tsx           The public share page. Uses AuthLayout, never
                              Header/Main — those need the sidebar.
    settings/seats/           Who can sign in, invite, revoke, remove.
    clients/tabs.ts           The client page's four tabs. Its own module: the
                              route validates ?tab= against it, and importing
                              it from the page component makes a cycle that
                              collapses the router's types to `never`.
    content/moodboard-lightbox.tsx  Click a tile to see the full image.
    content/share-links.tsx   The Share popover on a post.
    portal/use-workspace.ts   Persisted workspace selection (shared, derived)
    content/                  Ideas Bank, Calendar, Feed, Moodboard,
                              moodboard-preview (strip, reused),
                              hashtag-editor.tsx (chips, 30-tag counter).
                              review-queue.tsx exports NEXTSTEPS — the file
                              kept its old name so no import path moved.
    invoices/panel.tsx        Invoices + receipts. ONE panel for both audiences.
    invoices/document.tsx     The invoice as the DOCUMENT she sends — her
                              layout, printable, with the Pay button on it.
                              The PDF is the browser's; see the print rules in
                              src/styles/index.css
    content/post-grid.tsx     Posts as square previews. One component, two
                              filters: "Needs a decision" (pending + declined)
                              and "Coming up" (approved)
    portal/task-thread.tsx    The reply thread on one to-do. Both sides write
    portal/credentials.tsx    The password hub, same component both sides
    clients/ pipeline/ dashboard/ auth/
  routes/                TanStack file-based routes

scripts/
  migrate.ts             Applies migrations as bd_owner
  bootstrap.ts           Creates the org + first owner (sign-up is disabled)
  set-password.ts        Rotates a password; revokes that user's sessions
  db-tunnel.sh           localhost:55432 -> $HOST:5432, auto-reconnecting
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
| `task_comments` | Replies on a to-do, so both sides can talk about one. Shaped exactly like `content_comments`, and inherits its parent's visibility rather than restating it. No UPDATE policy. | `server/db/schema.ts` |
| `client_credentials` | The password hub. `secretCipher` is AES-256-GCM ciphertext and never a password; the plaintext never enters a list payload. Client-WRITABLE — they fill it in. | `server/db/schema.ts` |
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
- **`navigator.clipboard` is never called directly.** The original reason has expired — the portal is HTTPS now, so it is present in production — and the rule stands on its remaining ones: it rejects when the document is not focused or permission is refused, the old bare-IP URL still forwards traffic that arrives over plain HTTP, and `copyText()` reports whether the text actually landed instead of throwing. A copy button that silently does nothing is the failure this exists to prevent. Use `src/lib/copy-text.ts`.
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
| 16 | Browser APIs are feature-detected before use, never assumed | `navigator.clipboard` shipped broken once: it is secure-context only, and the site was plain HTTP while dev was localhost, so it worked everywhere it was tested and nowhere it mattered. HTTPS closed that specific gap and not the class — an API present in your browser is not evidence about hers |
| 17 | Logic duplicated across the client/server boundary is bound by a test in `contract.test.ts` | The server cannot import from `src` and the browser should not import from `server`, so some logic exists twice. Two copies that drift produce a UI that disagrees with what was saved. Both hashtag normalisers run over the same inputs there |
| 18 | A query key rename is finished only when the OLD key has no references left | Keys are strings; the compiler cannot see them. Renaming one already left two mutations invalidating a key nothing read |
| 19 | A client-role user may reach **nothing** belonging to a workspace whose `portal_enabled` is false, or whose client is archived | Enforced in `app_client_ids()` (migration 0014), which every client-visible policy goes through, and again in `resolveClientId`. It lived only in `canSeePortal` before, so the toggle closed the homepage and left the calendar, ideas bank, feed and moodboard fully readable. `invoices` and `invoice_payments` are the stated exception — money owed must not vanish |
| 20 | A stored password is encrypted **before it reaches Postgres**, and is never in a list response | The nightly dump is copied to a laptop by this repo's own runbook, `bd_owner` can read every row, and the class of bug this schema is arranged around is a SELECT that leaks. All three then leak ciphertext. Revealing one is its own request and writes an audit row; there is deliberately no mode that stores plaintext "for now". `hasSecret` is computed by Postgres (`secret_cipher IS NOT NULL`) so the ciphertext is never selected — the first version selected it and dropped it with a `.map()`, which is the same rule enforced one layer too late |
| 21 | An invoice has exactly ONE line item, because `invoices.amount_pence` is one integer | The printable document renders it as row 1 and puts the itemisation in the description, line breaks preserved. Splitting the money across rows needs a line-items table AND a second answer to "what is owed" — the one number both sides have to agree on |

### Share Links (`review_links`)

**What they are.** A bearer token in a URL that lets someone with NO ACCOUNT
open one post, or one client's feed grid, and approve it. Whoever holds the
link can approve — that is the property being chosen, and the UI says so beside
the copy button.

**The token.** 32 random bytes, base64url. Only its `sha256` is stored, so the
API physically cannot re-display a link and a `backup.sh` dump contains no live
approval credentials. Minting a replacement is one click. **256 bits of entropy
is what makes guessing infeasible — not the rate limiter**, which protects the
box from the traffic, a different job.

**How authority is obtained.** `withReviewToken(tokenHash, {bump}, fn)` in
`server/db/index.ts` is the ONLY way. It refuses to set any session variable
until the hash redeems against a live, unrevoked, unexpired link belonging to a
non-archived client. Compare with `withTenant`, which takes a context object it
trusts — this one earns it.

| Rule | Why |
|---|---|
| `review.ts` may never use `withTenant`, `c.get('tenant')` or `isStaff: true` | The single worst regression on this boundary is somebody "fixing" a permissions error by reaching for `withTenant`. A source-text test in `contract.test.ts` asserts the file does not contain those strings, with comments stripped first |
| Redemption goes through `redeem_review_link()` | `review_links` is staff-only, so a plain `UPDATE` from an unauthenticated request matches zero rows. Written that way first; every valid link 404'd. A policy arm keyed to a GUC would be circular — the GUC is SET BY redemption |
| Decisions go through `record_review_decision()` | Recording one is not a single insert: the item's status moves and an `activities` row is written, both staff-only. `content_approvals_insert` therefore gains NO review arm, which makes "a review context cannot insert an approval at all" a positive property the isolation suite asserts |
| `AND visible_to_client` on both `content_items_select` review arms | LOAD-BEARING. It is what stops a token minted around the handler opening a raw Ideas Bank row, at the database rather than only in the route |
| The asset arm composes: `content_item_id = app_review_content_id() AND content_item_id IN (SELECT id FROM content_items)` | Direct equality ALONE leaked. A token aimed at an unshared post could not read the post but COULD read its creative — migration 0006's bug through a new door, caught against a fixture called `secret-pitch-deck.png` |
| `content_comments_*` is untouched | A link holder approves and leaves a note; that is all. Narrower than 0002's instruction permits is fine, wider is not |
| Revoke, never DELETE | `content_approvals.review_link_id` is `ON DELETE SET NULL` under `CHECK num_nonnulls(actor_id, review_link_id) = 1`, so deleting a used link violates the check. Probed on all three cascade paths: deleting a link alone FAILS; deleting its content item or its client is fine |
| The path is redacted from the log | A share URL IS a live approval credential and every request logs its path. `redactPath()` blanks it. **Caddy keeps its own access log outside this repo and must be checked separately.** `/api/shares/…` is deliberately NOT redacted — those are link ids, not credentials |

### Stripe

**What it is.** Hosted Checkout for what is OUTSTANDING on an invoice. No card
number touches this server, which keeps the application out of PCI scope.

**One endpoint, two audiences.** `POST /invoices/:id/checkout` serves her "send
a payment request" button and the client's "Pay now". Which you get is decided
by who is signed in. **The boundary is RLS, not a check in the handler** — a
client asking about an unissued draft gets 404 because `invoices_select` gates
on `issued_on`.

| Rule | Why |
|---|---|
| A card payment goes through `recordPayment()` — the same function she uses by hand | One overpayment rule, one receipt sequence, one audit row. A second implementation for Stripe would be a second set of money rules that drift the first time one is corrected |
| Amounts pass through untouched | Stripe wants the smallest currency unit, which is what this codebase already carries. There is no `* 100` anywhere for a float to spoil |
| The webhook verifies the signature over the RAW body | Parsing and re-serialising changes key order and whitespace, and every signature then fails for reasons that look like a wrong secret |
| No `STRIPE_WEBHOOK_SECRET` means REFUSE, never "trust for now" | An unverified webhook is an open endpoint that marks invoices paid |
| The duplicate check runs BEFORE the money rules | Stripe redelivers until it gets a 2xx, so repeats are ORDINARY. Falling through to the overpayment refusal logged `CARD PAYMENT TAKEN THAT COULD NOT BE RECORDED` on every retry — a standing alarm about a non-event, which is the one she learns to ignore |
| The partial unique index on `external_id` is the backstop | Two deliveries in flight at once, both reading before either writes. Code cannot settle that race. Partial, because a plain unique index would allow exactly ONE hand-entered payment across the agency where they all share NULL |
| A session that completed but is not `paid` records nothing | A delayed payment method can complete without money arriving |

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
| `/api/portal`, `/api/content`, `/api/media` | authed | `?client=<uuid>` honoured for staff, **ignored** for clients. A client whose portal is closed (or whose account is archived) gets 404 from all three — invariant 19 |
| `/api/portal/tasks/:id/comments` | authed | The reply thread on one to-do. GET and POST are open to BOTH audiences by design — a thread only the agency can write in is a notice board. DELETE is staff only, and there is no edit at all |
| `/api/portal/credentials` | authed | The password hub. Client-writable: they fill it in. The list carries `hasSecret`, never the secret |
| `/api/portal/credentials/:id/reveal` | authed | Returns ONE plaintext password and writes an audit row naming who looked. 503 when `CREDENTIALS_SECRET` is unset; 409 for a row saved under a previous key |
| `/api/invoices/settings` | GET authed, PATCH staff | Payment method, payment condition and closing line for every invoice document. Readable by a CLIENT — it is the block telling them where to send the money |
| `/api/next-steps`, `/api/next-steps/:clientId` | authed | Posts awaiting a decision plus dated open to-dos, soonest first. One loader serves both — do not add a second query |
| `/api/clients/:id/archive`, `/restore` | staff only | Archive is a timestamp, never a DELETE. It closes the portal and drops the client from `/api/clients`, `/api/deals` and `/api/next-steps` — but **not** from `/api/invoices`: tidying a client away must never hide money owed. Any new list that joins `clients` for staff needs `isNull(clients.archivedAt)`, because RLS deliberately still shows staff the row |
| `/api/media/clients/:id/logo` | authed | Reads the key off the row, never from the URL; RLS decides who sees it |
| `/api/seats` | staff only | Seat cap of 10, counting members + pending invitations |
| `/api/invitations/:id` | public | Rate limited; the invitation id is the credential |
| `/healthz` | public | Asserts DB **and** uploads, not just a socket |

Status codes: `401` unauthenticated, `403` wrong role, `404` invisible-or-absent (**deliberately indistinguishable**), `409` state conflict, `413` too large, `415` wrong file type, `429` rate limited.

---

## Operational Tooling

### Configuration Files You Must Create

Two files are gitignored and neither is optional. Nothing works without them,
and the failure looks like a bug rather than missing setup.

| File | From | Holds |
|---|---|---|
| `.env` | `.env.example` | Database URLs, `BETTER_AUTH_SECRET`, Stripe keys |
| `deploy.config.sh` | `deploy.config.example.sh` | Where production lives: SSH alias, app and web roots, data dir, health URL |

`deploy.config.sh` is gitignored because **this repository is public**. The
server's address, account name and directory layout are not credentials — SSH
is key-only and Postgres is firewalled — but there is no reason to publish the
floor plan. Every script sources it relative to its own location, so it resolves
the same from a laptop, from cron on the server, and from a systemd timer, and
`deploy.sh` rsyncs it to the host so the scripts that run THERE find it too.

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

**When it will not run at all.** In at least one session the bridge answered
every `snapshot`, `eval` and `click` with `Invalid arguments … Required at
pageId` and could not be recovered by restarting it. The fallback is
Playwright, which is already a dependency (the component suite runs on it) —
drive it from a script in the scratchpad and READ the screenshots. Do not
report a UI change as verified because the tool that verifies it was broken.

**Do not verify UI against production data.** `npm run dev` proxies `/api` to
`:4300`, which is the live agency's database. `VITE_API_TARGET` overrides that
target, so a second dev server can be pointed at a second API:

```bash
# an API on the TEST database…
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_OWNER="$TEST_DATABASE_URL_OWNER" \
  PORT=4401 APP_URL=http://localhost:5199 npx tsx server/index.ts
# …and a dev server pointed at it
VITE_API_TARGET=http://127.0.0.1:4401 npx vite --port 5199 --strictPort
```

`APP_URL` must match the dev server's origin or Better Auth answers **403
INVALID_ORIGIN** on sign-in, which looks like a wrong password and is not.
`bootstrap.ts` refuses if an organization already exists; on the test database
`delete from organization` first — the isolation fixtures create their own.

**Common pitfalls.**
- **uids go stale.** Take one snapshot and use uids from *that* snapshot. Grepping a fresh snapshot for each uid gives mismatched ids and silent no-op clicks.
- `eval` needs a single expression — wrap multi-statement code in an IIFE.
- Synthetic pointer events do **not** drive dnd-kit; the harness cannot emit the intermediate moves it tracks.
- The headed window **does not resize**, so mobile layout cannot be verified here. Say so rather than claiming it works.

### Deploy (`npm run deploy`)

**What it does.** rsyncs source to VPS4, installs and builds **on the host**, publishes `dist/` to `$WEB_DIR`, applies migrations, restarts the service, and waits for health.

**When to use.** Any change the human wants live.

**Common pitfalls.**
- **Native modules must build on the host.** `sharp` from macOS will not load on Linux. Never rsync `node_modules`.
- `.env` is excluded on purpose. Production secrets live only on the server.
- Caddy cannot traverse `the deploy user’s home` (mode 0750) — that is why `dist/` is published to `$WEB_DIR`. Serving from the home directory returns **403**.
- **The URL must not change.** `https://portal.bananadigitallondon.com` is shared with a real person. The public URL is deliberately spelled out here while server paths and the bare IP are not: a customer-facing address is not infrastructure detail, and `deploy.config.sh` (gitignored) holds the things that are.
- **The old bare-IP URL still forwards and must keep doing so.** Invitation and share links minted before the domain existed point at it. It cannot serve directly any more — cookies are `Secure`, so a session set over plain HTTP would never come back — so Caddy 302s it to HTTPS.

### Backups

```bash
ssh "$HOST" $APP_DIR/scripts/backup.sh          # nightly via systemd timer
ssh "$HOST" sudo $APP_DIR/scripts/restore-check.sh   # monthly
```

**Pitfall that already bit:** `postgres` cannot read dumps inside `the deploy user’s home` (0750). The restore check stages the dump in `/tmp` first. It once reported "restored but empty" because `pg_restore`'s stderr was discarded — **never swallow errors in a verification script**.

**The backups live on the same disk as the data.** They survive a mistake, not
a disk failure. Copy the newest pair off the box after any session that
mattered:

```bash
mkdir -p ~/Documents/bd-portal-backups
scp "$HOST":$DATA_DIR/backups/bd_portal-<stamp>.dump      ~/Documents/bd-portal-backups/
scp "$HOST":$DATA_DIR/backups/uploads-<stamp>.tar.zst     ~/Documents/bd-portal-backups/
# and confirm the copy is not truncated
ssh "$HOST" md5sum $DATA_DIR/backups/bd_portal-<stamp>.dump
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
| Uploaded files lost | `tar --zstd -xf uploads-<stamp>.tar.zst` into `$DATA_DIR/`. |

Restoring the database is **destructive and manual on purpose** — there is no
script for it, because a script that can overwrite production is a loaded gun
sitting in the repository. Take a fresh dump first, so the state you are
abandoning is itself recoverable:

```bash
ssh "$HOST" $APP_DIR/scripts/backup.sh   # 1. snapshot NOW, before anything
ssh "$HOST" sudo $APP_DIR/scripts/restore-check.sh  # 2. prove the target dump is good
# 3. only then, with the row counts from step 2 in front of you, restore for real
```

Always run step 2 first. It restores into a throwaway database and prints the
row counts, which is how you find out the dump you were about to trust is empty
*before* you have overwritten anything.

### The Ingress (Caddy on VPS4)

**What it does.** Caddy terminates TLS for
`portal.bananadigitallondon.com`, serves the built SPA from `$WEB_DIR`, and
proxies `/api` and `/healthz` to the Node process on `127.0.0.1:4300`. **It is
part of the application** and it has caused a full day of debugging that looked
like an application bug and was not.

**Three site blocks, and they are not interchangeable.**

| Block | Serves | Notes |
|---|---|---|
| `portal.bananadigitallondon.com` | The portal, over HTTPS | Let's Encrypt, auto-renewed by Caddy. Also gets an automatic `:80` → `:443` redirect for this host only |
| `:8100` | A 302 to the domain | The old bare-IP URL. It CANNOT serve directly — cookies are `Secure`, so a session set over plain HTTP is never sent back and login fails silently |
| `:80` | An unrelated site | Not ours. A host-specific match beats a bare port match, which is why adding the domain did not disturb it |

**The certificate came through TLS-ALPN-01, not HTTP-01.** `:80` has a
catch-all for the other site, so the HTTP challenge had nowhere to land. Caddy
fell back on its own because `:443` was free. Nothing needs configuring for
this; know it so the log line is not mistaken for a fault.

**When to look here.** When a request never reaches the server at all. If
`journalctl` shows NO log line for the thing the user says is broken, the
application never saw it — suspect the browser or the ingress, not the code.

```bash
ssh "$HOST" 'sudo cat /etc/caddy/Caddyfile'          # read it
ssh "$HOST" 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh "$HOST" 'sudo systemctl reload caddy'            # apply; never restart blindly
curl -s -D - -o /dev/null https://portal.bananadigitallondon.com/portal | grep -i cache-control
ssh "$HOST" 'sudo journalctl -u caddy --since "10 min ago" | grep -i certificate'
```

**Common pitfalls.**
- **`:80` on that box is a different site.** The bare IP with no port serves an
  unrelated application. Give humans the DOMAIN — never the IP, with or without
  a port.
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

**The same file, the same trap one method along:** `z.string().min(1)` accepts
`"   "`. Every `text NOT NULL` column in this schema takes `''` quite happily,
so a handler that trims AFTER validating writes an empty row — a blank reply
with a timestamp on it, which also increments the reply count, so the panel
advertises something to read that is not there. `.trim()` goes **before**
`.min(1)`, and the handler then stops trimming, because two places deciding
what a value is is how they come to disagree.

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

**What happened:** The restore check reported "the dump restored but is empty". The real message was `Permission denied` — `postgres` cannot read `the deploy user’s home`. Debugging took far longer than it should have.

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

**It happened a second time, in the same shape.** `portal_enabled` was checked
in exactly one function — `canSeePortal`, inside `GET /api/portal` — and the
comment above that check claimed it now closed "links, files, to-dos, notices
and content". It closed the homepage. The content calendar, ideas bank, feed
preview and moodboard all resolve their workspace from `client_access`, which
outlives both the toggle and the archive, so a client whose portal she had
closed still read everything through those four screens. The endpoint the check
lived in was the ONE endpoint that did not need it, because it was the one
being looked at while writing it.

Reproduced against `bd_portal_test` before fixing: with `portal_enabled = false`
*and* `archived_at = now()`, the client user still selected their
`content_items` rows. The fix is migration 0014, which puts the rule in the
policies where every route inherits it — including the id-addressed ones
(`/api/content/:id`, `/api/media/assets/:id`) that no route-level check would
have covered.

**The lesson beyond the grep:** when a rule is enforced in application code, ask
which OTHER handler could reach the same rows without passing through it. If the
answer is "any handler someone writes next year", the rule belongs in the
database.

---

### Failure Mode 22: A refusal that records nothing

**The bad behavior:** an upload is rejected with a 415 and the only trace is
the request line — `POST /api/media/upload 415`. Nothing says what the file
was, what it was sniffed as, or which screen sent it.

**What happened:** she added a photo to a client's moodboard and it was
refused. Answering "why" meant reading the timestamps of the requests either
side of it to work out which screen she was on, then reproducing the pipeline
against a matrix of real files to find which format it must have been. The
answer — an iPhone HEIC — was a one-line lookup that took an hour, because the
one place that knew it threw the fact away.

**The correct behavior:** whatever decides to refuse something is the only code
that knows why. It logs the decision and the evidence it decided on — here the
target, the filename, the size, the sniffed type and the first bytes. Same rule
as never discarding stderr in a verification script (Failure Mode 8): the
message that explains the failure is the whole point.

**And the message the human sees should name the file.** "That does not look
like an image or a video we can handle" is a sentence about a file she cannot
identify when she has selected four of them.

---

### Failure Mode 23: Handing over a live `FileList` and then resetting the input

**The bad behavior:** Passing `e.target.files` to a caller and then clearing the
input so the same file can be chosen twice. A `FileList` is a LIVE VIEW of that
input, so the reset empties the list the caller is holding. Consumers that read
it synchronously are fine; every consumer that reads it asynchronously — and a
TanStack mutation is asynchronous by definition — receives nothing.

This shipped, and it broke **every upload in the application**. The failure mode
is the worst kind: the mutation ran, iterated an empty array, sent NO REQUEST,
and reported SUCCESS. The UI refetched and cheerfully showed the empty state.
No error, no toast, no log line, nothing on the server. Her uploads were not
failing; they were never happening.

**The correct behavior:** Snapshot with `Array.from` BEFORE resetting, and hand
over a plain `File[]` so the type makes the mistake unrepresentable. The same
applies to `e.dataTransfer.files` on a drop handler — also a live view the
browser may empty once the handler returns.

### Failure Mode 24: Adding a storage-key column without registering it

**The bad behavior:** Adding a column that holds a storage key — `fullKey`,
`posterKey`, whatever comes next — without adding its name to the field list in
`keysReferencedBy()` (`server/routes/media.ts`).

That list is the only thing standing between a committed row and its bytes
being deleted as unreferenced. The post-commit cleanup subtracts what the row
references from what the upload produced; a key it cannot see is an orphan by
definition. Adding `fullKey` without it deleted the original BEFORE the response
was sent — the upload succeeded, the row pointed at a file, the file was gone.
Caught by comparing what two URLs served: 274 bytes for the tile and 21 for the
original, which is the length of `{"error":"Not found"}`.

**The correct behavior:** A new key column is a TWO-PLACE change — the schema
AND that list. Verify by fetching the bytes back, not by reading the insert.

### Failure Mode 25: Importing `server/index.ts` from a test

**The bad behavior:** Importing the app entrypoint to reach something exported
from it. That module STARTS AN HTTP SERVER as a side effect, so the vitest
worker tries to listen on `PORT` and dies of `EADDRINUSE` whenever a dev API is
running.

Vitest reported **"3 passed (4)"** and a green-looking 217 with **89 tests
silently never run**. The suite's result depended on what was open in another
terminal.

**The correct behavior:** A pure function that a test needs lives in its own
module that imports nothing and boots nothing — `server/lib/redact.ts` is the
pattern. And READ THE FILE COUNT, not just the test count: `Test Files 3 passed
(4)` is a failure wearing green.

### Failure Mode 26: Adding a process-level handler without re-reading what it changes

**The bad behavior:** Adding `process.on('unhandledRejection')` to survive an
abandoned response — correct in itself — without following through to the code
it changes the meaning of.

Shutdown was `server.close(async () => { await closeDb(); process.exit(0) })`.
A rejecting `pool.end()` used to take the process down: untidy, but it ENDED
the shutdown. With rejections now survived, the same failure skips
`process.exit` and leaves the process alive — so systemd waits its full
`TimeoutStopSec` (90s here) before SIGKILL. Every deploy, silently slower, with
nothing obviously wrong.

**The correct behavior:** A handler that changes what happens to errors changes
every path that was relying on an error to terminate. Grep for `process.exit`
and for callbacks whose only exit is an awaited promise. Demonstrate the
before-and-after rather than reasoning about it: with the old shutdown and the
new handler, the process was still running 14 seconds after SIGTERM.


### Failure Mode 27: A scripted edit landing on the first of two identical anchors

**The bad behavior:** adding `clientBillingAddress: clients.billingAddress` to
"the select in the invoices route" with a single-occurrence replace, when that
file has TWO selects beginning `clientName: clients.name,` — the list handler
and the detail handler. The edit landed on the list, which nothing reads it
from, and the detail payload never carried the field.

**What happened:** the printable invoice rendered `BILL TO: Change of
Perspective` — the client's short name — instead of the four-line legal address
that was already in the database. It looked exactly like a client who had not
filled the field in, which is a state that genuinely exists, so nothing on
screen said anything was wrong. `tsc` was clean on both sides: the server does
not import the client's types, so a field the browser expects and the API never
sends is invisible to the compiler by construction.

**The correct behavior:** before a scripted edit, count the matches. `grep -c`
takes two seconds. Then verify the RESULT — the bug was found by looking at the
rendered document, and it would not have been found by re-reading the patch.
This is Failure Mode 16 in a new place: the claim "the select now has it" was
true of a select, and false of the one that mattered.

---

### Failure Mode 28: `position: absolute` in a print stylesheet

**The bad behavior:** the textbook recipe for printing one element —
`body * { visibility: hidden }`, the sheet and its descendants visible again,
and `position: absolute; inset: 0` on the sheet.

**What happened:** `position: absolute` resolves against the nearest POSITIONED
ancestor, and in this app that is the sidebar shell. The invoice started at the
sidebar's inner edge and ran off the right of the page with the totals column
cut in half — on the one document that exists to be handed to somebody who is
about to pay it.

**The correct behavior:** take the chrome out of the FLOW rather than trying to
position around it, and flatten the elements between the page and the sheet so
it inherits the page box (`src/styles/index.css`). Scope the whole block to
`body:has(.invoice-sheet)` — without that guard the "hide everything else" rule
matches on every other page in the app and prints a blank sheet of paper.
Verify by actually printing: `page.emulateMedia({media:'print'})` and a
screenshot, plus `page.pdf()`. Reading print CSS tells you nothing.


### Failure Mode 29: A mutation's `onSuccess` as a shared side effect

**The bad behavior:** one `useMutation` that fetches a password, with
`onSuccess: (r) => setShown(r.secret)` on it, called from two buttons — an eye
that should display it and a Copy that should not.

**What happened:** pressing **Copy put the password on the screen**, directly
contradicting the comment sitting on that button explaining that it fetches
rather than reads off the screen precisely so copying does not reveal. It read
as correct in review because the two call sites are forty lines apart and the
side effect is declared next to neither of them.

**The correct behavior:** a mutation describes the REQUEST. When two callers
want the same request and different outcomes, the outcome belongs to the
caller — `mutateAsync()` and let each one decide. Keep `onError` on the
mutation, since "the request failed" genuinely is the same for both.

The general shape: any time a second caller is added to an existing mutation,
re-read its `onSuccess`. It was written for the first caller and nothing warns
you that it now runs for the second.


## Appendix A: Environment Variables

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Runtime connection | **MUST** be `bd_app`. The guard refuses to boot otherwise. |
| `DATABASE_URL_OWNER` | Migrations only | `bd_owner`. The app never connects with this. |
| `TEST_DATABASE_URL` / `_OWNER` | Isolation suite | `bd_portal_test`. **Never** point at `bd_portal`. |
| `PORT` | API port | 4300 |
| `NODE_ENV` | `development` \| `production` \| `test` | Production serves `dist/` from Node if Caddy is absent |
| `LOG_LEVEL` | pino level | `info` in production |
| `COOKIE_SECURE` | `Secure` flag on session cookies | **`true` in production** since the portal moved to HTTPS. It must stay in step with the scheme: `true` over HTTP makes every login fail silently, because the cookie is set and never sent back. |
| `MAX_SEATS` | Seat cap | 10 |
| `UPLOAD_DIR` | Where bytes land | `./.uploads` locally, `$DATA_DIR/uploads` on VPS4 |
| `APP_URL` | Public origin | Better Auth derives callbacks and trusted origins from it |
| `BETTER_AUTH_SECRET` | Session signing key | **Required in production.** Rotating it logs everyone out. |
| `STRIPE_SECRET_KEY` | Card payments | Optional. Absent, the Pay buttons answer 503 naming what is missing and the rest of the portal is untouched. |
| `CREDENTIALS_SECRET` | The password hub's AES-256-GCM key | Optional to boot. Absent, the hub stores and reveals nothing and says so — there is deliberately no plaintext fallback. **NOT `BETTER_AUTH_SECRET`**: rotating that logs everyone out, which is recoverable; rotating this makes every stored password undecryptable, which is not. `openssl rand -base64 48` |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook deliveries | Optional, and **belongs to the webhook endpoint, not the API keys page** — each endpoint has its own. Absent, the webhook refuses to run at all: an unverified webhook is an open endpoint that marks invoices paid. |

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
| Look at a UI change in a browser | A second API on the TEST database plus `VITE_API_TARGET` — see Browser Verification. Never against `:4300`, which is production |
| Store a secret for a client | The password hub. It needs `CREDENTIALS_SECRET`; without it the routes answer 503 rather than writing plaintext |
| Open a file picker | `<UploadButton>`, or a native `<label htmlFor>`. NEVER a scripted `.click()` |
| Retire a client | Archive it. There is no delete AFFORDANCE and there must not be one — the button, the route and the label all say archive |
| Actually destroy a client | Only on an explicit, in-conversation instruction from the human. Back up first, rehearse the DELETE inside a transaction and ROLLBACK, check for attached invoices, then commit. Bytes on disk are NOT removed by the cascade — hand the human the orphan list; Rule 1 still applies to you |
| Set up deploys on a new machine | `cp deploy.config.example.sh deploy.config.sh` and fill it in. It is gitignored: this repo is PUBLIC, and the server address, account and directory layout are not published |
| Test a share link end to end | Mint via `POST /api/shares/content/:id`, then fetch `/api/share/<token>` with NO cookie at all. It must work anonymously |
| Test the Stripe webhook | Sign a payload with `stripe.webhooks.generateTestHeaderString({payload, secret})` and POST it. A forged signature MUST be 400 |
| Drive the API without touching production | boot a second instance on `:4399` against `bd_portal_test` |
| Find out why a request "did nothing" | `ssh "$HOST" journalctl --user -u bd-portal -n 50` — no line means it never arrived |
| Deploy | `npm run deploy` |
| Read production logs | `ssh "$HOST" journalctl --user -u bd-portal -n 50` |
| Restart production | `ssh "$HOST" systemctl --user restart bd-portal.service` |
| Check production health | `curl "$HEALTH_URL"` |
| Check the certificate | `echo \| openssl s_client -connect portal.bananadigitallondon.com:443 2>/dev/null \| openssl x509 -noout -dates` |

## Appendix C: Current Known Limitations

State these plainly when relevant. Do not paper over them.

- **No self-service password change.** Rotation requires `scripts/set-password.ts` on the server.
- **No email.** Invitations are copyable links; nothing notifies a client that content awaits them except the in-app review queue.
- **Backups sit on the same disk as the data.** They survive a mistake, not a disk failure. Copy the newest pair off the box after any session that mattered — see Backups above.
- **Mobile layout is unverified.** The browser harness cannot resize, and it cannot switch engine either: **nothing here has been verified on Safari or iOS**, which is where the upload picker failed. Say so rather than implying coverage.
- **No per-client timezone.** `content_items.scheduled_time` is a bare wall-clock time and means her local reckoning. Correct for a London agency today; it is the thing to revisit before an international client.
- **The password hub needs `CREDENTIALS_SECRET` on the server.** Until it is
  set on VPS4 the hub stores handles and notes and refuses passwords, with a
  line on the card saying so. Setting it later is safe; CHANGING it later
  makes every already-stored password undecryptable, and the reveal route
  answers 409 telling her to ask for it again rather than showing a blank box.
- **An invoice is one line item.** The document renders the itemisation from
  the description's line breaks, which is what her real invoices look like —
  one numbered item with a paragraph and a list under it. Several priced rows
  would need a line-items table; see invariant 21.
- **`chrome-devtools-axi` was unusable in the session this was written in** —
  every command answered `Required at pageId`. The UI here was verified with
  Playwright instead. Nothing in this project has been verified on Safari or
  iOS, and the print output was checked in Chrome only.
- **No platform model.** `content_type` is a FORMAT (video/reel/story/graphic/carousel), not a channel. There is no Instagram-vs-TikTok distinction and one caption and one hashtag set serve all destinations — the 30-tag warning names Instagram because that is the strictest, not because the post is bound to it. The Feed Preview is a hardcoded 3x3 Instagram grid.
- **Approvals do not bind to an asset version.** `content_assets.version` and `content_approvals.version` are always 1. A client approves, the creative is replaced, and the approval row still says approved.
- **The seat cap counts client users.** `MAX_SEATS` is 10 across staff AND every client's users, because clients are modelled as members of the agency org.
- **`audit_log` is write-only.** Every mutation writes one; nothing reads them back. There is no screen and no export.
- **The Ideas Bank create form has no caption, hashtags or upload — deliberately.** It is quick capture for a backlog that includes pitches which never happen, and a caption box at that stage invites writing final copy for a post that may not exist. The calendar dialog takes all three. Do not "fix" this without asking.
- **Archiving does not touch invoices.** An archived client keeps their unpaid invoices in the payments view, by design (see Key Design Decisions). Nothing warns her at archive time that a client still owes money.
- **No scheduled or outbound anything.** No weekly digest, no reminder, no notification. Every panel is pull, not push, so an item only chases someone if they open the page.

</INSTRUCTIONS>
