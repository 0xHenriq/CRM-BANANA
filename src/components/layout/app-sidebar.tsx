import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()

  // TODO(phase-2): filter `staffOnly` groups against the signed-in user's role.
  // Until auth lands, everything renders. The API is the real gate regardless.
  const groups = sidebarData.navGroups

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {groups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={sidebarData.user} />
        <div className='px-2 pb-1 text-[0.625rem] leading-relaxed tracking-wide opacity-50'>
          <span className='font-semibold'>Banana Digital London</span>
          <br />
          Social &amp; content partner
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
