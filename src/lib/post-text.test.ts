import { describe, expect, it } from 'vitest'
import { postText } from './api'

/**
 * The block she pastes into Instagram on posting day.
 *
 * Worth pinning as a property rather than trusting: the caller disables its
 * button on `''`, so "nothing to copy" has to be exactly that and not a stray
 * newline — a Copy button that puts a blank line over her clipboard is worse
 * than one that is greyed out.
 */
describe('postText', () => {
  it('puts a blank line between the caption and the tags', () => {
    expect(
      postText({ caption: 'Zara was excluded.', hashtags: ['SEND', 'EHCP'] })
    ).toBe('Zara was excluded.\n\n#SEND #EHCP')
  })

  it('is just the caption when there are no tags', () => {
    expect(postText({ caption: 'No tags here.', hashtags: [] })).toBe(
      'No tags here.'
    )
    expect(postText({ caption: 'No tags here.', hashtags: null })).toBe(
      'No tags here.'
    )
  })

  it('is just the tags when there is no caption', () => {
    // No leading blank line: pasting this should start with the first tag.
    expect(postText({ caption: null, hashtags: ['SEND'] })).toBe('#SEND')
    expect(postText({ caption: '   ', hashtags: ['SEND'] })).toBe('#SEND')
  })

  it('is empty when there is nothing to say', () => {
    // Exactly '' — the button reads this to decide whether it can be pressed.
    expect(postText({ caption: null, hashtags: [] })).toBe('')
    expect(postText({ caption: '  ', hashtags: null })).toBe('')
  })

  it('adds the hash back, because the store keeps them without one', () => {
    // Hashtags are normalised on the way in: no hashes, no punctuation. The
    // hash is presentation, and this is the one place it goes back on.
    expect(postText({ caption: null, hashtags: ['SEND', 'SouthLondon'] })).toBe(
      '#SEND #SouthLondon'
    )
  })
})
