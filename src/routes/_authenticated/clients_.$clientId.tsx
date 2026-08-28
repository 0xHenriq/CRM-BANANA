import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { ClientDetailPage } from '@/features/clients/detail'
import { CLIENT_TAB_VALUES, type ClientTab } from '@/features/clients/tabs'
import { requireStaffRoute } from '@/lib/route-guards'

/**
 * The open tab lives in the URL.
 *
 * So a refresh comes back to the tab she was on, the browser's Back button
 * steps between tabs rather than leaving the client entirely, and a link she
 * pastes to herself opens where she meant.
 *
 * `.catch()` rather than a bare enum: an unknown or hand-edited `?tab=` falls
 * back to Overview instead of failing validation, which in TanStack Router
 * means an error boundary where a client page should be.
 */
const searchSchema = z.object({
  tab: z.enum(CLIENT_TAB_VALUES).catch('overview').optional(),
})

/**
 * The route reads the URL; the page takes a value and a callback.
 *
 * Not `useSearch({ from })` inside the page, which is the shorter version and
 * does not typecheck here: this file imports the page component, so a router
 * hook in the page closes the loop routeTree.gen → route → page → registry,
 * and TypeScript resolves the whole router type to `never` — every `from`
 * string on the page becomes an error, including the `useParams` that had been
 * working. Passing the tab down keeps the URL knowledge in the file that owns
 * the URL, which is where it belongs anyway.
 */
export const Route = createFileRoute('/_authenticated/clients_/$clientId')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  validateSearch: searchSchema,
  // Declared here rather than beside `Route`, so the module still exports only
  // `Route` and fast refresh keeps working. Named, so it is not "Anonymous" in
  // a stack trace or the React devtools tree.
  component: function ClientDetailRoute() {
    const { tab } = Route.useSearch()
    const navigate = Route.useNavigate()

    return (
      <ClientDetailPage
        tab={tab ?? 'overview'}
        onTabChange={(next: ClientTab) =>
          navigate({
            search: (prev) => ({ ...prev, tab: next }),
            // Replace, so ten tab clicks are not ten Back presses to leave.
            replace: true,
          })
        }
      />
    )
  },
})
