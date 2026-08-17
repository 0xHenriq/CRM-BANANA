import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { UserAuthForm } from './user-auth-form'

const FORM_MESSAGES = {
  emailEmpty: 'Please enter your email.',
  passwordEmpty: 'Please enter your password.',
} as const

const navigate = vi.fn()
const signInEmail = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/auth-client', () => ({
  signIn: {
    email: (...args: unknown[]) => signInEmail(...args),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    promise: vi.fn(),
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
  }
})

/**
 * Each test mounts its own form. Rendering once in beforeEach and again inside
 * a test leaves two forms in the DOM, and every locator then matches twice.
 */
async function renderForm(props: { redirectTo?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <UserAuthForm {...props} />
    </QueryClientProvider>
  )
  return {
    screen,
    email: screen.getByRole('textbox', { name: /^Email$/i }),
    password: screen.getByLabelText(/^Password$/i),
    submit: screen.getByRole('button', { name: /^Sign in$/i }),
  }
}

describe('UserAuthForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signInEmail.mockResolvedValue({ data: { user: {} }, error: null })
  })

  it('renders fields and submit button', async () => {
    const { email, password, submit } = await renderForm()
    await expect.element(email).toBeInTheDocument()
    await expect.element(password).toBeInTheDocument()
    await expect.element(submit).toBeInTheDocument()
  })

  it('shows validation messages when submitting empty form', async () => {
    const { screen, submit } = await renderForm()
    await userEvent.click(submit)

    await expect
      .element(screen.getByText(FORM_MESSAGES.emailEmpty))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(FORM_MESSAGES.passwordEmpty))
      .toBeInTheDocument()
    expect(signInEmail).not.toHaveBeenCalled()
  })

  it('signs in and navigates to the default route on success', async () => {
    const { email, password, submit } = await renderForm()
    await userEvent.fill(email, 'sophie@bananadigital.london')
    await userEvent.fill(password, 'bananacrate2026')
    await userEvent.click(submit)

    await vi.waitFor(() => expect(signInEmail).toHaveBeenCalledOnce())
    expect(signInEmail).toHaveBeenCalledWith({
      email: 'sophie@bananadigital.london',
      password: 'bananacrate2026',
    })
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    )
  })

  it('reports a generic failure and does not navigate on bad credentials', async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { message: 'User not found', status: 401 },
    })

    const { email, password, submit } = await renderForm()
    await userEvent.fill(email, 'nobody@example.com')
    await userEvent.fill(password, 'wrong-password')
    await userEvent.click(submit)

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    // The message must not distinguish "no such account" from "wrong
    // password", or the form becomes an account-enumeration oracle.
    expect(toastError).toHaveBeenCalledWith(
      'That email and password did not match.'
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it('navigates to redirectTo when provided', async () => {
    const { email, password, submit } = await renderForm({
      redirectTo: '/portal/calendar',
    })
    await userEvent.fill(email, 'a@b.com')
    await userEvent.fill(password, 'password123')
    await userEvent.click(submit)

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/portal/calendar',
        replace: true,
      })
    )
  })
})
