import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Encryption at rest for the password hub.
 *
 * ITS OWN MODULE, importing nothing from this application, so a test can reach
 * these functions without booting an HTTP server — the trap that once let 89
 * tests silently not run (Failure Mode 25).
 *
 * AES-256-GCM, which is authenticated: a ciphertext altered in the database
 * fails to decrypt rather than decrypting to something else. A stored password
 * that quietly becomes a different stored password is the worst outcome
 * available here, because nothing on screen would say so — she would simply be
 * locked out of a client's Instagram with no explanation.
 *
 * The key comes from CREDENTIALS_SECRET and nowhere else. Deliberately NOT
 * BETTER_AUTH_SECRET: rotating that logs everyone out, which is recoverable in
 * a minute, and it must never also mean every stored password becomes
 * undecryptable, which is not recoverable at all.
 */

/** Version tag, so a future scheme can be told apart from this one on sight. */
const V1 = 'v1'

/**
 * 32 bytes from the configured secret.
 *
 * sha256 rather than the raw string: the key has to be exactly 32 bytes and a
 * passphrase is whatever length someone typed. This is not password hashing —
 * there is no user-supplied input and nothing to brute force — so a KDF with a
 * work factor would buy nothing and would have to store a salt.
 */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** Thrown when the hub is used without a key configured. Callers answer 503. */
export class SecretsUnconfigured extends Error {
  constructor() {
    super(
      'The password hub is not configured. Set CREDENTIALS_SECRET (openssl ' +
        'rand -base64 48) and restart the API. Nothing is stored until it is: ' +
        'a password kept in plain text "for now" stays in plain text.'
    )
    this.name = 'SecretsUnconfigured'
  }
}

/**
 * The shortest key this will accept, exported so `env.ts` can enforce the
 * SAME number at boot.
 *
 * Two files have to agree about what counts as a configured key: env.ts, which
 * decides whether the process starts, and this one, which decides whether the
 * hub works. Written as two literals they drift — relax the boot check to 16
 * and the app starts happily with a key this module then silently rejects, so
 * the hub is off and nothing anywhere says why. One constant, imported.
 */
export const MIN_SECRET_LENGTH = 32

export function secretsAvailable(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH
}

/**
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * A random 12-byte IV per encryption, which is what GCM requires: reusing one
 * with the same key is the single way to break this cipher, and it is why the
 * IV is stored beside the ciphertext rather than derived from anything.
 */
export function encryptSecret(plain: string, secret: string | undefined): string {
  if (!secretsAvailable(secret)) throw new SecretsUnconfigured()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    V1,
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.')
}

/**
 * Returns null for anything this key cannot open, rather than throwing.
 *
 * A row encrypted under a previous secret is a real state — someone rotated
 * the key — and it must read as "this one cannot be shown" on one line rather
 * than as a 500 that takes the whole hub down with it.
 */
export function decryptSecret(
  stored: string | null,
  secret: string | undefined
): string | null {
  if (!stored) return null
  if (!secretsAvailable(secret)) throw new SecretsUnconfigured()
  const parts = stored.split('.')
  if (parts.length !== 4 || parts[0] !== V1) return null
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFrom(secret),
      Buffer.from(parts[1], 'base64url')
    )
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
