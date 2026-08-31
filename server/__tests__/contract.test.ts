import { describe, expect, it } from 'vitest'
import {
  DEAL_STAGES as SERVER_STAGES,
  PAYMENT_STATUSES as SERVER_PAYMENTS,
} from '../routes/deals.js'
import {
  CONTENT_STATUSES as SERVER_STATUSES,
  CONTENT_TYPES as SERVER_TYPES,
} from '../routes/content.js'
import {
  clientStatus,
  contentStatus,
  contentType,
  invoiceStatus,
  paymentStatus,
} from '../db/schema.js'
import {
  BRAND_COLOR_SLOTS as SERVER_BRAND_SLOTS,
  CLIENT_STATUSES as SERVER_CLIENT_STATUSES,
} from '../routes/clients.js'
import { INVOICE_STATUSES as SERVER_INVOICE_STATUSES } from '../routes/invoices.js'
import { hhmm } from '../lib/audit.js'
import { compareSteps } from '../routes/next-steps.js'
import { canSeePortal } from '../routes/portal.js'
import { downloadFilename } from '../routes/media.js'
import { DEFAULT_FILES } from '../lib/seed-workspace.js'
import { readFileSync, readdirSync } from 'node:fs'
import {
  hashReviewToken,
  isLinkUsable as serverIsLinkUsable,
  mintReviewToken,
  reviewLinkExpiry,
} from '../lib/review-tokens.js'
import { redactPath } from '../lib/redact.js'
import {
  HASHTAG_LIMIT as SERVER_HASHTAG_LIMIT,
  normaliseHashtags as serverNormalise,
  parseHashtagInput as serverParse,
} from '../lib/hashtags.js'
import {
  HASHTAG_LIMIT as CLIENT_HASHTAG_LIMIT,
  normaliseHashtags as clientNormalise,
  parseHashtagInput as clientParse,
} from '../../src/lib/hashtags.js'
import {
  CLIENT_STATUSES as UI_CLIENT_STATUSES,
  CLIENT_STATUS_ORDER,
  CONTENT_STATUSES as CLIENT_STATUSES,
  CONTENT_TYPES as CLIENT_TYPES,
  DEAL_STAGES as CLIENT_STAGES,
  PAYMENT_STATUSES as CLIENT_PAYMENTS,
  INVOICE_STATUSES as CLIENT_INVOICE_STATUSES,
  invoiceState,
  isApprovalOverdue,
  isLinkUsable as clientIsLinkUsable,
  linkState,
  localDayOf,
  outstandingPence,
  paymentState,
  formatPence,
  formatShortDate,
  formatTime,
  sumPence,
  toPence,
  BRAND_COLOR_ROLES,
  BRAND_COLOR_SLOTS as UI_BRAND_SLOTS,
  brandPalette,
  normaliseHex,
} from '../../src/lib/api.js'

/**
 * Contract checks between the API and the client.
 *
 * The stage list has to exist on both sides — the board renders its columns
 * before any data arrives, so it cannot wait for the server to tell it what
 * the stages are. Two hand-written lists drift; this makes that a test failure
 * rather than a 400 the first time someone drags a card.
 */
describe('deal stages', () => {
  it('are identical, and in the same order, on both sides', () => {
    expect([...CLIENT_STAGES]).toEqual([...SERVER_STAGES])
  })
})

/**
 * Content vocabulary.
 *
 * Her five types and six statuses are written out THREE times: as a Postgres
 * enum, as the zod enums the API validates against, and as the client's list
 * that fills the type and status pickers. The deal stages already had this
 * check; the content vocabulary did not, even though it is the list that has
 * three copies rather than two.
 *
 * Drift is silent in both directions. A value the client offers but the API
 * rejects is a 400 the moment she picks it; a value the API accepts but the
 * enum does not is a 500 at the insert. Order matters too — the Ideas Bank
 * sorts by CONTENT_STATUSES.indexOf to get pipeline order rather than
 * alphabetical, so reordering one copy quietly reorders that table.
 */
describe('content vocabulary', () => {
  it('types match across the Postgres enum, the API and the client', () => {
    expect([...SERVER_TYPES]).toEqual([...CLIENT_TYPES])
    expect([...contentType.enumValues]).toEqual([...CLIENT_TYPES])
  })

  it('statuses match, and in the same pipeline order', () => {
    expect([...SERVER_STATUSES]).toEqual([...CLIENT_STATUSES])
    expect([...contentStatus.enumValues]).toEqual([...CLIENT_STATUSES])
  })
})

/**
 * Payment vocabulary, and the state that is NOT in it.
 *
 * Three stored values across three places — the Postgres enum, the API's zod
 * enum, the client's menu. `overdue` is deliberately absent from all of them:
 * it is derived from the due date, so it becomes true at midnight on its own
 * rather than waiting to be marked. A stored "overdue" would be a status that
 * silently goes stale, which is worse than none.
 */
/**
 * Client lifecycle, bound across all three copies.
 *
 * This vocabulary was the one the product did NOT check. It exists in the
 * Postgres enum, in the create/update schemas on the server, and in the
 * browser — and the two screens that render it each had a fourth and fifth
 * hand-written copy until these lists replaced them.
 *
 * Note the aliases: elsewhere in this file "CLIENT" means the browser. Here
 * the subject is literally a client of the agency, so the browser copy is
 * UI_CLIENT_STATUSES and the API copy is SERVER_CLIENT_STATUSES.
 */
describe('client statuses', () => {
  it('match across the Postgres enum, the API and the browser', () => {
    expect([...SERVER_CLIENT_STATUSES]).toEqual([...UI_CLIENT_STATUSES])
    expect([...clientStatus.enumValues]).toEqual([...UI_CLIENT_STATUSES])
  })

  /**
   * The Clients page renders one group per entry in this order, so a status
   * missing from it does not sort to the bottom — those clients vanish from
   * the page altogether. The order is deliberately different from the enum;
   * the MEMBERS must be identical.
   */
  it('the display order is a permutation, not a subset', () => {
    expect([...CLIENT_STATUS_ORDER].sort()).toEqual([...UI_CLIENT_STATUSES].sort())
    expect(CLIENT_STATUS_ORDER).toHaveLength(UI_CLIENT_STATUSES.length)
    expect(new Set(CLIENT_STATUS_ORDER).size).toBe(CLIENT_STATUS_ORDER.length)
  })
})

/**
 * The brand palette is fixed-length and positional, and three places have to
 * agree about that: the PATCH schema requires exactly five entries, the card
 * renders one swatch per role, and `brandPalette` pads whatever is stored up
 * to that length. Any two of them disagreeing is a 400 on every save or a
 * silently dropped colour.
 */
/**
 * The red "Approval not received" tag.
 *
 * Derived at render like overdue payments and overdue invoices, so these are
 * the tests that stop it drifting. The rule is narrow on purpose and the tests
 * say why for each excluded status.
 */
/**
 * A timestamp rendered as the day it falls on where the reader is.
 *
 * The bug this exists to stop shipped once already, in a different shape: a
 * date rendered through `toLocaleDateString('en-GB')` spelled September
 * "Sept" while the rest of the product spelled it "Sep". Feeding timestamps
 * through the same pair of helpers as date columns is what keeps that from
 * happening again, so the pair is bound here.
 */
describe('localDayOf', () => {
  it('produces the YYYY-MM-DD shape formatShortDate and isPastDate take', () => {
    const day = localDayOf('2026-09-14T12:00:00.000Z')
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(formatShortDate(day)).toBe('14 Sep')
  })

  it('uses local calendar parts, never the UTC slice', () => {
    /*
     * Deliberately picks a local time that lands on a DIFFERENT UTC day.
     *
     * A fixed 23:30 would only expose `iso.slice(0, 10)` west of Greenwich —
     * mutation-verified: with the slice in place this test passed on a machine
     * running UTC+1, which is a test protecting nothing. So the side is chosen
     * from the runner's actual offset. In UTC itself the two are genuinely
     * identical and there is nothing to catch, which the branch says out loud
     * rather than pretending otherwise.
     */
    const offsetMinutes = new Date(2026, 8, 14).getTimezoneOffset()
    if (offsetMinutes === 0) {
      expect(localDayOf(new Date(2026, 8, 14, 12).toISOString())).toBe(
        '2026-09-14'
      )
      return
    }
    // getTimezoneOffset is positive WEST of UTC. Late evening there is already
    // tomorrow in UTC; early morning east of UTC is still yesterday.
    const local =
      offsetMinutes > 0
        ? new Date(2026, 8, 14, 23, 30)
        : new Date(2026, 8, 14, 0, 30)

    expect(localDayOf(local.toISOString())).toBe('2026-09-14')
    // And prove the naive version really would have differed here, so this
    // test cannot quietly stop testing anything.
    expect(local.toISOString().slice(0, 10)).not.toBe('2026-09-14')
  })

  it('never spells a month the way en-GB does', () => {
    // en-GB renders September as "Sept". Four characters where the feed grid
    // and the deadline badge both use three.
    expect(formatShortDate(localDayOf('2026-09-01T12:00:00.000Z'))).toBe(
      '1 Sep'
    )
  })

  it('returns empty for nothing and for nonsense, rather than "Invalid Date"', () => {
    expect(localDayOf(null)).toBe('')
    expect(localDayOf(undefined)).toBe('')
    expect(localDayOf('not a date')).toBe('')
  })
})

/**
 * A named slot downloads with an extension.
 *
 * "Agreement" is the row's name and must stay so on screen, but a file saved
 * as `Agreement` with no extension is one the operating system cannot open.
 * The stored key is what carries the truth, because it was named from the
 * sniffed type rather than from what the browser claimed the file was.
 */
/**
 * A new file slot needs a backfill, or only new clients ever get it.
 *
 * `seedNewClientWorkspace` runs once, when a portal is first opened. Adding a
 * name to DEFAULT_FILES therefore reaches new workspaces only, and every
 * client she already has would never see it — which is exactly what would have
 * happened to the Brief slot she asked for.
 */
describe('seeded file slots', () => {
  const migrations = readdirSync('server/db/migrations')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(`server/db/migrations/${f}`, 'utf8'))
    .join('\n')

  /** The five that existed before any client had a workspace to backfill. */
  const ORIGINAL = [
    'Agreement',
    'Invoices',
    'Reports',
    'Social Strategy',
    'Shoot Planning',
  ]

  it('every slot added since the original five has a backfill migration', () => {
    const added = DEFAULT_FILES.filter((n) => !ORIGINAL.includes(n))
    // If this list is empty the test proves nothing, so say so out loud.
    expect(added.length).toBeGreaterThan(0)
    for (const name of added) {
      expect(migrations, `${name} has no backfill migration`).toContain(
        `'${name}'`
      )
    }
  })

  it('still contains the original five, so none was quietly dropped', () => {
    for (const name of ORIGINAL) {
      expect(DEFAULT_FILES as readonly string[], name).toContain(name)
    }
  })
})

describe('downloadFilename', () => {
  it('gives a named slot the extension of what is in it', () => {
    expect(downloadFilename('Agreement', 'client/abc.pdf')).toBe('Agreement.pdf')
    expect(downloadFilename('Shoot Planning', 'client/abc.xlsx')).toBe(
      'Shoot Planning.xlsx'
    )
  })

  it('does not double an extension that is already there', () => {
    expect(downloadFilename('INV-2026-014.pdf', 'client/abc.pdf')).toBe(
      'INV-2026-014.pdf'
    )
    // Case-insensitively, because she types the name by hand.
    expect(downloadFilename('Report.PDF', 'client/abc.pdf')).toBe('Report.PDF')
  })

  it('leaves the name alone when the key has no extension', () => {
    expect(downloadFilename('Agreement', 'client/abc')).toBe('Agreement')
    expect(downloadFilename('Agreement', null)).toBe('Agreement')
  })

  it('does not mistake a dot in the path for an extension', () => {
    // A key like `some.dir/abc` has a dot BEFORE the last slash. Treating it
    // as the extension would append the whole directory name to the download.
    expect(downloadFilename('Agreement', 'some.dir/abc')).toBe('Agreement')
  })

  it('never produces a name ending in a bare dot', () => {
    expect(downloadFilename('Agreement', 'client/abc.')).toBe('Agreement')
  })
})

describe('share link tokens', () => {
  it('mints a long, URL-safe token and stores only its hash', () => {
    const { token, tokenHash } = mintReviewToken()
    // base64url of 32 bytes: no +, / or = to escape, and 256 bits of entropy —
    // which is the actual reason guessing is infeasible, not the rate limiter.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).not.toContain(token)
    expect(hashReviewToken(token)).toBe(tokenHash)
  })

  it('never mints the same token twice', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => mintReviewToken().token)
    )
    expect(seen.size).toBe(200)
  })

  it('expires a whole number of days out', () => {
    const from = new Date(2026, 8, 1, 12, 0, 0)
    const out = reviewLinkExpiry(from, 30)
    expect(out.getMonth()).toBe(9)
    expect(out.getDate()).toBe(1)
    expect(out > from).toBe(true)
  })
})

/**
 * `isLinkUsable` exists on BOTH sides — the server decides, and the browser
 * labels each link "Live"/"Expired"/"Revoked" without asking. Invariant 17:
 * two copies of one rule drift, so they are bound over the same inputs,
 * exactly as the two hashtag normalisers are.
 */
describe('isLinkUsable, on both sides', () => {
  const now = new Date(2026, 8, 1, 12)
  const cases = [
    { name: 'live', expiresAt: new Date(2026, 8, 30).toISOString(), revokedAt: null },
    { name: 'expired', expiresAt: new Date(2026, 7, 1).toISOString(), revokedAt: null },
    { name: 'revoked but not yet expired', expiresAt: new Date(2026, 8, 30).toISOString(), revokedAt: new Date(2026, 8, 2).toISOString() },
    { name: 'revoked AND expired', expiresAt: new Date(2026, 7, 1).toISOString(), revokedAt: new Date(2026, 7, 2).toISOString() },
    { name: 'expiring this very instant', expiresAt: now.toISOString(), revokedAt: null },
  ]

  it.each(cases)('agrees for a link that is $name', (c) => {
    expect(clientIsLinkUsable(c, now)).toBe(serverIsLinkUsable(c, now))
  })

  it('an expiry exactly now is NOT usable', () => {
    expect(serverIsLinkUsable({ expiresAt: now.toISOString(), revokedAt: null }, now)).toBe(false)
  })

  it('revocation beats an expiry still in the future', () => {
    // The order of the two checks matters: a revoked link must read "Revoked",
    // not "Live", or she thinks a link she pulled is still out there.
    expect(
      linkState(
        { expiresAt: new Date(2026, 8, 30).toISOString(), revokedAt: new Date(2026, 8, 2).toISOString() },
        now
      )
    ).toBe('revoked')
    expect(linkState({ expiresAt: new Date(2026, 8, 30).toISOString(), revokedAt: null }, now)).toBe('live')
    expect(linkState({ expiresAt: new Date(2026, 7, 1).toISOString(), revokedAt: null }, now)).toBe('expired')
  })
})

/**
 * A share-link path IS a live approval credential, and every request is
 * logged. Without redaction anyone with read access to journalctl could
 * approve her clients' posts.
 */
describe('share tokens never reach the log', () => {
  it('redacts the token from both the API and the SPA path', () => {
    expect(redactPath('/api/share/AbC-123_xyz')).toBe('/api/share/[token]')
    expect(redactPath('/share/AbC-123_xyz')).toBe('/share/[token]')
    expect(redactPath('/api/share/AbC-123_xyz/assets/9f2')).toBe(
      '/api/share/[token]/assets/9f2'
    )
    expect(redactPath('/api/share/AbC-123_xyz/decision')).toBe(
      '/api/share/[token]/decision'
    )
  })

  it('leaves every other path alone', () => {
    for (const p of ['/api/clients', '/api/media/assets/abc', '/portal/feed', '/']) {
      expect(redactPath(p), p).toBe(p)
    }
  })

  it('does NOT redact the staff routes, which carry ids and not tokens', () => {
    // /api/shares/... is the staff surface: a link id is not a credential, and
    // blanking it would cost the one thing the log is for. `\/share\/` must
    // not match `\/shares\/`.
    expect(redactPath('/api/shares/content/abc')).toBe('/api/shares/content/abc')
    expect(redactPath('/api/shares/9f2/revoke')).toBe('/api/shares/9f2/revoke')
    expect(redactPath('/api/shares/client/9f2/feed')).toBe(
      '/api/shares/client/9f2/feed'
    )
  })

  it('redacts a real minted token, not just a tidy example', () => {
    const { token } = mintReviewToken()
    const redacted = redactPath(`/api/share/${token}`)
    expect(redacted).not.toContain(token)
    expect(redacted).toBe('/api/share/[token]')
  })
})

/**
 * An ugly test, and it catches the single worst regression on this boundary:
 * somebody resolving a permissions error in review.ts by reaching for
 * withTenant. There is no HTTP-level harness in this project, so this is the
 * one mitigation available for the route wiring.
 */
describe('the public share routes claim no authority', () => {
  const raw = readFileSync('server/routes/review.ts', 'utf8')

  /*
   * Comments stripped first, and not as a convenience: the file's own header
   * explains that it must never reach for withTenant, so the prose contains
   * every string the rule forbids. The rule is about code. A crude strip is
   * the right tool — this is a tripwire, not a parser, and it only has to be
   * wrong in the safe direction.
   */
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it.each(['withTenant', "c.get('tenant')", 'isStaff: true', 'requireAuth', 'requireStaff'])(
    'review.ts never calls %s',
    (forbidden) => {
      expect(source).not.toContain(forbidden)
    }
  )

  it('obtains its authority only through withReviewToken', () => {
    expect(source).toContain('withReviewToken')
  })
})

describe('overdue approval', () => {
  const iso = (offsetDays: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('flags a post sent for review whose day has passed', () => {
    expect(
      isApprovalOverdue({ status: 'ready_for_review', scheduledAt: iso(-1) })
    ).toBe(true)
  })

  it('does not flag one whose day is still to come', () => {
    expect(
      isApprovalOverdue({ status: 'ready_for_review', scheduledAt: iso(1) })
    ).toBe(false)
  })

  it('does not flag one due today — she still has the day to chase it', () => {
    expect(
      isApprovalOverdue({ status: 'ready_for_review', scheduledAt: iso(0) })
    ).toBe(false)
  })

  it('never flags an undated post: no date is no deadline', () => {
    expect(
      isApprovalOverdue({ status: 'ready_for_review', scheduledAt: null })
    ).toBe(false)
  })

  /**
   * The important half. Every other status has already had its answer —
   * approving moves the row to scheduled/approved and requesting changes moves
   * it to in_progress — so flagging one would send her chasing a client who
   * already replied. An `approved` post past its date is a publishing failure,
   * not an approval one.
   */
  it('never flags a status that has already been decided', () => {
    for (const status of CLIENT_STATUSES) {
      if (status === 'ready_for_review') continue
      expect(
        isApprovalOverdue({ status, scheduledAt: iso(-30) }),
        status
      ).toBe(false)
    }
  })

  it('covers every status the enum has, so a new one cannot be forgotten', () => {
    // If a status is added to the enum, this list grows with it and the loop
    // above starts asserting about it — which is the point.
    expect(CLIENT_STATUSES).toContain('ready_for_review')
    expect(CLIENT_STATUSES.length).toBeGreaterThan(1)
  })
})

describe('brand palette', () => {
  it('is the same number of slots on both sides, with a label for each', () => {
    expect(UI_BRAND_SLOTS).toBe(SERVER_BRAND_SLOTS)
    expect(BRAND_COLOR_ROLES).toHaveLength(UI_BRAND_SLOTS)
    expect(new Set(BRAND_COLOR_ROLES).size).toBe(BRAND_COLOR_ROLES.length)
  })

  it('pads a short or empty stored palette to full length', () => {
    // Every client starts with '{}' — read positionally, that must still
    // answer five slots rather than undefined.
    expect(brandPalette([])).toEqual(['', '', '', '', ''])
    expect(brandPalette(null)).toHaveLength(UI_BRAND_SLOTS)
    expect(brandPalette(['#112233'])).toEqual(['#112233', '', '', '', ''])
  })

  it('never lengthens a palette that is already full', () => {
    const full = ['#111111', '#222222', '#333333', '#444444', '#555555']
    expect(brandPalette(full)).toEqual(full)
  })

  /**
   * The binding that matters: everything normaliseHex accepts must be
   * something the server's PATCH schema accepts, or the field takes a value
   * the save then rejects.
   */
  it('produces only what the server regex accepts', () => {
    const serverAccepts = /^#[0-9a-fA-F]{6}$/
    const inputs = [
      '#1A2B3C',
      '1a2b3c',
      '#abc',
      'ABC',
      '  #ff0055  ',
      '#FFFFFF',
      '000',
    ]
    for (const raw of inputs) {
      const hex = normaliseHex(raw)
      expect(hex, raw).not.toBeNull()
      expect(hex, raw).toMatch(serverAccepts)
      // Lowercase, so a picked colour and a pasted one compare equal.
      expect(hex, raw).toBe(hex!.toLowerCase())
    }
  })

  it('expands three digits by doubling, not by padding', () => {
    expect(normaliseHex('#abc')).toBe('#aabbcc')
    expect(normaliseHex('#f00')).toBe('#ff0000')
  })

  it('refuses anything that is not a colour, including blank', () => {
    for (const raw of ['', '   ', '#', 'red', '#12345', '#1234567', '#gghhii']) {
      expect(normaliseHex(raw), raw).toBeNull()
    }
  })
})

describe('payment status', () => {
  it('matches across the enum, the API and the client', () => {
    expect([...SERVER_PAYMENTS]).toEqual([...CLIENT_PAYMENTS])
    expect([...paymentStatus.enumValues]).toEqual([...CLIENT_PAYMENTS])
  })

  it('never stores overdue', () => {
    expect(CLIENT_PAYMENTS).not.toContain('overdue')
    expect([...paymentStatus.enumValues]).not.toContain('overdue')
  })

  it('derives overdue from a due date that has passed', () => {
    const past = new Date(Date.now() - 3 * 86_400_000)
    const future = new Date(Date.now() + 3 * 86_400_000)
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    expect(paymentState({ paymentStatus: 'awaiting', paymentDue: iso(past) })).toBe('overdue')
    expect(paymentState({ paymentStatus: 'awaiting', paymentDue: iso(future) })).toBe('awaiting')
  })

  it('never calls a paid or untracked deal overdue, however old the date', () => {
    // The bug this guards: colouring a settled invoice red because its due
    // date is in the past. Only `awaiting` can become overdue.
    expect(paymentState({ paymentStatus: 'paid', paymentDue: '2020-01-01' })).toBe('paid')
    expect(paymentState({ paymentStatus: 'none', paymentDue: '2020-01-01' })).toBe('none')
  })

  it('leaves an awaiting deal with no due date simply awaiting', () => {
    expect(paymentState({ paymentStatus: 'awaiting', paymentDue: null })).toBe('awaiting')
  })
})

/**
 * Invoices.
 *
 * A retainer is billed in stages, so one deal carries many invoices and an
 * invoice can be half settled. Only three states are stored — draft, sent,
 * void — because paid, part paid and overdue are facts about the receipts and
 * today's date. Storing them would mean something had to run at midnight to
 * keep them honest.
 */
describe('invoice state', () => {
  const base = { status: 'sent' as const, amountPence: 500000, dueOn: null }
  const iso = (offsetDays: number) => {
    const d = new Date(Date.now() + offsetDays * 86_400_000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('matches across the enum, the API and the client', () => {
    expect([...SERVER_INVOICE_STATUSES]).toEqual([...CLIENT_INVOICE_STATUSES])
    expect([...invoiceStatus.enumValues]).toEqual([...CLIENT_INVOICE_STATUSES])
  })

  it('stores none of the derived states', () => {
    for (const derived of ['paid', 'part_paid', 'overdue']) {
      expect([...invoiceStatus.enumValues]).not.toContain(derived)
    }
  })

  it('is part paid after a deposit, and paid once settled', () => {
    // Her actual shape: a £300 deposit against a £5,000 retainer, then the
    // balance. Two receipts, one invoice.
    expect(invoiceState({ ...base, paidPence: 0 })).toBe('sent')
    expect(invoiceState({ ...base, paidPence: 30000 })).toBe('part_paid')
    expect(invoiceState({ ...base, paidPence: 500000 })).toBe('paid')
  })

  it('calls a late invoice overdue even when partly paid', () => {
    // Overdue outranks part paid: half the money arriving does not make a
    // missed deadline stop mattering.
    expect(
      invoiceState({ ...base, paidPence: 30000, dueOn: iso(-3) })
    ).toBe('overdue')
  })

  it('never calls a settled or unsent invoice overdue, however old the date', () => {
    expect(invoiceState({ ...base, paidPence: 500000, dueOn: iso(-90) })).toBe('paid')
    expect(
      invoiceState({ status: 'draft', amountPence: 1000, paidPence: 0, dueOn: iso(-90) })
    ).toBe('draft')
    expect(
      invoiceState({ status: 'void', amountPence: 1000, paidPence: 0, dueOn: iso(-90) })
    ).toBe('void')
  })

  it('counts nothing outstanding on a draft or a void', () => {
    // A draft has not been asked for and a void has been withdrawn. Including
    // either in "what they owe" would overstate the debt on her dashboard.
    expect(outstandingPence({ status: 'draft', amountPence: 500000, paidPence: 0 })).toBe(0)
    expect(outstandingPence({ status: 'void', amountPence: 500000, paidPence: 0 })).toBe(0)
    expect(outstandingPence({ status: 'sent', amountPence: 500000, paidPence: 30000 })).toBe(470000)
  })
})

/**
 * Posting time.
 *
 * Postgres returns a `time` column as 'HH:MM:SS'; a picker sends 'HH:MM'. Two
 * places have to agree on that: the server compares the stored value against
 * what a PATCH sent, to decide whether the post actually moved, and the client
 * renders it. If they disagree, '18:30' never equals '18:30:00' and every save
 * writes a timeline entry claiming the post was rescheduled when nothing
 * changed — noise in the one record she reads to answer "when did this move".
 */
describe('posting time', () => {
  it('normalises the stored format to what a picker sends', () => {
    expect(hhmm('18:30:00')).toBe('18:30')
    expect(formatTime('18:30:00')).toBe('18:30')
  })

  it('agrees across the server and the client, including midnight', () => {
    for (const stored of ['00:00:00', '09:05:00', '23:59:00', '18:30']) {
      expect(hhmm(stored)).toBe(formatTime(stored))
    }
  })

  it('treats an absent time as absent rather than as midnight', () => {
    // Coercing null to '00:00' would put every undated idea at the top of a
    // day and claim a slot nobody chose.
    expect(hhmm(null)).toBeNull()
    expect(formatTime(null)).toBe('')
  })
})

/**
 * Money helpers.
 *
 * Deal values are numeric(12,2) carried as strings. These ran in the browser
 * suite only by accident of where they live; they are pure functions and the
 * arithmetic is what matters, so they are pinned here.
 */
/**
 * A date rendered from LOCAL parts.
 *
 * The feed grid shows a posting date next to each title, and the obvious
 * `new Date('2026-09-01')` parses as UTC midnight — which renders as 31 August
 * for anyone west of Greenwich and, on an evening render, misreports the day
 * east of it. Same trap `isPastDate` above exists to avoid.
 */
describe('formatShortDate', () => {
  it('renders the day that was stored, not the UTC one', () => {
    // A date the UTC reading would move: midnight UTC on the 1st is still the
    // 31st in New York, and this must say the 1st wherever it is read.
    expect(formatShortDate('2026-09-01')).toBe('1 Sep')
    expect(formatShortDate('2026-01-31')).toBe('31 Jan')
    expect(formatShortDate('2026-12-25')).toBe('25 Dec')
  })

  it('abbreviates every month to three characters', () => {
    // Not `toLocaleDateString`: en-GB gives "Sept" for September, which is a
    // character too many for a feed cell, and its output moves with the ICU
    // data in whichever Node is running.
    const months = Array.from({ length: 12 }, (_, i) =>
      formatShortDate(`2026-${String(i + 1).padStart(2, '0')}-05`)
    )
    expect(months).toEqual([
      '5 Jan', '5 Feb', '5 Mar', '5 Apr', '5 May', '5 Jun',
      '5 Jul', '5 Aug', '5 Sep', '5 Oct', '5 Nov', '5 Dec',
    ])
  })

  it('renders nothing for a month outside the calendar', () => {
    expect(formatShortDate('2026-13-01')).toBe('')
    expect(formatShortDate('2026-00-01')).toBe('')
  })

  it('renders nothing for an absent or unusable date', () => {
    // An undated idea is the common case — the cell shows its title alone
    // rather than an em dash standing in for a date nobody set.
    expect(formatShortDate(null)).toBe('')
    expect(formatShortDate(undefined)).toBe('')
    expect(formatShortDate('')).toBe('')
    expect(formatShortDate('not-a-date')).toBe('')
  })
})

describe('money', () => {
  it.each([
    ['2400.00', 240000],
    ['2400.5', 240050],
    ['2400.05', 240005],
    ['2400', 240000],
    ['0.99', 99],
    ['-100.50', -10050],
    // Number('-0') is -0 and `-0 < 0` is false, so this returned +50.
    ['-0.50', -50],
    ['', 0],
  ])('toPence(%s) = %i', (input, expected) => {
    expect(toPence(input)).toBe(expected)
  })

  it('sums without float drift', () => {
    // As floats this is 4299.599999999999.
    expect(sumPence(['1800.10', '2400.20', '99.30'])).toBe(429960)
  })

  it('shows pence only when there are pence', () => {
    // Rounding these away rendered £2,400.50 as "£2,401" — a figure that does
    // not match the contract she signed.
    expect(formatPence(240000)).toBe('£2,400')
    expect(formatPence(240050)).toBe('£2,400.50')
    expect(formatPence(75)).toBe('£0.75')
    expect(formatPence(-10050)).toBe('-£100.50')
  })
})

/**
 * Next-step ordering.
 *
 * The panel leads the page, so whatever sorts first is what she reads first.
 * The failure that matters is an undated item sorting to the top: null sorts
 * before everything in most naive comparators, which would put a post with no
 * schedule above one due tomorrow and make the panel actively misleading.
 */
describe('compareSteps', () => {
  const sorted = (steps: { due: string | null; title: string }[]) =>
    [...steps].sort(compareSteps).map((s) => s.title)

  it('puts the soonest deadline first', () => {
    expect(
      sorted([
        { due: '2026-09-01', title: 'later' },
        { due: '2026-08-20', title: 'sooner' },
      ])
    ).toEqual(['sooner', 'later'])
  })

  it('sorts undated LAST, not first', () => {
    expect(
      sorted([
        { due: null, title: 'no date' },
        { due: '2026-08-20', title: 'due soon' },
      ])
    ).toEqual(['due soon', 'no date'])
  })

  it('keeps overdue above everything still to come', () => {
    expect(
      sorted([
        { due: '2026-12-01', title: 'future' },
        { due: '2020-01-01', title: 'overdue' },
        { due: null, title: 'undated' },
      ])
    ).toEqual(['overdue', 'future', 'undated'])
  })

  it('breaks a tie on title so the order is stable between requests', () => {
    expect(
      sorted([
        { due: '2026-08-20', title: 'beta' },
        { due: '2026-08-20', title: 'alpha' },
      ])
    ).toEqual(['alpha', 'beta'])
  })

  it('compares dates as strings, which is chronological for YYYY-MM-DD', () => {
    // The trap: '2026-9-1' would break this, which is why the column is a date
    // and the value is never hand-built.
    expect(
      sorted([
        { due: '2026-10-01', title: 'october' },
        { due: '2026-09-30', title: 'september' },
      ])
    ).toEqual(['september', 'october'])
  })
})

/**
 * Hashtag normalisation, on both sides of the wire.
 *
 * There are two copies of this function because the server cannot import from
 * src and the browser should not import from server. That is a real risk: a
 * client that normalises differently from the server shows her a tag list that
 * is not what was saved, and she would only find out by reloading. So every
 * case below runs through BOTH implementations and asserts they agree.
 */
describe('hashtag normalisation', () => {
  const cases: [string, string[], string[]][] = [
    ['strips the hash', ['#LDN'], ['LDN']],
    ['strips punctuation and spaces', [' #social media! '], ['socialmedia']],
    [
      'dedupes case-insensitively, keeping the first spelling',
      ['BananaDigital', 'bananadigital', 'BANANADIGITAL'],
      ['BananaDigital'],
    ],
    ['drops entries that are only punctuation', ['#', '  ', '###'], []],
    ['keeps underscores and digits', ['#top_10'], ['top_10']],
    ['keeps non-latin letters', ['#café', '#東京'], ['café', '東京']],
    ['preserves order', ['#b', '#a', '#c'], ['b', 'a', 'c']],
  ]

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(serverNormalise(input)).toEqual(expected)
      expect(clientNormalise(input)).toEqual(expected)
    })
  }

  it('case-folds with locale rules on both sides', () => {
    // Two spellings that differ only in case must collapse to one.
    expect(serverNormalise(['Straße', 'straße'])).toEqual(['Straße'])
    expect(clientNormalise(['Straße', 'straße'])).toEqual(['Straße'])
  })

  it('parses a pasted blob the same way on both sides', () => {
    const blob = '#one #two,#three\n#one  four'
    const expected = ['one', 'two', 'three', 'four']
    expect(serverParse(blob)).toEqual(expected)
    expect(clientParse(blob)).toEqual(expected)
  })

  it('splits tags written with no spaces between them', () => {
    // How they arrive when copied straight out of a caption.
    expect(serverParse('#one#two#three')).toEqual(['one', 'two', 'three'])
    expect(clientParse('#one#two#three')).toEqual(['one', 'two', 'three'])
  })

  it('agrees on the limit', () => {
    expect(SERVER_HASHTAG_LIMIT).toBe(CLIENT_HASHTAG_LIMIT)
    // Instagram's cap. If this changes, it changed on purpose.
    expect(SERVER_HASHTAG_LIMIT).toBe(30)
  })
})

/**
 * A closed portal is actually closed.
 *
 * `portal_enabled` gated the workspace switcher and nothing else, so a client
 * whose portal she had turned off kept full read access by loading the page
 * directly. Found while checking that archiving closes the portal: the
 * endpoint answered 200 for a client whose portal_enabled was false.
 */
describe('canSeePortal', () => {
  const staff = { isStaff: true }
  const client = { isStaff: false }

  it('refuses a client whose portal is closed', () => {
    expect(canSeePortal(client, { portalEnabled: false })).toBe(false)
  })

  it('admits a client whose portal is open', () => {
    expect(canSeePortal(client, { portalEnabled: true })).toBe(true)
  })

  it('admits staff either way, so a workspace can be built before it opens', () => {
    expect(canSeePortal(staff, { portalEnabled: false })).toBe(true)
    expect(canSeePortal(staff, { portalEnabled: true })).toBe(true)
  })

  it('refuses nobody at all', () => {
    expect(canSeePortal(undefined, { portalEnabled: true })).toBe(false)
    expect(canSeePortal(null, { portalEnabled: true })).toBe(false)
  })
})
