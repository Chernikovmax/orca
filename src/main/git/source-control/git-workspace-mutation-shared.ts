import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitMutationReceipt, GitWorkspaceMutationRequest } from '../../../shared/git-workspace-mutation'
import type { GitStatusEntry } from '../../../shared/git-status-types'
import type {
  GitContextRef,
  GitWorkspaceSnapshot,
  RepositoryState,
  SubmoduleEntry
} from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { getStatus } from './status-read'
import { workspacePathWithin } from './git-workspace-context'
import { GitMutationError } from './git-workspace-mutation-error'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'

export const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type ResolvedWorkspace = {
  workspace: GitWorkspaceSnapshot
  repository: RepositoryState
  context: GitContextRef
}

/**
 * Re-authorizes the requested Git context against this host's discovered tree and
 * enforces the caller's expected state. `expectedState` is never renderer authority:
 * discovery decides which contexts exist and what their state is.
 */
export async function readAuthorizedWorkspace(
  root: string,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<ResolvedWorkspace> {
  const status = await getStatus(root, {
    ...options,
    includeWorkspace: true,
    includeLineStats: false,
    workspaceRefsContextId: undefined
  })
  const workspace = status.workspace
  if (!workspace) {
    throw new GitMutationError(
      'access-denied',
      'Git workspace discovery returned no authorized contexts'
    )
  }
  const contextId = request.contextId ?? workspace.rootContextId
  const repository = workspace.repositories.find((item) => item.context.id === contextId)
  if (!repository) {
    throw new GitMutationError(
      'access-denied',
      'Git context is not part of this authorized worktree; refresh before writing'
    )
  }
  if (request.expectedState === undefined) {
    // Legacy callers (CLI/preload file actions) never carried an expectation.
    return { workspace, repository, context: repository.context }
  }
  const lifecycle = request.action.startsWith('submodule') || request.action.startsWith('previewSubmodule')
  if (repository.incomplete || (workspace.incomplete && !(lifecycle && hasOnlyUninitializedGaps(workspace)))) {
    throw new GitMutationError(
      'incomplete',
      'Git context discovery is incomplete; refresh and review the real state before writing'
    )
  }
  if (repository.expectedState !== request.expectedState) {
    throw new GitMutationError(
      'stale',
      'Git HEAD, index or working tree changed since the previewed state; review the refreshed state'
    )
  }
  return { workspace, repository, context: repository.context }
}

export function hasOnlyUninitializedGaps(workspace: GitWorkspaceSnapshot): boolean {
  return workspace.errors.length === 0 &&
    workspace.repositories.every((repository) => !repository.incomplete) &&
    workspace.submodules.every((entry) =>
      entry.availability === 'initialized' ||
      (entry.availability === 'uninitialized' &&
        entry.metadataIssues.every((issue) => issue.startsWith('Declared and local URL differ')) &&
        entry.indexConflictOids.length === 0))
}

export function findEntry(
  repository: RepositoryState,
  filePath: string,
  area: GitStatusEntry['area']
): GitStatusEntry | undefined {
  return repository.entries.find((entry) => entry.path === filePath && entry.area === area)
}

export function submoduleForPath(
  workspace: GitWorkspaceSnapshot,
  parent: GitContextRef,
  filePath: string
): SubmoduleEntry | undefined {
  const pathByContext = new Map(
    workspace.submodules.filter((item) => item.contextId).map((item) => [item.contextId!, item.path])
  )
  const parentPath = pathByContext.get(parent.id) ?? ''
  const fullPath = parentPath ? `${parentPath}/${filePath}` : filePath
  return workspace.submodules.find(
    (item) => item.parentContextId === parent.id && item.path === fullPath
  )
}

export function refreshReceipt(
  receipt: GitMutationReceipt,
  repository: RepositoryState | undefined
): GitMutationReceipt {
  if (!repository) {
    return receipt
  }
  return {
    ...receipt,
    contextId: repository.context.id,
    expectedState: repository.expectedState,
    ...(repository.head ? { head: repository.head } : {})
  }
}

export async function readFreshState(
  root: string,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<RepositoryState | undefined> {
  try {
    const status = await getStatus(root, {
      ...options,
      includeWorkspace: true,
      includeLineStats: false,
      workspaceRefsContextId: undefined
    })
    const workspace = status.workspace
    if (!workspace) {
      return undefined
    }
    return request.contextId
      ? workspace.repositories.find((item) => item.context.id === request.contextId)
      : workspace.repositories.find((item) => item.context.id === workspace.rootContextId)
  } catch {
    return undefined
  }
}

/** Applies a host-built patch to the real index through a private file (byte-exact, no stdin encoding). */
export async function applySelectedPatch(
  context: GitContextRef,
  patch: Buffer,
  options: GetStatusOptions
): Promise<void> {
  const directory = path.join(context.gitDir, 'orca-patches')
  await mkdir(directory, { mode: 0o700, recursive: true })
  if (!workspacePathWithin(context.gitDir, await realpath(directory))) {
    throw new GitMutationError(
      'access-denied',
      'Patch directory resolves outside authorized Git metadata'
    )
  }
  const file = path.join(directory, `${randomUUID()}.patch`)
  await writeFile(file, patch, { mode: 0o600, flag: 'wx' })
  try {
    await gitExecFileAsync(['apply', '--cached', '--whitespace=nowarn', file], {
      ...gitOptionsForWorktree(context.checkoutPath, options),
      admissionTier: 'interactive'
    })
  } finally {
    await rm(file, { force: true })
  }
}
