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
   * `round` is a third prop on a component that already had two which once
   * silently contradicted each other — `markOnly` used to return before the
   * upload control rendered, so `markOnly` + `canEdit` gave a control that
   * could not be used. A new prop earns a test of the COMBINATION, not of
   * itself: round must change the shape and silence nothing.
   */
  it('round makes a circle and still allows the upload it is wrapped in', async () => {
    const { container } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Change of Perspective'
          logoKey={null}
          canEdit
          markOnly
          round
        />
      )
    )
    // The mark is a circle...
    expect(container.querySelector('.rounded-full')).not.toBeNull()
    expect(container.querySelector('.rounded-xl')).toBeNull()
    // ...and the file input is still there, which is the half that regressed
    // last time a prop short-circuited this component.
    expect(container.querySelector('input[type="file"]')).not.toBeNull()
  })

  it('defaults to the rounded square everywhere else', async () => {
    const { container } = await render(
      wrap(<ClientLogo clientId='c1' name='Acme Corp' logoKey={null} markOnly />)
    )
    expect(container.querySelector('.rounded-xl')).not.toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
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

  /**
   * markOnly used to return before the upload control was rendered, so passing
   * both markOnly and canEdit silently produced a logo that could not be
   * changed — which is exactly how it is used in the client page header.
   */
  it('a markOnly logo is still uploadable when canEdit is set', async () => {
    const { getByLabelText } = await render(
      wrap(
        <ClientLogo
          clientId='c1'
          name='Acme Corp'
          logoKey={null}
          canEdit
          markOnly
        />
      )
    )
    await expect
      .element(getByLabelText(/Upload Acme Corp's logo/i))
      .toBeInTheDocument()
  })

  it('shows no upload control when canEdit is not set', async () => {
    const { container } = await render(
      wrap(
        <ClientLogo clientId='c1' name='Acme Corp' logoKey={null} markOnly />
      )
    )
    expect(container.querySelector('input[type="file"]')).toBeNull()
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
