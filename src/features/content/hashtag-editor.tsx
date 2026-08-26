import { useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import {
  HASHTAG_LIMIT,
  normaliseHashtags,
  parseHashtagInput,
} from '@/lib/hashtags'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Hashtags, as chips rather than a second caption box.
 *
 * Sofia asked for descriptions and hashtags on a post. The description is the
 * caption, which already existed; the hashtags did not, and a plain text field
 * would have been the wrong answer even though it is what she types into.
 * Thirty tags in a textarea cannot be counted at a glance, cannot be removed
 * one at a time, and hide the duplicate that is silently costing a slot.
 *
 * So: she still types or pastes exactly as she would into Instagram, and it is
 * split into chips on the way in. Space, comma and Enter all commit, because
 * all three are how a person ends a tag.
 */
export function HashtagEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string[]
  onChange: (next: string[]) => void
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  const commit = (text: string) => {
    const additions = parseHashtagInput(text)
    if (additions.length === 0) return
    // Normalising the CONCATENATION is what dedupes against what is already
    // there — normalising the additions alone would happily add a second
    // "#LDN" next to "#ldn".
    onChange(normaliseHashtags([...value, ...additions]))
    setDraft('')
  }

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag))

  const copyAll = async () => {
    await navigator.clipboard.writeText(value.map((t) => `#${t}`).join(' '))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const over = value.length > HASHTAG_LIMIT

  if (readOnly) {
    if (value.length === 0) return null
    return (
      <div className='flex flex-wrap gap-1.5'>
        {value.map((tag) => (
          <span
            key={tag}
            className='rounded-full border border-bd-rule bg-bd-sand px-2 py-0.5 text-xs text-bd-ink'
          >
            #{tag}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className='grid gap-1.5'>
      <div className='flex items-center justify-between gap-2'>
        <Label htmlFor='cd-hashtags'>Hashtags</Label>
        <div className='flex items-center gap-2'>
          <span
            className={cn(
              'text-xs tabular-nums',
              over ? 'font-bold text-destructive' : 'text-muted-foreground'
            )}
          >
            {value.length}/{HASHTAG_LIMIT}
          </span>
          {value.length > 0 && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-6 px-2 text-xs'
              onClick={copyAll}
            >
              {copied ? (
                <Check className='size-3' />
              ) : (
                <Copy className='size-3' />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </div>
      </div>

      {value.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {value.map((tag, i) => (
            <span
              key={tag}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                // Everything past the thirtieth is what Instagram would drop,
                // so it is shown as the part that is over rather than the
                // whole list turning red and telling her nothing about which.
                i >= HASHTAG_LIMIT
                  ? 'border-destructive bg-destructive/10 text-destructive'
                  : 'border-bd-rule bg-bd-sand text-bd-ink'
              )}
            >
              #{tag}
              <button
                type='button'
                onClick={() => remove(tag)}
                aria-label={`Remove #${tag}`}
                className='opacity-60 hover:opacity-100'
              >
                <X className='size-3' />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        id='cd-hashtags'
        name='content-hashtags'
        value={draft}
        placeholder='Type or paste tags — space, comma or Enter to add'
        onChange={(e) => {
          const text = e.target.value
          // Any separator means at least one tag just ended, so the whole
          // field is parsed and the draft cleared — parseHashtagInput splits
          // on every separator, so "one two three" pasted at once becomes
          // three chips rather than one. Typing is the same path: the space
          // after "one" commits it and leaves the field empty for "two".
          if (/[\s,]/.test(text)) {
            commit(text)
          } else {
            setDraft(text)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && draft === '' && value.length) {
            // Backspace on an empty field removes the last chip — the
            // behaviour every tag input has, and its absence feels broken.
            remove(value[value.length - 1]!)
          }
        }}
        onBlur={() => commit(draft)}
      />

      {over && (
        <p className='text-xs text-destructive'>
          Instagram allows {HASHTAG_LIMIT}. The {value.length - HASHTAG_LIMIT}{' '}
          in red will be rejected.
        </p>
      )}
    </div>
  )
}
