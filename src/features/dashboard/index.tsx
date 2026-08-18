import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Building2, ClipboardCheck, Eye, PoundSterling } from 'lucide-react'
import {
  api,
  formatMoney,
  formatPence,
  sumPence,
  type ClientSummary,
  type DealWithClient,
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { ClientStatusPill, DealStagePill } from '../clients/status-pill'
import { ReviewQueue } from '../content/review-queue'

/**
 * Agency overview.
 *
 * Every number here is derived from real rows. Placeholder metrics that look
 * plausible are worse than visibly empty ones — they get screenshotted and
 * believed. Where there is genuinely nothing to count, the card says so.
 */
export function Dashboard() {
  const clientsQuery = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: ClientSummary[] }>('/clients'),
  })
  const dealsQuery = useQuery({
    queryKey: ['deals'],
    queryFn: () => api.get<{ deals: DealWithClient[] }>('/deals'),
  })

  const clients = clientsQuery.data?.clients ?? []
  const deals = dealsQuery.data?.deals ?? []
  const isLoading = clientsQuery.isLoading || dealsQuery.isLoading

  const activeClients = clients.filter((c) => c.status === 'active').length
  const awaitingReview = clients.reduce(
    (sum, c) => sum + c.awaitingReviewCount,
    0
  )
  const openTasks = clients.reduce((sum, c) => sum + c.openTaskCount, 0)
  const openDeals = deals.filter(
    (d) => d.stage !== 'won' && d.stage !== 'lost'
  )
  const pipelinePence = sumPence(openDeals.map((d) => d.value))

  const stats = [
    {
      label: 'Active clients',
      icon: Building2,
      value: String(activeClients),
      hint: `${clients.length} total`,
    },
    {
      label: 'Awaiting review',
      icon: Eye,
      value: String(awaitingReview),
      hint: 'Content sent to clients',
    },
    {
      label: 'Open pipeline',
      icon: PoundSterling,
      value: pipelinePence > 0 ? formatPence(pipelinePence) : '—',
      hint: `${openDeals.length} deal${openDeals.length === 1 ? '' : 's'} in play`,
    },
    {
      label: 'Open to-dos',
      icon: ClipboardCheck,
      value: String(openTasks),
      hint: 'Across all workspaces',
    },
  ]

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
          eyebrow='Agency overview'
          title='Dashboard'
          stamp={{ top: 'EST.', big: 'BD', bottom: 'LDN' }}
        />

        {/* What is actually blocked, before the summary numbers. Her Monday
            question is "who owes me a decision", not "how many". */}
        <ReviewQueue variant='agency' />

        <div className='grid gap-5 sm:grid-cols-2 lg:grid-cols-4'>
          {stats.map(({ label, icon: Icon, value, hint }) => (
            <Card key={label} className='crate-card gap-0 py-5'>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 px-5 pb-2'>
                <CardTitle className='text-sm font-semibold'>{label}</CardTitle>
                <Icon className='size-4 text-muted-foreground' />
              </CardHeader>
              <CardContent className='px-5'>
                {isLoading ? (
                  <Skeleton className='h-8 w-16' />
                ) : (
                  <div className='display text-3xl'>{value}</div>
                )}
                <p className='mt-1 text-xs text-muted-foreground'>{hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className='mt-6 grid gap-5 lg:grid-cols-2'>
          <Card className='crate-card'>
            <CardHeader>
              <CardTitle className='display crate-rule pb-2 text-lg'>
                Clients
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className='h-24' />
              ) : clients.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  No clients yet.{' '}
                  <Link to='/clients' className='underline'>
                    Add the first one
                  </Link>
                  .
                </p>
              ) : (
                <ul className='divide-y divide-bd-rule-soft'>
                  {clients.slice(0, 6).map((client) => (
                    <li key={client.id}>
                      <Link
                        to='/clients/$clientId'
                        params={{ clientId: client.id }}
                        className='flex items-center justify-between gap-3 py-2.5 hover:opacity-70'
                      >
                        <span className='truncate text-sm font-semibold'>
                          {client.name}
                        </span>
                        <ClientStatusPill status={client.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className='crate-card'>
            <CardHeader>
              <CardTitle className='display crate-rule pb-2 text-lg'>
                Deals in play
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className='h-24' />
              ) : openDeals.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  Nothing in the pipeline.{' '}
                  <Link to='/pipeline' className='underline'>
                    Add a deal
                  </Link>
                  .
                </p>
              ) : (
                <ul className='divide-y divide-bd-rule-soft'>
                  {openDeals.slice(0, 6).map((deal) => (
                    <li
                      key={deal.id}
                      className='flex items-center justify-between gap-3 py-2.5'
                    >
                      <div className='min-w-0'>
                        <p className='truncate text-sm font-semibold'>
                          {deal.title}
                        </p>
                        <p className='truncate text-xs text-muted-foreground'>
                          {deal.clientName}
                        </p>
                      </div>
                      <div className='flex shrink-0 items-center gap-2'>
                        <span className='display text-sm'>
                          {formatMoney(deal.value, deal.currency)}
                        </span>
                        <DealStagePill stage={deal.stage} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}
