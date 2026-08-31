import { createHash, randomBytes } from 'node:crypto'

/**
 * The share-link token.
 *
 * 32 random bytes, base64url so it survives a URL without escaping. This — not
 * the rate limiter — is what makes guessing infeasible: 256 bits has no
 * meaningful chance of being hit however many attempts anyone makes. The
 * limiter protects the box from the traffic, which is a different job.
 *
 * The raw token is returned exactly once, at creation, and never stored or
 * logged. Only its sha256 goes in the database, which is why the API cannot
 * re-display a link, why `backup.sh` dumps contain no live approval
 * credentials, and why minting a replacement is the answer to "I lost it".
 */
export function mintReviewToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashReviewToken(token) }
}

/**
 * Looked up by hash, which is a unique-index probe rather than a secret string
 * comparison — so there is no timing signal to attack.
 */
export function hashReviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Default life of a link. Long enough to be useful, short enough to lapse. */
export const REVIEW_LINK_DAYS = 30

export function reviewLinkExpiry(from: Date, days = REVIEW_LINK_DAYS): Date {
  const out = new Date(from)
  out.setDate(out.getDate() + days)
  return out
}

/**
 * Can this link still be used?
 *
 * Exists TWICE on purpose — here, and in src/lib/api.ts for the staff list's
 * "Expired"/"Revoked" badge — because the browser has to label a link without
 * asking the server. Two copies of a rule drift, so contract.test.ts binds
 * them over the same inputs, exactly as the two hashtag normalisers are.
 */
export function isLinkUsable(
  link: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date
): boolean {
  if (link.revokedAt) return false
  return new Date(link.expiresAt).getTime() > now.getTime()
}
