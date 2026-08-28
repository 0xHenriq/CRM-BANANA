import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Archive,
  Plus,
  Users,
  ClipboardList,
  Eye,
  ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  CLIENT_STATUSES,
  CLIENT_STATUS_ORDER,
  type ClientStatus,
  type ClientSummary,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { ClientLogo } from '@/components/client-logo'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ClientStatusPill, CLIENT_LABEL } from './status-pill'

export function ClientsList() {
  // Archived clients are off by default and the toggle is part of the query
  // key, so switching it refetches rather than filtering a list that never
  // contained them.
  const [showArchived, setShowArchived] = useState(false)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['clients', showArchived ? 'with-archived' : 'active'],
    queryFn: () =>
      api.get<{ clients: ClientSummary[] }>(
        showArchived ? '/clients?archived=1' : '/clients'
      ),
  })

  return (
    <>
      <Header>
        <Search />
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <PageHead
          eyebrow='Accounts'
          title='Clients'
          actions={
            <div className='flex items-center gap-2'>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive className='size-3.5' />
                {showArchived ? 'Hide archived' : 'Show archived'}
              </Button>
              <NewClientDialog />
            </div>
          }
        />

        {isLoading ? (
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className='h-40 rounded-lg' />
            ))}
          </div>
        ) : isError ? (
          // Never fall through to the empty state on error: "No clients yet"
          // when the request failed is a lie she would act on.
          <QueryError
            title='Could not load clients'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : !data?.clients.length ? (
          <Card className='crate-card'>
            <CardContent className='py-10 text-center'>
              <p className='text-sm text-muted-foreground'>
                No clients yet. Add the first one to open a workspace for them.
              </p>
            </CardContent>
          </Card>
        ) : (
          /*
            Grouped by status, not one mixed grid.
            
            Twelve cards in creation order, each with a small pill in the
            corner, meant reading every card to answer "who is actually
            active" — which is the first question she asks this page. The
            groups are ordered by how much attention each state wants: live
            work, then things she is chasing, then the dormant ones.
          */
          <div className='space-y-8'>
            {CLIENT_STATUS_ORDER.map((status) => {
              // An archived client keeps whatever status it had, so it would
              // otherwise reappear inside Active — which is the one place she
              // archived it to get it out of.
              const group = data.clients.filter(
                (c) => c.status === status && !c.archivedAt
              )
              if (group.length === 0) return null
              return (
                <section key={status}>
                  <div className='mb-4 flex items-baseline gap-3 pb-1.5 crate-underline'>
                    <h2 className='display text-xl'>{CLIENT_LABEL[status]}</h2>
                    <span className='text-xs text-muted-foreground'>
                      {group.length}
                      {status === 'active' &&
                        ` · ${group.filter((c) => c.awaitingReviewCount > 0).length} waiting on a decision`}
                    </span>
                  </div>
                  <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                    {group.map((client) => (
                      <ClientCard key={client.id} client={client} />
                    ))}
                  </div>
                </section>
              )
            })}

            {showArchived &&
              (() => {
                const archived = data.clients.filter((c) => c.archivedAt)
                if (archived.length === 0) {
                  return (
                    <p className='text-sm text-muted-foreground'>
                      Nothing archived.
                    </p>
                  )
                }
                return (
                  <section>
                    <div className='mb-4 flex items-baseline gap-3 pb-1.5 crate-underline'>
                      <h2 className='display text-xl'>Archived</h2>
                      <span className='text-xs text-muted-foreground'>
                        {archived.length} · hidden from the list, nothing
                        deleted
                      </span>
                    </div>
                    <div className='grid gap-4 opacity-60 sm:grid-cols-2 lg:grid-cols-3'>
                      {archived.map((client) => (
                        <ClientCard key={client.id} client={client} />
                      ))}
                    </div>
                  </section>
                )
              })()}
          </div>
        )}
      </Main>
    </>
  )
}

function ClientCard({ client }: { client: ClientSummary }) {
  return (
    <Link
      to='/clients/$clientId'
      params={{ clientId: client.id }}
      className='group'
    >
      <Card className='h-full gap-0 crate-card py-5 transition-transform group-hover:-translate-y-0.5'>
        <CardContent className='px-5'>
          <div className='mb-3 flex items-start justify-between gap-3'>
            {/*
              The mark before the name: with the list grouped by status there
              are a lot of near-identical cards on this screen, and a logo is
              recognised faster than a name is read.
            */}
            <div className='flex min-w-0 items-center gap-2.5'>
              <ClientLogo
                clientId={client.id}
                name={client.name}
                logoKey={client.logoKey}
                brandColor={client.brandColor}
                markOnly
              />
              <h2 className='truncate display text-xl'>{client.name}</h2>
            </div>
            <ClientStatusPill status={client.status} />
          </div>

          <div className='mb-3 crate-rule' />

          <dl className='grid grid-cols-3 gap-2 text-center'>
            <Metric icon={Users} value={client.seatCount} label='Seats' />
            <Metric
              icon={ClipboardList}
              value={client.openTaskCount}
              label='Open'
            />
            <Metric
              icon={Eye}
              value={client.awaitingReviewCount}
              label='Review'
            />
          </dl>

          <p className='mt-3 flex items-center gap-1.5 text-xs text-muted-foreground'>
            {client.portalEnabled ? (
              <>
                <ExternalLink className='size-3' />
                Portal open
              </>
            ) : (
              'Portal not open yet'
            )}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}

function Metric({
  icon: Icon,
  value,
  label,
}: {
  icon: React.ElementType
  value: number
  label: string
}) {
  return (
    <div>
      <dt className='sr-only'>{label}</dt>
      <dd className='display text-xl'>{value}</dd>
      <p className='flex items-center justify-center gap-1 text-[0.625rem] tracking-wide text-muted-foreground uppercase'>
        <Icon className='size-3' />
        {label}
      </p>
    </div>
  )
}

function NewClientDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [status, setStatus] = useState<ClientStatus>('lead')
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: () => api.post('/clients', { name: name.trim(), status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
      toast.success(`${name.trim()} added`)
      setOpen(false)
      setName('')
      setStatus('lead')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New client
        </Button>
      </DialogTrigger>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>New client</DialogTitle>
          <DialogDescription>
            Creating one as <strong>Active</strong> opens their portal
            immediately and seeds the standard link stack, file folder and
            onboarding to-do&rsquo;s.
          </DialogDescription>
        </DialogHeader>

        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='client-name'>Name</Label>
            <Input
              id='client-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Acme Skincare'
              autoComplete='off'
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='client-status'>Status</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as ClientStatus)}
            >
              <SelectTrigger id='client-status'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CLIENT_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
          >
            Create client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
