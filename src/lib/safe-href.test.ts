import { describe, expect, it } from 'vitest'
import { safeHref } from './safe-href'

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
