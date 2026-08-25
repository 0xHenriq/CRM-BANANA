import { describe, expect, it } from 'vitest'
import {
  filePatchSchema,
  linkPatchSchema,
  taskPatchSchema,
} from '../routes/portal.js'
import {
  duplicateFields,
  scheduleOverrides,
  timeForNewItem,
} from '../routes/content.js'

/**
 * PATCH schemas must not carry defaults.
 *
 * `schema.partial()` does NOT strip `.default()`: a field omitted from the
 * request body still parses back populated. That is how ticking off
 * "INTERNAL: chase unpaid invoice" published it to the client — the body was
 * {"done":true}, and the schema helpfully added visibleToClient:true.
 *
 * These tests encode the rule as a property rather than a comment: parsing a
 * minimal body must return exactly the keys that were sent.
 */
describe('patch schemas do not invent fields', () => {
  it('a task tick does not carry visibility with it', () => {
    const parsed = taskPatchSchema.parse({ done: true })
    expect(Object.keys(parsed)).toEqual(['done'])
    expect('visibleToClient' in parsed).toBe(false)
  })

  it('renaming a link does not blank its url', () => {
    const parsed = linkPatchSchema.parse({ label: 'Google Drive (shared)' })
    expect(Object.keys(parsed)).toEqual(['label'])
    expect('url' in parsed).toBe(false)
  })

  it('renaming a file does not blank its link', () => {
    const parsed = filePatchSchema.parse({ name: 'Agreement v2' })
    expect(Object.keys(parsed)).toEqual(['name'])
    expect('externalUrl' in parsed).toBe(false)
  })

  it('still accepts the fields that are sent', () => {
    expect(taskPatchSchema.parse({ done: false, visibleToClient: true })).toEqual({
      done: false,
      visibleToClient: true,
    })
    expect(linkPatchSchema.parse({ label: 'A', url: 'https://x.test' })).toEqual({
      label: 'A',
      url: 'https://x.test',
    })
  })
})

/**
 * A duplicate must not inherit approval.
 *
 * The copy is a fresh idea: nobody has reviewed it. Inheriting `approved` or
 * `scheduled` would put a post on the calendar carrying a decision that was
 * made about different creative, and inheriting `visibleToClient` would show
 * the client unreviewed work — the same shape of bug as the PATCH defaults
 * above, arrived at from the other direction.
 */
describe('duplicating a post resets what it must', () => {
  const approvedAndShared = {
    title: 'Autumn range hero',
    type: 'carousel' as const,
    caption: 'Shop the drop',
    hashtags: ['AutumnRange', 'LDN'],
  }

  it('starts the copy as an unreviewed, unshared idea', () => {
    const copy = duplicateFields(approvedAndShared)
    expect(copy.status).toBe('idea')
    expect(copy.visibleToClient).toBe(false)
  })

  it('takes the copy off the calendar and out of the feed', () => {
    const copy = duplicateFields(approvedAndShared)
    expect(copy.scheduledAt).toBeNull()
    expect(copy.scheduledTime).toBeNull()
    expect(copy.feedOrder).toBeNull()
  })

  it('keeps the creative but marks the title', () => {
    const copy = duplicateFields(approvedAndShared)
    expect(copy.title).toBe('Autumn range hero (copy)')
    expect(copy.type).toBe('carousel')
    expect(copy.caption).toBe('Shop the drop')
    // Carried over for the same reason as the caption: a duplicate is the same
    // post again on a new date, and retyping thirty tags is why she would stop
    // using the button.
    expect(copy.hashtags).toEqual(['AutumnRange', 'LDN'])
  })

  it('does not overflow the title column', () => {
    // title is varchar-bounded at 200 by the create schema; " (copy)" on an
    // already-long name has to be truncated rather than rejected at insert.
    const copy = duplicateFields({ ...approvedAndShared, title: 'x'.repeat(200) })
    expect(copy.title.length).toBe(200)
  })
})

/**
 * A posting time cannot exist without a day.
 *
 * The first version of this rule only looked at whether the request said
 * `scheduledAt: null`, which left the other direction open: sending just a
 * time to an undated idea stored "18:30, no date". The calendar cannot place
 * that row, and the time reappears at a slot nobody chose the day the post is
 * finally scheduled. The rule has to be judged on the row as it will be, not
 * on what the request happens to mention.
 */
describe('a posting time needs a date', () => {
  it('refuses a time on a create with no date', () => {
    expect(timeForNewItem(null, '18:30')).toBeNull()
    expect(timeForNewItem(undefined, '18:30')).toBeNull()
  })

  it('keeps a time on a create that has a date', () => {
    expect(timeForNewItem('2026-09-20', '18:30')).toBe('18:30')
    expect(timeForNewItem('2026-09-20', null)).toBeNull()
  })

  it('clears the time when a patch clears the date', () => {
    expect(scheduleOverrides('2026-09-20', { scheduledAt: null })).toEqual({
      scheduledTime: null,
    })
  })

  it('clears the time when a patch sets one on a row that has no date', () => {
    // The hole. The request never mentions scheduledAt, so the old check saw
    // nothing to act on and wrote the time anyway.
    expect(scheduleOverrides(null, {})).toEqual({ scheduledTime: null })
  })

  it('leaves the time alone when the row keeps a date', () => {
    // `{}` and not `{scheduledTime: undefined}` — an omitted key is what makes
    // Drizzle skip the column instead of writing null over a real value.
    expect(scheduleOverrides('2026-09-20', {})).toEqual({})
    expect(scheduleOverrides(null, { scheduledAt: '2026-09-20' })).toEqual({})
  })
})
