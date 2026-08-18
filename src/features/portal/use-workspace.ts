import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/hooks/use-current-user'

const STORAGE_KEY = 'bd_portal_workspace'

export type Workspace = { id: string; name: string }

/**
 * Which client workspace the staff member is currently looking at.
 *
 * Shared across every portal screen and persisted, because it has to be. The
 * selection previously lived in the Homepage's local state while the Ideas
 * Bank and Calendar sent no client at all — so the server fell back to the
 * first workspace alphabetically. Selecting "Verdant Botanicals" and clicking
 * through to the Ideas Bank showed Acme Skincare's content with nothing to say
 * so, which is how you approve a post for the wrong client.
 *
 * Clients have exactly one workspace and no say in it: the hook returns null
 * for them and the server resolves it from their grant.
 */
export function useWorkspace() {
  const { data: currentUser } = useCurrentUser()
  const isStaff = currentUser?.isStaff ?? false

  const [stored, setStored] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(STORAGE_KEY)
  )

  const workspaces = useQuery({
    queryKey: ['portal-workspaces'],
    queryFn: () => api.get<{ workspaces: Workspace[] }>('/portal/workspaces'),
    enabled: isStaff,
  })

  const list = workspaces.data?.workspaces ?? []

  /**
   * Derived, not synced.
   *
   * A stored id can outlive its workspace — the client may have been deleted
   * or its portal closed — so the stored value is only used when it still
   * matches something real, and otherwise the first workspace stands in.
   * Deriving avoids a set-state-in-effect round trip and the render flash
   * that comes with it.
   */
  const clientId = !isStaff
    ? null
    : stored && list.some((w) => w.id === stored)
      ? stored
      : (list[0]?.id ?? null)

  const setClientId = useCallback((id: string) => {
    setStored(id)
    window.localStorage.setItem(STORAGE_KEY, id)
  }, [])

  return {
    isStaff,
    /** Null for clients, and for staff until the workspace list resolves. */
    clientId,
    setClientId,
    workspaces: list,
    isReady: !isStaff || !workspaces.isLoading,
  }
}

/** Appends ?client= only when there is one to append. */
export function withClient(path: string, clientId: string | null): string {
  if (!clientId) return path
  return `${path}${path.includes('?') ? '&' : '?'}client=${clientId}`
}
