import { describe, expect, it } from 'vitest'
import {
  filePatchSchema,
  linkPatchSchema,
  taskPatchSchema,
} from '../routes/portal.js'

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
