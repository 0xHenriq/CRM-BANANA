/**
 * Applies pending Drizzle migrations as bd_owner.
 *
 * Runs as a one-shot script rather than at server boot: two systemd restarts
 * racing the same migration is a class of outage worth designing out, and boot
 * time migrations make rollbacks harder to reason about.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const url = process.env.DATABASE_URL_OWNER
if (!url) {
  throw new Error(
    'DATABASE_URL_OWNER is required — migrations must run as the schema owner, ' +
      'not as bd_app (which has DML only, by design).'
  )
}

const pool = new Pool({ connectionString: url, max: 1 })

try {
  await migrate(drizzle(pool), { migrationsFolder: './server/db/migrations' })
  // eslint-disable-next-line no-console -- CLI script: stdout is the interface
  console.log('migrations applied')
} finally {
  await pool.end()
}
