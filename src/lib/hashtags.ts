/**
 * Hashtags, normalised.
 *
 * She types them the way she would type them into Instagram — "#BananaDigital
 * #socialmedia, #LDN" — pasted in one blob, sometimes with hashes, sometimes
 * without, usually with a stray comma. Storing that verbatim means the same
 * tag exists four ways and none of them can ever be counted or reused.
 *
 * Case is PRESERVED. Instagram treats #BananaDigital and #bananadigital as the
 * same tag, but the capitals are what make a long tag readable, and lowercasing
 * her work to satisfy a comparison would be the tool correcting her taste. So
 * duplicates are removed case-insensitively while the first spelling survives.
 *
 * There is a copy of this on the other side of the wire. The two are bound by a
 * contract test that runs both over the same inputs, because a client that
 * normalises differently from the server produces a UI that silently disagrees
 * with what was saved.
 */
export const HASHTAG_LIMIT = 30

/** Anything that is not a letter, number or underscore is not part of a tag. */
const STRIP = /[^\p{L}\p{N}_]/gu

export function normaliseHashtags(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const item of raw) {
    const tag = item.replace(STRIP, '')
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }

  return out
}

/**
 * A pasted blob into a list of tags.
 *
 * Splits on whitespace, commas and hashes, so "#one #two,#three" and
 * "one, two, three" and "#one#two#three" all give the same three tags — the
 * last of those being how they arrive when copied out of a caption.
 */
export function parseHashtagInput(text: string): string[] {
  return normaliseHashtags(text.split(/[\s,#]+/))
}
