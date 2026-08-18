import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SearchProvider } from '@/context/search-provider'
import type { CurrentUser } from '@/hooks/use-current-user'

const COMMAND_MENU_PLACEHOLDER = 'Type a command or search...'

const STAFF: CurrentUser = {
  id: 'staff-1',
  email: 'sophie@bananadigital.london',
  name: 'Sophie',
  role: 'owner',
  isStaff: true,
}

const CLIENT: CurrentUser = {
  id: 'client-1',
  email: 'someone@acme.test',
  name: 'Acme Skincare',
  role: 'client',
  isStaff: false,
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setTheme: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({ setTheme: mocks.setTheme }),
}))

type ShortcutModifier = 'Control' | 'Meta'

/**
 * The palette reads the signed-in user to decide whether the staff-only groups
 * belong in it, so the query cache is seeded rather than the network mocked —
 * `useCurrentUser` holds ['me'] fresh for a minute, so a seeded entry means no
 * request is made at all.
 */
async function renderWithSearchProvider(user: CurrentUser | null = STAFF) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(['me'], user)
  return await render(
    <QueryClientProvider client={queryClient}>
      <SearchProvider>{null}</SearchProvider>
    </QueryClientProvider>
  )
}

/**
 * Open the palette by shortcut, retrying while the keydown listener may not be mounted yet.
 * Waits between attempts so a successful toggle is not immediately undone by a second chord.
 */
async function openCommandPalette(
  screen: RenderResult,
  modifier: ShortcutModifier = 'Control'
) {
  await vi.waitFor(
    async () => {
      const isCommandPaletteOpen =
        document.querySelector(
          `[placeholder="${COMMAND_MENU_PLACEHOLDER}"]`
        ) !== null

      if (!isCommandPaletteOpen) {
        await userEvent.keyboard(`{${modifier}>}k{/${modifier}}`)
      }

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    },
    { interval: 50, timeout: 5000 }
  )
}

describe('SearchProvider and CommandMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the command palette when the palette is open', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByText } = screen

    await openCommandPalette(screen)

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toBeInTheDocument()
    await expect.element(getByText('Theme')).toBeInTheDocument()
    await expect.element(getByText('Light')).toBeInTheDocument()
    await expect.element(getByText('Dark')).toBeInTheDocument()
    await expect.element(getByText('System')).toBeInTheDocument()
    await expect.element(getByText('Dashboard')).toBeInTheDocument()
  })

  it('does not show the dialog content when search is closed', async () => {
    const { getByPlaceholder } = await renderWithSearchProvider()

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it.each([
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
  ] as const)(
    'opens the command menu when %s + K is pressed',
    async (_label, modifier) => {
      const screen = await renderWithSearchProvider()

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .not.toBeInTheDocument()

      await openCommandPalette(screen, modifier)

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    }
  )

  it('navigates to a top-level route and closes the palette when a nav item is selected', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('Clients'))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/clients' })
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('navigates for nested sidebar items (group with sub-items)', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByRole } = screen

    await openCommandPalette(screen)

    await userEvent.click(getByRole('option', { name: 'Settings Account' }))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/account' })
    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('applies theme and closes the palette when a theme command is chosen', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('Dark'))

    expect(mocks.setTheme).toHaveBeenCalledWith('dark')
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  /**
   * The sidebar filters staffOnly groups; this palette did not, and ⌘K opens it
   * for every authenticated session — so a client saw an "Agency" group listing
   * Dashboard, Clients and Pipeline. The routes were still guarded, so the leak
   * was the framing rather than the data, which is exactly what
   * `requireStaffRoute` exists to prevent.
   */
  it('hides the agency group from a client-role session', async () => {
    const screen = await renderWithSearchProvider(CLIENT)

    await openCommandPalette(screen)

    await expect.element(screen.getByText('Agency')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Dashboard')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Clients')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Pipeline')).not.toBeInTheDocument()

    // Their own workspace is still there — this hides a group, not the palette.
    await expect.element(screen.getByText('Homepage')).toBeInTheDocument()
  })

  it('hides it while the session is still resolving, rather than flashing it', async () => {
    // `useCurrentUser` returns null until /api/me answers. Defaulting to
    // "staff" for that window would show a client the agency entries for as
    // long as the request took.
    const screen = await renderWithSearchProvider(null)

    await openCommandPalette(screen)

    await expect.element(screen.getByText('Agency')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Homepage')).toBeInTheDocument()
  })

  it('shows empty state when the filter matches nothing', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.fill(
      screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER),
      'zzzz-no-match-xxxx'
    )

    await expect
      .element(screen.getByText('No results found.'))
      .toBeInTheDocument()
  })
})
