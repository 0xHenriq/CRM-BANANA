import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Mail, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  formatShortDate,
  localDayOf,
  type ClientSummary,
} from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { QueryError } from '@/components/layout/query-error'
import { ContentSection } from '../components/content-section'

type Seats = {
  seats: { used: number; total: number; remaining: number }
  members: {
    memberId: string
    userId: string
    role: string
    email: string
    name: string
    joinedAt: string
    isStaff: boolean
  }[]
  pending: {
    id: string
    email: string
    role: string
    status: string
    expiresAt: string
  }[]
}

/**
 * Who can get in, and how many more can.
 *
 * `POST /api/seats/invite` has existed since the beginning and nothing in the
 * browser called it — the only way to add a colleague or give a client a login
 * was to POST it by hand. This is that screen.
 *
 * Staff-only, guarded on the route. The rest of Settings is deliberately left
 * open to clients, because a profile and a colour theme are theirs to change;
 * this one is the agency's.
 */
export function SettingsSeats() {
  const queryClient = useQueryClient()
  const [confirmRemove, setConfirmRemove] = useState<
    Seats['members'][number] | null
  >(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['seats'],
    queryFn: () => api.get<Seats>('/seats'),
  })

  const cancelInvite = useMutation({
    mutationFn: (id: string) => api.post(`/seats/invitations/${id}/cancel`, {}),
    onSuccess: async () => {
      toast.success('Invitation revoked. The seat is free again.')
      await queryClient.invalidateQueries({ queryKey: ['seats'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const removeMember = useMutation({
    mutationFn: (memberId: string) =>
      api.del<{ workspacesRevoked: number }>(`/seats/members/${memberId}`),
    onSuccess: async (result) => {
      setConfirmRemove(null)
      toast.success(
        result.workspacesRevoked
          ? `Seat removed, and access to ${result.workspacesRevoked} workspace${result.workspacesRevoked === 1 ? '' : 's'} with it.`
          : 'Seat removed.'
      )
      await queryClient.invalidateQueries({ queryKey: ['seats'] })
      // Their access rows are gone, so the client page's seat list is stale.
      await queryClient.invalidateQueries({ queryKey: ['client'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <ContentSection
      title='Seats'
      desc='Who can sign in, and how many places are left.'
    >
      <>
        {isLoading ? (
          <div className='space-y-3'>
            <Skeleton className='h-10' />
            <Skeleton className='h-24' />
          </div>
        ) : isError || !data ? (
          /* Before the empty state, never after it. */
          <QueryError
            title='Could not load your seats'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : (
          <div className='space-y-6'>
            <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3'>
              <div>
                <p className='text-sm font-semibold'>
                  {data.seats.used} of {data.seats.total} seats in use
                </p>
                <p className='text-xs text-muted-foreground'>
                  {/* Say the rule rather than only the number: a pending
                      invitation holding a seat is the surprising half, and it
                      is what the 409 on invite is about. */}
                  Pending invitations hold a seat until they are accepted or
                  revoked.
                </p>
              </div>
              <InviteDialog
                remaining={data.seats.remaining}
                total={data.seats.total}
              />
            </div>

            <section className='space-y-2'>
              <h4 className='text-sm font-semibold'>
                Signed up ({data.members.length})
              </h4>
              {data.members.length === 0 ? (
                <p className='text-sm text-muted-foreground'>Nobody yet.</p>
              ) : (
                <ul className='divide-y divide-bd-rule-soft'>
                  {data.members.map((m) => (
                    <li
                      key={m.memberId}
                      className='flex items-center gap-3 py-2.5'
                    >
                      <div className='min-w-0 flex-1'>
                        <p className='truncate text-sm font-semibold'>
                          {m.name || m.email}
                        </p>
                        <p className='truncate text-xs text-muted-foreground'>
                          {m.email}
                        </p>
                      </div>
                      <RolePill role={m.role} isStaff={m.isStaff} />
                      <Button
                        size='icon'
                        variant='ghost'
                        className='size-7'
                        aria-label={`Remove ${m.email}`}
                        onClick={() => setConfirmRemove(m)}
                      >
                        <Trash2 className='size-3.5' />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className='space-y-2'>
              <h4 className='text-sm font-semibold'>
                Invited, not yet accepted ({data.pending.length})
              </h4>
              {data.pending.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  No invitations outstanding.
                </p>
              ) : (
                <ul className='divide-y divide-bd-rule-soft'>
                  {data.pending.map((p) => (
                    <li key={p.id} className='flex items-center gap-3 py-2.5'>
                      <Mail className='size-4 shrink-0 text-muted-foreground' />
                      <div className='min-w-0 flex-1'>
                        <p className='truncate text-sm font-semibold'>
                          {p.email}
                        </p>
                        <p className='truncate text-xs text-muted-foreground'>
                          {/* formatShortDate, not toLocaleDateString: en-GB
                              renders September as "Sept" and the rest of this
                              product renders it "Sep". One product, one
                              spelling of a month. */}
                          Expires {formatShortDate(localDayOf(p.expiresAt))}
                        </p>
                      </div>
                      <RolePill role={p.role} isStaff={p.role !== 'client'} />
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={cancelInvite.isPending}
                        onClick={() => cancelInvite.mutate(p.id)}
                      >
                        {cancelInvite.isPending &&
                        cancelInvite.variables === p.id ? (
                          <Loader2 className='animate-spin' />
                        ) : null}
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <ConfirmDialog
          open={!!confirmRemove}
          onOpenChange={(open) => !open && setConfirmRemove(null)}
          title={`Remove ${confirmRemove?.email}?`}
          desc={
            <>
              They lose their seat immediately, and{' '}
              <strong>every workspace they could see closes with it</strong>.
              Their sign-in still exists but there will be nothing behind it.
              <br />
              <br />
              Nothing they uploaded or approved is deleted.
            </>
          }
          confirmText='Remove seat'
          destructive
          isLoading={removeMember.isPending}
          handleConfirm={() =>
            confirmRemove && removeMember.mutate(confirmRemove.memberId)
          }
        />
      </>
    </ContentSection>
  )
}

function RolePill({ role, isStaff }: { role: string; isStaff: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border-[1.5px] border-bd-ink px-2 py-0.5',
        'text-[0.6875rem] font-bold whitespace-nowrap text-bd-ink',
        isStaff ? 'bg-bd-yellow' : 'bg-bd-sand'
      )}
    >
      {/* "owner" comes off the member row lowercase; "Client" is ours. Two
          capitalisations side by side in one list looks like a bug. */}
      {isStaff ? role.charAt(0).toUpperCase() + role.slice(1) : 'Client'}
    </span>
  )
}

/**
 * Invite someone, and get a link to send them yourself.
 *
 * The button says "Copy invite link" and not "Send invitation", because there
 * is no mail sending anywhere in this product. A button that appears to email
 * someone and quietly does not is the worst of the three options — she would
 * wait for a reply that was never going to come.
 */
function InviteDialog({
  remaining,
  total,
}: {
  remaining: number
  total: number
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('client')
  const [clientIds, setClientIds] = useState<string[]>([])
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: ClientSummary[] }>('/clients'),
    enabled: open && role === 'client',
  })

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ inviteUrl: string }>('/seats/invite', {
        email: email.trim(),
        role,
        clientIds: role === 'client' ? clientIds : [],
      }),
    onSuccess: async (result) => {
      // The dialog stays open and switches to showing the link. Closing on
      // success would be the usual thing and would throw away the one piece of
      // information the whole flow exists to produce.
      setInviteUrl(result.inviteUrl)
      await queryClient.invalidateQueries({ queryKey: ['seats'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const reset = () => {
    setEmail('')
    setRole('client')
    setClientIds([])
    setInviteUrl(null)
    invite.reset()
  }

  const canSubmit =
    email.trim().length > 0 &&
    (role !== 'client' || clientIds.length > 0) &&
    !invite.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' disabled={remaining <= 0}>
          <UserPlus />
          {remaining > 0 ? 'Invite someone' : `All ${total} seats taken`}
        </Button>
      </DialogTrigger>
      <DialogContent className='crate-card sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>Invite someone</DialogTitle>
          <DialogDescription>
            {inviteUrl
              ? 'Send them this link yourself — there is no email delivery yet.'
              : `${remaining} seat${remaining === 1 ? '' : 's'} left.`}
          </DialogDescription>
        </DialogHeader>

        {inviteUrl ? (
          <div className='space-y-3'>
            <Input readOnly value={inviteUrl} className='font-mono text-xs' />
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                onClick={async () => {
                  // copyText, never navigator.clipboard: this is served over
                  // plain HTTP, where the modern API is undefined.
                  const ok = await copyText(inviteUrl)
                  toast[ok ? 'success' : 'error'](
                    ok
                      ? 'Link copied. Send it to them however you like.'
                      : 'Could not copy — select the link and copy it by hand.'
                  )
                }}
              >
                Copy invite link
              </Button>
              <Button size='sm' variant='outline' onClick={reset}>
                Invite someone else
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>
              The seat is held from now until they accept or you revoke it.
            </p>
          </div>
        ) : (
          <div className='space-y-4'>
            <div className='grid gap-1.5'>
              <Label htmlFor='invite-email'>Email</Label>
              <Input
                id='invite-email'
                type='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder='them@example.com'
              />
            </div>

            <div className='grid gap-1.5'>
              <Label>They are</Label>
              <Select
                value={role}
                onValueChange={(v) => {
                  setRole(v)
                  if (v !== 'client') setClientIds([])
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='client'>
                    A client — sees only their own workspace
                  </SelectItem>
                  <SelectItem value='member'>
                    Agency staff — can see every client
                  </SelectItem>
                  <SelectItem value='admin'>
                    Agency admin — staff, plus managing seats
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {role === 'client' && (
              <div className='grid gap-1.5'>
                <Label>Which workspaces</Label>
                {/* Required, and the server refuses without it: a client seat
                    with no workspace signs in to nothing. */}
                <div className='max-h-44 space-y-1.5 overflow-y-auto rounded-md border border-border p-2.5'>
                  {clients.isLoading ? (
                    <Skeleton className='h-16' />
                  ) : clients.isError ? (
                    <p className='text-sm text-destructive'>
                      Could not load your clients.
                    </p>
                  ) : (
                    (clients.data?.clients ?? []).map((cl) => (
                      <label
                        key={cl.id}
                        className='flex items-center gap-2 text-sm'
                      >
                        <Checkbox
                          checked={clientIds.includes(cl.id)}
                          onCheckedChange={(checked) =>
                            setClientIds((prev) =>
                              checked
                                ? [...prev, cl.id]
                                : prev.filter((id) => id !== cl.id)
                            )
                          }
                        />
                        {cl.name}
                      </label>
                    ))
                  )}
                </div>
                {clientIds.length === 0 && (
                  <p className='text-xs text-muted-foreground'>
                    Pick at least one, or they sign in to an empty portal.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {!inviteUrl && (
          <DialogFooter>
            <Button
              onClick={() => invite.mutate()}
              disabled={!canSubmit}
            >
              {invite.isPending && <Loader2 className='animate-spin' />}
              Create invitation
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
