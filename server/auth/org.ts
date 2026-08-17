import { db } from '../db/index.js'
import { organization } from '../db/auth-schema.js'

export const ORG_SLUG = 'banana-digital'

let cached: string | null = null

/**
 * The id of the single Banana Digital organization.
 *
 * There is exactly one, created by `scripts/bootstrap.ts`. Seat counting and
 * invitations are scoped to it, so a second organization would silently
 * partition the cap — which is why `allowUserToCreateOrganization` is false.
 *
 * Cached because it never changes for the life of the process, and it is on
 * the path of every seat operation.
 */
export async function getOrganizationId(): Promise<string> {
  if (cached) return cached

  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .limit(2)

  if (rows.length === 0) {
    throw new Error(
      'No organization exists. Run `npm run bootstrap` to create Banana ' +
        'Digital and its first owner account.'
    )
  }
  if (rows.length > 1) {
    throw new Error(
      'More than one organization exists. Seat counting assumes exactly one; ' +
        'the extra org must be removed before invitations are trustworthy.'
    )
  }

  cached = rows[0].id
  return cached
}

/** Test-only: clears the memoized id between fixtures. */
export function resetOrganizationCache(): void {
  cached = null
}
