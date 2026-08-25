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

/**
 * Whether a stored link points at a page of this application.
 *
 * The seeded "Content Calendar" link is the one entry whose destination we
 * already know, so it is stored as `/portal/calendar` rather than waiting for
 * someone to paste a URL. `safeHref` refuses it — correctly, since it is not
 * http(s) — so the link stack asks this instead and routes internally.
 *
 * The leading-slash test is deliberately `/` but NOT `//`. A protocol-relative
 * URL like `//evil.com` also starts with a slash and is emphatically not an
 * internal path: the browser reads it as another origin, so treating it as one
 * of ours would turn a link row into an open redirect. Backslashes are refused
 * for the same reason — some browsers normalise `/\evil.com` the same way.
 */
export function internalPath(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null
  return trimmed
}
