import { sql } from 'drizzle-orm'
import { db } from './index.js'

/**
 * Boot-time assertion that the runtime database role cannot bypass RLS.
 *
 * This is the protection that `FORCE ROW LEVEL SECURITY` was going to provide,
 * done better. FORCE would also have applied policies to bd_owner, breaking
 * migrations and seeds, and its failure mode is a confusing empty result set.
 * This fails at startup with a sentence explaining what is wrong.
 *
 * The specific accident being guarded against: someone hits a permissions
 * error, points DATABASE_URL at bd_owner "just to unblock", and every tenancy
 * guarantee in the application silently evaporates with no visible symptom.
 */
export async function assertRlsIsBinding(): Promise<void> {
  const result = await db.execute<{
    role: string
    is_superuser: boolean
    bypasses_rls: boolean
    owns_tables: number
    unprotected: string[]
  }>(sql`
    select
      current_user                                  as role,
      (select rolsuper      from pg_roles where rolname = current_user) as is_superuser,
      (select rolbypassrls  from pg_roles where rolname = current_user) as bypasses_rls,
      (select count(*)::int from pg_class c
         where c.relnamespace = 'public'::regnamespace
           and c.relkind = 'r'
           and pg_get_userbyid(c.relowner) = current_user)              as owns_tables,
      -- The empty-array fallback must be cast, or Postgres infers an untyped
      -- literal and the driver hands back a string instead of an array.
      (select coalesce(array_agg(c.relname order by c.relname), '{}'::text[])
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relkind = 'r'
          and not c.relrowsecurity
          and c.relname = any (array[
            'clients','client_access','contacts','deals','activities','audit_log',
            'links','files','notice_posts','tasks','content_items','content_assets',
            'content_approvals','content_comments','moodboard_items','review_links',
            'invitation_grants'
          ]))                                                           as unprotected
  `)

  const row = result.rows[0]
  if (!row) throw new Error('RLS guard: no result from Postgres')

  const problems: string[] = []

  if (row.is_superuser) {
    problems.push(`role "${row.role}" is a superuser, so RLS never applies`)
  }
  if (row.bypasses_rls) {
    problems.push(`role "${row.role}" has BYPASSRLS`)
  }
  if (row.owns_tables > 0) {
    problems.push(
      `role "${row.role}" owns ${row.owns_tables} table(s) in public; ` +
        'a table owner is exempt from its own policies unless FORCE is set'
    )
  }
  // Defensive: drivers differ on how they surface Postgres arrays, and a guard
  // that crashes is a guard that stops the app for the wrong reason.
  const unprotected = Array.isArray(row.unprotected)
    ? row.unprotected
    : String(row.unprotected ?? '')
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean)

  if (unprotected.length) {
    problems.push(`tenant tables without RLS enabled: ${unprotected.join(', ')}`)
  }

  if (problems.length) {
    throw new Error(
      'Refusing to start — row level security is not binding:\n' +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\n\nDATABASE_URL must point at bd_app (DML only, non-owner). If you hit ' +
        'a permissions error, the fix is a GRANT, never a role swap.'
    )
  }
}
