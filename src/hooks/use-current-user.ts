import { useQuery } from '@tanstack/react-query'

export type CurrentUser = {
  id: string
  email: string
  name: string
  role: string
  isStaff: boolean
}

/**
 * The signed-in user, as the *server* sees them.
 *
 * Deliberately not derived from the Better Auth session payload on the client:
 * `isStaff` is resolved server-side from the member row, and having exactly one
 * authority for it means the sidebar and the API can never disagree about who
 * someone is.
 */
export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.status === 401) return null
      if (!res.ok) throw new Error('Could not load the current user')
      const data = (await res.json()) as { user: CurrentUser }
      return data.user
    },
    staleTime: 60_000,
    retry: false,
  })
}
