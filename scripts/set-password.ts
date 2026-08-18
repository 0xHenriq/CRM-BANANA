/**
 * Sets a user's password.
 *
 * Public sign-up is disabled and there is no self-service password change yet,
 * so this is the only way to rotate a credential. Run it on the server, with
 * the production env — hashing uses Better Auth's own routine so the result is
 * byte-identical to what a normal registration would store.
 *
 *   npm run set-password -- --email someone@example.com --password '…'
 */
import { and, eq } from 'drizzle-orm'
import { auth } from '../server/auth/index.js'
import { closeDb, db } from '../server/db/index.js'
import { account, user } from '../server/db/auth-schema.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const email = arg('email')
const password = arg('password')

if (!email || !password) {
  throw new Error(
    "Usage: npm run set-password -- --email <email> --password '<password>'"
  )
}
if (password.length < 10) {
  throw new Error('Password must be at least 10 characters.')
}

const [target] = await db
  .select({ id: user.id, name: user.name })
  .from(user)
  .where(eq(user.email, email))
  .limit(1)

if (!target) throw new Error(`No user with the address ${email}`)

const ctx = await auth.$context
const hash = await ctx.password.hash(password)

// Narrowed to the credential provider, not "any account row for this user".
// Better Auth writes one `account` row per provider and only the credential
// one carries a password, so an unqualified match would pick whichever row
// came back first and stamp a hash onto a row that has no business holding
// one — leaving the real credential untouched and the rotation silently
// ineffective. Only email/password is configured today; this is the assumption
// made explicit rather than relied upon.
const [credential] = await db
  .select({ id: account.id })
  .from(account)
  .where(and(eq(account.userId, target.id), eq(account.providerId, 'credential')))
  .limit(1)

if (credential) {
  await db
    .update(account)
    .set({ password: hash })
    .where(eq(account.id, credential.id))
} else {
  await ctx.internalAdapter.linkAccount({
    userId: target.id,
    providerId: 'credential',
    accountId: target.id,
    password: hash,
  })
}

// Existing sessions keep working on their own cookie; revoking them is the
// point of a rotation, so anyone holding the old password is signed out too.
await ctx.internalAdapter.deleteUserSessions(target.id)

// eslint-disable-next-line no-console -- CLI script: stdout is the interface
console.log(`password updated for ${target.name} <${email}>; sessions revoked`)

await closeDb()
