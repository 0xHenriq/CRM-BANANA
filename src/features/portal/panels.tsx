import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink,
  EyeOff,
  FileText,
  Plus,
  Send,
  Trash2,
  CornerDownRight,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type NoticePost,
  type PortalFile,
  type PortalTask,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { safeHref } from '@/lib/safe-href'

function CardTitleRow({
  title,
  action,
}: {
  title: string
  action?: React.ReactNode
}) {
  return (
    <CardHeader className='flex flex-row items-center justify-between'>
      <CardTitle className='display flex items-center gap-2 text-lg'>
        <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-yellow' />
        {title}
      </CardTitle>
      {action}
    </CardHeader>
  )
}

/* -------------------------------------------------------------- file folder */

export function FileFolder({
  files,
  canEdit,
  clientId,
}: {
  files: PortalFile[]
  canEdit: boolean
  clientId: string
}) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', externalUrl: '' })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['portal'] })

  const create = useMutation({
    mutationFn: () =>
      api.post(`/portal/files?client=${clientId}`, {
        name: form.name.trim(),
        externalUrl: form.externalUrl.trim(),
      }),
    onSuccess: async () => {
      await invalidate()
      setForm({ name: '', externalUrl: '' })
      setAdding(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const update = useMutation({
    mutationFn: ({ id, externalUrl }: { id: string; externalUrl: string }) =>
      api.patch(`/portal/files/${id}`, { externalUrl }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/files/${id}`),
    onSuccess: invalidate,
  })

  return (
    <Card className='crate-card'>
      <CardTitleRow
        title='File Folder'
        action={
          canEdit &&
          !adding && (
            <Button size='sm' variant='outline' onClick={() => setAdding(true)}>
              <Plus /> Add file
            </Button>
          )
        }
      />
      <CardContent>
        <div className='crate-rule mb-3' />
        {files.length === 0 && !adding ? (
          <p className='text-sm text-muted-foreground'>No files yet.</p>
        ) : (
          <ul className='divide-y divide-bd-rule-soft'>
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                canEdit={canEdit}
                onSetUrl={(externalUrl) =>
                  update.mutate({ id: file.id, externalUrl })
                }
                onDelete={() => remove.mutate(file.id)}
              />
            ))}
          </ul>
        )}

        {adding && (
          <form
            className='mt-3 flex flex-wrap gap-2 rounded-md border-[1.5px] border-dashed border-bd-rule p-2'
            onSubmit={(e) => {
              e.preventDefault()
              if (form.name.trim()) create.mutate()
            }}
          >
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder='File name'
              className='h-8 min-w-32 flex-1'
              aria-label='File name'
              autoFocus
            />
            <Input
              value={form.externalUrl}
              onChange={(e) =>
                setForm({ ...form, externalUrl: e.target.value })
              }
              placeholder='https://…'
              className='h-8 min-w-40 flex-[2]'
              aria-label='File link'
            />
            <Button size='sm' disabled={!form.name.trim() || create.isPending}>
              Add
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </form>
        )}

        {/* Real uploads land in Phase 6. Until then a file is a link, which is
            exactly what the prototype did — so nothing is lost, and the empty
            slots she seeds are honest about being slots. */}
        <p className='mt-3 text-xs text-muted-foreground italic'>
          Files are links for now. Uploads arrive with the media work.
        </p>
      </CardContent>
    </Card>
  )
}

function FileRow({
  file,
  canEdit,
  onSetUrl,
  onDelete,
}: {
  file: PortalFile
  canEdit: boolean
  onSetUrl: (url: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(file.externalUrl ?? '')
  const href = safeHref(file.externalUrl ?? '')

  return (
    <li className='group flex items-center gap-2.5 py-2'>
      <span className='flex size-7 shrink-0 items-center justify-center rounded border-[1.5px] border-bd-ink bg-bd-yellow'>
        <FileText className='size-3.5 text-bd-ink' />
      </span>

      {editing ? (
        <form
          className='flex flex-1 items-center gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            onSetUrl(url.trim())
            setEditing(false)
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://…'
            className='h-8'
            aria-label={`Link for ${file.name}`}
            autoFocus
          />
          <Button size='sm'>Save</Button>
        </form>
      ) : (
        <>
          <span className='min-w-0 flex-1 truncate text-sm font-semibold'>
            {file.name}
          </span>
          {href ? (
            <a
              href={href}
              target='_blank'
              rel='noopener noreferrer'
              className='flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:underline'
            >
              Open <ExternalLink className='size-3' />
            </a>
          ) : (
            <span className='shrink-0 text-xs text-muted-foreground'>
              Not uploaded yet
            </span>
          )}
        </>
      )}

      {canEdit && !editing && (
        <span className='flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-xs'
            onClick={() => setEditing(true)}
          >
            {href ? 'Change' : 'Add link'}
          </Button>
          <Button
            size='icon'
            variant='ghost'
            className='size-7'
            onClick={onDelete}
            aria-label={`Remove ${file.name}`}
          >
            <Trash2 className='size-3.5 text-destructive' />
          </Button>
        </span>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------- tasks */

export function TaskList({
  tasks,
  canEdit,
  clientId,
}: {
  tasks: PortalTask[]
  canEdit: boolean
  clientId: string
}) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [internal, setInternal] = useState(false)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['portal'] })

  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      api.patch(`/portal/tasks/${id}`, { done }),
    // Optimistic: a checkbox that waits for a round trip feels broken.
    onMutate: async ({ id, done }) => {
      await queryClient.cancelQueries({ queryKey: ['portal'] })
      const previous = queryClient.getQueryData(['portal', clientId])
      queryClient.setQueryData(['portal', clientId], (old: unknown) => {
        const w = old as { tasks: PortalTask[] } | undefined
        if (!w) return old
        return {
          ...w,
          tasks: w.tasks.map((t) => (t.id === id ? { ...t, done } : t)),
        }
      })
      return { previous }
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.previous)
        queryClient.setQueryData(['portal', clientId], ctx.previous)
      toast.error(err.message)
    },
    onSettled: invalidate,
  })

  const create = useMutation({
    mutationFn: () =>
      api.post(`/portal/tasks?client=${clientId}`, {
        title: title.trim(),
        visibleToClient: !internal,
      }),
    onSuccess: async () => {
      await invalidate()
      setTitle('')
      setInternal(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/tasks/${id}`),
    onSuccess: invalidate,
  })

  return (
    <Card className='crate-card'>
      <CardTitleRow title="To-Do's" />
      <CardContent>
        <div className='crate-rule mb-3' />
        {tasks.length === 0 ? (
          <p className='text-sm text-muted-foreground'>Nothing to do yet.</p>
        ) : (
          <ul className='space-y-0.5'>
            {tasks.map((task) => (
              <li
                key={task.id}
                className='group flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-bd-cream'
              >
                <Checkbox
                  id={`task-${task.id}`}
                  checked={task.done}
                  onCheckedChange={(v) =>
                    toggle.mutate({ id: task.id, done: v === true })
                  }
                />
                <label
                  htmlFor={`task-${task.id}`}
                  className={cn(
                    'min-w-0 flex-1 cursor-pointer text-sm',
                    task.done && 'text-muted-foreground line-through'
                  )}
                >
                  {task.title}
                </label>

                {/* Only staff ever receive these rows — the RLS policy on
                    tasks filters visible_to_client — so the badge is a
                    reminder of who can see it, not a gate. */}
                {!task.visibleToClient && (
                  <span
                    className='flex shrink-0 items-center gap-1 rounded-full border-[1.5px] border-bd-ink bg-bd-sand px-1.5 py-0.5 text-[0.625rem] font-bold'
                    title='Internal only — the client never sees this'
                  >
                    <EyeOff className='size-2.5' />
                    Internal
                  </span>
                )}

                {canEdit && (
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-7 shrink-0 opacity-0 group-hover:opacity-100'
                    onClick={() => remove.mutate(task.id)}
                    aria-label={`Remove ${task.title}`}
                  >
                    <Trash2 className='size-3.5 text-destructive' />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form
            className='mt-3 space-y-2'
            onSubmit={(e) => {
              e.preventDefault()
              if (title.trim()) create.mutate()
            }}
          >
            <div className='flex gap-2'>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='Add a task…'
                className='h-8'
                aria-label='New task'
              />
              <Button size='sm' disabled={!title.trim() || create.isPending}>
                <Plus />
              </Button>
            </div>
            <label className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Checkbox
                checked={internal}
                onCheckedChange={(v) => setInternal(v === true)}
              />
              Internal only — keep this off the client&rsquo;s list
            </label>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------ notice board */

export function NoticeBoard({
  notices,
  clientId,
  canModerate,
}: {
  notices: NoticePost[]
  clientId: string
  canModerate: boolean
}) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['portal'] })

  const post = useMutation({
    mutationFn: (input: { body: string; parentId: string | null }) =>
      api.post(`/portal/notices?client=${clientId}`, input),
    onSuccess: async () => {
      await invalidate()
      setBody('')
      setReplyBody('')
      setReplyTo(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/notices/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  // The API returns a flat list newest-first; group replies under their root.
  const roots = notices.filter((n) => !n.parentId)
  const repliesByParent = new Map<string, NoticePost[]>()
  for (const n of notices) {
    if (!n.parentId) continue
    const list = repliesByParent.get(n.parentId) ?? []
    list.push(n)
    repliesByParent.set(n.parentId, list)
  }

  return (
    <Card className='crate-card'>
      <CardTitleRow title='Notice Board' />
      <CardContent>
        <div className='crate-rule mb-3' />

        <form
          className='mb-4 space-y-2'
          onSubmit={(e) => {
            e.preventDefault()
            if (body.trim()) post.mutate({ body: body.trim(), parentId: null })
          }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='Leave an update or a question…'
            className='min-h-16 resize-y'
          />
          <Button size='sm' disabled={!body.trim() || post.isPending}>
            <Send /> Post
          </Button>
        </form>

        {roots.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            Nothing posted yet. This is where updates and questions live.
          </p>
        ) : (
          <ol className='space-y-4'>
            {roots.map((note) => (
              <li key={note.id}>
                <NoticeItem
                  note={note}
                  canModerate={canModerate}
                  onDelete={() => remove.mutate(note.id)}
                />

                <ul className='mt-2 space-y-2 border-s-2 border-bd-rule-soft ps-3'>
                  {(repliesByParent.get(note.id) ?? [])
                    .slice()
                    .reverse()
                    .map((reply) => (
                      <li key={reply.id}>
                        <NoticeItem note={reply} canModerate={false} />
                      </li>
                    ))}
                </ul>

                {replyTo === note.id ? (
                  <form
                    className='mt-2 flex gap-2 ps-3'
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (replyBody.trim())
                        post.mutate({
                          body: replyBody.trim(),
                          parentId: note.id,
                        })
                    }}
                  >
                    <Input
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder='Reply…'
                      className='h-8'
                      aria-label='Reply'
                      autoFocus
                    />
                    <Button size='sm' disabled={!replyBody.trim()}>
                      Reply
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      onClick={() => setReplyTo(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='mt-1 h-7 px-2 text-xs'
                    onClick={() => {
                      setReplyTo(note.id)
                      setReplyBody('')
                    }}
                  >
                    <CornerDownRight className='size-3' /> Reply
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

function NoticeItem({
  note,
  canModerate,
  onDelete,
}: {
  note: NoticePost
  canModerate: boolean
  onDelete?: () => void
}) {
  return (
    <div className='group'>
      <div className='flex items-baseline gap-2'>
        {/* The prototype's notice board was one shared textarea: no author, no
            timestamp, no way to tell who said what. */}
        <span className='text-sm font-semibold'>
          {note.authorName ?? 'Someone'}
        </span>
        <span className='text-xs text-muted-foreground'>
          {new Date(note.createdAt).toLocaleString('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
        {canModerate && onDelete && (
          <Button
            size='icon'
            variant='ghost'
            className='ms-auto size-6 opacity-0 group-hover:opacity-100'
            onClick={onDelete}
            aria-label='Delete post'
          >
            <Trash2 className='size-3 text-destructive' />
          </Button>
        )}
      </div>
      <p className='text-sm whitespace-pre-wrap'>{note.body}</p>
    </div>
  )
}
