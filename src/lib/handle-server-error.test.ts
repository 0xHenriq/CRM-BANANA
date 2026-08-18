import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { handleServerError } from './handle-server-error'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
  },
}))

beforeEach(() => {
  vi.mocked(toastError).mockClear()
})

describe('handleServerError', () => {
  it('shows a generic message when the error is not recognised', () => {
    handleServerError(new Error('network'))

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })

  it('maps a plain object with status 204 to the no-content message', () => {
    handleServerError({ status: 204 })

    expect(toastError).toHaveBeenCalledWith('No content.')
  })

  /**
   * The message the server wrote is the whole point: "All 10 seats are taken
   * (10 active, 0 pending)" tells her what to do, and "Something went wrong!"
   * does not. These tests previously asserted the same thing about
   * `AxiosError`, which nothing in this app throws — so they passed while the
   * behaviour they described could not happen.
   */
  it("shows the server's own message when the error came from the API", () => {
    handleServerError(new ApiError('All 10 seats are taken.', 409))

    expect(toastError).toHaveBeenCalledWith('All 10 seats are taken.')
  })

  it('falls back to the generic message when the API sent an empty one', () => {
    handleServerError(new ApiError('', 500))

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })

  it('does not surface the text of an error that is not from the API', () => {
    // A TypeError from our own code must not be shown to a client verbatim.
    handleServerError(new TypeError('cannot read properties of undefined'))

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })
})
