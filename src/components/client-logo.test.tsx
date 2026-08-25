import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { logoUrl } from '@/lib/api'
import { ClientLogo } from './client-logo'

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('ClientLogo', () => {
  it('initials come from the first and last word', async () => {
    const { getByText } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Change of Perspective'
          logoKey={null}
          markOnly
        />
      )
    )
    // CP, not CH — a person abbreviating this would skip "of".
    await expect.element(getByText('CP')).toBeInTheDocument()
  })

  it('a single-word name falls back to its first two letters', async () => {
    const { getByText } = await render(
      wrap(<ClientLogo clientId='c1' name='Verdant' logoKey={null} markOnly />)
    )
    await expect.element(getByText('VE')).toBeInTheDocument()
  })

  it('renders the image when a logo exists, not the initials', async () => {
    const { getByRole, container } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Acme Corp'
          logoKey='c1/abc.webp'
          markOnly
        />
      )
    )
    await expect
      .element(getByRole('img', { name: 'Acme Corp logo' }))
      .toBeInTheDocument()
    expect(container.textContent).not.toContain('AC')
  })

  /**
   * Her palette runs bright, and white initials on a bright colour cannot be
   * read.
   *
   * Bright GREEN is the case that matters, not yellow: yellow is called light
   * by a naive channel average too, so it proves nothing. #00c800 averages to
   * 0.26 — the naive formula picks white and makes it unreadable — while
   * perceived luminance puts it at 0.53 and picks black. Green is where the
   * two formulas actually disagree, so green is what this asserts.
   */
  it('picks dark text on a light brand colour and white on a dark one', async () => {
    const { getByText: light } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Green Brand'
          logoKey={null}
          brandColor='#00c800'
          markOnly
        />
      )
    )
    const onGreen = await light('GB').element()
    expect(getComputedStyle(onGreen).color).toBe('rgb(17, 17, 17)')

    const { getByText: dark } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Navy Brand'
          logoKey={null}
          brandColor='#101c3a'
          markOnly
        />
      )
    )
    const onNavy = await dark('NB').element()
    expect(getComputedStyle(onNavy).color).toBe('rgb(255, 255, 255)')
  })

  it('the logo url carries a cache-buster so a replacement is visible', () => {
    const a = logoUrl('c1', 'c1/one.webp')
    const b = logoUrl('c1', 'c1/two.webp')
    expect(a).not.toBe(b)
    expect(a).toContain('/api/media/clients/c1/logo')
    // The key itself must not leak into the path — the server looks it up.
    expect(a.split('?')[0]).toBe('/api/media/clients/c1/logo')
  })
})
