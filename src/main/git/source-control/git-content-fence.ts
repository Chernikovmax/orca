import { createHash } from 'node:crypto'
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { validateDiffPath } from './git-diff-path'

/** Above this size freshness uses the filesystem identity instead of hashing all bytes. */
export const CONTENT_FENCE_HASH_LIMIT = 16 * 1024 * 1024
const CHUNK = 256 * 1024

export type ContentFenceEntry =
  | { kind: 'absent' }
  | { kind: 'gitlink' }
  | { kind: 'symlink'; target: string }
  | {
      kind: 'file'
      mode: string
      size: number
      digest?: string
      identity?: { dev: number; ino: number; mtimeMs: number; ctimeMs: number }
    }

async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(CHUNK)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (!bytesRead) {
      return hash.digest('hex')
    }
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

/** Reads one worktree path without following symlinks or crossing a symlinked parent. */
export async function readContentFenceEntry(
  cwd: string,
  filePath: string,
  options: GetStatusOptions
): Promise<ContentFenceEntry> {
  const root = resolveWorktreeFilesystemPath(cwd, options)
  let target = root
  const parts = filePath.split('/')
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part)
    let info
    try {
      info = await lstat(target)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { kind: 'absent' }
      }
      throw error
    }
    if (index < parts.length - 1) {
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Access denied: path crosses a symlink or non-directory')
      }
      continue
    }
    if (info.isSymbolicLink()) {
      return { kind: 'symlink', target: await readlink(target) }
    }
    if (info.isDirectory()) {
      return { kind: 'gitlink' }
    }
    if (!info.isFile()) {
      throw new Error('Unsupported filesystem entry')
    }
    const mode = info.mode & 0o111 ? '100755' : '100644'
    if (info.size > CONTENT_FENCE_HASH_LIMIT) {
      return {
        kind: 'file',
        mode,
        size: info.size,
        identity: {
          dev: info.dev,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs
        }
      }
    }
    const handle = await open(target, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error('File changed identity while reading its fingerprint; refresh required')
      }
      return { kind: 'file', mode, size: info.size, digest: await hashHandle(handle) }
    } finally {
      await handle.close()
    }
  }
  return { kind: 'absent' }
}

/**
 * Exact freshness token for one file: HEAD, its index records and its current
 * worktree bytes. A partial selection may only be applied while all three match
 * what the issued diff was built from.
 */
export async function readContentFence(
  cwd: string,
  paths: { filePath: string; oldPath?: string },
  options: GetStatusOptions
): Promise<string> {
  const filePath = validateDiffPath(paths.filePath)
  const oldPath = validateDiffPath(paths.oldPath ?? filePath)
  const unique = oldPath === filePath ? [filePath] : [oldPath, filePath]
  const [head, records, entries] = await Promise.all([
    workspaceGitRead(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], options, true).then(
      (value) => value.trim(),
      () => ''
    ),
    workspaceGitRead(
      cwd,
      ['ls-files', '--stage', '-z', '--', ...unique.map((item) => `:(literal)${item}`)],
      options
    ),
    Promise.all(unique.map((item) => readContentFenceEntry(cwd, item, options)))
  ])
  const indexRecords = records
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      const metadata = record.slice(0, tab).split(' ')
      return { metadata, path: record.slice(tab + 1) }
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.metadata.join(' ').localeCompare(b.metadata.join(' ')))
  return createHash('sha256')
    .update(JSON.stringify([head, indexRecords, unique.map((item, index) => [item, entries[index]])]))
    .digest('hex')
}
