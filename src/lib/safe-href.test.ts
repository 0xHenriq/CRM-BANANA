import { describe, expect, it } from 'vitest'
import { internalPath, safeHref } from './safe-href'

describe('safeHref', () => {
  it.each([
    'https://drive.google.com/folder/abc',
    'http://example.com',
    'https://www.canva.com/design/DAF/edit',
  ])('passes through %s', (url) => {
    expect(safeHref(url)).toContain(new URL(url).hostname)
  })

  it('assumes https for a bare hostname, which is what gets pasted', () => {
    expect(safeHref('drive.google.com/x')).toBe('https://drive.google.com/x')
  })

  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('refuses %s', (url) => {
    expect(safeHref(url)).toBeNull()
  })

  it.each(['', '   ', null, undefined, 'not a url', 'nodot'])(
    'returns null for %s',
    (url) => {
      expect(safeHref(url)).toBeNull()
    }
  )
})

/**
 * Internal paths.
 *
 * A link row can now point at a page of this application, which means a second
 * way for a stored string to become somewhere the browser goes — and therefore
 * a second thing that has to refuse `//evil.com`.
 */
describe('internalPath', () => {
  it('accepts a path inside this application', () => {
    expect(internalPath('/portal/calendar')).toBe('/portal/calendar')
    expect(internalPath('/portal/moodboard')).toBe('/portal/moodboard')
  })

  it('refuses a protocol-relative URL, which is another origin wearing a slash', () => {
    // `//evil.com` is not a path. A browser resolves it against the current
    // scheme and leaves the site — an open redirect out of a link row.
    expect(internalPath('//evil.com')).toBeNull()
    expect(internalPath('//evil.com/portal')).toBeNull()
    expect(internalPath('/\\evil.com')).toBeNull()
  })

  it('refuses anything that is not a path at all', () => {
    expect(internalPath('https://example.com')).toBeNull()
    expect(internalPath('javascript:alert(1)')).toBeNull()
    expect(internalPath('portal/calendar')).toBeNull()
    expect(internalPath('')).toBeNull()
    expect(internalPath(null)).toBeNull()
  })
})
