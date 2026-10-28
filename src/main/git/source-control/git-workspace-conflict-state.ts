import { createHash, randomUUID } from 'node:crypto'
import type { GitWorkspaceConflictDocument } from '../../../shared/git-workspace-conflict'
import type { GitContextRef } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { readContentFence, readContentFenceEntry } from './git-content-fence'
import { detectConflictOperationState } from './git-conflict-operation'
import { GitMutationError } from './git-workspace-mutation-error'
import { workspaceGitRead } from './git-workspace-discovery'

type ConflictFence = { full: string; index: string }

export type IssuedConflict = {
  document: GitWorkspaceConflictDocument
  context: GitContextRef
  fence: ConflictFence
  expires: number
  bytes: number
}
const issued = new Map<string, IssuedConflict>()
const EXPIRY_MS = 15 * 60_000
const MAX_DOCUMENTS = 32

export async function conflictFence(
  context: GitContextRef,
  filePath: string,
  options: GetStatusOptions
): Promise<ConflictFence> {
  const state = await detectConflictOperationState(context.checkoutPath, options)
  const markers: unknown[] = [state]
  for (const marker of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REBASE_HEAD',
    'rebase-merge/head-name',
    'rebase-merge/onto',
    'rebase-merge/stopped-sha',
    'rebase-merge/msgnum',
    'rebase-merge/git-rebase-todo',
    'rebase-apply/head-name',
    'rebase-apply/onto',
    'rebase-apply/next',
    'sequencer/todo'
  ]) {
    const entry = await readContentFenceEntry(context.gitDir, marker, {})
    markers.push([marker, entry])
  }
  const index = createHash('sha256')
    .update(
      JSON.stringify([
        await workspaceGitRead(
          context.checkoutPath,
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          options,
          true
        ),
        await workspaceGitRead(
          context.checkoutPath,
          ['ls-files', '--stage', '-z', '--', `:(literal)${filePath}`],
          options
        ),
        markers
      ])
    )
    .digest('hex')
  const full = createHash('sha256')
    .update(
      JSON.stringify([await readContentFence(context.checkoutPath, { filePath }, options), index])
    )
    .digest('hex')
  return { full, index }
}

export function issueConflict(
  document: Omit<GitWorkspaceConflictDocument, 'documentId'>,
  context: GitContextRef,
  fence: ConflictFence
): GitWorkspaceConflictDocument {
  for (const [id, value] of issued) {
    if (value.expires <= Date.now()) {
      issued.delete(id)
    }
  }
  const bytes = [
    document.base.content,
    document.ours.content,
    document.theirs.content,
    document.result
  ].reduce(
    (total, content) => total + ('content' in content ? Buffer.byteLength(content.content) : 0),
    0
  )
  while (
    issued.size >= MAX_DOCUMENTS ||
    [...issued.values()].reduce((total, value) => total + value.bytes, 0) + bytes > 64 * 1024 * 1024
  ) {
    const first = issued.keys().next().value
    if (first) {
      issued.delete(first)
    }
  }
  const result = { ...document, documentId: randomUUID() }
  issued.set(result.documentId, {
    document: result,
    context,
    fence,
    bytes,
    expires: Date.now() + EXPIRY_MS
  })
  return result
}

export function getConflict(
  documentId: string | undefined,
  context: GitContextRef
): IssuedConflict {
  const value = documentId ? issued.get(documentId) : undefined
  if (!value || value.expires <= Date.now()) {
    throw new GitMutationError(
      'stale',
      'Conflict review expired; reopen the conflict before writing'
    )
  }
  if (
    value.context.id !== context.id ||
    value.context.checkoutPath !== context.checkoutPath ||
    value.context.gitDir !== context.gitDir ||
    value.context.commonGitDir !== context.commonGitDir
  ) {
    throw new GitMutationError('access-denied', 'Conflict document belongs to another checkout')
  }
  return value
}

export function forgetConflict(documentId: string): void {
  issued.delete(documentId)
}

export async function assertConflictFresh(
  value: IssuedConflict,
  options: GetStatusOptions
): Promise<void> {
  if (
    value.fence.full !== (await conflictFence(value.context, value.document.filePath, options)).full
  ) {
    throw new GitMutationError(
      'stale',
      'Conflict index, operation or worktree changed externally; reopen before writing'
    )
  }
  const entry = await readContentFenceEntry(
    value.context.checkoutPath,
    value.document.filePath,
    options
  )
  if (entry.kind === 'file' && !entry.digest) {
    throw new GitMutationError(
      'unsupported',
      'Oversized worktree conflicts cannot be overwritten safely'
    )
  }
}
