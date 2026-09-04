import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CornerDownRight,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  fileUrl,
  formatBytes,
  formatShortDate,
  type NoticePost,
  type PortalFile,
  type PortalTask,
} from '@/lib/api'
import { uploadMedia } from '@/lib/upload'
import { UploadButton } from '@/components/upload-button'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { safeHref } from '@/lib/safe-href'
import { TaskThread } from './task-thread'

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
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['portal'] })

  /**
   * Real uploads, not just pasted links.
   *
   * The folder is where proposals, agreements, invoices and reports live, and
   * until now it could only hold a URL to somewhere else — so the documents
   * themselves stayed in Drive and the portal described them rather than
   * holding them. The pipeline always supported `target=file`; nothing called
   * it, and it refused anything that was not an image or a video anyway.
   *
   * Sequential rather than parallel: each upload is written and hashed on the
   * server, and a dozen at once would contend for the same cores for no gain.
   */
  const upload = useMutation({
    mutationFn: async (chosen: File[]) => {
      for (const file of Array.from(chosen)) {
        setProgress(0)
        await uploadMedia(file, {
          clientId,
          target: 'file',
          onProgress: setProgress,
        })
      }
    },
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setProgress(null),
  })

  /**
   * The same upload, aimed at a row that already exists.
   *
   * Uploading a signed agreement used to leave the "Agreement" slot reading
   * "Empty slot" and put agreement-signed.pdf at the bottom of the list — two
   * rows for one document, and the category she had set up left unfilled.
   * This fills the slot and keeps its name.
   */
  const fillSlot = useMutation({
    mutationFn: async ({ fileId, file }: { fileId: string; file: File }) => {
      setProgress(0)
      await uploadMedia(file, {
        clientId,
        target: 'file',
        fileId,
        onProgress: setProgress,
      })
    },
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setProgress(null),
  })

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
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card
      className={cn(
        'crate-card transition-colors',
        // Drop anywhere on the card, which is where people aim. Only for
        // staff: a client has no write access to this table.
        dragging && 'bg-bd-cream ring-2 ring-bd-yellow-deep'
      )}
      onDragOver={
        canEdit
          ? (e) => {
              e.preventDefault()
              setDragging(true)
            }
          : undefined
      }
      onDragLeave={canEdit ? () => setDragging(false) : undefined}
      onDrop={
        canEdit
          ? (e) => {
              e.preventDefault()
              setDragging(false)
              // Copied out of the DataTransfer, for the same reason the file
              // input's list is: it is a live view that the browser is free to
              // empty once this handler returns, and the mutation reads it
              // afterwards.
              const dropped = Array.from(e.dataTransfer.files ?? [])
              if (dropped.length) upload.mutate(dropped)
            }
          : undefined
      }
    >
      <CardTitleRow
        title='File Folder'
        action={
          canEdit && (
            <span className='flex items-center gap-2'>
              <UploadButton
                size='sm'
                label='Upload'
                icon={<Upload />}
                pending={upload.isPending}
                progress={progress}
                onFiles={(files) => upload.mutate(files)}
              />
              {!adding && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setAdding(true)}
                >
                  <Plus /> Link
                </Button>
              )}
            </span>
          )
        }
      />
      <CardContent>
        <div className='crate-rule mb-3' />
        {files.length === 0 && !adding ? (
          <p className='text-sm text-muted-foreground'>
            {canEdit
              ? 'No files yet. Upload a proposal or an agreement, or drop one here.'
              : 'No files yet.'}
          </p>
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
                onUpload={(chosen) =>
                  fillSlot.mutate({ fileId: file.id, file: chosen })
                }
                uploading={
                  fillSlot.isPending && fillSlot.variables?.fileId === file.id
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

        {canEdit && (
          <p className='mt-3 text-xs text-muted-foreground italic'>
            Drop files here to upload. PDF, Word, Excel, PowerPoint, CSV, images
            and video, up to 1 GB each.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function FileRow({
  file,
  canEdit,
  onSetUrl,
  onUpload,
  uploading,
  onDelete,
}: {
  file: PortalFile
  canEdit: boolean
  onSetUrl: (url: string) => void
  onUpload: (chosen: File) => void
  uploading: boolean
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(file.externalUrl ?? '')
  const href = safeHref(file.externalUrl ?? '')
  // A row holds bytes we stored, or a link to somewhere else, or neither (one
  // of the five slots seeded when the portal opens).
  const uploaded = !!file.storageKey

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
          <span className='min-w-0 flex-1'>
            <span className='block truncate text-sm font-semibold'>
              {file.name}
            </span>
            {uploaded && (
              <span className='block text-[0.6875rem] text-muted-foreground'>
                {formatBytes(file.sizeBytes)}
              </span>
            )}
          </span>

          {/*
            An uploaded file wins over a pasted link: the bytes we hold are
            more authoritative than a URL to somewhere else, and a row can
            legitimately have both once she uploads over a link she had
            previously pasted.
          */}
          {uploaded ? (
            <a
              href={fileUrl(file.id)}
              className='flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:underline'
            >
              Download <Download className='size-3' />
            </a>
          ) : href ? (
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
              Empty slot
            </span>
          )}

          {/*
            Fill this exact slot, keeping its name.
            
            On every row, not only the empty ones: replacing last year's
            agreement with this year's is the same action, and the superseded
            bytes are removed server-side rather than left behind.
          */}
          {canEdit && (
            <UploadButton
              size='sm'
              variant='ghost'
              className='h-7 shrink-0 px-2 text-xs'
              label={uploaded ? 'Replace' : 'Upload'}
              icon={<Upload className='size-3' />}
              // One file per slot — "Agreement" holds an agreement, not four.
              // No `accept`: the card-level button sets none either, and the
              // server decides from the bytes and says what it refused.
              multiple={false}
              pending={uploading}
              onFiles={(list) => {
                const chosen = list[0]
                if (chosen) onUpload(chosen)
              }}
            />
          )}
        </>
      )}

      {canEdit && !editing && (
        <span className='flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
          {/*
            A row that already holds the bytes is not missing a link, so
            offering "Add link" on it reads as though the upload had not
            worked. The link controls belong to link-only rows.
          */}
          {!uploaded && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-xs'
              onClick={() => setEditing(true)}
            >
              {href ? 'Change' : 'Add link'}
            </Button>
          )}
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
  const [dueDate, setDueDate] = useState('')
  /* One open thread at a time. Two expanded conversations in a panel this
     narrow push everything else off the screen and neither is readable. */
  const [threadOpen, setThreadOpen] = useState<string | null>(null)

  /*
   * Tasks feed the Next Steps panel as well as this one, so both keys have to
   * go. Without the second line, ticking a to-do off leaves it sitting at the
   * top of the page with its deadline still counting down — the panel that
   * exists to say what is outstanding, quietly lying about it.
   *
   * A prefix invalidates every variant, so the whole-agency list and each
   * per-client list all refresh from one call.
   */
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['portal'] })
    queryClient.invalidateQueries({ queryKey: ['next-steps'] })
  }

  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      api.patch(`/portal/tasks/${id}`, { done }),
    /**
     * Optimistic: a checkbox that waits for a round trip feels broken.
     *
     * Addressed by PREFIX, not by ['portal', clientId]. The page keys its
     * query on the staff *selection* — ['portal', 'default'] until a
     * workspace is picked — so writing to ['portal', <uuid>] landed on a
     * cache entry that did not exist and the tick never appeared until the
     * refetch returned. Only one portal query is ever live, so updating every
     * match is both correct and simpler than threading the real key down.
     */
    onMutate: async ({ id, done }) => {
      await queryClient.cancelQueries({ queryKey: ['portal'] })
      const previous = queryClient.getQueriesData({ queryKey: ['portal'] })
      queryClient.setQueriesData({ queryKey: ['portal'] }, (old: unknown) => {
        const w = old as { tasks: PortalTask[] } | undefined
        if (!w?.tasks) return old
        return {
          ...w,
          tasks: w.tasks.map((t) => (t.id === id ? { ...t, done } : t)),
        }
      })
      return { previous }
    },
    onError: (err: Error, _v, ctx) => {
      for (const [key, data] of ctx?.previous ?? []) {
        queryClient.setQueryData(key, data)
      }
      toast.error(err.message)
    },
    onSettled: invalidate,
  })

  const create = useMutation({
    mutationFn: () =>
      api.post(`/portal/tasks?client=${clientId}`, {
        title: title.trim(),
        visibleToClient: !internal,
        dueDate: dueDate || null,
      }),
    onSuccess: async () => {
      await invalidate()
      setTitle('')
      setInternal(false)
      setDueDate('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * Reveal an internal task to the client, or take a shared one back.
   *
   * `visible_to_client` could only ever be set at creation, so a task typed as
   * internal was internal for good — she had to delete it and retype it to
   * share it. The RLS policy on tasks is what actually enforces this; the
   * client never receives a hidden row at all, so flipping the flag is the
   * only way to put one in front of them.
   */
  const setVisibility = useMutation({
    mutationFn: ({ id, visibleToClient }: { id: string; visibleToClient: boolean }) =>
      api.patch(`/portal/tasks/${id}`, { visibleToClient }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/portal/tasks/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
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
              <li key={task.id}>
              <div
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

                {/* The deadline as its own field rather than typed into the
                    title. She had been writing "Due 28/08/2026" into the name
                    because the column existed and the form never offered it. */}
                {task.dueDate && !task.done && <DueDate date={task.dueDate} />}

                {/* Only staff ever receive these rows — the RLS policy on
                    tasks filters visible_to_client — so the badge is a
                    reminder of who can see it, not a gate. Clicking it is how
                    a task typed as internal gets shared with the client; there
                    was no way to do that short of deleting and retyping it. */}
                {!task.visibleToClient &&
                  (canEdit ? (
                    <button
                      type='button'
                      onClick={() =>
                        setVisibility.mutate({
                          id: task.id,
                          visibleToClient: true,
                        })
                      }
                      className='flex shrink-0 items-center gap-1 rounded-full border-[1.5px] border-bd-ink bg-bd-sand px-1.5 py-0.5 text-[0.625rem] font-bold hover:bg-bd-yellow'
                      title='Internal only — click to show this to the client'
                    >
                      <EyeOff className='size-2.5' />
                      Internal
                    </button>
                  ) : null)}

                {canEdit && (
                  <span className='flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100'>
                    {task.visibleToClient && (
                      <Button
                        size='icon'
                        variant='ghost'
                        className='size-7'
                        onClick={() =>
                          setVisibility.mutate({
                            id: task.id,
                            visibleToClient: false,
                          })
                        }
                        aria-label={`Hide ${task.title} from the client`}
                        title='Shown to the client — click to make it internal'
                      >
                        <Eye className='size-3.5' />
                      </Button>
                    )}
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-7'
                      onClick={() => remove.mutate(task.id)}
                      aria-label={`Remove ${task.title}`}
                    >
                      <Trash2 className='size-3.5 text-destructive' />
                    </Button>
                  </span>
                )}

                {/*
                  The same thread as the Next Steps panel, on the same to-do.
                  
                  Both places, because a to-do appears in both and it would be
                  a strange product where the conversation about one of them
                  existed on the panel at the top of the page and not on the
                  list halfway down. Undated to-dos never reach Next Steps at
                  all, so without this half of them would have no thread.
                  
                  Not hidden behind group-hover like the staff-only controls
                  beside it: a client has to be able to find it, and a control
                  that only appears on hover does not exist on a phone.
                */}
                <button
                  type='button'
                  onClick={() =>
                    setThreadOpen((open) => (open === task.id ? null : task.id))
                  }
                  aria-expanded={threadOpen === task.id}
                  aria-label={
                    task.replies
                      ? `${threadOpen === task.id ? 'Hide' : 'Show'} ${task.replies} ${task.replies === 1 ? 'reply' : 'replies'} on "${task.title}"`
                      : `Reply to "${task.title}"`
                  }
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded-full border-[1.5px] px-1.5 py-0.5',
                    'text-[0.625rem] font-bold transition-colors',
                    task.replies
                      ? 'border-bd-ink bg-bd-yellow text-bd-ink hover:brightness-95'
                      : 'border-bd-rule text-muted-foreground hover:border-bd-ink hover:text-bd-ink'
                  )}
                >
                  <MessageSquare className='size-2.5' />
                  {task.replies ? task.replies : 'Reply'}
                </button>
              </div>

              {threadOpen === task.id && (
                <TaskThread taskId={task.id} canModerate={canEdit} />
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
                name='new-task'
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='Add a task…'
                className='h-8'
                aria-label='New task'
              />
              <Input
                type='date'
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className='h-8 w-36 shrink-0'
                aria-label='Deadline'
                title='Deadline'
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
            // A placeholder is not an accessible name — it disappears on
            // focus and screen readers announced this only as "text area".
            id='notice-body'
            name='notice-body'
            aria-label='Write a notice'
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
                        <NoticeItem
                          note={reply}
                          canModerate={canModerate}
                          onDelete={() => remove.mutate(reply.id)}
                        />
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

/**
 * A deadline, coloured by how close it is.
 *
 * "Due 28/08/2026" buried in a task title tells her nothing at a glance, which
 * is the whole reason a deadline exists. Overdue is the state that has to be
 * unmissable, so it gets the destructive colour; due today or tomorrow is
 * amber; anything further out is quiet.
 */
export function DueDate({ date }: { date: string }) {
  // Compared as local calendar days, never through Date.parse of the whole
  // string: 'YYYY-MM-DD' parses as UTC midnight, so east of Greenwich an
  // evening check would call today's deadline yesterday's.
  const [y, m, d] = date.split('-').map(Number)
  const due = new Date(y, m - 1, d)
  const today = new Date()
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((due.getTime() - midnight.getTime()) / 86_400_000)

  const tone =
    days < 0
      ? 'bg-destructive text-white border-bd-ink'
      : days <= 1
        ? 'bg-bd-yellow text-bd-ink border-bd-ink'
        : 'bg-bd-sand text-bd-ink border-bd-rule'

  const label =
    days < 0
      ? `${Math.abs(days)}d overdue`
      : days === 0
        ? 'Today'
        : days === 1
          ? 'Tomorrow'
          : // formatShortDate, not toLocaleDateString: en-GB abbreviates
            // September to "Sept", and the feed grid renders the same month as
            // "Sep". One product should not spell a month two ways.
            formatShortDate(date)

  return (
    <span
      className={cn(
        'shrink-0 rounded-full border-[1.5px] px-1.5 py-0.5 text-[0.625rem] font-bold',
        tone
      )}
      title={`Deadline ${due.toLocaleDateString('en-GB', { dateStyle: 'full' })}`}
    >
      {label}
    </span>
  )
}
