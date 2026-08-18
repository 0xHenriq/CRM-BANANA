import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { DirectionProvider } from './context/direction-provider'
import { FontProvider } from './context/font-provider'
import { ThemeProvider } from './context/theme-provider'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Styles
import './styles/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // An auth failure will not answer differently on the fourth attempt;
        // retrying only delays the redirect to sign-in. This tested for
        // AxiosError, which nothing here throws, so every 401 was retried.
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          return false
        }
        if (import.meta.env.DEV) return false
        return failureCount <= 3
      },
      refetchOnWindowFocus: import.meta.env.PROD,

      staleTime: 10 * 1000, // 10s
    },
    mutations: {
      // Only reached by mutations that do not handle their own onError; the
      // rest toast the server's message themselves.
      onError: (error) => handleServerError(error),
    },
  },
  queryCache: new QueryCache({
    /**
     * The session-expiry path. This was guarded on `error instanceof
     * AxiosError` and therefore never ran: a 401 left the user sitting on a
     * screen of stale rows with no toast, no cache clear and no redirect,
     * until they happened to reload. `ApiError` is what `src/lib/api.ts`
     * actually throws, and it carries the status directly.
     */
    onError: (error) => {
      if (!(error instanceof ApiError)) return

      if (error.status === 401) {
        /**
         * Only from a signed-in screen, and only once.
         *
         * A session expiring fails every query that is in flight, and each
         * failure ran this. Landing on /sign-in then failed the next one,
         * whose redirect captured a href that already carried a redirect:
         * verified in the browser as
         * `/sign-in?redirect=%2Fsign-in%3Fredirect%3D%252Fsign-in…`, nesting
         * once per query, plus a stack of identical toasts. Sitting on the
         * sign-in page is the end state, so there is nothing left to do.
         */
        if (router.history.location.pathname === '/sign-in') return

        toast.error('Session expired!')
        // The cookie is already invalid server-side; drop cached data so a
        // stale client's rows cannot linger on screen after the redirect.
        queryClient.clear()
        const redirect = `${router.history.location.href}`
        router.navigate({ to: '/sign-in', search: { redirect } })
      }

      if (error.status === 500) {
        toast.error('Internal Server Error!')
        // Only navigate to the error page in production, so a 500 does not
        // interrupt HMR while working on the thing that caused it.
        if (import.meta.env.PROD) {
          router.navigate({ to: '/500' })
        }
      }
    },
  }),
})

// Create a new router instance
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FontProvider>
            <DirectionProvider>
              <RouterProvider router={router} />
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
