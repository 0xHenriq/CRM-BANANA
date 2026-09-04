import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  secretsAvailable,
  SecretsUnconfigured,
} from '../lib/secrets.js'

/**
 * The password hub's encryption, tested without a database or a server.
 *
 * `secrets.ts` imports nothing from this application precisely so this file
 * can exist — importing the app entrypoint to reach a pure function starts an
 * HTTP server and takes the whole suite down with it (Failure Mode 25).
 */
const KEY = 'k'.repeat(48)
const OTHER = 'j'.repeat(48)

describe('the password hub cipher', () => {
  it('round-trips a password', () => {
    const stored = encryptSecret('hunter2!£€', KEY)
    expect(decryptSecret(stored, KEY)).toBe('hunter2!£€')
  })

  it('never stores the plaintext', () => {
    // The one property the whole scheme exists for. Asserted on the stored
    // string itself rather than on the fact that a cipher was called.
    const stored = encryptSecret('SuperSecret123', KEY)
    expect(stored).not.toContain('SuperSecret123')
    expect(stored.startsWith('v1.')).toBe(true)
  })

  it('produces a different ciphertext each time for the same input', () => {
    // A fresh IV per encryption. Identical ciphertexts would tell anyone
    // reading the table which two clients use the same password.
    const a = encryptSecret('same', KEY)
    const b = encryptSecret('same', KEY)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY))
  })

  it('refuses to open a ciphertext with the wrong key', () => {
    expect(decryptSecret(encryptSecret('hunter2', KEY), OTHER)).toBeNull()
  })

  it('refuses a ciphertext that has been tampered with', () => {
    // GCM is authenticated, and this is what that buys: a row edited in the
    // database fails to open rather than opening to something else. A stored
    // password that silently becomes a DIFFERENT password would lock her out
    // of a client's account with nothing on screen to say why.
    const stored = encryptSecret('hunter2', KEY)
    const [v, iv, tag, body] = stored.split('.')
    const flipped = Buffer.from(body, 'base64url')
    flipped[0] ^= 0xff
    expect(
      decryptSecret([v, iv, tag, flipped.toString('base64url')].join('.'), KEY)
    ).toBeNull()
  })

  it('returns null for a row from an unknown scheme rather than throwing', () => {
    expect(decryptSecret('v2.a.b.c', KEY)).toBeNull()
    expect(decryptSecret('not-a-ciphertext', KEY)).toBeNull()
    expect(decryptSecret(null, KEY)).toBeNull()
  })

  it('refuses to encrypt at all without a configured key', () => {
    // Not "stores it in plain text until the key is set up". That is the
    // degraded mode this throw exists to make impossible.
    expect(() => encryptSecret('hunter2', undefined)).toThrow(SecretsUnconfigured)
    expect(() => encryptSecret('hunter2', 'too-short')).toThrow(SecretsUnconfigured)
  })

  it('treats a short key as no key', () => {
    expect(secretsAvailable(undefined)).toBe(false)
    expect(secretsAvailable('short')).toBe(false)
    expect(secretsAvailable(KEY)).toBe(true)
  })
})
