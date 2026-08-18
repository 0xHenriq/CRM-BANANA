import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Workspace } from './use-workspace'

/**
 * Shown on every portal screen for staff, so the workspace in view is never
 * ambiguous. Clients see nothing — they have one workspace and did not choose
 * it.
 */
export function WorkspaceSwitcher({
  clientId,
  workspaces,
  onChange,
}: {
  clientId: string | null
  workspaces: Workspace[]
  onChange: (id: string) => void
}) {
  if (workspaces.length === 0) return null

  return (
    <Select value={clientId ?? ''} onValueChange={onChange}>
      <SelectTrigger className='h-8 w-48' aria-label='Client workspace'>
        <SelectValue placeholder='Choose a workspace' />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
