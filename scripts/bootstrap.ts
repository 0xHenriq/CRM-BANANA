/**
 * One-time setup: creates the Banana Digital organization and its first owner.
 *
 * Sign-up is disabled by design — seats are invited, never self-served — so
 * there has to be a way to create the very first account. This is it, and it
 * is the only path that bypasses the invitation flow.
 *
 *   npm run bootstrap -- --email sophie@… --name "Sophie" --password "…"
 */
import { auth } from '../server/auth/index.js'
import { ORG_SLUG } from '../server/auth/org.js'
import { db, closeDb } from '../server/db/index.js'
import { member, organization, user } from '../server/db/auth-schema.js'
import { eq } from 'drizzle-orm'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const email = arg('email')
const name = arg('name') ?? 'Owner'
const password = arg('password')

if (!email || !password) {
  throw new Error(
    'Usage: npm run bootstrap -- --email <email> --password <password> [--name "Full Name"]'
  )
}
if (password.length < 10) {
  throw new Error('Password must be at least 10 characters.')
}

const existingOrgs = await db.select({ id: organization.id }).from(organization)
if (existingOrgs.length > 0) {
  throw new Error(
    'An organization already exists. Bootstrap runs once; use the seats screen ' +
      'to invite further accounts.'
  )
}

// The sign-up endpoint is disabled on purpose, so this goes through Better
// Auth's internal adapter instead — same hashing and same table shape as a
// normal registration, just without an open public route.
const ctx = await auth.$context

const existingUser = await db
  .select({ id: user.id })
  .from(user)
  .where(eq(user.email, email))
if (existingUser.length) {
  throw new Error(`A user with ${email} already exists.`)
}

const createdUser = await ctx.internalAdapter.createUser({
  email,
  name,
  emailVerified: true,
})

await ctx.internalAdapter.linkAccount({
  userId: createdUser.id,
  providerId: 'credential',
  accountId: createdUser.id,
  password: await ctx.password.hash(password),
})

const userId = createdUser.id

const [org] = await db
  .insert(organization)
  .values({
    id: crypto.randomUUID(),
    name: 'Banana Digital',
    slug: ORG_SLUG,
    createdAt: new Date(),
  })
  .returning()

await db.insert(member).values({
  id: crypto.randomUUID(),
  organizationId: org.id,
  userId,
  role: 'owner',
  createdAt: new Date(),
})

// eslint-disable-next-line no-console -- CLI script: stdout is the interface
console.log(
  `\nBanana Digital created.\n  owner: ${email}\n  org:   ${org.id}\n\n` +
    `Sign in at http://localhost:5173/sign-in — then invite the remaining seats.\n`
)

await closeDb()
