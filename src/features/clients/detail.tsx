import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import {
  ArrowLeft,
  Mail,
  Phone,
  Plus,
  Star,
  Trash2,
  MessageSquare,
  ArrowRightLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  formatMoney,
  type ClientDetail,
  type ClientStatus,
  type PortalWorkspace,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { MoodboardPreview } from '@/features/content/moodboard-preview'
import { NextSteps } from '@/features/content/review-queue'
import { InvoicesPanel } from '@/features/invoices/panel'
import { LinkStack } from '@/features/portal/link-stack'
import { FileFolder, TaskList } from '@/features/portal/panels'
import { useWorkspace } from '@/features/portal/use-workspace'
import {
  ClientStatusPill,
  DealStagePill,
  PaymentBadge,
  CLIENT_LABEL,
} from './status-pill'

const STATUSES: ClientStatus[] = [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
]

export function ClientDetailPage() {
  const { clientId } = useParams({ from: '/_authenticated/clients_/$clientId' })
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => api.get<ClientDetail>(`/clients/${clientId}`),
  })

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/clients/${clientId}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // A failed query previously left `data` undefined and `isLoading` false,
  // so this component rendered skeletons forever — verified against a
  // non-existent client id. An error needs its own branch and a way out.
  if (isError || (!isLoading && !data)) {
    return (
      <>
        <Header>
          <div className='ms-auto flex items-center gap-2'>
            <ThemeSwitch />
            <ProfileDropdown />
          </div>
        </Header>
        <Main>
          {/* Only claim "not found" when the server actually said 404 — a
              network failure or a 500 is a different problem, and telling her
              the client does not exist would send her looking for the wrong
              thing. */}
          <PageHead
            eyebrow='Client account'
            title={
              error instanceof ApiError && error.status === 404
                ? 'Not found'
                : 'Unavailable'
            }
          />
          <QueryError
            title={
              error instanceof ApiError && error.status === 404
                ? 'That client does not exist, or you no longer have access.'
                : 'Could not load this client'
            }
            error={error as Error}
            onRetry={() => refetch()}
          />
          <div className='mt-4'>
            <Button variant='outline' asChild>
              <Link to='/clients'>
                <ArrowLeft />
                Back to clients
              </Link>
            </Button>
          </div>
        </Main>
      </>
    )
  }

  if (isLoading || !data) {
    return (
      <>
        <Header>
          <div className='ms-auto flex items-center gap-2'>
            <ThemeSwitch />
            <ProfileDropdown />
          </div>
        </Header>
        <Main>
          <Skeleton className='mb-6 h-20' />
          <Skeleton className='h-64' />
        </Main>
      </>
    )
  }

  const { client, contacts, deals, timeline, seats } = data

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <PageHead
          eyebrow='Client account'
          title={client.name}
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
          actions={
            <div className='flex items-center gap-3'>
              <Button variant='outline' size='sm' asChild>
                <Link to='/clients'>
                  <ArrowLeft />
                  Clients
                </Link>
              </Button>
              <ClientStatusPill status={client.status} />
            </div>
          }
        />

        {/*
          This client's next actions, before anything else on the page.

          Sofia asked for "waiting on clients" to be individual to each client:
          the dashboard list answers "what is outstanding everywhere", which is
          the wrong question once she has opened one client's page. Same
          component and same endpoint as the dashboard, narrowed by id, so the
          two cannot disagree about what counts as a step.
        */}
        <NextSteps variant='agency' clientId={clientId} />

        {/*
          The workspace, on the agency's own client page.
          
          She asked to see "the same kind of info as the homepage" here, and she
          was right to: the client page held the CRM half — status, deals,
          contacts — while the links, files, to-dos and moodboard she actually
          works in lived on a different screen behind a workspace switcher. Two
          screens about one client, neither of which showed the whole of it.

          The very same components as the portal homepage, so the two cannot
          drift into showing different things or behaving differently. They read
          ['portal', clientId], which is the key the panels invalidate, so an
          edit made here refreshes there and the other way round.
        */}
        {client.portalEnabled ? (
          <ClientWorkspace clientId={clientId} />
        ) : (
          /*
            Say why rather than showing nothing. A client at proposal or paused
            has no seeded workspace at all, so the panels would be four empty
            boxes — but silently omitting them reads as a missing feature. The
            toggle that fixes it is a few lines further down this same page.
          */
          <Card className='mb-5 crate-card border-dashed'>
            <CardContent className='py-4 text-sm text-muted-foreground'>
              <strong>{client.name}</strong> has no workspace yet. Turn on{' '}
              <strong>Client portal</strong> below to create their link stack,
              file folder and onboarding to-do&rsquo;s.
            </CardContent>
          </Card>
        )}

        <div className='grid gap-5 lg:grid-cols-3'>
          <div className='space-y-5 lg:col-span-2'>
            <Card className='crate-card'>
              <CardHeader>
                <CardTitle className='pb-2 display text-lg crate-rule'>
                  Account
                </CardTitle>
              </CardHeader>
              <CardContent className='grid gap-4 sm:grid-cols-2'>
                <div className='grid gap-1.5'>
                  <Label>Status</Label>
                  <Select
                    value={client.status}
                    onValueChange={(v) => patch.mutate({ status: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {CLIENT_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className='grid gap-1.5'>
                  <Label htmlFor='portal-toggle'>Client portal</Label>
                  <div className='flex h-9 items-center gap-2.5'>
                    <Switch
                      id='portal-toggle'
                      checked={client.portalEnabled}
                      onCheckedChange={(v) =>
                        patch.mutate({ portalEnabled: v })
                      }
                    />
                    <span className='text-sm text-muted-foreground'>
                      {client.portalEnabled
                        ? `${seats.length} seat${seats.length === 1 ? '' : 's'} with access`
                        : 'Closed'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* What this client owes, on the page about this client. */}
            <InvoicesPanel clientId={clientId} canEdit />

            <ContactsCard clientId={clientId} contacts={contacts} />

            <Card className='crate-card'>
              <CardHeader>
                <CardTitle className='pb-2 display text-lg crate-rule'>
                  Deals
                </CardTitle>
              </CardHeader>
              <CardContent>
                {deals.length === 0 ? (
                  <p className='text-sm text-muted-foreground'>
                    No deals yet. Add one from the Pipeline board.
                  </p>
                ) : (
                  <ul className='divide-y divide-bd-rule-soft'>
                    {deals.map((d) => (
                      <li
                        key={d.id}
                        className='flex items-center justify-between gap-3 py-2.5'
                      >
                        <div className='min-w-0'>
                          <p className='truncate text-sm font-semibold'>
                            {d.title}
                          </p>
                          {d.expectedClose && (
                            <p className='text-xs text-muted-foreground'>
                              Expected {d.expectedClose}
                            </p>
                          )}
                        </div>
                        <div className='flex shrink-0 items-center gap-3'>
                          <span className='display text-base'>
                            {formatMoney(d.value, d.currency)}
                          </span>
                          {/* The same badge the pipeline shows. "Which of
                              these has he actually paid" is asked here more
                              often than on the board. */}
                          <PaymentBadge deal={d} />
                          <DealStagePill stage={d.stage} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <TimelineCard clientId={clientId} timeline={timeline} />
        </div>
      </Main>
    </>
  )
}

function ContactsCard({
  clientId,
  contacts,
}: {
  clientId: string
  contacts: ClientDetail['contacts']
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    title: '',
    isPrimary: false,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['client', clientId] })

  const add = useMutation({
    mutationFn: () =>
      api.post(`/clients/${clientId}/contacts`, {
        name: form.name.trim(),
        // Empty strings would fail email validation server-side; null is the
        // honest value for "not provided".
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        title: form.title.trim() || null,
        isPrimary: form.isPrimary,
      }),
    onSuccess: async () => {
      await invalidate()
      setOpen(false)
      setForm({ name: '', email: '', phone: '', title: '', isPrimary: false })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (contactId: string) =>
      api.del(`/clients/${clientId}/contacts/${contactId}`),
    onSuccess: invalidate,
  })

  return (
    <Card className='crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='display text-lg'>Contacts</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size='sm' variant='outline'>
              <Plus /> Add
            </Button>
          </DialogTrigger>
          <DialogContent className='crate-card sm:max-w-md'>
            <DialogHeader>
              <DialogTitle className='display text-xl'>New contact</DialogTitle>
            </DialogHeader>
            <div className='grid gap-3'>
              {(['name', 'title', 'email', 'phone'] as const).map((field) => (
                <div key={field} className='grid gap-1.5'>
                  <Label htmlFor={`contact-${field}`} className='capitalize'>
                    {field}
                  </Label>
                  <Input
                    id={`contact-${field}`}
                    value={form[field]}
                    onChange={(e) =>
                      setForm({ ...form, [field]: e.target.value })
                    }
                    type={field === 'email' ? 'email' : 'text'}
                  />
                </div>
              ))}
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={form.isPrimary}
                  onChange={(e) =>
                    setForm({ ...form, isPrimary: e.target.checked })
                  }
                  className='size-4 accent-bd-yellow-deep'
                />
                Primary contact
              </label>
            </div>
            <DialogFooter>
              <Button
                onClick={() => add.mutate()}
                disabled={!form.name.trim() || add.isPending}
              >
                Add contact
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {contacts.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No contacts yet — who do you call?
          </p>
        ) : (
          <ul className='divide-y divide-bd-rule-soft'>
            {contacts.map((contact) => (
              <li
                key={contact.id}
                className='group flex items-center justify-between gap-3 py-2.5'
              >
                <div className='min-w-0'>
                  <p className='flex items-center gap-1.5 text-sm font-semibold'>
                    {contact.isPrimary && (
                      <Star
                        className='size-3.5 fill-bd-yellow text-bd-ink'
                        aria-label='Primary contact'
                      />
                    )}
                    {contact.name}
                    {contact.title && (
                      <span className='font-normal text-muted-foreground'>
                        · {contact.title}
                      </span>
                    )}
                  </p>
                  <p className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
                    {contact.email && (
                      <a
                        href={`mailto:${contact.email}`}
                        className='flex items-center gap-1 hover:underline'
                      >
                        <Mail className='size-3' />
                        {contact.email}
                      </a>
                    )}
                    {contact.phone && (
                      <a
                        href={`tel:${contact.phone}`}
                        className='flex items-center gap-1 hover:underline'
                      >
                        <Phone className='size-3' />
                        {contact.phone}
                      </a>
                    )}
                  </p>
                </div>
                <Button
                  size='icon'
                  variant='ghost'
                  className='shrink-0 opacity-0 group-hover:opacity-100'
                  onClick={() => remove.mutate(contact.id)}
                  aria-label={`Remove ${contact.name}`}
                >
                  <Trash2 className='size-4 text-destructive' />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function TimelineCard({
  clientId,
  timeline,
}: {
  clientId: string
  timeline: ClientDetail['timeline']
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  const addNote = useMutation({
    mutationFn: () =>
      api.post(`/clients/${clientId}/activities`, {
        body: note.trim(),
        kind: 'note',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      setNote('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card className='h-fit crate-card'>
      <CardHeader>
        <CardTitle className='pb-2 display text-lg crate-rule'>
          Activity
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='space-y-2'>
          <Textarea
            id='activity-note'
            name='activity-note'
            aria-label='Log an activity'
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Log a call, a meeting, or a note…'
            className='min-h-16 resize-y'
          />
          <Button
            size='sm'
            onClick={() => addNote.mutate()}
            disabled={!note.trim() || addNote.isPending}
          >
            Add note
          </Button>
        </div>

        {timeline.length === 0 ? (
          <p className='text-sm text-muted-foreground'>Nothing logged yet.</p>
        ) : (
          <ol className='space-y-3'>
            {timeline.map((entry) => (
              <li key={entry.id} className='flex gap-2.5'>
                <span className='mt-0.5 shrink-0'>
                  {entry.kind === 'status_change' ? (
                    <ArrowRightLeft className='size-3.5 text-muted-foreground' />
                  ) : (
                    <MessageSquare className='size-3.5 text-muted-foreground' />
                  )}
                </span>
                <div className='min-w-0'>
                  <p className='text-sm break-words'>{entry.body}</p>
                  <p className='text-xs text-muted-foreground'>
                    {new Date(entry.occurredAt).toLocaleString('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {entry.actorName ? ` · ${entry.actorName}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Links, files, to-dos and the moodboard for one client, on the agency side.
 *
 * Fetches the same `/api/portal?client=` payload the homepage does rather than
 * widening `/api/clients/:id`, because the shapes must not diverge: the moment
 * this page had its own idea of what a workspace contains, the two screens
 * start disagreeing about the same client.
 */
function ClientWorkspace({ clientId }: { clientId: string }) {
  const { setClientId } = useWorkspace()

  /**
   * Opening a client's page makes that client the active workspace.
   *
   * Without this the panels here show client X while every link out of them —
   * "Open board", the Content Calendar row in the link stack — lands on
   * whichever workspace was last persisted, which may be a different client
   * entirely. That is precisely the defect use-workspace.ts was written to end:
   * a selection living in one place and guessed in another, so you approve or
   * schedule against the wrong client without anything on screen saying so.
   *
   * Setting it rather than threading `?client=` through every destination
   * keeps one source of truth, and it matches what opening a client's page
   * means: this is the client I am working on now.
   */
  useEffect(() => {
    setClientId(clientId)
  }, [clientId, setClientId])

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['portal', clientId],
    queryFn: () => api.get<PortalWorkspace>(`/portal?client=${clientId}`),
  })

  if (isLoading) {
    return (
      <div className='mb-5 grid gap-5 lg:grid-cols-2'>
        <Skeleton className='h-56' />
        <Skeleton className='h-56' />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className='mb-5'>
        <QueryError
          title='Could not load this client&rsquo;s workspace'
          error={error as Error}
          onRetry={() => refetch()}
        />
      </div>
    )
  }

  return (
    <>
      <MoodboardPreview clientId={clientId} canEdit />
      <div className='mb-5 grid items-start gap-5 lg:grid-cols-2'>
        <LinkStack links={data.links} canEdit clientId={clientId} />
        <div className='space-y-5'>
          <FileFolder files={data.files} canEdit clientId={clientId} />
          <TaskList tasks={data.tasks} canEdit clientId={clientId} />
        </div>
      </div>
    </>
  )
}
