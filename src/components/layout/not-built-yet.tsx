import { Hammer } from 'lucide-react'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Placeholder for a screen the navigation promises but a later phase builds.
 *
 * The alternative was leaving those nav entries pointing at nothing, which
 * 404s — worse in a demo than an honest "not built yet", and it makes the
 * intended shape of the product visible while it is being filled in.
 */
export function NotBuiltYet({
  eyebrow,
  title,
  stamp,
  summary,
  phase,
}: {
  eyebrow: string
  title: string
  stamp?: { top: string; big: string; bottom: string }
  summary: string
  phase: string
}) {
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
        <PageHead eyebrow={eyebrow} title={title} stamp={stamp} />
        <Card className='crate-card'>
          <CardContent className='flex items-start gap-3 py-7'>
            <Hammer className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
            <div className='space-y-1'>
              <p className='text-sm'>{summary}</p>
              <p className='text-xs text-muted-foreground'>Arrives in {phase}.</p>
            </div>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
