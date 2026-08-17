import { defineConfig } from 'drizzle-kit'

/**
 * Migrations run as bd_owner — the schema owner. The application role (bd_app)
 * has DML only and cannot create or alter tables, which is what keeps a
 * runtime bug from being able to drop a policy.
 *
 * `drizzle-kit push` is banned outside local scratch work: it reconciles by
 * dropping columns. Use `db:generate` → review the emitted SQL → `db:migrate`.
 */
export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
})
