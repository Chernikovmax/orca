import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import type { GitExecOptions } from '../command-runner/git-exec-options'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { GitMutationError } from './git-workspace-mutation-error'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'
import {
  readHead,
  resolveLocalCommit,
  safeGitMessage,
  validateWorkspaceRefName
} from './git-workspace-branch-refs'
import {
  assertCleanForIntegration,
  assertNoUnfinishedOperation,
  currentOperation,
  unresolvedConflictCount
} from './git-workspace-branch-guards'

export const INTEGRATION_TIMEOUT_MS = 120_000

function integrationOptions(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): GitExecOptions {
  return {
    ...gitOptionsForWorktree(workspace.context.checkoutPath, options),
    admissionTier: 'interactive',
    timeout: INTEGRATION_TIMEOUT_MS
  }
}

async function conflictFailure(
  workspace: ResolvedWorkspace,
  label: string,
  error: unknown,
  options: GetStatusOptions
): Promise<GitMutationError> {
  const unresolved = await unresolvedConflictCount(workspace, options)
  const detail = safeGitMessage(error)
  return new GitMutationError(
    'conflict',
    `${label} stopped with ${unresolved} unresolved conflict(s); it is not complete. Resolve the files and stage them, then continue — or abort. Orca's conflict resolver is a later stage.\n${detail}`
  )
}

async function mergeDetail(
  workspace: ResolvedWorkspace,
  before: string | undefined,
  after: string | undefined,
  options: GetStatusOptions
): Promise<'already-up-to-date' | 'fast-forward' | 'merge-commit'> {
  if (!after || before === after) {
    return 'already-up-to-date'
  }
  const parents = (
    await workspaceGitRead(
      workspace.context.checkoutPath,
      ['rev-list', '--parents', '-n', '1', after],
      options
    )
  )
    .trim()
    .split(' ')
  return parents.length > 2 ? 'merge-commit' : 'fast-forward'
}

/** Explicit merge of one resolved local revision into the current checkout. */
export async function mergeImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository } = workspace
  const refName = validateWorkspaceRefName(request.refName)
  assertNoUnfinishedOperation(repository)
  assertCleanForIntegration(repository)
  const targetOid = await resolveLocalCommit(workspace, refName, options)
  if (targetOid === repository.head) {
    throw new GitMutationError('invalid', 'That revision is already integrated into HEAD')
  }
  try {
    await gitExecFileAsync(
      ['merge', '--no-edit', refName, '--'],
      integrationOptions(workspace, options)
    )
  } catch (error) {
    const state = await currentOperation(workspace, options)
    if (state.inProgress && state.operation === 'merge') {
      throw await conflictFailure(workspace, 'Merge', error, options)
    }
    throw new GitMutationError('git-error', safeGitMessage(error) || 'Git merge failed')
  }
  const state = await currentOperation(workspace, options)
  if (state.inProgress) {
    throw new GitMutationError(
      'conflict',
      'Git left an unfinished merge; the integration is not complete'
    )
  }
  const after = await readHead(workspace, options)
  return {
    action: 'merge',
    outcome: 'succeeded',
    contextId: repository.context.id,
    operation: {
      kind: 'merge',
      refName,
      oid: targetOid,
      completed: true,
      conflicts: false,
      detail: await mergeDetail(workspace, repository.head, after, options)
    }
  }
}

/** Explicit rebase of the current checkout onto one resolved local revision. */
export async function rebaseImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository } = workspace
  const refName = validateWorkspaceRefName(request.refName)
  assertNoUnfinishedOperation(repository)
  assertCleanForIntegration(repository)
  const targetOid = await resolveLocalCommit(workspace, refName, options)
  try {
    await gitExecFileAsync(['rebase', refName], integrationOptions(workspace, options))
  } catch (error) {
    const state = await currentOperation(workspace, options)
    if (state.inProgress && state.operation === 'rebase') {
      throw await conflictFailure(workspace, 'Rebase', error, options)
    }
    throw new GitMutationError('git-error', safeGitMessage(error) || 'Git rebase failed')
  }
  const state = await currentOperation(workspace, options)
  if (state.inProgress) {
    throw new GitMutationError(
      'conflict',
      'Git left an unfinished rebase; the integration is not complete'
    )
  }
  return {
    action: 'rebase',
    outcome: 'succeeded',
    contextId: repository.context.id,
    operation: {
      kind: 'rebase',
      refName,
      oid: targetOid,
      completed: true,
      conflicts: false,
      detail: 'rebase-completed'
    }
  }
}

export async function continueOperationImpl(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const state = await currentOperation(workspace, options)
  if (!state.inProgress) {
    throw new GitMutationError('invalid', 'No merge or rebase is in progress')
  }
  if (state.operation === 'cherry-pick') {
    throw new GitMutationError(
      'unsupported',
      'A cherry-pick is in progress; conflict resolution for cherry-pick is not part of this stage'
    )
  }
  if (state.operation !== 'merge' && state.operation !== 'rebase') {
    throw new GitMutationError('unsupported', 'The unfinished Git operation is not supported')
  }
  const label = state.operation === 'merge' ? 'Merge' : 'Rebase'
  try {
    await gitExecFileAsync(
      ['-c', 'core.editor=true', state.operation, '--continue'],
      integrationOptions(workspace, options)
    )
  } catch (error) {
    const after = await currentOperation(workspace, options)
    if (after.inProgress) {
      throw await conflictFailure(workspace, label, error, options)
    }
    throw new GitMutationError('git-error', safeGitMessage(error) || `${label} continue failed`)
  }
  const after = await currentOperation(workspace, options)
  if (after.inProgress) {
    throw new GitMutationError('conflict', `${label} is still unfinished; it is not complete`)
  }
  return {
    action: 'continueOperation',
    outcome: 'succeeded',
    contextId: workspace.repository.context.id,
    operation: {
      kind: 'continue',
      completed: true,
      conflicts: false,
      detail: 'continued'
    }
  }
}

export async function abortOperationImpl(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const state = await currentOperation(workspace, options)
  if (!state.inProgress) {
    throw new GitMutationError('invalid', 'No merge or rebase is in progress')
  }
  if (state.operation === 'cherry-pick') {
    throw new GitMutationError(
      'unsupported',
      'A cherry-pick is in progress; aborting it is not part of this stage'
    )
  }
  if (state.operation !== 'merge' && state.operation !== 'rebase') {
    throw new GitMutationError('unsupported', 'The unfinished Git operation is not supported')
  }
  await gitExecFileAsync([state.operation, '--abort'], integrationOptions(workspace, options))
  const after = await currentOperation(workspace, options)
  if (after.inProgress) {
    throw new GitMutationError(
      'git-error',
      'Git reported an abort, but the operation is still unfinished; verify the real state'
    )
  }
  return {
    action: 'abortOperation',
    outcome: 'succeeded',
    contextId: workspace.repository.context.id,
    operation: { kind: 'abort', completed: true, conflicts: false, detail: 'aborted' }
  }
}
