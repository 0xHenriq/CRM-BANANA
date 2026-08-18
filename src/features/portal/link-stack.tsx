import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Trash2,
  Check,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type PortalLink } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { safeHref } from '@/lib/safe-href'

export function LinkStack({
  links,
  canEdit,
  clientId,
}: {
  links: PortalLink[]
  canEdit: boolean
  clientId: string
}) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Two columns for a client, one for staff. The hover edit buttons still
  // occupy layout width at opacity-0, so in two columns they squeezed labels
  // down to "Google ..." — useless for the one thing this panel exists to
  // show. Staff get the width instead.
  const columns = canEdit ? 'sm:grid-cols-1' : 'sm:grid-cols-2'

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['portal'] })

  const save = useMutation({
    mutationFn: ({ id, ...body }: { id: string; label: string; url: string }) =>
      api.patch(`/portal/links/${id}`, body),
    onSuccess: async () => {
      await invalidate()
      setEditingId(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const create = useMutation({
    mutationFn: (body: { label: string; url: string }) =>
      api.post(`/portal/links?client=${clientId}`, body),
    onSuccess: async () => {
      await invalidate()
      setAdding(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/links/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card className='crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='display flex items-center gap-2 text-lg'>
          <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-yellow' />
          The Link Stack
        </CardTitle>
        {canEdit && !adding && (
          <Button size='sm' variant='outline' onClick={() => setAdding(true)}>
            <Plus /> Add link
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className='crate-rule mb-3' />

        {links.length === 0 && !adding ? (
          <p className='text-sm text-muted-foreground'>No links yet.</p>
        ) : (
          <ul
            className={cn('grid gap-0.5', columns)}
          >
            {links.map((link) =>
              editingId === link.id ? (
                <li key={link.id}>
                  <LinkForm
                    initial={link}
                    onCancel={() => setEditingId(null)}
                    onSubmit={(v) => save.mutate({ id: link.id, ...v })}
                    pending={save.isPending}
                  />
                </li>
              ) : (
                <li key={link.id} className='group'>
                  <LinkRow
                    link={link}
                    canEdit={canEdit}
                    onEdit={() => setEditingId(link.id)}
                    onDelete={() => remove.mutate(link.id)}
                  />
                </li>
              )
            )}
          </ul>
        )}

        {adding && (
          <div className='mt-2'>
            <LinkForm
              onCancel={() => setAdding(false)}
              onSubmit={(v) => create.mutate(v)}
              pending={create.isPending}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LinkRow({
  link,
  canEdit,
  onEdit,
  onDelete,
}: {
  link: PortalLink
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const href = safeHref(link.url)

  return (
    <div className='flex items-center gap-2 rounded-md px-2 py-2 hover:bg-bd-cream'>
      <Link2 className='size-4 shrink-0 text-muted-foreground' />

      {/*
        The prototype rendered two <input> elements here and no anchor at all,
        so the single most-used feature of the portal did nothing. This is the
        fix: a real link the client can click.
      */}
      {href ? (
        <a
          href={href}
          target='_blank'
          rel='noopener noreferrer'
          className='flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold hover:underline'
        >
          <span className='truncate'>{link.label}</span>
          <ExternalLink className='size-3 shrink-0 opacity-50' />
        </a>
      ) : (
        <span className='min-w-0 flex-1 truncate text-sm font-semibold text-muted-foreground'>
          {link.label}
          <span className='ms-1.5 text-xs font-normal'>
            {link.url.trim() ? '(invalid link)' : '(no link yet)'}
          </span>
        </span>
      )}

      {canEdit && (
        <span className='flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
          <Button
            size='icon'
            variant='ghost'
            className='size-7'
            onClick={onEdit}
            aria-label={`Edit ${link.label}`}
          >
            <Pencil className='size-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='size-7'
            onClick={onDelete}
            aria-label={`Remove ${link.label}`}
          >
            <Trash2 className='size-3.5 text-destructive' />
          </Button>
        </span>
      )}
    </div>
  )
}

function LinkForm({
  initial,
  onCancel,
  onSubmit,
  pending,
}: {
  initial?: PortalLink
  onCancel: () => void
  onSubmit: (v: { label: string; url: string }) => void
  pending: boolean
}) {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')

  return (
    <form
      className='flex flex-wrap items-center gap-2 rounded-md border-[1.5px] border-dashed border-bd-rule p-2'
      onSubmit={(e) => {
        e.preventDefault()
        if (label.trim()) onSubmit({ label: label.trim(), url: url.trim() })
      }}
    >
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder='Link name'
        className='h-8 min-w-32 flex-1'
        aria-label='Link name'
        autoFocus
      />
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder='https://…'
        className='h-8 min-w-40 flex-[2]'
        aria-label='Link URL'
      />
      <Button size='icon' className='size-8' disabled={!label.trim() || pending}>
        <Check className='size-4' />
        <span className='sr-only'>Save link</span>
      </Button>
      <Button
        type='button'
        size='icon'
        variant='ghost'
        className='size-8'
        onClick={onCancel}
      >
        <X className='size-4' />
        <span className='sr-only'>Cancel</span>
      </Button>
    </form>
  )
}
