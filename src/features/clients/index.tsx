import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Users, ClipboardList, Eye, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api, type ClientStatus, type ClientSummary } from '@/lib/api'
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
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: ClientSummary[] }>('/clients'),
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
          stamp={{ top: 'BD', big: 'CL', bottom: 'LDN' }}
          actions={<NewClientDialog />}
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
            {STATUS_ORDER.map((status) => {
              const group = data.clients.filter((c) => c.status === status)
              if (group.length === 0) return null
              return (
                <section key={status}>
                  <div className='crate-underline mb-4 flex items-baseline gap-3 pb-1.5'>
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
      <Card className='crate-card h-full gap-0 py-5 transition-transform group-hover:-translate-y-0.5'>
        <CardContent className='px-5'>
          <div className='mb-3 flex items-start justify-between gap-3'>
            <h2 className='display truncate text-xl'>{client.name}</h2>
            <ClientStatusPill status={client.status} />
          </div>

          <div className='crate-rule mb-3' />

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

const STATUSES: ClientStatus[] = [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
]

/**
 * Display order for the grouped list, which is NOT the order of the enum.
 *
 * The enum runs lead -> churned because that is the lifecycle. This runs by
 * how much attention each state deserves on a Monday morning: the clients she
 * is delivering for, then the ones she is chasing, then the dormant ones she
 * only needs to see to know they are still there.
 */
const STATUS_ORDER: ClientStatus[] = [
  'active',
  'proposal',
  'lead',
  'paused',
  'churned',
]

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
                {STATUSES.map((s) => (
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
