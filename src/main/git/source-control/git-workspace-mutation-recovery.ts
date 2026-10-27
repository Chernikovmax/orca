import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitMutationReceipt,
  GitRecoveryEntry,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GitContextRef } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { workspacePathWithin } from './git-workspace-context'
import { readContentFence } from './git-content-fence'
import { GitMutationError } from './git-workspace-mutation-error'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'

const RECOVERY_DIRECTORY = 'orca-recovery'
const RECOVERY_LIMIT = 50

export type RecoveryManifest = {
  version: 1
  id: string
  contextId: string
  filePath: string
  existed: boolean
  mode?: number
  size?: number
  createdAt: number
  fence: string
  postFence: string
}

export function recoveryDirectory(context: GitContextRef): string {
  return path.join(context.gitDir, RECOVERY_DIRECTORY)
}

/** Creates and validates the recovery directory; failure means a discard must not proceed. */
export async function ensureRecoveryDirectory(context: GitContextRef): Promise<string> {
  try {
    const directory = recoveryDirectory(context)
    await mkdir(directory, { mode: 0o700, recursive: true })
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GitMutationError(
        'unsupported',
        'Recovery path is not a regular directory; discard refused'
      )
    }
    const canonical = await realpath(directory)
    if (!workspacePathWithin(context.gitDir, canonical)) {
      throw new GitMutationError(
        'unsupported',
        'Recovery path escapes authorized Git metadata; discard refused'
      )
    }
    return canonical
  } catch (error) {
    if (error instanceof GitMutationError) {
      throw error
    }
    throw new GitMutationError(
      'unsupported',
      `Cannot create a recovery copy (${error instanceof Error ? error.message : String(error)}); discard refused`
    )
  }
}

export async function writeRecoveryManifest(
  directory: string,
  manifest: RecoveryManifest
): Promise<void> {
  const handle = await open(path.join(directory, `${manifest.id}.json`), 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(manifest))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function toRecoveryEntry(manifest: RecoveryManifest): GitRecoveryEntry {
  return {
    id: manifest.id,
    contextId: manifest.contextId,
    filePath: manifest.filePath,
    createdAt: manifest.createdAt,
    existed: manifest.existed,
    ...(manifest.size === undefined ? {} : { size: manifest.size }),
    ...(manifest.mode === undefined ? {} : { mode: manifest.mode })
  }
}

async function readRecoveryManifest(
  context: GitContextRef,
  id: string
): Promise<RecoveryManifest | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new GitMutationError('invalid', 'Invalid recovery id')
  }
  try {
    const raw = await readFile(path.join(recoveryDirectory(context), `${id}.json`), 'utf8')
    const parsed = JSON.parse(raw) as RecoveryManifest
    if (parsed.version !== 1 || parsed.id !== id || parsed.contextId !== context.id) {
      throw new GitMutationError('invalid', 'Recovery record does not belong to this context')
    }
    return parsed
  } catch (error) {
    if (error instanceof GitMutationError) {
      throw error
    }
    return undefined
  }
}

/**
 * Restores a discarded regular file only while nothing changed since the discard.
 * This is a recovery copy of Orca's own discard, not a general Git undo.
 */
export async function restoreDiscardImpl(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { context } = resolved
  const manifest = await readRecoveryManifest(context, request.recoveryId ?? '')
  if (!manifest) {
    throw new GitMutationError('stale', 'Recovery copy is no longer available')
  }
  const currentFence = await readContentFence(
    context.checkoutPath,
    { filePath: manifest.filePath },
    options
  )
  if (currentFence !== manifest.postFence) {
    throw new GitMutationError(
      'stale',
      'The file changed after it was discarded; refusing to overwrite it with the old copy'
    )
  }
  const backup = path.join(recoveryDirectory(context), manifest.id)
  const target = path.join(
    resolveWorktreeFilesystemPath(context.checkoutPath, options),
    manifest.filePath
  )
  let info
  try {
    info = await lstat(target)
  } catch {
    info = undefined
  }
  if (manifest.existed) {
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new GitMutationError('unsupported', 'Restore target is not a regular file')
    }
    await copyFile(backup, target)
    if (manifest.mode !== undefined) {
      await chmod(target, manifest.mode & 0o777)
    }
  } else if (info) {
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GitMutationError('unsupported', 'Restore target is not a regular file')
    }
    await unlink(target)
  }
  return {
    action: 'restoreDiscard',
    outcome: 'succeeded',
    recovery: toRecoveryEntry(manifest)
  }
}

export async function listRecoveriesImpl(resolved: ResolvedWorkspace): Promise<GitRecoveryEntry[]> {
  const { context } = resolved
  try {
    const entries = await readdir(recoveryDirectory(context))
    const manifests = entries
      .filter((name) => name.endsWith('.json'))
      .slice(0, RECOVERY_LIMIT)
      .map((name) => name.slice(0, -'.json'.length))
    const records = await Promise.all(manifests.map((id) => readRecoveryManifest(context, id)))
    return records
      .filter((item): item is RecoveryManifest => !!item)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toRecoveryEntry)
  } catch {
    return []
  }
}
