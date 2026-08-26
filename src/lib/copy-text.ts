/**
 * Copy text to the clipboard, including over plain HTTP.
 *
 * `navigator.clipboard` only exists in a SECURE CONTEXT — HTTPS, or localhost.
 * This application is served to her over plain HTTP on a bare IP and port, so
 * in production `navigator.clipboard` is `undefined` and reaching for it
 * throws a TypeError. It works perfectly on the dev server, which is
 * localhost, which is exactly how a bug like this survives to a deploy.
 *
 * So the modern API is tried and the old one is the fallback.
 * `document.execCommand('copy')` is deprecated and still works everywhere,
 * and it has no secure-context requirement — it predates the idea.
 *
 * Returns whether the text actually landed, rather than throwing: a copy
 * button that silently does nothing is worse than one that says it failed.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission refused, or the document is not focused. Fall through —
      // the legacy path often still works.
    }
  }

  try {
    const scratch = document.createElement('textarea')
    scratch.value = text
    // Off-screen rather than hidden: display:none and visibility:hidden are
    // not selectable, and an unselectable textarea cannot be copied from.
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.top = '-9999px'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)

    const selection = document.getSelection()
    // Whatever she had selected is restored afterwards — copying hashtags
    // should not silently destroy a selection elsewhere on the page.
    const previous =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    scratch.select()
    scratch.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')

    document.body.removeChild(scratch)
    if (previous && selection) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
    return ok
  } catch {
    return false
  }
}
