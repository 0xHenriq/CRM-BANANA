import { describe, expect, it } from 'vitest'
import { DEAL_STAGES as SERVER_STAGES } from '../routes/deals.js'
import {
  DEAL_STAGES as CLIENT_STAGES,
  formatPence,
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
