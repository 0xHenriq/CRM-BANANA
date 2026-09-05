import { describe, expect, it } from 'vitest'
import {
  credentialPatchSchema,
  filePatchSchema,
  linkPatchSchema,
  taskCommentSchema,
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

  it('renaming a stored login does not clear its password', () => {
    /*
     * The three states this schema has to keep apart, and the reason it is
     * written out rather than derived from the create schema:
     *
     *   absent      leave the stored secret exactly as it is
     *   null        clear it
     *   a string    replace it
     *
     * Only the first is at risk from the `.partial()` trap, and it is the one
     * that matters most: correcting the username on a row would otherwise
     * blank the password with nothing on screen to say so, and the next time
     * anyone needed it they would find an empty field and no idea when it went.
     */
    const parsed = credentialPatchSchema.parse({ username: '@banana.digital' })
    expect(Object.keys(parsed)).toEqual(['username'])
    expect('secret' in parsed).toBe(false)
  })

  it('a stored login can still be cleared on purpose', () => {
    // The other two states, so "absent" above is a distinction rather than the
    // only behaviour the schema has.
    expect(credentialPatchSchema.parse({ secret: null })).toEqual({ secret: null })
    expect(credentialPatchSchema.parse({ secret: 'new-one' })).toEqual({
      secret: 'new-one',
    })
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
/**
 * Whitespace is not content.
 *
 * `z.string().min(1)` accepts "   ", and both of these columns are `NOT NULL`
 * text, which is perfectly happy with ''. The handlers trimmed AFTER
 * validating, so a spacebar produced a blank reply with a timestamp on it —
 * and bumped the reply count, so the to-do advertised something to read that
 * was not there. `.trim()` goes before `.min(1)`, and these pin it.
 */
describe('whitespace-only input is refused, not stored empty', () => {
  it('a reply of spaces is not a reply', () => {
    expect(taskCommentSchema.safeParse({ body: '   ' }).success).toBe(false)
    expect(taskCommentSchema.safeParse({ body: '' }).success).toBe(false)
  })

  it('a reply is stored already trimmed', () => {
    expect(taskCommentSchema.parse({ body: '  send it  ' })).toEqual({
      body: 'send it',
    })
  })

  it('a stored login cannot be renamed to nothing', () => {
    expect(credentialPatchSchema.safeParse({ label: '  ' }).success).toBe(false)
    expect(credentialPatchSchema.parse({ label: ' Instagram ' })).toEqual({
      label: 'Instagram',
    })
  })
})

describe('duplicating a post resets what it must', () => {
  const approvedAndShared = {
    title: 'Autumn range hero',
    type: 'carousel' as const,
    caption: 'Shop the drop',
    hashtags: ['AutumnRange', 'LDN'],
    platforms: ['instagram', 'tiktok'],
  }

  it('starts the copy as an unreviewed, unshared idea', () => {
    const copy = duplicateFields(approvedAndShared)
    expect(copy.status).toBe('idea')
    expect(copy.visibleToClient).toBe(false)
  })

  it('keeps the work: caption, hashtags and destinations', () => {
    /*
     * The three fields the copy exists to save her retyping. `platforms` was
     * added to the table without being added here first, and the copier only
     * carries what it can see — so every duplicate would have come back
     * reading "nobody has said where this goes", which is a real state that
     * means something and would have been manufactured out of nothing.
     */
    const copy = duplicateFields(approvedAndShared)
    expect(copy.caption).toBe('Shop the drop')
    expect(copy.hashtags).toEqual(['AutumnRange', 'LDN'])
    expect(copy.platforms).toEqual(['instagram', 'tiktok'])
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
