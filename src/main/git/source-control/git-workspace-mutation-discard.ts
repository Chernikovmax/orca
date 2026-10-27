import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitDiscardPreview,
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { validateDiffPath } from './git-diff-path'
import { readContentFence } from './git-content-fence'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { redoWriteForDriveCheckoutSuspects } from './drive-checkout-suspect-writes'
import {
  findEntry,
  submoduleForPath,
  type ResolvedWorkspace
} from './git-workspace-mutation-shared'
import {
  ensureRecoveryDirectory,
  toRecoveryEntry,
  writeRecoveryManifest,
  type RecoveryManifest
} from './git-workspace-mutation-recovery'

const PREVIEW_TTL_MS = 5 * 60_000
const PREVIEW_LIMIT = 64

type DiscardPreviewRecord = {
  id: string
  contextId: string
  filePath: string
  fence: string
  expiresAt: number
}
const discardPreviews = new Map<string, DiscardPreviewRecord>()

function readTargetInfo(
  target: string
): Promise<{ exists: boolean; mode?: string; permissions?: number }> {
  return lstat(target).then(
    (info) => {
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new GitMutationError('unsupported', 'Discard supports regular files only')
      }
      return {
        exists: true,
        mode: info.mode & 0o111 ? '100755' : '100644',
        permissions: info.mode & 0o777
      }
    },
    (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { exists: false }
      }
      throw error
    }
  )
}

/**
 * A discard has a preview (bound to file content and state), an explicit confirm token,
 * a durable recovery copy written before the overwrite, and a refusal when that copy
 * cannot be stored. Untracked files are never removed here.
 */
export async function discardImpl(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository, context, workspace } = resolved
  const filePath = validateDiffPath(request.filePath ?? '')
  const previewId = request.previewId
  const preview = previewId ? discardPreviews.get(previewId) : undefined
  if (!preview || preview.contextId !== context.id || preview.filePath !== filePath) {
    throw new GitMutationError('invalid', 'Discard requires a fresh host preview of this file')
  }
  if (preview.expiresAt < Date.now()) {
    discardPreviews.delete(previewId!)
    throw new GitMutationError('stale', 'Discard preview expired; preview the file again')
  }
  const entry = findEntry(repository, filePath, 'unstaged')
  if (!entry || entry.conflictStatus === 'unresolved') {
    throw new GitMutationError(
      'invalid',
      entry ? 'Conflict entries must be resolved, not discarded' : 'Only unstaged changes of tracked files can be discarded'
    )
  }
  if (!['modified', 'deleted', 'renamed'].includes(entry.status)) {
    throw new GitMutationError('invalid', 'Only modified or deleted tracked files can be discarded')
  }
  if (submoduleForPath(workspace, context, filePath)) {
    throw new GitMutationError('unsupported', 'Submodule gitlinks are not discarded as files')
  }
  const tracked = await workspaceGitRead(
    context.checkoutPath,
    ['ls-files', '--error-unmatch', '--', `:(literal)${filePath}`],
    options,
    true
  ).catch(() => '')
  if (!tracked) {
    throw new GitMutationError('invalid', 'Untracked files are not removed by discard')
  }
  const currentFence = await readContentFence(context.checkoutPath, { filePath }, options)
  if (currentFence !== preview.fence) {
    throw new GitMutationError('stale', 'File changed after the discard preview; review it again')
  }
  const directory = await ensureRecoveryDirectory(context)
  const id = randomUUID()
  const target = path.join(resolveWorktreeFilesystemPath(context.checkoutPath, options), filePath)
  const info = await readTargetInfo(target)
  const backup = path.join(directory, id)
  if (info.exists) {
    await copyFile(target, backup, constants.COPYFILE_EXCL)
    const handle = await open(backup, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } else {
    // An absent file has a durable empty backup: its recovery deletes the restored file again.
    await writeFile(backup, Buffer.alloc(0), { mode: 0o600, flag: 'wx' })
  }
  const recheckedFence = await readContentFence(context.checkoutPath, { filePath }, options)
  if (recheckedFence !== preview.fence) {
    throw new GitMutationError(
      'stale',
      'File changed while saving the recovery copy; discard refused'
    )
  }
  discardPreviews.delete(previewId!)
  await gitExecFileAsync(['restore', '--worktree', '--', `:(literal)${filePath}`], {
    ...gitOptionsForWorktree(context.checkoutPath, options),
    admissionTier: 'interactive'
  })
  await redoWriteForDriveCheckoutSuspects(
    context.checkoutPath,
    [filePath],
    ['restore', '--worktree'],
    options
  )
  const postFence = await readContentFence(context.checkoutPath, { filePath }, options)
  const manifest: RecoveryManifest = {
    version: 1,
    id,
    contextId: context.id,
    filePath,
    existed: info.exists,
    ...(info.exists && info.permissions !== undefined ? { mode: info.permissions } : {}),
    createdAt: Date.now(),
    fence: preview.fence,
    postFence
  }
  await writeRecoveryManifest(directory, manifest)
  return { action: 'discard', outcome: 'succeeded', recovery: toRecoveryEntry(manifest) }
}

export async function previewDiscardImpl(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitDiscardPreview> {
  const { repository, context, workspace } = resolved
  const filePath = validateDiffPath(request.filePath ?? '')
  const entry = findEntry(repository, filePath, 'unstaged')
  if (!entry) {
    throw new GitMutationError('invalid', 'Only unstaged changes of tracked files can be discarded')
  }
  if (entry.conflictStatus === 'unresolved') {
    throw new GitMutationError('unsupported', 'Conflict entries must be resolved, not discarded')
  }
  if (submoduleForPath(workspace, context, filePath)) {
    throw new GitMutationError('unsupported', 'Submodule gitlinks are not discarded as files')
  }
  const fence = await readContentFence(context.checkoutPath, { filePath }, options)
  const target = path.join(resolveWorktreeFilesystemPath(context.checkoutPath, options), filePath)
  const info = await readTargetInfo(target)
  const id = randomUUID()
  let recoveryAvailable = true
  try {
    await ensureRecoveryDirectory(context)
  } catch {
    recoveryAvailable = false
  }
  discardPreviews.set(id, {
    id,
    contextId: context.id,
    filePath,
    fence,
    expiresAt: Date.now() + PREVIEW_TTL_MS
  })
  while (discardPreviews.size > PREVIEW_LIMIT) {
    discardPreviews.delete(discardPreviews.keys().next().value!)
  }
  return {
    contextId: context.id,
    expectedState: repository.expectedState,
    filePath,
    previewId: id,
    tracked: true,
    exists: info.exists,
    ...(info.mode ? { mode: info.mode } : {}),
    recoveryAvailable,
    warning: !recoveryAvailable
      ? 'No recovery copy can be stored under Git metadata; discard is refused.'
      : info.exists
        ? 'A copy of the current file is kept under Git metadata and can be restored while it is unchanged.'
        : 'The file is deleted in the working tree; discard restores it from the index.'
  }
}
