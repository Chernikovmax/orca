import { createHash } from 'node:crypto'
import type { GitWorkspaceMutationRequest } from '../../../shared/git-workspace-mutation'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { getStatus } from './status-read'
import { GitMutationError } from './git-workspace-mutation-error'
import { workspaceGitRead } from './git-workspace-discovery'
import { type BatchState, repositoryFor, sameStrings } from './git-workspace-batch-state'
import { computeSelection } from './git-workspace-batch-plan'
import type { GitWorkspaceBatchStep } from '../../../shared/git-workspace-batch'
function indexRows(raw: string): { path: string; record: string }[] {
  return raw
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf('\t')
      return { path: row.slice(separator + 1), record: row.slice(0, separator) }
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.record.localeCompare(right.record)
    )
}

function sameIndexExceptPath(before: string, after: string, filePath: string): boolean {
  const oldRows = indexRows(before).filter((row) => row.path !== filePath)
  const newRows = indexRows(after).filter((row) => row.path !== filePath)
  return JSON.stringify(oldRows) === JSON.stringify(newRows)
}

export async function recordStagedGitlink(
  state: BatchState,
  contextId: string,
  filePath: string,
  childOid: string,
  options: GetStatusOptions
): Promise<void> {
  const previous = state.indexRecords.get(contextId)
  const identity = state.identities.get(contextId)
  if (!previous || !identity) {
    throw new GitMutationError('stale', `Parent index for ${contextId} is no longer fenced`)
  }
  const current = await workspaceGitRead(
    identity.checkoutPath,
    ['ls-files', '--stage', '-z'],
    options
  )
  const targetRows = indexRows(current).filter((row) => row.path === filePath)
  if (
    !sameIndexExceptPath(previous, current, filePath) ||
    targetRows.length !== 1 ||
    targetRows[0].record !== `160000 ${childOid} 0`
  ) {
    throw new GitMutationError('stale', `Gitlink staging changed unreviewed parent index entries`)
  }
  state.indexRecords.set(contextId, current)
}

export function stepRequest(
  step: GitWorkspaceBatchStep,
  state: BatchState
): GitWorkspaceMutationRequest {
  const contextId = step.contextId
  const expectedState = state.expectedStates.get(contextId)
  if (!expectedState) {
    throw new GitMutationError('stale', `Context ${contextId} is not fenced by this batch preview`)
  }
  if (step.kind === 'stageGitlink') {
    if (!step.filePath || !step.childOid) {
      throw new GitMutationError('stale', 'Generated gitlink lacks a confirmed path or child OID')
    }
    return {
      action: 'stageGitlink',
      contextId,
      expectedState,
      filePath: step.filePath,
      childOid: step.childOid
    }
  }
  if (step.kind === 'commit') {
    const selection = state.request.commits.find((item) => item.contextId === contextId)
    if (!selection) {
      throw new GitMutationError('invalid', 'Commit selection is missing')
    }
    return { action: 'commit', contextId, expectedState, message: selection.message }
  }
  if (step.kind === 'push') {
    const expectedRefOid = state.currentRefs.get(contextId)
    if (!step.remote || !step.refName || !expectedRefOid) {
      throw new GitMutationError(
        'stale',
        'Publication step lacks its reviewed remote, branch ref, or OID'
      )
    }
    return {
      action: 'push',
      contextId,
      remote: step.remote,
      refName: step.refName,
      expectedRefOid,
      ...(step.progressId ? { progressId: step.progressId } : {})
    }
  }
  throw new GitMutationError('invalid', 'Remote verification is not dispatched as a mutation')
}

export async function freshSnapshot(
  root: string,
  options: GetStatusOptions
): Promise<GitWorkspaceSnapshot> {
  const status = await getStatus(root, {
    ...options,
    includeWorkspace: true,
    includeLineStats: false
  })
  if (!status.workspace) {
    throw new GitMutationError(
      'access-denied',
      'Git workspace discovery returned no authorized contexts'
    )
  }
  return status.workspace
}

export async function remoteEndpoints(
  checkoutPath: string,
  remote: string,
  options: GetStatusOptions
): Promise<{ fetch: string[]; push: string[] }> {
  try {
    const [fetchRaw, pushRaw] = await Promise.all([
      workspaceGitRead(checkoutPath, ['remote', 'get-url', '--all', remote], options),
      workspaceGitRead(checkoutPath, ['remote', 'get-url', '--push', '--all', remote], options)
    ])
    const fetch = fetchRaw
      .split('\n')
      .map((url) => url.trim())
      .filter(Boolean)
      .sort()
    const push = pushRaw
      .split('\n')
      .map((url) => url.trim())
      .filter(Boolean)
      .sort()
    if (fetch.length === 0 || push.length === 0) {
      throw new GitMutationError('invalid', `Remote ${remote} has no configured destination`)
    }
    return { fetch, push }
  } catch (error) {
    if (error instanceof GitMutationError) {
      throw error
    }
    throw new GitMutationError('invalid', `Remote ${remote} destination cannot be inspected`)
  }
}

export async function remoteFingerprint(
  checkoutPath: string,
  remote: string,
  options: GetStatusOptions
): Promise<string> {
  const endpoints = await remoteEndpoints(checkoutPath, remote, options)
  return createHash('sha256').update(JSON.stringify(endpoints)).digest('hex')
}

export function destinationCanBeVerified(endpoints: { fetch: string[]; push: string[] }): boolean {
  return (
    endpoints.fetch.length === 1 &&
    endpoints.push.length === 1 &&
    sameStrings(endpoints.fetch, endpoints.push)
  )
}

export async function assertDependencies(
  state: BatchState,
  options: GetStatusOptions
): Promise<GitWorkspaceSnapshot> {
  const current = await freshSnapshot(state.workspaceRoot, options)
  if (current.rootContextId !== state.rootContextId) {
    throw new GitMutationError(
      'stale',
      'Workspace root identity changed; refresh before continuing this batch'
    )
  }
  if (current.incomplete) {
    throw new GitMutationError(
      'incomplete',
      'Workspace discovery became incomplete during the batch'
    )
  }
  const selectionErrors: string[] = []
  const currentSelection = computeSelection(current, state.request, selectionErrors)
  if (
    selectionErrors.length > 0 ||
    currentSelection.length !== state.selectedIds.length ||
    state.selectedIds.some((id) => !currentSelection.includes(id))
  ) {
    throw new GitMutationError(
      'stale',
      'Selected or recursive workspace dependencies changed; refresh and review the batch'
    )
  }
  for (const contextId of state.selectedIds) {
    const expected = state.expectedStates.get(contextId)
    const repo = repositoryFor(current, contextId)
    const old = state.identities.get(contextId)
    if (!repo || !expected || !old) {
      throw new GitMutationError('stale', `Selected dependency ${contextId} is no longer available`)
    }
    if (
      repo.context.checkoutPath !== old.checkoutPath ||
      repo.context.commonGitDir !== old.commonGitDir ||
      repo.context.executionHostId !== old.executionHostId
    ) {
      throw new GitMutationError(
        'stale',
        `Checkout identity changed for ${contextId}; refresh before continuing`
      )
    }
    if (repo.expectedState !== expected) {
      throw new GitMutationError(
        'stale',
        `Context ${contextId} changed since the prior batch step; review before continuing`
      )
    }
    const expectedIndex = state.indexRecords.get(contextId)
    const currentIndex = await workspaceGitRead(
      repo.context.checkoutPath,
      ['ls-files', '--stage', '-z'],
      options
    )
    if (currentIndex !== expectedIndex) {
      throw new GitMutationError(
        'stale',
        `Index changed for ${contextId}; review before continuing the batch`
      )
    }
  }
  state.lastWorkspace = current
  return current
}

export async function updateFence(
  state: BatchState,
  contextId: string,
  options: GetStatusOptions,
  expectedAfter: string | undefined
): Promise<void> {
  const current = await freshSnapshot(state.workspaceRoot, options)
  const repo = repositoryFor(current, contextId)
  if (!repo || !expectedAfter || repo.expectedState !== expectedAfter) {
    throw new GitMutationError('stale', `Context ${contextId} changed after its batch operation`)
  }
  state.expectedStates.set(contextId, expectedAfter)
  state.identities.set(contextId, repo.context)
  state.lastWorkspace = current
}
