/**
 * The client page's four tabs, in one place.
 *
 * Its own module rather than an export from `detail.tsx`, and that is not
 * tidiness. The route file validates `?tab=` against this list, so importing
 * it from the page component would make the route file depend on the component
 * while the component reads its own route's search params — a cycle that
 * TanStack Router's type registry resolves to `never`, and every `useSearch`
 * and `useNavigate` on the page loses its types with it. This module imports
 * nothing, so there is no cycle to resolve.
 *
 * Grouped by the question she is asking: who are they (Overview), what are we
 * making (Work), what do they owe (Money), what have we got (Files).
 */
export const CLIENT_TAB_VALUES = ['overview', 'work', 'money', 'files'] as const

export type ClientTab = (typeof CLIENT_TAB_VALUES)[number]

export const CLIENT_TAB_LABEL: Record<ClientTab, string> = {
  overview: 'Overview',
  work: 'Work',
  money: 'Money',
  files: 'Files',
}
