import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { env } from '../env.js'

/**
 * Where uploaded bytes live.
 *
 * An interface with one real implementation, deliberately. VPS4 has 416 GB
 * free and sixteen idle cores, so local disk is faster than object storage and
 * adds no third-party credential to manage. The seam exists so that changing
 * that decision later is a new file rather than a refactor — not because the
 * abstraction is earning anything today.
 */
export type StoredObject = {
  key: string
  sizeBytes: number
}

export interface StorageDriver {
  put(stream: Readable, opts: { prefix: string; ext: string }): Promise<StoredObject>
  putBuffer(buf: Buffer, opts: { prefix: string; ext: string }): Promise<StoredObject>
  read(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream
  size(key: string): Promise<number>
  remove(key: string): Promise<void>
  /**
   * A second, independent object with the same bytes.
   *
   * Duplicating a post copies its assets, and the copy must own its bytes
   * rather than pointing at the original's. Sharing a key would make the two
   * rows silently coupled: removing either one's bytes would break the other,
   * which is exactly the aliasing bug that appears months later when someone
   * tidies up an old post and an unrelated one loses its image.
   */
  copy(key: string, opts: { prefix: string }): Promise<StoredObject>
}

export class LocalDiskDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  /**
   * Keys are generated here, never taken from the client.
   *
   * A key is `<prefix>/<uuid>.<ext>`, and `resolvePath` refuses anything that
   * escapes the root. Both matter: the upload path never trusts a filename,
   * and the download path never trusts a key, so a stored value that somehow
   * contained `../` still cannot read outside the upload directory.
   */
  private newKey(prefix: string, ext: string): string {
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
    return `${prefix}/${randomUUID()}.${safeExt.toLowerCase()}`
  }

  private resolvePath(key: string): string {
    const full = resolve(this.root, key)
    const rootWithSep = resolve(this.root) + sep
    if (!full.startsWith(rootWithSep)) {
      throw new Error(`Refusing to touch a path outside the upload root: ${key}`)
    }
    return full
  }

  async put(
    stream: Readable,
    opts: { prefix: string; ext: string }
  ): Promise<StoredObject> {
    const key = this.newKey(opts.prefix, opts.ext)
    const path = this.resolvePath(key)
    await mkdir(dirname(path), { recursive: true })
    await pipeline(stream, createWriteStream(path))
    const { size } = await stat(path)
    return { key, sizeBytes: size }
  }

  async putBuffer(
    buf: Buffer,
    opts: { prefix: string; ext: string }
  ): Promise<StoredObject> {
    const key = this.newKey(opts.prefix, opts.ext)
    const path = this.resolvePath(key)
    await mkdir(dirname(path), { recursive: true })
    await pipeline(Readable.from(buf), createWriteStream(path))
    return { key, sizeBytes: buf.byteLength }
  }

  read(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.resolvePath(key), range)
  }

  async size(key: string): Promise<number> {
    const { size } = await stat(this.resolvePath(key))
    return size
  }

  async remove(key: string): Promise<void> {
    // A missing object is the desired end state, not a failure.
    await unlink(this.resolvePath(key)).catch(() => {})
  }

  async copy(key: string, opts: { prefix: string }): Promise<StoredObject> {
    const from = this.resolvePath(key)
    // Keep the original's extension: it is what decides how the bytes are
    // served back, and a 200 MB .mov copied as .bin plays nowhere.
    const dot = key.lastIndexOf('.')
    const ext = dot >= 0 ? key.slice(dot + 1) : 'bin'

    const newKeyPath = this.newKey(opts.prefix, ext)
    const to = this.resolvePath(newKeyPath)
    await mkdir(dirname(to), { recursive: true })
    // copyFile rather than read-then-write: it stays in the kernel, so a large
    // video never passes through this process's heap.
    await copyFile(from, to)
    const { size } = await stat(to)
    return { key: newKeyPath, sizeBytes: size }
  }
}

export const storage: StorageDriver = new LocalDiskDriver(
  resolve(env.UPLOAD_DIR)
)

export const UPLOAD_ROOT = resolve(env.UPLOAD_DIR)

/** Absolute path for a key — used by ffmpeg, which needs a real file. */
export function localPath(key: string): string {
  const full = resolve(UPLOAD_ROOT, key)
  if (!full.startsWith(resolve(UPLOAD_ROOT) + sep)) {
    throw new Error('Path escapes the upload root')
  }
  return full
}

export { join }
