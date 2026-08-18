/**
 * Turns a user-supplied string into an href, or refuses.
 *
 * The link stack and file folder are the only places in this app where a
 * string someone typed becomes something the browser will navigate to. That
 * makes this the one function where `javascript:` and `data:` URLs matter —
 * a client-role user can edit nothing here today, but she pastes URLs from
 * clients, and the rule should not depend on remembering who typed what.
 *
 * Returns null for anything that is not http(s), and the caller renders inert
 * text instead of an anchor.
 */
export function safeHref(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    // "drive.google.com" with no scheme is what she will actually paste.
    // Assume https rather than refusing, then re-parse so the guess is
    // validated by the same rule as everything else.
    try {
      const guessed = new URL(`https://${trimmed}`)
      return guessed.hostname.includes('.') ? guessed.toString() : null
    } catch {
      return null
    }
  }
}
