import { toast } from 'sonner'
import { ApiError } from '@/lib/api'

/**
 * The fallback toast for an error no mutation handled itself.
 *
 * It used to test for `AxiosError`, which the scaffold assumed and this app
 * has never thrown — every request goes through `src/lib/api.ts` and fails as
 * an `ApiError`. So the branch was dead and every failure said "Something
 * went wrong!", discarding the message the server wrote for a human ("All 10
 * seats are taken…"), which is the only part worth reading.
 */
export function handleServerError(error: unknown) {
  let errMsg = 'Something went wrong!'

  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    Number(error.status) === 204
  ) {
    errMsg = 'No content.'
  }

  if (error instanceof ApiError && error.message) {
    errMsg = error.message
  }

  toast.error(errMsg)
}
