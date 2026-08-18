import { describe, expect, it } from 'vitest'
import { sniffMime } from '../lib/media.js'
import { parseRange } from '../routes/media.js'

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
