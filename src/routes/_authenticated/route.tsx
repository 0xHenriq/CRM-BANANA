import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import type { CurrentUser } from '@/hooks/use-current-user'

export const Route = createFileRoute('/_authenticated')({
  /**
   * Gate every authenticated route on a real server-side session.
   *
   * Asking the API rather than reading local state is the point: a cookie can
   * expire, be revoked, or belong to a deleted account, and only the server
   * knows. The result is cached in the query client so this is one request per
   * navigation burst, not per route.
   */
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData<CurrentUser | null>({
      queryKey: ['me'],
      queryFn: async () => {
        const res = await fetch('/api/me', { credentials: 'include' })
        if (res.status === 401) return null
        if (!res.ok) throw new Error('Could not load the current user')
        const data = (await res.json()) as { user: CurrentUser }
        return data.user
      },
      staleTime: 60_000,
    })

    if (!user) {
      throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    }

    return { user }
  },
  component: AuthenticatedLayout,
})
