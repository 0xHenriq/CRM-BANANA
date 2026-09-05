import { describe, expect, it } from 'vitest'
import {
  IMAGE_MIME,
  isAcceptedMime,
  isImageMime,
  sniffDocumentMime,
  sniffMime,
} from '../lib/media.js'
import {
  assetVariantKey,
  contentDisposition,
  humanSize,
  imageTypeForKey,
  parseRange,
  keysReferencedBy,
} from '../routes/media.js'

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

/**
 * A complete `ftyp` box: size, major brand, minor version, compatible brands.
 *
 * The compatible list is the half that decides a generic HEIF, and the plain
 * helper above cannot carry it — its size field is zero, which is exactly the
 * unreadable-header case the sniffer has to survive as well.
 */
function ftypBox(major: string, compatible: string[]): Buffer {
  const size = 16 + compatible.length * 4
  const buf = Buffer.alloc(size)
  buf.writeUInt32BE(size, 0)
  buf.write('ftyp', 4, 'ascii')
  buf.write(major, 8, 'ascii')
  compatible.forEach((brand, i) => buf.write(brand, 16 + i * 4, 'ascii'))
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
   * play. Naming the brands is what stops that.
   *
   * It used to assert `null` — a deliberate refusal, because sharp cannot
   * decode HEIC. That refusal is what a real upload hit: she added a photo to
   * a client's moodboard and got a 415. They are now decoded by libheif-js and
   * converted to JPEG, so the assertion is that the brand is RECOGNISED. What
   * must never come back is `video/mp4`.
   */
  it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])(
    'reads the HEIC brand %s as a photo, never as mp4',
    (brand) => {
      expect(sniffMime(ftyp(brand))).toBe('image/heic')
    }
  )

  /**
   * The generic HEIF brands name a container, not a codec.
   *
   * `mif1` appears in the COMPATIBLE brands of both a real iPhone HEIC
   * (major heic: mif1 MiHB MiHE MiPr miaf heic tmap) and a real AVIF (major
   * avif: mif1 avif miaf), so a test that read it as a major brand and
   * answered AVIF stored a HEVC-coded still with a `.avif` extension — a file
   * no browser renders, with no thumbnail, no error and nothing in the log.
   */
  it('reads a generic HEIF carrying HEVC as a photo, not as AVIF', () => {
    expect(sniffMime(ftypBox('mif1', ['mif1', 'heic']))).toBe('image/heic')
  })

  it('still reads a generic HEIF carrying AV1 as AVIF', () => {
    // AVIF must be decided before anything looks at mif1, or this one is lost.
    expect(sniffMime(ftypBox('mif1', ['mif1', 'avif', 'miaf']))).toBe(
      'image/avif'
    )
  })

  it('sends an unqualified HEIF to the decoder that reads both', () => {
    // libheif handles HEVC and AV1, so the ambiguous case is safe there.
    expect(sniffMime(ftypBox('mif1', []))).toBe('image/heic')
    expect(sniffMime(ftypBox('msf1', ['msf1', 'hevc']))).toBe('image/heic')
  })

  /**
   * The declared box size is a number out of the file, and sniffMime runs over
   * the whole upload — which may be a 1 GB video. Trusting it would walk the
   * entire buffer four bytes at a time: 268 million iterations for that video,
   * on the event loop, for every upload. The scan is capped instead.
   */
  it('does not walk the whole file when the box size is nonsense', () => {
    const big = Buffer.alloc(8 * 1024 * 1024)
    big.writeUInt32BE(0xffffffff, 0)
    big.write('ftyp', 4, 'ascii')
    big.write('isom', 8, 'ascii')

    const started = Date.now()
    expect(sniffMime(big)).toBe('video/mp4')
    // Generous: the capped scan is a few dozen reads. An uncapped one over
    // 8 MB is two million, and over a real upload far worse.
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('a real mp4 is unaffected by reading the compatible brands', () => {
    expect(sniffMime(ftypBox('isom', ['isom', 'iso2', 'mp41']))).toBe(
      'video/mp4'
    )
  })

  it.each([
    ['little-endian', Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08])],
    ['big-endian', Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00])],
  ])('reads a %s TIFF', (_name, buf) => {
    expect(sniffMime(buf)).toBe('image/tiff')
  })

  /**
   * SVG has no magic number, so this is a shape check — and the shape has to
   * exclude HTML specifically. An uploaded HTML file served from our own
   * origin is stored XSS; matching it as an image would put it through a
   * rasteriser instead of refusing it, which is not the answer we want on
   * record even though nothing is served from those bytes.
   */
  it.each([
    ['a bare svg element', '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'],
    ['an xml declaration first', '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'],
    ['leading whitespace', '\n\n  <svg width="10" height="10"/>'],
  ])('reads %s as an SVG', (_name, text) => {
    expect(sniffMime(Buffer.from(text))).toBe('image/svg+xml')
  })

  it.each([
    ['an HTML document that contains an svg', '<!doctype html><html><body><svg onload="alert(1)"></svg></body></html>'],
    ['an HTML fragment', '<html><svg/></html>'],
    ['xml that is not an svg', '<?xml version="1.0"?><rss><channel/></rss>'],
  ])('does not read %s as an SVG', (_name, text) => {
    expect(sniffMime(Buffer.from(text))).toBeNull()
  })

  it('returns null for bytes it does not recognise', () => {
    expect(sniffMime(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull()
    expect(sniffMime(Buffer.alloc(0))).toBeNull()
  })
})

/**
 * What we take versus what we STORE.
 *
 * These are two different lists and conflating them is how a logo upload got
 * refused for a format the pipeline can handle: the route checked IMAGE_MIME,
 * which is the storage map, rather than asking whether it is an image at all.
 */
describe('isImageMime', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])(
    'accepts %s, which is stored as-is',
    (mime) => {
      expect(isImageMime(mime)).toBe(true)
      expect(isAcceptedMime(mime)).toBe(true)
    }
  )

  it.each(['image/heic', 'image/tiff', 'image/svg+xml'])(
    'accepts %s, which is converted on the way in',
    (mime) => {
      expect(isImageMime(mime)).toBe(true)
      expect(isAcceptedMime(mime)).toBe(true)
      // Not storable: nothing may ever write these bytes to disk, because a
      // browser cannot render the first two and must not execute the third.
      expect(IMAGE_MIME[mime]).toBeUndefined()
    }
  )

  it.each(['video/mp4', 'application/pdf', 'text/plain'])(
    'does not call %s an image',
    (mime) => {
      expect(isImageMime(mime)).toBe(false)
    }
  )
})

/**
 * Which of the produced objects the written row actually keeps.
 *
 * Read off the returned row, so it is what was stored rather than a guess.
 * Two narrower versions of this rule both leaked: one tested the request's
 * `target` string, which the insert does not agree with for an unrecognised
 * target, and one asked only whether the thumbnail had been stored, which
 * misses the File Folder discarding its thumbnail and a video moodboard tile
 * discarding its poster.
 */
describe('keysReferencedBy', () => {
  it('a content asset keeps all three, so nothing is removed', () => {
    const keys = keysReferencedBy({
      asset: { storageKey: 'c/a.mp4', thumbKey: null, posterKey: 'c/a.webp' },
    })
    expect(keys).toEqual(['c/a.mp4', 'c/a.webp'])
  })

  it('a File Folder document keeps only the original', () => {
    // `files` has no thumbnail column, so a thumbnail derived for one is
    // referenced by nothing the moment it is written.
    expect(keysReferencedBy({ file: { storageKey: 'c/deck.pdf' } })).toEqual([
      'c/deck.pdf',
    ])
  })

  it('a moodboard tile keeps whichever key was actually stored', () => {
    expect(
      keysReferencedBy({ moodboardItem: { storageKey: 'c/thumb.webp' } })
    ).toEqual(['c/thumb.webp'])
  })

  it('a logo keeps its logoKey, and never the superseded one', () => {
    // `replaced` is a bare string and belongs to the PREVIOUS logo, which is
    // removed on its own path. Counting it here would keep dead bytes alive.
    const keys = keysReferencedBy({
      client: { id: 'c1', logoKey: 'c/new.webp' },
      replaced: 'c/old.webp',
    })
    expect(keys).toEqual(['c/new.webp'])
  })

  it('answers empty rather than throwing when there is no result', () => {
    expect(keysReferencedBy(null)).toEqual([])
    expect(keysReferencedBy(undefined)).toEqual([])
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

/**
 * RFC 5987 encoding, which encodeURIComponent does not quite do.
 *
 * It leaves `!*'()~` unescaped, and the apostrophe is the delimiter in
 * `UTF-8'<lang>'<value>` — so a filename containing one produced a header a
 * strict parser may truncate at that quote. "Sofia's Agreement.pdf" is not a
 * hypothetical filename for this client.
 */
describe('contentDisposition escaping', () => {
  it('percent-encodes the characters that are not attr-char', () => {
    const header = contentDisposition("Sofia's Agreement.pdf")
    const encoded = /filename\*=UTF-8''(.*)$/.exec(header)?.[1] ?? ''
    expect(encoded).not.toContain("'")
    expect(encoded).toContain('%27')
  })

  it('encodes parentheses and asterisks too', () => {
    const encoded =
      /filename\*=UTF-8''(.*)$/.exec(contentDisposition('Q4 (final)*.pdf'))?.[1] ?? ''
    expect(encoded).not.toMatch(/[()*]/)
  })

  it('still round-trips to the original name', () => {
    for (const name of ["Sofia's Agreement.pdf", 'Acme — Agreement.pdf', 'Q4 (final).pdf']) {
      const encoded = /filename\*=UTF-8''(.*)$/.exec(contentDisposition(name))?.[1] ?? ''
      expect(decodeURIComponent(encoded)).toBe(name)
    }
  })
})

/**
 * The logo is normally the derived webp, but processImage keeps the ORIGINAL
 * when sharp cannot thumbnail a file rather than failing the upload — so the
 * stored key is sometimes a .png or .gif, and hard-coding webp would label it
 * wrongly.
 */
describe('imageTypeForKey', () => {
  it('types each image extension we ever store', () => {
    expect(imageTypeForKey('c1/a.webp')).toBe('image/webp')
    expect(imageTypeForKey('c1/a.png')).toBe('image/png')
    expect(imageTypeForKey('c1/a.jpg')).toBe('image/jpeg')
    expect(imageTypeForKey('c1/a.gif')).toBe('image/gif')
    expect(imageTypeForKey('c1/a.avif')).toBe('image/avif')
  })

  it('is case-insensitive about the extension', () => {
    expect(imageTypeForKey('c1/A.PNG')).toBe('image/png')
  })

  it('refuses anything that is not an image rather than guessing', () => {
    // The route turns null into a 404, so the portal falls back to initials
    // instead of rendering a broken image.
    expect(imageTypeForKey('c1/a.mp4')).toBeNull()
    expect(imageTypeForKey('c1/a.pdf')).toBeNull()
    expect(imageTypeForKey('c1/noextension')).toBeNull()
  })
})

/**
 * Which bytes a variant resolves to.
 *
 * This shipped broken and looked fine, which is why it is pinned here. The
 * public share route ignored the variant and always returned `storage_key`.
 * Every fixture in this project is a PNG, and a PNG original in an `<img>`
 * renders — so the shared feed preview appeared to work. Production's assets
 * are ALL `video/mp4`, and the grid was handing an `<img>` an MP4: every tile
 * a broken image, on the one link she sends to clients.
 *
 * A video has no thumbnail, which is the case worth asserting: `thumb` must
 * fall through to the poster rather than to the original, or the fix would
 * have moved the bug one step along.
 */
describe('assetVariantKey', () => {
  const video = {
    storageKey: 'uploads/reel.mp4',
    thumbKey: null,
    posterKey: 'uploads/reel-poster.webp',
    mime: 'video/mp4',
  }
  const photo = {
    storageKey: 'uploads/shot.png',
    thumbKey: 'uploads/shot-thumb.webp',
    posterKey: null,
    mime: 'image/png',
  }

  it('gives a video a POSTER, never the mp4, for either derived variant', () => {
    // The whole bug in two assertions: an <img> asking for a picture of a
    // video must not be handed the video.
    expect(assetVariantKey(video, 'poster')).toEqual({
      key: 'uploads/reel-poster.webp',
      mime: 'image/webp',
    })
    expect(assetVariantKey(video, 'thumb')).toEqual({
      key: 'uploads/reel-poster.webp',
      mime: 'image/webp',
    })
  })

  it('gives an image its thumbnail, and falls back for poster', () => {
    expect(assetVariantKey(photo, 'thumb')).toEqual({
      key: 'uploads/shot-thumb.webp',
      mime: 'image/webp',
    })
    // An image has no poster frame; the thumbnail is the honest stand-in.
    expect(assetVariantKey(photo, 'poster')).toEqual({
      key: 'uploads/shot-thumb.webp',
      mime: 'image/webp',
    })
  })

  it('keeps the original type only for the original', () => {
    expect(assetVariantKey(video, 'original')).toEqual({
      key: 'uploads/reel.mp4',
      mime: 'video/mp4',
    })
    expect(assetVariantKey(photo, 'original')).toEqual({
      key: 'uploads/shot.png',
      mime: 'image/png',
    })
  })

  it('falls back to the original when nothing derived exists', () => {
    // A row from before thumbnails were generated, or one whose derivation
    // failed. Serving something is better than a 404 on a picture.
    const bare = {
      storageKey: 'uploads/bare.png',
      thumbKey: null,
      posterKey: null,
      mime: 'image/png',
    }
    expect(assetVariantKey(bare, 'thumb')).toEqual({
      key: 'uploads/bare.png',
      mime: 'image/png',
    })
  })
})
