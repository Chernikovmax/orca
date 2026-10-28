import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitConflictContent, GitConflictStage } from '../../../shared/git-workspace-conflict'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import type { GetStatusOptions } from './get-status-options'
import { readContentFenceEntry } from './git-content-fence'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import { readGitBlobBytes } from './git-blob-read'

export const CONFLICT_CONTENT_LIMIT = 8 * 1024 * 1024

export function conflictContent(bytes: Buffer): GitConflictContent {
  if (isBinaryBuffer(bytes)) {
    return { kind: 'binary', bytes: bytes.length }
  }
  try {
    return {
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    }
  } catch {
    return { kind: 'binary', bytes: bytes.length }
  }
}

export async function readConflictStage(
  cwd: string,
  record: { oid: string; mode: string } | undefined,
  options: GetStatusOptions
): Promise<GitConflictStage> {
  if (!record) {
    return { content: { kind: 'absent' } }
  }
  if (record.mode === '160000') {
    return { ...record, content: { kind: 'gitlink' } }
  }
  const bytes = Number(
    (await workspaceGitRead(cwd, ['cat-file', '-s', record.oid], options)).trim()
  )
  if (bytes > CONFLICT_CONTENT_LIMIT) {
    return { ...record, content: { kind: 'large', bytes } }
  }
  const buffer = await readGitBlobBytes(cwd, record.oid, options, CONFLICT_CONTENT_LIMIT, bytes)
  const content = conflictContent(buffer)
  return {
    ...record,
    content:
      record.mode === '120000' && content.kind === 'text'
        ? { kind: 'symlink', content: content.content }
        : content
  }
}

export async function readConflictResult(
  cwd: string,
  filePath: string,
  options: GetStatusOptions
): Promise<GitConflictContent> {
  const entry = await readContentFenceEntry(cwd, filePath, options)
  if (entry.kind === 'absent') {
    return { kind: 'absent' }
  }
  if (entry.kind === 'gitlink') {
    return { kind: 'gitlink' }
  }
  if (entry.kind === 'symlink') {
    return { kind: 'symlink', content: entry.target }
  }
  if (entry.size > CONFLICT_CONTENT_LIMIT) {
    return { kind: 'large', bytes: entry.size }
  }
  const handle = await open(path.join(cwd, filePath), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = Buffer.alloc(entry.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== entry.size) {
      throw new GitMutationError('stale', 'Conflict result changed while reading')
    }
    return conflictContent(bytes.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
