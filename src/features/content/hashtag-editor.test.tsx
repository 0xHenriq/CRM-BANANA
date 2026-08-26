import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { HashtagEditor } from './hashtag-editor'

/** Controlled component, so the test owns the state the way the dialog does. */
function Harness({ initial = [] as string[] }) {
  const [tags, setTags] = useState<string[]>(initial)
  return (
    <>
      <HashtagEditor value={tags} onChange={setTags} />
      <output data-testid='tags'>{tags.join(',')}</output>
    </>
  )
}

describe('HashtagEditor', () => {
  it('a pasted blob becomes separate chips, not one tag', async () => {
    const { getByRole, getByTestId } = await render(<Harness />)
    // How they arrive out of a caption: no spaces, all hashes.
    await userEvent.fill(getByRole('textbox'), '#one#two#three ')
    await expect.element(getByTestId('tags')).toHaveTextContent('one,two,three')
  })

  it('a space commits the tag being typed', async () => {
    const { getByRole, getByTestId } = await render(<Harness />)
    await userEvent.fill(getByRole('textbox'), 'LDN ')
    await expect.element(getByTestId('tags')).toHaveTextContent('LDN')
  })

  it('refuses a duplicate that differs only in case', async () => {
    const { getByRole, getByTestId } = await render(
      <Harness initial={['BananaDigital']} />
    )
    await userEvent.fill(getByRole('textbox'), 'bananadigital ')
    // The first spelling survives; the second is not appended.
    await expect.element(getByTestId('tags')).toHaveTextContent('BananaDigital')
    expect(
      (await getByTestId('tags').element()).textContent?.split(',').length
    ).toBe(1)
  })

  /**
   * She is served this over plain HTTP, where navigator.clipboard does not
   * exist. The button must still work, and must never throw.
   */
  it('copies without navigator.clipboard, as it must over plain HTTP', async () => {
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })
    try {
      const { getByRole } = await render(
        <Harness initial={['ldn', 'social']} />
      )
      await userEvent.click(getByRole('button', { name: /Copy/i }))
      // The assertion that matters is that this did not throw and the button
      // resolved to a definite outcome rather than staying on "Copy".
      await expect
        .element(getByRole('button', { name: /Copied|Press/i }))
        .toBeInTheDocument()
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        value: original,
        configurable: true,
      })
    }
  })

  it('a draft that yields no tags still clears the field', async () => {
    const { getByRole } = await render(<Harness />)
    const input = getByRole('textbox')
    // Punctuation-only: nothing to commit, but it must not be stranded there.
    await userEvent.fill(input, '!!')
    await userEvent.keyboard('{Enter}')
    await expect.element(input).toHaveValue('')
  })

  it('removes a chip by its own button', async () => {
    const { getByRole, getByTestId } = await render(
      <Harness initial={['keep', 'drop']} />
    )
    await userEvent.click(getByRole('button', { name: 'Remove #drop' }))
    await expect.element(getByTestId('tags')).toHaveTextContent('keep')
  })

  it('backspace on an empty field removes the last chip', async () => {
    const { getByRole, getByTestId } = await render(
      <Harness initial={['first', 'last']} />
    )
    await userEvent.click(getByRole('textbox'))
    await userEvent.keyboard('{Backspace}')
    await expect.element(getByTestId('tags')).toHaveTextContent('first')
  })

  /**
   * The count is the reason this is chips and not a textarea: thirty-one tags
   * in a text field look exactly like thirty, and Instagram rejects the post.
   */
  it('warns once past the limit and says how many are over', async () => {
    const many = Array.from({ length: 32 }, (_, i) => `tag${i}`)
    const { getByText } = await render(<Harness initial={many} />)
    await expect.element(getByText('32/30')).toBeInTheDocument()
    await expect
      .element(getByText(/2 in\s+red will be rejected/))
      .toBeInTheDocument()
  })

  it('stays quiet at exactly the limit', async () => {
    const exactly = Array.from({ length: 30 }, (_, i) => `tag${i}`)
    const { getByText, container } = await render(<Harness initial={exactly} />)
    await expect.element(getByText('30/30')).toBeInTheDocument()
    expect(container.textContent).not.toContain('will be rejected')
  })
})
