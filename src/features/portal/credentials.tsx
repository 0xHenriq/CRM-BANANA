import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Eye, EyeOff, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, type ClientCredential } from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { QueryError } from '@/components/layout/query-error'

/**
 * The password hub.
 *
 * Sofia: "can we put a section for password hub - client can fill in social
 * media passwords". The agency cannot post to a client's Instagram without the
 * login, so the credential already exists somewhere — and today that somewhere
 * is a WhatsApp message, sitting in two phone backups, searchable by anyone
 * who picks up either handset. This is not competing with a password manager
 * nobody has installed; it is competing with that.
 *
 * What it does about it:
 *
 *  - The password is encrypted before it reaches Postgres, so the nightly dump
 *    this repo's runbook tells you to copy onto a laptop contains none of them.
 *  - It is never in a list response. Seeing one is a separate request that
 *    writes an audit row naming who looked.
 *  - The row says "Saved" rather than showing dots of the right length: a
 *    masked field that matches the real length tells anyone standing behind
 *    her how long the password is.
 *
 * The SAME component on both sides. She fills these in for a client who cannot
 * be bothered; the client fills them in themselves; either way it is one list
 * and one set of rules, rather than her copy drifting from theirs.
 */
export function CredentialsHub({
  clientId,
  className,
}: {
  clientId: string
  className?: string
}) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ label: '', username: '', secret: '' })
  /**
   * Which login is one click from being destroyed.
   *
   * Deleting one is not like deleting a link or a file: once the client has
   * typed a password in here this row may be the ONLY copy, there is no
   * archive, no undo and nothing else in the product holds it. A bin icon that
   * acts immediately is out of step with a codebase that puts a named
   * confirmation on archiving a client — and this control is on the client's
   * own phone, where a stray tap is likelier than it is on her laptop.
   */
  const [confirmRemove, setConfirmRemove] = useState<ClientCredential | null>(
    null
  )

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['credentials', clientId],
    queryFn: () =>
      api.get<{
        clientId: string
        configured: boolean
        credentials: ClientCredential[]
      }>(`/portal/credentials?client=${clientId}`),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['credentials', clientId] })

  const add = useMutation({
    mutationFn: () =>
      api.post(`/portal/credentials?client=${clientId}`, {
        label: form.label.trim(),
        username: form.username.trim() || null,
        secret: form.secret || null,
      }),
    onSuccess: async () => {
      await invalidate()
      setAdding(false)
      setForm({ label: '', username: '', secret: '' })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/credentials/${id}`),
    onSuccess: async () => {
      await invalidate()
      setConfirmRemove(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card className={cn('crate-card', className)}>
      <CardContent className='py-4'>
        <div className='mb-3 flex items-center gap-2'>
          <span className='flex size-6 items-center justify-center rounded-full border-[1.5px] border-bd-ink bg-bd-yellow'>
            <KeyRound className='size-3.5 text-bd-ink' />
          </span>
          <h2 className='display text-lg'>Password hub</h2>
          {data && data.credentials.length > 0 && (
            <span className='text-xs text-muted-foreground'>
              {data.credentials.length}{' '}
              {data.credentials.length === 1 ? 'account' : 'accounts'}
            </span>
          )}
        </div>
        <div className='mb-3 crate-rule' />

        {/* Error before empty — "no logins saved" over a failed request is a
            statement about their own workspace that is not true. */}
        {isError ? (
          <QueryError
            title='Could not load the password hub'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : isPending ? (
          <Skeleton className='h-20' />
        ) : (
          <>
            {/*
              Said before anything is typed, not after it is refused.
              
              Without the key on the server nothing can be stored, and finding
              that out by filling in a password and getting an error is the
              worst order to learn it in.
            */}
            {!data.configured && (
              <p className='mb-3 rounded-md border-[1.5px] border-dashed border-pay-overdue px-3 py-2 text-xs'>
                Passwords cannot be saved yet — the server needs its encryption
                key set up first. Handles and notes still work.
              </p>
            )}

            {data.credentials.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                Nothing saved yet. Add the accounts we post from — the login
                goes in encrypted, and it is not in any backup or email.
              </p>
            ) : (
              <ul className='divide-y divide-bd-rule-soft'>
                {data.credentials.map((credential) => (
                  <li key={credential.id}>
                    <CredentialRow
                      credential={credential}
                      canReveal={data.configured}
                      onRemove={() => setConfirmRemove(credential)}
                      removing={
                        remove.isPending && remove.variables === credential.id
                      }
                      onSaved={invalidate}
                    />
                  </li>
                ))}
              </ul>
            )}

            {adding ? (
              <form
                className='mt-3 grid gap-2 rounded-md border-[1.5px] border-dashed border-bd-rule p-3 sm:grid-cols-3'
                onSubmit={(e) => {
                  e.preventDefault()
                  if (form.label.trim()) add.mutate()
                }}
              >
                <div className='grid gap-1.5'>
                  <Label htmlFor='cred-label'>Account</Label>
                  <Input
                    id='cred-label'
                    autoFocus
                    className='h-8'
                    placeholder='Instagram'
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='cred-username'>Handle or email</Label>
                  <Input
                    id='cred-username'
                    className='h-8'
                    placeholder='@theirhandle'
                    value={form.username}
                    onChange={(e) =>
                      setForm({ ...form, username: e.target.value })
                    }
                  />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='cred-secret'>Password</Label>
                  {/*
                    type=password, so it is not shoulder-readable while it is
                    typed and no password manager offers to save it into the
                    wrong site. autoComplete off for the same reason.
                  */}
                  <Input
                    id='cred-secret'
                    type='password'
                    autoComplete='off'
                    className='h-8'
                    disabled={!data.configured}
                    value={form.secret}
                    onChange={(e) =>
                      setForm({ ...form, secret: e.target.value })
                    }
                  />
                </div>
                <div className='flex gap-2 sm:col-span-3'>
                  <Button
                    size='sm'
                    disabled={!form.label.trim() || add.isPending}
                  >
                    {add.isPending && <Loader2 className='animate-spin' />}
                    Save
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={() => {
                      setAdding(false)
                      setForm({ label: '', username: '', secret: '' })
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='mt-3 h-7 px-2 text-xs'
                onClick={() => setAdding(true)}
              >
                <Plus className='size-3' />
                Add an account
              </Button>
            )}

            <p className='mt-3 text-xs text-muted-foreground'>
              Stored encrypted. Nobody can read one without opening it here, and
              every time somebody does it is recorded.
            </p>
          </>
        )}
      </CardContent>

      {/*
        Named, and it says what is actually lost.

        "Are you sure?" over a bin icon teaches people to click through. This
        one names the account and states the part that matters — the password
        cannot be recovered from anywhere, because the whole point of the hub
        is that nothing else holds it.
      */}
      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null)
        }}
        destructive
        title={`Remove ${confirmRemove?.label ?? 'this account'}?`}
        desc={
          confirmRemove?.hasSecret ? (
            <>
              The password saved for{' '}
              <strong>{confirmRemove.label}</strong> is deleted with it and{' '}
              <strong>cannot be recovered</strong> — nothing else in here holds
              a copy, and it is not in any backup you can read.
            </>
          ) : (
            <>
              This removes <strong>{confirmRemove?.label}</strong> from the hub.
              No password is saved against it, so there is nothing to lose.
            </>
          )
        }
        confirmText='Remove'
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (confirmRemove) remove.mutate(confirmRemove.id)
        }}
      />
    </Card>
  )
}

/**
 * One saved login.
 *
 * Editing is inline and on blur, like the client name field on her client
 * page — but the password is deliberately NOT edited that way. It has its own
 * explicit Save, because a field that writes on blur cannot tell "I changed
 * it" apart from "I tabbed through it", and for a password that is the
 * difference between a correction and silently destroying the only copy.
 */
function CredentialRow({
  credential,
  canReveal,
  onRemove,
  removing,
  onSaved,
}: {
  credential: ClientCredential
  canReveal: boolean
  onRemove: () => void
  removing: boolean
  onSaved: () => Promise<unknown>
}) {
  const [shown, setShown] = useState<string | null>(null)
  const [editingSecret, setEditingSecret] = useState(false)
  const [draft, setDraft] = useState('')

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/portal/credentials/${credential.id}`, body),
    onSuccess: onSaved,
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * Fetch the plaintext. It does NOT decide what happens to it.
   *
   * `onSuccess: setShown(...)` was the obvious place to put that and it was
   * wrong: the Copy button below calls this same mutation with `mutateAsync`,
   * so copying a password ALSO printed it on the screen — the exact thing the
   * comment on that button says it avoids. Two callers want the same request
   * and different outcomes, so the outcome belongs to the caller.
   */
  const reveal = useMutation({
    mutationFn: () =>
      api.post<{ secret: string | null }>(
        `/portal/credentials/${credential.id}/reveal`,
        {}
      ),
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className='flex flex-wrap items-center gap-2 py-2.5'>
      <Input
        aria-label={`Account name for ${credential.label}`}
        className='h-8 w-32 font-semibold'
        defaultValue={credential.label}
        key={`label-${credential.id}-${credential.updatedAt}`}
        onBlur={(e) => {
          const next = e.target.value.trim()
          if (next && next !== credential.label) patch.mutate({ label: next })
        }}
      />
      <Input
        aria-label={`Handle for ${credential.label}`}
        className='h-8 min-w-36 flex-1'
        placeholder='Handle or email'
        defaultValue={credential.username ?? ''}
        key={`user-${credential.id}-${credential.updatedAt}`}
        onBlur={(e) => {
          const next = e.target.value.trim()
          if (next !== (credential.username ?? '')) {
            patch.mutate({ username: next || null })
          }
        }}
      />

      {editingSecret ? (
        <form
          className='flex items-center gap-1.5'
          onSubmit={(e) => {
            e.preventDefault()
            patch.mutate({ secret: draft || null })
            setEditingSecret(false)
            setShown(null)
            setDraft('')
          }}
        >
          <Input
            autoFocus
            type='password'
            autoComplete='off'
            aria-label={`New password for ${credential.label}`}
            className='h-8 w-40'
            placeholder='New password'
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button size='sm' className='h-8'>
            Save
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-8'
            onClick={() => {
              setEditingSecret(false)
              setDraft('')
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className='flex items-center gap-1.5'>
          {shown === null ? (
            <span className='w-24 text-xs text-muted-foreground'>
              {credential.hasSecret ? 'Password saved' : 'No password'}
            </span>
          ) : (
            /* Wraps rather than truncating. A password shown as
               "c0rrect-horse-batt…" is a password you still cannot use, and
               the whole point of the eye is to read it out to somebody. */
            <code className='max-w-64 rounded bg-bd-sand px-2 py-1 font-mono text-xs break-all'>
              {shown || '—'}
            </code>
          )}

          {credential.hasSecret && (
            <>
              <Button
                size='icon'
                variant='ghost'
                className='size-7'
                disabled={!canReveal || reveal.isPending}
                aria-label={
                  shown === null
                    ? `Show the password for ${credential.label}`
                    : `Hide the password for ${credential.label}`
                }
                onClick={async () => {
                  if (shown !== null) {
                    setShown(null)
                    return
                  }
                  const result = await reveal.mutateAsync().catch(() => null)
                  if (result) setShown(result.secret ?? '')
                }}
              >
                {reveal.isPending ? (
                  <Loader2 className='size-3.5 animate-spin' />
                ) : shown === null ? (
                  <Eye className='size-3.5' />
                ) : (
                  <EyeOff className='size-3.5' />
                )}
              </Button>
              <Button
                size='icon'
                variant='ghost'
                className='size-7'
                disabled={!canReveal}
                aria-label={`Copy the password for ${credential.label}`}
                onClick={async () => {
                  /*
                    Fetched rather than read off the screen, so copying works
                    without revealing first — the common case is pasting it
                    into the app she is logging into, and putting the password
                    on screen to get it into the clipboard is a step backwards.

                    copyText, never navigator.clipboard directly: it reports
                    whether the text actually landed. A copy button that
                    silently does nothing is the failure that rule exists for.
                  */
                  // Deliberately does not touch `shown`: the point of Copy is
                  // to get it into the clipboard WITHOUT putting it on screen.
                  const result = await reveal.mutateAsync().catch(() => null)
                  // A rejected request already toasted through the mutation's
                  // own onError, so there is nothing more to say here.
                  if (!result?.secret) return
                  const ok = await copyText(result.secret)
                  toast[ok ? 'success' : 'error'](
                    ok
                      ? `${credential.label} password copied.`
                      : 'The copy failed — open it with the eye instead.'
                  )
                }}
              >
                <Copy className='size-3.5' />
              </Button>
            </>
          )}

          <Button
            size='sm'
            variant='outline'
            className='h-7 px-2 text-xs'
            disabled={!canReveal}
            onClick={() => setEditingSecret(true)}
          >
            {credential.hasSecret ? 'Change' : 'Set'}
          </Button>
        </div>
      )}

      <Button
        size='icon'
        variant='ghost'
        className='size-7'
        aria-label={`Remove ${credential.label}`}
        disabled={removing}
        onClick={onRemove}
      >
        {removing ? (
          <Loader2 className='size-3.5 animate-spin' />
        ) : (
          <Trash2 className='size-3.5 text-destructive' />
        )}
      </Button>
    </div>
  )
}
