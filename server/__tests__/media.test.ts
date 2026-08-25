import { describe, expect, it } from 'vitest'
import { sniffDocumentMime, sniffMime } from '../lib/media.js'
import { contentDisposition, humanSize, parseRange } from '../routes/media.js'

/**
 * The two pieces of the media path that are pure arithmetic and pure byte
 * inspection, and therefore the two worth testing without a socket. Both had
 * a defect that no type check could see: one stored a photo as a video, the
 * other served the wrong part of a file.
 */

/** A 16-byte ISO base media header with the given major brand. */
function ftyp(brand: string): Buffer {
  const buf = Buffer.alloc(16)
  buf.write('ftyp', 4, 'ascii')
  buf.write(brand, 8, 'ascii')
  return buf
}

describe('sniffMime', () => {
  it.each([
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'image/png'],
    ['gif', Buffer.from('GIF89a'), 'image/gif'],
    ['webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), 'video/webm'],
    ['mp4', ftyp('isom'), 'video/mp4'],
    ['mov', ftyp('qt  '), 'video/quicktime'],
    ['avif', ftyp('avif'), 'image/avif'],
  ])('reads %s from its magic number', (_name, buf, expected) => {
    expect(sniffMime(buf)).toBe(expected)
  })

  it('reads webp from the RIFF container', () => {
    const buf = Buffer.alloc(16)
    buf.write('RIFF', 0, 'ascii')
    buf.write('WEBP', 8, 'ascii')
    expect(sniffMime(buf)).toBe('image/webp')
  })

  /**
   * The regression this exists for.
   *
   * HEIC is an iPhone's default photo format and shares its container with
   * MP4, so the `ftyp` catch-all called it video/mp4: it was accepted, stored
   * as a video, produced no poster frame, and rendered as a tile nothing can
   * play. Refusing it here is what produces the 415 that names the formats
   * she can send instead.
   */
  it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])(
    'refuses the HEIC brand %s rather than calling it mp4',
    (brand) => {
      expect(sniffMime(ftyp(brand))).toBeNull()
    }
  )

  it('returns null for bytes it does not recognise', () => {
    expect(sniffMime(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull()
    expect(sniffMime(Buffer.alloc(0))).toBeNull()
  })
})

describe('parseRange', () => {
  it('returns null when no range was asked for, so the whole file is sent', () => {
    expect(parseRange(undefined, 100)).toBeNull()
  })

  it('reads an open-ended range as everything from the offset', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=40-', 100)).toEqual({ start: 40, end: 99 })
  })

  it('reads an explicit window', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  /**
   * `bytes=-500` means the LAST 500 bytes. Read as a start of zero it served
   * the first 501 instead, with a Content-Range header that described bytes
   * the body did not contain.
   */
  it('reads a suffix range as the last n bytes', () => {
    expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('clamps a suffix range longer than the file to the whole file', () => {
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  /**
   * Players ask for a fixed-size window regardless of how small the file is.
   * Answering 416 to that reads as a broken file, and it is not: a range that
   * starts inside the representation is satisfiable and the end is clamped.
   */
  it('clamps an end past the last byte instead of refusing', () => {
    expect(parseRange('bytes=0-1048575', 300)).toEqual({ start: 0, end: 299 })
  })

  it('refuses a start past the end of the file', () => {
    expect(parseRange('bytes=500-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=100-200', 100)).toBe('unsatisfiable')
  })

  it('refuses any range against an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-10', 0)).toBe('unsatisfiable')
  })

  it('refuses a zero-length suffix', () => {
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  it('sends the whole file rather than guessing at input it does not implement', () => {
    // Multi-range and malformed headers both mean "we did not honour this",
    // and a 200 with the full body is always a valid answer to a range
    // request. Previously the leading `bytes=0-99` of a multi-range header
    // matched and one arbitrary part was served as though it were the lot.
    expect(parseRange('bytes=0-99,200-299', 1000)).toBeNull()
    expect(parseRange('items=0-99', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('', 1000)).toBeNull()
  })
})

/**
 * Document sniffing, which the File Folder depends on.
 *
 * The folder holds proposals, agreements and invoices, so refusing everything
 * that is not an image or a video made "upload a file" impossible. These are
 * the formats she actually sends, and the two cases that matter most are the
 * ones with no signature of their own: a zip could be any Office format or
 * none, and CSV/TXT have no magic number at all, so the extension is a claim
 * that has to be checked rather than believed.
 */

/** A zip whose central directory names the given OOXML part. */
function ooxml(part: string): Buffer {
  const head = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  return Buffer.concat([head, Buffer.from(`\0\0junk${part}more`, 'latin1')])
}

describe('sniffDocumentMime', () => {
  it('reads a PDF from its signature, whatever it is called', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')
    expect(sniffDocumentMime(pdf, 'Agreement.pdf')).toBe('application/pdf')
    // The signature wins over the extension, so a mislabelled file still works.
    expect(sniffDocumentMime(pdf, 'Agreement.txt')).toBe('application/pdf')
  })

  it.each([
    ['docx', 'word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('identifies %s from its OOXML part', (ext, part, expected) => {
    expect(sniffDocumentMime(ooxml(part), `Social Strategy.${ext}`)).toBe(expected)
  })

  it('refuses a zip that is not the Office format it claims to be', () => {
    // A plain .zip renamed to .docx. PK alone cannot tell them apart, which is
    // exactly why the part name is checked rather than the signature only.
    const plainZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('\0\0holiday-photos/img1.jpg', 'latin1'),
    ])
    expect(sniffDocumentMime(plainZip, 'Strategy.docx')).toBeNull()
    // And an Office file whose extension does not match its content.
    expect(sniffDocumentMime(ooxml('xl/workbook.xml'), 'Notes.docx')).toBeNull()
  })

  it('accepts csv and txt only when the bytes really are text', () => {
    const csv = Buffer.from('date,impressions\n2026-08-01,1200\n')
    expect(sniffDocumentMime(csv, 'August report.csv')).toBe('text/csv')
    expect(sniffDocumentMime(Buffer.from('hello'), 'notes.txt')).toBe('text/plain')

    // A renamed binary. Without the text check this is how an executable gets
    // stored as "notes.txt" and handed back to whoever clicks it.
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02])
    expect(sniffDocumentMime(binary, 'notes.txt')).toBeNull()
    // Invalid UTF-8 is refused too.
    expect(sniffDocumentMime(Buffer.from([0xff, 0xfe, 0xfd]), 'notes.csv')).toBeNull()
  })

  it('refuses an extension it does not know, however innocent the bytes', () => {
    expect(sniffDocumentMime(Buffer.from('#!/bin/sh\necho hi\n'), 'run.sh')).toBeNull()
    expect(sniffDocumentMime(Buffer.from('<script>alert(1)</script>'), 'x.html')).toBeNull()
    expect(sniffDocumentMime(Buffer.from('<svg onload=alert(1)>'), 'x.svg')).toBeNull()
  })
})

/**
 * Downloads are served from the application's own origin, so the header that
 * makes the browser save rather than render is the whole defence against an
 * uploaded document executing against a signed-in session.
 */
describe('contentDisposition', () => {
  it('always marks the response as an attachment', () => {
    expect(contentDisposition('Agreement.pdf')).toMatch(/^attachment;/)
  })

  it('survives a quote in the filename without breaking out of the header', () => {
    const header = contentDisposition('Ac"me\\Agreement.pdf')
    // The ASCII fallback must not contain a bare quote or backslash, or the
    // rest of the header is attacker-controlled.
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? ''
    expect(fallback).not.toMatch(/["\\]/)
  })

  it('carries a non-ASCII name through the RFC 6266 form', () => {
    const header = contentDisposition('Acme — Agreement.pdf')
    expect(header).toContain("filename*=UTF-8''")
    expect(header).toContain(encodeURIComponent('Acme — Agreement.pdf'))
  })

  it('never emits an empty filename', () => {
    expect(contentDisposition('———')).toMatch(/filename="download"/)
  })
})

/**
 * Upload size messages.
 *
 * `(bytes / 1024 / 1024).toFixed(0)` told a person whose file was nine bytes
 * over the ceiling: "That file is 1024 MB. The limit is 1024 MB." Both numbers
 * were true, identical, and useless — there is no way to act on that. Caught by
 * pushing a real 1 GB file through the endpoint, which is the only reason it
 * was noticed at all.
 */
describe('humanSize', () => {
  it('keeps the file and the limit distinguishable at the boundary', () => {
    const limit = 1024 * 1024 * 1024
    // Nine bytes over: the two must not render as the same string.
    expect(humanSize(limit + 9)).not.toBe(humanSize(limit))
  })

  it('reports gigabytes with enough precision to act on', () => {
    // Exactly the limit is exact; nothing to round.
    expect(humanSize(1024 * 1024 * 1024)).toBe('1.00 GB')
    // 1200 MB is 1.171875 GB, and it rounds UP rather than to nearest — the
    // message exists to say a file is too big, so understating it is the one
    // direction that must not happen.
    expect(humanSize(1258291200)).toBe('1.18 GB')
  })

  it('stays in megabytes below a gigabyte, where decimals are noise', () => {
    expect(humanSize(200 * 1024 * 1024)).toBe('200 MB')
    expect(humanSize(1536 * 1024)).toBe('2 MB')
  })
})
