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
  contentStatus,
  contentType,
  invoiceStatus,
  paymentStatus,
} from '../db/schema.js'
import { INVOICE_STATUSES as SERVER_INVOICE_STATUSES } from '../routes/invoices.js'
import { hhmm } from '../lib/audit.js'
import { compareSteps } from '../routes/next-steps.js'
import { canSeePortal } from '../routes/portal.js'
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
  CONTENT_STATUSES as CLIENT_STATUSES,
  CONTENT_TYPES as CLIENT_TYPES,
  DEAL_STAGES as CLIENT_STAGES,
  PAYMENT_STATUSES as CLIENT_PAYMENTS,
  INVOICE_STATUSES as CLIENT_INVOICE_STATUSES,
  invoiceState,
  outstandingPence,
  paymentState,
  formatPence,
  formatTime,
  sumPence,
  toPence,
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
